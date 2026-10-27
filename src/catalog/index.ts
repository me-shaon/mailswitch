// mailswitch/catalog: the data of every built-in provider, for a settings form or docs.
// It imports only meta files, so no adapter code is in this bundle.

import type { ProviderMeta } from "../core/meta";
import { brevoMeta } from "../providers/brevo/meta";
import { cloudflareBindingMeta, cloudflareRestMeta } from "../providers/cloudflare/meta";
import { mailchannelsMeta } from "../providers/mailchannels/meta";
import { mailersendMeta } from "../providers/mailersend/meta";
import { mailgunMeta } from "../providers/mailgun/meta";
import { mailjetMeta } from "../providers/mailjet/meta";
import { postmarkMeta } from "../providers/postmark/meta";
import { resendMeta } from "../providers/resend/meta";
import { sendgridMeta } from "../providers/sendgrid/meta";
import { sesMeta } from "../providers/ses/meta";
import { smtpMeta } from "../providers/smtp/meta";
import { smtp2goMeta } from "../providers/smtp2go/meta";
import { toSendMeta } from "../providers/tosend/meta";
import { zeptomailMeta } from "../providers/zeptomail/meta";

export type { CredentialField, ProviderMeta, ProviderPreset, ProviderTier } from "../core/meta";

/** Every built-in provider, in a stable order. */
export const catalog: readonly ProviderMeta[] = Object.freeze([
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
]);

/** Returns the meta of a built-in provider, or undefined for an unknown id. */
export function getProviderMeta(id: string): ProviderMeta | undefined {
  return catalog.find((meta) => meta.id === id);
}
