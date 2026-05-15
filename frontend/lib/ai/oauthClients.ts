// OAuth client registry.
//
// MVP keeps the client list in environment variables rather than in the
// database. Two reasons:
//   1. There are very few clients (1 — the ChatGPT Custom GPT — at I.3
//      launch, with Claude MCP / Apps later). A DB table would be
//      ceremony for ~3 rows.
//   2. Client secrets should not be readable by the same db role that the
//      AI endpoints use. Env-scoped secrets keep blast radius small.
//
// Env format (one client per slot, slot keys are CSV in OAUTH_CLIENT_SLOTS):
//
//   OAUTH_CLIENT_SLOTS=chatgpt,local
//   OAUTH_CLIENT_CHATGPT_ID=chatgpt-shopping-gpt
//   OAUTH_CLIENT_CHATGPT_SECRET=...
//   OAUTH_CLIENT_CHATGPT_REDIRECT_URIS=https://chat.openai.com/aip/g-xxxxx/oauth/callback
//
// Redirect URIs are comma-separated. Comparisons are exact-match
// (no wildcard / prefix matching — that's an open-redirect footgun).

export interface OAuthClient {
  id: string;
  secret: string;
  redirectUris: string[];
  name: string; // human-readable, shown on the SIWE landing page
}

function parseSlots(): string[] {
  const raw = process.env.OAUTH_CLIENT_SLOTS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readClientFromSlot(slot: string): OAuthClient | null {
  const upper = slot.toUpperCase().replace(/-/g, "_");
  const id = process.env[`OAUTH_CLIENT_${upper}_ID`];
  const secret = process.env[`OAUTH_CLIENT_${upper}_SECRET`];
  const redirectRaw = process.env[`OAUTH_CLIENT_${upper}_REDIRECT_URIS`];
  if (!id || !secret || !redirectRaw) return null;
  const redirectUris = redirectRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (redirectUris.length === 0) return null;
  const name = process.env[`OAUTH_CLIENT_${upper}_NAME`] ?? slot;
  return { id, secret, redirectUris, name };
}

let cachedClients: OAuthClient[] | null = null;

function loadClients(): OAuthClient[] {
  if (cachedClients !== null) return cachedClients;
  const slots = parseSlots();
  const clients = slots
    .map(readClientFromSlot)
    .filter((c): c is OAuthClient => c !== null);
  cachedClients = clients;
  return clients;
}

export function findClient(clientId: string): OAuthClient | null {
  return loadClients().find((c) => c.id === clientId) ?? null;
}

export function isAllowedRedirect(client: OAuthClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

// Test-only seam to avoid env juggling in unit tests.
export function __setOAuthClientsForTesting(clients: OAuthClient[] | null): void {
  cachedClients = clients;
}
