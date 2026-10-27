// The MailerSend request body of one message. Internal to the adapter. It is not a public
// export.
// https://developers.mailersend.com/api/v1/email

import type { Address, AddressInput, OutgoingMessage } from "../../core/types";
import { parseAddress } from "../../internal/address";
import { bytesToBase64 } from "../../internal/encoding";

/** The recipient limits of one MailerSend email, by field. */
export const FIELD_LIMITS: Readonly<Record<"to" | "cc" | "bcc", number>> = {
  to: 50,
  cc: 10,
  bcc: 10,
};

/** An address in the MailerSend shape, `{ email, name? }`. */
function address(input: AddressInput): Address {
  // validateMessage has checked every address, so parseAddress cannot return null here.
  const parsed = parseAddress(input) ?? { email: "" };
  return parsed.name ? { email: parsed.email, name: parsed.name } : { email: parsed.email };
}

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
    from: address(message.from),
    to: message.to.map(address),
    subject: message.subject,
  };
  if (message.cc?.length) body.cc = message.cc.map(address);
  if (message.bcc?.length) body.bcc = message.bcc.map(address);
  if (message.replyTo !== undefined) body.reply_to = address(message.replyTo);
  if (message.text !== undefined) body.text = message.text;
  if (message.html !== undefined) body.html = message.html;
  if (message.headers && Object.keys(message.headers).length > 0) {
    body.headers = Object.entries(message.headers).map(([name, value]) => ({ name, value }));
  }
  if (message.attachments?.length) {
    // MailerSend has no content type field. It reads the type from the file name.
    body.attachments = message.attachments.map((item) => ({
      content: typeof item.content === "string" ? item.content : bytesToBase64(item.content),
      filename: item.filename,
      ...(item.contentId === undefined
        ? { disposition: "attachment" }
        : { disposition: "inline", id: item.contentId }),
    }));
  }
  return body;
}
