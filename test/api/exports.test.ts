// The public API snapshot. Each subpath of package.json maps to its source entry, and
// the runtime export names of that entry must equal the list below. A new export fails
// this test, so every addition to the public API is a deliberate change of this file.
// Type-only exports have no runtime value, so this list does not cover them.

import { describe, expect, it } from "vitest";
import pkg from "../../package.json";

const ENTRIES: Record<string, { load: () => Promise<object>; names: string[] }> = {
  ".": {
    load: () => import("../../src/index"),
    names: [
      "BLOCKED_HEADERS",
      "DAILY_CAP_WINDOW_MS",
      "DEFAULT_PENDING_TIMEOUT_MS",
      "NORMALIZED_EVENT_TYPES",
      "TEST_EMAIL_SUBJECT",
      "TEST_EMAIL_TEXT",
      "WEBHOOK_REJECTIONS",
      "allowFallback",
      "checkCapabilities",
      "createMailer",
      "createSendContext",
      "defineProvider",
      "defineProviderMeta",
      "minPendingTimeout",
      "parseCredentials",
      "sendTestEmail",
      "validateMessage",
    ],
  },
  "./catalog": {
    load: () => import("../../src/catalog/index"),
    names: ["catalog", "getProviderMeta"],
  },
  "./provider-kit": {
    load: () => import("../../src/provider-kit/index"),
    names: [
      "DEFAULT_TIMEOUT_MS",
      "base64ToBytes",
      "bytesToBase64",
      "bytesToHex",
      "callProvider",
      "checkCapabilities",
      "classifyResponse",
      "classifyThrown",
      "defineProvider",
      "defineProviderMeta",
      "defineStatusMap",
      "discardBody",
      "hexToBytes",
      "hmacSign",
      "hmacVerify",
      "isBase64",
      "parseRetryAfter",
      "readJson",
      "redactUrl",
      "timingSafeEqualText",
      "utf8",
      "utf8ByteLength",
    ],
  },
  "./webhooks": {
    load: () => import("../../src/webhooks/index"),
    names: [
      "DEFAULT_DEDUPE_TTL_MS",
      "DEFAULT_LEASE_MS",
      "DEFAULT_MAX_BODY_BYTES",
      "REJECTION_STATUS",
      "UNSIGNED_TIMESTAMP_TTL_MS",
      "handleWebhook",
    ],
  },
  "./crypto": {
    load: () => import("../../src/crypto/index"),
    names: ["CredentialDecryptError", "createKeyRing", "decrypt", "encrypt", "needsReencrypt"],
  },
  "./testing": {
    load: () => import("../../src/testing/index"),
    names: [
      "FAKE_API_BASE",
      "FAKE_SIGNATURE_HEADER",
      "FAKE_WEBHOOK_TOLERANCE_MS",
      "fakeFixture",
      "fakeMeta",
      "fakeProvider",
      "fakeSignedPayload",
    ],
  },
  "./conformance": {
    load: () => import("../../src/conformance/index"),
    names: [
      "CHECK_IDS",
      "SMTP_CHECK_IDS",
      "conformanceChecks",
      "createSnsSigner",
      "decodeHeaderValue",
      "echoFetch",
      "matches",
      "mockFetch",
      "mockSmtp",
      "parseMail",
      "runChecks",
      "sampleMessage",
    ],
  },
  "./conformance/vitest": {
    load: () => import("../../src/conformance/vitest"),
    names: ["runConformance"],
  },
  "./resend": {
    load: () => import("../../src/providers/resend/index"),
    names: [
      "RESEND_API_BASE",
      "RESEND_MAX_KEY_LENGTH",
      "SVIX_TOLERANCE_MS",
      "parseResendEvents",
      "resend",
      "resendIdempotencyKey",
      "resendMeta",
      "svixSignedPayload",
      "svixVerifier",
      "verifyResendWebhook",
    ],
  },
  "./tosend": {
    load: () => import("../../src/providers/tosend/index"),
    names: [
      "TOSEND_API_BASE",
      "TOSEND_SIGNATURE_HEADER",
      "toSendMeta",
      "toSendSignature",
      "tosend",
    ],
  },
  "./cloudflare": {
    load: () => import("../../src/providers/cloudflare/index"),
    names: [
      "CLOUDFLARE_API_BASE",
      "cloudflareBinding",
      "cloudflareBindingMeta",
      "cloudflareRest",
      "cloudflareRestMeta",
    ],
  },
  "./mailgun": {
    load: () => import("../../src/providers/mailgun/index"),
    names: [
      "MAILGUN_MIN_DEDUPE_TTL_MS",
      "MAILGUN_REGIONS",
      "MAILGUN_WEBHOOK_MAX_AGE_MS",
      "MAILGUN_WEBHOOK_MAX_SKEW_MS",
      "mailgun",
      "mailgunMeta",
      "mailgunSignature",
      "parseMailgunEvents",
      "verifyMailgunWebhook",
    ],
  },
  "./postmark": {
    load: () => import("../../src/providers/postmark/index"),
    names: [
      "POSTMARK_API_BASE",
      "POSTMARK_MIN_HEX_SECRET_LENGTH",
      "POSTMARK_MIN_SECRET_LENGTH",
      "POSTMARK_WEBHOOK_USERNAME",
      "checkPostmarkWebhookSecret",
      "generatePostmarkWebhookSecret",
      "parsePostmarkEvents",
      "postmark",
      "postmarkMeta",
      "postmarkWebhookAuthorization",
      "postmarkWebhooks",
    ],
  },
  "./brevo": {
    load: () => import("../../src/providers/brevo/index"),
    names: [
      "BREVO_API_BASE",
      "BREVO_MIN_HEX_TOKEN_LENGTH",
      "BREVO_MIN_TOKEN_LENGTH",
      "BREVO_WEBHOOK_EVENTS",
      "brevo",
      "brevoMeta",
      "brevoWebhooks",
      "checkBrevoWebhookToken",
      "generateBrevoWebhookToken",
      "parseBrevoEvents",
      "verifyBrevoWebhook",
    ],
  },
  "./mailersend": {
    load: () => import("../../src/providers/mailersend/index"),
    names: [
      "MAILERSEND_API_BASE",
      "MAILERSEND_SIGNATURE_HEADER",
      "mailersend",
      "mailersendMeta",
      "mailersendSignature",
      "mailersendWebhooks",
      "parseMailersendEvents",
      "verifyMailersendWebhook",
    ],
  },
  "./sendgrid": {
    load: () => import("../../src/providers/sendgrid/index"),
    names: [
      "SENDGRID_API_BASE",
      "SENDGRID_EU_API_BASE",
      "SENDGRID_SIGNATURE_HEADER",
      "SENDGRID_TIMESTAMP_HEADER",
      "SENDGRID_WEBHOOK_TOLERANCE_MS",
      "parseSendgridEvents",
      "sendgrid",
      "sendgridMeta",
      "sendgridSignedPayload",
      "sendgridWebhooks",
      "verifySendgridWebhook",
    ],
  },
  "./ses": {
    load: () => import("../../src/providers/ses/index"),
    names: [
      "SES_MAX_HEADERS",
      "SNS_CERT_MAX_BYTES",
      "SNS_CERT_TIMEOUT_MS",
      "SNS_CERT_TTL_MS",
      "SNS_MAX_AGE_MS",
      "SNS_MAX_FUTURE_MS",
      "createSnsVerifier",
      "parseSesEvents",
      "ses",
      "sesMeta",
      "snsConfirmAction",
    ],
  },
  "./smtp": {
    load: () => import("../../src/providers/smtp/index"),
    names: [
      "BREVO_FREE_DAILY_CAP",
      "GMAIL_DAILY_CAP",
      "SMTP_PRESETS",
      "WORKSPACE_DAILY_CAP",
      "resolveSmtpSettings",
      "smtp",
      "smtpMeta",
      "smtpPreset",
    ],
  },
  "./smtp/brevo": {
    load: () => import("../../src/providers/smtp/brevo-webhooks"),
    names: [
      "BREVO_MIN_HEX_TOKEN_LENGTH",
      "BREVO_MIN_TOKEN_LENGTH",
      "BREVO_WEBHOOK_EVENTS",
      "brevoWebhooks",
      "checkBrevoWebhookToken",
      "generateBrevoWebhookToken",
      "parseBrevoEvents",
      "verifyBrevoWebhook",
    ],
  },
  "./stores/memory": {
    load: () => import("../../src/stores/memory"),
    names: [
      "MemoryDailyCapStore",
      "MemoryDedupeStore",
      "MemoryIdempotencyStore",
      "MemoryRateLimitStore",
    ],
  },
  "./stores/d1": {
    load: () => import("../../src/stores/d1"),
    names: ["D1DailyCapStore", "D1DedupeStore", "D1IdempotencyStore", "D1_SCHEMA", "applyD1Schema"],
  },
  "./stores/durable-object": {
    load: () => import("../../src/stores/durable-object"),
    names: [
      "MailswitchIdempotency",
      "MailswitchLimiter",
      "durableObjectDailyCapStore",
      "durableObjectIdempotencyStore",
      "durableObjectRateLimitStore",
    ],
  },
};

/** The subpaths of package.json that are not JavaScript modules. */
const NON_MODULE_SUBPATHS = new Set(["./stores/d1-schema.sql", "./package.json"]);

describe("public API", () => {
  it("covers every JavaScript subpath of package.json", () => {
    const subpaths = Object.keys(pkg.exports).filter((key) => !NON_MODULE_SUBPATHS.has(key));
    expect(Object.keys(ENTRIES).sort()).toEqual(subpaths.sort());
  });

  for (const [subpath, entry] of Object.entries(ENTRIES)) {
    it(`${subpath} exports only the listed names`, async () => {
      const names = Object.keys(await entry.load()).sort();
      expect(names).toEqual([...entry.names].sort());
    });
  }
});
