import { prisma } from "@/lib/db";
import { emailFrom, isEmailEnabled, resend } from "@/lib/email/client";
import { getEmailForAddress, getOwnerEmail } from "@/lib/email/recipientLookup";
import { renderNotification, type NotificationKind } from "@/lib/email/templates";
import { getOrder, type MarketplaceVersion } from "@/lib/orders";

// Default dedup window: a given recipient gets at most one notification of
// the same kind for the same order per 24 hours. Lifecycle events (paid,
// shipped, completed, …) are nearly idempotent and a noisy retry would just
// annoy the user.
const debounceMs = 24 * 60 * 60 * 1000;

// Per-kind override for the 24h default. Chat is conversational — collapsing
// every reply within a day into a single email would defeat the purpose of
// the notification. One hour strikes a balance between "too chatty" and
// "user actually finds out someone replied".
const dedupWindowMsByKind: Partial<Record<NotificationKind, number>> = {
  NewChatMessage: 60 * 60 * 1000
};

export async function sendNotification(
  toWalletAddress: string,
  kind: NotificationKind,
  payload: { chainId: number; onChainOrderId: string },
  marketplaceVersion: MarketplaceVersion = "v3"
): Promise<void> {
  try {
    const toAddress = toWalletAddress.toLowerCase();
    const toEmail = await getEmailForAddress(toAddress);

    if (!toEmail) {
      await logEmail({ toAddress, toEmail: "", kind, ...payload, marketplaceVersion, status: "skipped", error: "No bound email" });
      return;
    }

    await sendToEmail(toAddress, toEmail, kind, payload, marketplaceVersion);
  } catch (error) {
    await logEmail({
      toAddress: toWalletAddress.toLowerCase(),
      toEmail: "",
      kind,
      ...payload,
      marketplaceVersion,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown email failure"
    });
  }
}

export async function sendOwnerNotification(
  kind: NotificationKind,
  payload: { chainId: number; onChainOrderId: string },
  marketplaceVersion: MarketplaceVersion = "v3"
): Promise<void> {
  try {
    const toEmail = getOwnerEmail();

    if (!toEmail) {
      await logEmail({ toAddress: "platform-owner", toEmail: "", kind, ...payload, marketplaceVersion, status: "skipped", error: "No owner email" });
      return;
    }

    await sendToEmail("platform-owner", toEmail, kind, payload, marketplaceVersion);
  } catch (error) {
    await logEmail({
      toAddress: "platform-owner",
      toEmail: "",
      kind,
      ...payload,
      marketplaceVersion,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown email failure"
    });
  }
}

export function queueNotification(
  toWalletAddress: string,
  kind: NotificationKind,
  payload: { chainId: number; onChainOrderId: string },
  marketplaceVersion: MarketplaceVersion = "v3",
  delayMs = 0
) {
  if (delayMs <= 0) {
    void sendNotification(toWalletAddress, kind, payload, marketplaceVersion);
    return;
  }

  setTimeout(() => {
    void sendNotification(toWalletAddress, kind, payload, marketplaceVersion);
  }, delayMs);
}

async function sendToEmail(
  toAddress: string,
  toEmail: string,
  kind: NotificationKind,
  payload: { chainId: number; onChainOrderId: string },
  marketplaceVersion: MarketplaceVersion
) {
  const windowMs = dedupWindowMsByKind[kind] ?? debounceMs;
  const duplicate = await prisma.emailLog.findFirst({
    where: {
      toAddress,
      kind,
      chainId: payload.chainId,
      onChainOrderId: payload.onChainOrderId,
      marketplaceVersion,
      status: "sent",
      createdAt: { gte: new Date(Date.now() - windowMs) }
    }
  });

  if (duplicate) {
    await logEmail({
      toAddress,
      toEmail,
      kind,
      ...payload,
      marketplaceVersion,
      status: "skipped",
      error: `Duplicate within ${Math.round(windowMs / 3_600_000)}h`
    });
    return;
  }

  if (!isEmailEnabled() || !resend) {
    await logEmail({ toAddress, toEmail, kind, ...payload, marketplaceVersion, status: "skipped", error: "RESEND_API_KEY not configured" });
    return;
  }

  const order = await getOrder(payload.chainId, payload.onChainOrderId, marketplaceVersion);

  if (!order) {
    await logEmail({ toAddress, toEmail, kind, ...payload, marketplaceVersion, status: "failed", error: "Order not found" });
    return;
  }

  const template = renderNotification(kind, order);

  try {
    const result = await resend.emails.send({
      from: emailFrom(),
      to: toEmail,
      subject: template.subject,
      html: template.html,
      text: template.text
    });

    if (result.error) {
      await logEmail({ toAddress, toEmail, kind, ...payload, marketplaceVersion, status: "failed", error: result.error.message });
      return;
    }

    await logEmail({ toAddress, toEmail, kind, ...payload, marketplaceVersion, status: "sent" });
  } catch (error) {
    await logEmail({
      toAddress,
      toEmail,
      kind,
      ...payload,
      marketplaceVersion,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown email failure"
    });
  }
}

async function logEmail({
  toAddress,
  toEmail,
  kind,
  chainId,
  onChainOrderId,
  marketplaceVersion,
  status,
  error
}: {
  toAddress: string;
  toEmail: string;
  kind: NotificationKind;
  chainId: number;
  onChainOrderId: string;
  marketplaceVersion: MarketplaceVersion;
  status: "sent" | "skipped" | "failed";
  error?: string;
}) {
  await prisma.emailLog.create({
    data: {
      toAddress,
      toEmail,
      kind,
      chainId,
      onChainOrderId,
      marketplaceVersion,
      status,
      error
    }
  });
}
