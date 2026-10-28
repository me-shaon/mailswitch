// Provider meta: the pure data that describes a provider. The catalog and the settings
// form read it without loading any adapter code. Each provider keeps it in its meta.ts.

import type { StatusMap } from "./classify";
import type { Capabilities } from "./types";

/** One input of the credential form. */
export interface CredentialField {
  /** The key of the value in the credentials object. */
  name: string;
  label: string;
  /** The form hides the value, and an API never returns it. */
  secret: boolean;
  required: boolean;
  hint?: string;
  placeholder?: string;
  /** The value of an optional field that the user leaves empty. */
  defaultValue?: string;
  /** The source of a regular expression that a value must match. */
  pattern?: string;
  /** The allowed values, for a field that the form shows as a choice. Give `defaultValue` too. */
  options?: readonly { value: string; label: string }[];
}

/** A preset of the credential form, for a provider that serves many services. */
export interface ProviderPreset {
  id: string;
  name: string;
  /** Fixed values of credential fields, by field name. The form shows them read-only. */
  fixed: Readonly<Record<string, string>>;
  /** Labels and hints that replace the field's own for this preset, by field name. */
  fieldHints?: Readonly<Record<string, { label?: string; hint?: string; placeholder?: string }>>;
  /** The default daily cap of this preset. The user can change it. */
  defaultDailyCap?: number;
}

/** The webhook secret, as a settings form shows it. It is not a credential field. */
export interface WebhookSecretMeta {
  label: string;
  /**
   * Where the value comes from.
   * - `provider`: copy it from the provider, for example a signing secret or a public key.
   * - `generated`: make it with the generate helper of the adapter, then give it to the provider.
   */
  source: "provider" | "generated";
  hint?: string;
  placeholder?: string;
  /** The source of a regular expression that a value must match. */
  pattern?: string;
}

/**
 * The provider tier.
 * - 1: send, attachments, verify, webhooks where offered, and a researched status map.
 * - 2: send, attachments, and verify. Every 5xx is `unknown`.
 */
export type ProviderTier = 1 | 2;

/** The pure data of one provider. */
export interface ProviderMeta {
  /** A stable id, for example `resend`. */
  id: string;
  name: string;
  tier: ProviderTier;
  capabilities: Capabilities;
  credentialFields: readonly CredentialField[];
  presets?: readonly ProviderPreset[];
  /** The provider's own documentation. */
  docsUrl: string;
  /** Sourced overrides of the default status table. */
  statusMap: StatusMap;
  /** The adapter verifies and parses provider webhooks. */
  webhooks?: boolean;
  /** The webhook secret that `handleWebhook` takes. It needs `webhooks`. */
  webhookSecret?: WebhookSecretMeta;
  /**
   * The default daily cap of the provider. A preset `defaultDailyCap` takes precedence.
   * The built-in providers leave it out, because free-plan limits change often.
   */
  defaultDailyCap?: number;
  /** The provider accepts an idempotency key and drops a repeat. */
  nativeIdempotency: boolean;
  /**
   * How long the provider keeps an idempotency key, in milliseconds. Leave it out when the
   * window is at least as long as the store keeps a sent record. It needs `nativeIdempotency`.
   */
  nativeIdempotencyWindowMs?: number;
}

function fail(id: string, text: string): never {
  throw new TypeError(`Provider meta "${id}": ${text}`);
}

function checkPattern(id: string, pattern: string | undefined, where: string): void {
  if (pattern === undefined) return;
  try {
    new RegExp(pattern);
  } catch {
    fail(id, `the pattern of ${where} is not a valid regular expression.`);
  }
}

function checkCap(id: string, cap: number | undefined, where: string): void {
  if (cap !== undefined && !(Number.isSafeInteger(cap) && cap >= 1)) {
    fail(id, `the defaultDailyCap of ${where} must be a positive integer.`);
  }
}

