import { network } from "hardhat";

async function main() {
  // Connect to the network selected with `--network`.
  const connection = await network.create();
  const { ethers } = connection;

  const [deployer] = await ethers.getSigners();

  if (deployer === undefined) {
    throw new Error("No deployer signer found. Check PRIVATE_KEY in your .env file.");
  }

  const deployerAddress = await deployer.getAddress();

  console.log("Deploying EscrowMarketplace v2...");
  console.log("Network name:", connection.networkName);
  console.log("Deployer address:", deployerAddress);

  // amoy's eth_estimateGas can fail on contract creation with
  // "contract creation code storage out of gas" even when the deployment
  // itself would succeed. Override with explicit gasLimits on amoy to
  // bypass estimation entirely. Sepolia handles estimation correctly.
  // gasLimit values are conservative caps (~2x actual measured cost) so the node's
  // upfront balance check (gasLimit * maxFeePerGas) doesn't demand absurd deposits
  // during amoy gas price spikes. Reduce if you're sure of actual gas usage.
  const isAmoy = connection.networkName === "amoy";
  const vaultOverrides = isAmoy ? { gasLimit: 800_000n } : {};
  const marketplaceOverrides = isAmoy ? { gasLimit: 3_000_000n } : {};
  const wiringOverrides = isAmoy ? { gasLimit: 80_000n } : {};

  // 1. Deploy the vault first. It will hold all escrowed funds.
  const VaultFactory = await ethers.getContractFactory("EscrowVault", deployer);
  const vault = await VaultFactory.deploy(vaultOverrides);
  const vaultDeploymentTx = vault.deploymentTransaction();

  if (vaultDeploymentTx === null) {
    throw new Error("Vault deployment transaction was not found");
  }

  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  console.log("Vault address:", vaultAddress);
  console.log("Vault deployment tx hash:", vaultDeploymentTx.hash);

  // 2. Deploy the marketplace with the vault address.
  const MarketplaceFactory = await ethers.getContractFactory("EscrowMarketplaceV2", deployer);
  const marketplace = await MarketplaceFactory.deploy(vaultAddress, marketplaceOverrides);
  const marketplaceDeploymentTx = marketplace.deploymentTransaction();

  if (marketplaceDeploymentTx === null) {
    throw new Error("Marketplace deployment transaction was not found");
  }

  await marketplace.waitForDeployment();
  const marketplaceAddress = await marketplace.getAddress();

  console.log("Marketplace address:", marketplaceAddress);
  console.log("Marketplace deployment tx hash:", marketplaceDeploymentTx.hash);

  // 3. Wire the vault so only this marketplace can lock/release funds.
  const wiringTx = await vault.connect(deployer).setMarketplace(marketplaceAddress, wiringOverrides);
  await wiringTx.wait();

  console.log("Vault wiring tx hash:", wiringTx.hash);
  console.log("Vault marketplace:", await vault.marketplace());
  console.log("EscrowMarketplace v2 deployed and wired successfully");

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
