import { describe, expect, it } from "vitest";
import { uuidFromKey } from "../../src/internal/uuid";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidFromKey", () => {
  it("gives the same UUID for the same key", async () => {
    const key = "order-1042:receipt";
    expect(await uuidFromKey(key)).toBe(await uuidFromKey(key));
  });

  it("gives different UUIDs for different keys", async () => {
    const values = await Promise.all(["a", "b", "order-1", "order-2", "Order-1"].map(uuidFromKey));
    expect(new Set(values).size).toBe(values.length);
  });

  it("matches a known SHA-256 vector", async () => {
    // SHA-256("abc") is ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.
    // Byte 6 (0xcf) becomes 0x8f for version 8. Byte 8 (0x41) becomes 0x81 for variant 10.
    expect(await uuidFromKey("abc")).toBe("ba7816bf-8f01-8fea-8141-40de5dae2223");
  });

  it("has version 8, variant 10, and lowercase hex for many keys", async () => {
    for (let i = 0; i < 200; i++) {
      const value = await uuidFromKey(`key-${i}`);
      expect(value).toMatch(UUID);
      expect(value).toHaveLength(36);
    }
  });

  it("takes an empty key and a key outside ASCII", async () => {
    expect(await uuidFromKey("")).toMatch(UUID);
    expect(await uuidFromKey("ключ-☃")).toMatch(UUID);
    expect(await uuidFromKey("ключ-☃")).not.toBe(await uuidFromKey(""));
  });
});
