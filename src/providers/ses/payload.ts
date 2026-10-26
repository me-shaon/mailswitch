// The SES v2 request body of one message, and the API origin of a region. Internal to
// the adapter. They are not public exports.

import type { OutgoingMessage } from "../../core/types";
import { bytesToBase64 } from "../../internal/encoding";
import { encodeMailbox } from "../../internal/mime";

/** The SES v2 SendEmail body of one message. */
export function sesPayload(
  message: OutgoingMessage,
  configurationSetName?: string,
): Record<string, unknown> {
  const destination: Record<string, string[]> = { ToAddresses: message.to.map(encodeMailbox) };
  if (message.cc?.length) destination.CcAddresses = message.cc.map(encodeMailbox);
  if (message.bcc?.length) destination.BccAddresses = message.bcc.map(encodeMailbox);
  const body: Record<string, unknown> = {};
  if (message.html) body.Html = { Data: message.html, Charset: "UTF-8" };
  if (message.text) body.Text = { Data: message.text, Charset: "UTF-8" };
  const simple: Record<string, unknown> = {
    Subject: { Data: message.subject, Charset: "UTF-8" },
    Body: body,
  };
  const headers = Object.entries(message.headers ?? {});
  if (headers.length > 0) simple.Headers = headers.map(([Name, Value]) => ({ Name, Value }));
  if (message.attachments?.length) {
    simple.Attachments = message.attachments.map((item) => {
      const out: Record<string, string> = {
        FileName: item.filename,
        RawContent: typeof item.content === "string" ? item.content : bytesToBase64(item.content),
        ContentType: item.contentType,
        ContentTransferEncoding: "BASE64",
        ContentDisposition: item.contentId === undefined ? "ATTACHMENT" : "INLINE",
      };
      if (item.contentId !== undefined) out.ContentId = item.contentId;
      return out;
    });
  }
  const payload: Record<string, unknown> = {
    FromEmailAddress: encodeMailbox(message.from),
    Destination: destination,
    Content: { Simple: simple },
  };
  if (message.replyTo !== undefined) payload.ReplyToAddresses = [encodeMailbox(message.replyTo)];
  if (configurationSetName !== undefined) payload.ConfigurationSetName = configurationSetName;
  return payload;
}

/** The SES API origin of a region. */
export function sesEndpoint(region: string): string {
  return `https://email.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
}
