// Submits evidence URIs to Kleros V2's EvidenceModule for the active dispute,
// so that the Kleros UI / jurors can see them. Our own EvidenceRegistry has
// the same data, but Kleros's frontend only reads from its own EvidenceModule.
//
// Required env (root .env):
//   PRIVATE_KEY                                    buyer
//   SELLER_PRIVATE_KEY                             seller (needs Arb Sepolia ETH)
//   ARBITRUM_SEPOLIA_RPC_URL
//   KLEROS_ADAPTER_ARBITRUMSEPOLIA_ADDRESS
//   ORDER_ID            optional, defaults to 1
//
// Usage:
//   npx hardhat run scripts/sepoliaTest/04_submitKlerosEvidence.ts --network arbitrumSepolia

import { network } from "hardhat";
import type { Wallet } from "ethers";

// Kleros V2 EvidenceModule on Arbitrum Sepolia.
// Source: github.com/kleros/kleros-v2 deployments/arbitrumSepolia/EvidenceModule_Proxy.json
const KLEROS_EVIDENCE_MODULE_ARB_SEPOLIA = "0xA88A9a25cE7f1d8b3941dA3b322Ba91D009E1397";

const EVIDENCE_MODULE_ABI = [
  "function submitEvidence(uint256 _externalDisputeID, string _evidence) external",
  "event Evidence(uint256 indexed _externalDisputeID, address indexed _party, string _evidence)"
];

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

  if (networkName !== "arbitrumSepolia") {
    throw new Error(`Only meaningful on arbitrumSepolia (Kleros V2 testnet), got ${networkName}`);
  }

  const adapterAddr = requireEnv(`KLEROS_ADAPTER_${upper}_ADDRESS`);
  const sellerKey = requireEnv("SELLER_PRIVATE_KEY");
  const orderId = BigInt(process.env.ORDER_ID ?? "1");

  const [buyer] = await ethers.getSigners();
  if (!buyer) throw new Error("No buyer signer");
  const seller = new ethers.Wallet(sellerKey, buyer.provider) as unknown as Wallet;

  const adapter = await ethers.getContractAt("KlerosV2DisputeAdapter", adapterAddr);
  const disputeID: bigint = await adapter.orderToDisputeID(orderId);

  if (disputeID === 0n) {
    throw new Error(`No Kleros dispute mapped for order ${orderId}. Run 03_realKlerosE2E first.`);
  }

  console.log(`Order ID:     ${orderId}`);
  console.log(`Dispute ID:   ${disputeID}  (will be the externalDisputeID for Kleros)`);
  console.log(`Buyer:        ${await buyer.getAddress()}`);
  console.log(`Seller:       ${await seller.getAddress()}`);
  console.log(`EvidenceModule: ${KLEROS_EVIDENCE_MODULE_ARB_SEPOLIA}`);

  const evidenceModuleAsBuyer = new ethers.Contract(
    KLEROS_EVIDENCE_MODULE_ARB_SEPOLIA,
    EVIDENCE_MODULE_ABI,
    buyer
  );
  const evidenceModuleAsSeller = new ethers.Contract(
    KLEROS_EVIDENCE_MODULE_ARB_SEPOLIA,
    EVIDENCE_MODULE_ABI,
    seller
  );

  console.log("\n[1/2] Buyer submits evidence to Kleros EvidenceModule");
  const buyerURI = "ipfs://QmBuyerEvidence_RealKleros_E2E";
  const tx1 = await evidenceModuleAsBuyer.submitEvidence(disputeID, buyerURI);
  console.log(`  tx: ${tx1.hash}`);
  await tx1.wait();
  console.log(`  ✓ confirmed`);

  console.log("\n[2/2] Seller submits counter-evidence to Kleros EvidenceModule");
  const sellerURI = "ipfs://QmSellerCounterEvidence_RealKleros_E2E";
  const tx2 = await evidenceModuleAsSeller.submitEvidence(disputeID, sellerURI);
  console.log(`  tx: ${tx2.hash}`);
  await tx2.wait();
  console.log(`  ✓ confirmed`);

  console.log("\nDone. Kleros UI should now see 2 evidence pieces for dispute ${disputeID}.");
  console.log("");
  console.log("Verify on Arbiscan (EvidenceModule events):");
  console.log(`  https://sepolia.arbiscan.io/address/${KLEROS_EVIDENCE_MODULE_ARB_SEPOLIA}#events`);
  console.log("");
  console.log("Kleros V2 UI (connect MetaMask to Arbitrum Sepolia first):");
  console.log(`  https://v2.kleros.builders/#/cases/${disputeID}`);

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
