import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsTTSProvider } from "../providers/ttsProviders";

/**
 * Contract test for ElevenLabs Text-to-Dialogue.
 *
 * The provider POSTs the full multi-turn payload to /v1/text-to-dialogue
 * with per-turn voice_ids and gets back a single MP3 binary. We mock
 * `fetch` and verify three things:
 *   1. The endpoint URL, method, and headers match ElevenLabs spec.
 *   2. The body wraps `inputs[]` with per-turn voice_ids resolved from
 *      the host voice map (Maya/Theo/Cam → distinct voice ids).
 *   3. A single TTSAudioChunk with base64 audio comes back, and
 *      `model_id: "eleven_v3"` is forced regardless of the instance's
 *      configured streaming model (T2D is v3-only).
 */
describe("ElevenLabsTTSProvider.synthesizeDialogue", () => {
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

  const okResponse = () => ({
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new Uint8Array([0x01, 0x02, 0x03, 0x04]).buffer)
  });

  it("POSTs to /v1/text-to-dialogue with per-turn voice_ids and forces eleven_v3", async () => {
    mockFetch.mockResolvedValue(okResponse());
    const provider = new ElevenLabsTTSProvider("test-key", "default-voice", "eleven_flash_v2_5", {
      maya: "voice-maya",
      theo: "voice-theo",
      cam: "voice-cam"
    });
    const chunk = await provider.synthesizeDialogue({
      commentaryId: "c1",
      turns: [
        { hostId: "theo", text: "Welcome in." },
        { hostId: "maya", text: "Numbers say this is a 4-point favorite." },
        { hostId: "cam", text: "Hot take incoming." }
      ]
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-dialogue");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    // T2D is v3-only — even though the instance is configured for
    // flash_v2_5 streaming, dialogue MUST send v3.
    expect(body.model_id).toBe("eleven_v3");
    expect(body.inputs).toEqual([
      { text: "Welcome in.", voice_id: "voice-theo" },
      { text: "Numbers say this is a 4-point favorite.", voice_id: "voice-maya" },
      { text: "Hot take incoming.", voice_id: "voice-cam" }
    ]);
    expect(chunk.commentaryId).toBe("c1");
    expect(chunk.provider).toBe("elevenlabs");
    expect(chunk.mimeType).toBe("audio/mpeg");
    expect(chunk.base64Audio).toBeTruthy();
    expect(chunk.isFinal).toBe(true);
  });

  it("falls back to the default voice when a host has no per-host override", async () => {
    mockFetch.mockResolvedValue(okResponse());
    const provider = new ElevenLabsTTSProvider("test-key", "fallback-voice", "eleven_v3", {});
    await provider.synthesizeDialogue({
      commentaryId: "c2",
      turns: [{ hostId: "theo", text: "Solo monologue." }]
    });
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.inputs).toEqual([{ text: "Solo monologue.", voice_id: "fallback-voice" }]);
  });

  it("throws on non-429 HTTP errors so the chain falls back to per-line synth", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized")
    });
    const provider = new ElevenLabsTTSProvider("bad-key", "v", "eleven_v3", {});
    await expect(
      provider.synthesizeDialogue({ commentaryId: "c3", turns: [{ hostId: "theo", text: "hi" }] })
    ).rejects.toThrow(/HTTP 401/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 with backoff before giving up", async () => {
    vi.useFakeTimers();
    const _429 = {
      ok: false,
      status: 429,
      text: () => Promise.resolve("rate limited"),
      headers: { get: () => null }
    };
    mockFetch
      .mockResolvedValueOnce(_429 as never)
      .mockResolvedValueOnce(_429 as never)
      .mockResolvedValueOnce(okResponse() as never);

    const provider = new ElevenLabsTTSProvider("k", "v", "eleven_v3", {});
    const promise = provider.synthesizeDialogue({
      commentaryId: "c4",
      turns: [{ hostId: "theo", text: "retryable" }]
    });
    // Run all pending timers to fast-forward backoff sleeps.
    await vi.runAllTimersAsync();
    const chunk = await promise;
    expect(chunk.isFinal).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("throws if api key is missing", async () => {
    const provider = new ElevenLabsTTSProvider(undefined, "v", "eleven_v3", {});
    await expect(
      provider.synthesizeDialogue({ commentaryId: "c5", turns: [{ hostId: "theo", text: "x" }] })
    ).rejects.toThrow(/ELEVENLABS_API_KEY/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
