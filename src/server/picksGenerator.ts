import type { MarketSnapshot, SportLeague, FantasyRoster } from "../shared/contracts";
import type { PickProp, PickSlate, PickStatType } from "../shared/picksContracts";

/**
 * Build a balanced PickSlate for a single game from the market firehose
 * + (optionally) a fantasy roster as synthetic backstop.
 *
 * Strategy:
 *   1) Filter incoming markets to player-prop kind matching this game.
 *   2) Parse each title for { player, statType, line }. Drop unparseable.
 *   3) De-dup by (player, statType) keeping the best-priced source.
 *   4) Diversify: at most 1 prop per player and 2 per stat-type.
 *   5) If we still have <4, synthesize from the listener's roster (when
 *      a sport-template applies) so the slate is always playable.
 *
 * Returns up to `maxPicks` props (default 6 = the PrizePicks max).
 */

type GenerateOptions = {
  gameId: string;
  sport: SportLeague;
  /** Pro-team abbreviations actually playing in this game. Synthetic picks only fire for rostered players on these teams. */
  teams: string[];
  markets: MarketSnapshot[];
  /** Optional fantasy roster — used for synthetic backfill when real markets are sparse. */
  rosterStarters?: FantasyRoster["starters"];
  maxPicks?: number;
};

export function buildPickSlate(options: GenerateOptions): PickSlate {
  const max = Math.min(options.maxPicks ?? 6, 6);

  const playerPropMarkets = options.markets.filter(
    (market) => market.marketKind === "player-prop" && (market.gameId ? market.gameId === options.gameId : true)
  );

  const parsed: PickProp[] = [];
  for (const market of playerPropMarkets) {
    const fromTitle = parseMarketTitle(market.title, options.sport);
    if (!fromTitle) continue;
    parsed.push({
      id: stableId(market.source, market.externalId, fromTitle.statType),
      gameId: options.gameId,
      sport: options.sport,
      playerName: fromTitle.playerName,
      playerTeam: matchTeamForPlayer(fromTitle.playerName, options.rosterStarters, options.teams),
      statType: fromTitle.statType,
      line: fromTitle.line,
      source: market.source,
      rawTitle: market.title
    });
  }

  const diversified = diversify(parsed, max);
  let synthetic = false;

  if (diversified.length < Math.min(4, max) && options.rosterStarters?.length) {
    const synth = synthesizeFromRoster({
      gameId: options.gameId,
      sport: options.sport,
      teams: options.teams,
      starters: options.rosterStarters,
      excludePlayers: new Set(diversified.map((pick) => pick.playerName.toLowerCase()))
    });
    const merged = diversify([...diversified, ...synth], max);
    if (merged.length > diversified.length) synthetic = true;
    return {
      gameId: options.gameId,
      sport: options.sport,
      generatedAt: new Date().toISOString(),
      props: merged,
      synthetic
    };
  }

  return {
    gameId: options.gameId,
    sport: options.sport,
    generatedAt: new Date().toISOString(),
    props: diversified,
    synthetic
  };
}

// ---------------- Title parsing ----------------

type ParsedProp = {
  playerName: string;
  statType: PickStatType;
  line: number;
};

/**
 * Stat keyword table. The order matters when multiple keywords would
 * match — more-specific ones come first (e.g. "passing TDs" before
 * "TDs", which is ambiguous between passing/rushing/receiving).
 *
 * Each entry: regex matching the stat phrase, the canonical statType,
 * and the sports it applies to (for guarding against cross-sport
 * collisions, e.g. NBA "points" vs NFL "fantasy points").
 */
