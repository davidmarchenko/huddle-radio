import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ProviderDiagnostics } from "../shared/contracts";
import { config } from "./config";
import { getActiveProviders, getHealth } from "./showFactories";

/**
 * Diagnostics view: provider health + per-feature readiness checks.
 * Surfaces in the producer panel so the listener can see at a glance
 * which integrations are configured and which are degraded.
 *
 * Pure read — no I/O beyond a stat() of the local media-cache
 * manifest. Safe to call as often as the UI wants.
 */
export async function buildDiagnostics(
  sportsDataMode: "demo" | "espn" = config.SPORTS_DATA_PROVIDER
): Promise<ProviderDiagnostics> {
  const health = await getHealth();
  // Media cache check: only meaningful in dev / single-instance
  // deploys with a writable filesystem. On Vercel the public/ dir
  // ships static, so existsSync still works but mtime reflects the
  // build, not a freshly run `npm run media:cache`.
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
