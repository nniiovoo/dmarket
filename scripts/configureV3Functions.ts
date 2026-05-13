// Encrypt secrets, upload to Chainlink DON, then configure the V3 marketplace
// contract on the selected network (subscription, donID, callback gas, source,
// secrets reference).
//
// Required env (root .env):
//   PRIVATE_KEY                       deployer / owner of the V3 marketplace
//   SEPOLIA_RPC_URL or AMOY_RPC_URL
//   TRACK17_API_KEY                   17track API token
//   FUNCTIONS_SUBSCRIPTION_ID         Chainlink Functions subscription id
//   V3_{NETWORK}_MARKETPLACE_ADDRESS  deployed v3 marketplace address
//   TRACKING_LOOKUP_URL  (optional)   public endpoint resolving orderId -> tracking
//   TEST_TRACKING_NUMBER (optional)   fallback when no lookup URL set
//   TEST_CARRIER         (optional)   17track carrier code for the test tracking
//   ALLOW_TEST_FALLBACK is automatically set when TRACKING_LOOKUP_URL is
//   absent but TEST_TRACKING_NUMBER is present. Mainnet networks reject
//   this combination outright.
//
// Usage:
//   npx hardhat run scripts/configureV3Functions.ts --network sepolia
//   npx hardhat run scripts/configureV3Functions.ts --network amoy

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SecretsManager } from "@chainlink/functions-toolkit";
import { network } from "hardhat";

const NETWORK_CONFIG: Record<
  string,
  {
    routerAddress: string;
    donId: string; // human-readable id, e.g. "fun-ethereum-sepolia-1"
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
  }
};

