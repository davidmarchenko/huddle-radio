import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  ActiveProviderSummary,
  ClientServerEvent,
  FantasyImportPreview,
  FantasyLeagueState,
  FrameValidationResponse,
  GameOdds,
  GroupSettings,
  ListenerCue,
  LivecastRequest,
  ProviderDiagnostics,
  ProviderHealth,
  ShowHistoryEntry,
  SportLeague,
  SportsGameOption,
  VideoFrameSnapshot
} from "../shared/contracts";
import type { ModelStackProfile } from "../shared/modelStack";
import { DemoFantasyProvider } from "../providers/demoFantasyProvider";
import { createNewsProvider, describeNewsStack } from "./createNewsProvider";
import { createOddsProvider } from "./createOddsProvider";
import { DemoSportsDataProvider } from "../providers/demoSportsDataProvider";
import { EspnFantasyProvider } from "../providers/espnFantasyProvider";
import { EspnSportsDataProvider, ESPN_SPORTS } from "../providers/espnSportsDataProvider";
import { isVideoFrameSnapshot, normalizeValidationPlay } from "./visionRequest";
import { createCommentaryProvider, describeCommentaryStack } from "./createCommentaryProvider";
import { getMetrics, incrementCounter, registerCommentaryChain, registerNewsChain, registerVisionChain } from "./metrics";
import { getDefaultShowHistoryStore, isValidListenerId } from "./showHistoryStore";
import { getDefaultYahooTokenStore } from "./yahooTokenStore";
import { buildYahooAuthUrl, exchangeYahooAuthCode, refreshYahooAccessToken } from "../providers/yahooFantasyProvider";
import { getDefaultClipStore } from "./clipStore";
import { config } from "./config";
import { getDefaultPlayerIdResolver } from "./playerIdResolver";
import { getDefaultSportsGamesCache } from "./sportsGamesCache";

