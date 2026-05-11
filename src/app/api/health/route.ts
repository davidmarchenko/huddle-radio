import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { getActiveProviders, getHealth } from "@/server/showFactories";

/**
 * Provider health snapshot. Same payload as `/api/diagnostics` but
 * narrower — just the health array + provider summary, no per-feature
 * checks. The producer panel polls this to refresh the health pills
 * without re-running the full diagnostics build.
 */

export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET() {
  const health = await getHealth();
  return NextResponse.json(
    {
      ok: health.every((item) => item.status !== "error"),
      health,
      providers: getActiveProviders(undefined, "demo", config.SPORTS_DATA_PROVIDER)
    },
    { headers: { "Cache-Control": "no-cache" } }
  );
}
