import type { SportsGameOption } from "../shared/contracts";

/**
 * Bundled demo game options surfaced when the client picks
 * `sportsDataMode=demo` from the discover page. Mirrors what the
 * Fastify `/api/sports/games` handler returns; the Next.js route
 * imports this so a Vercel deploy without any Fastify backing serves
 * the same list. Pure data — no I/O.
 */
export function demoGameOptions(): SportsGameOption[] {
  return [
    {
      id: "demo-kc-det",
      label: "Kansas City Chiefs at Detroit Lions",
      shortName: "KC @ DET",
      sport: "nfl",
      awayTeam: "KC",
      homeTeam: "DET",
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
      score: { away: 88, home: 92 },
      status: "demo",
      detail: "Q4 4:02 · scripted demo",
      broadcast: "ESPN"
    }
  ];
}
