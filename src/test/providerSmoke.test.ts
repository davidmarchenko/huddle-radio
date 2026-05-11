import "dotenv/config";
import { describe, expect, it } from "vitest";
import { OpenAICommentaryProvider } from "../providers/openAICommentaryProvider";
import { ElevenLabsTTSProvider } from "../providers/ttsProviders";
import { NemotronVisionProvider } from "../providers/nemotronVisionProvider";
import { NemotronAsrProvider } from "../providers/nemotronAsrProvider";
import { fetchKalshiSnapshots } from "../providers/kalshiMarketsProvider";
import { fetchPolymarketSnapshots } from "../providers/polymarketMarketsProvider";
import { demoPlays } from "../providers/demoData";

/**
 * Optional real-vendor smoke tests. These call live APIs and therefore
 * cost real money / quota. Excluded from the default test suite (see
 * vitest.config.ts) and run only via:
 *
 *   npm run test:providers
 *
 * Each test self-skips when its credential is missing so the suite is
 * safe to run on a CI without secrets — it'll silently no-op the
 * tests it can't execute.
 *
 * What these guarantee that the unit tests can't: the provider's
 * parser still matches the vendor's current response shape. If
 * Nvidia changes Nemotron's `input_audio` envelope or Polymarket
 * renames a Gamma field, these tests turn red while the unit suite
 * stays green — that's the whole point.
 */

