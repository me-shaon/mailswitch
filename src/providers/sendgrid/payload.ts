// The SendGrid request body of one message. Internal to the adapter. It is not a public
// export.
// https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send

import type { OutgoingMessage } from "../../core/types";
import { addressObject, parseAddress } from "../../internal/address";
import { attachmentBase64 } from "../../internal/encoding";

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
      ...(item.contentId === undefined
        ? { disposition: "attachment" }
        : { disposition: "inline", content_id: item.contentId }),
    }));
  }
  if (sandbox) body.mail_settings = { sandbox_mode: { enable: true } };
  return body;
}
