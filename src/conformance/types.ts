// The fixture format and the report types of the conformance kit. A contributor records
// real provider exchanges once, puts them in this shape, and passes them to `runChecks`
// or `runConformance`. The kit builds the request and the response for every check.

import type { NormalizedEvent } from "../core/events";
import type { CredentialField, ProviderTier } from "../core/meta";
import type { FailureReason } from "../core/types";
import type {
  CapturedRequest,
  RecordedExchange,
  RecordedHttpResponse,
  RequestMatcher,
} from "./mock-fetch";

/** The ids of the checks. */
export type CheckId =
  | "declaration"
  | "declaration.tier"
  | "send.ok"
  | "send.auth"
  | "send.invalid"
  | "send.rate-limited"
  | "send.uncertain"
  | "send.headers"
  | "send.idempotency"
  | "idempotency.conflict"
  | "attachments"
  | "capability.refuse"
  | "send.batch"
  | "verify.ok"
  | "verify.bad-key"
  | "verify.server-error"
  | "webhook.valid"
  | "webhook.changed"
  | "webhook.wrong-secret"
  | "webhook.stale"
  | "webhook.malformed"
  | "events.parse"
  | "redaction"
  | "smtp.before-data"
  | "smtp.tls"
  | "smtp.dot-stuffing";

/** The outcome of one check. A check that does not apply is `n/a`, with the reason. */
export type CheckStatus =
  | { status: "pass" }
  | { status: "fail"; problems: string[] }
  | { status: "n/a"; reason: string };

/** One check result in a report. */
export type CheckEntry = { id: CheckId; title: string } & CheckStatus;

/** What `runChecks` returns. */
export interface CheckReport {
  /** The provider id from the adapter meta. */
  provider: string;
  /** The tier that the caller declared. */
  tier: ProviderTier;
  /** True when no check failed. */
  ok: boolean;
  checks: CheckEntry[];
}

/** An attachment as the provider request carries it. */
export interface CapturedAttachment {
  filename: string;
  /** The content as base64 text, as the request carries it. Whitespace is ignored. */
  content: string;
}

/** Recorded exchanges for the send endpoint. The kit answers the request with each one. */
export interface SendFixture {
  /** The request that `send` makes for one message. */
  request: RequestMatcher;
  /** An accepted message. */
  success: RecordedHttpResponse;
  /** The provider message id in `success`. When set, the result must carry it. */
  providerMessageId?: string;
  /** A response to a wrong key. */
  authFailure: RecordedHttpResponse;
  /** The reason for `authFailure`. Defaults to `auth`. */
  authReason?: FailureReason;
  /** A response to a message that the provider refuses as invalid. */
  validationFailure: RecordedHttpResponse;
  /** The reason for `validationFailure`. Defaults to `invalid_message`. */
  validationReason?: FailureReason;
  /** A 5xx response. The result must be `unknown`. */
  serverError: RecordedHttpResponse;
  /** A throttle response. Defaults to a 429 with `Retry-After: 2`. */
  rateLimited?: RecordedHttpResponse;
  /**
   * The response when an idempotency key is in use or reused with a different payload.
   * Required when the provider has native idempotency.
   */
  keyConflict?: RecordedHttpResponse;
  /** The request and the accepted response of `sendBatch`. Required when it exists. */
  batch?: { request: RequestMatcher; success: RecordedHttpResponse };
}

/** A webhook request: headers and raw body bytes. */
export interface WebhookSample {
  headers: Headers;
  body: Uint8Array;
}

/** One webhook body and the events that `parse` must return for it. */
export interface EventSample {
  label: string;
  body: string | Uint8Array;
  /**
   * The events, in order. Each entry lists the fields to compare. An empty list means
   * that the body holds no event.
   */
  expected: (Pick<NormalizedEvent, "type"> & Partial<NormalizedEvent>)[];
}

/** The webhook part of a fixture. */
export interface WebhookFixture {
  /** The signing secret. */
  secret: string;
  /** A secret that must fail. Defaults to a changed copy of `secret`. */
  wrongSecret?: string;
  /**
   * Signs a body the way the provider does, at `at` (Unix milliseconds). Returns the
   * request. Most providers return the body unchanged with signature headers.
   */
  sign(input: { body: Uint8Array; secret: string; at: number }): Promise<WebhookSample>;
  /**
   * A time outside the signature window, in Unix milliseconds. Set null only when the
   * provider signs no timestamp. The check then reports `n/a`.
   */
  staleAt: number | null;
  /** Changes a signed body. The default appends "x" to the first JSON string value. */
  tamper?(body: Uint8Array): Uint8Array;
  /** Exchanges that verification needs, for example the SNS signing certificate. */
  exchanges?: RecordedExchange[];
  /** The bodies for `parse`. The first one is the sample of the signature checks. */
  samples: EventSample[];
}

