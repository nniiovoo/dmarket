# ChainUs 白皮书

**版本**：v0.9（草案 / Lite Paper）
**日期**：2026 年 5 月
**状态**：所有「已实现」条目均可在 GitHub 主分支与公开 testnet 上验证；所有「规划中」条目均明确标注，未对外承诺时间。

---

## 摘要

**ChainUs 是一个把链上资金安全注入 Web2 电商体验的去中心化交易平台。**

买家像在普通电商一样浏览、下单、查物流、申请售后。买家与卖家之间的货款，则托管在一份开源、可审计的 Escrow 智能合约中。当订单顺利完成，资金从托管合约结算给卖家；当出现争议，平台无权挪用任何一方的资金，最终裁决由去中心化仲裁网络 Kleros V2 完成。

与目前市面上的 Web3 电商 demo 不同，ChainUs 的设计前提是：

1. **Web2 体验是底线**，链上是基础设施，不是用户感知层。
2. **链上只放钱和关键状态**，商品、物流、聊天、证据走 Web2，可被审计但不必上链。
3. **AI 是订单入口的差异点**，不是营销词。

本文档描述 ChainUs 当前已交付的产品（v2 / v3 / v3.1 合约 + Next.js dApp），并明确区分**正在 testnet 上运行的功能**与**路线图规划**。

---

## 1. 问题陈述

### 1.1 中心化电商的资金风险

主流电商平台对货款拥有单方面控制权：

- 平台可冻结卖家账户、延迟结算、强制退款。
- 卖家保证金、信用分由平台单方面计算，没有可移植性。
- 跨境支付链路依赖银行、第三方支付，结算 T+N，且不透明。
- 一旦平台经营失败，未结算货款进入破产清算，无优先权。

### 1.2 Web3 电商现状的问题

现有的「Web3 + 电商」项目大多落在以下三种局限里：

1. **纯链上 demo**：把整个购物流程上链，包括 SKU、库存、UGC。结果是 gas 昂贵、用户体验糟糕、链上数据冗余。
2. **只接受加密原生用户**：要求买家自带钱包、自带链上资产、自带 gas，非加密原生用户的转化率近乎为 0。
3. **没有真实仲裁**：争议依赖平台 owner 用 `ownerEmergencyRefund` 一类的特权，从治理角度看仍是中心化。

### 1.3 我们的判断

电商场景里值得上链的部分只有三类：

- **资金**：托管、结算、退款。
- **关键订单状态**：created / paid / shipped / completed / cancelled / disputed / refunded。
- **仲裁触发与裁决**：可被独立网络验证的争议解决记录。

其他所有东西（商品 metadata、物流、UGC、风控信号）放在可审计的 Web2 后端，对最终用户来说更便宜、更快、更熟悉。

---

## 2. 系统总览

```
                ┌──────────────────────────────────────────┐
 用户入口层      │  Web (Next.js)  · iOS/Android (规划)      │
                │  AI 对话入口（MCP / Claude Apps 规划）     │
                └────────────┬─────────────────────────────┘
                             │
                ┌────────────┴─────────────────────────────┐
 AI 订购层       │  NLU → 选品 → 风险评分 → 草稿订单 → 确认  │
 （规划中）      │       → Checkout → 链上执行              │
                └────────────┬─────────────────────────────┘
                             │
                ┌────────────┴─────────────────────────────┐
 系统服务层      │  商品 · 订单 · 支付 · 通知 · 用户          │
                │  会话/证据 · 物流 · 风控 · RPC 代理        │
                └────────────┬─────────────────────────────┘
                             │
                ┌────────────┴─────────────────────────────┐
 智能合约层      │  EscrowMarketplace + EscrowVault         │
                │  EvidenceRegistry  ·  Kleros V2 Adapter   │
                │  ReputationRegistry (v3.2 草稿)           │
                └────────────┬─────────────────────────────┘
                             │
                ┌────────────┴─────────────────────────────┐
 基础设施层      │  Postgres · R2/S3 · RPC Proxy · 索引器    │
                │  邮件 (Resend) · 17track · LI.FI          │
                └──────────────────────────────────────────┘
```

