import type { AsrProvider } from "../shared/contracts";
import { config } from "./config";
import { NemotronAsrProvider } from "../providers/nemotronAsrProvider";

/**
 * Construct the ASR provider used by /api/asr/transcribe and the
 * upcoming voice-input flow (W18).
 *
 * Today there's only one keyed vendor — Nvidia Nemotron Nano Omni —
 * so the chain stays single-element. The factory still exists so the
 * route handler doesn't reach into config directly; if we ever add a
 * Whisper / Deepgram backstop we drop it in here.
 *
 * Returns a provider that always responds (even without a key it
 * yields an empty transcript with confidence 0) so route handlers
 * stay simple.
 */
export function createAsrProvider(): AsrProvider {
  return new NemotronAsrProvider(
    config.NEMOTRON_API_KEY,
    config.NEMOTRON_MODEL,
    config.NEMOTRON_ENDPOINT
  );
}
