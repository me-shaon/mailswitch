import { describe, expect, it } from "vitest";
import {
  BREVO_FIXTURE_TOKEN,
  BREVO_MESSAGE_ID,
  brevoEvent,
} from "../../src/conformance/fixtures/smtp";
import { type MockSmtpOptions, mockSmtp, parseMail } from "../../src/conformance/mock-smtp";
import type { SendContext } from "../../src/core/adapter";
import { parseCredentials } from "../../src/core/credentials";
import type { SocketConnect } from "../../src/core/socket";
import type { OutgoingMessage, SendResult } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import {
  brevoWebhooks,
  checkBrevoWebhookToken,
  generateBrevoWebhookToken,
} from "../../src/providers/smtp/brevo-webhooks";
import {
  BREVO_FREE_DAILY_CAP,
  dotStuff,
  GMAIL_DAILY_CAP,
  queueId,
  resolveSmtpSettings,
  smtp,
  smtpMeta,
  smtpPreset,
  WORKSPACE_DAILY_CAP,
} from "../../src/providers/smtp/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const USER = "sender@example.com";
const PASS = "pässword-with-ümlauts-1";
const CREDS = {
  host: "smtp.example.com",
  port: "587",
  security: "starttls",
  username: USER,
  password: PASS,
};

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: { email: "sender@example.com", name: "Acme Billing" },
    to: ["ana@example.org"],
    subject: "Your receipt",
    text: "Thanks for your order.",
    html: "<p>Thanks for your order.</p>",
    ...overrides,
  };
}

function server(options: MockSmtpOptions = {}) {
  return mockSmtp({ username: USER, password: PASS, ...options });
}

function ctx(
  connect: SocketConnect,
  credentials: Record<string, string> = CREDS,
  timeoutMs = 1000,
): SendContext {
  return {
    fetch: async () => {
      throw new TypeError("no HTTP");
    },
    timeoutMs,
    credentials,
    now: NOW,
    connect,
  };
}

const on =
  (verb: string, answer: string): MockSmtpOptions["reply"] =>
  (command) =>
    command.verb === verb ? answer : undefined;

/** Every form of the login that must stay out of results. */
function authForms(user: string, pass: string): string[] {
  const b64 = (text: string) => bytesToBase64(utf8(text)).replace(/=+$/, "");
  return [pass, b64(pass), b64(user), b64(`\0${user}\0${pass}`)];
}

