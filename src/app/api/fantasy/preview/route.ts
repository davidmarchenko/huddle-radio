import { NextResponse } from "next/server";
import { buildFantasyPreview } from "@/server/buildFantasyPreview";
import { createFantasyProvider } from "@/server/showFactories";
import { redactSecret } from "@/server/redactSecret";
import type { FantasyImportPreview } from "@/shared/contracts";

/**
 * Loads a fantasy league + summarizes it for the producer panel's
 * "League import" surface. Returns the league + readiness checks
 * even on partial failure so the UI can show actionable detail
 * instead of a generic error.
 *
 * Query params:
 *   providerMode    - "demo" | "sleeper" | "espn"  (default: demo)
 *   sleeperLeagueId - Sleeper league id (when providerMode=sleeper)
 *   espnLeagueId    - ESPN league id (when providerMode=espn)
 *   espnSeason      - season year (espn)
 *   week            - week number
 */

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const providerMode = (url.searchParams.get("providerMode") as "demo" | "sleeper" | "espn" | null) ?? "demo";
  const sleeperLeagueId = url.searchParams.get("sleeperLeagueId") ?? undefined;
  const espnLeagueId = url.searchParams.get("espnLeagueId") ?? undefined;
  const espnSeason = url.searchParams.get("espnSeason");
  const week = url.searchParams.get("week");

  const provider = createFantasyProvider(providerMode, undefined);
  try {
    const league = await provider.getLeagueState({
      leagueId: providerMode === "espn" ? espnLeagueId : sleeperLeagueId,
      week: week ? Number(week) : undefined,
      season: espnSeason ? Number(espnSeason) : undefined
    });
    return NextResponse.json(buildFantasyPreview(league, providerMode, week ? Number(week) : undefined));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load fantasy league.";
    console.warn(JSON.stringify({ event: "fantasy.preview.failed", providerMode, error: message }));
    // Mirror Fastify's behavior: 200 with a not-ok preview shape
    // so the client renders the readiness panel + error detail
    // without a separate error branch.
    return NextResponse.json({
      ok: false,
      providerMode,
      readiness: [
        {
          id: "league-load",
          label: "League loaded",
          ok: false,
          detail: redactSecret(message)
        }
      ],
      message: redactSecret(message)
    } satisfies FantasyImportPreview);
  }
}
