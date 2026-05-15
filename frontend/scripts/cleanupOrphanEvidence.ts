import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "../lib/db";
import {
  EVIDENCE_PACKAGE_CONTENT_TYPE,
  type EvidenceManifestV1,
  isEvidenceManifest
} from "../lib/evidencePackage";
import { getStorage, type StorageBackend } from "../lib/storage";

loadEnv();

const APPLY = process.argv.includes("--apply");
const ORPHAN_AGE_HOURS = 24;

type UploadRow = {
  id: string;
  storageKey: string;
  storageBackend: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: Date;
};

async function main() {
  const cutoff = new Date(Date.now() - ORPHAN_AGE_HOURS * 60 * 60 * 1000);

  const manifests = await prisma.evidenceUpload.findMany({
    where: {
      createdAt: { lt: cutoff },
      contentType: EVIDENCE_PACKAGE_CONTENT_TYPE
    },
    orderBy: { createdAt: "asc" }
  });

  const plan: UploadRow[] = [];

  for (const manifest of manifests) {
    const manifestPath = `/api/evidence/files/${manifest.id}`;
    const referenced = await prisma.evidence.findFirst({
      where: { evidenceURI: { contains: manifestPath } },
      select: { id: true }
    });

    if (referenced) {
      continue;
    }

    const attachmentIds = await readAttachmentIds(manifest);
    const rows = await prisma.evidenceUpload.findMany({
      where: {
        OR: [
          { id: manifest.id },
          attachmentIds.length > 0 ? { id: { in: attachmentIds } } : { id: "__never__" }
        ]
      },
      orderBy: { createdAt: "asc" }
    });

    for (const row of rows) {
      if (!plan.some((p) => p.id === row.id)) {
        plan.push(row);
      }
    }
  }

  printPlan(plan);

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to delete these rows and storage objects.");
    await prisma.$disconnect();
    return;
  }

  for (const row of plan) {
    const storage = getStorage(row.storageBackend as StorageBackend);
    await storage.delete(row.storageKey);
    await prisma.evidenceUpload.delete({ where: { id: row.id } });
    console.log(`deleted ${row.id} ${row.storageBackend}:${row.storageKey}`);
  }

  await prisma.$disconnect();
}

async function readAttachmentIds(manifest: UploadRow): Promise<string[]> {
  try {
    const storage = getStorage(manifest.storageBackend as StorageBackend);
    const buffer = await storage.get(manifest.storageKey);
    const parsed = JSON.parse(buffer.toString("utf8")) as Partial<EvidenceManifestV1>;
    if (!Array.isArray(parsed.attachments)) return [];
    return parsed.attachments
      .map((attachment) => attachment?.fileId)
      .filter((fileId): fileId is string => typeof fileId === "string" && fileId.length > 0);
  } catch (err) {
    console.warn(
      `warning: could not read manifest ${manifest.id} (${manifest.storageBackend}:${manifest.storageKey}); ` +
        `will delete manifest row only. ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

function printPlan(rows: UploadRow[]) {
  const totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
  console.log(`${APPLY ? "Apply" : "Dry run"}: ${rows.length} EvidenceUpload row(s), ${formatBytes(totalBytes)}`);

  if (rows.length === 0) return;

  for (const row of rows) {
    const marker = isEvidenceManifest(row.contentType) ? "manifest" : "attachment";
    console.log(
      [
        `- ${row.id}`,
        marker,
        row.storageBackend,
        row.storageKey,
        row.fileName,
        formatBytes(row.size),
        row.createdAt.toISOString()
      ].join(" | ")
    );
  }
}

function loadEnv() {
  for (const file of [".env", ".env.local"]) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx);
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] ??= value;
    }
  }
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
