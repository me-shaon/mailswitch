// AWS Signature Version 4 on Web Crypto. It replaces the aws4fetch dependency.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
//
// The signer returns the headers to send. It never returns or keeps the canonical
// request, the string to sign, or the signing key, so no result or log can hold them.

import { bytesToHex, utf8 } from "./encoding";

/** The credentials of one AWS identity. */
export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** The session token of temporary credentials. */
  sessionToken?: string;
}

/** One request to sign. */
export interface SigV4Request {
  method: string;
  url: string;
  /** Headers to sign and send. `host` and `x-amz-date` are added. */
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
}

/** The scope of a signature. */
export interface SigV4Scope {
  region: string;
  service: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

/** RFC 3986 percent-encoding, as SigV4 needs it: only unreserved characters stay. */
export function uriEncode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `YYYYMMDDTHHMMSSZ` for a Unix time in milliseconds. */
export function amzDate(now: number): string {
  return new Date(now).toISOString().replace(/[-:]|\.\d+/g, "");
}

function canonicalPath(url: URL): string {
  // `URL` already encoded the path once. SigV4 for every service except S3 encodes each
  // segment again.
  return url.pathname.split("/").map(uriEncode).join("/");
}

function canonicalQuery(url: URL): string {
  // NUL sorts before every encoded character, so this sorts by key, then by value.
  const pairs: string[] = [];
  for (const [key, value] of url.searchParams) pairs.push(`${uriEncode(key)}\0${uriEncode(value)}`);
  return pairs.sort().join("&").replaceAll("\0", "=");
}

async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, utf8(data)));
}

/** The lowercase, sorted, trimmed headers that a signature covers. */
function signedHeaderList(
  url: URL,
  headers: Readonly<Record<string, string>>,
  date: string,
  sessionToken: string | undefined,
): [string, string][] {
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    map.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  }
  map.set("host", url.host);
  map.set("x-amz-date", date);
  if (sessionToken) map.set("x-amz-security-token", sessionToken);
  // Names are unique, so the order never ties.
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * The canonical request. Exported for tests only: the adapter never puts it in a result.
 * `now` is the signing time in Unix milliseconds.
 */
export async function canonicalRequest(
  request: SigV4Request,
  now: number,
  sessionToken?: string,
): Promise<{ text: string; signedHeaders: string; headers: [string, string][] }> {
  const url = new URL(request.url);
  const headers = signedHeaderList(url, request.headers ?? {}, amzDate(now), sessionToken);
  const signedHeaders = headers.map(([name]) => name).join(";");
  const text = [
    request.method.toUpperCase(),
    canonicalPath(url),
    canonicalQuery(url),
    `${headers.map(([name, value]) => `${name}:${value}`).join("\n")}\n`,
    signedHeaders,
    await sha256(request.body ?? ""),
  ].join("\n");
  return { text, signedHeaders, headers };
}

/** The derived signing key. Exported for tests only. */
export async function signingKey(
  secretAccessKey: string,
  day: string,
  scope: SigV4Scope,
): Promise<Uint8Array<ArrayBuffer>> {
  const date = await hmac(utf8(`AWS4${secretAccessKey}`), day);
  const region = await hmac(date, scope.region);
  const service = await hmac(region, scope.service);
  return hmac(service, "aws4_request");
}

const MAX_CACHED_KEYS = 16;
// Signing keys by day, scope, and a SHA-256 of the secret, so no raw secret is a map key.
const keyCache: Map<string, Promise<CryptoKey>> = new Map();

async function cachedSigningKey(
  secretAccessKey: string,
  day: string,
  scope: SigV4Scope,
): Promise<CryptoKey> {
  const id = `${day}/${scope.region}/${scope.service}/${await sha256(secretAccessKey)}`;
  const cached = keyCache.get(id);
  if (cached) return cached;
  const pending = signingKey(secretAccessKey, day, scope).then((raw) =>
    crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  );
  if (keyCache.size >= MAX_CACHED_KEYS) keyCache.clear();
  keyCache.set(id, pending);
  pending.catch(() => keyCache.delete(id));
  return pending;
}

/**
 * Signs a request. Returns the headers to send: the given headers, `x-amz-date`, the
 * session token when there is one, and `authorization`. `host` is signed but not
 * returned, because fetch sets it.
 */
export async function signRequest(
  request: SigV4Request,
  credentials: SigV4Credentials,
  scope: SigV4Scope,
  now: number,
): Promise<Record<string, string>> {
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const { text, signedHeaders, headers } = await canonicalRequest(
    request,
    now,
    credentials.sessionToken,
  );
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = [ALGORITHM, date, credentialScope, await sha256(text)].join("\n");
  const key = await cachedSigningKey(credentials.secretAccessKey, day, scope);
  const signature = bytesToHex(await crypto.subtle.sign("HMAC", key, utf8(stringToSign)));
  const out: Record<string, string> = {};
  for (const [name, value] of headers) if (name !== "host") out[name] = value;
  out.authorization = `${ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
