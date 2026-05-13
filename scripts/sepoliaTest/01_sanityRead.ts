// Sepolia deployment sanity check — read-only.
// Verifies all wiring + Chainlink config without spending gas.
//
// Required env (root .env):
//   PRIVATE_KEY
//   SEPOLIA_RPC_URL
//   V3_SEPOLIA_VAULT_ADDRESS
//   V3_SEPOLIA_MARKETPLACE_ADDRESS
//   V3_SEPOLIA_EVIDENCE_REGISTRY_ADDRESS
//   FUNCTIONS_SUBSCRIPTION_ID
//
// Usage:
//   npx hardhat run scripts/sepoliaTest/01_sanityRead.ts --network sepolia

import { network } from "hardhat";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function assertEq(label: string, actual: string | bigint | number, expected: string | bigint | number) {
  const actualStr = typeof actual === "bigint" ? actual.toString() : String(actual);
  const expectedStr = typeof expected === "bigint" ? expected.toString() : String(expected);
  if (actualStr.toLowerCase() === expectedStr.toLowerCase()) {
    console.log(`  ✓ ${label}: ${actualStr}`);
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`      actual:   ${actualStr}`);
    console.log(`      expected: ${expectedStr}`);
    throw new Error(`Mismatch: ${label}`);
  }
}

function assertNonZero(label: string, value: string | bigint, hint?: string) {
  const v = typeof value === "bigint" ? value.toString() : value;
  const isZero =
    v === "0" ||
    v === "0x0000000000000000000000000000000000000000" ||
    v === "0x0000000000000000000000000000000000000000000000000000000000000000";
  if (!isZero) {
    console.log(`  ✓ ${label}: ${v}${hint ? ` (${hint})` : ""}`);
  } else {
    console.log(`  ✗ ${label}: is zero / unset`);
    throw new Error(`Empty: ${label}`);
  }
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;

  const vaultAddr = requireEnv("V3_SEPOLIA_VAULT_ADDRESS");
  const marketplaceAddr = requireEnv("V3_SEPOLIA_MARKETPLACE_ADDRESS");
  const registryAddr = requireEnv("V3_SEPOLIA_EVIDENCE_REGISTRY_ADDRESS");
  const expectedSubId = BigInt(requireEnv("FUNCTIONS_SUBSCRIPTION_ID"));

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer");
  const deployer = await signer.getAddress();

  console.log("=".repeat(70));
  console.log("V3 Sepolia Deployment Sanity Check");
  console.log("=".repeat(70));
  console.log(`Network:           ${connection.networkName}`);
  console.log(`Caller / deployer: ${deployer}`);
  console.log(`Vault:             ${vaultAddr}`);
  console.log(`Marketplace:       ${marketplaceAddr}`);
  console.log(`EvidenceRegistry:  ${registryAddr}`);
  console.log(`Subscription:      ${expectedSubId}`);

  const vault = await ethers.getContractAt("EscrowVaultV3", vaultAddr, signer);
  const marketplace = await ethers.getContractAt("EscrowMarketplaceV3", marketplaceAddr, signer);
  const registry = await ethers.getContractAt("EvidenceRegistryV3", registryAddr, signer);

  console.log("\n[1/6] Vault wiring");
  assertEq("vault.owner", await vault.owner(), deployer);
  assertEq("vault.marketplace", await vault.marketplace(), marketplaceAddr);

  console.log("\n[2/6] Marketplace wiring");
  assertEq("marketplace.vault", await marketplace.vault(), vaultAddr);
  assertEq("marketplace.functionsRouter", await marketplace.functionsRouter(), "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0");
  assertEq("marketplace.owner", await marketplace.owner(), deployer);
  assertEq("marketplace.pendingOwner", await marketplace.pendingOwner(), "0x0000000000000000000000000000000000000000");
  assertEq("marketplace.nextOrderId (should be 1)", await marketplace.nextOrderId(), 1);
  assertEq("marketplace.paused", await marketplace.paused(), false);

  console.log("\n[3/6] Marketplace Chainlink config");
  assertEq("marketplace.subscriptionId", await marketplace.subscriptionId(), expectedSubId);
  assertNonZero("marketplace.donID", await marketplace.donID());
  assertEq("marketplace.callbackGasLimit", await marketplace.callbackGasLimit(), 300_000);
  const sourceLen = (await marketplace.requestSource()).length;
  assertNonZero("marketplace.requestSource length", BigInt(sourceLen), `${sourceLen} chars`);
  const secretsRef = await marketplace.encryptedSecretsReference();
  assertNonZero("marketplace.encryptedSecretsReference", secretsRef, `${secretsRef.length / 2 - 1} bytes`);

  console.log("\n[4/6] Marketplace ↔ Registry hook");
  assertEq("marketplace.evidenceRegistry", await marketplace.evidenceRegistry(), registryAddr);
  assertEq("registry.marketplace", await registry.marketplace(), marketplaceAddr);

  console.log("\n[5/6] Registry Chainlink config");
  assertEq("registry.functionsRouter", await registry.functionsRouter(), "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0");
  assertEq("registry.owner", await registry.owner(), deployer);
  assertEq("registry.paused", await registry.paused(), false);
  assertEq("registry.subscriptionId", await registry.subscriptionId(), expectedSubId);
  assertNonZero("registry.donID", await registry.donID());
  assertEq("registry.callbackGasLimit", await registry.callbackGasLimit(), 300_000);
  const regSourceLen = (await registry.requestSource()).length;
  assertNonZero("registry.requestSource length", BigInt(regSourceLen), `${regSourceLen} chars`);
  const regSecretsRef = await registry.encryptedSecretsReference();
  assertNonZero("registry.encryptedSecretsReference", regSecretsRef, `${regSecretsRef.length / 2 - 1} bytes`);

  console.log("\n[6/6] Time-window constants");
  const constants = [
    ["DELIVERY_REQUEST_COOLDOWN", await marketplace.DELIVERY_REQUEST_COOLDOWN(), 3600n],
    ["DISPUTE_RESOLUTION_DELAY", await marketplace.DISPUTE_RESOLUTION_DELAY(), 3n * 24n * 3600n],
    ["EMERGENCY_REFUND_PAID_DELAY", await marketplace.EMERGENCY_REFUND_PAID_DELAY(), 30n * 24n * 3600n],
    ["EMERGENCY_REFUND_SHIPPED_DELAY", await marketplace.EMERGENCY_REFUND_SHIPPED_DELAY(), 60n * 24n * 3600n],
    ["REQUEST_SOURCE_DELAY", await marketplace.REQUEST_SOURCE_DELAY(), 7n * 24n * 3600n],
    ["ORACLE_QUERY_COOLDOWN (registry)", await registry.ORACLE_QUERY_COOLDOWN(), 3600n]
  ] as const;
  for (const [name, actual, expected] of constants) {
    assertEq(name, actual, expected);
  }

  console.log("\n" + "=".repeat(70));
  console.log("✓ ALL SANITY CHECKS PASSED");
  console.log("=".repeat(70));

  await connection.close();
}

main().catch((error: unknown) => {
  console.error("\n✗ SANITY CHECK FAILED");
  console.error(error);
  process.exitCode = 1;
});
