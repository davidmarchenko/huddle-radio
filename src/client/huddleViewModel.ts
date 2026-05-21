import type { FantasyImpact, FantasyLeagueState, FantasyMatchup, FantasyPlayer, FantasyRoster, GroupSettings, HostId, LivecastCommentary, SportsGameOption, SportsGameState, SportsPlay, VideoMode } from "../shared/contracts";
import { formatPeriodLabel } from "../shared/period";

export type HuddlePhase = "empty" | "pregame" | "live" | "live-audio" | "recap";

export type HuddleHost = {
  id: "maya" | "theo" | "cam";
  name: string;
  role: "Analyst" | "Fan" | "Wildcard";
  accent: "violet" | "orange" | "gold";
  description: string;
  /** URL of the host headshot served from /public. Optional so the
   *  initials-only fallback still works when art isn't available. */
  avatar?: string;
};

export type HuddleHostTurn = {
  id: string;
  /** Lead speaker (first line's host). Drives accent + the
   *  single-line fallback rendering. */
  host: HuddleHost;
  /** Joined / shortened text. Kept for back-compat and as the
   *  fallback render when `lines` is absent. */
  text: string;
  eyebrow: string;
  time?: string;
  /** Per-speaker breakdown for multi-host turns. Populated only when
   *  the underlying commentary had >1 dialogue line — single-host
   *  turns leave this undefined so the renderer keeps the simpler
   *  single-block layout. Each entry is the line as-emitted by the
   *  engine (no per-line truncation; the engine prompts already cap
   *  turn length at 30-60 words). */
  lines?: Array<{ host: HuddleHost; text: string }>;
};

export type HuddleSetupStep = {
  id: "fantasy" | "game" | "stream" | "hosts";
  title: string;
  body: string;
  action: string;
  state: "ready" | "next" | "optional";
};

export type MatchupStory = {
  leader?: string;
  trailer?: string;
  margin: number;
  line: string;
};

export type RecapSummary = {
  title: string;
  subtitle: string;
  turningPoint: string;
  hostMoment: string;
  /** Which host delivered the best moment — undefined when commentary
   *  is empty (recap shouldn't render in that state, but defensive).
   *  Lets the UI attribute the quote ("Cam: …") instead of showing it
   *  anonymously. */
  hostMomentSpeaker?: HostId;
  matchupShift: string;
};

export type ListenerStakes = {
  listenerName: string;
  teamName?: string;
  ownerName?: string;
  startersInGame: FantasyPlayer[];
  swingPlayer?: { name: string; projectedPoints: number; proTeam: string };
  opponent?: { ownerName: string; teamName: string };
  margin: number;
  stakesLine: string;
  status: "no-listener" | "no-roster" | "ready";
};

export type ListenerGameSpotlight = {
  gameId: string;
  starters: FantasyPlayer[];
  topStarter?: FantasyPlayer;
};

export type FriendMatchup = {
  friendId: string;
  friendName: string;
  favoriteTeam: string;
  teamName: string;
  ownerName: string;
  // Friend's matchup opponent in the same league.
  opponentTeamName?: string;
  opponentOwnerName?: string;
  // Positive = friend leading, negative = friend trailing.
  margin: number;
  // Convenience copy for the UI so callers don't all reformat.
  stakeLine: string;
  // Which sport's league this matchup came from.
  sport: FantasyLeagueState["sport"];
};

export type ListenerRecapHighlight = {
  kind: "win" | "loss";
  playerName: string;
  pointsDelta: number;
  hostText: string;
  hostId?: string;
  playHeadline: string;
  reason: string;
  /** ID of the commentary that captured this moment — used for clip archival. */
  commentaryId?: string;
};

export type TonightAtAGlance = {
  listenerName: string;
  perSport: Array<{
    sport: FantasyLeagueState["sport"];
    leagueName: string;
    teamName: string;
    opponentTeamName?: string;
    opponentOwnerName?: string;
    margin: number;
    startersInPlayCount: number;
    totalStartersProjected: number;
    topSwing?: { id: string; name: string; position: string; proTeam: string; projectedPoints: number };
    suggestedGameId?: string;
    suggestedGameLabel?: string;
  }>;
};

