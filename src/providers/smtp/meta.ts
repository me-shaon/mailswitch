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
  return {
    id,
    name,
    fixed: { preset: id, security: "none", insecure: "true" },
    fieldHints: LOCAL_HINTS,
  };
}

type FieldHints = NonNullable<ProviderPreset["fieldHints"]>;

/** Gmail and Google Workspace log in with an app password, not the account password. */
function googleHints(account: string, passwordHint: string): FieldHints {
  return {
    username: { label: "Email address", hint: `The full address of the ${account}.` },
    password: { label: "App password", hint: passwordHint },
  };
}

const LOCAL_HINTS: FieldHints = {
  host: { placeholder: "localhost", hint: "Local development only. The server has no TLS." },
  port: { placeholder: "1025" },
  username: { hint: "Leave it empty. The local server needs no login." },
  password: { hint: "Leave it empty. The local server needs no login." },
};

/** The presets. Each one fixes the `preset` field, so the adapter knows which one it is. */
export const SMTP_PRESETS: readonly ProviderPreset[] = [
  {
    ...relay("gmail", "Gmail", "smtp.gmail.com", GMAIL_DAILY_CAP),
    fieldHints: googleHints(
      "Gmail account",
      "A 16-character app password. Turn on 2-Step Verification first, then create the app password in your Google Account.",
    ),
  },
  {
    ...relay("google-workspace", "Google Workspace", "smtp.gmail.com", WORKSPACE_DAILY_CAP),
    fieldHints: googleHints(
      "Workspace user",
      "An app password of the Workspace user. The user needs 2-Step Verification. Some Workspace policies block app passwords.",
    ),
  },
  {
    ...relay("brevo", "Brevo", "smtp-relay.brevo.com", BREVO_FREE_DAILY_CAP),
    fieldHints: {
      username: {
        label: "SMTP login",
        hint: "The login on the SMTP & API page of Brevo. It is not always your account email.",
      },
      password: {
        label: "SMTP key",
        hint: "An SMTP key from the SMTP & API page of Brevo. A Brevo API key does not work.",
      },
    },
  },
  local("mailpit", "Mailpit"),
  local("mailcrab", "MailCrab"),
  { id: "custom", name: "Custom server", fixed: { preset: "custom" } },
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
      label: "Service",
      secret: false,
      required: false,
      defaultValue: "custom",
      options: SMTP_PRESETS.map((preset) => ({ value: preset.id, label: preset.name })),
      hint: "A preset fills the host, port, and encryption. Pick Custom server for any other service.",
    },
    {
      name: "host",
      label: "SMTP host",
      secret: false,
      required: true,
      placeholder: "smtp.example.com",
      pattern: "^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$",
    },
    {
      name: "port",
      label: "Port",
      secret: false,
      required: false,
      placeholder: "587",
      pattern: "^[0-9]{1,5}$",
      hint: "Leave it empty for the default: 587 for STARTTLS, 465 for TLS.",
    },
    {
      name: "security",
      label: "Encryption",
      secret: false,
      required: false,
      defaultValue: "starttls",
      options: [
        { value: "starttls", label: "STARTTLS (port 587)" },
        { value: "tls", label: "TLS from the start (port 465)" },
        { value: "none", label: "None (local test servers only)" },
      ],
    },
    {
      name: "insecure",
      label: "Allow plain text",
      secret: false,
      required: false,
      defaultValue: "false",
      options: [
        { value: "false", label: "No" },
        { value: "true", label: "Yes, send without TLS" },
      ],
      hint: "Encryption None needs Yes. Use it only for a local test server.",
    },
    {
      name: "username",
      label: "User name",
      secret: false,
      required: false,
      hint: "Leave it empty for a server that needs no login.",
    },
    {
      name: "password",
      label: "Password",
      secret: true,
      required: false,
      hint: "The password or the SMTP key of the user name.",
    },
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
