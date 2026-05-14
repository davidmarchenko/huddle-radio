/**
 * The ProducerAgent sits between the raw signal payload (play, news,
 * markets, enrichment, picks, listener cues, recent commentary) and
 * the host LLM prompt. It does the editorial work a real radio
 * producer does: decides what's worth saying this tick, who should
 * lead, how long to spend, and what angle to take.
 *
 * The host LLM no longer reasons about a wall of disconnected fields
 * — it gets a focused directive ("this tick: lead with the market
 * swing, callback to Cam's earlier prediction, then Maya cuts in
 * with the contradicting stat") and writes the dialogue.
 *
 * Two implementations:
 *
 *   - LocalProducer — deterministic heuristic; runs in tests and as
 *     the fallback when the LLM producer fails. Always available.
 *   - AnthropicProducer (and friends) — small/fast LLM producer.
 *     Uses recent commentary, full payload, and the show's running
 *     `showState` to make richer editorial calls than rules alone.
 *
 * Failure isolation: when the LLM producer throws/times out, the
 * caller falls back to the local producer. When BOTH fail, the
 * caller can fall back to the legacy "raw payload → host prompt"
 * path that existed before this layer. The producer is additive —
 * removing it should never blank the show.
 */

import type { CommentaryDraftInput } from "../commentaryPrompts";
import type { HostId, ProviderHealth } from "../../shared/contracts";

/** What kind of signal motivated a beat. Drives UI chip rendering
 *  and per-source telemetry — "did we ever lead with an enrichment
 *  signal?" is answerable from this field alone. */
export type BeatSourceKind =
  | "play" // raw play-by-play (default — always available)
  | "market" // prediction market price or swing
  | "news" // beat-reporter article from news provider
  | "enrichment" // fan reaction / deep-stat / wiki context
  | "vision" // visual color the model saw in this tick's frame
  | "picks" // listener parlay / pick state
  | "listener" // push-to-talk cue
  | "callback" // recent-commentary thread the producer wants to extend
  | "pregame" // angle-rotation hint while waiting for tip
  | "banter" // pure conversation beat — fills silence when there's no new game action
  | "handoff"; // mid-show transition between two games — wraps the prior game and tees up the new one without closing the broadcast

export type ProducerBeat = {
  /** One-sentence directive the host LLM expands into dialogue.
   *  Specific. Names the player / market / number / quote. Not
   *  "talk about the play" — instead "Wilson just hit her fourth
   *  three; nba-stats says she's now 12-of-15 from deep on the
   *  season at this distance." */
  topic: string;
  /** The framing the producer wants on top of the topic — callback
   *  to a prior take, friction with another host, push back on the
   *  conventional read. The host LLM uses this to pick the rhetorical
   *  shape, not just the facts. */
  angle: string;
  /** Recommended lead host. Producer can override the deterministic
   *  rotation when one persona fits the beat — e.g. Cam for hot
   *  takes, Maya for stat-anchored beats, Theo for handoffs. */
  leadHostId: HostId;
  /** How many turns this beat justifies — 1=quick reaction, 2=back
   *  and forth, 3=multi-host break. The host LLM still controls
   *  exact word count; this drives the moment.priority equivalent. */
  turnCount: 1 | 2 | 3;
  /** What source the beat draws on. Used for telemetry + UI chips. */
  sourceKind: BeatSourceKind;
};

export type ProducerDirective = {
  /** Ordered beats — the host LLM works through them in order.
   *  Empty array is legal but rare ("nothing material this tick");
   *  the caller should treat empty as a duplicate-skip equivalent. */
  beats: ProducerBeat[];
  /** Producer's running summary of the show — what arc we're on,
   *  what threads are open, who's been leading. Fed back into the
   *  next tick's producer call so it has continuity without re-
   *  reading every prior turn from scratch. ~1-3 sentences. */
  showState: string;
  /** Show-arc position carried through from the planner so the host
   *  LLM can apply position-specific voice rules (cold-open energy,
   *  pivot counter-programming, close wrap-and-tease). Optional —
   *  legacy producer paths that don't set it just get the default
   *  voice rules in the directive prompt. */
  arcPosition?: import("../../server/showArc/types").ArcPosition;
  /** Per-show rapport snapshot — passed straight through to the
   *  host LLM via the directive payload. Lets the LLM see who's
   *  quiet, what threads are open, what the tonal temperature is,
   *  and shape its turn accordingly. */
  rapportState?: import("../../server/rapport/types").RapportState;
};

