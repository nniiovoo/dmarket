// One-off: buyer transfers a small amount of native ETH to the seller wallet
// so seller can pay gas on the current network. Used to bootstrap a fresh
// chain (e.g. Arbitrum Sepolia) where the seller has no balance yet.
//
// Usage:
//   npx hardhat run scripts/sepoliaTest/_fundSeller.ts --network arbitrumSepolia

import { network } from "hardhat";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) throw new Error(`Missing required env: ${name}`);
  return v;
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;

  const [buyer] = await ethers.getSigners();
  if (!buyer) throw new Error("No signer");

  const sellerWallet = new ethers.Wallet(requireEnv("SELLER_PRIVATE_KEY"), buyer.provider);
  const sellerAddr = await sellerWallet.getAddress();
  const amount = ethers.parseEther("0.005");

  console.log(`Sending ${ethers.formatEther(amount)} ETH from buyer to seller (${sellerAddr})`);
  const tx = await buyer.sendTransaction({ to: sellerAddr, value: amount });
  console.log(`tx: ${tx.hash}`);
  await tx.wait();
  const bal = await buyer.provider!.getBalance(sellerAddr);
  console.log(`Seller balance now: ${ethers.formatEther(bal)} ETH`);

  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
