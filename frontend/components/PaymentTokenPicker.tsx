"use client";

import { formatUnits } from "viem";

import { getAcceptedTokens, type AcceptedToken } from "@/lib/contractsV3_2";
import { convertEthWeiToToken, MOCK_ETH_TO_MUSD } from "@/lib/payment/tokenAmount";

export { convertEthWeiToToken };

export type PaymentMode =
  | { kind: "native" }
  | { kind: "erc20"; token: AcceptedToken };

type Props = {
  chainId: number | undefined;
  value: PaymentMode;
  onChange: (value: PaymentMode) => void;
  productPriceInWei: bigint;
};

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

