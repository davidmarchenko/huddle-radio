import type {
  ClientServerEvent,
  GameOdds,
  HostId,
  ListenerCue,
  LivecastRequest,
  PlayerSeasonStats,
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
import { MockTTSProvider, ElevenLabsTTSProvider } from "../providers/ttsProviders";
import { UserVideoProvider } from "../providers/userVideoProvider";
import { config } from "./config";
import { fetchMarketSnapshots, pickRelevantMarketsForGame } from "./marketsProvider";
import { detectMarketSwings } from "../providers/commentaryPrompts";
import { redactSecret } from "./redactSecret";
import {
  createFantasyProvider,
  createSportsDataProvider,
  createModelProvider,
  buildHostVoiceMap,
  getActiveProviders,
  getHealth
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

  constructor(options: { id?: string; logger?: ShowEngineLogger } = {}) {
    this.id = options.id ?? `show-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.logger = options.logger ?? NOOP_LOGGER;
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

    const fantasyProvider = createFantasyProvider(request.providerMode, request.customLeague);
    const sportsProvider = createSportsDataProvider(request.sportsDataMode, request.sportsGameId);
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
    const commentaryProvider = {
      draft: (input: Parameters<typeof realCommentaryProvider.draft>[0]) => {
        incrementCounter("commentaryRequests");
        return budget.isCommentaryDegraded()
          ? localCommentaryProvider.draft(input)
          : realCommentaryProvider.draft(input);
      }
    };

    const videoProvider = new UserVideoProvider();
    const realTtsProvider =
      config.RESOLVED_TTS_PROVIDER === "elevenlabs"
        ? new ElevenLabsTTSProvider(
            config.ELEVENLABS_API_KEY,
            config.ELEVENLABS_VOICE_ID,
            config.RESOLVED_ELEVENLABS_MODEL_ID,
            buildHostVoiceMap()
          )
        : new MockTTSProvider();
    const mockTtsProvider = new MockTTSProvider();
    // Serialize TTS requests per-engine: ElevenLabs subscriptions cap
    // concurrent requests (the demo plan is 3). With v3 HTTP TTS
    // taking 1-3s and the engine ticking every 5s, back-to-back
    // commentary turns overlap. The lock makes turn N+1 wait for
    // turn N's audio to finish before kicking off the next API
    // call, keeping us at concurrency 1 from this engine and
    // leaving the rest of the quota for other sessions.
    let ttsLock: Promise<void> = Promise.resolve();
    const ttsProvider = {
      async *synthesize(input: Parameters<typeof realTtsProvider.synthesize>[0]) {
        incrementCounter("ttsRequests");
        const previous = ttsLock;
        let release!: () => void;
        ttsLock = new Promise<void>((resolve) => { release = resolve; });
        try {
          await previous;
          const provider = budget.isTtsDegraded() ? mockTtsProvider : realTtsProvider;
          for await (const chunk of provider.synthesize(input)) {
            yield chunk;
          }
        } finally {
          release();
        }
      }
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
        providers: getActiveProviders(request.customLeague, request.providerMode, request.sportsDataMode)
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
      try {
        const openerStarted = performance.now();
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
        opener.text = await commentaryProvider.draft({
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
        opener.latency.endToEndMs = Math.round(performance.now() - openerStarted);
        this.recentCommentary = [opener.text];
        this.recentHostIds = [opener.hostId];
        this.budget.recordCommentary(opener.text);
        this.queue.push({ type: "commentary", commentary: opener });
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
          for await (const audio of ttsProvider.synthesize({
            commentaryId: opener.id,
            text: opener.text,
            hostId: opener.hostId
          })) {
            if (this.stopped) break;
            opener.latency.ttsFirstAudioMs ??= audio.latencyMs;
            this.queue.push({ type: "tts", audio });
          }
        }
      } catch (error) {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Show opener failed; continuing into live ticks"
        );
      }

      const tick = async () => {
        if (this.stopped) return;
        try {
          const startedAt = performance.now();
          await videoProvider.observe(request.video);
          const play = await sportsProvider.nextPlay();
          const [gameState, observation, news] = await Promise.all([
            sportsProvider.getGameState(),
            modelProvider.observe({ video: request.video, play, frame: this.latestFrame }),
            newsProvider.getLatest({ playerIds: play.playerIds, teams: [play.team] })
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
            marketsForTurn = pickRelevantMarketsForGame(
              allMarkets,
              {
                sport: gameState.sport,
                teams: [gameState.awayTeam, gameState.homeTeam],
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
          const textStart = performance.now();
          commentary.text = await commentaryProvider.draft({
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
          commentary.latency.textGenerationMs = Math.round(performance.now() - textStart);
          commentary.latency.endToEndMs = Math.round(performance.now() - startedAt);
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
            for await (const audio of ttsProvider.synthesize({
              commentaryId: commentary.id,
              text: commentary.text,
              hostId: commentary.hostId
            })) {
              if (this.stopped) break;
              commentary.latency.ttsFirstAudioMs ??= audio.latencyMs;
              this.queue.push({ type: "tts", audio });
            }
          }
        } catch (error) {
          this.queue.push({
            type: "error",
            message: redactSecret(error instanceof Error ? error.message : "Livecast tick failed.")
          });
        }
      };

      await tick();
      if (!this.stopped) {
        this.tickTimer = setInterval(() => {
          void tick();
        }, request.cadenceMs ?? 5000);
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
