# ChainUs — 项目上下文

> 这个文件是 Claude Code 每次启动自动加载的项目级 context。每次对话都不需要重复贴下面这些信息。

## 项目定位

**ChainUs**：去中心化电商平台。

- **核心命题**：Web2 体验 + Web3 资金安全
- 用户像普通电商一样浏览商品、下单、查物流、处理售后
- 但**资金结算通过链上 escrow 合约**，降低买卖双方信任成本
- 当前**不是合约 demo**，而是要逐步发展成完整的去中心化电商平台

## 已经存在的资产

### 1. Solidity v2 合约（已冻结，已部署）

- `contracts/v2/EscrowMarketplace.sol` — 订单生命周期 + 业务逻辑
- `contracts/v2/EscrowVault.sol` — 唯一持有 ETH 的合约
- 设计哲学："钱独立住，其他都住一起"——详见 `contracts/v2/ARCHITECTURE.md`

### 2. 链上订单流程（v2 已支持的所有动作）

```
createOrder, payOrder, markShipped, confirmReceived, cancelOrder,
openDispute, resolveDispute, ownerEmergencyRefund
```

### 3. 订单状态（7 个）

```
Created → Paid → Shipped → Completed
       ↘ Cancelled
       ↘ Disputed → Refunded / Completed
       ↘ Refunded (via ownerEmergencyRefund)
```

### 4. 部署

- **Sepolia**: vault `0x4F2350154A34d8D87013Cab3E1001311186fb839`，marketplace `0x3d08d1549aBD309a124a3C77CbE8bCc39a0eB366`
- **Polygon Amoy**: vault `0xdCeD6FC8cF7CEF86b630f1978d0B78655d103f1E`，marketplace `0xC8141a88633fa08121E6B9244e5d1Ad1a441FcfD`

### 5. 前端（Next.js App Router）

- 技术栈：Next.js + TypeScript + Tailwind + wagmi + viem + RainbowKit + React Query
- 目录：`frontend/`
- ABI 通过 `scripts/syncAbi.ts` 从 artifacts 同步进 `frontend/abi/`
- 合约地址走 `NEXT_PUBLIC_*` 环境变量

## 通用编码守则

> 默认行为偏向谨慎，简单任务请自行判断。

### 1. 想清楚再写代码

不要假设，不要掩盖困惑，把权衡摆出来。

实现前：
- 把假设明确说出来。不确定就先问。
- 有多种解读就把所有可能性列出来，别静悄悄选一个。
- 如果有更简单的方案，说出来。该 push back 就 push back。
- 任何不清楚的地方都先停下。指明困惑点。问。

### 2. 简单第一

用最少的代码解决问题。不做投机性的东西。

- 不实现没要求的功能
- 不为只用一次的代码做抽象
- 不加未被要求的"灵活性"或"可配置性"
- 不为不可能发生的场景写错误处理
- 200 行能压到 50 行就重写

自问："资深工程师会不会觉得这写得太复杂？"如果会，简化。

### 3. 外科手术式改动

只动必须动的地方。只清理自己制造的烂摊子。

修改现有代码时：
- 不"顺便改进"周边代码、注释或格式
- 不重构没坏的东西
- 沿用现有风格，即使你觉得有更好的写法
- 发现无关的死代码 → 提一下，别擅自删

你的改动产生了孤儿代码：
- 删掉**你的**改动造成的未使用 import / 变量 / 函数
- 不删既有的死代码，除非被要求

检验标准：每一行新增/修改都能直接追溯到用户的请求。

### 4. 目标驱动的执行

明确成功标准，循环到验证通过。

把任务转成可验证的目标：
- "加 validation" → "为非法输入写测试，让它们通过"
- "修 bug" → "写一个能复现的测试，再让它通过"
- "重构 X" → "确保改动前后测试都通过"

多步任务，先写简要计划：

```
1. [步骤] → 验证：[检查]
2. [步骤] → 验证：[检查]
3. [步骤] → 验证：[检查]
```

强成功标准让你能自循环。弱标准（"让它能跑"）则需要不断追问澄清。

---

**这套准则起作用的标志**：diff 里多余改动变少；因过度复杂而重写的次数变少；澄清问题发生在动手前而不是出错后。

## 项目特定规则

1. **优先兼容当前 v2 / v3 架构**——v2 已冻结，v3 是延展。不要随便提议改合约。
2. **不要破坏已有测试**（目前 120 passing）。
3. **如果需要改合约**，同时告诉我需要新增哪些测试。
4. **如果需要改前端**，说明涉及哪些页面、组件、hooks、lib 文件。
5. **如果需要新增后端服务**，说明 API、数据库表、业务流程。
6. **链上只处理资金和关键订单状态**；商品、物流、评价、证据、风控等先放 Web2 后端。
7. **涉及钱的逻辑双倍谨慎**——优先复用现有的 EscrowVault / EscrowMarketplace，不要新建合约。
8. **提议改合约前先问**："必须改吗？能不能在 Web2 层解决？"
9. **改动估算**：明确说"改 X 文件 / 加 Y 测试 / 多少时间"。
10. **涉及多层（合约 + 前端 + 后端）时**，明确列出每层的变更。

## 当前架构边界

| 应该在链上 | 应该在 Web2 后端 |
|---|---|
| 订单状态机（7 个状态） | 商品 metadata、图片、描述 |
| 资金托管 + 转账 | 物流追踪信息 |
| 争议触发 + 仲裁结果 | 评价、评分、UGC |
| 关键事件审计（events） | 争议证据存储（IPFS 链接可上链） |
| 角色（buyer/seller/owner） | KYC、风控、反欺诈 |
|  | 商品搜索、推荐、个性化 |

## 仓库结构速查

```
contracts/
├── EscrowMarketplace.sol         v1 单体（历史参考，仍可编译）
├── v2/                           ⭐ 产品线
│   ├── EscrowMarketplace.sol
│   ├── EscrowVault.sol
│   └── ARCHITECTURE.md
└── test/MaliciousEscrowActors.sol

test/
├── EscrowMarketplace.test.ts     43 测试（v1）
└── V2Marketplace.test.ts         29 测试 + invariant helper（v2）

scripts/
├── deploy.ts / deployV2.ts       部署
├── testFlow.ts / testFlowV2.ts   真链端到端
├── recoverStuckOrder.ts          清理卡单
└── syncAbi.ts                    ABI → frontend

frontend/
├── app/                          Next.js 页面 (Home/Create/OrderDetail/Admin)
├── components/                   TxPanel, OrderBadge, NetworkNotice 等
└── lib/                          chains, wagmi, contracts, errors, order

hardhat.config.ts                 viaIR + optimizer + sepolia/amoy 网络
```

## 当前未启动的方向（演化路线图）

- **v0.2**：Pausable、平台手续费、部署自动化
- **v1.0**：SellerBondVault（卖家保证金）、ReputationRegistry（信用）
- **v1.5**：自有 token、staking
- **v2.0**：DAO 治理、保险池、Proxy 升级
- **Web2 后端**：商品 CRUD、订单 metadata 缓存、indexer、用户系统

每条都不急做，**等业务需要再启动**。
