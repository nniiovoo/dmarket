import { network } from "hardhat";

const ORDER_STATUS = ["Created", "Paid", "Shipped", "Completed", "Cancelled", "Disputed", "Refunded"];
const AMOUNT = "0.0001";

async function main() {
  const connection = await network.create();
  const { ethers } = connection;

  const { marketplaceAddress, vaultAddress } = getV2Addresses(connection.networkName);
  const signers = await ethers.getSigners();
  const buyer = signers[0];

  if (buyer === undefined) {
    throw new Error("No buyer/owner signer found. Check PRIVATE_KEY in your .env file.");
  }

  const seller = getSellerSigner(ethers, signers[1]);
  const buyerAddress = await buyer.getAddress();
  const sellerAddress = await seller.getAddress();
  const marketplace = await ethers.getContractAt("EscrowMarketplaceV2", marketplaceAddress, buyer);
  const vault = await ethers.getContractAt("EscrowVault", vaultAddress, buyer);
  const amount = ethers.parseEther(AMOUNT);
  const touchedOrderIds: bigint[] = [];

  console.log("Network name:", connection.networkName);
  console.log("Marketplace address:", marketplaceAddress);
  console.log("Vault address:", vaultAddress);
  console.log("Buyer/owner address:", buyerAddress);
  console.log("Seller address:", sellerAddress);
  console.log("Amount:", AMOUNT);

  await runHappyFlow(ethers, marketplace, vault, buyer, seller, sellerAddress, amount, touchedOrderIds);
  await runDisputeRefundFlow(ethers, marketplace, vault, buyer, sellerAddress, amount, touchedOrderIds);
  await runDisputeReleaseFlow(ethers, marketplace, vault, buyer, sellerAddress, amount, touchedOrderIds);
  await runCancelFlow(ethers, marketplace, vault, buyer, sellerAddress, amount, touchedOrderIds);
  await runEmergencyRefundFlow(ethers, marketplace, vault, buyer, sellerAddress, amount, touchedOrderIds);

  await checkInvariants(ethers, marketplace, vault, touchedOrderIds);

  console.log("V2 full test flow completed successfully");

  await connection.close();
}

async function runHappyFlow(
  ethers: any,
  marketplace: any,
  vault: any,
  buyer: any,
  seller: any,
  sellerAddress: string,
  amount: bigint,
  touchedOrderIds: bigint[]
) {
  console.log("\n=== Happy flow ===");
  const orderId = await createOrder(ethers, marketplace, vault, sellerAddress, amount, touchedOrderIds);

  const payTx = await marketplace.payOrder(orderId, { value: amount });
  await payTx.wait();
  await assertStatus(marketplace, orderId, 1);
  await logStep(ethers, marketplace, vault, "payOrder", payTx.hash, orderId, "Paid");

  const shippedTx = await marketplace.connect(seller).markShipped(orderId);
  await shippedTx.wait();
  await assertStatus(marketplace, orderId, 2);
  await logStep(ethers, marketplace, vault, "markShipped", shippedTx.hash, orderId, "Shipped");

  const receivedTx = await marketplace.connect(buyer).confirmReceived(orderId);
  await receivedTx.wait();
  await assertStatus(marketplace, orderId, 3);
  await logStep(ethers, marketplace, vault, "confirmReceived", receivedTx.hash, orderId, "Completed");
}

async function runDisputeRefundFlow(
  ethers: any,
  marketplace: any,
  vault: any,
  buyer: any,
  sellerAddress: string,
  amount: bigint,
  touchedOrderIds: bigint[]
) {
  console.log("\n=== Dispute refund flow ===");
  const orderId = await createOrder(ethers, marketplace, vault, sellerAddress, amount, touchedOrderIds);
  await sendAndLog(ethers, marketplace, vault, marketplace.payOrder(orderId, { value: amount }), orderId, "payOrder", 1);
  await sendAndLog(ethers, marketplace, vault, marketplace.openDispute(orderId), orderId, "openDispute", 5);
  await sendAndLog(
    ethers,
    marketplace,
    vault,
    marketplace.connect(buyer).resolveDispute(orderId, true),
    orderId,
    "resolveDispute(refundBuyer=true)",
    6
  );
}

async function runDisputeReleaseFlow(
  ethers: any,
  marketplace: any,
  vault: any,
  buyer: any,
  sellerAddress: string,
  amount: bigint,
  touchedOrderIds: bigint[]
) {
  console.log("\n=== Dispute release flow ===");
  const orderId = await createOrder(ethers, marketplace, vault, sellerAddress, amount, touchedOrderIds);
  await sendAndLog(ethers, marketplace, vault, marketplace.payOrder(orderId, { value: amount }), orderId, "payOrder", 1);
  await sendAndLog(ethers, marketplace, vault, marketplace.openDispute(orderId), orderId, "openDispute", 5);
  await sendAndLog(
    ethers,
    marketplace,
    vault,
    marketplace.connect(buyer).resolveDispute(orderId, false),
    orderId,
    "resolveDispute(refundBuyer=false)",
    3
  );
}

async function runCancelFlow(
  ethers: any,
  marketplace: any,
  vault: any,
  _buyer: any,
  sellerAddress: string,
  amount: bigint,
  touchedOrderIds: bigint[]
) {
  console.log("\n=== Cancel flow ===");
  const orderId = await createOrder(ethers, marketplace, vault, sellerAddress, amount, touchedOrderIds);
  await sendAndLog(ethers, marketplace, vault, marketplace.cancelOrder(orderId), orderId, "cancelOrder", 4);
}

