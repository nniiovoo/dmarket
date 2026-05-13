import { network } from "hardhat";

const FUNCTIONS_ROUTERS: Record<string, string> = {
  sepolia: "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0",
  amoy: "0xC22a79eBA640940ABB6dF0f7982cc119578E11De"
};

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();

  if (deployer === undefined) {
    throw new Error("No deployer signer found. Check PRIVATE_KEY in your .env file.");
  }

  const routerAddress = FUNCTIONS_ROUTERS[connection.networkName];

  if (!routerAddress) {
    throw new Error(`No Chainlink Functions router configured for network ${connection.networkName}`);
  }

  const deployerAddress = await deployer.getAddress();
  const envNetwork = connection.networkName.toUpperCase();
  const isAmoy = connection.networkName === "amoy";
  const vaultOverrides = isAmoy ? { gasLimit: 900_000n } : {};
  const marketplaceOverrides = isAmoy ? { gasLimit: 4_500_000n } : {};
  const wiringOverrides = isAmoy ? { gasLimit: 90_000n } : {};

  console.log("Deploying ChainUs v3...");
  console.log("Network name:", connection.networkName);
  console.log("Deployer address:", deployerAddress);
  console.log("Chainlink Functions router:", routerAddress);

  const VaultFactory = await ethers.getContractFactory("EscrowVaultV3", deployer);
  const vault = await VaultFactory.deploy(deployerAddress, vaultOverrides);
  const vaultDeploymentTx = vault.deploymentTransaction();

  if (vaultDeploymentTx === null) {
    throw new Error("Vault deployment transaction was not found");
  }

  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  console.log("V3 vault address:", vaultAddress);
  console.log("V3 vault deployment tx hash:", vaultDeploymentTx.hash);

  const MarketplaceFactory = await ethers.getContractFactory("EscrowMarketplaceV3", deployer);
  const marketplace = await MarketplaceFactory.deploy(vaultAddress, routerAddress, marketplaceOverrides);
  const marketplaceDeploymentTx = marketplace.deploymentTransaction();

  if (marketplaceDeploymentTx === null) {
    throw new Error("Marketplace deployment transaction was not found");
  }

  await marketplace.waitForDeployment();
  const marketplaceAddress = await marketplace.getAddress();

  console.log("V3 marketplace address:", marketplaceAddress);
  console.log("V3 marketplace deployment tx hash:", marketplaceDeploymentTx.hash);

  const wiringTx = await vault.connect(deployer).setMarketplace(marketplaceAddress, wiringOverrides);
  await wiringTx.wait();

  console.log("V3 vault wiring tx hash:", wiringTx.hash);
  console.log("V3 vault marketplace:", await vault.marketplace());
  console.log(`V3_${envNetwork}_VAULT_ADDRESS=${vaultAddress}`);
  console.log(`V3_${envNetwork}_MARKETPLACE_ADDRESS=${marketplaceAddress}`);

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
