// The shared builder of the bounce detail. Every adapter passes the raw provider fields
// here. The builder removes control and invisible characters from the text, trims it, and
// cuts it at a fixed length. It keeps a code only when the provider sends it as its own
// field in a valid form. It never reads a code out of the text.

import type { BounceDetail } from "../core/events";

/** The longest bounce text, in UTF-16 code units. */
export const BOUNCE_TEXT_MAX = 1000;

// C0 controls, DEL, C1 controls, the soft hyphen, the Arabic letter mark, zero-width and
// direction marks, the line and paragraph separators, the bidi embeddings and isolates,
// the invisible operators, the byte order mark, and the tag characters.
const REMOVED_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

function removed(codePoint: number): boolean {
  return REMOVED_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

// Removes the characters of the set and the leading whitespace. It stops a little after
// the cap, so a large text costs no more CPU than a short one.
function stripRemoved(value: string): string {
  let out = "";
  for (const char of value) {
    if (removed(char.codePointAt(0) as number)) continue;
    if (out === "" && char.trim() === "") continue;
    out += char;
    if (out.length > BOUNCE_TEXT_MAX + 2) break;
  }
  return out;
}

const ENHANCED_CODE = /^[245]\.\d{1,3}\.\d{1,3}$/;

/** The raw bounce fields of one provider event. Each part is optional and unchecked. */
export interface RawBounceDetail {
  text?: unknown;
  smtpCode?: unknown;
  enhancedCode?: unknown;
}

/** The text without the removed characters, trimmed and cut at `BOUNCE_TEXT_MAX`. */
export function cleanBounceText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = stripRemoved(value).trim();
  if (text.length > BOUNCE_TEXT_MAX) {
    text = text.slice(0, BOUNCE_TEXT_MAX);
    // Do not end on the first half of a surrogate pair.
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text === "" ? undefined : text;
}

/**
 * The bounce detail of one event, or `undefined` when no part is present and valid. The
 * SMTP code must be an integer from 200 to 599. The enhanced code must have the form
 * `class.subject.detail`, with a class of 2, 4, or 5.
 */
export function bounceDetail(raw: RawBounceDetail): BounceDetail | undefined {
  const detail: BounceDetail = {};
  const text = cleanBounceText(raw.text);
  if (text !== undefined) detail.text = text;
  const smtp = raw.smtpCode;
  if (typeof smtp === "number" && Number.isInteger(smtp) && smtp >= 200 && smtp <= 599) {
    detail.smtpCode = smtp;
  }
  const enhanced = raw.enhancedCode;
  if (typeof enhanced === "string" && ENHANCED_CODE.test(enhanced)) {
    detail.enhancedCode = enhanced;
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}
