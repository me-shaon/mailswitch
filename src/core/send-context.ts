// A SendContext builder for code that calls an adapter directly, such as a settings
// screen that runs `adapter.verify()` or `sendTestEmail()` with no mailer.

import { DEFAULT_TIMEOUT_MS, type FetchLike } from "../internal/http";
import type { ProviderCredentials, SendContext } from "./adapter";
import type { SocketConnect } from "./socket";

/** Options of `createSendContext`. */
export interface SendContextOptions<Creds extends ProviderCredentials = ProviderCredentials> {
  /** The credentials, already checked with `parseCredentials`. */
  credentials: Creds;
  /** Outbound HTTP. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** The timeout of one provider request. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Outbound TCP, for socket adapters (SMTP). */
  connect?: SocketConnect;
  /** The current time, in Unix milliseconds. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Builds the `SendContext` of one adapter call.
 *
 * @throws RangeError when `timeoutMs` is not a positive number.
 */
export function createSendContext<Creds extends ProviderCredentials = ProviderCredentials>(
  options: SendContextOptions<Creds>,
): SendContext<Creds> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!(timeoutMs > 0 && timeoutMs < Infinity)) {
    throw new RangeError("createSendContext: timeoutMs must be a positive number.");
  }
  const ctx: SendContext<Creds> = {
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    timeoutMs,
    credentials: options.credentials,
    now: options.now ?? Date.now(),
  };
  if (options.connect) ctx.connect = options.connect;
  return ctx;
}
