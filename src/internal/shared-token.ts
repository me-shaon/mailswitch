// A shared webhook token check, for providers that sign nothing and send a secret in
// the Authorization header instead: HTTP Basic auth with a username, or a Bearer token.
//
// The token covers no timestamp and no body. A replayed request passes the check, so the
// webhook router must dedupe on the event key. A changed body also passes the check: the
// token only proves that the sender knows the secret. Use HTTPS for the webhook URL.

import type { WebhookVerifyResult } from "../core/adapter";
import { base64ToBytes, bytesToBase64 } from "./encoding";
import { timingSafeEqualText } from "./webhook-bytes";

/** The shortest secret, in characters, when it is not hex only. 22 base64url characters hold 128 bits. */
export const SHARED_TOKEN_MIN_LENGTH = 22;
/** The shortest secret that holds only hex characters. 32 hex characters hold 128 bits. */
export const SHARED_TOKEN_MIN_HEX_LENGTH = 32;

/** An Authorization scheme that a provider sends: Basic with a fixed username, or Bearer. */
export type SharedTokenScheme = { type: "basic"; username: string } | { type: "bearer" };

/** The options of `sharedTokenVerifier`. */
export interface SharedTokenOptions {
  /** The provider name for error messages, for example `Mailjet`. */
  name: string;
  /** The schemes that the provider can send. A header with any other scheme fails. */
  schemes: readonly SharedTokenScheme[];
  /**
   * The secret before a rotation. While it is set, a request with this secret also
   * passes. Remove it when the provider sends the new secret.
   */
  previousSecret?: string;
}

const HEX_ONLY = /^[0-9a-fA-F]+$/;
// One space between the scheme and the value. `Headers` trims the ends of a value.
const AUTHORIZATION = /^([A-Za-z]+) (\S+)$/;
const USERNAME = /^[\x21-\x39\x3b-\x7e]{1,128}$/;

/**
 * Checks that a webhook secret holds at least 128 bits of entropy, as far as its length
 * shows: 22 characters, or 32 characters for a hex-only secret. A long secret of one
 * repeated character also passes, so make the secret with `generateSharedTokenSecret`.
 *
 * @throws TypeError for a secret that is too short. The message never holds the secret.
 */
export function checkSharedTokenSecret(secret: string, name: string): void {
  if (
    typeof secret !== "string" ||
    secret.length < (HEX_ONLY.test(secret) ? SHARED_TOKEN_MIN_HEX_LENGTH : SHARED_TOKEN_MIN_LENGTH)
  ) {
    throw new TypeError(`The ${name} webhook secret is too short: it needs 128 bits.`);
  }
}

/** Makes a webhook secret of 32 random bytes, as 43 base64url characters (256 bits). */
export function generateSharedTokenSecret(): string {
  const text = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  return text.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The `user:password` text of a Basic value, split at the first colon, or null. */
function basicPair(value: string): [string, string] | null {
  const bytes = base64ToBytes(value);
  if (bytes === null) return null;
  let pair: string;
  try {
    pair = fatal.decode(bytes);
  } catch {
    return null;
  }
  const cut = pair.indexOf(":");
  return cut < 0 ? null : [pair.slice(0, cut), pair.slice(cut + 1)];
}

/**
 * Makes a check of the Authorization header against the webhook secret. It parses the
 * scheme without regard to case. It compares the SHA-256 digests of the username and of
 * the secret, each in constant time. It does not read the body.
 *
 * The check gives `bad_signature` for an empty secret, a missing header, another scheme,
 * or a wrong username or secret. It gives `malformed` for a header that it cannot parse.
 *
 * @throws TypeError for no scheme, an invalid username, or a weak `previousSecret`. The
 * check itself throws TypeError for a weak secret, because that is a setup error.
 */
export function sharedTokenVerifier(
  options: SharedTokenOptions,
): (headers: Headers, secret: string) => Promise<WebhookVerifyResult> {
  const { name, schemes, previousSecret: previous } = options;
  if (schemes.length === 0) throw new TypeError(`The ${name} webhook check needs a scheme.`);
  for (const scheme of schemes) {
    if (scheme.type === "basic" && !USERNAME.test(scheme.username)) {
      throw new TypeError(`The ${name} webhook username is empty or has a colon or a space.`);
    }
  }
  if (previous !== undefined) checkSharedTokenSecret(previous, name);

  return async (headers, secret) => {
    if (secret === "") return { ok: false, reason: "bad_signature" };
    checkSharedTokenSecret(secret, name);
    const header = headers.get("authorization");
    if (header === null) return { ok: false, reason: "bad_signature" };
    const match = AUTHORIZATION.exec(header);
    if (!match) return { ok: false, reason: "malformed" };
    const type = (match[1] as string).toLowerCase();
    const scheme = schemes.find((item) => item.type === type);
    if (scheme === undefined) return { ok: false, reason: "bad_signature" };
    let user: string | undefined;
    let token = match[2] as string;
    if (scheme.type === "basic") {
      const pair = basicPair(token);
      if (pair === null) return { ok: false, reason: "malformed" };
      [user, token] = pair;
    }
    // All three comparisons run before the result is combined.
    const [userOk, tokenOk, previousOk] = await Promise.all([
      scheme.type === "basic" ? timingSafeEqualText(user as string, scheme.username) : true,
      timingSafeEqualText(token, secret),
      // With no previous secret, compare against the secret again, so the number of
      // comparisons does not show whether a previous secret is set.
      timingSafeEqualText(token, previous ?? secret),
    ]);
    return userOk && (tokenOk || previousOk)
      ? { ok: true }
      : { ok: false, reason: "bad_signature" };
  };
}
