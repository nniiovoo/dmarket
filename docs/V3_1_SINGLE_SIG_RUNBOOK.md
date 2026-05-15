# V3.1 Single-Sig Cross-Chain Pay Runbook

V3.1 adds `createAndPayWithAuth(PaymentAuth, signature)` so a buyer can sign
one EIP-712 authorization, bridge funds to a relayer, and let the relayer
create/pay the order on Arbitrum Sepolia.

## Deployed Arbitrum Sepolia Contracts

```bash
V3_1_ARBITRUMSEPOLIA_VAULT_ADDRESS=0x897f4d06B9eF3FD1DFF0d9DdC901666909B726cC
V3_1_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS=0x3E9f3FF927F407Cd693009438cC6E0AFC1F27067
```

## Environment

Root `.env`:

```bash
ARBITRUM_SEPOLIA_RPC_URL=...
PRIVATE_KEY=...

# Optional. If unset, the local relayer falls back to PRIVATE_KEY.
RELAYER_PRIVATE_KEY=...

V3_1_ARBITRUMSEPOLIA_VAULT_ADDRESS=0x897f4d06B9eF3FD1DFF0d9DdC901666909B726cC
V3_1_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS=0x3E9f3FF927F407Cd693009438cC6E0AFC1F27067
```

`frontend/.env.local`:

```bash
NEXT_PUBLIC_V3_1_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS=0x3E9f3FF927F407Cd693009438cC6E0AFC1F27067
NEXT_PUBLIC_V3_1_ARBITRUMSEPOLIA_VAULT_ADDRESS=0x897f4d06B9eF3FD1DFF0d9DdC901666909B726cC
NEXT_PUBLIC_RELAYER_ADDRESS_ARBITRUMSEPOLIA=<relayer wallet address>

# Optional; defaults to http://localhost:4001/submit
RELAYER_URL=http://localhost:4001/submit
```

The relayer wallet must hold enough Arbitrum Sepolia ETH to pay gas. It must
also receive the bridged payment amount before submitting the signed auth.

## Run The Local Relayer

In one shell:

```bash
cd /Users/ni/web3/dApp
npx tsx scripts/v3_1Relayer.ts --network arbitrumSepolia
```

The server listens on `http://localhost:4001/submit` and logs each request as:

```text
[T+0ms] received
[T+50ms] sig verified
[T+2400ms] tx confirmed
```

It rejects:

- invalid signatures
- signatures that do not recover to `auth.buyer`
- wrong `chainId`
- `auth.amount` above `0.05 ETH`

## Run The Frontend

In another shell:

```bash
cd /Users/ni/web3/dApp/frontend
npm run dev
```

Open the dApp in the browser:

1. Go to a product page.
2. Click **Buy now**.
3. In the modal, enable **Single-sig cross-chain pay (V3.1, experimental)**.
4. Click **Sign authorization**.
5. Sign the EIP-712 `PaymentAuth`.
6. Wait for LI.FI to bridge funds to the relayer.
7. The frontend POSTs the auth to `/api/relayer/submit`.
8. The relayer calls `createAndPayWithAuth`.
9. The UI shows the created order tx and navigates to the new order.

Expected end-to-end time is roughly **5-10 minutes**, mostly determined by the
LI.FI bridge route.

## Testnet Smoke Mode (Bypass LI.FI)

LI.FI currently does not provide a Sepolia -> Arbitrum Sepolia route, so local
testnet smoke tests cannot exercise the real bridge path. For this case only,
the frontend has an explicit bypass mode:

```bash
# frontend/.env.local
NEXT_PUBLIC_V3_1_TESTNET_BYPASS=true
```

Restart the Next.js dev server after changing the env var. In the buy dialog:

1. Enable **Single-sig cross-chain pay (V3.1, experimental)**.
2. Enable **Bypass LI.FI bridge (testnet smoke only)**.
3. Click **Sign authorization** and sign the EIP-712 `PaymentAuth`.
4. The frontend skips LI.FI and POSTs the signed auth directly to the local
   relayer.
5. The relayer pays `msg.value` from its own Arbitrum Sepolia balance and calls
   `createAndPayWithAuth`.

This validates:

```text
buyer signs EIP-712 -> /api/relayer/submit -> relayer wallet ->
createAndPayWithAuth -> vault locks funds -> indexer sees the order
```

It does **not** validate bridging. The relayer must have enough Arbitrum Sepolia
ETH for both gas and `msg.value` (for example, at least the product price plus
gas). This mode is testnet-only. Remove `NEXT_PUBLIC_V3_1_TESTNET_BYPASS` when
LI.FI supports the target testnet route or when moving to a mainnet route with
real funds.

## Troubleshooting

- If the toggle does not appear, confirm `NEXT_PUBLIC_V3_1_ARBITRUMSEPOLIA_*`
  is set and restart the Next.js dev server.
- If the UI says the relayer address is missing, set
  `NEXT_PUBLIC_RELAYER_ADDRESS_ARBITRUMSEPOLIA` to the relayer wallet.
- If the UI says the LI.FI quote is unavailable on Sepolia, use
  **Testnet Smoke Mode (Bypass LI.FI)** above. This is expected until LI.FI
  supports Sepolia -> Arbitrum Sepolia.
- If the relayer returns `Signature does not recover to auth.buyer`, the user
  likely signed against a different chain ID or marketplace address.
- If the relayer tx reverts with `AuthNonceMismatch`, refresh the page and sign
  a new authorization.
- If the relayer has no gas, fund it with Arbitrum Sepolia ETH.
