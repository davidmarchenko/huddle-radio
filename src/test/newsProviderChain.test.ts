import { describe, expect, it } from "vitest";
import { NewsProviderChain } from "../providers/newsProviderChain";
import type { NewsItem, NewsProvider, ProviderHealth } from "../shared/contracts";

class FakeNewsProvider implements NewsProvider {
  id: string;
  constructor(
    id: string,
    private readonly behavior: () => Promise<NewsItem[]>,
    private readonly status: ProviderHealth["status"] = "ready"
  ) {
    this.id = id;
  }
  getLatest(): Promise<NewsItem[]> {
    return this.behavior();
  }
  async health(): Promise<ProviderHealth> {
    return { id: this.id, label: this.id, status: this.status, detail: "fake" };
  }
}

const sample: NewsItem = {
  id: "n1",
  title: "Hello",
  source: "Test",
  publishedAt: "2026-05-09T00:00:00Z"
};

describe("NewsProviderChain", () => {
  it("returns the first provider's non-empty result", async () => {
    const chain = new NewsProviderChain([
      new FakeNewsProvider("primary", async () => [sample]),
      new FakeNewsProvider("backup", async () => [{ ...sample, id: "n2", title: "Backup" }])
    ]);
    const items = await chain.getLatest({ playerIds: [], teams: [], sport: "nfl" });
    expect(items.map((i) => i.title)).toEqual(["Hello"]);
  });

  it("falls through when the primary throws", async () => {
    const chain = new NewsProviderChain([
      new FakeNewsProvider("primary", async () => {
        throw new Error("ESPN broken");
      }),
      new FakeNewsProvider("backup", async () => [sample])
    ]);
    const items = await chain.getLatest({ playerIds: [], teams: [], sport: "nfl" });
    expect(items).toHaveLength(1);
    expect(chain.getFallbackStats()).toMatchObject({ primary: 1 });
  });

  it("advances when a provider returns nothing relevant", async () => {
    const chain = new NewsProviderChain([
      new FakeNewsProvider("primary", async () => []),
      new FakeNewsProvider("backup", async () => [sample])
    ]);
    const items = await chain.getLatest({ playerIds: [], teams: [], sport: "nfl" });
    expect(items).toHaveLength(1);
  });

  it("times out a hung provider and advances", async () => {
    const chain = new NewsProviderChain(
      [
        new FakeNewsProvider("primary", () => new Promise(() => {})),
        new FakeNewsProvider("backup", async () => [sample])
      ],
      { perProviderTimeoutMs: 30 }
    );
    const items = await chain.getLatest({ playerIds: [], teams: [], sport: "nfl" });
    expect(items).toHaveLength(1);
  });

  it("returns empty when every provider fails (no terminal data)", async () => {
    const chain = new NewsProviderChain([
      new FakeNewsProvider("primary", async () => {
        throw new Error("a");
      }),
      new FakeNewsProvider("backup", async () => {
        throw new Error("b");
      })
    ]);
    expect(await chain.getLatest({ playerIds: [], teams: [], sport: "nfl" })).toEqual([]);
  });

  it("health reports the highest-tier ready provider", async () => {
    const chain = new NewsProviderChain([
      new FakeNewsProvider("primary", async () => [], "error"),
      new FakeNewsProvider("backup", async () => [], "ready")
    ]);
    const health = await chain.health();
    expect(health.status).toBe("ready");
    expect(health.label).toContain("backup");
  });
});
