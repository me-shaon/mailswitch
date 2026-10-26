// The SNS message shape and the canonical string that SNS signs. The SES verifier and
// the conformance signer share this module. It imports nothing from the adapter.
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html

/** The type of an SNS message. */
export type SnsMessageType =
  | "Notification"
  | "SubscriptionConfirmation"
  | "UnsubscribeConfirmation";

/** An SNS message as it arrives in a webhook body. */
export interface SnsMessage {
  Type: SnsMessageType;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
  UnsubscribeURL?: string;
}

/** A field that SNS can sign. */
export type SnsSignedField =
  | "Message"
  | "MessageId"
  | "Subject"
  | "SubscribeURL"
  | "Timestamp"
  | "Token"
  | "TopicArn"
  | "Type";

const CONFIRMATION_FIELDS: readonly SnsSignedField[] = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
];

/** The signed fields of each message type, in signing order. */
const FIELDS: Readonly<Record<SnsMessageType, readonly SnsSignedField[]>> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: CONFIRMATION_FIELDS,
  UnsubscribeConfirmation: CONFIRMATION_FIELDS,
};

/** True when a value is a known SNS message type. */
export function isSnsMessageType(value: unknown): value is SnsMessageType {
  return typeof value === "string" && Object.hasOwn(FIELDS, value);
}

/**
 * The canonical string that SNS signs: `Key\nValue\n` for each field, in order. Returns
 * an empty string when a required field is missing.
 */
export function snsStringToSign(message: SnsMessage): string {
  let text = "";
  for (const field of FIELDS[message.Type]) {
    // Each signed field is a typed key of SnsMessage, so the compiler checks this table.
    const value: string | undefined = message[field];
    if (value == null) {
      // Subject appears only when the publisher set one.
      if (field === "Subject") continue;
      return "";
    }
    text += `${field}\n${value}\n`;
  }
  return text;
}