const defaultGroup: GroupSettings = {
  listener: { name: "Alex", rosterId: "roster-alex", favoriteTeam: "KC" },
  tone: "pg",
  homeTeamBias: "fantasy-first",
  friends: [
    { id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex", rivalryNotes: "you are one Kelce catch away from unbearable confidence" },
    { id: "maya", name: "Maya", favoriteTeam: "DET", rosterId: "roster-maya", rivalryNotes: "do not pretend you were calm during that drive" }
  ]
};

export async function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Surface seed-load size at boot so a missing/empty playerIdMap.json
  // is obvious in the deploy logs instead of silently degrading
  // personalization.
  const resolverStats = getDefaultPlayerIdResolver().getStats();
  app.log.info({ playerIdResolver: resolverStats }, `PlayerIdResolver loaded ${resolverStats.registered} players`);

  app.get("/api/health", async () => {
    const health = await getHealth();
    return { ok: health.every((item) => item.status !== "error"), health, providers: getActiveProviders(undefined, "demo", config.SPORTS_DATA_PROVIDER) };
  });

  app.get("/api/bootstrap", async (request) => {
    const query = request.query as {
      providerMode?: "demo" | "sleeper" | "espn";
      sportsDataMode?: "demo" | "espn";
      sportsGameId?: string;
      sleeperLeagueId?: string;
      espnLeagueId?: string;
      espnSeason?: string;
      week?: string;
    };
    const fantasy = createFantasyProvider(query.providerMode, undefined);
    const sports = createSportsDataProvider(query.sportsDataMode, query.sportsGameId);
    return {
      fantasy: await fantasy.getLeagueState({
        leagueId: query.providerMode === "espn" ? query.espnLeagueId : query.sleeperLeagueId,
        week: query.week ? Number(query.week) : undefined,
        season: query.espnSeason ? Number(query.espnSeason) : undefined
      }),
      game: await sports.getGameState(),
      group: defaultGroup,
      health: await getHealth(),
      providers: getActiveProviders(undefined, query.providerMode, query.sportsDataMode)
    };
  });

  app.get("/api/fantasy/preview", async (request) => {
    const query = request.query as { providerMode?: "demo" | "sleeper" | "espn"; sleeperLeagueId?: string; espnLeagueId?: string; espnSeason?: string; week?: string };
    const providerMode = query.providerMode ?? "demo";
    const provider = createFantasyProvider(providerMode, undefined);
    try {
      const league = await provider.getLeagueState({
        leagueId: providerMode === "espn" ? query.espnLeagueId : query.sleeperLeagueId,
        week: query.week ? Number(query.week) : undefined,
        season: query.espnSeason ? Number(query.espnSeason) : undefined
      });
      return buildFantasyPreview(league, providerMode, query.week ? Number(query.week) : undefined);
    } catch (error) {
      return {
        ok: false,
        providerMode,
        readiness: [
          {
            id: "league-load",
            label: "League loaded",
            ok: false,
            detail: redactSecret(error instanceof Error ? error.message : "Unable to load fantasy league.")
          }
        ],
        message: redactSecret(error instanceof Error ? error.message : "Unable to load fantasy league.")
      } satisfies FantasyImportPreview;
    }
  });

  app.get("/api/diagnostics", async (request) => {
    const query = request.query as { sportsDataMode?: "demo" | "espn" };
    return buildDiagnostics(query.sportsDataMode);
  });
  app.get("/api/diagnostics/player-ids", async () => {
    return getDefaultPlayerIdResolver().getStats();
  });
  app.get("/api/diagnostics/sports-cache", async () => {
    return getDefaultSportsGamesCache().getStats();
  });
  app.get("/api/metrics", async () => getMetrics());

  // ---- W8: Listener history backend ----
  // The listener UUID is generated client-side and persisted in
  // localStorage. The server treats it as opaque; trust boundary lives
  // at the device. Real accounts (W5 follow-up) will tie this UUID to
  // a verified identity.
  app.get("/api/history/shows", async (request, reply) => {
    const query = request.query as { listenerId?: string; limit?: string };
    if (!isValidListenerId(query.listenerId)) {
      reply.code(400);
      return { error: "Invalid listenerId." };
    }
    const limit = query.limit ? Math.max(1, Math.min(50, Number(query.limit))) : undefined;
    const shows = await getDefaultShowHistoryStore().list({ listenerId: query.listenerId, limit });
    return { shows };
  });

  app.post("/api/history/shows", async (request, reply) => {
    const parsed = HistoryArchiveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? "Invalid history archive body." };
    }
    await getDefaultShowHistoryStore().archive({ listenerId: parsed.data.listenerId, entry: parsed.data.entry });
    return { ok: true };
  });

  // ---- W5: Yahoo Fantasy OAuth ----
  app.get("/api/fantasy/yahoo/auth-url", async (request, reply) => {
    if (!config.YAHOO_CLIENT_ID || !config.YAHOO_REDIRECT_URI) {
      reply.code(503);
      return { error: "Yahoo OAuth is not configured. Set YAHOO_CLIENT_ID and YAHOO_REDIRECT_URI." };
    }
    const query = request.query as { listenerId?: string };
    if (!isValidListenerId(query.listenerId)) {
      reply.code(400);
      return { error: "Invalid listenerId." };
    }
    return {
      url: buildYahooAuthUrl({
        clientId: config.YAHOO_CLIENT_ID,
        redirectUri: config.YAHOO_REDIRECT_URI,
        state: query.listenerId
      })
    };
  });

  app.get("/api/fantasy/yahoo/callback", async (request, reply) => {
    if (!config.YAHOO_CLIENT_ID || !config.YAHOO_CLIENT_SECRET || !config.YAHOO_REDIRECT_URI) {
      reply.code(503);
      return { error: "Yahoo OAuth is not configured." };
    }
    const query = request.query as { code?: string; state?: string; error?: string };
    if (query.error) {
      reply.code(400);
      return { error: query.error };
    }
    if (!query.code || !isValidListenerId(query.state)) {
      reply.code(400);
      return { error: "Missing code or invalid state (listener id)." };
    }
    const token = await exchangeYahooAuthCode({
      code: query.code,
      clientId: config.YAHOO_CLIENT_ID,
      clientSecret: config.YAHOO_CLIENT_SECRET,
      redirectUri: config.YAHOO_REDIRECT_URI
    });
    if (!token.access_token || !token.refresh_token) {
      reply.code(502);
      return { error: token.error_description ?? token.error ?? "Yahoo token exchange failed." };
    }
    await getDefaultYahooTokenStore().put(query.state, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
      yahooGuid: token.xoauth_yahoo_guid,
      scope: token.scope,
      storedAt: Date.now()
    });
    return { ok: true };
  });

  app.post("/api/fantasy/yahoo/refresh", async (request, reply) => {
    if (!config.YAHOO_CLIENT_ID || !config.YAHOO_CLIENT_SECRET || !config.YAHOO_REDIRECT_URI) {
      reply.code(503);
      return { error: "Yahoo OAuth is not configured." };
    }
    const body = request.body as { listenerId?: string };
    if (!isValidListenerId(body?.listenerId)) {
      reply.code(400);
      return { error: "Invalid listenerId." };
    }
    const existing = await getDefaultYahooTokenStore().get(body.listenerId);
    if (!existing) {
      reply.code(404);
      return { error: "No Yahoo token stored for this listener." };
    }
    const refreshed = await refreshYahooAccessToken({
      refreshToken: existing.refreshToken,
      clientId: config.YAHOO_CLIENT_ID,
      clientSecret: config.YAHOO_CLIENT_SECRET,
      redirectUri: config.YAHOO_REDIRECT_URI
    });
    if (!refreshed.access_token) {
      reply.code(502);
      return { error: refreshed.error_description ?? refreshed.error ?? "Yahoo token refresh failed." };
    }
    await getDefaultYahooTokenStore().put(body.listenerId, {
      ...existing,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? existing.refreshToken,
      expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
      storedAt: Date.now()
    });
    return { ok: true };
  });

  // ---- W9: Clip archival ----
  app.post("/api/clips", async (request, reply) => {
    const parsed = ClipUploadBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? "Invalid clip upload body." };
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(parsed.data.audioBase64, "base64");
    } catch {
      reply.code(400);
      return { error: "Invalid base64 audio." };
    }
    try {
      const metadata = await getDefaultClipStore().put({
        listenerId: parsed.data.listenerId,
        commentaryId: parsed.data.commentaryId,
        mimeType: parsed.data.mimeType,
        data: buffer
      });
      return { id: metadata.id, url: `/api/clips/${metadata.id}`, mimeType: metadata.mimeType, byteLength: metadata.byteLength };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Clip persistence failed." };
    }
  });

  app.get("/api/clips/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await getDefaultClipStore().read(id);
    if (!result) {
      reply.code(404);
      return { error: "Not found." };
    }
    reply.header("Content-Type", result.metadata.mimeType);
    // Audio rarely changes; cache aggressively but still allow the
    // browser to revalidate so a deleted clip clears.
    reply.header("Cache-Control", "public, max-age=3600, stale-while-revalidate=300");
    return reply.send(result.data);
  });

  app.delete("/api/history/shows/:showId", async (request, reply) => {
    const { showId } = request.params as { showId: string };
    const query = request.query as { listenerId?: string };
    if (!isValidListenerId(query.listenerId)) {
      reply.code(400);
      return { error: "Invalid listenerId." };
    }
    if (!showId) {
      reply.code(400);
      return { error: "Missing showId." };
    }
    const removed = await getDefaultShowHistoryStore().remove({ listenerId: query.listenerId, showId });
    if (!removed) {
      reply.code(404);
      return { error: "Not found." };
    }
    return { ok: true };
  });
  app.get("/api/odds", async (request) => {
    const query = request.query as { gameId?: string; sport?: SportLeague; homeTeam?: string; awayTeam?: string };
    if (!query.gameId || !query.sport || !query.homeTeam || !query.awayTeam) {
      return { odds: undefined };
    }
    try {
      const odds = await createOddsProvider().getOdds({
        gameId: query.gameId,
        sport: query.sport,
        homeTeam: query.homeTeam,
        awayTeam: query.awayTeam
      });
      return { odds };
    } catch (error) {
      app.log.warn({ error: error instanceof Error ? error.message : error }, "Odds fetch failed");
      return { odds: undefined };
    }
  });
  app.get("/api/news/storylines", async (request) => {
    const query = request.query as { sport?: SportLeague; teams?: string; playerIds?: string };
    const teams = (query.teams ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const playerIds = (query.playerIds ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const news = await createNewsProvider().getLatest({ playerIds, teams, sport: query.sport });
    return { news };
  });

  app.get("/api/sports/games", async (request, reply) => {
    const query = request.query as { sportsDataMode?: "demo" | "espn" };
    if (query.sportsDataMode !== "espn") {
      return { games: demoGameOptions(), failedSports: [] };
    }
    const cache = getDefaultSportsGamesCache();
    const results = await Promise.allSettled(ESPN_SPORTS.map((sportPath) => cache.get(sportPath)));
    const failedSports: Array<{ sport: SportLeague; label: string }> = [];
    const games = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const sport = ESPN_SPORTS[index];
      app.log.warn({ sport: sport.sport, error: result.reason instanceof Error ? result.reason.message : result.reason }, "ESPN scoreboard fetch failed");
      // Surface to the client so the discover page can flag which
      // scoreboards are temporarily unavailable instead of silently
      // dropping all of that sport's games.
      failedSports.push({ sport: sport.sport, label: sport.label });
      return [];
    });
    // Let CDN/browser cache for the same TTL as the in-memory cache so
    // we decouple user count from ESPN request count at every layer.
    reply.header("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
    return { games, failedSports };
  });
  app.get("/api/model-stack", async () => buildModelStack());
  app.post("/api/video/validate-frame", async (request, reply) => {
    const body = request.body as { frame?: VideoFrameSnapshot; video?: { mode?: "stream-url" | "screen-share" | "vod"; url?: string }; play?: unknown };
    if (!isVideoFrameSnapshot(body?.frame)) {
      reply.code(400);
      return { error: "A valid frame snapshot is required." };
    }
    const provider = createModelProvider();
    const observation = await provider.observe({
      video: { mode: body.video?.mode ?? body.frame.source, url: body.video?.url },
      play: normalizeValidationPlay(body.play),
      frame: body.frame
    });
    return { observation } satisfies FrameValidationResponse;
  });

  app.get("/ws/livecast", { websocket: true }, (socket) => {
    incrementCounter("webSocketsOpened");
    // The whole show loop now lives in ShowEngine — this handler is a
    // thin transport adapter that pumps engine events out as WS
    // frames and feeds inbound frames/cues/nudges back into it.
    const engine = new ShowEngine({ logger: app.log });

    // Pump outbound events. The for-await ends when engine.stop()
    // closes the queue or when the client disconnects.
    void (async () => {
      try {
        for await (const event of engine.events()) {
          if (socket.readyState !== socket.OPEN) break;
          send(socket, event);
        }
      } catch (error) {
        app.log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Engine event pump terminated"
        );
      }
    })();

    socket.on("message", (raw) => {
      // Wrap the async work in an IIFE with a top-level catch so a
      // throw before the inner try/catch (e.g. parseSocketMessage on a
      // pathological payload) can't bubble up as an unhandled
      // rejection. Surface as an `error` event so the client sees it.
      void (async () => {
        try {
          await handleSocketMessage(raw);
        } catch (error) {
          app.log.error({ err: error instanceof Error ? error.message : String(error) }, "WS message handler crashed");
          send(socket, { type: "error", message: redactSecret(error instanceof Error ? error.message : "Internal socket error.") });
        }
      })();
    });

    const handleSocketMessage = async (raw: unknown) => {
      const incoming = parseSocketMessage(String(raw));
      if (incoming.type === "frame") {
        engine.pushFrame(incoming.frame);
        return;
      }
      if (incoming.type === "nudge") {
        engine.pushNudge(incoming.hostId);
        return;
      }
      if (incoming.type === "cue") {
        engine.pushCue(incoming.cue);
        return;
      }
      const requestResult = parseLivecastRequest(incoming.rawRequest);
      if (!requestResult.ok) {
        send(socket, { type: "error", message: requestResult.message });
        return;
      }
      // start() runs the opener + ticks; the event pump above already
      // drains engine.events() into the socket so we don't need to
      // wire each emitted event here.
      void engine.start(requestResult.request);
    };

    socket.on("close", () => {
      incrementCounter("webSocketsClosed");
      engine.stop();
    });
  });

  return app;
}


