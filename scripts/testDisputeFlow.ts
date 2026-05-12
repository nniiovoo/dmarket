import { network } from "hardhat";

const CONTRACT_ADDRESSES: Record<string, string> = {
  sepolia: "0x2d72949E02119DcB06B13375E51D3A6159F618C3",
  amoy: "0x2412a68b0296bA434E93eb409795555Ae2F9983F"
};

const ORDER_STATUS = ["Created", "Paid", "Shipped", "Completed", "Cancelled", "Disputed", "Refunded"];

async function main() {
  const connection = await network.create();
  const { ethers } = connection;

  const contractAddress = CONTRACT_ADDRESSES[connection.networkName];

  if (contractAddress === undefined) {
    throw new Error(`Unsupported network: ${connection.networkName}. Use sepolia or amoy.`);
  }

  const signers = await ethers.getSigners();
  const buyer = signers[0];

  if (buyer === undefined) {
    throw new Error("No buyer signer found. Check PRIVATE_KEY in your .env file.");
  }

  const seller = getSellerSigner(ethers, signers[1]);

  const buyerAddress = await buyer.getAddress();
  const sellerAddress = await seller.getAddress();
  const marketplace = await ethers.getContractAt("EscrowMarketplace", contractAddress, buyer);
  const amount = ethers.parseEther("0.0001");
  const productId = BigInt(Date.now());

  console.log("Network name:", connection.networkName);
  console.log("Contract address:", contractAddress);
  console.log("Buyer address:", buyerAddress);
  console.log("Seller address:", sellerAddress);

  const orderId = await marketplace.nextOrderId();
  await logStep(ethers, "nextOrderId", "N/A", orderId, "N/A", contractAddress);

  const createTx = await marketplace.createOrder(sellerAddress, productId, amount);
  await createTx.wait();
  await assertStatus(marketplace, orderId, 0);
  await logStep(ethers, "createOrder", createTx.hash, orderId, "Created", contractAddress);

  const payTx = await marketplace.payOrder(orderId, { value: amount });
  await payTx.wait();
  await assertStatus(marketplace, orderId, 1);
  await logStep(ethers, "payOrder", payTx.hash, orderId, "Paid", contractAddress);

  const disputeTx = await marketplace.openDispute(orderId);
  await disputeTx.wait();
  await assertStatus(marketplace, orderId, 5);
  await logStep(ethers, "openDispute", disputeTx.hash, orderId, "Disputed", contractAddress);

  const refundTx = await marketplace.resolveDispute(orderId, true);
  await refundTx.wait();
  await assertStatus(marketplace, orderId, 6);
  await logStep(ethers, "resolveDispute", refundTx.hash, orderId, "Refunded", contractAddress);

  console.log("Dispute test flow completed successfully");

  await connection.close();
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

function getSellerSigner(ethers: any, configuredSeller: any) {
  if (configuredSeller !== undefined) {
    return configuredSeller;
  }

  if (process.env.SELLER_PRIVATE_KEY !== undefined && process.env.SELLER_PRIVATE_KEY !== "") {
    return new ethers.Wallet(process.env.SELLER_PRIVATE_KEY, ethers.provider);
  }

  throw new Error("No seller signer found. Add SELLER_PRIVATE_KEY to your .env file.");
}

async function logStep(
  ethers: any,
  functionName: string,
  txHash: string,
  orderId: bigint,
  currentStatus: string,
  contractAddress: string
) {
  const balance = await ethers.provider.getBalance(contractAddress);

  console.log("----------------------------------------");
  console.log("Function:", functionName);
  console.log("Tx hash:", txHash);
  console.log("Order ID:", orderId.toString());
  console.log("Current order status:", currentStatus);
  console.log("Contract balance:", ethers.formatEther(balance));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
