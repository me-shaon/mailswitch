import type { Address, AddressInput } from "../core/types";

// Strict parsing of one mailbox. A value that could hold more than one address is refused,
// so a caller cannot add recipients through a single field.

/**
 * True for a character code that is never allowed in a header-bound field: C0 controls
 * except TAB (this includes CR, LF, and NUL), DEL, NEL (U+0085), and the Unicode line and
 * paragraph separators (U+2028, U+2029).
 */
export function isForbiddenCharCode(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09) ||
    code === 0x7f ||
    code === 0x85 ||
    code === 0x2028 ||
    code === 0x2029
  );
}

/** True when the text holds a character that could break a header line. */
export function hasForbiddenChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isForbiddenCharCode(text.charCodeAt(i))) return true;
  }
  return false;
}

const MAX_EMAIL_LENGTH = 254;
// The local part and the domain cannot hold whitespace, separators, or quoting characters.
const EMAIL_PART = /^[^\s@<>()[\]\\,;:"]+$/;

/** True for one plain `local@domain` address with no display name. */
export function isEmail(email: string): boolean {
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;
  if (hasForbiddenChars(email)) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!EMAIL_PART.test(local) || !EMAIL_PART.test(domain)) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return domain.split(".").every((label) => label.length > 0 && !/^-|-$/.test(label));
}

const MAILBOX = /^(.*?)\s*<([^<>]*)>$/;

/**
 * Parses one address. Returns null when the value is not exactly one valid address.
 * A string can be a bare email or `Name <email>`. The display name may be in double quotes.
 */
export function parseAddress(input: AddressInput): Address | null {
  if (typeof input === "string") return parseMailbox(input);
  if (typeof input !== "object" || input === null) return null;
  const { email, name } = input;
  if (typeof email !== "string" || !isEmail(email)) return null;
  if (name === undefined) return { email };
  if (typeof name !== "string" || hasForbiddenChars(name)) return null;
  return name.trim() === "" ? { email } : { email, name };
}

function parseMailbox(text: string): Address | null {
  if (hasForbiddenChars(text)) return null;
  const value = text.trim();
  const match = MAILBOX.exec(value);
  if (!match) return isEmail(value) ? { email: value } : null;
  const email = (match[2] ?? "").trim();
  if (!isEmail(email)) return null;
  let name = (match[1] ?? "").trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  } else if (/[<>"]/.test(name)) {
    return null;
  }
  return name === "" ? { email } : { email, name };
}

/**
 * Parses an address that `validateMessage` has already checked, as `{ email, name? }`.
 * The `name` key is present only for a non-empty name, because `parseAddress` sets no
 * other. The `{ email: "" }` fallback is never reached for a checked address.
 */
export function addressObject(input: AddressInput): Address {
  return parseAddress(input) ?? { email: "" };
}

// Display names with only these characters need no quoting (RFC 5322 atext plus space).
const PLAIN_NAME = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/;

/**
 * Formats an address for a header, for example `"Ana, Acme" <ana@example.com>`.
 * A name with non-ASCII characters is returned as is: the caller encodes it for its transport.
 */
export function formatAddress(address: Address): string {
  if (!address.name) return address.email;
  const name = address.name;
  // Non-ASCII characters count as plain here. Only ASCII specials force quotes.
  if (PLAIN_NAME.test(name.replace(/[^\x20-\x7e]/g, "a"))) return `${name} <${address.email}>`;
  return `"${name.replace(/(["\\])/g, "\\$1")}" <${address.email}>`;
}
