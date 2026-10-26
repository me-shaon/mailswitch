import type { ProviderSocket, SocketConnect, SocketTarget } from "../core/socket";

// An in-process SMTP server behind the `connect` capability. The SMTP client tests and
// the conformance kit use it, so no test opens a real socket or reaches a real mail
// server. It simulates STARTTLS: `startTls()` returns a new socket on the
// same session and marks the session as secure. There is no real TLS.

/** A reply line such as "550 5.1.1 No such user", or a transport failure. */
export type MockReply = string | "timeout" | "disconnect";

export interface MockCommand {
  /** The upper-case verb, for example `RCPT`. `CONNECT` is the greeting and `DATA_END` the final dot. */
  verb: string;
  /** The rest of the line after the verb. */
  arg: string;
  /** How many messages the session accepted before this command. */
  accepted: number;
  /** The session runs over TLS (implicit, or after STARTTLS). */
  secure: boolean;
}

export interface MockSmtpOptions {
  /** Advertise STARTTLS on a plain connection. Defaults to true. */
  starttls?: boolean;
  /** The AUTH mechanisms to advertise. Defaults to PLAIN and LOGIN. */
  authMechanisms?: readonly string[];
  /** Advertise AUTH before TLS too, as a careless server would. Defaults to false. */
  authBeforeTls?: boolean;
  /** Reject EHLO with 502, so the client must use HELO. */
  rejectEhlo?: boolean;
  /** The accepted credentials. Defaults to `user` and `secret`. */
  username?: string;
  password?: string;
  /** Overrides the reply to a command. Return undefined for the normal reply. */
  reply?: (command: MockCommand) => MockReply | undefined;
}

export interface CapturedSmtpMessage {
  from: string;
  to: string[];
  /** The message as sent, after the server removed the dot-stuffing. */
  data: string;
  /** The DATA bytes as they came over the wire, with the dot-stuffing. */
  wire: string;
  secure: boolean;
}

export interface MockSession {
  target: SocketTarget;
  /** Every command line, as received. AUTH payloads included. */
  commands: string[];
  secure: boolean;
  /** AUTH arrived while the session was plain text. */
  authOverPlaintext: boolean;
  closed: boolean;
}

