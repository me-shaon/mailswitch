import type { Capabilities, NotSentResult, OutgoingMessage } from "./types";

function unsupported(message: string): NotSentResult {
  return { status: "not_sent", reason: "unsupported", message };
}

/**
 * Checks a valid message against what a provider can send. Returns a
 * `not_sent/unsupported` result for the first missing capability, or null when the
 * provider can send the message. `encodedBytes` is the size from `validateMessage`.
 */
export function checkCapabilities(
  message: OutgoingMessage,
  capabilities: Capabilities,
  encodedBytes: number,
): NotSentResult | null {
  if (message.attachments && message.attachments.length > 0 && !capabilities.attachments) {
    return unsupported("The provider does not accept attachments.");
  }
  if (message.cc && message.cc.length > 0 && !capabilities.cc) {
    return unsupported("The provider does not accept cc recipients.");
  }
  if (message.bcc && message.bcc.length > 0 && !capabilities.bcc) {
    return unsupported("The provider does not accept bcc recipients.");
  }
  if (message.replyTo !== undefined && !capabilities.replyTo) {
    return unsupported("The provider does not accept a reply-to address.");
  }
  if (message.headers && Object.keys(message.headers).length > 0 && !capabilities.customHeaders) {
    return unsupported("The provider does not accept custom headers.");
  }
  if (capabilities.maxRecipients !== undefined) {
    const count = message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0);
    if (count > capabilities.maxRecipients) {
      return unsupported(
        `The message has ${count} recipients. The provider limit is ${capabilities.maxRecipients}.`,
      );
    }
  }
  if (capabilities.maxMessageBytes !== null && encodedBytes > capabilities.maxMessageBytes) {
    return unsupported(
      `The encoded message is ${encodedBytes} bytes. The provider limit is ${capabilities.maxMessageBytes} bytes.`,
    );
  }
  return null;
}
