import { beforeAll, describe, expect, it } from "vitest";
import { ahasendFixture } from "../../src/conformance/fixtures/ahasend";
import { autosendFixture } from "../../src/conformance/fixtures/autosend";
import { brevoFixture } from "../../src/conformance/fixtures/brevo";
import { mailersendFixture } from "../../src/conformance/fixtures/mailersend";
import { mailgunFixture } from "../../src/conformance/fixtures/mailgun";
import { mailtrapFixture } from "../../src/conformance/fixtures/mailtrap";
import { postmarkFixture } from "../../src/conformance/fixtures/postmark";
import { resendFixture } from "../../src/conformance/fixtures/resend";
import { sendgridFixture } from "../../src/conformance/fixtures/sendgrid";
import { sesFixture } from "../../src/conformance/fixtures/ses";
import { smtp2goFixture } from "../../src/conformance/fixtures/smtp2go";
import { toSendFixture } from "../../src/conformance/fixtures/tosend";
import type { ConformanceFixture } from "../../src/conformance/index";
import type { ProviderAdapter } from "../../src/core/adapter";
import type { NormalizedEvent } from "../../src/core/events";
import { utf8 } from "../../src/internal/encoding";
import { ahasend } from "../../src/providers/ahasend/index";
import { autosend } from "../../src/providers/autosend/index";
import { brevo } from "../../src/providers/brevo/index";
import { mailersend } from "../../src/providers/mailersend/index";
import { mailgun } from "../../src/providers/mailgun/index";
import { mailtrap } from "../../src/providers/mailtrap/index";
import { postmark } from "../../src/providers/postmark/index";
import { resend } from "../../src/providers/resend/index";
import { sendgrid } from "../../src/providers/sendgrid/index";
import { ses } from "../../src/providers/ses/index";
import { smtp2go } from "../../src/providers/smtp2go/index";
import { tosend } from "../../src/providers/tosend/index";

// Every adapter whose bounce fields the provider docs confirm. Each fixture has a hard
// and a soft bounce with detail, and its other events carry no detail.
const CASES: [string, ProviderAdapter, ConformanceFixture][] = [
  ["resend", resend(), resendFixture()],
  ["tosend", tosend(), toSendFixture()],
  ["mailgun", mailgun(), mailgunFixture()],
  ["postmark", postmark(), postmarkFixture()],
  ["brevo", brevo(), brevoFixture()],
  ["mailersend", mailersend(), mailersendFixture()],
  ["sendgrid", sendgrid(), sendgridFixture()],
  ["ses", ses(), sesFixture()],
  ["ahasend", ahasend(), ahasendFixture()],
  ["mailtrap", mailtrap(), mailtrapFixture()],
  ["autosend", autosend(), autosendFixture()],
  ["smtp2go", smtp2go(), smtp2goFixture()],
];

// Signs each sample first: some fixtures, such as Mailgun and SES, build the envelope then.
async function parseAll(
  adapter: ProviderAdapter,
  fixture: ConformanceFixture,
): Promise<NormalizedEvent[][]> {
  const parse = adapter.webhooks?.parse;
  const webhook = fixture.webhook;
  if (parse === undefined || webhook === undefined) throw new Error("no webhooks");
  const out: NormalizedEvent[][] = [];
  for (const sample of webhook.samples) {
    const body = typeof sample.body === "string" ? utf8(sample.body) : sample.body;
    const signed = await webhook.sign({ body, secret: webhook.secret, at: fixture.now ?? 0 });
    out.push(parse(signed.body, new Headers(signed.headers)));
  }
  return out;
}

describe.each(CASES)("bounce detail of the %s fixture", (_id, adapter, fixture) => {
  const samples = fixture.webhook?.samples ?? [];
  let parsed: NormalizedEvent[][] = [];
  beforeAll(async () => {
    parsed = await parseAll(adapter, fixture);
  });

  it("gives the expected detail for each bounce sample", () => {
    samples.forEach((sample, index) => {
      sample.expected.forEach((want, at) => {
        if (want.bounceDetail === undefined) return;
        expect(parsed[index]?.[at]?.bounceDetail).toEqual(want.bounceDetail);
      });
    });
  });

  it("has a hard bounce and a soft bounce with detail", () => {
    const events = parsed.flat().filter((event) => event.bounceDetail !== undefined);
    const hard = events.filter((event) => event.bounce !== "soft");
    const soft = events.filter((event) => event.bounce === "soft");
    expect(hard.length).toBeGreaterThan(0);
    expect(soft.length).toBeGreaterThan(0);
  });

  it("gives no detail to a complaint, a delivery, or an unmapped event", () => {
    const others = parsed.flat().filter((event) => event.type !== "bounced");
    expect(others.length).toBeGreaterThan(0);
    for (const event of others) expect(event.bounceDetail).toBeUndefined();
  });
});
