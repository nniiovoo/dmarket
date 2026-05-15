// Helpers for the unified messenger.
//
// A Conversation row is identified by (chainId, participantA, participantB)
// where the participants are stored in lexicographic order. That way two
// users can never collide on duplicate rows depending on who initiated,
// and the @@unique constraint catches it.

import { randomBytes } from "node:crypto";

import { prisma } from "@/lib/db";

export type ConversationRow = {
  id: string;
  chainId: number;
  participantA: string;
  participantB: string;
  initialProductId: string | null;
  createdAt: Date;
  lastMessageAt: Date;
};

export function lowerAddress(addr: string): string {
  return addr.toLowerCase();
}

// Sort a pair of addresses so the smaller hex string is "A". Used as the
// stable conversation key.
export function canonicalPair(a: string, b: string): [string, string] {
  const x = lowerAddress(a);
  const y = lowerAddress(b);
  return x < y ? [x, y] : [y, x];
}

export function isParticipant(
  conv: { participantA: string; participantB: string },
  address: string
): boolean {
  const lower = lowerAddress(address);
  return lower === conv.participantA || lower === conv.participantB;
}

export function counterpartyOf(
  conv: { participantA: string; participantB: string },
  myAddress: string
): string {
  const lower = lowerAddress(myAddress);
  if (lower === conv.participantA) return conv.participantB;
  if (lower === conv.participantB) return conv.participantA;
  throw new Error("Address is not a participant");
}

export async function getOrCreateConversation(params: {
  chainId: number;
  initiator: string;
  otherParty: string;
  initialProductId?: string;
}): Promise<ConversationRow> {
  if (lowerAddress(params.initiator) === lowerAddress(params.otherParty)) {
    throw new Error("Cannot start a conversation with yourself");
  }
  const [participantA, participantB] = canonicalPair(params.initiator, params.otherParty);
  const existing = await prisma.conversation.findUnique({
    where: {
      chainId_participantA_participantB: {
        chainId: params.chainId,
        participantA,
        participantB
      }
    }
  });
  if (existing) return existing;

  // initialProductId is set only on first creation. Subsequent get-or-create
  // calls with different products don't mutate it — the field is a hint,
  // not part of the conversation identity.
  return prisma.conversation.create({
    data: {
      id: randomBytes(32).toString("base64url"),
      chainId: params.chainId,
      participantA,
      participantB,
      initialProductId: params.initialProductId ?? null
    }
  });
}
