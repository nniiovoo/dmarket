import { test } from "node:test";
import assert from "node:assert";

import { __setOAuthClientsForTesting, findClient, isAllowedRedirect } from "./oauthClients";

test("findClient returns null for unknown clientId", () => {
  __setOAuthClientsForTesting([]);
  assert.strictEqual(findClient("nope"), null);
});

test("findClient returns matching client by id", () => {
  __setOAuthClientsForTesting([
    {
      id: "alpha",
      secret: "s1",
      redirectUris: ["https://example.com/cb"],
      name: "Alpha"
    },
    {
      id: "beta",
      secret: "s2",
      redirectUris: ["https://other.com/cb"],
      name: "Beta"
    }
  ]);
  const alpha = findClient("alpha");
  assert.ok(alpha);
  assert.strictEqual(alpha!.name, "Alpha");
});

test("isAllowedRedirect is exact-match only — no prefix / wildcard", () => {
  const client = {
    id: "x",
    secret: "s",
    redirectUris: ["https://example.com/cb"],
    name: "X"
  };
  assert.strictEqual(isAllowedRedirect(client, "https://example.com/cb"), true);
  assert.strictEqual(isAllowedRedirect(client, "https://example.com/cb?evil=1"), false);
  assert.strictEqual(isAllowedRedirect(client, "https://example.com/cb/sub"), false);
  assert.strictEqual(isAllowedRedirect(client, "https://attacker.example.com/cb"), false);
});

// Reset between test files just in case.
test.after(() => {
  __setOAuthClientsForTesting(null);
});
