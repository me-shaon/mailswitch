import { describe, expect, it } from "vitest";
import { asRecord, numberField, stringField } from "../../src/internal/json";

describe("asRecord", () => {
  it("keeps a plain object and refuses null, an array, and a primitive", () => {
    const record = { a: 1 };
    expect(asRecord(record)).toBe(record);
    for (const value of [null, [], "text", 1, undefined]) expect(asRecord(value)).toBeUndefined();
  });
});

describe("stringField", () => {
  it("gives a trimmed string and undefined for a blank string or another type", () => {
    const record = { a: "  value\t", b: "", c: " \t ", d: 42, e: null };
    expect(stringField(record, "a")).toBe("value");
    for (const name of ["b", "c", "d", "e", "missing"]) {
      expect(stringField(record, name)).toBeUndefined();
    }
  });
});

describe("numberField", () => {
  it("gives a finite number and undefined for NaN, Infinity, and a number text", () => {
    const record = { a: 0, b: -1.5, c: Number.NaN, d: Number.POSITIVE_INFINITY, e: "12" };
    expect(numberField(record, "a")).toBe(0);
    expect(numberField(record, "b")).toBe(-1.5);
    for (const name of ["c", "d", "e", "missing"]) {
      expect(numberField(record, name)).toBeUndefined();
    }
  });
});
