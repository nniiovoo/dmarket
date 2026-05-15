import { NextRequest, NextResponse } from "next/server";

import { isAdmin } from "@/lib/adminAuth";
import { getSession } from "@/lib/auth/siwe";
import { addEntry, BlacklistDuplicateError, listAll } from "@/lib/blacklist";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const session = await getSession();
  if (!isAdmin(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const entries = await listAll();
  return NextResponse.json(entries);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!isAdmin(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { address, reason } = body as Record<string, unknown>;
  if (typeof address !== "string" || typeof reason !== "string") {
    return NextResponse.json({ error: "address and reason are required strings" }, { status: 400 });
  }

  try {
    const entry = await addEntry({ address, reason, addedBy: session!.address });
    return NextResponse.json(entry, { status: 201 });
  } catch (err) {
    if (err instanceof BlacklistDuplicateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