function checkFields(id: string, fields: readonly CredentialField[]): Set<string> {
  const names = new Set<string>();
  for (const field of fields) {
    if (typeof field.name !== "string" || field.name === "") fail(id, "a field has no name.");
    if (names.has(field.name)) fail(id, `the field name "${field.name}" is used twice.`);
    names.add(field.name);
    checkPattern(id, field.pattern, `field "${field.name}"`);
    if (field.options !== undefined) {
      if (field.options.length === 0) fail(id, `field "${field.name}" has an empty options list.`);
      const def = field.defaultValue;
      if (def !== undefined && !field.options.some((option) => option.value === def)) {
        fail(id, `the default value of field "${field.name}" is not one of its options.`);
      }
    }
  }
  return names;
}

function checkPresets(id: string, presets: readonly ProviderPreset[], names: Set<string>): void {
  const ids = new Set<string>();
  for (const preset of presets) {
    if (typeof preset.id !== "string" || preset.id === "") fail(id, "a preset has no id.");
    if (ids.has(preset.id)) fail(id, `the preset id "${preset.id}" is used twice.`);
    ids.add(preset.id);
    checkCap(id, preset.defaultDailyCap, `preset "${preset.id}"`);
    for (const key of [...Object.keys(preset.fixed), ...Object.keys(preset.fieldHints ?? {})]) {
      if (!names.has(key)) fail(id, `preset "${preset.id}" names the unknown field "${key}".`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Checks and freezes provider meta. It throws for a programmer error: a missing id, name,
 * or docs URL, a tier that is not 1 or 2, a duplicate field or preset, an invalid pattern,
 * a tier 2 status map that maps a 5xx code to `not_sent`, a `nativeIdempotencyWindowMs`
 * that is not a positive integer or has no native idempotency, a `defaultDailyCap` that is
 * not a positive integer, or an invalid `webhookSecret` or one without `webhooks`.
 */
export function defineProviderMeta(meta: ProviderMeta): ProviderMeta {
  const id = typeof meta.id === "string" ? meta.id : "";
  if (id === "" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    fail(id, "the id must be lowercase letters, digits, and hyphens.");
  }
  if (typeof meta.name !== "string" || meta.name === "") fail(id, "the name is missing.");
  if (meta.tier !== 1 && meta.tier !== 2) fail(id, "the tier must be 1 or 2.");
  if (typeof meta.docsUrl !== "string" || !/^https?:\/\//.test(meta.docsUrl)) {
    fail(id, "the docsUrl must be an http or https URL.");
  }
  if (typeof meta.nativeIdempotency !== "boolean") fail(id, "nativeIdempotency must be a boolean.");
  if (meta.nativeIdempotency !== meta.capabilities.idempotency) {
    fail(id, "nativeIdempotency and capabilities.idempotency must agree.");
  }
  const windowMs = meta.nativeIdempotencyWindowMs;
  if (windowMs !== undefined && !(meta.nativeIdempotency && windowMs > 0 && windowMs % 1 === 0)) {
    fail(
      id,
      "nativeIdempotencyWindowMs must be a positive integer, and nativeIdempotency must be true.",
    );
  }
  const names = checkFields(id, meta.credentialFields);
  if (meta.presets !== undefined) checkPresets(id, meta.presets, names);
  checkCap(id, meta.defaultDailyCap, "the provider");
  const secret = meta.webhookSecret;
  if (secret !== undefined) {
    if (meta.webhooks !== true) fail(id, "webhookSecret needs webhooks to be true.");
    if (typeof secret.label !== "string" || secret.label === "") {
      fail(id, "the webhookSecret has no label.");
    }
    if (secret.source !== "provider" && secret.source !== "generated") {
      fail(id, 'the webhookSecret source must be "provider" or "generated".');
    }
    checkPattern(id, secret.pattern, "the webhookSecret");
  }
  if (meta.tier === 2) {
    for (const key of Object.keys(meta.statusMap)) {
      const code = Number(key);
      if (code >= 500 && meta.statusMap[code]?.status === "not_sent") {
        fail(id, `a tier 2 provider must keep ${code} as unknown.`);
      }
    }
  }
  return deepFreeze({ ...meta });
}
