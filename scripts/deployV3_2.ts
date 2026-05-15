import { network } from "hardhat";

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();

  if (deployer === undefined) {
    throw new Error("No deployer signer found. Check PRIVATE_KEY in your .env file.");
  }

  const deployerAddress = await deployer.getAddress();
  const envNetwork = connection.networkName.toUpperCase();

  let reputationSigner = process.env.REPUTATION_SIGNER_ADDRESS;
  if (!reputationSigner || reputationSigner.trim() === "") {
    // Derive a deterministic, off-by-one address from the deployer so the deploy
    // is reproducible without a separate key. This MUST NOT be used in prod —
    // a real attestor needs its own custodied private key.
    const derived = "0x" + (BigInt(deployerAddress) + 1n).toString(16).padStart(40, "0");
    reputationSigner = ethers.getAddress(derived);
    console.warn(
      `WARN: REPUTATION_SIGNER_ADDRESS not set. Using derived address ${reputationSigner}. ` +
        `In production this MUST be a separate, custodied key.`
    );
  }

  console.log("Deploying ChainUs v3.2...");
  console.log("Network name:", connection.networkName);
  console.log("Deployer address:", deployerAddress);
  console.log("Reputation signer:", reputationSigner);

  // -------------------------------------------------------------------------
  // EscrowMarketplaceERC20
  // -------------------------------------------------------------------------
  const MarketplaceFactory = await ethers.getContractFactory("EscrowMarketplaceERC20", deployer);
  const marketplace = await MarketplaceFactory.deploy();
  const marketplaceDeploymentTx = marketplace.deploymentTransaction();
  if (marketplaceDeploymentTx === null) {
    throw new Error("Marketplace deployment transaction was not found");
  }
  await marketplace.waitForDeployment();
  const marketplaceAddress = await marketplace.getAddress();

  console.log("V3.2 marketplace address:", marketplaceAddress);
  console.log("V3.2 marketplace deployment tx hash:", marketplaceDeploymentTx.hash);

  // -------------------------------------------------------------------------
  // ReputationRegistry
  // -------------------------------------------------------------------------
  const RegistryFactory = await ethers.getContractFactory("ReputationRegistry", deployer);
  const registry = await RegistryFactory.deploy(reputationSigner);
  const registryDeploymentTx = registry.deploymentTransaction();
  if (registryDeploymentTx === null) {
    throw new Error("Registry deployment transaction was not found");
  }
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();

  console.log("V3.2 reputation registry address:", registryAddress);
  console.log("V3.2 reputation registry deployment tx hash:", registryDeploymentTx.hash);

  // -------------------------------------------------------------------------
  // MockERC20 (testnet-only mUSD)
  // -------------------------------------------------------------------------
  const MockFactory = await ethers.getContractFactory("MockERC20", deployer);
  const mockUsd = await MockFactory.deploy("ChainUs Mock USD", "mUSD", 6);
  const mockDeploymentTx = mockUsd.deploymentTransaction();
  if (mockDeploymentTx === null) {
    throw new Error("MockERC20 deployment transaction was not found");
  }
  await mockUsd.waitForDeployment();
  const mockUsdAddress = await mockUsd.getAddress();

  console.log("V3.2 mock USD address:", mockUsdAddress);
  console.log("V3.2 mock USD deployment tx hash:", mockDeploymentTx.hash);

  // Mint 1,000,000 mUSD to the deployer for development convenience.
  const mintAmount = 1_000_000n * 10n ** 6n;
  const mintTx = await mockUsd.connect(deployer).mint(deployerAddress, mintAmount);
  await mintTx.wait();
  console.log("V3.2 mock USD mint tx hash:", mintTx.hash);

  // -------------------------------------------------------------------------
  // Allowlist mUSD
  // -------------------------------------------------------------------------
  let setMockTxHash = "";
  try {
    const tx = await marketplace.connect(deployer).setAcceptedToken(mockUsdAddress, true);
    const receipt = await tx.wait();
    setMockTxHash = receipt?.hash ?? tx.hash;
    console.log("V3.2 setAcceptedToken(mUSD) tx hash:", setMockTxHash);
  } catch (err) {
    console.error("setAcceptedToken(mUSD) failed:", err);
  }

  // -------------------------------------------------------------------------
  // Allowlist USDC (testnet) if provided
  // -------------------------------------------------------------------------
  const usdcAddressRaw = process.env[`V3_2_${envNetwork}_USDC_ADDRESS`];
  let setUsdcTxHash = "";
  let usdcAddress = "";
  if (usdcAddressRaw && usdcAddressRaw.trim() !== "") {
    try {
      usdcAddress = ethers.getAddress(usdcAddressRaw.trim());
      const tx = await marketplace.connect(deployer).setAcceptedToken(usdcAddress, true);
      const receipt = await tx.wait();
      setUsdcTxHash = receipt?.hash ?? tx.hash;
      console.log("V3.2 setAcceptedToken(USDC) tx hash:", setUsdcTxHash);
    } catch (err) {
      console.error(`setAcceptedToken(USDC=${usdcAddressRaw}) failed:`, err);
      setUsdcTxHash = "FAILED";
    }
  } else {
    console.log(`V3.2 setAcceptedToken(USDC): skipped — V3_2_${envNetwork}_USDC_ADDRESS not set`);
  }

  // -------------------------------------------------------------------------
  // Paste-into-.env block
  // -------------------------------------------------------------------------
  console.log("\n--- Paste into .env ---");
  console.log(`V3_2_${envNetwork}_MARKETPLACE_ADDRESS=${marketplaceAddress}`);
  console.log(`V3_2_${envNetwork}_REPUTATION_ADDRESS=${registryAddress}`);
  console.log(`V3_2_${envNetwork}_MOCK_USD_ADDRESS=${mockUsdAddress}`);
  if (usdcAddress) {
    console.log(`V3_2_${envNetwork}_USDC_ADDRESS=${usdcAddress}`);
  }
  console.log(`REPUTATION_SIGNER_ADDRESS=${reputationSigner}`);
  console.log("--- End paste block ---\n");

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
