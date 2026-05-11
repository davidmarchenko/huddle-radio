import type {
  ActiveProviderSummary,
  FantasyLeagueState,
  MultimodalModelProvider,
  ProviderHealth
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
  customLeague?: FantasyLeagueState
) {
  if (providerMode === "sleeper") return new SleeperFantasyProvider();
  if (providerMode === "espn") return new EspnFantasyProvider({ swid: config.ESPN_SWID, espnS2: config.ESPN_S2 });
  return new DemoFantasyProvider(customLeague);
}

export function createSportsDataProvider(
  sportsDataMode: "demo" | "espn" | undefined,
  sportsGameId?: string
) {
  // W10: paid live-data backups. Operators with Sportradar /
  // SportsDataIO contracts pass `sportradar:<gameId>` or
  // `sportsdataio:<scoreId>` in sportsGameId; the API key comes from
  // env. Falls through to ESPN when the prefix isn't present so the
  // free path is unchanged.
  if (sportsGameId?.startsWith("sportradar:") && config.SPORTRADAR_API_KEY) {
    return new SportradarSportsDataProvider({
      apiKey: config.SPORTRADAR_API_KEY,
      accessLevel: config.SPORTRADAR_ACCESS_LEVEL,
      gameId: sportsGameId.slice("sportradar:".length)
    });
  }
  if (sportsGameId?.startsWith("sportsdataio:") && config.SPORTSDATAIO_API_KEY) {
    return new SportsDataIoProvider({
      apiKey: config.SPORTSDATAIO_API_KEY,
      scoreId: sportsGameId.slice("sportsdataio:".length)
    });
  }
  if (sportsDataMode === "espn") {
    const parsed = parseSportPrefixedGameId(sportsGameId);
    return new EspnSportsDataProvider(fetch, parsed?.eventId, parsed?.sportPath ?? ESPN_SPORTS[0]);
  }
  return new DemoSportsDataProvider(sportsGameId);
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
 */
export function createTTSProvider(): TTSProvider {
  switch (config.RESOLVED_TTS_PROVIDER) {
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
