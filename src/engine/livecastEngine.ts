import type {
  FantasyLeagueState,
  GroupSettings,
  HostId,
  LatencyMetrics,
  LivecastCommentary,
  MomentCue,
  NewsItem,
  SportsPlay,
  VideoObservation
} from "../shared/contracts";
import { selectHost } from "../shared/hostPersonas";
import { rankFantasyImpacts } from "./fantasyImpact";

export function createLivecastCommentary(input: {
  league: FantasyLeagueState;
  play: SportsPlay;
  observation: VideoObservation;
  group: GroupSettings;
  news: NewsItem[];
  startedAt: number;
  recentCommentary?: string[];
  recentHostIds?: HostId[];
  /**
   * Listener-driven override. When set, this host delivers the upcoming
   * turn instead of the deterministic pick. Used by the live "tap a host
   * to make them speak" interaction; cleared after one use upstream.
   */
  forceHostId?: HostId;
}): LivecastCommentary {
  const textStart = performance.now();
  const impacts = rankFantasyImpacts(input.league, input.play);
  const moment = assessMomentCue({ play: input.play, impacts, group: input.group });
  const hostId = input.forceHostId ?? selectHost({
    moment,
    impacts,
    play: input.play,
    listenerName: input.group.listener.name,
    recentHostIds: input.recentHostIds
  });
  const text = buildCommentaryText({
    play: input.play,
    observation: input.observation,
    group: input.group,
    impacts,
    moment,
    news: input.news,
    recentCommentary: input.recentCommentary ?? []
  });
  const textGenerationMs = Math.round(performance.now() - textStart);
  const endToEndMs = Math.round(performance.now() - input.startedAt);

  const latency: LatencyMetrics = {
    videoIngestMs: input.observation.latencyMs,
    modelResponseMs: input.observation.latencyMs,
    textGenerationMs,
    endToEndMs
  };

  return {
    id: crypto.randomUUID(),
    kind: "play",
    hostId,
    text,
    fantasyImpacts: impacts,
    moment,
    observation: input.observation,
    play: input.play,
    createdAt: new Date().toISOString(),
    latency
  };
}

/**
 * Build a one-shot show opener. This is the AI-DJ moment: name the
 * listener, name their actual lineup, give one specific thing about each
 * starter. The LLM is asked to deliver it in Theo's voice (he's the host
 * who naturally addresses the listener directly).
 *
 * Returns a complete commentary object ready to send, with a synthetic
 * `play` payload because every commentary needs one. The client should
 * render this with `kind === "opener"` styling — eyebrow "ON AIR", no
 * play meta.
 */
export function createListenerOpener(input: {
  league: FantasyLeagueState;
  game?: SportsPlay;
  group: GroupSettings;
  listenerRoster?: { ownerName: string; teamName: string; starters: Array<{ name: string; position: string; proTeam: string; currentPoints: number; projectedPoints: number }> };
  startedAt: number;
  observation: VideoObservation;
}): LivecastCommentary {
  const listener = input.group.listener;
  const roster = input.listenerRoster;
  const text = buildLocalOpenerText({ listenerName: listener.name, roster });
  const endToEndMs = Math.round(performance.now() - input.startedAt);
  return {
    id: crypto.randomUUID(),
    kind: "opener",
    hostId: "theo",
    text,
    fantasyImpacts: [],
    moment: { priority: "major", headline: "Show open", summary: "Personalized welcome", reasons: ["personalized-opener"], targetFriendIds: [], score: 1 },
    observation: input.observation,
    play: input.game ?? syntheticOpenerPlay(),
    createdAt: new Date().toISOString(),
    latency: {
      videoIngestMs: 0,
      modelResponseMs: 0,
      textGenerationMs: 0,
      endToEndMs
    }
  };
}

function buildLocalOpenerText(input: { listenerName: string; roster?: { teamName: string; starters: Array<{ name: string; position: string; currentPoints: number; projectedPoints: number }> } }): string {
  if (!input.roster || input.roster.starters.length === 0) {
    return `${input.listenerName}, welcome in. We don't have your lineup loaded yet, so we'll call this one off the official feed.`;
  }
  const top = [...input.roster.starters].sort((a, b) => b.projectedPoints - a.projectedPoints).slice(0, 3);
  const names = top.map((p) => `${p.name} at ${p.position}`).join(", ");
  return `${input.listenerName}, welcome to your show. ${input.roster.teamName} is rolling with ${names} — that's the trio I'm watching for you tonight. Let's see what they give us.`;
}

function syntheticOpenerPlay(): SportsPlay {
  return {
    id: `opener-${Date.now()}`,
    type: "other",
    excitement: 1,
    clock: "—",
    quarter: "Open",
    possession: "—",
    headline: "Show open",
    description: "Welcome to Huddle Radio.",
    playerIds: [],
    team: "—",
    score: { away: 0, home: 0 },
    occurredAt: new Date().toISOString()
  };
}

