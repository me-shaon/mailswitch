// The precedence of one credential field that an adapter option can also set. Preset
// fixed values come first, so the caller applies them before this helper.

/**
 * Returns a credential the caller gave, then the adapter option, then the credential
 * value, which is then the field default. `defaulted` names the fields that got a
 * default. Without it, every credential counts as given.
 */
export function credentialOrOption(
  credentials: Readonly<Record<string, string>>,
  defaulted: ReadonlySet<string> | undefined,
  name: string,
  option: unknown,
): string {
  const value = credentials[name] ?? "";
  if (value !== "" && !defaulted?.has(name)) return value;
  return option === undefined || option === "" ? value : String(option);
}
