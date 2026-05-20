import type {
  ClientServerEvent,
  DialogueLine,
  GameOdds,
  HostId,
  ListenerCue,
  LivecastCommentary,
  LivecastRequest,
  PlayerSeasonStats,
  SportsGameOption,
  SportsGameState,
  SportsPlay,
  TTSAudioChunk,
  VideoFrameSnapshot,
  VideoObservation,
  VideoSourceConfig,
  MarketSnapshot
} from "../shared/contracts";
import { formatPeriodLabel } from "../shared/period";
import { createLivecastCommentary, createListenerOpener } from "../engine/livecastEngine";
import { createNewsProvider } from "./createNewsProvider";
import { createCommentaryProvider } from "./createCommentaryProvider";
import { createOddsProvider } from "./createOddsProvider";
import { incrementCounter, ShowUsageBudget } from "./metrics";
import { rosterForListener, rosterMatchKind } from "./rosterMatch";
import { getDefaultAdvancedStatsProvider } from "./advancedStatsProvider";
import { LocalCommentaryProvider } from "../providers/openAICommentaryProvider";
import { CommentaryProviderChain } from "../providers/commentaryProviderChain";
import { MockTTSProvider, ElevenLabsTTSProvider } from "../providers/ttsProviders";
import { FishAudioTTSProvider } from "../providers/fishAudioProvider";
import { recordTurn, type TurnSummary } from "./turnSummaries";
import { UserVideoProvider } from "../providers/userVideoProvider";
import { demoGameIdToSport } from "../providers/demoSportsDataProvider";
import { config } from "./config";
import { fetchMarketSnapshots, pickRelevantMarketsForGame, teamIdentifiersFromMeta } from "./marketsProvider";
import { detectClosingHandoff, detectMarketSwings, getCommentaryPromptVersion, joinDialogueLines } from "../providers/commentaryPrompts";
import { computeEntryStatus, getEntry } from "./picksStore";
import { fetchLiveStats } from "./picksLiveStats";
import {
  buildLivePicksHostHint,
  refreshActivePicks,
  resolveExpiredEntries
} from "./livePicksStore";
import { extractMentionCues } from "./mentionCues";
import { redactSecret } from "./redactSecret";
import {
  createClaimsExtractor,
  createEnrichmentAggregator,
  createEvaluator,
  createFantasyProvider,
  createProducerAgent,
  createSportsDataProvider,
  createModelProvider,
  buildHostVoiceMap,
  createTTSProvider,
  deriveSportsLabelMode,
  getActiveProviders,
  getClaimsStoreSingleton,
  getHealth,
  resolveSportsSource
} from "./showFactories";
import { getRecentEvalSnapshot, recordEvaluation } from "./eval/evalStore";
import { ShowArcPlanner } from "./showArc/planner";
import { OutcomeResolver } from "./memory/outcomeResolver";
import { RapportTracker } from "./rapport/tracker";
import { extractVisionSignals } from "../providers/enrichment/visionExtractor";
import { AsyncEventQueue } from "./asyncEventQueue";
import { rankSlate, summarizeSlate, type SlateContext } from "./slateRanker";

/**
 * Transport-agnostic live-show engine. Owns the per-show state
 * (latest frame, queued cues, queued nudges, recent commentary,
 * markets baseline, usage budget) and the tick + opener loops that
 * the WebSocket handler used to host inline.
 *
 * Outbound events are emitted via an AsyncEventQueue so either a
 * Fastify WebSocket handler (legacy) or a Next.js SSE Route Handler
 * (Vercel-deployable) can pump them out without changes to the show
 * logic itself.
 *
 * Lifecycle:
 *   1. `new ShowEngine({ logger })` — cheap; no I/O yet.
 *   2. `engine.start(request)` — kicks off the show loop. Resolves
 *       once the opener completes; ticks continue in the background
 *       until `stop()` is called or the engine is GC'd.
 *   3. Consumers iterate `engine.events()` (an async iterable) to
 *       receive ClientServerEvent values in order.
 *   4. Inbound: `pushFrame`, `pushCue`, `pushNudge` — synchronous,
 *       fire-and-forget.
 *   5. `stop()` — idempotent, drains the event queue and clears the
 *       tick / health intervals.
 */

export type ShowEngineLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/**
 * Stream the full multi-speaker audio for a commentary turn. Each
 * line's TTS request fires IN PARALLEL (one ElevenLabs WebSocket per
 * line, capped at the number of dialogue lines — 3 for play turns,
 * 5 for the opener — both well under the Creator-tier 3-concurrent
 * cap when one engine is active). Chunks are delivered back to the
 * caller in strict line order so the listener hears Maya → Theo →
 * Cam in the same order the LLM authored, even though synth happens
 * concurrently.
 *
 * Why head-of-line drain: line N+1's chunks may finish synthesizing
 * while line N is still in flight. Naive serial synth would idle the
 * second WS slot; a naive `Promise.all + concat` would wait for the
 * slowest line before yielding the first chunk. This pattern emits
 * line N's chunks the instant they arrive and falls through to line
 * N+1's already-buffered chunks the instant N completes — minimal
 * gap between speakers, no head-of-line blocking.
 */
/**
 * Pick the right TTS strategy for a multi-turn commentary.
 *
 * - 2+ turns AND the provider exposes `synthesizeDialogue` → one
 *   ElevenLabs Text-to-Dialogue call returns a SINGLE seamless MP3
 *   with natural turn-taking handled by the model. Yields one chunk.
 *   This is the entertainment path — what listeners actually want.
 *
 * - Single-turn OR provider lacks dialogue support (mock, older
 *   instance) → existing per-line WebSocket streaming via
 *   `streamDialogueAudio`. Same head-of-line drain as before.
 *
 * On T2D failure, falls back to the per-line path so a transient
 * dialogue endpoint failure (rate limit, 500, model rejection) still
 * gets the listener audio. The fallback path is logged so operators
 * can see when the entertainment path is degrading.
 */
/**
 * Run mention-cue extraction against a TTS chunk's wordTimings if
 * present, and return the chunk with `mentionCues` attached. The
 * client uses these to fire audio-synced entity chips in the live
 * transcript panel. No-op when the provider didn't return timings
 * (ElevenLabs flash, Fish, mock).
 */
function enrichChunkWithMentionCues(
  chunk: TTSAudioChunk,
  lines: DialogueLine[],
  context: {
    starters?: import("../shared/contracts").FantasyPlayer[];
    game?: import("../shared/contracts").SportsGameState;
    markets?: MarketSnapshot[];
    listenerName?: string;
  }
): TTSAudioChunk {
  if (!chunk.wordTimings || chunk.wordTimings.length === 0) return chunk;
  if (chunk.lineIndex == null) return chunk;
  const line = lines[chunk.lineIndex];
  if (!line) return chunk;
  const cues = extractMentionCues({
    text: line.text,
    wordTimings: chunk.wordTimings,
    lineIndex: chunk.lineIndex,
    starters: context.starters,
    game: context.game,
    markets: context.markets,
    listenerName: context.listenerName
  });
  if (cues.length === 0) return chunk;
  return { ...chunk, mentionCues: cues };
}

async function* selectTTSStrategy(
  lines: DialogueLine[],
  commentaryId: string,
  ttsProvider: {
    synthesize: (input: { commentaryId: string; text: string; hostId?: HostId }) => AsyncIterable<TTSAudioChunk>;
    synthesizeDialogue?: (input: {
      commentaryId: string;
      turns: Array<{ text: string; hostId?: HostId }>;
    }) => Promise<TTSAudioChunk>;
  },
  isStopped: () => boolean,
  logger: ShowEngineLogger
): AsyncGenerator<TTSAudioChunk> {
  if (lines.length >= 2 && ttsProvider.synthesizeDialogue) {
    try {
      const chunk = await ttsProvider.synthesizeDialogue({
        commentaryId,
        turns: lines.map((line) => ({ text: line.text, hostId: line.hostId }))
      });
      if (!isStopped()) yield chunk;
      return;
    } catch (error) {
      logger.warn(
        {
          commentaryId,
          turnCount: lines.length,
          err: error instanceof Error ? error.message : String(error)
        },
        "Text-to-Dialogue failed — falling back to per-turn streaming"
      );
      // Fall through to per-line streaming below.
    }
  }
  yield* streamDialogueAudio(lines, commentaryId, ttsProvider.synthesize, isStopped, logger);
}

