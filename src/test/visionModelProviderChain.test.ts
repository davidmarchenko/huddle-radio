import { describe, expect, it } from "vitest";
import { VisionModelProviderChain } from "../providers/visionModelProviderChain";
import type { MultimodalModelProvider, ProviderHealth, SportsPlay, VideoFrameSnapshot, VideoObservation, VideoSourceConfig } from "../shared/contracts";

const play: SportsPlay = {
  id: "p1",
  type: "pass",
  excitement: 3,
  clock: "0:00",
  quarter: "Q1",
  possession: "KC",
  headline: "headline",
  description: "desc",
  playerIds: [],
  team: "KC",
  score: { away: 0, home: 0 },
  occurredAt: "2026-05-09T00:00:00Z"
};

const frame: VideoFrameSnapshot = {
  id: "f1",
  dataUrl: "data:image/png;base64,AAAA",
  capturedAt: "2026-05-09T00:00:00Z",
  source: "stream-url",
  width: 64,
  height: 64
};

const video: VideoSourceConfig = { mode: "stream-url", url: "https://example/stream" };

class FakeVisionProvider implements MultimodalModelProvider {
  id: string;
  constructor(
    id: string,
    private readonly behavior: () => Promise<VideoObservation>,
    private readonly status: ProviderHealth["status"] = "ready"
  ) {
    this.id = id;
  }
  observe(): Promise<VideoObservation> {
    return this.behavior();
  }
  async health(): Promise<ProviderHealth> {
    return { id: this.id, label: this.id, status: this.status, detail: "fake" };
  }
}

const SPORTS_OBS: VideoObservation = {
  id: "obs",
  source: "stream-url",
  summary: "looks like a game",
  confidence: 0.9,
  observedAt: "2026-05-09T00:00:00Z",
  latencyMs: 50,
  validation: {
    status: "sports-event",
    confidence: 0.9,
    evidence: ["scoreboard"],
    reason: "looks legit",
    validatedAt: "2026-05-09T00:00:00Z"
  }
};

const UNAVAILABLE_OBS: VideoObservation = {
  id: "obs-unavail",
  source: "stream-url",
  summary: "no frame",
  confidence: 0,
  observedAt: "2026-05-09T00:00:00Z",
  latencyMs: 5,
  validation: {
    status: "unavailable",
    confidence: 0,
    evidence: [],
    reason: "no frame yet",
    validatedAt: "2026-05-09T00:00:00Z"
  }
};

describe("VisionModelProviderChain", () => {
  it("returns the first usable observation", async () => {
    const chain = new VisionModelProviderChain([
      new FakeVisionProvider("primary", async () => SPORTS_OBS),
      new FakeVisionProvider("backup", async () => UNAVAILABLE_OBS)
    ]);
    const obs = await chain.observe({ video, play, frame });
    expect(obs.validation?.status).toBe("sports-event");
  });

  it("falls through when the primary returns 'unavailable'", async () => {
    const chain = new VisionModelProviderChain([
      new FakeVisionProvider("primary", async () => UNAVAILABLE_OBS),
      new FakeVisionProvider("backup", async () => SPORTS_OBS)
    ]);
    const obs = await chain.observe({ video, play, frame });
    expect(obs.validation?.status).toBe("sports-event");
    expect(chain.getFallbackStats()).toMatchObject({ primary: 1 });
  });

  it("falls through when the primary throws", async () => {
    const chain = new VisionModelProviderChain([
      new FakeVisionProvider("primary", async () => {
        throw new Error("rate limit");
      }),
      new FakeVisionProvider("backup", async () => SPORTS_OBS)
    ]);
    const obs = await chain.observe({ video, play, frame });
    expect(obs.validation?.status).toBe("sports-event");
  });

  it("returns the last unavailable observation when every provider degrades", async () => {
    const chain = new VisionModelProviderChain([
      new FakeVisionProvider("primary", async () => UNAVAILABLE_OBS),
      new FakeVisionProvider("backup", async () => UNAVAILABLE_OBS)
    ]);
    const obs = await chain.observe({ video, play, frame });
    expect(obs.validation?.status).toBe("unavailable");
  });

  it("times out a hung provider and advances", async () => {
    const chain = new VisionModelProviderChain(
      [
        new FakeVisionProvider("primary", () => new Promise(() => {})),
        new FakeVisionProvider("backup", async () => SPORTS_OBS)
      ],
      { perProviderTimeoutMs: 30 }
    );
    const obs = await chain.observe({ video, play, frame });
    expect(obs.validation?.status).toBe("sports-event");
  });

  it("health reports the highest-tier ready provider", async () => {
    const chain = new VisionModelProviderChain([
      new FakeVisionProvider("primary", async () => SPORTS_OBS, "error"),
      new FakeVisionProvider("backup", async () => SPORTS_OBS, "ready")
    ]);
    const health = await chain.health();
    expect(health.status).toBe("ready");
    expect(health.label).toContain("backup");
  });
});
