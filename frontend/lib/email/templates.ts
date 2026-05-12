import { formatEther } from "viem";

import { appBaseUrl } from "@/lib/email/client";
import type { ApiOrder } from "@/lib/orders";
import { carrierName } from "@/lib/carriers";

export type NotificationKind = "OrderPaid" | "OrderShipped" | "OrderCompleted" | "OrderDisputed" | "OrderRefunded";

export type NotificationTemplate = {
  subject: string;
  html: string;
  text: string;
};

export function renderNotification(kind: NotificationKind, order: ApiOrder): NotificationTemplate {
  const productName = order.product?.name ?? `Product #${order.productId}`;
  const orderUrl = `${appBaseUrl()}/orders/${order.onChainOrderId}?chainId=${order.chainId}`;
  const amount = safeFormatEther(order.amountWei);
  const common = {
    productName,
    orderUrl,
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
  }
}

function buildTemplate({
  title,
  subject,
  intro,
  productName,
  orderUrl,
  amount,
  order,
  shipping = false
}: {
  title: string;
  subject: string;
  intro: string;
  productName: string;
  orderUrl: string;
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
            <tr><td><p style="margin:20px 0 0;color:#64748b;font-size:12px;">你可以在 Settings 中移除或更新通知邮箱。</p></td></tr>
          </table>
        </td>
      </tr>
    </table>
  `;
  const shippingText = shipping
    ? `\n承运商：${carrierName(order.carrier)}\n物流单号：${order.trackingNumber ?? "卖家未提供物流信息"}\n追踪链接：${order.trackingUrl ?? "-"}`
    : "";

  return {
    subject,
    html,
    text: `${title}\n\n${intro}\n订单号：#${order.onChainOrderId}\n商品：${productName}\n金额：${amount} ETH / MATIC\n状态：${order.status}${shippingText}\n\n订单详情：${orderUrl}`
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
