import { prisma as defaultPrisma } from "@/lib/db";

export type BlacklistEntry = {
  id: number;
  address: string;
  reason: string;
  addedBy: string;
  createdAt: Date;
};

export class BlacklistDuplicateError extends Error {
  constructor(address: string) {
    super(`Address already blacklisted: ${address}`);
    this.name = "BlacklistDuplicateError";
  }
}

const ADDRESS_RE = /^0x[a-f0-9]{40}$/;

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function validateAddress(address: string): string {
  const lower = normalizeAddress(address);
  if (!ADDRESS_RE.test(lower)) throw new Error(`Invalid address: ${address}`);
  return lower;
}

type PrismaBlacklist = {
  findUnique(args: { where: { address: string } }): Promise<BlacklistEntry | null>;
  create(args: { data: Omit<BlacklistEntry, "id" | "createdAt"> }): Promise<BlacklistEntry>;
  deleteMany(args: { where: { address: string } }): Promise<{ count: number }>;
  findMany(args: { orderBy: { createdAt: "asc" | "desc" } }): Promise<BlacklistEntry[]>;
};

type Db = { blacklist: PrismaBlacklist };

function db(): Db {
  return defaultPrisma as unknown as Db;
}

export async function isBlocked(address: string, _db?: Db): Promise<boolean> {
  const lower = normalizeAddress(address);
  const row = await (_db ?? db()).blacklist.findUnique({ where: { address: lower } });
  return row !== null;
}

export async function addEntry(
  opts: { address: string; reason: string; addedBy: string },
  _db?: Db
): Promise<BlacklistEntry> {
  const address = validateAddress(opts.address);
  if (!opts.reason.trim()) throw new Error("reason must not be empty");
  const addedBy = normalizeAddress(opts.addedBy);
  const d = _db ?? db();

  const existing = await d.blacklist.findUnique({ where: { address } });
  if (existing) throw new BlacklistDuplicateError(address);

  return d.blacklist.create({ data: { address, reason: opts.reason, addedBy } });
}

export async function removeEntry(address: string, _db?: Db): Promise<boolean> {
  const lower = normalizeAddress(address);
  const deleted = await (_db ?? db()).blacklist.deleteMany({ where: { address: lower } });
  return deleted.count > 0;
}

export async function listAll(_db?: Db): Promise<BlacklistEntry[]> {
  return (_db ?? db()).blacklist.findMany({ orderBy: { createdAt: "asc" } });
}
