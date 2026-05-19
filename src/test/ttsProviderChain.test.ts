import { describe, expect, it } from "vitest";
import { TtsProviderChain } from "../providers/ttsProviderChain";
import type { HostId, ProviderHealth, TTSAudioChunk, TTSProvider } from "../shared/contracts";

/**
 * Direct tests for the TTS chain. The chain is the safety layer that
 * keeps the show audible when the configured primary (Inworld today)
 * goes down — the listener should never hear silence just because the
 * primary returns 403 / 401 / network error.
 */

function makeChunk(commentaryId: string, payload = "audio"): TTSAudioChunk {
  return {
    id: `${commentaryId}-chunk`,
    commentaryId,
    provider: "test",
    mimeType: "audio/mpeg",
    base64Audio: Buffer.from(payload).toString("base64"),
    isFinal: true,
    latencyMs: 0
  };
}

function workingProvider(id: string, chunkPayload = `from-${id}`): TTSProvider {
  return {
    id,
    async *synthesize(input) {
      yield makeChunk(input.commentaryId, chunkPayload);
    },
    async synthesizeDialogue(input) {
      return makeChunk(input.commentaryId, `dialogue-${chunkPayload}`);
    },
    async health(): Promise<ProviderHealth> {
      return { id, label: id, status: "ready", detail: "" };
    }
  };
}

function failingProvider(id: string, kind: "throw-sync" | "throw-stream" | "empty-stream" = "throw-sync"): TTSProvider {
  return {
    id,
    synthesize(_input) {
      const error = new Error(`${id} failed`);
      if (kind === "throw-sync") {
        // Throw before yielding any chunk — async iterable rejects on
        // first .next().
        return (async function* () {
          throw error;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          yield {} as TTSAudioChunk;
        })();
      }
      if (kind === "empty-stream") {
        return (async function* () {
          // Yields nothing — chain treats as failure.
        })();
      }
      return (async function* () {
        // Yields one chunk then throws. Chain should commit after
        // first chunk; the throw becomes the caller's problem.
        yield makeChunk("partial", "partial");
        throw error;
      })();
    },
    async synthesizeDialogue() {
      throw new Error(`${id} dialogue failed`);
    },
    async health(): Promise<ProviderHealth> {
      return { id, label: id, status: "error", detail: "deliberate test failure" };
    }
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("TtsProviderChain", () => {
  it("uses the primary when it succeeds, never touching backups", async () => {
    const primary = workingProvider("primary");
    const backup = workingProvider("backup");
    const chain = new TtsProviderChain([primary, backup]);
    const chunks = await collect(chain.synthesize({ commentaryId: "c1", text: "hello" }));
    expect(chunks).toHaveLength(1);
    expect(Buffer.from(chunks[0]!.base64Audio ?? "", "base64").toString()).toBe("from-primary");
    expect(chain.lastProviderId).toBe("primary");
  });

  it("falls through to the backup when primary throws on first .next()", async () => {
    const chain = new TtsProviderChain([
      failingProvider("primary", "throw-sync"),
      workingProvider("backup")
    ]);
    const chunks = await collect(chain.synthesize({ commentaryId: "c2", text: "hi" }));
    expect(chunks).toHaveLength(1);
    expect(Buffer.from(chunks[0]!.base64Audio ?? "", "base64").toString()).toBe("from-backup");
    expect(chain.lastProviderId).toBe("backup");
    expect(chain.getFallbackStats()).toEqual({ primary: 1 });
  });

  it("falls through to the backup when primary yields an empty stream", async () => {
    const chain = new TtsProviderChain([
      failingProvider("primary", "empty-stream"),
      workingProvider("backup")
    ]);
    const chunks = await collect(chain.synthesize({ commentaryId: "c3", text: "hi" }));
    expect(chunks).toHaveLength(1);
    expect(chain.lastProviderId).toBe("backup");
  });

  it("synthesizeDialogue walks the chain on each provider's throw", async () => {
    const chain = new TtsProviderChain([
      failingProvider("primary", "throw-sync"),
      workingProvider("backup")
    ]);
    const chunk = await chain.synthesizeDialogue!({
      commentaryId: "c4",
      turns: [
        { text: "first", hostId: "theo" as HostId },
        { text: "second", hostId: "maya" as HostId }
      ]
    });
    expect(Buffer.from(chunk.base64Audio ?? "", "base64").toString()).toBe("dialogue-from-backup");
    expect(chain.lastProviderId).toBe("backup");
  });

  it("throws from synthesizeDialogue when every backup also fails", async () => {
    const chain = new TtsProviderChain([
      failingProvider("primary", "throw-sync"),
      failingProvider("backup", "throw-sync")
    ]);
    await expect(
      chain.synthesizeDialogue!({ commentaryId: "c5", turns: [{ text: "x" }] })
    ).rejects.toThrow(/backup dialogue failed/);
  });

  it("health() reports the first ready provider as the chain's label", async () => {
    const chain = new TtsProviderChain([
      failingProvider("primary"),
      workingProvider("backup")
    ]);
    const health = await chain.health();
    expect(health.status).toBe("ready");
    expect(health.label).toContain("backup");
  });

  it("throws when constructed with zero providers", () => {
    expect(() => new TtsProviderChain([])).toThrow(/at least one provider/);
  });
});
