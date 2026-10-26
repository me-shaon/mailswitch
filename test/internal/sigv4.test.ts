import { describe, expect, it } from "vitest";
import { bytesToHex } from "../../src/internal/encoding";
import {
  amzDate,
  canonicalRequest,
  type SigV4Request,
  signingKey,
  signRequest,
  uriEncode,
} from "../../src/internal/sigv4";

// Vectors from the AWS SigV4 test suite (aws-sig-v4-test-suite): the credentials, the
// scope, the time, and the expected signatures of the named cases. The same values were
// also recomputed with the aws4fetch reference signer before it was removed.
const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const SCOPE = { region: "us-east-1", service: "service" };
const NOW = Date.UTC(2015, 7, 30, 12, 36, 0);
const HOST = "https://example.amazonaws.com";
const STS_TOKEN =
  "AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==";

interface Vector {
  name: string;
  request: SigV4Request;
  sessionToken?: string;
  signedHeaders: string;
  signature: string;
}

const VECTORS: Vector[] = [
  {
    name: "get-vanilla",
    request: { method: "GET", url: `${HOST}/` },
    signedHeaders: "host;x-amz-date",
    signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  },
  {
    name: "post-vanilla",
    request: { method: "POST", url: `${HOST}/` },
    signedHeaders: "host;x-amz-date",
    signature: "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
  },
  {
    name: "get-vanilla-query-order-key-case",
    request: { method: "GET", url: `${HOST}/?Param2=value2&Param1=value1` },
    signedHeaders: "host;x-amz-date",
    signature: "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
  },
  {
    name: "post-x-www-form-urlencoded",
    request: {
      method: "POST",
      url: `${HOST}/`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "Param1=value1",
    },
    signedHeaders: "content-type;host;x-amz-date",
    signature: "ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
  },
  {
    name: "get-vanilla-query-unreserved",
    request: {
      method: "GET",
      url: `${HOST}/?-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz=-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`,
    },
    signedHeaders: "host;x-amz-date",
    signature: "9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197",
  },
  {
    name: "post-header-key-sort",
    request: { method: "POST", url: `${HOST}/`, headers: { "My-Header1": "value1" } },
    signedHeaders: "host;my-header1;x-amz-date",
    signature: "c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c",
  },
  {
    name: "get-header-value-trim",
    request: {
      method: "GET",
      url: `${HOST}/`,
      headers: { "My-Header1": " value1", "My-Header2": ' "a   b   c"' },
    },
    signedHeaders: "host;my-header1;my-header2;x-amz-date",
    signature: "acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736",
  },
  {
    name: "post-sts-header-before",
    request: { method: "POST", url: `${HOST}/` },
    sessionToken: STS_TOKEN,
    signedHeaders: "host;x-amz-date;x-amz-security-token",
    signature: "85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead",
  },
];

describe("sigv4", () => {
  for (const vector of VECTORS) {
    it(`matches the AWS test suite vector ${vector.name}`, async () => {
      const credentials = {
        ...CREDENTIALS,
        ...(vector.sessionToken ? { sessionToken: vector.sessionToken } : {}),
      };
      const headers = await signRequest(vector.request, credentials, SCOPE, NOW);
      expect(headers.authorization).toBe(
        `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${vector.signedHeaders}, Signature=${vector.signature}`,
      );
      expect(headers["x-amz-date"]).toBe("20150830T123600Z");
      expect(headers.host).toBeUndefined();
      if (vector.sessionToken) expect(headers["x-amz-security-token"]).toBe(vector.sessionToken);
    });
  }

  it("builds the canonical request of get-vanilla", async () => {
    const { text } = await canonicalRequest({ method: "GET", url: `${HOST}/` }, NOW);
    expect(text).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
  });

  it("derives the signing key of the AWS documentation example", async () => {
    // https://docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html
    const key = await signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", {
      region: "us-east-1",
      service: "iam",
    });
    expect(bytesToHex(key)).toBe(
      "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
    );
  });

  it("encodes reserved characters and double-encodes path segments", async () => {
    expect(uriEncode("a b!*'()~")).toBe("a%20b%21%2A%27%28%29~");
    const { text } = await canonicalRequest(
      { method: "GET", url: `${HOST}/v2/email/identities/a%40b.com` },
      NOW,
    );
    expect(text.split("\n")[1]).toBe("/v2/email/identities/a%2540b.com");
    expect(amzDate(NOW)).toBe("20150830T123600Z");
  });

  it("returns a new signature for a new body and the same one for the same input", async () => {
    const sign = (body: string) =>
      signRequest({ method: "POST", url: `${HOST}/`, body }, CREDENTIALS, SCOPE, NOW);
    const a = await sign("one");
    expect((await sign("one")).authorization).toBe(a.authorization);
    expect((await sign("two")).authorization).not.toBe(a.authorization);
  });
});
