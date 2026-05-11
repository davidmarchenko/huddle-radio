import { describe, expect, it } from "vitest";
import { createTTSProvider } from "../server/showFactories";
import { config } from "../server/config";

/**
 * createTTSProvider(override) lets the listener flip TTS vendors at
 * runtime via LivecastRequest.ttsProviderOverride. We assert the wiring,
 * not the network behavior of each vendor — those have their own
 * provider tests. The key contract is:
 *
 *   1. omitted/"auto" → the env-resolved default still wins
 *   2. an explicit choice with a configured key → that vendor is used
 *   3. an explicit choice WITHOUT a configured key → falls back to mock
 *      so the show doesn't 500 on a missing secret
 *
 * Tests that need a real key gate themselves on env so CI can run them
 * even on a clean checkout.
 */
describe("createTTSProvider override", () => {
  it("returns the env-resolved default when override is undefined", () => {
    const provider = createTTSProvider();
    // Should match what config resolved at boot. No assertion on a
    // specific vendor — that depends on which keys the dev has set.
    expect(provider.id).toBeDefined();
    expect(typeof provider.id).toBe("string");
  });

  it("returns the env-resolved default when override is 'auto'", () => {
    const auto = createTTSProvider("auto");
    const def = createTTSProvider();
    expect(auto.id).toBe(def.id);
  });

  it("falls back to mock when the chosen vendor has no key configured", () => {
    // Pick whichever of the three is NOT configured locally — that's
    // the safest cell to assert on. If all three are configured (lucky
    // dev), we skip to keep the test deterministic.
    const missing = (["elevenlabs", "fish", "inworld"] as const).find((v) =>
      v === "elevenlabs"
        ? !config.ELEVENLABS_API_KEY
        : v === "fish"
          ? !config.FISH_API_KEY
          : !config.INWORLD_API_KEY
    );
    if (!missing) {
      console.log("[skip] all TTS keys configured — no missing-key cell to test");
      return;
    }
    const provider = createTTSProvider(missing);
    expect(provider.id).toBe("mock-tts");
  });

  it("explicit 'mock' always returns the mock provider", () => {
    expect(createTTSProvider("mock").id).toBe("mock-tts");
  });
});
