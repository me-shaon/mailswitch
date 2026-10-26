import { describe, expect, it } from "vitest";
import { type OutgoingMessage, validateMessage } from "../../src/index";
import { bytesToBase64 } from "../../src/internal/encoding";

// R36: one send with a 1 MB attachment uses less than 5 ms CPU. workerd freezes its
// timers during synchronous work, so this Node test is the CI gate. It measures the
// mailswitch share of a send: validation and the attachment encoding.

const BUDGET_MICROSECONDS = 5000;
// The test takes the fastest of several runs. A shared CI runner adds scheduler noise,
// and the fastest run is the closest to the real cost of the work.
const RUNS = 7;

interface CpuUsage {
  user: number;
  system: number;
}
// The project has no Node type definitions, so give process.cpuUsage a local type.
const nodeProcess = process as { cpuUsage(previous?: CpuUsage): CpuUsage };

function cpuMicroseconds(work: () => void): number {
  const start = nodeProcess.cpuUsage();
  work();
  const delta = nodeProcess.cpuUsage(start);
  return delta.user + delta.system;
}

function fastest(values: number[]): number {
  return Math.min(...values);
}

describe("R36 CPU budget (Node)", () => {
  it("validates and encodes a 1 MB attachment in under 5 ms CPU", () => {
    const content = new Uint8Array(1024 * 1024);
    for (let i = 0; i < content.length; i++) content[i] = (i * 31) & 0xff;
    const message: OutgoingMessage = {
      from: { email: "billing@acme.test", name: "Acme Billing" },
      to: ["ana@example.com"],
      subject: "Invoice INV-1001",
      html: "<p>Your invoice is attached.</p>",
      text: "Your invoice is attached.",
      attachments: [{ filename: "INV-1001.pdf", content, contentType: "application/pdf" }],
    };
    const work = () => {
      const validation = validateMessage(message);
      if (!validation.ok) throw new Error("Expected a valid message.");
      bytesToBase64(content);
    };

    for (let i = 0; i < 3; i++) work();
    const samples = Array.from({ length: RUNS }, () => cpuMicroseconds(work));
    expect(fastest(samples)).toBeLessThan(BUDGET_MICROSECONDS);
  });
});
