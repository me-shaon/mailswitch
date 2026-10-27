// The MailerSend request body of one message. Internal to the adapter. It is not a public
// export.
// https://developers.mailersend.com/api/v1/email

import type { OutgoingMessage } from "../../core/types";
import { addressObject } from "../../internal/address";
import { attachmentBase64 } from "../../internal/encoding";

/** The recipient limits of one MailerSend email, by field. */
export const FIELD_LIMITS: Readonly<Record<"to" | "cc" | "bcc", number>> = {
  to: 50,
  cc: 10,
  bcc: 10,
};

/** Returns the first field that has more recipients than MailerSend accepts, or null. */
export function overLimitField(message: OutgoingMessage): "to" | "cc" | "bcc" | null {
  for (const field of ["to", "cc", "bcc"] as const) {
    if ((message[field]?.length ?? 0) > FIELD_LIMITS[field]) return field;
  }
  return null;
}

/** Maps a message to the MailerSend request shape. */
export function mailersendPayload(message: OutgoingMessage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: addressObject(message.from),
    to: message.to.map(addressObject),
    subject: message.subject,
  };
  if (message.cc?.length) body.cc = message.cc.map(addressObject);
  if (message.bcc?.length) body.bcc = message.bcc.map(addressObject);
  if (message.replyTo !== undefined) body.reply_to = addressObject(message.replyTo);
  if (message.text !== undefined) body.text = message.text;
  if (message.html !== undefined) body.html = message.html;
  if (message.headers && Object.keys(message.headers).length > 0) {
    body.headers = Object.entries(message.headers).map(([name, value]) => ({ name, value }));
  }
  if (message.attachments?.length) {
    // MailerSend has no content type field. It reads the type from the file name.
    body.attachments = message.attachments.map((item) => ({
      content: attachmentBase64(item),
      filename: item.filename,
      ...(item.contentId === undefined
        ? { disposition: "attachment" }
        : { disposition: "inline", id: item.contentId }),
    }));
  }
  return body;
}
