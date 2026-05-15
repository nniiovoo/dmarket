"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";

import {
  type EvidenceManifestV1,
  EVIDENCE_PACKAGE_CONTENT_TYPE,
  isEvidenceManifest
} from "@/lib/evidencePackage";
import { useSiweAuth } from "@/lib/useSiweAuth";

type FileMeta = {
  fileName: string;
  contentType: string;
  size: number;
};

type ViewerState =
  | { kind: "loading" }
  | { kind: "needs_wallet" }
  | { kind: "needs_siwe" }
  | { kind: "checking_access" }
  | { kind: "forbidden"; reason: string }
  | { kind: "ready_file"; blobUrl: string; meta: FileMeta; reason: string }
  | { kind: "ready_package"; manifest: EvidenceManifestV1; reason: string }
  | { kind: "error"; message: string };

export default function EvidenceViewerPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const next = search.get("next");
  const evidenceId = params.id;

  const { isConnected, address } = useAccount();
  const siwe = useSiweAuth();
  const [state, setState] = useState<ViewerState>({ kind: "loading" });
  const [forceReload, setForceReload] = useState(0);

  useEffect(() => {
    if (siwe.status === "checking") return;
    if (!isConnected) {
      setState({ kind: "needs_wallet" });
      return;
    }
    if (!siwe.matchesConnected) {
      setState({ kind: "needs_siwe" });
      return;
    }

    let cancelled = false;
    setState({ kind: "checking_access" });

    void (async () => {
      try {
        const url = next ?? `/api/evidence/files/${evidenceId}`;
        const res = await fetch(url, { credentials: "include" });
        if (cancelled) return;

        if (res.status === 401) {
          setState({ kind: "needs_siwe" });
          return;
        }
        if (res.status === 403) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setState({ kind: "forbidden", reason: body.error ?? "not_authorized" });
          return;
        }
        if (!res.ok) {
          setState({ kind: "error", message: `Server returned ${res.status}` });
          return;
        }

        const reason = res.headers.get("X-Access-Reason") ?? "unknown";
        const contentType = res.headers.get("Content-Type") ?? "application/octet-stream";

        if (isEvidenceManifest(contentType)) {
          const manifest = (await res.json()) as EvidenceManifestV1;
          setState({ kind: "ready_package", manifest, reason });
          return;
        }

        const filename = parseFilename(res.headers.get("Content-Disposition")) ?? "evidence";
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);

        setState({
          kind: "ready_file",
          blobUrl,
          meta: { fileName: filename, contentType, size: blob.size },
          reason
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err)
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isConnected, siwe.status, siwe.matchesConnected, address, evidenceId, next, forceReload]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-xl font-semibold text-slate-950">Dispute evidence</h1>
      <p className="mt-1 text-sm text-slate-600">Evidence ID: <span className="font-mono">{evidenceId}</span></p>

      {(state.kind === "loading" || state.kind === "checking_access") && (
        <div className="mt-6 rounded border border-slate-200 bg-white p-4 text-sm text-slate-700">
          {state.kind === "loading" ? "Initialising…" : "Checking your access permissions…"}
        </div>
      )}

      {state.kind === "needs_wallet" && (
        <div className="mt-6 rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <div className="font-medium">Connect a wallet</div>
          <div className="mt-1">
            Evidence is restricted to the order's buyer, seller, the platform admin, and Kleros V2 jurors of the
            related dispute. Connect your wallet (top-right) to verify your identity.
          </div>
        </div>
      )}

      {state.kind === "needs_siwe" && (
        <div className="mt-6 rounded border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          <div className="font-medium">Sign in to confirm your wallet</div>
          <div className="mt-1">
            Click the button below to sign a one-time message. No transaction, no gas. The signature proves you
            control wallet <span className="font-mono">{address}</span> and grants you 7-day access.
          </div>
          <button
            onClick={async () => {
              const result = await siwe.signIn();
              if (result.ok) setForceReload((v) => v + 1);
            }}
            disabled={siwe.status === "signing" || siwe.status === "verifying"}
            className="mt-3 rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {siwe.status === "signing"
              ? "Sign in your wallet…"
              : siwe.status === "verifying"
                ? "Verifying…"
                : "Sign in with Ethereum"}
          </button>
          {siwe.error && (
            <div className="mt-2 text-xs text-red-700">{siwe.error}</div>
          )}
        </div>
      )}

      {state.kind === "forbidden" && (
        <div className="mt-6 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <div className="font-medium">Access denied</div>
          <div className="mt-1">
            Wallet <span className="font-mono">{address}</span> is not a recognised viewer of this evidence (reason:{" "}
            <span className="font-mono">{state.reason}</span>).
          </div>
          <div className="mt-2 text-xs text-red-700">
            If you believe this is wrong: check you're connected with the right wallet, or that the Kleros dispute is
            in the Evidence/Vote period (juror lists are only available while the dispute is active).
          </div>
        </div>
      )}

      {state.kind === "error" && (
        <div className="mt-6 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <div className="font-medium">Could not load evidence</div>
          <div className="mt-1">{state.message}</div>
        </div>
      )}

      {state.kind === "ready_file" && (
        <div className="mt-6 space-y-4">
          <AccessBadge reason={state.reason} extra={`File: ${state.meta.fileName} (${formatBytes(state.meta.size)})`} />
          <FilePreview blobUrl={state.blobUrl} contentType={state.meta.contentType} filename={state.meta.fileName} />
        </div>
      )}

      {state.kind === "ready_package" && (
        <PackageView manifest={state.manifest} reason={state.reason} />
      )}
    </div>
  );
}

