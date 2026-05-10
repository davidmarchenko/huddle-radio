import { AnthropicCommentaryProvider } from "../providers/anthropicCommentaryProvider";
import { CommentaryProviderChain } from "../providers/commentaryProviderChain";
import { GeminiCommentaryProvider } from "../providers/geminiCommentaryProvider";
import { LocalCommentaryProvider, OpenAICommentaryProvider, type CommentaryProvider } from "../providers/openAICommentaryProvider";
import { config } from "./config";
import { registerCommentaryChain } from "./metrics";

/**
 * Single source of truth for commentary-provider construction.
 *
 * Builds an ordered fallback chain based on which env vars are present.
 * OpenAI is primary when configured; Anthropic and Gemini activate only
 * when their respective API keys are set; LocalCommentaryProvider is
 * always terminal so the chain never throws on the happy path.
 */
export function createCommentaryProvider(): CommentaryProvider {
  const providers: CommentaryProvider[] = [];

  if (config.RESOLVED_COMMENTARY_PROVIDER === "openai" && config.OPENAI_API_KEY) {
    providers.push(new OpenAICommentaryProvider(config.OPENAI_API_KEY, config.RESOLVED_OPENAI_MODEL, config.OPENAI_REASONING_EFFORT));
  }
  if (config.ANTHROPIC_API_KEY) {
    providers.push(new AnthropicCommentaryProvider(config.ANTHROPIC_API_KEY, config.ANTHROPIC_COMMENTARY_MODEL));
  }
  if (config.GOOGLE_API_KEY) {
    providers.push(new GeminiCommentaryProvider(config.GOOGLE_API_KEY, config.GEMINI_COMMENTARY_MODEL));
  }
  // Terminal fallback — deterministic templates. Never throws.
  providers.push(new LocalCommentaryProvider());

  if (providers.length === 1) {
    // Only the local fallback is configured — no point wrapping it.
    registerCommentaryChain(undefined);
    return providers[0];
  }
  const chain = new CommentaryProviderChain(providers, {
    perProviderTimeoutMs: config.COMMENTARY_PROVIDER_TIMEOUT_MS
  });
  registerCommentaryChain(chain);
  return chain;
}

/**
 * Active provider summary for the diagnostics surface.
 */
export function describeCommentaryStack(): string {
  const labels: string[] = [];
  if (config.RESOLVED_COMMENTARY_PROVIDER === "openai" && config.OPENAI_API_KEY) {
    labels.push(`OpenAI ${config.RESOLVED_OPENAI_MODEL}`);
  }
  if (config.ANTHROPIC_API_KEY) labels.push(`Anthropic ${config.ANTHROPIC_COMMENTARY_MODEL}`);
  if (config.GOOGLE_API_KEY) labels.push(`Gemini ${config.GEMINI_COMMENTARY_MODEL}`);
  labels.push("Local fallback");
  return labels.join(" → ");
}