export function buildCommentaryText(input: {
  play: SportsPlay;
  observation: VideoObservation;
  group: GroupSettings;
  impacts: ReturnType<typeof rankFantasyImpacts>;
  moment?: MomentCue;
  news: NewsItem[];
  recentCommentary?: string[];
}): string {
  const topImpact = input.impacts[0];
  const moment = input.moment ?? assessMomentCue({ play: input.play, impacts: input.impacts, group: input.group });
  const friend = topImpact ? input.group.friends.find((candidate) => candidate.rosterId === topImpact.rosterId) : undefined;
  const recent = input.recentCommentary ?? [];
  const tonePrefix = chooseFresh(toneLeads(input.group.tone), recent, input.play.id);
  const eventLead = chooseFresh(eventLeads(input.play.excitement, input.play.type), recent, `${input.play.id}-event`);
  const impactText = topImpact
    ? impactLine(topImpact, recent, input.play.id)
    : chooseFresh(noImpactLines(), recent, `${input.play.id}-no-impact`);
  const extraImpacts = input.impacts
    .slice(1, 3)
    .map((impact) => `${impact.ownerName} also moved ${impact.pointsDelta > 0 ? "+" : ""}${impact.pointsDelta} with ${impact.playerName}`)
    .join("; ");
  const friendNeedle = friend?.rivalryNotes ? ` ${friend.name}, ${friend.rivalryNotes.toLowerCase()}.` : "";
  const newsHook = input.news[0] && input.play.excitement >= 4 ? ` Context note: ${input.news[0].title}.` : "";
  const observation = observationLine(input.observation);
  const bias = biasLine(input.group.homeTeamBias, input.play.team, input.group.friends);
  const momentLead = moment.priority === "interrupt" ? `Interrupt-worthy: ${moment.headline}.` : moment.priority === "major" ? `${moment.headline}.` : "";

  return `${tonePrefix} ${momentLead} ${input.play.quarter}, ${input.play.clock}: ${input.play.headline}. ${eventLead} ${impactText} ${extraImpacts ? `${extraImpacts}.` : ""} ${observation} ${bias}${friendNeedle}${newsHook}`
    .replace(/\s+/g, " ")
    .slice(0, 520);
}

export function assessMomentCue(input: { play: SportsPlay; impacts: ReturnType<typeof rankFantasyImpacts>; group: GroupSettings }): MomentCue {
  const reasons: string[] = [];
  let score = input.play.excitement * 14;
  const absoluteSwing = input.impacts.reduce((total, impact) => total + Math.abs(impact.pointsDelta), 0);
  const topSwing = Math.abs(input.impacts[0]?.pointsDelta ?? 0);

  if (input.play.type === "touchdown") {
    score += 32;
    reasons.push("touchdown");
  }
  if (input.play.type === "turnover") {
    score += 30;
    reasons.push("turnover");
  }
  if (input.play.type === "field-goal" && input.play.excitement >= 4) {
    score += 14;
    reasons.push("pressure kick");
  }
  // Sport-agnostic excitement boost. NFL gets enough signal from
  // touchdown/turnover above; NBA / NHL / MLB plays come through as
  // type:"other" so a clutch dunk or buzzer-beater would otherwise stay
  // "notable" and route to default Theo. Only fires when no
  // sport-specific boost has already classified the play.
  const typeBoosted =
    input.play.type === "touchdown" ||
    input.play.type === "turnover" ||
    (input.play.type === "field-goal" && input.play.excitement >= 4);
  if (!typeBoosted) {
    if (input.play.excitement === 5) {
      score += 26;
      reasons.push("high-stakes moment");
    } else if (input.play.excitement === 4) {
      score += 12;
      reasons.push("notable moment");
    }
  }
  if (topSwing >= 6) {
    score += 24;
    reasons.push("major fantasy swing");
  } else if (topSwing >= 3) {
    score += 12;
    reasons.push("fantasy swing");
  }
  if (absoluteSwing >= 8) {
    score += 12;
    reasons.push("multi-roster impact");
  }

  const impactedRosterIds = new Set(input.impacts.map((impact) => impact.rosterId));
  const targetFriendIds = input.group.friends.filter((friend) => friend.rosterId && impactedRosterIds.has(friend.rosterId)).map((friend) => friend.id);
  if (targetFriendIds.length > 1) {
    score += 10;
    reasons.push("friend-vs-friend stakes");
  }

  const priority: MomentCue["priority"] = score >= 95 ? "interrupt" : score >= 76 ? "major" : score >= 48 ? "notable" : "routine";
  const headline = headlineForMoment(priority, input.play, input.impacts[0]);
  return {
    priority,
    headline,
    summary: summaryForMoment(input.play, input.impacts[0], absoluteSwing),
    reasons: reasons.length ? reasons : ["routine game context"],
    targetFriendIds,
    score: Math.min(100, Math.round(score))
  };
}

