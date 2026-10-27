// The SMTP2GO `POST /v3/email/send` body of one message. Internal to the adapter. It is
// not a public export.
// https://developers.smtp2go.com/reference/send-standard-email.md

import type { AddressInput, OutgoingMessage } from "../../core/types";
import { formatAddress, parseAddress } from "../../internal/address";
import { attachmentBase64 } from "../../internal/encoding";

/** An address as `Name <addr>` text. */
function address(input: AddressInput): string {
  // validateMessage has checked every address, so parseAddress cannot return null here.
  return formatAddress(parseAddress(input) ?? { email: "" });
}

/**
 * Maps a message to the send body. The key never goes in the body.
 *
 * - `fastaccept` is always false, so the answer keeps `succeeded` and `failed`.
 * - Reply-To goes in `custom_headers`, after the custom headers of the message.
 * - An attachment with a `contentId` goes to `inlines`. SMTP2GO links an inline image as
 *   `cid:<filename>`, so its `filename` is the content id.
 */
export function smtp2goPayload(message: OutgoingMessage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sender: address(message.from),
    to: message.to.map(address),
  };
  if (message.cc?.length) body.cc = message.cc.map(address);
  if (message.bcc?.length) body.bcc = message.bcc.map(address);
  body.subject = message.subject;
  if (message.text !== undefined) body.text_body = message.text;
  if (message.html !== undefined) body.html_body = message.html;
  const headers = Object.entries(message.headers ?? {}).map(([header, value]) => ({
    header,
    value,
  }));
  if (message.replyTo !== undefined) {
    headers.push({ header: "Reply-To", value: address(message.replyTo) });
  }
  if (headers.length > 0) body.custom_headers = headers;
  const files: Record<string, string>[] = [];
  const inlines: Record<string, string>[] = [];
  for (const item of message.attachments ?? []) {
    const fileblob = attachmentBase64(item);
    if (item.contentId === undefined) {
      files.push({ filename: item.filename, fileblob, mimetype: item.contentType });
    } else {
      inlines.push({ filename: item.contentId, fileblob, mimetype: item.contentType });
    }
  }
  if (files.length > 0) body.attachments = files;
  if (inlines.length > 0) body.inlines = inlines;
  body.fastaccept = false;
  return body;
}
