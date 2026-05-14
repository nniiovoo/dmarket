// Deploys KlerosV2DisputeAdapter on Sepolia. Reuses MockArbitratorV2 as the
// IArbitratorV2 implementation since Kleros V2 isn't deployed to Ethereum
// Sepolia (only Arbitrum Sepolia / mainnet Arbitrum / Gnosis).
//
// On mainnet / Arbitrum, swap KLEROS_ARBITRATOR_ADDRESS to the real Kleros
// KlerosCore (or equivalent) — same IArbitratorV2 interface, no contract
// changes needed.
//
// Required env (root .env):
//   PRIVATE_KEY
//   SEPOLIA_RPC_URL
//   V3_SEPOLIA_MARKETPLACE_ADDRESS
//
// Optional:
//   KLEROS_ARBITRATOR_SEPOLIA_ADDRESS  — override the arbitrator. If unset,
//                                        we deploy a fresh MockArbitratorV2
//                                        and use its address.
//
// Usage:
//   npx hardhat run scripts/deployKlerosAdapterV3.ts --network sepolia

import { network } from "hardhat";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) throw new Error(`Missing required env: ${name}`);
  return v;
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const networkName = connection.networkName;
  const upper = networkName.toUpperCase();

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer; check PRIVATE_KEY");

  const marketplaceAddress = requireEnv(`V3_${upper}_MARKETPLACE_ADDRESS`);

  console.log("Deploying KlerosV2DisputeAdapter");
  console.log(`  network:        ${networkName}`);
  console.log(`  deployer:       ${await deployer.getAddress()}`);
  console.log(`  marketplace:    ${marketplaceAddress}`);

  // Resolve arbitrator — either env override, a known real Kleros deployment,
  // or fresh Mock deployment.
  //
  // KNOWN_REAL_KLEROS pins chains where the real Kleros V2 court already
  // exists. On those chains we must NEVER fall through to the Mock, even if
  // the env var is missing — otherwise a Mock could accidentally bind itself
  // as the arbitrator on a chain where users expect real jurors.
  const KNOWN_REAL_KLEROS: Record<string, string> = {
    arbitrumSepolia: "0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479"
  };

  let arbitratorAddress = process.env[`KLEROS_ARBITRATOR_${upper}_ADDRESS`];

  if (!arbitratorAddress) {
    if (KNOWN_REAL_KLEROS[networkName]) {
      arbitratorAddress = KNOWN_REAL_KLEROS[networkName];
      console.log(`\n[1/2] Using real Kleros V2 KlerosCore at ${arbitratorAddress}`);
    } else {
      console.log("\n[1/2] No KLEROS_ARBITRATOR_*_ADDRESS env — deploying MockArbitratorV2 as test stand-in...");
      const mock = await ethers.deployContract("MockArbitratorV2", [], deployer);
      const deployTx = mock.deploymentTransaction();
      await mock.waitForDeployment();
      arbitratorAddress = await mock.getAddress();
      console.log(`      MockArbitratorV2 deployed: ${arbitratorAddress}`);
      console.log(`      deploy tx: ${deployTx?.hash}`);
    }
  } else {
    console.log(`\n[1/2] Using existing arbitrator: ${arbitratorAddress}`);
  }

  // ExtraData encoding for Kleros V2: (uint96 courtID, uint256 minJurors).
  // For MockArbitratorV2 it's ignored — pass empty bytes.
  // For real Kleros on Arbitrum Sepolia, default to General Court (1) + 3
  // jurors. Owner can swap later via setArbitratorExtraData.
  const arbitratorExtraData =
    networkName === "arbitrumSepolia"
      ? ethers.AbiCoder.defaultAbiCoder().encode(["uint96", "uint256"], [1n, 3n])
      : "0x";

  // Template ID: 0 for Mock; for real Kleros, register a template via
  // Kleros's TemplateRegistry first and set the ID via setTemplateId().
  const templateId = 0n;

  console.log("\n[2/2] Deploying KlerosV2DisputeAdapter...");
  const adapter = await ethers.deployContract(
    "KlerosV2DisputeAdapter",
    [arbitratorAddress, marketplaceAddress, arbitratorExtraData, templateId],
    deployer
  );
  const adapterDeployTx = adapter.deploymentTransaction();
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log(`      adapter deployed: ${adapterAddress}`);
  console.log(`      deploy tx:        ${adapterDeployTx?.hash}`);

  console.log("\nDeployment complete.");
  console.log("");
  console.log("Add to .env:");
  console.log(`  KLEROS_ARBITRATOR_${upper}_ADDRESS=${arbitratorAddress}`);
  console.log(`  KLEROS_ADAPTER_${upper}_ADDRESS=${adapterAddress}`);
  console.log("");
  console.log("Next step: migrate marketplace ownership to adapter:");
  console.log(`  npx hardhat run scripts/migrateMarketplaceToKlerosAdapter.ts --network ${networkName}`);

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
