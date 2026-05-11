import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MediaCacheManifest } from "@/shared/mediaManifest";

/**
 * Serves the media-cache manifest the local `npm run media:cache`
 * script writes to `public/media-cache/manifest.json`.
 *
 * Why a route instead of letting the browser fetch the static file
 * directly: that file is gitignored (it's user-machine-specific —
 * absolute paths, license-gated assets) and so it doesn't reach
 * Vercel deploys. Without this route, the static fetch 404s in the
 * browser console on every page load. Wrapping it in a route lets
 * Vercel return a clean empty manifest with a 200, while local dev
 * still serves whatever the user has cached.
 */

export const runtime = "nodejs";

const EMPTY_MANIFEST: MediaCacheManifest = {
  generatedAt: "1970-01-01T00:00:00.000Z",
  outDir: "public/media-cache",
  counts: {},
  assets: []
};

export async function GET() {
  const manifestPath = path.join(process.cwd(), "public", "media-cache", "manifest.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as MediaCacheManifest;
    return NextResponse.json(manifest, {
      headers: { "Cache-Control": "no-cache" }
    });
  } catch {
    // Missing or unreadable manifest is the expected case on a fresh
    // Vercel deploy (the cache is local-dev-only). Return the empty
    // shape so the client can render its "no cache loaded" state
    // without the browser logging a network 404.
    return NextResponse.json(EMPTY_MANIFEST, {
      headers: { "Cache-Control": "no-cache" }
    });
  }
}
