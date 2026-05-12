import { NextResponse } from "next/server";
import { fetchMarketSnapshots } from "@/server/marketsProvider";
import { buildPickSlate } from "@/server/picksGenerator";
import { getDefaultSportsGamesCache } from "@/server/sportsGamesCache";
import { demoGameOptions } from "@/server/demoGameOptions";
import { ESPN_SPORTS, type EspnSportPath } from "@/providers/espnSportsDataProvider";
import { parseSportPrefixedGameId } from "@/server/showFactories";
import { fetchPlayerMediaMap } from "@/server/picksLiveStats";
import type { SportLeague, SportsGameOption, TeamMeta } from "@/shared/contracts";

export const runtime = "nodejs";

/**
 * GET /api/picks/slate?gameId=...
 *
 * Builds a 4-6-prop slate for the requested game by:
 *   1) Resolving sport + teams from the gameId (sport-prefixed for
 *      ESPN ids, or by lookup in the demo list for "demo-*").
 *   2) Fetching player-prop markets for that sport.
 *   3) Filtering + diversifying via picksGenerator.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json({ error: "Missing gameId." }, { status: 400 });
  }

  const resolved = await resolveGame(gameId);
  if (!resolved) {
    return NextResponse.json({ error: "Game not found." }, { status: 404 });
  }
  const { sport, homeTeam, awayTeam } = resolved;

  const startedAt = Date.now();
  try {
    const markets = await fetchMarketSnapshots({ sports: [sport] });
    const slate = buildPickSlate({
      gameId,
      sport,
      teams: [homeTeam, awayTeam],
      markets
    });
    // Enrich with media: player headshots from ESPN's roster section,
    // team logos / colors from the game meta we already have. Demo
    // games skip the ESPN call (no real roster) and rely on the
    // generic fallback in the UI.
    let enrichedProps = slate.props;
    if (!gameId.startsWith("demo-") && slate.props.length > 0) {
      try {
        const mediaMap = await fetchPlayerMediaMap(gameId, sport, {
          teamAbbreviations: [homeTeam, awayTeam],
          teamLogos: {
            [homeTeam.toLowerCase()]: resolved.homeMeta?.logo,
            [awayTeam.toLowerCase()]: resolved.awayMeta?.logo
          }
        });
        enrichedProps = slate.props.map((prop) => {
          const media =
            mediaMap.get(prop.playerName.toLowerCase().trim()) ??
            mediaMap.get(prop.playerName.toLowerCase().split(/\s+/).pop() ?? "");
          const teamMeta = pickTeamMeta(resolved, media?.teamAbbr ?? prop.playerTeam);
          return {
            ...prop,
            playerHeadshot: media?.headshot,
            playerTeamLogo: teamMeta?.logo ?? media?.teamLogo,
            playerTeamColor: teamMeta?.color ?? media?.teamColor,
            playerPosition: media?.position,
            playerTeam: media?.teamAbbr ?? prop.playerTeam
          };
        });
      } catch {
        // Enrichment is best-effort — failures fall back to bare slate.
      }
    }
    console.log(JSON.stringify({
      event: "picks.slate.ok",
      gameId,
      sport,
      props: slate.props.length,
      synthetic: slate.synthetic,
      enriched: enrichedProps.filter((p) => p.playerHeadshot).length,
      latencyMs: Date.now() - startedAt
    }));
    return NextResponse.json(
      { ...slate, props: enrichedProps },
      {
        // Short cache — slate only changes when ESPN's roster does
        // (rarely) or markets shift. Long cache hid the headshot
        // enrichment fix during the last debugging cycle.
        headers: { "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=120" }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "picks.slate.failed",
      gameId,
      latencyMs: Date.now() - startedAt,
      error: message
    }));
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

type ResolvedGame = {
  sport: SportLeague;
  homeTeam: string;
  awayTeam: string;
  homeMeta?: TeamMeta;
  awayMeta?: TeamMeta;
};

async function resolveGame(gameId: string): Promise<ResolvedGame | undefined> {
  if (gameId.startsWith("demo-")) {
    const game = demoGameOptions().find((g: SportsGameOption) => g.id === gameId);
    if (!game) return undefined;
    return {
      sport: game.sport,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      homeMeta: game.homeMeta,
      awayMeta: game.awayMeta
    };
  }
  const parsed = parseSportPrefixedGameId(gameId);
  if (!parsed) return undefined;
  const sportPath: EspnSportPath = parsed.sportPath;
  const cache = getDefaultSportsGamesCache();
  try {
    const games = await cache.get(sportPath);
    const game = games.find((g) => g.id === gameId);
    if (!game) return undefined;
    return {
      sport: sportPath.sport,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      homeMeta: game.homeMeta,
      awayMeta: game.awayMeta
    };
  } catch {
    return undefined;
  }
  // Fallback never used — narrowing keeps tsc happy.
  void ESPN_SPORTS;
}

/** Match a team-abbreviation against the resolved game's home/away meta. */
function pickTeamMeta(game: ResolvedGame | undefined, abbr?: string): TeamMeta | undefined {
  if (!game || !abbr) return undefined;
  const target = abbr.toUpperCase();
  if (game.homeTeam.toUpperCase() === target) return game.homeMeta;
  if (game.awayTeam.toUpperCase() === target) return game.awayMeta;
  return undefined;
}
