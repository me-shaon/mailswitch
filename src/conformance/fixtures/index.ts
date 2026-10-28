// mailswitch/conformance/fixtures: the webhook fixtures of each provider, for app tests.
// Each provider with webhooks exports its test secret, a sign helper, and the builders of
// its sample event bodies. A test signs a sample at the current time and passes it to
// `handleWebhook`. The secrets and keys protect nothing. Never use them in production.
//
// The export names and the helper signatures follow semver. The sample bodies follow the
// provider docs and can change in a minor release.

export type { WebhookSample } from "../types";
export { AHASEND_FIXTURE_SECRET, ahasendEvent, signAhasendWebhook } from "./ahasend";
export { AUTOSEND_FIXTURE_SECRET, autosendEvent, signAutosendWebhook } from "./autosend";
export {
  MAILCHANNELS_FIXTURE_CUSTOMER_HANDLE,
  MAILCHANNELS_FIXTURE_OTHER_PUBLIC_KEY,
  MAILCHANNELS_FIXTURE_PUBLIC_KEY,
  type MailchannelsSignOptions,
  mailchannelsEvent,
  signMailchannelsWebhook,
} from "./mailchannels";
export { MAILERSEND_FIXTURE_SECRET, mailersendEvent, signMailersendWebhook } from "./mailersend";
export { MAILGUN_FIXTURE_SECRET, mailgunEvent, signMailgunWebhook } from "./mailgun";
export { MAILJET_FIXTURE_SECRET, mailjetEvent, signMailjetWebhook } from "./mailjet";
export {
  MAILTRAP_FIXTURE_SECRET,
  mailtrapEvent,
  mailtrapEvents,
  signMailtrapWebhook,
} from "./mailtrap";
export {
  POSTMARK_FIXTURE_SECRET,
  type PostmarkSubscriptionChangeOptions,
  postmarkBounce,
  postmarkDelivery,
  postmarkSpamComplaint,
  postmarkSubscriptionChange,
  signPostmarkWebhook,
} from "./postmark";
export { RESEND_FIXTURE_SECRET, resendEvent, signResendWebhook } from "./resend";
export {
  SENDGRID_FIXTURE_OTHER_PUBLIC_KEY,
  SENDGRID_FIXTURE_PUBLIC_KEY,
  sendgridEvent,
  signSendgridWebhook,
} from "./sendgrid";
export {
  SES_FIXTURE_CERT_URL,
  SES_FIXTURE_TOPIC,
  sesFixtureSigner,
  sesNotification,
  signSesWebhook,
  snsEnvelope,
} from "./ses";
export { BREVO_FIXTURE_TOKEN, brevoEvent, signBrevoWebhook } from "./smtp";
export { SMTP2GO_FIXTURE_SECRET, signSmtp2goWebhook, smtp2goEvent } from "./smtp2go";
export {
  signToSendWebhook,
  TOSEND_FIXTURE_SECRET,
  toSendBounce,
  toSendComplaint,
} from "./tosend";