设计原则：
- **资金独立住**：所有 ETH/MATIC 由独立的 Vault 合约持有，业务合约只调用 Vault；Vault 不知道订单细节。
- **业务都住一起**：订单生命周期、状态机、事件全部在 Marketplace 合约里，方便审计。
- **链下可替换**：商品搜索、推荐、风控可以替换实现，不影响链上资金安全。

---

## 3. 已实现：智能合约层

ChainUs 当前在三条公链上运行三套合约版本：

| 版本 | 网络 | 用途 |
|---|---|---|
| v2 | Sepolia + Polygon Amoy | 已冻结的稳定版，单条链原生币结算 |
| v3 | Arbitrum Sepolia | 接入 Kleros V2 真实仲裁 + EvidenceRegistry |
| v3.1 | Arbitrum Sepolia | 引入签名授权下单（单签 createAndPayWithAuth） |
| v3.2 | Arbitrum Sepolia | ERC-20 结算 + 链上声誉 + Kleros V2 仲裁（已部署） |

### 3.1 订单生命周期

```
Created ──pay──► Paid ──ship──► Shipped ──confirm──► Completed
   │                │              │
   │                │              └──dispute──► Disputed ──resolve──► Completed / Refunded
   │                └──cancel──► Cancelled
   └──cancel──► Cancelled
```

链上动作：`createOrder`, `payOrder`, `markShipped`, `confirmReceived`, `cancelOrder`, `openDispute`, `resolveDispute`, `ownerEmergencyRefund`。每个动作都会发出可索引的事件，被链下 indexer 写入 Postgres。

### 3.2 Escrow + Vault 双合约设计

Marketplace 合约处理订单状态与权限；Vault 合约只做两件事：`deposit` 与 `release`。Vault 不知道订单 ID、不知道谁是卖家，所有调用必须来自被白名单的 Marketplace。

**安全收益**：

- Marketplace 业务升级不需要迁移用户资金。
- Vault 代码极小（几十行），便于形式化审计。
- 攻击面缩小到一个边界清晰的合约对。

### 3.3 EvidenceRegistry（v3 起）

争议证据（聊天记录哈希、物流凭证、IPFS 链接）通过 EvidenceRegistry 上链。链上只存 `keccak256(evidence_blob)` 与提交者地址，原始内容存 R2 / IPFS。这样：

- 链上 gas 成本极低（一条事件）。
- 仲裁员可以验证「这就是争议发生时双方提交的版本」。
- 平台无法事后篡改证据。

### 3.4 Kleros V2 仲裁集成

`KlerosV2DisputeAdapter` 把 Marketplace 与 Kleros 仲裁器解耦：

- Marketplace 触发争议 → 调用 adapter → adapter 调用 Kleros 仲裁器。
- 仲裁结果通过 callback 回流到 Marketplace，更新订单状态。
- adapter 可以替换为其他仲裁网络（Aragon Court、UMA OO）而无需改动 Marketplace。

### 3.5 v3.1：签名授权下单

v3.1 引入 EIP-712 签名授权，允许买家通过一次签名完成「创建订单 + 支付」，由 platform relayer 提交链上交易、用户不必先点 approve 再点 pay。这显著降低了非加密原生用户的钱包交互门槛。

### 3.6 已部署地址

所有地址都可以在区块浏览器上验证。

**Sepolia（v2）**
- Marketplace: `0x3d08d1549aBD309a124a3C77CbE8bCc39a0eB366`
- Vault: `0x4F2350154A34d8D87013Cab3E1001311186fb839`

**Polygon Amoy（v2）**
- Marketplace: `0xC8141a88633fa08121E6B9244e5d1Ad1a441FcfD`
- Vault: `0xdCeD6FC8cF7CEF86b630f1978d0B78655d103f1E`

**Sepolia（v3 + Kleros）**
- Marketplace: `0x6534B1912f669C22cA9F5FEE4C148Efb69c5E2AE`
- Vault: `0x49749f2D627A39202AF451038654CE2934C3A8e5`
- EvidenceRegistry: `0x79235ab33285a44f59D891733Ee968F15F1BB1c6`
- KlerosAdapter: `0x7A99FE6C60281161C57369BbBB1Be197113Cfc4f`