export const HUDDLE_HOSTS: HuddleHost[] = [
  {
    id: "maya",
    name: "Maya",
    role: "Analyst",
    accent: "violet",
    description: "Anchored in the numbers. Gets ragged on for it.",
    avatar: "/Headshots/Maya.png"
  },
  {
    id: "theo",
    name: "Theo",
    role: "Fan",
    accent: "orange",
    description: "Anchor of the booth. Sets up the others, pushes back when it's earned.",
    avatar: "/Headshots/Theo.png"
  },
  {
    id: "cam",
    name: "Cam",
    role: "Wildcard",
    accent: "gold",
    description: "Confident, sharp, and occasionally wrong about it.",
    avatar: "/Headshots/Cam.png"
  }
];

export function deriveHuddlePhase(input: {
  showPrepared: boolean;
  isLive: boolean;
  hasVideoSource: boolean;
  commentaryCount: number;
  gameStatus?: SportsGameState["status"];
  /** When the listener has paused mid-show, keep the live-audio phase
   *  even if the SSE session timed out — they expect to resume into
   *  the same view, not get dumped into recap. */
  isPaused?: boolean;
  /** When the page boots on a /watch/{gameId} URL we hold the
   *  live-audio phase across the brief window between bootstrap and
   *  the user gesture that wakes the audio context. Without this
   *  flag, phase=empty fires showHome and the listener lands back on
   *  discover after a refresh. */
  awaitingResume?: boolean;
}): HuddlePhase {
  if (input.isLive) return input.hasVideoSource ? "live" : "live-audio";
  if (input.isPaused && input.commentaryCount > 0) {
    return input.hasVideoSource ? "live" : "live-audio";
  }
  if (input.awaitingResume) {
    return input.hasVideoSource ? "live" : "live-audio";
  }
  if (!input.showPrepared && input.commentaryCount === 0) return "empty";
  if (input.commentaryCount > 0 || input.gameStatus === "final") return "recap";
  if (input.showPrepared) return "pregame";
  return "empty";
}

export function buildSetupSteps(input: {
  providerMode: "demo" | "sleeper" | "espn";
  sportsDataMode: "demo" | "espn";
  hasVideoSource: boolean;
  friendCount: number;
}): HuddleSetupStep[] {
  return [
    {
      id: "fantasy",
      title: "Connect your fantasy",
      body: input.providerMode === "demo" ? "Try a demo league now, or connect ESPN/Sleeper when you are ready." : `${input.providerMode.toUpperCase()} is selected for the room.`,
      action: input.providerMode === "demo" ? "Connect fantasy account" : "Fantasy connected",
      state: input.providerMode === "demo" ? "next" : "ready"
    },
    {
      id: "game",
      title: "Choose what you are watching",
      body: input.sportsDataMode === "espn" ? "ESPN scoreboard is ready to follow real game state." : "Demo play-by-play can rehearse the show without credentials.",
      action: input.sportsDataMode === "espn" ? "Game feed ready" : "Select game or stream",
      state: input.providerMode === "demo" ? "optional" : input.sportsDataMode === "espn" ? "ready" : "next"
    },
    {
      id: "stream",
      title: "Add the broadcast",
      body: "Use screen share for ESPN, YouTube TV, cable apps, or anything behind a login.",
      action: input.hasVideoSource ? "Stream added" : "Add stream",
      state: input.hasVideoSource ? "ready" : "optional"
    },
    {
      id: "hosts",
      title: "Meet your hosts",
      body: "Maya, Theo, and Cam adapt to your league, friends, and fantasy stakes.",
      action: input.friendCount ? "Hosts ready" : "Add friends",
      state: input.friendCount ? "ready" : "next"
    }
  ];
}

