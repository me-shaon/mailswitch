// mailswitch core. Later units add createMailer and defineProvider.
export const PACKAGE_NAME = "mailswitch" as const;

export { checkCapabilities } from "./core/capabilities";
export { BLOCKED_HEADERS, type MessageValidation, validateMessage } from "./core/message";
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