describe("SMTP send", () => {
  it("sends over STARTTLS and returns the queue id", async () => {
    const mock = server();
    const result = await smtp().send(message(), ctx(mock.connect));
    expect(result).toEqual({ status: "sent", providerMessageId: "M1", provider: "smtp" });
    expect(mock.sessions[0]?.target).toEqual({
      hostname: "smtp.example.com",
      port: 587,
      secureTransport: "starttls",
    });
    expect(mock.sessions[0]?.authOverPlaintext).toBe(false);
    expect(mock.messages[0]).toMatchObject({ from: USER, to: ["ana@example.org"], secure: true });
  });

  it("builds valid multipart/mixed output for an attachment", async () => {
    const mock = server();
    const pdf = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) % 256);
    const result = await smtp().send(
      message({
        subject: "Ihre Rechnung für Oktober",
        attachments: [
          { filename: "Rechnung März.pdf", content: pdf, contentType: "application/pdf" },
        ],
      }),
      ctx(mock.connect),
    );
    expect(result.status).toBe("sent");
    const data = mock.messages[0]?.data ?? "";
    const lines = data.split("\r\n");
    expect(lines.every((line) => line.length <= 998)).toBe(true);
    expect(/[^\r]\n|\r[^\n]/.test(data)).toBe(false);
    const parsed = parseMail(data);
    const type = parsed.headers.get("content-type") ?? "";
    expect(type).toMatch(/^multipart\/mixed; boundary="=_ms_[0-9a-f]{32}"$/);
    const boundary = /boundary="([^"]+)"/.exec(type)?.[1] as string;
    expect(lines.filter((line) => line === `--${boundary}`)).toHaveLength(2);
    expect(lines.at(-1)).toBe(`--${boundary}--`);
    expect(parsed.headers.get("subject")).toBe("Ihre Rechnung für Oktober");
    expect(parsed.text).toBe("Thanks for your order.");
    expect(parsed.attachments).toEqual([
      {
        filename: "Rechnung März.pdf",
        contentType: "application/pdf",
        content: bytesToBase64(pdf),
        inline: false,
      },
    ]);
    // The base64 body of the attachment is in lines of 76 characters.
    const start = lines.findIndex((line) => line.startsWith(bytesToBase64(pdf).slice(0, 20)));
    const body = lines.slice(start, lines.indexOf(`--${boundary}--`));
    expect(body.slice(0, -1).every((line) => line.length === 76)).toBe(true);
    expect((body.at(-1) as string).length).toBeLessThanOrEqual(76);
  });

  it("escapes a line that starts with a dot", async () => {
    const mock = server();
    const text = ".hidden\n.\nplain\n..two";
    await smtp().send(message({ text, html: undefined }), ctx(mock.connect));
    const sent = mock.messages[0];
    expect(sent?.wire).toContain("\r\n..hidden\r\n..\r\nplain\r\n...two");
    expect(parseMail(sent?.data ?? "").text).toBe(text.replaceAll("\n", "\r\n"));
    expect(dotStuff(".a\r\nb\r\n.")).toBe("..a\r\nb\r\n..\r\n.\r\n");
  });

  it("maps a 535 to not_sent/auth and writes no MAIL FROM", async () => {
    const mock = server({ password: "another" });
    const result = await smtp().send(message(), ctx(mock.connect));
    expect(result).toMatchObject({ status: "not_sent", reason: "auth", provider: "smtp" });
    expect(mock.sessions[0]?.commands.some((line) => line.startsWith("MAIL"))).toBe(false);
  });

  it("maps a connect failure before DATA to not_sent", async () => {
    const thrown = await smtp().send(
      message(),
      ctx(() => {
        throw new TypeError("connection refused");
      }),
    );
    expect(thrown).toMatchObject({ status: "not_sent", reason: "network" });
    for (const verb of ["CONNECT", "EHLO", "STARTTLS", "AUTH", "MAIL", "RCPT", "DATA"]) {
      const mock = server({ reply: on(verb, "disconnect") as MockSmtpOptions["reply"] });
      const result = await smtp().send(message(), ctx(mock.connect));
      expect(result.status, verb).toBe("not_sent");
      expect(mock.messages).toHaveLength(0);
    }
  });

  it("maps a drop after DATA to unknown", async () => {
    const mock = server({ reply: on("DATA_END", "disconnect") });
    const result = await smtp().send(message(), ctx(mock.connect));
    expect(result).toMatchObject({ status: "unknown", reason: "network" });
    const silent = server({ reply: on("DATA_END", "timeout") });
    expect(await smtp().send(message(), ctx(silent.connect, CREDS, 30))).toMatchObject({
      status: "unknown",
      reason: "timeout",
    });
    const refused = server({ reply: on("DATA_END", "554 5.7.1 Spam detected") });
    expect((await smtp().send(message(), ctx(refused.connect))).status).toBe("unknown");
  });

  it("maps throttles, quotas, and refusals before DATA", async () => {
    const cases: [string, string, string, string][] = [
      ["CONNECT", "421 4.7.0 Try again later", "not_sent", "rate_limited"],
      ["MAIL", "451 4.7.1 Please slow down", "not_sent", "rate_limited"],
      ["MAIL", "550 5.4.5 Daily user sending limit exceeded", "not_sent", "quota"],
      ["MAIL", "553 5.7.1 Sender not owned by user", "not_sent", "rejected"],
      ["RCPT", "550 5.1.1 No such user", "not_sent", "rejected"],
      ["RCPT", "452 4.5.3 Too many recipients", "not_sent", "invalid_message"],
      ["MAIL", "530 5.7.0 Authentication required", "not_sent", "auth"],
    ];
    for (const [verb, reply, status, reason] of cases) {
      const mock = server({ reply: on(verb, reply) });
      const result = await smtp().send(message(), ctx(mock.connect));
      expect(result, reply).toMatchObject({ status, reason });
    }
  });

  it("keeps AUTH data out of every result", async () => {
    const forms = authForms(USER, PASS);
    const results: unknown[] = [];
    const modes: [MockSmtpOptions, number][] = [
      [{ password: "wrong" }, 1000],
      [{ reply: on("AUTH", "disconnect") }, 1000],
      [{ reply: on("AUTH", "454 4.7.0 Temporary authentication failure") }, 1000],
      [{ reply: on("RCPT", "timeout") }, 30],
      [{ reply: on("DATA_END", "451 4.3.0 rejected") }, 1000],
      [{ authMechanisms: ["LOGIN"], password: "wrong" }, 1000],
    ];
    for (const [options, timeout] of modes) {
      const mock = server(options);
      results.push(await smtp().send(message(), ctx(mock.connect, CREDS, timeout)));
      results.push(await smtp().verify(ctx(server(options).connect, CREDS, timeout)));
      // The AUTH line did go out, so the search proves something.
      expect(mock.sessions[0]?.commands.join("\n")).toMatch(/AUTH/);
    }
    const text = JSON.stringify(results);
    for (const form of forms) expect(text).not.toContain(form);
    expect(text).not.toContain(USER);
  });

  it("supports AUTH LOGIN", async () => {
    const mock = server({ authMechanisms: ["LOGIN"] });
    expect((await smtp().send(message(), ctx(mock.connect))).status).toBe("sent");
    expect(mock.sessions[0]?.commands).toContain("AUTH LOGIN");
  });

  it("refuses a server without STARTTLS and writes no AUTH line", async () => {
    const mock = server({ starttls: false, authBeforeTls: true });
    const result = await smtp().send(message(), ctx(mock.connect));
    expect(result).toMatchObject({ status: "not_sent", reason: "auth" });
    const commands = mock.sessions[0]?.commands ?? [];
    expect(commands.some((line) => line.startsWith("AUTH"))).toBe(false);
    expect(commands.some((line) => line.startsWith("MAIL"))).toBe(false);
    expect(mock.sessions[0]?.authOverPlaintext).toBe(false);
  });

  it("refuses a plain connection without insecure, before it connects", async () => {
    const mock = server();
    const plain = { ...CREDS, security: "none", insecure: "false" };
    const result = await smtp().send(message(), ctx(mock.connect, plain));
    expect(result).toMatchObject({ status: "not_sent", reason: "auth" });
    expect(mock.sessions).toHaveLength(0);
    expect(await smtp().verify(ctx(mock.connect, plain))).toMatchObject({ ok: false });
  });

  it("connects to Mailpit without TLS", async () => {
    const mock = mockSmtp({ authRequired: false });
    const credentials = { preset: "mailpit", host: "localhost" };
    const result = await smtp().send(message(), ctx(mock.connect, credentials));
    expect(result.status).toBe("sent");
    expect(mock.sessions[0]?.target).toEqual({
      hostname: "localhost",
      port: 1025,
      secureTransport: "off",
    });
    expect(mock.sessions[0]?.commands.some((line) => line.startsWith("STARTTLS"))).toBe(false);
    expect(mock.messages[0]?.secure).toBe(false);
    const crab = mockSmtp({ authRequired: false });
    const viaPreset = parseCredentials(smtpMeta, { host: "mailcrab" }, "mailcrab");
    if (!viaPreset.ok) throw new Error("credentials");
    expect((await smtp().send(message(), ctx(crab.connect, viaPreset.values))).status).toBe("sent");
    expect(crab.sessions[0]?.target.secureTransport).toBe("off");
  });

  it("connects with implicit TLS on port 465", async () => {
    const mock = server({ starttls: false });
    const credentials = { ...CREDS, security: "tls", port: "" };
    expect((await smtp().send(message(), ctx(mock.connect, credentials))).status).toBe("sent");
    expect(mock.sessions[0]?.target).toMatchObject({ port: 465, secureTransport: "on" });
  });

  it("sends a bcc in the envelope only", async () => {
    const mock = server();
    await smtp().send(
      message({ cc: ["cc@example.org"], bcc: ["hidden@example.org"] }),
      ctx(mock.connect),
    );
    expect(mock.messages[0]?.to).toEqual([
      "ana@example.org",
      "cc@example.org",
      "hidden@example.org",
    ]);
    expect(mock.messages[0]?.data).not.toContain("hidden@example.org");
  });

  it("refuses a message above the advertised SIZE before MAIL FROM", async () => {
    const mock = server();
    const result = await smtp().send(message({ html: "a".repeat(10_485_761) }), ctx(mock.connect));
    expect(result).toMatchObject({ status: "not_sent", reason: "invalid_message" });
    expect(mock.sessions[0]?.commands.some((line) => line.startsWith("MAIL"))).toBe(false);
  });

  it("returns not_sent/unsupported with no connect function", async () => {
    const { connect: _connect, ...rest } = ctx(server().connect);
    expect(await smtp().send(message(), rest)).toMatchObject({
      status: "not_sent",
      reason: "unsupported",
    });
  });

  it("uses the connect option when the context has none", async () => {
    const mock = server();
    const { connect: _connect, ...rest } = ctx(mock.connect);
    expect((await smtp({ connect: mock.connect }).send(message(), rest)).status).toBe("sent");
  });

  it("throws for an invalid heloName", () => {
    expect(() => smtp({ heloName: "bad name" })).toThrow(TypeError);
  });
});

