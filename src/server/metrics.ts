import { getDefaultPlayerIdResolver } from "./playerIdResolver";
import { getDefaultSportsGamesCache } from "./sportsGamesCache";
import { CommentaryProviderChain } from "../providers/commentaryProviderChain";
import { NewsProviderChain } from "../providers/newsProviderChain";
import { VisionModelProviderChain } from "../providers/visionModelProviderChain";

/**
 * Process-wide metrics registry. Other subsystems push counters here
 * (or expose getters that this module pulls from); the `/api/metrics`
 * endpoint serializes the snapshot.
 *
 * Resolution: in-memory, single-instance. A future Prometheus exporter
 * or push-based pipeline can read from the same getters.
 */

type Counter = number;

const counters: Record<string, Counter> = {
  showsStarted: 0,
  showsCompleted: 0,
  espnSportsFetchFailures: 0,
  espnNewsFetchFailures: 0,
  oddsFetchFailures: 0,
  commentaryRequests: 0,
  ttsRequests: 0,
  webSocketsOpened: 0,
  webSocketsClosed: 0
};

const observableChains = {
  commentary: undefined as CommentaryProviderChain | undefined,
  news: undefined as NewsProviderChain | undefined,
  vision: undefined as VisionModelProviderChain | undefined
};

export function incrementCounter(name: keyof typeof counters, by = 1): void {
  counters[name] = (counters[name] ?? 0) + by;
}

export function registerCommentaryChain(chain: CommentaryProviderChain | undefined): void {
  observableChains.commentary = chain;
}
export function registerNewsChain(chain: NewsProviderChain | undefined): void {
  observableChains.news = chain;
}
export function registerVisionChain(chain: VisionModelProviderChain | undefined): void {
  observableChains.vision = chain;
}

export type MetricsSnapshot = {
  generatedAt: string;
  uptimeSeconds: number;
  counters: Record<string, number>;
  playerIdResolver: { resolved: number; missed: number; registered: number };
  sportsGamesCache: { hits: number; stale: number; misses: number; sports: string[] };
  fallbacks: {
    commentary: Record<string, number>;
    news: Record<string, number>;
    vision: Record<string, number>;
  };
};

const startedAt = Date.now();

export function getMetrics(): MetricsSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    counters: { ...counters },
    playerIdResolver: getDefaultPlayerIdResolver().getStats(),
    sportsGamesCache: getDefaultSportsGamesCache().getStats(),
    fallbacks: {
      commentary: observableChains.commentary?.getFallbackStats() ?? {},
      news: observableChains.news?.getFallbackStats() ?? {},
      vision: observableChains.vision?.getFallbackStats() ?? {}
    }
  };
}

/**
 * Per-show usage budget. Approximates token cost via input+output text
 * length and TTS-spoken character count. When a cap is exceeded the
 * caller can degrade providers (swap to local commentary / mock TTS).
 */
export type ShowBudgetOptions = {
  /** Max approximate tokens (chars/4) before commentary degrades. Default 200K. */
  maxCommentaryTokens?: number;
  /** Max TTS characters before TTS degrades. Default 60K (~6.7 min). */
  maxTtsCharacters?: number;
};

export class ShowUsageBudget {
  private commentaryChars = 0;
  private ttsChars = 0;
  private commentaryDegraded = false;
  private ttsDegraded = false;

  constructor(private readonly options: ShowBudgetOptions = {}) {}

  recordCommentary(text: string): void {
    this.commentaryChars += text.length;
  }

  recordTts(text: string): void {
    this.ttsChars += text.length;
  }

  shouldDegradeCommentary(): boolean {
    const cap = this.options.maxCommentaryTokens ?? 200_000;
    const tokens = Math.ceil(this.commentaryChars / 4);
    if (tokens >= cap) {
      const wasFresh = !this.commentaryDegraded;
      this.commentaryDegraded = true;
      return wasFresh;
    }
    return false;
  }

  shouldDegradeTts(): boolean {
    const cap = this.options.maxTtsCharacters ?? 60_000;
    if (this.ttsChars >= cap) {
      const wasFresh = !this.ttsDegraded;
      this.ttsDegraded = true;
      return wasFresh;
    }
    return false;
  }

  isCommentaryDegraded(): boolean {
    return this.commentaryDegraded;
  }
  isTtsDegraded(): boolean {
    return this.ttsDegraded;
  }

  snapshot() {
    return {
      commentaryChars: this.commentaryChars,
      commentaryTokensApprox: Math.ceil(this.commentaryChars / 4),
      ttsChars: this.ttsChars,
      commentaryDegraded: this.commentaryDegraded,
      ttsDegraded: this.ttsDegraded
    };
  }
}
