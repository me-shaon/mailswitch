// mailswitch/smtp: the SMTP adapter. It sends through any SMTP submission server over a
// socket that the app injects, so this module never imports `cloudflare:sockets`. The
// app imports `connect` from that module and passes it to `createMailer` or `smtp`.
//
// - send: one connection per message. sendBatch: one connection for up to 50 messages.
// - verify: the greeting, TLS, and AUTH, then QUIT. It sends no message.
// - Presets (meta.ts and presets.ts) fix the host, the port, and the TLS mode.
// - webhooks: none by default, because SMTP itself has no events. A relay with webhooks
//   injects its verifier: `smtp({ webhooks: brevoWebhooks() })` with `brevoWebhooks`
//   from the optional `mailswitch/smtp/brevo` subpath. Only Brevo users load that code.

import {
  defineProvider,
  type ProviderAdapter,
  type ProviderWebhooks,
  type SendContext,
  type VerifyResult,
} from "../../core/adapter";
import { validateMessage } from "../../core/message";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";
import type { SocketConnect } from "../../core/socket";
import type { AddressInput, NotSentResult, OutgoingMessage, SendResult } from "../../core/types";
import { parseAddress } from "../../internal/address";
import { buildMime } from "../../internal/mime";
import { checkSmtp, HOST_NAME, type SmtpEnvelope, type SmtpSettings, sendSmtp } from "./client";
import { smtpMeta } from "./meta";
import { resolveSmtpSettings, type SmtpConnectionOptions } from "./presets";

export { dotStuff, queueId, type SmtpSecurity, type SmtpSettings } from "./client";
export {
  BREVO_FREE_DAILY_CAP,
  GMAIL_DAILY_CAP,
  SMTP_PRESETS,
  type SmtpPresetId,
  smtpMeta,
  WORKSPACE_DAILY_CAP,
} from "./meta";
export {
  resolveSmtpSettings,
  type SmtpConnectionOptions,
  type SmtpSettingsResult,
  smtpPreset,
} from "./presets";

/** Options of `smtp`. The credentials in the send context take precedence. */
export interface SmtpOptions extends SmtpConnectionOptions {
  /** The name in EHLO. Defaults to the domain of the From address. */
  heloName?: string;
  /**
   * The socket function, when the send context gives none. In a Worker, pass `connect`
   * from `cloudflare:sockets`, here or in `createMailer`.
   */
  connect?: SocketConnect;
  /**
   * The webhook methods of the relay, for example `brevoWebhooks()` from
   * `mailswitch/smtp/brevo`. With them, the adapter meta sets `webhooks: true`.
   */
  webhooks?: ProviderWebhooks;
}

/**
 * An SMTP adapter with relay webhooks. The webhook router needs a dedupe store for it,
 * as `requiresDedupe` marks, because a bearer token passes for a replayed request.
 */
export interface SmtpWebhookAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
}

/** The meta of an SMTP adapter with relay webhooks. */
const webhookMeta: ProviderMeta = defineProviderMeta({ ...smtpMeta, webhooks: true });

const PROVIDER = smtpMeta.id;

function tag<T extends SendResult>(result: T): T {
  return { ...result, provider: PROVIDER };
}

function emailOf(input: AddressInput): string {
  // validateMessage has checked every address, so parseAddress cannot return null here.
  return parseAddress(input)?.email ?? "";
}

/** The envelope and the MIME source of a valid message. */
function envelopeOf(message: OutgoingMessage, now: number): SmtpEnvelope {
  const mime = buildMime(message, { now });
  return {
    from: emailOf(message.from),
    recipients: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map(emailOf),
    data: mime.raw,
    messageId: mime.messageId,
  };
}

/**
 * Creates the SMTP adapter. With `webhooks`, it is an `SmtpWebhookAdapter`.
 *
 * @throws TypeError for an invalid `heloName`.
 */
export function smtp(options: SmtpOptions & { webhooks: ProviderWebhooks }): SmtpWebhookAdapter;
export function smtp(options?: SmtpOptions): ProviderAdapter;
export function smtp(options: SmtpOptions = {}): ProviderAdapter {
  if (options.heloName !== undefined && !HOST_NAME.test(options.heloName)) {
    throw new TypeError("smtp: heloName must be a host name.");
  }
  const webhooks = options.webhooks;

  /** The settings and the socket function, or the refusal that stops the send. */
  function setup(
    ctx: SendContext,
  ):
    | { ok: true; settings: SmtpSettings; connect: SocketConnect }
    | { ok: false; result: NotSentResult } {
    const connect = ctx.connect ?? options.connect;
    if (!connect) {
      return {
        ok: false,
        result: tag({
          status: "not_sent",
          reason: "unsupported",
          message: "SMTP needs a socket connect function. Pass connect from cloudflare:sockets.",
        }),
      };
    }
    const resolved = resolveSmtpSettings(ctx.credentials, options);
    if (!resolved.ok) {
      return {
        ok: false,
        result: tag({ status: "not_sent", reason: "auth", message: resolved.message }),
      };
    }
    const settings: SmtpSettings = { ...resolved.settings };
    if (options.heloName !== undefined) settings.heloName = options.heloName;
    return { ok: true, settings, connect };
  }

  async function sendBatch(
    messages: readonly OutgoingMessage[],
    ctx: SendContext,
  ): Promise<SendResult[]> {
    if (messages.length > smtpMeta.capabilities.batchSize) {
      throw new RangeError(
        `SMTP takes at most ${smtpMeta.capabilities.batchSize} messages per batch.`,
      );
    }
    const results: (SendResult | undefined)[] = messages.map((message) => {
      const checked = validateMessage(message, smtpMeta.capabilities);
      return checked.ok ? undefined : tag(checked.result);
    });
    const slots = results.flatMap((result, index) => (result === undefined ? [index] : []));
    if (slots.length === 0) return results as SendResult[];
    const ready = setup(ctx);
    if (!ready.ok) return results.map((result) => result ?? ready.result);
    const envelopes = slots.map((index) => envelopeOf(messages[index] as OutgoingMessage, ctx.now));
    const sent = await sendSmtp(envelopes, ready.settings, {
      connect: ready.connect,
      timeoutMs: ctx.timeoutMs,
    });
    slots.forEach((index, position) => {
      results[index] = tag(sent[position] as SendResult);
    });
    return results as SendResult[];
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    return (await sendBatch([message], ctx))[0] as SendResult;
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const ready = setup(ctx);
    if (!ready.ok) return { ...ready.result, ok: false };
    const check = await checkSmtp(ready.settings, {
      connect: ready.connect,
      timeoutMs: ctx.timeoutMs,
    });
    return check.ok ? check : { ...tag(check), ok: false };
  }

  if (!webhooks) return defineProvider({ meta: smtpMeta, send, sendBatch, verify });
  const adapter = defineProvider({ meta: webhookMeta, send, sendBatch, verify, webhooks });
  const result: SmtpWebhookAdapter = { ...adapter, webhooks, requiresDedupe: true };
  return result;
}
