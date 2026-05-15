// On-disk format for a complete piece of dispute evidence. One manifest =
// one Submit Evidence click = one on-chain submitEvidence call. The manifest
// itself is stored as an EvidenceUpload row with
// contentType = EVIDENCE_PACKAGE_CONTENT_TYPE; its URL is what gets committed
// on-chain. Attachments referenced inside live as their own EvidenceUpload
// rows, fetched separately through the same auth gate.

export const EVIDENCE_PACKAGE_CONTENT_TYPE = "application/vnd.chainus.evidence+json";

export type EvidenceAttachment = {
  fileId: string;         // EvidenceUpload.id of the attachment
  fileName: string;
  contentType: string;
  size: number;
  contentHash: string;    // 0x-prefixed keccak256 of the attachment bytes
};

export type EvidenceManifestV1 = {
  version: 1;
  kind: "chainus-dispute-evidence";
  chainId: number;
  onChainOrderId: string;
  description: string;     // user-supplied text; "" if attachments-only
  submittedBy: string;     // lowercased wallet address
  submittedAt: string;     // ISO timestamp
  attachments: EvidenceAttachment[];
};

export function isEvidenceManifest(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  // Trim any charset suffix.
  return contentType.split(";")[0]?.trim() === EVIDENCE_PACKAGE_CONTENT_TYPE;
}
