// mailswitch/testing: test helpers for apps and adapter authors.

export { fakeFixture } from "./fake-fixture";
export {
  FAKE_API_BASE,
  FAKE_SIGNATURE_HEADER,
  FAKE_WEBHOOK_TOLERANCE_MS,
  type FakeOutcome,
  type FakeProvider,
  type FakeProviderOptions,
  type FakeSend,
  fakeMeta,
  fakeProvider,
  fakeSignedPayload,
} from "./fake-provider";
