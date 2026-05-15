import { formatEther } from "viem";

import { getExplorerTxUrl } from "@/lib/chains";
import { appBaseUrl } from "@/lib/email/client";
import type { ApiOrder } from "@/lib/orders";
import { carrierName } from "@/lib/carriers";

export type NotificationKind =
  | "OrderPaid"
  | "OrderShipped"
  | "OrderCompleted"
  | "OrderDisputed"
  | "OrderRefunded"
  | "EvidenceSubmittedByBuyer"
  | "EvidenceSubmittedBySeller"
  | "NewChatMessage"
  | "NewDirectMessage";

export type NotificationTemplate = {
  subject: string;
  html: string;
  text: string;
};

export function renderNotification(kind: NotificationKind, order: ApiOrder): NotificationTemplate {
  const productName = order.product?.name ?? `Product #${order.productId}`;
  // V3 lives at /orders, V3.1 at /v3_1/orders, v3.2 at
  // /orders/v3_2/<chainId>/<marketplace>/<orderId>. We deliberately keep
  // the human-facing subject/body identical so users don't learn (or
  // care) about the marketplace version distinction.
  const orderUrl =
    order.marketplaceVersion === "v3.2" && order.marketplaceAddress
      ? `${appBaseUrl()}/orders/v3_2/${order.chainId}/${order.marketplaceAddress}/${order.onChainOrderId}`
      : `${appBaseUrl()}${order.marketplaceVersion === "v3.1" ? "/v3_1/orders" : "/orders"}/${order.onChainOrderId}?chainId=${order.chainId}`;
  const explorerUrl = getExplorerTxUrl(order.chainId, order.lastTxHash ?? undefined);
  const amount = safeFormatEther(order.amountWei);
  const common = {
    productName,
    orderUrl,
    explorerUrl,
    amount,
    order
  };

  switch (kind) {
    case "OrderPaid":
      return buildTemplate({
        title: "你有新订单需要发货",
        subject: "「ChainUs」你有新订单需要发货",
        intro: `订单 #${order.onChainOrderId} 已付款，请准备发货。`,
        ...common
      });
    case "OrderShipped":
      return buildTemplate({
        title: "订单已发货",
        subject: "「ChainUs」订单已发货，可追踪物流",
        intro: `订单 #${order.onChainOrderId} 已由卖家标记发货。`,
        shipping: true,
        ...common
      });
    case "OrderCompleted":
      return buildTemplate({
        title: "订单已完成",
        subject: "「ChainUs」订单已完成，资金已到账",
        intro: `订单 #${order.onChainOrderId} 已完成。`,
        ...common
      });
    case "OrderDisputed":
      return buildTemplate({
        title: "订单争议已发起",
        subject: "「ChainUs」订单争议已发起",
        intro: `订单 #${order.onChainOrderId} 已进入争议状态。`,
        ...common
      });
    case "OrderRefunded":
      return buildTemplate({
        title: "订单已退款",
        subject: "「ChainUs」订单已退款",
        intro: `订单 #${order.onChainOrderId} 已退款给买家。`,
        ...common
      });
    case "EvidenceSubmittedByBuyer":
      return buildTemplate({
        title: "买家提交了新证据",
        subject: "「ChainUs」买家提交了新证据",
        intro: `订单 #${order.onChainOrderId} 的买家在争议中提交了新证据。请尽快查看并回应。`,
        ...common
      });
    case "EvidenceSubmittedBySeller":
      return buildTemplate({
        title: "卖家提交了新证据",
        subject: "「ChainUs」卖家提交了新证据",
        intro: `订单 #${order.onChainOrderId} 的卖家在争议中提交了新证据。请尽快查看并回应。`,
        ...common
      });
    case "NewChatMessage":
      // Deliberately omit the message body and sender address from the
      // email — the chat is private to the two parties and the email is a
      // best-effort nudge, not a transcript. The recipient clicks through
      // to the dapp to see what was said.
      return buildTemplate({
        title: "对方在订单中给你发了新消息",
        subject: "「ChainUs」对方在订单中给你发了新消息",
        intro: `订单 #${order.onChainOrderId} 中对方刚给你发了一条消息，点击查看并回复。`,
        ...common
      });
    case "NewDirectMessage":
      // Direct messages don't ride on an order — this branch shouldn't be
      // reached via renderNotification (which always has an order). The
      // direct-message path uses renderDirectMessageNotification below.
      // Falling through with a generic message just in case some legacy
      // caller wires this kind into the order pipeline.
      return buildTemplate({
        title: "你有一条新私信",
        subject: "「ChainUs」你有一条新私信",
        intro: "你有一条新私信，点击查看并回复。",
        ...common
      });
  }
}

