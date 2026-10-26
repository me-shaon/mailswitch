import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  callProvider,
  classifyResponse,
  type FetchLike,
  hmacSign,
  hmacVerify,
  utf8,
} from "../../src/provider-kit/index";

const KEY = "Jefe";
const DATA = utf8("what do ya want for nothing?");
const SHA256 = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";

describe("provider-kit (workerd)", () => {
  it("signs and verifies with HMAC", async () => {
    const signature = await hmacSign(KEY, DATA);
    expect(bytesToHex(signature)).toBe(SHA256);
    expect(await hmacVerify(KEY, signature, DATA)).toBe(true);
    const tampered = signature.slice();
    tampered[31] = (tampered[31] as number) ^ 0x80;
    expect(await hmacVerify(KEY, tampered, DATA)).toBe(false);
  });

  it("gives unknown/timeout when AbortSignal.timeout fires", async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const call = await callProvider({ url: "https://x.test/send", timeoutMs: 20, fetch: hanging });
    expect(call).toMatchObject({ ok: false, result: { status: "unknown", reason: "timeout" } });
  });

  it("classifies a 429 with Retry-After", async () => {
    const call = await callProvider({
      url: "https://x.test/send",
      fetch: async () =>
        new Response("slow down", { status: 429, headers: { "retry-after": "3" } }),
    });
    if (!call.ok) throw new Error("expected a response");
    expect(classifyResponse(call.response.status, call.response.headers)).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 3000,
    });
  });
});
