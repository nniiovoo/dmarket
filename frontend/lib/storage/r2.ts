// Cloudflare R2 storage backend.
//
// R2 is S3-compatible — same SDK, different endpoint. The endpoint URL has
// the form https://<account_id>.r2.cloudflarestorage.com and a single
// access-key/secret pair authenticates all operations on the buckets the
// token was scoped to.
//
// Required env (production):
//   R2_ENDPOINT          https://<account>.r2.cloudflarestorage.com
//   R2_ACCESS_KEY_ID     from "R2 → Manage API Tokens → Create"
//   R2_SECRET_ACCESS_KEY (same screen — only shown once at creation)
//   R2_BUCKET            bucket name, e.g. "chainus-evidence-prod"
//
// Files are stored with private (default) ACL. The server reads them on
// behalf of authorized viewers and streams the bytes through
// /api/evidence/files/[id] — R2 URLs are never exposed to the browser.

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { StorageAdapter, StorageBackend, StoredFile } from "./index";
import { keccak256Hex } from "./index";

export class R2Adapter implements StorageAdapter {
  backend: StorageBackend = "r2";

  private client: S3Client;

  constructor(
    private bucket: string,
    endpoint: string,
    accessKeyId: string,
    secretAccessKey: string
  ) {
    this.client = new S3Client({
      // R2 doesn't care about the region but the SDK requires one — "auto"
      // is the Cloudflare-recommended sentinel.
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      // R2 doesn't support the new chunked encoding the SDK uses by default
      // for large uploads. Force flat encoding for compatibility.
      forcePathStyle: true
    });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<StoredFile> {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
      // Defense-in-depth: declare we want private even though R2 buckets are
      // private by default. If a future Cloudflare change makes new objects
      // public, this header keeps existing evidence private.
      ACL: "private"
    });
    await this.client.send(cmd);
    return {
      backend: this.backend,
      key,
      size: data.length,
      contentHash: keccak256Hex(data)
    };
  }

  async get(key: string): Promise<Buffer> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const resp = await this.client.send(cmd);
    if (!resp.Body) {
      throw new Error(`R2 returned empty body for key ${key}`);
    }
    const chunks: Buffer[] = [];
    // @aws-sdk/client-s3 returns a Node Readable in Node, ReadableStream in
    // edge/browser. We only run server-side so the Node path is what matters.
    // The transformToByteArray helper handles both shapes.
    if (typeof (resp.Body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
      const bytes = await (resp.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      return Buffer.from(bytes);
    }
    // Fallback for older SDK shapes — stream-style.
    const stream = resp.Body as AsyncIterable<Uint8Array>;
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status === 404) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function createR2AdapterFromEnv(): R2Adapter {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;

  const missing = [
    ["R2_ENDPOINT", endpoint],
    ["R2_ACCESS_KEY_ID", accessKeyId],
    ["R2_SECRET_ACCESS_KEY", secretAccessKey],
    ["R2_BUCKET", bucket]
  ]
    .filter(([, v]) => !v || (v as string).trim().length === 0)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `STORAGE_BACKEND=r2 but missing env: ${missing.join(", ")}. ` +
        `See frontend/.env.example for the full list.`
    );
  }

  return new R2Adapter(
    bucket!,
    endpoint!,
    accessKeyId!,
    secretAccessKey!
  );
}
