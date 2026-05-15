import { network } from "hardhat";

// Throwaway helper: top up the reputation signer wallet with ETH from the
// deployer so it can pay gas for acceptSigner and (post-rotation) any
// recordAttestation calls that aren't relayed. Not deleted after first use
// because the signer may need refills later.
//
// Sends 0.002 ETH from PRIVATE_KEY (deployer) to REPUTATION_SIGNER_ADDRESS
// on Arbitrum Sepolia.

const TRANSFER_AMOUNT_WEI = 2_000_000_000_000_000n; // 0.002 ETH

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer found. Check PRIVATE_KEY in your .env file.");
  }

  const target = process.env.REPUTATION_SIGNER_ADDRESS?.trim();
  if (!target) {
    throw new Error("REPUTATION_SIGNER_ADDRESS is not set in .env");
  }

  const targetAddress = ethers.getAddress(target);
  const deployerAddress = await deployer.getAddress();

  console.log("Network:", connection.networkName);
  console.log("Deployer:", deployerAddress);
  console.log("Target signer:", targetAddress);
  console.log("Amount:", ethers.formatEther(TRANSFER_AMOUNT_WEI), "ETH");

  const balanceBefore = await deployer.provider.getBalance(targetAddress);
  console.log("Target balance BEFORE:", ethers.formatEther(balanceBefore), "ETH");

  const tx = await deployer.sendTransaction({ to: targetAddress, value: TRANSFER_AMOUNT_WEI });
  const receipt = await tx.wait();
  console.log("Transfer tx hash:", receipt?.hash ?? tx.hash);

  const balanceAfter = await deployer.provider.getBalance(targetAddress);
  console.log("Target balance AFTER:", ethers.formatEther(balanceAfter), "ETH");

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
