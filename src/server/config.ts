import "dotenv/config";
import { z } from "zod";
import { recommendedModelDefaults } from "../shared/modelStack";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8787),
  SPORTS_DATA_PROVIDER: z.enum(["demo", "espn"]).default("demo"),
  // News chain: `auto`/`espn` activate the ESPN news feed with the
  // demo provider as terminal fallback. `demo` keeps the demo-only
  // behavior. No keys required either way.
  NEWS_PROVIDER: z.enum(["auto", "demo", "espn"]).default("auto"),
  MODEL_PRESET: z.enum(["sota", "fast", "local"]).default("sota"),
  COMMENTARY_PROVIDER: z.enum(["auto", "local", "openai"]).default("auto"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default(recommendedModelDefaults.commentaryModel),
  OPENAI_FAST_MODEL: z.string().default(recommendedModelDefaults.commentaryFastModel),
  OPENAI_REASONING_EFFORT: z.enum(["none", "low", "medium", "high"]).default("none"),
  // Commentary fallback chain. Each is optional; the chain only activates
  // a vendor when its key is present. With no fallback keys, behavior is
  // unchanged: OpenAI primary, LocalCommentaryProvider terminal.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_COMMENTARY_MODEL: z.string().default("claude-sonnet-4-6"),
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_COMMENTARY_MODEL: z.string().default("gemini-1.5-pro"),
  COMMENTARY_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
  OPENAI_REALTIME_MODEL: z.string().default(recommendedModelDefaults.realtimeModel),
  OPENAI_REALTIME_FAST_MODEL: z.string().default(recommendedModelDefaults.realtimeFastModel),
  MODEL_PROVIDER: z.enum(["mock", "openai-vision", "nemotron", "openai-realtime"]).default("openai-vision"),
  NEMOTRON_MODEL: z.string().default(recommendedModelDefaults.multimodalLocalModel),
  // Nvidia's hosted OpenAI-compatible endpoint at build.nvidia.com.
  // Override only when self-hosting via NIM or pointing at a private
  // catalog mirror.
  NEMOTRON_ENDPOINT: z.string().default("https://integrate.api.nvidia.com/v1"),
  NEMOTRON_API_KEY: z.string().optional(),
  TTS_PROVIDER: z.enum(["auto", "mock", "elevenlabs"]).default("auto"),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().default("Xb7hH8MSUJpSbSDYk0k2"),
  // Per-host voice overrides. When set, Maya / Theo / Cam route to
  // their own voice instead of all sharing ELEVENLABS_VOICE_ID.
  ELEVENLABS_VOICE_ID_MAYA: z.string().optional(),
  ELEVENLABS_VOICE_ID_THEO: z.string().optional(),
  ELEVENLABS_VOICE_ID_CAM: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().default(recommendedModelDefaults.ttsLowLatencyModel),
  ELEVENLABS_EXPRESSIVE_MODEL_ID: z.string().default(recommendedModelDefaults.ttsExpressiveModel),
  ESPN_SWID: z.string().optional(),
  ESPN_S2: z.string().optional(),
  // Yahoo Fantasy OAuth. Yahoo requires HTTPS callback URLs even for
  // local dev; pair with ngrok / cloudflared to test locally.
  YAHOO_CLIENT_ID: z.string().optional(),
  YAHOO_CLIENT_SECRET: z.string().optional(),
  YAHOO_REDIRECT_URI: z.string().optional(),
  // The Odds API (free tier 500 req/mo). Spread, total, moneyline. When
  // set, surfaces a Vegas-line card pregame and feeds the commentary
  // payload so persona prompts can cite the line.
  THE_ODDS_API_KEY: z.string().optional(),
  // W10: paid live-data backups for ESPN. Disabled by default. The
  // operator points at one (or neither) — ESPN remains primary unless
  // a paid key is set, at which point that takes precedence. Cost
  // matters here, so this is opt-in only.
  SPORTRADAR_API_KEY: z.string().optional(),
  SPORTRADAR_ACCESS_LEVEL: z.enum(["trial", "production"]).default("trial"),
  SPORTSDATAIO_API_KEY: z.string().optional()
});

const parsed = EnvSchema.parse(process.env);
const isTest = process.env.NODE_ENV === "test";

export const config = {
  ...parsed,
  RESOLVED_COMMENTARY_PROVIDER:
    isTest ? "local" : parsed.COMMENTARY_PROVIDER === "auto" ? (parsed.OPENAI_API_KEY && parsed.MODEL_PRESET !== "local" ? "openai" : "local") : parsed.COMMENTARY_PROVIDER,
  RESOLVED_MODEL_PROVIDER: isTest ? "mock" : parsed.MODEL_PROVIDER,
  RESOLVED_OPENAI_MODEL: parsed.MODEL_PRESET === "fast" ? parsed.OPENAI_FAST_MODEL : parsed.OPENAI_MODEL,
  RESOLVED_REALTIME_MODEL: parsed.MODEL_PRESET === "fast" ? parsed.OPENAI_REALTIME_FAST_MODEL : parsed.OPENAI_REALTIME_MODEL,
  RESOLVED_TTS_PROVIDER:
    isTest ? "mock" : parsed.TTS_PROVIDER === "auto" ? (parsed.ELEVENLABS_API_KEY && parsed.MODEL_PRESET !== "local" ? "elevenlabs" : "mock") : parsed.TTS_PROVIDER,
  // sota → expressive (eleven_v3 quality), fast/local → low-latency
  // (eleven_flash_v2_5). Earlier this ternary picked the same model
  // on both branches, silently negating the preset switch.
  RESOLVED_ELEVENLABS_MODEL_ID: parsed.MODEL_PRESET === "sota" ? parsed.ELEVENLABS_EXPRESSIVE_MODEL_ID : parsed.ELEVENLABS_MODEL_ID
};
