// End-to-end test against real Kleros V2 on Arbitrum Sepolia.
//
// Flow:
//   1. Buyer createAndPay() on V3 marketplace
//   2. Seller markShipped()
//   3. Buyer openDispute()
//   4. Buyer + seller submitEvidence() to EvidenceRegistry
//   5. Buyer queries Kleros arbitration cost, then adapter.escalateToKleros()
//   6. Script prints Kleros UI link so you can watch real jurors deliberate
//
// Required env (root .env):
//   PRIVATE_KEY                                   buyer / deployer
//   SELLER_PRIVATE_KEY                            seller (needs Arb Sepolia ETH)
//   ARBITRUM_SEPOLIA_RPC_URL
//   V3_ARBITRUMSEPOLIA_VAULT_ADDRESS
//   V3_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS
//   V3_ARBITRUMSEPOLIA_EVIDENCE_REGISTRY_ADDRESS
//   KLEROS_ADAPTER_ARBITRUMSEPOLIA_ADDRESS
//
// Usage:
//   npx hardhat run scripts/sepoliaTest/03_realKlerosE2E.ts --network arbitrumSepolia

import { network } from "hardhat";
import type { Wallet } from "ethers";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) throw new Error(`Missing required env: ${name}`);
  return v;
}

function fmtEth(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(6) + " ETH";
}

