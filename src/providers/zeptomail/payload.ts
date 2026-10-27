// The ZeptoMail `POST /v1.1/email` body of one message. Internal to the adapter. It is
// not a public export.
// https://www.zoho.com/zeptomail/help/api/email-sending.html

import type { AddressInput, OutgoingMessage } from "../../core/types";
import { parseAddress } from "../../internal/address";
import { attachmentBase64 } from "../../internal/encoding";

interface ZeptomailAddress {
  address: string;
  name?: string;
}

function mailbox(input: AddressInput): ZeptomailAddress {
  // validateMessage has checked every address, so parseAddress cannot return null here.
  const parsed = parseAddress(input) ?? { email: "" };
  return parsed.name === undefined
    ? { address: parsed.email }
    : { address: parsed.email, name: parsed.name };
}

const recipient = (input: AddressInput) => ({ email_address: mailbox(input) });

/**
 * Maps a message to the send body. The token never goes in the body.
 *
 * - Custom headers go to `mime_headers`.
 * - An attachment with a `contentId` goes to `inline_images` with that `cid`.
 */
export function zeptomailPayload(message: OutgoingMessage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: mailbox(message.from),
    to: message.to.map(recipient),
  };
  if (message.cc?.length) body.cc = message.cc.map(recipient);
  if (message.bcc?.length) body.bcc = message.bcc.map(recipient);
  if (message.replyTo !== undefined) body.reply_to = [mailbox(message.replyTo)];
  body.subject = message.subject;
  if (message.text !== undefined) body.textbody = message.text;
  if (message.html !== undefined) body.htmlbody = message.html;
  if (message.headers && Object.keys(message.headers).length > 0) {
    body.mime_headers = { ...message.headers };
  }
  const files: Record<string, string>[] = [];
  const inlines: Record<string, string>[] = [];
  for (const item of message.attachments ?? []) {
    const content = attachmentBase64(item);
    const entry = { content, mime_type: item.contentType, name: item.filename };
    if (item.contentId === undefined) files.push(entry);
    else inlines.push({ ...entry, cid: item.contentId });
  }
  if (files.length > 0) body.attachments = files;
  if (inlines.length > 0) body.inline_images = inlines;
  return body;
}
