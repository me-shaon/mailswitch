// mailswitch/smtp/brevo: Brevo transactional webhooks, for the Brevo preset of the SMTP
// adapter. It is an optional subpath, so other SMTP users do not load it. Ported from
// Envelopen. The code is in src/internal/brevo-webhooks.ts.
//
//   import { smtp } from "mailswitch/smtp";
//   import { brevoWebhooks } from "mailswitch/smtp/brevo";
//   const adapter = smtp({ preset: "brevo", webhooks: brevoWebhooks() });

export {
  BREVO_MIN_HEX_TOKEN_LENGTH,
  BREVO_MIN_TOKEN_LENGTH,
  BREVO_WEBHOOK_EVENTS,
  brevoWebhooks,
  checkBrevoWebhookToken,
  generateBrevoWebhookToken,
  parseBrevoEvents,
  verifyBrevoWebhook,
} from "../../internal/brevo-webhooks";
