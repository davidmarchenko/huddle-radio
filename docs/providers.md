# Providers

Providers isolate external APIs and keep the app normalized around Huddle contracts. Provider interfaces live in `src/shared/contracts.ts`.

## Provider Types

Fantasy:

```ts
FantasyProvider
```

Returns normalized league, roster, matchup, scoring, and player state.

Sports data:

```ts
SportsDataProvider
```

Returns game state, available games, and play-by-play events.

News:

```ts
NewsProvider
```

Returns short player/team context for commentary.

Video:

```ts
VideoSourceProvider
```

Tracks user-provided video configuration and validates basic source behavior.

Model:

```ts
MultimodalModelProvider
```

Creates observations from the current play and optional video frame.

Commentary:

```ts
CommentaryProvider
```

Drafts short personalized livecast lines.

TTS:

```ts
TTSProvider
```

Streams audio chunk events for generated commentary.

## Fantasy Providers

### DemoFantasyProvider

File: `src/providers/demoFantasyProvider.ts`

Purpose:

- no-key local development,
- deterministic tests,
- product demos,
- custom demo league experiments.

The demo provider returns the bundled `demoLeagueState`.

### Custom Demo League

The client can pass a full `FantasyLeagueState` through `LivecastRequest.customLeague`. This is useful for testing roster names, friends, player IDs, and fake matchups without building auth.

Important: scripted sports plays only generate fantasy impact when `SportsPlay.playerIds` match demo/custom player IDs.

### SleeperFantasyProvider

File: `src/providers/sleeperFantasyProvider.ts`

Sleeper is the first real fantasy-friendly adapter because it is read-only and does not require OAuth for public league data.

Useful inputs:

- `SLEEPER_LEAGUE_ID`
- `SLEEPER_WEEK`

Expected behavior:

- load league metadata,
- load rosters,
- load users,
- map users to rosters,
- normalize player IDs/names/teams,
- return `FantasyLeagueState`.

### EspnFantasyProvider

File: `src/providers/espnFantasyProvider.ts`

ESPN Fantasy support uses ESPN's unofficial v3 fantasy endpoints.

Public leagues may work with:

- `ESPN_LEAGUE_ID`
- `ESPN_SEASON`
- `week`

Private leagues require:

- `ESPN_SWID`
- `ESPN_S2`

Those cookies must stay server-side in `.env`.

See [ESPN Fantasy](espn-fantasy.md).

### Yahoo Fantasy

Yahoo is documented as a future provider. Private Yahoo fantasy data requires OAuth, so it should not be implemented as a no-auth scrape.

Recommended future work:

- OAuth app setup,
- user consent,
- token refresh storage,
- normalized Yahoo league/team/player mapping.

## Sports Data Providers

### DemoSportsDataProvider

File: `src/providers/demoSportsDataProvider.ts`

Purpose:

- deterministic scripted NFL play-by-play,
- no-key demos,
- repeatable WebSocket tests,
- fantasy impact testing.

### EspnSportsDataProvider

File: `src/providers/espnSportsDataProvider.ts`

Uses ESPN public NFL scoreboard data for game status and lightweight play context.

Strengths:

- no API key,
- useful for demo or hobby development,
- enough to select games and follow basic state.

Limitations:

- not a licensed production feed,
- limited player ID consistency,
- sparse data depending on game status,
- not guaranteed low latency.

### Licensed Production Providers

Recommended:

- Sportradar NFL play-by-play / push events,
- SportsDataIO NFL scores, stats, injuries, and news.

Production adapters should provide:

- stable game IDs,
- stable player IDs,
- low-latency play feed,
- official scoring/stat deltas,
- licensing for downstream use,
- media/news terms that are clear enough for caching/display.

## News Providers

Current:

- `DemoNewsProvider`

Future:

- licensed sports news provider,
- fantasy injury/news provider,
- team/player notes from a data partner.

News should be short, attribution-friendly, and used as context. Do not dump article text into prompts or UI.

## Video and Model Providers

### UserVideoProvider

File: `src/providers/userVideoProvider.ts`

Tracks the selected video mode:

- `stream-url`,
- `screen-share`,
- `vod`.

It does not bypass browser security or DRM.

### MockModelProvider

Simulates visual/model observation for local development.

### OpenAIVisionModelProvider

Uses browser-captured frames and OpenAI vision to classify/describe whether a source appears to be a sporting event.

Vision output is contextual only. Official play-by-play remains the source of truth.

### Nemotron

`MODEL_PROVIDER=nemotron` is scaffolded for a future NVIDIA Nemotron 3 Nano Omni-compatible endpoint.

Expected future role:

- low-latency multimodal observation,
- audio/video event detection,
- non-authoritative visual color for commentary.

## Commentary Providers

### LocalCommentaryProvider

No-key fallback. Produces deterministic-ish text from play, moment, fantasy impact, and group context.

### OpenAICommentaryProvider

Uses OpenAI for short personalized commentary when `OPENAI_API_KEY` is present and `COMMENTARY_PROVIDER=auto|openai`.

Defaults are defined in `src/shared/modelStack.ts`.

## TTS Providers

### MockTTSProvider

Used in local/test mode. Keeps the pipeline active without ElevenLabs credentials.

### ElevenLabsTTSProvider

Uses ElevenLabs streaming WebSocket TTS.

Important environment:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `ELEVENLABS_MODEL_ID`

Default low-latency model:

- `eleven_flash_v2_5`

## Adding a Provider

1. Choose the provider interface in `src/shared/contracts.ts`.
2. Implement a provider in `src/providers`.
3. Normalize external IDs into stable app IDs.
4. Return a useful `health()` status.
5. Add unit tests for normalization and missing-key/degraded paths.
6. Wire the provider into `src/server/app.ts`.
7. Add env vars to `.env.example` if needed.
8. Update this doc and any relevant setup docs.

## Health Status Guidelines

Use:

- `ready`: usable and configured,
- `degraded`: usable with caveats,
- `disabled`: intentionally inactive or missing optional key,
- `error`: configured but failing.

Health details should be user-safe. Do not expose API keys, tokens, cookies, or raw secret-bearing URLs.

## ID Mapping Guidelines

Provider IDs are the hardest part of a real production build. Keep these separate:

- provider player ID,
- fantasy platform player ID,
- licensed stats provider player ID,
- media provider player ID,
- display name/team fallback.

The MVP often uses names/teams for fallback matching. Production should add explicit mapping tables.
