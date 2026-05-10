# ESPN Fantasy

The ESPN Fantasy adapter supports NFL fantasy football through ESPN's unofficial v3 fantasy endpoints.

## Endpoint Shape

The main endpoint is:

```text
https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{leagueId}
```

The adapter requests views such as:

- `mTeam`
- `mRoster`
- `mMatchup`
- `mMatchupScore`
- `mSettings`

## Public Leagues

Public leagues may work with:

```bash
ESPN_LEAGUE_ID=123456
ESPN_SEASON=2026
```

In the app, choose ESPN Fantasy, enter league/season/week, and validate/load.

## Private Leagues

Private leagues require cookies from the ESPN account that can access the league:

```bash
ESPN_SWID=
ESPN_S2=
```

Rules:

- Store cookies in `.env`.
- Keep them server-side.
- Do not paste them into browser code.
- Do not commit them.
- Rotate them if exposed.

## Normalization

The adapter should normalize ESPN data into:

- `FantasyLeagueState`,
- `FantasyMatchup`,
- `FantasyRoster`,
- `FantasyPlayer`.

Current normalization focuses on:

- league name/season,
- teams/owners,
- rosters,
- starters/bench,
- matchup scores,
- player name/position/team,
- projected/current points where available.

## Limitations

- ESPN endpoints are unofficial and can change.
- Private league access depends on valid cookies.
- Player/team IDs may not align with live sports data provider IDs.
- ESPN Fantasy is not a substitute for licensed live stats/play data.

## Why Not Just Use a GitHub Wrapper?

Community projects are useful references, but Huddle keeps a native adapter so:

- normalized contracts stay stable,
- browser/server boundaries stay clear,
- dependency surface stays small,
- tests can target our data model directly.

Community projects that informed endpoint shape:

- `cwendt94/espn-api`
- `mkreiser/ESPN-Fantasy-Football-API`

## Future Work

- More robust private league setup UI.
- Clear cookie instructions with screenshots.
- Better player ID mapping to sports data/media providers.
- Scoring settings-driven fantasy impact.
- Multi-league/team selection.
- OAuth-like account flow if ESPN offers a supported path.
