# Amazon SES

Last checked: 2026-10-26

The `mailswitch/ses` adapter sends email with the Amazon SES v2 API. It signs each request with AWS Signature Version 4 on Web Crypto, so it has no runtime dependencies. It verifies SES events that Amazon SNS delivers to your webhook. The adapter is tier 1.

## Credentials

| Field | Required | Secret | Value |
|---|---|---|---|
| `region` | Yes | No | The AWS region of your SES account, for example `eu-west-1`. |
| `accessKeyId` | Yes | No | The access key ID of an IAM identity. |
| `secretAccessKey` | Yes | Yes | The secret access key of that identity. |
| `sessionToken` | No | Yes | The session token. Set it only for temporary credentials. |

Give the IAM identity these permissions:

- `ses:SendEmail`, to send.
- `ses:GetAccount`, for `verify`. `verify` sends no email.

## Send email

```ts
import { createMailer } from "mailswitch";
import { ses } from "mailswitch/ses";

declare const env: {
  SES_REGION: string;
  SES_ACCESS_KEY_ID: string;
  SES_SECRET_ACCESS_KEY: string;
};

const mailer = createMailer({
  providers: [
    {
      adapter: ses({ configurationSetName: "app-events" }),
      credentials: {
        region: env.SES_REGION,
        accessKeyId: env.SES_ACCESS_KEY_ID,
        secretAccessKey: env.SES_SECRET_ACCESS_KEY,
      },
    },
  ],
});
```

Each message is one `SendEmail` call to `https://email.<region>.amazonaws.com/v2/email/outbound-emails`. SES has no batch call for full messages, so `sendBatch` sends the messages one by one.

### Options

| Option | Default | What it does |
|---|---|---|
| `configurationSetName` | None | The configuration set of each message. Event publishing to SNS needs it. |
| `endpoint` | `https://email.<region>.amazonaws.com` | The API origin, for example a VPC endpoint. The signature still uses the region of the credentials. |
| `region`, `accessKeyId`, `secretAccessKey`, `sessionToken` | None | Credentials. The credentials of the mailer take precedence. |
| `snsMaxAgeMs` | 1 hour | The oldest SNS `Timestamp` that the webhook check accepts. |
| `requireSignatureVersion2` | `false` | Refuse SNS messages with SignatureVersion 1 (SHA-1). |
| `certTimeoutMs` | 5 seconds | The timeout of an SNS certificate fetch. |
| `maxCertBytes` | 16 KiB | The largest SNS certificate response that the adapter reads. |

### Attachments

The adapter sends every message as `Content.Simple`. SES v2 accepts attachments in `Content.Simple.Attachments`, so the adapter builds no raw MIME message. An attachment with a `contentId` goes out with the `INLINE` disposition. Other attachments use `ATTACHMENT`.

