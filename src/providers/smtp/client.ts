// A small SMTP submission client on the injected `connect` capability. It is a
// reply-per-command state machine: it writes one command, reads one reply, and decides.
// It does not pipeline. Ported from the Envelopen SMTP client.
//
// One call is one connection: the greeting, EHLO, STARTTLS or implicit TLS, AUTH, then
// MAIL FROM, RCPT TO, and DATA per message, and QUIT. The whole session has one deadline
// of `timeoutMs`, shared by every read and write. The socket closes in `finally`.
//
// Security rules:
// - AUTH and MAIL FROM run only on a TLS connection: implicit TLS, or STARTTLS that the
//   server offered and that completed. The client never falls back to plain text.
// - A plain-text connection needs `security: "none"` and `insecure: true` together.
//   Only the Mailpit and MailCrab presets set them by default.
// - Bytes that arrive after the STARTTLS 220 and before the handshake end the session.
// - Result messages hold only the SMTP reply code and the command. They never hold the
//   reply text, the commands, or any AUTH line.
//
// Delivery status:
// - A failure before the server answers DATA with 354 is `not_sent`. The server has no
//   message yet. This covers a failed connect, the greeting, EHLO, STARTTLS, AUTH, MAIL
//   FROM, RCPT TO, and a refused DATA command.
// - A failure after the 354 is `unknown`: a timeout, a lost connection, or any reply
//   other than 250 to the final dot. The message may have gone out.
// - A 250 to the final dot is `sent`.

import type { ProviderSocket, SocketConnect } from "../../core/socket";
import type { FailureReason, NotSentResult, SendResult } from "../../core/types";
import { bytesToBase64, utf8 } from "../../internal/encoding";

/** `starttls` upgrades a plain connection, `tls` is implicit TLS, `none` stays plain. */
export type SmtpSecurity = "starttls" | "tls" | "none";

/** The settings of one SMTP server. */
export interface SmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** Allows plain text. `security: "none"` needs it. */
  insecure: boolean;
  /** Empty for a server that needs no AUTH. */
  username: string;
  password: string;
  /** The name in EHLO. Defaults to the domain of the From address, or `localhost`. */
  heloName?: string;
}

/** The transport of one call. */
export interface SmtpContext {
  connect: SocketConnect;
  /** The longest time for the whole session, in milliseconds. Every step shares it. */
  timeoutMs: number;
}

/** One message, ready for the wire. */
export interface SmtpEnvelope {
  from: string;
  /** Every recipient: to, cc, and bcc. */
  recipients: readonly string[];
  /** The MIME source with CRLF line endings, before dot-stuffing. */
  data: string;
  /** The `Message-ID` header value, with angle brackets. */
  messageId: string;
}

const MAX_LINE = 4096;
const MAX_REPLY_LINES = 100;
const AUTH_CODES: ReadonlySet<number> = new Set([530, 534, 535, 538]);
const QUOTA_WORDING = /quota|daily .*limit|sending limit|limit exceeded|exceeded .*limit/i;
const RATE_WORDING = /rate|too many|throttl|slow down|try again later/i;
const NON_ASCII = /[\u0080-\uffff]/;

const LOST = "The SMTP connection was lost.";
const TIMEOUT = "The SMTP server did not answer in time.";
const BAD_REPLY = "The SMTP server sent a reply that is not valid.";
const NO_TLS = "The SMTP connection has no TLS, so mailswitch sent no password and no message.";

type Stage = "greeting" | "EHLO" | "STARTTLS" | "AUTH" | "MAIL FROM" | "RCPT TO" | "DATA" | "RSET";

interface Reply {
  code: number;
  text: string;
}

/**
 * A failure. `scope` is `message` when the server refused only this message and the
 * session can go on, and `session` when the session must end.
 */
class SmtpStop extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
    readonly scope: "message" | "session" = "session",
  ) {
    super(message);
  }
}

