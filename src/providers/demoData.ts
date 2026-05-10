import type { FantasyLeagueState, SportsPlay } from "../shared/contracts";

export const demoLeagueState: FantasyLeagueState = {
  provider: "demo",
  leagueId: "demo-league",
  leagueName: "Sunday Group Chat Championship",
  sport: "nfl",
  season: "2026",
  scoringSummary: "Half-PPR with 4-point passing touchdowns and one flex.",
  updatedAt: new Date().toISOString(),
  matchups: [
    {
      id: "matchup-1",
      week: 7,
      rosters: [
        {
          id: "roster-alex",
          ownerName: "Alex",
          teamName: "Fourth & Snack",
          starters: [
            { id: "kc-qb-15", name: "Patrick Mahomes", position: "QB", proTeam: "KC", projectedPoints: 22.4, currentPoints: 16.2 },
            { id: "det-wr-14", name: "Amon-Ra St. Brown", position: "WR", proTeam: "DET", projectedPoints: 16.1, currentPoints: 8.7 },
            { id: "sf-rb-23", name: "Christian McCaffrey", position: "RB", proTeam: "SF", projectedPoints: 19.8, currentPoints: 12.4 }
          ],
          bench: [
            { id: "dal-wr-88", name: "CeeDee Lamb", position: "WR", proTeam: "DAL", projectedPoints: 15.8, currentPoints: 0 }
          ]
        },
        {
          id: "roster-maya",
          ownerName: "Maya",
          teamName: "Red Zone Renaissance",
          starters: [
            { id: "kc-te-87", name: "Travis Kelce", position: "TE", proTeam: "KC", projectedPoints: 13.3, currentPoints: 10.9 },
            { id: "buf-qb-17", name: "Josh Allen", position: "QB", proTeam: "BUF", projectedPoints: 24.1, currentPoints: 14.1 },
            { id: "det-rb-5", name: "Jahmyr Gibbs", position: "RB", proTeam: "DET", projectedPoints: 17.5, currentPoints: 6.8 }
          ],
          bench: [
            { id: "cin-wr-1", name: "Ja'Marr Chase", position: "WR", proTeam: "CIN", projectedPoints: 18.2, currentPoints: 0 }
          ]
        }
      ]
    }
  ]
};

/**
 * Demo NBA league so multi-sport personalization is visible without
 * requiring users to actually connect a real fantasy basketball league.
 * Same listener "Alex" owns the team here too — the app resolves the
 * right roster per sport based on game context.
 */
export const demoNbaLeagueState: FantasyLeagueState = {
  provider: "demo",
  leagueId: "demo-nba-league",
  leagueName: "Hoops & Hot Takes",
  sport: "nba",
  season: "2026",
  scoringSummary: "9-cat roto with no punts.",
  updatedAt: new Date().toISOString(),
  matchups: [
    {
      id: "matchup-nba-1",
      week: 7,
      rosters: [
        {
          id: "roster-alex-nba",
          ownerName: "Alex",
          teamName: "Crossover Kings",
          starters: [
            { id: "den-pf-15", name: "Nikola Jokić", position: "C", proTeam: "DEN", projectedPoints: 56.2, currentPoints: 28.1 },
            { id: "okc-pg-2", name: "Shai Gilgeous-Alexander", position: "PG", proTeam: "OKC", projectedPoints: 48.4, currentPoints: 22.5 },
            { id: "bos-sf-0", name: "Jayson Tatum", position: "SF", proTeam: "BOS", projectedPoints: 44.1, currentPoints: 18.7 }
          ],
          bench: [
            { id: "lal-pg-3", name: "Austin Reaves", position: "SG", proTeam: "LAL", projectedPoints: 28.4, currentPoints: 0 }
          ]
        },
        {
          id: "roster-rivals-nba",
          ownerName: "Devon",
          teamName: "Triple Doubles & Trouble",
          starters: [
            { id: "dal-pg-77", name: "Luka Dončić", position: "PG", proTeam: "DAL", projectedPoints: 52.6, currentPoints: 24.8 },
            { id: "min-c-32", name: "Karl-Anthony Towns", position: "C", proTeam: "MIN", projectedPoints: 41.2, currentPoints: 16.1 },
            { id: "phx-sg-1", name: "Devin Booker", position: "SG", proTeam: "PHX", projectedPoints: 42.5, currentPoints: 19.4 }
          ],
          bench: [
            { id: "atl-pg-11", name: "Trae Young", position: "PG", proTeam: "ATL", projectedPoints: 39.0, currentPoints: 0 }
          ]
        }
      ]
    }
  ]
};

