import { network } from "hardhat";

const CONTRACT_ADDRESSES: Record<string, string> = {
  sepolia: "0x2d72949E02119DcB06B13375E51D3A6159F618C3",
  amoy: "0x2412a68b0296bA434E93eb409795555Ae2F9983F"
};

const ORDER_STATUS = ["Created", "Paid", "Shipped", "Completed", "Cancelled", "Disputed", "Refunded"];

// Recover ETH stuck in an order whose lifecycle got interrupted between Paid
// and Completed. The only on-chain escape is: open a dispute, then have the
// owner resolve it with refundBuyer=true. This script assumes buyer == owner
// (both keyed off PRIVATE_KEY in .env). If they differ, run the second step
// with a different signer.

async function main() {
  const orderIdArg = process.env.ORDER_ID;

  if (orderIdArg === undefined || orderIdArg === "") {
    throw new Error("Set ORDER_ID env var, e.g. ORDER_ID=1 npx hardhat --network amoy run scripts/recoverStuckOrder.ts");
  }

  const orderId = BigInt(orderIdArg);

  const connection = await network.create();
  const { ethers } = connection;
  const contractAddress = CONTRACT_ADDRESSES[connection.networkName];

  if (contractAddress === undefined) {
    throw new Error(`Unsupported network: ${connection.networkName}. Use sepolia or amoy.`);
  }

  const signers = await ethers.getSigners();
  const buyer = signers[0];

  if (buyer === undefined) {
    throw new Error("No signer found. Check PRIVATE_KEY in your .env file.");
  }

  const marketplace = await ethers.getContractAt("EscrowMarketplace", contractAddress, buyer);

  const owner = await marketplace.owner();
  const buyerAddress = await buyer.getAddress();

  console.log("Network:", connection.networkName);
  console.log("Contract:", contractAddress);
  console.log("Signer (buyer & owner expected):", buyerAddress);
  console.log("Contract owner on-chain:", owner);

  if (owner.toLowerCase() !== buyerAddress.toLowerCase()) {
    throw new Error(
      "Signer is not the contract owner. resolveDispute will revert. Configure a separate owner signer before running this."
    );
  }

  const order = await marketplace.getOrder(orderId);
  const status = Number(order.status);
  console.log("----------------------------------------");
  console.log("Order ID:", orderId.toString());
  console.log("Status:", ORDER_STATUS[status] ?? status);
  console.log("Buyer:", order.buyer);
  console.log("Seller:", order.seller);
  console.log("Amount:", ethers.formatEther(order.amount));

  if (order.buyer.toLowerCase() !== buyerAddress.toLowerCase()) {
    throw new Error("Signer is not the buyer of this order. openDispute will revert.");
  }

  const balanceBefore = await ethers.provider.getBalance(contractAddress);
  console.log("Contract balance before:", ethers.formatEther(balanceBefore));

  // Step 1: openDispute (buyer or seller can call; we use buyer).
  if (status === 1 /* Paid */ || status === 2 /* Shipped */) {
    console.log("----------------------------------------");
    console.log("Step 1: openDispute");
    const disputeTx = await marketplace.openDispute(orderId);
    await disputeTx.wait();
    console.log("Tx hash:", disputeTx.hash);
  } else if (status === 5 /* Disputed */) {
    console.log("Order already Disputed — skipping openDispute.");
  } else {
    throw new Error(
      `Order status is ${ORDER_STATUS[status] ?? status}. Recovery only applies to Paid/Shipped/Disputed orders.`
    );
  }

  // Step 2: resolveDispute(refundBuyer=true) (owner only).
  console.log("----------------------------------------");
  console.log("Step 2: resolveDispute(refundBuyer=true)");
  const resolveTx = await marketplace.resolveDispute(orderId, true);
  await resolveTx.wait();
  console.log("Tx hash:", resolveTx.hash);

  // Verify.
  const orderAfter = await marketplace.getOrder(orderId);
  const balanceAfter = await ethers.provider.getBalance(contractAddress);
  console.log("----------------------------------------");
  console.log("Final status:", ORDER_STATUS[Number(orderAfter.status)]);
  console.log("Contract balance after:", ethers.formatEther(balanceAfter));
  console.log("Refunded:", ethers.formatEther(balanceBefore - balanceAfter), "to", order.buyer);

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
