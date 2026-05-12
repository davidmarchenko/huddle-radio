import { NextResponse } from "next/server";
import { fetchMarketSnapshots } from "@/server/marketsProvider";
import { buildPickSlate, parseMarketTitle } from "@/server/picksGenerator";
import { getDefaultSportsGamesCache } from "@/server/sportsGamesCache";
import { demoGameOptions } from "@/server/demoGameOptions";
import { ESPN_SPORTS, type EspnSportPath } from "@/providers/espnSportsDataProvider";
import { parseSportPrefixedGameId } from "@/server/showFactories";
import { fetchPlayerMediaMap, type PlayerMedia } from "@/server/picksLiveStats";
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
    // Fan out markets + roster media in parallel. The roster media
    // doubles as a "who's playing in this game" filter — without it
    // the slate ends up showing whichever player-prop markets are
    // most popular for the sport, not the ones in THIS game.
    const isDemo = gameId.startsWith("demo-");
    const [markets, mediaMap] = await Promise.all([
      fetchMarketSnapshots({ sports: [sport] }),
      isDemo
        ? Promise.resolve(new Map())
        : fetchPlayerMediaMap(gameId, sport, {
            teamAbbreviations: [homeTeam, awayTeam],
            teamLogos: {
              [homeTeam.toLowerCase()]: resolved.homeMeta?.logo,
              [awayTeam.toLowerCase()]: resolved.awayMeta?.logo
            }
          })
    ]);

    // Pre-filter markets to ONLY those whose player is on a roster in
    // this game. We do this BEFORE generating the slate so the
    // diversification logic (one prop per player, max 2 per stat)
    // operates on the right candidate pool. Demo gameIds skip the
    // filter — they fall back to the generator's roster-based synth.
    const relevantMarkets = isDemo
      ? markets
      : markets.filter((market) => playerInGame(market.title, mediaMap, sport));

    const slate = buildPickSlate({
      gameId,
      sport,
      teams: [homeTeam, awayTeam],
      markets: relevantMarkets
    });
    // Now enrich each picked prop with the media we already fetched.
    let enrichedProps = slate.props;
    if (!isDemo && slate.props.length > 0) {
      enrichedProps = slate.props.map((prop) => {
        const media = lookupMedia(mediaMap, prop.playerName);
        const teamMeta = pickTeamMeta(resolved, media?.teamAbbr ?? prop.playerTeam);
        return {
          ...prop,
          playerHeadshot: media?.headshot,
          playerTeamLogo: teamMeta?.logo ?? media?.teamLogo,
          playerTeamColor: teamMeta?.color ?? media?.teamColor,
          playerTeamAltColor: teamMeta?.alternateColor,
          playerPosition: media?.position,
          playerTeam: media?.teamAbbr ?? prop.playerTeam
        };
      });
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
  const cache = getDefaultSportsGamesCache();

  // Sport-prefixed form (the happy path). Look up in that sport's
  // cached scoreboard.
  if (parsed) {
    try {
      const games = await cache.get(parsed.sportPath);
      const matchById = games.find((g) => g.id === gameId);
      const matchByEvent = matchById ?? games.find((g) => g.id.endsWith(`-${parsed.eventId}`));
      if (matchByEvent) {
        return {
          sport: parsed.sportPath.sport,
          homeTeam: matchByEvent.homeTeam,
          awayTeam: matchByEvent.awayTeam,
          homeMeta: matchByEvent.homeMeta,
          awayMeta: matchByEvent.awayMeta
        };
      }
    } catch {
      // Fall through to the unprefixed scan below.
    }
  }

  // Defense-in-depth: callers that hand us a raw ESPN event id (no
  // `${sport}-` prefix) — e.g. an older client cache or a hand-typed
  // URL — should still get a slate. Scan each sport's scoreboard for
  // an id matching the raw or suffix form. First hit wins.
  for (const sportPath of ESPN_SPORTS) {
    try {
      const games = await cache.get(sportPath);
      const match = games.find((g) => g.id === gameId || g.id.endsWith(`-${gameId}`));
      if (match) {
        return {
          sport: sportPath.sport,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          homeMeta: match.homeMeta,
          awayMeta: match.awayMeta
        };
      }
    } catch {
      // Single-sport fetch failure shouldn't poison the scan.
    }
  }
  return undefined;
}

/** Match a team-abbreviation against the resolved game's home/away meta. */
function pickTeamMeta(game: ResolvedGame | undefined, abbr?: string): TeamMeta | undefined {
  if (!game || !abbr) return undefined;
  const target = abbr.toUpperCase();
  if (game.homeTeam.toUpperCase() === target) return game.homeMeta;
  if (game.awayTeam.toUpperCase() === target) return game.awayMeta;
  return undefined;
}

/** Look up a player's media by parsed title fragments (full + last name). */
function lookupMedia(map: Map<string, PlayerMedia>, playerName: string): PlayerMedia | undefined {
  const lower = playerName.toLowerCase().trim();
  return map.get(lower) ?? map.get(lower.split(/\s+/).pop() ?? "");
}

/**
 * True when the market title parses to a player who's on a roster
 * for this game. Used to drop the long tail of "popular NBA prop"
 * markets that aren't for tonight's matchup.
 */
function playerInGame(
  title: string,
  mediaMap: Map<string, PlayerMedia>,
  sport: SportLeague
): boolean {
  if (mediaMap.size === 0) return true; // No roster fetched — don't filter.
  const parsed = parseMarketTitle(title, sport);
  if (!parsed) return false;
  return Boolean(lookupMedia(mediaMap, parsed.playerName));
}
