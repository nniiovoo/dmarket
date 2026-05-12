# Decentralized E-commerce MVP

Day 1 built the first on-chain escrow flow:

buyer creates order -> buyer pays -> ETH stays in contract escrow -> seller ships -> buyer confirms receipt -> contract releases ETH to seller.

It also includes a simple dispute flow where the platform owner can refund the buyer or release funds to the seller.

## Install

```bash
npm install
```

## Environment Variables

Create a local `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Fill in:

```bash
PRIVATE_KEY=your_wallet_private_key_without_quotes
SELLER_PRIVATE_KEY=your_seller_wallet_private_key_without_quotes
SEPOLIA_RPC_URL=your_sepolia_rpc_url
AMOY_RPC_URL=your_polygon_amoy_rpc_url
ETHERSCAN_API_KEY=your_etherscan_api_key
POLYGONSCAN_API_KEY=your_polygonscan_api_key
```

Keep `.env` private. Do not commit real private keys.

`PRIVATE_KEY` is used as the buyer/deployer account. `SELLER_PRIVATE_KEY` is used as the seller account in the real testnet flow scripts. The seller wallet must have a small amount of Sepolia ETH or Amoy MATIC to pay gas for `markShipped`.

## Compile

```bash
npx hardhat compile
```

## Test

```bash
npx hardhat test
```

Stop at the first Mocha failure:

```bash
npx hardhat test mocha --bail
```

## Coverage

Hardhat 3 supports coverage through the global `--coverage` flag:

```bash
npx hardhat --coverage test mocha --bail
```

The HTML report is written to:

```bash
coverage/html/index.html
```

## Static Analysis

Install Slither once:

```bash
python3 -m pip install --user slither-analyzer
export PATH="$HOME/.local/bin:$PATH"
solc-select install 0.8.24
solc-select use 0.8.24
```

Scan v2:

```bash
slither contracts/v2 --exclude-dependencies
```

Current note: Slither may report `timestamp` findings on v2 because order structs store timestamp fields and status checks read the same struct. The contract does not use `block.timestamp` for authorization, randomness, or economic decisions.

## Deploy to Sepolia

Make sure `.env` has `PRIVATE_KEY` and `SEPOLIA_RPC_URL`.

```bash
npx hardhat --network sepolia run scripts/deploy.ts
```

The deploy script prints:

- network name
- deployer address
- contract address
- transaction hash

## Deploy to Polygon Amoy

Make sure `.env` has `PRIVATE_KEY` and `AMOY_RPC_URL`.

```bash
npx hardhat --network amoy run scripts/deploy.ts
```

The deploy script prints the same deployment details as the Sepolia deployment.

## Deploy v2

v2 deploys two contracts:

- `EscrowVault`: holds escrowed ETH/MATIC
- `EscrowMarketplaceV2`: owns order, shipping, dispute, and admin refund logic

The deploy script automatically calls `vault.setMarketplace(marketplaceAddress)` after both contracts are deployed.

Deploy v2 to Sepolia:

```bash
npx hardhat --network sepolia run scripts/deployV2.ts
```

Deploy v2 to Polygon Amoy:

```bash
npx hardhat --network amoy run scripts/deployV2.ts
```

The script prints:

- network name
- deployer address
- vault address
- marketplace address
- vault deployment transaction hash
- marketplace deployment transaction hash
- vault wiring transaction hash

Current v2 Sepolia deployment:

- Vault: `0x4F2350154A34d8D87013Cab3E1001311186fb839`
- Marketplace: `0x3d08d1549aBD309a124a3C77CbE8bCc39a0eB366`

Current v2 Polygon Amoy deployment:

- Vault: `0xdCeD6FC8cF7CEF86b630f1978d0B78655d103f1E`
- Marketplace: `0xC8141a88633fa08121E6B9244e5d1Ad1a441FcfD`

## Verify Contract

`EscrowMarketplace` has no constructor arguments, so verification only needs the deployed contract address.

Verify on Sepolia:

```bash
npx hardhat --network sepolia verify DEPLOYED_CONTRACT_ADDRESS
```

Verify on Polygon Amoy:

```bash
npx hardhat --network amoy verify DEPLOYED_CONTRACT_ADDRESS
```

For Sepolia, Hardhat uses `ETHERSCAN_API_KEY`. For Polygon Amoy, this project selects `POLYGONSCAN_API_KEY` when `--network amoy` is used.

Verify v2 on Sepolia or Amoy:

```bash
npx hardhat --network sepolia verify VAULT_ADDRESS
npx hardhat --network sepolia verify MARKETPLACE_V2_ADDRESS VAULT_ADDRESS