// Body validation for the listener-history backend (W8). Built off the
// shared `ShowHistoryEntry` shape so the runtime check matches the
// type contract instead of the looser hand-rolled property checks the
// route had originally.
const ShowHistoryEntrySchema = z.object({
  id: z.string().min(1).max(128),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  sport: z.enum(["nfl", "nba", "wnba", "mlb", "nhl", "ncaaf", "ncaab", "soccer", "other"]),
  gameId: z.string().min(1).max(256),
  gameLabel: z.string().min(1).max(256),
  listenerName: z.string().min(1).max(64),
  listenerTeamName: z.string().max(128).optional(),
  finalScore: z.object({ away: z.number(), home: z.number() }).optional(),
  topMoment: z
    .object({
      playerName: z.string().min(1).max(128),
      pointsDelta: z.number(),
      hostText: z.string().max(2000)
    })
    .optional(),
  marginShift: z.number().optional(),
  totalCommentary: z.number().int().nonnegative()
});

const HistoryArchiveBodySchema = z.object({
  listenerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  entry: ShowHistoryEntrySchema
});

// Audio clip upload body (W9). 8MB cap is enforced at the store layer
// too, but bound the base64 string here so a multi-GB string can't
// burn memory before we get to the buffer check.
const ClipUploadBodySchema = z.object({
  listenerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  commentaryId: z.string().max(256).optional(),
  mimeType: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9.+/_-]+$/),
  audioBase64: z
    .string()
    .min(1)
    .max(12_000_000) // ~8MB binary after base64 decode
});