async function* streamDialogueAudio(
  lines: DialogueLine[],
  commentaryId: string,
  synthesize: (input: { commentaryId: string; text: string; hostId?: HostId }) => AsyncIterable<TTSAudioChunk>,
  isStopped: () => boolean,
  logger: ShowEngineLogger
): AsyncGenerator<TTSAudioChunk> {
  const lineState = lines.map(() => ({
    chunks: [] as TTSAudioChunk[],
    done: false,
    error: undefined as Error | undefined,
    yieldedChunks: false
  }));
  let notify: (() => void) | undefined;
  const ping = () => {
    const cb = notify;
    notify = undefined;
    cb?.();
  };

  // Start every line synth concurrently. Per-line errors are
  // captured so the drainer can surface them — naive swallow leaves
  // the listener with silent audio AND no diagnostic, which is the
  // worst possible failure mode.
  const launches = lines.map(async (line, lineIndex) => {
    try {
      for await (const chunk of synthesize({ commentaryId, text: line.text, hostId: line.hostId })) {
        if (isStopped()) return;
        // Stamp every chunk with the turn it came from. The client
        // swaps the on-screen transcript to whichever turn is being
        // spoken, so it never shows a future turn the listener hasn't
        // heard yet — fixes the "user sees the script" failure mode.
        const annotated: TTSAudioChunk = { ...chunk, lineIndex, lineHostId: line.hostId };
        lineState[lineIndex].chunks.push(annotated);
        ping();
      }
    } catch (error) {
      lineState[lineIndex].error = error instanceof Error ? error : new Error(String(error));
      logger.warn(
        {
          commentaryId,
          lineIndex,
          hostId: line.hostId,
          textPreview: line.text.slice(0, 80),
          err: lineState[lineIndex].error?.message
        },
        "Per-line TTS synthesis failed"
      );
    } finally {
      lineState[lineIndex].done = true;
      ping();
    }
  });

  let currentLine = 0;
  let totalYielded = 0;
  while (currentLine < lineState.length) {
    if (isStopped()) break;
    while (lineState[currentLine].chunks.length > 0) {
      const chunk = lineState[currentLine].chunks.shift()!;
      lineState[currentLine].yieldedChunks = true;
      totalYielded += 1;
      yield chunk;
    }
    if (lineState[currentLine].done) {
      currentLine += 1;
      continue;
    }
    await new Promise<void>((resolve) => { notify = resolve; });
  }

  // Drain remaining promises so we don't leak unhandled rejections.
  await Promise.allSettled(launches);

  // If NO line yielded any audio, propagate the first error so the
  // engine's outer catch fires and emits an SSE `error` event the
  // listener can see. Without this, total-failure looks identical
  // to "audio playing fine" from the SSE side.
  if (totalYielded === 0) {
    const firstError = lineState.find((s) => s.error)?.error;
    if (firstError) throw firstError;
    // No errors but no audio either — happens when the provider
    // is a mock that yields metadata-only chunks. Treat as a
    // soft no-op (legitimate state for dev / test paths).
  }
}

/** Coerce a partial TurnSummary into the full shape, falling back to safe
 *  defaults so a half-populated summary (early failure) still serializes
 *  cleanly to JSON and the diagnostics UI. */
function buildTickSummary(partial: Partial<TurnSummary>, startedAtIso: string): TurnSummary {
  return {
    turnId: partial.turnId ?? `tick-${Date.now()}`,
    kind: "play",
    sessionId: partial.sessionId ?? "",
    engineId: partial.engineId ?? "(unknown)",
    leadHostId: partial.leadHostId ?? "theo",
    finalHostIds: partial.finalHostIds ?? [],
    lineCount: partial.lineCount ?? 0,
    commentaryProvider: partial.commentaryProvider ?? "(unknown)",
    ttsEnabled: partial.ttsEnabled ?? false,
    ttsProvider: partial.ttsProvider,
    ttsChunks: partial.ttsChunks ?? 0,
    ttsFirstByteMs: partial.ttsFirstByteMs,
    textGenerationMs: partial.textGenerationMs,
    totalMs: partial.totalMs ?? 0,
    errorReason: partial.errorReason,
    startedAt: partial.startedAt ?? startedAtIso,
    lines: partial.lines,
    // Prompt version stamps every recorded turn so eval scores from
    // `/api/diagnostics/eval` join back to the exact code version of
    // the active prompts. Computed once + memoized inside
    // getCommentaryPromptVersion.
    promptVersion: partial.promptVersion ?? getCommentaryPromptVersion()
  };
}

const NOOP_LOGGER: ShowEngineLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

/**
 * Input for `ShowEngine.switchGame()`. The listener wants to follow a
 * different game without ending the broadcast — engine swaps the play
 * feed underneath, fires a producer-driven handoff turn, and
 * preserves all per-show state (rapport, claims, recentCommentary,
 * eval ring, arc planner). `toSummaryHint` is optional copy the
 * client may pass when it knows the new matchup ahead of the
 * sportsProvider fetch.
 */
export type GameSwitchInput = {
  sportsGameId?: string;
  video: VideoSourceConfig;
  latestFrame?: VideoFrameSnapshot;
  toSummaryHint?: string;
};

/** One-line prose summary of a game state for the handoff producer
 *  payload. Picks the most-readable shape based on game status:
 *  scheduled → matchup names; live → score line; final → final score
 *  with the winner first. */
function formatGameSummary(state: SportsGameState): string {
  const score = state.currentPlay?.score;
  if (state.status === "final" && score) {
    const home = score.home ?? 0;
    const away = score.away ?? 0;
    const winner = home >= away ? state.homeTeam : state.awayTeam;
    const loser = home >= away ? state.awayTeam : state.homeTeam;
    return `${winner} ${Math.max(home, away)}, ${loser} ${Math.min(home, away)} — final`;
  }
  if (state.status === "live" && score) {
    return `${state.awayTeam} ${score.away ?? 0}, ${state.homeTeam} ${score.home ?? 0} — ${state.currentPlay ? formatPeriodLabel(state.currentPlay.period) || "live" : "live"}`;
  }
  return `${state.awayTeam} at ${state.homeTeam}`;
}

export class ShowEngine {
  readonly id: string;

  private readonly queue = new AsyncEventQueue<ClientServerEvent>();
  private readonly budget = new ShowUsageBudget();
  private readonly logger: ShowEngineLogger;

  private stopped = false;
  /** Listener-initiated pause. When true, the tick interval handler
   *  short-circuits BEFORE any LLM / TTS calls — no commentary tokens,
   *  no voice credits, no audio chunks shipped over SSE. Heartbeat +
   *  health timer keep running so the connection (and engine state:
   *  rapport, claims, arc planner) stay warm. Resume just flips the
   *  flag back; the existing setInterval picks up cleanly on the next
   *  cycle. State preserved end-to-end. */
  private paused = false;
  private started = false;
  private tickTimer?: ReturnType<typeof setInterval>;
  private healthTimer?: ReturnType<typeof setInterval>;
  private latestFrame?: VideoFrameSnapshot;
  private pendingNextHostId?: HostId;
  private pendingCues: ListenerCue[] = [];
  private lastMarketsForSwing: MarketSnapshot[] = [];
  private recentCommentary: string[] = [];
  private recentHostIds: HostId[] = [];
  /** Wall-clock ms of the last commentary turn we delivered. Used by listener-cue routing today; available to future "no recent action" detection. */
  private lastCommentaryAtMs = 0;
  /** Most recently observed play id. When the next tick returns the same id (pre-game placeholder, scoreboard hiccup), there's literally nothing new to commentate on. */
  private lastSeenPlayId?: string;
  /** Consecutive ticks where the play id was unchanged. Capped — past the cap we force a turn so a pre-game game doesn't go silent forever. */
  private duplicatePlayCount = 0;
  /** Rotates per pregame tick so each forced turn anchors on a different angle (matchup math → odds → listener stake → ...) instead of recycling the same talking points. */
  private pregameAngleIndex = 0;
  /** Session id assigned by the route handler post-construction. Stamped on turn summaries
   *  so the diagnostics endpoint can group by show. Empty until setSessionId fires. */
  private sessionId = "";
  /** Set by `switchGame()`; consumed at the top of the next tick by
   *  the closure-scope `consumePendingSwitch()`. Single-slot — a
   *  rapid double-switch overwrites the first; the listener only
   *  hears one handoff into the freshest target game. */
  private pendingGameSwitch?: GameSwitchInput;
  /** Discovery-driven slate: ordered remaining games to walk after
   *  the current one ends. Engine auto-pivots to the next entry at
   *  game-end. Empty in single-game mode. */
  private slateQueue: SportsGameOption[] = [];
  /** Snapshot of the slate at show start — what the opener uses to
   *  surface breadth ("eight games tonight, three of your guys
   *  live"). Undefined in single-game mode. */
  private slateContext?: SlateContext;