function headlineForMoment(priority: MomentCue["priority"], play: SportsPlay, topImpact?: ReturnType<typeof rankFantasyImpacts>[number]) {
  if (priority === "interrupt") return topImpact ? `Break in for ${topImpact.ownerName}` : "Break in for a major game swing";
  if (priority === "major") return topImpact ? `Major swing for ${topImpact.ownerName}` : "Major game moment";
  if (priority === "notable") return topImpact ? `Notable fantasy move for ${topImpact.ownerName}` : "Notable game context";
  return play.type === "other" ? "Routine update" : `${labelizePlayType(play.type)} update`;
}

function summaryForMoment(play: SportsPlay, topImpact: ReturnType<typeof rankFantasyImpacts>[number] | undefined, absoluteSwing: number) {
  const swing = topImpact ? `${topImpact.playerName} moved ${topImpact.ownerName} ${topImpact.pointsDelta > 0 ? "+" : ""}${topImpact.pointsDelta}.` : "No direct rostered-player swing.";
  return `${labelizePlayType(play.type)} with ${Math.round(absoluteSwing * 10) / 10} total fantasy points in play. ${swing}`;
}

function labelizePlayType(type: SportsPlay["type"]) {
  return type.replace("-", " ");
}

function observationLine(observation: VideoObservation) {
  const validation = observation.validation;
  if (!validation) {
    return observation.confidence < 0.65 ? `Model read is tentative: ${observation.summary}` : observation.summary;
  }
  if (validation.status === "sports-event") {
    return `Validated sports frame: ${observation.summary}`;
  }
  if (validation.status === "not-sports") {
    return "Visual validation says the stream does not look like game action, so this call is based on the official play feed.";
  }
  if (validation.status === "unavailable") {
    return "Visual validation is unavailable, so this call stays anchored to the official play feed.";
  }
  return `Visual validation is uncertain: ${observation.summary}`;
}

function toneLeads(tone: GroupSettings["tone"]): string[] {
  switch (tone) {
    case "chaos":
      return ["Sound the group-chat alarm.", "Oh, the standings just got personal.", "Nobody breathe for a second."];
    case "family":
      return ["Big moment for the watch party.", "Circle this one for the room.", "That will get everyone leaning forward."];
    case "pg":
      return ["Here we go.", "That one changes the feel.", "Keep an eye on this swing."];
  }
}

function eventLeads(excitement: SportsPlay["excitement"], type: SportsPlay["type"]) {
  if (type === "turnover") return ["That is a full emotional tax audit.", "Turnover math is brutal in fantasy.", "That mistake changes the whole room."];
  if (excitement >= 5) return ["That one matters right now.", "That is not background noise.", "That is a headline play for this matchup."];
  if (excitement >= 4) return ["That was a real momentum play.", "Loud implications either way.", "That one nudges the matchup needle."];
  return ["Small play, but the context is useful.", "Not every update is fireworks, but this one sets the table.", ""];
}

function noImpactLines() {
  return [
    "No direct fantasy starters moved, but the game script is shifting.",
    "No rostered player got the points, so this is mostly scoreboard context.",
    "The fantasy blast radius is low, which is its own kind of relief."
  ];
}

function impactLine(impact: ReturnType<typeof rankFantasyImpacts>[number], recent: string[], seed: string) {
  const signed = impact.pointsDelta > 0 ? `+${impact.pointsDelta}` : `${impact.pointsDelta}`;
  return chooseFresh(
    [
      `${impact.ownerName}'s ${impact.teamName} just moved ${signed} with ${impact.playerName}${impact.isStarter ? "" : " on the bench"}.`,
      `${impact.playerName} puts ${signed} on ${impact.ownerName}'s side of the ledger${impact.isStarter ? "" : ", annoyingly from the bench"}.`,
      `${impact.ownerName} gets the fantasy headline here: ${impact.playerName}, ${signed}.`
    ],
    recent,
    seed
  );
}

function biasLine(bias: GroupSettings["homeTeamBias"], team: string, friends: GroupSettings["friends"]): string {
  if (bias === "balanced") return "";
  if (bias === "fantasy-first") return "Fantasy impact gets priority over the scoreboard here.";
  const matchingFriends = friends.filter((friend) => friend.favoriteTeam.toUpperCase() === team.toUpperCase());
  if (matchingFriends.length === 0) return "";
  return `${matchingFriends.map((friend) => friend.name).join(" and ")} get the favorite-team bump.`;
}

function chooseFresh(options: string[], recent: string[], seed: string) {
  const filtered = options.filter((option) => option && !recent.some((text) => text.includes(option.slice(0, 28))));
  const choices = filtered.length ? filtered : options.filter(Boolean);
  return choices[stableIndex(seed, choices.length)] ?? "";
}

function stableIndex(value: string, modulo: number) {
  return [...value].reduce((total, char) => total + char.charCodeAt(0), 0) % modulo;
}