const LivecastRequestSchema = z.object({
  providerMode: z.enum(["demo", "sleeper", "espn"]).default("demo"),
  sportsDataMode: z.enum(["demo", "espn"]).default(config.SPORTS_DATA_PROVIDER),
  sportsGameId: z.string().trim().optional(),
  sleeperLeagueId: z.string().trim().optional(),
  espnLeagueId: z.string().trim().optional(),
  espnSeason: z.number().int().min(2018).max(2100).optional(),
  week: z.number().int().min(1).max(22).optional(),
  cadenceMs: z.number().int().min(3000).max(15000).default(5000),
  customLeague: z.custom<FantasyLeagueState>((value) => validateFantasyLeagueShape(value)).optional(),
  ttsEnabled: z.boolean().default(true),
  // Cross-show memory the client derives from its localStorage history.
  // Free-form prose so the LLM can reference the listener's recent
  // shows in the opener ("last week Mahomes burned you, let's see…").
  priorContext: z.string().max(800).optional(),
  video: z
    .object({
      mode: z.enum(["stream-url", "screen-share", "vod"]).default("stream-url"),
      url: z.string().trim().url().optional().or(z.literal(""))
    })
    .default({ mode: "stream-url" }),
  group: z
    .object({
      listener: z
        .object({
          name: z.string().min(1),
          rosterId: z.string().optional(),
          favoriteTeam: z.string().optional()
        })
        .default(defaultGroup.listener),
      tone: z.enum(["family", "pg", "chaos"]).default("pg"),
      homeTeamBias: z.enum(["balanced", "fantasy-first", "favorite-team-first"]).default("fantasy-first"),
      friends: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            favoriteTeam: z.string().min(1),
            rosterId: z.string().optional(),
            rivalryNotes: z.string().optional()
          })
        )
        .min(1)
    })
    .default(defaultGroup)
});

