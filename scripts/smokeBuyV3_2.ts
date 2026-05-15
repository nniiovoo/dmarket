import { network } from "hardhat";

// E2E smoke: exercise the exact contract sequence that useBuyNowERC20 runs
// from the browser — approve → createOrder → payOrderERC20 — against the
// live Arbitrum Sepolia deployment, printing tx hashes and balances at each
// step. Caller acts as the buyer; a `--seller` env var (or the deployer's
// off-by-one address) acts as the seller.
async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) {
    throw new Error("No deployer signer found. Check PRIVATE_KEY in your .env file.");
  }

  const envNetwork = connection.networkName.toUpperCase();
  const marketplaceAddress = process.env[`V3_2_${envNetwork}_MARKETPLACE_ADDRESS`];
  const mockUsdAddress = process.env[`V3_2_${envNetwork}_MOCK_USD_ADDRESS`];
  if (!marketplaceAddress || !mockUsdAddress) {
    throw new Error(
      `Missing V3_2_${envNetwork}_MARKETPLACE_ADDRESS or V3_2_${envNetwork}_MOCK_USD_ADDRESS in .env`
    );
  }

  const buyerAddress = await deployer.getAddress();

  // Build a deterministic seller address that is NOT the buyer. We can't pay
  // a real third-party in this script, but the marketplace contract only
  // requires seller != buyer at order time. Using a derived address gives us
  // a stable, throw-away seller for repeat runs.
  const sellerAddress =
    process.env.SELLER_FOR_SMOKE ??
    ethers.getAddress("0x" + (BigInt(buyerAddress) + 1n).toString(16).padStart(40, "0"));

  const productId = BigInt(process.env.PRODUCT_ID ?? "1");
  // 0.001 ETH * 3000 = 3 mUSD at 6 decimals → 3_000_000
  const amount = BigInt(process.env.AMOUNT_RAW ?? "3000000");

  console.log("Network:", connection.networkName);
  console.log("Buyer:", buyerAddress);
  console.log("Seller:", sellerAddress);
  console.log("Marketplace:", marketplaceAddress);
  console.log("Mock USD:", mockUsdAddress);
  console.log("Amount (raw):", amount.toString());
  console.log("Product id:", productId.toString());

  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)"
  ];
  const marketplaceAbi = [
    "function createOrder(address,address,uint256,uint256) returns (uint256)",
    "function payOrderERC20(uint256)",
    "function getOrder(uint256) view returns (tuple(uint256 id,address buyer,uint8 status,uint64 createdAt,address seller,uint64 paidAt,address paymentToken,uint64 shippedAt,uint64 completedAt,uint64 disputedAt,uint256 productId,uint256 amount))",
    "function nextOrderId() view returns (uint256)",
    "event OrderCreated(uint256 indexed orderId,address indexed buyer,address indexed seller,address paymentToken,uint256 productId,uint256 amount)"
  ];

  const mockUsd = new ethers.Contract(mockUsdAddress, erc20Abi, deployer);
  const marketplace = new ethers.Contract(marketplaceAddress, marketplaceAbi, deployer);

  const marketplaceBalanceBefore = (await mockUsd.balanceOf(marketplaceAddress)) as bigint;
  console.log("Marketplace mUSD balance BEFORE:", marketplaceBalanceBefore.toString());

  const allowance = (await mockUsd.allowance(buyerAddress, marketplaceAddress)) as bigint;
  console.log("Current allowance:", allowance.toString());

  if (allowance < amount) {
    if (allowance > 0n) {
      const reset = await mockUsd.approve(marketplaceAddress, 0n);
      await reset.wait();
      console.log("approve(0) tx:", reset.hash);
    }
    const approve = await mockUsd.approve(marketplaceAddress, amount);
    const approveReceipt = await approve.wait();
    console.log("approve tx:", approveReceipt?.hash ?? approve.hash);
  } else {
    console.log("Skipping approve — allowance already sufficient");
  }

  const createTx = await marketplace.createOrder(sellerAddress, mockUsdAddress, productId, amount);
  const createReceipt = await createTx.wait();
  console.log("createOrder tx:", createReceipt?.hash ?? createTx.hash);

  // Parse orderId from the OrderCreated event.
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
  if (orderId === undefined) throw new Error("OrderCreated event not found");
  console.log("New orderId:", orderId.toString());

  const payTx = await marketplace.payOrderERC20(orderId);
  const payReceipt = await payTx.wait();
  console.log("payOrderERC20 tx:", payReceipt?.hash ?? payTx.hash);

  const order = await marketplace.getOrder(orderId);
  console.log("Order status (1=Paid):", order.status.toString());
  console.log("Order paymentToken:", order.paymentToken);
  console.log("Order amount (raw):", order.amount.toString());

  const marketplaceBalanceAfter = (await mockUsd.balanceOf(marketplaceAddress)) as bigint;
  console.log("Marketplace mUSD balance AFTER:", marketplaceBalanceAfter.toString());
  console.log(
    "Delta:",
    (marketplaceBalanceAfter - marketplaceBalanceBefore).toString(),
    `(expected ${amount.toString()})`
  );

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
