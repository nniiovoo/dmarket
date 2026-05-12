import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";

export type DappError = {
  title: string;
  message: string;
  tone: "neutral" | "danger" | "warning";
  category: "user-rejected" | "insufficient-funds" | "wrong-network" | "contract-revert" | "unknown";
};

export function decodeDappError(error: unknown): DappError {
  if (error instanceof BaseError) {
    const rejected = error.walk((candidate) => candidate instanceof UserRejectedRequestError);
    if (rejected !== undefined) {
      return {
        title: "Signature rejected",
        message: "You rejected the wallet request. Nothing was submitted.",
        tone: "neutral",
        category: "user-rejected"
      };
    }

    const revert = error.walk((candidate) => candidate instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return {
        title: "Contract rejected the transaction",
        message: revert.reason ?? "The contract reverted without a reason.",
        tone: "danger",
        category: "contract-revert"
      };
    }

    const details = `${error.shortMessage} ${error.details ?? ""}`.toLowerCase();
    if (details.includes("insufficient funds")) {
      return {
        title: "Insufficient funds",
        message: "Your wallet does not have enough testnet funds for this transaction.",
        tone: "warning",
        category: "insufficient-funds"
      };
    }

    if (details.includes("chain") || details.includes("network")) {
      return {
        title: "Wrong network",
        message: error.shortMessage,
        tone: "warning",
        category: "wrong-network"
      };
    }

    return {
      title: "Transaction failed",
      message: error.shortMessage,
      tone: "danger",
      category: "unknown"
    };
  }

  return {
    title: "Unexpected error",
    message: error instanceof Error ? error.message : "Something went wrong.",
    tone: "danger",
    category: "unknown"
  };
}
