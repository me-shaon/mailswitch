// The SMTP form of the conformance kit. An SMTP adapter talks to the mock SMTP server
// through `SendContext.connect`, so the HTTP exchanges of `ConformanceFixture` do not
// apply. These checks keep the ids of the HTTP checks where the meaning is the same,
// and add three SMTP checks:
// - smtp.before-data: every failure before the 354 to DATA is `not_sent`.
// - smtp.tls: no AUTH and no message on a plain connection, unless the fixture is plain.
// - smtp.dot-stuffing: a line that starts with a dot reaches the server unchanged.
//
// The declaration and webhook checks are the HTTP ones: they read only the credentials
// and the webhook fixture. checks.ts passes them in.

import type {
  ProviderAdapter,
  SendContext,
  WebhookVerifyInput,
  WebhookVerifyResult,
} from "../core/adapter";
import type { ProviderMeta, ProviderTier } from "../core/meta";
import type { SocketConnect } from "../core/socket";
import type { Capabilities, FailureReason, OutgoingMessage, SendResult } from "../core/types";
import { bytesToBase64, utf8 } from "../internal/encoding";
import type { FetchLike } from "../internal/http";
import {
  base64Text,
  type ConformanceCheck,
  changedSecret,
  check,
  cloneSample,
  defaultTamper,
  expectResult,
  expectVerifyFailure,
  findLeak,
  flatten,
  isRecord,
  randomToken,
  refusalCases,
  type SecretForm,
  sampleMessage,
  secretForms,
  toBytes,
  validResult,
  withCapturedConsole,
} from "./helpers";
import {
  type MockReply,
  type MockSmtp,
  type MockSmtpOptions,
  mockSmtp,
  parseMail,
} from "./mock-smtp";
import type {
  CheckId,
  RunChecksOptions,
  SmtpConformanceFixture,
  SmtpReplies,
  WebhookSample,
} from "./types";

