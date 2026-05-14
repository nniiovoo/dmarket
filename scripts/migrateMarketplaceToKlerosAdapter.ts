// Migrates V3 marketplace ownership to KlerosV2DisputeAdapter.
//
// V3 uses Ownable2Step. Migration is two transactions:
//   1. current marketplace owner calls marketplace.transferOwnership(adapter)
//      → adapter becomes pendingOwner
//   2. adapter's owner (multisig in production; deployer EOA on testnet)
//      calls adapter.acceptMarketplaceOwnership()
//      → adapter internally calls marketplace.acceptOwnership()
//      → marketplace.owner() == adapter
//
// After this, resolveDispute can only be invoked through the adapter — either
// by Kleros's rule() callback or by adapter's owner via emergencyResolveDispute.
//
// Required env (root .env):
//   PRIVATE_KEY                      — must be the current marketplace owner
//   SEPOLIA_RPC_URL
//   V3_SEPOLIA_MARKETPLACE_ADDRESS
//   KLEROS_ADAPTER_SEPOLIA_ADDRESS   — from deployKlerosAdapterV3.ts output
//
// Usage:
//   npx hardhat run scripts/migrateMarketplaceToKlerosAdapter.ts --network sepolia

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

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer");
  const signerAddr = await signer.getAddress();

  const marketplaceAddress = requireEnv(`V3_${upper}_MARKETPLACE_ADDRESS`);
  const adapterAddress = requireEnv(`KLEROS_ADAPTER_${upper}_ADDRESS`);

  console.log("Migrating marketplace ownership → Kleros adapter");
  console.log(`  network:     ${networkName}`);
  console.log(`  signer:      ${signerAddr}`);
  console.log(`  marketplace: ${marketplaceAddress}`);
  console.log(`  adapter:     ${adapterAddress}`);

  const marketplace = await ethers.getContractAt("EscrowMarketplaceV3", marketplaceAddress, signer);
  const adapter = await ethers.getContractAt("KlerosV2DisputeAdapter", adapterAddress, signer);

  // Sanity check: signer is current marketplace owner
  const currentOwner = await marketplace.owner();
  console.log(`\n[pre-check] marketplace.owner()        = ${currentOwner}`);
  if (currentOwner.toLowerCase() === adapterAddress.toLowerCase()) {
    console.log("\nMarketplace is already owned by the adapter. Nothing to do.");
    await connection.close();
    return;
  }
  if (currentOwner.toLowerCase() !== signerAddr.toLowerCase()) {
    throw new Error(
      `Signer ${signerAddr} is not the current marketplace owner (${currentOwner}). ` +
      `Run this script with PRIVATE_KEY of the actual owner.`
    );
  }

  // Sanity check: adapter's owner must equal signer (so they can call acceptMarketplaceOwnership)
  const adapterOwner = await adapter.owner();
  console.log(`[pre-check] adapter.owner()             = ${adapterOwner}`);
  if (adapterOwner.toLowerCase() !== signerAddr.toLowerCase()) {
    throw new Error(
      `Adapter owner ${adapterOwner} differs from signer ${signerAddr}. ` +
      `Cannot complete migration — re-run with the adapter owner's key, or transfer ` +
      `adapter ownership to the marketplace owner first.`
    );
  }

  // Sanity check: adapter's marketplace must point to this marketplace
  const adapterMarketplace = await adapter.marketplace();
  console.log(`[pre-check] adapter.marketplace()       = ${adapterMarketplace}`);
  if (adapterMarketplace.toLowerCase() !== marketplaceAddress.toLowerCase()) {
    throw new Error("Adapter is configured for a different marketplace — abort.");
  }

  console.log("\n[1/2] marketplace.transferOwnership(adapter)...");
  const tx1 = await marketplace.transferOwnership(adapterAddress);
  console.log(`      tx: ${tx1.hash}`);
  await tx1.wait();
  const pending = await marketplace.pendingOwner();
  console.log(`      marketplace.pendingOwner() = ${pending}`);
  if (pending.toLowerCase() !== adapterAddress.toLowerCase()) {
    throw new Error("transferOwnership did not set pendingOwner to adapter");
  }

  console.log("\n[2/2] adapter.acceptMarketplaceOwnership()...");
  const tx2 = await adapter.acceptMarketplaceOwnership();
  console.log(`      tx: ${tx2.hash}`);
  await tx2.wait();
  const newOwner = await marketplace.owner();
  console.log(`      marketplace.owner() = ${newOwner}`);
  if (newOwner.toLowerCase() !== adapterAddress.toLowerCase()) {
    throw new Error("acceptMarketplaceOwnership did not transfer ownership");
  }

  console.log("\nMigration complete.");
  console.log("");
  console.log("Marketplace.resolveDispute() is now reachable only via:");
  console.log("  1. Kleros (or stand-in arbitrator) calling adapter.rule()");
  console.log("  2. Adapter owner calling adapter.emergencyResolveDispute()");
  console.log("");
  console.log("If anything goes wrong, the adapter owner can transfer ownership back:");
  console.log(`  adapter.owner() can call a low-level transferMarketplaceOwnership(),`);
  console.log(`  but the adapter contract doesn't expose that today — would need a redeploy.`);

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
