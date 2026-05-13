// Deploys a hardened V3 stack:
//   1. EscrowVaultV3 (owner = deployer initially, only used for setMarketplace)
//   2. EscrowMarketplaceV3 (owner = deployer initially)
//   3. TimelockController with the multisig as PROPOSER and EXECUTOR
//   4. Calls marketplace.transferOwnership(timelock) — multisig then must
//      schedule + execute a timelock.acceptOwnership() proposal
//
// Required env (root .env):
//   PRIVATE_KEY                       deployer (single-use, can be cold)
//   SEPOLIA_RPC_URL or AMOY_RPC_URL
//   FUNCTIONS_ROUTER_ADDRESS_<NETWORK>   Chainlink Functions router for that network
//   MULTISIG_ADDRESS_<NETWORK>            Gnosis Safe address that will control the timelock
//   TIMELOCK_DELAY_SECONDS                Minimum delay for queued ops (e.g. 86400 = 24h)
//
// Usage:
//   npx hardhat run scripts/deployV3WithTimelock.ts --network sepolia
//
// Post-deploy steps the operator must do manually via the multisig UI:
//   a) Schedule timelock.acceptOwnership() on the marketplace
//   b) Wait TIMELOCK_DELAY_SECONDS
//   c) Execute the queued op
//   d) Verify marketplace.owner() == timelock address
//   e) Run scripts/configureV3Functions.ts to set subscription / DON / secrets
//      (these calls must also be scheduled through the timelock from now on)

import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Standard OZ TimelockController bytecode is shipped via the npm package.
// We deploy it from this script using its ABI/bytecode through ethers.
// hardhat-toolbox already includes @openzeppelin/contracts as a dep here.

const FUNCTIONS_ROUTER: Record<string, string> = {
  sepolia: "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0",
  amoy: "0xC22a79eBA640940ABB6dF0f7982cc119578E11De"
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const networkName = connection.networkName;
  const router = FUNCTIONS_ROUTER[networkName];
  if (!router) {
    throw new Error(`Unsupported network: ${networkName}`);
  }

  const multisig = requireEnv(`MULTISIG_ADDRESS_${networkName.toUpperCase()}`);
  const delay = BigInt(requireEnv("TIMELOCK_DELAY_SECONDS"));

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer; check PRIVATE_KEY");

  console.log("Network:        ", networkName);
  console.log("Deployer:       ", await deployer.getAddress());
  console.log("Multisig:       ", multisig);
  console.log("Timelock delay: ", delay.toString(), "seconds");

  const sourcePath = join(process.cwd(), "chainlink/functions/deliveryStatus.js");
  const initialSource = readFileSync(sourcePath, "utf8");

  // 1. Deploy vault
  console.log("\n[1/4] Deploying EscrowVaultV3...");
  const vault = await ethers.deployContract("EscrowVaultV3", [await deployer.getAddress()], deployer);
  await vault.waitForDeployment();
  console.log("      vault:", await vault.getAddress());

  // 2. Deploy marketplace
  console.log("\n[2/4] Deploying EscrowMarketplaceV3...");
  const marketplace = await ethers.deployContract(
    "EscrowMarketplaceV3",
    [await vault.getAddress(), router, initialSource],
    deployer
  );
  await marketplace.waitForDeployment();
  console.log("      marketplace:", await marketplace.getAddress());
  console.log("      initial requestSource: %s chars", initialSource.length);

  // Bind vault -> marketplace once
  await (await vault.setMarketplace(await marketplace.getAddress())).wait();
  console.log("      vault.setMarketplace done");

  // 3. Deploy TimelockController
  //    proposers = [multisig], executors = [multisig], admin = address(0)
  //    (admin=0 means the timelock self-administers — no backdoor)
  console.log("\n[3/4] Deploying TimelockController...");
  const timelockArtifact = JSON.parse(
    readFileSync(
      new URL("../node_modules/@openzeppelin/contracts/build/contracts/TimelockController.json", import.meta.url),
      "utf8"
    )
  );
  const TimelockController = new ethers.ContractFactory(
    timelockArtifact.abi,
    timelockArtifact.bytecode,
    deployer
  );
  const timelock = await TimelockController.deploy(
    delay,
    [multisig],
    [multisig],
    ethers.ZeroAddress
  );
  await timelock.waitForDeployment();
  console.log("      timelock:", await timelock.getAddress());

  // 4. Transfer ownership of marketplace to timelock (step 1 of Ownable2Step)
  console.log("\n[4/4] Transferring marketplace ownership to timelock (step 1 of 2)...");
  await (await marketplace.transferOwnership(await timelock.getAddress())).wait();

  const pendingOwner = await marketplace.pendingOwner();
  console.log("      pendingOwner:", pendingOwner);
  console.log("\nNext steps (do via multisig UI on Gnosis Safe):");
  console.log("  1. Schedule call: marketplace.acceptOwnership() (no args)");
  console.log("     target: ", await marketplace.getAddress());
  console.log("     value:  0");
  console.log("     data:   ", marketplace.interface.encodeFunctionData("acceptOwnership"));
  console.log("     delay:  ", delay.toString(), "seconds");
  console.log("  2. Wait", delay.toString(), "seconds");
  console.log("  3. Execute the scheduled op");
  console.log("  4. Verify marketplace.owner() == timelock");

  console.log("\nDeployment complete.");
  console.log("  vault:      ", await vault.getAddress());
  console.log("  marketplace:", await marketplace.getAddress());
  console.log("  timelock:   ", await timelock.getAddress());

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
