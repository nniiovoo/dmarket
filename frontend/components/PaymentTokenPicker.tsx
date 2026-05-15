"use client";

import { formatUnits } from "viem";

import { getAcceptedTokens, type AcceptedToken } from "@/lib/contractsV3_2";

export type PaymentMode =
  | { kind: "native" }
  | { kind: "erc20"; token: AcceptedToken };

type Props = {
  chainId: number | undefined;
  value: PaymentMode;
  onChange: (value: PaymentMode) => void;
  productPriceInWei: bigint;
};

// TODO: replace with real oracle in Phase D. 1 ETH = 3000 mUSD is fine for
// testnet demo purposes; the on-chain order amount is whatever the buyer
// commits to, so a stale rate just changes how the UI labels the price.
const MOCK_ETH_TO_MUSD = 3000n;

export function PaymentTokenPicker({ chainId, value, onChange, productPriceInWei }: Props) {
  const erc20Tokens = getAcceptedTokens(chainId);

  if (erc20Tokens.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs font-medium uppercase text-slate-500">Payment method</p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name="payment-mode"
          checked={value.kind === "native"}
          onChange={() => onChange({ kind: "native" })}
          className="mt-1"
        />
        <span>
          <span className="font-medium text-slate-900">ETH</span>
          <span className="ml-2 text-slate-500">(Native)</span>
        </span>
      </label>
      {erc20Tokens.map((token) => (
        <label key={token.address} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="payment-mode"
            checked={value.kind === "erc20" && value.token.address === token.address}
            onChange={() => onChange({ kind: "erc20", token })}
            className="mt-1"
          />
          <span>
            <span className="font-medium text-slate-900">{token.symbol}</span>
            <span className="ml-2 text-slate-500">({token.label})</span>
            <span className="ml-2 text-slate-600">
              ≈ {formatUnits(convertEthWeiToToken(productPriceInWei, token), token.decimals)} {token.symbol}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

// Convert an ETH-denominated price (in wei, 18 decimals) into the target
// token's smallest unit, using the mock rate. Caller is responsible for
// displaying / submitting this value as the order amount.
export function convertEthWeiToToken(priceWei: bigint, token: AcceptedToken): bigint {
  const tokenScaled = priceWei * MOCK_ETH_TO_MUSD;
  if (token.decimals >= 18) {
    return tokenScaled * 10n ** BigInt(token.decimals - 18);
  }
  return tokenScaled / 10n ** BigInt(18 - token.decimals);
}
