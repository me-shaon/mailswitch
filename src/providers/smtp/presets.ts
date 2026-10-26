// The preset logic of the SMTP adapter. The preset data is in meta.ts, because the
// catalog imports only meta files. This file turns credentials, a preset, and adapter
// options into the settings of the client.
//
// Precedence, from high to low: the fixed values of the preset, the credentials, the
// adapter options, and the defaults of this file.

import type { ProviderPreset } from "../../core/meta";
import { HOST_NAME, type SmtpSecurity, type SmtpSettings } from "./client";
import { SMTP_PRESETS, type SmtpPresetId } from "./meta";

/** The default port of each security mode. Mailpit and MailCrab listen on 1025. */
const DEFAULT_PORTS: Readonly<Record<SmtpSecurity, number>> = { tls: 465, starttls: 587, none: 25 };
const LOCAL_PRESETS: ReadonlySet<string> = new Set(["mailpit", "mailcrab"]);
const GOOGLE_PRESETS: ReadonlySet<string> = new Set(["gmail", "google-workspace"]);

/** Returns a preset by id, or undefined. */
export function smtpPreset(id: string | undefined): ProviderPreset | undefined {
  return SMTP_PRESETS.find((preset) => preset.id === id);
}

/** Connection values that the adapter options can give. The credentials take precedence. */
export interface SmtpConnectionOptions {
  /** A preset id. Its fixed values apply. */
  preset?: SmtpPresetId;
  host?: string;
  port?: number;
  /** `starttls` (the default), `tls` for implicit TLS, or `none` for plain text. */
  security?: SmtpSecurity;
  /** Allows a plain-text connection. `security: "none"` needs it. Defaults to false. */
  insecure?: boolean;
  username?: string;
  password?: string;
}

/** The outcome of `resolveSmtpSettings`. A failure message never holds a value. */
export type SmtpSettingsResult =
  | { ok: true; settings: SmtpSettings; preset: string }
  | { ok: false; message: string };

/** Resolves the client settings. It never throws. */
export function resolveSmtpSettings(
  credentials: Readonly<Record<string, string>>,
  options: SmtpConnectionOptions = {},
): SmtpSettingsResult {
  const presetId = credentials.preset || options.preset || "custom";
  const preset = smtpPreset(presetId);
  if (!preset) return { ok: false, message: "The SMTP preset is not known." };
  const value = (name: string): string => {
    const given =
      preset.fixed[name] ?? (credentials[name] || (options as Record<string, unknown>)[name]);
    return given === undefined ? "" : String(given).trim();
  };

  const host = value("host").toLowerCase();
  if (!HOST_NAME.test(host)) {
    return { ok: false, message: "The SMTP host is missing or not valid." };
  }
  const security = (value("security") || "starttls") as SmtpSecurity;
  if (!Object.hasOwn(DEFAULT_PORTS, security)) {
    return { ok: false, message: "The SMTP encryption must be starttls, tls, or none." };
  }
  const portText = value("port");
  const fallback = LOCAL_PRESETS.has(presetId) ? 1025 : DEFAULT_PORTS[security];
  const port = portText === "" ? fallback : Number(portText);
  if (!/^\d{0,5}$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, message: "The SMTP port is not valid." };
  }
  const insecure = value("insecure") === "true";
  const username = value("username");
  // Google shows app passwords in groups of four, with spaces. SMTP needs them without.
  let password = preset.fixed.password ?? (credentials.password || options.password || "");
  if (GOOGLE_PRESETS.has(presetId)) password = password.replace(/\s+/g, "");
  return {
    ok: true,
    preset: presetId,
    settings: { host, port, security, insecure, username, password },
  };
}
