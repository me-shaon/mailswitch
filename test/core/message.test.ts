import { describe, expect, it, vi } from "vitest";
import type { Capabilities, MessageValidation, OutgoingMessage } from "../../src/index";
import { checkCapabilities, validateMessage } from "../../src/index";
import { formatAddress, parseAddress } from "../../src/internal/address";
import { bytesToBase64 } from "../../src/internal/encoding";

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: { email: "billing@acme.test", name: "Acme Billing" },
    to: ["ana@example.com", "Bo Li <bo@example.com>"],
    cc: [{ email: "cc@example.com" }],
    replyTo: "support@acme.test",
    subject: "Invoice INV-1001",
    html: "<p>Your invoice is attached.</p>",
    text: "Your invoice is attached.",
    attachments: [{ filename: "INV-1001.pdf", content: pdf, contentType: "application/pdf" }],
    ...overrides,
  };
}

const full: Capabilities = {
  attachments: true,
  maxMessageBytes: 10 * 1024 * 1024,
  cc: true,
  bcc: true,
  replyTo: true,
  customHeaders: true,
  idempotency: false,
  batchSize: 1,
};

function refusal(validation: MessageValidation) {
  if (validation.ok) throw new Error("Expected the message to be refused.");
  return validation.result;
}

function expectInvalid(validation: MessageValidation): void {
  const result = refusal(validation);
  expect(result.status).toBe("not_sent");
  expect(result.reason).toBe("invalid_message");
}

describe("validateMessage", () => {
  it("accepts html, text, cc, reply-to, two recipients, and a PDF", () => {
    const validation = validateMessage(message(), full);
    expect(validation.ok).toBe(true);
  });

  it("refuses a message with no html and no text", () => {
    expectInvalid(validateMessage(message({ html: undefined, text: undefined })));
    expectInvalid(validateMessage(message({ html: "", text: "" })));
  });

  it("accepts a message with only a text body", () => {
    expect(validateMessage(message({ html: undefined })).ok).toBe(true);
  });

  it("refuses an empty recipient list", () => {
    expectInvalid(validateMessage(message({ to: [], cc: undefined })));
    expectInvalid(validateMessage(message({ to: [], cc: ["cc@example.com"] })));
  });

  it("refuses CRLF in a custom header value", () => {
    expectInvalid(validateMessage(message({ headers: { "X-Tag": "a\r\nBcc: evil@x.test" } })));
  });

  it("refuses U+2028 in the subject", () => {
    expectInvalid(validateMessage(message({ subject: "Invoice\u2028Bcc: evil@x.test" })));
  });

  it.each(["\r", "\n", "\0", "\u0085", "\u2028", "\u2029"])("refuses %j in the subject", (char) => {
    expectInvalid(validateMessage(message({ subject: `a${char}b` })));
  });

  it("refuses NUL in a display name", () => {
    expectInvalid(validateMessage(message({ from: { email: "a@acme.test", name: "Acme\0" } })));
    expectInvalid(validateMessage(message({ to: ["Ana\0 <ana@example.com>"] })));
  });

  it("refuses two addresses in one to value", () => {
    expectInvalid(validateMessage(message({ to: ["a@x.com, b@y.com"] })));
    expectInvalid(validateMessage(message({ to: ["a@x.com; b@y.com"] })));
    expectInvalid(validateMessage(message({ to: [{ email: "a@x.com,b@y.com" }] })));
    expectInvalid(validateMessage(message({ cc: ["A <a@x.com>, B <b@y.com>"] })));
  });

  it.each([
    "plain",
    "@example.com",
    "ana@",
    "ana@@example.com",
    "ana @example.com",
    "ana@exa mple.com",
    "ana@example..com",
    "<ana@example.com",
    "ana@example.com\r\n",
  ])("refuses the address %j", (value) => {
    expectInvalid(validateMessage(message({ to: [value] })));
  });

  it("refuses a bad from and a bad reply-to address", () => {
    expectInvalid(validateMessage(message({ from: "not an address" })));
    expectInvalid(validateMessage(message({ replyTo: "a@x.com, b@y.com" })));
    expectInvalid(validateMessage(message({ bcc: ["bad"] })));
  });

  it.each([
    "Bcc",
    "bcc",
    "To",
    "Cc",
    "From",
    "Subject",
    "Content-Type",
    "Content-Transfer-Encoding",
    "MIME-Version",
    "Return-Path",
    "DKIM-Signature",
  ])("refuses a %s custom header", (name) => {
    expectInvalid(validateMessage(message({ headers: { [name]: "evil@x.test" } })));
  });

  it("accepts a List-Unsubscribe custom header", () => {
    const headers = { "List-Unsubscribe": "<https://acme.test/u/1>" };
    expect(validateMessage(message({ headers }), full).ok).toBe(true);
  });

  it.each(["X Tag", "X:Tag", "", "X-Tág", "X-Tag\r\n"])("refuses the header name %j", (name) => {
    expectInvalid(validateMessage(message({ headers: { [name]: "v" } })));
  });

  it("refuses a header set twice with different case", () => {
    expectInvalid(validateMessage(message({ headers: { "X-Tag": "a", "x-tag": "b" } })));
  });

  it("refuses a filename with a quote and CRLF", () => {
    const attachments = [
      { filename: 'a.pdf"\r\nX: y', content: pdf, contentType: "application/pdf" },
    ];
    expectInvalid(validateMessage(message({ attachments })));
  });

  it.each(["../a.pdf", "dir\\a.pdf", 'a".pdf', "a\tb.pdf", "a\u2028.pdf", "", "x".repeat(256)])(
    "refuses the filename %j",
    (filename) => {
      const attachments = [{ filename, content: pdf, contentType: "application/pdf" }];
      expectInvalid(validateMessage(message({ attachments })));
    },
  );

  it.each(["application/pdf; name=x", "application", "text/plain\r\n", "a/b/c"])(
    "refuses the content type %j",
    (contentType) => {
      const attachments = [{ filename: "a.pdf", content: pdf, contentType }];
      expectInvalid(validateMessage(message({ attachments })));
    },
  );

  it("refuses a duplicate Content-ID", () => {
    const attachments = [
      { filename: "a.png", content: pdf, contentType: "image/png", contentId: "logo@acme" },
      { filename: "b.png", content: pdf, contentType: "image/png", contentId: "logo@acme" },
    ];
    expectInvalid(validateMessage(message({ attachments })));
  });

  it("refuses a Content-ID with characters outside the allowed set", () => {
    const attachments = [
      { filename: "a.png", content: pdf, contentType: "image/png", contentId: "<logo>" },
    ];
    expectInvalid(validateMessage(message({ attachments })));
  });

  it("accepts base64 content and refuses content that is not base64", () => {
    const ok = [{ filename: "a.pdf", content: bytesToBase64(pdf), contentType: "application/pdf" }];
    expect(validateMessage(message({ attachments: ok })).ok).toBe(true);
    const bad = [{ filename: "a.pdf", content: "not base64!", contentType: "application/pdf" }];
    expectInvalid(validateMessage(message({ attachments: bad })));
  });

  it("refuses a bad idempotency key", () => {
    expectInvalid(validateMessage(message({ idempotencyKey: "" })));
    expectInvalid(validateMessage(message({ idempotencyKey: "k\r\n" })));
    expect(validateMessage(message({ idempotencyKey: "invoice-1001" })).ok).toBe(true);
  });

  it("never copies the field value into the result text", () => {
    const result = refusal(validateMessage(message({ to: ["secret-person@x.com, b@y.com"] })));
    expect(result.message).not.toContain("secret-person");
    const header = refusal(validateMessage(message({ headers: { "X-Key": "sk_live\r\n" } })));
    expect(header.message).not.toContain("sk_live");
  });

  it("throws for a message that is not an object", () => {
    expect(() => validateMessage(null as unknown as OutgoingMessage)).toThrow(TypeError);
  });

  it("reports the size after base64 encoding", () => {
    const bytes = new Uint8Array(3000);
    const validation = validateMessage(
      message({
        cc: undefined,
        replyTo: undefined,
        attachments: [
          { filename: "a.bin", content: bytes, contentType: "application/octet-stream" },
        ],
      }),
    );
    if (!validation.ok) throw new Error("Expected a valid message.");
    expect(validation.encodedBytes).toBeGreaterThan(4000);
  });
});