export const demoLeagues: FantasyLeagueState[] = [demoLeagueState, demoNbaLeagueState];

export const demoPlays: SportsPlay[] = [
  {
    id: "play-001",
    type: "pass",
    excitement: 3,
    clock: "12:42",
    quarter: "Q2",
    possession: "KC",
    headline: "Mahomes escapes pressure for a chunk gain",
    description: "Patrick Mahomes scrambles right and finds Travis Kelce across the middle for 21 yards.",
    playerIds: ["kc-qb-15", "kc-te-87"],
    team: "KC",
    score: { away: 13, home: 10 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "play-002",
    type: "touchdown",
    excitement: 5,
    clock: "11:58",
    quarter: "Q2",
    possession: "KC",
    headline: "Kelce converts in the red zone",
    description: "Travis Kelce catches a short touchdown after motioning into the flat.",
    playerIds: ["kc-te-87", "kc-qb-15"],
    team: "KC",
    score: { away: 20, home: 10 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "play-003",
    type: "rush",
    excitement: 4,
    clock: "09:36",
    quarter: "Q2",
    possession: "DET",
    headline: "Gibbs breaks loose",
    description: "Jahmyr Gibbs cuts behind the left guard and bursts for 34 yards.",
    playerIds: ["det-rb-5"],
    team: "DET",
    score: { away: 20, home: 13 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "play-004",
    type: "first-down",
    excitement: 3,
    clock: "08:21",
    quarter: "Q2",
    possession: "DET",
    headline: "St. Brown keeps the drive alive",
    description: "Amon-Ra St. Brown hauls in a contested third-down catch near the sideline.",
    playerIds: ["det-wr-14"],
    team: "DET",
    score: { away: 20, home: 13 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "play-005",
    type: "turnover",
    excitement: 5,
    clock: "06:44",
    quarter: "Q2",
    possession: "KC",
    headline: "Mahomes gets picked under pressure",
    description: "Patrick Mahomes is intercepted while trying to force a deep throw into double coverage.",
    playerIds: ["kc-qb-15"],
    team: "DET",
    score: { away: 20, home: 13 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "play-006",
    type: "touchdown",
    excitement: 5,
    clock: "05:51",
    quarter: "Q2",
    possession: "DET",
    headline: "Gibbs cashes in after the takeaway",
    description: "Jahmyr Gibbs runs for an 8 yard touchdown after Detroit starts with a short field.",
    playerIds: ["det-rb-5"],
    team: "DET",
    score: { away: 20, home: 20 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "play-007",
    type: "pass",
    excitement: 4,
    clock: "03:12",
    quarter: "Q2",
    possession: "DET",
    headline: "St. Brown turns a short catch into trouble",
    description: "Amon-Ra St. Brown catches a quick slant and fights through contact for 18 yards.",
    playerIds: ["det-wr-14"],
    team: "DET",
    score: { away: 20, home: 20 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "play-008",
    type: "field-goal",
    excitement: 2,
    clock: "00:04",
    quarter: "Q2",
    possession: "KC",
    headline: "Kansas City steals three before halftime",
    description: "Kansas City hits a 46 yard field goal as the half expires.",
    playerIds: [],
    team: "KC",
    score: { away: 23, home: 20 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "play-009",
    type: "rush",
    excitement: 3,
    clock: "13:17",
    quarter: "Q3",
    possession: "DET",
    headline: "Gibbs starts the half with patience",
    description: "Jahmyr Gibbs waits behind the right tackle and slips forward for 11 yards.",
    playerIds: ["det-rb-5"],
    team: "DET",
    score: { away: 23, home: 20 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "play-010",
    type: "touchdown",
    excitement: 5,
    clock: "10:02",
    quarter: "Q3",
    possession: "DET",
    headline: "St. Brown wins at the goal line",
    description: "Amon-Ra St. Brown catches a 12 yard touchdown on a sharp in-breaker.",
    playerIds: ["det-wr-14"],
    team: "DET",
    score: { away: 23, home: 27 },
    occurredAt: new Date().toISOString()
  }
];

/**
 * NBA play stream — used when the user picks a basketball game in demo
 * mode. Player IDs match `demoNbaLeagueState` so listener spotlights and
 * fantasy impacts wire up the same way they do for the NFL stream.
 */
export const demoNbaPlays: SportsPlay[] = [
  {
    id: "nba-play-001",
    type: "other",
    excitement: 3,
    clock: "9:48",
    quarter: "Q3",
    possession: "DEN",
    headline: "Jokić threads a no-look to the corner",
    description: "Nikola Jokić whips a no-look pass from the post to a wide-open corner three.",
    playerIds: ["den-pf-15"],
    team: "DEN",
    score: { away: 58, home: 62 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "nba-play-002",
    type: "other",
    excitement: 4,
    clock: "8:30",
    quarter: "Q3",
    possession: "OKC",
    headline: "SGA gets to the rim",
    description: "Shai Gilgeous-Alexander snakes through the lane and finishes through contact.",
    playerIds: ["okc-pg-2"],
    team: "OKC",
    score: { away: 58, home: 64 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "nba-play-003",
    type: "other",
    excitement: 5,
    clock: "6:44",
    quarter: "Q3",
    possession: "DEN",
    headline: "Jokić hits a step-back three",
    description: "Nikola Jokić rises over a smaller defender and drains a long jumper from the wing.",
    playerIds: ["den-pf-15"],
    team: "DEN",
    score: { away: 61, home: 64 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "nba-play-004",
    type: "other",
    excitement: 4,
    clock: "5:12",
    quarter: "Q3",
    possession: "OKC",
    headline: "SGA finds Williams for the slam",
    description: "Shai Gilgeous-Alexander draws two defenders and dishes to a cutting Jalen Williams.",
    playerIds: ["okc-pg-2"],
    team: "OKC",
    score: { away: 61, home: 66 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "nba-play-005",
    type: "turnover",
    excitement: 4,
    clock: "3:45",
    quarter: "Q3",
    possession: "DEN",
    headline: "Jokić gets stripped at the elbow",
    description: "OKC traps the high post and forces a Jokić turnover that becomes an easy fast-break two.",
    playerIds: ["den-pf-15"],
    team: "OKC",
    score: { away: 61, home: 68 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "nba-play-006",
    type: "other",
    excitement: 5,
    clock: "1:58",
    quarter: "Q3",
    possession: "DEN",
    headline: "Jokić answers with a soft jumper",
    description: "Jokić shrugs off the steal and drops a smooth mid-range jumper over a closeout.",
    playerIds: ["den-pf-15"],
    team: "DEN",
    score: { away: 63, home: 68 },
    occurredAt: new Date().toISOString()
  },
  {
    id: "nba-play-007",
    type: "other",
    excitement: 4,
    clock: "0:14",
    quarter: "Q3",
    possession: "OKC",
    headline: "SGA beats the buzzer with a pull-up",
    description: "Shai pulls up from the elbow and beats the third-quarter horn.",
    playerIds: ["okc-pg-2"],
    team: "OKC",
    score: { away: 63, home: 70 },
    occurredAt: new Date().toISOString()
  }
];
