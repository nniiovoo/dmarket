// Browser-safe SIWE message builder. Mirrors the format in
// lib/auth/siwe.ts so verifier and client never diverge.
//
// Kept in its own file (no "use server"/"use client" directives, no
// node-only imports) so both the React hook and a future test harness can
// import it without pulling in cookies()/prisma.

export type SiweClientFields = {
  domain: string;
  address: `0x${string}`;
  statement: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
};

export function buildSiweMessageClient(fields: SiweClientFields): string {
  return [
    `${fields.domain} wants you to sign in with your Ethereum account:`,
    fields.address,
    "",
    fields.statement,
    "",
    `URI: ${fields.uri}`,
    `Version: ${fields.version}`,
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expiration Time: ${fields.expirationTime}`
  ].join("\n");
}