export interface MockSmtp {
  connect: SocketConnect;
  sessions: MockSession[];
  messages: CapturedSmtpMessage[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeBase64(text: string): string {
  try {
    const binary = atob(text.trim());
    return decoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return "";
  }
}

/** A mock SMTP server. Each `connect` call opens one session. */
export function mockSmtp(options: MockSmtpOptions = {}): MockSmtp {
  const sessions: MockSession[] = [];
  const messages: CapturedSmtpMessage[] = [];
  const username = options.username ?? "user";
  const password = options.password ?? "secret";
  const mechanisms = options.authMechanisms ?? ["PLAIN", "LOGIN"];

  const connect: SocketConnect = (target) => {
    const session: MockSession = {
      target,
      commands: [],
      secure: target.secureTransport === "on",
      authOverPlaintext: false,
      closed: false,
    };
    sessions.push(session);

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let input = "";
    let state:
      | "command"
      | "data"
      | "auth-plain"
      | "auth-login-user"
      | "auth-login-pass"
      | "starttls-wait" = "command";
    let loginUser = "";
    let authenticated = false;
    let envelope: { from: string; to: string[] } | null = null;
    let wire: string[] = [];
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const close = () => {
      if (session.closed) return;
      session.closed = true;
      try {
        controller?.close();
      } catch {
        // Closed already.
      }
      resolveClosed();
    };

    const send = (text: string) => {
      if (!session.closed) controller?.enqueue(encoder.encode(`${text}\r\n`));
    };

    /** Sends the override reply when there is one. Returns true when it replied. */
    const override = (verb: string, arg: string): boolean => {
      const reply = options.reply?.({
        verb,
        arg,
        accepted: messages.length,
        secure: session.secure,
      });
      if (reply === undefined) return false;
      if (reply === "timeout") return true;
      if (reply === "disconnect") close();
      else {
        send(reply);
        if (reply.startsWith("421")) close();
      }
      return true;
    };

    const ehloLines = (): string[] => {
      const lines = ["mock.smtp.test greets you", "8BITMIME", "SIZE 10485760"];
      if (options.starttls !== false && !session.secure) lines.push("STARTTLS");
      if ((session.secure || options.authBeforeTls) && mechanisms.length > 0) {
        lines.push(`AUTH ${mechanisms.join(" ")}`);
      }
      return lines;
    };

    const checkCredentials = (user: string, pass: string) => {
      if (user === username && pass === password) {
        authenticated = true;
        send("235 2.7.0 Authentication successful");
      } else {
        send("535 5.7.8 Authentication credentials invalid");
      }
    };

    const handleLine = (line: string) => {
      if (state === "data") {
        wire.push(line);
        if (line !== ".") return;
        const data = wire
          .slice(0, -1)
          .map((item) => (item.startsWith(".") ? item.slice(1) : item))
          .join("\r\n");
        const raw = wire.slice(0, -1).join("\r\n");
        state = "command";
        if (override("DATA_END", "")) {
          envelope = null;
          return;
        }
        if (envelope) {
          messages.push({
            from: envelope.from,
            to: envelope.to,
            data,
            wire: raw,
            secure: session.secure,
          });
        }
        envelope = null;
        send(`250 2.0.0 Ok: queued as M${messages.length}`);
        return;
      }
      session.commands.push(line);
      if (state === "auth-plain") {
        state = "command";
        const [, user = "", pass = ""] = decodeBase64(line).split("\0");
        checkCredentials(user, pass);
        return;
      }
      if (state === "auth-login-user") {
        loginUser = decodeBase64(line);
        state = "auth-login-pass";
        send("334 UGFzc3dvcmQ6");
        return;
      }
      if (state === "auth-login-pass") {
        state = "command";
        checkCredentials(loginUser, decodeBase64(line));
        return;
      }
      if (state === "starttls-wait") {
        // Data after STARTTLS and before the upgrade is an injection attempt.
        send("554 5.5.1 Data before the TLS handshake");
        close();
        return;
      }
      const space = line.indexOf(" ");
      const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
      const arg = space < 0 ? "" : line.slice(space + 1);
      // An override of DATA replaces the 354, so the client must not send the body.
      if (override(verb, arg)) return;
      switch (verb) {
        case "EHLO": {
          if (options.rejectEhlo) {
            send("502 5.5.2 Command not recognized");
            return;
          }
          const lines = ehloLines();
          for (const [index, text] of lines.entries()) {
            send(`250${index === lines.length - 1 ? " " : "-"}${text}`);
          }
          return;
        }
        case "HELO":
          send("250 mock.smtp.test");
          return;
        case "STARTTLS":
          if (options.starttls === false || session.secure) {
            send("502 5.5.1 STARTTLS not available");
            return;
          }
          send("220 2.0.0 Ready to start TLS");
          state = "starttls-wait";
          return;
        case "AUTH": {
          if (!session.secure) session.authOverPlaintext = true;
          const [mechanism = "", initial] = arg.split(" ");
          const name = mechanism.toUpperCase();
          if (!mechanisms.includes(name)) {
            send("504 5.5.4 Unrecognized authentication type");
            return;
          }
          if (name === "PLAIN") {
            if (initial) {
              const [, user = "", pass = ""] = decodeBase64(initial).split("\0");
              checkCredentials(user, pass);
            } else {
              state = "auth-plain";
              send("334 ");
            }
            return;
          }
          state = "auth-login-user";
          send("334 VXNlcm5hbWU6");
          return;
        }
        case "MAIL":
          if (!authenticated) {
            send("530 5.7.0 Authentication required");
            return;
          }
          envelope = { from: arg.replace(/^FROM:/i, "").replace(/[<>]/g, ""), to: [] };
          send("250 2.1.0 Ok");
          return;
        case "RCPT":
          if (!envelope) {
            send("503 5.5.1 Need MAIL first");
            return;
          }
          envelope.to.push(arg.replace(/^TO:/i, "").replace(/[<>]/g, ""));
          send("250 2.1.5 Ok");
          return;
        case "DATA":
          if (!envelope || envelope.to.length === 0) {
            send("503 5.5.1 Need RCPT first");
            return;
          }
          state = "data";
          wire = [];
          send("354 End data with <CR><LF>.<CR><LF>");
          return;
        case "RSET":
          envelope = null;
          send("250 2.0.0 Ok");
          return;
        case "NOOP":
          send("250 2.0.0 Ok");
          return;
        case "QUIT":
          send("221 2.0.0 Bye");
          close();
          return;
        default:
          send("500 5.5.2 Command not recognized");
      }
    };

    const receive = (chunk: Uint8Array) => {
      input += decoder.decode(chunk, { stream: true });
      let end = input.indexOf("\r\n");
      while (end >= 0 && !session.closed) {
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        handleLine(line);
        end = input.indexOf("\r\n");
      }
    };

    const makeSocket = (): ProviderSocket => {
      const readable = new ReadableStream<Uint8Array>({
        start(next) {
          controller = next;
        },
      });
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          if (session.closed) throw new TypeError("The socket is closed.");
          receive(chunk);
        },
      });
      return {
        readable,
        writable,
        closed,
        startTls() {
          if (target.secureTransport !== "starttls") {
            throw new TypeError("startTls() needs a socket opened with secureTransport starttls.");
          }
          if (state !== "starttls-wait") {
            throw new TypeError("startTls() before the server accepted STARTTLS.");
          }
          const previous = controller;
          const upgraded = makeSocket();
          try {
            previous?.close();
          } catch {
            // Closed already.
          }
          session.secure = true;
          state = "command";
          input = "";
          return upgraded;
        },
        async close() {
          close();
        },
      };
    };

