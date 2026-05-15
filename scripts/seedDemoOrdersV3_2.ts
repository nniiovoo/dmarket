import { network } from "hardhat";
import { spawn } from "node:child_process";

// Seed 8 fully-completed v3.2 orders so the demo seller's reputation
// sample crosses MIN_SAMPLE_SIZE=5 and the UI badges start showing real
// numbers. Throwaway demo helper, kept in scripts/.
//
// Lifecycle per order: createOrder → payOrderERC20 → markShipped →
// confirmReceived. Buyer = PRIVATE_KEY (deployer wallet, holds 1M mUSD).
// Seller = SELLER_PRIVATE_KEY. Each order is processed sequentially to
// avoid nonce races on the public RPC.

const NUM_ORDERS = 8;
const AMOUNT_RAW = 3_000_000n; // 3 mUSD at 6 decimals
const REQUIRED_BUYER_MUSD = AMOUNT_RAW * BigInt(NUM_ORDERS);
const SELLER_MIN_ETH = 3_000_000_000_000_000n; // 0.003 ETH
const SELLER_TOP_UP_ETH = 5_000_000_000_000_000n; // 0.005 ETH refill
const BUYER_MIN_ETH = 3_000_000_000_000_000n; // 0.003 ETH

// chainId allowlist. arbitrumSepolia = 421614. Mainnet-class chains are
// explicitly excluded here so a misconfigured `--network mainnet` doesn't
// accidentally burn real funds.
const ALLOWED_CHAIN_IDS = new Set<bigint>([421614n]);

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];
const marketplaceAbi = [
  "function createOrder(address,address,uint256,uint256) returns (uint256)",
  "function payOrderERC20(uint256)",
  "function markShipped(uint256)",
  "function confirmReceived(uint256)",
  "function getOrder(uint256) view returns (tuple(uint256 id,address buyer,uint8 status,uint64 createdAt,address seller,uint64 paidAt,address paymentToken,uint64 shippedAt,uint64 completedAt,uint64 disputedAt,uint256 productId,uint256 amount))",
  "event OrderCreated(uint256 indexed orderId,address indexed buyer,address indexed seller,address paymentToken,uint256 productId,uint256 amount)"
];