async function runEmergencyRefundFlow(
  ethers: any,
  marketplace: any,
  vault: any,
  buyer: any,
  sellerAddress: string,
  amount: bigint,
  touchedOrderIds: bigint[]
) {
  console.log("\n=== Owner emergency refund flow ===");
  const orderId = await createOrder(ethers, marketplace, vault, sellerAddress, amount, touchedOrderIds);
  await sendAndLog(ethers, marketplace, vault, marketplace.payOrder(orderId, { value: amount }), orderId, "payOrder", 1);
  await sendAndLog(
    ethers,
    marketplace,
    vault,
    marketplace.connect(buyer).ownerEmergencyRefund(orderId),
    orderId,
    "ownerEmergencyRefund",
    6
  );
}

async function createOrder(
  ethers: any,
  marketplace: any,
  vault: any,
  sellerAddress: string,
  amount: bigint,
  touchedOrderIds: bigint[]
) {
  const orderId = await marketplace.nextOrderId();
  touchedOrderIds.push(orderId);

  const tx = await marketplace.createOrder(sellerAddress, BigInt(Date.now()) + orderId, amount);
  await tx.wait();
  await assertStatus(marketplace, orderId, 0);
  await logStep(ethers, marketplace, vault, "createOrder", tx.hash, orderId, "Created");

  return orderId;
}

async function sendAndLog(
  ethers: any,
  marketplace: any,
  vault: any,
  txPromise: Promise<any>,
  orderId: bigint,
  functionName: string,
  expectedStatus: number
) {
  const tx = await txPromise;
  await tx.wait();
  await assertStatus(marketplace, orderId, expectedStatus);
  await logStep(ethers, marketplace, vault, functionName, tx.hash, orderId, ORDER_STATUS[expectedStatus]);
}

async function assertStatus(marketplace: any, orderId: bigint, expectedStatus: number) {
  const order = await marketplace.getOrder(orderId);
  const actualStatus = Number(order.status);

  if (actualStatus !== expectedStatus) {
    throw new Error(
      `Unexpected order status for order ${orderId}. Expected ${ORDER_STATUS[expectedStatus]}, got ${
        ORDER_STATUS[actualStatus] ?? actualStatus
      }.`
    );
  }
}

async function checkInvariants(ethers: any, marketplace: any, vault: any, orderIds: bigint[]) {
  let totalLocked = 0n;

  for (const orderId of orderIds) {
    const order = await marketplace.getOrder(orderId);
    const status = Number(order.status);
    const locked = await vault.lockedAmount(orderId);

    totalLocked += locked;

    if (status === 1 || status === 2 || status === 5) {
      if (locked !== order.amount) {
        throw new Error(`Invariant failed: active order ${orderId} locked amount does not match order amount`);
      }
    } else if (locked !== 0n) {
      throw new Error(`Invariant failed: inactive order ${orderId} still has locked funds`);
    }
  }

  const marketplaceBalance = await ethers.provider.getBalance(await marketplace.getAddress());
  const vaultBalance = await ethers.provider.getBalance(await vault.getAddress());

  if (marketplaceBalance !== 0n) {
    throw new Error("Invariant failed: marketplace holds ETH/MATIC");
  }

  if (vaultBalance !== totalLocked) {
    throw new Error("Invariant failed: vault balance does not equal sum of locked funds");
  }
}

async function logStep(
  ethers: any,
  marketplace: any,
  vault: any,
  functionName: string,
  txHash: string,
  orderId: bigint,
  currentStatus: string
) {
  const marketplaceBalance = await ethers.provider.getBalance(await marketplace.getAddress());
  const vaultBalance = await ethers.provider.getBalance(await vault.getAddress());
  const locked = await vault.lockedAmount(orderId);

  console.log("----------------------------------------");
  console.log("Function:", functionName);
  console.log("Tx hash:", txHash);
  console.log("Order ID:", orderId.toString());
  console.log("Current order status:", currentStatus);
  console.log("Order locked amount:", ethers.formatEther(locked));
  console.log("Marketplace balance:", ethers.formatEther(marketplaceBalance));
  console.log("Vault balance:", ethers.formatEther(vaultBalance));
}

function getSellerSigner(ethers: any, configuredSeller: any) {
  if (configuredSeller !== undefined) {
    return configuredSeller;
  }

  if (process.env.SELLER_PRIVATE_KEY !== undefined && process.env.SELLER_PRIVATE_KEY !== "") {
    return new ethers.Wallet(process.env.SELLER_PRIVATE_KEY, ethers.provider);
  }

  throw new Error("No seller signer found. Add SELLER_PRIVATE_KEY to your .env file.");
}

function getV2Addresses(networkName: string) {
  const upperNetworkName = networkName.toUpperCase();
  const marketplaceAddress =
    process.env[`V2_${upperNetworkName}_MARKETPLACE_ADDRESS`] ?? process.env.V2_MARKETPLACE_ADDRESS;
  const vaultAddress = process.env[`V2_${upperNetworkName}_VAULT_ADDRESS`] ?? process.env.V2_VAULT_ADDRESS;

  if (marketplaceAddress === undefined || marketplaceAddress === "") {
    throw new Error(`Missing V2_${upperNetworkName}_MARKETPLACE_ADDRESS in your .env file.`);
  }

  if (vaultAddress === undefined || vaultAddress === "") {
    throw new Error(`Missing V2_${upperNetworkName}_VAULT_ADDRESS in your .env file.`);
  }

  return { marketplaceAddress, vaultAddress };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
