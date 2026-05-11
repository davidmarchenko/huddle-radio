import { describe, expect, it, vi } from "vitest";

/**
 * Exercises the ElevenLabs WebSocket streaming TTS protocol.
 *
 * The provider opens a `wss://api.elevenlabs.io/.../stream-input`
 * socket, sends three text frames (initial voice settings, payload,
 * end-of-stream marker), and yields each `{ audio, isFinal }` message
 * as a TTSAudioChunk back to the caller.
 *
 * The unit suite cannot dial real WebSockets, so we mock the `ws`
 * module before importing the provider and drive the fake socket's
 * lifecycle by hand. Three things matter for the contract:
 *   1. Auth: the WebSocket constructor was called with the
 *      `xi-api-key` header set to our key.
 *   2. Protocol: the three opening text frames matched what
 *      ElevenLabs expects (settings + payload + close).
 *   3. Streaming semantics: every `audio` payload becomes one
 *      AudioChunk, `isFinal` ends the iterator, and socket errors
 *      raise through the iterator so callers can recover.
 */

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly options: { headers?: Record<string, string> } | undefined;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(arg?: unknown) => void>>();

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  on(event: string, listener: (arg?: unknown) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  fire(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }

  static latest(): FakeWebSocket {
    const last = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!last) throw new Error("FakeWebSocket has no instances yet.");
    return last;
  }

  static reset(): void {
    FakeWebSocket.instances.length = 0;
  }
}

// Mock the `ws` package BEFORE importing the provider so the provider's
// `import WebSocket from "ws"` resolves to FakeWebSocket. vi.mock is
// hoisted, so the relative ordering with the import below is correct.
vi.mock("ws", () => ({
  default: FakeWebSocket
}));

// Imported AFTER the mock so the provider module captures FakeWebSocket.
const { ElevenLabsTTSProvider } = await import("../providers/ttsProviders");

describe("ElevenLabsTTSProvider streaming protocol", () => {
  it("opens a wss:// connection at the per-voice stream-input URL with xi-api-key auth", async () => {
    FakeWebSocket.reset();
    const provider = new ElevenLabsTTSProvider("test-key", "voice-abc", "model-xyz");
    // Kick off synthesize but don't drain — we just want to inspect
    // the constructor call. Wrap in a microtask drain so the open
    // handler doesn't block the assertions.
    const iterator = provider.synthesize({ commentaryId: "c1", text: "hello" });
    // Consume a single tick so `new WebSocket(...)` runs.
    void iterator[Symbol.asyncIterator]().next();
    // Microtask flush so the `new WebSocket` runs.
    await Promise.resolve();
    const socket = FakeWebSocket.latest();
    expect(socket.url).toBe(
      "wss://api.elevenlabs.io/v1/text-to-speech/voice-abc/stream-input?model_id=model-xyz&auto_mode=true"
    );
    expect(socket.options?.headers?.["xi-api-key"]).toBe("test-key");
    // Tear the iterator down so the open-handler promise doesn't leak.
    socket.fire("close");
  });

  it("sends the three-frame opening protocol (settings, payload, end) on open", async () => {
    FakeWebSocket.reset();
    const provider = new ElevenLabsTTSProvider("k", "v", "m");
    const iterator = provider.synthesize({ commentaryId: "c1", text: "Some commentary text." });
    void iterator[Symbol.asyncIterator]().next();
    await Promise.resolve();
    const socket = FakeWebSocket.latest();
    socket.fire("open");

    expect(socket.sent).toHaveLength(3);
    const [settingsFrame, payloadFrame, closeFrame] = socket.sent.map((s) => JSON.parse(s));
    // Frame 1: warm-up + voice settings.
    expect(settingsFrame).toMatchObject({
      text: " ",
      voice_settings: { stability: 0.45, similarity_boost: 0.75 }
    });
    // Frame 2: actual payload with try_trigger_generation hint.
    expect(payloadFrame).toMatchObject({
      text: "Some commentary text.",
      try_trigger_generation: true
    });
    // Frame 3: empty text closes the input stream.
    expect(closeFrame).toEqual({ text: "" });
    // Cleanup so the iterator promise resolves.
    socket.fire("close");
  });

  it("yields each `audio` message as a TTSAudioChunk and stops iterating on isFinal", async () => {
    FakeWebSocket.reset();
    const provider = new ElevenLabsTTSProvider("k", "v", "m");
    const iterator = provider.synthesize({ commentaryId: "c1", text: "hi" });

    // Start consuming; drive the fake socket between awaits.
    const chunks: Array<{ base64Audio?: string; isFinal: boolean; commentaryId: string }> = [];
    const consume = (async () => {
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
    })();

    // Microtask: provider constructed the socket; fire open then
    // simulate the server pushing two audio chunks then a final.
    await Promise.resolve();
    const socket = FakeWebSocket.latest();
    socket.fire("open");

    socket.fire("message", JSON.stringify({ audio: "AAAA" }));
    socket.fire("message", JSON.stringify({ audio: "BBBB" }));
    socket.fire("message", JSON.stringify({ audio: "CCCC", isFinal: true }));

    await consume;

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      commentaryId: "c1",
      base64Audio: "AAAA",
      isFinal: false
    });
    expect(chunks[2]).toMatchObject({ base64Audio: "CCCC", isFinal: true });
  });

  it("ignores messages without an `audio` field (keep-alives, status pings)", async () => {
    FakeWebSocket.reset();
    const provider = new ElevenLabsTTSProvider("k", "v", "m");
    const iterator = provider.synthesize({ commentaryId: "c1", text: "hi" });
    const chunks: unknown[] = [];
    const consume = (async () => {
      for await (const chunk of iterator) chunks.push(chunk);
    })();

    await Promise.resolve();
    const socket = FakeWebSocket.latest();
    socket.fire("open");
    // Status-only message: no audio field, no isFinal — should not yield.
    socket.fire("message", JSON.stringify({ message: "queued" }));
    socket.fire("message", JSON.stringify({ audio: "AAAA", isFinal: true }));
    await consume;

    expect(chunks).toHaveLength(1);
  });

  it("propagates a socket-level error through the iterator so the caller can recover", async () => {
    FakeWebSocket.reset();
    const provider = new ElevenLabsTTSProvider("k", "v", "m");
    const iterator = provider.synthesize({ commentaryId: "c1", text: "hi" });
    let caught: Error | undefined;
    const consume = (async () => {
      try {
        for await (const _chunk of iterator) {
          // Drain — nothing should arrive before the error fires.
        }
      } catch (error) {
        caught = error as Error;
      }
    })();

    await Promise.resolve();
    const socket = FakeWebSocket.latest();
    socket.fire("open");
    socket.fire("error");
    await consume;
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/ElevenLabs WebSocket error/);
  });

  it("throws synchronously when no API key is configured (fail fast, before opening the socket)", async () => {
    const provider = new ElevenLabsTTSProvider(undefined);
    const iterator = provider.synthesize({ commentaryId: "c1", text: "hi" });
    // The first .next() awaits the generator's first yield/throw.
    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });
});
