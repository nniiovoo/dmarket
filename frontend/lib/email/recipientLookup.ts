import { prisma } from "@/lib/db";

export async function getEmailForAddress(walletAddress: string) {
  const user = await prisma.user.findUnique({
    where: { walletAddress: walletAddress.toLowerCase() },
    select: { email: true }
  });

  return user?.email ?? null;
}

export function getOwnerEmail() {
  return process.env.PLATFORM_OWNER_EMAIL ?? null;
}
