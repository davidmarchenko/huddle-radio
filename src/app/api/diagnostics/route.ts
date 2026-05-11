import { NextResponse } from "next/server";
import { buildDiagnostics } from "@/server/buildDiagnostics";

/**
 * Provider diagnostics view: returns provider health + per-feature
 * readiness checks for the producer panel. Pure read; safe to call
 * as often as the UI wants.
 */

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sportsDataMode = url.searchParams.get("sportsDataMode") === "espn" ? "espn" : "demo";
  try {
    const diagnostics = await buildDiagnostics(sportsDataMode);
    return NextResponse.json(diagnostics, {
      headers: { "Cache-Control": "no-cache" }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "diagnostics.failed", error: message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
