// The SMTP adapter over a real socket: node:net and node:tls against a tiny SMTP server
// in this process. The STARTTLS test makes a throwaway certificate with openssl. It is
// skipped when openssl is not on the PATH.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SendContext } from "../../src/core/adapter";
import type { SocketConnect } from "../../src/core/socket";
import { smtp } from "../../src/providers/smtp/index";
import { loadNode } from "../scaffold/node";
import {
  loadNodeSockets,
  type NodeServer,
  type NodeSocket,
  type NodeSocketApis,
  nodeConnect,
} from "./smtp-node-socket";

interface ServerOptions {
  /** The TLS key and certificate. Without them, the server offers no STARTTLS and no AUTH. */
  tls?: { key: string; cert: string };
  username?: string;
  password?: string;
}

interface Received {
  from: string;
  to: string[];
  wire: string;
  secure: boolean;
}

interface TestServer {
  port: number;
  messages: Received[];
  /** Every command line, with the TLS state at the time. */
  commands: { line: string; secure: boolean }[];
  close(): Promise<void>;
}

const decoder = new TextDecoder();

function startServer(apis: NodeSocketApis, options: ServerOptions = {}): Promise<TestServer> {
  const messages: Received[] = [];
  const commands: { line: string; secure: boolean }[] = [];
  const sockets: NodeSocket[] = [];
  const server: NodeServer = apis.net.createServer((raw) => {
    sockets.push(raw);
    let socket = raw;
    let secure = false;
    let buffer = "";
    let data: string[] | null = null;
    let envelope: { from: string; to: string[] } = { from: "", to: [] };
    const reply = (text: string) => socket.write(`${text}\r\n`);
    const line = (text: string) => {
      if (data) {
        if (text !== ".") {
          data.push(text);
          return;
        }
        messages.push({ ...envelope, wire: data.join("\r\n"), secure });
        data = null;
        reply(`250 2.0.0 Ok: queued as N${messages.length}`);
        return;
      }
      commands.push({ line: text, secure });
      const verb = text.split(" ")[0]?.toUpperCase();
      if (verb === "EHLO") {
        const lines = ["localhost"];
        if (options.tls && !secure) lines.push("STARTTLS");
        if (secure) lines.push("AUTH PLAIN");
        for (const [index, item] of lines.entries()) {
          reply(`250${index === lines.length - 1 ? " " : "-"}${item}`);
        }
      } else if (verb === "STARTTLS" && options.tls) {
        reply("220 2.0.0 Ready to start TLS");
        raw.off("data", onData);
        socket = new apis.tls.TLSSocket(raw, { isServer: true, ...options.tls });
        socket.on("data", onData);
        socket.on("error", () => {});
        secure = true;
      } else if (verb === "AUTH") {
        const token = atob(text.split(" ")[2] ?? "");
        const ok = token === `\0${options.username}\0${options.password}`;
        reply(ok ? "235 2.7.0 Authentication successful" : "535 5.7.8 Bad login");
      } else if (verb === "MAIL") {
        envelope = { from: /<([^>]*)>/.exec(text)?.[1] ?? "", to: [] };
        reply("250 2.1.0 Ok");
      } else if (verb === "RCPT") {
        envelope.to.push(/<([^>]*)>/.exec(text)?.[1] ?? "");
        reply("250 2.1.5 Ok");
      } else if (verb === "DATA") {
        data = [];
        reply("354 End data with <CR><LF>.<CR><LF>");
      } else if (verb === "QUIT") {
        reply("221 2.0.0 Bye");
        socket.end();
      } else reply("502 5.5.2 Command not recognized");
    };
    const onData = (chunk: Uint8Array) => {
      buffer += decoder.decode(chunk);
      let end = buffer.indexOf("\r\n");
      while (end >= 0) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        line(text);
        end = buffer.indexOf("\r\n");
      }
    };
    raw.on("data", onData);
    raw.on("error", () => {});
    reply("220 localhost ESMTP test server");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        messages,
        commands,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}

function context(connect: SocketConnect, credentials: Record<string, string>): SendContext {
  return {
    fetch: async () => {
      throw new TypeError("no HTTP");
    },
    timeoutMs: 5000,
    credentials,
    now: Date.now(),
    connect,
  };
}

const message = {
  from: "sender@example.com",
  to: ["ana@example.org"],
  subject: "Real socket",
  text: ".a line with a leading dot\nend",
};

async function selfSigned(): Promise<{ key: string; cert: string } | null> {
  const { child } = await loadNode();
  const result = child.spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      "/dev/stdout",
      "-out",
      "/dev/stdout",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-days",
      "1",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  if (result.status !== 0) return null;
  const key = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/.exec(result.stdout);
  const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(result.stdout);
  return key && cert ? { key: `${key[0]}\n`, cert: `${cert[0]}\n` } : null;
}

let apis: NodeSocketApis;
let pem: { key: string; cert: string } | null = null;
const servers: TestServer[] = [];

beforeAll(async () => {
  apis = await loadNodeSockets();
  pem = await selfSigned();
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe("SMTP over node:net", () => {
  it("sends to a Mailpit-style server in plain text", async () => {
    const server = await startServer(apis);
    servers.push(server);
    const credentials = { preset: "mailpit", host: "127.0.0.1", port: String(server.port) };
    const result = await smtp().send(message, context(nodeConnect(apis), credentials));
    expect(result).toEqual({ status: "sent", providerMessageId: "N1", provider: "smtp" });
    expect(server.messages[0]).toMatchObject({
      from: "sender@example.com",
      to: ["ana@example.org"],
      secure: false,
    });
    expect(server.messages[0]?.wire).toContain("\r\n..a line with a leading dot\r\n");
  });

  it("refuses the same server without the insecure preset", async () => {
    const server = await startServer(apis);
    servers.push(server);
    const credentials = { host: "127.0.0.1", port: String(server.port) };
    const result = await smtp().send(message, context(nodeConnect(apis), credentials));
    // The server offers no STARTTLS, so no AUTH and no message goes out.
    expect(result).toMatchObject({ status: "not_sent", reason: "auth" });
    expect(server.messages).toHaveLength(0);
  });

  it("upgrades with STARTTLS and logs in only over TLS", async (test) => {
    if (!pem) test.skip();
    const tlsPem = pem as { key: string; cert: string };
    const server = await startServer(apis, {
      tls: tlsPem,
      username: "sender@example.com",
      password: "s3cret",
    });
    servers.push(server);
    const credentials = {
      host: "localhost",
      port: String(server.port),
      security: "starttls",
      username: "sender@example.com",
      password: "s3cret",
    };
    const connect = nodeConnect(apis, { ca: tlsPem.cert });
    expect(await smtp().verify(context(connect, credentials))).toEqual({ ok: true });
    const result = await smtp().send(message, context(connect, credentials));
    expect(result).toMatchObject({ status: "sent", provider: "smtp" });
    expect(server.messages.at(-1)?.secure).toBe(true);
    const auth = server.commands.filter((item) => item.line.startsWith("AUTH"));
    expect(auth.length).toBe(2);
    expect(auth.every((item) => item.secure)).toBe(true);
  });

  it("gives not_sent when the TLS certificate is not trusted", async (test) => {
    if (!pem) test.skip();
    const server = await startServer(apis, { tls: pem as { key: string; cert: string } });
    servers.push(server);
    const credentials = {
      host: "localhost",
      port: String(server.port),
      security: "starttls",
      username: "sender@example.com",
      password: "s3cret",
    };
    const result = await smtp().send(message, context(nodeConnect(apis), credentials));
    expect(result).toMatchObject({ status: "not_sent", reason: "network" });
    expect(server.commands.some((item) => item.line.startsWith("AUTH"))).toBe(false);
  });
});
