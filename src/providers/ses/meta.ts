// Amazon SES provider data. Pure data: a catalog imports this file without the adapter.
// https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
// https://docs.aws.amazon.com/ses/latest/dg/quotas.html

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

export const sesMeta: ProviderMeta = defineProviderMeta({
  id: "ses",
  name: "Amazon SES",
  tier: 1,
  capabilities: {
    attachments: true,
    // SES v2 accepts messages up to 40 MB, including attachments, after base64 encoding.
    maxMessageBytes: 40_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    // SES has no idempotency key.
    idempotency: false,
    // SendBulkEmail takes only templates, so each message is one SendEmail call.
    batchSize: 1,
    // SendEmail accepts at most 50 recipients across To, Cc, and Bcc.
    maxRecipients: 50,
  },
  credentialFields: [
    {
      name: "region",
      label: "Region",
      secret: false,
      required: true,
      placeholder: "us-east-1",
      pattern: "^[a-z]{2}(-[a-z0-9]+)+-\\d{1,2}$",
      hint: "The AWS region of your SES account, for example eu-west-1.",
    },
    {
      name: "accessKeyId",
      label: "Access key ID",
      secret: false,
      required: true,
      placeholder: "AKIA...",
      pattern: "^[A-Za-z0-9]{16,128}$",
      hint: "An IAM identity with ses:SendEmail and ses:GetAccount.",
    },
    {
      name: "secretAccessKey",
      label: "Secret access key",
      secret: true,
      required: true,
    },
    {
      name: "sessionToken",
      label: "Session token",
      secret: true,
      required: false,
      hint: "Only for temporary credentials.",
    },
  ],
  docsUrl: "https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html",
  // No overrides. Every 5xx stays unknown. The adapter refines 4xx reasons from the SES
  // error type: https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html#API_SendEmail_Errors
  statusMap: defineStatusMap({}),
  webhooks: true,
  nativeIdempotency: false,
});
