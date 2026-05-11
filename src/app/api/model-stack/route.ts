import { NextResponse } from "next/server";
import { buildModelStack } from "@/server/buildModelStack";

/**
 * Snapshot of which models the deploy is configured to use per role
 * (commentary, realtime, multimodal, TTS). Pure config introspection
 * — surfaces in the producer panel as model badges.
 */

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(buildModelStack(), {
    headers: { "Cache-Control": "no-cache" }
  });
}
