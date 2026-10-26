import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index";

describe("core entry (Node)", () => {
  it("loads", () => {
    expect(PACKAGE_NAME).toBe("mailswitch");
  });
});
