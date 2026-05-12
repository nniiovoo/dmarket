import { network } from "hardhat";

async function main() {
  // Connect to the network selected with `--network`.
  const connection = await network.create();
  const { ethers } = connection;

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  console.log("Deploying EscrowMarketplace...");
  console.log("Network name:", connection.networkName);
  console.log("Deployer address:", deployerAddress);

  // EscrowMarketplace has no constructor arguments.
  const marketplace = await ethers.deployContract("EscrowMarketplace", [], deployer);
  const deploymentTx = marketplace.deploymentTransaction();

  if (deploymentTx === null) {
    throw new Error("Deployment transaction was not found");
  }

  await marketplace.waitForDeployment();

  console.log("Contract address:", await marketplace.getAddress());
  console.log("Transaction hash:", deploymentTx.hash);

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
