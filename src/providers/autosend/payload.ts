// The AutoSend request body of one message, and the checks that AutoSend needs before a
// send. Internal to the adapter. It is not a public export. Checked 2026-10-27.
// https://docs.autosend.com/api-reference/mails/send.md

import type { OutgoingMessage } from "../../core/types";
import { addressObject } from "../../internal/address";
import { attachmentBase64 } from "../../internal/encoding";

/** The most custom headers of one email. */
export const MAX_HEADERS = 20;
/** The most attachments of one email. */
export const MAX_ATTACHMENTS = 20;
/** The longest subject, in characters. */
export const MAX_SUBJECT = 998;
/** The longest custom header value, in characters. */
export const MAX_HEADER_VALUE = 1000;

const HEADER_NAME = /^[A-Za-z0-9-]{1,76}$/;

/**
 * The reserved header names, in lowercase, that mailswitch refuses before the request.
 * AutoSend also reserves `List-Unsubscribe` and `List-Unsubscribe-Post`. The docs do not
 * say whether AutoSend refuses them or drops them. mailswitch passes those two through,
 * so the send call decides.
 */
export const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "date",
  "message-id",
  "return-path",
  "sender",
  "reply-to",
  "received",
  "dkim-signature",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "x-ses-configuration-set",
  "x-ses-message-tags",
]);

/**
 * The text of the first AutoSend rule that the message breaks, or null. `validateMessage`
 * has already checked the general rules.
 */
export function autosendRefusal(message: OutgoingMessage): string | null {
  if (message.to.length !== 1) {
    return "AutoSend takes one To address for each email. Send one message for each To recipient.";
  }
  if (message.subject.length > MAX_SUBJECT) {
    return `AutoSend takes a subject of at most ${MAX_SUBJECT} characters.`;
  }
  const attachments = message.attachments ?? [];
  if (attachments.length > MAX_ATTACHMENTS) {
    return `AutoSend takes at most ${MAX_ATTACHMENTS} attachments.`;
  }
  if (attachments.some((item) => item.contentId !== undefined)) {
    return "AutoSend has no inline attachments. Remove the contentId.";
  }
  const headers = Object.entries(message.headers ?? {});
  if (headers.length > MAX_HEADERS) return `AutoSend takes at most ${MAX_HEADERS} custom headers.`;
  for (const [name, value] of headers) {
    if (!HEADER_NAME.test(name)) {
      return "An AutoSend header name has 1 to 76 letters, digits, or hyphens.";
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      return `AutoSend reserves the ${name.toLowerCase()} header.`;
    }
    if (value.length > MAX_HEADER_VALUE) {
      return `AutoSend takes a header value of at most ${MAX_HEADER_VALUE} characters.`;
    }
  }
  return null;
}

/**
 * Maps a message to the request shape of `POST /v1/mails/send`. `to` is one object. The
 * caller has already checked the message with `autosendRefusal`.
 */
export function autosendPayload(message: OutgoingMessage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: addressObject(message.from),
    to: addressObject(message.to[0] as OutgoingMessage["from"]),
    subject: message.subject,
  };
  if (message.cc?.length) body.cc = message.cc.map(addressObject);
  if (message.bcc?.length) body.bcc = message.bcc.map(addressObject);
  if (message.replyTo !== undefined) body.replyTo = addressObject(message.replyTo);
  if (message.html !== undefined) body.html = message.html;
  if (message.text !== undefined) body.text = message.text;
  if (message.headers && Object.keys(message.headers).length > 0) body.headers = message.headers;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((item) => ({
      fileName: item.filename,
      content: attachmentBase64(item),
      contentType: item.contentType,
    }));
  }
  return body;
}