const CALLBACK_GAS_LIMIT = 300_000;
const SECRETS_EXPIRATION_MINUTES = 60 * 24 * 7; // 7 days

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
  const mainnetNetworks = new Set(["mainnet", "polygon", "arbitrum", "base", "optimism"]);
  const isMainnet = mainnetNetworks.has(connection.networkName);
  const trackingLookupUrl = process.env.TRACKING_LOOKUP_URL ?? "";
  const testTrackingNumber = process.env.TEST_TRACKING_NUMBER ?? "";
  const testCarrier = process.env.TEST_CARRIER ?? "";

  if (isMainnet && !trackingLookupUrl) {
    throw new Error(
      `Refusing to deploy on ${connection.networkName} without TRACKING_LOOKUP_URL — ` +
      `the fallback test-tracking path would mark every Shipped order as delivered ` +
      `from the same tracking number. Set TRACKING_LOOKUP_URL or use a testnet.`
    );
  }

  if (isMainnet && (testTrackingNumber || testCarrier)) {
    throw new Error(
      `Refusing to deploy on ${connection.networkName} with TEST_TRACKING_NUMBER / ` +
      `TEST_CARRIER set — these are testnet-only secrets and must not be uploaded to a ` +
      `mainnet DON.`
    );
  }

  const cfg = NETWORK_CONFIG[connection.networkName];

  if (!cfg) {
    throw new Error(`Unsupported network: ${connection.networkName}`);
  }

  const [owner] = await ethers.getSigners();

  if (!owner) {
    throw new Error("No signer; check PRIVATE_KEY in .env");
  }

  const marketplaceAddress = requireEnv(`V3_${envUpper(connection.networkName)}_MARKETPLACE_ADDRESS`);
  const subscriptionId = BigInt(requireEnv("FUNCTIONS_SUBSCRIPTION_ID"));
  const track17Key = requireEnv("TRACK17_API_KEY");

  if (!trackingLookupUrl && !testTrackingNumber) {
    throw new Error("Either TRACKING_LOOKUP_URL or TEST_TRACKING_NUMBER must be set");
  }

  const ownerAddress = await owner.getAddress();
  console.log("Configuring V3 Functions integration");
  console.log("  network:           ", connection.networkName);
  console.log("  owner / signer:    ", ownerAddress);
  console.log("  marketplace:       ", marketplaceAddress);
  console.log("  subscription:      ", subscriptionId.toString());
  console.log("  donId:             ", cfg.donId);

  // 1. Encrypt + upload secrets to the DON gateways.
  // functions-toolkit ships ethers v5 types while this repo uses v6 — the
  // signer shape is compatible at runtime (signMessage / getAddress / connect)
  // but the type declarations conflict. Cast through unknown to bypass.
  const secretsManager = new SecretsManager({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: owner as any,
    functionsRouterAddress: cfg.routerAddress,
    donId: cfg.donId
  });
  await secretsManager.initialize();

  const secrets: Record<string, string> = { TRACK17_KEY: track17Key };

  if (trackingLookupUrl) secrets.TRACKING_LOOKUP_URL = trackingLookupUrl;
  if (testTrackingNumber) secrets.TEST_TRACKING_NUMBER = testTrackingNumber;
  if (testCarrier) secrets.TEST_CARRIER = testCarrier;
  // Only set ALLOW_TEST_FALLBACK explicitly on testnet AND only if user
  // intends to use the test tracking path. The JS source refuses to run
  // without this flag if TRACKING_LOOKUP_URL is also missing.
  if (!trackingLookupUrl && testTrackingNumber) {
    secrets.ALLOW_TEST_FALLBACK = "1";
  }

  console.log("Encrypting secrets locally...");
  const encrypted = await secretsManager.encryptSecrets(secrets);

  // Slot 0 is conventional for a single project; bump if you need multiple
  // simultaneous secret sets.
  const slotId = 0;
  console.log(`Uploading encrypted secrets to slot ${slotId}, expiry ${SECRETS_EXPIRATION_MINUTES} minutes...`);
  const uploadResult = await secretsManager.uploadEncryptedSecretsToDON({
    encryptedSecretsHexstring: encrypted.encryptedSecrets,
    gatewayUrls: cfg.gatewayUrls,
    slotId,
    minutesUntilExpiration: SECRETS_EXPIRATION_MINUTES
  });

  if (!uploadResult.success) {
    throw new Error(`DON secrets upload failed: ${JSON.stringify(uploadResult)}`);
  }

  console.log("DON secrets uploaded. version:", uploadResult.version);

  const secretsReference = secretsManager.buildDONHostedEncryptedSecretsReference({
    slotId,
    version: uploadResult.version
  });

  // 2. Read JS source.
  const sourcePath = join(process.cwd(), "chainlink/functions/deliveryStatus.js");
  const source = readFileSync(sourcePath, "utf8");

  // 3. Configure the marketplace contract.
  const marketplace = await ethers.getContractAt("EscrowMarketplaceV3", marketplaceAddress, owner);

  console.log("Setting subscription id...");
  await (await marketplace.setSubscriptionId(subscriptionId)).wait();

  console.log("Setting donId...");
  await (await marketplace.setDonId(cfg.donIdBytes32)).wait();

  console.log("Setting callback gas limit:", CALLBACK_GAS_LIMIT);
  await (await marketplace.setCallbackGasLimit(CALLBACK_GAS_LIMIT)).wait();

  // requestSource is set at deploy time (via constructor argument).
  // Subsequent updates must go through proposeRequestSource +
  // commitRequestSource with the 7-day delay. This script does not
  // change the source — to update it after deploy, run a separate
  // propose/commit workflow.
  console.log("Request source loaded for reference (", source.length, "chars); not updating on-chain.");

  console.log("Setting encrypted secrets reference...");
  await (await marketplace.setEncryptedSecretsReference(secretsReference)).wait();

  console.log("\nDone. Don't forget to add the marketplace as a consumer of subscription",
    subscriptionId.toString(),
    "at https://functions.chain.link/" + (connection.networkName === "sepolia" ? "sepolia" : "polygon-amoy"));

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