**Arbitrum Sepolia（v3 + Kleros V2 实链）**
- Marketplace: `0x1E0357FCE511C864331A45cef0AE42BA8d5a84dD`
- Vault: `0xeCec8417AA2bf5071fC6d3F85875dc43c68D7C15`
- EvidenceRegistry: `0x7D4999C3B9ff2B3614479d1ed052A75A5bE0D690`
- KlerosAdapter: `0x04dA4a7aA65a5244B28Eb65eC1e9b29c84903699`

**Arbitrum Sepolia（v3.1）**
- Marketplace: `0x3E9f3FF927F407Cd693009438cC6E0AFC1F27067`
- Vault: `0x897f4d06B9eF3FD1DFF0d9DdC901666909B726cC`

**Arbitrum Sepolia（v3.2）**
- Marketplace (`EscrowMarketplaceERC20`): `0xFf488C9bE6ec21AC47368bed321F4aAa62bAbCA1`
- ReputationRegistry: `0xa3A62B5Bf8a3537ACd931D7b1e13d59b6ceaca1e`
- KlerosAdapter: `0x5fD98A1916600c9957914347547D94FD0A337D0f`
- Mock USD（`mUSD`，仅用于 testnet dev）: `0x2331987BBf1d1543DA8F0d00D3a0C6f5B8b95b52`

v3.2 是与 v3 / v3.1 并行的独立 lane（不继承 v3.1），marketplace 自托管 ERC-20，无独立 Vault。详细设计与接口见 [`contracts/v3_2/ARCHITECTURE.md`](../contracts/v3_2/ARCHITECTURE.md)，部署与运维流程见 [`docs/V3_2_DEPLOYMENT_RUNBOOK.md`](V3_2_DEPLOYMENT_RUNBOOK.md)。

---

## 4. 已实现：系统服务层

后端基于 Next.js App Router + Prisma + Postgres，全部源代码开源。

### 4.1 商品服务
- 卖家签名上架（不要求中心化审核入口）
- 图片上传到 R2，URL 写入数据库
- 黑名单拦截：列表与下单环节都会过 risk engine

### 4.2 订单 + 索引器
- 链上事件 → indexer → Postgres，3–10 秒延迟
- `/api/indexer/_status` 暴露索引器滞后秒数，作为健康检查
- 前端展示链上数据时优先读 indexer 缓存，失败回退到 RPC

### 4.3 支付服务
- 钱包直付（MetaMask / WalletConnect / RainbowKit）
- v3.1 单签 createAndPayWithAuth
- **跨链支付**：通过 LI.FI 集成，买家可以用任意链上的资产支付到 Marketplace 所在的目标链（当前 Arbitrum Sepolia）

### 4.4 用户系统
- SIWE（Sign-In with Ethereum）会话
- 邮箱绑定 + 偏好设置
- 通知去重（Resend 邮件管线，按 (订单, 状态变化) 去重）

### 4.5 会话 + 证据
- 统一 Messenger：买卖双方之间不局限于单笔订单
- 证据上传带 SHA-256 哈希，上链到 EvidenceRegistry
- 附件支持图片 / PDF，6MB 上限

### 4.6 物流
- 17track 快照定期拉取
- 状态变化触发通知 + indexer 更新

### 4.7 风控（脚手架已上线，模型在演进）
- 黑名单（地址 / 用户）
- 卖家基线异常评分（订单金额、新钱包、节奏）
- 声明式规则引擎：`if seller.dispute_rate_30d > 5% then require_review`

### 4.8 RPC 代理
- 白名单 RPC 方法（防 RPC 滥用）
- LRU 缓存（按 method + params + block）
- 每 IP 限流 + 计数器
- `/api/rpc/_status` 暴露命中率与错误码分布

---

## 5. 核心机制

### 5.1 资金安全保证

任何一笔订单都满足以下不变量（已在 hardhat 测试套件中以 invariant 形式验证）：

