// mailswitch core: createMailer, defineProvider, and the shared types.

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
export { DAILY_CAP_WINDOW_MS } from "./core/daily-cap";
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
  type WebhookSecretMeta,
} from "./core/meta";
export {
  createMailer,
  type Mailer,
  type MailerOptions,
  type MailerProvider,
} from "./core/pipeline";
export { createSendContext, type SendContextOptions } from "./core/send-context";
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
  DedupeClaimInput,
  DedupeClaimOutcome,
  DedupeCommitInput,
  DedupeReleaseInput,
  DedupeStore,
  IdempotencyAttempt,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinalState,
  IdempotencyFinishInput,
  IdempotencyRecord,
  IdempotencyState,
  IdempotencyStore,
  IdempotencyTouchInput,
  RateLimitAcquireInput,
  RateLimitGrant,
  RateLimitStore,
} from "./stores/types";
