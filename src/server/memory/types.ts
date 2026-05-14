/**
 * Cross-show memory — extracted host claims that can come back as
 * callbacks in future shows.
 *
 * A "claim" is anything a host said about a specific player or team
 * that we'd want to surface later: predictions ("Wilson goes for 30
 * tonight"), named bindings ("Cam called the Storm soft on the
 * boards"), declared rooting interests ("Theo said he's done with
 * the Aces"). The system extracts them per-turn, stores them keyed
 * by the listener (so memories are personal), and pulls matching
 * claims back through a CallbackEnrichmentProvider when the same
 * player or team comes up in a later show.
 *
 * Why per-listener: the same host saying the same thing means
 * different things to different listeners. Cam predicting Wilson
 * over 30 is a callback for the listener who heard it last week,
 * but pure noise for someone tuning in for the first time.
 */

import type { HostId } from "../../shared/contracts";

export type Claim = {
  /** Stable id — used as the EnrichmentSignal id when this claim is
   *  surfaced as a callback, so the aggregator's identity-dedup pass
   *  collapses it across ticks. */
  id: string;
  /** Whose memory this is. Claims never cross listener boundaries —
   *  a Cam-from-last-week prediction belongs only to the listener
   *  who heard it. */
  listenerId: string;
  /** Which host made the claim. */
  hostId: HostId;
  /** What they said — short paraphrase the next show can quote. */
  text: string;
  /** Optional player anchor (canonical id from the play). When set,
   *  the callback provider matches by player. */
  anchorPlayerId?: string;
  /** Player name as the extractor saw it ("Wilson", "A'ja Wilson").
   *  Carried alongside the id because the OutcomeResolver queries
   *  fetchLiveStats by name (ESPN box scores are keyed by name, not
   *  the canonical player id). Optional — may be absent for older
   *  claims or when only a team anchor was inferred. */
  anchorPlayerName?: string;
  /** Optional team anchor (abbreviation from the play / game state).
   *  When set, the callback provider matches by team. */
  anchorTeam?: string;
  /** Show that produced this claim — useful for "last week" framing. */
  sourceShowId: string;
  /** ISO timestamp of when the claim was captured. Drives recency
   *  cutoffs (we don't want a 3-month-old prediction surfacing). */
  capturedAt: string;
  /** Optional outcome marker — "right" / "wrong" / "pending". When
   *  resolved, the callback can be framed with that context. Future:
   *  an outcome-resolver job; today claims start as "pending" and
   *  the producer can flag them on next surface. */
  outcome?: "right" | "wrong" | "pending";
};

export type ClaimsStore = {
  /** Save a freshly extracted claim. Idempotent on `id`. Async
   *  because the production backend is Upstash REST (network call);
   *  the in-memory fallback resolves synchronously. */
  save(claim: Claim): Promise<void>;
  /** Find claims for a listener that match the current game's
   *  players or teams. Caller passes the candidate match keys
   *  (player ids + team abbreviations from the current play). */
  findRelevant(input: {
    listenerId: string;
    playerIds: string[];
    teams: string[];
    /** Maximum age in ms — drop claims older than this. Default
     *  the implementation chooses (typically ~14 days). */
    maxAgeMs?: number;
    /** Cap on returned claims so a chatty listener's history doesn't
     *  swamp the producer payload. */
    limit?: number;
  }): Promise<Claim[]>;
  /** Update the outcome on a stored claim. No-op when the id doesn't
   *  exist in the listener's bucket. Used by the OutcomeResolver
   *  after game-end to mark predictions right / wrong. */
  updateOutcome(input: {
    claimId: string;
    listenerId: string;
    outcome: "right" | "wrong" | "pending";
  }): Promise<void>;
  /** Get all claims for a listener that are still in pending state.
   *  Drives the outcome resolver — we only need to look at unresolved
   *  predictions, not re-grade ones we've already settled. */
  pendingFor(listenerId: string): Promise<Claim[]>;
  /** Get all claims for a listener regardless of outcome. Used by
   *  the /api/diagnostics/memory endpoint to surface the full
   *  per-listener history for debugging. Cap at limit. */
  listAllForListener(listenerId: string, limit?: number): Promise<Claim[]>;
  /** Test-only — drain the store. */
  reset?(): void | Promise<void>;
};

export type ExtractInput = {
  listenerId: string;
  hostId: HostId;
  /** Joined dialogue from the turn. */
  text: string;
  /** Player ids the play involved — used to anchor extracted claims
   *  to a specific player when the text mentions them. */
  playPlayerIds: string[];
  /** Both teams in the matchup — used to anchor claims by team. */
  teams: string[];
  sourceShowId: string;
  capturedAt: string;
};

export type ClaimsExtractor = {
  id: string;
  /** Pull zero-or-more claims out of a turn. Returns empty when the
   *  turn doesn't contain anything memorable. Never throws past its
   *  public surface — extractors are best-effort. */
  extract(input: ExtractInput): Promise<Claim[]>;
};