/** Maps a refusal before the 354. Reads the reply text, but never copies it. */
function refusal(reply: Reply, stage: Stage): SmtpStop {
  const { code, text } = reply;
  const what = `The SMTP server answered ${code} to ${stage}.`;
  if (AUTH_CODES.has(code) || (stage === "AUTH" && code >= 500)) {
    return new SmtpStop("auth", `The SMTP server refused the login (${code}).`);
  }
  if (QUOTA_WORDING.test(text) || /\b5\.4\.5\b/.test(text)) return new SmtpStop("quota", what);
  if (code === 421 || code === 450 || code === 451 || code === 454) {
    return new SmtpStop("rate_limited", what);
  }
  if (code === 452) {
    // 4.5.3 is "too many recipients". Any other 452 is a temporary limit.
    return /\b4\.5\.3\b/.test(text)
      ? new SmtpStop("invalid_message", what, "message")
      : new SmtpStop("rate_limited", what);
  }
  if (code >= 500 && RATE_WORDING.test(text)) return new SmtpStop("rate_limited", what);
  const perMessage = stage === "MAIL FROM" || stage === "RCPT TO" || stage === "DATA";
  if (code >= 500 && code < 600 && perMessage) {
    const reason = code === 501 || code === 552 || code === 555 ? "invalid_message" : "rejected";
    return new SmtpStop(reason, what, "message");
  }
  return new SmtpStop("provider_error", what);
}

/** Adds a dot to each line that starts with one, and the end-of-data line (RFC 5321). */
export function dotStuff(data: string): string {
  const body = data.endsWith("\r\n") ? data : `${data}\r\n`;
  return `${body.replace(/(^|\r\n)\./g, "$1..")}.\r\n`;
}

/** Reads a queue id from the reply to the final dot, when the server gives one. */
export function queueId(text: string): string | undefined {
  const match = /queued as\s+(\S+)/i.exec(text) ?? /\bid=(\S+)/i.exec(text);
  const id = match?.[1]?.replace(/[.,;)]+$/, "");
  return id && /^[\x21-\x7e]{1,200}$/.test(id) ? id : undefined;
}

/** A host name: labels of letters, digits, and inner hyphens, at most 253 characters. */
export const HOST_NAME: RegExp =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

function checkName(name: string): string {
  return HOST_NAME.test(name) ? name : "localhost";
}

/** One open connection. Every method throws an `SmtpStop` for a failure. */
interface Connection {
  /** The greeting, EHLO, STARTTLS, and AUTH. */
  start(name: string): Promise<void>;
  /** One message transaction. `state.committed` turns true at the 354. */
  send(envelope: SmtpEnvelope, state: { committed: boolean }): Promise<SendResult>;
  rset(): Promise<void>;
  /** QUIT, best effort. The result does not depend on it. */
  quit(): Promise<void>;
  /** Closes the socket. It never throws. */
  close(): Promise<void>;
}