describe("SMTP sendBatch", () => {
  it("sends every message on one connection", async () => {
    const mock = server();
    const results = await smtp().sendBatch?.(
      [message(), message({ to: ["ben@example.org"] })],
      ctx(mock.connect),
    );
    expect(results?.map((item) => item.status)).toEqual(["sent", "sent"]);
    expect(mock.sessions).toHaveLength(1);
    expect(mock.messages.map((item) => item.to[0])).toEqual(["ana@example.org", "ben@example.org"]);
  });

  it("goes on after a refused recipient, with RSET", async () => {
    const mock = server({
      reply: (command) =>
        command.verb === "RCPT" && command.arg.includes("bad@")
          ? "550 5.1.1 No such user"
          : undefined,
    });
    const results = (await smtp().sendBatch?.(
      [message({ to: ["bad@example.org"] }), message({ to: ["ben@example.org"] })],
      ctx(mock.connect),
    )) as SendResult[];
    expect(results.map((item) => item.status)).toEqual(["not_sent", "sent"]);
    expect(mock.sessions[0]?.commands).toContain("RSET");
  });

  it("gives unknown to the message in flight and not_sent to the rest after a drop", async () => {
    const mock = server({
      reply: (command) =>
        command.verb === "DATA_END" && command.accepted === 1 ? "disconnect" : undefined,
    });
    const results = (await smtp().sendBatch?.(
      [message(), message(), message()],
      ctx(mock.connect),
    )) as SendResult[];
    expect(results.map((item) => item.status)).toEqual(["sent", "unknown", "not_sent"]);
  });

  it("refuses an invalid message on its own", async () => {
    const mock = server();
    const results = (await smtp().sendBatch?.(
      [message({ to: ["not an address"] }), message()],
      ctx(mock.connect),
    )) as SendResult[];
    expect(results.map((item) => item.status)).toEqual(["not_sent", "sent"]);
  });
});

