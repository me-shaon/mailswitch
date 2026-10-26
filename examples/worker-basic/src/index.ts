// A small Worker that sends one invoice email with a PDF attachment and receives Resend
// webhooks. Routes:
//   POST /invoices/:id/send   sends the invoice email once per invoice id
//   POST /webhooks/resend     receives Resend events

import { createMailer, type Mailer, type SendResult } from "mailswitch";
import { resend } from "mailswitch/resend";
import {
  applyD1Schema,
  D1DailyCapStore,
  D1DedupeStore,
  D1IdempotencyStore,
} from "mailswitch/stores/d1";
import { tosend } from "mailswitch/tosend";
import { handleWebhook } from "mailswitch/webhooks";

export interface Env {
  DB: D1Database;
  MAIL_FROM: string;
  RESEND_API_KEY: string;
  TOSEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
}

// Apply the schema once per isolate. A production app puts D1_SCHEMA in a migration.
let schema: Promise<void> | undefined;

function mailer(env: Env): Mailer {
  return createMailer({
    providers: [
      { adapter: resend(), credentials: { apiKey: env.RESEND_API_KEY }, dailyCap: 100 },
      { adapter: tosend(), credentials: { apiKey: env.TOSEND_API_KEY } },
    ],
    namespace: "worker-basic",
    idempotency: new D1IdempotencyStore(env.DB),
    dailyCaps: new D1DailyCapStore(env.DB),
    logger: { warn: (message, data) => console.warn(message, data) },
  });
}

/**
 * Builds the PDF of an invoice. The bytes must be the same for one invoice on every
 * call, so a retry with the same idempotency key is not a conflict. A real app uses a
 * PDF library with a fixed creation date.
 */
function invoicePdf(invoiceId: string): Uint8Array {
  const text = `%PDF-1.4\n% Invoice ${invoiceId}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function sendInvoice(invoiceId: string, to: string, env: Env): Promise<Response> {
  const result: SendResult = await mailer(env).send({
    from: env.MAIL_FROM,
    to: [to],
    subject: `Invoice ${invoiceId}`,
    text: `Your invoice ${invoiceId} is attached.`,
    attachments: [
      {
        filename: `${invoiceId}.pdf`,
        content: invoicePdf(invoiceId),
        contentType: "application/pdf",
      },
    ],
    idempotencyKey: `invoice:${invoiceId}:send:1`,
  });
  switch (result.status) {
    case "sent":
      return json({ status: "sent", provider: result.provider, id: result.providerMessageId });
    case "not_sent":
      // The email did not go out. A retry is safe.
      return json({ status: "not_sent", reason: result.reason }, 502);
    case "unknown":
      // The email may have gone out. Do not retry. Ask a person to check.
      return json({ status: "unknown", reason: result.reason }, 202);
  }
}

async function onResendWebhook(request: Request, env: Env): Promise<Response> {
  const result = await handleWebhook(request, {
    adapter: resend(),
    secret: env.RESEND_WEBHOOK_SECRET,
    dedupe: new D1DedupeStore(env.DB),
  });
  if (!result.ok) return new Response(null, { status: result.status });
  try {
    for (const event of result.events) {
      if (event.type === "bounced" && event.bounce === "hard" && event.recipient) {
        // Put the address on the suppression list of your app here.
        console.log("hard bounce", event.providerMessageId);
      }
    }
  } catch {
    // Not handled, so no ack(). A non-2xx status makes Resend send the event again.
    await result.release();
    return new Response(null, { status: 500 });
  }
  await result.ack();
  return new Response(null, { status: 200 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    schema ??= applyD1Schema(env.DB);
    await schema;
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const send = /^\/invoices\/([A-Za-z0-9-]+)\/send$/.exec(url.pathname);
    if (send) {
      const to = url.searchParams.get("to");
      if (!to) return json({ error: "Add ?to=<address>." }, 400);
      return sendInvoice(send[1] as string, to, env);
    }
    if (url.pathname === "/webhooks/resend") return onResendWebhook(request, env);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