export function parseLivecastRequest(raw: string): { ok: true; request: LivecastRequest } | { ok: false; message: string } {
  try {
    const parsed = LivecastRequestSchema.parse(JSON.parse(raw));
    if (parsed.providerMode === "sleeper" && !parsed.sleeperLeagueId) {
      return { ok: false, message: "Sleeper mode needs a league ID before the livecast can start." };
    }
    if (parsed.providerMode === "espn" && !parsed.espnLeagueId) {
      return { ok: false, message: "ESPN mode needs a league ID before the livecast can start." };
    }
    return {
      ok: true,
      request: {
        ...parsed,
        sleeperLeagueId: parsed.sleeperLeagueId || undefined,
        espnLeagueId: parsed.espnLeagueId || undefined,
        video: { ...parsed.video, url: parsed.video.url || undefined }
      }
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? redactSecret(`Invalid livecast settings: ${error.message}`) : "Invalid livecast settings."
    };
  }
}

export function parseSocketMessage(raw: string):
  | { type: "start"; rawRequest: string }
  | { type: "frame"; frame: VideoFrameSnapshot }
  | { type: "nudge"; hostId: "maya" | "theo" | "cam" }
  | { type: "cue"; cue: ListenerCue } {
  try {
    const parsed = JSON.parse(raw) as { type?: string; request?: unknown; frame?: unknown; hostId?: unknown; cue?: unknown };
    if (parsed.type === "frame" && isVideoFrameSnapshot(parsed.frame)) {
      return { type: "frame", frame: parsed.frame };
    }
    if (parsed.type === "nudge" && (parsed.hostId === "maya" || parsed.hostId === "theo" || parsed.hostId === "cam")) {
      return { type: "nudge", hostId: parsed.hostId };
    }
    if (parsed.type === "cue" && isListenerCue(parsed.cue)) {
      return { type: "cue", cue: parsed.cue };
    }
    if (parsed.type === "start" && parsed.request) {
      return { type: "start", rawRequest: JSON.stringify(parsed.request) };
    }
  } catch {
    // Legacy clients send the livecast request directly; parseLivecastRequest handles validation.
  }
  return { type: "start", rawRequest: raw };
}