/** The fixture of one HTTP provider. */
export interface ConformanceFixture {
  /** The transport. Leave it out, or set `http`. An SMTP fixture sets `smtp`. */
  transport?: "http";
  /** Valid credentials, by field name, in the parsed form. */
  credentials: Readonly<Record<string, string>>;
  /** The clock of every call, in Unix milliseconds. Defaults to the real clock. */
  now?: number;
  send: SendFixture;
  /**
   * Reads the custom headers of the email in one captured send request. Required when
   * the provider passes custom headers.
   */
  readHeaders?(request: CapturedRequest): Record<string, string>;
  /** Reads the attachments of one captured send request. Required with attachments. */
  readAttachments?(request: CapturedRequest): CapturedAttachment[];
  verify: {
    /** Good credentials. `verify` must return `ok: true`. */
    ok: RecordedExchange[];
    /** A wrong key. `verify` must return `not_sent` with `badKeyReason`. */
    badKey: RecordedExchange[];
    /** Defaults to `auth`. */
    badKeyReason?: FailureReason;
  };
  /** Required when `meta.webhooks` is true. */
  webhook?: WebhookFixture;
  /**
   * Builds the canary value of a credential field for the redaction check. `token` is a
   * unique random string that must appear in the value. The default keeps a short
   * prefix of the fixture value (for example `re_`) and appends the token. Give your own
   * when the field pattern needs another shape.
   */
  canary?(field: CredentialField, token: string): string;
}

/**
 * Recorded SMTP replies. Each one is a full reply, as the server sends it. Separate the
 * lines of a multi-line reply with CRLF, for example `535-5.7.8 ...\r\n535 5.7.8 ...`.
 */
export interface SmtpReplies {
  /** The reply to AUTH with a wrong password. Defaults to a 535. */
  authFailure?: string;
  /** The reply to RCPT TO for a refused recipient. Defaults to a 550 5.1.1. */
  recipientRejected?: string;
  /** The reason for `recipientRejected`. Defaults to `rejected`. */
  recipientRejectedReason?: FailureReason;
  /** A throttle reply to MAIL FROM. Defaults to a 421 4.7.0. */
  rateLimited?: string;
  /** A reply to the final dot that is not 250. The result must be `unknown`. Defaults to a 451. */
  afterData?: string;
}

/**
 * The fixture of one SMTP provider. The kit runs the adapter against the mock SMTP
 * server (`mockSmtp`) through `SendContext.connect`. It makes no HTTP call.
 */
export interface SmtpConformanceFixture {
  transport: "smtp";
  /** Valid credentials, by field name, in the parsed form. They name the mock server. */
  credentials: Readonly<Record<string, string>>;
  /** The clock of every call, in Unix milliseconds. Defaults to the real clock. */
  now?: number;
  /** The login that the mock server accepts. It must match `credentials`. */
  server: { username: string; password: string; authMechanisms?: readonly string[] };
  /**
   * True when the credentials connect in plain text, as a local test server does. The
   * TLS check then reports `n/a`. Defaults to false.
   */
  plaintext?: boolean;
  /** Recorded replies of the provider. Each one has a default. */
  replies?: SmtpReplies;
  /** The provider message id of an accepted message. When set, the result must carry it. */
  providerMessageId?: string;
  /**
   * Builds credentials with a canary user name and password, for the redaction check.
   * The kit starts a mock server that accepts them.
   */
  canaryCredentials(username: string, password: string): Record<string, string>;
  /** Required when `meta.webhooks` is true. */
  webhook?: WebhookFixture;
}

/** An HTTP or an SMTP fixture. */
export type AnyConformanceFixture = ConformanceFixture | SmtpConformanceFixture;

/** The options of `runChecks`. */
export interface RunChecksOptions {
  /** The tier that the adapter claims. It must match `meta.tier`. */
  tier: ProviderTier;
}
