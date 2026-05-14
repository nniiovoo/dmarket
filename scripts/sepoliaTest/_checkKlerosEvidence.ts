// Reads Evidence events from Kleros V2's EvidenceModule directly via RPC.
// Bypasses Kleros's subgraph (which is unreliable on testnet) to confirm our
// evidence submissions actually landed on-chain.
//
// Usage:
//   npx hardhat run scripts/sepoliaTest/_checkKlerosEvidence.ts --network arbitrumSepolia

import { network } from "hardhat";

const EVIDENCE_MODULE = "0xA88A9a25cE7f1d8b3941dA3b322Ba91D009E1397";

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const provider = ethers.provider;

  const evidenceModule = new ethers.Contract(
    EVIDENCE_MODULE,
    ["event Evidence(uint256 indexed _externalDisputeID, address indexed _party, string _evidence)"],
    provider
  );

  // Pull only what we know are our txs (to avoid Alchemy's 10-block range cap).
  const ourTxs = [
    "0x767dee906cae9a2f8aed6463484ac271016946919ad78e3f0f6d6b832af65e9a", // buyer
    "0x472d2de19b7e4cbd666ec218a10063842826182ae0055337c85b83bf865ed519"  // seller
  ];

  console.log(`Reading Evidence events from EvidenceModule ${EVIDENCE_MODULE}`);
  console.log(`Checking 2 known tx hashes for emitted Evidence events:\n`);

  for (const txHash of ourTxs) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      console.log(`  ✗ ${txHash}: tx not found`);
      continue;
    }
    console.log(`  tx: ${txHash}`);
    console.log(`     status:    ${receipt.status === 1 ? "success ✓" : "failed ✗"}`);
    console.log(`     block:     ${receipt.blockNumber}`);

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== EVIDENCE_MODULE.toLowerCase()) continue;
      try {
        const parsed = evidenceModule.interface.parseLog(log);
        if (parsed?.name === "Evidence") {
          const externalDisputeID = parsed.args._externalDisputeID as bigint;
          const party = parsed.args._party as string;
          const evidence = parsed.args._evidence as string;
          console.log(`     ✓ Evidence event:`);
          console.log(`         externalDisputeID: ${externalDisputeID}`);
          console.log(`         party:             ${party}`);
          console.log(`         evidence URI:      ${evidence}`);
        }
      } catch {
        // ignore non-matching events
      }
    }
    console.log();
  }

  console.log("If both events show externalDisputeID=33 and your URIs, evidence is on-chain.");
  console.log("The Kleros UI 'loading forever' = their subgraph indexer hasn't caught up");
  console.log("(testnet subgraphs are commonly stale because few users care).");

  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