export function buildHostTurns(input: { commentary: LivecastCommentary[]; game?: SportsGameState; group: GroupSettings }): HuddleHostTurn[] {
  if (input.commentary.length > 0) {
    return input.commentary.slice(0, 5).map((item, index) => {
      // Use server-assigned hostId. Fall back to round-robin only for
      // legacy commentary missing the field (older sessions, snapshots).
      const host = HUDDLE_HOSTS.find((h) => h.id === item.hostId) ?? HUDDLE_HOSTS[index % HUDDLE_HOSTS.length];
      const isOpener = item.kind === "opener";
      // Resolve every line's host to a HuddleHost. Lines without a
      // recognized hostId fall back to the turn's lead host, same
      // pattern as legacy fallback above. Filter out empty texts —
      // they'd render as empty avatar blocks with no content.
      const lineEntries = (item.lines ?? [])
        .map((line) => ({
          host: HUDDLE_HOSTS.find((h) => h.id === line.hostId) ?? host,
          text: stripMarkdown(line.text).trim()
        }))
        .filter((line) => line.text.length > 0);
      return {
        id: item.id,
        host,
        // Opener gets to breathe — let it run longer than per-play turns.
        text: shorten(stripMarkdown(item.text), isOpener ? 360 : 150),
        eyebrow: isOpener ? "On air" : item.moment.priority,
        time: isOpener ? undefined : `${formatPeriodLabel(item.play.period)} ${item.play.clock}`,
        // Only attach `lines` when the turn actually had multiple
        // speakers — single-speaker turns keep the existing simpler
        // single-block render via `host` + `text`.
        lines: lineEntries.length > 1 ? lineEntries : undefined
      };
    });
  }
  const matchup = input.game ? `${input.game.awayTeam} at ${input.game.homeTeam}` : "tonight's game";
  const names = input.group.friends.slice(0, 2).map((friend) => friend.name).join(" and ") || "the room";
  return [
    {
      id: "pregame-maya",
      host: HUDDLE_HOSTS[0],
      eyebrow: "Pregame",
      text: `${matchup} is set. I am watching the matchup math and where the fantasy pressure starts.`
    },
    {
      id: "pregame-theo",
      host: HUDDLE_HOSTS[1],
      eyebrow: "Pregame",
      text: `${names} are going to know pretty quickly whether this is a calm night or a group-chat emergency.`
    },
    {
      id: "pregame-cam",
      host: HUDDLE_HOSTS[2],
      eyebrow: "Pregame",
      text: "Somebody is about to call this a must-win in Week 7, and honestly, I respect the drama."
    }
  ];
}

export function buildMatchupStory(league?: FantasyLeagueState): MatchupStory {
  const rosters = league?.matchups[0]?.rosters ?? [];
  const totals = rosters
    .map((roster) => ({
      owner: roster.ownerName,
      points: roster.starters.reduce((sum, player) => sum + player.currentPoints, 0)
    }))
    .sort((left, right) => right.points - left.points);
  const leader = totals[0];
  const trailer = totals[totals.length - 1];
  const margin = leader && trailer && leader.owner !== trailer.owner ? Number(Math.abs(leader.points - trailer.points).toFixed(1)) : 0;
  return {
    leader: leader?.owner,
    trailer: trailer?.owner,
    margin,
    line: leader && trailer && leader.owner !== trailer.owner ? `${leader.owner} leads ${trailer.owner} by ${margin}.` : "The matchup is waiting for its first real swing."
  };
}

