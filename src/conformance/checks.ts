// The checks of the conformance kit, as plain functions with no test framework. Each
// check returns a status and never throws, so the kit can test itself: a broken adapter
// must fail. `vitest.ts` wraps these checks in describe and it blocks.
//
// Every check is required. A check is `n/a` only when the adapter meta shows that it
// does not apply, and the report gives that reason. A missing fixture part is a failure,
// not a skip.

import type {
  ProviderAdapter,
  SendContext,
  WebhookVerifyInput,
  WebhookVerifyResult,
} from "../core/adapter";
import { parseCredentials } from "../core/credentials";
import { validateMessage } from "../core/message";
import type { CredentialField, ProviderMeta, ProviderTier } from "../core/meta";
import type { Capabilities, OutgoingMessage, SendResult } from "../core/types";
import { bytesToBase64, utf8 } from "../internal/encoding";
import type { FetchLike } from "../internal/http";
import {
  type ConformanceCheck,
  changedSecret,
  check,
  checkBounceFields,
  cloneSample,
  decoder,
  defaultTamper,
  EVENT_TYPES,
  expectResult,
  expectVerifyFailure,
  fieldText,
  findLeak,
  flatten,
  headerValue,
  isRecord,
  randomToken,
  refusalCases,
  rejected,
  type SecretForm,
  sameField,
  sampleMessage,
  secretForms,
  toBytes,
  validResult,
  withCapturedConsole,
} from "./helpers";
import {
  type CapturedRequest,
  type EchoMode,
  echoFetch,
  type FetchMock,
  matches,
  mockFetch,
  type RecordedExchange,
  type RecordedHttpResponse,
  type RecordedResponse,
} from "./mock-fetch";
import { smtpConformanceChecks } from "./smtp-checks";
import type {
  AnyConformanceFixture,
  CheckEntry,
  CheckId,
  CheckReport,
  ConformanceFixture,
  RunChecksOptions,
  SmtpConformanceFixture,
  WebhookFixture,
  WebhookSample,
} from "./types";

export { type ConformanceCheck, sampleMessage } from "./helpers";

/** The ids of every check, in run order. */
export const CHECK_IDS: readonly CheckId[] = [
  "declaration",
  "declaration.tier",
  "send.ok",
  "send.auth",
  "send.invalid",
  "send.rate-limited",
  "send.uncertain",
  "send.headers",
  "send.idempotency",
  "idempotency.conflict",
  "attachments",
  "capability.refuse",
  "send.batch",
  "verify.ok",
  "verify.bad-key",
  "verify.server-error",
  "webhook.valid",
  "webhook.changed",
  "webhook.wrong-secret",
  "webhook.stale",
  "webhook.malformed",
  "events.parse",
  "redaction",
];

const TIMEOUT_MS = 1000;
const SERVER_ERRORS = [500, 502, 503, 504] as const;
const REDACTION_MODES: readonly EchoMode[] = [401, 403, 422, 429, 500, 503, "timeout", "network"];

const UNUSED: RecordedHttpResponse = { status: 599 };

/**
 * The HTTP view of an SMTP fixture, for the checks that read only the credentials and
 * the webhook fixture: the declaration check and the webhook checks.
 */
function sharedView(fixture: SmtpConformanceFixture): ConformanceFixture {
  return {
    credentials: fixture.credentials,
    ...(fixture.now === undefined ? {} : { now: fixture.now }),
    send: {
      request: { method: "POST", url: "https://smtp.invalid/" },
      success: UNUSED,
      authFailure: UNUSED,
      validationFailure: UNUSED,
      serverError: UNUSED,
    },
    verify: { ok: [], badKey: [] },
    ...(fixture.webhook === undefined ? {} : { webhook: fixture.webhook }),
  };
}

/**
 * Builds the checks for one adapter. Run each one with `run()`, or use `runChecks`. An
 * SMTP fixture (`transport: "smtp"`) gives the SMTP checks, in `SMTP_CHECK_IDS` order.
 */
export function conformanceChecks(
  adapter: ProviderAdapter,
  fixture: AnyConformanceFixture,
  options: RunChecksOptions,
): ConformanceCheck[] {
  if (fixture.transport === "smtp") {
    const shared = httpChecks(adapter, sharedView(fixture), options);
    return smtpConformanceChecks(adapter, fixture, options, shared);
  }
  return httpChecks(adapter, fixture, options);
}

