# Architecture

Huddle Radio is split into three layers:

- React/Vite client for the show experience.
- Fastify backend for provider orchestration and WebSocket streaming.
- Shared TypeScript contracts for data normalization.

The architecture deliberately keeps provider-specific details out of the client. The client should render a show; the server should normalize data, generate commentary, and stream events.

## Runtime Components

```text
Browser
  React app
  Huddle phase/view-model layer
  media cache loader
  video/screen-share capture
  WebSocket event consumer

Fastify server
  REST bootstrap/diagnostics endpoints
  /ws/livecast event loop
  provider factory wiring
  OpenAI/ElevenLabs integration points

Providers
  FantasyProvider
  SportsDataProvider
  NewsProvider
  VideoSourceProvider
  MultimodalModelProvider
  CommentaryProvider
  TTSProvider

Engine
  fantasy impact ranking
  moment cue scoring
  commentary object assembly
  transcript export
```

## Main Data Flow

1. Browser loads `/api/bootstrap`.
2. Backend returns fantasy state, game state, default group settings, provider summaries, and provider health.
3. Client derives Huddle phase and view models.
4. User starts a show.
5. Browser opens `/ws/livecast` and sends a `LivecastRequest`.
6. Backend loads selected fantasy provider and sports provider.
7. Backend emits an initial `snapshot`.
8. On every tick:
   - sports provider emits/returns the next play,
   - model provider observes optional video/frame context,
   - news provider returns short context,
   - engine ranks moment and fantasy impact,
   - commentary provider drafts the spoken line,
   - TTS provider streams audio chunks when enabled.
9. Client updates the show UI, waveform, host turns, score, highlights, and recap state.

## REST Endpoints

`GET /api/health`

Returns provider health and active provider labels.

`GET /api/bootstrap`

Loads current fantasy/game/group state. Query parameters include:

- `providerMode=demo|sleeper|espn`
- `sportsDataMode=demo|espn`
- `sportsGameId`
- `sleeperLeagueId`
- `espnLeagueId`
- `espnSeason`
- `week`

`GET /api/fantasy/preview`

Validates/loads a fantasy league before starting a show and returns readiness checks.

`GET /api/diagnostics`

Returns technical provider diagnostics for Settings/Diagnostics surfaces.

`GET /api/sports/games`

Lists demo game options or ESPN scoreboard game options.

`GET /api/model-stack`

Returns the resolved model stack profile.

`POST /api/video/validate-frame`

Accepts a browser-captured frame and returns a model observation/validation response.

## WebSocket Endpoint

`GET /ws/livecast`

The socket accepts:

- a full `LivecastRequest` JSON message to start/restart a show,
- frame messages for ongoing video validation.

It emits:

- `snapshot`: fantasy/game/provider state,
- `play`: latest play and game state,
- `observation`: video/model observation,
- `commentary`: generated commentary plus fantasy impacts and latency,
- `tts`: TTS audio chunk metadata and optional base64 audio,
- `health`: periodic provider health,
- `error`: recoverable runtime error.

## Shared Contracts

Contracts live in `src/shared/contracts.ts`. The important normalized entities are:

- `FantasyLeagueState`
- `FantasyRoster`
- `FantasyPlayer`
- `SportsGameState`
- `SportsPlay`
- `VideoObservation`
- `StreamValidation`
- `FantasyImpact`
- `MomentCue`
- `LivecastCommentary`
- `LatencyMetrics`
- `ClientServerEvent`

These contracts are the boundary between providers, engine, server, and UI.

## Client Phase Layer

`src/client/huddleViewModel.ts` converts app state into show surfaces:

- `deriveHuddlePhase`
- `buildSetupSteps`
- `buildHostTurns`
- `buildMatchupStory`
- `buildFantasySpotlight`
- `buildRecapSummary`

This keeps product presentation local to the client while avoiding backend churn for every UI experiment.

## Provider Factories

The server chooses providers inside `src/server/app.ts`.

Fantasy:

- demo,
- Sleeper,
- ESPN,
- custom demo league JSON.

Sports data:

- demo scripted plays,
- ESPN public scoreboard.

News:

- demo news.

Model:

- mock,
- OpenAI vision,
- planned Nemotron,
- planned OpenAI realtime.

Commentary:

- local fallback,
- OpenAI Responses API.

TTS:

- mock/browser-compatible flow,
- ElevenLabs streaming WebSocket TTS.

## Latency Budget

Each commentary object includes:

- `videoIngestMs`
- `modelResponseMs`
- `textGenerationMs`
- `ttsFirstAudioMs`
- `endToEndMs`

Target MVP behavior:

- demo/local path should feel instant,
- commentary generation should stay short enough for real-time delivery,
- TTS first audio should be optimized before overall audio fidelity,
- official play-by-play should remain source of truth even if vision is slow/unavailable.

## Error Handling

Server errors are redacted before being sent to the client. The main UI should translate technical errors into plain-language states, for example:

- `Signal issue`
- `Needs setup`
- `Using demo data`
- `Following official play-by-play`

Raw provider/HTTP errors belong in diagnostics, not the main show surface.

## Production Direction

Recommended production path:

1. Add account/auth/session model.
2. Replace demo/ESPN scoreboard live data with a licensed low-latency provider.
3. Add robust provider ID mapping across fantasy, stats, media, and news.
4. Use screen share or licensed video ingest only.
5. Add multi-host orchestration and voice selection.
6. Add persistent show history, clips, and recap sharing.
7. Consolidate CSS into a stable component/token system.
