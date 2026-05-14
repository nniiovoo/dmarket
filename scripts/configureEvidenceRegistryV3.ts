// Encrypts secrets, uploads to Chainlink DON (slot 1, to avoid clobbering
// marketplace secrets in slot 0), and configures the EvidenceRegistryV3
// contract: subscription / donID / callback gas / secrets reference.
// The requestSource was set at deploy time (constructor); subsequent updates
// go through setRequestSource directly (no commit-reveal in this contract).
//
// Required env (root .env):
//   PRIVATE_KEY                                owner of the registry
//   SEPOLIA_RPC_URL or AMOY_RPC_URL
//   TRACK17_API_KEY                            17track API token
//   FUNCTIONS_SUBSCRIPTION_ID                  shared subscription with marketplace
//   V3_{NETWORK}_EVIDENCE_REGISTRY_ADDRESS     deployed registry
//   TRACKING_LOOKUP_URL  (optional)            same semantics as marketplace
//   TEST_TRACKING_NUMBER (optional)            mainnet-prohibited fallback
//   TEST_CARRIER         (optional)
//
// Usage:
//   npx hardhat run scripts/configureEvidenceRegistryV3.ts --network sepolia

import { readFileSync } from "node:fs";   // imported but currently unused; keep for future-proofing
import { SecretsManager } from "@chainlink/functions-toolkit";
import { network } from "hardhat";

const NETWORK_CONFIG: Record<
  string,
  {
    routerAddress: string;
    donId: string;
    donIdBytes32: string;
    gatewayUrls: string[];
  }
> = {
  sepolia: {
    routerAddress: "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0",
    donId: "fun-ethereum-sepolia-1",
    donIdBytes32: "0x66756e2d657468657265756d2d7365706f6c69612d3100000000000000000000",
    gatewayUrls: [
      "https://01.functions-gateway.testnet.chain.link/",
      "https://02.functions-gateway.testnet.chain.link/"
    ]
  },
  amoy: {
    routerAddress: "0xC22a79eBA640940ABB6dF0f7982cc119578E11De",
    donId: "fun-polygon-amoy-1",
    donIdBytes32: "0x66756e2d706f6c79676f6e2d616d6f792d310000000000000000000000000000",
    gatewayUrls: [
      "https://01.functions-gateway.testnet.chain.link/",
      "https://02.functions-gateway.testnet.chain.link/"
    ]
  },
  arbitrumSepolia: {
    routerAddress: "0x234a5fb5Bd614a7AA2FfAB244D603abFA0Ac5C5C",
    donId: "fun-arbitrum-sepolia-1",
    donIdBytes32: "0x66756e2d617262697472756d2d7365706f6c69612d3100000000000000000000",
    gatewayUrls: [
      "https://01.functions-gateway.testnet.chain.link/",
      "https://02.functions-gateway.testnet.chain.link/"
    ]
  }
};

