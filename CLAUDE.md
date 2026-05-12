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

## 开发原则（每次对话都要遵守）

1. **不要一次性重构整个项目**
2. **每次只实现指定的模块**
3. **优先兼容当前 v2 架构**——不要随便提议改合约
4. **不要破坏已有测试**（73 passing）
5. **如果需要改合约**，同时告诉我需要新增哪些测试
6. **如果需要改前端**，说明涉及哪些页面、组件、hooks、lib 文件
7. **如果需要新增后端服务**，说明 API、数据库表、业务流程
8. **所有代码适合初创 MVP**——不要过度工程化
9. **链上只处理资金和关键订单状态**；商品、物流、评价、证据、风控等先放 Web2 后端

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

## 我希望你（Claude）每次怎么响应

- 提议改合约前先问"必须改吗？能不能在 Web2 层解决"
- 给改动估算："改 X 文件 / 加 Y 测试 / 多少时间"
- 涉及多层（合约 + 前端 + 后端）时**明确列出每层的变更**
- 涉及钱的逻辑**双倍谨慎**——优先复用现有的 Escrow 而不是新建
- 不确定时**先问再写代码**
