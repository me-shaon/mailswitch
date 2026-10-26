// mailswitch/provider-kit: the public helpers for adapter authors. Built-in adapters and
// custom providers import this subpath, so no adapter needs a deep import.

export {
  defineProvider,
  type ProviderAdapter,
  type ProviderCredentials,
  type ProviderWebhooks,
  type SendContext,
  type VerifyResult,
  type WebhookVerifyInput,
  type WebhookVerifyResult,
} from "../core/adapter";
export { checkCapabilities } from "../core/capabilities";
export {
  type ClassifyResponseOptions,
  type ClassifyThrownOptions,
  classifyResponse,
  classifyThrown,
  defineStatusMap,
  parseRetryAfter,
  type ResponseClassification,
  redactUrl,
  type SentMarker,
  type StatusMap,
  type StatusOverride,
} from "../core/classify";
export type { NormalizedEvent, NormalizedEventType, WebhookRejection } from "../core/events";
export {
  type CredentialField,
  defineProviderMeta,
  type ProviderMeta,
  type ProviderPreset,
  type ProviderTier,
} from "../core/meta";
export {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  isBase64,
  utf8,
  utf8ByteLength,
} from "../internal/encoding";
export { type HmacHash, type HmacKey, hmacSign, hmacVerify } from "../internal/hmac";
export {
  callProvider,
  DEFAULT_TIMEOUT_MS,
  discardBody,
  type FetchLike,
  type ProviderCall,
  type ProviderRequest,
  readJson,
} from "../internal/http";
