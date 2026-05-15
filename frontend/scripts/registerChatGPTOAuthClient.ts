// Mints OAuth client_id + client_secret for the ChatGPT Custom GPT lane
// and prints the env block the operator should paste into `.env`.
//
// We don't *write* to .env automatically — env files are operator
// territory and we don't want a stray script clobbering an existing
// secret. The script:
//
//   1. If OAUTH_CLIENT_CHATGPT_ID is already set, prints the current
//      configuration (secret masked) and exits without changing it.
//   2. Otherwise generates id (uuid v4) + secret (32 random bytes hex)
//      and prints a copy-pasteable env block.
//
// REDIRECT_URIS is left as a placeholder — ChatGPT only reveals the
// callback URL after the GPT is saved for the first time. See
// docs/CHATGPT_CUSTOM_GPT_SETUP.md §5.
//
// Usage:
//   cd frontend
//   npx tsx scripts/registerChatGPTOAuthClient.ts

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig({ path: ".env" });
dotenvConfig({ path: "../.env" });

import { randomBytes, randomUUID } from "node:crypto";

function maskSecret(secret: string): string {
  if (secret.length <= 8) return "***";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

function existingSlots(): string[] {
  const raw = process.env.OAUTH_CLIENT_SLOTS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function main() {
  const id = process.env.OAUTH_CLIENT_CHATGPT_ID;
  const secret = process.env.OAUTH_CLIENT_CHATGPT_SECRET;
  const redirects = process.env.OAUTH_CLIENT_CHATGPT_REDIRECT_URIS;
  const name = process.env.OAUTH_CLIENT_CHATGPT_NAME ?? "ChainUs Shopper (ChatGPT)";

  if (id && secret) {
    console.log("\nChatGPT OAuth client is already configured:\n");
    console.log(`  OAUTH_CLIENT_SLOTS=${process.env.OAUTH_CLIENT_SLOTS ?? "(unset)"}`);
    console.log(`  OAUTH_CLIENT_CHATGPT_ID=${id}`);
    console.log(`  OAUTH_CLIENT_CHATGPT_SECRET=${maskSecret(secret)}`);
    console.log(`  OAUTH_CLIENT_CHATGPT_NAME=${name}`);
    console.log(`  OAUTH_CLIENT_CHATGPT_REDIRECT_URIS=${redirects ?? "(unset — required before ChatGPT can complete OAuth)"}`);
    if (!redirects) {
      console.log("\nNext step: create the GPT in ChatGPT, copy the revealed callback URL, then set:");
      console.log("  OAUTH_CLIENT_CHATGPT_REDIRECT_URIS=https://chat.openai.com/aip/g-XXXXX/oauth/callback");
      console.log("…and restart the server so lib/ai/oauthClients.ts re-reads env.");
    }
    return;
  }

  const newId = `chatgpt-${randomUUID()}`;
  const newSecret = randomBytes(32).toString("hex");
  const slots = existingSlots();
  const slotsAfter = slots.includes("chatgpt") ? slots : [...slots, "chatgpt"];

  console.log("\nGenerated ChatGPT OAuth client. Paste this block into your .env\n");
  console.log("# --- Phase I.4 — ChatGPT Custom GPT OAuth client ---");
  console.log(`OAUTH_CLIENT_SLOTS=${slotsAfter.join(",")}`);
  console.log(`OAUTH_CLIENT_CHATGPT_ID=${newId}`);
  console.log(`OAUTH_CLIENT_CHATGPT_SECRET=${newSecret}`);
  console.log(`OAUTH_CLIENT_CHATGPT_NAME=${name}`);
  console.log("# Replace g-XXXXX below with your real Custom GPT id once ChatGPT reveals it (see docs/CHATGPT_CUSTOM_GPT_SETUP.md §5).");
  console.log("OAUTH_CLIENT_CHATGPT_REDIRECT_URIS=https://chat.openai.com/aip/g-XXXXX/oauth/callback");
  console.log("");
  console.log("⚠ Treat OAUTH_CLIENT_CHATGPT_SECRET as a production secret. Do NOT commit it.");
  console.log("⚠ Re-running this script will NOT regenerate the secret once .env contains it — delete the old line first if you really want to rotate.");
}

main();