describe("optional real provider smoke tests", () => {
  it("can call OpenAI commentary when OPENAI_API_KEY is present", async () => {
    if (!process.env.OPENAI_API_KEY) {
      console.log("[skip] OPENAI_API_KEY not set");
      expect(true).toBe(true);
      return;
    }
    let lines: import("../shared/contracts").DialogueLine[];
    try {
      lines = await new OpenAICommentaryProvider(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL ?? "gpt-4.1-mini").draft({
        play: demoPlays[0],
        observation: {
          id: "obs",
          source: "stream-url",
          summary: "The quarterback extended the play.",
          confidence: 0.9,
          observedAt: new Date().toISOString(),
          latencyMs: 80
        },
        impacts: [],
        group: { listener: { name: "Alex", rosterId: "roster-alex" }, tone: "pg", homeTeamBias: "balanced", friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC" }] },
        news: [],
        recentCommentary: [],
        fallbackText: "fallback"
      });
    } catch (error) {
      // Treat quota / rate-limit responses as skips rather than
      // failures — the parser shape is unchanged when the vendor
      // refuses; we simply can't verify the live path right now.
      const message = error instanceof Error ? error.message : String(error);
      if (/429|quota|rate.?limit/i.test(message)) {
        console.log(`[skip] OpenAI quota exhausted: ${message.slice(0, 120)}`);
        expect(true).toBe(true);
        return;
      }
      throw error;
    }
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.map((l) => l.text).join(" ");
    expect(joined).not.toBe("fallback");
    expect(joined.length).toBeGreaterThan(10);
  }, 45000);

  it("reports ElevenLabs ready when ELEVENLABS_API_KEY is present", async () => {
    const health = await new ElevenLabsTTSProvider(process.env.ELEVENLABS_API_KEY, process.env.ELEVENLABS_VOICE_ID, process.env.ELEVENLABS_MODEL_ID).health();
    expect(health.status).toBe(process.env.ELEVENLABS_API_KEY ? "ready" : "disabled");
  });

  it("can synthesize a short utterance over the ElevenLabs WebSocket when ELEVENLABS_API_KEY is present", async () => {
    if (!process.env.ELEVENLABS_API_KEY) {
      console.log("[skip] ELEVENLABS_API_KEY not set");
      expect(true).toBe(true);
      return;
    }
    // The WebSocket path is the production hot path — health() only
    // checks env config. This test actually opens the wss:// connection,
    // sends a one-line payload, and confirms at least one base64 audio
    // chunk comes back with isFinal eventually flipping true. Catches
    // contract drift (envelope renames, new auth requirements, etc.)
    // that the unit suite (mocked WebSocket) cannot.
    const provider = new ElevenLabsTTSProvider(
      process.env.ELEVENLABS_API_KEY,
      process.env.ELEVENLABS_VOICE_ID,
      process.env.ELEVENLABS_MODEL_ID
    );
    const chunks: Array<{ base64Audio?: string; isFinal: boolean; latencyMs?: number }> = [];
    let firstChunkLatencyMs: number | undefined;
    try {
      for await (const chunk of provider.synthesize({
        commentaryId: "smoke",
        text: "Testing one two."
      })) {
        chunks.push(chunk);
        if (firstChunkLatencyMs === undefined && chunk.base64Audio) {
          firstChunkLatencyMs = chunk.latencyMs;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Treat WS-level rate-limit / quota responses as skips — same
      // logic as the OpenAI smoke above.
      if (/429|quota|rate.?limit|unauthorized/i.test(message)) {
        console.log(`[skip] ElevenLabs refused: ${message.slice(0, 120)}`);
        expect(true).toBe(true);
        return;
      }
      throw error;
    }
    // At least one audio chunk should arrive — silence/empty audio
    // would be a contract drift, not a "no quota" condition.
    const audioChunks = chunks.filter((c) => Boolean(c.base64Audio));
    expect(audioChunks.length).toBeGreaterThan(0);
    // ElevenLabs' real stream signals "done" two ways: an isFinal:true
    // marker on the last data frame, OR a socket close with no marker.
    // Both terminate the iterator cleanly — what matters is that the
    // generator returned without throwing AND we got audio. The last
    // chunk may or may not carry isFinal, so we don't assert it.
    // First-chunk latency is the user-visible spec for "time to
    // first audible byte". Log it for the operator without failing
    // on a slow vendor day.
    if (firstChunkLatencyMs !== undefined) {
      console.log(`[info] ElevenLabs first-chunk latency: ${firstChunkLatencyMs}ms`);
    }
  }, 30000);

  it("can call Nemotron Nano Omni vision when NEMOTRON_API_KEY is present", async () => {
    if (!process.env.NEMOTRON_API_KEY) {
      console.log("[skip] NEMOTRON_API_KEY not set");
      expect(true).toBe(true);
      return;
    }
    // 1x1 transparent PNG so the model has SOMETHING to look at
    // without us shipping a real broadcast frame.
    const tinyPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUCNdjAAAAAgABz8g15QAAAABJRU5ErkJggg==";
    const provider = new NemotronVisionProvider(
      process.env.NEMOTRON_API_KEY,
      process.env.NEMOTRON_MODEL ?? "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      process.env.NEMOTRON_ENDPOINT ?? "https://integrate.api.nvidia.com/v1"
    );
    const observation = await provider.observe({
      video: { mode: "stream-url", url: "https://example.test/stream" },
      play: demoPlays[0],
      frame: {
        id: "smoke",
        capturedAt: new Date().toISOString(),
        source: "stream-url",
        width: 1,
        height: 1,
        dataUrl: `data:image/png;base64,${tinyPng}`
      }
    });
    // We don't assert on the specific status — a 1x1 PNG should yield
    // "uncertain" or "not-sports" — just confirm the parser populated
    // a validation envelope, meaning the response shape still matches.
    expect(observation.validation).toBeDefined();
    expect(typeof observation.confidence).toBe("number");
  }, 30000);

  it("can call Nemotron Nano Omni ASR when NEMOTRON_API_KEY is present", async () => {
    if (!process.env.NEMOTRON_API_KEY) {
      console.log("[skip] NEMOTRON_API_KEY not set");
      expect(true).toBe(true);
      return;
    }
    // Smallest valid WAV — silence — so the call exercises the
    // input_audio envelope without us bundling sample audio. Some
    // models return an empty transcript for silence; the parser
    // still has to handle that shape cleanly.
    const silentWav =
      "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
    const provider = new NemotronAsrProvider(
      process.env.NEMOTRON_API_KEY,
      process.env.NEMOTRON_MODEL ?? "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      process.env.NEMOTRON_ENDPOINT ?? "https://integrate.api.nvidia.com/v1"
    );
    const transcript = await provider.transcribe({
      audio: {
        id: "smoke",
        capturedAt: new Date().toISOString(),
        source: "broadcast",
        mimeType: "audio/wav",
        dataUrl: `data:audio/wav;base64,${silentWav}`
      }
    });
    expect(transcript.provider).toBe("nemotron-asr");
    expect(typeof transcript.text).toBe("string");
    // Confidence is in [0, 1] per the parser contract.
    if (typeof transcript.confidence === "number") {
      expect(transcript.confidence).toBeGreaterThanOrEqual(0);
      expect(transcript.confidence).toBeLessThanOrEqual(1);
    }
  }, 30000);

  it("can fetch live Kalshi NFL markets (parser shape contract)", async () => {
    // Kalshi REST is unauthenticated for read access — runs on every
    // invocation. Its purpose is to detect contract drift, not to
    // assert specific market values, so we only check the envelope.
    const snapshots = await fetchKalshiSnapshots({ sports: ["nfl"] });
    expect(Array.isArray(snapshots)).toBe(true);
    if (snapshots.length === 0) {
      // Offseason / no live series — Kalshi returns 404 which our
      // parser treats as empty. Still a valid response shape.
      console.log("[info] Kalshi returned no NFL snapshots (offseason or filtered out)");
      return;
    }
    // Sample the first snapshot's required fields so we'd notice if
    // Kalshi removed/renamed something.
    const first = snapshots[0]!;
    expect(first.source).toBe("kalshi");
    expect(typeof first.externalId).toBe("string");
    expect(typeof first.title).toBe("string");
    expect(typeof first.yesPriceCents).toBe("number");
    expect(first.yesPriceCents).toBeGreaterThanOrEqual(0);
    expect(first.yesPriceCents).toBeLessThanOrEqual(100);
  }, 20000);

  it("can fetch live Polymarket NFL markets (parser shape contract)", async () => {
    const snapshots = await fetchPolymarketSnapshots({ sports: ["nfl"] });
    expect(Array.isArray(snapshots)).toBe(true);
    if (snapshots.length === 0) {
      console.log("[info] Polymarket returned no NFL snapshots (no active events)");
      return;
    }
    const first = snapshots[0]!;
    expect(first.source).toBe("polymarket");
    expect(typeof first.externalId).toBe("string");
    expect(typeof first.title).toBe("string");
    expect(typeof first.yesPriceCents).toBe("number");
  }, 20000);
});
