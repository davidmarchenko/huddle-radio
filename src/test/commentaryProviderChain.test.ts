import { describe, expect, it } from "vitest";
import { CommentaryProviderChain } from "../providers/commentaryProviderChain";
import { LocalCommentaryProvider, type CommentaryProvider } from "../providers/openAICommentaryProvider";
import type { CommentaryDraftInput } from "../providers/commentaryPrompts";
import type { DialogueLine, ProviderHealth } from "../shared/contracts";

/** Helper: wrap a single line of text in the new DialogueLine[] shape. */
const oneLine = (text: string): DialogueLine[] => [{ hostId: "theo", text }];

const baseInput: CommentaryDraftInput = {
  play: {
    id: "p1",
    type: "pass",
    excitement: 3,
    clock: "0:00",
    quarter: "Q1",
    possession: "KC",
    headline: "test",
    description: "test",
    playerIds: [],
    team: "KC",
    score: { away: 0, home: 0 },
    occurredAt: "2026-05-09T00:00:00Z"
  },
  observation: {
    id: "obs",
    source: "stream-url",
    summary: "",
    confidence: 0.5,
    observedAt: "2026-05-09T00:00:00Z",
    latencyMs: 10
  },
  impacts: [],
  group: {
    listener: { name: "Alex", favoriteTeam: "KC" },
    friends: [],
    tone: "pg",
    homeTeamBias: "fantasy-first"
  },
  news: [],
  recentCommentary: [],
  fallbackText: "Local fallback text."
};

class FakeProvider implements CommentaryProvider {
  id: string;
  constructor(
    id: string,
    private readonly behavior: () => Promise<DialogueLine[]>,
    private readonly status: ProviderHealth["status"] = "ready"
  ) {
    this.id = id;
  }

  draft(): Promise<DialogueLine[]> {
    return this.behavior();
  }

  async health(): Promise<ProviderHealth> {
    return { id: this.id, label: this.id, status: this.status, detail: "fake" };
  }
}

describe("CommentaryProviderChain", () => {
  it("returns the first provider's success", async () => {
    const chain = new CommentaryProviderChain([
      new FakeProvider("primary", async () => oneLine("primary text")),
      new FakeProvider("backup", async () => oneLine("backup text")),
      new LocalCommentaryProvider()
    ]);

    expect(await chain.draft(baseInput)).toEqual(oneLine("primary text"));
  });

  it("falls through to the next provider when the primary throws", async () => {
    const chain = new CommentaryProviderChain([
      new FakeProvider("primary", async () => {
        throw new Error("boom");
      }),
      new FakeProvider("backup", async () => oneLine("backup text")),
      new LocalCommentaryProvider()
    ]);

    expect(await chain.draft(baseInput)).toEqual(oneLine("backup text"));
    expect(chain.getFallbackStats()).toMatchObject({ primary: 1 });
  });

  it("falls through past two failed providers to the local fallback", async () => {
    const chain = new CommentaryProviderChain([
      new FakeProvider("primary", async () => {
        throw new Error("primary down");
      }),
      new FakeProvider("backup", async () => {
        throw new Error("backup down");
      }),
      new LocalCommentaryProvider()
    ]);

    const result = await chain.draft(baseInput);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(baseInput.fallbackText);
    expect(chain.getFallbackStats()).toMatchObject({ primary: 1, backup: 1 });
  });

  it("times out a hung provider and advances to the next", async () => {
    let resolveBackup: ((value: DialogueLine[]) => void) | undefined;
    const chain = new CommentaryProviderChain(
      [
        new FakeProvider("primary", () => new Promise(() => {})), // never resolves
        new FakeProvider(
          "backup",
          () =>
            new Promise<DialogueLine[]>((resolve) => {
              resolveBackup = resolve;
            })
        ),
        new LocalCommentaryProvider()
      ],
      { perProviderTimeoutMs: 30 }
    );

    const draftPromise = chain.draft(baseInput);
    // Wait long enough for the primary to time out, then resolve the backup.
    await new Promise((resolve) => setTimeout(resolve, 60));
    resolveBackup?.(oneLine("backup wins"));
    expect(await draftPromise).toEqual(oneLine("backup wins"));
    expect(chain.getFallbackStats().primary).toBe(1);
  });

  it("invokes onFallback for every fallthrough", async () => {
    const fallbacks: Array<{ id: string; error: unknown }> = [];
    const chain = new CommentaryProviderChain(
      [
        new FakeProvider("primary", async () => {
          throw new Error("primary boom");
        }),
        new FakeProvider("backup", async () => oneLine("ok"))
      ],
      { onFallback: (id, error) => fallbacks.push({ id, error }) }
    );
    await chain.draft(baseInput);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].id).toBe("primary");
  });

  it("health reports the highest-tier ready provider", async () => {
    const chain = new CommentaryProviderChain([
      new FakeProvider("primary", async () => oneLine("x"), "error"),
      new FakeProvider("backup", async () => oneLine("y"), "ready"),
      new LocalCommentaryProvider()
    ]);
    const health = await chain.health();
    expect(health.status).toBe("ready");
    expect(health.label).toContain("backup");
  });
});