describe("SMTP verify", () => {
  it("logs in and sends no message", async () => {
    const mock = server();
    expect(await smtp().verify(ctx(mock.connect))).toEqual({ ok: true });
    expect(mock.messages).toHaveLength(0);
    expect(mock.sessions[0]?.commands.at(-1)).toBe("QUIT");
  });
});

describe("SMTP presets", () => {
  it("keeps the caps of Gmail, Workspace, and Brevo", () => {
    expect(smtpPreset("gmail")?.defaultDailyCap).toBe(GMAIL_DAILY_CAP);
    expect(smtpPreset("google-workspace")?.defaultDailyCap).toBe(WORKSPACE_DAILY_CAP);
    expect(smtpPreset("brevo")?.defaultDailyCap).toBe(BREVO_FREE_DAILY_CAP);
    expect([GMAIL_DAILY_CAP, WORKSPACE_DAILY_CAP, BREVO_FREE_DAILY_CAP]).toEqual([500, 2000, 300]);
    expect(smtpMeta.presets?.map((preset) => preset.id)).toEqual([
      "gmail",
      "google-workspace",
      "brevo",
      "mailpit",
      "mailcrab",
      "custom",
    ]);
  });

  it("sets insecure only for Mailpit and MailCrab", () => {
    const plain = smtpMeta.presets?.filter((preset) => preset.fixed.insecure === "true");
    expect(plain?.map((preset) => preset.id)).toEqual(["mailpit", "mailcrab"]);
  });

  it("fixes the Gmail host and removes the spaces of an app password", () => {
    const resolved = resolveSmtpSettings({
      preset: "gmail",
      host: "evil.example.com",
      username: "me@gmail.com",
      password: "abcd efgh ijkl mnop",
    });
    expect(resolved).toMatchObject({
      ok: true,
      settings: {
        host: "smtp.gmail.com",
        port: 587,
        security: "starttls",
        password: "abcdefghijklmnop",
      },
    });
  });

  it("takes the credentials over the options", () => {
    const resolved = resolveSmtpSettings(
      { host: "a.example.com" },
      { host: "b.example.com", port: 2525 },
    );
    expect(resolved).toMatchObject({ ok: true, settings: { host: "a.example.com", port: 2525 } });
    expect(resolveSmtpSettings({ host: "bad host" })).toMatchObject({ ok: false });
    expect(resolveSmtpSettings({ host: "a.example.com", port: "70000" })).toMatchObject({
      ok: false,
    });
  });

  it("parses queue ids", () => {
    expect(queueId("2.0.0 Ok: queued as 4Bx9Zp1kqKz")).toBe("4Bx9Zp1kqKz");
    expect(queueId("OK id=1qXyz-000abc-00")).toBe("1qXyz-000abc-00");
    expect(queueId("2.0.0 OK  1792929598 a1-20020a gsmtp")).toBeUndefined();
  });

  it("falls back to the Message-ID when the server gives no queue id", async () => {
    const mock = server({ reply: on("DATA_END", "250 2.0.0 OK 1792929598 gsmtp") });
    // An override of DATA_END answers without a capture, so only the result is checked.
    const result = await smtp().send(message(), ctx(mock.connect));
    expect(result).toMatchObject({ status: "sent" });
    expect((result as { providerMessageId?: string }).providerMessageId).toMatch(
      /^<[0-9a-f]{32}@example\.com>$/,
    );
  });
});

