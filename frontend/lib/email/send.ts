import { prisma } from "@/lib/db";
import { emailFrom, isEmailEnabled, resend } from "@/lib/email/client";
import { getEmailForAddress, getOwnerEmail } from "@/lib/email/recipientLookup";
import { renderNotification, type NotificationKind } from "@/lib/email/templates";
import { getOrder } from "@/lib/orders";

const debounceMs = 24 * 60 * 60 * 1000;

export async function sendNotification(
  toWalletAddress: string,
  kind: NotificationKind,
  payload: { chainId: number; onChainOrderId: string }
): Promise<void> {
  try {
    const toAddress = toWalletAddress.toLowerCase();
    const toEmail = await getEmailForAddress(toAddress);

    if (!toEmail) {
      await logEmail({ toAddress, toEmail: "", kind, ...payload, status: "skipped", error: "No bound email" });
      return;
    }

    await sendToEmail(toAddress, toEmail, kind, payload);
  } catch (error) {
    await logEmail({
      toAddress: toWalletAddress.toLowerCase(),
      toEmail: "",
      kind,
      ...payload,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown email failure"
    });
  }
}

export async function sendOwnerNotification(kind: NotificationKind, payload: { chainId: number; onChainOrderId: string }): Promise<void> {
  try {
    const toEmail = getOwnerEmail();

    if (!toEmail) {
      await logEmail({ toAddress: "platform-owner", toEmail: "", kind, ...payload, status: "skipped", error: "No owner email" });
      return;
    }

    await sendToEmail("platform-owner", toEmail, kind, payload);
  } catch (error) {
    await logEmail({
      toAddress: "platform-owner",
      toEmail: "",
      kind,
      ...payload,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown email failure"
    });
  }
}

export function queueNotification(
  toWalletAddress: string,
  kind: NotificationKind,
  payload: { chainId: number; onChainOrderId: string },
  delayMs = 0
) {
  if (delayMs <= 0) {
    void sendNotification(toWalletAddress, kind, payload);
    return;
  }

  setTimeout(() => {
    void sendNotification(toWalletAddress, kind, payload);
  }, delayMs);
}

async function sendToEmail(
  toAddress: string,
  toEmail: string,
  kind: NotificationKind,
  payload: { chainId: number; onChainOrderId: string }
) {
  const duplicate = await prisma.emailLog.findFirst({
    where: {
      toAddress,
      kind,
      chainId: payload.chainId,
      onChainOrderId: payload.onChainOrderId,
      status: "sent",
      createdAt: { gte: new Date(Date.now() - debounceMs) }
    }
  });

  if (duplicate) {
    await logEmail({ toAddress, toEmail, kind, ...payload, status: "skipped", error: "Duplicate within 24h" });
    return;
  }

  if (!isEmailEnabled() || !resend) {
    await logEmail({ toAddress, toEmail, kind, ...payload, status: "skipped", error: "RESEND_API_KEY not configured" });
    return;
  }

  const order = await getOrder(payload.chainId, payload.onChainOrderId);

  if (!order) {
    await logEmail({ toAddress, toEmail, kind, ...payload, status: "failed", error: "Order not found" });
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
      await logEmail({ toAddress, toEmail, kind, ...payload, status: "failed", error: result.error.message });
      return;
    }

    await logEmail({ toAddress, toEmail, kind, ...payload, status: "sent" });
  } catch (error) {
    await logEmail({
      toAddress,
      toEmail,
      kind,
      ...payload,
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
  status,
  error
}: {
  toAddress: string;
  toEmail: string;
  kind: NotificationKind;
  chainId: number;
  onChainOrderId: string;
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
      status,
      error
    }
  });
}
