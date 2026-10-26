// Shared helpers of the conformance kit: the sample message, result checks, secret
// forms for the redaction check, and webhook helpers. The HTTP checks (checks.ts) and
// the SMTP checks (smtp-checks.ts) both use them.

import { NORMALIZED_EVENT_TYPES, WEBHOOK_REJECTIONS } from "../core/events";
import type { Capabilities, FailureReason, OutgoingMessage, SendResult } from "../core/types";
import { bytesToBase64, bytesToHex, utf8 } from "../internal/encoding";
import type { CheckId, CheckStatus, WebhookSample } from "./types";

/** One check, ready to run. */
export interface ConformanceCheck {
  id: CheckId;
  title: string;
  /** Set when the check does not apply, with the reason from the adapter meta. */
  notApplicable?: string;
  run(): Promise<CheckStatus>;
}

export const FAILURE_REASONS: ReadonlySet<string> = new Set<FailureReason>([
  "auth",
  "rate_limited",
  "quota",
  "credits",
  "rejected",
  "timeout",
  "network",
  "invalid_message",
  "provider_error",
  "unsupported",
  "daily_cap",
  "idempotency_conflict",
  "stale_pending",
  "in_flight",
]);
export const REJECTIONS: ReadonlySet<string> = new Set(WEBHOOK_REJECTIONS);
export const EVENT_TYPES: ReadonlySet<string> = new Set(NORMALIZED_EVENT_TYPES);

/** The largest `maxMessageBytes` for which the kit builds an oversized message. */
export const MAX_OVERSIZE_BYTES = 50_000_000;

export const decoder: TextDecoder = new TextDecoder();

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function randomToken(): string {
  return `cnry${bytesToHex(crypto.getRandomValues(new Uint8Array(12)))}`;
}

export function toBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? utf8(body) : body.slice();
}

export function cloneSample(sample: WebhookSample, body: Uint8Array = sample.body): WebhookSample {
  return { headers: new Headers(sample.headers), body: body.slice() };
}

/** Appends "x" to the first string value of a JSON body, or to a body that is not JSON. */
export function defaultTamper(body: Uint8Array): Uint8Array {
  const text = decoder.decode(body);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return utf8(`${text}x`);
  }
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (changed) return node;
    if (typeof node === "string") {
      changed = true;
      return `${node}x`;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    }
    return node;
  };
  const next = walk(value);
  return utf8(changed ? JSON.stringify(next) : `${text} `);
}

export function changedSecret(secret: string): string {
  if (secret === "") return "conformance-wrong-secret";
  const last = secret.at(-1) === "A" ? "B" : "A";
  return `${secret.slice(0, -1)}${last}`;
}

export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** A sample message that every provider can send. */
export function sampleMessage(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: { email: "sender@example.com", name: "Conformance Kit" },
    to: ["recipient@example.org"],
    subject: "Conformance check",
    html: "<p>Hello from the conformance kit.</p>",
    text: "Hello from the conformance kit.",
    ...overrides,
  };
}

/** One message that a provider without a capability must refuse. */
export interface RefusalCase {
  label: string;
  build(): OutgoingMessage;
}

export function refusalCases(caps: Partial<Capabilities>): RefusalCase[] {
  const cases: RefusalCase[] = [];
  if (caps.attachments === false) {
    cases.push({
      label: "an attachment",
      build: () =>
        sampleMessage({
          attachments: [{ filename: "a.txt", content: utf8("a"), contentType: "text/plain" }],
        }),
    });
  }
  if (caps.cc === false) {
    cases.push({ label: "a cc recipient", build: () => sampleMessage({ cc: ["cc@example.org"] }) });
  }
  if (caps.bcc === false) {
    cases.push({
      label: "a bcc recipient",
      build: () => sampleMessage({ bcc: ["bcc@example.org"] }),
    });
  }
  if (caps.replyTo === false) {
    cases.push({
      label: "a reply-to address",
      build: () => sampleMessage({ replyTo: "reply@example.org" }),
    });
  }
  if (caps.customHeaders === false) {
    cases.push({
      label: "a custom header",
      build: () => sampleMessage({ headers: { "X-Conformance": "1" } }),
    });
  }
  const maxRecipients = caps.maxRecipients;
  if (typeof maxRecipients === "number" && maxRecipients >= 1) {
    cases.push({
      label: `${maxRecipients + 1} recipients`,
      build: () =>
        sampleMessage({
          to: Array.from({ length: maxRecipients + 1 }, (_, i) => `r${i}@example.org`),
        }),
    });
  }
  const maxBytes = caps.maxMessageBytes;
  if (typeof maxBytes === "number" && maxBytes > 0 && maxBytes <= MAX_OVERSIZE_BYTES) {
    cases.push({
      label: `a body larger than ${maxBytes} bytes`,
      build: () => sampleMessage({ html: "a".repeat(maxBytes + 1), text: "a" }),
    });
  }
  return cases;
}

/** One string form of a secret that must not leak. */
export interface SecretForm {
  label: string;
  value: string;
}

export function base64Text(text: string): string {
  return bytesToBase64(utf8(text)).replace(/=+$/, "");
}

export function base64UrlText(text: string): string {
  return base64Text(text).replaceAll("+", "-").replaceAll("/", "_");
}

/**
 * The forms of a secret that the redaction check searches for: raw, base64, base64url,
 * hex, URL-encoded, and HTTP Basic `user:pass` and `api:<key>` in base64.
 */
