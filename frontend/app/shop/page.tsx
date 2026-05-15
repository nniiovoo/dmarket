import type { Metadata } from "next";

import { ShopChatBox } from "@/components/ai/ShopChatBox";

export const metadata: Metadata = {
  title: "ChainUs Shop · AI Assistant",
  description:
    "Search and order from the ChainUs decentralized marketplace through a natural-language AI assistant. Your wallet signs every purchase — the agent never holds keys."
};

export default function ShopPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-6">
      <ShopChatBox />
    </main>
  );
}
