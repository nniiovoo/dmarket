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
  }
];

for (const target of abiTargets) {
  const artifact = JSON.parse(await readFile(target.artifact, "utf8"));
  const outputPath = path.resolve(target.output);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact.abi, null, 2)}\n`);

  console.log(`Synced ABI: ${target.artifact} -> ${target.output}`);
}