/** The ids of every SMTP check, in run order. */
export const SMTP_CHECK_IDS: readonly CheckId[] = [
  "declaration",
  "declaration.tier",
  "send.ok",
  "send.auth",
  "send.invalid",
  "send.rate-limited",
  "send.uncertain",
  "smtp.before-data",
  "smtp.tls",
  "smtp.dot-stuffing",
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

/** The checks that come from the HTTP form unchanged. */
const SHARED: ReadonlySet<CheckId> = new Set<CheckId>([
  "declaration",
  "webhook.valid",
  "webhook.changed",
  "webhook.wrong-secret",
  "webhook.stale",
  "webhook.malformed",
  "events.parse",
]);

const TIMEOUT_MS = 1000;
/** The read timeout of the timeout cases, so the suite stays fast. */
const SHORT_TIMEOUT_MS = 40;

const DEFAULT_REPLIES: Required<SmtpReplies> = {
  authFailure: "535 5.7.8 Authentication credentials invalid",
  recipientRejected: "550 5.1.1 The email account that you tried to reach does not exist",
  recipientRejectedReason: "rejected",
  rateLimited: "421 4.7.0 Try again later, closing connection",
  afterData: "451 4.3.0 Mail server temporarily rejected message",
};

type ReplyFn = NonNullable<MockSmtpOptions["reply"]>;

/** Answers one verb with a fixed reply. */
function on(verb: string, answer: MockReply): ReplyFn {
  return (command) => (command.verb === verb ? answer : undefined);
}

const failingConnect: SocketConnect = () => {
  throw new TypeError("connect failed: the host is not reachable.");
};

const noFetch: FetchLike = async () => {
  throw new TypeError("An SMTP adapter must not make HTTP requests.");
};

function commandsOf(mock: MockSmtp): string[] {
  return mock.sessions.flatMap((session) => session.commands);
}

function hasVerb(mock: MockSmtp, verb: string): boolean {
  return commandsOf(mock).some((line) => line.toUpperCase().startsWith(verb));
}

/** Builds the SMTP checks. `shared` holds the HTTP checks with the same meaning. */
export function smtpConformanceChecks(
  adapter: ProviderAdapter,
  fixture: SmtpConformanceFixture,
  options: RunChecksOptions,
  shared: readonly ConformanceCheck[],
): ConformanceCheck[] {
  const meta: Partial<ProviderMeta> = isRecord(adapter.meta) ? adapter.meta : {};
  const caps: Partial<Capabilities> = isRecord(meta.capabilities) ? meta.capabilities : {};
  const statusMap = isRecord(meta.statusMap) ? meta.statusMap : {};
  const hooks = adapter.webhooks;
  const now = fixture.now ?? Date.now();
  const tier: ProviderTier = options.tier;
  const replies: Required<SmtpReplies> = { ...DEFAULT_REPLIES, ...fixture.replies };
  const plaintext = fixture.plaintext === true;

  function server(reply?: ReplyFn, extra: Partial<MockSmtpOptions> = {}): MockSmtp {
    const login = fixture.server;
    return mockSmtp({
      username: login.username,
      password: login.password,
      ...(login.authMechanisms === undefined ? {} : { authMechanisms: login.authMechanisms }),
      ...extra,
      ...(reply === undefined ? {} : { reply }),
    });
  }

  function context(
    connect: SocketConnect,
    credentials: Readonly<Record<string, string>> = fixture.credentials,
    timeoutMs: number = TIMEOUT_MS,
  ): SendContext {
    return { fetch: noFetch, timeoutMs, credentials, now, connect };
  }

  async function send(
    reply?: ReplyFn,
    message: OutgoingMessage = sampleMessage(),
    timeoutMs: number = TIMEOUT_MS,
    extra: Partial<MockSmtpOptions> = {},
  ): Promise<{ result: SendResult; mock: MockSmtp }> {
    const mock = server(reply, extra);
    const result = await adapter.send(
      message,
      context(mock.connect, fixture.credentials, timeoutMs),
    );
    return { result, mock };
  }

  /** The plain-text rules for every session of a mock. */
  function safe(mock: MockSmtp, where: string, problems: string[]): void {
    if (plaintext) return;
    if (mock.sessions.some((session) => session.authOverPlaintext)) {
      problems.push(`${where}: AUTH went over a plain-text connection.`);
    }
    if (mock.messages.some((message) => !message.secure)) {
      problems.push(`${where}: a message went over a plain-text connection.`);
    }
  }

  const fromShared = (id: CheckId): ConformanceCheck => {
    const found = shared.find((item) => item.id === id);
    return (
      found ??
      check(id, id, (problems) => {
        problems.push(`The kit has no shared check ${id}.`);
      })
    );
  };

  const refusals = refusalCases(caps);
  const noIdempotency = "SMTP has no idempotency key.";

  const checks: ConformanceCheck[] = [
    check("declaration.tier", "keeps the promises of its declared tier", (problems) => {
      if (meta.tier !== tier) {
        problems.push(`The declared tier is ${tier}, but meta.tier is ${String(meta.tier)}.`);
      }
      for (const [key, entry] of Object.entries(statusMap)) {
        if (
          !isRecord(entry) ||
          typeof entry.source !== "string" ||
          !/^https?:\/\//.test(entry.source)
        ) {
          problems.push(`The status map entry for ${key} has no source URL.`);
        }
      }
      if (meta.nativeIdempotency !== false) {
        problems.push("SMTP has no idempotency key. Set nativeIdempotency to false.");
      }
      if (meta.webhooks === true && !hooks) {
        problems.push("meta.webhooks is true, but the adapter has no webhooks methods.");
      }
      if (meta.webhooks !== true && hooks) {
        problems.push("The adapter has webhooks methods, but meta.webhooks is not true.");
      }
    }),

    check("send.ok", "maps a 250 to the final dot to sent", async (problems) => {
      const { result, mock } = await send();
      expectResult(result, "send", problems, "sent");
      if (mock.sessions.length === 0) problems.push("send opened no connection.");
      if (mock.messages.length !== 1) {
        problems.push(`The server got ${mock.messages.length} messages. Expected 1.`);
      } else if (!mock.messages[0]?.to.includes("recipient@example.org")) {
        problems.push("The envelope does not name the recipient.");
      }
      if (result.status === "sent") {
        const want = fixture.providerMessageId;
        if (typeof result.providerMessageId !== "string" || result.providerMessageId === "") {
          problems.push("A sent result needs a providerMessageId.");
        } else if (want !== undefined && result.providerMessageId !== want) {
          problems.push(`providerMessageId is ${result.providerMessageId}, not ${want}.`);
        }
      }
      safe(mock, "send", problems);
    }),

    check("send.auth", "maps a refused login to not_sent/auth", async (problems) => {
      const { result, mock } = await send(on("AUTH", replies.authFailure));
      expectResult(result, "auth failure", problems, "not_sent", "auth");
      if (!hasVerb(mock, "AUTH")) problems.push("send wrote no AUTH command.");
      if (hasVerb(mock, "MAIL")) problems.push("send wrote MAIL FROM after a refused login.");
    }),

    check("send.invalid", "maps a refused recipient to not_sent", async (problems) => {
      const { result, mock } = await send(on("RCPT", replies.recipientRejected));
      const reason: FailureReason = replies.recipientRejectedReason;
      expectResult(result, "refused recipient", problems, "not_sent", reason);
      if (hasVerb(mock, "DATA")) problems.push("send wrote DATA after a refused recipient.");
    }),

    check("send.rate-limited", "maps a throttle to not_sent/rate_limited", async (problems) => {
      const { result } = await send(on("MAIL", replies.rateLimited));
      expectResult(result, "throttle", problems, "not_sent", "rate_limited");
    }),

    check("send.uncertain", "maps a failure after the 354 to unknown", async (problems) => {
      const refused = await send(on("DATA_END", replies.afterData));
      expectResult(refused.result, "a refusal of the final dot", problems, "unknown");
      const dropped = await send(on("DATA_END", "disconnect"));
      expectResult(dropped.result, "a drop after the final dot", problems, "unknown", "network");
      const silent = await send(on("DATA_END", "timeout"), sampleMessage(), SHORT_TIMEOUT_MS);
      expectResult(silent.result, "no reply to the final dot", problems, "unknown", "timeout");
    }),

    check("smtp.before-data", "maps every failure before the 354 to not_sent", async (problems) => {
      const failed = await adapter.send(sampleMessage(), context(failingConnect));
      expectResult(failed, "a failed connect", problems, "not_sent", "network");
      const cases: [string, ReplyFn, number][] = [
        ["a drop before the greeting", on("CONNECT", "disconnect"), TIMEOUT_MS],
        ["a refused greeting", on("CONNECT", "554 5.3.2 No service here"), TIMEOUT_MS],
        ["a drop at RCPT TO", on("RCPT", "disconnect"), TIMEOUT_MS],
        ["no reply to MAIL FROM", on("MAIL", "timeout"), SHORT_TIMEOUT_MS],
        ["a refused DATA command", on("DATA", "554 5.7.1 Message refused"), TIMEOUT_MS],
      ];
      for (const [label, reply, timeout] of cases) {
        const { result, mock } = await send(reply, sampleMessage(), timeout);
        expectResult(result, label, problems, "not_sent");
        if (mock.messages.length > 0) problems.push(`${label}: the server got a message.`);
      }
    }),

    check(
      "smtp.tls",
      "sends AUTH and the message only over TLS",
      async (problems) => {
        const { result, mock } = await send();
        expectResult(result, "send", problems, "sent");
        safe(mock, "send", problems);
        const mode = mock.sessions[0]?.target.secureTransport;
        if (mode === "off") {
          problems.push("The fixture connects in plain text. Set plaintext: true, or use TLS.");
          return;
        }
        if (mode !== "starttls") return;
        const missing = await send(undefined, sampleMessage(), TIMEOUT_MS, {
          starttls: false,
          authBeforeTls: true,
        });
        const refused = await send(on("STARTTLS", "454 4.7.0 TLS not available"));
        for (const [label, item] of [
          ["a server without STARTTLS", missing],
          ["a refused STARTTLS", refused],
        ] as const) {
          expectResult(item.result, label, problems, "not_sent");
          if (hasVerb(item.mock, "AUTH")) problems.push(`${label}: the adapter wrote AUTH.`);
          if (hasVerb(item.mock, "MAIL")) problems.push(`${label}: the adapter wrote MAIL FROM.`);
        }
      },
      plaintext ? "The fixture connects in plain text (plaintext is true)." : undefined,
    ),

    check("smtp.dot-stuffing", "escapes a line that starts with a dot", async (problems) => {
      const text = ".a line with a leading dot\n.\n..two dots\nend";
      const { result, mock } = await send(undefined, sampleMessage({ text }));
      expectResult(result, "send", problems, "sent");
      const message = mock.messages[0];
      if (!message) {
        problems.push("The server got no message.");
        return;
      }
      const stuffed = message.data
        .split("\r\n")
        .map((line) => (line.startsWith(".") ? `.${line}` : line))
        .join("\r\n");
      if (message.wire !== stuffed) problems.push("The DATA bytes are not dot-stuffed.");
      if (parseMail(message.data).text !== text.replaceAll("\n", "\r\n")) {
        problems.push("The text body did not arrive unchanged.");
      }
    }),

    check(
      "send.headers",
      "passes custom headers through unchanged",
      async (problems) => {
        const headers = {
          "X-Conformance-Check": "header-passthrough-1",
          "List-Unsubscribe": "<https://example.com/unsubscribe/1>",
        };
        const { result, mock } = await send(undefined, sampleMessage({ headers }));
        expectResult(result, "send", problems, "sent");
        const message = mock.messages[0];
        if (!message) {
          problems.push("The server got no message.");
          return;
        }
        const got = parseMail(message.data).headers;
        for (const [name, value] of Object.entries(headers)) {
          const actual = got.get(name.toLowerCase());
          if (actual !== value) problems.push(`The header ${name} is ${actual ?? "(missing)"}.`);
        }
      },
      caps.customHeaders === true ? undefined : "meta.capabilities.customHeaders is false.",
    ),

    check("send.idempotency", "sends the per-message key", () => {}, noIdempotency),
    check("idempotency.conflict", "keeps a key conflict unknown", () => {}, noIdempotency),

    check(
      "attachments",
      "sends valid MIME with attachment bytes that match the input",
      async (problems) => {
        const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
        const note = bytesToBase64(utf8("Conformance attachment.\n"));
        const message = sampleMessage({
          attachments: [
            { filename: "bytes.bin", content: binary, contentType: "application/octet-stream" },
            { filename: "note.txt", content: note, contentType: "text/plain" },
          ],
        });
        const { result, mock } = await send(undefined, message);
        expectResult(result, "send", problems, "sent");
        const sent = mock.messages[0];
        if (!sent) {
          problems.push("The server got no message.");
          return;
        }
        if (!/^multipart\/mixed;/im.test(parseMail(sent.data).headers.get("content-type") ?? "")) {
          problems.push("A message with attachments must be multipart/mixed.");
        }
        if (sent.data.split("\r\n").some((line) => line.length > 998)) {
          problems.push("A line is longer than 998 characters.");
        }
        if (/[^\r]\n|\r[^\n]/.test(sent.data)) problems.push("A line break is not CRLF.");
        const captured = parseMail(sent.data).attachments;
        const want = [
          { filename: "bytes.bin", content: bytesToBase64(binary) },
          { filename: "note.txt", content: note },
        ];
        for (const item of want) {
          const got = captured.find((entry) => entry.filename === item.filename);
          if (!got) problems.push(`The message has no attachment ${item.filename}.`);
          else if (got.content !== item.content) {
            problems.push(`The bytes of ${item.filename} do not match the input.`);
          }
        }
      },
      caps.attachments === true ? undefined : "meta.capabilities.attachments is false.",
    ),

    check(
      "capability.refuse",
      "refuses an unsupported message with no connection",
      async (problems) => {
        for (const item of refusals) {
          const { result, mock } = await send(undefined, item.build());
          if (mock.sessions.length > 0) {
            problems.push(
              `The adapter connected for a message with ${item.label}. Refuse it first.`,
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
        const messages = [sampleMessage(), sampleMessage({ to: ["second@example.org"] })];
        const mock = server();
        const batch = (adapter.sendBatch as NonNullable<typeof adapter.sendBatch>).bind(adapter);
        const results = await batch(messages, context(mock.connect));
        if (!Array.isArray(results) || results.length !== messages.length) {
          problems.push(`sendBatch must return ${messages.length} results.`);
          return;
        }
        results.forEach((result, index) => {
          expectResult(result, `batch result ${index}`, problems, "sent");
        });
        const order = mock.messages.map((message) => message.to.join(","));
        if (order.join(" ") !== "recipient@example.org second@example.org") {
          problems.push("The server did not get the messages in order.");
        }
        safe(mock, "sendBatch", problems);
      },
      typeof adapter.sendBatch === "function" ? undefined : "The adapter has no sendBatch.",
    ),

    check("verify.ok", "accepts good credentials and sends no message", async (problems) => {
      const mock = server();
      const result = await adapter.verify(context(mock.connect));
      const value: unknown = result;
      if (!isRecord(value)) problems.push("verify returned no result.");
      else if (value.ok !== true) {
        problems.push(`verify failed: ${String(value.status)}/${String(value.reason)}.`);
      }
      if (hasVerb(mock, "MAIL") || mock.messages.length > 0)
        problems.push("verify sent a message.");
      safe(mock, "verify", problems);
    }),

    check("verify.bad-key", "rejects a refused login as not_sent/auth", async (problems) => {
      const mock = server(on("AUTH", replies.authFailure));
      const result = await adapter.verify(context(mock.connect));
      if (isRecord(result) && result.ok === true) {
        problems.push("verify accepted a refused login.");
        return;
      }
      expectVerifyFailure(result, "verify with a refused login", problems, "not_sent", "auth");
    }),

    check(
      "verify.server-error",
      "reports a failed connect and a refused greeting as a failure",
      async (problems) => {
        const failed = await adapter.verify(context(failingConnect));
        if (failed.ok) problems.push("verify passed with no server.");
        else if (validResult(failed, "verify with no server", problems)) {
          if (failed.reason !== "network") {
            problems.push(`verify with no server gave ${failed.reason}. Expected network.`);
          }
        }
        const mock = server(on("CONNECT", "421 4.3.2 Service not available"));
        const down = await adapter.verify(context(mock.connect));
        if (isRecord(down) && down.ok === true)
          problems.push("verify passed after a 421 greeting.");
        else validResult(down, "verify after a 421 greeting", problems);
      },
    ),

    redaction(),
  ];

  /** The redaction check: no password, AUTH line, or webhook secret in any output. */
  function redaction(): ConformanceCheck {
    return check(
      "redaction",
      "keeps the password, AUTH lines, and webhook secrets out of results, errors, and logs",
      async (problems) => {
        const user = randomToken();
        const pass = randomToken();
        const credentials = fixture.canaryCredentials(user, pass);
        const forms: SecretForm[] = [
          ...secretForms("password", pass, [user]),
          { label: "AUTH PLAIN token", value: base64Text(`\0${user}\0${pass}`) },
          { label: "base64 user name", value: base64Text(user) },
        ];
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
        const modes: [string, ReplyFn | undefined, number][] = [
          ["an accepted message", undefined, TIMEOUT_MS],
          ["a refused login", on("AUTH", replies.authFailure), TIMEOUT_MS],
          ["a drop at AUTH", on("AUTH", "disconnect"), TIMEOUT_MS],
          ["a refused sender", on("MAIL", "550 5.7.1 Sender not allowed"), TIMEOUT_MS],
          ["no reply to RCPT TO", on("RCPT", "timeout"), SHORT_TIMEOUT_MS],
          ["a refused final dot", on("DATA_END", replies.afterData), TIMEOUT_MS],
          ["a drop after the final dot", on("DATA_END", "disconnect"), TIMEOUT_MS],
        ];
        const webhookForms: SecretForm[] = [];
        await withCapturedConsole(outputs, async () => {
          for (const [label, reply, timeout] of modes) {
            const mocks: MockSmtp[] = [];
            const mock = (): MockSmtp => {
              const item = mockSmtp({
                username: user,
                password: pass,
                ...(fixture.server.authMechanisms === undefined
                  ? {}
                  : { authMechanisms: fixture.server.authMechanisms }),
                ...(reply === undefined ? {} : { reply }),
              });
              mocks.push(item);
              return item;
            };
            const message = sampleMessage();
            const sendMock = mock();
            await run(`send after ${label}`, () =>
              adapter.send(message, context(sendMock.connect, credentials, timeout)),
            );
            const verifyMock = mock();
            await run(`verify after ${label}`, () =>
              adapter.verify(context(verifyMock.connect, credentials, timeout)),
            );
            if (typeof adapter.sendBatch === "function") {
              const batchMock = mock();
              const batch = adapter.sendBatch.bind(adapter);
              await run(`sendBatch after ${label}`, () =>
                batch([message], context(batchMock.connect, credentials, timeout)),
              );
            }
            for (const item of mocks) {
              if (findLeak(commandsOf(item).join("\n"), forms)) carried = true;
            }
          }
          if (hooks && fixture.webhook && fixture.webhook.samples.length > 0) {
            await webhookPaths(run, webhookForms);
          }
        });
        if (!carried) {
          problems.push(
            "No AUTH command carried the canary login, so the check proves nothing. Use canaryCredentials in the credentials.",
          );
        }
        for (const output of outputs) {
          const text = flatten(output.value).join("\n");
          const leak = findLeak(text, forms) ?? findLeak(text, webhookForms);
          if (leak) problems.push(`${output.where}: the output holds the ${leak.label}.`);
        }
      },
    );
  }

  /** Runs the failing webhook paths for the redaction check. */
  async function webhookPaths(
    run: (where: string, call: () => Promise<unknown>) => Promise<void>,
    forms: SecretForm[],
  ): Promise<void> {
    const webhook = fixture.webhook;
    const verifyHooks = hooks?.verify.bind(hooks);
    if (!webhook || !verifyHooks) return;
    const verify = (sample: WebhookSample, secret: string): Promise<WebhookVerifyResult> => {
      const input: WebhookVerifyInput = {
        headers: new Headers(sample.headers),
        body: sample.body.slice(),
        secret,
        now,
        fetch: noFetch,
      };
      return verifyHooks(input);
    };
    forms.push(...secretForms("webhook secret", webhook.secret, []));
    const first = toBytes(webhook.samples[0]?.body ?? "");
    const sample = await webhook.sign({ body: first, secret: webhook.secret, at: now });
    for (const [, value] of sample.headers.entries()) {
      if (value.length >= 16) forms.push({ label: "expected signature", value });
    }
    const wrong = webhook.wrongSecret ?? changedSecret(webhook.secret);
    const tampered = (webhook.tamper ?? defaultTamper)(sample.body.slice());
    const paths: [string, () => Promise<WebhookSample>, string][] = [
      ["a wrong secret", async () => cloneSample(sample), wrong],
      ["an empty secret", async () => cloneSample(sample), ""],
      ["a changed body", async () => cloneSample(sample, tampered), webhook.secret],
      ["no headers", async () => ({ headers: new Headers(), body: sample.body }), webhook.secret],
    ];
    if (webhook.staleAt !== null) {
      const at = webhook.staleAt;
      paths.push([
        "a stale timestamp",
        () => webhook.sign({ body: first, secret: webhook.secret, at }),
        webhook.secret,
      ]);
    }
    for (const [label, build, secret] of paths) {
      const item = await build();
      await run(`webhook verify with ${label}`, () => verify(item, secret));
    }
  }

  const byId = new Map(checks.map((item) => [item.id, item]));
  return SMTP_CHECK_IDS.map((id) =>
    SHARED.has(id) ? fromShared(id) : (byId.get(id) ?? fromShared(id)),
  );
}