const STAT_PATTERNS: Array<{
  pattern: RegExp;
  statType: PickStatType;
  sports: SportLeague[];
}> = [
  // Football — order matters
  { pattern: /\bpassing\s+(?:tds|touchdowns)\b|\bpass\s+tds\b/i, statType: "passing-tds", sports: ["nfl", "ncaaf"] },
  { pattern: /\b(?:passing\s+yards|pass\s+y(?:ar)?ds|throw\s+for)\b/i, statType: "passing-yards", sports: ["nfl", "ncaaf"] },
  { pattern: /\b(?:rushing\s+yards|rush\s+y(?:ar)?ds|rush\s+for)\b/i, statType: "rushing-yards", sports: ["nfl", "ncaaf"] },
  { pattern: /\b(?:receiving\s+yards|rec(?:eiving)?\s+y(?:ar)?ds|catch\s+for)\b/i, statType: "receiving-yards", sports: ["nfl", "ncaaf"] },
  { pattern: /\breceptions\b|\bcatches\b/i, statType: "receptions", sports: ["nfl", "ncaaf"] },

  // Basketball
  { pattern: /\b(?:pra|p\+r\+a|pts\+reb\+ast|points\s*\+\s*rebounds\s*\+\s*assists)\b/i, statType: "pra", sports: ["nba", "wnba", "ncaab"] },
  { pattern: /\b(?:3-?pointers|threes|3pm|made\s+threes|3pt\s+made)\b/i, statType: "threes", sports: ["nba", "wnba", "ncaab"] },
  { pattern: /\bassists\b|\basts\b/i, statType: "assists", sports: ["nba", "wnba", "ncaab"] },
  { pattern: /\brebounds\b|\bboards\b|\breb(?!ounding)\b/i, statType: "rebounds", sports: ["nba", "wnba", "ncaab"] },
  { pattern: /\bpoints\b|\bpts\b/i, statType: "points", sports: ["nba", "wnba", "ncaab"] },

  // Baseball
  { pattern: /\b(?:home\s+runs?|hrs?)\b/i, statType: "home-runs", sports: ["mlb"] },
  { pattern: /\btotal\s+bases\b|\btb\b/i, statType: "total-bases", sports: ["mlb"] },
  { pattern: /\bstrikeouts\b|\bk\'?s\b/i, statType: "strikeouts-pitcher", sports: ["mlb"] },
  { pattern: /\bhits\b/i, statType: "hits", sports: ["mlb"] },

  // Hockey
  { pattern: /\b(?:shots\s+on\s+goal|sog|shots)\b/i, statType: "shots-on-goal", sports: ["nhl"] },
  { pattern: /\bgoals?\b/i, statType: "goals", sports: ["nhl"] }
];

const NUMBER_NEAR_STAT_RE = /(\d{1,3}(?:\.\d)?)\s*\+?/;

export function parseMarketTitle(title: string, sport: SportLeague): ParsedProp | null {
  if (!title) return null;
  const cleanTitle = title.replace(/[?!]/g, " ").replace(/\s+/g, " ").trim();

  // Find the first stat pattern that matches AND is sport-applicable.
  let matched: { statType: PickStatType; index: number; length: number } | null = null;
  for (const entry of STAT_PATTERNS) {
    if (!entry.sports.includes(sport)) continue;
    const m = entry.pattern.exec(cleanTitle);
    if (m) {
      matched = { statType: entry.statType, index: m.index, length: m[0].length };
      break;
    }
  }
  if (!matched) return null;

  // Extract a number anywhere within ±40 chars of the stat keyword.
  // "Mahomes throw for over 250.5 yards" — the number is right before
  // the stat. "Will Mahomes pass for 300+ yards?" — same.
  const window = cleanTitle.slice(
    Math.max(0, matched.index - 40),
    Math.min(cleanTitle.length, matched.index + matched.length + 20)
  );
  const numMatch = NUMBER_NEAR_STAT_RE.exec(window);
  if (!numMatch) return null;
  const raw = Number.parseFloat(numMatch[1]!);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  // Force a .5 line so picks never push. "300" becomes "299.5", "0"
  // is rejected above.
  const line = Number.isInteger(raw) ? raw - 0.5 : raw;

  // Player name: capitalized run before the stat keyword. Strip
  // leading "Will" / "Does" / etc. Take the longest run of capitalized
  // tokens that's not a generic word.
  const beforeStat = cleanTitle.slice(0, matched.index).trim();
  const playerName = extractPlayerName(beforeStat);
  if (!playerName) return null;

  return { playerName, statType: matched.statType, line };
}

const NAME_LEAD_STOPWORDS = new Set([
  "Will", "Does", "Has", "Have", "Can", "Should", "Did", "Is", "Are", "The",
  "Yes", "No", "Over", "Under", "More", "Less", "Record", "Score", "Throw",
  "Pass", "Rush", "Catch", "Grab", "Haul", "Hit", "Drive", "Pitch",
  "By", "For", "In", "Of", "On", "At", "To", "From", "Vs", "And", "Or",
  "End", "First", "Last", "Game", "Match", "Tonight", "Today", "Week"
]);

function extractPlayerName(beforeStat: string): string | null {
  // Tokenize by whitespace, walk right-to-left collecting capitalized
  // tokens — that's the player name as it appears closest to the stat.
  const tokens = beforeStat.split(/\s+/).filter(Boolean);
  const collected: string[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!;
    const stripped = token.replace(/[.,;:]/g, "");
    if (!stripped) continue;
    const looksCapitalized = /^[A-Z]/.test(stripped);
    const isStopword = NAME_LEAD_STOPWORDS.has(stripped);
    if (looksCapitalized && !isStopword) {
      collected.unshift(stripped);
      continue;
    }
    if (collected.length > 0) break;
  }
  if (collected.length === 0) return null;
  // Reject single-token names that are obviously not players (e.g. "Chiefs").
  if (collected.length === 1 && collected[0]!.length <= 3) return null;
  return collected.join(" ");
}

// ---------------- Diversification ----------------

function diversify(props: PickProp[], max: number): PickProp[] {
  const seenPlayer = new Set<string>();
  const seenStatCount = new Map<PickStatType, number>();
  const out: PickProp[] = [];
  for (const prop of props) {
    const playerKey = prop.playerName.toLowerCase();
    if (seenPlayer.has(playerKey)) continue;
    const statCount = seenStatCount.get(prop.statType) ?? 0;
    if (statCount >= 2) continue;
    seenPlayer.add(playerKey);
    seenStatCount.set(prop.statType, statCount + 1);
    out.push(prop);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------- Synthetic fallback ----------------

type SynthOptions = {
  gameId: string;
  sport: SportLeague;
  teams: string[];
  starters: FantasyRoster["starters"];
  excludePlayers: Set<string>;
};

/**
 * Per-position stat templates we'll synthesize when real markets are
 * sparse. The lines are loose averages — good enough for the demo,
 * not pretending to be a sportsbook. Position is matched
 * case-insensitively.
 */
const SYNTH_TEMPLATES: Record<SportLeague, Array<{ position: RegExp; statType: PickStatType; line: number }>> = {
  nfl: [
    { position: /^QB$/i, statType: "passing-yards", line: 244.5 },
    { position: /^QB$/i, statType: "passing-tds", line: 1.5 },
    { position: /^RB$/i, statType: "rushing-yards", line: 64.5 },
    { position: /^WR$|^TE$/i, statType: "receiving-yards", line: 49.5 },
    { position: /^WR$|^TE$/i, statType: "receptions", line: 4.5 }
  ],
  ncaaf: [
    { position: /^QB$/i, statType: "passing-yards", line: 234.5 },
    { position: /^RB$/i, statType: "rushing-yards", line: 64.5 }
  ],
  nba: [
    { position: /^PG$|^SG$|^G$/i, statType: "points", line: 18.5 },
    { position: /^PG$|^G$/i, statType: "assists", line: 5.5 },
    { position: /^SF$|^PF$|^F$/i, statType: "points", line: 16.5 },
    { position: /^C$|^PF$/i, statType: "rebounds", line: 7.5 },
    { position: /./, statType: "threes", line: 1.5 }
  ],
  wnba: [
    { position: /./, statType: "points", line: 14.5 },
    { position: /^G$/i, statType: "assists", line: 4.5 }
  ],
  ncaab: [
    { position: /./, statType: "points", line: 13.5 },
    { position: /^G$/i, statType: "assists", line: 3.5 }
  ],
  mlb: [
    { position: /^P$|^SP$/i, statType: "strikeouts-pitcher", line: 5.5 },
    { position: /^OF$|^IF$|^[123]B$|^SS$|^C$|^DH$/i, statType: "hits", line: 0.5 },
    { position: /^OF$|^IF$|^[123]B$|^SS$|^DH$/i, statType: "total-bases", line: 1.5 }
  ],
  nhl: [
    { position: /^C$|^LW$|^RW$|^F$/i, statType: "shots-on-goal", line: 2.5 },
    { position: /^C$|^LW$|^RW$/i, statType: "goals", line: 0.5 }
  ],
  soccer: [],
  other: []
};

function synthesizeFromRoster(opts: SynthOptions): PickProp[] {
  const templates = SYNTH_TEMPLATES[opts.sport] ?? [];
  if (templates.length === 0) return [];
  const eligible = opts.starters.filter((player) => opts.teams.includes(player.proTeam));
  const out: PickProp[] = [];
  for (const player of eligible) {
    if (opts.excludePlayers.has(player.name.toLowerCase())) continue;
    const template = templates.find((entry) => entry.position.test(player.position));
    if (!template) continue;
    out.push({
      id: stableId("synthetic", `${opts.gameId}:${player.id}`, template.statType),
      gameId: opts.gameId,
      sport: opts.sport,
      playerName: player.name,
      playerTeam: player.proTeam,
      statType: template.statType,
      line: template.line,
      source: "synthetic"
    });
  }
  return out;
}

// ---------------- Helpers ----------------

function stableId(source: string, identifier: string, statType: PickStatType): string {
  // Hash-free deterministic id — short enough for URLs / localStorage
  // keys, stable across re-fetches so user selections stay sticky.
  return `${source}:${identifier}:${statType}`.toLowerCase().replace(/[^a-z0-9:.-]+/g, "-");
}

function matchTeamForPlayer(
  playerName: string,
  starters: FantasyRoster["starters"] | undefined,
  teams: string[]
): string | undefined {
  const target = playerName.toLowerCase();
  const hit = starters?.find((player) => player.name.toLowerCase() === target);
  if (hit && teams.includes(hit.proTeam)) return hit.proTeam;
  return undefined;
}
