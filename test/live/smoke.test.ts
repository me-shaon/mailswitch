import { describe, expect, it } from "vitest";
import { brevo } from "../../src/providers/brevo/index";
import { mailersend } from "../../src/providers/mailersend/index";
import { mailjet } from "../../src/providers/mailjet/index";
import { resend } from "../../src/providers/resend/index";
import { sendgrid } from "../../src/providers/sendgrid/index";
import { smtp2go } from "../../src/providers/smtp2go/index";
import { tosend } from "../../src/providers/tosend/index";
import { zeptomail } from "../../src/providers/zeptomail/index";

// Live smoke tests call real provider APIs. They run only when their env vars are set,
// so CI makes no live calls. The provider units add a send test to each block:
//
// - Resend (U5): MAILSWITCH_LIVE_RESEND_KEY, MAILSWITCH_LIVE_RESEND_FROM, MAILSWITCH_LIVE_TO.
// - toSend (U6): MAILSWITCH_LIVE_TOSEND_KEY, MAILSWITCH_LIVE_TOSEND_FROM, MAILSWITCH_LIVE_TOSEND_TO.
// - SendGrid: MAILSWITCH_LIVE_SENDGRID_KEY, MAILSWITCH_LIVE_SENDGRID_FROM, MAILSWITCH_LIVE_TO.
//   It uses sandbox mode, so SendGrid checks the request and delivers no email.
// - Brevo: MAILSWITCH_LIVE_BREVO_KEY, MAILSWITCH_LIVE_BREVO_FROM, MAILSWITCH_LIVE_TO.
//   It sends the X-Sib-Sandbox: drop header, so Brevo checks the request and sends no email.
// - MailerSend: MAILSWITCH_LIVE_MAILERSEND_KEY, MAILSWITCH_LIVE_MAILERSEND_FROM, MAILSWITCH_LIVE_TO.
//   MailerSend has no sandbox flag, so it sends one real email. Set MAILSWITCH_LIVE_TO to an
//   address of the account owner.
// - Mailjet: MAILSWITCH_LIVE_MAILJET_KEY, MAILSWITCH_LIVE_MAILJET_SECRET,
//   MAILSWITCH_LIVE_MAILJET_FROM, MAILSWITCH_LIVE_TO. It uses SandboxMode, so Mailjet checks
//   the request and delivers no email.
// - SMTP2GO: MAILSWITCH_LIVE_SMTP2GO_KEY, MAILSWITCH_LIVE_SMTP2GO_FROM, MAILSWITCH_LIVE_TO.
//   SMTP2GO has no sandbox flag in the request, so it sends one real email. Set
//   MAILSWITCH_LIVE_TO to an address of the account owner.
// - ZeptoMail: MAILSWITCH_LIVE_ZEPTOMAIL_TOKEN, MAILSWITCH_LIVE_ZEPTOMAIL_FROM,
//   MAILSWITCH_LIVE_TO, and the optional MAILSWITCH_LIVE_ZEPTOMAIL_REGION. This block is
//   the release gate of the ZeptoMail verify request. It records that a good token gets
//   400 TM_3201 (ok) and that a wrong token gets 401 TM_4001 (not_sent/auth). Then it sends
//   one real email. The FROM address must be on a verified domain.
//
// Each block checks that its env vars are complete. A block with an adapter also sends.

const env: Readonly<Record<string, string | undefined>> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

function hasLiveEnv(...names: string[]): boolean {
  return names.every((name) => (env[name] ?? "") !== "");
}