function isListenerCue(value: unknown): value is ListenerCue {
  if (!value || typeof value !== "object") return false;
  const cue = value as Partial<ListenerCue>;
  return Boolean(
    cue.id &&
    cue.capturedAt &&
    typeof cue.text === "string" &&
    cue.text.trim().length > 0 &&
    cue.text.length <= 600
  );
}

// Provider factories now live in ./showFactories so the new SSE
// ShowEngine can import them without pulling in Fastify.
import {
  createFantasyProvider,
  createSportsDataProvider,
  createModelProvider,
  parseSportPrefixedGameId,
  buildHostVoiceMap as _buildHostVoiceMap,
  getActiveProviders as _getActiveProviders,
  getHealth as _getHealth
} from "./showFactories";
import { redactSecret } from "./redactSecret";
import { ShowEngine } from "./showEngine";
const buildHostVoiceMap = _buildHostVoiceMap;
const getActiveProviders = _getActiveProviders;
const getHealth = _getHealth;
export { redactSecret };

function demoGameOptions(): SportsGameOption[] {
  return [
    {
      id: "demo-kc-det",
      label: "Kansas City Chiefs at Detroit Lions",
      shortName: "KC @ DET",
      sport: "nfl",
      awayTeam: "KC",
      homeTeam: "DET",
      score: { away: 24, home: 21 },
      status: "demo",
      detail: "Scripted demo game",
      broadcast: "ESPN"
    },
    {
      id: "demo-buf-cin",
      label: "Buffalo Bills at Cincinnati Bengals",
      shortName: "BUF @ CIN",
      sport: "nfl",
      awayTeam: "BUF",
      homeTeam: "CIN",
      score: { away: 0, home: 0 },
      status: "demo",
      detail: "Pregame · scripted demo",
      broadcast: "Demo"
    },
    {
      id: "demo-den-okc",
      label: "Denver Nuggets at Oklahoma City Thunder",
      shortName: "DEN @ OKC",
      sport: "nba",
      awayTeam: "DEN",
      homeTeam: "OKC",
      score: { away: 58, home: 62 },
      status: "demo",
      detail: "Q3 6:14 · scripted demo",
      broadcast: "TNT"
    },
    {
      id: "demo-bos-dal",
      label: "Boston Celtics at Dallas Mavericks",
      shortName: "BOS @ DAL",
      sport: "nba",
      awayTeam: "BOS",
      homeTeam: "DAL",
      score: { away: 0, home: 0 },
      status: "demo",
      detail: "Tip-off 8pm · scripted demo",
      broadcast: "Demo"
    },
    {
      id: "demo-lal-phx",
      label: "Los Angeles Lakers at Phoenix Suns",
      shortName: "LAL @ PHX",
      sport: "nba",
      awayTeam: "LAL",
      homeTeam: "PHX",
      score: { away: 88, home: 92 },
      status: "demo",
      detail: "Q4 4:02 · scripted demo",
      broadcast: "ESPN"
    }
  ];
}

export function buildFantasyPreview(league: FantasyLeagueState, providerMode: "demo" | "sleeper" | "espn", requestedWeek?: number): FantasyImportPreview {
  const rosters = league.matchups.flatMap((matchup) => matchup.rosters);
  const players = new Map<string, { proTeam: string }>();
  let starterCount = 0;
  let benchCount = 0;
  let missingRosterNames = 0;
  let missingPlayerTeams = 0;

  for (const roster of rosters) {
    if (!roster.ownerName || roster.ownerName.startsWith("Roster ")) missingRosterNames += 1;
    starterCount += roster.starters.length;
    benchCount += roster.bench.length;
    for (const player of [...roster.starters, ...roster.bench]) {
      players.set(player.id, { proTeam: player.proTeam });
      if (!player.proTeam || player.proTeam === "FA") missingPlayerTeams += 1;
    }
  }

  const summary = {
    leagueName: league.leagueName,
    season: league.season,
    week: requestedWeek ?? league.matchups[0]?.week ?? 1,
    rosterCount: rosters.length,
    matchupCount: league.matchups.length,
    playerCount: players.size,
    starterCount,
    benchCount,
    missingRosterNames,
    missingPlayerTeams
  };

  const readiness = [
    {
      id: "league-load",
      label: "League loaded",
      ok: true,
      detail: `${league.leagueName} loaded from ${providerMode}.`
    },
    {
      id: "matchups",
      label: "Matchups found",
      ok: summary.matchupCount > 0 && summary.rosterCount > 0,
      detail: `${summary.matchupCount} matchup(s), ${summary.rosterCount} roster(s).`
    },
    {
      id: "players",
      label: "Players normalized",
      ok: summary.playerCount > 0,
      detail: `${summary.playerCount} unique player(s), ${summary.starterCount} starters.`
    },
    {
      id: "teams",
      label: "NFL teams available",
      ok: summary.missingPlayerTeams === 0,
      detail: summary.missingPlayerTeams ? `${summary.missingPlayerTeams} player(s) missing NFL teams.` : "All normalized players have teams."
    }
  ];

  return {
    ok: readiness.every((item) => item.ok),
    providerMode,
    league,
    summary,
    readiness,
    message: readiness.every((item) => item.ok) ? "League is ready for livecast." : "League loaded, but some fields need attention."
  };
}

