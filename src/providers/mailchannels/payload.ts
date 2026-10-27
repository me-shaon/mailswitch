// The MailChannels request body of one message. Internal to the adapter. It is not a
// public export.
// https://docs.mailchannels.com/api-reference/send/send-an-email

import type { OutgoingMessage } from "../../core/types";
import { addressObject } from "../../internal/address";
import { attachmentBase64, utf8ByteLength } from "../../internal/encoding";

/**
 * Headers that MailChannels does not accept in `headers`, in lowercase. MailChannels
 * builds them from the message fields. `validateMessage` already refuses most of them.
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "authentication-results",
  "bcc",
  "cc",
  "content-transfer-encoding",
  "content-type",
  "dkim-signature",
  "from",
  "message-id",
  "received",
  "reply-to",
  "subject",
  "to",
]);

/** The largest size of the custom header names and values together, in bytes (5 KB). */
export const MAILCHANNELS_MAX_HEADER_BYTES = 5_000;

/**
 * Why MailChannels would refuse the custom headers of a message, or null when they are
 * fine. The text names no header value.
 */
export function headerProblem(message: OutgoingMessage): string | null {
  let bytes = 0;
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      return `MailChannels does not accept a custom ${name.toLowerCase()} header.`;
    }
    bytes += utf8ByteLength(name) + utf8ByteLength(value);
  }
  return bytes > MAILCHANNELS_MAX_HEADER_BYTES
    ? "The custom headers are larger than the 5 KB that MailChannels accepts."
    : null;
}

/**
 * Maps a message to the MailChannels request shape. All recipients go in one
 * personalization. `text/plain` comes before `text/html`.
 */
export function mailchannelsPayload(message: OutgoingMessage): Record<string, unknown> {
  const recipients: Record<string, unknown> = { to: message.to.map(addressObject) };
  if (message.cc?.length) recipients.cc = message.cc.map(addressObject);
  if (message.bcc?.length) recipients.bcc = message.bcc.map(addressObject);
  const content: { type: string; value: string }[] = [];
  if (message.text) content.push({ type: "text/plain", value: message.text });
  if (message.html) content.push({ type: "text/html", value: message.html });
  const body: Record<string, unknown> = {
    personalizations: [recipients],
    from: addressObject(message.from),
    subject: message.subject,
    content,
  };
  if (message.replyTo !== undefined) body.reply_to = addressObject(message.replyTo);
  if (message.headers && Object.keys(message.headers).length > 0) body.headers = message.headers;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((item) => ({
      content: attachmentBase64(item),
      filename: item.filename,
      type: item.contentType,
      ...(item.contentId === undefined ? {} : { content_id: item.contentId }),
    }));
  }
  return body;
}
