// mailswitch core. Later units add createMailer and defineProvider.
export const PACKAGE_NAME = "mailswitch" as const;

export { checkCapabilities } from "./core/capabilities";
export {
  type CredentialError,
  type CredentialErrorCode,
  type CredentialParseResult,
  parseCredentials,
} from "./core/credentials";
export { BLOCKED_HEADERS, type MessageValidation, validateMessage } from "./core/message";
export {
  type CredentialField,
  defineProviderMeta,
  type ProviderMeta,
  type ProviderPreset,
  type ProviderTier,
} from "./core/meta";
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
