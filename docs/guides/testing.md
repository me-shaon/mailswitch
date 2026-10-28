# Testing webhooks in your app

[Back to the README](../../README.md)

`mailswitch/conformance/fixtures` gives your tests signed sample webhooks for each provider that sends webhooks. Use it to test your webhook route without a live provider account.

- [What the subpath exports](#what-the-subpath-exports)
- [Sign a sample and handle it](#sign-a-sample-and-handle-it)
- [Test Amazon SES webhooks](#test-amazon-ses-webhooks)
- [Versioning](#versioning)

## What the subpath exports

For each provider with webhooks, the subpath exports three kinds of values:

- A test secret, for example `RESEND_FIXTURE_SECRET` or `TOSEND_FIXTURE_SECRET`. SendGrid and MailChannels export a public key, for example `SENDGRID_FIXTURE_PUBLIC_KEY`. Amazon SES exports a topic ARN, `SES_FIXTURE_TOPIC`.
- A sign helper, for example `signResendWebhook`. It takes `{ body, secret, at }` and returns `{ headers, body }`. `body` is a `Uint8Array`. `at` is the signing time in Unix milliseconds.
- Builders of sample event bodies, for example `resendEvent` or `toSendBounce`.

The secrets and keys are public test values. They protect nothing. Never put them in production config.

A provider that signs no time ignores `at`. These providers are toSend, Postmark, Brevo, MailerSend, Mailjet, Mailtrap, and SMTP2GO.

## Sign a sample and handle it

Sign the sample at `Date.now()`. `handleWebhook` checks the signing time against the real clock, so an old time gives `stale`. Give the test secret to the adapter in your test env.

This Vitest test sends a toSend bounce and a Resend delivery to `handleWebhook`:

```ts
import {
  RESEND_FIXTURE_SECRET,
  resendEvent,
  signResendWebhook,
  signToSendWebhook,
  TOSEND_FIXTURE_SECRET,
  toSendBounce,
} from "mailswitch/conformance/fixtures";
import { resend } from "mailswitch/resend";
import { MemoryDedupeStore } from "mailswitch/stores/memory";
import { tosend } from "mailswitch/tosend";
import { handleWebhook } from "mailswitch/webhooks";
import { expect, it } from "vitest";

const encoder = new TextEncoder();

/** Builds the request that the provider sends to your webhook route. */
function webhookRequest(sample: { headers: Headers; body: Uint8Array }): Request {
  return new Request("https://app.example.com/hooks", {
    method: "POST",
    headers: sample.headers,
    body: sample.body,
  });
}

it("handles a toSend hard bounce", async () => {
  const sample = await signToSendWebhook({
    body: encoder.encode(toSendBounce("ana@example.org")),
    secret: TOSEND_FIXTURE_SECRET,
    at: Date.now(),
  });
  const result = await handleWebhook(webhookRequest(sample), {
    adapter: tosend(),
    secret: TOSEND_FIXTURE_SECRET,
    dedupe: new MemoryDedupeStore(),
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.events[0]).toMatchObject({ type: "bounced", bounce: "hard" });
});

it("handles a Resend delivery", async () => {
  const sample = await signResendWebhook({
    body: encoder.encode(resendEvent("email.delivered")),
    secret: RESEND_FIXTURE_SECRET,
    at: Date.now(),
  });
  const result = await handleWebhook(webhookRequest(sample), {
    adapter: resend(),
    secret: RESEND_FIXTURE_SECRET,
  });
  expect(result.ok).toBe(true);
});
```

To test your own route, send the request to your Worker instead of to `handleWebhook`. Set the webhook secret binding of the test Worker to the fixture secret.

To test the replay window, sign at an old time. For example, a Resend or SendGrid sample signed 10 minutes ago gives `{ ok: false, rejection: "stale" }`.

SendGrid and MailChannels sign with fixed test key pairs. Put `SENDGRID_FIXTURE_PUBLIC_KEY` or `MAILCHANNELS_FIXTURE_PUBLIC_KEY` in the test binding. The sign helpers import the private key on the first call. Pass `MAILCHANNELS_FIXTURE_CUSTOMER_HANDLE` as the `customerHandle` of the MailChannels adapter.

## Test Amazon SES webhooks

SES webhooks come through Amazon SNS. The SES adapter fetches the SNS signing certificate from `SigningCertURL` to verify a message. The fixture signs with a test RSA key, and it does not use a real certificate. Your test must serve the test certificate.

Do these steps:

1. Call `sesFixtureSigner()`. It returns the shared test signer. Its `certificatePem` is the test certificate.
2. Replace the global `fetch`. Return `certificatePem` for `SES_FIXTURE_CERT_URL`. Return 404 for other URLs.
3. Sign an SNS envelope with `signSesWebhook`. Use `SES_FIXTURE_TOPIC` as the secret. The helper sets the topic, the timestamp, and the certificate URL.
4. Give `SES_FIXTURE_TOPIC` to `handleWebhook` as the secret.

```ts
import {
  SES_FIXTURE_CERT_URL,
  SES_FIXTURE_TOPIC,
  sesFixtureSigner,
  sesNotification,
  signSesWebhook,
} from "mailswitch/conformance/fixtures";
import { ses } from "mailswitch/ses";
import { handleWebhook } from "mailswitch/webhooks";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("handles an SES delivery", async () => {
  const signer = await sesFixtureSigner();
  vi.stubGlobal("fetch", async (url: string) =>
    url === SES_FIXTURE_CERT_URL
      ? new Response(signer.certificatePem)
      : new Response("Not found", { status: 404 }),
  );
  const sample = await signSesWebhook({
    body: new TextEncoder().encode(sesNotification({ eventType: "Delivery" })),
    secret: SES_FIXTURE_TOPIC,
    at: Date.now(),
  });
  const request = new Request("https://app.example.com/hooks/ses", {
    method: "POST",
    headers: sample.headers,
    body: sample.body,
  });
  const result = await handleWebhook(request, { adapter: ses(), secret: SES_FIXTURE_TOPIC });
  expect(result.ok).toBe(true);
});
```

The SES adapter keeps fetched certificates in a cache. Create a new adapter in each test, or serve the certificate in each test.

## Versioning

The export names and the helper signatures follow semver. A breaking change to them comes only in a major release.

The sample bodies follow the provider docs. A minor release can change a sample body when a provider changes its docs. Do not compare a full sample body in a snapshot. Assert only the fields that your code reads.
