// GET /openapi.yaml — public OpenAPI spec for the ChatGPT Actions
// importer (and any other consumer of the AI surface).
//
// The template at `public/openapi.template.yaml` carries
// `${PUBLIC_BASE_URL}` placeholders for the `servers` block and the
// OAuth `authorizationUrl` / `tokenUrl`. We substitute them at request
// time from `NEXT_PUBLIC_APP_ORIGIN` (or the request origin as a
// fallback) so a single committed file works behind ngrok / localhost
// / chainus.org without a re-deploy.
//
// Why `.template.yaml` instead of `openapi.yaml` in `public/`? Next.js
// refuses to register an App-Router route at a path that already
// resolves as a static file in `public/` ("conflicting public file and
// page file"). The dynamic route wins on the URL `/openapi.yaml`; the
// underlying file is renamed so the static handler doesn't claim it.
//
// Public endpoint — no auth. ChatGPT imports this URL before the user
// has any token, and the file contains no secrets. The OAuth client_id
// the GPT will use is configured in the Custom GPT settings, not here.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const yamlPath = join(process.cwd(), "public", "openapi.template.yaml");
  const raw = await readFile(yamlPath, "utf8");
  const baseUrl = process.env.NEXT_PUBLIC_APP_ORIGIN ?? request.nextUrl.origin;
  const body = raw.replace(/\$\{PUBLIC_BASE_URL\}/g, baseUrl);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/yaml; charset=utf-8",
      "cache-control": "public, max-age=60"
    }
  });
}