/** Opens a connection. A refusal before the first byte throws an `SmtpStop`. */
function open(settings: SmtpSettings, ctx: SmtpContext): Connection {
  const plainAllowed = settings.security === "none";
  if (plainAllowed && !settings.insecure) {
    throw new SmtpStop("auth", "A plain-text SMTP connection needs insecure set to true.");
  }
  let socket: ProviderSocket;
  try {
    socket = ctx.connect({
      hostname: settings.host,
      port: settings.port,
      secureTransport:
        settings.security === "tls" ? "on" : settings.security === "starttls" ? "starttls" : "off",
    });
  } catch {
    throw new SmtpStop("network", LOST);
  }
  // One deadline for the session. A step that is still open when it passes fails.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new SmtpStop("timeout", TIMEOUT)), ctx.timeoutMs);
  });
  expired.catch(() => {});
  const extensions = new Map<string, string>();
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  let decoder = new TextDecoder();
  let buffer = "";
  let secure = settings.security === "tls";

  /** Races a step against the session deadline, and against `cap` when given. */
  async function timed<T>(step: Promise<T>, cap?: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const racers: Promise<T>[] = [step, expired];
    if (cap !== undefined) {
      racers.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SmtpStop("timeout", TIMEOUT)), cap);
        }),
      );
    }
    // The step may settle after the timeout. Its rejection must not go unhandled.
    step.catch(() => {});
    try {
      return await Promise.race(racers);
    } catch (error) {
      throw error instanceof SmtpStop ? error : new SmtpStop("network", LOST);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Reads one reply, with its continuation lines (`250-...`, then `250 ...`). */
  async function read(cap?: number): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      let end = buffer.indexOf("\n");
      while (end < 0) {
        if (buffer.length > MAX_LINE) throw new SmtpStop("provider_error", BAD_REPLY);
        const chunk = await timed(reader.read(), cap);
        if (chunk.done) throw new SmtpStop("network", LOST);
        buffer += decoder.decode(chunk.value, { stream: true });
        end = buffer.indexOf("\n");
      }
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      const match = /^([2-5]\d\d)([ -]?)(.*)$/.exec(line);
      if (!match || lines.length > MAX_REPLY_LINES) {
        throw new SmtpStop("provider_error", BAD_REPLY);
      }
      lines.push(match[3] ?? "");
      if (match[2] !== "-") return { code: Number(match[1]), text: lines.join("\n") };
    }
  }

  async function write(text: string): Promise<void> {
    await timed(writer.write(utf8(text)));
  }

  async function command(line: string): Promise<Reply> {
    await write(`${line}\r\n`);
    return read();
  }

  /** Writes one command and throws unless the reply has one of the codes. */
  async function expect(line: string, codes: readonly number[], stage: Stage): Promise<Reply> {
    const reply = await command(line);
    if (!codes.includes(reply.code)) throw refusal(reply, stage);
    return reply;
  }

  async function hello(name: string): Promise<void> {
    const reply = await command(`EHLO ${name}`);
    extensions.clear();
    if (reply.code === 250) {
      for (const line of reply.text.split("\n").slice(1)) {
        const [keyword = "", ...rest] = line.trim().split(/[ =]/);
        extensions.set(keyword.toUpperCase(), rest.join(" ").toUpperCase());
      }
      return;
    }
    if (reply.code < 500) throw refusal(reply, "EHLO");
    // Only a server that rejects EHLO gets HELO. HELO has no extensions.
    await expect(`HELO ${name}`, [250], "EHLO");
  }

  /** STARTTLS, then the socket from `startTls()` replaces the plain one. */
  async function startTls(): Promise<void> {
    if (!extensions.has("STARTTLS")) throw new SmtpStop("auth", NO_TLS);
    const reply = await command("STARTTLS");
    if (reply.code !== 220) throw new SmtpStop("auth", NO_TLS);
    // Bytes after the 220 came before the handshake: an injection attempt.
    if (buffer.length > 0) throw new SmtpStop("provider_error", BAD_REPLY);
    reader.releaseLock();
    writer.releaseLock();
    try {
      socket = socket.startTls();
    } catch {
      throw new SmtpStop("network", LOST);
    }
    reader = socket.readable.getReader();
    writer = socket.writable.getWriter();
    decoder = new TextDecoder();
    secure = true;
  }

  /** Throws unless the connection is TLS, or plain text is allowed. */
  function requireSecure(): void {
    if (!secure && !plainAllowed) throw new SmtpStop("auth", NO_TLS);
  }

  async function auth(username: string, password: string): Promise<void> {
    requireSecure();
    const offered = extensions.get("AUTH")?.split(/\s+/) ?? [];
    if (offered.includes("PLAIN")) {
      const token = bytesToBase64(utf8(`\0${username}\0${password}`));
      const reply = await command(`AUTH PLAIN ${token}`);
      if (reply.code === 334) await expect(token, [235], "AUTH");
      else if (reply.code !== 235) throw refusal(reply, "AUTH");
      return;
    }
    if (!offered.includes("LOGIN")) {
      throw new SmtpStop("auth", "The SMTP server offers no PLAIN or LOGIN login.");
    }
    await expect("AUTH LOGIN", [334], "AUTH");
    await expect(bytesToBase64(utf8(username)), [334], "AUTH");
    await expect(bytesToBase64(utf8(password)), [235], "AUTH");
  }

  return {
    async start(name) {
      const greeting = await read();
      if (greeting.code !== 220) throw refusal(greeting, "greeting");
      await hello(name);
      if (settings.security === "starttls") {
        await startTls();
        await hello(name);
      }
      if (settings.username !== "" || settings.password !== "") {
        await auth(settings.username, settings.password);
      }
    },

    async send(envelope, state) {
      requireSecure();
      const wire = dotStuff(envelope.data);
      const bytes = utf8(wire).length;
      const size = Number(extensions.get("SIZE") ?? "0");
      if (size > 0 && bytes > size) {
        throw new SmtpStop(
          "invalid_message",
          "The message is larger than the SMTP server accepts.",
          "message",
        );
      }
      const wide = [envelope.from, ...envelope.recipients].some((item) => NON_ASCII.test(item));
      if (wide && !extensions.has("SMTPUTF8")) {
        throw new SmtpStop(
          "unsupported",
          "The SMTP server does not accept non-ASCII addresses.",
          "message",
        );
      }
      const params = `${extensions.has("SIZE") ? ` SIZE=${bytes}` : ""}${wide ? " SMTPUTF8" : ""}`;
      await expect(`MAIL FROM:<${envelope.from}>${params}`, [250], "MAIL FROM");
      for (const recipient of envelope.recipients) {
        await expect(`RCPT TO:<${recipient}>`, [250, 251], "RCPT TO");
      }
      await expect("DATA", [354], "DATA");
      state.committed = true;
      await write(wire);
      const reply = await read();
      if (reply.code !== 250) {
        // The server has the whole message. A refusal here is not proof that no copy
        // went out, so the status stays unknown. The session can go on.
        throw new SmtpStop(
          "provider_error",
          `The SMTP server answered ${reply.code} to the end of DATA.`,
          "message",
        );
      }
      return { status: "sent", providerMessageId: queueId(reply.text) ?? envelope.messageId };
    },

    async rset() {
      await expect("RSET", [250], "RSET");
    },

    async quit() {
      try {
        await write("QUIT\r\n");
        await read(2_000);
      } catch {
        // The server may close first.
      }
    },

    async close() {
      try {
        reader.releaseLock();
        writer.releaseLock();
      } catch {
        // A pending read keeps the lock. close() ends it.
      }
      // The socket must close even after the deadline. The deadline never fires now.
      if (deadline !== undefined) clearTimeout(deadline);
      try {
        await timed(socket.close(), 1_000);
      } catch {
        // Closing is best effort.
      }
    },
  };
}

