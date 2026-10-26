// The Mailgun request body: the form fields of one message, encoded as
// `multipart/form-data`. Internal to the adapter. It is not a public export.

import type { AddressInput, OutgoingMessage } from "../../core/types";
import { formatAddress, parseAddress } from "../../internal/address";
import { base64ToBytes, utf8 } from "../../internal/encoding";

function address(input: AddressInput): string {
  const parsed = parseAddress(input);
  return parsed ? formatAddress(parsed) : "";
}

/**
 * Escapes a quoted parameter of a Content-Disposition header, as the HTML form encoding
 * does: `"` becomes `%22`, CR becomes `%0D`, and LF becomes `%0A`.
 */
export function escapeDispositionValue(value: string): string {
  return value.replace(/["\r\n]/g, (char) =>
    char === '"' ? "%22" : char === "\r" ? "%0D" : "%0A",
  );
}

/** One part of the form: a text field, or a file with a name and a type. */
export type MailgunFormPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; bytes: Uint8Array };

/** The form fields of one message, in order. Attachments are file parts. */
export function mailgunFormParts(message: OutgoingMessage): MailgunFormPart[] {
  const parts: MailgunFormPart[] = [{ name: "from", value: address(message.from) }];
  for (const to of message.to) parts.push({ name: "to", value: address(to) });
  for (const cc of message.cc ?? []) parts.push({ name: "cc", value: address(cc) });
  for (const bcc of message.bcc ?? []) parts.push({ name: "bcc", value: address(bcc) });
  parts.push({ name: "subject", value: message.subject });
  if (message.html !== undefined) parts.push({ name: "html", value: message.html });
  if (message.text !== undefined) parts.push({ name: "text", value: message.text });
  if (message.replyTo !== undefined) {
    parts.push({ name: "h:Reply-To", value: address(message.replyTo) });
  }
  // Custom headers go as `h:` fields, unchanged.
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    parts.push({ name: `h:${name}`, value });
  }
  for (const item of message.attachments ?? []) {
    const bytes =
      typeof item.content === "string"
        ? (base64ToBytes(item.content) ?? new Uint8Array(0))
        : item.content;
    // Mailgun names an inline file by its filename, and the HTML refers to `cid:<filename>`.
    parts.push(
      item.contentId === undefined
        ? { name: "attachment", filename: item.filename, contentType: item.contentType, bytes }
        : { name: "inline", filename: item.contentId, contentType: item.contentType, bytes },
    );
  }
  return parts;
}

/** Encodes form parts as a `multipart/form-data` body with the given boundary. */
export function encodeMultipart(parts: readonly MailgunFormPart[], boundary: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeDispositionValue(part.name)}"`;
    if ("filename" in part) {
      head += `; filename="${escapeDispositionValue(part.filename)}"\r\nContent-Type: ${part.contentType}`;
    }
    chunks.push(utf8(`${head}\r\n\r\n`));
    chunks.push("filename" in part ? part.bytes : utf8(part.value));
    chunks.push(utf8("\r\n"));
  }
  chunks.push(utf8(`--${boundary}--\r\n`));
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
