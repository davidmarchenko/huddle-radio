import { DemoNewsProvider } from "../providers/demoNewsProvider";
import { EspnNewsProvider } from "../providers/espnNewsProvider";
import { NewsProviderChain } from "../providers/newsProviderChain";
import type { NewsProvider } from "../shared/contracts";
import { config } from "./config";
import { registerNewsChain } from "./metrics";

/**
 * Single source of truth for news-provider construction.
 *
 * Builds a chain that prefers ESPN's live news feed and falls back to
 * `DemoNewsProvider` when ESPN is unavailable or returns nothing
 * relevant to the listener's matchup. With `NEWS_PROVIDER=demo`,
 * behavior is unchanged.
 */
export function createNewsProvider(): NewsProvider {
  const providers: NewsProvider[] = [];
  if (config.NEWS_PROVIDER === "espn" || config.NEWS_PROVIDER === "auto") {
    providers.push(new EspnNewsProvider(fetch, { itemLimit: 25 }));
  }
  // Demo is always the terminal so the pregame card never goes empty.
  providers.push(new DemoNewsProvider());
  if (providers.length === 1) {
    registerNewsChain(undefined);
    return providers[0];
  }
  const chain = new NewsProviderChain(providers, { perProviderTimeoutMs: 5_000 });
  registerNewsChain(chain);
  return chain;
}

export function describeNewsStack(): string {
  const labels: string[] = [];
  if (config.NEWS_PROVIDER === "espn" || config.NEWS_PROVIDER === "auto") labels.push("ESPN news");
  labels.push("Demo storylines");
  return labels.join(" → ");
}
