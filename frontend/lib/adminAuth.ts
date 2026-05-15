import type { Session } from "@/lib/auth/siwe";

function adminAddressSet(): Set<string> {
  const raw = process.env.EVIDENCE_ADMIN_ADDRESSES ?? "";
  const set = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(trimmed)) set.add(trimmed);
  }
  return set;
}

export function isAdmin(session: Session | null): boolean {
  if (!session) return false;
  return adminAddressSet().has(session.address.toLowerCase());
}