export function buildFantasySpotlight(input: { impacts: FantasyImpact[]; league?: FantasyLeagueState; game?: SportsGameState }) {
  const impact = input.impacts[0];
  if (impact) {
    return {
      title: `${impact.playerName} ${impact.pointsDelta > 0 ? "+" : ""}${impact.pointsDelta}`,
      body: `${impact.ownerName} feels this one. ${impact.reason}`,
      owner: impact.ownerName
    };
  }
  const allStarters = input.league?.matchups[0]?.rosters.flatMap((roster) => roster.starters.map((starter) => ({ ...starter, ownerName: roster.ownerName }))) ?? [];
  // Only highlight a fantasy player when their pro team is actually in the
  // game on screen — otherwise the spotlight ("Mahomes is the fantasy
  // spotlight") shows up on broadcasts where Mahomes isn't even playing.
  const teamsInGame = input.game ? new Set([input.game.awayTeam, input.game.homeTeam]) : undefined;
  const eligible = teamsInGame
    ? allStarters.filter((starter) => teamsInGame.has(starter.proTeam))
    : allStarters;
  const player = eligible.sort((a, b) => b.currentPoints - a.currentPoints)[0];
  if (player) {
    return {
      title: `${player.name} is the fantasy spotlight`,
      body: `${player.ownerName} has ${player.currentPoints.toFixed(1)} points from ${player.proTeam}.`,
      owner: player.ownerName
    };
  }
  if (input.game && allStarters.length > 0) {
    return {
      title: `${input.game.awayTeam} at ${input.game.homeTeam}`,
      body: "No one in your league has skin in this game — it's pure entertainment.",
      owner: undefined
    };
  }
  return {
    title: "Waiting for the first swing",
    body: "The hosts will light this up once the first meaningful play lands.",
    owner: undefined
  };
}

/** Rank by moment.priority first (interrupt > major > notable > routine),
 *  then by score, then by text length (a substantive turn beats a
 *  one-liner). Used to pick the "best" turn for the recap so the
 *  hero / host-moment cards quote the most memorable beat instead of
 *  whichever turn happened to be first in the array. */
const PRIORITY_RANK: Record<string, number> = {
  interrupt: 4,
  major: 3,
  notable: 2,
  routine: 1
};
function rankTurn(turn: LivecastCommentary): number {
  const p = PRIORITY_RANK[turn.moment?.priority ?? "routine"] ?? 1;
  const score = turn.moment?.score ?? 0;
  const length = turn.text?.length ?? 0;
  // priority dominates; score is a tiebreaker; length nudges between
  // two equal-priority turns toward the meatier paragraph.
  return p * 10_000 + score * 100 + Math.min(length, 600);
}

export function buildRecapSummary(input: { commentary: LivecastCommentary[]; game?: SportsGameState; league?: FantasyLeagueState }): RecapSummary {
  const matchup = buildMatchupStory(input.league);
  const gameLabel = input.game ? `${input.game.awayTeam} vs ${input.game.homeTeam}` : "The show";
  // Pick the highest-ranked turn for the host-moment + title.
  // Falling back to commentary[0] (whichever was newest) meant the
  // recap always quoted the most-recent tick, often a low-impact
  // turn or — worse — the welcome opener.
  const best = [...input.commentary].sort((a, b) => rankTurn(b) - rankTurn(a))[0];
  const headline = best?.moment.headline?.trim();
  // Treat very short / generic moment.headlines ("pass update",
  // "play", "tick") as not useful for the title — fall back to the
  // game label so the listener doesn't read 'pass update became the
  // story'.
  const useHeadlineForTitle = Boolean(headline) && headline!.length >= 12;
  return {
    title: useHeadlineForTitle ? `${headline} became the story` : `${gameLabel} recap`,
    subtitle: input.game ? `${input.game.awayTeam} ${input.game.currentPlay?.score.away ?? 0}, ${input.game.homeTeam} ${input.game.currentPlay?.score.home ?? 0}` : "Your personalized postgame show is ready.",
    turningPoint: best?.play.headline ?? "The first big fantasy swing defined the night.",
    hostMoment: best?.text ? shorten(best.text, 140) : "The hosts kept the room oriented around the stakes.",
    hostMomentSpeaker: best?.hostId,
    matchupShift: matchup.line
  };
}

/**
 * Recap "Show stats" card content. Goes a bit beyond "X calls" so the
 * listener can see who carried the show and how long it ran — turns
 * the card from a single-line bullet into a real summary line.
 *
 * Inputs:
 *  - commentary: every host turn that landed during the show (already
 *    filtered to this show).
 *  - hosts: HUDDLE_HOSTS in display order (Maya, Theo, Cam). Used to
 *    drive the "led with X turns" callout and ensure label order
 *    matches the rest of the UI.
 *
 * Output: up to 4 lines suitable for StorylineCard. Empty strings are
 * dropped by the card itself.
 */
