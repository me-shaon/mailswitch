// mailswitch/webhooks: the normalized event types. A later unit adds handleWebhook.

export type {
  ProviderWebhooks,
  WebhookVerifyInput,
  WebhookVerifyResult,
} from "../core/adapter";
export type { NormalizedEvent, NormalizedEventType, WebhookRejection } from "../core/events";
