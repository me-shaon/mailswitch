// mailswitch/catalog: the data of every built-in provider, for a settings form or docs.
// It imports only meta files, so no adapter code is in this bundle.

import type { ProviderMeta } from "../core/meta";
import { ahasendMeta } from "../providers/ahasend/meta";
import { autosendMeta } from "../providers/autosend/meta";
import { brevoMeta } from "../providers/brevo/meta";
import { cloudflareBindingMeta, cloudflareRestMeta } from "../providers/cloudflare/meta";
import { httpMeta } from "../providers/http/meta";
import { mailchannelsMeta } from "../providers/mailchannels/meta";
import { mailersendMeta } from "../providers/mailersend/meta";
import { mailgunMeta } from "../providers/mailgun/meta";
import { mailjetMeta } from "../providers/mailjet/meta";
import { mailtrapMeta } from "../providers/mailtrap/meta";
import { postmarkMeta } from "../providers/postmark/meta";
import { resendMeta } from "../providers/resend/meta";
import { scalewayMeta } from "../providers/scaleway/meta";
import { sendgridMeta } from "../providers/sendgrid/meta";
import { sesMeta } from "../providers/ses/meta";
import { smtpMeta } from "../providers/smtp/meta";
import { smtp2goMeta } from "../providers/smtp2go/meta";
import { toSendMeta } from "../providers/tosend/meta";
import { zeptomailMeta } from "../providers/zeptomail/meta";

export type {
  CredentialField,
  ProviderMeta,
  ProviderPreset,
  ProviderTier,
  WebhookSecretMeta,
} from "../core/meta";

/** The id of a built-in provider. */
export type ProviderId =
  | "resend"
  | "tosend"
  | "cloudflare-rest"
  | "cloudflare-binding"
  | "mailgun"
  | "postmark"
  | "brevo"
  | "mailersend"
  | "mailjet"
  | "smtp2go"
  | "zeptomail"
  | "sendgrid"
  | "ses"
  | "smtp"
  | "mailchannels"
  | "ahasend"
  | "mailtrap"
  | "autosend"
  | "scaleway"
  | "http";

/** The id of every built-in provider, in catalog order. */
export const PROVIDER_IDS: readonly ProviderId[] = Object.freeze([
  "resend",
  "tosend",
  "cloudflare-rest",
  "cloudflare-binding",
  "mailgun",
  "postmark",
  "brevo",
  "mailersend",
  "mailjet",
  "smtp2go",
  "zeptomail",
  "sendgrid",
  "ses",
  "smtp",
  "mailchannels",
  "ahasend",
  "mailtrap",
  "autosend",
  "scaleway",
  "http",
]);

/** The meta of a built-in provider. Its id is a `ProviderId`. */
export type CatalogEntry = ProviderMeta & { readonly id: ProviderId };

/** Every built-in provider, in a stable order. */
export const catalog: readonly CatalogEntry[] = Object.freeze([
  resendMeta,
  toSendMeta,
  cloudflareRestMeta,
  cloudflareBindingMeta,
  mailgunMeta,
  postmarkMeta,
  brevoMeta,
  mailersendMeta,
  mailjetMeta,
  smtp2goMeta,
  zeptomailMeta,
  sendgridMeta,
  sesMeta,
  smtpMeta,
  mailchannelsMeta,
  ahasendMeta,
  mailtrapMeta,
  autosendMeta,
  scalewayMeta,
  httpMeta,
] as CatalogEntry[]);

/** Tells whether a string, for example a saved setting, is the id of a built-in provider. */
export function isProviderId(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

/** Returns the meta of a built-in provider. For a `ProviderId`, the result is defined. */
export function getProviderMeta(id: ProviderId): CatalogEntry;
/** Returns the meta of a built-in provider, or undefined for an unknown id. */
export function getProviderMeta(id: string): CatalogEntry | undefined;
export function getProviderMeta(id: string): CatalogEntry | undefined {
  return catalog.find((meta) => meta.id === id);
}
