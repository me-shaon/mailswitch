// Credential parsing. It checks user input against the credential fields of a provider,
// with no adapter code. Errors name the field and the rule. They never hold the value.

import type { ProviderMeta } from "./meta";

/** Why a credential value was refused. */
export type CredentialErrorCode = "required" | "pattern" | "option" | "type";

/** One refused credential field. It never holds the submitted value. */
export interface CredentialError {
  field: string;
  code: CredentialErrorCode;
}

/** What `parseCredentials` returns. */
export type CredentialParseResult =
  | { ok: true; values: Readonly<Record<string, string>> }
  | { ok: false; errors: readonly CredentialError[] };

/**
 * Checks credentials against the fields of a provider. It applies preset fixed values
 * first, then the defaults of empty optional fields. Keys that no field declares are
 * dropped. Values are trimmed. An unknown preset id is a programmer error and throws.
 */
export function parseCredentials(
  meta: ProviderMeta,
  input: Readonly<Record<string, unknown>>,
  presetId?: string,
): CredentialParseResult {
  const result = checkCredentials(meta, input, presetId);
  return result.ok ? { ok: true, values: result.values } : result;
}

/** What `checkCredentials` returns: `parseCredentials` plus the defaulted field names. */
export type CredentialCheckResult =
  | { ok: true; values: Readonly<Record<string, string>>; defaulted: ReadonlySet<string> }
  | { ok: false; errors: readonly CredentialError[] };

/**
 * The checks of `parseCredentials`. It also returns the names of the fields whose value
 * is the field default, because the caller left them empty. Internal: `createMailer`
 * puts the set in `SendContext.defaultedFields`.
 */
export function checkCredentials(
  meta: ProviderMeta,
  input: Readonly<Record<string, unknown>>,
  presetId?: string,
): CredentialCheckResult {
  const defaulted = new Set<string>();
  const errors: CredentialError[] = [];
  let fixed: Readonly<Record<string, string>> = {};
  if (presetId !== undefined) {
    const preset = meta.presets?.find((item) => item.id === presetId);
    if (!preset) throw new RangeError(`Provider "${meta.id}" has no preset "${presetId}".`);
    fixed = preset.fixed;
  }
  const values: Record<string, string> = {};
  for (const field of meta.credentialFields) {
    const raw = Object.hasOwn(fixed, field.name) ? fixed[field.name] : input[field.name];
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      errors.push({ field: field.name, code: "type" });
      continue;
    }
    const given = typeof raw === "string" ? raw.trim() : "";
    const value = given === "" ? (field.defaultValue ?? "") : given;
    if (value === "") {
      if (field.required) errors.push({ field: field.name, code: "required" });
      continue;
    }
    if (field.options && !field.options.some((option) => option.value === value)) {
      errors.push({ field: field.name, code: "option" });
      continue;
    }
    if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) {
      errors.push({ field: field.name, code: "pattern" });
      continue;
    }
    values[field.name] = value;
    if (given === "") defaulted.add(field.name);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values, defaulted };
}
