// The MIME builder that the raw transports share (SMTP, and any adapter that sends raw
// RFC 5322 source). It builds 7-bit output with CRLF line endings:
// - Header values with non-ASCII characters are RFC 2047 B encoded words.
// - Header lines are folded near 78 characters. No line is longer than 998 characters.
// - Text bodies are UTF-8 quoted-printable. Attachments are base64 in 76-character lines.
// - Each boundary holds 128 random bits.
// - Attachment names use `filename*=UTF-8''` (RFC 2231), so any name survives.
//
// The input must pass `validateMessage` first. A value that is still invalid throws a
// TypeError, because that is a programmer error.

import type { Address, AddressInput, Attachment, OutgoingMessage } from "../core/types";
import { formatAddress, parseAddress } from "./address";
import { base64ToBytes, bytesToBase64, bytesToHex, utf8 } from "./encoding";

/** The longest line that RFC 5322 allows, without the CRLF. */
export const MAX_LINE_LENGTH = 998;
/** The line length that header folding aims for. */
const FOLD_AT = 78;
/** An encoded word carries at most 45 bytes, so it stays within 75 characters. */
const WORD_BYTES = 45;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** Options of `buildMime`. */
export interface MimeOptions {
  /** The `Date` header time, in Unix milliseconds. */
  now: number;
  /** Returns a boundary. Tests replace it. Defaults to 128 random bits. */
  boundary?: () => string;
  /** The `Message-ID` header. Defaults to 128 random bits at the domain of `from`. */
  messageId?: string;
}

/** The built message. */
export interface BuiltMime {
  /** The full RFC 5322 source, with CRLF line endings. */
  raw: string;
  /** The `Message-ID` value, with angle brackets. */
  messageId: string;
}

function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A boundary with 128 random bits. `=_` never appears in quoted-printable or base64 output. */
export function randomBoundary(): string {
  return `=_ms_${randomHex(16)}`;
}

/** RFC 2047 B encoded words, split on character boundaries. */
export function encodeWords(value: string): string[] {
  const words: string[] = [];
  let chunk = "";
  let size = 0;
  for (const char of value) {
    const bytes = utf8(char).length;
    if (size + bytes > WORD_BYTES && chunk !== "") {
      words.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += char;
    size += bytes;
  }
  if (chunk !== "") words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${bytesToBase64(utf8(word))}?=`);
}

/** Folds tokens into header lines of about 78 characters, joined with CRLF and a space. */
function fold(name: string, tokens: readonly string[]): string {
  const lines: string[] = [];
  let line = `${name}:`;
  for (const token of tokens) {
    if (line.length + 1 + token.length > FOLD_AT && line !== `${name}:`) {
      lines.push(line);
      line = "";
    }
    line += ` ${token}`;
  }
  lines.push(line);
  return lines.join("\r\n");
}

/**
 * One unstructured header field. A value with non-ASCII text, or with a word too long
 * for one line, becomes encoded words, so every line stays within 998 characters.
 */
export function headerField(name: string, value: string): string {
  if (PRINTABLE_ASCII.test(value)) {
    const words = value.split(" ");
    if (words.every((word) => word.length + name.length + 2 <= MAX_LINE_LENGTH)) {
      return fold(name, words);
    }
  }
  return fold(name, encodeWords(value));
}

/**
 * Formats one mailbox for a header. A display name with non-ASCII text becomes encoded
 * words. Throws a TypeError for an invalid address.
 */
export function encodeMailbox(input: AddressInput): string {
  const address: Address | null = parseAddress(input);
  if (!address) throw new TypeError("buildMime: an address is not valid.");
  const name = address.name;
  if (!name || PRINTABLE_ASCII.test(name)) return formatAddress(address);
  return `${encodeWords(name).join(" ")} <${address.email}>`;
}

function addressField(name: string, list: readonly AddressInput[]): string {
  const items = list.map(encodeMailbox);
  // Each mailbox ends with a comma, except the last. Tokens split at spaces.
  const tokens = items.flatMap((item, index) =>
    `${item}${index < items.length - 1 ? "," : ""}`.split(" "),
  );
  return fold(name, tokens);
}

const HEX = "0123456789ABCDEF";

/** UTF-8 quoted-printable (RFC 2045) with CRLF line breaks and lines of at most 76 characters. */
export function quotedPrintable(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, "\n")
    .split("\n")
    .map((line) => {
      const bytes = utf8(line);
      let out = "";
      let length = 0;
      bytes.forEach((byte, index) => {
        const last = index === bytes.length - 1;
        const plain =
          (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !last);
        const token = plain
          ? String.fromCharCode(byte)
          : `=${HEX[byte >> 4] as string}${HEX[byte & 15] as string}`;
        if (length + token.length > 75) {
          out += "=\r\n";
          length = 0;
        }
        out += token;
        length += token.length;
      });
      return out;
    })
    .join("\r\n");
}

/** Base64 in lines of 76 characters. */
function base64Lines(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/(.{76})(?=.)/g, "$1\r\n");
}

function attachmentBytes(item: Attachment): Uint8Array {
  if (typeof item.content !== "string") return item.content;
  const bytes = base64ToBytes(item.content);
  if (!bytes) throw new TypeError("buildMime: an attachment is not valid base64.");
  return bytes;
}

/** The longest value of one RFC 2231 parameter section. */
const SECTION_LENGTH = 60;

/**
 * `filename*=UTF-8''...` with RFC 3986 percent-encoding, plus a plain name when it is
 * safe. A long name is split into RFC 2231 sections (`filename*0*`, `filename*1*`), so
 * each folded line stays short. A split never cuts a `%XX` triplet.
 */
function fileParameters(filename: string): string[] {
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const sections: string[] = [];
  for (let start = 0; start < encoded.length; ) {
    let end = Math.min(start + SECTION_LENGTH, encoded.length);
    const percent = encoded.lastIndexOf("%", end - 1);
    if (percent > end - 3 && percent >= start && end < encoded.length) end = percent;
    sections.push(encoded.slice(start, end));
    start = end;
  }
  const params =
    sections.length === 1
      ? [`filename*=UTF-8''${encoded}`]
      : sections.map(
          (section, index) =>
            `filename*${index}*=${index === 0 ? "UTF-8''" : ""}${section}${index < sections.length - 1 ? ";" : ""}`,
        );
  if (PRINTABLE_ASCII.test(filename) && !/["\\]/.test(filename) && filename.length <= 200) {
    params.unshift(`filename="${filename}";`);
  }
  return params;
}

interface Part {
  headers: string[];
  body: string;
}

function textPart(type: "plain" | "html", text: string): Part {
  return {
    headers: [
      `Content-Type: text/${type}; charset=UTF-8`,
      "Content-Transfer-Encoding: quoted-printable",
    ],
    body: quotedPrintable(text),
  };
}

function attachmentPart(item: Attachment): Part {
  const inline = item.contentId !== undefined;
  const disposition = fold("Content-Disposition", [
    inline ? "inline;" : "attachment;",
    ...fileParameters(item.filename),
  ]);
  const headers = [
    `Content-Type: ${item.contentType}`,
    "Content-Transfer-Encoding: base64",
    disposition,
  ];
  if (inline) headers.push(`Content-ID: <${item.contentId}>`);
  return { headers, body: base64Lines(attachmentBytes(item)) };
}

function multipart(subtype: string, parts: Part[], boundary: () => string): Part {
  if (parts.length === 1) return parts[0] as Part;
  const mark = boundary();
  const lines: string[] = [];
  for (const part of parts) lines.push(`--${mark}`, ...part.headers, "", part.body);
  lines.push(`--${mark}--`);
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${mark}"`],
    body: lines.join("\r\n"),
  };
}