const RESEND = ["MAILSWITCH_LIVE_RESEND_KEY", "MAILSWITCH_LIVE_RESEND_FROM", "MAILSWITCH_LIVE_TO"];
const TOSEND = [
  "MAILSWITCH_LIVE_TOSEND_KEY",
  "MAILSWITCH_LIVE_TOSEND_FROM",
  "MAILSWITCH_LIVE_TOSEND_TO",
];
const SENDGRID = [
  "MAILSWITCH_LIVE_SENDGRID_KEY",
  "MAILSWITCH_LIVE_SENDGRID_FROM",
  "MAILSWITCH_LIVE_TO",
];
const BREVO = ["MAILSWITCH_LIVE_BREVO_KEY", "MAILSWITCH_LIVE_BREVO_FROM", "MAILSWITCH_LIVE_TO"];
const MAILERSEND = [
  "MAILSWITCH_LIVE_MAILERSEND_KEY",
  "MAILSWITCH_LIVE_MAILERSEND_FROM",
  "MAILSWITCH_LIVE_TO",
];
const MAILJET = [
  "MAILSWITCH_LIVE_MAILJET_KEY",
  "MAILSWITCH_LIVE_MAILJET_SECRET",
  "MAILSWITCH_LIVE_MAILJET_FROM",
  "MAILSWITCH_LIVE_TO",
];
const SMTP2GO = [
  "MAILSWITCH_LIVE_SMTP2GO_KEY",
  "MAILSWITCH_LIVE_SMTP2GO_FROM",
  "MAILSWITCH_LIVE_TO",
];
const ZEPTOMAIL = [
  "MAILSWITCH_LIVE_ZEPTOMAIL_TOKEN",
  "MAILSWITCH_LIVE_ZEPTOMAIL_FROM",
  "MAILSWITCH_LIVE_TO",
];

describe("live smoke gate", () => {
  it("needs every env var of a block", () => {
    expect(hasLiveEnv()).toBe(true);
    expect(hasLiveEnv("MAILSWITCH_LIVE_UNSET_FOR_SURE")).toBe(false);
  });
});

describe.skipIf(!hasLiveEnv(RESEND[0] as string))("live smoke: Resend", () => {
  it("has the env vars of the Resend smoke test", () => {
    expect(hasLiveEnv(...RESEND)).toBe(true);
  });

  it.skipIf(!hasLiveEnv(...RESEND))("verifies the key and sends one email", async () => {
    const adapter = resend();
    const ctx = {
      fetch: (input: string, init: RequestInit) => fetch(input, init),
      timeoutMs: 15_000,
      credentials: { apiKey: env.MAILSWITCH_LIVE_RESEND_KEY as string },
      now: Date.now(),
    };
    expect(await adapter.verify(ctx)).toEqual({ ok: true });
    const result = await adapter.send(
      {
        from: env.MAILSWITCH_LIVE_RESEND_FROM as string,
        to: [env.MAILSWITCH_LIVE_TO as string],
        subject: "mailswitch live smoke test (Resend)",
        text: "This email comes from the mailswitch live smoke test.",
        idempotencyKey: `mailswitch-smoke-${Date.now()}`,
      },
      ctx,
    );
    expect(result).toMatchObject({ status: "sent", provider: "resend" });
  });
});

describe.skipIf(!hasLiveEnv(TOSEND[0] as string))("live smoke: toSend", () => {
  it("has the env vars of the toSend smoke test", () => {
    expect(hasLiveEnv(...TOSEND)).toBe(true);
  });

  it.skipIf(!hasLiveEnv(...TOSEND))("verifies the key and sends one email", async () => {
    const adapter = tosend();
    const ctx = {
      fetch: (input: string, init: RequestInit) => fetch(input, init),
      timeoutMs: 15_000,
      credentials: { apiKey: env.MAILSWITCH_LIVE_TOSEND_KEY ?? "" },
      now: Date.now(),
    };
    expect(await adapter.verify(ctx)).toEqual({ ok: true });
    const result = await adapter.send(
      {
        from: env.MAILSWITCH_LIVE_TOSEND_FROM ?? "",
        to: [env.MAILSWITCH_LIVE_TOSEND_TO ?? ""],
        subject: "mailswitch live smoke test (toSend)",
        text: "This email comes from the mailswitch live smoke test.",
      },
      ctx,
    );
    expect(result.status).toBe("sent");
  });
});

