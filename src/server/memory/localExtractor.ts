/**
 * LocalClaimsExtractor — heuristic claim extraction.
 *
 * Catches the common patterns deterministically without an LLM call:
 *
 *   1. Predictions: "<name> goes for <number>", "<name> over <number>",
 *      "I think <name> hits/scores/rushes <number>"
 *   2. Strong takes: "<name> is washed", "<name> is the best", "<team>
 *      can't shoot", "<team> is done"
 *   3. Hot rivalry beats: "<host name> said X about <name/team>"
 *
 * Anchor inference: when a player or team named in the play appears
 * in the claim text, attach the anchor so the callback provider can
 * match precisely. Otherwise the claim is dropped (un-anchored
 * claims are noise — they can't ever be surfaced by a player/team
 * lookup).
 *
 * This is a floor, not a ceiling. An LLM-backed extractor will catch
 * subtler claims (e.g. "I'd be surprised if she hits another one
 * tonight") that this regex pass misses. Same chain pattern as
 * commentary/producer/eval — LLM first, this as fallback.
 */

import type { HostId } from "../../shared/contracts";
import type { Claim, ClaimsExtractor, ExtractInput } from "./types";

const ID = "local-claims-extractor";

const PREDICTION_RE =
  /\b([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})\b\s+(?:goes for|over|hits|scores|rushes for|throws for|nets|drops)\s+(\d{1,3})\b/g;
const HOT_TAKE_RE =
  /\b([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})\b\s+(?:is|are)\s+(washed|done|cooked|the best|the worst|finished|elite|cooked tonight|on fire|locked in)/gi;

export class LocalClaimsExtractor implements ClaimsExtractor {
  id = ID;

  async extract(input: ExtractInput): Promise<Claim[]> {
    try {
      const text = input.text;
      if (!text || text.length < 30) return [];
      const candidates: Array<{ raw: string; anchorName: string }> = [];
      collectMatches(text, PREDICTION_RE, candidates);
      collectMatches(text, HOT_TAKE_RE, candidates);
      if (candidates.length === 0) return [];

      const out: Claim[] = [];
      const seen = new Set<string>();
      for (const cand of candidates) {
        if (seen.has(cand.raw)) continue;
        seen.add(cand.raw);
        const anchor = inferAnchor(cand.anchorName, input);
        if (!anchor.playerId && !anchor.team) continue; // un-anchored → drop
        out.push({
          id: `claim-${stableHash(`${input.sourceShowId}:${cand.raw}`)}`,
          listenerId: input.listenerId,
          hostId: input.hostId,
          text: cand.raw,
          anchorPlayerId: anchor.playerId,
          anchorPlayerName: anchor.playerId ? cand.anchorName : undefined,
          anchorTeam: anchor.team,
          sourceShowId: input.sourceShowId,
          capturedAt: input.capturedAt,
          outcome: "pending"
        });
      }
      return out;
    } catch {
      // Per-contract: never throw past the extractor surface. A
      // regex bug shouldn't take down the show.
      return [];
    }
  }
}

function collectMatches(
  text: string,
  re: RegExp,
  out: Array<{ raw: string; anchorName: string }>
): void {
  // RegExp with /g — exec or matchAll. Use matchAll for cleanliness.
  for (const match of text.matchAll(re)) {
    const raw = match[0].trim();
    const anchorName = match[1]?.trim();
    if (raw && anchorName) out.push({ raw, anchorName });
  }
}

function inferAnchor(
  anchorName: string,
  input: ExtractInput
): { playerId?: string; team?: string } {
  const lower = anchorName.toLowerCase();
  // Player anchor: when the named token matches a play.playerIds
  // entry. We don't have a player-id → name map here so this is a
  // weak attribution — substring match against the playerIds is the
  // best we can do without a roster lookup. The LLM extractor will
  // do this properly.
  for (const pid of input.playPlayerIds) {
    if (pid.toLowerCase().includes(lower) || lower.includes(pid.toLowerCase())) {
      return { playerId: pid };
    }
  }
  // Team anchor: substring match against team abbreviations.
  for (const team of input.teams) {
    if (team.length >= 2 && (lower === team.toLowerCase() || lower.includes(team.toLowerCase()))) {
      return { team };
    }
  }
  return {};
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
