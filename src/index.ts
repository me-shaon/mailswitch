// mailswitch core. Later units add createMailer.
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
  NORMALIZED_EVENT_TYPES,
  type NormalizedEvent,
  type NormalizedEventType,
  WEBHOOK_REJECTIONS,
  type WebhookRejection,
} from "./core/events";
export { BLOCKED_HEADERS, type MessageValidation, validateMessage } from "./core/message";
export {
  type CredentialField,
  defineProviderMeta,
  type ProviderMeta,
  type ProviderPreset,
  type ProviderTier,
} from "./core/meta";
export type {
  ProviderSocket,
  SecureTransport,
  SocketConnect,
  SocketTarget,
} from "./core/socket";
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
