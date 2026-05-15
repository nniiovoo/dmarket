// End-to-end smoke: create order → pay → openDispute → escalateToKleros.
// Confirms the v3.2 Kleros adapter is wired up correctly on Arbitrum Sepolia
// with the real Kleros V2 court. We do NOT wait for jury deliberation —
// the goal is to verify the createDispute tx lands and the adapter
// mappings are populated.

import { network } from "hardhat";

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer");

  const envNetwork = connection.networkName.toUpperCase();
  const marketplaceAddr = process.env[`V3_2_${envNetwork}_MARKETPLACE_ADDRESS`];
  const mockUsdAddr = process.env[`V3_2_${envNetwork}_MOCK_USD_ADDRESS`];
  const adapterAddr = process.env[`V3_2_${envNetwork}_KLEROS_ADAPTER_ADDRESS`];
  const sellerKey = process.env.SELLER_PRIVATE_KEY;
  if (!marketplaceAddr || !mockUsdAddr || !adapterAddr) throw new Error("Missing v3.2 envs");
  if (!sellerKey) throw new Error("SELLER_PRIVATE_KEY missing");

  const seller = new ethers.Wallet(sellerKey, deployer.provider);
  const buyer = deployer;

  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)"
  ];
  const marketplaceAbi = [
    "function createOrder(address,address,uint256,uint256) returns (uint256)",
    "function payOrderERC20(uint256)",
    "function markShipped(uint256)",
    "function openDispute(uint256)",
    "function getOrder(uint256) view returns (tuple(uint256 id,address buyer,uint8 status,uint64 createdAt,address seller,uint64 paidAt,address paymentToken,uint64 shippedAt,uint64 completedAt,uint64 disputedAt,uint256 productId,uint256 amount))",
    "function owner() view returns (address)",
    "event OrderCreated(uint256 indexed orderId,address indexed buyer,address indexed seller,address paymentToken,uint256 productId,uint256 amount)"
  ];
  const adapterAbi = [
    "function arbitrator() view returns (address)",
    "function marketplace() view returns (address)",
    "function getArbitrationCost() view returns (uint256)",
    "function escalateToKleros(uint256 orderId) payable returns (uint256)",
    "function klerosDisputeIdByOrder(uint256) view returns (uint256)",
    "function orderEscalated(uint256) view returns (bool)",
    "event DisputeEscalated(uint256 indexed orderId,uint256 indexed klerosDisputeId,address indexed by,uint256 feePaid)"
  ];

  const mockUsd = new ethers.Contract(mockUsdAddr, erc20Abi, buyer);
  const marketplace = new ethers.Contract(marketplaceAddr, marketplaceAbi, buyer);
  const adapter = new ethers.Contract(adapterAddr, adapterAbi, buyer);

  // Sanity checks.
  const mpOwner = (await marketplace.owner()) as string;
  console.log("marketplace.owner():", mpOwner);
  if (mpOwner.toLowerCase() !== adapterAddr.toLowerCase()) {
    throw new Error("Marketplace not owned by the adapter — run migrate script first");
  }
  console.log("adapter.marketplace():", await adapter.marketplace());
  console.log("adapter.arbitrator():", await adapter.arbitrator());

  // 1. Create + pay an order.
  const amount = 3_000_000n; // 3 mUSD
  const productId = BigInt(Date.now()); // unique productId per run
  console.log(`\nproductId=${productId}, amount=${amount}`);

  // Approve once if needed.
  const allow = (await mockUsd.allowance(buyer.address, marketplaceAddr)) as bigint;
  if (allow < amount) {
    const approveTx = await mockUsd.approve(marketplaceAddr, (1n << 256n) - 1n);
    await approveTx.wait();
    console.log("approve tx:", approveTx.hash);
  }

  console.log("\n[1/4] createOrder");
  const createTx = await marketplace.createOrder(seller.address, mockUsdAddr, productId, amount);
  const createReceipt = await createTx.wait();
  let orderId: bigint | undefined;
  for (const log of createReceipt?.logs ?? []) {
    try {
      const parsed = marketplace.interface.parseLog({ data: log.data, topics: log.topics });
      if (parsed?.name === "OrderCreated") {
        orderId = parsed.args.orderId as bigint;
        break;
      }
    } catch {
      continue;
    }
  }
  if (orderId === undefined) throw new Error("orderId not decoded");
  console.log(`      tx: ${createReceipt?.hash}  orderId: ${orderId}`);

  console.log("\n[2/4] payOrderERC20");
  const payTx = await marketplace.payOrderERC20(orderId);
  await payTx.wait();
  console.log(`      tx: ${payTx.hash}`);

  console.log("\n[3/4] openDispute (as buyer)");
  const disputeTx = await marketplace.openDispute(orderId);
  await disputeTx.wait();
  console.log(`      tx: ${disputeTx.hash}`);
  const order = await marketplace.getOrder(orderId);
  if (Number(order.status) !== 5) throw new Error(`Expected Disputed (5), got ${order.status}`);

  // 2. Escalate to Kleros — costs arbitrationCost ETH.
  const cost = (await adapter.getArbitrationCost()) as bigint;
  console.log(`\n[4/4] escalateToKleros — arbitrationCost = ${cost} wei (${ethers.formatEther(cost)} ETH)`);
  const buyerEth = await deployer.provider.getBalance(buyer.address);
  if (buyerEth < cost) {
    throw new Error(`Buyer ETH ${ethers.formatEther(buyerEth)} below arbitration cost ${ethers.formatEther(cost)}`);
  }

  const escalateTx = await adapter.escalateToKleros(orderId, { value: cost });
  const escalateReceipt = await escalateTx.wait();
  console.log(`      tx: ${escalateReceipt?.hash}`);

  const klerosDisputeId = (await adapter.klerosDisputeIdByOrder(orderId)) as bigint;
  console.log(`      klerosDisputeId: ${klerosDisputeId}`);
  console.log(`      orderEscalated: ${await adapter.orderEscalated(orderId)}`);

  console.log("\nDone. Kleros jurors will deliberate; the adapter's rule() callback will fire");
  console.log("once Kleros V2 reaches a verdict (typically days). Inspect on Arbiscan:");
  console.log(`  https://sepolia.arbiscan.io/tx/${escalateReceipt?.hash}`);
  console.log(`  https://v2-testnet.kleros.builders/#/cases/${klerosDisputeId}`);

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
