// The Mailjet Send API v3.1 body of one message. Internal to the adapter. It is not a
// public export.
// https://dev.mailjet.com/openapi/openapi-mailjet/send-emails/postsendv31.md

import type { AddressInput, OutgoingMessage } from "../../core/types";
import { parseAddress } from "../../internal/address";
import { bytesToBase64 } from "../../internal/encoding";

/** An address in the Mailjet shape, `{ Email, Name? }`. */
function address(input: AddressInput): { Email: string; Name?: string } {
  // validateMessage has checked every address, so parseAddress cannot return null here.
  const parsed = parseAddress(input) ?? { email: "" };
  return parsed.name ? { Email: parsed.email, Name: parsed.name } : { Email: parsed.email };
}

/**
 * Maps a message to one entry of the `Messages` array. An attachment with a `contentId`
 * goes to `InlinedAttachments`. The `Headers` object never holds a header that has its
 * own property, because `validateMessage` refuses those headers.
 */
export function mailjetMessage(message: OutgoingMessage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    From: address(message.from),
    To: message.to.map(address),
  };
  if (message.cc?.length) body.Cc = message.cc.map(address);
  if (message.bcc?.length) body.Bcc = message.bcc.map(address);
  if (message.replyTo !== undefined) body.ReplyTo = address(message.replyTo);
  body.Subject = message.subject;
  if (message.text !== undefined) body.TextPart = message.text;
  if (message.html !== undefined) body.HTMLPart = message.html;
  if (message.headers && Object.keys(message.headers).length > 0) {
    body.Headers = { ...message.headers };
  }
  const files: Record<string, string>[] = [];
  const inline: Record<string, string>[] = [];
  for (const item of message.attachments ?? []) {
    const file: Record<string, string> = {
      ContentType: item.contentType,
      Filename: item.filename,
      Base64Content: typeof item.content === "string" ? item.content : bytesToBase64(item.content),
    };
    if (item.contentId === undefined) files.push(file);
    else inline.push({ ...file, ContentID: item.contentId });
  }
  if (files.length > 0) body.Attachments = files;
  if (inline.length > 0) body.InlinedAttachments = inline;
  return body;
}
