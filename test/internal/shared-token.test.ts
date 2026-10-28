import { describe, expect, it } from "vitest";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import {
  checkSharedTokenSecret,
  generateSharedTokenSecret,
  SHARED_TOKEN_MIN_HEX_LENGTH,
  SHARED_TOKEN_MIN_LENGTH,
  sharedTokenVerifier,
} from "../../src/internal/shared-token";

const SECRET = "test-shared-token-secret-one";
const PREVIOUS = "test-previous-token-secret-two";
const USER = "mailswitch";

const basic = (user: string, pass: string): string =>
  `Basic ${bytesToBase64(utf8(`${user}:${pass}`))}`;
const headers = (authorization?: string): Headers =>
  new Headers(authorization === undefined ? {} : { authorization });

const both = sharedTokenVerifier({
  name: "Test",
  schemes: [{ type: "basic", username: USER }, { type: "bearer" }],
});
const basicOnly = sharedTokenVerifier({
  name: "Test",
  schemes: [{ type: "basic", username: USER }],
});
const bearerOnly = sharedTokenVerifier({ name: "Test", schemes: [{ type: "bearer" }] });

describe("shared webhook token", () => {
  it("accepts the right Basic username and secret, and the right Bearer token", async () => {
    expect(await both(headers(basic(USER, SECRET)), SECRET)).toEqual({ ok: true });
    expect(await basicOnly(headers(basic(USER, SECRET)), SECRET)).toEqual({ ok: true });
    expect(await both(headers(`Bearer ${SECRET}`), SECRET)).toEqual({ ok: true });
    expect(await bearerOnly(headers(`Bearer ${SECRET}`), SECRET)).toEqual({ ok: true });
  });

  it("parses the scheme without regard to case", async () => {
    for (const scheme of ["bearer", "BEARER", "BeArEr"]) {
      expect(await bearerOnly(headers(`${scheme} ${SECRET}`), SECRET)).toEqual({ ok: true });
    }
    const value = basic(USER, SECRET).slice("Basic ".length);
    expect(await basicOnly(headers(`BASIC ${value}`), SECRET)).toEqual({ ok: true });
  });

  it("accepts a password that holds a colon", async () => {
    const secret = `${SECRET}:x`;
    expect(await basicOnly(headers(basic(USER, secret)), secret)).toEqual({ ok: true });
  });

  it("accepts the previous secret during a rotation, and only while it is set", async () => {
    const rotating = sharedTokenVerifier({
      name: "Test",
      schemes: [{ type: "basic", username: USER }, { type: "bearer" }],
      previousSecret: PREVIOUS,
    });
    expect(await rotating(headers(basic(USER, PREVIOUS)), SECRET)).toEqual({ ok: true });
    expect(await rotating(headers(`Bearer ${PREVIOUS}`), SECRET)).toEqual({ ok: true });
    expect(await rotating(headers(basic(USER, SECRET)), SECRET)).toEqual({ ok: true });
    expect(await both(headers(basic(USER, PREVIOUS)), SECRET)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("gives bad_signature for a wrong secret, a wrong username, and an empty username", async () => {
    const bad = { ok: false, reason: "bad_signature" };
    expect(await both(headers(basic(USER, PREVIOUS)), SECRET)).toEqual(bad);
    expect(await both(headers(basic("someone", SECRET)), SECRET)).toEqual(bad);
    expect(await both(headers(basic("", SECRET)), SECRET)).toEqual(bad);
    expect(await both(headers(`Bearer ${PREVIOUS}`), SECRET)).toEqual(bad);
    // A Bearer token of `user:secret` is not a Basic value.
    expect(await both(headers(`Bearer ${USER}:${SECRET}`), SECRET)).toEqual(bad);
  });

  it("gives bad_signature for a missing header, an empty secret, and another scheme", async () => {
    const bad = { ok: false, reason: "bad_signature" };
    expect(await both(headers(), SECRET)).toEqual(bad);
    expect(await both(headers(`Bearer ${SECRET}`), "")).toEqual(bad);
    expect(await basicOnly(headers(`Bearer ${SECRET}`), SECRET)).toEqual(bad);
    expect(await bearerOnly(headers(basic(USER, SECRET)), SECRET)).toEqual(bad);
    expect(await both(headers(`Token ${SECRET}`), SECRET)).toEqual(bad);
  });

  it("gives malformed for a Basic value that is not base64, not UTF-8, or has no colon", async () => {
    const malformed = { ok: false, reason: "malformed" };
    expect(await both(headers("Basic not-base64!"), SECRET)).toEqual(malformed);
    expect(
      await both(headers(`Basic ${bytesToBase64(new Uint8Array([0xff, 0x3a, 0x61]))}`), SECRET),
    ).toEqual(malformed);
    expect(await both(headers(`Basic ${bytesToBase64(utf8(SECRET))}`), SECRET)).toEqual(malformed);
  });

  it("does not parse a header loosely", async () => {
    const malformed = { ok: false, reason: "malformed" };
    expect(await both(headers(`Bearer  ${SECRET}`), SECRET)).toEqual(malformed);
    expect(await both(headers(`Bearer\t${SECRET}`), SECRET)).toEqual(malformed);
    expect(await both(headers(`Bearer ${SECRET} extra`), SECRET)).toEqual(malformed);
    expect(await both(headers(SECRET), SECRET)).toEqual(malformed);
    expect(await both(headers("Bearer"), SECRET)).toEqual(malformed);
    expect(await both(headers(`Bearer-x ${SECRET}`), SECRET)).toEqual(malformed);
  });

  it("refuses a weak secret as invalid_secret, and the setup check throws", async () => {
    const short = "a".repeat(SHARED_TOKEN_MIN_LENGTH - 1).replace(/^a/, "z");
    const shortHex = "a".repeat(SHARED_TOKEN_MIN_HEX_LENGTH - 1);
    expect(short).toHaveLength(21);
    expect(shortHex).toHaveLength(31);
    expect(() => checkSharedTokenSecret(short, "Test")).toThrow(TypeError);
    expect(() => checkSharedTokenSecret(shortHex, "Test")).toThrow(TypeError);
    expect(() => checkSharedTokenSecret("a".repeat(32), "Test")).not.toThrow();
    expect(() => checkSharedTokenSecret("z".repeat(22), "Test")).not.toThrow();
    expect(() => checkSharedTokenSecret(short, "Test")).toThrow(
      /^The Test webhook secret is too short: it needs 128 bits\.$/,
    );
    expect(await both(headers(`Bearer ${short}`), short)).toEqual({
      ok: false,
      reason: "invalid_secret",
    });
    expect(await both(headers(`Bearer ${shortHex}`), shortHex)).toEqual({
      ok: false,
      reason: "invalid_secret",
    });
  });

  it("throws TypeError at setup for no scheme, a bad username, or a weak previous secret", () => {
    const setup = (options: Parameters<typeof sharedTokenVerifier>[0]) => () =>
      sharedTokenVerifier(options);
    expect(setup({ name: "Test", schemes: [] })).toThrow(/needs a scheme/);
    for (const username of ["", "a:b", "a b", "x".repeat(129)]) {
      expect(setup({ name: "Test", schemes: [{ type: "basic", username }] })).toThrow(TypeError);
    }
    expect(
      setup({ name: "Test", schemes: [{ type: "bearer" }], previousSecret: "a".repeat(31) }),
    ).toThrow(/too short/);
  });

  it("generates a secret that passes the check", () => {
    const secret = generateSharedTokenSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => checkSharedTokenSecret(secret, "Test")).not.toThrow();
    expect(generateSharedTokenSecret()).not.toBe(secret);
  });
});