function heloName(settings: SmtpSettings, from: string | undefined): string {
  if (settings.heloName) return checkName(settings.heloName);
  return checkName(from?.slice(from.lastIndexOf("@") + 1) ?? "");
}

function notSent(reason: FailureReason, message: string): NotSentResult {
  return { status: "not_sent", reason, message };
}

function asStop(error: unknown): SmtpStop {
  return error instanceof SmtpStop ? error : new SmtpStop("network", LOST);
}

/**
 * Sends messages on one connection. It returns one result per envelope, in order. It
 * never throws.
 */
export async function sendSmtp(
  envelopes: readonly SmtpEnvelope[],
  settings: SmtpSettings,
  ctx: SmtpContext,
): Promise<SendResult[]> {
  const results: SendResult[] = [];
  let connection: Connection | null = null;
  try {
    connection = open(settings, ctx);
    await connection.start(heloName(settings, envelopes[0]?.from));
  } catch (error) {
    const stop = asStop(error);
    await connection?.close();
    return envelopes.map(() => notSent(stop.reason, stop.message));
  }
  let dirty = false;
  let ended: SmtpStop | null = null;
  for (const envelope of envelopes) {
    if (ended) {
      results.push(notSent(ended.reason, "The SMTP session ended before this email was sent."));
      continue;
    }
    const state = { committed: false };
    try {
      if (dirty) await connection.rset();
      dirty = false;
      results.push(await connection.send(envelope, state));
    } catch (error) {
      const stop = asStop(error);
      const status = state.committed ? "unknown" : "not_sent";
      results.push({ status, reason: stop.reason, message: stop.message });
      if (stop.scope === "session") ended = stop;
      else dirty = !state.committed;
    }
  }
  if (!ended) await connection.quit();
  await connection.close();
  return results;
}

/** The outcome of `checkSmtp`. */
export type SmtpCheck = { ok: true } | (NotSentResult & { ok: false });

/** Checks the settings: the greeting, TLS, and AUTH, then QUIT. It sends no message. */
export async function checkSmtp(settings: SmtpSettings, ctx: SmtpContext): Promise<SmtpCheck> {
  let connection: Connection | null = null;
  try {
    connection = open(settings, ctx);
    await connection.start(heloName(settings, undefined));
    await connection.quit();
    return { ok: true };
  } catch (error) {
    const stop = asStop(error);
    return { ...notSent(stop.reason, stop.message), ok: false };
  } finally {
    await connection?.close();
  }
}
