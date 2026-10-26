// The fallback rule. The default rule moves to the next provider after `not_sent` and
// never after `sent` or `unknown`. A `shouldFallback` callback can only narrow it.

import { errorName, type MailerLogger, safeWarn } from "./hooks";
import type { NotSentResult, SendResult, UnknownResult } from "./types";

/**
 * Decides whether a failed attempt moves to the next provider. It can only say no to a
 * `not_sent` result. A true answer for an `unknown` result is ignored with a warning.
 */
export type ShouldFallback = (result: NotSentResult | UnknownResult) => boolean;

/**
 * True when the pipeline may try the next provider after `result`.
 *
 * - `sent` and `unknown` never fall back. An `unknown` email may have gone out.
 * - `not_sent` falls back unless `shouldFallback` returns a value that is not `true`.
 * - A `shouldFallback` that throws counts as false, and the logger gets a warning.
 */
export function allowFallback(
  result: SendResult,
  shouldFallback?: ShouldFallback,
  logger?: MailerLogger,
): boolean {
  if (result.status === "sent") return false;
  if (!shouldFallback) return result.status === "not_sent";
  let answer: unknown;
  try {
    answer = shouldFallback(result);
  } catch (error) {
    safeWarn(logger, "mailswitch: shouldFallback threw. The pipeline does not fall back.", {
      provider: result.provider,
      error: errorName(error),
    });
    return false;
  }
  if (result.status === "unknown") {
    if (answer === true) {
      safeWarn(
        logger,
        "mailswitch: shouldFallback returned true for an unknown result. The pipeline ignores it, because the email may have gone out.",
        { provider: result.provider, reason: result.reason },
      );
    }
    return false;
  }
  return answer === true;
}
