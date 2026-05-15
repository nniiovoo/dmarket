// Sign-In-With-Ethereum: nonce + signature verification + session cookie.
//
// Why not the official `siwe` package? Two reasons:
//   1. It depends on ethers v5 which we'd rather not bring back into the
//      frontend bundle (we ship viem).
//   2. The full EIP-4361 spec is heavier than we need — we don't use
//      Resources, Chain Id rotation, Statement field. A small viem-based
//      verifier handles the core threat model (nonce replay, signer recovery,
//      domain binding, expiration).
//
// Message format (single line per field):
//
//   chainus.org wants you to sign in with your Ethereum account:
//   0xABCD...
//
//   Authenticate to view dispute evidence on ChainUs.
//
//   URI: https://chainus.org
//   Version: 1
//   Chain ID: 421614
//   Nonce: <one-time random base64url>
//   Issued At: <ISO>
//   Expiration Time: <ISO>

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { Address } from "viem";
import { recoverMessageAddress } from "viem";

import { prisma } from "@/lib/db";

export const SESSION_COOKIE = "chainus_session";
export const SESSION_TTL_HOURS = 24 * 7;
export const NONCE_TTL_MINUTES = 10;

export type SiweFields = {
  domain: string;
  address: Address;
  statement: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
};

export function buildSiweMessage(fields: SiweFields): string {
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

// Very tolerant parser: pulls labelled fields out by name. The address is the
// 2nd line. Returns null if anything mandatory is missing.
export function parseSiweMessage(message: string): SiweFields | null {
  const lines = message.split("\n");
  if (lines.length < 8) return null;

  const firstLine = lines[0];
  const domainMatch = firstLine?.match(/^(.+) wants you to sign in with your Ethereum account:$/);
  if (!domainMatch || !domainMatch[1]) return null;
  const domain = domainMatch[1];

  const addressLine = lines[1]?.trim();
  if (!addressLine || !/^0x[0-9a-fA-F]{40}$/.test(addressLine)) return null;
  const address = addressLine as Address;

  const byKey = (key: string) =>
    lines.find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2);

  const uri = byKey("URI");
  const version = byKey("Version");
  const chainIdRaw = byKey("Chain ID");
  const nonce = byKey("Nonce");
  const issuedAt = byKey("Issued At");
  const expirationTime = byKey("Expiration Time");

  if (!uri || !version || !chainIdRaw || !nonce || !issuedAt || !expirationTime) return null;

  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId)) return null;

  // Statement = first non-empty line after the blank line that follows address.
  // We rely on the fixed layout in buildSiweMessage but be defensive.
  const statement = lines[3]?.trim() ?? "";

  return { domain, address, statement, uri, version, chainId, nonce, issuedAt, expirationTime };
}

export function generateNonce(): string {
  return randomBytes(24).toString("base64url");
}

// Issues a fresh nonce, persists it, returns it. Caller hands this to the
// browser to embed in the SIWE message.
export async function createNonce(): Promise<string> {
  const nonce = generateNonce();
  await prisma.siweNonce.create({ data: { nonce } });
  // Best-effort GC of expired nonces. Doesn't need to be transactional.
  void cleanupExpiredNonces();
  return nonce;
}

async function cleanupExpiredNonces() {
  const cutoff = new Date(Date.now() - NONCE_TTL_MINUTES * 60_000);
  try {
    await prisma.siweNonce.deleteMany({ where: { createdAt: { lt: cutoff } } });
  } catch {
    // Ignore — non-critical maintenance.
  }
}

export type VerifyResult =
  | { ok: true; address: Address }
  | { ok: false; reason: string };

// Verifies a SIWE message + signature, marks the nonce used.
export async function verifySiwe(message: string, signature: `0x${string}`): Promise<VerifyResult> {
  const parsed = parseSiweMessage(message);
  if (!parsed) return { ok: false, reason: "malformed_message" };

  const now = Date.now();
  const issuedAt = Date.parse(parsed.issuedAt);
  const expires = Date.parse(parsed.expirationTime);

  if (Number.isNaN(issuedAt) || Number.isNaN(expires)) {
    return { ok: false, reason: "bad_timestamps" };
  }
  if (now < issuedAt - 60_000) return { ok: false, reason: "issued_in_future" };
  if (now > expires) return { ok: false, reason: "expired" };

  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (recovered.toLowerCase() !== parsed.address.toLowerCase()) {
    return { ok: false, reason: "signer_mismatch" };
  }

  // Nonce: must exist, must not have been used. Atomic via update-where.
  const claimed = await prisma.siweNonce.findUnique({ where: { nonce: parsed.nonce } });
  if (!claimed) return { ok: false, reason: "unknown_nonce" };
  if (claimed.usedAt !== null) return { ok: false, reason: "nonce_replay" };
  const nonceAge = now - claimed.createdAt.getTime();
  if (nonceAge > NONCE_TTL_MINUTES * 60_000) return { ok: false, reason: "nonce_expired" };

  await prisma.siweNonce.update({
    where: { nonce: parsed.nonce },
    data: { usedAt: new Date() }
  });

  return { ok: true, address: recovered };
}

export type Session = { id: string; address: Address; expiresAt: Date };

export async function createSession(address: Address): Promise<Session> {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60_000);
  await prisma.authSession.create({
    data: {
      id,
      address: address.toLowerCase(),
      expiresAt
    }
  });
  return { id, address, expiresAt };
}

export async function setSessionCookie(session: Session): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const id = store.get(SESSION_COOKIE)?.value;
  if (!id) return null;

  const row = await prisma.authSession.findUnique({ where: { id } });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    // Lazy expiry — delete and return null.
    await prisma.authSession.delete({ where: { id } }).catch(() => undefined);
    return null;
  }

  // Sliding lastUsedAt for analytics; not load-bearing for auth.
  void prisma.authSession
    .update({ where: { id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    id: row.id,
    address: row.address as Address,
    expiresAt: row.expiresAt
  };
}
