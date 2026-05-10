import type { MultimodalModelProvider } from "../shared/contracts";
import { config } from "./config";
import { AnthropicVisionModelProvider } from "../providers/anthropicVisionModelProvider";
import { GeminiVisionModelProvider } from "../providers/geminiVisionModelProvider";
import { MockModelProvider } from "../providers/mockModelProvider";
import { NemotronVisionProvider } from "../providers/nemotronVisionProvider";
import { OpenAIVisionModelProvider } from "../providers/openAIVisionModelProvider";
import { VisionModelProviderChain } from "../providers/visionModelProviderChain";
import { registerVisionChain } from "./metrics";

/**
 * Construct the vision provider chain. Shared between Fastify
 * (legacy) and Next.js Route Handlers so they always agree on
 * model selection / fallback order. See createModelProvider in
 * src/server/app.ts (now a thin wrapper).
 *
 * Order: Nemotron Nano Omni first when keyed (the differentiated
 * primary, omni-modal in a single model), then OpenAI / Anthropic
 * / Gemini, then MockModelProvider as a never-throws terminal so
 * downstream code always gets an observation.
 *
 * Idempotent — call once per request without worrying about
 * leaks; the providers are stateless aside from a per-instance
 * OpenAI client which is fine to re-construct.
 */
export function createVisionProvider(): MultimodalModelProvider {
  if (config.RESOLVED_MODEL_PROVIDER === "mock") return new MockModelProvider();

  const providers: MultimodalModelProvider[] = [];
  if (config.NEMOTRON_API_KEY) {
    providers.push(new NemotronVisionProvider(
      config.NEMOTRON_API_KEY,
      config.NEMOTRON_MODEL,
      config.NEMOTRON_ENDPOINT
    ));
  }
  if (config.RESOLVED_MODEL_PROVIDER === "openai-vision" && config.OPENAI_API_KEY) {
    providers.push(new OpenAIVisionModelProvider(config.OPENAI_API_KEY, config.RESOLVED_OPENAI_MODEL));
  }
  if (config.ANTHROPIC_API_KEY) {
    providers.push(new AnthropicVisionModelProvider(config.ANTHROPIC_API_KEY, config.ANTHROPIC_COMMENTARY_MODEL));
  }
  if (config.GOOGLE_API_KEY) {
    providers.push(new GeminiVisionModelProvider(config.GOOGLE_API_KEY, config.GEMINI_COMMENTARY_MODEL));
  }
  providers.push(new MockModelProvider());

  if (providers.length === 1) {
    registerVisionChain(undefined);
    return providers[0]!;
  }
  const chain = new VisionModelProviderChain(providers, { perProviderTimeoutMs: config.COMMENTARY_PROVIDER_TIMEOUT_MS });
  registerVisionChain(chain);
  return chain;
}
