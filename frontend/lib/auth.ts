import { verifyMessage } from "viem";

const MESSAGE_VALID_WINDOW_MS = 5 * 60 * 1000;

export type AuthRequest = {
  sellerAddress: string;
  signature: `0x${string}`;
  signedMessage: string;
};

export type WalletAuthRequest = {
  walletAddress: string;
  signature: `0x${string}`;
  signedMessage: string;
};

export async function verifySellerSignature(
  req: AuthRequest,
  expectedPrefix: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!req.signedMessage.startsWith(expectedPrefix)) {
    return { ok: false, reason: "Message prefix mismatch" };
  }

  const parts = req.signedMessage.split(":");
  const timestamp = Number(parts[parts.length - 2]);

  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > MESSAGE_VALID_WINDOW_MS) {
    return { ok: false, reason: "Message expired or invalid timestamp" };
  }

  const messageSeller = parts[parts.length - 1]?.toLowerCase();
  if (messageSeller !== req.sellerAddress.toLowerCase()) {
    return { ok: false, reason: "Address mismatch in message" };
  }

  const valid = await verifyMessage({
    address: req.sellerAddress as `0x${string}`,
    message: req.signedMessage,
    signature: req.signature
  });

  if (!valid) {
    return { ok: false, reason: "Invalid signature" };
  }

  return { ok: true };
}

export async function verifyWalletSignature(
  req: WalletAuthRequest,
  expectedPrefix: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!req.signedMessage.startsWith(expectedPrefix)) {
    return { ok: false, reason: "Message prefix mismatch" };
  }

  const parts = req.signedMessage.split(":");
  const timestamp = Number(parts[parts.length - 2]);

  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > MESSAGE_VALID_WINDOW_MS) {
    return { ok: false, reason: "Message expired or invalid timestamp" };
  }

  const messageWallet = parts[parts.length - 1]?.toLowerCase();
  if (messageWallet !== req.walletAddress.toLowerCase()) {
    return { ok: false, reason: "Address mismatch in message" };
  }

  const valid = await verifyMessage({
    address: req.walletAddress as `0x${string}`,
    message: req.signedMessage,
    signature: req.signature
  });

  if (!valid) {
    return { ok: false, reason: "Invalid signature" };
  }

  return { ok: true };
}
