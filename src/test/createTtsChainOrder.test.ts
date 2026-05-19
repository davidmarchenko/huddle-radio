import { describe, expect, it } from "vitest";
import { createTTSProvider } from "../server/showFactories";
import { TtsProviderChain } from "../providers/ttsProviderChain";
import { config } from "../server/config";

/**
 * Verifies createTTSProvider assembles the chain in the right order:
 * primary first, then every other vendor with a key set, with Mock
 * as the always-safe tail. The "Inworld stays primary, ElevenLabs
 * catches failures" guarantee depends on this — a refactor that
 * silently reorders the chain (or skips the Mock tail) would let a
 * primary failure drop the listener into silence without anyone
 * noticing until prod logs surfaced it.
 *
 * Tests use the `override` arg to force a specific primary so they
 * don't depend on the test env's RESOLVED_TTS_PROVIDER (which is
 * pinned to "mock" via NODE_ENV=test). Each test guards on the
 * relevant key being configured — a clean checkout with no keys
 * cleanly skips.
 */

function chainProviderIds(provider: ReturnType<typeof createTTSProvider>): string[] | null {
  if (provider instanceof TtsProviderChain) {
    // Reach into the private providers array via a typed unknown cast
    // — same pattern the chain's own tests use. Keeps this test honest
    // about the chain shape without coupling production code to a
    // public accessor it doesn't need.
    const internal = provider as unknown as { providers: Array<{ id: string }> };
    return internal.providers.map((p) => p.id);
  }
  return null;
}

describe("createTTSProvider chain order", () => {
  it("returns the bare mock provider (no chain) when override is 'mock'", () => {
    const provider = createTTSProvider("mock");
    expect(provider.id).toBe("mock-tts");
  });

  it("Inworld primary → chain with [inworld, ...backups, mock]", () => {
    if (!config.INWORLD_API_KEY) {
      console.log("[skip] INWORLD_API_KEY not configured");
      return;
    }
    const provider = createTTSProvider("inworld");
    expect(provider).toBeInstanceOf(TtsProviderChain);
    const ids = chainProviderIds(provider)!;
    expect(ids[0]).toBe("inworld-tts-2");
    expect(ids[ids.length - 1]).toBe("mock-tts");
    // Inworld should appear exactly once — no double-listing as both
    // primary and backup.
    expect(ids.filter((id) => id === "inworld-tts-2")).toHaveLength(1);
  });

  it("ElevenLabs primary → chain with [elevenlabs, ...backups, mock]", () => {
    if (!config.ELEVENLABS_API_KEY) {
      console.log("[skip] ELEVENLABS_API_KEY not configured");
      return;
    }
    const provider = createTTSProvider("elevenlabs");
    expect(provider).toBeInstanceOf(TtsProviderChain);
    const ids = chainProviderIds(provider)!;
    expect(ids[0]).toBe("elevenlabs");
    expect(ids[ids.length - 1]).toBe("mock-tts");
    expect(ids.filter((id) => id === "elevenlabs")).toHaveLength(1);
  });

  it("Inworld primary + ElevenLabs configured → ElevenLabs is a backup", () => {
    if (!config.INWORLD_API_KEY || !config.ELEVENLABS_API_KEY) {
      console.log("[skip] need both Inworld + ElevenLabs keys configured");
      return;
    }
    const provider = createTTSProvider("inworld");
    const ids = chainProviderIds(provider)!;
    const inworldIdx = ids.indexOf("inworld-tts-2");
    const elevenIdx = ids.indexOf("elevenlabs");
    expect(inworldIdx).toBe(0);
    expect(elevenIdx).toBeGreaterThan(0); // not primary
    expect(elevenIdx).toBeLessThan(ids.length - 1); // before mock tail
  });

  it("Mock always anchors the tail — no real-vendor primary can fall through to silence", () => {
    if (!config.INWORLD_API_KEY && !config.ELEVENLABS_API_KEY && !config.FISH_API_KEY) {
      console.log("[skip] no real vendor keys configured");
      return;
    }
    const primary = config.INWORLD_API_KEY
      ? "inworld"
      : config.ELEVENLABS_API_KEY
        ? "elevenlabs"
        : "fish";
    const provider = createTTSProvider(primary);
    const ids = chainProviderIds(provider)!;
    expect(ids[ids.length - 1]).toBe("mock-tts");
  });

  it("missing vendor key + that vendor as override → degrades to bare mock (no chain)", () => {
    const missing = !config.ELEVENLABS_API_KEY
      ? "elevenlabs"
      : !config.FISH_API_KEY
        ? "fish"
        : !config.INWORLD_API_KEY
          ? "inworld"
          : undefined;
    if (!missing) {
      console.log("[skip] every vendor key is set — no missing-key cell to assert");
      return;
    }
    const provider = createTTSProvider(missing);
    expect(provider.id).toBe("mock-tts");
    expect(provider).not.toBeInstanceOf(TtsProviderChain);
  });
});
