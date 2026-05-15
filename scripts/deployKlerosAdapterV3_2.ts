// Deploy KlerosV2DisputeAdapterV3_2 on Arbitrum Sepolia (or any network with a
// configured v3.2 marketplace). Uses the real Kleros V2 KlerosCore on
// arbitrumSepolia; falls back to MockArbitratorV2 elsewhere.
//
// Required env (root .env):
//   PRIVATE_KEY
//   ARBITRUM_SEPOLIA_RPC_URL  (or matching RPC for the chosen network)
//   V3_2_<NETWORK>_MARKETPLACE_ADDRESS
//
// Optional:
//   KLEROS_ARBITRATOR_<NETWORK>_ADDRESS  — override the arbitrator. When unset
//     on a chain in KNOWN_REAL_KLEROS we use the pinned real Kleros address;
//     elsewhere we deploy a fresh MockArbitratorV2.
//
// Usage:
//   npx hardhat run scripts/deployKlerosAdapterV3_2.ts --network arbitrumSepolia

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

  const marketplaceAddress = requireEnv(`V3_2_${upper}_MARKETPLACE_ADDRESS`);

  console.log("Deploying KlerosV2DisputeAdapterV3_2");
  console.log(`  network:        ${networkName}`);
  console.log(`  deployer:       ${await deployer.getAddress()}`);
  console.log(`  v3.2 mkt:       ${marketplaceAddress}`);

  // Pinned real Kleros V2 KlerosCore addresses by chain. We never fall
  // through to the Mock on a chain in this list — adapter signed by a Mock
  // on a chain with real Kleros would be confusing for users.
  const KNOWN_REAL_KLEROS: Record<string, string> = {
    arbitrumSepolia: "0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479"
  };

  let arbitratorAddress = process.env[`KLEROS_ARBITRATOR_${upper}_ADDRESS`];

  if (!arbitratorAddress) {
    if (KNOWN_REAL_KLEROS[networkName]) {
      arbitratorAddress = KNOWN_REAL_KLEROS[networkName];
      console.log(`\n[1/2] Using real Kleros V2 KlerosCore at ${arbitratorAddress}`);
    } else {
      console.log(
        "\n[1/2] No KLEROS_ARBITRATOR_*_ADDRESS env — deploying MockArbitratorV2 as test stand-in..."
      );
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

  // Kleros V2 court selection: General Court (1) + 3 jurors on arbitrumSepolia.
  // For Mock, extraData is ignored — empty bytes work. Owner can swap later
  // via setArbitratorExtraData.
  const arbitratorExtraData =
    networkName === "arbitrumSepolia"
      ? ethers.AbiCoder.defaultAbiCoder().encode(["uint96", "uint256"], [1n, 3n])
      : "0x";

  // Template ID: 0 for Mock. For real Kleros, register a template via
  // Kleros's TemplateRegistry first and set the ID via setTemplateId().
  const templateId = 0n;

  console.log("\n[2/2] Deploying KlerosV2DisputeAdapterV3_2...");
  const adapter = await ethers.deployContract(
    "KlerosV2DisputeAdapterV3_2",
    [marketplaceAddress, arbitratorAddress, arbitratorExtraData, templateId],
    deployer
  );
  const adapterDeployTx = adapter.deploymentTransaction();
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log(`      adapter deployed: ${adapterAddress}`);
  console.log(`      deploy tx:        ${adapterDeployTx?.hash}`);

  console.log("\n--- Paste into .env ---");
  console.log(`KLEROS_ARBITRATOR_${upper}_ADDRESS=${arbitratorAddress}`);
  console.log(`V3_2_${upper}_KLEROS_ADAPTER_ADDRESS=${adapterAddress}`);
  console.log("--- End paste block ---");
  console.log("");
  console.log("Next step: transfer marketplace ownership to the adapter:");
  console.log(`  npx hardhat run scripts/migrateV3_2MarketplaceToKlerosAdapter.ts --network ${networkName}`);

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
