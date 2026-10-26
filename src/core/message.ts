import { hasForbiddenChars, parseAddress } from "../internal/address";
import { base64Length, isBase64, utf8ByteLength } from "../internal/encoding";
import { checkCapabilities } from "./capabilities";
import type {
  AddressInput,
  Attachment,
  Capabilities,
  NotSentResult,
  OutgoingMessage,
} from "./types";

/** The outcome of `validateMessage`. */
export type MessageValidation =
  | {
      ok: true;
      /**
       * The size of the message after base64 encoding of the attachments, in bytes. It
       * counts the header-bound fields, the bodies, and the encoded attachments. It does
       * not count MIME boundaries or line breaks.
       */
      encodedBytes: number;
    }
  | { ok: false; result: NotSentResult };

/**
 * Headers that a custom header cannot set, in lowercase. mailswitch or the provider
 * builds them from the message fields.
 */
export const BLOCKED_HEADERS: ReadonlySet<string> = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "date",
  "reply-to",
  "sender",
  "content-type",
  "content-transfer-encoding",
  "mime-version",
  "return-path",
  "dkim-signature",
]);

const HEADER_NAME = /^[\x21-\x39\x3b-\x7e]+$/;
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
// A Message-ID is `<local@domain>`: no space, angle bracket, or second `@`.
const MESSAGE_ID = /^<[^\s<>@]+@[^\s<>@]+>$/;
const CONTENT_ID = /^[A-Za-z0-9._@-]+$/;
// A filename cannot hold a quote or a path separator, in addition to the header rules.
const FILENAME_SPECIALS = /["/\\]/;
const MAX_FILENAME_LENGTH = 255;

/** C0 and C1 controls, DEL, U+2028, and U+2029. Stricter than the header rule: TAB is refused too. */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

class Invalid {
  constructor(readonly text: string) {}
}

function fail(text: string): never {
  throw new Invalid(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addressBytes(input: AddressInput, field: string): number {
  const address = parseAddress(input);
  if (!address) fail(`${field} is not exactly one valid email address.`);
  return utf8ByteLength(address.email) + (address.name ? utf8ByteLength(address.name) : 0);
}

function addressListBytes(list: unknown, field: string): number {
  if (list === undefined) return 0;
  if (!Array.isArray(list)) fail(`${field} must be a list of addresses.`);
  let bytes = 0;
  for (let i = 0; i < list.length; i++) bytes += addressBytes(list[i], `${field}[${i}]`);
  return bytes;
}

function headerBytes(headers: unknown): number {
  if (headers === undefined) return 0;
  if (!isRecord(headers)) fail("headers must be an object of header names and values.");
  const seen = new Set<string>();
  let bytes = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) {
      fail("A custom header name must be printable ASCII with no space or colon.");
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) fail(`The ${lower} header is set more than once.`);
    seen.add(lower);
    if (typeof value !== "string") fail(`The value of the ${lower} header must be a string.`);
    if (hasForbiddenChars(value))
      fail(`The value of the ${lower} header has a forbidden character.`);
    if (BLOCKED_HEADERS.has(lower) || (lower === "message-id" && !MESSAGE_ID.test(value))) {
      fail(`The ${lower} header cannot be set to this value.`);
    }
    bytes += name.length + utf8ByteLength(value);
  }
  return bytes;
}

function attachmentBytes(attachment: unknown, field: string, contentIds: Set<string>): number {
  if (!isRecord(attachment)) fail(`${field} must be an attachment object.`);
  const { filename, content, contentType, contentId } = attachment as Partial<Attachment>;
  if (typeof filename !== "string" || filename.trim() === "") {
    fail(`${field}.filename must be a non-empty string.`);
  }
  if (filename.length > MAX_FILENAME_LENGTH) {
    fail(`${field}.filename is longer than ${MAX_FILENAME_LENGTH} characters.`);
  }
  if (hasControlChars(filename) || FILENAME_SPECIALS.test(filename)) {
    fail(`${field}.filename has a control character, a quote, or a path separator.`);
  }
  if (typeof contentType !== "string" || !CONTENT_TYPE.test(contentType)) {
    fail(`${field}.contentType must be a type/subtype MIME type with no parameters.`);
  }
  if (contentId !== undefined) {
    if (typeof contentId !== "string" || !CONTENT_ID.test(contentId)) {
      fail(`${field}.contentId may only contain letters, digits, '.', '_', '@', and '-'.`);
    }
    const key = contentId.toLowerCase();
    if (contentIds.has(key)) fail(`${field}.contentId is used by another attachment.`);
    contentIds.add(key);
  }
  let encoded: number;
  if (content instanceof Uint8Array) encoded = base64Length(content.length);
  else if (typeof content === "string") {
    if (!isBase64(content)) fail(`${field}.content is not valid padded base64.`);
    encoded = content.length;
  } else fail(`${field}.content must be a Uint8Array or a base64 string.`);
  return (
    encoded +
    utf8ByteLength(filename) +
    contentType.length +
    (contentId === undefined ? 0 : contentId.length)
  );
}

function measure(message: OutgoingMessage): number {
  let bytes = addressBytes(message.from, "from");

  if (!Array.isArray(message.to) || message.to.length === 0) {
    fail("to must list at least one recipient.");
  }
  bytes += addressListBytes(message.to, "to");
  bytes += addressListBytes(message.cc, "cc");
  bytes += addressListBytes(message.bcc, "bcc");
  if (message.replyTo !== undefined) bytes += addressBytes(message.replyTo, "replyTo");

  if (typeof message.subject !== "string") fail("subject must be a string.");
  if (hasForbiddenChars(message.subject)) fail("subject has a forbidden character.");
  bytes += utf8ByteLength(message.subject);

  const { html, text } = message;
  if (html !== undefined && typeof html !== "string") fail("html must be a string.");
  if (text !== undefined && typeof text !== "string") fail("text must be a string.");
  if (!html && !text) fail("The message needs an html or a text body.");
  bytes += (html ? utf8ByteLength(html) : 0) + (text ? utf8ByteLength(text) : 0);

  bytes += headerBytes(message.headers);

  if (message.attachments !== undefined) {
    if (!Array.isArray(message.attachments)) fail("attachments must be a list.");
    const contentIds = new Set<string>();
    for (let i = 0; i < message.attachments.length; i++) {
      bytes += attachmentBytes(message.attachments[i], `attachments[${i}]`, contentIds);
    }
  }

  const key = message.idempotencyKey;
  if (key !== undefined) {
    if (typeof key !== "string" || key === "") fail("idempotencyKey must be a non-empty string.");
    if (hasForbiddenChars(key)) fail("idempotencyKey has a forbidden character.");
  }
  return bytes;
}

/**
 * Checks a message before any network call. It never throws for bad message data.
 *
 * - A message that breaks a rule gives `not_sent/invalid_message`.
 * - With `capabilities`, a message that the provider cannot send gives `not_sent/unsupported`.
 *
 * The result text names the field. It never copies the field value.
 *
 * @throws TypeError when `message` is not an object. That is a programmer error.
 */
export function validateMessage(
  message: OutgoingMessage,
  capabilities?: Capabilities,
): MessageValidation {
  if (!isRecord(message)) throw new TypeError("validateMessage expects a message object.");
  let encodedBytes: number;
  try {
    encodedBytes = measure(message);
  } catch (error) {
    if (error instanceof Invalid) {
      return {
        ok: false,
        result: { status: "not_sent", reason: "invalid_message", message: error.text },
      };
    }
    throw error;
  }
  if (capabilities) {
    const refusal = checkCapabilities(message, capabilities, encodedBytes);
    if (refusal) return { ok: false, result: refusal };
  }
  return { ok: true, encodedBytes };
}
