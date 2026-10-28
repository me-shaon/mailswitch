<p align="center">
  <img src="https://raw.githubusercontent.com/me-shaon/mailswitch/main/docs/assets/mailswitch-logo.png" alt="mailswitch logo: orange envelope with switching arrows" width="440">
</p>

# mailswitch

**A transactional email library for Cloudflare Workers. Send through any provider, and switch providers without a code change or a redeploy.**

An admin of your app picks the provider on a settings screen: Resend, Postmark, Amazon SES, an SMTP server, or another supported service. Your send code stays the same. mailswitch also gives you the parts of that screen: provider fields, credential checks, test emails, and encrypted key storage.

## When to use it

- **Self-hosted apps:** each owner connects their own email provider. You do not supply or pay for an email account.
- **Multi-tenant SaaS:** each customer sends from their own domain and their own provider account.
- **Outages and price changes:** switch to another provider in settings. You do not change code or redeploy.
- **Apps with one provider today:** start with one provider. Add a backup provider or change providers later through configuration.

## Why mailswitch

- **Settings screen included:** the provider catalog describes the credential fields of each provider. Build one form for all supported providers.
- **Check before save:** validate the credentials, check them with the provider, and send a test email before an admin saves the settings.
- **Encrypted credentials:** encrypt the stored API keys with AES-256-GCM. Key rotation is supported.
- **Same behavior for every provider:** each send returns `sent`, `not_sent`, or `unknown`. mailswitch never retries an `unknown` send through a backup provider. Webhooks and bounce events have one format.
- **Built for Workers:** D1 and Durable Object stores, SMTP over `cloudflare:sockets`, and Cloudflare Email Sending. Zero runtime dependencies and no compatibility flags.

## Install

```sh
npm install mailswitch
```

ESM only. No Node.js compatibility flags required in Workers.

## Send an email

Start with one provider. Pass your Worker's secret binding as `env.RESEND_API_KEY` and use a sender address verified with your provider.

```ts
import { createMailer } from "mailswitch";
import { resend } from "mailswitch/resend";

declare const env: { RESEND_API_KEY: string };

const mailer = createMailer({
  providers: [
    { adapter: resend(), credentials: { apiKey: env.RESEND_API_KEY } },
  ],
});

const result = await mailer.send({
  from: { email: "hello@your-domain.com" },
  to: [{ email: "reader@example.com" }],
  subject: "Welcome!",
  text: "Thanks for signing up.",
});

if (result.status === "sent") {
  console.log("Accepted by", result.provider);
} else {
  // Inspect the status before deciding whether to retry.
  console.log(result.status, result.reason);
}
```

For fallback, add another entry to `providers`. For retry protection across providers, configure a persistent `idempotency` store and a stable `namespace`, then give each message an `idempotencyKey`. Reuse that key when retrying the same message. The quick start above does not configure this protection.

See the [fallback and D1 example](docs/guides/usage.md#send-an-email) for the complete setup.

## Delivery status

| Status | Meaning | What to do |
|---|---|---|
| `sent` | The provider accepted the email; inbox delivery is not guaranteed. | Record the result. |
| `not_sent` | The email was not accepted. | Check the reason, fix it if needed, and retry. |
| `unknown` | The email may have been accepted. | Check with the provider before sending again. |

**Never automatically retry an `unknown` result.** A timeout or network error can happen after the provider accepts a message. mailswitch only tries a fallback after `not_sent`.

Provider failures return results. Invalid configuration can throw a `TypeError`. Read the [delivery-safety guide](docs/guides/delivery-safety.md) before adding retries or a job queue.

## Providers

Resend, toSend, Postmark, Amazon SES, Mailgun, SendGrid, Brevo, MailerSend, Mailjet, SMTP2GO, ZeptoMail, Cloudflare Email, MailChannels, AhaSend, Mailtrap, AutoSend, Scaleway, SMTP, and generic HTTP endpoints.

See the [provider comparison and guides](docs/providers/README.md) for imports, attachments, batch support, webhook support, and limits. For SMTP, pass your Worker's `cloudflare:sockets` connection function; see the [SMTP guide](docs/providers/smtp.md).

## Receive webhooks

Verify incoming webhooks and turn provider-specific events into one format. Use a dedupe store to track handled events, and acknowledge them after processing.

[Webhook example and provider retry rules →](docs/guides/usage.md#receive-webhooks)

## Send a batch

Send fully built messages with `sendBatch()` and get one result per message. Configure an idempotency store and give each message its own key for batch retry protection. Build or render your templates before sending.

[Batch example →](docs/guides/usage.md#send-a-batch)

## Rate limits and Durable Object stores

Set per-provider send rates and daily caps. Use shared persistent stores so limits apply across Worker instances.

[Store options and Worker configuration →](docs/guides/usage.md#rate-limits-and-durable-object-stores)

## Settings-screen tools

Build a “bring your own email provider” form with provider metadata, credential validation, connection checks, test emails, and credential encryption helpers.

[Settings-screen example →](docs/guides/usage.md#settings-screen-tools)

## Documentation

- [Usage guide](docs/guides/usage.md): fallback, webhooks, batches, stores, and settings screens.
- [Delivery safety](docs/guides/delivery-safety.md): retry rules and duplicate-send protection.
- [Testing webhooks](docs/guides/testing.md): signed sample webhooks for your app tests.
- [Provider comparison](docs/providers/README.md): supported features and individual provider guides.
- [PlainBooks integration](docs/guides/plainbooks.md): invoices, PDFs, D1 setup, and a job outbox.
- [Envelopen migration](docs/guides/envelopen.md): move from `@envelopen/providers`.
- [Example Worker](examples/worker-basic/): send an invoice and receive webhooks.
- [Add a provider](docs/guides/add-a-provider.md) · [Release guide](docs/guides/releasing.md)

## Versioning

mailswitch follows semantic versioning. A major release can break your code. A minor or a patch release cannot, with one exception:

- A minor release can add a value to these string unions: `NormalizedEventType`, `WebhookRejection`, and `FailureReason`. New providers and new checks need new values. Give each `switch` on these types a `default` case.
- `DeliveryStatus` is fixed. It is always `sent`, `not_sent`, or `unknown`. Base retry and fallback decisions on the status, not on the reason.

The sample bodies of `mailswitch/conformance/fixtures` follow the provider docs, and a minor release can change them. Their export names and helper signatures follow semantic versioning.

## License

MIT. See [LICENSE](LICENSE).