export type ProducerAgent = {
  /** Stable id used for diagnostics + provider-chain selection. */
  id: string;
  label: string;
  /** Build a directive from the next tick's raw input. The input
   *  is the same payload the host LLM would receive in the legacy
   *  path; the producer chooses the beats and shortens the prompt. */
  produce(input: ProducerInput): Promise<ProducerDirective>;
  /** Health probe for the producer-panel diagnostics endpoint. */
  health(): Promise<ProviderHealth>;
};

export type ProducerInput = {
  /** Same shape the host LLM would receive — see CommentaryDraftInput. */
  draft: CommentaryDraftInput;
  /** Producer state from the previous tick. Empty string at show
   *  start. The producer updates this and the engine carries it
   *  forward; it's how editorial continuity ("we're 12 minutes in,
   *  Cam's prediction about Wilson is still pending, we haven't
   *  used a callback in two turns") survives between calls. */
  priorShowState: string;
  /** Optional show-arc directive — sets the dramatic frame for this
   *  tick (cold open, climax, act-break, pivot, close). Producer
   *  treats this as the highest-level constraint when picking beats:
   *  e.g. on `position: "pivot"` it should counter-program rather
   *  than narrate the lopsided game. Absent in tests + when no
   *  planner is wired (legacy path). */
  arcDirective?: import("../../server/showArc/types").ArcDirective;
  /** Rolling means from the eval ring buffer — closes the feedback
   *  loop. When recent turns scored low on a dimension (specificity,
   *  friction, callbacks), the producer can prefer beats that
   *  address that gap. Absent at show start (no eval data yet) and
   *  in tests that don't seed it. */
  evalSnapshot?: import("../../server/eval/evalStore").EvalSnapshot;
  /** Per-show rapport state — open threads, running bits, host
   *  standing, tonal temperature. Producer reads it to force the
   *  quiet host as lead, inject callback beats when a thread fits,
   *  and avoid stacking laugh moments. Optional in tests. */
  rapportState?: import("../../server/rapport/types").RapportState;
  /** When true, the engine has decided this tick should be PURE
   *  banter (no new game action worth reacting to, but the show
   *  shouldn't go silent). Producer skips play/enrichment/market
   *  beats and emits ONLY banter beats anchored on rapportState.
   *  Default false. */
  banterMode?: boolean;
  /** When true, this is the SHOW OPENER — the very first turn the
   *  listener hears. Producer emits opener-specific beats that name
   *  the listener, name their team, foreshadow a storyline, and set
   *  the tone for the show. Distinct from arcPosition === "cold-open"
   *  (which can apply to any early-show tick); openerMode is the
   *  one-shot-at-show-start moment. Default false. */
  openerMode?: boolean;
  /** When set, the listener just SWITCHED GAMES mid-show — the
   *  broadcast is continuous, but the play-feed underneath has
   *  changed. Producer emits a single handoff beat that wraps the
   *  prior game ("alright, that one's in the books") and tees up the
   *  new matchup ("over to the late game — your guy Mahomes is
   *  warming up"). Distinct from `arcPosition === "pivot"` (which
   *  fires on a lopsided in-game score and counter-programs); this
   *  is the "the game we were watching changed" moment. */
  gamePivotMode?: GamePivotContext;
};

export type GamePivotContext = {
  /** Short prose summary of the game we're leaving. Engine builds
   *  this from the most recent gameState — score line, headline. */
  fromSummary: string;
  /** Short prose summary of the game we're moving to. Engine builds
   *  this from the new gameState — matchup, status, listener stake
   *  if relevant. */
  toSummary: string;
};
