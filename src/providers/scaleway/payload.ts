// The Scaleway `POST .../emails` body of one message, and the checks that Scaleway needs
// before a send. Internal to the adapter. It is not a public export. Checked 2026-10-27.
// https://www.scaleway.com/en/developers/api/transactional-email/v1alpha1/schema.yml
// https://www.scaleway.com/en/docs/transactional-email/reference-content/tem-capabilities-and-limits/

import type { OutgoingMessage } from "../../core/types";
import { addressObject } from "../../internal/address";
import { attachmentBase64 } from "../../internal/encoding";
import { encodeMailbox } from "../../internal/mime";

/** The most attachments of one email. */
const MAX_ATTACHMENTS = 10;

/**
 * The text of the first Scaleway rule that the message breaks, or null. `validateMessage`
 * has already checked the general rules and the recipient count.
 */
export function scalewayRefusal(message: OutgoingMessage): string | null {
  const attachments = message.attachments ?? [];
  if (attachments.length > MAX_ATTACHMENTS) {
    return `Scaleway takes at most ${MAX_ATTACHMENTS} attachments.`;
  }
  if (attachments.some((item) => item.contentId !== undefined)) {
    return "Scaleway has no inline attachments. Remove the contentId.";
  }
  return null;
}

/**
 * Maps a message to the send body. The secret key never goes in the body.
 *
 * - Reply-To and the custom headers go to `additional_headers` as `{ key, value }`.
 * - A Reply-To display name with non-ASCII text becomes RFC 2047 encoded words.
 * - The attachment MIME type is not checked. Scaleway refuses a type that it does not
 *   allow.
 */
export function scalewayPayload(
  message: OutgoingMessage,
  projectId: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: addressObject(message.from),
    to: message.to.map(addressObject),
  };
  if (message.cc?.length) body.cc = message.cc.map(addressObject);
  if (message.bcc?.length) body.bcc = message.bcc.map(addressObject);
  body.subject = message.subject;
  if (message.text !== undefined) body.text = message.text;
  if (message.html !== undefined) body.html = message.html;
  body.project_id = projectId;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((item) => ({
      name: item.filename,
      type: item.contentType,
      content: attachmentBase64(item),
    }));
  }
  const headers: { key: string; value: string }[] = [];
  if (message.replyTo !== undefined) {
    headers.push({ key: "Reply-To", value: encodeMailbox(message.replyTo) });
  }
  for (const [key, value] of Object.entries(message.headers ?? {})) headers.push({ key, value });
  if (headers.length > 0) body.additional_headers = headers;
  return body;
}
