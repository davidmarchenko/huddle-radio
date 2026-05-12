import type {
  ClientServerEvent,
  DialogueLine,
  GameOdds,
  HostId,
  ListenerCue,
  LivecastRequest,
  PlayerSeasonStats,
  TTSAudioChunk,
  VideoFrameSnapshot,
  MarketSnapshot
} from "../shared/contracts";
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
import { detectMarketSwings, joinDialogueLines } from "../providers/commentaryPrompts";
import { redactSecret } from "./redactSecret";
import {
  createFantasyProvider,
  createSportsDataProvider,
  createModelProvider,
  buildHostVoiceMap,
  createTTSProvider,
  deriveSportsLabelMode,
  getActiveProviders,
  getHealth,
  resolveSportsSource
} from "./showFactories";
import { AsyncEventQueue } from "./asyncEventQueue";

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
    startedAt: partial.startedAt ?? startedAtIso
  };
}

const NOOP_LOGGER: ShowEngineLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

export class ShowEngine {
  readonly id: string;

  private readonly queue = new AsyncEventQueue<ClientServerEvent>();
  private readonly budget = new ShowUsageBudget();
  private readonly logger: ShowEngineLogger;

  private stopped = false;
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
  /** Session id assigned by the route handler post-construction. Stamped on turn summaries
   *  so the diagnostics endpoint can group by show. Empty until setSessionId fires. */
  private sessionId = "";

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

  async start(request: LivecastRequest): Promise<void> {
    if (this.started) return;
    if (this.stopped) return;
    this.started = true;
    incrementCounter("showsStarted");

    // Sports backend is derived from the gameId prefix — see
    // resolveSportsSource. The old separate `sportsDataMode` request
    // field used to drive this and silently fell through to KC@DET when
    // the two disagreed; that whole class of bug is gone now.
    const sportsProvider = createSportsDataProvider(request.sportsGameId);
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

      // Fetch the Vegas line once at show start. Lines move on the
      // order of minutes, so refetching every tick would burn the free
      // tier. `undefined` is the no-op happy path when no key is set.
      let odds: GameOdds | undefined;
      try {
        odds = await createOddsProvider().getOdds({
          gameId: game.gameId,
          sport: game.sport,
          homeTeam: game.homeTeam,
          awayTeam: game.awayTeam
        });
      } catch (error) {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Show-start odds fetch failed"
        );
      }

      // W12: fetch advanced stats for the listener's starters once
      // at show start. Provider returns only known canonicalIds, so
      // an empty list is the no-op fallback.
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
      let analytics: PlayerSeasonStats[] = [];
      if (starterIds.length) {
        try {
          analytics = await getDefaultAdvancedStatsProvider().getPlayerSeason({
            canonicalIds: starterIds,
            sport: game.sport
          });
        } catch (error) {
          this.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Show-start advanced-stats fetch failed"
          );
        }
      }

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
        const openerLines = await commentaryProvider.draft({
          play: opener.play,
          observation: opener.observation,
          impacts: [],
          moment: opener.moment,
          group: request.group,
          news: [],
          recentCommentary: [],
          hostId: opener.hostId,
          listenerRoster,
          kind: "opener",
          priorContext: request.priorContext,
          odds,
          analytics,
          fallbackText: opener.text
        });
        opener.lines = openerLines;
        opener.text = joinDialogueLines(openerLines);
        opener.hostId = openerLines[0].hostId;
        opener.latency.endToEndMs = Math.round(performance.now() - openerStarted);
        this.recentCommentary = [opener.text];
        this.recentHostIds = [opener.hostId];
        this.budget.recordCommentary(opener.text);
        this.queue.push({ type: "commentary", commentary: opener });
        this.lastCommentaryAtMs = Date.now();
        openerSummary.turnId = opener.id;
        openerSummary.leadHostId = opener.hostId;
        openerSummary.finalHostIds = openerLines.map((l) => l.hostId);
        openerSummary.lineCount = openerLines.length;
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
            this.queue.push({ type: "tts", audio });
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
          startedAt: openerSummary.startedAt ?? openerStartedIso
        });
      }

      const tick = async () => {
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
          const matchupTeams = [gameState.awayTeam, gameState.homeTeam, play.team]
            .filter((team): team is string => Boolean(team));
          const [observation, news] = await Promise.all([
            modelProvider.observe({ video: request.video, play, frame: this.latestFrame }),
            newsProvider.getLatest({ playerIds: play.playerIds, teams: matchupTeams, sport: gameState.sport })
          ]);
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
          const hasUserSignal = cuesForTurn.length > 0 || !!swingForTurn;
          const isDuplicate = play.id === this.lastSeenPlayId;
          if (isDuplicate && !hasUserSignal && this.duplicatePlayCount < MAX_DUPLICATE_SKIPS) {
            this.duplicatePlayCount += 1;
            this.logger.info(
              { playId: play.id, type: play.type, duplicates: this.duplicatePlayCount },
              "Skipping duplicate play (no new game state since last tick)"
            );
            return;
          }
          if (!isDuplicate) {
            this.lastSeenPlayId = play.id;
            this.duplicatePlayCount = 0;
          } else {
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

          const textStart = performance.now();
          const dialogueLines = await commentaryProvider.draft({
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
            fallbackText: commentary.text
          });
          commentary.lines = dialogueLines;
          commentary.text = joinDialogueLines(dialogueLines);
          commentary.hostId = dialogueLines[0].hostId;
          commentary.latency.textGenerationMs = Math.round(performance.now() - textStart);
          commentary.latency.endToEndMs = Math.round(performance.now() - startedAt);
          tickSummary.turnId = commentary.id;
          tickSummary.leadHostId = commentary.hostId;
          tickSummary.finalHostIds = dialogueLines.map((l) => l.hostId);
          tickSummary.lineCount = dialogueLines.length;
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
              this.queue.push({ type: "tts", audio });
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
