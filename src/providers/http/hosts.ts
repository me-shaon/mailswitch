// The host rules of the generic HTTP provider. They apply to every request that the
// provider makes, send and verify alike. Internal to the provider. Error text names the
// rule, never the URL or a value.
//
// - The URL parses with `URL`, and its protocol is `https:`.
// - The URL has no userinfo, and no character at or below U+0020 or U+007F.
// - The host is not an IPv6 literal, and not an IPv4 address in any form: dotted,
//   decimal, hex, or octal.
// - The host is lowercased, and one trailing dot is removed. `localhost`, `*.localhost`,
//   `*.local`, `*.internal`, and a name with one label are refused.
// - A port other than 443 needs an `allowHosts` entry that names it (`host:port`).
// - When `allowHosts` is set, the host must match one entry exactly.
//
// The loopback exception of `parseBaseUrl` does not apply here. Workers cannot pin DNS,
// so the allowlist is the main control against a request to an internal host.

/** A checked allowlist: bare hosts, and `host:port` entries. */
export interface AllowHosts {
  /** Hosts that match on the default port, 443. */
  hosts: ReadonlySet<string>;
  /** `host:port` entries, with a port other than 443. */
  hostPorts: ReadonlySet<string>;
}

/** Why a URL breaks the host rules. */
export type HostRuleBreak =
  | "not_https"
  | "userinfo"
  | "query"
  | "ip_literal"
  | "local_name"
  | "port"
  | "not_allowed";

const LOCAL_SUFFIXES: readonly string[] = [".localhost", ".local", ".internal"];

/** True when a label is a number in any IPv4 form: decimal, hex (`0x`), or octal. */
function isNumberLabel(label: string): boolean {
  return /^(0x[0-9a-f]*|\d+)$/i.test(label);
}

/**
 * True when a host name is an IPv4 address in any form. The WHATWG URL parser reads a
 * host whose last label is a number as IPv4, for example `2130706433`, `0x7f000001`,
 * `0177.0.0.1`, and `127.1`. So any host that ends in a number label is refused.
 */
export function isIpv4Like(host: string): boolean {
  const labels = host.split(".");
  if (labels.length > 1 && labels[labels.length - 1] === "") labels.pop();
  const last = labels[labels.length - 1] ?? "";
  return last !== "" && isNumberLabel(last);
}

/** Lowercases a host name and removes one trailing dot. */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/** The rule that a normalized host name breaks, or null. */
function hostBreak(host: string): HostRuleBreak | null {
  if (host === "" || host.startsWith("[") || host.includes(":")) return "ip_literal";
  if (isIpv4Like(host)) return "ip_literal";
  if (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return "local_name";
  }
  // A name with one label resolves only on a local network. An empty label is not a
  // public name either.
  if (!host.includes(".") || host.split(".").includes("")) return "local_name";
  return null;
}

/** The authority part of a URL string as written: the text between `//` and the path. */
function rawAuthority(text: string): string {
  const rest = text.replace(/^[A-Za-z][A-Za-z0-9+.-]*:[/\\]*/, "");
  return rest.split(/[/\\?#]/, 1)[0] ?? "";
}

/** The host of a raw authority, without userinfo and without a port. */
function rawHost(authority: string): string {
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  if (host.startsWith("[")) return host;
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/** True when the text holds a space, a C0 control character, or DEL. */
function hasSpaceOrControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Options of `checkRequestUrl`. */
export interface UrlRuleOptions {
  /** The checked allowlist. Undefined allows any host that passes the other rules. */
  allowHosts?: AllowHosts | undefined;
  /** Refuse a query string and a fragment. The JSON config API sets it. */
  refuseQuery?: boolean;
}

/**
 * Checks one request URL against the host rules. Returns the parsed URL, or the rule
 * that the URL breaks. It never throws.
 */
export function checkRequestUrl(
  value: unknown,
  options: UrlRuleOptions = {},
): { ok: true; url: URL } | { ok: false; rule: HostRuleBreak } {
  if (typeof value !== "string") return { ok: false, rule: "not_https" };
  // The URL parser removes tabs and newlines in silence. Refuse them, and any other
  // control character or space, before the parse.
  if (hasSpaceOrControl(value)) return { ok: false, rule: "not_https" };
  const url = URL.parse(value);
  if (url === null || url.protocol !== "https:") return { ok: false, rule: "not_https" };
  const authority = rawAuthority(value);
  if (authority.includes("@") || url.username !== "" || url.password !== "") {
    return { ok: false, rule: "userinfo" };
  }
  if (
    options.refuseQuery === true &&
    (url.search !== "" || url.hash !== "" || /[?#]/.test(value))
  ) {
    return { ok: false, rule: "query" };
  }
  const raw = normalizeHost(rawHost(authority));
  const rawRule = hostBreak(raw);
  if (rawRule !== null) return { ok: false, rule: rawRule };
  const host = normalizeHost(url.hostname);
  const parsedRule = hostBreak(host);
  if (parsedRule !== null) return { ok: false, rule: parsedRule };
  const allow = options.allowHosts;
  if (url.port !== "" && url.port !== "443") {
    if (allow === undefined || !allow.hostPorts.has(`${host}:${url.port}`)) {
      return { ok: false, rule: "port" };
    }
    return { ok: true, url };
  }
  if (allow !== undefined && !allow.hosts.has(host)) return { ok: false, rule: "not_allowed" };
  return { ok: true, url };
}

/** A short sentence for a broken rule. It names the field, never the value. */
export function describeBreak(field: string, rule: HostRuleBreak): string {
  switch (rule) {
    case "not_https":
      return `${field} must be an https URL.`;
    case "userinfo":
      return `${field} must not hold a user name or a password.`;
    case "query":
      return `${field} must not hold a query string or a fragment.`;
    case "ip_literal":
      return `${field} must name a host, not an IP address.`;
    case "local_name":
      return `${field} must name a public host, not a local name.`;
    case "port":
      return `${field} uses a port that allowHosts does not name.`;
    case "not_allowed":
      return `${field} names a host that is not in allowHosts.`;
  }
}

const ENTRY = /^([a-z0-9.-]+?)(?::(\d{1,5}))?$/;

/**
 * Checks and normalizes an `allowHosts` list. An entry is a host name, or `host:port`.
 * Each host follows the host rules.
 *
 * @param label The option name in the error, for example `"httpProvider: allowHosts"`.
 * @throws TypeError for a list that is not an array, an empty list, a `*` entry, or an
 * entry that breaks a rule. The error never holds the entry.
 */
export function parseAllowHosts(value: unknown, label: string): AllowHosts {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of host names.`);
  if (value.length === 0) throw new TypeError(`${label} must name at least one host.`);
  const hosts = new Set<string>();
  const hostPorts = new Set<string>();
  value.forEach((entry: unknown, index) => {
    const where = `${label}[${index}]`;
    if (typeof entry !== "string") throw new TypeError(`${where} must be a string.`);
    if (entry.includes("*")) throw new TypeError(`${where} must not hold a wildcard.`);
    const match = ENTRY.exec(entry.trim().toLowerCase());
    if (!match) throw new TypeError(`${where} must be a host name or host:port.`);
    const host = normalizeHost(match[1] as string);
    const rule = hostBreak(host);
    if (rule !== null) throw new TypeError(describeBreak(where, rule));
    const port = match[2];
    if (port === undefined || Number(port) === 443) {
      hosts.add(host);
      return;
    }
    const number = Number(port);
    if (number < 1 || number > 65_535) throw new TypeError(`${where} has a port out of range.`);
    hostPorts.add(`${host}:${number}`);
  });
  return { hosts, hostPorts };
}