describe("capabilities", () => {
  it("refuses attachments to a provider without the attachments capability", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const validation = validateMessage(message(), { ...full, attachments: false });
    vi.unstubAllGlobals();
    const result = refusal(validation);
    expect(result).toEqual({
      status: "not_sent",
      reason: "unsupported",
      message: "The provider does not accept attachments.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["cc", { cc: false }, {}],
    ["bcc", { bcc: false }, { bcc: ["b@example.com"] }],
    ["replyTo", { replyTo: false }, {}],
    ["customHeaders", { customHeaders: false }, { headers: { "X-Tag": "a" } }],
    ["maxRecipients", { maxRecipients: 2 }, {}],
  ] as const)("refuses a message that needs %s", (_name, caps, overrides) => {
    const result = refusal(validateMessage(message(overrides), { ...full, ...caps }));
    expect(result.status).toBe("not_sent");
    expect(result.reason).toBe("unsupported");
  });

  it("refuses a message larger than maxMessageBytes after base64", () => {
    // 7.5 MB of raw bytes is 10 MB of base64.
    const bytes = new Uint8Array(7.5 * 1024 * 1024 + 3);
    const attachments = [{ filename: "a.bin", content: bytes, contentType: "application/pdf" }];
    const result = refusal(validateMessage(message({ attachments }), full));
    expect(result.reason).toBe("unsupported");
  });

  it("reports invalid_message before unsupported", () => {
    const result = refusal(
      validateMessage(message({ subject: "a\nb" }), { ...full, attachments: false }),
    );
    expect(result.reason).toBe("invalid_message");
  });

  it("checkCapabilities returns null when the provider can send the message", () => {
    expect(checkCapabilities(message(), full, 100)).toBeNull();
  });
});

describe("address helpers", () => {
  it("parses bare, named, and quoted mailboxes", () => {
    expect(parseAddress("ana@example.com")).toEqual({ email: "ana@example.com" });
    expect(parseAddress("Ana Li <ana@example.com>")).toEqual({
      email: "ana@example.com",
      name: "Ana Li",
    });
    expect(parseAddress('"Li, Ana" <ana@example.com>')).toEqual({
      email: "ana@example.com",
      name: "Li, Ana",
    });
    expect(parseAddress({ email: "ana@example.com", name: " " })).toEqual({
      email: "ana@example.com",
    });
  });

  it("formats names that need quotes", () => {
    expect(formatAddress({ email: "a@x.test" })).toBe("a@x.test");
    expect(formatAddress({ email: "a@x.test", name: "Ana Li" })).toBe("Ana Li <a@x.test>");
    expect(formatAddress({ email: "a@x.test", name: "Li, Ana" })).toBe('"Li, Ana" <a@x.test>');
    expect(formatAddress({ email: "a@x.test", name: 'A "B"' })).toBe('"A \\"B\\"" <a@x.test>');
    expect(formatAddress({ email: "a@x.test", name: "Zoë" })).toBe("Zoë <a@x.test>");
  });
});
