// Quick standalone test: send one email via Resend to a hardcoded recipient.
// Run: cd frontend && npx tsx scripts/sendTestEmail.ts
//
// Usage:
//   npx tsx scripts/sendTestEmail.ts                    # sends to default test address
//   TO=foo@bar.com npx tsx scripts/sendTestEmail.ts     # override recipient

import dotenv from "dotenv";
import { Resend } from "resend";

dotenv.config({ path: ".env.local" });

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.EMAIL_FROM;
const to = process.env.TO ?? "danielni0418@outlook.com";

if (!apiKey) {
  console.error("Missing RESEND_API_KEY in .env.local");
  process.exit(1);
}

if (!from) {
  console.error("Missing EMAIL_FROM in .env.local");
  process.exit(1);
}

const resend = new Resend(apiKey);
const fromEmail = from;

async function main() {
  console.log(`Sending test email`);
  console.log(`  from: ${from}`);
  console.log(`  to:   ${to}`);

  const result = await resend.emails.send({
    from: fromEmail,
    to,
    subject: "ChainUs 邮件测试 - chainus.org domain",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #0f172a; margin: 0 0 16px;">📬 ChainUs 测试邮件</h2>
        <p style="color: #334155; line-height: 1.6;">
          如果你能在 <strong>收件箱</strong>（不是 spam）看到这封邮件，
          说明 <code>chainus.org</code> 的 SPF / DKIM 配置都对了。
        </p>
        <p style="color: #334155; line-height: 1.6;">
          这意味着你接下来可以给 <strong>任何邮箱</strong> 发订单状态通知，
          不再限于 Resend 注册时绑定的那个 gmail。
        </p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="color: #64748b; font-size: 13px;">
          发件时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}<br />
          发件人：${from}<br />
          收件人：${to}
        </p>
      </div>
    `,
    text: `ChainUs 测试邮件\n\n如果你能在收件箱看到这封邮件（不是 spam），说明 chainus.org 的 SPF/DKIM 配置都对了。\n\n发件时间: ${new Date().toLocaleString("zh-CN")}\n发件人: ${from}\n收件人: ${to}`
  });

  if (result.error) {
    console.error("❌ Resend returned an error:");
    console.error(result.error);
    process.exit(1);
  }

  console.log(`✅ Sent. Resend message id: ${result.data?.id ?? "(no id)"}`);
  console.log(`\nCheck ${to} inbox (and spam folder).`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
