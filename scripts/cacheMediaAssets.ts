import "dotenv/config";

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { demoLeagueState } from "../src/providers/demoData";
import {
  createFallbackSvg,
  espnDemoPlayerHeadshotAsset,
  espnDemoTeamLogoAsset,
  extensionFromContentType,
  generatedFallbackAssetsFromLeague,
  safeAssetFilename,
  sleeperAvatarAsset,
  uniqueFantasyPlayers,
  uniqueFantasyTeams,
  type MediaAssetCandidate
} from "../src/shared/mediaAssets";

type CacheResult = {
  id: string;
  label: string;
  kind: string;
  source: string;
  rights: string;
  status: "cached" | "generated" | "skipped" | "failed" | "dry-run";
  url?: string;
  localPath?: string;
  publicPath?: string;
  sha256?: string;
  bytes?: number;
  reason?: string;
};

type SleeperLeague = {
  league_id: string;
  name?: string;
  avatar?: string;
};

type SleeperUser = {
  user_id: string;
  display_name?: string;
  username?: string;
  avatar?: string;
  metadata?: {
    team_name?: string;
  };
};

const APPROVED_REMOTE_RIGHTS = new Set(["provider-permitted", "provider-licensed", "user-provided"]);
const DEMO_ESPN_IDS_BY_PLAYER_NAME: Record<string, number> = {
  "Patrick Mahomes": 3139477,
  "Travis Kelce": 15847,
  "Josh Allen": 3918298,
  "Amon-Ra St. Brown": 4374302,
  "Jahmyr Gibbs": 4429795,
  "Christian McCaffrey": 3117251,
  "CeeDee Lamb": 4241389,
  "Ja'Marr Chase": 4362628
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(options.outDir);
  const assetsDir = path.join(outDir, "assets");
  const manifestPath = path.join(outDir, "manifest.json");
  await mkdir(assetsDir, { recursive: true });

  const candidates: MediaAssetCandidate[] = [
    ...generatedFallbackAssetsFromLeague(demoLeagueState),
    ...(options.includeEspnDemo ? getEspnDemoCandidates(options.assumeRights) : []),
    ...(await getSleeperCandidates(options.sleeperLeagueId))
  ];

  const results: CacheResult[] = [];
  for (const candidate of dedupeCandidates(candidates).slice(0, options.maxAssets)) {
    results.push(await cacheCandidate(candidate, assetsDir, options.dryRun));
  }

  const skippedUnofficial = candidates.filter((candidate) => candidate.rights === "demo-unofficial").length;
  const manifest = {
    generatedAt: new Date().toISOString(),
    outDir,
    policy: {
      approvedRemoteRights: [...APPROVED_REMOTE_RIGHTS],
      note: "The cache skips demo-unofficial media. Add licensed provider adapters before caching NFL/team/player likeness assets for production."
      ,
      assumeRights: options.assumeRights ? "User asserted they have rights for selected remote media." : false
    },
    counts: summarize(results),
    skippedUnofficial,
    assets: results
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  printSummary(results, manifestPath);
}

async function getSleeperCandidates(leagueId?: string): Promise<MediaAssetCandidate[]> {
  if (!leagueId) return [];
  const [league, users] = await Promise.all([
    getJson<SleeperLeague>(`https://api.sleeper.app/v1/league/${leagueId}`),
    getJson<SleeperUser[]>(`https://api.sleeper.app/v1/league/${leagueId}/users`)
  ]);

  return [
    sleeperAvatarAsset({
      id: `league-${league.league_id}`,
      label: league.name ?? `Sleeper League ${league.league_id}`,
      avatarId: league.avatar
    }),
    ...users.map((user) =>
      sleeperAvatarAsset({
        id: `user-${user.user_id}`,
        label: user.metadata?.team_name ?? user.display_name ?? user.username ?? `Sleeper user ${user.user_id}`,
        avatarId: user.avatar
      })
    )
  ].filter((asset): asset is MediaAssetCandidate => Boolean(asset));
}

async function cacheCandidate(candidate: MediaAssetCandidate, assetsDir: string, dryRun: boolean): Promise<CacheResult> {
  if (candidate.source === "generated") {
    const svg = createFallbackSvg(String(candidate.metadata?.initials ?? candidate.label), String(candidate.metadata?.position ?? candidate.metadata?.team ?? ""));
    const filename = safeAssetFilename(candidate, "svg");
    const localPath = path.join(assetsDir, filename);
    if (!dryRun) await writeFile(localPath, svg, "utf8");
    return {
      ...baseResult(candidate, dryRun ? "dry-run" : "generated"),
      localPath,
      publicPath: publicPathFor(localPath),
      sha256: sha256(svg),
      bytes: Buffer.byteLength(svg)
    };
  }

  if (!candidate.url) {
    return { ...baseResult(candidate, "skipped"), reason: "No URL available." };
  }

  if (!APPROVED_REMOTE_RIGHTS.has(candidate.rights)) {
    return {
      ...baseResult(candidate, "skipped"),
      url: candidate.url,
      reason: `Skipped ${candidate.rights} media. Use a licensed/provider-permitted source before caching.`
    };
  }

  if (dryRun) {
    return { ...baseResult(candidate, "dry-run"), url: candidate.url };
  }

  try {
    const response = await fetch(candidate.url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const contentType = response.headers.get("content-type") ?? candidate.contentType;
    const bytes = Buffer.from(await response.arrayBuffer());
    const extension = extensionFromContentType(contentType, candidate.url);
    const filename = safeAssetFilename(candidate, extension);
    const localPath = path.join(assetsDir, filename);
    await writeFile(localPath, bytes);
    return {
      ...baseResult(candidate, "cached"),
      url: candidate.url,
      localPath,
      publicPath: publicPathFor(localPath),
      sha256: sha256(bytes),
      bytes: bytes.byteLength
    };
  } catch (error) {
    return {
      ...baseResult(candidate, "failed"),
      url: candidate.url,
      reason: error instanceof Error ? error.message : "Download failed."
    };
  }
}

function getEspnDemoCandidates(assumeRights: boolean): MediaAssetCandidate[] {
  const assets = [
    ...uniqueFantasyTeams(demoLeagueState).map(espnDemoTeamLogoAsset),
    ...uniqueFantasyPlayers(demoLeagueState)
      .map((player) => {
        const espnId = DEMO_ESPN_IDS_BY_PLAYER_NAME[player.name];
        return espnId ? espnDemoPlayerHeadshotAsset(player, espnId) : undefined;
      })
      .filter((asset): asset is MediaAssetCandidate => Boolean(asset))
  ];

  if (!assumeRights) return assets;
  return assets.map((asset) => ({
    ...asset,
    rights: "user-provided",
    metadata: {
      ...asset.metadata,
      originalRights: asset.rights,
      rightsAssertion: "User asserted rights for this selected remote media cache run."
    }
  }));
}

function baseResult(candidate: MediaAssetCandidate, status: CacheResult["status"]): CacheResult {
  return {
    id: candidate.id,
    label: candidate.label,
    kind: candidate.kind,
    source: candidate.source,
    rights: candidate.rights,
    status
  };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

function dedupeCandidates(candidates: MediaAssetCandidate[]): MediaAssetCandidate[] {
  const byId = new Map<string, MediaAssetCandidate>();
  for (const candidate of candidates) byId.set(candidate.id, candidate);
  return [...byId.values()];
}

function parseArgs(args: string[]) {
  const options = {
    outDir: "public/media-cache",
    dryRun: false,
    assumeRights: false,
    includeEspnDemo: false,
    maxAssets: Number.POSITIVE_INFINITY,
    sleeperLeagueId: process.env.SLEEPER_LEAGUE_ID
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") options.dryRun = true;
    if (arg === "--assume-rights") options.assumeRights = true;
    if (arg === "--include-espn-demo") options.includeEspnDemo = true;
    if (arg === "--out") options.outDir = requireValue(args, ++index, arg);
    if (arg === "--max-assets") options.maxAssets = Number(requireValue(args, ++index, arg));
    if (arg === "--sleeper-league-id") options.sleeperLeagueId = requireValue(args, ++index, arg);
  }

  return options;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function summarize(results: CacheResult[]) {
  return results.reduce<Record<string, number>>((counts, result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    return counts;
  }, {});
}

function printSummary(results: CacheResult[], manifestPath: string) {
  const counts = summarize(results);
  console.log(`Media cache manifest: ${manifestPath}`);
  console.log(`Generated: ${counts.generated ?? 0}`);
  console.log(`Cached: ${counts.cached ?? 0}`);
  console.log(`Skipped: ${counts.skipped ?? 0}`);
  console.log(`Failed: ${counts.failed ?? 0}`);
  console.log(`Dry run: ${counts["dry-run"] ?? 0}`);
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function publicPathFor(localPath: string): string | undefined {
  const publicRoot = path.join(process.cwd(), "public");
  const relativePath = path.relative(publicRoot, localPath);
  if (relativePath.startsWith("..")) return undefined;
  return `/${relativePath.split(path.sep).join("/")}`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
