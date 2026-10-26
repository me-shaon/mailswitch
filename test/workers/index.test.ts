import { describe, expect, it } from "vitest";
import { createMailer } from "../../src/index";

describe("core entry (workerd)", () => {
  it("loads in the Workers runtime", () => {
    expect(typeof createMailer).toBe("function");
    expect(typeof navigator.userAgent).toBe("string");
  });
});
