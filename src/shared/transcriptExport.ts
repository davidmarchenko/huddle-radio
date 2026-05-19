import type { ActiveProviderSummary, FantasyLeagueState, HostId, LivecastCommentary, SportsGameState } from "./contracts";

export type TranscriptExportInput = {
  fantasy?: FantasyLeagueState;
  game?: SportsGameState;
  providers: ActiveProviderSummary;
  commentary: LivecastCommentary[];
  generatedAt?: string;
};

// Display names for the markdown attribution. Kept here (not imported
// from huddleViewModel) so the shared module stays client-agnostic —
// shared/ can be imported by server code too.
const HOST_DISPLAY_NAMES: Record<HostId, string> = {
  maya: "Maya",
  theo: "Theo",
  cam: "Cam"
};

export function buildTranscriptExport(input: TranscriptExportInput) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  // Chronological order in the export — easier to read top-to-bottom
  // than the reverse-chrono order the live UI uses.
  const ordered = input.commentary
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const biggestMoment = input.commentary.slice().sort((a, b) => b.moment.score - a.moment.score)[0];
  const topImpact = input.commentary.flatMap((item) => item.fantasyImpacts).sort((a, b) => Math.abs(b.pointsDelta) - Math.abs(a.pointsDelta))[0];
  // Show duration from first to last turn (when present). Listeners
  // care about "how long was the show", not internal latency numbers.
  const timestamps = input.commentary
    .map((c) => Date.parse(c.createdAt))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const spanMs = timestamps.length >= 2 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
  const spanMin = Math.round(spanMs / 60000);

  return [
    "# Fantasy Livecast Recap",
    "",
    `Generated: ${new Date(generatedAt).toLocaleString()}`,
    `League: ${input.fantasy?.leagueName ?? "No league loaded"}`,
    `Game: ${input.game ? `${input.game.awayTeam} at ${input.game.homeTeam} (${input.game.status})` : "No game loaded"}`,
    `Providers: ${input.providers.fantasy} / ${input.providers.sportsData} / ${input.providers.commentary} / ${input.providers.tts}`,
    "",
    "## Session Highlights",
    "",
    biggestMoment ? `- Biggest moment: ${biggestMoment.moment.headline} (${biggestMoment.moment.priority}, ${biggestMoment.moment.score}/100).` : "- Biggest moment: none yet.",
    topImpact ? `- Biggest fantasy swing: ${topImpact.ownerName} ${topImpact.pointsDelta > 0 ? "+" : ""}${topImpact.pointsDelta} from ${topImpact.playerName}.` : "- Biggest fantasy swing: none yet.",
    spanMs > 0 ? `- Show length: ${spanMin === 0 ? "<1" : spanMin} ${spanMin === 1 ? "minute" : "minutes"} (${input.commentary.length} ${input.commentary.length === 1 ? "call" : "calls"}).` : `- Show length: ${input.commentary.length} ${input.commentary.length === 1 ? "call" : "calls"}.`,
    "",
    "## Transcript",
    "",
    ordered.length ? ordered.map(formatCommentary).join("\n\n") : "No commentary generated yet."
  ].join("\n");
}

function formatCommentary(item: LivecastCommentary) {
  const time = new Date(item.createdAt).toLocaleTimeString();
  // Per-turn header: time + a short human label (kind). Drops the
  // internal score/priority noise — listeners don't care about
  // "MAJOR (72/100)"; that lives in Session Highlights instead.
  const header = `### ${time} — ${formatKind(item.kind)}`;
  // Multi-speaker turns: attribute each line to its host. Falls back
  // to a single bullet when `lines` is absent or empty (legacy /
  // mock-fallback path), so older sessions and tests still export.
  const lines = item.lines && item.lines.length > 0
    ? item.lines.map((line) => `**${HOST_DISPLAY_NAMES[line.hostId] ?? line.hostId}:** ${line.text.trim()}`).join("\n\n")
    : item.text;
  const impact = item.fantasyImpacts[0]
    ? `\n\n_Fantasy impact: ${item.fantasyImpacts[0].ownerName} ${item.fantasyImpacts[0].pointsDelta > 0 ? "+" : ""}${item.fantasyImpacts[0].pointsDelta} via ${item.fantasyImpacts[0].playerName}._`
    : "";
  return `${header}\n\n${lines}${impact}`;
}

// Render CommentaryKind as a short human label. The internal kind
// vocabulary ("opener" | "play") is producer scaffolding; map to
// phrases the listener would recognize from the show.
function formatKind(kind: LivecastCommentary["kind"]): string {
  switch (kind) {
    case "opener": return "Cold open";
    case "play": return "Live call";
    default: return "Call";
  }
}