    const socket = makeSocket();
    queueMicrotask(() => {
      if (!override("CONNECT", "")) send("220 mock.smtp.test ESMTP ready");
    });
    return socket;
  };

  return { connect, sessions, messages };
}

// A small reader of the captured messages, so tests check decoded content.

export interface ParsedMail {
  /** Header names in lower case, values unfolded and RFC 2047-decoded. */
  headers: Map<string, string>;
  /** The raw header block, unfolded only. */
  rawHeaders: string;
  text: string | null;
  html: string | null;
}

function decodeQuotedPrintable(text: string): string {
  const soft = text.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const char = soft[i] as string;
    if (char === "=" && /^[0-9A-F]{2}$/i.test(soft.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...encoder.encode(char));
  }
  return decoder.decode(new Uint8Array(bytes));
}

/** Decodes RFC 2047 encoded words (B and Q) in a header value. */
export function decodeHeaderValue(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_, kind: string, payload: string) =>
      kind.toUpperCase() === "B"
        ? decodeBase64(payload)
        : decodeQuotedPrintable(payload.replaceAll("_", " ")),
    );
}

function decodePart(headers: string, body: string): string {
  const encoding = /content-transfer-encoding:\s*([\w-]+)/i.exec(headers)?.[1]?.toLowerCase();
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  if (encoding === "base64") return decodeBase64(body.replace(/\s+/g, ""));
  return body;
}

/** Splits a captured message into headers and decoded text and HTML parts. */
export function parseMail(data: string): ParsedMail {
  const split = data.indexOf("\r\n\r\n");
  const rawHeaders = data.slice(0, split).replace(/\r\n[ \t]+/g, " ");
  const body = data.slice(split + 4);
  const headers = new Map<string, string>();
  for (const line of rawHeaders.split("\r\n")) {
    const colon = line.indexOf(":");
    headers.set(
      line.slice(0, colon).toLowerCase(),
      decodeHeaderValue(line.slice(colon + 1).trim()),
    );
  }
  const type = headers.get("content-type") ?? "";
  let text: string | null = null;
  let html: string | null = null;
  const boundary = /boundary="([^"]+)"/.exec(type)?.[1];
  const parts = boundary
    ? body
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((part) => {
          const cut = part.indexOf("\r\n\r\n");
          return {
            headers: part.slice(0, cut),
            body: part.slice(cut + 4).replace(/\r\n$/, ""),
          };
        })
    : [{ headers: `Content-Type: ${type}\r\n${rawHeaders}`, body }];
  for (const part of parts) {
    const decoded = decodePart(part.headers, part.body);
    if (/content-type:\s*text\/plain/i.test(part.headers)) text = decoded;
    if (/content-type:\s*text\/html/i.test(part.headers)) html = decoded;
  }
  return { headers, rawHeaders, text, html };
}