1. **守恒**：Vault 余额 = 所有 `Paid` / `Shipped` / `Disputed` 状态订单金额之和。
2. **方向**：付款只能从 buyer 进入 Vault；结算只能从 Vault 流向 seller 或 buyer。
3. **权限**：状态转移必须由对应角色签名（买家 confirm，卖家 ship，owner 仅 emergency）。
4. **不可双花**：每笔订单在终态（Completed / Cancelled / Refunded）后不可再被触发。

### 5.2 争议流程

```
Buyer 或 Seller 调用 openDispute (附 evidence hash)
        │
        ▼
Marketplace 锁定订单 → 调用 KlerosAdapter
        │
        ▼
Kleros V2 创建争议 (Arbitrum Sepolia)
        │
        ▼
双方在 Web 端提交证据 → EvidenceRegistry 记录 hash
        │
        ▼
Kleros 陪审员投票
        │
        ▼
callback → Marketplace.resolveDispute(winner)
        │
        ▼
Vault 按裁决释放资金
```

**关键点**：从 `openDispute` 那一刻起，平台 owner **没有任何方式**单方面挪用这笔订单的资金，除非走 Kleros 裁决回调。

> v3.2 + v3.3 完整集成 Kleros V2 仲裁——两条 marketplace lane 的 ownership 都转移给各自的 adapter，争议升级、裁决回流、indexer 镜像、UI 入口全链路 ship（v3.2 Phase H、v3.3 Phase L）。详见 [`contracts/v3_2/ARCHITECTURE.md`](../contracts/v3_2/ARCHITECTURE.md) §4 与 [`contracts/v3_3/ARCHITECTURE.md`](../contracts/v3_3/ARCHITECTURE.md) 的 Kleros V2 章节。

### 5.3 卖家声誉

链下聚合 indexer 数据（争议率、退款率、平均发货时长、休眠期、完成订单数），由 `frontend/lib/reputation/score.ts` 算成 0–1000 整数分。样本数 `< 5` 时退回 sentinel 值 500，UI 显示 "New seller" 不亮分；样本数 ≥ 5 时按颜色梯度（绿 / 琥珀 / 红）呈现。

**链上锚定**（已实现，见 `contracts/v3_2/ReputationRegistry.sol`）：平台用 EIP-712 对 `Attestation{subject, score, issuedAt, expiry, version}` 签名后写入 Registry，链上只做签名校验 + 版本单调递增 + 过期检查，**不计算分数**。链上 schema 与具体 marketplace 解耦，让卖家信用具备**跨平台可移植性**——卖家迁移到另一个采用同一 Registry 的市场，无需从零积累信用。

签发者私钥支持 2-step rotation（`setPendingSigner` → `acceptSigner`），不影响历史 attestation 的可验证性。

### 5.4 风险与黑名单

风险信号 → 规则引擎 → 行为分级：

- 低风险：自动放行
- 中风险：要求买家二次确认
- 高风险：人工 review 队列（UI 规划中）
- 黑名单：列表 + 下单环节直接拒绝

风控不在合约层，是有意为之：合约层只保证「不可挪用资金」，风险判断属于产品策略，必须能快速迭代。

---

## 6. AI 订购层（MVP 已实现）

我们的判断是：**Web3 电商真正的差异化不在合约设计，而在订单入口体验**。当 AI 能直接代用户下单时，传统电商的 SEO / 搜索框 / 推荐位 / 广告位会被绕过。

**当前状态**：AI 订购层 MVP 已上线，覆盖两条入口（ChatGPT Custom GPT + 网站对话框）。完整阶段进度见 [`docs/AI_LAYER_ROADMAP.md`](./AI_LAYER_ROADMAP.md)，开发者与运维参考见 [`docs/WEB_CHATBOX_GUIDE.md`](./WEB_CHATBOX_GUIDE.md) 与 [`docs/CHATGPT_CUSTOM_GPT_SETUP.md`](./CHATGPT_CUSTOM_GPT_SETUP.md)。

### 6.1 实际链路

