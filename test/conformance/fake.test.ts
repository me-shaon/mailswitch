import { describe, expect, it } from "vitest";
import {
  CHECK_IDS,
  type CheckReport,
  type ConformanceFixture,
  runChecks,
} from "../../src/conformance/index";
import { runConformance } from "../../src/conformance/vitest";
import type { ProviderAdapter } from "../../src/index";
import { utf8 } from "../../src/internal/encoding";
import { sha256Hex } from "../../src/internal/sha256";
import { fakeFixture, fakeProvider } from "../../src/testing/index";

// The fake provider in the fetch transport passes every check that applies.
runConformance(fakeProvider({ transport: "fetch" }), fakeFixture(), { tier: 1 });

describe("conformance report of the fake provider", () => {
  it("passes, runs every check, and marks only sendBatch n/a", async () => {
    const report = await runChecks({
      adapter: fakeProvider({ transport: "fetch" }),
      fixture: fakeFixture(),
      tier: 1,
    });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.provider).toBe("fake");
    expect(report.checks.map((entry) => entry.id)).toEqual(CHECK_IDS);
    const na = report.checks.filter((entry) => entry.status === "n/a");
    expect(na).toEqual([
      expect.objectContaining({ id: "send.batch", reason: "The adapter has no sendBatch." }),
    ]);
  });

  it("fails declaration.tier when the declared tier differs from meta", async () => {
    const report = await runChecks({
      adapter: fakeProvider({ transport: "fetch" }),
      fixture: fakeFixture(),
      tier: 2,
    });
    const entry = report.checks.find((item) => item.id === "declaration.tier");
    expect(entry?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });
});

// A provider that takes a derived key in the body, as Brevo takes a UUID. The adapter
// moves the key out of the header and puts its SHA-256 prefix in the JSON body.
function derive(key: string): string {
  return sha256Hex(utf8(key)).slice(0, 32);
}

function bodyKeyProvider(transform: (key: string) => string = derive): ProviderAdapter {
  const base = fakeProvider({ transport: "fetch" });
  return {
    ...base,
    send(message, ctx) {
      const key = message.idempotencyKey;
      if (key === undefined) return base.send(message, ctx);
      const { idempotencyKey: _, ...rest } = message;
      return base.send(rest, {
        ...ctx,
        fetch: (input, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return ctx.fetch(input, {
            ...init,
            body: JSON.stringify({ ...body, key: transform(key) }),
          });
        },
      });
    },
  };
}

function bodyKeyFixture(): ConformanceFixture {
  return {
    ...fakeFixture(),
    readIdempotencyKey: (request) => (JSON.parse(request.body) as { key?: string }).key,
    expectedIdempotencyKey: async (key) => derive(key),
  };
}

function statusOf(report: CheckReport, id: CheckReport["checks"][number]["id"]) {
  return report.checks.find((item) => item.id === id)?.status;
}

describe("conformance kit: a body-placed idempotency key", () => {
  it("passes send.idempotency when both hooks find the derived key", async () => {
    const report = await runChecks({
      adapter: bodyKeyProvider(),
      fixture: bodyKeyFixture(),
      tier: 1,
    });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(statusOf(report, "send.idempotency")).toBe("pass");
  });

  it("fails send.idempotency when the adapter derives the key wrongly", async () => {
    const report = await runChecks({
      adapter: bodyKeyProvider((key) => derive(`${key}x`)),
      fixture: bodyKeyFixture(),
      tier: 1,
    });
    const entry = report.checks.find((item) => item.id === "send.idempotency");
    expect(entry?.status).toBe("fail");
    expect(entry?.status === "fail" ? entry.problems.join("\n") : "").toContain(
      `not ${derive("conformance-idempotency-key-1")}`,
    );
  });

  it("fails send.idempotency without the hooks, because no header carries the key", async () => {
    const report = await runChecks({ adapter: bodyKeyProvider(), fixture: fakeFixture(), tier: 1 });
    expect(statusOf(report, "send.idempotency")).toBe("fail");
  });

  it("fails send.idempotency when a message without a key still carries one", async () => {
    const base = bodyKeyProvider();
    const sticky: ProviderAdapter = {
      ...base,
      send: (message, ctx) =>
        base.send(
          { ...message, idempotencyKey: message.idempotencyKey ?? "conformance-idempotency-key-1" },
          ctx,
        ),
    };
    const report = await runChecks({ adapter: sticky, fixture: bodyKeyFixture(), tier: 1 });
    const entry = report.checks.find((item) => item.id === "send.idempotency");
    expect(entry?.status === "fail" ? entry.problems.join("\n") : "").toContain(
      "A message without a key still carries a key.",
    );
  });

  it("checks the header for the derived key when only expectedIdempotencyKey is set", async () => {
    const base = fakeProvider({ transport: "fetch" });
    const derived: ProviderAdapter = {
      ...base,
      send: (message, ctx) =>
        base.send(
          message.idempotencyKey === undefined
            ? message
            : { ...message, idempotencyKey: derive(message.idempotencyKey) },
          ctx,
        ),
    };
    const fixture: ConformanceFixture = { ...fakeFixture(), expectedIdempotencyKey: derive };
    const report = await runChecks({ adapter: derived, fixture, tier: 1 });
    expect(statusOf(report, "send.idempotency")).toBe("pass");
    const plain = await runChecks({ adapter: derived, fixture: fakeFixture(), tier: 1 });
    expect(statusOf(plain, "send.idempotency")).toBe("fail");
  });
});
