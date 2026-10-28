import { describe, expect, it } from "vitest";
import { NORMALIZED_EVENT_TYPES } from "../../src/index";

describe("NORMALIZED_EVENT_TYPES", () => {
  it("lists every event type in a fixed order", () => {
    expect(NORMALIZED_EVENT_TYPES).toEqual([
      "bounced",
      "complained",
      "delivered",
      "unsubscribed",
      "unknown",
    ]);
  });
});
