// The Brevo request body of one message. Internal to the adapter. It is not a public
// export.
// https://developers.brevo.com/reference/sendtransacemail

import type { OutgoingMessage } from "../../core/types";
import { addressObject } from "../../internal/address";
import { attachmentBase64 } from "../../internal/encoding";

/** The body header that carries the idempotency key. */
export const BREVO_IDEMPOTENCY_HEADER = "idempotencyKey";
/** The body header that turns on sandbox mode. Brevo then checks the request and sends no email. */
export const BREVO_SANDBOX_HEADER = "X-Sib-Sandbox";

/** The reserved name of a custom header, in lowercase, or undefined. The adapter owns these names. */
export function reservedHeader(message: OutgoingMessage): string | undefined {
  const reserved = [BREVO_IDEMPOTENCY_HEADER.toLowerCase(), BREVO_SANDBOX_HEADER.toLowerCase()];
  return Object.keys(message.headers ?? {})
    .map((name) => name.toLowerCase())
    .find((name) => reserved.includes(name));
}

/** True when an attachment has a `contentId`. Brevo has no inline-image field. */
export function hasInlineAttachment(message: OutgoingMessage): boolean {
  return message.attachments?.some((item) => item.contentId !== undefined) === true;
}

/**
 * Maps a message to the Brevo request shape. `key` is the derived UUID of the message
 * idempotency key, or undefined. The same message and key always give the same body.
 */
export function brevoPayload(
  message: OutgoingMessage,
  key: string | undefined,
  sandbox: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sender: addressObject(message.from),
    to: message.to.map(addressObject),
    subject: message.subject,
  };
  if (message.cc?.length) body.cc = message.cc.map(addressObject);
  if (message.bcc?.length) body.bcc = message.bcc.map(addressObject);
  if (message.replyTo !== undefined) body.replyTo = addressObject(message.replyTo);
  if (message.html !== undefined) body.htmlContent = message.html;
  if (message.text !== undefined) body.textContent = message.text;
  const headers: Record<string, string> = { ...message.headers };
  if (key !== undefined) headers[BREVO_IDEMPOTENCY_HEADER] = key;
  if (sandbox) headers[BREVO_SANDBOX_HEADER] = "drop";
  if (Object.keys(headers).length > 0) body.headers = headers;
  if (message.attachments?.length) {
    body.attachment = message.attachments.map((item) => ({
      content: attachmentBase64(item),
      name: item.filename,
    }));
  }
  return body;
}
