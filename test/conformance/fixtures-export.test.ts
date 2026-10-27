// The public webhook fixtures: each sign helper of the barrel signs a sample at the
// current time, and handleWebhook with the real adapter accepts it.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fixtures from "../../src/conformance/fixtures/index";
import {
  AHASEND_FIXTURE_SECRET,
  AUTOSEND_FIXTURE_SECRET,
  ahasendEvent,
  autosendEvent,
  BREVO_FIXTURE_TOKEN,
  brevoEvent,
  MAILCHANNELS_FIXTURE_CUSTOMER_HANDLE,
  MAILCHANNELS_FIXTURE_PUBLIC_KEY,
  MAILERSEND_FIXTURE_SECRET,
  MAILGUN_FIXTURE_SECRET,
  MAILJET_FIXTURE_SECRET,
  MAILTRAP_FIXTURE_SECRET,
  mailchannelsEvent,
  mailersendEvent,
  mailgunEvent,
  mailjetEvent,
  mailtrapEvent,
  mailtrapEvents,
  POSTMARK_FIXTURE_SECRET,
  postmarkBounce,
  RESEND_FIXTURE_SECRET,
  resendEvent,
  SENDGRID_FIXTURE_PUBLIC_KEY,
  SES_FIXTURE_CERT_URL,
  SES_FIXTURE_TOPIC,
  SMTP2GO_FIXTURE_SECRET,
  sendgridEvent,
  sesFixtureSigner,
  sesNotification,
  signAhasendWebhook,
  signAutosendWebhook,
  signBrevoWebhook,
  signMailchannelsWebhook,
  signMailersendWebhook,
  signMailgunWebhook,
  signMailjetWebhook,
  signMailtrapWebhook,
  signPostmarkWebhook,
  signResendWebhook,
  signSendgridWebhook,
  signSesWebhook,
  signSmtp2goWebhook,
  signToSendWebhook,
  smtp2goEvent,
  TOSEND_FIXTURE_SECRET,
  toSendBounce,
} from "../../src/conformance/fixtures/index";
import type { WebhookSample } from "../../src/conformance/index";
import type { ProviderAdapter } from "../../src/index";
import { ahasend } from "../../src/providers/ahasend/index";
import { autosend } from "../../src/providers/autosend/index";
import { brevo } from "../../src/providers/brevo/index";
import { mailchannels } from "../../src/providers/mailchannels/index";
import { mailersend } from "../../src/providers/mailersend/index";
import { mailgun } from "../../src/providers/mailgun/index";
import { mailjet } from "../../src/providers/mailjet/index";
import { mailtrap } from "../../src/providers/mailtrap/index";
import { postmark } from "../../src/providers/postmark/index";
import { resend } from "../../src/providers/resend/index";
import { sendgrid } from "../../src/providers/sendgrid/index";
import { ses } from "../../src/providers/ses/index";
import { smtp2go } from "../../src/providers/smtp2go/index";
import { tosend } from "../../src/providers/tosend/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import {
  type DedupeRequiredAdapter,
  handleWebhook,
  type WebhookOutcome,
} from "../../src/webhooks/index";

type Sign = (input: { body: Uint8Array; secret: string; at: number }) => Promise<WebhookSample>;

interface Case {
  id: string;
  adapter: () => ProviderAdapter;
  secret: string;
  sign: Sign;
  body: string;
}

const encoder = new TextEncoder();

