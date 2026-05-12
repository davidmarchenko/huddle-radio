import type {
  EntryStatus,
  ListenerPickSelection,
  PickEntry,
  PickProp,
  PickSlate,
  PickStatType
} from "../shared/picksContracts";

/**
 * Browser-side helpers for the picks feature: API calls, the listener
 * id (a stable per-device UUID), and per-game pick persistence so a
 * reload or tab-swap doesn't lose what the user picked.
 */

const ENTRY_KEY_PREFIX = "huddle:picks:entry:"; // suffixed with `${listenerId}:${gameId}`

export function loadCachedSelections(listenerId: string, gameId: string): ListenerPickSelection[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(`${ENTRY_KEY_PREFIX}${listenerId}:${gameId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCachedSelections(
  listenerId: string,
  gameId: string,
  selections: ListenerPickSelection[]
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `${ENTRY_KEY_PREFIX}${listenerId}:${gameId}`,
      JSON.stringify(selections)
    );
  } catch {
    // Quota / private mode — degrade silently; selections live in memory.
  }
}

export function clearCachedSelections(listenerId: string, gameId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`${ENTRY_KEY_PREFIX}${listenerId}:${gameId}`);
  } catch {
    /* ignore */
  }
}

export async function fetchSlate(gameId: string, signal?: AbortSignal): Promise<PickSlate | undefined> {
  try {
    const response = await fetch(`/api/picks/slate?gameId=${encodeURIComponent(gameId)}`, { signal });
    if (!response.ok) return undefined;
    return (await response.json()) as PickSlate;
  } catch {
    return undefined;
  }
}

export async function submitEntry(input: {
  listenerId: string;
  gameId: string;
  selections: ListenerPickSelection[];
  availableProps: PickProp[];
}): Promise<PickEntry | { error: string }> {
  try {
    const response = await fetch("/api/picks/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    const payload = await response.json();
    if (!response.ok) return { error: payload?.error ?? `submit failed (${response.status})` };
    return payload as PickEntry;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchEntryStatus(
  listenerId: string,
  gameId: string,
  signal?: AbortSignal
): Promise<EntryStatus | undefined> {
  try {
    const response = await fetch(
      `/api/picks/status?listenerId=${encodeURIComponent(listenerId)}&gameId=${encodeURIComponent(gameId)}`,
      { signal }
    );
    if (!response.ok) return undefined;
    return (await response.json()) as EntryStatus;
  } catch {
    return undefined;
  }
}

export async function fetchEntry(listenerId: string, gameId: string, signal?: AbortSignal): Promise<PickEntry | undefined> {
  try {
    const response = await fetch(
      `/api/picks/entry?listenerId=${encodeURIComponent(listenerId)}&gameId=${encodeURIComponent(gameId)}`,
      { signal }
    );
    if (!response.ok) return undefined;
    return (await response.json()) as PickEntry;
  } catch {
    return undefined;
  }
}

export async function settleEntry(listenerId: string, gameId: string): Promise<EntryStatus | undefined> {
  try {
    const response = await fetch("/api/picks/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listenerId, gameId })
    });
    if (!response.ok) return undefined;
    return (await response.json()) as EntryStatus;
  } catch {
    return undefined;
  }
}

// ---------------- Display helpers ----------------

const STAT_LABELS: Record<PickStatType, string> = {
  "passing-yards": "Pass yds",
  "passing-tds": "Pass TDs",
  "rushing-yards": "Rush yds",
  "receiving-yards": "Rec yds",
  "receptions": "Receptions",
  "points": "Pts",
  "rebounds": "Reb",
  "assists": "Ast",
  "threes": "3PM",
  "pra": "P+R+A",
  "hits": "Hits",
  "total-bases": "TB",
  "home-runs": "HR",
  "strikeouts-pitcher": "K (pitcher)",
  "shots-on-goal": "SOG",
  "goals": "Goals"
};

export function statLabel(stat: PickStatType): string {
  return STAT_LABELS[stat];
}

const STAT_ICONS: Record<PickStatType, string> = {
  "passing-yards": "icon-football",
  "passing-tds": "icon-football",
  "rushing-yards": "icon-football",
  "receiving-yards": "icon-football",
  "receptions": "icon-football",
  "points": "icon-ball",
  "rebounds": "icon-ball",
  "assists": "icon-ball",
  "threes": "icon-ball",
  "pra": "icon-ball",
  "hits": "icon-baseball",
  "total-bases": "icon-baseball",
  "home-runs": "icon-baseball",
  "strikeouts-pitcher": "icon-baseball",
  "shots-on-goal": "icon-target",
  "goals": "icon-target"
};

export function statIcon(stat: PickStatType): string {
  return STAT_ICONS[stat];
}
