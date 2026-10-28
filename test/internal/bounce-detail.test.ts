import { describe, expect, it } from "vitest";
import { BOUNCE_TEXT_MAX, bounceDetail, cleanBounceText } from "../../src/internal/bounce-detail";

// One character from each group that the builder removes.
const REMOVED = [
  "\u0000",
  "\u0009",
  "\u001F",
  "\u007F",
  "\u0080",
  "\u009F",
  "­",
  "؜",
  "​",
  "‏",
  " ",
  " ",
  "‪",
  "‮",
  "⁠",
  "⁤",
  "⁦",
  "⁩",
  "﻿",
  "\u{E0000}",
  "\u{E0041}",
  "\u{E007F}",
];

describe("cleanBounceText", () => {
  it("passes plain text through after it trims the ends", () => {
    expect(cleanBounceText("  550 5.1.1 User unknown <a@example.org>\n")).toBe(
      "550 5.1.1 User unknown <a@example.org>",
    );
  });

  it("removes one character from each group of the removed set", () => {
    for (const char of REMOVED) {
      expect(cleanBounceText(`550${char} user unknown`)).toBe("550 user unknown");
    }
    expect(cleanBounceText(`a${REMOVED.join("")}b`)).toBe("ab");
  });

  it("keeps characters that are not in the removed set", () => {
    expect(cleanBounceText("Postfach voll 📭 (ü)")).toBe("Postfach voll 📭 (ü)");
  });

  it("cuts a 1,500 character text to 1,000", () => {
    expect(cleanBounceText("a".repeat(1500))?.length).toBe(BOUNCE_TEXT_MAX);
  });

  it("does not end in a lone surrogate when a pair sits at the cut", () => {
    const text = cleanBounceText(`${"a".repeat(999)}📭${"b".repeat(10)}`) ?? "";
    expect(text).toBe("a".repeat(999));
    const last = text.charCodeAt(text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("gives undefined for an empty string, whitespace, or a value that is not a string", () => {
    for (const value of ["", "   \t", "​­", 550, null, undefined, {}]) {
      expect(cleanBounceText(value)).toBeUndefined();
    }
  });
});

describe("bounceDetail", () => {
  it("keeps all three parts when they are valid", () => {
    expect(bounceDetail({ text: "User unknown", smtpCode: 550, enhancedCode: "5.1.1" })).toEqual({
      text: "User unknown",
      smtpCode: 550,
      enhancedCode: "5.1.1",
    });
  });

  it("drops an SMTP code that is not an integer from 200 to 599", () => {
    for (const smtpCode of [199, 600, "550", 550.5, Number.NaN]) {
      expect(bounceDetail({ smtpCode })).toBeUndefined();
    }
    expect(bounceDetail({ smtpCode: 550 })).toEqual({ smtpCode: 550 });
  });

  it("keeps a valid enhanced code and drops an invalid one", () => {
    expect(bounceDetail({ enhancedCode: "5.1.1" })).toEqual({ enhancedCode: "5.1.1" });
    expect(bounceDetail({ enhancedCode: "4.7.26" })).toEqual({ enhancedCode: "4.7.26" });
    for (const enhancedCode of ["6.1.1", "5.1", "550 5.1.1", 511]) {
      expect(bounceDetail({ enhancedCode })).toBeUndefined();
    }
  });

  it("never reads a code out of the text", () => {
    expect(bounceDetail({ text: "550 5.1.1 User unknown" })).toEqual({
      text: "550 5.1.1 User unknown",
    });
  });

  it("gives undefined when every part is empty or invalid", () => {
    expect(bounceDetail({})).toBeUndefined();
    expect(bounceDetail({ text: " ", smtpCode: 0, enhancedCode: "" })).toBeUndefined();
  });
});
