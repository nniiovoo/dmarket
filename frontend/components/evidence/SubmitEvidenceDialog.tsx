"use client";

import { useEffect, useRef, useState } from "react";
import type { Hash } from "viem";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import {
  evidenceRegistryV3Abi,
  getEvidenceRegistryForOrder
} from "@/lib/contracts";
import { decodeDappError } from "@/lib/errors";
import type { ApiOrder } from "@/lib/orders";
import { useEnsureChain } from "@/lib/useEnsureChain";
import { useSiweAuth } from "@/lib/useSiweAuth";

type UploadResponse = {
  manifestId?: string;
  uri?: string;
  contentHash?: string;
  attachmentCount?: number;
  totalBytes?: number;
  error?: string;
};

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 8000;

export function SubmitEvidenceDialog({
  order,
  onClose,
  onSubmitted
}: {
  order: ApiOrder;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const { address: connectedAddress } = useAccount();
  // Picks the V3 or V3.1 EvidenceRegistry based on order.marketplaceVersion.
  // V3.1 orders MUST submit to the V3.1 registry — the V3 registry's
  // marketplace() check would revert otherwise.
  const registryAddress = getEvidenceRegistryForOrder(order);

  const { writeContractAsync, isPending: walletPending } = useWriteContract();
  const { ensure, switching } = useEnsureChain();
  const siwe = useSiweAuth();

  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [previewURLs, setPreviewURLs] = useState<Map<File, string>>(new Map());
  const [fireOracle, setFireOracle] = useState(false);
  const [uploadedURI, setUploadedURI] = useState<string | undefined>();
  const [uploadedSummary, setUploadedSummary] = useState<string | undefined>();
  const [hash, setHash] = useState<Hash | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [phase, setPhase] = useState<"idle" | "uploading" | "submitting">("idle");

  const handledReceipt = useRef<Hash | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const receipt = useWaitForTransactionReceipt({ hash });
  const receiptPending = hash !== undefined && receipt.isPending;
  const busy =
    phase !== "idle" ||
    walletPending ||
    receiptPending ||
    switching;

  const normalizedConnected = connectedAddress?.toLowerCase();
  const isParty =
    normalizedConnected !== undefined &&
    (normalizedConnected === order.buyer.toLowerCase() ||
      normalizedConnected === order.seller.toLowerCase());

  const hasContent = description.trim().length > 0 || files.length > 0;

  useEffect(() => {
    if (receipt.isSuccess && handledReceipt.current !== hash) {
      handledReceipt.current = hash;
      onSubmitted();
      onClose();
    }
  }, [receipt.isSuccess, hash, onSubmitted, onClose]);

  // Generate / clean up object URLs for image previews.
  useEffect(() => {
    const next = new Map<File, string>();
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        const existing = previewURLs.get(f);
        next.set(f, existing ?? URL.createObjectURL(f));
      }
    }
    // Revoke ones no longer referenced.
    for (const [f, url] of previewURLs.entries()) {
      if (!next.has(f)) URL.revokeObjectURL(url);
    }
    setPreviewURLs(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  useEffect(() => {
    return () => {
      for (const url of previewURLs.values()) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = (incoming: FileList | File[]) => {
    setError(undefined);
    const accepted: File[] = [];
    for (const f of Array.from(incoming)) {
      if (files.length + accepted.length >= MAX_FILES) {
        setError(`Maximum ${MAX_FILES} files per submission.`);
        break;
      }
      if (f.size > MAX_FILE_BYTES) {
        setError(`${f.name} is larger than 10 MB.`);
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
  };

  const removeFile = (file: File) => {
    setFiles((prev) => prev.filter((f) => f !== file));
  };

  const ensureSiwe = async (): Promise<boolean> => {
    if (siwe.matchesConnected) return true;
    const result = await siwe.signIn();
    if (!result.ok) {
      setError(`Sign-in failed: ${result.error}`);
      return false;
    }
    return true;
  };

  const uploadPackage = async (): Promise<string | undefined> => {
    setPhase("uploading");
    setError(undefined);
    try {
      const form = new FormData();
      form.set("chainId", String(order.chainId));
      form.set("onChainOrderId", order.onChainOrderId);
      form.set("description", description);
      // Tells the backend which order table to query (V3 vs V3.1). Defaulting
      // to "v3" on the server keeps existing V3 callers working unchanged.
      form.set("marketplaceVersion", order.marketplaceVersion);
      for (const f of files) form.append("files", f);

      let res = await fetch("/api/evidence/upload", {
        method: "POST",
        body: form,
        credentials: "include"
      });

      if (res.status === 401) {
        const ok = await ensureSiwe();
        if (!ok) return undefined;
        // Retry with the freshly-issued session cookie.
        const retry = new FormData();
        retry.set("chainId", String(order.chainId));
        retry.set("onChainOrderId", order.onChainOrderId);
        retry.set("description", description);
        retry.set("marketplaceVersion", order.marketplaceVersion);
        for (const f of files) retry.append("files", f);
        res = await fetch("/api/evidence/upload", {
          method: "POST",
          body: retry,
          credentials: "include"
        });
      }

      const data = (await res.json().catch(() => ({}))) as UploadResponse;
      if (!res.ok || !data.uri) {
        setError(data.error ?? `Upload failed (${res.status})`);
        return undefined;
      }

      setUploadedURI(data.uri);
      setUploadedSummary(
        `✓ Uploaded privately: ${formatUploadSummary(data.attachmentCount ?? 0, data.totalBytes ?? 0)}. ` +
          `Now confirm the on-chain submission in your wallet — your files are already saved, ` +
          `so if the wallet popup is rejected or missed, just click the button again.`
      );
      return data.uri;
    } catch (err) {
      setError(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      setPhase((p) => (p === "uploading" ? "idle" : p));
    }
  };

  const submitOnChain = async (uri: string) => {
    try {
      setPhase("submitting");
      try {
        await ensure(order.chainId);
      } catch {
        setError("Network switch required");
        setPhase("idle");
        return;
      }

      const args = [BigInt(order.onChainOrderId), uri] as const;
      const txHash = await writeContractAsync({
        address: registryAddress!,
        abi: evidenceRegistryV3Abi,
        chainId: order.chainId,
        functionName: fireOracle ? "submitEvidenceWithOracleQuery" : "submitEvidence",
        args
      });
      setHash(txHash);
    } catch (err: unknown) {
      const decoded = decodeDappError(err);
      setError(`${decoded.title}: ${decoded.message}`);
      setPhase("idle");
    }
  };

  const submit = async () => {
    if (!registryAddress) {
      setError("EvidenceRegistry is not deployed on this chain");
      return;
    }
    if (!isParty) {
      setError("Only the buyer or seller of this order can submit evidence");
      return;
    }

    // If files are already uploaded, this click only retries the on-chain
    // confirmation. The wallet should show exactly one prompt this time.
    if (uploadedURI) {
      setError(undefined);
      await submitOnChain(uploadedURI);
      return;
    }

    if (!hasContent) {
      setError("Add a description, one or more files, or both.");
      return;
    }
    setError(undefined);

    const uri = await uploadPackage();
    if (!uri) return; // error already set

    // Give the wallet a beat to clean up the SIWE prompt before we open the
    // tx prompt. Without this, some wallets (notably MetaMask under load)
    // auto-reject the second request as a duplicate.
    await new Promise((r) => setTimeout(r, 400));

    await submitOnChain(uri);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-950">Submit dispute evidence</h2>
          <button onClick={onClose} disabled={busy} className="text-slate-500 hover:text-slate-700">
            ✕
          </button>
        </div>

        {!registryAddress && (
          <div className="mt-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
            EvidenceRegistry is not configured on this chain yet.
          </div>
        )}
        {registryAddress && !isParty && (
          <div className="mt-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
            You are not a party of this order.
          </div>
        )}

        <label className="mt-4 block text-sm">
          <span className="text-slate-700">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION_CHARS))}
            placeholder="Describe what happened. The product was wrong, missing parts, damaged on arrival, ..."
            rows={5}
            disabled={busy}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
          <div className="mt-1 flex justify-between text-xs text-slate-500">
            <span>What you say here is shown alongside your attachments to the Kleros jurors.</span>
            <span>{description.length}/{MAX_DESCRIPTION_CHARS}</span>
          </div>
        </label>

        <div className="mt-4">
          <span className="text-sm text-slate-700">Attachments (optional)</span>
          <div className="mt-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif,image/heic,application/pdf,text/plain"
              disabled={busy || files.length >= MAX_FILES}
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              className="block w-full text-xs text-slate-600 file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1.5 file:text-xs file:text-slate-700 hover:file:bg-slate-200"
            />
          </div>
          <span className="mt-1 block text-xs text-slate-500">
            Image/PDF/text. Up to {MAX_FILES} files, 10 MB each, 25 MB total. Stored privately; only buyer, seller,
            platform admin, and the Kleros jurors of this dispute can read.
          </span>

          {files.length > 0 && (
            <ul className="mt-3 grid grid-cols-2 gap-2">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="relative flex items-center gap-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs"
                >
                  {previewURLs.get(f) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previewURLs.get(f)!} alt={f.name} className="h-10 w-10 rounded object-cover" />
                  ) : (
                    <div className="grid h-10 w-10 place-items-center rounded bg-slate-200 text-[10px] text-slate-600">
                      {f.type === "application/pdf" ? "PDF" : f.type.split("/")[0] ?? "FILE"}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium text-slate-700">{f.name}</div>
                    <div className="text-slate-500">{formatBytes(f.size)}</div>
                  </div>
                  <button
                    onClick={() => removeFile(f)}
                    disabled={busy}
                    aria-label={`Remove ${f.name}`}
                    className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {uploadedSummary && (
          <div className="mt-3 rounded bg-emerald-50 p-2 text-xs text-emerald-800 break-all">{uploadedSummary}</div>
        )}

        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={fireOracle}
            onChange={(e) => setFireOracle(e.target.checked)}
            disabled={busy}
            className="mt-0.5"
          />
          <span className="text-slate-700">
            Also trigger a fresh Chainlink delivery oracle query (costs LINK from platform subscription, 1h cooldown
            per order).
          </span>
        </label>

        {error && (
          <div className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={
              busy ||
              !registryAddress ||
              !isParty ||
              (!hasContent && !uploadedURI)
            }
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {switching
              ? "Switching network…"
              : phase === "uploading"
                ? "Uploading…"
                : phase === "submitting" || walletPending
                  ? "Awaiting wallet…"
                  : receiptPending
                    ? "Confirming on-chain…"
                    : uploadedURI
                      ? "Confirm on-chain →"
                      : fireOracle
                        ? "Upload + Submit + Query Oracle"
                        : "Upload + Submit Evidence"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatUploadSummary(fileCount: number, totalBytes: number) {
  if (fileCount === 0) {
    return "Description only, no attachments";
  }
  return `${fileCount} file${fileCount === 1 ? "" : "s"}, ${formatBytes(totalBytes)}`;
}
