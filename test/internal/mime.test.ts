import { describe, expect, it } from "vitest";
import { decodeHeaderValue } from "../../src/conformance/index";
import type { OutgoingMessage } from "../../src/core/types";
import { base64ToBytes, bytesToBase64, utf8 } from "../../src/internal/encoding";
import {
  buildMime,
  encodeMailbox,
  headerField,
  MAX_LINE_LENGTH,
  quotedPrintable,
  randomBoundary,
} from "../../src/internal/mime";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const PDF = utf8("%PDF-1.7\n%mailswitch test\n".repeat(20));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 254, 255]);

// A small MIME reader for the tests: it splits headers, unfolds them, and walks
// multipart bodies by their boundary.
interface ParsedPart {
  headers: Map<string, string>;
  body: string;
  parts: ParsedPart[];
}

function parsePart(source: string): ParsedPart {
  const cut = source.indexOf("\r\n\r\n");
  const head = cut === -1 ? source : source.slice(0, cut);
  const body = cut === -1 ? "" : source.slice(cut + 4);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  const boundary = /boundary="([^"]+)"/.exec(headers.get("content-type") ?? "")?.[1];
  const parts = boundary
    ? body
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((chunk) => parsePart(chunk.replace(/^\r\n/, "").replace(/\r\n$/, "")))
    : [];
  return { headers, body, parts };
}

function decodeQp(text: string): string {
  const soft = text.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] === "=") {
      bytes.push(Number.parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(soft.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\r\n/g, "\n");
}

/** The file name from RFC 2231 parameters, joined across sections. */
function filenameOf(disposition: string): string {
  const sections = [...disposition.matchAll(/filename\*(?:(\d+)\*)?=(?:UTF-8'')?([^;\s]+)/g)];
  const joined = sections
    .sort((a, b) => Number(a[1] ?? 0) - Number(b[1] ?? 0))
    .map((match) => match[2])
    .join("");
  return decodeURIComponent(joined);
}

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: { email: "billing@example.com", name: "Zoë Müller, Acme" },
    to: ["ana@example.org", { email: "bo@example.org", name: "Bo" }],
    cc: ["cc@example.org"],
    bcc: ["hidden@example.org"],
    replyTo: "help@example.com",
    subject: "Rechnung 42: Grüße aus Köln",
    text: "Hello Zoë,\nyour invoice is attached.\n",
    html: "<p>Hello Zoë, your invoice is <b>attached</b>.</p>",
    headers: { "X-Entity-Ref": "inv-42" },
    ...overrides,
  };
}

describe("buildMime", () => {
  it("builds a message with an attachment that parses back to the same parts", () => {
    const { raw, messageId } = buildMime(
      message({
        attachments: [
          { filename: "Rechnung März 2026.pdf", content: PDF, contentType: "application/pdf" },
          {
            filename: "logo.png",
            content: bytesToBase64(PNG),
            contentType: "image/png",
            contentId: "logo@acme",
          },
        ],
      }),
      { now: NOW },
    );
    const root = parsePart(raw);
    expect(root.headers.get("message-id")).toBe(messageId);
    expect(messageId).toMatch(/^<[0-9a-f]{32}@example\.com>$/);
    expect(root.headers.get("date")).toBe("Mon, 26 Oct 2026 12:00:00 +0000");
    expect(decodeHeaderValue(root.headers.get("from") ?? "")).toBe(
      "Zoë Müller, Acme <billing@example.com>",
    );
    expect(root.headers.get("to")).toBe("ana@example.org, Bo <bo@example.org>");
    expect(root.headers.get("cc")).toBe("cc@example.org");
    expect(root.headers.has("bcc")).toBe(false);
    expect(root.headers.get("reply-to")).toBe("help@example.com");
    expect(decodeHeaderValue(root.headers.get("subject") ?? "")).toBe(
      "Rechnung 42: Grüße aus Köln",
    );
    expect(root.headers.get("x-entity-ref")).toBe("inv-42");
    expect(root.headers.get("mime-version")).toBe("1.0");

    // mixed [ related [ alternative [ text, html ], inline png ], pdf ]
    expect(root.headers.get("content-type")).toMatch(/^multipart\/mixed; boundary="=_ms_/);
    const [related, pdf] = root.parts;
    expect(related?.headers.get("content-type")).toMatch(/^multipart\/related/);
    const [alternative, png] = related?.parts ?? [];
    const [text, html] = alternative?.parts ?? [];
    expect(decodeQp(text?.body ?? "")).toBe("Hello Zoë,\nyour invoice is attached.\n");
    expect(decodeQp(html?.body ?? "")).toBe("<p>Hello Zoë, your invoice is <b>attached</b>.</p>");
    expect(text?.headers.get("content-type")).toBe("text/plain; charset=UTF-8");

    expect(pdf?.headers.get("content-type")).toBe("application/pdf");
    expect(pdf?.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(filenameOf(pdf?.headers.get("content-disposition") ?? "")).toBe(
      "Rechnung März 2026.pdf",
    );
    expect(base64ToBytes((pdf?.body ?? "").replace(/\s+/g, ""))).toEqual(PDF);

    expect(png?.headers.get("content-id")).toBe("<logo@acme>");
    expect(png?.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(base64ToBytes((png?.body ?? "").replace(/\s+/g, ""))).toEqual(PNG);
  });

  it("keeps every line at most 998 characters and 7-bit", () => {
    const longWord = "x".repeat(2000);
    const { raw } = buildMime(
      message({
        subject: `A ${longWord} subject`,
        headers: { "X-Long": longWord },
        text: `${"é".repeat(3000)}\n${"a".repeat(5000)}`,
        attachments: [
          {
            filename: `${"ü".repeat(200)}.pdf`,
            content: new Uint8Array(10_000),
            contentType: "application/pdf",
          },
        ],
      }),
      { now: NOW },
    );
    for (const line of raw.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(MAX_LINE_LENGTH);
      expect(/^[\x20-\x7e\t]*$/.test(line)).toBe(true);
    }
    expect(raw.includes("\n") && !/[^\r]\n/.test(raw)).toBe(true);
    const root = parsePart(raw);
    const file = root.parts[1];
    expect(filenameOf(file?.headers.get("content-disposition") ?? "")).toBe(
      `${"ü".repeat(200)}.pdf`,
    );
    expect(decodeHeaderValue(root.headers.get("x-long") ?? "")).toBe(longWord);
  });

  it("uses a new random 128-bit boundary each time", () => {
    const a = randomBoundary();
    const b = randomBoundary();
    expect(a).toMatch(/^=_ms_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("sends a single text part without a multipart wrapper", () => {
    const { raw } = buildMime(message({ html: undefined, text: "Hi" }), { now: NOW });
    const root = parsePart(raw);
    expect(root.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(decodeQp(root.body)).toBe("Hi\n");
  });

  it("encodes display names and folds headers", () => {
    expect(encodeMailbox({ email: "a@example.com", name: "Ana" })).toBe("Ana <a@example.com>");
    expect(encodeMailbox({ email: "a@example.com", name: "Ana, Acme" })).toBe(
      '"Ana, Acme" <a@example.com>',
    );
    expect(encodeMailbox({ email: "a@example.com", name: "Zoë" })).toBe(
      "=?UTF-8?B?Wm/Dqw==?= <a@example.com>",
    );
    expect(() => encodeMailbox("not an address")).toThrow(TypeError);
    const folded = headerField("Subject", "word ".repeat(40).trim());
    for (const line of folded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    expect(quotedPrintable("a=b\n")).toBe("a=3Db\r\n");
  });
});