async function main() {
  const connection = await network.create();
  const { ethers } = connection;

  // Hard safety gate: must be arbitrumSepolia. The networkName check guards
  // against config typos; the chainId check guards against config that
  // *says* arbitrumSepolia but is wired to a different RPC.
  if (connection.networkName !== "arbitrumSepolia") {
    throw new Error(
      `Refusing to seed on network "${connection.networkName}". Only arbitrumSepolia is allowed.`
    );
  }
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("PRIVATE_KEY not set");
  const detectedChainId = (await deployer.provider.getNetwork()).chainId;
  if (!ALLOWED_CHAIN_IDS.has(detectedChainId)) {
    throw new Error(
      `Refusing to seed on chainId ${detectedChainId}. Allowed: ${[...ALLOWED_CHAIN_IDS].join(", ")}`
    );
  }

  const envNetwork = connection.networkName.toUpperCase();
  const marketplaceAddress = process.env[`V3_2_${envNetwork}_MARKETPLACE_ADDRESS`];
  const mockUsdAddress = process.env[`V3_2_${envNetwork}_MOCK_USD_ADDRESS`];
  if (!marketplaceAddress || !mockUsdAddress) {
    throw new Error(`Missing V3_2_${envNetwork}_MARKETPLACE_ADDRESS / MOCK_USD_ADDRESS`);
  }

  const sellerKey = process.env.SELLER_PRIVATE_KEY;
  if (!sellerKey) throw new Error("SELLER_PRIVATE_KEY not set");

  const buyer = deployer;
  const seller = new ethers.Wallet(sellerKey, deployer.provider);

  const buyerAddress = await buyer.getAddress();
  const sellerAddress = seller.address;
  if (buyerAddress.toLowerCase() === sellerAddress.toLowerCase()) {
    throw new Error("Buyer and seller addresses are equal — v3.2 contract rejects seller == buyer");
  }

  console.log("Network:", connection.networkName);
  console.log("Buyer:", buyerAddress);
  console.log("Seller:", sellerAddress);
  console.log("Marketplace:", marketplaceAddress);
  console.log("Mock USD:", mockUsdAddress);

  const mockUsd = new ethers.Contract(mockUsdAddress, erc20Abi, buyer);
  const marketplaceBuyer = new ethers.Contract(marketplaceAddress, marketplaceAbi, buyer);
  const marketplaceSeller = marketplaceBuyer.connect(seller);

  // -------- health checks --------
  const buyerMUSD = (await mockUsd.balanceOf(buyerAddress)) as bigint;
  console.log(`Buyer mUSD balance: ${buyerMUSD} (need ${REQUIRED_BUYER_MUSD})`);
  if (buyerMUSD < REQUIRED_BUYER_MUSD) {
    throw new Error(
      `Buyer mUSD balance ${buyerMUSD} is below required ${REQUIRED_BUYER_MUSD}. ` +
        `Mint more from deployer: MockERC20.mint(buyer, ${REQUIRED_BUYER_MUSD - buyerMUSD})`
    );
  }

  const buyerEth = await buyer.provider.getBalance(buyerAddress);
  console.log(`Buyer ETH balance: ${ethers.formatEther(buyerEth)} ETH`);
  if (buyerEth < BUYER_MIN_ETH) {
    throw new Error(
      `Buyer (deployer) ETH balance ${ethers.formatEther(buyerEth)} below 0.003 — fund the deployer wallet manually before re-running.`
    );
  }

  const sellerEthBefore = await buyer.provider.getBalance(sellerAddress);
  console.log(`Seller ETH balance: ${ethers.formatEther(sellerEthBefore)} ETH`);
  if (sellerEthBefore < SELLER_MIN_ETH) {
    console.log(`  → topping up seller with ${ethers.formatEther(SELLER_TOP_UP_ETH)} ETH from buyer`);
    const fundTx = await buyer.sendTransaction({ to: sellerAddress, value: SELLER_TOP_UP_ETH });
    await fundTx.wait();
    console.log(`  → fund tx: ${fundTx.hash}`);
  }

  // -------- approve once --------
  const allowance = (await mockUsd.allowance(buyerAddress, marketplaceAddress)) as bigint;
  const targetAllowance = (1n << 256n) - 1n; // MAX_UINT256
  if (allowance < REQUIRED_BUYER_MUSD) {
    if (allowance > 0n) {
      // USDT-style: reset to 0 before raising. mUSD doesn't require it but
      // this keeps the same pattern as useBuyNowERC20.
      const reset = await mockUsd.approve(marketplaceAddress, 0n);
      await reset.wait();
    }
    const approveTx = await mockUsd.approve(marketplaceAddress, targetAllowance);
    await approveTx.wait();
    console.log(`approve(MAX_UINT256) tx: ${approveTx.hash}`);
  } else {
    console.log("Allowance already sufficient — skipping approve");
  }

  // -------- 8 order lifecycle --------
  const startTime = Date.now();
  const completed: Array<{ orderId: bigint; createTx: string; confirmTx: string }> = [];
  for (let i = 0; i < NUM_ORDERS; i++) {
    const productId = BigInt(1000 + i);
    console.log(`\n--- Order ${i + 1}/${NUM_ORDERS} (productId=${productId}) ---`);

    // a. createOrder
    const createTx = await marketplaceBuyer.createOrder(sellerAddress, mockUsdAddress, productId, AMOUNT_RAW);
    const createReceipt = await createTx.wait();
    let orderId: bigint | undefined;
    for (const log of createReceipt?.logs ?? []) {
      try {
        const parsed = marketplaceBuyer.interface.parseLog({ data: log.data, topics: log.topics });
        if (parsed?.name === "OrderCreated") {
          orderId = parsed.args.orderId as bigint;
          break;
        }
      } catch {
        continue;
      }
    }
    if (orderId === undefined) throw new Error("OrderCreated event not decoded");
    console.log(`  createOrder tx: ${createReceipt?.hash} (orderId=${orderId})`);

    // b. payOrderERC20 (allowance is already MAX_UINT256, skip per-order approve)
    const payTx = await marketplaceBuyer.payOrderERC20(orderId);
    await payTx.wait();
    console.log(`  payOrderERC20 tx: ${payTx.hash}`);

    // c. markShipped (seller signer)
    const shipTx = await marketplaceSeller.markShipped(orderId);
    await shipTx.wait();
    console.log(`  markShipped tx: ${shipTx.hash}`);

    // d. confirmReceived (buyer signer)
    const confirmTx = await marketplaceBuyer.confirmReceived(orderId);
    await confirmTx.wait();
    console.log(`  confirmReceived tx: ${confirmTx.hash}`);

    // Sanity-check status (3 = Completed in the on-chain enum).
    const order = await marketplaceBuyer.getOrder(orderId);
    if (Number(order.status) !== 3) {
      throw new Error(`Order ${orderId} status is ${order.status}, expected 3 (Completed)`);
    }

    completed.push({ orderId, createTx: createReceipt?.hash ?? "", confirmTx: confirmTx.hash });
    console.log(`✓ Order #${orderId} Completed (${i + 1}/${NUM_ORDERS})`);
  }
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nAll ${NUM_ORDERS} orders Completed in ${elapsedSec}s`);

  // -------- catch indexer up --------
  console.log("\nRunning v3.2 indexer once to ingest the new events...");
  await runChildScript("npm", ["run", "indexer:v3_2:once", "--silent"]);

  // -------- trigger attestation refresh --------
  console.log("\nRunning reputation cron once to re-sign + publish...");
  await runChildScript("npm", ["run", "reputation:cron:once", "--silent"]);

  console.log("\nSeller:", sellerAddress);
  console.log("Completed orders this run:", completed.length);
  for (const c of completed.slice(0, 3)) {
    console.log(`  Order ${c.orderId}: create=${c.createTx} confirm=${c.confirmTx}`);
  }
  console.log(
    `\nDone. curl http://localhost:3000/api/reputation/${sellerAddress} — sampleSize should now be ≥ 5.`
  );

  await connection.close();
}

function runChildScript(cmd: string, args: string[]) {
  // Run inside frontend/ so the npm script + tsconfig + node_modules
  // resolve correctly. Inherits stdio so the child's log lines reach our
  // terminal.
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: `${process.cwd()}/frontend`,
      stdio: "inherit",
      env: { ...process.env }
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