```
用户："我想买一个 500 USDC 以下的 iPhone 15"
      ▼
1. NLU 服务（lib/ai/llm 抽象，DeepSeek 默认 / OpenAI / Anthropic 可切换）
   将自然语言解析为 SearchProductsInput
2. 候选选品（Postgres tsvector + pg_trgm，lib/search/products）取 Top 30
3. 声誉过滤：每个候选过 ReputationRegistry + sentinel 标记
4. 风险评分：lib/risk/engine 默认规则集（blacklist / anomaly score）
5. 取分数 + relevance 综合得分前 3
6. 返回候选 + 一句话说明（流向 /shop 对话框 或 ChatGPT 客户端）
7. 用户点 Buy → /api/ai/draft-order 生成未签名的 EIP-712 PaymentAuth
8. 用户在 /sign/<draftId> 钱包弹窗签名 + 自付 gas
9. 链上 v3.2 createAndPayWithAuth 落地
```

### 6.2 实际入口

- **入口 1：ChatGPT Custom GPT**（Phase I.4）——公网 OpenAPI 3.1 spec + OAuth 2.0 授权码流程；用户在 ChatGPT 客户端里用自然语言即可走完上述 8 步。配置见 [`docs/CHATGPT_CUSTOM_GPT_SETUP.md`](./CHATGPT_CUSTOM_GPT_SETUP.md)。
- **入口 2：网站对话框 `/shop`**（Phase I.5）——同一组 API，对 chainus.org 自有用户开放，SIWE session 直接打通钱包绑定；技术文档见 [`docs/WEB_CHATBOX_GUIDE.md`](./WEB_CHATBOX_GUIDE.md)。
- **入口 3：Claude MCP server**（Phase I.6，未实现 follow-up）——目标是把同一组 API 暴露为 Anthropic Apps 目录里的 MCP server，让 Claude 桌面端用户也能直接下单。

三条入口共享 Phase I.3 的公共 API（`/api/ai/search`、`/api/ai/draft-order`、SIWE / OAuth 双轨认证）。

### 6.3 与合约层的关系

AI 订购层**完全不需要修改合约**。最终落到 `createAndPayWithAuth` 的还是同一份 v3.2 接口。AI 是入口，不是结算层；agent 永远不持有私钥，每笔订单都以用户在 `/sign/<draftId>` 钱包弹窗结束。

---

## 7. $DATO Token（暂未发行）

> **声明**：截至本文档发布，$DATO **尚未发行**，**未进行任何形式的预售、空投或公开募资**。本节描述的是规划中的经济模型，最终形态以正式发行时的文档为准。

### 7.1 用途定位

$DATO 的设计目标是支撑去中心化电商的两个长期需求：

1. **卖家保证金 / Bond**：卖家上架前需质押 $DATO，争议败诉触发部分 slashing。这把卖家信用从「平台账户冻结」迁移为「链上可验证的资本承诺」。
2. **治理 + 费率折扣**：持有者可投票决定平台费率、新增仲裁器、紧急参数；持有者享受手续费折扣。

### 7.2 不做的事

- 不作为交易媒介强制用户使用（结算依然支持 ETH / 稳定币）。
- 不承诺收益、不承诺 staking 年化、不承诺增值。
- 不引入「平台收入回购销毁」这类容易构成证券特征的机制，等法律环境清晰后再评估。

v3.2 `ReputationRegistry` 是合约层的第一个去中心化可验证组件（任何人都能用 `verifyAttestation` 校验平台签发的声誉分），但 $DATO 仍未发行，本节描述的经济模型不因 Registry 上线而改变。

### 7.3 分发原则（规划）

具体比例待经济模型设计完成后公布，但以下原则已确定：

- **真实使用者优先**：交易额 / 仲裁参与 / 长期持仓的卖家应获得最大份额。
- **团队 + 顾问 ≤ 20%**，全部锁仓 ≥ 24 个月。
- **不预留私募轮巨额份额**。
- **公开透明的解锁曲线**，全部写进合约 Timelock。

---

## 8. 治理（规划）

ChainUs 的中长期治理结构：

| 阶段 | 决策权 | 实现方式 |
|---|---|---|
| 现在 | Founder + 核心开发 | 合约 owner，所有特权操作公开记录 |
| Phase 1 | Multisig（3-of-5） | Gnosis Safe，关键参数变更需多签 |
| Phase 2 | Timelock | 所有合约升级、参数变更经过 48-72h 延时 |
| Phase 3 | DAO | OpenZeppelin Governor + Timelock，$DATO 投票 |

