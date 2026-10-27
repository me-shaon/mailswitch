// The public webhook fixtures in workerd: a sample signed now passes handleWebhook. The
// SendGrid and MailChannels helpers import their fixed private keys in the runtime.

import { describe, expect, it } from "vitest";
import {
  MAILCHANNELS_FIXTURE_CUSTOMER_HANDLE,
  MAILCHANNELS_FIXTURE_PUBLIC_KEY,
  mailchannelsEvent,
  RESEND_FIXTURE_SECRET,
  resendEvent,
  SENDGRID_FIXTURE_PUBLIC_KEY,
  sendgridEvent,
  signMailchannelsWebhook,
  signResendWebhook,
  signSendgridWebhook,
  signToSendWebhook,
  TOSEND_FIXTURE_SECRET,
  toSendBounce,
} from "../../src/conformance/fixtures/index";
import type { WebhookSample } from "../../src/conformance/index";
import type { ProviderAdapter } from "../../src/index";
import { mailchannels } from "../../src/providers/mailchannels/index";
import { resend } from "../../src/providers/resend/index";
import { sendgrid } from "../../src/providers/sendgrid/index";
import { tosend } from "../../src/providers/tosend/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { type DedupeRequiredAdapter, handleWebhook } from "../../src/webhooks/index";

interface Case {
  id: string;
  adapter: () => ProviderAdapter;
  secret: string;
  sign: (input: { body: Uint8Array; secret: string; at: number }) => Promise<WebhookSample>;
  body: string;
}

const CASES: Case[] = [
  {
    id: "tosend",
    adapter: () => tosend(),
    secret: TOSEND_FIXTURE_SECRET,
    sign: signToSendWebhook,
    body: toSendBounce("ana@example.org"),
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
    id: "mailchannels",
    adapter: () => mailchannels({ customerHandle: MAILCHANNELS_FIXTURE_CUSTOMER_HANDLE }),
    secret: MAILCHANNELS_FIXTURE_PUBLIC_KEY,
    sign: (input) => signMailchannelsWebhook(input),
    body: JSON.stringify([mailchannelsEvent("delivered")]),
  },
];

describe("mailswitch/conformance/fixtures (workerd)", () => {
  for (const item of CASES) {
    it(`${item.id}: a sample signed now is accepted`, async () => {
      const body = new TextEncoder().encode(item.body);
      const sample = await item.sign({ body, secret: item.secret, at: Date.now() });
      const request = new Request(`https://app.example.com/hooks/${item.id}`, {
        method: "POST",
        headers: sample.headers,
        body: sample.body,
      });
      // Every case gets a dedupe store, so the dedupe overload fits each adapter.
      const outcome = await handleWebhook(request, {
        adapter: item.adapter() as DedupeRequiredAdapter,
        secret: item.secret,
        dedupe: new MemoryDedupeStore(),
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.events.length).toBeGreaterThan(0);
    });
  }
});
