import { NextResponse } from "next/server";
import { listEntriesForListener } from "@/server/picksStore";
import type { PickEntry } from "@/shared/picksContracts";
import { STAKE_PER_ENTRY } from "@/shared/picksContracts";

export const runtime = "nodejs";

/**
 * GET /api/picks/history?listenerId=...
 *
 * All-time stats for the listener: settled entry count, total wagered,
 * total payout, hit rate (entries fully won), current streak. Used by
 * the profile / recap surface to give the picks loop persistence
 * across sessions.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const listenerId = url.searchParams.get("listenerId");
  if (!listenerId) {
    return NextResponse.json({ error: "Missing listenerId." }, { status: 400 });
  }
  const entries = listEntriesForListener(listenerId);
  const settled = entries.filter((entry) => entry.status === "settled");
  const wins = settled.filter((entry) => (entry.payout ?? 0) > 0);
  const totalWagered = settled.reduce((sum, entry) => sum + entry.stake, 0);
  const totalPayout = settled.reduce((sum, entry) => sum + (entry.payout ?? 0), 0);
  const streak = computeStreak(settled);
  console.log(JSON.stringify({
    event: "picks.history.ok",
    listenerId,
    entries: entries.length,
    settled: settled.length,
    wins: wins.length
  }));
  return NextResponse.json({
    listenerId,
    entries,
    summary: {
      totalEntries: entries.length,
      settledEntries: settled.length,
      wins: wins.length,
      losses: settled.length - wins.length,
      hitRate: settled.length > 0 ? wins.length / settled.length : 0,
      totalWagered,
      totalPayout,
      net: totalPayout - totalWagered,
      stakePerEntry: STAKE_PER_ENTRY,
      currentStreak: streak
    }
  });
}

/**
 * Most recent consecutive run of wins (positive) or losses (negative).
 * "WLW" returns +1; "LLLL" returns -4.
 */
function computeStreak(settled: PickEntry[]): number {
  if (settled.length === 0) return 0;
  // settled is newest-first per picksStore index ordering.
  const first = settled[0]!;
  const won = (entry: PickEntry) => (entry.payout ?? 0) > 0;
  const sign = won(first) ? 1 : -1;
  let count = 0;
  for (const entry of settled) {
    if ((sign > 0) === won(entry)) count++;
    else break;
  }
  return sign * count;
}
