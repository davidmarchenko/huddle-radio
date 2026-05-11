import { NextResponse } from "next/server";
import { z } from "zod";
import { getDefaultClipStore } from "@/server/clipStore";

/**
 * Vercel-deployable clip upload. Accepts the same body shape as the
 * legacy Fastify route (`/api/clips` on :8787) so the existing client
 * call site doesn't change.
 *
 * In production (BLOB_READ_WRITE_TOKEN set) the store backs onto
 * Vercel Blob and returns the CDN URL directly. Locally it falls
 * through to the file-backed store + a relative URL the legacy
 * Fastify GET serves.
 *
 * Body: { listenerId, commentaryId?, mimeType, audioBase64 }
 * Response: { id, url, mimeType, byteLength }
 */

export const runtime = "nodejs";
// Audio uploads can be ~6MB base64; default Server Action body
// limit is 1MB. Set generously here to match next.config.ts.
export const maxDuration = 30;

const ClipUploadBodySchema = z.object({
  listenerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  commentaryId: z.string().max(256).optional(),
  mimeType: z.string().min(1).max(64).regex(/^[A-Za-z0-9.+/_-]+$/),
  audioBase64: z
    .string()
    .min(1)
    .max(12_000_000) // ~8MB binary after base64 decode
});

export async function POST(request: Request) {
  const startedAt = Date.now();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = ClipUploadBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid clip upload body." },
      { status: 400 }
    );
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(parsed.data.audioBase64, "base64");
  } catch {
    return NextResponse.json({ error: "Invalid base64 audio." }, { status: 400 });
  }
  try {
    const metadata = await getDefaultClipStore().put({
      listenerId: parsed.data.listenerId,
      commentaryId: parsed.data.commentaryId,
      mimeType: parsed.data.mimeType,
      data: buffer
    });
    // Blob-backed store provides its own CDN URL; file-backed store
    // returns no url and we synthesize the legacy Fastify path.
    const url = metadata.url ?? `/api/clips/${metadata.id}`;
    console.log(JSON.stringify({
      event: "clips.upload.ok",
      backend: metadata.url ? "blob" : "file",
      bytes: metadata.byteLength,
      latencyMs: Date.now() - startedAt
    }));
    return NextResponse.json({
      id: metadata.id,
      url,
      mimeType: metadata.mimeType,
      byteLength: metadata.byteLength
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "clips.upload.failed",
      latencyMs: Date.now() - startedAt,
      error: message
    }));
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
