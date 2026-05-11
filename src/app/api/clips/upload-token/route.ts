import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

/**
 * Client-direct Vercel Blob upload bridge.
 *
 * Why this exists: serverless Functions on Vercel cap the request
 * body at ~4.5 MB. Our TTS audio clips can run 6–8 MB base64. Going
 * through `POST /api/clips` (server-side upload) breaks for any clip
 * over the cap. With `@vercel/blob/client`'s `upload()`, the browser
 * uploads directly to the Blob CDN via a short-lived signed token
 * minted here, so our Function never touches the bytes.
 *
 * Flow:
 *  1. Client calls upload(name, blob, { handleUploadUrl: "/api/clips/upload-token" })
 *  2. `@vercel/blob/client` POSTs a HandleUploadBody to this route.
 *  3. handleUpload() mints a token scoped to one filename + content
 *     type and returns it.
 *  4. Client uploads directly to Blob and gets back the public URL.
 *  5. Blob calls this route again with the completion event for
 *     logging / hooks (we currently just log).
 *
 * 404 when BLOB_READ_WRITE_TOKEN isn't set so the client can detect
 * "no Blob configured" and fall back to the legacy server POST.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Vercel Blob is not configured on this deploy." },
      { status: 404 }
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // Only allow uploads under clips/<listenerId>/ paths. The
        // client puts the file there; if someone tries to abuse the
        // token endpoint to upload elsewhere we reject up front.
        if (!/^clips\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_.-]+$/.test(pathname)) {
          throw new Error("Invalid clip pathname.");
        }
        return {
          // Audio mime types only; the server contract enforces this
          // for server-uploaded clips and we mirror it here.
          allowedContentTypes: [
            "audio/webm",
            "audio/webm;codecs=opus",
            "audio/ogg",
            "audio/mpeg",
            "audio/mp3",
            "audio/mp4",
            "audio/wav",
            "audio/aac",
            "audio/flac"
          ],
          // 8MB cap mirrors BlobClipStore's server-side check.
          maximumSizeInBytes: 8 * 1024 * 1024,
          // 1h token lifetime — well over a typical upload duration,
          // short enough that a stolen token doesn't stay useful.
          validUntil: Date.now() + 60 * 60 * 1000
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.log(JSON.stringify({
          event: "clips.upload-token.completed",
          url: blob.url,
          pathname: blob.pathname
        }));
      }
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "clips.upload-token.failed", error: message }));
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
