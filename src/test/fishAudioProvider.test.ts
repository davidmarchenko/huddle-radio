import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";

/**
 * Contract test for FishAudioTTSProvider.
 *
 * The provider opens a `wss://api.fish.audio/v1/tts/live` WebSocket,
 * sends three MessagePack-encoded events (start with reference_id
 * array, text with optional [speaker_N] tags, stop), and yields each
 * `{ event: "audio", audio }` message as a TTSAudioChunk. We mock the
 * `ws` module so we can drive the FakeWebSocket lifecycle by hand and
 * verify three things:
 *
 *   1. Auth + model headers are correct.
 *   2. The wire format is MessagePack (we DECODE what was sent and
 *      assert the structure).
 *   3. Multi-speaker requests pack `reference_id` as an array and pass
 *      `[speaker_N]`-tagged text through; single-speaker requests pack
 *      a single-element array.
 */

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly options: { headers?: Record<string, string> } | undefined;
  readonly sent: Buffer[] = [];
  readonly listeners = new Map<string, Array<(arg?: unknown, arg2?: unknown) => void>>();

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  on(event: string, listener: (arg?: unknown, arg2?: unknown) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  send(payload: Buffer | Uint8Array): void {
    this.sent.push(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
  }

  close(): void {
    /* no-op for tests */
  }

  fire(event: string, arg?: unknown, arg2?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg, arg2);
  }

  static latest(): FakeWebSocket {
    const last = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!last) throw new Error("FakeWebSocket has no instances yet.");
    return last;
  }

  static reset(): void {
    FakeWebSocket.instances.length = 0;
  }

  decodeSent(): Array<Record<string, unknown>> {
    return this.sent.map((buf) => msgpackDecode(buf) as Record<string, unknown>);
  }
}

vi.mock("ws", () => ({ default: FakeWebSocket }));

// Imported AFTER the mock so the provider picks up FakeWebSocket.
const { FishAudioTTSProvider } = await import("../providers/fishAudioProvider");

beforeEach(() => {
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FishAudioTTSProvider — single-speaker streaming", () => {
  it("opens a WS to fish.audio with Bearer auth + model header, sends start/text/stop in msgpack, yields each audio chunk", async () => {
    const provider = new FishAudioTTSProvider("test-key", "default-voice", "s2-pro", {});
    const iter = provider.synthesize({ commentaryId: "c1", text: "Hello", hostId: "theo" });
    const collected: Array<{ base64Audio?: string }> = [];

    const consume = (async () => {
      for await (const chunk of iter) {
        collected.push({ base64Audio: chunk.base64Audio });
      }
    })();

    // Wait for the constructor to register the FakeWebSocket.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const sock = FakeWebSocket.latest();
    expect(sock.url).toBe("wss://api.fish.audio/v1/tts/live");
    expect(sock.options?.headers?.Authorization).toBe("Bearer test-key");
    expect(sock.options?.headers?.model).toBe("s2-pro");

    // Drive the WS lifecycle: open → send → receive audio → finish.
    sock.fire("open");
    // After "open" the provider should have sent three msgpack frames.
    const sent = sock.decodeSent();
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({
      event: "start",
      request: expect.objectContaining({
        reference_id: ["default-voice"],
        format: "mp3"
      })
    });
    expect(sent[1]).toEqual({ event: "text", text: "Hello" });
    expect(sent[2]).toEqual({ event: "stop" });

    // Server sends 2 audio chunks, then finish.
    sock.fire("message", msgpackEncode({ event: "audio", audio: Buffer.from([0x01, 0x02]) }));
    sock.fire("message", msgpackEncode({ event: "audio", audio: Buffer.from([0x03, 0x04]) }));
    sock.fire("message", msgpackEncode({ event: "finish", reason: "stop" }));
    await consume;

    expect(collected).toHaveLength(2);
    // Each audio chunk's base64 round-trips back to the original bytes.
    expect(Buffer.from(collected[0].base64Audio!, "base64")).toEqual(Buffer.from([0x01, 0x02]));
    expect(Buffer.from(collected[1].base64Audio!, "base64")).toEqual(Buffer.from([0x03, 0x04]));
  });

  it("uses per-host voice override when one is configured", async () => {
    const provider = new FishAudioTTSProvider("k", "default-voice", "s2-pro", { theo: "theo-voice" });
    const iter = provider.synthesize({ commentaryId: "c1", text: "Hi", hostId: "theo" });
    const consume = (async () => {
      for await (const _ of iter) {
        /* drain */
      }
    })();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const sock = FakeWebSocket.latest();
    sock.fire("open");
    const start = sock.decodeSent()[0];
    expect(start).toMatchObject({ request: expect.objectContaining({ reference_id: ["theo-voice"] }) });
    sock.fire("message", msgpackEncode({ event: "finish", reason: "stop" }));
    await consume;
  });

  it("surfaces a non-1000 close as an error so the chain falls back", async () => {
    const provider = new FishAudioTTSProvider("k", "v", "s2-pro", {});
    const iter = provider.synthesize({ commentaryId: "c1", text: "Hi" });
    const promise = (async () => {
      for await (const _ of iter) {
        /* drain */
      }
    })();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const sock = FakeWebSocket.latest();
    sock.fire("open");
    sock.fire("close", 1011, Buffer.from("model unavailable"));
    await expect(promise).rejects.toThrow(/Fish WebSocket closed/);
  });
});

