// Reads Kleros V2 KlerosCore directly to verify our dispute exists and show
// its current status. Independent of any frontend UI.
//
// Usage:
//   npx hardhat run scripts/sepoliaTest/_checkKlerosDispute.ts --network arbitrumSepolia

import { network } from "hardhat";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) throw new Error(`Missing required env: ${name}`);
  return v;
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const upper = connection.networkName.toUpperCase();

  const adapterAddr = requireEnv(`KLEROS_ADAPTER_${upper}_ADDRESS`);
  const orderId = BigInt(process.env.ORDER_ID ?? "1");

  const adapter = await ethers.getContractAt("KlerosV2DisputeAdapter", adapterAddr);
  const arbitratorAddr = await adapter.arbitrator();
  const disputeID: bigint = await adapter.orderToDisputeID(orderId);
  if (disputeID === 0n) {
    console.log(`No dispute found for order ${orderId}`);
    await connection.close();
    return;
  }

  console.log(`Adapter:    ${adapterAddr}`);
  console.log(`Arbitrator: ${arbitratorAddr}  (real Kleros V2 KlerosCore)`);
  console.log(`Order ID:   ${orderId}`);
  console.log(`Dispute ID: ${disputeID}`);

  // Read KlerosCore.disputes(disputeID). V2 KlerosCore struct:
  // struct Dispute {
  //   uint96 courtID;
  //   IArbitrable arbitrated;
  //   uint256 lastPeriodChange;
  //   uint8 period;            // 0=Evidence, 1=Commit, 2=Vote, 3=Appeal, 4=Execution
  //   bool ruled;
  // }
  // Plus separate currentRuling(disputeID) → (ruling, tied, overridden)
  const klerosAbi = [
    "function disputes(uint256 _disputeID) view returns (uint96 courtID, address arbitrated, uint256 lastPeriodChange, uint256 nbRounds, uint256 currentRound, uint8 period, bool ruled)",
    "function currentRuling(uint256 _disputeID) view returns (uint256 ruling, bool tied, bool overridden)"
  ];
  const kleros = new ethers.Contract(arbitratorAddr, klerosAbi, ethers.provider);

  try {
    const d = await kleros.disputes(disputeID);
    const periodNames = ["Evidence", "Commit", "Vote", "Appeal", "Execution"];
    console.log(`\nKlerosCore.disputes(${disputeID}):`);
    console.log(`  courtID:           ${d.courtID}`);
    console.log(`  arbitrated:        ${d.arbitrated}`);
    console.log(`  arbitrated==adapter? ${d.arbitrated.toLowerCase() === adapterAddr.toLowerCase() ? "✓ yes" : "✗ MISMATCH"}`);
    console.log(`  lastPeriodChange:  ${new Date(Number(d.lastPeriodChange) * 1000).toISOString()}`);
    console.log(`  nbRounds:          ${d.nbRounds}`);
    console.log(`  currentRound:      ${d.currentRound}`);
    console.log(`  period:            ${d.period} (${periodNames[Number(d.period)] ?? "unknown"})`);
    console.log(`  ruled:             ${d.ruled}`);

    const r = await kleros.currentRuling(disputeID);
    console.log(`\nCurrent ruling: ${r.ruling}  tied=${r.tied}  overridden=${r.overridden}`);
    if (r.ruling === 0n) {
      console.log("  (0 = no ruling yet / pending)");
    } else if (r.ruling === 1n) {
      console.log("  (1 = BuyerWins — adapter will call resolveDispute(_, true))");
    } else if (r.ruling === 2n) {
      console.log("  (2 = SellerWins — adapter will call resolveDispute(_, false))");
    }
  } catch (err) {
    console.log("\nKlerosCore.disputes() call failed — ABI may not match the deployed version.");
    console.log("Raw error:", err);
  }

  // Local mapping
  console.log("\nAdapter local state:");
  console.log(`  orderToDisputeID[${orderId}]: ${await adapter.orderToDisputeID(orderId)}`);
  console.log(`  disputeToOrderID[${disputeID}]: ${await adapter.disputeToOrderID(disputeID)}`);
  console.log(`  pendingRulings[${orderId}]: ${await adapter.pendingRulings(orderId)}`);

  console.log(`\nUI links:`);
  console.log(`  Kleros V2 (find testnet selector top-right):`);
  console.log(`    https://v2.kleros.builders/#/cases/${disputeID}`);
  console.log(`  Arbiscan (KlerosCore contract):`);
  console.log(`    https://sepolia.arbiscan.io/address/${arbitratorAddr}#readContract`);
  console.log(`  Arbiscan (adapter):`);
  console.log(`    https://sepolia.arbiscan.io/address/${adapterAddr}`);

  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
