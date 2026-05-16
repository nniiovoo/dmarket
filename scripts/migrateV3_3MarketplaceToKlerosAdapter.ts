// Migrate v3.3 marketplace ownership to KlerosV2DisputeAdapterV3_3.
//
// Marketplace + adapter are both Ownable2Step. Migration is two on-chain txs:
//   1. current marketplace owner → marketplace.transferOwnership(adapter)
//      → adapter becomes pendingOwner
//   2. adapter owner (= current marketplace owner on testnet) →
//      adapter.acceptMarketplaceOwnership()
//      → adapter internally calls marketplace.acceptOwnership()
//
// After this:
//   - marketplace.resolveDispute is reachable only via the adapter
//     (Kleros rule() callback OR adapter.executeEmergencyRefund OR
//      adapter.executeOnMarketplace by the owner).
//   - other owner-only marketplace functions (pause / unpause /
//     setAcceptedToken / setDistributor / setFeeRateBps / setFeeRecipient)
//     are reachable via adapter.executeOnMarketplace.
//
// Required env:
//   PRIVATE_KEY                                — current marketplace owner
//   ARBITRUM_SEPOLIA_RPC_URL                   — or matching RPC
//   V3_3_<NETWORK>_MARKETPLACE_ADDRESS
//   V3_3_<NETWORK>_KLEROS_ADAPTER_ADDRESS      — from deployKlerosAdapterV3_3 output
//
// Idempotent: re-running once marketplace.owner() == adapter exits cleanly.

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
  if (!signer) throw new Error("No signer; check PRIVATE_KEY");
  const signerAddr = await signer.getAddress();

  const marketplaceAddress = requireEnv(`V3_3_${upper}_MARKETPLACE_ADDRESS`);
  const adapterAddress = requireEnv(`V3_3_${upper}_KLEROS_ADAPTER_ADDRESS`);

  console.log("Migrating v3.3 marketplace ownership → Kleros adapter");
  console.log(`  network:     ${networkName}`);
  console.log(`  signer:      ${signerAddr}`);
  console.log(`  marketplace: ${marketplaceAddress}`);
  console.log(`  adapter:     ${adapterAddress}`);

  const marketplace = await ethers.getContractAt("EscrowMarketplaceV3_3", marketplaceAddress, signer);
  const adapter = await ethers.getContractAt("KlerosV2DisputeAdapterV3_3", adapterAddress, signer);

  // Idempotency check.
  const currentOwner = await marketplace.owner();
  console.log(`\n[pre-check] marketplace.owner()         = ${currentOwner}`);
  if (currentOwner.toLowerCase() === adapterAddress.toLowerCase()) {
    console.log("\nMarketplace is already owned by the adapter. Nothing to do.");
    await connection.close();
    return;
  }
  if (currentOwner.toLowerCase() !== signerAddr.toLowerCase()) {
    throw new Error(
      `Signer ${signerAddr} is not the current marketplace owner (${currentOwner}). ` +
        `Re-run with PRIVATE_KEY of the actual owner.`
    );
  }

  const adapterOwner = await adapter.owner();
  console.log(`[pre-check] adapter.owner()             = ${adapterOwner}`);
  if (adapterOwner.toLowerCase() !== signerAddr.toLowerCase()) {
    throw new Error(
      `Adapter owner ${adapterOwner} differs from signer ${signerAddr}. ` +
        `Cannot complete migration — re-run with the adapter owner's key.`
    );
  }

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
  console.log("  2. Adapter owner via adapter.executeEmergencyRefund() (KLEROS_TIMEOUT + EMERGENCY_TIMELOCK gated)");
  console.log("  3. Adapter owner via adapter.executeOnMarketplace(<resolveDispute calldata>) — the");
  console.log("     ultimate escape hatch for un-escalated disputes; trust your multisig.");

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
