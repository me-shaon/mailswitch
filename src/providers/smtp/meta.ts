// SMTP provider data. Pure data: the catalog imports this file without the adapter.
// The preset data lives here too, because the catalog shows the presets. The preset
// logic is in presets.ts.
//
// Daily caps of the presets, from the providers' own pages (checked 2026-10-26):
// - Gmail: 500 recipients per day for a personal account.
//   https://support.google.com/mail/answer/22839
// - Google Workspace: 2,000 messages per day per user.
//   https://support.google.com/a/answer/166852
// - Brevo: the free plan sends 300 emails per day.
//   https://www.brevo.com/pricing/
// Mailpit and MailCrab are local test servers. They have no cap and no TLS.
//   https://mailpit.axllent.org/docs/configuration/smtp/
//   https://github.com/tweedegolf/mailcrab

import { defineProviderMeta, type ProviderMeta, type ProviderPreset } from "../../core/meta";

/** The ids of the SMTP presets. */
export type SmtpPresetId =
  | "gmail"
  | "google-workspace"
  | "brevo"
  | "mailpit"
  | "mailcrab"
  | "custom";

/** The daily cap of the Gmail preset. */
export const GMAIL_DAILY_CAP = 500;
/** The daily cap of the Google Workspace preset. */
export const WORKSPACE_DAILY_CAP = 2_000;
/** The daily cap of the Brevo preset: the free plan. */
export const BREVO_FREE_DAILY_CAP = 300;

/** A STARTTLS preset on port 587. */
function relay(id: SmtpPresetId, name: string, host: string, cap: number): ProviderPreset {
  return {
    id,
    name,
    fixed: { preset: id, host, port: "587", security: "starttls" },
    defaultDailyCap: cap,
  };
}

/** A local test server: plain text, with `insecure` set. */
function local(id: SmtpPresetId, name: string): ProviderPreset {
  return { id, name, fixed: { preset: id, security: "none", insecure: "true" } };
}

const APP_PASSWORD = { password: { label: "App password" } };

/** The presets. Each one fixes the `preset` field, so the adapter knows which one it is. */
export const SMTP_PRESETS: readonly ProviderPreset[] = [
  { ...relay("gmail", "Gmail", "smtp.gmail.com", GMAIL_DAILY_CAP), fieldHints: APP_PASSWORD },
  {
    ...relay("google-workspace", "Google Workspace", "smtp.gmail.com", WORKSPACE_DAILY_CAP),
    fieldHints: APP_PASSWORD,
  },
  {
    ...relay("brevo", "Brevo", "smtp-relay.brevo.com", BREVO_FREE_DAILY_CAP),
    fieldHints: { password: { label: "SMTP key" } },
  },
  local("mailpit", "Mailpit"),
  local("mailcrab", "MailCrab"),
  { id: "custom", name: "Custom", fixed: { preset: "custom" } },
];

export const smtpMeta: ProviderMeta = defineProviderMeta({
  id: "smtp",
  name: "SMTP",
  tier: 1,
  capabilities: {
    attachments: true,
    // Each server sets its own limit, and it advertises it with the SIZE extension. The
    // adapter refuses a message above the advertised SIZE before MAIL FROM.
    maxMessageBytes: null,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    // SMTP has no idempotency key. The mailer store gives the only protection.
    idempotency: false,
    // One connection carries up to 50 messages, with RSET between them.
    batchSize: 50,
  },
  credentialFields: [
    {
      name: "preset",
      label: "Preset",
      secret: false,
      required: false,
      defaultValue: "custom",
      options: SMTP_PRESETS.map((preset) => ({ value: preset.id, label: preset.name })),
    },
    {
      name: "host",
      label: "Host",
      secret: false,
      required: true,
      pattern: "^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$",
    },
    { name: "port", label: "Port", secret: false, required: false, pattern: "^[0-9]{1,5}$" },
    {
      name: "security",
      label: "Encryption",
      secret: false,
      required: false,
      defaultValue: "starttls",
      options: [
        { value: "starttls", label: "STARTTLS" },
        { value: "tls", label: "TLS" },
        { value: "none", label: "None" },
      ],
    },
    {
      name: "insecure",
      label: "Plain text",
      secret: false,
      required: false,
      defaultValue: "false",
      options: [
        { value: "false", label: "No" },
        { value: "true", label: "Yes" },
      ],
    },
    { name: "username", label: "User name", secret: false, required: false },
    { name: "password", label: "Password", secret: true, required: false },
  ],
  presets: SMTP_PRESETS,
  docsUrl: "https://www.rfc-editor.org/rfc/rfc6409",
  // SMTP replies are not HTTP statuses, so the status map is empty. The client maps the
  // replies itself: see client.ts. A plain literal keeps the classifier out of the bundle.
  statusMap: {},
  // SMTP has no events. An adapter with relay webhooks (Brevo) sets this to true on its
  // own copy of the meta. See index.ts.
  webhooks: false,
  nativeIdempotency: false,
});
