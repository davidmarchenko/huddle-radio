import "dotenv/config";

import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { PlayerRecord, SeedFile } from "../src/server/playerIdResolver";

/**
 * Pull Sleeper's /players/nfl endpoint and emit a canonical player-ID
 * map keyed by Sleeper ID, with ESPN/Yahoo cross-references attached
 * for downstream resolvers.
 *
 * Run: `npx tsx scripts/buildPlayerIdMap.ts [--out=src/server/data/playerIdMap.json] [--active-only]`
 */

type SleeperPlayer = {
  player_id?: string;
  espn_id?: number | string | null;
  yahoo_id?: number | string | null;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  team?: string;
  active?: boolean;
  status?: string;
};

type Options = {
  outPath: string;
  activeOnly: boolean;
  sport: "nfl";
  limit: number;
};

const DEFAULT_OUT = path.resolve("src/server/data/playerIdMap.json");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const url = `https://api.sleeper.app/v1/players/${options.sport}`;

  console.log(`Fetching ${url} …`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Sleeper request failed: ${response.status} ${response.statusText}`);
  const players = (await response.json()) as Record<string, SleeperPlayer>;

  const records: PlayerRecord[] = [];
  for (const [sleeperId, player] of Object.entries(players)) {
    if (!sleeperId) continue;
    if (options.activeOnly && !isActive(player)) continue;
    const name = displayName(player);
    if (!name) continue;
    const external: PlayerRecord["external"] = { sleeper: sleeperId };
    if (player.espn_id != null && player.espn_id !== "") external.espn = String(player.espn_id);
    if (player.yahoo_id != null && player.yahoo_id !== "") external.yahoo = String(player.yahoo_id);
    if (Object.keys(external).length === 1 && !external.espn && !external.yahoo) {
      // Sleeper-only entries don't help cross-provider resolution. Skip
      // unless we want every roster spot Sleeper exposes — that bloats
      // the JSON without buying anything for ESPN/Yahoo bridging.
      continue;
    }
    records.push({
      canonicalId: sleeperId,
      name,
      sport: options.sport,
      position: player.position ?? undefined,
      team: player.team ?? undefined,
      external
    });
    if (records.length >= options.limit) break;
  }

  records.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));

  const seed: SeedFile = {
    version: new Date().toISOString().slice(0, 10),
    source: `Built from ${url} on ${new Date().toISOString()}`,
    players: records
  };

  await writeFile(options.outPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
  console.log(`Wrote ${records.length} players → ${options.outPath}`);
  console.log(`  with ESPN cross-ref: ${records.filter((r) => r.external.espn).length}`);
  console.log(`  with Yahoo cross-ref: ${records.filter((r) => r.external.yahoo).length}`);
}

function isActive(player: SleeperPlayer): boolean {
  if (player.active === false) return false;
  const status = player.status?.toUpperCase();
  if (!status) return Boolean(player.team);
  if (status === "ACTIVE" || status === "INJURED RESERVE" || status === "PUP" || status === "RESERVE") return true;
  return false;
}

function displayName(player: SleeperPlayer): string | undefined {
  if (player.full_name) return player.full_name;
  const parts = [player.first_name, player.last_name].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    outPath: DEFAULT_OUT,
    activeOnly: true,
    sport: "nfl",
    limit: Number.POSITIVE_INFINITY
  };
  for (const arg of args) {
    if (arg.startsWith("--out=")) options.outPath = path.resolve(arg.slice("--out=".length));
    else if (arg === "--all") options.activeOnly = false;
    else if (arg === "--active-only") options.activeOnly = true;
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length));
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: tsx scripts/buildPlayerIdMap.ts [--out=path.json] [--all|--active-only] [--limit=N]");
      process.exit(0);
    }
  }
  return options;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
