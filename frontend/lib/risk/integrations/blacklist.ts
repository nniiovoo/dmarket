import { isBlocked } from "@/lib/blacklist";

export async function loadBlacklistFacts(
  addresses: string[]
): Promise<{ blacklisted: string[] }> {
  const results = await Promise.all(
    addresses.map(async (addr) => ({ addr, blocked: await isBlocked(addr) }))
  );
  return { blacklisted: results.filter((r) => r.blocked).map((r) => r.addr) };
}