describe("Brevo webhooks", () => {
  const hooks = smtp({ webhooks: brevoWebhooks() }).webhooks;
  const body = utf8(JSON.stringify(brevoEvent("hard_bounce", "ana@example.org")));

  it("accepts the bearer token in any case of the scheme", async () => {
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      const headers = new Headers({ authorization: `${scheme} ${BREVO_FIXTURE_TOKEN}` });
      expect(await hooks.verify({ headers, body, secret: BREVO_FIXTURE_TOKEN, now: NOW })).toEqual({
        ok: true,
      });
    }
  });

  it("refuses a Basic header and a weak secret", async () => {
    const headers = new Headers({ authorization: `Basic ${BREVO_FIXTURE_TOKEN}` });
    expect(await hooks.verify({ headers, body, secret: BREVO_FIXTURE_TOKEN, now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    await expect(hooks.verify({ headers, body, secret: "short", now: NOW })).rejects.toThrow(
      /too short/,
    );
    expect(() => checkBrevoWebhookToken(generateBrevoWebhookToken())).not.toThrow();
  });

  it("maps events and drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const request = () =>
      new Request("https://app.example.com/hooks/brevo", {
        method: "POST",
        headers: { authorization: `Bearer ${BREVO_FIXTURE_TOKEN}` },
        body,
      });
    const first = await handleWebhook(request(), {
      adapter: smtp({ webhooks: brevoWebhooks() }),
      secret: BREVO_FIXTURE_TOKEN,
      dedupe,
    });
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([
      {
        type: "bounced",
        bounce: "hard",
        provider: "smtp",
        providerMessageId: BREVO_MESSAGE_ID,
        recipient: "ana@example.org",
      },
    ]);
    await first.ack();
    expect(
      await handleWebhook(request(), {
        adapter: smtp({ webhooks: brevoWebhooks() }),
        secret: BREVO_FIXTURE_TOKEN,
        dedupe,
      }),
    ).toMatchObject({ ok: true, events: [] });
  });
});
