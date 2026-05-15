import { test } from "node:test";
import assert from "node:assert";

import {
  OAUTH_JWT_DEFAULT_TTL_SECONDS,
  OAuthConfigError,
  signOAuthJwt,
  verifyOAuthJwt
} from "./auth";

const BUYER = "0x1111111111111111111111111111111111111111";
const SECRET = "test-secret-but-long-enough";

function withEnv<T>(secret: string | undefined, fn: () => T): T {
  const prior = process.env.OAUTH_JWT_SECRET;
  if (secret === undefined) delete process.env.OAUTH_JWT_SECRET;
  else process.env.OAUTH_JWT_SECRET = secret;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.OAUTH_JWT_SECRET;
    else process.env.OAUTH_JWT_SECRET = prior;
  }
}

test("signOAuthJwt + verifyOAuthJwt round-trip", () => {
  withEnv(SECRET, () => {
    const token = signOAuthJwt({
      sub: BUYER,
      cid: "smoke",
      exp: Math.floor(Date.now() / 1000) + OAUTH_JWT_DEFAULT_TTL_SECONDS
    });
    const result = verifyOAuthJwt(token);
    assert.ok(result.ok, `expected verify to succeed, got ${JSON.stringify(result)}`);
    if (result.ok) {
      assert.strictEqual(result.claims.sub, BUYER);
      assert.strictEqual(result.claims.cid, "smoke");
    }
  });
});

test("verifyOAuthJwt rejects tampered payload", () => {
  withEnv(SECRET, () => {
    const token = signOAuthJwt({
      sub: BUYER,
      cid: "smoke",
      exp: Math.floor(Date.now() / 1000) + 60
    });
    const [h, p, s] = token.split(".");
    // Flip a single bit in the payload by swapping the buyer address.
    const tampered = Buffer.from(
      JSON.stringify({
        sub: "0x2222222222222222222222222222222222222222",
        cid: "smoke",
        iss: "chainus.org",
        aud: "chainus-ai",
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 60
      })
    )
      .toString("base64")
      .replace(/=+$/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const result = verifyOAuthJwt(`${h}.${tampered}.${s}`);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.reason, "bad_signature");
    // touch p so the linter doesn't complain about an unused destructure
    assert.ok(p.length > 0);
  });
});

test("verifyOAuthJwt rejects expired tokens", () => {
  withEnv(SECRET, () => {
    const token = signOAuthJwt({
      sub: BUYER,
      cid: "smoke",
      exp: Math.floor(Date.now() / 1000) - 5
    });
    const result = verifyOAuthJwt(token);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.reason, "expired");
  });
});

test("verifyOAuthJwt rejects wrong-algorithm header", () => {
  withEnv(SECRET, () => {
    const fakeHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))
      .toString("base64")
      .replace(/=+$/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const fakePayload = Buffer.from(
      JSON.stringify({
        sub: BUYER,
        cid: "x",
        iss: "chainus.org",
        aud: "chainus-ai",
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 60
      })
    )
      .toString("base64")
      .replace(/=+$/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const result = verifyOAuthJwt(`${fakeHeader}.${fakePayload}.signature`);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.reason, "wrong_alg");
  });
});

test("signOAuthJwt throws OAuthConfigError when secret missing", () => {
  withEnv(undefined, () => {
    assert.throws(
      () =>
        signOAuthJwt({
          sub: BUYER,
          cid: "smoke",
          exp: Math.floor(Date.now() / 1000) + 60
        }),
      (err) => err instanceof OAuthConfigError
    );
  });
});
