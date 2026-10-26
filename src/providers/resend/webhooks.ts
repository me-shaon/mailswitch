// Resend webhooks. Resend signs them with Svix.
// https://docs.svix.com/receiving/verifying-payloads/how-manual
// https://resend.com/docs/dashboard/webhooks/event-types
//
// The signed content is `${id}.${timestamp}.${body}`, signed with HMAC-SHA256 under the
// base64 key after the `whsec_` prefix. The signature header holds space-separated
// `v1,<base64>` entries. During a secret rotation it holds more than one.

import type { WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import type { NormalizedEvent, NormalizedEventType } from "../../core/events";
import { base64ToBytes, utf8 } from "../../internal/encoding";
import { hmacVerify } from "../../internal/hmac";
import { decodeJsonBytes } from "../../internal/webhook-bytes";

/** The Svix timestamp window, in both directions, in milliseconds. */
export const SVIX_TOLERANCE_MS: number = 5 * 60 * 1000;
/** The most signature entries that the verifier reads from one header. */
const MAX_SIGNATURES = 10;
const SIGNATURE_BYTES = 32;
const PROVIDER = "resend";

/** A verifier bound to one decoded signing secret. */
export interface SvixVerifier {
  /** Checks the Svix headers and the signature over the raw body. It never throws. */
  verify(headers: Headers, body: Uint8Array, now: number): Promise<WebhookVerifyResult>;
}

function header(headers: Headers, name: string): string | null {
  return headers.get(`svix-${name}`) ?? headers.get(`webhook-${name}`);
}

/** The bytes that Svix signs: `${id}.${timestamp}.` followed by the raw body. */
export function svixSignedPayload(id: string, timestamp: string, body: Uint8Array): Uint8Array {
  const prefix = utf8(`${id}.${timestamp}.`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

/**
 * Decodes a Svix signing secret strictly and returns a verifier for it. The `whsec_`
 * prefix is optional.
 *
 * @throws TypeError when the secret is not valid base64 or decodes to no bytes. The
 * message never holds the secret.
 */
export function svixVerifier(secret: string): SvixVerifier {
  const text = typeof secret === "string" ? secret.replace(/^whsec_/, "") : "";
  const key = base64ToBytes(text);
  if (!key || key.length === 0) {
    throw new TypeError("The Resend webhook secret is not a valid whsec_ base64 secret.");
  }
  return {
    async verify(headers, body, now) {
      const id = header(headers, "id");
      const timestamp = header(headers, "timestamp");
      const signature = header(headers, "signature");
      if (!id || !timestamp || !signature) return { ok: false, reason: "bad_signature" };
      if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "malformed" };
      // A replayed request carries its old timestamp, and the signature covers it.
      if (Math.abs(now - Number(timestamp) * 1000) > SVIX_TOLERANCE_MS) {
        return { ok: false, reason: "stale" };
      }
      const signed = svixSignedPayload(id, timestamp, body);
      const entries = signature.split(" ").filter((entry) => entry !== "");
      let valid = false;
      for (const entry of entries.slice(0, MAX_SIGNATURES)) {
        const cut = entry.indexOf(",");
        if (cut < 0 || entry.slice(0, cut) !== "v1") continue;
        const bytes = base64ToBytes(entry.slice(cut + 1));
        if (!bytes || bytes.length !== SIGNATURE_BYTES) continue;
        if (await hmacVerify(key, bytes, signed)) {
          valid = true;
          break;
        }
      }
      if (!valid) return { ok: false, reason: "bad_signature" };
      // The signature covers the raw bytes. Only a verified body is decoded.
      return decodeJsonBytes(body) === undefined
        ? { ok: false, reason: "malformed" }
        : { ok: true };
    },
  };
}

// The last verifier, so a steady endpoint decodes its secret once.
let cached: { secret: string; verifier: SvixVerifier } | null = null;

/**
 * The `webhooks.verify` method of the Resend adapter. An empty secret is refused as
 * `bad_signature`.
 *
 * @throws TypeError when the secret is set but is not a valid `whsec_` secret. That is a
 * setup error, not a bad request.
 */
export function verifyResendWebhook(input: WebhookVerifyInput): Promise<WebhookVerifyResult> {
  if (input.secret === "") return Promise.resolve({ ok: false, reason: "bad_signature" });
  if (cached?.secret !== input.secret) {
    cached = { secret: input.secret, verifier: svixVerifier(input.secret) };
  }
  return cached.verifier.verify(input.headers, input.body, input.now);
}

interface ResendEvent {
  type?: unknown;
  created_at?: unknown;
  data?: {
    email_id?: unknown;
    to?: unknown;
    bounce?: { type?: unknown };
  };
}

const TYPES: Readonly<Record<string, NormalizedEventType>> = {
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivered": "delivered",
};

/**
 * The `webhooks.parse` method of the Resend adapter. One body holds one event. Its key
 * is the `svix-id` header, which stays the same across retries of one delivery.
 *
 * - `email.bounced` with bounce type `Permanent` is a hard bounce. Other types are soft.
 * - `recipient` is set only when the email had exactly one `to` address.
 * - Event types that mailswitch does not map give `unknown` with the raw type.
 */
export function parseResendEvents(body: Uint8Array, headers: Headers): NormalizedEvent[] {
  const event = decodeJsonBytes(body) as ResendEvent | undefined;
  if (event === undefined) return [];
  if (typeof event !== "object" || event === null || typeof event.type !== "string") return [];
  const rawType = event.type;
  const data = typeof event.data === "object" && event.data !== null ? event.data : {};
  const messageId = typeof data.email_id === "string" ? data.email_id : undefined;
  const createdAt = typeof event.created_at === "string" ? event.created_at : "";
  const eventKey = header(headers, "id") || `${messageId ?? ""}:${rawType}:${createdAt}`;
  const type = TYPES[rawType] ?? "unknown";
  const out: NormalizedEvent = { type, provider: PROVIDER, eventKey, rawType };
  if (type === "bounced") out.bounce = data.bounce?.type === "Permanent" ? "hard" : "soft";
  const to = typeof data.to === "string" ? [data.to] : Array.isArray(data.to) ? data.to : [];
  if (to.length === 1 && typeof to[0] === "string") out.recipient = to[0];
  if (messageId !== undefined) out.providerMessageId = messageId;
  const at = Date.parse(createdAt);
  if (Number.isFinite(at)) out.occurredAt = at;
  return [out];
}
