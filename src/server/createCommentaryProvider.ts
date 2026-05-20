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

  // RESOLVED_COMMENTARY_PROVIDER === "local" means "do not call any
  // LLM commentary provider, just use the deterministic local
  // templates." NODE_ENV=test forces this so the suite can't
  // accidentally hit a real API. Previously the Anthropic + Google
  // branches checked key presence in isolation and would add LLM
  // providers to the chain even when the resolved mode was "local" —
  // adding ANTHROPIC_API_KEY for evals broke 8 integration tests
  // because they suddenly tried to call Anthropic against the real
  // endpoint and timed out. Gate the LLM branches on the resolved
  // mode so "local" really means local.
  const wantLlm = config.RESOLVED_COMMENTARY_PROVIDER !== "local";
  if (wantLlm && config.RESOLVED_COMMENTARY_PROVIDER === "openai" && config.OPENAI_API_KEY) {
    providers.push(new OpenAICommentaryProvider(config.OPENAI_API_KEY, config.RESOLVED_OPENAI_MODEL, config.OPENAI_REASONING_EFFORT));
  }
  if (wantLlm && config.ANTHROPIC_API_KEY) {
    providers.push(new AnthropicCommentaryProvider(config.ANTHROPIC_API_KEY, config.ANTHROPIC_COMMENTARY_MODEL));
  }
  if (wantLlm && config.GOOGLE_API_KEY) {
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