describe.skipIf(!hasLiveEnv(SENDGRID[0] as string))("live smoke: SendGrid", () => {
  it("has the env vars of the SendGrid smoke test", () => {
    expect(hasLiveEnv(...SENDGRID)).toBe(true);
  });

  it.skipIf(!hasLiveEnv(...SENDGRID))("verifies the key and sends in sandbox mode", async () => {
    const adapter = sendgrid({ sandbox: true });
    const ctx = {
      fetch: (input: string, init: RequestInit) => fetch(input, init),
      timeoutMs: 15_000,
      credentials: { apiKey: env.MAILSWITCH_LIVE_SENDGRID_KEY ?? "" },
      now: Date.now(),
    };
    expect(await adapter.verify(ctx)).toEqual({ ok: true });
    const result = await adapter.send(
      {
        from: env.MAILSWITCH_LIVE_SENDGRID_FROM ?? "",
        to: [env.MAILSWITCH_LIVE_TO ?? ""],
        subject: "mailswitch live smoke test (SendGrid sandbox)",
        text: "This request comes from the mailswitch live smoke test. Sandbox mode delivers no email.",
      },
      ctx,
    );
    expect(result).toMatchObject({ status: "sent", provider: "sendgrid" });
  });
});

describe.skipIf(!hasLiveEnv(BREVO[0] as string))("live smoke: Brevo", () => {
  it("has the env vars of the Brevo smoke test", () => {
    expect(hasLiveEnv(...BREVO)).toBe(true);
  });

  it.skipIf(!hasLiveEnv(...BREVO))("verifies the key and sends in sandbox mode", async () => {
    const adapter = brevo({ sandbox: true });
    const ctx = {
      fetch: (input: string, init: RequestInit) => fetch(input, init),
      timeoutMs: 15_000,
      credentials: { apiKey: env.MAILSWITCH_LIVE_BREVO_KEY ?? "" },
      now: Date.now(),
    };
    expect(await adapter.verify(ctx)).toEqual({ ok: true });
    const result = await adapter.send(
      {
        from: env.MAILSWITCH_LIVE_BREVO_FROM ?? "",
        to: [env.MAILSWITCH_LIVE_TO ?? ""],
        subject: "mailswitch live smoke test (Brevo sandbox)",
        text: "This request comes from the mailswitch live smoke test. Sandbox mode sends no email.",
        idempotencyKey: `mailswitch-live-${Date.now()}`,
      },
      ctx,
    );
    expect(result).toMatchObject({ status: "sent", provider: "brevo" });
  });
});

describe.skipIf(!hasLiveEnv(MAILERSEND[0] as string))("live smoke: MailerSend", () => {
  it("has the env vars of the MailerSend smoke test", () => {
    expect(hasLiveEnv(...MAILERSEND)).toBe(true);
  });

  it.skipIf(!hasLiveEnv(...MAILERSEND))("verifies the token and sends one email", async () => {
    const adapter = mailersend();
    const ctx = {
      fetch: (input: string, init: RequestInit) => fetch(input, init),
      timeoutMs: 15_000,
      credentials: { apiKey: env.MAILSWITCH_LIVE_MAILERSEND_KEY ?? "" },
      now: Date.now(),
    };
    expect(await adapter.verify(ctx)).toEqual({ ok: true });
    const result = await adapter.send(
      {
        from: env.MAILSWITCH_LIVE_MAILERSEND_FROM ?? "",
        to: [env.MAILSWITCH_LIVE_TO ?? ""],
        subject: "mailswitch live smoke test (MailerSend)",
        text: "This email comes from the mailswitch live smoke test. MailerSend has no sandbox mode.",
      },
      ctx,
    );
    expect(result).toMatchObject({ status: "sent", provider: "mailersend" });
  });
});