export async function buildDiagnostics(sportsDataMode: "demo" | "espn" = config.SPORTS_DATA_PROVIDER): Promise<ProviderDiagnostics> {
  const health = await getHealth();
  const mediaManifestPath = path.join(process.cwd(), "public", "media-cache", "manifest.json");
  const mediaExists = existsSync(mediaManifestPath);
  const mediaAge = mediaExists ? Math.round((Date.now() - statSync(mediaManifestPath).mtimeMs) / 60000) : undefined;

  return {
    generatedAt: new Date().toISOString(),
    providers: getActiveProviders(undefined, "demo", sportsDataMode),
    health,
    checks: [
      {
        id: "espn-private-cookies",
        label: "ESPN private league cookies",
        status: config.ESPN_SWID && config.ESPN_S2 ? "ready" : "disabled",
        detail: config.ESPN_SWID && config.ESPN_S2 ? "ESPN_SWID and ESPN_S2 are configured." : "Private ESPN leagues need ESPN_SWID and ESPN_S2 in .env."
      },
      {
        id: "openai-commentary",
        label: "OpenAI commentary",
        status: config.RESOLVED_COMMENTARY_PROVIDER === "openai" && config.OPENAI_API_KEY ? "ready" : config.COMMENTARY_PROVIDER === "openai" ? "error" : "disabled",
        detail:
          config.RESOLVED_COMMENTARY_PROVIDER === "openai"
            ? config.OPENAI_API_KEY
              ? `Using ${config.RESOLVED_OPENAI_MODEL} with reasoning=${config.OPENAI_REASONING_EFFORT}.`
              : "COMMENTARY_PROVIDER is openai but OPENAI_API_KEY is missing."
            : config.COMMENTARY_PROVIDER === "auto"
              ? "Auto mode selected local commentary because no OpenAI key is configured."
              : "Local commentary templates are active."
      },
      {
        id: "elevenlabs-tts",
        label: "ElevenLabs TTS",
        status: config.RESOLVED_TTS_PROVIDER === "elevenlabs" && config.ELEVENLABS_API_KEY ? "ready" : config.TTS_PROVIDER === "elevenlabs" ? "error" : "disabled",
        detail:
          config.RESOLVED_TTS_PROVIDER === "elevenlabs"
            ? config.ELEVENLABS_API_KEY
              ? `Using voice ${config.ELEVENLABS_VOICE_ID} with ${config.RESOLVED_ELEVENLABS_MODEL_ID}.`
              : "TTS_PROVIDER is elevenlabs but ELEVENLABS_API_KEY is missing."
            : config.TTS_PROVIDER === "auto"
              ? "Auto mode selected browser/mock TTS because no ElevenLabs key is configured."
              : "Browser/mock TTS is active."
      },
      {
        id: "model-preset",
        label: "SOTA model preset",
        status: config.MODEL_PRESET === "local" ? "disabled" : "ready",
        detail: `${config.MODEL_PRESET} preset: commentary=${config.RESOLVED_OPENAI_MODEL}, realtime=${config.RESOLVED_REALTIME_MODEL}, TTS=${config.RESOLVED_ELEVENLABS_MODEL_ID}.`
      },
      {
        id: "multimodal-model",
        label: "Live video model",
        status:
          config.RESOLVED_MODEL_PROVIDER === "mock"
            ? "disabled"
            : config.RESOLVED_MODEL_PROVIDER === "openai-vision" && config.OPENAI_API_KEY
              ? "ready"
              : config.RESOLVED_MODEL_PROVIDER === "nemotron" && config.NEMOTRON_ENDPOINT
                ? "ready"
                : "error",
        detail:
          config.RESOLVED_MODEL_PROVIDER === "mock"
            ? `Mock observations active. Next real option: ${config.NEMOTRON_MODEL} or ${config.RESOLVED_REALTIME_MODEL} with browser frame/audio capture.`
            : config.RESOLVED_MODEL_PROVIDER === "openai-vision"
              ? config.OPENAI_API_KEY
                ? `OpenAI frame validation active with ${config.RESOLVED_OPENAI_MODEL}.`
                : "MODEL_PROVIDER=openai-vision needs OPENAI_API_KEY."
            : config.RESOLVED_MODEL_PROVIDER === "nemotron"
              ? config.NEMOTRON_ENDPOINT
                ? `Nemotron-compatible endpoint configured for ${config.NEMOTRON_MODEL}.`
                : "MODEL_PROVIDER=nemotron needs NEMOTRON_ENDPOINT."
              : `OpenAI realtime model target is ${config.RESOLVED_REALTIME_MODEL}; browser capture bridge is still planned.`
      },
      {
        id: "media-cache",
        label: "Media cache",
        status: mediaExists ? "ready" : "disabled",
        detail: mediaExists ? `Manifest found at public/media-cache/manifest.json, updated about ${mediaAge} minute(s) ago.` : "Run npm run media:cache to create local media assets."
      },
      {
        id: "sports-data",
        label: "Sports data mode",
        status: "ready",
        detail: sportsDataMode === "espn" ? "Current control-room sports data mode is ESPN scoreboard." : "Current control-room sports data mode is demo scripted plays."
      }
    ]
  };
}

