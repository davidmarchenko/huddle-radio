import type {
  ActiveProviderSummary,
  FantasyLeagueState,
  MultimodalModelProvider,
  ProviderHealth,
  SportLeague
} from "../shared/contracts";
import { config } from "./config";
import { describeCommentaryStack, createCommentaryProvider } from "./createCommentaryProvider";
import { describeNewsStack, createNewsProvider } from "./createNewsProvider";
import { createVisionProvider } from "./visionProviderFactory";
import { DemoFantasyProvider } from "../providers/demoFantasyProvider";
import { DemoSportsDataProvider } from "../providers/demoSportsDataProvider";
import { EspnFantasyProvider } from "../providers/espnFantasyProvider";
import { EspnSportsDataProvider, ESPN_SPORTS } from "../providers/espnSportsDataProvider";
import { SleeperFantasyProvider } from "../providers/sleeperFantasyProvider";
import { SportradarSportsDataProvider } from "../providers/sportradarSportsDataProvider";
import { SportsDataIoProvider } from "../providers/sportsDataIoProvider";
import { ElevenLabsTTSProvider, MockTTSProvider, type HostVoiceMap } from "../providers/ttsProviders";
import { FishAudioTTSProvider, buildFishHostVoiceMap } from "../providers/fishAudioProvider";
import { InworldTtsProvider, buildInworldHostVoiceMap } from "../providers/inworldTtsProvider";
import type { TTSProvider } from "../shared/contracts";
import { UserVideoProvider } from "../providers/userVideoProvider";

/**
 * Provider factories shared by the Fastify legacy show route and the
 * new Next.js SSE Route Handlers. Lives in its own module so the
 * ShowEngine class can import these without creating a circular
 * dependency back to app.ts (which previously owned them).
 *
 * Behavior is unchanged from the inline versions in app.ts — this is
 * pure relocation. app.ts still re-exports them so existing imports
 * continue to work.
 */

export function createFantasyProvider(
  providerMode: "demo" | "sleeper" | "espn" | undefined,
  customLeague?: FantasyLeagueState,
  /**
   * Optional sport hint derived from the picked gameId (see
   * resolveSportsSource). Only the demo provider uses it — Sleeper and
   * ESPN already carry sport identity through their leagueId. When set,
   * the demo provider returns the bundled league for that sport (or an
   * empty-shell league when no demo data exists), preventing the demo
   * NFL roster from polluting commentary on a real-game in a different
   * sport.
   */
  sportHint?: SportLeague
) {
  if (providerMode === "sleeper") return new SleeperFantasyProvider();
  if (providerMode === "espn") return new EspnFantasyProvider({ swid: config.ESPN_SWID, espnS2: config.ESPN_S2 });
  return new DemoFantasyProvider(customLeague, sportHint);
}

/**
 * Tagged-union view of which sports backend a gameId points at. Routing
 * is derived from the gameId prefix alone — there is no separate "mode"
 * variable to drift out of sync with it. Prefix grammar:
 *
 *   sportradar:<id>     → paid Sportradar feed (key required)
 *   sportsdataio:<id>   → paid SportsDataIO feed (key required)
 *   nba-<id> / nfl-<id> / ... → ESPN scoreboard for that sport
 *   demo-<key>          → bundled demo script
 *   "" / undefined      → bundled demo script (default landing)
 *
 * Anything else is rejected so we surface "unknown game" instead of
 * silently substituting a default and serving the wrong play-by-play —
 * the bug we just hunted down.
 */
export type SportsSource =
  | { kind: "sportradar"; gameId: string }
  | { kind: "sportsdataio"; scoreId: string }
  | { kind: "espn"; sportPath: typeof ESPN_SPORTS[number]; eventId: string }
  | { kind: "demo"; gameId?: string }
  | { kind: "unknown"; raw: string };

export function resolveSportsSource(sportsGameId?: string): SportsSource {
  if (!sportsGameId) return { kind: "demo" };
  if (sportsGameId.startsWith("sportradar:")) {
    return { kind: "sportradar", gameId: sportsGameId.slice("sportradar:".length) };
  }
  if (sportsGameId.startsWith("sportsdataio:")) {
    return { kind: "sportsdataio", scoreId: sportsGameId.slice("sportsdataio:".length) };
  }
  if (sportsGameId.startsWith("demo-")) {
    return { kind: "demo", gameId: sportsGameId };
  }
  const espn = parseSportPrefixedGameId(sportsGameId);
  if (espn) return { kind: "espn", sportPath: espn.sportPath, eventId: espn.eventId };
  return { kind: "unknown", raw: sportsGameId };
}

