import { describe, expect, it } from "vitest";
import { tosend } from "../../src/providers/tosend/index";

// Live smoke tests call real provider APIs. They run only when their env vars are set,
// so CI makes no live calls. The provider units add a send test to each block:
//
// - Resend (U5): MAILSWITCH_LIVE_RESEND_KEY, MAILSWITCH_LIVE_RESEND_FROM, MAILSWITCH_LIVE_TO.
// - toSend (U6): MAILSWITCH_LIVE_TOSEND_KEY, MAILSWITCH_LIVE_TOSEND_FROM, MAILSWITCH_LIVE_TOSEND_TO.
//
// Each block checks that its env vars are complete. A block with an adapter also sends.

const env: Readonly<Record<string, string | undefined>> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

function hasLiveEnv(...names: string[]): boolean {
  return names.every((name) => (env[name] ?? "") !== "");
}

const RESEND = ["MAILSWITCH_LIVE_RESEND_KEY", "MAILSWITCH_LIVE_RESEND_FROM", "MAILSWITCH_LIVE_TO"];
const TOSEND = [
  "MAILSWITCH_LIVE_TOSEND_KEY",
  "MAILSWITCH_LIVE_TOSEND_FROM",
  "MAILSWITCH_LIVE_TOSEND_TO",
];

describe("live smoke gate", () => {
  it("needs every env var of a block", () => {
    expect(hasLiveEnv()).toBe(true);
    expect(hasLiveEnv("MAILSWITCH_LIVE_UNSET_FOR_SURE")).toBe(false);
  });
});

describe.skipIf(!hasLiveEnv(RESEND[0] as string))("live smoke: Resend", () => {
  it("has the env vars of the Resend smoke test", () => {
    expect(hasLiveEnv(...RESEND)).toBe(true);
  });
});

describe.skipIf(!hasLiveEnv(TOSEND[0] as string))("live smoke: toSend", () => {
  it("has the env vars of the toSend smoke test", () => {
    expect(hasLiveEnv(...TOSEND)).toBe(true);
  });

  it.skipIf(!hasLiveEnv(...TOSEND))("verifies the key and sends one email", async () => {
    const adapter = tosend();
    const ctx = {
      fetch: (input: string, init: RequestInit) => fetch(input, init),
      timeoutMs: 15_000,
      credentials: { apiKey: env.MAILSWITCH_LIVE_TOSEND_KEY ?? "" },
      now: Date.now(),
    };
    expect(await adapter.verify(ctx)).toEqual({ ok: true });
    const result = await adapter.send(
      {
        from: env.MAILSWITCH_LIVE_TOSEND_FROM ?? "",
        to: [env.MAILSWITCH_LIVE_TOSEND_TO ?? ""],
        subject: "mailswitch live smoke test (toSend)",
        text: "This email comes from the mailswitch live smoke test.",
      },
      ctx,
    );
    expect(result.status).toBe("sent");
  });
});
