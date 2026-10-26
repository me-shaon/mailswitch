// The message shape of the Workers `send_email` binding, the mapping of a message to it,
// and the classification of a binding error. The binding types are public through the
// adapter entry. The functions and the code table are internal.
// https://developers.cloudflare.com/email-service/api/send-emails/workers-api/

import { classifyThrown } from "../../core/classify";
import type {
  Address,
  AddressInput,
  FailureReason,
  NotSentResult,
  OutgoingMessage,
  UnknownResult,
} from "../../core/types";
import { parseAddress } from "../../internal/address";
import { base64ToBytes } from "../../internal/encoding";
import { cloudflareBindingMeta } from "./meta";

const BINDING = cloudflareBindingMeta.id;

/** A mailbox with a display name, in the binding shape. */
export interface CloudflareEmailAddress {
  email: string;
  name: string;
}

/** One attachment, in the binding shape. An inline attachment needs a content id. */
export type CloudflareEmailAttachment =
  | {
      disposition: "inline";
      contentId: string;
      filename: string;
      type: string;
      content: string | ArrayBuffer | ArrayBufferView;
    }
  | {
      disposition: "attachment";
      contentId?: undefined;
      filename: string;
      type: string;
      content: string | ArrayBuffer | ArrayBufferView;
    };

/** The structured message that `send_email` accepts, so no raw MIME is needed. */
export interface CloudflareEmailBuilder {
  from: string | CloudflareEmailAddress;
  to: (string | CloudflareEmailAddress)[];
  cc?: (string | CloudflareEmailAddress)[];
  bcc?: (string | CloudflareEmailAddress)[];
  replyTo?: string | CloudflareEmailAddress;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: CloudflareEmailAttachment[];
}

/**
 * The part of the Workers `send_email` binding (`SendEmail` in
 * `@cloudflare/workers-types`) that mailswitch uses. A local type, so mailswitch needs no
 * Workers types and imports no `cloudflare:*` module.
 */
export interface CloudflareSendEmail {
  send(message: CloudflareEmailBuilder): Promise<{ messageId?: string } | undefined>;
}

/**
 * The binding error codes that prove that Cloudflare did not accept the message, with the
 * reason of each. Every other code, and an error with no code, is `unknown`. This includes
 * `E_DELIVERY_FAILED` and `E_INTERNAL_SERVER_ERROR`.
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */
export const CLOUDFLARE_BINDING_NOT_SENT: Readonly<Record<string, FailureReason>> = Object.freeze({
  E_VALIDATION_ERROR: "invalid_message",
  E_FIELD_MISSING: "invalid_message",
  E_TOO_MANY_RECIPIENTS: "invalid_message",
  E_TOO_MANY_ATTACHMENTS: "invalid_message",
  E_CONTENT_TOO_LARGE: "invalid_message",
  E_HEADER_NOT_ALLOWED: "invalid_message",
  E_HEADER_USE_API_FIELD: "invalid_message",
  E_HEADER_VALUE_INVALID: "invalid_message",
  E_HEADER_VALUE_TOO_LONG: "invalid_message",
  E_HEADER_NAME_INVALID: "invalid_message",
  E_HEADERS_TOO_LARGE: "invalid_message",
  E_HEADERS_TOO_MANY: "invalid_message",
  E_SENDER_NOT_VERIFIED: "rejected",
  E_SENDER_DOMAIN_NOT_AVAILABLE: "rejected",
  E_RECIPIENT_NOT_ALLOWED: "rejected",
  E_RECIPIENT_SUPPRESSED: "rejected",
  E_ACCOUNT_SUSPENDED: "auth",
  E_RATE_LIMIT_EXCEEDED: "rate_limited",
  E_DAILY_LIMIT_EXCEEDED: "quota",
});

function parsed(input: AddressInput): Address {
  // validateMessage has checked every address, so parseAddress cannot fail here.
  return parseAddress(input) ?? { email: "" };
}

function bindingAddress(input: AddressInput): string | CloudflareEmailAddress {
  const value = parsed(input);
  return value.name ? { email: value.email, name: value.name } : value.email;
}

/** The structured message of one email, in the shape of the binding. */
export function cloudflareBindingMessage(message: OutgoingMessage): CloudflareEmailBuilder {
  const out: CloudflareEmailBuilder = {
    from: bindingAddress(message.from),
    to: message.to.map(bindingAddress),
    subject: message.subject,
  };
  if (message.cc?.length) out.cc = message.cc.map(bindingAddress);
  if (message.bcc?.length) out.bcc = message.bcc.map(bindingAddress);
  if (message.replyTo !== undefined) out.replyTo = bindingAddress(message.replyTo);
  if (message.html !== undefined) out.html = message.html;
  if (message.text !== undefined) out.text = message.text;
  if (message.headers && Object.keys(message.headers).length > 0) {
    out.headers = { ...message.headers };
  }
  if (message.attachments?.length) {
    out.attachments = message.attachments.map((item) => {
      // A string is base64. The binding reads a string as text, so it gets the bytes.
      const content =
        typeof item.content === "string"
          ? (base64ToBytes(item.content) ?? new Uint8Array(0))
          : item.content;
      return item.contentId === undefined
        ? { disposition: "attachment", filename: item.filename, type: item.contentType, content }
        : {
            disposition: "inline",
            contentId: item.contentId,
            filename: item.filename,
            type: item.contentType,
            content,
          };
    });
  }
  return out;
}

/** Classifies an error that the binding threw. */
export function classifyBindingError(error: unknown): NotSentResult | UnknownResult {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const reason = typeof code === "string" ? CLOUDFLARE_BINDING_NOT_SENT[code] : undefined;
  if (reason !== undefined) {
    return {
      status: "not_sent",
      reason,
      message: `Cloudflare refused the message (${code as string}).`,
      provider: BINDING,
    };
  }
  if (typeof code === "string" && /^E_[A-Z_]{1,64}$/.test(code)) {
    return {
      status: "unknown",
      reason: "provider_error",
      message: `The send_email binding failed (${code}). The message may have gone out.`,
      provider: BINDING,
    };
  }
  return { ...classifyThrown(error), provider: BINDING };
}