function httpChecks(
  adapter: ProviderAdapter,
  fixture: ConformanceFixture,
  options: RunChecksOptions,
): ConformanceCheck[] {
  const meta: Partial<ProviderMeta> = isRecord(adapter.meta) ? adapter.meta : {};
  const caps: Partial<Capabilities> = isRecord(meta.capabilities) ? meta.capabilities : {};
  const statusMap = isRecord(meta.statusMap) ? meta.statusMap : {};
  const native = meta.nativeIdempotency === true;
  const hooks = adapter.webhooks;
  const hasHooks = meta.webhooks === true || hooks !== undefined;
  const now = fixture.now ?? Date.now();
  const tier: ProviderTier = options.tier;
  const fields: readonly CredentialField[] = Array.isArray(meta.credentialFields)
    ? meta.credentialFields
    : [];

  function context(fetcher: FetchLike, credentials = fixture.credentials): SendContext {
    return { fetch: fetcher, timeoutMs: TIMEOUT_MS, credentials, now };
  }

  function sendExchange(response: RecordedResponse, label: string): RecordedExchange[] {
    const { method, url } = fixture.send.request;
    return [{ label, method, url, response }];
  }

  function noStrays(mock: FetchMock, problems: string[], where: string): void {
    for (const call of mock.unmatched) {
      problems.push(`${where}: the fixture records no exchange for ${call.method} ${call.url}.`);
    }
  }

  async function send(
    response: RecordedResponse,
    message: OutgoingMessage = sampleMessage(),
  ): Promise<{ result: SendResult; mock: FetchMock }> {
    const mock = mockFetch(sendExchange(response, "conformance send"));
    const result = await adapter.send(message, context(mock.fetch));
    return { result, mock };
  }

  // Webhook helpers.

  function needHooks(problems: string[]): { webhook: WebhookFixture } | null {
    if (!hooks) {
      problems.push("meta.webhooks is true, but the adapter has no webhooks methods.");
      return null;
    }
    const webhook = fixture.webhook;
    if (!webhook) {
      problems.push("Add fixture.webhook. The adapter declares webhooks.");
      return null;
    }
    if (webhook.samples.length === 0) {
      problems.push("Add at least one sample to fixture.webhook.samples.");
      return null;
    }
    return { webhook };
  }

  async function verifyHook(
    webhook: WebhookFixture,
    sample: WebhookSample,
    secret: string,
  ): Promise<WebhookVerifyResult> {
    const mock = mockFetch(webhook.exchanges ?? []);
    const input: WebhookVerifyInput = {
      headers: new Headers(sample.headers),
      body: sample.body.slice(),
      secret,
      now,
      fetch: mock.fetch,
    };
    return (hooks as NonNullable<typeof hooks>).verify(input);
  }

  function signFirst(webhook: WebhookFixture, at = now, secret = webhook.secret) {
    const first = webhook.samples[0];
    return webhook.sign({ body: toBytes(first?.body ?? ""), secret, at });
  }

  async function validFirst(webhook: WebhookFixture, problems: string[]) {
    const sample = await signFirst(webhook);
    const result = await verifyHook(webhook, cloneSample(sample), webhook.secret);
    if (!result.ok) {
      problems.push(`The valid sample fails (${result.reason}), so this check proves nothing.`);
      return null;
    }
    return sample;
  }

  const noHooks = hasHooks ? undefined : "meta.webhooks is not true and the adapter has none.";
  const staleNa =
    noHooks ??
    (fixture.webhook?.staleAt === null
      ? "The fixture states that the provider signs no timestamp (webhook.staleAt is null)."
      : undefined);
  const refusals = refusalCases(caps);
  const secretFields = fields.filter((field) => field.secret);
  const redactionNa =
    secretFields.length === 0 && !hasHooks
      ? "meta declares no secret credential field and no webhooks."
      : undefined;

  return [
    check("declaration", "declares valid meta and adapter methods", (problems) => {
      if (!isRecord(adapter.meta)) {
        problems.push("The adapter has no meta.");
        return;
      }
      if (typeof meta.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(meta.id)) {
        problems.push("meta.id must be lowercase letters, digits, and hyphens.");
      }
      if (typeof meta.name !== "string" || meta.name.trim() === "") {
        problems.push("meta.name is empty.");
      }
      if (typeof meta.docsUrl !== "string" || !meta.docsUrl.startsWith("https://")) {
        problems.push("meta.docsUrl must be an https URL.");
      }
      if (fields.length === 0) problems.push("Declare at least one credential field.");
      const names = fields.map((field) => field.name);
      if (new Set(names).size !== names.length) problems.push("Credential field names repeat.");
      if (fields.length > 0 && !fields.some((field) => field.required)) {
        problems.push("At least one credential field must be required.");
      }
      for (const field of fields) {
        if (!field.label?.trim()) problems.push(`The field ${field.name} has no label.`);
        if (typeof field.secret !== "boolean") {
          problems.push(`The field ${field.name} must set secret.`);
        }
        if (field.pattern !== undefined) {
          try {
            new RegExp(field.pattern);
          } catch {
            problems.push(`The pattern of ${field.name} is not a regular expression.`);
          }
        }
      }
      if (fields.length > 0 && problems.length === 0) {
        const parsed = parseCredentials(meta as ProviderMeta, fixture.credentials);
        if (!parsed.ok) {
          for (const error of parsed.errors) {
            problems.push(`fixture.credentials fails ${error.field} (${error.code}).`);
          }
        }
      }
      for (const flag of ["attachments", "cc", "bcc", "replyTo", "customHeaders"] as const) {
        if (typeof caps[flag] !== "boolean") problems.push(`Set capabilities.${flag}.`);
      }
      if (typeof caps.idempotency !== "boolean") problems.push("Set capabilities.idempotency.");
      if (caps.idempotency !== meta.nativeIdempotency) {
        problems.push("nativeIdempotency and capabilities.idempotency must agree.");
      }
      if (!Number.isInteger(caps.batchSize) || (caps.batchSize as number) < 1) {
        problems.push("capabilities.batchSize must be a positive integer.");
      }
      const max = caps.maxMessageBytes;
      if (max !== null && !(Number.isInteger(max) && (max as number) > 0)) {
        problems.push("capabilities.maxMessageBytes must be null or a positive integer.");
      }
      const maxRecipients = caps.maxRecipients;
      if (maxRecipients !== undefined && !(Number.isInteger(maxRecipients) && maxRecipients > 0)) {
        problems.push("capabilities.maxRecipients must be a positive integer when it is set.");
      }
      if (typeof adapter.send !== "function") problems.push("send must be a function.");
      if (typeof adapter.verify !== "function") problems.push("verify must be a function.");
      if (adapter.sendBatch !== undefined && typeof adapter.sendBatch !== "function") {
        problems.push("sendBatch must be a function when it is set.");
      }
    }),

    check("declaration.tier", "keeps the promises of its declared tier", async (problems) => {
      if (meta.tier !== tier) {
        problems.push(`The declared tier is ${tier}, but meta.tier is ${String(meta.tier)}.`);
      }
      const tierTwo = tier === 2 || meta.tier === 2;
      for (const [key, entry] of Object.entries(statusMap)) {
        const code = Number(key);
        if (!isRecord(entry)) {
          problems.push(`The status map entry for ${key} is not an object.`);
          continue;
        }
        let source: URL | undefined;
        try {
          source = typeof entry.source === "string" ? new URL(entry.source) : undefined;
        } catch {
          source = undefined;
        }
        if (!source || (source.protocol !== "https:" && source.protocol !== "http:")) {
          problems.push(`The status map entry for ${key} has no source URL.`);
        }
        if (tierTwo && code >= 500 && entry.status === "not_sent") {
          problems.push(`A tier 2 provider must keep HTTP ${code} as unknown, not not_sent.`);
        }
      }
      if (meta.webhooks === true && !hooks) {
        problems.push("meta.webhooks is true, but the adapter has no webhooks methods.");
      }
      if (meta.webhooks !== true && hooks) {
        problems.push("The adapter has webhooks methods, but meta.webhooks is not true.");
      }
      for (const code of SERVER_ERRORS) {
        const override = tierTwo ? undefined : statusMap[code];
        const want = override?.status ?? "unknown";
        const { result, mock } = await send({ status: code, body: { message: "Server error." } });
        noStrays(mock, problems, `HTTP ${code}`);
        if (!validResult(result, `HTTP ${code}`, problems)) continue;
        if (result.status === want) continue;
        problems.push(
          tierTwo
            ? `A tier 2 provider must return unknown for HTTP ${code}, not ${result.status}.`
            : `HTTP ${code} gave ${result.status}. The status map gives ${want}.`,
        );
      }
    }),

    check("send.ok", "maps an accepted message to sent", async (problems) => {
      const { result, mock } = await send(fixture.send.success);
      noStrays(mock, problems, "send");
      if (mock.calls.length === 0) problems.push("send made no request.");
      expectResult(result, "send", problems, "sent");
      const want = fixture.send.providerMessageId;
      if (want !== undefined && result.status === "sent" && result.providerMessageId !== want) {
        problems.push(`providerMessageId is ${String(result.providerMessageId)}, not ${want}.`);
      }
    }),

    check("send.auth", "maps a wrong key to not_sent", async (problems) => {
      const { result, mock } = await send(fixture.send.authFailure);
      noStrays(mock, problems, "send");
      expectResult(result, "auth failure", problems, "not_sent", fixture.send.authReason ?? "auth");
    }),

    check("send.invalid", "maps a refused message to not_sent", async (problems) => {
      const { result, mock } = await send(fixture.send.validationFailure);
      noStrays(mock, problems, "send");
      const reason = fixture.send.validationReason ?? "invalid_message";
      expectResult(result, "validation failure", problems, "not_sent", reason);
    }),

    check(
      "send.rate-limited",
      "maps a throttle to not_sent with retryAfterMs",
      async (problems) => {
        const response: RecordedHttpResponse = fixture.send.rateLimited ?? {
          status: 429,
          headers: { "retry-after": "2" },
          body: { message: "Too many requests." },
        };
        const { result, mock } = await send(response);
        noStrays(mock, problems, "send");
        expectResult(result, "throttle", problems, "not_sent", "rate_limited");
        const header = headerValue(response.headers ?? {}, "retry-after");
        if (header !== undefined && /^\d+$/.test(header) && result.status === "not_sent") {
          const want = Number(header) * 1000;
          if (result.retryAfterMs !== want) {
            problems.push(
              `retryAfterMs is ${String(result.retryAfterMs)}. Retry-After gives ${want}.`,
            );
          }
        }
      },
    ),

    check(
      "send.uncertain",
      "maps a 5xx, a timeout, and a network error to unknown",
      async (problems) => {
        const server = await send(fixture.send.serverError);
        noStrays(server.mock, problems, "send");
        expectResult(server.result, "server error", problems, "unknown");
        const timeout = await send("timeout");
        expectResult(timeout.result, "timeout", problems, "unknown", "timeout");
        const network = await send("network");
        expectResult(network.result, "network error", problems, "unknown", "network");
      },
    ),

    check(
      "send.headers",
      "passes custom headers through unchanged",
      async (problems) => {
        const read = fixture.readHeaders;
        if (!read) {
          problems.push("Add fixture.readHeaders. The adapter declares customHeaders.");
          return;
        }
        const headers = {
          "X-Conformance-Check": "header-passthrough-1",
          "List-Unsubscribe": "<https://example.com/unsubscribe/1>",
        };
        const { result, mock } = await send(fixture.send.success, sampleMessage({ headers }));
        noStrays(mock, problems, "send");
        expectResult(result, "send", problems, "sent");
        const call = mock.calls.find((item) => matches(fixture.send.request, item));
        if (!call) {
          problems.push("send made no request to the send endpoint.");
          return;
        }
        const sent = read(call);
        for (const [name, value] of Object.entries(headers)) {
          const got = headerValue(sent, name);
          if (got !== value) problems.push(`The header ${name} is ${got ?? "(missing)"}.`);
        }
      },
      caps.customHeaders === true ? undefined : "meta.capabilities.customHeaders is false.",
    ),

    check(
      "send.idempotency",
      "sends the per-message key and the same bytes on a retry",
      async (problems) => {
        const key = "conformance-idempotency-key-1";
        const message = sampleMessage({ idempotencyKey: key });
        const first = await send(fixture.send.success, message);
        const second = await send(fixture.send.success, message);
        noStrays(first.mock, problems, "send");
        expectResult(first.result, "first send", problems, "sent");
        expectResult(second.result, "retry", problems, "sent");
        const calls = [...first.mock.calls, ...second.mock.calls];
        if (calls.length === 0) problems.push("send made no request.");
        const expected = fixture.expectedIdempotencyKey
          ? await fixture.expectedIdempotencyKey(key)
          : key;
        const readKey = fixture.readIdempotencyKey;
        for (const call of calls) {
          if (readKey) {
            const got = readKey(call);
            if (got !== expected) {
              problems.push(
                `The request to ${call.url} carries the key ${got ?? "(missing)"}, not ${expected}.`,
              );
            }
          } else if (![...call.headers.values()].includes(expected)) {
            problems.push(`The request to ${call.url} does not carry the key in a header.`);
          }
        }
        const bodies = (list: CapturedRequest[]) => list.map((call) => call.body);
        if (
          JSON.stringify(bodies(first.mock.calls)) !== JSON.stringify(bodies(second.mock.calls))
        ) {
          problems.push("A retry with the same key must send the same bytes.");
        }
        const plain = await send(fixture.send.success);
        for (const call of plain.mock.calls) {
          const carried = readKey
            ? readKey(call) !== undefined
            : [...call.headers.values()].includes(expected);
          if (carried) problems.push("A message without a key still carries a key.");
        }
      },
      native ? undefined : "meta.nativeIdempotency is false.",
    ),

    check(
      "idempotency.conflict",
      "keeps a key-conflict response unknown",
      async (problems) => {
        const conflict = fixture.send.keyConflict;
        if (!conflict) {
          problems.push("Add fixture.send.keyConflict. The provider has native idempotency.");
          return;
        }
        // The status map entry can be not_sent when the adapter reads the body to tell a
        // key conflict from another error of the same status. Only the result counts.
        const message = sampleMessage({ idempotencyKey: "conformance-conflict-key-1" });
        const { result, mock } = await send(conflict, message);
        noStrays(mock, problems, "send");
        if (!validResult(result, "key conflict", problems)) return;
        if (result.status !== "unknown") {
          problems.push(
            `A key conflict (HTTP ${conflict.status}) gave ${result.status}. It must be unknown. The earlier request may have sent.`,
          );
        }
      },
      native ? undefined : "meta.nativeIdempotency is false.",
    ),

    check(
      "attachments",
      "sends attachment bytes that match the input",
      async (problems) => {
        const read = fixture.readAttachments;
        if (!read) {
          problems.push("Add fixture.readAttachments. The adapter declares attachments.");
          return;
        }
        const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
        const note = bytesToBase64(utf8("Conformance attachment.\n"));
        const message = sampleMessage({
          attachments: [
            { filename: "bytes.bin", content: binary, contentType: "application/octet-stream" },
            { filename: "note.txt", content: note, contentType: "text/plain" },
          ],
        });
        const { result, mock } = await send(fixture.send.success, message);
        noStrays(mock, problems, "send");
        expectResult(result, "send", problems, "sent");
        const call = mock.calls.find((item) => matches(fixture.send.request, item));
        if (!call) {
          problems.push("send made no request to the send endpoint.");
          return;
        }
        const captured = read(call);
        const want = [
          { filename: "bytes.bin", content: bytesToBase64(binary) },
          { filename: "note.txt", content: note },
        ];
        for (const item of want) {
          const got = captured.find((entry) => entry.filename === item.filename);
          if (!got) {
            problems.push(`The request has no attachment ${item.filename}.`);
          } else if (got.content.replace(/\s+/g, "") !== item.content) {
            problems.push(`The bytes of ${item.filename} do not match the input.`);
          }
        }
      },
      caps.attachments === true ? undefined : "meta.capabilities.attachments is false.",
    ),

    check(
      "capability.refuse",
      "refuses an unsupported message with no network call",
      async (problems) => {
        for (const item of refusals) {
          const message = item.build();
          const expected = validateMessage(message, caps as Capabilities);
          if (expected.ok || expected.result.reason !== "unsupported") {
            problems.push(`The kit could not build a message with ${item.label}.`);
            continue;
          }
          const { result, mock } = await send(fixture.send.success, message);
          if (mock.calls.length > 0) {
            problems.push(
              `The adapter made ${mock.calls.length} request(s) for a message with ${item.label}. Refuse it before any network call.`,
            );
          }
          expectResult(result, `a message with ${item.label}`, problems, "not_sent", "unsupported");
        }
      },
      refusals.length > 0
        ? undefined
        : "meta declares every capability and no size or recipient limit.",
    ),

    check(
      "send.batch",
      "returns one result per message, in order",
      async (problems) => {
        const batch = fixture.send.batch;
        if (!batch) {
          problems.push("Add fixture.send.batch. The adapter has sendBatch.");
          return;
        }
        const messages = [sampleMessage(), sampleMessage({ to: ["second@example.org"] })];
        const mock = mockFetch([{ label: "batch", ...batch.request, response: batch.success }]);
        const results = await (adapter.sendBatch as NonNullable<typeof adapter.sendBatch>)(
          messages,
          context(mock.fetch),
        );
        noStrays(mock, problems, "sendBatch");
        if (!Array.isArray(results) || results.length !== messages.length) {
          problems.push(`sendBatch must return ${messages.length} results.`);
          return;
        }
        results.forEach((result, index) => {
          expectResult(result, `batch result ${index}`, problems, "sent");
        });
      },
      typeof adapter.sendBatch === "function" ? undefined : "The adapter has no sendBatch.",
    ),

    check("verify.ok", "accepts good credentials", async (problems) => {
      const mock = mockFetch(fixture.verify.ok);
      const result = await adapter.verify(context(mock.fetch));
      noStrays(mock, problems, "verify");
      const value: unknown = result;
      if (!isRecord(value)) problems.push("verify returned no result.");
      else if (value.ok !== true) {
        problems.push(`verify failed: ${String(value.status)}/${String(value.reason)}.`);
      }
    }),

    check("verify.bad-key", "rejects a wrong key as not_sent", async (problems) => {
      const mock = mockFetch(fixture.verify.badKey);
      const result = await adapter.verify(context(mock.fetch));
      noStrays(mock, problems, "verify");
      if (isRecord(result) && result.ok === true) {
        problems.push("verify accepted a wrong key.");
        return;
      }
      const reason = fixture.verify.badKeyReason ?? "auth";
      expectVerifyFailure(result, "verify with a wrong key", problems, "not_sent", reason);
    }),

    check(
      "verify.server-error",
      "reports a 5xx and a network error as unknown",
      async (problems) => {
        const down = fixture.verify.ok.map((exchange) => ({
          ...exchange,
          times: undefined,
          response: { status: 503, body: { message: "Service unavailable." } },
        }));
        const server = await adapter.verify(context(mockFetch(down).fetch));
        const override = tier === 2 || meta.tier === 2 ? undefined : statusMap[503];
        if (isRecord(server) && server.ok === true) problems.push("verify passed after HTTP 503.");
        else {
          const want = override?.status ?? "unknown";
          expectVerifyFailure(server, "verify after HTTP 503", problems, want);
        }
        const failing: FetchLike = async () => {
          throw new TypeError("Network connection lost.");
        };
        const network = await adapter.verify(context(failing));
        if (isRecord(network) && network.ok === true)
          problems.push("verify passed with no network.");
        else expectVerifyFailure(network, "verify with no network", problems, "unknown", "network");
      },
    ),

    check(
      "webhook.valid",
      "accepts a valid webhook",
      async (problems) => {
        const ready = needHooks(problems);
        if (ready) await validFirst(ready.webhook, problems);
      },
      noHooks,
    ),

    check(
      "webhook.changed",
      "rejects a changed body",
      async (problems) => {
        const ready = needHooks(problems);
        if (!ready) return;
        const sample = await validFirst(ready.webhook, problems);
        if (!sample) return;
        const body = (ready.webhook.tamper ?? defaultTamper)(sample.body.slice());
        if (decoder.decode(body) === decoder.decode(sample.body)) {
          problems.push("tamper did not change the body.");
          return;
        }
        const result = await verifyHook(
          ready.webhook,
          cloneSample(sample, body),
          ready.webhook.secret,
        );
        rejected(result, "a changed body", problems);
      },
      noHooks,
    ),

    check(
      "webhook.wrong-secret",
      "rejects a wrong secret and an empty secret",
      async (problems) => {
        const ready = needHooks(problems);
        if (!ready) return;
        const { webhook } = ready;
        const sample = await validFirst(webhook, problems);
        if (!sample) return;
        const wrong = webhook.wrongSecret ?? changedSecret(webhook.secret);
        if (wrong === webhook.secret) problems.push("wrongSecret is the same as secret.");
        rejected(await verifyHook(webhook, cloneSample(sample), wrong), "a wrong secret", problems);
        rejected(await verifyHook(webhook, cloneSample(sample), ""), "an empty secret", problems);
      },
      noHooks,
    ),

    check(
      "webhook.stale",
      "rejects a stale timestamp",
      async (problems) => {
        const ready = needHooks(problems);
        if (!ready) return;
        const { webhook } = ready;
        if (!(await validFirst(webhook, problems))) return;
        const at = webhook.staleAt as number;
        const sample = await signFirst(webhook, at);
        const result = await verifyHook(webhook, sample, webhook.secret);
        if (rejected(result, "a stale timestamp", problems) && !result.ok) {
          if (result.reason !== "stale") {
            problems.push(`A stale timestamp gave ${result.reason}. Expected stale.`);
          }
        }
      },
      staleNa,
    ),

    check(
      "webhook.malformed",
      "rejects missing headers, broken headers, and an empty body",
      async (problems) => {
        const ready = needHooks(problems);
        if (!ready) return;
        const { webhook } = ready;
        const sample = await validFirst(webhook, problems);
        if (!sample) return;
        const broken = new Headers();
        for (const [name] of sample.headers.entries()) broken.set(name, "malformed");
        const cases: [string, WebhookSample][] = [
          ["a request with no headers", { headers: new Headers(), body: sample.body.slice() }],
          ["a request with broken headers", { headers: broken, body: sample.body.slice() }],
          ["an empty body", { headers: new Headers(sample.headers), body: new Uint8Array(0) }],
        ];
        for (const [label, item] of cases) {
          rejected(await verifyHook(webhook, item, webhook.secret), label, problems);
        }
      },
      noHooks,
    ),

    check(
      "events.parse",
      "normalizes each sample to the expected events",
      async (problems) => {
        const ready = needHooks(problems);
        if (!ready) return;
        const { webhook } = ready;
        const parse = (hooks as NonNullable<typeof hooks>).parse;
        for (const item of webhook.samples) {
          const where = `"${item.label}"`;
          const sample = await webhook.sign({
            body: toBytes(item.body),
            secret: webhook.secret,
            at: now,
          });
          const verified = await verifyHook(webhook, cloneSample(sample), webhook.secret);
          if (!verified.ok) {
            problems.push(`${where} fails verification (${verified.reason}).`);
            continue;
          }
          const events = parse(sample.body.slice(), new Headers(sample.headers));
          const again = parse(sample.body.slice(), new Headers(sample.headers));
          if (!Array.isArray(events)) {
            problems.push(`${where}: parse must return an array.`);
            continue;
          }
          if (events.length !== item.expected.length) {
            problems.push(
              `${where} gave ${events.length} events. Expected ${item.expected.length}.`,
            );
            continue;
          }
          const keys = new Set<string>();
          events.forEach((event, index) => {
            const at = `${where} event ${index}`;
            if (!EVENT_TYPES.has(event.type))
              problems.push(`${at}: the type ${event.type} is unknown.`);
            if (event.provider !== meta.id) {
              problems.push(`${at}: provider is ${event.provider}, not ${String(meta.id)}.`);
            }
            if (typeof event.eventKey !== "string" || event.eventKey === "") {
              problems.push(`${at} has no eventKey.`);
            }
            if (again[index]?.eventKey !== event.eventKey) {
              problems.push(`${at}: the eventKey changes between two parses of one body.`);
            }
            keys.add(event.eventKey);
            if (typeof event.rawType !== "string" || event.rawType === "") {
              problems.push(`${at} has no rawType.`);
            }
            checkBounceFields(event, at, problems);
            if (event.occurredAt !== undefined && !Number.isFinite(event.occurredAt)) {
              problems.push(`${at}: occurredAt is not a finite number.`);
            }
            const want = item.expected[index] ?? { type: event.type };
            for (const [field, value] of Object.entries(want)) {
              const actual = (event as unknown as Record<string, unknown>)[field];
              if (!sameField(actual, value)) {
                problems.push(`${at}: ${field} is ${fieldText(actual)}, not ${fieldText(value)}.`);
              }
            }
          });
          if (keys.size !== events.length) problems.push(`${where} repeats an eventKey.`);
        }
      },
      noHooks,
    ),

    check(
      "redaction",
      "keeps credentials and webhook secrets out of results, errors, and logs",
      async (problems) => {
        const credentials: Record<string, string> = { ...fixture.credentials };
        const secrets: { name: string; value: string }[] = [];
        for (const field of fields) {
          if (field.options !== undefined) continue;
          const token = randomToken();
          const fallback = /^[A-Za-z]{1,10}[_-]/.exec(fixture.credentials[field.name] ?? "");
          const value = fixture.canary
            ? fixture.canary(field, token)
            : `${fallback?.[0] ?? ""}${token}`;
          if (!value.includes(token)) {
            problems.push(`The canary of ${field.name} must contain the token.`);
            continue;
          }
          if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) {
            problems.push(`The canary of ${field.name} breaks its pattern. Give fixture.canary.`);
            continue;
          }
          credentials[field.name] = value;
          if (field.secret) secrets.push({ name: field.name, value });
        }
        const values = Object.values(credentials);
        const forms = secrets.flatMap((secret) => secretForms(secret.name, secret.value, values));

        const outputs: { where: string; value: unknown }[] = [];
        let carried = false;
        const run = async (where: string, call: () => Promise<unknown>) => {
          try {
            outputs.push({ where, value: await call() });
          } catch (error) {
            outputs.push({ where: `${where} (thrown)`, value: error });
            problems.push(`${where}: the adapter threw. Return a result for a provider failure.`);
          }
        };

        const message = sampleMessage(native ? { idempotencyKey: "conformance-redaction-1" } : {});
        const webhookForms: SecretForm[] = [];
        await withCapturedConsole(outputs, async () => {
          for (const mode of REDACTION_MODES) {
            const label = typeof mode === "number" ? `HTTP ${mode}` : `a ${mode} error`;
            const sendMock = echoFetch(mode);
            await run(`send after ${label}`, () =>
              adapter.send(message, context(sendMock.fetch, credentials)),
            );
            const verifyMock = echoFetch(mode);
            await run(`verify after ${label}`, () =>
              adapter.verify(context(verifyMock.fetch, credentials)),
            );
            const calls = [...sendMock.calls, ...verifyMock.calls];
            if (typeof adapter.sendBatch === "function") {
              const batchMock = echoFetch(mode);
              const batch = adapter.sendBatch.bind(adapter);
              await run(`sendBatch after ${label}`, () =>
                batch([message], context(batchMock.fetch, credentials)),
              );
              calls.push(...batchMock.calls);
            }
            if (calls.some((call) => findLeak(flatten(call).join("\n"), forms))) carried = true;
          }

          const webhook = fixture.webhook;
          if (hooks && webhook && webhook.samples.length > 0) {
            webhookForms.push(...secretForms("webhook secret", webhook.secret, []));
            const sample = await signFirst(webhook);
            for (const [, value] of sample.headers.entries()) {
              if (value.length >= 16) webhookForms.push({ label: "expected signature", value });
            }
            const wrong = webhook.wrongSecret ?? changedSecret(webhook.secret);
            const tampered = (webhook.tamper ?? defaultTamper)(sample.body.slice());
            const paths: [string, () => Promise<WebhookSample>, string][] = [
              ["a wrong secret", async () => cloneSample(sample), wrong],
              ["an empty secret", async () => cloneSample(sample), ""],
              ["a changed body", async () => cloneSample(sample, tampered), webhook.secret],
              [
                "no headers",
                async () => ({ headers: new Headers(), body: sample.body }),
                webhook.secret,
              ],
            ];
            if (webhook.staleAt !== null) {
              const at = webhook.staleAt;
              paths.push(["a stale timestamp", () => signFirst(webhook, at), webhook.secret]);
            }
            for (const [label, build, secret] of paths) {
              const item = await build();
              await run(`webhook verify with ${label}`, () => verifyHook(webhook, item, secret));
            }
          }
        });

        if (forms.length > 0 && !carried) {
          problems.push(
            "No request carried a credential canary, so the check proves nothing. Send the credentials in the request.",
          );
        }
        for (const output of outputs) {
          const text = flatten(output.value).join("\n");
          const leak = findLeak(text, forms) ?? findLeak(text, webhookForms);
          if (leak) problems.push(`${output.where}: the output holds the ${leak.label}.`);
        }
      },
      redactionNa,
    ),
  ];
}

/** Runs every check and returns the report. It never throws for an adapter fault. */
export async function runChecks(input: {
  adapter: ProviderAdapter;
  fixture: AnyConformanceFixture;
  tier: ProviderTier;
}): Promise<CheckReport> {
  const checks: CheckEntry[] = [];
  for (const item of conformanceChecks(input.adapter, input.fixture, { tier: input.tier })) {
    checks.push({ id: item.id, title: item.title, ...(await item.run()) });
  }
  const provider = isRecord(input.adapter.meta) ? String(input.adapter.meta.id) : "";
  return {
    provider,
    tier: input.tier,
    ok: checks.every((entry) => entry.status !== "fail"),
    checks,
  };
}