/** The RFC 5322 date, for example `Mon, 26 Oct 2026 12:00:00 +0000`. */
function rfc5322Date(ms: number): string {
  return new Date(ms).toUTCString().replace("GMT", "+0000");
}

/**
 * Builds the RFC 5322 source of a message. Bcc recipients get no header: the transport
 * adds them to the envelope only.
 */
export function buildMime(message: OutgoingMessage, options: MimeOptions): BuiltMime {
  const boundary = options.boundary ?? randomBoundary;
  const from = parseAddress(message.from);
  if (!from) throw new TypeError("buildMime: the from address is not valid.");
  const messageId =
    options.messageId ?? `<${randomHex(16)}@${from.email.slice(from.email.lastIndexOf("@") + 1)}>`;

  const head = [
    `Message-ID: ${messageId}`,
    `Date: ${rfc5322Date(options.now)}`,
    addressField("From", [message.from]),
    addressField("To", message.to),
  ];
  if (message.cc?.length) head.push(addressField("Cc", message.cc));
  if (message.replyTo !== undefined) head.push(addressField("Reply-To", [message.replyTo]));
  head.push(headerField("Subject", message.subject), "MIME-Version: 1.0");
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    head.push(headerField(name, value));
  }

  const texts: Part[] = [];
  if (message.text !== undefined && message.text !== "")
    texts.push(textPart("plain", message.text));
  if (message.html !== undefined && message.html !== "") texts.push(textPart("html", message.html));
  const attachments = message.attachments ?? [];
  const inline = attachments.filter((item) => item.contentId !== undefined);
  const files = attachments.filter((item) => item.contentId === undefined);

  let root = multipart("alternative", texts, boundary);
  if (inline.length > 0) {
    root = multipart("related", [root, ...inline.map(attachmentPart)], boundary);
  }
  if (files.length > 0) root = multipart("mixed", [root, ...files.map(attachmentPart)], boundary);

  const raw = `${[...head, ...root.headers].join("\r\n")}\r\n\r\n${root.body}\r\n`;
  return { raw, messageId };
}
