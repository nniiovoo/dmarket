// Migrates existing v3.2 sellers into the ShopNFT layer (Phase K.1).
//
// For every distinct seller address that appears in OnChainOrderV3_2,
// adminMint a ShopNFT to that seller. Skips sellers that already have
// `shopIdOf != 0` on-chain — idempotent, re-run as needed.
//
// Required env (in addition to PRIVATE_KEY for the deployer / NFT owner):
//   V3_3_<NETWORK>_SHOP_NFT_ADDRESS  e.g. V3_3_ARBITRUMSEPOLIA_SHOP_NFT_ADDRESS
//   DATABASE_URL                     points at the v3.2 indexer DB
//
// Optional env:
//   SHOP_MIGRATION_NAME_PREFIX  prefix for the auto-generated shop name
//                               (default "Shop"). Each shop is named
//                               "<prefix> #<n>" where n is a 1-indexed
//                               counter from this run, so a human can
//                               glance at the chain and tell apart
//                               imports from self-mints.
//
// Run:
//   npx hardhat run scripts/migrateSellersToShopNFT.ts --network arbitrumSepolia

import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: "frontend/.env.local" });

import { network } from "hardhat";

import { PrismaClient } from "../frontend/node_modules/@prisma/client/index.js";

const IMPORTED_DESCRIPTION = "Imported from v3.2 — owner can update at any time.";

async function main() {
  const namePrefix = process.env.SHOP_MIGRATION_NAME_PREFIX ?? "Shop";

  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) {
    throw new Error("No deployer signer found. Check PRIVATE_KEY in your .env file.");
  }
  const deployerAddress = await deployer.getAddress();
  const envNetwork = connection.networkName.toUpperCase();

  const shopNftAddrRaw = process.env[`V3_3_${envNetwork}_SHOP_NFT_ADDRESS`];
  if (!shopNftAddrRaw || shopNftAddrRaw.trim() === "") {
    throw new Error(
      `V3_3_${envNetwork}_SHOP_NFT_ADDRESS is not set — run scripts/deployShopNFT.ts first.`
    );
  }
  const shopNftAddress = ethers.getAddress(shopNftAddrRaw.trim());

  console.log("Migrating v3.2 sellers into ShopNFT...");
  console.log("Network         :", connection.networkName);
  console.log("Deployer (owner):", deployerAddress);
  console.log("ShopNFT address :", shopNftAddress);

  const shopNft = await ethers.getContractAt("ShopNFT", shopNftAddress, deployer);

  // Sanity-check ownership before we burn gas on adminMint calls that
  // would revert with `OwnableUnauthorizedAccount`.
  const owner: string = await shopNft.owner();
  if (owner.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(
      `Deployer ${deployerAddress} is not the ShopNFT owner (${owner}). Run this from the deployer wallet.`
    );
  }

  const prisma = new PrismaClient();
  let attempted = 0;
  let migrated = 0;
  let skipped = 0;
  const log: Array<{ seller: string; shopId: bigint | null; tx?: string; reason?: string }> = [];

  try {
    // Distinct seller addresses (stored lowercased in OnChainOrderV3_2).
    const rows = await prisma.onChainOrderV3_2.findMany({
      select: { seller: true },
      distinct: ["seller"]
    });
    console.log(`Found ${rows.length} distinct sellers in OnChainOrderV3_2.\n`);

    for (const { seller: sellerLower } of rows) {
      attempted += 1;
      const seller = ethers.getAddress(sellerLower);

      const existing: bigint = await shopNft.shopIdOf(seller);
      if (existing !== 0n) {
        skipped += 1;
        log.push({ seller, shopId: existing, reason: "already_has_shop" });
        console.log(`  [skip] ${seller} already owns shop #${existing.toString()}`);
        continue;
      }

      const name = `${namePrefix} #${attempted}`;
      try {
        const tx = await shopNft.adminMint(seller, name, IMPORTED_DESCRIPTION, "");
        const receipt = await tx.wait();
        if (!receipt) throw new Error("no receipt");
        // After mint the new shopId is whatever shopIdOf returns.
        const shopId: bigint = await shopNft.shopIdOf(seller);
        migrated += 1;
        log.push({ seller, shopId, tx: receipt.hash });
        console.log(`  [mint] ${seller} -> shop #${shopId.toString()} (tx ${receipt.hash})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.push({ seller, shopId: null, reason: msg });
        console.error(`  [err ] ${seller}: ${msg}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log("\n--- Summary ---");
  console.log(`Attempted : ${attempted}`);
  console.log(`Migrated  : ${migrated}`);
  console.log(`Skipped   : ${skipped}`);
  for (const entry of log) {
    const shop = entry.shopId !== null ? `shop #${entry.shopId.toString()}` : "(no mint)";
    const tail = entry.tx ?? entry.reason ?? "";
    console.log(`  ${entry.seller}  ${shop}  ${tail}`);
  }
  console.log("---------------\n");

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