export function createSportsDataProvider(sportsGameId?: string) {
  const source = resolveSportsSource(sportsGameId);
  switch (source.kind) {
    case "sportradar":
      // Paid backup is only useful with a key. Without one, fall through
      // to ESPN if the underlying id happens to be ESPN-prefixed, else
      // demo — same behavior the previous mode-based factory had.
      if (config.SPORTRADAR_API_KEY) {
        return new SportradarSportsDataProvider({
          apiKey: config.SPORTRADAR_API_KEY,
          accessLevel: config.SPORTRADAR_ACCESS_LEVEL,
          gameId: source.gameId
        });
      }
      return createSportsDataProvider(source.gameId);
    case "sportsdataio":
      if (config.SPORTSDATAIO_API_KEY) {
        return new SportsDataIoProvider({
          apiKey: config.SPORTSDATAIO_API_KEY,
          scoreId: source.scoreId
        });
      }
      return createSportsDataProvider(source.scoreId);
    case "espn":
      return new EspnSportsDataProvider(fetch, source.eventId, source.sportPath);
    case "demo":
      return new DemoSportsDataProvider(source.gameId);
    case "unknown":
      // Surface the misuse loudly — the previous code path silently
      // routed unknown ids to KC@DET, which is exactly how the wrong
      // commentary leaked into real-game shows.
      throw new Error(
        `Unrecognized sportsGameId "${source.raw}". Expected a sport-prefixed ESPN id (e.g. nba-401741234), a "demo-*" id, or a "sportradar:" / "sportsdataio:" prefix.`
      );
  }
}

/**
 * Coarse label hint for the producer-panel "Sports data" row. The full
 * routing lives in resolveSportsSource; this is just a two-bucket
 * summary the existing getActiveProviders signature expects.
 */
export function deriveSportsLabelMode(sportsGameId?: string): "demo" | "espn" {
  const source = resolveSportsSource(sportsGameId);
  return source.kind === "espn" || source.kind === "sportradar" || source.kind === "sportsdataio" ? "espn" : "demo";
}

export function parseSportPrefixedGameId(gameId?: string) {
  if (!gameId) return undefined;
  const match = ESPN_SPORTS.find((sport) => gameId.startsWith(`${sport.sport}-`));
  if (!match) return undefined;
  return { sportPath: match, eventId: gameId.slice(match.sport.length + 1) };
}

export function createModelProvider(): MultimodalModelProvider {
  // Delegates to the shared factory so the Next.js Route Handler
  // (POST /api/vision/observe) and Fastify legacy route stay in sync
  // on chain construction + fallback order.
  return createVisionProvider();
}

export function modelProviderLabel(): string {
  // Reflect the actual primary in the chain. Nemotron wins whenever
  // its key is set, regardless of MODEL_PROVIDER, because that's
  // what createModelProvider() does above.
  if (config.NEMOTRON_API_KEY) return `Nemotron ${config.NEMOTRON_MODEL}`;
  if (config.RESOLVED_MODEL_PROVIDER === "openai-vision") return `OpenAI Vision ${config.RESOLVED_OPENAI_MODEL}`;
  if (config.RESOLVED_MODEL_PROVIDER === "nemotron") return `Nemotron ${config.NEMOTRON_MODEL}`;
  if (config.RESOLVED_MODEL_PROVIDER === "openai-realtime") return `OpenAI Realtime ${config.RESOLVED_REALTIME_MODEL}`;
  return "Mock Multimodal Model";
}

/**
 * Per-host ElevenLabs voice IDs from env. Lets Maya / Theo / Cam sound
 * distinct instead of all sharing ELEVENLABS_VOICE_ID. Each host that
 * doesn't get an override falls back to the default voice.
 */
export function buildHostVoiceMap(): HostVoiceMap {
  const map: HostVoiceMap = {};
  if (config.ELEVENLABS_VOICE_ID_MAYA) map.maya = config.ELEVENLABS_VOICE_ID_MAYA;
  if (config.ELEVENLABS_VOICE_ID_THEO) map.theo = config.ELEVENLABS_VOICE_ID_THEO;
  if (config.ELEVENLABS_VOICE_ID_CAM) map.cam = config.ELEVENLABS_VOICE_ID_CAM;
  return map;
}

