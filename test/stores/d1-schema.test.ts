import { expect, it } from "vitest";
import { D1_IDEMPOTENCY_SCHEMA } from "../../src/stores/d1";
import schemaFile from "../../src/stores/d1-schema.sql?raw";

it("keeps d1-schema.sql and D1_IDEMPOTENCY_SCHEMA the same", () => {
  expect(schemaFile).toBe(D1_IDEMPOTENCY_SCHEMA);
});
