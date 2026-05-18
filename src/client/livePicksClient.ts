import type { LivePickEntry, LivePickProp, LivePickSide } from "../shared/livePicksContracts";

/**
 * Thin fetch wrappers around the live-picks endpoints. Mirrors the
 * shape of `picksClient.ts` for the pregame parlay so callers can
 * skim both modules at once.
 */

export type FetchActiveResult = {
  active: LivePickProp[];
  entries: LivePickEntry[];
};

export async function fetchActiveLivePicks(input: {
  gameId: string;
  listenerId: string;
  signal?: AbortSignal;
}): Promise<FetchActiveResult> {
  const params = new URLSearchParams({ gameId: input.gameId });
  if (input.listenerId) params.set("listenerId", input.listenerId);
  try {
    const response = await fetch(`/api/picks/live/active?${params.toString()}`, {
      signal: input.signal
    });
    if (!response.ok) return { active: [], entries: [] };
    const payload = (await response.json()) as Partial<FetchActiveResult>;
    return {
      active: Array.isArray(payload.active) ? payload.active : [],
      entries: Array.isArray(payload.entries) ? payload.entries : []
    };
  } catch {
    return { active: [], entries: [] };
  }
}

export type LockResult =
  | { entry: LivePickEntry }
  | { error: string };

export async function lockLivePick(input: {
  listenerId: string;
  gameId: string;
  propId: string;
  side: LivePickSide;
}): Promise<LockResult> {
  try {
    const response = await fetch("/api/picks/live/lock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    const payload = await response.json().catch(() => ({})) as Partial<LockResult>;
    if (!response.ok) {
      return { error: (payload as { error?: string }).error || `Lock failed (${response.status}).` };
    }
    const entry = (payload as { entry?: LivePickEntry }).entry;
    if (!entry) return { error: "Lock response missing entry." };
    return { entry };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Lock request failed." };
  }
}
