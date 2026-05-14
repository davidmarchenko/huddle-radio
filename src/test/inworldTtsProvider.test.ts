import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InworldTtsProvider } from "../providers/inworldTtsProvider";

/**
 * Contract test for InworldTtsProvider.
 *
 * The provider streams from /tts/v1/voice:stream — Basic auth, JSON
 * request, response is a series of concatenated JSON frames (NOT
 * NDJSON) each shaped `{ result?: { audioContent?, timestampInfo? },
 * error? }`. We mock global fetch with a ReadableStream body and
 * verify:
 *
 *   1. Auth header is `Basic ${apiKey}` (NOT Bearer).
 *   2. URL is the streaming variant + body includes the resolved voice.
 *   3. `timestampTransportStrategy: "ASYNC"` is set when timestamps on.
 *   4. Multi-frame audio is base64-decoded, concatenated, re-encoded.
 *   5. Trailing timestampInfo frame produces ms-based wordTimings.
 *   6. Non-retryable errors throw immediately so the chain falls back.
 *   7. 429/5xx retries with backoff.
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

  /** Build a Response whose body streams the given JSON frames as
   *  concatenated text (no newline separators — matches Inworld's
   *  documented streaming format). */
  function streamingResponse(frames: unknown[]): {
    ok: true;
    status: 200;
    body: ReadableStream<Uint8Array>;
  } {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(JSON.stringify(frame)));
        }
        controller.close();
      }
    });
    return { ok: true as const, status: 200 as const, body };
  }

  async function collectChunks(
    iter: AsyncIterable<{ base64Audio?: string; wordTimings?: unknown }>
  ) {
    const out: Array<{ base64Audio?: string; wordTimings?: unknown }> = [];
    for await (const c of iter) out.push(c);
    return out;
  }

  it("POSTs to /tts/v1/voice:stream with Basic auth, voiceId, modelId, and CREATIVE delivery mode", async () => {
    mockFetch.mockResolvedValue(streamingResponse([{ result: { audioContent: "AAAA" } }]));
    // timestamps disabled to keep the body assertion tight
    const provider = new InworldTtsProvider("test-key", "default-voice", "inworld-tts-2", {
      theo: "theo-voice"
    }, false);
    const chunks = await collectChunks(
      provider.synthesize({ commentaryId: "c1", text: "Hello world", hostId: "theo" })
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.inworld.ai/tts/v1/voice:stream");
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
    expect(chunks[0].wordTimings).toBeUndefined();
  });

  it("requests ASYNC word-level timestamps when timestamps are enabled", async () => {
    mockFetch.mockResolvedValue(streamingResponse([{ result: { audioContent: "AAAA" } }]));
    const provider = new InworldTtsProvider("k", "v", "inworld-tts-2", {}, true);
    await collectChunks(provider.synthesize({ commentaryId: "c1", text: "hi" }));
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.timestampType).toBe("WORD");
    expect(body.timestampTransportStrategy).toBe("ASYNC");
  });

  it("falls back to the default voice when a host has no override", async () => {
    mockFetch.mockResolvedValue(streamingResponse([{ result: { audioContent: "BBBB" } }]));
    const provider = new InworldTtsProvider("k", "fallback-voice", "inworld-tts-2", {}, false);
    await collectChunks(provider.synthesize({ commentaryId: "c2", text: "x", hostId: "cam" }));
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.voiceId).toBe("fallback-voice");
  });

  it("trims text over the 1900-char safety cap so we don't 400 on long turns", async () => {
    mockFetch.mockResolvedValue(streamingResponse([{ result: { audioContent: "CCCC" } }]));
    const provider = new InworldTtsProvider("k", "v", "inworld-tts-2", {}, false);
    const longText = "a".repeat(2500);
    await collectChunks(provider.synthesize({ commentaryId: "c3", text: longText }));
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.text.length).toBe(1900);
  });

  it("concatenates multi-frame audio bytes into a single base64 chunk", async () => {
    // "Hello" + " world" as base64 fragments — verify the provider
    // decodes, concatenates as bytes, and re-encodes the combined
    // buffer rather than naively concatenating base64 strings.
    const partA = Buffer.from("Hello", "utf8").toString("base64");
    const partB = Buffer.from(" world", "utf8").toString("base64");
    mockFetch.mockResolvedValue(
      streamingResponse([
        { result: { audioContent: partA } },
        { result: { audioContent: partB } }
      ])
    );
    const provider = new InworldTtsProvider("k", "v", "inworld-tts-2", {}, false);
    const chunks = await collectChunks(provider.synthesize({ commentaryId: "c", text: "hi" }));
    expect(chunks).toHaveLength(1);
    const decoded = Buffer.from(chunks[0].base64Audio!, "base64").toString("utf8");
    expect(decoded).toBe("Hello world");
  });

  it("converts trailing timestampInfo frame into ms-based wordTimings", async () => {
    mockFetch.mockResolvedValue(
      streamingResponse([
        { result: { audioContent: "AAAA" } },
        {
          result: {
            timestampInfo: {
              wordAlignment: {
                words: ["Hello", "world"],
                wordStartTimeSeconds: [0, 0.5],
                wordEndTimeSeconds: [0.45, 0.9]
              }
            }
          }
        }
      ])
    );
    const provider = new InworldTtsProvider("k", "v", "inworld-tts-2", {}, true);
    const chunks = await collectChunks(provider.synthesize({ commentaryId: "c", text: "Hello world" }));
    expect(chunks[0].wordTimings).toEqual([
      { text: "Hello", startMs: 0, endMs: 450 },
      { text: "world", startMs: 500, endMs: 900 }
    ]);
  });

  it("throws on 401 (non-retryable) so the chain falls back", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized")
    });
    const provider = new InworldTtsProvider("bad-key", "v", "inworld-tts-2", {}, false);
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
      .mockResolvedValueOnce(streamingResponse([{ result: { audioContent: "DDDD" } }]) as never);

    const provider = new InworldTtsProvider("k", "v", "inworld-tts-2", {}, false);
    const iter = provider.synthesize({ commentaryId: "c5", text: "retry" });
    const collect = collectChunks(iter);
    await vi.runAllTimersAsync();
    const chunks = await collect;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].base64Audio).toBe("DDDD");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("surfaces error frames from the stream", async () => {
    mockFetch.mockResolvedValue(
      streamingResponse([{ error: { message: "voice not found" } }])
    );
    const provider = new InworldTtsProvider("k", "v", "inworld-tts-2", {}, false);
    await expect(
      collectChunks(provider.synthesize({ commentaryId: "c", text: "x" }))
    ).rejects.toThrow(/voice not found/);
  });

  it("throws if api key is missing", async () => {
    const provider = new InworldTtsProvider(undefined, "v", "inworld-tts-2", {}, false);
    await expect(
      collectChunks(provider.synthesize({ commentaryId: "c6", text: "x" }))
    ).rejects.toThrow(/INWORLD_API_KEY/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOT implement synthesizeDialogue — engine falls back to per-line synth", async () => {
    const provider = new InworldTtsProvider("k", "v", "inworld-tts-2", {}, false);
    // Inworld has no native multi-speaker; the absence of the method
    // is part of the contract the engine's selectTTSStrategy reads.
    expect((provider as unknown as { synthesizeDialogue?: unknown }).synthesizeDialogue).toBeUndefined();
  });
});