function section(label: string) {
  console.log("\n" + "=".repeat(70));
  console.log(label);
  console.log("=".repeat(70));
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const networkName = connection.networkName;
  const upper = networkName.toUpperCase();

  if (networkName !== "arbitrumSepolia") {
    throw new Error(
      `This script targets the REAL Kleros V2 court on Arbitrum Sepolia. ` +
      `Run with --network arbitrumSepolia, not ${networkName}.`
    );
  }

  const vaultAddr = requireEnv(`V3_${upper}_VAULT_ADDRESS`);
  const marketplaceAddr = requireEnv(`V3_${upper}_MARKETPLACE_ADDRESS`);
  const registryAddr = requireEnv(`V3_${upper}_EVIDENCE_REGISTRY_ADDRESS`);
  const adapterAddr = requireEnv(`KLEROS_ADAPTER_${upper}_ADDRESS`);
  const sellerKey = requireEnv("SELLER_PRIVATE_KEY");

  const [buyer] = await ethers.getSigners();
  if (!buyer) throw new Error("No buyer signer; check PRIVATE_KEY");
  const seller = new ethers.Wallet(sellerKey, buyer.provider) as unknown as Wallet;

  const buyerAddr = await buyer.getAddress();
  const sellerAddr = await seller.getAddress();

  const vault = await ethers.getContractAt("EscrowVaultV3", vaultAddr, buyer);
  const marketplace = await ethers.getContractAt("EscrowMarketplaceV3", marketplaceAddr, buyer);
  const registry = await ethers.getContractAt("EvidenceRegistryV3", registryAddr, buyer);
  const adapter = await ethers.getContractAt("KlerosV2DisputeAdapter", adapterAddr, buyer);

  const marketplaceAsSeller = marketplace.connect(seller);
  const registryAsSeller = registry.connect(seller);

  section("Setup");
  console.log(`Network:     ${networkName}`);
  console.log(`Buyer:       ${buyerAddr}`);
  console.log(`Seller:      ${sellerAddr}`);
  console.log(`Marketplace: ${marketplaceAddr}`);
  console.log(`Adapter:     ${adapterAddr}`);

  // Confirm adapter is marketplace owner (post-migration)
  const mOwner = await marketplace.owner();
  if (mOwner.toLowerCase() !== adapterAddr.toLowerCase()) {
    throw new Error(
      `marketplace.owner is ${mOwner}, expected adapter ${adapterAddr}. ` +
      `Did you run migrateMarketplaceToKlerosAdapter?`
    );
  }
  console.log(`✓ marketplace.owner == adapter`);

  // Balance check
  const buyerBal = await buyer.provider!.getBalance(buyerAddr);
  const sellerBal = await buyer.provider!.getBalance(sellerAddr);
  console.log(`Buyer balance:  ${fmtEth(buyerBal)}`);
  console.log(`Seller balance: ${fmtEth(sellerBal)}`);

  if (buyerBal < ethers.parseEther("0.01")) {
    throw new Error("Buyer needs ≥ 0.01 Arbitrum Sepolia ETH (escrow + Kleros fee + gas)");
  }
  if (sellerBal < ethers.parseEther("0.001")) {
    throw new Error(`Seller wallet ${sellerAddr} needs ≥ 0.001 Arbitrum Sepolia ETH for gas. Faucet it first.`);
  }

  const startOrderId = await marketplace.nextOrderId();
  const ORDER_AMOUNT = ethers.parseEther("0.001");

  // ─────────────────────────────────────────────────────────────────────
  section("[1/5] Order lifecycle: createAndPay → markShipped → openDispute");

  console.log("\nBuyer createAndPay()...");
  const tx1 = await marketplace.createAndPay(sellerAddr, 9001n, { value: ORDER_AMOUNT });
  await tx1.wait();
  const orderId = startOrderId;
  console.log(`  ✓ orderId: ${orderId}`);

  console.log("Seller markShipped()...");
  await (await marketplaceAsSeller.markShipped(orderId)).wait();
  console.log(`  ✓ Shipped`);

  console.log("Buyer openDispute()...");
  await (await marketplace.openDispute(orderId)).wait();
  const orderAfter = await marketplace.getOrder(orderId);
  console.log(`  ✓ Disputed, disputedAt=${orderAfter.disputedAt}`);

  // ─────────────────────────────────────────────────────────────────────
  section("[2/5] Submit evidence (buyer + seller)");

  console.log("\nBuyer submitEvidence()...");
  await (await registry.submitEvidence(orderId, "ipfs://QmBuyerEvidence_RealKleros_E2E")).wait();
  console.log(`  ✓ Buyer evidence submitted`);

  console.log("Seller submitEvidence()...");
  await (await registryAsSeller.submitEvidence(orderId, "ipfs://QmSellerCounterEvidence_RealKleros_E2E")).wait();
  console.log(`  ✓ Seller evidence submitted`);

  const evCount = await registry.getEvidenceCount(orderId);
  console.log(`  evidence count: ${evCount}`);

  // ─────────────────────────────────────────────────────────────────────
  section("[3/5] Query real Kleros V2 arbitration cost");

  const arbAddr = await adapter.arbitrator();
  console.log(`\nadapter.arbitrator = ${arbAddr}`);
  console.log("(This should match Kleros V2 KlerosCore_Proxy: 0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479)");

  const extraData = await adapter.arbitratorExtraData();
  console.log(`arbitratorExtraData = ${extraData}`);

  // Minimal interface for IArbitratorV2
  const arbitratorAbi = [
    "function arbitrationCost(bytes _extraData) external view returns (uint256)"
  ];
  const arbitrator = new ethers.Contract(arbAddr, arbitratorAbi, buyer);
  const cost: bigint = await arbitrator.arbitrationCost(extraData);
  console.log(`\nKleros arbitrationCost = ${fmtEth(cost)}`);

  if (cost > ethers.parseEther("0.05")) {
    console.log(`⚠ Cost is high (>0.05 ETH); aborting for safety`);
    throw new Error("arbitrationCost too high");
  }

  // ─────────────────────────────────────────────────────────────────────
  section("[4/5] Escalate to real Kleros V2");

  console.log(`\nBuyer escalateToKleros(${orderId}, { value: ${fmtEth(cost)} })...`);
  const tx2 = await adapter.escalateToKleros(orderId, { value: cost });
  console.log(`  tx submitted: ${tx2.hash}`);
  const receipt = await tx2.wait();
  console.log(`  ✓ confirmed in block ${receipt!.blockNumber}`);

  // Find DisputeEscalatedToKleros event to get disputeID
  let disputeID: bigint | undefined;
  for (const log of receipt!.logs) {
    try {
      const parsed = adapter.interface.parseLog(log);
      if (parsed?.name === "DisputeEscalatedToKleros") {
        disputeID = parsed.args.disputeID as bigint;
        break;
      }
    } catch {
      // not our event
    }
  }

  if (disputeID === undefined) {
    throw new Error("DisputeEscalatedToKleros event not found — escalation may have failed");
  }

  console.log(`\n  ✓ Kleros disputeID: ${disputeID}`);
  console.log(`  ✓ orderToDisputeID[${orderId}] = ${await adapter.orderToDisputeID(orderId)}`);
  console.log(`  ✓ disputeToOrderID[${disputeID}] = ${await adapter.disputeToOrderID(disputeID)}`);

  // ─────────────────────────────────────────────────────────────────────
  section("[5/5] Done — watch jurors deliberate");

  console.log(`
Real Kleros V2 dispute opened on Arbitrum Sepolia testnet.

  Kleros UI:
    https://v2.kleros.builders/#/cases/${disputeID}
  Arbiscan (escalation tx):
    https://sepolia.arbiscan.io/tx/${receipt!.hash}
  Arbiscan (adapter):
    https://sepolia.arbiscan.io/address/${adapterAddr}

What happens next (automated, you wait):
  - Kleros V2 sortition module randomly draws PNK-staked jurors
  - Jurors view the evidence (via Evidence event from registry)
  - They vote: 1 = BuyerWins (refund), 2 = SellerWins (complete)
  - Once voted, Kleros calls adapter.rule(${disputeID}, ruling)
  - Adapter calls marketplace.resolveDispute(${orderId}, refundBuyer=(ruling==1))
    — but only after the 3-day disputedAt cooldown elapses; if Kleros rules
    faster than that, the ruling is stored in pendingRulings and anyone
    can call adapter.applyKlerosRuling(${orderId}) once the cooldown passes.

Testnet caveat: Arbitrum Sepolia Kleros has very few jurors so resolution
can take days or never happen. For full happy-path verification we'd need
to wait, or use Arbitrum One mainnet where jurors are active.

If you want to abort and resolve via owner override (emergency):
  await adapter.emergencyResolveDispute(${orderId}, refundBuyer);
`);

  await connection.close();
}

main().catch((err: unknown) => {
  console.error("\n✗ E2E TEST FAILED");
  console.error(err);
  process.exitCode = 1;
});