// Direct-message variant of renderNotification. Used by sendDirectMessageEmail
// — no underlying order, so it can't reuse the order-shaped pipeline.
export function renderDirectMessageNotification(args: {
  conversationId: string;
}): NotificationTemplate {
  const url = `${appBaseUrl()}/messages?id=${encodeURIComponent(args.conversationId)}`;
  const title = "你有一条新私信";
  const subject = "「ChainUs」你有一条新私信";
  const intro = "对方刚刚通过 ChainUs 给你发了一条私信，点击查看并回复。";

  const html = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;">
            <tr><td><h1 style="margin:0 0 12px;color:#0f172a;font-size:22px;">${escapeHtml(title)}</h1></td></tr>
            <tr><td><p style="margin:0 0 20px;color:#334155;line-height:1.5;">${escapeHtml(intro)}</p></td></tr>
            <tr><td style="padding-top:8px;"><a href="${escapeAttribute(url)}" style="display:inline-block;background:#0f172a;color:white;text-decoration:none;border-radius:6px;padding:10px 14px;">打开 Messages</a></td></tr>
            <tr><td><p style="margin:20px 0 0;color:#64748b;font-size:12px;">出于隐私考虑，邮件中不显示消息正文或发送者地址。你可以在 Settings 中移除或更新通知邮箱。</p></td></tr>
          </table>
        </td>
      </tr>
    </table>
  `;
  const text = `${title}\n\n${intro}\n\n打开 Messages: ${url}\n\n出于隐私考虑，邮件中不显示消息正文或发送者地址。`;
  return { subject, html, text };
}

function buildTemplate({
  title,
  subject,
  intro,
  productName,
  orderUrl,
  explorerUrl,
  amount,
  order,
  shipping = false
}: {
  title: string;
  subject: string;
  intro: string;
  productName: string;
  orderUrl: string;
  explorerUrl: string | undefined;
  amount: string;
  order: ApiOrder;
  shipping?: boolean;
}): NotificationTemplate {
  const shippingHtml = shipping
    ? `
      <tr><td style="padding:8px 0;color:#64748b;">承运商</td><td style="padding:8px 0;color:#0f172a;">${escapeHtml(carrierName(order.carrier))}</td></tr>
      <tr><td style="padding:8px 0;color:#64748b;">物流单号</td><td style="padding:8px 0;color:#0f172a;">${escapeHtml(order.trackingNumber ?? "卖家未提供物流信息")}</td></tr>
      ${
        order.trackingUrl
          ? `<tr><td style="padding:8px 0;color:#64748b;">追踪链接</td><td style="padding:8px 0;"><a href="${escapeAttribute(order.trackingUrl)}" style="color:#1d4ed8;">打开物流追踪</a></td></tr>`
          : ""
      }
    `
    : "";
  const html = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;">
            <tr><td><h1 style="margin:0 0 12px;color:#0f172a;font-size:22px;">${escapeHtml(title)}</h1></td></tr>
            <tr><td><p style="margin:0 0 20px;color:#334155;line-height:1.5;">${escapeHtml(intro)}</p></td></tr>
            <tr>
              <td>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;padding:8px 0;">
                  <tr><td style="padding:8px 0;color:#64748b;">订单号</td><td style="padding:8px 0;color:#0f172a;">#${escapeHtml(order.onChainOrderId)}</td></tr>
                  <tr><td style="padding:8px 0;color:#64748b;">商品</td><td style="padding:8px 0;color:#0f172a;">${escapeHtml(productName)}</td></tr>
                  <tr><td style="padding:8px 0;color:#64748b;">金额</td><td style="padding:8px 0;color:#0f172a;">${escapeHtml(amount)} ETH / MATIC</td></tr>
                  <tr><td style="padding:8px 0;color:#64748b;">状态</td><td style="padding:8px 0;color:#0f172a;">${escapeHtml(order.status)}</td></tr>
                  ${shippingHtml}
                </table>
              </td>
            </tr>
            <tr><td style="padding-top:20px;"><a href="${escapeAttribute(orderUrl)}" style="display:inline-block;background:#0f172a;color:white;text-decoration:none;border-radius:6px;padding:10px 14px;">查看订单详情</a></td></tr>
            ${
              explorerUrl
                ? `<tr><td style="padding-top:12px;"><a href="${escapeAttribute(explorerUrl)}" style="color:#1d4ed8;text-decoration:underline;font-size:13px;">在区块浏览器验证链上状态</a></td></tr>`
                : ""
            }
            <tr><td><p style="margin:20px 0 0;color:#64748b;font-size:12px;">邮件仅供参考，请始终以链上状态为准。你可以在 Settings 中移除或更新通知邮箱。</p></td></tr>
          </table>
        </td>
      </tr>
    </table>
  `;
  const shippingText = shipping
    ? `\n承运商：${carrierName(order.carrier)}\n物流单号：${order.trackingNumber ?? "卖家未提供物流信息"}\n追踪链接：${order.trackingUrl ?? "-"}`
    : "";

  const explorerText = explorerUrl ? `\n链上验证：${explorerUrl}` : "";

  return {
    subject,
    html,
    text: `${title}\n\n${intro}\n订单号：#${order.onChainOrderId}\n商品：${productName}\n金额：${amount} ETH / MATIC\n状态：${order.status}${shippingText}\n\n订单详情：${orderUrl}${explorerText}\n\n邮件仅供参考，请始终以链上状态为准。`
  };
}

function safeFormatEther(value: string) {
  try {
    return formatEther(BigInt(value));
  } catch {
    return value;
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}