npx hardhat --network amoy verify VAULT_ADDRESS
npx hardhat --network amoy verify MARKETPLACE_V2_ADDRESS VAULT_ADDRESS
```

## Real Testnet Flow

These scripts interact with the already deployed `EscrowMarketplace` contracts:

- Sepolia: `0x2d72949E02119DcB06B13375E51D3A6159F618C3`
- Polygon Amoy: `0x2412a68b0296bA434E93eb409795555Ae2F9983F`

Run the full order flow on Sepolia:

```bash
npx hardhat --network sepolia run scripts/testFlow.ts
```

Run the full order flow on Polygon Amoy:

```bash
npx hardhat --network amoy run scripts/testFlow.ts
```

Run the dispute refund flow on Sepolia:

```bash
npx hardhat --network sepolia run scripts/testDisputeFlow.ts
```

Run the dispute refund flow on Polygon Amoy:

```bash
npx hardhat --network amoy run scripts/testDisputeFlow.ts
```

Each script prints the function name, transaction hash, order id, current order status, and contract balance after every step. The payment amount is intentionally tiny: `0.0001`.

## Real Testnet Flow v2

After deploying v2, add these addresses to `.env`:

```bash
V2_SEPOLIA_MARKETPLACE_ADDRESS=0x3d08d1549aBD309a124a3C77CbE8bCc39a0eB366
V2_SEPOLIA_VAULT_ADDRESS=0x4F2350154A34d8D87013Cab3E1001311186fb839
V2_AMOY_MARKETPLACE_ADDRESS=0xC8141a88633fa08121E6B9244e5d1Ad1a441FcfD
V2_AMOY_VAULT_ADDRESS=0xdCeD6FC8cF7CEF86b630f1978d0B78655d103f1E
```

Run the v2 end-to-end flow on Sepolia:

```bash
npx hardhat --network sepolia run scripts/testFlowV2.ts
```

Run the v2 end-to-end flow on Polygon Amoy:

```bash
npx hardhat --network amoy run scripts/testFlowV2.ts
```

The v2 script checks:

- full order flow
- dispute refund
- dispute release
- cancel order
- owner emergency refund
- marketplace balance is always `0`
- vault balance equals the sum of locked order funds

## One-click Buy

The current v2 marketplace supports `createAndPay(seller, productId)` for the default buyer flow. It creates the order and locks funds in the vault in a single transaction, emitting `OrderCreated` and `OrderPaid` in that order. The older `createOrder` and `payOrder` functions remain available for advanced "create now, pay later" flows.

## Frontend Order Indexer

The frontend has a small Node indexer that mirrors v2 marketplace events into SQLite so order lists can use `/api/orders` instead of one RPC call per order.

Run the one-shot catch-up from the frontend directory:

```bash
cd frontend
npm run indexer:once
```

Run the long-lived watcher:

```bash
cd frontend
npm run indexer
```

The indexer loads `.env` and `.env.local`, uses `NEXT_PUBLIC_SEPOLIA_RPC_URL` / `NEXT_PUBLIC_AMOY_RPC_URL` (or `SEPOLIA_RPC_URL` / `AMOY_RPC_URL`), and processes Sepolia then Amoy sequentially. It chunks historical scans in `INDEXER_CHUNK_SIZE_BLOCKS` blocks, defaulting to `5000`, and automatically splits smaller when an RPC rejects the block range. The live watcher polls every `INDEXER_POLL_INTERVAL_MS`, defaulting to `15000`. `INDEXER_REQUEST_DELAY_MS` defaults to `75` to stay friendlier to free RPC tiers.

Deployment start blocks live in `frontend/lib/indexer/config.ts`:

- Sepolia marketplace `0x3d08d1549aBD309a124a3C77CbE8bCc39a0eB366`: block `10835467`
- Polygon Amoy marketplace `0xC8141a88633fa08121E6B9244e5d1Ad1a441FcfD`: block `38206485`

First catch-up should be quick for the current deployments because those start blocks are close to the deployed contracts rather than genesis. If the RPC provider rate-limits, lower `INDEXER_CHUNK_SIZE_BLOCKS` and rerun; `IndexerState` and per-order `(lastBlock, lastLogIndex)` make repeated catch-ups idempotent.

## Seller Workflow

Sellers use the frontend dashboard at `/seller`.

- Connect a seller wallet on Sepolia or Polygon Amoy.
- Open `Seller Dashboard` from the top navigation.
- Use `New product` to create a listing.
- Use `My products` to edit, unlist, or restore listings.
- Use `Pending shipments` to mark paid orders as shipped.
- Use `All orders` to review active, completed, cancelled, and refunded orders.

The dashboard badge shows the count of seller orders in `Paid` status on the connected chain. It refreshes periodically from `/api/orders?seller=...&status=Paid`.

Seller product images can be uploaded through imgbb by adding this to `frontend/.env.local`:

```bash
IMGBB_API_KEY=your_imgbb_api_key
```

The key is only used by the server route at `/api/upload-image`. If it is not configured, the product form keeps working in external URL mode.

## Notifications & Shipping

Task 4 adds wallet-level email notifications and seller-entered shipping details.

Configure optional email delivery in `frontend/.env.local`:

```bash
RESEND_API_KEY=re_xxxxxxxxxxxxx
EMAIL_FROM=onboarding@resend.dev
APP_BASE_URL=http://localhost:3000
PLATFORM_OWNER_EMAIL=owner@example.com
```

Without `RESEND_API_KEY`, the indexer continues normally and records skipped rows in `EmailLog`. Resend's `onboarding@resend.dev` is useful for local tests, but it can only send to the Resend account email. For broader testing or public users, verify your own domain in Resend and use an address on that domain.

Users bind an email from `/settings` by signing:

```text
ChainUs:BindEmail:<email>:<timestamp>:<walletAddress>
```

The indexer triggers these notifications after newly processed chain events:

- `OrderPaid`: seller receives a new-order email.
- `OrderShipped`: buyer receives a shipment email.
- `OrderCompleted`: seller receives a completion email.
- `OrderDisputed`: buyer, seller, and `PLATFORM_OWNER_EMAIL` receive a dispute email.
- `OrderRefunded`: buyer receives a refund email.

Seller shipping details are recorded after a successful chain `markShipped` transaction. The seller can enter carrier, tracking number, optional note, and optional manual URL for `Other`; buyers see the tracking block on the order detail page once the order is `Shipped` or later. `EmailLog` deduplicates sent emails for the same wallet, notification kind, chain, and order over 24 hours so indexer restarts do not spam users.

## Admin Emergency Refund

The contract includes `ownerEmergencyRefund(orderId)` for stuck orders where funds are escrowed but the buyer or seller cannot complete the normal dispute path.

Rules:

- only `owner` can call it
- order status must be `Paid`, `Shipped`, or `Disputed`
- funds are refunded to the buyer
- state changes to `Refunded` before the ETH transfer

This is intentionally powerful admin behavior. It protects users from stuck funds, but it also means the owner has authority to refund escrowed orders. Use it carefully, and consider multisig ownership before production.

## Backend & Products

The Phase 3 frontend includes a lightweight Web2 product backend inside the Next.js app. Products live in SQLite through Prisma; the chain still only stores escrow order state and the numeric `productId`.

Set up the frontend database:

```bash
cd frontend
npm install
npx prisma migrate dev --name init
npx prisma generate
```

The local database URL is:

```bash
DATABASE_URL="file:./dev.db"
```

Useful database commands:

```bash
npm run db:migrate
npm run db:studio
npm run db:reset
npm run api:smoke
```

`npm run api:smoke` expects the frontend dev server to be running on `http://127.0.0.1:3000`. It creates a temporary signing wallet in memory, creates a product, checks seller-only update permissions, updates it, and soft-deletes it.