**关键承诺**：Vault 合约的资金释放权限**不会**交给任何 DAO，永远只能由 Marketplace + Kleros 裁决回调驱动。治理层只能改变费率、新增链、新增仲裁器等参数，不能挪用用户托管资金。

---

## 9. 路线图

完整版见 [docs/ROADMAP.md](ROADMAP.md)，以下是关键里程碑：

### Q2 2026（当前季度，进行中）
- 修复 11 个 hardhat 测试（v3 + v3.1 安全审计的尾巴）
- 风控规则引擎接入实际订单流
- 客服后台 + 黑名单管理 UI

### Q3 2026
- AI 订购层 MVP：NLU + 选品 + 风险评分串成完整链路（MCP 入口）
- 稳定币结算（USDC / USDT，基于 v3.2 草稿合约）
- Kleros 仲裁 mainnet 上线（Arbitrum One）

### Q4 2026
- 卖家保证金 / Bond 合约
- 链上声誉 Registry 正式部署
- iOS / Android 移动端 MVP

### 2027
- DAO 治理 + Timelock
- $DATO 经济模型与发行（视产品-市场契合度与法律环境）
- 跨链 Marketplace（Optimism、Base、BNB Chain）

---

## 10. 已知风险与免责

- **本项目当前所有合约部署在 testnet。** 在 mainnet 部署之前，不应被理解为生产可用。
- **Kleros V2 仲裁本身是去中心化网络**，其裁决最终性依赖 Kleros 协议本身的安全性。
- **跨链 bridge（LI.FI）依赖第三方协议**，桥接资产期间用户面临 bridge 自身的风险。
- **合约虽经过内部审计 + 安全 fix**，但**尚未经过第三方专业审计公司审计**。Mainnet 部署前会启动正式审计。
- **本文档不构成投资建议、不构成证券发行要约**。$DATO 尚未发行。
- **代码与合约均为 As-Is 提供**，使用者自负风险。

---

## 11. 团队

（占位 — 待法律实体确认后填写）

ChainUs 的工程主导者拥有多年全栈与智能合约经验，团队当前以核心开发 + 外部贡献者形式运作。所有代码均在公开仓库提交，commit 历史可审计。

---

## 12. 参考与链接

- **代码仓库**：（GitHub 地址待补）
- **架构文档**：`contracts/v2/ARCHITECTURE.md`、`contracts/v3/ARCHITECTURE.md`
- **路线图**：[docs/ROADMAP.md](ROADMAP.md)
- **v3.1 单签运行手册**：[docs/V3_1_SINGLE_SIG_RUNBOOK.md](V3_1_SINGLE_SIG_RUNBOOK.md)
- **Kleros V2**：https://kleros.io
- **LI.FI**：https://li.fi

---

## 附录 A：合约接口摘要（v3.1）

```solidity
function createAndPayWithAuth(
    OrderAuth calldata auth,
    bytes calldata signature
) external payable returns (uint256 orderId);

function markShipped(uint256 orderId, bytes32 trackingHash) external;
function confirmReceived(uint256 orderId) external;
function cancelOrder(uint256 orderId) external;

function openDispute(uint256 orderId, bytes32 evidenceHash) external;
function resolveDispute(uint256 orderId, Resolution resolution) external;
```

完整 ABI 见 `frontend/abi/`。

## 附录 B：术语表

- **Escrow**：买家付款后，资金暂存于智能合约，达到约定条件后才释放给卖家。
- **Vault**：唯一持有资金的合约，与业务合约分离。
- **EvidenceRegistry**：争议证据哈希的链上注册表。
- **Kleros V2**：去中心化仲裁网络，由 PNK 持有者作为陪审员裁决。
- **SIWE**：Sign-In with Ethereum，基于钱包签名的登录协议。
- **LI.FI**：跨链桥聚合协议。
- **MCP**：Model Context Protocol，AI 模型与外部工具之间的标准化协议。
- **EIP-712**：以太坊上结构化数据签名标准。

---

**白皮书结束 · ChainUs v0.9 · 2026 年 5 月**