export function buildShowStatsLines(
  commentary: LivecastCommentary[],
  hosts: HuddleHost[]
): string[] {
  const lines: string[] = [];
  const turnCount = commentary.length;
  if (turnCount === 0) {
    // Recap shouldn't render in this state, but if it does we want a
    // graceful single-line fallback instead of "0 calls."
    return ["No calls landed during this show."];
  }
  // Sort by createdAt so we can read duration off first/last regardless
  // of array order. Source `commentary` from main.tsx is reverse-
  // chronological in some surfaces, chronological in others — sorting
  // here means the helper is robust to either.
  const timestamps = commentary
    .map((c) => Date.parse(c.createdAt))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const spanMs =
    timestamps.length >= 2 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
  const spanMin = Math.max(1, Math.round(spanMs / 60000));

  if (spanMs > 0) {
    lines.push(
      `${turnCount} ${turnCount === 1 ? "call" : "calls"} across ${spanMin} ${spanMin === 1 ? "minute" : "minutes"} of show.`
    );
  } else {
    lines.push(`${turnCount} ${turnCount === 1 ? "call" : "calls"} in this show.`);
  }

  // Host turn distribution — count by primary hostId on each turn.
  // Multi-speaker turns are still attributed to the lead so the totals
  // sum to turnCount (not to the dialogue-line count).
  const counts = new Map<string, number>();
  for (const c of commentary) {
    counts.set(c.hostId, (counts.get(c.hostId) ?? 0) + 1);
  }
  // Sort hosts by turn count desc, then by display order to break ties.
  const ranked = hosts
    .map((h) => ({ host: h, count: counts.get(h.id) ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
  if (ranked.length >= 2) {
    const lead = ranked[0];
    const rest = ranked
      .slice(1)
      .map((entry) => `${entry.host.name} ${entry.count}`)
      .join(", ");
    lines.push(
      `${lead.host.name} led with ${lead.count} ${lead.count === 1 ? "turn" : "turns"} — ${rest}.`
    );
  }

  return lines;
}

export function buildListenerStakes(input: {
  group: GroupSettings;
  leagues: FantasyLeagueState[];
  game?: SportsGameState;
}): ListenerStakes | undefined {
  const listener = input.group.listener;
  if (!listener?.name) return undefined;
  // Multi-sport: pick the league matching the current game's sport.
  // Fall back to the first connected league when no game is selected.
  const league = pickLeagueForSport(input.leagues, input.game?.sport);

  let listenerRoster: FantasyRoster | undefined;
  let listenerMatchup: FantasyMatchup | undefined;
  for (const matchup of league?.matchups ?? []) {
    const found = matchup.rosters.find((roster) =>
      listener.rosterId
        ? roster.id === listener.rosterId
        : roster.ownerName.toLowerCase() === listener.name.toLowerCase()
    );
    if (found) {
      listenerRoster = found;
      listenerMatchup = matchup;
      break;
    }
  }

  if (!listenerRoster) {
    const sportLabel = input.game ? sportNoun(input.game.sport) : "fantasy";
    return {
      listenerName: listener.name,
      startersInGame: [],
      margin: 0,
      stakesLine: league
        ? `Connect your ${sportLabel} league so the hosts can read your roster.`
        : `No ${sportLabel} league connected — running on the room's default takes.`,
      status: "no-roster"
    };
  }

  const opponent = listenerMatchup?.rosters.find((roster) => roster.id !== listenerRoster!.id);
  const teamsInGame = input.game ? new Set([input.game.awayTeam, input.game.homeTeam]) : undefined;
  const startersInGame = teamsInGame
    ? listenerRoster.starters.filter((starter) => teamsInGame.has(starter.proTeam))
    : [];
  const swingCandidate = startersInGame.length
    ? [...startersInGame].sort((left, right) => right.projectedPoints - left.projectedPoints)[0]
    : undefined;
  const listenerTotal = listenerRoster.starters.reduce((sum, player) => sum + player.currentPoints, 0);
  const opponentTotal = opponent?.starters.reduce((sum, player) => sum + player.currentPoints, 0) ?? 0;
  const margin = Number((listenerTotal - opponentTotal).toFixed(1));

  let stakesLine: string;
  if (!opponent) {
    stakesLine = swingCandidate
      ? `${swingCandidate.name} is your big swing tonight.`
      : "Your starters are warming up.";
  } else if (margin > 0.05) {
    stakesLine = swingCandidate
      ? `Up ${margin.toFixed(1)} on ${opponent.ownerName} — ${swingCandidate.name} can put it away.`
      : `Up ${margin.toFixed(1)} on ${opponent.ownerName} — protect the lead.`;
  } else if (margin < -0.05) {
    stakesLine = swingCandidate
      ? `Down ${Math.abs(margin).toFixed(1)} to ${opponent.ownerName} — ${swingCandidate.name} is your shot.`
      : `Down ${Math.abs(margin).toFixed(1)} to ${opponent.ownerName} — bench needs to wake up.`;
  } else {
    stakesLine = `Dead even with ${opponent.ownerName}.`;
  }

  return {
    listenerName: listener.name,
    teamName: listenerRoster.teamName,
    ownerName: listenerRoster.ownerName,
    startersInGame,
    swingPlayer: swingCandidate
      ? { name: swingCandidate.name, projectedPoints: swingCandidate.projectedPoints, proTeam: swingCandidate.proTeam }
      : undefined,
    opponent: opponent ? { ownerName: opponent.ownerName, teamName: opponent.teamName } : undefined,
    margin,
    stakesLine,
    status: "ready"
  };
}

/**
 * Resolve each friend's current fantasy matchup for the active game's
 * sport. Surfaces a compact "Friend stakes" view so the listener sees
 * what the room cares about, not just their own roster.
 *
 * Friends without a roster in the matching league are skipped — we'd
 * rather show fewer entries than render fake stakes.
 */
export function buildFriendMatchups(input: {
  group: GroupSettings;
  leagues: FantasyLeagueState[];
  game?: SportsGameState;
}): FriendMatchup[] {
  const league = pickLeagueForSport(input.leagues, input.game?.sport);
  if (!league) return [];
  const result: FriendMatchup[] = [];
  for (const friend of input.group.friends) {
    let friendRoster: FantasyRoster | undefined;
    let friendMatchup: FantasyMatchup | undefined;
    for (const matchup of league.matchups) {
      const found = matchup.rosters.find((roster) =>
        friend.rosterId
          ? roster.id === friend.rosterId
          : roster.ownerName.toLowerCase() === friend.name.toLowerCase()
      );
      if (found) {
        friendRoster = found;
        friendMatchup = matchup;
        break;
      }
    }
    if (!friendRoster) continue;
    const opponent = friendMatchup?.rosters.find((roster) => roster.id !== friendRoster!.id);
    const friendTotal = friendRoster.starters.reduce((sum, p) => sum + p.currentPoints, 0);
    const opponentTotal = opponent?.starters.reduce((sum, p) => sum + p.currentPoints, 0) ?? 0;
    const margin = Number((friendTotal - opponentTotal).toFixed(1));
    const stakeLine = !opponent
      ? `${friend.name} is solo this week.`
      : margin > 0.05
        ? `${friend.name} up ${margin.toFixed(1)} on ${opponent.ownerName}`
        : margin < -0.05
          ? `${friend.name} down ${Math.abs(margin).toFixed(1)} to ${opponent.ownerName}`
          : `${friend.name} dead even with ${opponent.ownerName}`;
    result.push({
      friendId: friend.id,
      friendName: friend.name,
      favoriteTeam: friend.favoriteTeam,
      teamName: friendRoster.teamName,
      ownerName: friendRoster.ownerName,
      opponentTeamName: opponent?.teamName,
      opponentOwnerName: opponent?.ownerName,
      margin,
      stakeLine,
      sport: league.sport
    });
  }
  result.sort((left, right) => Math.abs(right.margin) - Math.abs(left.margin));
  return result;
}

export function buildTonightAtAGlance(input: {
  group: GroupSettings;
  leagues: FantasyLeagueState[];
  games: SportsGameOption[];
}): TonightAtAGlance | undefined {
  const listener = input.group.listener;
  if (!listener?.name) return undefined;
  const perSport: TonightAtAGlance["perSport"] = [];
  for (const league of input.leagues) {
    const matchup = league.matchups.find((m) =>
      m.rosters.some((r) =>
        listener.rosterId
          ? r.id === listener.rosterId
          : r.ownerName.toLowerCase() === listener.name.toLowerCase()
      )
    );
    if (!matchup) continue;
    const listenerRoster = matchup.rosters.find((r) =>
      listener.rosterId
        ? r.id === listener.rosterId
        : r.ownerName.toLowerCase() === listener.name.toLowerCase()
    );
    if (!listenerRoster) continue;
    const opponent = matchup.rosters.find((r) => r.id !== listenerRoster.id);
    const listenerTotal = listenerRoster.starters.reduce((sum, p) => sum + p.currentPoints, 0);
    const opponentTotal = opponent?.starters.reduce((sum, p) => sum + p.currentPoints, 0) ?? 0;
    // Of the listener's starters, how many are playing in tonight's
    // available games (across the discover feed)?
    const sportGames = input.games.filter((game) => game.sport === league.sport);
    const startersInPlay = listenerRoster.starters.filter((starter) =>
      sportGames.some((game) => game.awayTeam === starter.proTeam || game.homeTeam === starter.proTeam)
    );
    const topSwing = [...startersInPlay].sort((left, right) => right.projectedPoints - left.projectedPoints)[0];
    // Suggested game = whichever sport's game contains the highest-
    // projected starter. Falls back to the first game with any starter.
    const suggested = topSwing
      ? sportGames.find((game) => game.awayTeam === topSwing.proTeam || game.homeTeam === topSwing.proTeam)
      : sportGames.find((game) => listenerRoster.starters.some((s) => s.proTeam === game.awayTeam || s.proTeam === game.homeTeam));
    perSport.push({
      sport: league.sport,
      leagueName: league.leagueName,
      teamName: listenerRoster.teamName,
      opponentTeamName: opponent?.teamName,
      opponentOwnerName: opponent?.ownerName,
      margin: Number((listenerTotal - opponentTotal).toFixed(1)),
      startersInPlayCount: startersInPlay.length,
      totalStartersProjected: Number(
        listenerRoster.starters.reduce((sum, p) => sum + p.projectedPoints, 0).toFixed(1)
      ),
      topSwing: topSwing
        ? {
            id: topSwing.id,
            name: topSwing.name,
            position: topSwing.position,
            proTeam: topSwing.proTeam,
            projectedPoints: topSwing.projectedPoints
          }
        : undefined,
      suggestedGameId: suggested?.id,
      suggestedGameLabel: suggested ? `${suggested.awayTeam} vs ${suggested.homeTeam}` : undefined
    });
  }
  if (perSport.length === 0) return undefined;
  // Sort by drama: largest absolute margin first, ties broken by top
  // swing projection. Want the most "story-worthy" sport on top.
  perSport.sort((left, right) => {
    const marginDiff = Math.abs(right.margin) - Math.abs(left.margin);
    if (Math.abs(marginDiff) > 0.05) return marginDiff;
    return (right.topSwing?.projectedPoints ?? 0) - (left.topSwing?.projectedPoints ?? 0);
  });
  return { listenerName: listener.name, perSport };
}

export function buildListenerRecapHighlight(input: {
  commentary: LivecastCommentary[];
  group: GroupSettings;
  leagues: FantasyLeagueState[];
  game?: SportsGameState;
}): ListenerRecapHighlight | undefined {
  const listener = input.group.listener;
  if (!listener?.name) return undefined;
  const league = pickLeagueForSport(input.leagues, input.game?.sport);
  const listenerRoster = (league?.matchups ?? [])
    .flatMap((matchup) => matchup.rosters)
    .find((roster) =>
      listener.rosterId
        ? roster.id === listener.rosterId
        : roster.ownerName.toLowerCase() === listener.name.toLowerCase()
    );
  if (!listenerRoster) return undefined;
  // Find the play with the biggest positive listener delta first; if none,
  // fall back to the worst negative one. Showing the high _or_ the low —
  // whichever defined the listener's show.
  let best: { item: LivecastCommentary; impact: FantasyImpact } | undefined;
  let worst: { item: LivecastCommentary; impact: FantasyImpact } | undefined;
  for (const item of input.commentary) {
    const impact = item.fantasyImpacts.find((candidate) => candidate.rosterId === listenerRoster.id);
    if (!impact) continue;
    if (impact.pointsDelta > 0 && (!best || impact.pointsDelta > best.impact.pointsDelta)) {
      best = { item, impact };
    }
    if (impact.pointsDelta < 0 && (!worst || impact.pointsDelta < worst.impact.pointsDelta)) {
      worst = { item, impact };
    }
  }
  const chosen = best ?? worst;
  if (!chosen) return undefined;
  return {
    kind: chosen === best ? "win" : "loss",
    playerName: chosen.impact.playerName,
    pointsDelta: chosen.impact.pointsDelta,
    hostText: chosen.item.text,
    hostId: chosen.item.hostId,
    playHeadline: chosen.item.play.headline,
    reason: chosen.impact.reason,
    commentaryId: chosen.item.id
  };
}

export function buildListenerGameSpotlights(input: {
  games: SportsGameOption[];
  leagues: FantasyLeagueState[];
  group: GroupSettings;
}): Map<string, ListenerGameSpotlight> {
  const result = new Map<string, ListenerGameSpotlight>();
  const listener = input.group.listener;
  if (!listener?.name) return result;
  // Multi-sport: aggregate across every connected league. A single
  // listener might have NFL starters playing tonight AND NBA starters
  // playing tonight — both should surface on the discover landing.
  for (const league of input.leagues) {
    const listenerRoster = league.matchups
      .flatMap((matchup) => matchup.rosters)
      .find((roster) =>
        listener.rosterId
          ? roster.id === listener.rosterId
          : roster.ownerName.toLowerCase() === listener.name.toLowerCase()
      );
    if (!listenerRoster) continue;
    for (const game of input.games) {
      // Each league is sport-specific, so its starters can only appear
      // in matching-sport games. NBA roster won't show up in NFL slots.
      if (game.sport !== league.sport) continue;
      const teams = new Set([game.awayTeam, game.homeTeam]);
      const starters = listenerRoster.starters.filter((starter) => teams.has(starter.proTeam));
      if (starters.length === 0) continue;
      const topStarter = [...starters].sort((left, right) => right.projectedPoints - left.projectedPoints)[0];
      result.set(game.id, { gameId: game.id, starters, topStarter });
    }
  }
  return result;
}

function pickLeagueForSport(leagues: FantasyLeagueState[], sport: SportsGameState["sport"] | undefined): FantasyLeagueState | undefined {
  if (sport) {
    // Strict match when a sport is specified — otherwise we'd silently
    // pull NFL roster data into an NBA show (or vice versa). Callers
    // handle the undefined case by routing to "no-roster" copy.
    return leagues.find((league) => league.sport === sport);
  }
  return leagues[0];
}

function sportNoun(sport: SportsGameState["sport"]): string {
  switch (sport) {
    case "nfl": return "NFL";
    case "nba": return "NBA";
    case "wnba": return "WNBA";
    case "mlb": return "MLB";
    case "nhl": return "NHL";
    case "ncaaf": return "college football";
    case "ncaab": return "college basketball";
    case "soccer": return "soccer";
    default: return "fantasy";
  }
}

export function showHasStream(videoMode: VideoMode, hasVideoSource: boolean) {
  return hasVideoSource || videoMode === "screen-share";
}

function shorten(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

function stripMarkdown(text: string) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    // Drop Inworld delivery tags ([deadpan], [skeptical], etc.) so
    // the host-turn cards on the recap don't show them as visible
    // text. Server keeps them on line.text for the Inworld TTS path.
    .replace(/\[[a-zA-Z][a-zA-Z_\s,]{0,40}\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
