// The Mailtrap request body of one message. Internal to the adapter. It is not a public
// export. Checked 2026-10-27.
// https://docs.mailtrap.io/developers/email-sending/transactional/send-transactional-email.md

import type { OutgoingMessage } from "../../core/types";
import { addressObject } from "../../internal/address";
import { attachmentBase64 } from "../../internal/encoding";

/**
 * Maps a message to the request shape of `POST /api/send`. An attachment with a
 * `contentId` goes out with `disposition: "inline"`. The meta caps the recipients at
 * 1000, which is also the limit of each list.
 */
export function mailtrapPayload(message: OutgoingMessage): Record<string, unknown> {
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
  return body;
}
