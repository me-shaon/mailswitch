// mailswitch/conformance: the adapter conformance kit. It runs on any runtime and
// imports no test framework. `mailswitch/conformance/vitest` wraps it in Vitest.

export {
  CHECK_IDS,
  type ConformanceCheck,
  conformanceChecks,
  runChecks,
  sampleMessage,
} from "./checks";
export {
  type CapturedRequest,
  type EchoMode,
  echoFetch,
  type FetchMock,
  matches,
  mockFetch,
  type RecordedExchange,
  type RecordedHttpResponse,
  type RecordedResponse,
  type RequestMatcher,
} from "./mock-fetch";
export {
  type CapturedSmtpMessage,
  decodeHeaderValue,
  type MockCommand,
  type MockReply,
  type MockSession,
  type MockSmtp,
  type MockSmtpOptions,
  mockSmtp,
  type ParsedMail,
  parseMail,
} from "./mock-smtp";
export { createSnsSigner, type SnsMessage, type SnsSigner, snsStringToSign } from "./sns-signer";
export type {
  CapturedAttachment,
  CheckEntry,
  CheckId,
  CheckReport,
  CheckStatus,
  ConformanceFixture,
  EventSample,
  RunChecksOptions,
  SendFixture,
  WebhookFixture,
  WebhookSample,
} from "./types";
