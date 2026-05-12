import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const maxBytes = 4 * 1024 * 1024;
const rateLimitWindowMs = 60_000;
const maxUploadsPerWindow = 10;
const uploadHits = new Map<string, { count: number; resetAt: number }>();

type ImgbbResponse = {
  data?: {
    url?: string;
    display_url?: string;
    delete_url?: string;
  };
  error?: {
    message?: string;
  };
  success?: boolean;
};

export async function POST(request: NextRequest) {
  const apiKey = process.env.IMGBB_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "Image upload is not configured. Paste an external image URL instead.", code: "UPLOAD_NOT_CONFIGURED" },
      { status: 503 }
    );
  }

  const rateLimit = checkRateLimit(getClientIp(request));

  if (!rateLimit.ok) {
    return NextResponse.json({ error: "Too many uploads. Please wait a minute and try again." }, { status: 429 });
  }

  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  if (!allowedTypes.has(file.type)) {
    return NextResponse.json({ error: "Use a JPEG, PNG, WebP, or GIF image." }, { status: 400 });
  }

  if (file.size > maxBytes) {
    return NextResponse.json({ error: "Image must be 4 MB or smaller." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const upload = new FormData();
  upload.set("image", buffer.toString("base64"));

  const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
    method: "POST",
    body: upload
  });
  const data = (await response.json()) as ImgbbResponse;

  if (!response.ok || data.success === false) {
    return NextResponse.json(
      { error: data.error?.message ?? "Image host rejected the upload. Try again later or paste an external URL." },
      { status: 502 }
    );
  }

  const url = data.data?.display_url ?? data.data?.url;

  if (!url) {
    return NextResponse.json({ error: "Image host did not return a URL." }, { status: 502 });
  }

  return NextResponse.json({ url, deleteUrl: data.data?.delete_url });
}

function checkRateLimit(ip: string) {
  const now = Date.now();
  const current = uploadHits.get(ip);

  if (!current || current.resetAt <= now) {
    uploadHits.set(ip, { count: 1, resetAt: now + rateLimitWindowMs });
    return { ok: true };
  }

  if (current.count >= maxUploadsPerWindow) {
    return { ok: false };
  }

  current.count += 1;
  return { ok: true };
}

function getClientIp(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}