describe("FishAudioTTSProvider — multi-speaker dialogue", () => {
  it("packs distinct voices into reference_id and tags turns with [speaker_N]", async () => {
    const provider = new FishAudioTTSProvider("k", "fallback", "s2-pro", {
      theo: "voice-theo",
      maya: "voice-maya",
      cam: "voice-cam"
    });
    const promise = provider.synthesizeDialogue({
      commentaryId: "c1",
      turns: [
        { hostId: "theo", text: "Frame this for me." },
        { hostId: "maya", text: "Number says yes." },
        { hostId: "theo", text: "Right." },
        { hostId: "cam", text: "Hot take incoming." }
      ]
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const sock = FakeWebSocket.latest();
    sock.fire("open");

    const sent = sock.decodeSent();
    expect(sent[0]).toMatchObject({
      event: "start",
      request: expect.objectContaining({
        // Three distinct hosts → three reference IDs in encounter order.
        reference_id: ["voice-theo", "voice-maya", "voice-cam"]
      })
    });
    // The text event tags each turn with the speaker index that matches
    // its position in reference_id. Theo is index 0 (appears first and
    // also again later), Maya is 1, Cam is 2.
    expect(sent[1]).toEqual({
      event: "text",
      text:
        "[speaker_0] Frame this for me. " +
        "[speaker_1] Number says yes. " +
        "[speaker_0] Right. " +
        "[speaker_2] Hot take incoming."
    });
    expect(sent[2]).toEqual({ event: "stop" });

    sock.fire("message", msgpackEncode({ event: "audio", audio: Buffer.from([0xaa]) }));
    sock.fire("message", msgpackEncode({ event: "audio", audio: Buffer.from([0xbb]) }));
    sock.fire("message", msgpackEncode({ event: "finish", reason: "stop" }));

    const result = await promise;
    expect(result.commentaryId).toBe("c1");
    expect(result.provider).toBe("fish-audio");
    expect(result.isFinal).toBe(true);
    // Combined base64 should decode to the concatenation of both audio frames.
    expect(Buffer.from(result.base64Audio!, "base64")).toEqual(Buffer.from([0xaa, 0xbb]));
  });

  it("throws if no chunks come back (silent failure trap)", async () => {
    const provider = new FishAudioTTSProvider("k", "v", "s2-pro", {});
    const promise = provider.synthesizeDialogue({
      commentaryId: "c2",
      turns: [{ hostId: "theo", text: "x" }]
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const sock = FakeWebSocket.latest();
    sock.fire("open");
    // Finish without any audio — should surface as a failure.
    sock.fire("message", msgpackEncode({ event: "finish", reason: "stop" }));
    await expect(promise).rejects.toThrow(/no audio chunks/);
  });
});

describe("FishAudioTTSProvider — health", () => {
  it("reports needs-key when no API key is set", async () => {
    const provider = new FishAudioTTSProvider(undefined, "v", "s2-pro", {});
    const h = await provider.health();
    expect(h.status).toBe("disabled");
  });

  it("reports ready when key is set", async () => {
    const provider = new FishAudioTTSProvider("present", "v", "s2-pro", {});
    const h = await provider.health();
    expect(h.status).toBe("ready");
  });
});
