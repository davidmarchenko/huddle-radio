/**
 * CallbackEnrichmentProvider — surfaces prior-show host claims as
 * enrichment signals when the same player or team appears in the
 * current play.
 *
 * Closes the loop on cross-show memory: the show extracts claims
 * after each turn → the store keeps them per-listener → this
 * provider pulls relevant ones into the next show's enrichment
 * stream → the producer can pick them as "callback" beats.
 *
 * Unlike Reddit / Bluesky / Wikipedia, this provider needs the
 * listener id to do anything useful. It's constructed per-show with
 * the active listener id baked in (showFactories handles this).
 *
 * Health is always "ready" — there's no upstream service to fail.
 */

import type { EnrichmentSignal, ProviderHealth, SportsGameState } from "../../shared/contracts";
import type { ClaimsStore } from "../../server/memory/types";
import type { EnrichmentProvider } from "./types";

const ID = "callback";
const LABEL = "Cross-show callbacks";

type CallbackProviderOptions = {
  store: ClaimsStore;
  listenerId: string;
  /** Optional age cap (ms) — drop claims older than this. Default 14 days. */
  maxAgeMs?: number;
  /** Cap on signals per gather() call. Default 3. */
  limit?: number;
};

export class CallbackEnrichmentProvider implements EnrichmentProvider {
  id = ID;
  label = LABEL;

  private readonly store: ClaimsStore;
  private readonly listenerId: string;
  private readonly maxAgeMs?: number;
  private readonly limit?: number;

  constructor(options: CallbackProviderOptions) {
    this.store = options.store;
    this.listenerId = options.listenerId;
    this.maxAgeMs = options.maxAgeMs;
    this.limit = options.limit;
  }

  async gather(input: { game: SportsGameState; deadlineMs: number }): Promise<EnrichmentSignal[]> {
    if (!this.listenerId) return [];
    const play = input.game.currentPlay;
    const playerIds = play?.playerIds ?? [];
    const teams = [input.game.homeTeam, input.game.awayTeam, play?.team]
      .filter((t): t is string => Boolean(t));
    if (playerIds.length === 0 && teams.length === 0) return [];
    const claims = await this.store.findRelevant({
      listenerId: this.listenerId,
      playerIds,
      teams,
      maxAgeMs: this.maxAgeMs,
      limit: this.limit
    });
    return claims.map((claim) => ({
      // Use the claim's stable id so the aggregator's id-dedup pass
      // collapses re-surfaces of the same callback across ticks.
      id: claim.id,
      source: "callback",
      kind: "context",
      text: `${claim.hostId} previously: "${claim.text}" (from earlier show)`,
      // Recency-weighted score in [0, 1]. Recent claims rank higher,
      // outcome="right" callbacks rank highest.
      score: scoreClaim(claim.capturedAt, claim.outcome),
      occurredAt: claim.capturedAt,
      refs: { playerId: claim.anchorPlayerId, teamId: claim.anchorTeam }
    }));
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: this.label,
      status: "ready",
      detail: "In-memory cross-show claims store."
    };
  }
}

function scoreClaim(capturedAt: string, outcome?: string): number {
  const ageMs = Date.now() - new Date(capturedAt).getTime();
  const days = Math.max(0, ageMs / (24 * 60 * 60 * 1000));
  // Recency: 0.85 today, ~0.45 at 7 days, ~0.05 at 14 days.
  const recency = Math.max(0.05, 0.85 - days * 0.057);
  const outcomeLift = outcome === "right" ? 0.1 : 0;
  return Math.min(1, recency + outcomeLift);
}