/**
 * Pick the right TTS provider implementation for this process based on
 * RESOLVED_TTS_PROVIDER. ElevenLabs remains the proven path; Fish Audio
 * is the experimental low-latency multi-speaker alternative. Mock is
 * always the safe fallback when no real provider is configured.
 *
 * Kept as a factory (not inlined in the engine) so swapping providers
 * is a single config flip — no code paths to delete when experimenting.
 *
 * `override` is an optional per-request choice supplied by the client
 * (LivecastRequest.ttsProviderOverride). "auto"/undefined falls through
 * to the env-resolved default; anything else wins. We still gate on
 * whether the corresponding API key is configured — if the listener
 * picks Inworld but INWORLD_API_KEY is empty, we fall back to mock so
 * the show doesn't 500 instead of speak.
 */
export function createTTSProvider(
  override?: "auto" | "elevenlabs" | "fish" | "inworld" | "mock"
): TTSProvider {
  const resolved: "elevenlabs" | "fish" | "inworld" | "mock" =
    !override || override === "auto"
      ? config.RESOLVED_TTS_PROVIDER
      : override === "elevenlabs" && !config.ELEVENLABS_API_KEY
        ? "mock"
        : override === "fish" && !config.FISH_API_KEY
          ? "mock"
          : override === "inworld" && !config.INWORLD_API_KEY
            ? "mock"
            : override;
  switch (resolved) {
    case "elevenlabs":
      return new ElevenLabsTTSProvider(
        config.ELEVENLABS_API_KEY,
        config.ELEVENLABS_VOICE_ID,
        config.RESOLVED_ELEVENLABS_MODEL_ID,
        buildHostVoiceMap()
      );
    case "fish":
      return new FishAudioTTSProvider(
        config.FISH_API_KEY,
        config.FISH_VOICE_ID,
        config.FISH_MODEL,
        buildFishHostVoiceMap()
      );
    case "inworld":
      return new InworldTtsProvider(
        config.INWORLD_API_KEY,
        config.INWORLD_VOICE_ID,
        config.INWORLD_MODEL,
        buildInworldHostVoiceMap()
      );
    case "mock":
    default:
      return new MockTTSProvider();
  }
}

export function getActiveProviders(
  customLeague?: FantasyLeagueState,
  providerMode: "demo" | "sleeper" | "espn" = "demo",
  sportsDataMode: "demo" | "espn" = config.SPORTS_DATA_PROVIDER
): ActiveProviderSummary {
  const fantasyProvider = customLeague
    ? "Custom Demo Fantasy"
    : providerMode === "espn"
      ? "ESPN Fantasy"
      : providerMode === "sleeper"
        ? "Sleeper Fantasy"
        : "Demo Fantasy";
  return {
    fantasy: fantasyProvider,
    sportsData: sportsDataMode === "espn" ? "ESPN Scoreboard" : "Demo Sports Data",
    news: describeNewsStack(),
    video: "User Video Source",
    model: modelProviderLabel(),
    commentary: describeCommentaryStack(),
    tts:
      config.RESOLVED_TTS_PROVIDER === "elevenlabs"
        ? `ElevenLabs ${config.RESOLVED_ELEVENLABS_MODEL_ID}`
        : config.RESOLVED_TTS_PROVIDER === "fish"
          ? `Fish Audio ${config.FISH_MODEL}`
          : config.RESOLVED_TTS_PROVIDER === "inworld"
            ? `Inworld ${config.INWORLD_MODEL}`
            : "Mock/Browser TTS"
  };
}

export async function getHealth(): Promise<ProviderHealth[]> {
  const providers = [
    new DemoFantasyProvider(),
    new EspnFantasyProvider({ swid: config.ESPN_SWID, espnS2: config.ESPN_S2 }),
    new DemoSportsDataProvider(),
    new EspnSportsDataProvider(),
    createNewsProvider(),
    new UserVideoProvider(),
    createModelProvider(),
    createCommentaryProvider(),
    createTTSProvider()
  ];
  return Promise.all(providers.map((provider) => provider.health()));
}
