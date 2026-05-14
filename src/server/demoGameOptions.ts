import type { SportsGameOption, TeamMeta } from "../shared/contracts";

/**
 * Bundled demo game options surfaced when the client picks
 * `sportsDataMode=demo` from the discover page. Mirrors what the
 * Fastify `/api/sports/games` handler returns; the Next.js route
 * imports this so a Vercel deploy without any Fastify backing serves
 * the same list. Pure data — no I/O.
 *
 * Each option ships `awayMeta`/`homeMeta` with ESPN CDN logo URLs +
 * team colors so the game-card grid and topbar matchup chip render
 * logos instantly without going through the media-manifest lookup.
 * On Vercel the manifest is empty (the cache dir is gitignored), so
 * without these the demo grid showed initials-only on the deployed
 * build AND logged 404s for the missing local logo paths.
 */
function teamMeta(
  sport: "nfl" | "nba",
  abbr: string,
  shortName: string,
  displayName: string,
  color: string,
  alternateColor: string
): TeamMeta {
  return {
    abbreviation: abbr,
    displayName,
    shortName,
    logo: `https://a.espncdn.com/i/teamlogos/${sport}/500/${abbr.toLowerCase()}.png`,
    color,
    alternateColor
  };
}

export function demoGameOptions(): SportsGameOption[] {
  return [
    {
      id: "demo-kc-det",
      label: "Kansas City Chiefs at Detroit Lions",
      shortName: "KC @ DET",
      sport: "nfl",
      awayTeam: "KC",
      homeTeam: "DET",
      awayMeta: teamMeta("nfl", "KC", "Chiefs", "Kansas City Chiefs", "E31837", "FFB81C"),
      homeMeta: teamMeta("nfl", "DET", "Lions", "Detroit Lions", "0076B6", "B0B7BC"),
      score: { away: 24, home: 21 },
      status: "demo",
      detail: "Scripted demo game",
      broadcast: "ESPN"
    },
    {
      id: "demo-buf-cin",
      label: "Buffalo Bills at Cincinnati Bengals",
      shortName: "BUF @ CIN",
      sport: "nfl",
      awayTeam: "BUF",
      homeTeam: "CIN",
      awayMeta: teamMeta("nfl", "BUF", "Bills", "Buffalo Bills", "00338D", "C60C30"),
      homeMeta: teamMeta("nfl", "CIN", "Bengals", "Cincinnati Bengals", "FB4F14", "000000"),
      score: { away: 0, home: 0 },
      status: "demo",
      detail: "Pregame · scripted demo",
      broadcast: "Demo"
    },
    {
      id: "demo-den-okc",
      label: "Denver Nuggets at Oklahoma City Thunder",
      shortName: "DEN @ OKC",
      sport: "nba",
      awayTeam: "DEN",
      homeTeam: "OKC",
      awayMeta: teamMeta("nba", "DEN", "Nuggets", "Denver Nuggets", "0E2240", "FEC524"),
      homeMeta: teamMeta("nba", "OKC", "Thunder", "Oklahoma City Thunder", "007AC1", "EF3B24"),
      score: { away: 58, home: 62 },
      status: "demo",
      detail: "Q3 6:14 · scripted demo",
      broadcast: "TNT"
    },
    {
      id: "demo-bos-dal",
      label: "Boston Celtics at Dallas Mavericks",
      shortName: "BOS @ DAL",
      sport: "nba",
      awayTeam: "BOS",
      homeTeam: "DAL",
      awayMeta: teamMeta("nba", "BOS", "Celtics", "Boston Celtics", "007A33", "BA9653"),
      homeMeta: teamMeta("nba", "DAL", "Mavericks", "Dallas Mavericks", "00538C", "B8C4CA"),
      score: { away: 0, home: 0 },
      status: "demo",
      detail: "Tip-off 8pm · scripted demo",
      broadcast: "Demo"
    },
    {
      id: "demo-lal-phx",
      label: "Los Angeles Lakers at Phoenix Suns",
      shortName: "LAL @ PHX",
      sport: "nba",
      awayTeam: "LAL",
      homeTeam: "PHX",
      awayMeta: teamMeta("nba", "LAL", "Lakers", "Los Angeles Lakers", "552583", "FDB927"),
      homeMeta: teamMeta("nba", "PHX", "Suns", "Phoenix Suns", "1D1160", "E56020"),
      score: { away: 88, home: 92 },
      status: "demo",
      detail: "Q4 4:02 · scripted demo",
      broadcast: "ESPN"
    }
  ];
}
