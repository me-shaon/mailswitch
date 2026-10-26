import { describe, expect, it } from "vitest";
import {
  beginIdempotency,
  finalState,
  minPendingTimeout,
  namespacedKey,
} from "../../src/core/idempotency";
import { payloadHash } from "../../src/core/payload-hash";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64 } from "../../src/internal/encoding";
import { MemoryIdempotencyStore } from "../../src/stores/memory";
import { idempotencyStoreSuite } from "../stores/store-suite";

idempotencyStoreSuite("memory", async () => {
  const store = new MemoryIdempotencyStore();
  return { store, rawRow: (key) => store.get(key) };
});

const base: OutgoingMessage = {
  from: "billing@acme.test",
  to: ["ana@example.com"],
  subject: "Hi",
  text: "Body",
  headers: { "X-A": "1", "X-B": "2" },
  attachments: [
    { filename: "a.pdf", contentType: "application/pdf", content: new Uint8Array([9]) },
  ],
  idempotencyKey: "k1",
};

describe("payloadHash", () => {
  it("is stable and ignores the idempotency key and the header order", async () => {
    const hash = await payloadHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await payloadHash({ ...base, idempotencyKey: "k2" })).toBe(hash);
    expect(await payloadHash({ ...base, headers: { "x-b": "2", "X-A": "1" } })).toBe(hash);
  });

  it("gives the same digest for base64 text and raw bytes", async () => {
    const bytes = new Uint8Array([1, 2, 250]);
    const raw = { ...base, attachments: [{ filename: "a", contentType: "a/b", content: bytes }] };
    const text = {
      ...base,
      attachments: [{ filename: "a", contentType: "a/b", content: bytesToBase64(bytes) }],
    };
    expect(await payloadHash(raw)).toBe(await payloadHash(text));
  });

  it("changes when any covered field changes", async () => {
    const hash = await payloadHash(base);
    const variants: OutgoingMessage[] = [
      { ...base, from: "other@acme.test" },
      { ...base, to: ["bob@example.com"] },
      { ...base, cc: ["ana@example.com"] },
      { ...base, bcc: ["ana@example.com"] },
      { ...base, replyTo: "ana@example.com" },
      { ...base, subject: "Hi!" },
      { ...base, html: "<p>Body</p>" },
      { ...base, text: "Body2" },
      { ...base, headers: { "X-A": "1" } },
      {
        ...base,
        attachments: [
          { filename: "a.pdf", contentType: "application/pdf", content: new Uint8Array([8]) },
        ],
      },
      {
        ...base,
        attachments: [
          { filename: "b.pdf", contentType: "application/pdf", content: new Uint8Array([9]) },
        ],
      },
      {
        ...base,
        attachments: [
          {
            filename: "a.pdf",
            contentType: "application/pdf",
            contentId: "logo",
            content: new Uint8Array([9]),
          },
        ],
      },
    ];
    const hashes = await Promise.all(variants.map(payloadHash));
    expect(new Set([hash, ...hashes]).size).toBe(variants.length + 1);
  });
});

describe("finalState", () => {
  it("prefers sent, then unknown, then not_sent", () => {
    expect(finalState([])).toBe("not_sent");
    expect(finalState([{ provider: "a", status: "not_sent", at: 1 }])).toBe("not_sent");
    expect(
      finalState([
        { provider: "a", status: "unknown", at: 1 },
        { provider: "b", status: "not_sent", at: 2 },
      ]),
    ).toBe("unknown");
    expect(
      finalState([
        { provider: "a", status: "unknown", at: 1 },
        { provider: "b", status: "sent", at: 2 },
      ]),
    ).toBe("sent");
  });
});

describe("guard helpers", () => {
  it("computes the pending timeout floor", () => {
    expect(minPendingTimeout(30_000, 3)).toBe(90_000);
    expect(minPendingTimeout(30_000, 0)).toBe(30_000);
  });

  it("namespaces the key and refuses a bad namespace", () => {
    expect(namespacedKey("plainbooks", "inv-1")).toBe("plainbooks:inv-1");
    expect(() => namespacedKey("", "k")).toThrow(TypeError);
    expect(() => namespacedKey("a:b", "k")).toThrow(TypeError);
  });

  it("keeps namespaces apart", async () => {
    const store = new MemoryIdempotencyStore();
    const a = await beginIdempotency(store, "one", base);
    const b = await beginIdempotency(store, "two", base);
    expect(a.proceed && b.proceed).toBe(true);
  });

  it("throws for a message with no idempotency key", async () => {
    const store = new MemoryIdempotencyStore();
    const { idempotencyKey: _, ...noKey } = base;
    await expect(beginIdempotency(store, "app", noKey)).rejects.toThrow(TypeError);
  });
});