const CALLBACK_GAS_LIMIT = 300_000;
// Chainlink DON caps secrets expiration. Sepolia/Amoy currently allow up
// to ~72 hours. Keep 3 days as safety margin.
const SECRETS_EXPIRATION_MINUTES = 60 * 24 * 3; // 3 days
const SECRETS_SLOT_ID = 1;  // marketplace uses slot 0

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function envUpper(networkName: string): string {
  return networkName.toUpperCase();
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const networkName = connection.networkName;
  const cfg = NETWORK_CONFIG[networkName];

  if (!cfg) {
    throw new Error(`Unsupported network: ${networkName}`);
  }

  const mainnetNetworks = new Set(["mainnet", "polygon", "arbitrum", "base", "optimism"]);
  const isMainnet = mainnetNetworks.has(networkName);

  const [owner] = await ethers.getSigners();
  if (!owner) {
    throw new Error("No signer; check PRIVATE_KEY in .env");
  }

  const registryAddress = requireEnv(`V3_${envUpper(networkName)}_EVIDENCE_REGISTRY_ADDRESS`);
  const subscriptionId = BigInt(requireEnv("FUNCTIONS_SUBSCRIPTION_ID"));
  const track17Key = requireEnv("TRACK17_API_KEY");
  const trackingLookupUrl = process.env.TRACKING_LOOKUP_URL ?? "";
  const testTrackingNumber = process.env.TEST_TRACKING_NUMBER ?? "";
  const testCarrier = process.env.TEST_CARRIER ?? "";

  if (isMainnet && !trackingLookupUrl) {
    throw new Error(
      `Refusing to deploy on ${networkName} without TRACKING_LOOKUP_URL — ` +
      `the fallback test-tracking path is testnet-only.`
    );
  }
  if (isMainnet && (testTrackingNumber || testCarrier)) {
    throw new Error(
      `Refusing to deploy on ${networkName} with TEST_TRACKING_NUMBER / TEST_CARRIER set ` +
      `— these are testnet-only secrets.`
    );
  }

  if (!trackingLookupUrl && !testTrackingNumber) {
    throw new Error("Either TRACKING_LOOKUP_URL or TEST_TRACKING_NUMBER must be set");
  }

  const ownerAddress = await owner.getAddress();
  console.log("Configuring EvidenceRegistryV3 Functions integration");
  console.log("  network:       ", networkName);
  console.log("  owner:         ", ownerAddress);
  console.log("  registry:      ", registryAddress);
  console.log("  subscription:  ", subscriptionId.toString());
  console.log("  donId:         ", cfg.donId);
  console.log("  secrets slot:  ", SECRETS_SLOT_ID);

  // 1. Upload secrets to DON slot 1.
  // functions-toolkit (0.3.x) ships ethers v5 internally and SecretsManager
  // constructs ethers.Contract directly, which rejects v6 signers from
  // hardhat-ethers. Use createRequire to grab v5 from the nested install.
  const { createRequire } = await import("node:module");
  const requireCJS = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ethersV5: any = requireCJS("@chainlink/functions-toolkit/node_modules/ethers");
  const rpcEnvName: Record<string, string> = {
    sepolia: "SEPOLIA_RPC_URL",
    amoy: "AMOY_RPC_URL",
    arbitrumSepolia: "ARBITRUM_SEPOLIA_RPC_URL"
  };
  const rpcUrl = requireEnv(rpcEnvName[networkName] ?? "SEPOLIA_RPC_URL");
  const v5Provider = new ethersV5.providers.JsonRpcProvider(rpcUrl);
  const v5Wallet = new ethersV5.Wallet(requireEnv("PRIVATE_KEY"), v5Provider);

  const secretsManager = new SecretsManager({
    signer: v5Wallet,
    functionsRouterAddress: cfg.routerAddress,
    donId: cfg.donId
  });
  await secretsManager.initialize();

  const secrets: Record<string, string> = { TRACK17_KEY: track17Key };
  if (trackingLookupUrl) secrets.TRACKING_LOOKUP_URL = trackingLookupUrl;
  if (testTrackingNumber) secrets.TEST_TRACKING_NUMBER = testTrackingNumber;
  if (testCarrier) secrets.TEST_CARRIER = testCarrier;
  if (!trackingLookupUrl && testTrackingNumber) {
    secrets.ALLOW_TEST_FALLBACK = "1";
  }

  console.log("Encrypting + uploading secrets to DON slot", SECRETS_SLOT_ID, "...");
  const encrypted = await secretsManager.encryptSecrets(secrets);
  const uploadResult = await secretsManager.uploadEncryptedSecretsToDON({
    encryptedSecretsHexstring: encrypted.encryptedSecrets,
    gatewayUrls: cfg.gatewayUrls,
    slotId: SECRETS_SLOT_ID,
    minutesUntilExpiration: SECRETS_EXPIRATION_MINUTES
  });
  if (!uploadResult.success) {
    throw new Error(`DON secrets upload failed: ${JSON.stringify(uploadResult)}`);
  }

  console.log("Secrets uploaded. version:", uploadResult.version);

  const secretsReference = secretsManager.buildDONHostedEncryptedSecretsReference({
    slotId: SECRETS_SLOT_ID,
    version: uploadResult.version
  });

  // 2. Configure registry.
  const registry = await ethers.getContractAt("EvidenceRegistryV3", registryAddress, owner);

  console.log("Setting subscription id...");
  await (await registry.setSubscriptionId(subscriptionId)).wait();

  console.log("Setting donId...");
  await (await registry.setDonId(cfg.donIdBytes32)).wait();

  console.log("Setting callback gas limit:", CALLBACK_GAS_LIMIT);
  await (await registry.setCallbackGasLimit(CALLBACK_GAS_LIMIT)).wait();

  console.log("Setting encrypted secrets reference...");
  await (await registry.setEncryptedSecretsReference(secretsReference)).wait();

  console.log("\nDone. Don't forget to add the registry as a Functions consumer:");
  console.log("  scripts/addEvidenceRegistryConsumer.ts   --network", networkName);

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
