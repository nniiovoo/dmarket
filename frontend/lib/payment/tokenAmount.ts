// Mock-rate ETH → ERC-20 conversion shared between the client picker and
// the server-side draft-order endpoint. Lives outside any "use client"
// module so Next can import it from API routes without bundling React.
//
// TODO: replace with a real oracle in Phase D. 1 ETH = 3000 mUSD is fine
// for testnet demo purposes; the on-chain order amount is whatever the
// buyer commits to, so a stale rate just changes how the UI labels the
// price.

import type { AcceptedToken } from "@/lib/contractsV3_2";

export const MOCK_ETH_TO_MUSD = 3000n;

export function convertEthWeiToToken(priceWei: bigint, token: AcceptedToken): bigint {
  const tokenScaled = priceWei * MOCK_ETH_TO_MUSD;
  if (token.decimals >= 18) {
    return tokenScaled * 10n ** BigInt(token.decimals - 18);
  }
  return tokenScaled / 10n ** BigInt(18 - token.decimals);
}
