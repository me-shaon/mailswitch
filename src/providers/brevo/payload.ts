// The Brevo request body of one message. Internal to the adapter. It is not a public
// export.
// https://developers.brevo.com/reference/sendtransacemail

import type { Address, AddressInput, OutgoingMessage } from "../../core/types";
import { parseAddress } from "../../internal/address";
import { bytesToBase64 } from "../../internal/encoding";

/** The body header that carries the idempotency key. */
export const BREVO_IDEMPOTENCY_HEADER = "idempotencyKey";
/** The body header that turns on sandbox mode. Brevo then checks the request and sends no email. */
export const BREVO_SANDBOX_HEADER = "X-Sib-Sandbox";

/** An address in the Brevo shape, `{ email, name? }`. */
function address(input: AddressInput): Address {
  // validateMessage has checked every address, so parseAddress cannot return null here.
  const parsed = parseAddress(input) ?? { email: "" };
  return parsed.name ? { email: parsed.email, name: parsed.name } : { email: parsed.email };
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
    sender: address(message.from),
    to: message.to.map(address),
    subject: message.subject,
  };
  if (message.cc?.length) body.cc = message.cc.map(address);
  if (message.bcc?.length) body.bcc = message.bcc.map(address);
  if (message.replyTo !== undefined) body.replyTo = address(message.replyTo);
  if (message.html !== undefined) body.htmlContent = message.html;
  if (message.text !== undefined) body.textContent = message.text;
  const headers: Record<string, string> = { ...message.headers };
  if (key !== undefined) headers[BREVO_IDEMPOTENCY_HEADER] = key;
  if (sandbox) headers[BREVO_SANDBOX_HEADER] = "drop";
  if (Object.keys(headers).length > 0) body.headers = headers;
  if (message.attachments?.length) {
    body.attachment = message.attachments.map((item) => ({
      content: typeof item.content === "string" ? item.content : bytesToBase64(item.content),
      name: item.filename,
    }));
  }
  return body;
}
