// The Postmark request body of one message. Internal to the adapter. It is not a public
// export.

import type { AddressInput, OutgoingMessage } from "../../core/types";
import { formatAddress, parseAddress } from "../../internal/address";
import { bytesToBase64 } from "../../internal/encoding";

function address(input: AddressInput): string {
  // validateMessage has checked every address, so parseAddress cannot return null here.
  const parsed = parseAddress(input);
  return parsed ? formatAddress(parsed) : "";
}

/** Maps a message to the Postmark request shape. */
export function postmarkPayload(
  message: OutgoingMessage,
  messageStream?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    From: address(message.from),
    To: message.to.map(address).join(", "),
    Subject: message.subject,
  };
  if (message.cc?.length) body.Cc = message.cc.map(address).join(", ");
  if (message.bcc?.length) body.Bcc = message.bcc.map(address).join(", ");
  if (message.replyTo !== undefined) body.ReplyTo = address(message.replyTo);
  if (message.html) body.HtmlBody = message.html;
  if (message.text) body.TextBody = message.text;
  if (message.headers && Object.keys(message.headers).length > 0) {
    body.Headers = Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value }));
  }
  if (message.attachments?.length) {
    body.Attachments = message.attachments.map((item) => ({
      Name: item.filename,
      Content: typeof item.content === "string" ? item.content : bytesToBase64(item.content),
      ContentType: item.contentType,
      ...(item.contentId === undefined ? {} : { ContentID: `cid:${item.contentId}` }),
    }));
  }
  if (messageStream) body.MessageStream = messageStream;
  return body;
}
