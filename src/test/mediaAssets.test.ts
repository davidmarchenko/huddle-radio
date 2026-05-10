import { describe, expect, it } from "vitest";

import { demoLeagueState } from "../providers/demoData";
import {
  createFallbackSvg,
  espnDemoPlayerHeadshotAsset,
  espnDemoTeamLogoAsset,
  extensionFromContentType,
  generatedFallbackAssetsFromLeague,
  initialsForLabel,
  safeAssetFilename,
  sleeperAvatarAsset
} from "../shared/mediaAssets";

describe("media asset helpers", () => {
  it("builds generated fallback assets from the demo league", () => {
    const assets = generatedFallbackAssetsFromLeague(demoLeagueState);
    expect(assets.some((asset) => asset.id === "generated-team-kc")).toBe(true);
    expect(assets.some((asset) => asset.label === "Patrick Mahomes")).toBe(true);
    expect(assets.every((asset) => asset.rights === "generated-fallback")).toBe(true);
  });

  it("creates stable fallback initials and SVG", () => {
    expect(initialsForLabel("Amon-Ra St. Brown")).toBe("AB");
    expect(initialsForLabel("KC")).toBe("KC");
    const svg = createFallbackSvg("Patrick Mahomes", "QB");
    expect(svg).toContain("<svg");
    expect(svg).toContain("PM");
    expect(svg).toContain("QB");
  });

  it("normalizes filenames and extensions", () => {
    expect(safeAssetFilename({ id: "a", kind: "team-logo", label: "KC", source: "generated", rights: "generated-fallback", filenameHint: "Team KC!" }, "svg")).toBe("team-kc.svg");
    expect(extensionFromContentType("image/png; charset=binary")).toBe("png");
    expect(extensionFromContentType(undefined, "https://example.com/headshot.webp")).toBe("webp");
  });

  it("builds provider-specific media candidates with explicit rights", () => {
    expect(sleeperAvatarAsset({ id: "u1", label: "Alex", avatarId: "abc" })?.url).toBe("https://sleepercdn.com/avatars/abc");
    expect(espnDemoTeamLogoAsset("KC").rights).toBe("demo-unofficial");
    expect(espnDemoPlayerHeadshotAsset(demoLeagueState.matchups[0].rosters[0].starters[0], 3139477).url).toContain("3139477.png");
  });
});
