// The README webhook example, run as a test. Keep the handler below in step with the
// README. The README uses `D1DedupeStore(env.DB)`. This test uses the memory store.

import { expect, it } from "vitest";
import { toSendBounce } from "../../src/conformance/fixtures/tosend";
import { utf8 } from "../../src/internal/encoding";
import { tosend } from "../../src/providers/tosend/index";
import { toSendSignature } from "../../src/providers/tosend/webhooks";
import { MemoryDedupeStore } from "../../src/stores/memory";
import type { DedupeStore } from "../../src/stores/types";
import { handleWebhook } from "../../src/webhooks/index";

interface Env {
  TOSEND_WEBHOOK_SECRET: string;
  dedupe: DedupeStore;
  suppress(address: string): Promise<void>;
}

// --- README example start ---
async function onWebhook(request: Request, env: Env): Promise<Response> {
  const result = await handleWebhook(request, {
    adapter: tosend(),
    secret: env.TOSEND_WEBHOOK_SECRET,
    dedupe: env.dedupe,
  });
  // 401 bad signature, 413 too large, 409 in flight. toSend sends each event once with no
  // retries, so a refused event is lost. Check the toSend logs for it.
  if (!result.ok) return new Response(null, { status: result.status });
  try {
    for (const event of result.events) {
      if (event.type === "bounced" && event.bounce === "hard" && event.recipient) {
        await env.suppress(event.recipient);
      }
    }
  } catch {
    // Not handled, so no ack(). release() frees the event for a provider that retries.
    // toSend does not retry, so check its logs for this event.
    await result.release();
    return new Response(null, { status: 500 });
  }
  await result.ack();
  return new Response(null, { status: 200 });
}
// --- README example end ---

const SECRET = "tosend-webhook-secret-0123456789";

async function delivery(body: string): Promise<Request> {
  const bytes = utf8(body);
  return new Request("https://app.test/webhooks/tosend", {
    method: "POST",
    headers: { "x-tosend-signature": await toSendSignature(SECRET, bytes) },
    body: bytes,
  });
}

it("suppresses a hard bounce once, retries after a failure, and maps in_flight to 409", async () => {
  const suppressed: string[] = [];
  let fail = true;
  const env: Env = {
    TOSEND_WEBHOOK_SECRET: SECRET,
    dedupe: new MemoryDedupeStore(),
    async suppress(address) {
      if (fail) throw new Error("database down");
      suppressed.push(address);
    },
  };
  const body = toSendBounce("ana@example.org");

  // The handler fails: no ack(), a non-2xx status, and the key is free again.
  expect((await onWebhook(await delivery(body), env)).status).toBe(500);
  fail = false;
  expect((await onWebhook(await delivery(body), env)).status).toBe(200);
  expect(suppressed).toEqual(["ana@example.org"]);

  // A replay after ack() is a duplicate: 200, and nothing is suppressed again.
  expect((await onWebhook(await delivery(body), env)).status).toBe(200);
  expect(suppressed).toEqual(["ana@example.org"]);

  // A second delivery that arrives while the first one holds the lease gets 409.
  let finish: () => void = () => undefined;
  const slow: Env = {
    ...env,
    dedupe: new MemoryDedupeStore(),
    suppress: () => new Promise<void>((resolve) => (finish = resolve)),
  };
  const other = toSendBounce("bo@example.org");
  const first = onWebhook(await delivery(other), slow);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await onWebhook(await delivery(other), slow)).status).toBe(409);
  finish();
  expect((await first).status).toBe(200);

  // A bad signature gets 401.
  const forged = new Request("https://app.test/webhooks/tosend", {
    method: "POST",
    headers: { "x-tosend-signature": `sha256=${"0".repeat(64)}` },
    body,
  });
  expect((await onWebhook(forged, env)).status).toBe(401);
});
