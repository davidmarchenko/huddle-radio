import { describe, expect, it } from "vitest";

import { createMediaLookupIndex, mediaAssetUrl, resolvePlayerMedia, resolveTeamMedia, type MediaCacheManifest } from "../shared/mediaManifest";

const manifest: MediaCacheManifest = {
  generatedAt: "2026-01-01T00:00:00.000Z",
  outDir: "/app/public/media-cache",
  counts: { generated: 2, cached: 2 },
  assets: [
    {
      id: "generated-player-kc-qb-15",
      label: "Patrick Mahomes",
      kind: "fallback-badge",
      source: "generated",
      rights: "generated-fallback",
      status: "generated",
      localPath: "/app/public/media-cache/assets/player-kc-qb-15.svg"
    },
    {
      id: "espn-demo-player-3139477",
      label: "Patrick Mahomes",
      kind: "player-headshot",
      source: "espn-demo",
      rights: "user-provided",
      status: "cached",
      publicPath: "/media-cache/assets/espn-player-3139477.png"
    },
    {
      id: "generated-team-kc",
      label: "KC",
      kind: "fallback-badge",
      source: "generated",
      rights: "generated-fallback",
      status: "generated",
      localPath: "/app/public/media-cache/assets/team-kc.svg"
    },
    {
      id: "espn-demo-team-kc",
      label: "KC",
      kind: "team-logo",
      source: "espn-demo",
      rights: "user-provided",
      status: "cached",
      publicPath: "/media-cache/assets/espn-team-kc.png"
    }
  ]
};

describe("media manifest lookup", () => {
  it("prefers player headshots over generated player fallbacks", () => {
    const index = createMediaLookupIndex(manifest);
    const asset = resolvePlayerMedia(index, { id: "kc-qb-15", name: "Patrick Mahomes" });
    expect(asset?.id).toBe("espn-demo-player-3139477");
    expect(mediaAssetUrl(asset)).toBe("/media-cache/assets/espn-player-3139477.png");
  });

  it("resolves team logos and converts old local paths to public URLs", () => {
    const index = createMediaLookupIndex(manifest);
    expect(resolveTeamMedia(index, "KC")?.id).toBe("espn-demo-team-kc");
    expect(mediaAssetUrl(manifest.assets[2])).toBe("/media-cache/assets/team-kc.svg");
  });
});
