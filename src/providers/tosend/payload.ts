// The toSend request body of one message. Internal to the adapter. It is not a public
// export.

import type { AddressInput, OutgoingMessage } from "../../core/types";
import { parseAddress } from "../../internal/address";
import { bytesToBase64 } from "../../internal/encoding";

interface ToSendAddress {
  email: string;
  name?: string;
}

function mailbox(input: AddressInput): ToSendAddress {
  // validateMessage has checked every address, so parseAddress cannot return null here.
  const parsed = parseAddress(input) ?? { email: "" };
  return parsed.name === undefined
    ? { email: parsed.email }
    : { email: parsed.email, name: parsed.name };
}

/**
 * Maps a message to the toSend request shape. The toSend API is in early access, so
 * every toSend field name is in this one function.
 */
export function toSendPayload(message: OutgoingMessage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: mailbox(message.from),
    to: message.to.map(mailbox),
    subject: message.subject,
  };
  if (message.cc?.length) body.cc = message.cc.map(mailbox);
  if (message.bcc?.length) body.bcc = message.bcc.map(mailbox);
  if (message.replyTo !== undefined) body.reply_to = mailbox(message.replyTo);
  if (message.html) body.html = message.html;
  if (message.text) body.text = message.text;
  if (message.headers && Object.keys(message.headers).length > 0) {
    body.headers = { ...message.headers };
  }
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((item) => ({
      type: item.contentType,
      name: item.filename,
      content: typeof item.content === "string" ? item.content : bytesToBase64(item.content),
      ...(item.contentId === undefined ? {} : { content_id: item.contentId }),
    }));
  }
  return body;
}
