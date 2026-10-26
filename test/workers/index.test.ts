import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../../src/index";

describe("core entry (workerd)", () => {
  it("loads in the Workers runtime", () => {
    expect(PACKAGE_NAME).toBe("mailswitch");
    expect(typeof navigator.userAgent).toBe("string");
  });
});