SES refuses some file types. See [Unsupported attachment types](https://docs.aws.amazon.com/ses/latest/dg/mime-types.html).

### Limits

| Limit | Value | What mailswitch does |
|---|---|---|
| Message size | 40 MB after base64 encoding | `validateMessage` refuses a larger message with `not_sent/unsupported`. |
| Recipients | 50 across To, Cc, and Bcc | `validateMessage` refuses more with `not_sent/unsupported`. |
| Custom headers | 15 | The adapter refuses more with `not_sent/unsupported`, before any request. |

### Idempotency

SES has no idempotency key. Configure an idempotency store on the mailer, so a retry cannot send a second copy.

### Failure mapping

The adapter reads the error name from the `x-amzn-ErrorType` header. It never copies the response body into a result.

| SES error | Status and reason |
|---|---|
| `TooManyRequestsException`, `ThrottlingException` | `not_sent/rate_limited` |
| `LimitExceededException`, or a daily quota message | `not_sent/quota` |
| `UnrecognizedClientException`, `InvalidSignatureException`, `SignatureDoesNotMatch`, `AccessDeniedException`, `ExpiredTokenException`, `AccountSuspendedException`, `SendingPausedException` | `not_sent/auth` |
| `MessageRejected`, `MailFromDomainNotVerifiedException` | `not_sent/rejected` |
| `BadRequestException`, `NotFoundException` | `not_sent/invalid_message` |
| Any 5xx | `unknown/provider_error` |
| A timeout or a network error | `unknown` |

Never retry or fall back after `unknown`. The message may have gone out.

## Webhooks

SES publishes events to an SNS topic. SNS sends each event to your HTTPS endpoint. The adapter checks the SNS signature and turns the SES event into normalized events.

### Set up event publishing

1. In SNS, create a standard topic.
2. Set the topic attribute `SignatureVersion` to `2`.
3. In SES, add an event destination of type SNS to your configuration set. Choose the topic and the event types that you need.
4. Set `configurationSetName` on the adapter, or set the configuration set as the default of your sending identity.
5. In SNS, create an HTTPS subscription of the topic to your webhook URL.
6. Confirm the subscription. See [Confirm the subscription](#confirm-the-subscription).

### The topic allowlist

Anyone can subscribe your URL to their own SNS topic. SNS signs those messages too. So a valid signature is not sufficient. The adapter accepts a message only from a topic on your allowlist.

Give the allowlist as the `secret` of `handleWebhook`. It is one topic ARN, or several topic ARNs separated by commas. An empty allowlist refuses every message.

```ts
import { ses, snsConfirmAction } from "mailswitch/ses";
import type { DedupeStore } from "mailswitch";
import { handleWebhook } from "mailswitch/webhooks";

interface Env {
  SES_ALLOWED_TOPIC_ARNS: string;
  dedupeStore: DedupeStore;
}

// Create the adapter once per isolate, so the certificate cache stays warm.
const adapter = ses({ requireSignatureVersion2: true });

export async function onSesWebhook(request: Request, env: Env): Promise<Response> {
  const outcome = await handleWebhook(request, {
    adapter,
    secret: env.SES_ALLOWED_TOPIC_ARNS,
    dedupe: env.dedupeStore,
  });
  if (!outcome.ok) return new Response(null, { status: outcome.status });
  for (const event of outcome.events) {
    const action = snsConfirmAction(event);
    if (action) {
      await fetch(action.subscribeUrl);
      continue;
    }
    console.log(event.type);
  }
  await outcome.ack();
  return new Response(null, { status: 200 });
}
```

### Confirm the subscription

SNS sends a `SubscriptionConfirmation` message first. mailswitch never fetches its `SubscribeURL`. The adapter verifies the message like any other message. Then it gives one event of type `unknown` with `rawType` `SubscriptionConfirmation`. For that event, `snsConfirmAction(event)` returns the confirm action:

```text
{ type: "confirm_subscription", topicArn: "arn:aws:sns:...", subscribeUrl: "https://sns.<region>.amazonaws.com/?Action=ConfirmSubscription&..." }
```

The action is present only when these conditions are true:

- The topic is on the allowlist.
- The signature is valid.
- The `SubscribeURL` is an https URL on the SNS host of the topic region.

Fetch `subscribeUrl` with GET to confirm the subscription. You can also confirm it in the SNS console.

### Verification rules

The adapter refuses a message for each of these reasons. No certificate fetch occurs before the allowlist check and the timestamp check.

| Check | Rejection |
|---|---|
| The body is not an SNS message, or the `x-amz-sns-message-type` header does not match it. | `malformed` |
| The signature version is not 1 or 2. With `requireSignatureVersion2`, it is not 2. | `bad_signature` |
| The topic is not on the allowlist. | `untrusted_topic` |
| The `Timestamp` is older than `snsMaxAgeMs`, or more than 5 minutes in the future. | `stale` |
| The certificate URL is not https, has a port or user info, is not on `sns.<region>.amazonaws.com` of the topic region, or does not have a `/SimpleNotificationService-<id>.pem` path. | `bad_signature` |
| The certificate fetch fails, redirects, times out, or is larger than `maxCertBytes`. | `bad_signature` |
| The signature does not match. | `bad_signature` |

For a topic in a China region (`arn:aws-cn:...`), the host is `sns.<region>.amazonaws.com.cn`.

The certificate fetch never follows a redirect. Workers do not accept `redirect: "error"`, so the adapter uses `redirect: "manual"` and refuses every status other than 200.

The adapter keeps each certificate in memory for 24 hours, per certificate URL. It never keeps a failed fetch. Requests that arrive during a fetch share that fetch. So a flood of forged messages for one certificate URL causes at most one fetch.

### Events

| SES event type | Normalized type |
|---|---|
| `Delivery` | `delivered` |
| `Bounce` with `bounceType` `Permanent` | `bounced`, with `bounce: "hard"` |
| `Bounce` with another `bounceType` | `bounced`, with `bounce: "soft"` |
| `Complaint` | `complained` |
| `Complaint` with feedback type `not-spam` | `unknown` |
| Every other type, for example `Send`, `Reject`, `Open`, or `Click` | `unknown` |

The adapter reads `eventType` (event publishing) and `notificationType` (identity notifications). One SES event can name more than one recipient. The adapter gives one normalized event for each recipient.

### Dedupe

The event key is the SNS `MessageId`. SNS keeps it across retries of one delivery. The second recipient of one message gets the key `<MessageId>:1`, the third gets `<MessageId>:2`, and so on.

The signature covers the `Timestamp`, and the adapter refuses an old message. So the default dedupe TTL is 7 days.

## Sources

- [SES v2 SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html)
- [SES v2 Message and Attachment](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_Message.html)
- [SES event publishing contents](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html)
- [Verify the signatures of SNS messages](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html)
- [AWS Signature Version 4](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html)
