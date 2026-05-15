// Storage backend abstraction for evidence files.
//
// Two backends:
//   - "local": files written under EVIDENCE_STORAGE_DIR (default ./evidence-uploads).
//     Suitable for dev and small self-hosted deployments. Files are NOT served
//     by Next's public asset pipeline — they're only readable through the
//     gated /api/evidence/files/[id] endpoint, so a wrong-permission filesystem
//     mount is the only way data leaks.
//   - "r2": Cloudflare R2 (S3-compatible). Not implemented yet but the
//     interface below is shaped so adding it is a single new file.
//
// The choice is per-process via STORAGE_BACKEND. Mixing backends within one
// install is not supported — the storageBackend column on EvidenceUpload
// records what wrote each row, so existing files keep working if you flip
// the env later.

import { mkdir, readFile, writeFile, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { keccak256 } from "viem";

const requireRel = createRequire(import.meta.url);

export type StorageBackend = "local" | "r2";

export interface StoredFile {
  backend: StorageBackend;
  key: string;       // backend-specific path/key
  size: number;
  contentHash: string; // 0x-prefixed keccak256 hex
}

export interface StorageAdapter {
  backend: StorageBackend;
  put(key: string, data: Buffer, contentType: string): Promise<StoredFile>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

class LocalFsAdapter implements StorageAdapter {
  backend: StorageBackend = "local";

  constructor(private rootDir: string) {}

  private full(key: string) {
    // Defensive: refuse keys that try to escape the root via "../".
    const r = resolve(this.rootDir, key);
    if (!r.startsWith(resolve(this.rootDir))) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return r;
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<StoredFile> {
    const path = this.full(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return {
      backend: this.backend,
      key,
      size: data.length,
      contentHash: keccak256Hex(data)
    };
  }

  async get(key: string): Promise<Buffer> {
    return await readFile(this.full(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.full(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.full(key));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return;
      throw err;
    }
  }
}

const cached = new Map<StorageBackend, StorageAdapter>();

export function getStorage(preferredBackend?: StorageBackend | string): StorageAdapter {
  const backend = (preferredBackend ?? process.env.STORAGE_BACKEND ?? "local") as StorageBackend;

  const existing = cached.get(backend);
  if (existing) return existing;

  if (backend === "local") {
    const root = process.env.EVIDENCE_STORAGE_DIR ?? join(process.cwd(), "evidence-uploads");
    const adapter = new LocalFsAdapter(root);
    cached.set(backend, adapter);
    return adapter;
  }

  if (backend === "r2") {
    // Lazy-load so the AWS SDK doesn't get pulled in for users who stay
    // on the local backend. createRequire works in both ESM and CJS contexts.
    const { createR2AdapterFromEnv } = requireRel("./r2") as typeof import("./r2");
    const adapter = createR2AdapterFromEnv();
    cached.set(backend, adapter);
    return adapter;
  }

  throw new Error(`Unknown STORAGE_BACKEND: ${backend}`);
}

// keccak256 over the raw file bytes. Matches the on-chain hash family used
// by EvidenceRegistry, so a future on-chain integrity check can compare
// hashes directly. Returns 0x-prefixed lowercase hex.
export function keccak256Hex(data: Buffer): string {
  return keccak256(new Uint8Array(data));
}

// Builds the storage key for a given evidence ID. Keeps files organized so
// you can ls a chain or order's evidence on the local FS easily.
export function buildStorageKey(
  chainId: number,
  onChainOrderId: string,
  evidenceId: string,
  fileName: string
): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return `${chainId}/${onChainOrderId}/${evidenceId}_${safe}`;
}
