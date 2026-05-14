import { getCrossChainQuote } from "../lib/lifi";

// Mainnet test: swap 0.0001 ETH on Ethereum mainnet for ETH on Arbitrum.
// Most reliable LI.FI route as a sanity check.
async function main() {
  const quote = await getCrossChainQuote({
    fromChainId: 1,
    fromToken: "0x0000000000000000000000000000000000000000",
    fromAmount: "100000000000000",
    fromAddress: "0x1577E3b310A9cca64C2E0Bf9f0e14aadc3579429",
    toChainId: 42161,
    toToken: "0x0000000000000000000000000000000000000000"
  });

  console.log("Quote:");
  console.log("  from:", quote.fromAmount, quote.fromTokenSymbol, "on chain", quote.fromChainId);
  console.log("  to:  ", quote.toAmount, quote.toTokenSymbol, "on chain", quote.toChainId);
  console.log("  fee USD:", quote.feeCostsUsd);
  console.log("  gas USD:", quote.gasCostsUsd);
  console.log("  ETA: ", quote.estimatedDurationSec, "seconds");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
