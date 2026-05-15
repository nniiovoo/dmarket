import { network } from "hardhat";

// Rotate the ReputationRegistry signer key from the orphan address (Phase A
// derived deployer+1, no private key custodian) to a real key whose secret
// lives in env. Idempotent: if signer() already equals the target, the
// script exits cleanly without spending gas.
//
// Two-phase workflow:
//   Run 1: env has no REPUTATION_SIGNER_PRIVATE_KEY → script generates a
//          random key pair, prints them, exits. User pastes both into .env.
//   Run 2: env has REPUTATION_SIGNER_PRIVATE_KEY → script derives address,
//          calls setPendingSigner(deployer) then acceptSigner(newSigner).
//
// Run 2 requires the target signer wallet to hold enough ETH for the
// acceptSigner tx. The script checks balance and bails with a faucet hint
// if it's too low rather than running into "insufficient funds" mid-flow.
async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer found. Check PRIVATE_KEY in your .env file.");
  }

  const envNetwork = connection.networkName.toUpperCase();
  const registryAddress = process.env[`V3_2_${envNetwork}_REPUTATION_ADDRESS`];
  if (!registryAddress) {
    throw new Error(`V3_2_${envNetwork}_REPUTATION_ADDRESS is not set`);
  }

  const newPrivateKey = process.env.REPUTATION_SIGNER_PRIVATE_KEY?.trim();
  if (!newPrivateKey || newPrivateKey === "" || newPrivateKey.toLowerCase() === "0x") {
    const generated = ethers.Wallet.createRandom();
    console.log("REPUTATION_SIGNER_PRIVATE_KEY is not set — generated a fresh key pair.");
    console.log("");
    console.log("Copy these into your .env, then re-run this script:");
    console.log("");
    console.log(`REPUTATION_SIGNER_PRIVATE_KEY=${generated.privateKey}`);
    console.log(`REPUTATION_SIGNER_ADDRESS=${generated.address}`);
    console.log("");
    console.log(`Then fund ${generated.address} with at least 0.001 ETH on Arbitrum Sepolia`);
    console.log("https://www.alchemy.com/faucets/arbitrum-sepolia");
    await connection.close();
    return;
  }

  let newWallet;
  try {
    newWallet = new ethers.Wallet(newPrivateKey, deployer.provider);
  } catch (err) {
    throw new Error(`REPUTATION_SIGNER_PRIVATE_KEY is set but not a valid private key: ${err instanceof Error ? err.message : String(err)}`);
  }
  const newSignerAddress = newWallet.address;

  console.log("Network:", connection.networkName);
  console.log("Registry:", registryAddress);
  console.log("Target signer:", newSignerAddress);

  const registry = await ethers.getContractAt("ReputationRegistry", registryAddress, deployer);

  const currentSigner = (await registry.signer()) as string;
  console.log("Current signer:", currentSigner);

  if (currentSigner.toLowerCase() === newSignerAddress.toLowerCase()) {
    console.log("Signer already matches target — nothing to do (idempotent).");
    await connection.close();
    return;
  }

  // Balance check for the target signer wallet (it must pay gas for the
  // acceptSigner call). 0.001 ETH covers an Arbitrum Sepolia call generously.
  const targetBalance = await deployer.provider.getBalance(newSignerAddress);
  const minBalance = 1_000_000_000_000_000n; // 0.001 ETH
  if (targetBalance < minBalance) {
    console.error(
      `Target signer ${newSignerAddress} has only ${targetBalance.toString()} wei (~${ethers.formatEther(targetBalance)} ETH).`
    );
    console.error("It needs at least 0.001 ETH to send the acceptSigner tx.");
    console.error("Fund it from a faucet: https://www.alchemy.com/faucets/arbitrum-sepolia");
    await connection.close();
    process.exitCode = 1;
    return;
  }

  // Check pending signer — if a previous run already pending'd this address
  // we can skip straight to acceptSigner.
  const pending = (await registry.pendingSigner()) as string;
  let setPendingTxHash: string | undefined;
  if (pending.toLowerCase() === newSignerAddress.toLowerCase()) {
    console.log("Pending signer already points to target — skipping setPendingSigner.");
  } else {
    console.log("Calling setPendingSigner(...)");
    const tx = await registry.connect(deployer).setPendingSigner(newSignerAddress);
    const receipt = await tx.wait();
    setPendingTxHash = receipt?.hash ?? tx.hash;
    console.log("setPendingSigner tx hash:", setPendingTxHash);
  }

  console.log("Calling acceptSigner() as new signer");
  const acceptTx = await registry.connect(newWallet).acceptSigner();
  const acceptReceipt = await acceptTx.wait();
  const acceptTxHash = acceptReceipt?.hash ?? acceptTx.hash;
  console.log("acceptSigner tx hash:", acceptTxHash);

  const finalSigner = (await registry.signer()) as string;
  if (finalSigner.toLowerCase() !== newSignerAddress.toLowerCase()) {
    throw new Error(`signer() reads ${finalSigner}, expected ${newSignerAddress}`);
  }

  console.log("");
  console.log("Done. Final on-chain signer:", finalSigner);
  if (setPendingTxHash) {
    console.log(`setPendingSigner tx: ${setPendingTxHash}`);
  }
  console.log(`acceptSigner tx:    ${acceptTxHash}`);
  console.log("");
  console.log("Remember to update .env so all future attestation issuance uses this key:");
  console.log(`REPUTATION_SIGNER_ADDRESS=${newSignerAddress}`);

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
