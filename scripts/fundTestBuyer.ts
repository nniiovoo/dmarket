import { network } from "hardhat";

// One-shot testnet helper: transfer mUSD from the deployer wallet to a buyer
// address so that buyer has balance for the V3.2 ERC-20 flow.
//
// Usage:
//   BUYER_ADDRESS=0x... AMOUNT_MUSD=100 \
//     npx hardhat run scripts/fundTestBuyer.ts --network arbitrumSepolia
async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();

  if (deployer === undefined) {
    throw new Error("No deployer signer found. Check PRIVATE_KEY in your .env file.");
  }

  const envNetwork = connection.networkName.toUpperCase();
  const mockUsdAddress = process.env[`V3_2_${envNetwork}_MOCK_USD_ADDRESS`];
  if (!mockUsdAddress) {
    throw new Error(`V3_2_${envNetwork}_MOCK_USD_ADDRESS is not set in .env`);
  }

  const buyer = process.env.BUYER_ADDRESS;
  if (!buyer) {
    throw new Error("BUYER_ADDRESS env var is required (e.g. BUYER_ADDRESS=0xabc...)");
  }

  const amountUnits = process.env.AMOUNT_MUSD ?? "100";
  const amount = BigInt(amountUnits) * 10n ** 6n;

  const mockUsd = await ethers.getContractAt("MockERC20", mockUsdAddress, deployer);
  const deployerAddress = await deployer.getAddress();

  console.log("Network:", connection.networkName);
  console.log("Deployer:", deployerAddress);
  console.log("Mock USD:", mockUsdAddress);
  console.log("Buyer:", buyer);
  console.log("Amount:", `${amountUnits} mUSD (raw ${amount.toString()})`);

  const tx = await mockUsd.transfer(buyer, amount);
  const receipt = await tx.wait();
  console.log("Transfer tx hash:", receipt?.hash ?? tx.hash);

  const balance = (await mockUsd.balanceOf(buyer)) as bigint;
  console.log("Buyer balance after transfer (mUSD):", (balance / 10n ** 6n).toString());

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
