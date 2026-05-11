import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InworldTtsProvider } from "../providers/inworldTtsProvider";

/**
 * Contract test for InworldTtsProvider.
 *
 * Inworld TTS-2 is HTTP-only on the basic /tts/v1/voice route — Basic
 * auth, JSON request with voiceId + modelId, JSON response with
 * audioContent as base64. We mock global fetch and verify:
 *
 *   1. Auth header is `Basic ${apiKey}` (NOT Bearer).
 *   2. Body includes the resolved per-host voice (with fallback).
 *   3. Audio response is forwarded as a single TTSAudioChunk.
 *   4. Non-retryable errors throw immediately so the chain falls back.
 *   5. 429/5xx retries with backoff.
 */

describe("InworldTtsProvider", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const ok = (audioContent: string) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ audioContent })
  });

  async function collectChunks(iter: AsyncIterable<{ base64Audio?: string }>) {
    const out: Array<{ base64Audio?: string }> = [];
    for await (const c of iter) out.push(c);
    return out;
  }

  it("POSTs to /tts/v1/voice with Basic auth, voiceId, modelId, and CREATIVE delivery mode", async () => {
    mockFetch.mockResolvedValue(ok("AAAA"));
    const provider = new InworldTtsProvider("test-key", "default-voice", "inworld-tts-2", {
      theo: "theo-voice"
    });
    const chunks = await collectChunks(
      provider.synthesize({ commentaryId: "c1", text: "Hello world", hostId: "theo" })
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.inworld.ai/tts/v1/voice");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Basic test-key");

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      text: "Hello world",
      voiceId: "theo-voice",
      modelId: "inworld-tts-2",
      audioConfig: { audioEncoding: "MP3", sampleRateHertz: 44100 },
      deliveryMode: "CREATIVE",
      temperature: 1.0
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].base64Audio).toBe("AAAA");
  });

  it("falls back to the default voice when a host has no override", async () => {
    mockFetch.mockResolvedValue(ok("BBBB"));
    const provider = new InworldTtsProvider("k", "fallback-voice", "inworld-tts-2", {});
    await collectChunks(provider.synthesize({ commentaryId: "c2", text: "x", hostId: "cam" }));
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.voiceId).toBe("fallback-voice");
  });

  it("trims text over the 1900-char safety cap so we don't 400 on long turns", async () => {
    mockFetch.mockResolvedValue(ok("CCCC"));
    const provider = new InworldTtsProvider("k", "v", "inworld-tts-2", {});
    const longText = "a".repeat(2500);
    await collectChunks(provider.synthesize({ commentaryId: "c3", text: longText }));
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.text.length).toBe(1900);
  });

  it("throws on 401 (non-retryable) so the chain falls back", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized")
    });
    const provider = new InworldTtsProvider("bad-key", "v", "inworld-tts-2", {});
    await expect(
      collectChunks(provider.synthesize({ commentaryId: "c4", text: "hi" }))
    ).rejects.toThrow(/HTTP 401/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries 429 with backoff before giving up", async () => {
    vi.useFakeTimers();
    const _429 = { ok: false, status: 429, text: () => Promise.resolve("rate limited") };
    mockFetch
      .mockResolvedValueOnce(_429 as never)
      .mockResolvedValueOnce(_429 as never)
      .mockResolvedValueOnce(ok("DDDD") as never);

    const provider = new InworldTtsProvider("k", "v", "inworld-tts-2", {});
    const iter = provider.synthesize({ commentaryId: "c5", text: "retry" });
    const collect = collectChunks(iter);
    await vi.runAllTimersAsync();
    const chunks = await collect;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].base64Audio).toBe("DDDD");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("throws if api key is missing", async () => {
    const provider = new InworldTtsProvider(undefined, "v", "inworld-tts-2", {});
    await expect(
      collectChunks(provider.synthesize({ commentaryId: "c6", text: "x" }))
    ).rejects.toThrow(/INWORLD_API_KEY/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOT implement synthesizeDialogue — engine falls back to per-line synth", async () => {
    const provider = new InworldTtsProvider("k", "v", "inworld-tts-2", {});
    // Inworld has no native multi-speaker; the absence of the method
    // is part of the contract the engine's selectTTSStrategy reads.
    expect((provider as unknown as { synthesizeDialogue?: unknown }).synthesizeDialogue).toBeUndefined();
  });
});
