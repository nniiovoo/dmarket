import { NextRequest, NextResponse } from "next/server";

import { isAdmin } from "@/lib/adminAuth";
import { getSession } from "@/lib/auth/siwe";
import { removeEntry } from "@/lib/blacklist";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
): Promise<NextResponse> {
  const session = await getSession();
  if (!isAdmin(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { address } = await params;
  const removed = await removeEntry(address);
  if (!removed) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ removed: true });
}
