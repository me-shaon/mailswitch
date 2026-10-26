// Test send for a settings screen. It sends one fixed message through one adapter, so the
// person can see that the provider settings deliver an email.

import type { ProviderAdapter, SendContext } from "./adapter";
import type { AddressInput, OutgoingMessage, SendResult } from "./types";

/** The default subject of a test email. */
export const TEST_EMAIL_SUBJECT = "mailswitch test email";
/** The default text of a test email. */
export const TEST_EMAIL_TEXT =
  "This is a test email from mailswitch. Your email provider settings work.";

/** Options of `sendTestEmail`. */
export interface TestEmailOptions {
  from: AddressInput;
  to: AddressInput;
  /** Defaults to `TEST_EMAIL_SUBJECT`. */
  subject?: string;
  /** Defaults to `TEST_EMAIL_TEXT`. */
  text?: string;
}

/**
 * Sends one plain-text test email through `adapter` and returns its result. Each call
 * has a new idempotency key, so a retry of the same call does not send a second copy
 * when the provider has native idempotency. A failure is a result, as with `send`.
 */
export function sendTestEmail(
  adapter: ProviderAdapter,
  ctx: SendContext,
  options: TestEmailOptions,
): Promise<SendResult> {
  const message: OutgoingMessage = {
    from: options.from,
    to: [options.to],
    subject: options.subject ?? TEST_EMAIL_SUBJECT,
    text: options.text ?? TEST_EMAIL_TEXT,
    idempotencyKey: `mailswitch-test-${crypto.randomUUID()}`,
  };
  return adapter.send(message, ctx);
}
