import { NextResponse } from "next/server";
import { getDefaultClipStore } from "@/server/clipStore";

/**
 * Serves a previously archived clip by id.
 *
 * Only meaningful for FileClipStore (local dev / single-instance
 * deploys without Vercel Blob). When BLOB_READ_WRITE_TOKEN is set the
 * default store returns the Blob CDN URL on `metadata.url` and clients
 * fetch the audio directly from the CDN — `read()` returns undefined
 * for that backend, so this handler 404s, which is the right answer:
 * the client never asked for our proxy in the first place.
 */

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const startedAt = Date.now();
  const { id } = await context.params;
  try {
    const result = await getDefaultClipStore().read(id);
    if (!result) {
      console.log(JSON.stringify({
        event: "clips.read.miss",
        id,
        latencyMs: Date.now() - startedAt
      }));
      return NextResponse.json({ error: "Clip not found." }, { status: 404 });
    }
    const { metadata, data } = result;
    console.log(JSON.stringify({
      event: "clips.read.ok",
      id,
      bytes: metadata.byteLength,
      latencyMs: Date.now() - startedAt
    }));
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": metadata.mimeType,
        "Content-Length": String(metadata.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "clips.read.failed",
      id,
      latencyMs: Date.now() - startedAt,
      error: message
    }));
    return NextResponse.json({ error: "Failed to read clip." }, { status: 500 });
  }
}
