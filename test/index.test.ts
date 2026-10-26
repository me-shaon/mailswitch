import { describe, expect, it } from "vitest";
import { createMailer } from "../src/index";

describe("core entry (Node)", () => {
  it("loads", () => {
    expect(typeof createMailer).toBe("function");
  });
});