Run the app:

```bash
npm run dev
```

Product routes:

- `GET /api/health`
- `GET /api/products`
- `POST /api/products`
- `GET /api/products/:id`
- `PATCH /api/products/:id`
- `DELETE /api/products/:id`

Create the first product from the UI:

1. Connect a seller wallet.
2. Open `/seller/new`.
3. Fill name, description, price, image URL, and sign the create-product message.
4. Open `/products`, select the product, then use `Buy now` to prefill `/create`.

## Frontend dApp

Phase 3 adds a real Next.js frontend in `frontend/`.

It supports:

- RainbowKit wallet connection
- Sepolia and Polygon Amoy network detection
- env-driven RPC URLs and v2 contract addresses
- order creation, payment, shipping, receipt confirmation, disputes, dispute resolution, and emergency refund
- transaction pending/submitted/confirmed/failed states with explorer links

Install frontend dependencies:

```bash
npm install --prefix frontend
```

Compile the contracts and sync generated ABIs into the frontend:

```bash
npm run compile
npm run sync-abi
```

Create a frontend env file:

```bash
cp frontend/.env.example frontend/.env.local
```

Fill in:

```bash
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_walletconnect_project_id
NEXT_PUBLIC_SEPOLIA_RPC_URL=your_sepolia_rpc_url
NEXT_PUBLIC_AMOY_RPC_URL=your_polygon_amoy_rpc_url

NEXT_PUBLIC_V2_SEPOLIA_MARKETPLACE_ADDRESS=0x3d08d1549aBD309a124a3C77CbE8bCc39a0eB366
NEXT_PUBLIC_V2_SEPOLIA_VAULT_ADDRESS=0x4F2350154A34d8D87013Cab3E1001311186fb839
NEXT_PUBLIC_V2_AMOY_MARKETPLACE_ADDRESS=0xC8141a88633fa08121E6B9244e5d1Ad1a441FcfD
NEXT_PUBLIC_V2_AMOY_VAULT_ADDRESS=0xdCeD6FC8cF7CEF86b630f1978d0B78655d103f1E
```

Run the frontend locally:

```bash
npm run dev --prefix frontend
```

Open:

```bash
http://localhost:3000
```

Frontend checks:

```bash
npm run typecheck --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
```

Manual acceptance checklist:

- connect a wallet and switch between Sepolia and Polygon Amoy
- create an order, pay, mark shipped, and confirm receipt
- create a dispute and resolve it as refund
- create a dispute and resolve it as release to seller
- use owner emergency refund on a paid, shipped, or disputed order
- reject a wallet signature and confirm the UI shows a neutral message
- confirm transaction links point to Etherscan for Sepolia and PolygonScan for Amoy

If you deployed before this function was added, redeploy `EscrowMarketplace` and update the contract addresses in the scripts before using it on a testnet.
