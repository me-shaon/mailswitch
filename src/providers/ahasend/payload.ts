// The AhaSend request body of one message. Internal to the adapter, except
// `AHASEND_MAX_LIST_RECIPIENTS`, which the subpath exports. Checked 2026-10-27.
// https://ahasend.com/docs/api-reference/messages/create-conversation.md

import type { OutgoingMessage } from "../../core/types";
import { addressObject } from "../../internal/address";
import { attachmentBase64 } from "../../internal/encoding";

/** The most addresses in each of to, cc, and bcc. */
export const AHASEND_MAX_LIST_RECIPIENTS = 50;

/**
 * Why AhaSend would refuse or change the message, or null when it is fine. AhaSend
 * ignores a custom Message-ID header, so mailswitch refuses it rather than drop it. The
 * text names no header value and no address.
 */
export function messageProblem(message: OutgoingMessage): string | null {
  const lists: [string, readonly unknown[] | undefined][] = [
    ["to", message.to],
    ["cc", message.cc],
    ["bcc", message.bcc],
  ];
  for (const [name, list] of lists) {
    if ((list?.length ?? 0) > AHASEND_MAX_LIST_RECIPIENTS) {
      return `AhaSend accepts at most ${AHASEND_MAX_LIST_RECIPIENTS} ${name} recipients.`;
    }
  }
  for (const name of Object.keys(message.headers ?? {})) {
    if (name.toLowerCase() === "message-id") {
      return "AhaSend ignores a custom message-id header.";
    }
  }
  return null;
}

/** The count of to, cc, and bcc recipients. */
export function recipientCount(message: OutgoingMessage): number {
  return message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0);
}

/**
 * Maps a message to the request shape of `POST /v2/accounts/{id}/messages/conversation`.
 * Every attachment is base64 with `base64: true`. An inline attachment gets its
 * `content_id` in angle brackets. The same message always gives the same bytes.
 */
export function ahasendPayload(
  message: OutgoingMessage,
  sandbox: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: addressObject(message.from),
    to: message.to.map(addressObject),
    subject: message.subject,
  };
  if (message.cc?.length) body.cc = message.cc.map(addressObject);
  if (message.bcc?.length) body.bcc = message.bcc.map(addressObject);
  if (message.replyTo !== undefined) body.reply_to = addressObject(message.replyTo);
  if (message.text !== undefined) body.text_content = message.text;
  if (message.html !== undefined) body.html_content = message.html;
  if (message.headers && Object.keys(message.headers).length > 0) body.headers = message.headers;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((item) => ({
      data: attachmentBase64(item),
      base64: true,
      content_type: item.contentType,
      file_name: item.filename,
      ...(item.contentId === undefined
        ? {}
        : { content_id: `<${item.contentId}>`, content_disposition: "inline" }),
    }));
  }
  if (sandbox) body.sandbox = true;
  return body;
}