const CASES: Case[] = [
  {
    id: "ahasend",
    adapter: () => ahasend(),
    secret: AHASEND_FIXTURE_SECRET,
    sign: signAhasendWebhook,
    body: ahasendEvent("message.delivered"),
  },
  {
    id: "autosend",
    adapter: () => autosend(),
    secret: AUTOSEND_FIXTURE_SECRET,
    sign: signAutosendWebhook,
    body: autosendEvent("email.delivered"),
  },
  {
    id: "brevo",
    adapter: () => brevo(),
    secret: BREVO_FIXTURE_TOKEN,
    sign: signBrevoWebhook,
    body: JSON.stringify(brevoEvent("delivered", "ana@example.org")),
  },
  {
    id: "mailchannels",
    adapter: () => mailchannels({ customerHandle: MAILCHANNELS_FIXTURE_CUSTOMER_HANDLE }),
    secret: MAILCHANNELS_FIXTURE_PUBLIC_KEY,
    sign: (input) => signMailchannelsWebhook(input),
    body: JSON.stringify([mailchannelsEvent("delivered")]),
  },
  {
    id: "mailersend",
    adapter: () => mailersend(),
    secret: MAILERSEND_FIXTURE_SECRET,
    sign: signMailersendWebhook,
    body: JSON.stringify(mailersendEvent("activity.delivered")),
  },
  {
    id: "mailgun",
    adapter: () => mailgun(),
    secret: MAILGUN_FIXTURE_SECRET,
    sign: signMailgunWebhook,
    body: mailgunEvent("delivered"),
  },
  {
    id: "mailjet",
    adapter: () => mailjet(),
    secret: MAILJET_FIXTURE_SECRET,
    sign: signMailjetWebhook,
    body: JSON.stringify(mailjetEvent("sent")),
  },
  {
    id: "mailtrap",
    adapter: () => mailtrap(),
    secret: MAILTRAP_FIXTURE_SECRET,
    sign: signMailtrapWebhook,
    body: mailtrapEvents(mailtrapEvent("delivery")),
  },
  {
    id: "postmark",
    adapter: () => postmark(),
    secret: POSTMARK_FIXTURE_SECRET,
    sign: signPostmarkWebhook,
    body: postmarkBounce("ana@example.org"),
  },
  {
    id: "resend",
    adapter: () => resend(),
    secret: RESEND_FIXTURE_SECRET,
    sign: signResendWebhook,
    body: resendEvent("email.delivered"),
  },
  {
    id: "sendgrid",
    adapter: () => sendgrid(),
    secret: SENDGRID_FIXTURE_PUBLIC_KEY,
    sign: signSendgridWebhook,
    body: JSON.stringify([sendgridEvent("delivered")]),
  },
  {
    id: "ses",
    adapter: () => ses(),
    secret: SES_FIXTURE_TOPIC,
    sign: signSesWebhook,
    body: sesNotification({ eventType: "Delivery" }),
  },
  {
    id: "smtp2go",
    adapter: () => smtp2go(),
    secret: SMTP2GO_FIXTURE_SECRET,
    sign: signSmtp2goWebhook,
    body: JSON.stringify(smtp2goEvent("delivered")),
  },
  {
    id: "tosend",
    adapter: () => tosend(),
    secret: TOSEND_FIXTURE_SECRET,
    sign: signToSendWebhook,
    body: toSendBounce("ana@example.org"),
  },
];

/** Signs the body of a case at `at` and passes the request to handleWebhook. */
async function deliver(item: Case, at: number): Promise<WebhookOutcome> {
  const sample = await item.sign({ body: encoder.encode(item.body), secret: item.secret, at });
  const request = new Request(`https://app.example.com/hooks/${item.id}`, {
    method: "POST",
    headers: sample.headers,
    body: sample.body,
  });
  // Every case gets a dedupe store, so the dedupe overload fits each adapter.
  return handleWebhook(request, {
    adapter: item.adapter() as DedupeRequiredAdapter,
    secret: item.secret,
    dedupe: new MemoryDedupeStore(),
  });
}

/** Serves the SNS signing certificate of the fixture signer, and nothing else. */
async function stubCertificateFetch(): Promise<void> {
  const signer = await sesFixtureSigner();
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (target === SES_FIXTURE_CERT_URL) return new Response(signer.certificatePem);
    return new Response("Not found", { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mailswitch/conformance/fixtures", () => {
  for (const item of CASES) {
    it(`${item.id}: a sample signed now is accepted`, async () => {
      if (item.id === "ses") await stubCertificateFetch();
      const outcome = await deliver(item, Date.now());
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.events.length).toBeGreaterThan(0);
    });
  }

  for (const id of ["resend", "sendgrid"]) {
    it(`${id}: a sample signed 10 minutes ago is stale`, async () => {
      const item = CASES.find((entry) => entry.id === id) as Case;
      const outcome = await deliver(item, Date.now() - 10 * 60 * 1000);
      expect(outcome).toMatchObject({ ok: false, rejection: "stale" });
    });
  }

  it("exports no conformance fixture objects", () => {
    const names = Object.keys(fixtures);
    expect(names.filter((name) => name.endsWith("Fixture"))).toEqual([]);
  });

  it("covers every exported sign helper", () => {
    const helpers = Object.keys(fixtures).filter((name) => /^sign\w+Webhook$/.test(name));
    expect(helpers.length).toBe(CASES.length);
  });
});