export function secretForms(name: string, secret: string, others: readonly string[]): SecretForm[] {
  const forms: SecretForm[] = [
    { label: `raw ${name}`, value: secret },
    { label: `base64 ${name}`, value: base64Text(secret) },
    { label: `base64url ${name}`, value: base64UrlText(secret) },
    { label: `hex ${name}`, value: bytesToHex(utf8(secret)) },
    { label: `Basic api:${name}`, value: base64Text(`api:${secret}`) },
    { label: `Basic ${name}:`, value: base64Text(`${secret}:`) },
  ];
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) forms.push({ label: `URL-encoded ${name}`, value: encoded });
  for (const other of others) {
    if (other === secret || other === "") continue;
    forms.push({ label: `Basic user:${name}`, value: base64Text(`${other}:${secret}`) });
    forms.push({ label: `Basic ${name}:pass`, value: base64Text(`${secret}:${other}`) });
  }
  return forms;
}

/** Flattens a value into searchable text: strings, error stacks, headers, and bytes. */
export function flatten(
  value: unknown,
  out: string[] = [],
  seen: Set<unknown> = new Set(),
): string[] {
  if (value === null || value === undefined) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (typeof value !== "object" && typeof value !== "function") {
    out.push(String(value));
    return out;
  }
  if (seen.has(value)) return out;
  seen.add(value);
  if (value instanceof Error) {
    out.push(value.name, value.message, value.stack ?? "");
    flatten((value as { cause?: unknown }).cause, out, seen);
  }
  if (value instanceof Headers) {
    for (const [name, item] of value.entries()) out.push(`${name}: ${item}`);
    return out;
  }
  if (value instanceof Uint8Array) {
    out.push(decoder.decode(value));
    return out;
  }
  try {
    out.push(JSON.stringify(value) ?? "");
  } catch {
    // A cycle or a BigInt. The walk below still covers the fields.
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    out.push(key);
    flatten((value as Record<string, unknown>)[key], out, seen);
  }
  return out;
}

export function findLeak(text: string, forms: readonly SecretForm[]): SecretForm | undefined {
  const lower = text.toLowerCase();
  return forms.find((form) =>
    form.label.startsWith("hex") ? lower.includes(form.value) : text.includes(form.value),
  );
}

export type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";
export const CONSOLE_METHODS: readonly ConsoleMethod[] = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
];

/** Runs `body` with every console method recorded instead of printed. */
export async function withCapturedConsole(
  logs: { where: string; value: unknown }[],
  body: () => Promise<void>,
): Promise<void> {
  const target = console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>;
  const saved = CONSOLE_METHODS.map((method) => target[method]);
  for (const method of CONSOLE_METHODS) {
    target[method] = (...args: unknown[]) => {
      logs.push({ where: `console.${method}`, value: args });
    };
  }
  try {
    await body();
  } finally {
    CONSOLE_METHODS.forEach((method, index) => {
      target[method] = saved[index] as (...args: unknown[]) => void;
    });
  }
}

/** Checks the shape of a send result. Returns false when it is not a result. */
export function validResult(
  value: unknown,
  where: string,
  problems: string[],
): value is SendResult {
  if (!isRecord(value)) {
    problems.push(`${where}: the result is not an object.`);
    return false;
  }
  const status = value.status;
  if (status === "sent") return true;
  if (status !== "not_sent" && status !== "unknown") {
    problems.push(`${where}: the status ${String(status)} is not sent, not_sent, or unknown.`);
    return false;
  }
  if (typeof value.reason !== "string" || !FAILURE_REASONS.has(value.reason)) {
    problems.push(`${where}: the reason ${String(value.reason)} is not a FailureReason.`);
  }
  if (typeof value.message !== "string" || value.message.trim() === "") {
    problems.push(`${where}: a failure needs a short message.`);
  }
  return true;
}

export function expectResult(
  value: unknown,
  where: string,
  problems: string[],
  status: SendResult["status"],
  reason?: FailureReason,
): void {
  if (!validResult(value, where, problems)) return;
  if (value.status !== status) {
    problems.push(`${where}: the status is ${value.status}. Expected ${status}.`);
    return;
  }
  if (reason !== undefined && value.status !== "sent" && value.reason !== reason) {
    problems.push(`${where}: the reason is ${value.reason}. Expected ${reason}.`);
  }
}

export function expectVerifyFailure(
  value: unknown,
  where: string,
  problems: string[],
  status: "not_sent" | "unknown",
  reason?: FailureReason,
): void {
  if (isRecord(value) && value.ok !== false) {
    problems.push(`${where}: a failed verify must set ok to false.`);
  }
  expectResult(value, where, problems, status, reason);
}

export function check(
  id: CheckId,
  title: string,
  body: (problems: string[]) => Promise<void> | void,
  notApplicable?: string,
): ConformanceCheck {
  return {
    id,
    title,
    ...(notApplicable === undefined ? {} : { notApplicable }),
    async run(): Promise<CheckStatus> {
      if (notApplicable !== undefined) return { status: "n/a", reason: notApplicable };
      const problems: string[] = [];
      try {
        await body(problems);
      } catch (error) {
        problems.push(
          `The check threw: ${errorText(error)}. Return a result for every provider failure.`,
        );
      }
      return problems.length > 0 ? { status: "fail", problems } : { status: "pass" };
    },
  };
}

/** Checks a rejection. Returns true when the request was rejected. */
export function rejected(result: unknown, where: string, problems: string[]): boolean {
  if (!isRecord(result) || typeof result.ok !== "boolean") {
    problems.push(`${where}: verify must return { ok: true } or { ok: false, reason }.`);
    return false;
  }
  if (result.ok) {
    problems.push(`${where}: verify accepted the request.`);
    return false;
  }
  if (typeof result.reason !== "string" || !REJECTIONS.has(result.reason)) {
    problems.push(`${where}: the reason ${String(result.reason)} is not a WebhookRejection.`);
  }
  return true;
}