  constructor(options: { id?: string; logger?: ShowEngineLogger } = {}) {
    this.id = options.id ?? `show-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** Stamp the session id post-construction so turn summaries can group by show. */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** Async iterable of outbound events. Single-consumer. */
  events(): AsyncIterable<ClientServerEvent> {
    return this.queue;
  }

  /** Latest queued event count — useful for reconnect/backpressure tests. */
  pendingEventCount(): number {
    return this.queue.size();
  }

  pushFrame(frame: VideoFrameSnapshot): void {
    if (this.stopped) return;
    this.latestFrame = frame;
  }

  pushNudge(hostId: HostId): void {
    if (this.stopped) return;
    this.pendingNextHostId = hostId;
    this.queue.push({ type: "status", message: `Up next: ${hostId}`, level: "info" });
  }

  /**
   * Switch the show to a different game without ending the broadcast.
   * Engine fires a producer-driven handoff turn at the top of the
   * next tick, then rebuilds the play feed against the new gameId.
   * Per-show state (rapport, claims, recentCommentary, eval ring)
   * carries forward — this is a continuous broadcast, not a re-open.
   *
   * No-ops when the engine hasn't started yet, has been stopped, or
   * the requested gameId matches the current one. Idempotent under
   * back-to-back calls — the latest input wins, the listener hears
   * one handoff into the freshest target game.
   */
  switchGame(input: GameSwitchInput): void {
    if (this.stopped || !this.started) return;
    this.pendingGameSwitch = input;
    this.queue.push({
      type: "status",
      message: `Pivoting to ${input.toSummaryHint ?? "the next game"}`,
      level: "info"
    });
  }

  pushCue(cue: ListenerCue): void {
    if (this.stopped) return;
    // Cap the queue so a chatty listener can't bloat the prompt
    // payload past the model's tolerance — keep the freshest 3.
    this.pendingCues = [cue, ...this.pendingCues].slice(0, 3);
    this.queue.push({
      type: "status",
      message: `Cue heard: ${cue.text.slice(0, 80)}`,
      level: "info"
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.tickTimer = undefined;
    this.healthTimer = undefined;
    if (this.started) incrementCounter("showsCompleted");
    this.queue.close();
  }

  /**
   * Listener pressed pause. Subsequent ticks short-circuit before any
   * LLM call or TTS generation — no OpenAI tokens, no ElevenLabs /
   * Inworld credits, no audio chunks queued. Keeps the engine warm
   * (heartbeat + health timer untouched) so resume picks up with
   * full state. Idempotent.
   */
  setPaused(paused: boolean): void {
    if (this.stopped) return;
    if (this.paused === paused) return;
    this.paused = paused;
    this.queue.push({
      type: "status",
      message: paused
        ? "Paused — pausing live commentary until you resume."
        : "Resumed — back on the air.",
      level: "info"
    });
  }

  async start(request: LivecastRequest): Promise<void> {
    if (this.started) return;
    if (this.stopped) return;
    this.started = true;
    incrementCounter("showsStarted");

    // Discovery-driven SLATE MODE. When the request carries 2+
    // candidate games, rank them against the listener's roster +
    // group settings; the top entry becomes the boot game, the rest
    // queue up for auto-pivot at game-end. A 1-entry slate is just a
    // single game and falls through to the legacy single-game path.
    const slateCandidates = request.slate ?? [];
    if (slateCandidates.length >= 2) {
      // Pull the listener's roster from any matchup in the custom
      // league so the ranker can boost starter-anchored games. The
      // ranker degrades gracefully when this is absent — slate still
      // ranks by liveness + marquee + favorite-team.
      const listenerRoster = request.customLeague?.matchups
        .flatMap((m) => m.rosters)
        .find((r) => r.id === request.group.listener.rosterId);
      const ranked = rankSlate({
        candidates: slateCandidates,
        group: request.group,
        listenerRoster
      });
      // Top entry boots the show; remaining entries queue for
      // auto-pivot. Mutating the request's sportsGameId here is
      // intentional — every downstream provider derives from it,
      // and lifting it onto the closure would mean reworking the
      // whole tick path against a different identity. Slate wins
      // over any caller-provided `sportsGameId` (documented).
      request.sportsGameId = ranked[0].game.id;
      this.slateQueue = ranked.slice(1).map((entry) => entry.game);
      const starterTeams = new Set(
        (listenerRoster?.starters ?? []).map((s) => s.proTeam.toUpperCase())
      );
      this.slateContext = summarizeSlate(ranked, { listenerStarterTeams: starterTeams });
      this.logger.info(
        {
          ranked: ranked.map((r) => ({ id: r.game.id, score: r.score, reasons: r.reasons.map((x) => x.kind) })),
          bootGame: ranked[0].game.id,
          remainingSlateLength: this.slateQueue.length
        },
        "Slate mode: ranked and booted"
      );
    }

    // Sports backend is derived from the gameId prefix — see
    // resolveSportsSource. The old separate `sportsDataMode` request
    // field used to drive this and silently fell through to KC@DET when
    // the two disagreed; that whole class of bug is gone now.
    // `let`-bound — switchGame() rebuilds against the new gameId
    // mid-show without restarting the broadcast.
    let sportsProvider = createSportsDataProvider(request.sportsGameId);
    // Derive the sport from the gameId (nfl-..., mlb-..., demo-..., etc.)
    // so the demo fantasy provider returns a sport-matched bundled league
    // instead of always defaulting to NFL. Without this, picking an MLB
    // game produced commentary that referenced Mahomes/Amon-Ra because
    // the demo NFL roster was the listener's only roster context.
    const sportsSource = resolveSportsSource(request.sportsGameId);
    const sportHint =
      sportsSource.kind === "espn"
        ? sportsSource.sportPath.sport
        : sportsSource.kind === "demo" && sportsSource.gameId
          ? demoGameIdToSport(sportsSource.gameId)
          : undefined;
    const fantasyProvider = createFantasyProvider(request.providerMode, request.customLeague, sportHint);
    const newsProvider = createNewsProvider();
    // Per-show enrichment aggregator. Owns its own per-provider cache
    // so a paused show's stale Reddit thread doesn't leak into the
    // next session. Failures are isolated inside the aggregator —
    // the tick path treats a missing/empty result as "no color this
    // turn" and continues, exactly like the markets / picks paths.
    const enrichmentAggregator = createEnrichmentAggregator({ listenerId: request.picksListenerId });
    // Per-show ProducerAgent. Sits between the raw signal payload and
    // the host LLM: digests every field into 1-3 prioritized "beats"
    // and a running showState so the host prompt stays focused. When
    // it fails, the engine drops back to the legacy raw-payload path
    // (host LLM still works, just without the editorial layer).
    const producerAgent = createProducerAgent();
    let priorShowState = "";
    // Snapshot of the most recent gameState in human-prose form. The
    // game-pivot helper reads this to fill the "fromSummary" of the
    // handoff beat ("Storm 78, Aces 71 — final"). Updated on every
    // tick that fetches a fresh gameState.
    let lastGameSummary: string | undefined;
    // Per-show synthetic-listener evaluator. Runs fire-and-forget
    // AFTER each turn ships, so its latency never reaches the listener.
    // Its output lands in the eval ring buffer for diagnostics + A/B.
    const evaluator = createEvaluator();
    // Per-show claims extractor + the process-wide claims store.
    // Extractor runs fire-and-forget per turn; extracted claims get
    // persisted to the shared store keyed by listenerId. Future
    // shows for the same listener pick them up via the
    // CallbackEnrichmentProvider already wired into the aggregator.
    const claimsExtractor = createClaimsExtractor();
    const claimsStore = getClaimsStoreSingleton();
    // Outcome resolver — fires once per show after the game flips to
    // final, grades pending claims, updates outcomes in the store.
    // Guarded by `hasResolvedClaims` so a long final-state tail
    // (which keeps emitting `status === "final"` ticks) doesn't
    // re-grade on every tick.
    const outcomeResolver = new OutcomeResolver(claimsStore);
    let hasResolvedClaims = false;
    // Per-show rapport tracker — owns RapportState (open threads,
    // running bits, host standing, tonal temperature) and updates
    // it after every turn ships. Producer + host LLM both read its
    // snapshot to make the show feel like an ongoing conversation
    // rather than independent reactions.
    const rapportTracker = new RapportTracker();
    // Per-show arc planner. Stateful — tracks how long the show has
    // been running, how many climactic moments we've seen, whether
    // we've already pivoted off a blowout. Producer reads its
    // ArcDirective each tick as the highest-level dramatic frame.
    const arcPlanner = new ShowArcPlanner();
    const modelProvider = createModelProvider();

    // Budget-aware commentary/TTS: when caps are exceeded, swap to
    // never-throws local providers so the show finishes without
    // burning further vendor budget on a runaway loop. Capture
    // `budget` into a local so the arrow functions below can close
    // over it cleanly (and so the closures don't accidentally rely
    // on `this` in nested calls).
    const budget = this.budget;
    const realCommentaryProvider = createCommentaryProvider();
    const localCommentaryProvider = new LocalCommentaryProvider();
    /** Provider id that answered the most recent commentary draft. Used
     *  for per-turn observability — the engine reads this after each draft
     *  to stamp the turn summary. */
    let lastCommentaryProviderId = "(no-draft-yet)";
    const commentaryProvider = {
      draft: async (input: Parameters<typeof realCommentaryProvider.draft>[0]) => {
        incrementCounter("commentaryRequests");
        if (budget.isCommentaryDegraded()) {
          const lines = await localCommentaryProvider.draft(input);
          lastCommentaryProviderId = `${localCommentaryProvider.id} (budget-degraded)`;
          return lines;
        }
        const lines = await realCommentaryProvider.draft(input);
        lastCommentaryProviderId =
          realCommentaryProvider instanceof CommentaryProviderChain
            ? realCommentaryProvider.lastProviderId ?? realCommentaryProvider.id
            : realCommentaryProvider.id;
        return lines;
      }
    };
    const commentaryProviderLabel = () => lastCommentaryProviderId;

    const videoProvider = new UserVideoProvider();
    // Provider construction lives in the factory now so swapping TTS
    // vendors (ElevenLabs ↔ Fish ↔ mock) is a single config flip.
    // Each branch in createTTSProvider() returns a provider that
    // implements the same TTSProvider contract; the engine doesn't
    // care which one it gets.
    const realTtsProvider = createTTSProvider(request.ttsProviderOverride);
    const mockTtsProvider = new MockTTSProvider();
    const ttsProvider = {
      synthesize: (input: Parameters<typeof realTtsProvider.synthesize>[0]) => {
        incrementCounter("ttsRequests");
        return budget.isTtsDegraded()
          ? mockTtsProvider.synthesize(input)
          : realTtsProvider.synthesize(input);
      },
      // Forward multi-speaker dialogue calls to the real provider when
      // it exposes the optional method AND we aren't budget-degraded.
      // Both ElevenLabs (Text-to-Dialogue HTTP) and Fish Audio (S2-Pro
      // WS) implement this; mock has no dialogue path so the
      // strategy selector falls back to per-line synthesis.
      synthesizeDialogue:
        !budget.isTtsDegraded() &&
        (realTtsProvider instanceof ElevenLabsTTSProvider ||
          realTtsProvider instanceof FishAudioTTSProvider)
          ? (input: { commentaryId: string; turns: Array<{ text: string; hostId?: HostId }> }) => {
              incrementCounter("ttsRequests");
              return realTtsProvider.synthesizeDialogue!(input);
            }
          : undefined
    };

    try {
      const [fantasy, game, health] = await Promise.all([
        fantasyProvider.getLeagueState({
          leagueId: request.providerMode === "espn" ? request.espnLeagueId : request.sleeperLeagueId,
          week: request.week,
          season: request.espnSeason
        }),
        sportsProvider.getGameState(),
        getHealth()
      ]);
      this.queue.push({
        type: "snapshot",
        fantasy,
        game,
        health,
        // The sports-data label tracks what the gameId actually
        // routes to — see resolveSportsSource. Passing the request
        // gameId here keeps the listener-visible "Sports data" line in
        // the producer panel honest.
        providers: getActiveProviders(request.customLeague, request.providerMode, deriveSportsLabelMode(request.sportsGameId))
      });

      // Synthetic placeholder observation. The NemotronSeesPanel
      // returns null until the first VideoObservation arrives — in
      // mock-provider mode that may not happen for tens of seconds
      // (or at all, if no upstream vision provider is wired). The
      // listener stares at a missing rail card during that gap.
      // Emit an "unavailable" observation immediately so the panel
      // mounts in a "Waiting on a usable frame" stub, then real
      // observations overwrite it as they arrive. NemotronSeesPanel
      // already special-cases `validation?.status === "unavailable"`
      // for the warming-up headline, so no client-side change needed.
      this.queue.push({
        type: "observation",
        observation: {
          id: `obs-placeholder-${Date.now()}`,
          source: "stream-url",
          summary: "Vision provider warming up — first frame pending.",
          confidence: 0,
          observedAt: new Date().toISOString(),
          latencyMs: 0,
          usedFrame: false,
          validation: {
            status: "unavailable",
            confidence: 0,
            evidence: [],
            reason: "Pre-first-tick placeholder — waiting on a usable frame.",
            validatedAt: new Date().toISOString()
          }
        }
      });

      // Vegas line + advanced stats run in parallel with the opener
      // commentary + TTS below, instead of blocking sequentially in
      // front of it. Used to be the first thing-the-listener-hears
      // landed only after both fetches resolved — that put 1-5s of
      // unnecessary latency between snapshot and audio (the opener
      // happily generates without odds or analytics — both are
      // enrichment context that gets folded in IF available, never
      // required). Kicked off here so the awaits below can read the
      // already-settled values without waiting.
      const matchKind = rosterMatchKind(fantasy, request.group.listener.rosterId);
      if (matchKind === "fallback-first" && request.group.listener.rosterId) {
        this.logger.warn(
          {
            listenerRosterId: request.group.listener.rosterId,
            leagueId: fantasy.leagueId,
            sport: fantasy.sport
          },
          "rosterForListener fallback: claimed rosterId not found in league"
        );
      }
      const showRoster = rosterForListener(fantasy, request.group.listener.rosterId);
      const starterIds = (showRoster?.starters ?? []).map((player) => player.id);
      const oddsPromise: Promise<GameOdds | undefined> = createOddsProvider()
        .getOdds({
          gameId: game.gameId,
          sport: game.sport,
          homeTeam: game.homeTeam,
          awayTeam: game.awayTeam
        })
        .catch((error) => {
          this.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Show-start odds fetch failed"
          );
          return undefined;
        });
      const analyticsPromise: Promise<PlayerSeasonStats[]> = starterIds.length
        ? getDefaultAdvancedStatsProvider()
            .getPlayerSeason({ canonicalIds: starterIds, sport: game.sport })
            .catch((error) => {
              this.logger.warn(
                { err: error instanceof Error ? error.message : String(error) },
                "Show-start advanced-stats fetch failed"
              );
              return [] as PlayerSeasonStats[];
            })
        : Promise.resolve([] as PlayerSeasonStats[]);
      // Await both right before the opener composer needs them.
      // Settled-or-not, the opener still composes — `odds` and
      // `analytics` default to undefined / [] when the upstream
      // providers fail or aren't configured.
      const [odds, analytics] = await Promise.all([oddsPromise, analyticsPromise]);

      // ---- SHOW OPENER ----
      // Emit the personalized welcome before any plays come in. This is
      // the highest-signal personalization moment per external research:
      // the listener should know within 30s that the show was made for
      // them. We try the LLM provider first and fall back to the local
      // template (which already names lineup) if it fails.
      // Hoisted so the summary record can fire in both the happy path
      // and the catch — same fields, single source of truth.
      const openerStarted = performance.now();
      const openerStartedIso = new Date().toISOString();
      let openerSummary: Partial<TurnSummary> = {
        kind: "opener",
        sessionId: this.sessionId,
        engineId: this.id,
        leadHostId: "theo",
        finalHostIds: [],
        lineCount: 0,
        commentaryProvider: "(unknown)",
        ttsEnabled: request.ttsEnabled,
        ttsProvider: config.RESOLVED_TTS_PROVIDER,
        ttsChunks: 0,
        startedAt: openerStartedIso
      };
      try {
        const listenerRoster = rosterForListener(fantasy, request.group.listener.rosterId);
        this.logger.info(
          {
            listenerName: request.group.listener.name,
            listenerRosterId: request.group.listener.rosterId,
            listenerRosterTeamName: listenerRoster?.teamName,
            starterCount: listenerRoster?.starters.length ?? 0,
            starters: listenerRoster?.starters.map((s) => `${s.name} (${s.position}, ${s.proTeam})`),
            hostId: "theo"
          },
          "Show opener context"
        );
        const opener = createListenerOpener({
          league: fantasy,
          game: game.currentPlay,
          group: request.group,
          listenerRoster: listenerRoster
            ? {
                ownerName: listenerRoster.ownerName,
                teamName: listenerRoster.teamName,
                starters: listenerRoster.starters
              }
            : undefined,
          startedAt: openerStarted,
          observation: {
            id: "opener-obs",
            source: "stream-url",
            summary: "Show open",
            confidence: 1,
            observedAt: new Date().toISOString(),
            latencyMs: 0,
            usedFrame: false
          }
        });
        // Producer step for the opener. Same shape as the per-tick
        // producer call, but with `openerMode: true` — the producer
        // emits opener-specific beats (frame the listener / pull a
        // starter / hand off into live action) instead of the play
        // cascade. When it succeeds, the directive replaces the raw
        // opener prompt with the focused directive prompt; when it
        // throws, we drop the directive and the host LLM falls back
        // to the legacy opener path so a producer outage never blanks
        // the show's first 30 seconds.
        const openerDraftInput = {
          play: opener.play,
          observation: opener.observation,
          impacts: [],
          moment: opener.moment,
          group: request.group,
          news: [],
          recentCommentary: [],
          hostId: opener.hostId,
          listenerRoster,
          odds,
          analytics,
          slateContext: this.slateContext,
          fallbackText: opener.text
        };
        let openerDirective: Awaited<ReturnType<typeof producerAgent.produce>> | undefined;
        try {
          openerDirective = await producerAgent.produce({
            draft: openerDraftInput,
            priorShowState: "",
            openerMode: true
          });
          openerSummary.producer =
            "lastProducerId" in producerAgent && typeof producerAgent.lastProducerId === "string" && producerAgent.lastProducerId
              ? producerAgent.lastProducerId
              : producerAgent.id;
          openerSummary.producerBeats = openerDirective.beats.map((b) => b.sourceKind);
        } catch (error) {
          this.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Producer failed for opener — falling back to legacy opener prompt"
          );
          openerSummary.producer = `${producerAgent.id}:error`;
        }
        const openerLines = await commentaryProvider.draft({
          ...openerDraftInput,
          kind: "opener",
          priorContext: request.priorContext,
          directive: openerDirective
        });
        opener.lines = openerLines;
        opener.text = joinDialogueLines(openerLines);
        opener.hostId = openerLines[0].hostId;
        // Surface producer beats on the opener commentary so the
        // transcript chips render the same way they do for tick
        // commentary. Absent when the producer threw and we fell
        // back to the legacy opener prompt.
        opener.producerBeats = openerDirective?.beats.map((b) => b.sourceKind);
        opener.latency.endToEndMs = Math.round(performance.now() - openerStarted);
        // Closing-handoff carry-forward. If the opener ends with a
        // host addressing another by name ("Maya, math it up."), the
        // next tick's lead is forced to that host so the addressed
        // handoff actually gets answered. Without this, rhetorical
        // handoffs strand across block boundaries.
        const openerHandoff = detectClosingHandoff(openerLines);
        if (openerHandoff) {
          this.pendingNextHostId = openerHandoff;
        }
        this.recentCommentary = [opener.text];
        this.recentHostIds = [opener.hostId];
        this.budget.recordCommentary(opener.text);
        this.queue.push({ type: "commentary", commentary: opener });
        this.lastCommentaryAtMs = Date.now();
        openerSummary.turnId = opener.id;
        openerSummary.leadHostId = opener.hostId;
        openerSummary.finalHostIds = openerLines.map((l) => l.hostId);
        openerSummary.lineCount = openerLines.length;
        openerSummary.lines = openerLines.map((l) => ({ hostId: l.hostId, text: l.text }));
        openerSummary.commentaryProvider = commentaryProviderLabel();
        const chainErrors = realCommentaryProvider instanceof CommentaryProviderChain
          ? realCommentaryProvider.lastTurnErrors
          : [];
        if (chainErrors.length > 0) {
          openerSummary.errorReason = `${chainErrors[0].providerId}: ${chainErrors[0].message.slice(0, 120)}`;
        }
        if (request.ttsEnabled) {
          this.budget.recordTts(opener.text);
          if (this.budget.shouldDegradeTts()) {
            this.logger.warn(
              { snapshot: this.budget.snapshot() },
              "Show TTS budget exceeded; degrading to mock"
            );
            this.queue.push({
              type: "status",
              message: "TTS budget reached — silent for the rest of the show.",
              level: "warn"
            });
          }
          // Per-line streaming TTS, parallelized across lines but
          // emitted in line order via streamDialogueAudio. First
          // audio reaches the listener in ~300ms (flash WS first
          // byte) regardless of how many lines the opener has.
          for await (const audio of selectTTSStrategy(
            openerLines,
            opener.id,
            ttsProvider,
            () => this.stopped,
            this.logger
          )) {
            if (this.stopped) break;
            opener.latency.ttsFirstAudioMs ??= audio.latencyMs;
            const enriched = enrichChunkWithMentionCues(audio, openerLines, {
              starters: listenerRoster?.starters,
              game,
              markets: undefined,
              listenerName: request.group.listener?.name
            });
            this.queue.push({ type: "tts", audio: enriched });
            openerSummary.ttsChunks = (openerSummary.ttsChunks ?? 0) + 1;
          }
          openerSummary.ttsFirstByteMs = opener.latency.ttsFirstAudioMs;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        openerSummary.errorReason = `opener-threw: ${msg.slice(0, 160)}`;
        this.logger.warn(
          { err: msg },
          "Show opener failed; continuing into live ticks"
        );
      } finally {
        openerSummary.totalMs = Math.round(performance.now() - openerStarted);
        recordTurn({
          turnId: openerSummary.turnId ?? `opener-${Date.now()}`,
          kind: "opener",
          sessionId: openerSummary.sessionId ?? "",
          engineId: openerSummary.engineId ?? this.id,
          leadHostId: openerSummary.leadHostId ?? "theo",
          finalHostIds: openerSummary.finalHostIds ?? [],
          lineCount: openerSummary.lineCount ?? 0,
          commentaryProvider: openerSummary.commentaryProvider ?? "(unknown)",
          ttsEnabled: openerSummary.ttsEnabled ?? false,
          ttsProvider: openerSummary.ttsProvider,
          ttsChunks: openerSummary.ttsChunks ?? 0,
          ttsFirstByteMs: openerSummary.ttsFirstByteMs,
          totalMs: openerSummary.totalMs ?? 0,
          errorReason: openerSummary.errorReason,
          startedAt: openerSummary.startedAt ?? openerStartedIso,
          producer: openerSummary.producer,
          producerBeats: openerSummary.producerBeats,
          lines: openerSummary.lines,
          // Stamp every opener summary with the active commentary
          // prompt version. See buildTickSummary for rationale.
          promptVersion: openerSummary.promptVersion ?? getCommentaryPromptVersion()
        });
      }

      // Game-pivot consumer. switchGame() (public method) sets
      // `this.pendingGameSwitch`; this helper drains it at the top
      // of every tick. When a switch is pending it:
      //   1. Captures from/to game summaries (prior gameState for
      //      "from", new gameState for "to").
      //   2. Drafts ONE producer-driven handoff turn — the lead host
      //      bridges out of the prior game and tees up the new one.
      //   3. TTS-streams the handoff turn so the listener actually
      //      hears the transition before tick fetches resume.
      //   4. Rebuilds `sportsProvider` against the new gameId and
      //      resets per-game state so the next tick fetches against
      //      the new game.
      // Per-show state (rapport, claims, recentCommentary, eval ring,
      // arc planner) is intentionally PRESERVED — the broadcast is
      // continuous, only the play feed underneath has changed.
      const consumePendingSwitch = async (): Promise<void> => {
        const pending = this.pendingGameSwitch;
        if (!pending) return;
        this.pendingGameSwitch = undefined;
        const pivotStarted = performance.now();
        const pivotStartedIso = new Date().toISOString();
        let pivotSummary: Partial<TurnSummary> = {
          kind: "play",
          sessionId: this.sessionId,
          engineId: this.id,
          leadHostId: "theo",
          finalHostIds: [],
          lineCount: 0,
          commentaryProvider: "(unknown)",
          ttsEnabled: request.ttsEnabled,
          ttsProvider: config.RESOLVED_TTS_PROVIDER,
          ttsChunks: 0,
          startedAt: pivotStartedIso
        };
        // Build the from/to context BEFORE we swap providers — the
        // "from" summary is the game we're leaving (lastGameSummary
        // captured during prior ticks), the "to" summary is fetched
        // off the new sportsProvider.
        const fromSummary = lastGameSummary ?? "the previous game we were watching";
        request.sportsGameId = pending.sportsGameId;
        request.video = pending.video;
        if (pending.latestFrame) request.latestFrame = pending.latestFrame;
        sportsProvider = createSportsDataProvider(pending.sportsGameId);
        // Reset per-game state — different game has different play ids,
        // different markets, different pregame angle rotation.
        this.lastSeenPlayId = undefined;
        this.duplicatePlayCount = 0;
        this.pregameAngleIndex = 0;
        this.lastMarketsForSwing = [];
        hasResolvedClaims = false;
        let toSummary = pending.toSummaryHint;
        let newGameStateForPivot: SportsGameState | undefined;
        try {
          newGameStateForPivot = await sportsProvider.getGameState();
          toSummary = `${newGameStateForPivot.awayTeam} at ${newGameStateForPivot.homeTeam}${
            newGameStateForPivot.status === "live" ? " — already underway" : newGameStateForPivot.status === "scheduled" ? " — about to tip" : ""
          }`;
        } catch (error) {
          this.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Game-pivot: failed to fetch new gameState — falling back to hint"
          );
        }
        const finalToSummary = toSummary ?? "the next game on the slate";

        // Draft the handoff via the same producer + commentary chain
        // the opener and tick paths use — handoffs benefit from the
        // same fallbacks (LLM producer → local producer; LLM host →
        // local host) so a vendor outage never blanks the pivot.
        const pivotPlay: SportsPlay = newGameStateForPivot?.currentPlay ?? {
          id: `pivot-${Date.now()}`,
          type: "other",
          excitement: 1,
          clock: "—",
          period: { number: 0, kind: "quarter", shortDetail: "Pivot" },
          possession: "—",
          headline: `Pivot to ${finalToSummary}`,
          description: "Mid-show handoff",
          playerIds: [],
          team: newGameStateForPivot?.homeTeam ?? "—",
          score: newGameStateForPivot?.currentPlay?.score ?? { away: 0, home: 0 },
          occurredAt: new Date().toISOString()
        };
        const pivotObservation: VideoObservation = {
          id: `pivot-obs-${Date.now()}`,
          source: "stream-url",
          summary: "Mid-show pivot",
          confidence: 1,
          observedAt: new Date().toISOString(),
          latencyMs: 0,
          usedFrame: false
        };
        const pivotDraftInput = {
          play: pivotPlay,
          observation: pivotObservation,
          impacts: [],
          moment: { priority: "notable" as const, headline: "Game pivot", summary: "switch", reasons: ["game-pivot"], targetFriendIds: [], score: 1 },
          group: request.group,
          news: [],
          recentCommentary: this.recentCommentary,
          listenerRoster: rosterForListener(fantasy, request.group.listener.rosterId),
          fallbackText: `Alright — that's it for ${fromSummary}. Over to ${finalToSummary}.`
        };
        let pivotDirective: Awaited<ReturnType<typeof producerAgent.produce>> | undefined;
        try {
          pivotDirective = await producerAgent.produce({
            draft: pivotDraftInput,
            priorShowState,
            gamePivotMode: { fromSummary, toSummary: finalToSummary },
            rapportState: rapportTracker.state()
          });
          priorShowState = pivotDirective.showState;
          pivotSummary.producer =
            "lastProducerId" in producerAgent && typeof producerAgent.lastProducerId === "string" && producerAgent.lastProducerId
              ? producerAgent.lastProducerId
              : producerAgent.id;
          pivotSummary.producerBeats = pivotDirective.beats.map((b) => b.sourceKind);
        } catch (error) {
          this.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Game-pivot producer failed — falling back to legacy host prompt"
          );
          pivotSummary.producer = `${producerAgent.id}:error`;
        }
        let pivotLines: DialogueLine[];
        try {
          pivotLines = await commentaryProvider.draft({
            ...pivotDraftInput,
            kind: "play",
            directive: pivotDirective
          });
        } catch (error) {
          this.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Game-pivot commentary draft failed — using local fallback line"
          );
          pivotLines = [{ hostId: "theo", text: pivotDraftInput.fallbackText }];
          pivotSummary.errorReason = `pivot-draft-failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`;
        }
        const pivotCommentary: LivecastCommentary = {
          id: crypto.randomUUID(),
          kind: "play",
          hostId: pivotLines[0]?.hostId ?? "theo",
          text: joinDialogueLines(pivotLines),
          lines: pivotLines,
          fantasyImpacts: [],
          moment: pivotDraftInput.moment,
          observation: pivotObservation,
          play: pivotPlay,
          createdAt: new Date().toISOString(),
          latency: { videoIngestMs: 0, modelResponseMs: 0, textGenerationMs: Math.round(performance.now() - pivotStarted), endToEndMs: 0 },
          producerBeats: pivotDirective?.beats.map((b) => b.sourceKind),
          arcPosition: "act-break"
        };
        // Carry-forward of recentCommentary so the next tick's producer
        // sees the pivot turn as part of the conversation history.
        this.recentCommentary = [pivotCommentary.text, ...this.recentCommentary].slice(0, 5);
        this.recentHostIds = [pivotCommentary.hostId, ...this.recentHostIds].slice(0, 4);
        this.budget.recordCommentary(pivotCommentary.text);
        this.queue.push({ type: "commentary", commentary: pivotCommentary });
        this.lastCommentaryAtMs = Date.now();
        // The handoff itself often ends with a forward-looking address
        // ("Maya, what's the storyline here?"); honour the carry-forward
        // so the next tick lands on the addressed host.
        const pivotHandoffHost = detectClosingHandoff(pivotLines);
        if (pivotHandoffHost) {
          this.pendingNextHostId = pivotHandoffHost;
        }
        if (request.ttsEnabled && !this.budget.shouldDegradeTts()) {
          this.budget.recordTts(pivotCommentary.text);
          for await (const audio of selectTTSStrategy(
            pivotLines,
            pivotCommentary.id,
            ttsProvider,
            () => this.stopped,
            this.logger
          )) {
            if (this.stopped) break;
            pivotCommentary.latency.ttsFirstAudioMs ??= audio.latencyMs;
            const enriched = enrichChunkWithMentionCues(audio, pivotLines, {
              starters: pivotDraftInput.listenerRoster?.starters,
              game: newGameStateForPivot,
              markets: undefined,
              listenerName: request.group.listener?.name
            });
            this.queue.push({ type: "tts", audio: enriched });
            pivotSummary.ttsChunks = (pivotSummary.ttsChunks ?? 0) + 1;
          }
          pivotSummary.ttsFirstByteMs = pivotCommentary.latency.ttsFirstAudioMs;
        }
        pivotCommentary.latency.endToEndMs = Math.round(performance.now() - pivotStarted);
        pivotSummary.turnId = pivotCommentary.id;
        pivotSummary.leadHostId = pivotCommentary.hostId;
        pivotSummary.finalHostIds = pivotLines.map((l) => l.hostId);
        pivotSummary.lineCount = pivotLines.length;
        pivotSummary.lines = pivotLines.map((l) => ({ hostId: l.hostId, text: l.text }));
        pivotSummary.commentaryProvider = commentaryProviderLabel();
        pivotSummary.totalMs = Math.round(performance.now() - pivotStarted);
        pivotSummary.arcPosition = "act-break";
        recordTurn(buildTickSummary(pivotSummary, pivotStartedIso));
        this.logger.info(
          { fromSummary, toSummary: finalToSummary, newGameId: pending.sportsGameId },
          "Game-pivot complete"
        );
      };

      const tick = async () => {
        if (this.stopped) return;
        // Listener paused — bail BEFORE any provider calls so we don't
        // burn commentary tokens, voice credits, or news provider
        // budget on chunks the listener won't hear. Engine state
        // (rapport, claims, arc planner) is preserved untouched so
        // resume picks up exactly where pause left off.
        if (this.paused) return;
        // Drain a pending game switch BEFORE any per-tick fetches —
        // the swap rebuilds sportsProvider and resets per-game state,
        // so subsequent fetches use the new game.
        await consumePendingSwitch();
        if (this.stopped) return;
        const startedAt = performance.now();
        const startedAtIso = new Date().toISOString();
        let tickSummary: Partial<TurnSummary> = {
          kind: "play",
          sessionId: this.sessionId,
          engineId: this.id,
          ttsEnabled: request.ttsEnabled,
          ttsProvider: config.RESOLVED_TTS_PROVIDER,
          ttsChunks: 0,
          startedAt: startedAtIso
        };
        let recordedAtEnd = false;
        try {
          await videoProvider.observe(request.video);
          // Fetch play + gameState first so we have BOTH teams in the
          // matchup before the news call. Previously news only saw
          // play.team (the team with possession on this play), which
          // dropped half the relevant articles — the ESPN news provider
          // would then return nothing and the chain would fall back to
          // the demo storylines ("Demo Wire", "Demo Beat").
          const [play, gameState] = await Promise.all([
            sportsProvider.nextPlay(),
            sportsProvider.getGameState()
          ]);
          // Capture the human-prose game state for the next pivot's
          // "fromSummary" — the listener may switch games at any
          // tick boundary, and the producer needs a concrete handle
          // on what we're leaving behind.
          lastGameSummary = formatGameSummary(gameState);
          // Game-end transition: when status flips to "final" for the
          // first time, fire the outcome resolver in the background.
          // Must come after the gameState fetch but before any other
          // tick work — same pattern as a side-effect side-channel.
          if (
            gameState.status === "final" &&
            !hasResolvedClaims &&
            request.picksListenerId
          ) {
            hasResolvedClaims = true;
            outcomeResolver
              .resolve({
                listenerId: request.picksListenerId,
                gameId: gameState.gameId,
                sport: gameState.sport
              })
              .then((counts) => {
                this.logger.info(
                  { ...counts, gameId: gameState.gameId, listenerId: request.picksListenerId },
                  "Outcome resolution complete"
                );
              })
              .catch((error) => {
                this.logger.warn(
                  { err: error instanceof Error ? error.message : String(error) },
                  "Outcome resolver failed"
                );
              });
          }
          // Slate-mode auto-pivot: when the current game just flipped
          // to `final` AND we have a queued slate alternative, queue
          // a switch into the next ranked game. The pivot fires at
          // the top of the NEXT tick via the same consumer the
          // public switchGame() uses — listener hears one continuous
          // broadcast across the night, not a series of restarts.
          if (
            gameState.status === "final" &&
            this.slateQueue.length > 0 &&
            !this.pendingGameSwitch
          ) {
            const next = this.slateQueue.shift()!;
            this.logger.info(
              { fromGameId: gameState.gameId, toGameId: next.id, remainingSlate: this.slateQueue.length },
              "Slate mode: auto-pivoting at game-end"
            );
            this.switchGame({
              sportsGameId: next.id,
              video: request.video,
              toSummaryHint: `${next.awayTeam} at ${next.homeTeam}`
            });
          }
          const matchupTeams = [gameState.awayTeam, gameState.homeTeam, play.team]
            .filter((team): team is string => Boolean(team));
          // Observation needs to complete BEFORE the aggregator runs
          // so vision color (extracted from observation.color[]) can
          // be fed into the aggregator's dedup pipeline alongside
          // fan/stat/wiki signals. News fetches in parallel since it
          // doesn't depend on observation.
          const [observation, news] = await Promise.all([
            modelProvider.observe({ video: request.video, play, frame: this.latestFrame }),
            newsProvider.getLatest({ playerIds: play.playerIds, teams: matchupTeams, sport: gameState.sport })
          ]);
          const visionSignals = extractVisionSignals(observation, gameState);
          const enrichmentSignals = await enrichmentAggregator
            .gather({
              game: gameState,
              activePlayId: play.id,
              deadlineMs: 1_500,
              additionalSignals: visionSignals
            })
            .catch((error) => {
              this.logger.warn(
                { err: error instanceof Error ? error.message : String(error) },
                "Enrichment gather failed — proceeding without crowd color"
              );
              return [];
            });
          tickSummary.enrichmentSignalCount = enrichmentSignals.length;
          tickSummary.enrichmentSources = Array.from(
            new Set(enrichmentSignals.map((s) => s.source))
          ).sort();
          this.queue.push({ type: "play", play, game: gameState });
          this.queue.push({ type: "observation", observation });

          // Listener nudge consumed here. One-shot: we hand it to the
          // engine, then clear so the next tick goes back to the
          // deterministic selectHost pick.
          const forcedHost = this.pendingNextHostId;
          this.pendingNextHostId = undefined;
          // W18: drain queued cues for this turn. The engine reads
          // them once and we ack the ids back so the UI can clear
          // them from the "queued" list.
          const cuesForTurn = this.pendingCues;
          this.pendingCues = [];

          // W19/W14 wiring: snapshot the relevant markets for this
          // game on every tick, compare to the last batch we sent
          // on-air, and surface a swing when one moved >5¢. Failures
          // fall through silently — markets are commentary color,
          // never a tick blocker.
          let marketsForTurn: MarketSnapshot[] = [];
          let swingForTurn: ReturnType<typeof detectMarketSwings> = undefined;
          try {
            const allMarkets = await fetchMarketSnapshots({ sports: [gameState.sport] });
            const teamIds = [
              ...teamIdentifiersFromMeta(gameState.awayTeam, gameState.awayMeta),
              ...teamIdentifiersFromMeta(gameState.homeTeam, gameState.homeMeta)
            ];
            marketsForTurn = pickRelevantMarketsForGame(
              allMarkets,
              {
                sport: gameState.sport,
                teams: teamIds,
                players: play.playerIds
              },
              6
            );
            swingForTurn = detectMarketSwings(marketsForTurn, this.lastMarketsForSwing);
            this.lastMarketsForSwing = marketsForTurn;
            if (swingForTurn) {
              // Tell the UI which ticker row the host is about to lead
              // with so the markets overlay can flash that row in sync
              // with the call.
              this.queue.push({
                type: "market-swing",
                source: swingForTurn.market.source,
                externalId: swingForTurn.market.externalId,
                title: swingForTurn.market.title,
                outcome: swingForTurn.market.outcomeLabel,
                fromCents: swingForTurn.market.yesPriceCents - swingForTurn.deltaCents,
                toCents: swingForTurn.market.yesPriceCents,
                deltaCents: swingForTurn.deltaCents,
                direction: swingForTurn.direction
              });
            }
          } catch (error) {
            this.logger.warn(
              { err: error instanceof Error ? error.message : String(error) },
              "Markets fetch failed for tick — proceeding without market color"
            );
          }

          // Picks: compute the listener's parlay state for THIS game
          // and surface a one-line hostHint to the commentary prompt.
          // Only does work when the listener has actually locked an
          // entry — no-op otherwise so unauthenticated listeners pay
          // nothing for the feature.
          let pickContextForTurn: string | undefined;
          if (request.picksListenerId) {
            try {
              const entry = getEntry(request.picksListenerId, gameState.gameId);
              if (entry) {
                const wants = entry.lockedProps.map((prop) => ({
                  playerName: prop.playerName,
                  statType: prop.statType
                }));
                // Demo gameIds have no ESPN box score — pickContext
                // stays undefined and the entry shows as "queued".
                if (!gameState.gameId.startsWith("demo-")) {
                  const { stats, gameCompleted } = await fetchLiveStats({
                    gameId: gameState.gameId,
                    sport: gameState.sport,
                    wants
                  });
                  const status = computeEntryStatus({ entry, stats, settle: gameCompleted });
                  pickContextForTurn = status.hostHint;
                }
              }
            } catch (error) {
              this.logger.warn(
                { err: error instanceof Error ? error.message : String(error) },
                "Picks status fetch failed for tick — proceeding without pick context"
              );
            }
          }

          // Live (in-show) snap picks. Separate flow from the parlay
          // hostHint above — the engine reads BOTH so the model gets
          // the "what's the listener watching" + "what did they just
          // lock 30 seconds ago" signals in parallel. Append rather
          // than overwrite so the parlay context isn't lost when a
          // live pick is also active.
          if (request.picksListenerId) {
            try {
              const nowMs = Date.now();
              resolveExpiredEntries({ game: gameState, now: nowMs });
              refreshActivePicks({ game: gameState, now: nowMs });
              const liveHint = buildLivePicksHostHint({
                listenerId: request.picksListenerId,
                gameId: gameState.gameId,
                now: nowMs
              });
              if (liveHint) {
                pickContextForTurn = pickContextForTurn
                  ? `${pickContextForTurn} ${liveHint}`
                  : liveHint;
              }
            } catch (error) {
              this.logger.warn(
                { err: error instanceof Error ? error.message : String(error) },
                "Live picks tick failed — proceeding without live pick context"
              );
            }
          }

          const commentary = createLivecastCommentary({
            league: fantasy,
            play,
            observation,
            group: request.group,
            news,
            startedAt,
            recentCommentary: this.recentCommentary,
            recentHostIds: this.recentHostIds,
            forceHostId: forcedHost
          });

          // Duplicate-play guard: ESPN's pre-game / scheduled
          // scoreboard returns the same placeholder play (id ending
          // in `-pre-0-0.0`) every tick until kickoff. There's
          // literally nothing new to commentate on, and it floods
          // the client UI with React duplicate-key warnings when
          // the play array stores them. Skip without counting
          // toward the routine cap — duplicates are not "minor
          // plays we're holding back," they're a missing data
          // signal. Listener cues / market swings always escape
          // the skip because they carry NEW information the
          // listener wants to hear about.
          //
          // Capped so a long pre-game stretch doesn't go silent
          // forever: past MAX_DUPLICATE_SKIPS we force a turn so
          // the hosts riff on whatever non-play context is fresh
          // (odds, markets, news, lineup outlook). Repetitive is
          // better than mute.
          const MAX_DUPLICATE_SKIPS = 4;
          /** Every Nth duplicate emits a banter beat instead of skipping.
           *  N=2 means: skip the 1st duplicate, banter on the 2nd, skip
           *  the 3rd, banter on the 4th. Keeps the silence broken without
           *  yelling over the listener every tick. */
          const BANTER_EVERY_N_DUPLICATES = 2;
          const hasUserSignal = cuesForTurn.length > 0 || !!swingForTurn;
          const isDuplicate = play.id === this.lastSeenPlayId;
          let banterMode = false;
          if (isDuplicate && !hasUserSignal) {
            this.duplicatePlayCount += 1;
            const shouldBanter =
              this.duplicatePlayCount % BANTER_EVERY_N_DUPLICATES === 0 &&
              this.duplicatePlayCount < MAX_DUPLICATE_SKIPS;
            if (shouldBanter) {
              banterMode = true;
              this.logger.info(
                { playId: play.id, duplicates: this.duplicatePlayCount },
                "Filling duplicate-play silence with a banter beat"
              );
            } else if (this.duplicatePlayCount < MAX_DUPLICATE_SKIPS) {
              this.logger.info(
                { playId: play.id, type: play.type, duplicates: this.duplicatePlayCount },
                "Skipping duplicate play (no new game state since last tick)"
              );
              return;
            }
            // Past the cap: fall through to a normal forced turn.
          }
          if (!isDuplicate) {
            this.lastSeenPlayId = play.id;
            this.duplicatePlayCount = 0;
          } else if (!banterMode) {
            // Forced through after the cap — keep counting so the
            // next true play change still resets cleanly, but log
            // that we punched through.
            this.logger.info(
              { playId: play.id, duplicates: this.duplicatePlayCount },
              "Forcing turn after duplicate-play cap to avoid extended silence"
            );
            this.duplicatePlayCount = 0;
          }

          // Routine-play skipping is intentionally NOT done. A
          // sports show is fundamentally different from a NotebookLM
          // overview: every play is a new piece of game state the
          // listener wants someone to react to, even if its
          // "priority" score is low. Staying on the previous topic
          // for 2-3 ticks felt podcast-like in theory but in
          // practice produced long stretches of silence. The
          // duplicate-play guard above is the right floor — the
          // engine only stays quiet when there's literally no new
          // game state to react to.

          // Pregame angle rotation: each forced duplicate-play tick
          // gets a fresh angle hint so hosts don't loop the same
          // pre-tip talking points. We only emit a hint while the
          // play id is the placeholder `-pre-` form — once real
          // plays land, the play itself is the anchor.
          const isPregamePlaceholder = /-pre-/.test(play.id);
          const PREGAME_ANGLES = [
            "matchup math: how the teams' core strengths collide on this slate.",
            "Vegas line and total: what the book is saying about this game.",
            "the listener's personal stake — their lineup, their parlay, their bubble player.",
            "a specific news headline from the feed (injury, lineup, weather, narrative).",
            "starter outlook: ONE of the listener's actual starters and what they need tonight.",
            "a market swing or sharp price: what bettors moved on, and why.",
            "the friend-room angle: who in the league has the most at stake."
          ];
          let pregameAngleHint: string | undefined;
          if (isPregamePlaceholder) {
            pregameAngleHint = PREGAME_ANGLES[this.pregameAngleIndex % PREGAME_ANGLES.length];
            this.pregameAngleIndex += 1;
          } else {
            // Reset rotation so the next pregame stretch (e.g. halftime
            // placeholder) starts fresh rather than mid-cycle.
            this.pregameAngleIndex = 0;
          }

          const textStart = performance.now();
          // The draft input is the same shape whether the producer
          // runs or not — the producer just decides whether to add a
          // `directive` so the host LLM uses the focused prompt path.
          const draftInput = {
            play,
            observation,
            impacts: commentary.fantasyImpacts,
            moment: commentary.moment,
            group: request.group,
            news,
            recentCommentary: this.recentCommentary,
            hostId: commentary.hostId,
            listenerRoster: rosterForListener(fantasy, request.group.listener.rosterId),
            odds,
            analytics,
            listenerCues: cuesForTurn,
            markets: marketsForTurn.length > 0 ? marketsForTurn : undefined,
            marketSwing: swingForTurn,
            pickContext: pickContextForTurn,
            pregameAngleHint,
            enrichmentSignals,
            fallbackText: commentary.text
          };
          // Producer step. Runs synchronously before the host LLM —
          // when it succeeds, the directive replaces all the raw
          // fields in the host prompt; when it throws, we drop the
          // directive and the host LLM falls back to the legacy
          // raw-field path (so a producer outage never blanks the show).
          // Pull rolling eval snapshot once and feed it to BOTH
          // the arc planner (pacing override on a stayTuned slump)
          // and the producer (corrective beat selection on low
          // specificity / friction / callbacks). Cheap — synchronous
          // read of an in-memory ring buffer.
          const evalSnapshot = getRecentEvalSnapshot(6);
          // Advance the arc planner with this tick's game state +
          // moment so its directive reflects the new dramatic
          // position before the producer reads it.
          const arcDirective = arcPlanner.tick({ game: gameState, moment: commentary.moment, evalSnapshot });
          tickSummary.arcPosition = arcDirective.position;
          const rapportSnapshot = rapportTracker.state();
          let directive: Awaited<ReturnType<typeof producerAgent.produce>> | undefined;
          try {
            directive = await producerAgent.produce({
              draft: draftInput,
              priorShowState,
              arcDirective,
              evalSnapshot,
              rapportState: rapportSnapshot,
              banterMode
            });
            priorShowState = directive.showState;
            // Prefer the chain's per-call resolution (the LLM
            // producer that actually answered) over the surface
            // chain id — without this, every turn looks like
            // "producer-chain" and we can't tell whether Haiku ever
            // ran vs always falling through to local.
            tickSummary.producer =
              "lastProducerId" in producerAgent && typeof producerAgent.lastProducerId === "string" && producerAgent.lastProducerId
                ? producerAgent.lastProducerId
                : producerAgent.id;
            tickSummary.producerBeats = directive.beats.map((b) => b.sourceKind);
          } catch (error) {
            this.logger.warn(
              { err: error instanceof Error ? error.message : String(error) },
              "Producer failed — falling back to raw-field host prompt"
            );
            tickSummary.producer = `${producerAgent.id}:error`;
          }
          const dialogueLines = await commentaryProvider.draft({
            ...draftInput,
            directive
          });
          commentary.lines = dialogueLines;
          commentary.text = joinDialogueLines(dialogueLines);
          commentary.hostId = dialogueLines[0].hostId;
          // Surface producer + arc context to the client so the
          // transcript can render source chips + an act marker.
          commentary.producerBeats = directive?.beats.map((b) => b.sourceKind);
          commentary.arcPosition = arcDirective.position;
          // Closing-handoff carry-forward (see opener path above).
          // Setting pendingNextHostId here overrides the deterministic
          // selectHost rotation for the NEXT tick only — the host
          // addressed in the final turn becomes the next lead.
          const tickHandoff = detectClosingHandoff(dialogueLines);
          if (tickHandoff) {
            this.pendingNextHostId = tickHandoff;
          }
          commentary.latency.textGenerationMs = Math.round(performance.now() - textStart);
          commentary.latency.endToEndMs = Math.round(performance.now() - startedAt);
          tickSummary.turnId = commentary.id;
          tickSummary.leadHostId = commentary.hostId;
          tickSummary.finalHostIds = dialogueLines.map((l) => l.hostId);
          tickSummary.lineCount = dialogueLines.length;
          tickSummary.lines = dialogueLines.map((l) => ({ hostId: l.hostId, text: l.text }));
          tickSummary.commentaryProvider = commentaryProviderLabel();
          tickSummary.textGenerationMs = commentary.latency.textGenerationMs;
          const tickChainErrors = realCommentaryProvider instanceof CommentaryProviderChain
            ? realCommentaryProvider.lastTurnErrors
            : [];
          if (tickChainErrors.length > 0) {
            tickSummary.errorReason = `${tickChainErrors[0].providerId}: ${tickChainErrors[0].message.slice(0, 120)}`;
          }
          // Track usage before TTS so the cap kicks in before we burn
          // ElevenLabs minutes on a hung loop.
          this.budget.recordCommentary(commentary.text);
          if (this.budget.shouldDegradeCommentary()) {
            this.logger.warn(
              { snapshot: this.budget.snapshot() },
              "Show commentary budget exceeded; degrading to local templates"
            );
            this.queue.push({
              type: "status",
              message: "Commentary budget reached — switching to local templates.",
              level: "warn"
            });
          }
          this.recentCommentary = [commentary.text, ...this.recentCommentary].slice(0, 5);
          // Fire-and-forget eval. Doesn't await — adds zero latency
          // to the listener-facing tick. Failures are isolated; the
          // eval ring buffer just won't get an entry for this turn.
          const evalInput = {
            turnId: commentary.id,
            text: commentary.text,
            recentCommentary: [...this.recentCommentary].slice(1, 5), // exclude this turn
            momentContext: commentary.moment?.headline ?? play.headline ?? "live play",
            availableSources: Array.from(
              new Set([
                ...(enrichmentSignals.length > 0 ? enrichmentSignals.map((s) => s.source) : []),
                ...(news.length > 0 ? ["news"] : []),
                ...(marketsForTurn.length > 0 ? ["markets"] : []),
                ...(cuesForTurn.length > 0 ? ["listener"] : []),
                "play"
              ])
            )
          };
          evaluator
            .evaluate(evalInput)
            .then((judgement) => recordEvaluation(judgement))
            .catch((error) => {
              this.logger.warn(
                { err: error instanceof Error ? error.message : String(error), turnId: commentary.id },
                "Evaluator failed for turn"
              );
            });
          // Cross-show memory: extract claims from this turn,
          // attribute them to the listener, and persist for future
          // shows to pull as callback signals. Only fires when we
          // know who the listener is — claims for an anonymous
          // session would be unattributable.
          let extractedClaims: Awaited<ReturnType<typeof claimsExtractor.extract>> = [];
          if (request.picksListenerId) {
            try {
              extractedClaims = await claimsExtractor.extract({
                listenerId: request.picksListenerId,
                hostId: commentary.hostId,
                text: commentary.text,
                playPlayerIds: play.playerIds,
                teams: matchupTeams,
                sourceShowId: this.id,
                capturedAt: new Date().toISOString()
              });
            } catch (error) {
              this.logger.warn(
                { err: error instanceof Error ? error.message : String(error), turnId: commentary.id },
                "Claims extractor failed for turn"
              );
            }
            // Persist asynchronously — don't block the rapport
            // tracker update or the next tick's setup on Upstash
            // latency. Sequential awaits inside the promise so we
            // don't race on the single-key-per-listener layout.
            void (async () => {
              try {
                for (const claim of extractedClaims) await claimsStore.save(claim);
              } catch (error) {
                this.logger.warn(
                  { err: error instanceof Error ? error.message : String(error) },
                  "Claims store save failed"
                );
              }
            })();
          }
          // Update the rapport tracker for THIS turn — runs whether
          // or not we have a listener id. Feeds extracted claims (when
          // present) into newThreads so the next tick's producer can
          // reach for them as callbacks within the same show.
          rapportTracker.update({
            turnId: commentary.id,
            leadHostId: commentary.hostId,
            dialogue: commentary.lines,
            shippedAt: new Date().toISOString(),
            newThreads: extractedClaims.map((c) => ({
              id: c.id,
              text: c.text,
              hostId: c.hostId
            }))
          });
          this.recentHostIds = [...this.recentHostIds, commentary.hostId].slice(-5);
          this.queue.push({ type: "commentary", commentary });
          this.lastCommentaryAtMs = Date.now();
          if (cuesForTurn.length > 0) {
            this.queue.push({
              type: "cue-ack",
              cueIds: cuesForTurn.map((c) => c.id),
              commentaryId: commentary.id
            });
          }

          if (request.ttsEnabled) {
            this.budget.recordTts(commentary.text);
            if (this.budget.shouldDegradeTts()) {
              this.logger.warn(
                { snapshot: this.budget.snapshot() },
                "Show TTS budget exceeded; degrading to mock"
              );
              this.queue.push({
                type: "status",
                message: "TTS budget reached — silent for the rest of the show.",
                level: "warn"
              });
            }
            // Per-line streaming TTS, parallelized across lines but
            // emitted in line order via streamDialogueAudio.
            for await (const audio of selectTTSStrategy(
              commentary.lines,
              commentary.id,
              ttsProvider,
              () => this.stopped,
              this.logger
            )) {
              if (this.stopped) break;
              commentary.latency.ttsFirstAudioMs ??= audio.latencyMs;
              const enriched = enrichChunkWithMentionCues(audio, commentary.lines, {
                starters: rosterForListener(fantasy, request.group.listener.rosterId)?.starters,
                game,
                markets: marketsForTurn,
                listenerName: request.group.listener?.name
              });
              this.queue.push({ type: "tts", audio: enriched });
              tickSummary.ttsChunks = (tickSummary.ttsChunks ?? 0) + 1;
            }
            tickSummary.ttsFirstByteMs = commentary.latency.ttsFirstAudioMs;
          }
          tickSummary.totalMs = Math.round(performance.now() - startedAt);
          recordTurn(buildTickSummary(tickSummary, startedAtIso));
          recordedAtEnd = true;
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Livecast tick failed.";
          tickSummary.errorReason = `tick-threw: ${msg.slice(0, 160)}`;
          this.queue.push({
            type: "error",
            message: redactSecret(msg)
          });
        } finally {
          // Only record if we didn't already record at the happy-path
          // boundary. The duplicate-skip early-return path doesn't
          // produce a turn — no commentary, no TTS — so we skip the
          // summary too. Recording every skip would bloat the buffer
          // and bury the real turns we want to see.
          if (!recordedAtEnd && tickSummary.errorReason) {
            tickSummary.totalMs = Math.round(performance.now() - startedAt);
            recordTurn(buildTickSummary(tickSummary, startedAtIso));
          }
        }
      };

      await tick();
      if (!this.stopped) {
        this.tickTimer = setInterval(() => {
          void tick();
        // 25s tick default lines up with the Text-to-Dialogue turn shape:
        // 2-3 turns × ~30-60 words each = ~20-30s of speech per tick,
        // plus a beat for the audio asset to generate (~2-5s) and a
        // small breathing-room buffer. Shorter cadences overlap audio
        // across ticks and the queue grows unbounded; longer feels slow.
        // Listeners can still bias faster/slower via cadenceMs.
        }, request.cadenceMs ?? 25000);
        this.healthTimer = setInterval(() => {
          getHealth()
            .then((healthSnapshot) => this.queue.push({ type: "health", health: healthSnapshot }))
            .catch((error) =>
              this.logger.warn(
                { err: error instanceof Error ? error.message : String(error) },
                "Periodic health check failed"
              )
            );
        }, 15000);
      }
    } catch (error) {
      this.queue.push({
        type: "error",
        message: redactSecret(error instanceof Error ? error.message : "Unable to start livecast.")
      });
    }
  }
}
