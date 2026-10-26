// Observe hooks. They get a redacted view and cannot change a status. The core catches
// every error that a hook throws.

import type { DeliveryStatus, FailureReason } from "./types";

/**
 * The view of one provider attempt that `onAttempt` gets. It never holds recipients, the
 * subject, bodies, attachments, credentials, or provider response bodies.
 */
export interface AttemptView {
  /** The provider id. */
  provider: string;
  status: DeliveryStatus;
  reason?: FailureReason;
  /** When the attempt ended, in Unix milliseconds. */
  at: number;
  /** The idempotency key of the message, when it has one. */
  messageKey?: string;
}

/** Data that mailswitch gives the logger. It holds ids and reasons only, never PII. */
export type LogData = Readonly<Record<string, string | number | boolean | undefined>>;

/** The logger that a mailer writes warnings to. */
export interface MailerLogger {
  warn(message: string, data?: LogData): void;
}

/** Calls the logger and drops any error that it throws. */
export function safeWarn(logger: MailerLogger | undefined, message: string, data?: LogData): void {
  if (!logger) return;
  try {
    logger.warn(message, data);
  } catch {
    // A logger failure must not change a send result.
  }
}

/** The name of a thrown value, for a log line. It never copies the error message. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
