import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const abiTargets = [
  {
    artifact: "artifacts/contracts/v2/EscrowMarketplace.sol/EscrowMarketplaceV2.json",
    output: "frontend/abi/EscrowMarketplaceV2.json"
  },
  {
    artifact: "artifacts/contracts/v2/EscrowVault.sol/EscrowVault.json",
    output: "frontend/abi/EscrowVault.json"
  },
  {
    artifact: "artifacts/contracts/v3/EscrowMarketplaceV3.sol/EscrowMarketplaceV3.json",
    output: "frontend/abi/EscrowMarketplaceV3.json"
  },
  {
    artifact: "artifacts/contracts/v3/EscrowVaultV3.sol/EscrowVaultV3.json",
    output: "frontend/abi/EscrowVaultV3.json"
  },
  {
    artifact: "artifacts/contracts/v3/EvidenceRegistryV3.sol/EvidenceRegistryV3.json",
    output: "frontend/abi/EvidenceRegistryV3.json"
  },
  {
    artifact: "artifacts/contracts/v3/KlerosV2DisputeAdapter.sol/KlerosV2DisputeAdapter.json",
    output: "frontend/abi/KlerosV2DisputeAdapter.json"
  },
  {
    artifact: "artifacts/contracts/v3_1/EscrowMarketplaceV3_1.sol/EscrowMarketplaceV3_1.json",
    output: "frontend/abi/EscrowMarketplaceV3_1.json"
  },
  {
    artifact: "artifacts/contracts/v3_2/EscrowMarketplaceERC20.sol/EscrowMarketplaceERC20.json",
    output: "frontend/abi/EscrowMarketplaceERC20.json"
  },
  {
    artifact: "artifacts/contracts/v3_2/ReputationRegistry.sol/ReputationRegistry.json",
    output: "frontend/abi/ReputationRegistry.json"
  },
  {
    artifact: "artifacts/contracts/v3_2/KlerosV2DisputeAdapterV3_2.sol/KlerosV2DisputeAdapterV3_2.json",
    output: "frontend/abi/KlerosV2DisputeAdapterV3_2.json"
  }
];

for (const target of abiTargets) {
  const artifact = JSON.parse(await readFile(target.artifact, "utf8"));
  const outputPath = path.resolve(target.output);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact.abi, null, 2)}\n`);

  console.log(`Synced ABI: ${target.artifact} -> ${target.output}`);
}
