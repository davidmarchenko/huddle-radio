export type CachedMediaAsset = {
  id: string;
  label: string;
  kind: "fantasy-avatar" | "team-logo" | "player-headshot" | "fallback-badge";
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

export type MediaCacheManifest = {
  generatedAt: string;
  outDir: string;
  counts: Record<string, number>;
  assets: CachedMediaAsset[];
  policy?: {
    assumeRights?: string | false;
    note?: string;
  };
};

export type MediaLookupIndex = {
  byId: Map<string, CachedMediaAsset>;
  playerByName: Map<string, CachedMediaAsset>;
  fallbackPlayerById: Map<string, CachedMediaAsset>;
  teamByCode: Map<string, CachedMediaAsset>;
};

export function createMediaLookupIndex(manifest?: MediaCacheManifest): MediaLookupIndex {
  const usableAssets = (manifest?.assets ?? []).filter((asset) => asset.status === "cached" || asset.status === "generated");
  const byId = new Map<string, CachedMediaAsset>();
  const playerByName = new Map<string, CachedMediaAsset>();
  const fallbackPlayerById = new Map<string, CachedMediaAsset>();
  const teamByCode = new Map<string, CachedMediaAsset>();

  for (const asset of usableAssets) {
    byId.set(asset.id, asset);
    if (asset.kind === "player-headshot") {
      playerByName.set(normalizeLabel(asset.label), asset);
    }
    if (asset.id.startsWith("generated-player-")) {
      fallbackPlayerById.set(asset.id.replace("generated-player-", ""), asset);
      if (!playerByName.has(normalizeLabel(asset.label))) playerByName.set(normalizeLabel(asset.label), asset);
    }
    if (asset.kind === "team-logo" || asset.id.startsWith("generated-team-")) {
      teamByCode.set(normalizeLabel(asset.label), asset);
    }
  }

  return { byId, playerByName, fallbackPlayerById, teamByCode };
}

export function resolvePlayerMedia(index: MediaLookupIndex, input: { id?: string; name: string }): CachedMediaAsset | undefined {
  if (input.id) {
    const fallback = index.fallbackPlayerById.get(input.id);
    const headshot = index.playerByName.get(normalizeLabel(input.name));
    return headshot ?? fallback;
  }
  return index.playerByName.get(normalizeLabel(input.name));
}

export function resolveTeamMedia(index: MediaLookupIndex, team?: string): CachedMediaAsset | undefined {
  if (!team) return undefined;
  return index.teamByCode.get(normalizeLabel(team));
}

export function mediaAssetUrl(asset?: CachedMediaAsset): string | undefined {
  if (!asset) return undefined;
  if (asset.publicPath) return asset.publicPath;
  if (asset.localPath) {
    const publicIndex = asset.localPath.indexOf("/public/");
    if (publicIndex >= 0) return asset.localPath.slice(publicIndex + "/public".length);
  }
  return asset.url;
}

export function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}