describe.skipIf(!hasLiveEnv(MAILJET[0] as string))("live smoke: Mailjet", () => {
  it("has the env vars of the Mailjet smoke test", () => {
    expect(hasLiveEnv(...MAILJET)).toBe(true);
  });

  it.skipIf(!hasLiveEnv(...MAILJET))("verifies the keys and sends in sandbox mode", async () => {
    const adapter = mailjet({ sandbox: true });
    const ctx = {
      fetch: (input: string, init: RequestInit) => fetch(input, init),
      timeoutMs: 15_000,
      credentials: {
        apiKey: env.MAILSWITCH_LIVE_MAILJET_KEY ?? "",
        secretKey: env.MAILSWITCH_LIVE_MAILJET_SECRET ?? "",
      },
      now: Date.now(),
    };
    expect(await adapter.verify(ctx)).toEqual({ ok: true });
    const result = await adapter.send(
      {
        from: env.MAILSWITCH_LIVE_MAILJET_FROM ?? "",
        to: [env.MAILSWITCH_LIVE_TO ?? ""],
        subject: "mailswitch live smoke test (Mailjet)",
        text: "This email comes from the mailswitch live smoke test. SandboxMode delivers nothing.",
      },
      ctx,
    );
    expect(result).toMatchObject({ status: "sent", provider: "mailjet" });
  });
});

describe.skipIf(!hasLiveEnv(SMTP2GO[0] as string))("live smoke: SMTP2GO", () => {
  it("has the env vars of the SMTP2GO smoke test", () => {
    expect(hasLiveEnv(...SMTP2GO)).toBe(true);
  });

  it.skipIf(!hasLiveEnv(...SMTP2GO))("verifies the key and sends one email", async () => {
    const adapter = smtp2go();
    const ctx = {
      fetch: (input: string, init: RequestInit) => fetch(input, init),
      timeoutMs: 15_000,
      credentials: { apiKey: env.MAILSWITCH_LIVE_SMTP2GO_KEY ?? "" },
      now: Date.now(),
    };
    expect(await adapter.verify(ctx)).toEqual({ ok: true });
    const result = await adapter.send(
      {
        from: env.MAILSWITCH_LIVE_SMTP2GO_FROM ?? "",
        to: [env.MAILSWITCH_LIVE_TO ?? ""],
        subject: "mailswitch live smoke test (SMTP2GO)",
        text: "This email comes from the mailswitch live smoke test.",
      },
      ctx,
    );
    expect(result).toMatchObject({ status: "sent", provider: "smtp2go" });
  });
});

describe.skipIf(!hasLiveEnv(ZEPTOMAIL[0] as string))("live smoke: ZeptoMail", () => {
  it("has the env vars of the ZeptoMail smoke test", () => {
    expect(hasLiveEnv(...ZEPTOMAIL)).toBe(true);
  });

  const context = (token: string) => ({
    fetch: (input: string, init: RequestInit) => fetch(input, init),
    timeoutMs: 15_000,
    credentials: {
      token,
      region: env.MAILSWITCH_LIVE_ZEPTOMAIL_REGION || "com",
      fromAddress: env.MAILSWITCH_LIVE_ZEPTOMAIL_FROM ?? "",
    },
    now: Date.now(),
  });

  it.skipIf(!hasLiveEnv(...ZEPTOMAIL))(
    "verifies a good and a wrong token, and sends one email",
    async () => {
      const adapter = zeptomail();
      const ctx = context(env.MAILSWITCH_LIVE_ZEPTOMAIL_TOKEN ?? "");
      // Release gate: a good token gets 400 TM_3201.
      expect(await adapter.verify(ctx)).toEqual({ ok: true });
      // Release gate: a wrong token gets 401 TM_4001.
      expect(await adapter.verify(context("mailswitch-wrong-token-0000000000"))).toMatchObject({
        ok: false,
        status: "not_sent",
        reason: "auth",
        httpStatus: 401,
      });
      const result = await adapter.send(
        {
          from: env.MAILSWITCH_LIVE_ZEPTOMAIL_FROM ?? "",
          to: [env.MAILSWITCH_LIVE_TO ?? ""],
          subject: "mailswitch live smoke test (ZeptoMail)",
          text: "This email comes from the mailswitch live smoke test.",
        },
        ctx,
      );
      expect(result).toMatchObject({ status: "sent", provider: "zeptomail" });
    },
  );
});
