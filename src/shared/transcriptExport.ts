import type { ActiveProviderSummary, FantasyLeagueState, LivecastCommentary, SportsGameState } from "./contracts";

export type TranscriptExportInput = {
  fantasy?: FantasyLeagueState;
  game?: SportsGameState;
  providers: ActiveProviderSummary;
  commentary: LivecastCommentary[];
  generatedAt?: string;
};

export function buildTranscriptExport(input: TranscriptExportInput) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const ordered = input.commentary.slice().reverse();
  const biggestMoment = input.commentary.slice().sort((a, b) => b.moment.score - a.moment.score)[0];
  const topImpact = input.commentary.flatMap((item) => item.fantasyImpacts).sort((a, b) => Math.abs(b.pointsDelta) - Math.abs(a.pointsDelta))[0];
  const averageLatency = input.commentary.length
    ? Math.round(input.commentary.reduce((total, item) => total + item.latency.endToEndMs, 0) / input.commentary.length)
    : undefined;

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
    averageLatency === undefined ? "- Average end-to-end latency: n/a." : `- Average end-to-end latency: ${averageLatency}ms.`,
    "",
    "## Transcript",
    "",
    ordered.length ? ordered.map(formatCommentary).join("\n\n") : "No commentary generated yet."
  ].join("\n");
}

function formatCommentary(item: LivecastCommentary) {
  const time = new Date(item.createdAt).toLocaleTimeString();
  const impact = item.fantasyImpacts[0]
    ? ` Top impact: ${item.fantasyImpacts[0].ownerName} ${item.fantasyImpacts[0].pointsDelta > 0 ? "+" : ""}${item.fantasyImpacts[0].pointsDelta} via ${item.fantasyImpacts[0].playerName}.`
    : "";
  return `### ${time} - ${item.moment.priority.toUpperCase()} (${item.moment.score}/100)\n\n${item.text}\n\n${item.moment.summary}${impact}`;
}
