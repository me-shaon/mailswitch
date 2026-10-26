import { parseAddress } from "../internal/address";
import { base64ToBytes, bytesToHex, utf8 } from "../internal/encoding";
import type { AddressInput, OutgoingMessage } from "./types";

// The payload hash binds an idempotency key to one message. A retry with the same key and
// a different message is a conflict. The hash covers every field that changes what the
// recipient gets. It does not cover the idempotency key.

const VERSION = "mailswitch-payload-v1";

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
}

function address(input: AddressInput | undefined): [string, string] | null {
  if (input === undefined) return null;
  const parsed = parseAddress(input);
  // Validation runs before the hash. Keep an invalid value as it is, so the hash stays defined.
  if (!parsed) return [typeof input === "string" ? input : String(input.email), ""];
  return [parsed.email, parsed.name ?? ""];
}

function addresses(list: readonly AddressInput[] | undefined): Array<[string, string] | null> {
  return (list ?? []).map(address);
}

/**
 * The SHA-256 hex of the canonical encoding of a message: from, to, cc, bcc, reply-to,
 * subject, bodies, custom headers (sorted by lowercase name), and one digest per
 * attachment (filename, content type, content id, and the SHA-256 of the bytes).
 *
 * A base64 string and the same raw bytes give the same digest.
 */
export async function payloadHash(message: OutgoingMessage): Promise<string> {
  const headers = Object.entries(message.headers ?? {})
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const attachments: string[][] = [];
  for (const attachment of message.attachments ?? []) {
    const { content } = attachment;
    const bytes =
      typeof content === "string"
        ? (base64ToBytes(content) ?? utf8(content))
        : new Uint8Array(content);
    attachments.push([
      attachment.filename,
      attachment.contentType,
      attachment.contentId ?? "",
      await sha256(bytes),
    ]);
  }
  const canonical = JSON.stringify([
    VERSION,
    address(message.from),
    addresses(message.to),
    addresses(message.cc),
    addresses(message.bcc),
    address(message.replyTo),
    message.subject,
    message.html ?? null,
    message.text ?? null,
    headers,
    attachments,
  ]);
  return sha256(utf8(canonical));
}