function buildModelStack(): ModelStackProfile {
  const commentaryProvider = config.RESOLVED_COMMENTARY_PROVIDER;
  const ttsProvider = config.RESOLVED_TTS_PROVIDER;
  return {
    preset: config.MODEL_PRESET,
    commentary: {
      provider: commentaryProvider,
      model: commentaryProvider === "openai" ? config.RESOLVED_OPENAI_MODEL : "local-template",
      reasoningEffort: config.OPENAI_REASONING_EFFORT,
      status: commentaryProvider === "openai" ? (config.OPENAI_API_KEY ? "ready" : "needs-key") : "local",
      role: "Drafts short personalized livecast scripts from play, fantasy, news, and group context."
    },
    realtime: {
      provider: config.MODEL_PRESET === "local" ? "mock" : "openai-realtime",
      model: config.MODEL_PRESET === "local" ? "mock-realtime" : config.RESOLVED_REALTIME_MODEL,
      status: config.MODEL_PRESET === "local" ? "mock" : "planned",
      role: "Target for future browser audio/video realtime loop and barge-in voice interaction."
    },
    multimodal: {
      provider: config.RESOLVED_MODEL_PROVIDER,
      model:
        config.RESOLVED_MODEL_PROVIDER === "openai-vision"
          ? config.RESOLVED_OPENAI_MODEL
          : config.RESOLVED_MODEL_PROVIDER === "nemotron"
            ? config.NEMOTRON_MODEL
            : config.RESOLVED_MODEL_PROVIDER === "openai-realtime"
              ? config.RESOLVED_REALTIME_MODEL
              : "mock-multimodal-observer",
      status:
        config.RESOLVED_MODEL_PROVIDER === "mock"
          ? "mock"
          : config.RESOLVED_MODEL_PROVIDER === "openai-vision" && config.OPENAI_API_KEY
            ? "ready"
            : config.RESOLVED_MODEL_PROVIDER === "nemotron" && config.NEMOTRON_ENDPOINT
              ? "ready"
              : "planned",
      role: "Observes permitted video/screen input and produces non-authoritative context for commentary."
    },
    tts: {
      provider: ttsProvider,
      model: ttsProvider === "elevenlabs" ? config.RESOLVED_ELEVENLABS_MODEL_ID : "browser-speechSynthesis",
      status: ttsProvider === "elevenlabs" ? (config.ELEVENLABS_API_KEY ? "ready" : "needs-key") : "local",
      role: "Streams low-latency spoken commentary audio."
    }
  };
}

function send(socket: { send: (data: string) => void }, event: ClientServerEvent) {
  socket.send(JSON.stringify(event));
}


function validateFantasyLeagueShape(value: unknown): value is FantasyLeagueState {
  if (!value || typeof value !== "object") return false;
  const league = value as Partial<FantasyLeagueState>;
  return Boolean(
    league.leagueId &&
      league.leagueName &&
      league.sport &&
      league.season &&
      Array.isArray(league.matchups) &&
      league.matchups.every((matchup) => Array.isArray(matchup.rosters))
  );
}
