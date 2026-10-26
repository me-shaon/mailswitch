// mailswitch core: createMailer, defineProvider, and the shared types.
export const PACKAGE_NAME = "mailswitch" as const;

export {
  defineProvider,
  type ProviderAdapter,
  type ProviderCredentials,
  type ProviderWebhooks,
  type SendContext,
  type VerifyResult,
  type WebhookVerifyInput,
  type WebhookVerifyResult,
} from "./core/adapter";
export { checkCapabilities } from "./core/capabilities";
export {
  type CredentialError,
  type CredentialErrorCode,
  type CredentialParseResult,
  parseCredentials,
} from "./core/credentials";
export {
  bucketExpiry,
  DAILY_CAP_BUCKET_MS,
  DAILY_CAP_WINDOW_MS,
} from "./core/daily-cap";
export {
  NORMALIZED_EVENT_TYPES,
  type NormalizedEvent,
  type NormalizedEventType,
  WEBHOOK_REJECTIONS,
  type WebhookRejection,
} from "./core/events";
export { allowFallback, type ShouldFallback } from "./core/fallback";
export type { AttemptView, LogData, MailerLogger } from "./core/hooks";
export {
  DEFAULT_PENDING_TIMEOUT_MS,
  minPendingTimeout,
} from "./core/idempotency";
export { BLOCKED_HEADERS, type MessageValidation, validateMessage } from "./core/message";
export {
  type CredentialField,
  defineProviderMeta,
  type ProviderMeta,
  type ProviderPreset,
  type ProviderTier,
} from "./core/meta";
export {
  createMailer,
  type Mailer,
  type MailerOptions,
  type MailerProvider,
} from "./core/pipeline";
export type {
  ProviderSocket,
  SecureTransport,
  SocketConnect,
  SocketTarget,
} from "./core/socket";
export {
  sendTestEmail,
  TEST_EMAIL_SUBJECT,
  TEST_EMAIL_TEXT,
  type TestEmailOptions,
} from "./core/test-send";
export type {
  Address,
  AddressInput,
  Attachment,
  Capabilities,
  DeliveryStatus,
  FailureFields,
  FailureReason,
  NotSentResult,
  OutgoingMessage,
  SendResult,
  SentResult,
  UnknownResult,
} from "./core/types";
export type {
  DailyCapFillInput,
  DailyCapReleaseInput,
  DailyCapReservation,
  DailyCapReserveInput,
  DailyCapStore,
  IdempotencyAppendInput,
  IdempotencyAttempt,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinalState,
  IdempotencyFinishInput,
  IdempotencyRecord,
  IdempotencyState,
  IdempotencyStore,
} from "./stores/types";
