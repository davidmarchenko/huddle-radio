import type { FantasyLeagueState, FantasyPlayer } from "./contracts";

export type MediaAssetKind = "fantasy-avatar" | "team-logo" | "player-headshot" | "fallback-badge";
export type MediaAssetSource = "generated" | "sleeper" | "espn-demo" | "licensed-provider";
export type MediaRights = "generated-fallback" | "user-provided" | "provider-permitted" | "provider-licensed" | "demo-unofficial";

export type MediaAssetCandidate = {
  id: string;
  kind: MediaAssetKind;
  label: string;
  source: MediaAssetSource;
  rights: MediaRights;
  url?: string;
  contentType?: string;
  filenameHint?: string;
  metadata?: Record<string, string | number | boolean | undefined>;
};

export function uniqueFantasyPlayers(league: FantasyLeagueState): FantasyPlayer[] {
  const players = new Map<string, FantasyPlayer>();
  for (const matchup of league.matchups) {
    for (const roster of matchup.rosters) {
      for (const player of [...roster.starters, ...roster.bench]) {
        players.set(player.id, player);
      }
    }
  }
  return [...players.values()];
}

export function uniqueFantasyTeams(league: FantasyLeagueState): string[] {
  const teams = new Set<string>();
  for (const player of uniqueFantasyPlayers(league)) {
    if (player.proTeam && player.proTeam !== "FA") teams.add(player.proTeam);
  }
  return [...teams].sort();
}

export function generatedFallbackAssetsFromLeague(league: FantasyLeagueState): MediaAssetCandidate[] {
  const playerAssets = uniqueFantasyPlayers(league).map((player) => ({
    id: `generated-player-${player.id}`,
    kind: "fallback-badge" as const,
    label: player.name,
    source: "generated" as const,
    rights: "generated-fallback" as const,
    contentType: "image/svg+xml",
    filenameHint: `player-${player.id}`,
    metadata: {
      playerId: player.id,
      position: player.position,
      proTeam: player.proTeam,
      initials: initialsForLabel(player.name)
    }
  }));

  const teamAssets = uniqueFantasyTeams(league).map((team) => ({
    id: `generated-team-${team.toLowerCase()}`,
    kind: "fallback-badge" as const,
    label: team,
    source: "generated" as const,
    rights: "generated-fallback" as const,
    contentType: "image/svg+xml",
    filenameHint: `team-${team.toLowerCase()}`,
    metadata: {
      team,
      initials: team
    }
  }));

  return [...teamAssets, ...playerAssets];
}

export function sleeperAvatarAsset(input: {
  id: string;
  label: string;
  avatarId?: string;
  kind?: Extract<MediaAssetKind, "fantasy-avatar">;
}): MediaAssetCandidate | undefined {
  if (!input.avatarId) return undefined;
  return {
    id: `sleeper-avatar-${input.id}`,
    kind: input.kind ?? "fantasy-avatar",
    label: input.label,
    source: "sleeper",
    rights: "provider-permitted",
    url: `https://sleepercdn.com/avatars/${input.avatarId}`,
    filenameHint: `sleeper-${input.id}`,
    metadata: {
      sleeperAvatarId: input.avatarId
    }
  };
}

export function espnDemoTeamLogoAsset(teamAbbreviation: string): MediaAssetCandidate {
  const team = teamAbbreviation.toLowerCase();
  return {
    id: `espn-demo-team-${team}`,
    kind: "team-logo",
    label: teamAbbreviation.toUpperCase(),
    source: "espn-demo",
    rights: "demo-unofficial",
    url: `https://a.espncdn.com/i/teamlogos/nfl/500/${team}.png`,
    filenameHint: `espn-team-${team}`,
    metadata: {
      team: teamAbbreviation.toUpperCase()
    }
  };
}

export function espnDemoPlayerHeadshotAsset(player: FantasyPlayer, espnId: number | string): MediaAssetCandidate {
  return {
    id: `espn-demo-player-${espnId}`,
    kind: "player-headshot",
    label: player.name,
    source: "espn-demo",
    rights: "demo-unofficial",
    url: `https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png`,
    filenameHint: `espn-player-${espnId}`,
    metadata: {
      playerId: player.id,
      espnId,
      proTeam: player.proTeam,
      position: player.position
    }
  };
}

export function createFallbackSvg(label: string, subtitle = ""): string {
  const initials = escapeXml(initialsForLabel(label));
  const escapedLabel = escapeXml(label);
  const escapedSubtitle = escapeXml(subtitle);
  const { background, accent } = colorsForLabel(label);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400" role="img" aria-label="${escapedLabel}">`,
    `<rect width="400" height="400" rx="48" fill="${background}"/>`,
    `<circle cx="314" cy="86" r="46" fill="${accent}" opacity="0.82"/>`,
    `<text x="50%" y="48%" text-anchor="middle" dominant-baseline="central" font-family="Inter, Arial, sans-serif" font-size="116" font-weight="800" fill="#f8fafc">${initials}</text>`,
    escapedSubtitle
      ? `<text x="50%" y="75%" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="700" fill="#dbeafe">${escapedSubtitle}</text>`
      : "",
    `</svg>`
  ].join("");
}

export function initialsForLabel(label: string): string {
  const words = label
    .replace(/['.]/g, "")
    .split(/\s+|&|-|_/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

export function safeAssetFilename(asset: MediaAssetCandidate, extension: string): string {
  return `${sanitizeFilenamePart(asset.filenameHint ?? asset.id)}.${extension.replace(/^\./, "")}`;
}

export function sanitizeFilenamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

export function extensionFromContentType(contentType?: string, url?: string): string {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  if (type === "image/svg+xml") return "svg";
  if (type === "image/png") return "png";
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/webp") return "webp";

  const pathname = url ? new URL(url).pathname : "";
  const match = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
  return match?.[1]?.toLowerCase() ?? "bin";
}

function colorsForLabel(label: string) {
  const palettes = [
    { background: "#17324d", accent: "#35c2a1" },
    { background: "#3a2447", accent: "#f59e0b" },
    { background: "#123b2d", accent: "#f97316" },
    { background: "#3f2f19", accent: "#38bdf8" },
    { background: "#2f365f", accent: "#f43f5e" },
    { background: "#1f3a37", accent: "#a3e635" }
  ];
  const index = [...label].reduce((sum, char) => sum + char.charCodeAt(0), 0) % palettes.length;
  return palettes[index];
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    const replacements: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      "\"": "&quot;"
    };
    return replacements[char];
  });
}