function PackageView({ manifest, reason }: { manifest: EvidenceManifestV1; reason: string }) {
  return (
    <div className="mt-6 space-y-4">
      <AccessBadge
        reason={reason}
        extra={`Submitted by ${shortAddr(manifest.submittedBy)} at ${new Date(manifest.submittedAt).toLocaleString()}`}
      />

      {manifest.description.length > 0 && (
        <article className="rounded border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-medium text-slate-700">Description</h2>
          <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm text-slate-900">
            {manifest.description}
          </pre>
        </article>
      )}

      {manifest.attachments.length === 0 ? (
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          No file attachments — this submission is text-only.
        </div>
      ) : (
        <section className="rounded border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-medium text-slate-700">
            Attachments ({manifest.attachments.length})
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {manifest.attachments.map((a) => (
              <AttachmentCard key={a.fileId} attachment={a} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AttachmentCard({
  attachment
}: {
  attachment: EvidenceManifestV1["attachments"][number];
}) {
  const [imgBlob, setImgBlob] = useState<string | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const url = `/api/evidence/files/${attachment.fileId}`;
  const isImage = attachment.contentType.startsWith("image/");

  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (cancelled) return;
        if (!res.ok) {
          setImgError(`${res.status}`);
          return;
        }
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setImgBlob(objectUrl);
      } catch (err) {
        if (!cancelled) setImgError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isImage, url]);

  return (
    <li className="overflow-hidden rounded border border-slate-200">
      <a href={url} target="_blank" rel="noreferrer" className="block">
        {isImage && imgBlob ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgBlob} alt={attachment.fileName} className="h-40 w-full object-cover" />
        ) : isImage && imgError ? (
          <div className="grid h-40 place-items-center bg-slate-100 text-xs text-red-600">
            preview error: {imgError}
          </div>
        ) : isImage ? (
          <div className="grid h-40 place-items-center bg-slate-50 text-xs text-slate-500">loading…</div>
        ) : (
          <div className="grid h-40 place-items-center bg-slate-50">
            <span className="text-2xl text-slate-400">
              {attachment.contentType === "application/pdf" ? "PDF" : "FILE"}
            </span>
          </div>
        )}
      </a>
      <div className="border-t border-slate-200 bg-white px-3 py-2 text-xs">
        <div className="truncate font-medium text-slate-700">{attachment.fileName}</div>
        <div className="flex justify-between text-slate-500">
          <span>{formatBytes(attachment.size)}</span>
          <a href={url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
            open ↗
          </a>
        </div>
      </div>
    </li>
  );
}

function AccessBadge({ reason, extra }: { reason: string; extra?: string }) {
  return (
    <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
      Access granted as <span className="font-mono font-medium">{reason}</span>.
      {extra ? <span className="ml-1 text-emerald-800">{extra}</span> : null}
    </div>
  );
}

function FilePreview({
  blobUrl,
  contentType,
  filename
}: {
  blobUrl: string;
  contentType: string;
  filename: string;
}) {
  if (contentType.startsWith("image/")) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={blobUrl} alt={filename} className="max-h-[80vh] w-auto rounded border" />;
  }
  if (contentType === "application/pdf") {
    return (
      <object data={blobUrl} type="application/pdf" className="h-[80vh] w-full rounded border">
        <a href={blobUrl} download={filename}>Download {filename}</a>
      </object>
    );
  }
  return (
    <div className="rounded border bg-slate-50 p-3 text-sm">
      <a href={blobUrl} download={filename} className="text-blue-700 hover:underline">
        Download {filename}
      </a>
    </div>
  );
}

function parseFilename(disposition: string | null): string | null {
  if (!disposition) return null;
  const m = disposition.match(/filename="([^"]+)"/);
  return m?.[1] ?? null;
}

function shortAddr(a: string) {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Silence "unused import" warning if turbo doesn't tree-shake this constant.
void EVIDENCE_PACKAGE_CONTENT_TYPE;
