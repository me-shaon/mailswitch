// The SendGrid request body of one message. Internal to the adapter. It is not a public
// export.
// https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send

import type { Address, AddressInput, OutgoingMessage } from "../../core/types";
import { parseAddress } from "../../internal/address";
import { bytesToBase64 } from "../../internal/encoding";

/** An address in the SendGrid shape, `{ email, name? }`. */
function address(input: AddressInput): Address {
  // validateMessage has checked every address, so parseAddress cannot return null here.
  const parsed = parseAddress(input) ?? { email: "" };
  return parsed.name ? { email: parsed.email, name: parsed.name } : { email: parsed.email };
}

/** True when the display name of `from` has a character outside ASCII. */
export function hasNonAsciiFromName(message: OutgoingMessage): boolean {
  const name = parseAddress(message.from)?.name ?? "";
  return /[^\x20-\x7e]/.test(name);
}

/**
 * Maps a message to the SendGrid request shape. All recipients go in one personalization.
 * `text/plain` comes before `text/html`, as SendGrid requires.
 */
export function sendgridPayload(
  message: OutgoingMessage,
  sandbox: boolean,
): Record<string, unknown> {
  const recipients: Record<string, unknown> = { to: message.to.map(address) };
  if (message.cc?.length) recipients.cc = message.cc.map(address);
  if (message.bcc?.length) recipients.bcc = message.bcc.map(address);
  const content: { type: string; value: string }[] = [];
  if (message.text) content.push({ type: "text/plain", value: message.text });
  if (message.html) content.push({ type: "text/html", value: message.html });
  const body: Record<string, unknown> = {
    personalizations: [recipients],
    from: address(message.from),
    subject: message.subject,
    content,
  };
  if (message.replyTo !== undefined) body.reply_to = address(message.replyTo);
  if (message.headers && Object.keys(message.headers).length > 0) body.headers = message.headers;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((item) => ({
      content: typeof item.content === "string" ? item.content : bytesToBase64(item.content),
      filename: item.filename,
      type: item.contentType,
      ...(item.contentId === undefined
        ? { disposition: "attachment" }
        : { disposition: "inline", content_id: item.contentId }),
    }));
  }
  if (sandbox) body.mail_settings = { sandbox_mode: { enable: true } };
  return body;
}
