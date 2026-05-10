# Huddle Radio

Huddle Radio is a personalized sports audio show for a fantasy league or friend group. It listens to fantasy state, sports play-by-play, optional video/screen-share context, news context, and group preferences, then produces low-latency commentary with optional streaming text-to-speech.

The current product is a local MVP for NFL fantasy football. It runs without credentials through demo data, but it already has provider seams for ESPN Fantasy, Sleeper, ESPN scoreboard data, OpenAI commentary/vision, ElevenLabs streaming TTS, and future licensed data/model providers.

## What It Is

Huddle should feel like a live sports media product, not a fantasy admin dashboard.

- The first screen helps a new user create a show: connect fantasy, choose what they are watching, and meet the hosts.
- Pregame mode frames the matchup, host personalities, storylines, and players to watch.
- Live mode prioritizes the broadcast or, when no stream is attached, a radio-style moment hero with player/team media and host conversation.
- Postgame mode turns the session into a shareable recap.
- Technical provider health and diagnostics are available, but they should stay out of the main show experience.

## Current Reality

Works now:

- Demo fantasy league and scripted NFL plays.
- Custom demo league JSON for experimenting with roster/player mappings.
- Sleeper fantasy scaffold/read path.
- ESPN Fantasy adapter for public leagues and private leagues with cookies.
- ESPN public NFL scoreboard adapter.
- YouTube URL detection and embed support.
- Screen-share flow for ESPN, YouTube TV, cable apps, and other authenticated/DRM surfaces.
- OpenAI commentary provider when `OPENAI_API_KEY` is configured.
- OpenAI vision-based frame validation when `MODEL_PROVIDER=openai-vision`.
- ElevenLabs WebSocket TTS when `ELEVENLABS_API_KEY` is configured.
- Mock/local model and TTS fallbacks when keys are absent.
- Media cache for team logos, player headshots, generated placeholders, and Huddle host art.
- Unit/integration-style tests for providers, engine, media, server endpoints, WebSocket flow, and Huddle view-model helpers.

Not production-ready yet:

- Licensed real-time sports data beyond public ESPN scoreboard context.
- Production auth/accounts.
- Yahoo OAuth.
- Sportradar/SportsDataIO adapters.
- Real Nemotron endpoint integration.
- Multi-host backend orchestration with separate generated voices/personas.
- Broadcast redistribution or any DRM bypass. The app only accepts user-provided/permitted sources.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

For the cleanest no-key demo:

1. Click `Create show +`.
2. Start the demo show.
3. Leave stream empty to test the live audio/no-stream experience.
4. Use `Stream` or setup controls to add a permitted URL or screen share.

The dev command starts both:

- Fastify backend on `PORT` from `.env.example` (`8787` by default).
- Vite frontend on `http://localhost:5173`.

## Environment Setup

Copy the template:

```bash
cp .env.example .env
```

The app works without keys. With no keys, it uses demo data, local commentary, mock model observations, and browser/mock TTS. Restart `npm run dev` after changing `.env`.

Common local modes:

```bash
# Fully local/free-ish demo mode.
MODEL_PRESET=local
COMMENTARY_PROVIDER=local
MODEL_PROVIDER=mock
TTS_PROVIDER=mock
FANTASY_PROVIDER=demo
SPORTS_DATA_PROVIDER=demo

# SOTA commentary and ElevenLabs TTS when keys exist.
MODEL_PRESET=sota
COMMENTARY_PROVIDER=auto
MODEL_PROVIDER=openai-vision
TTS_PROVIDER=auto
OPENAI_API_KEY=...
ELEVENLABS_API_KEY=...
```

More detail:

- [API keys and provider modes](docs/api-keys.md)
- [Provider guide](docs/providers.md)
- [Video ingest and rights boundaries](docs/video-ingest.md)

## Commands

```bash
npm run dev            # backend + Vite client
npm run dev:server     # backend only
npm run dev:client     # Vite client only
npm run build          # TypeScript check + Vite production build
npm run test           # default no-credit test suite
npm run test:providers # optional provider smoke tests
npm run media:cache    # generate/cache approved media assets
npm run preview        # preview production build
```

## App Structure

```text
src/client/             React app, Huddle phases, UI state, styles
src/client/huddleViewModel.ts
                        phase selection and show-specific view models
src/server/             Fastify REST + WebSocket API
src/providers/          fantasy, sports data, news, model, video, TTS providers
src/engine/             livecast commentary and fantasy impact logic
src/shared/             contracts, media manifest helpers, readiness/model stack
scripts/                media cache tooling
public/huddle/          Huddle product art
public/media-cache/     generated/cached media manifest and assets
docs/                   product, architecture, provider, test, media docs
```

## Runtime Flow

1. Browser bootstraps fantasy/game/group/provider state from `/api/bootstrap`.
2. User creates or starts a show.
3. Browser opens `/ws/livecast`.
4. Backend loads fantasy state and current game state.
5. Sports provider emits play-by-play events.
6. Optional video frame/screen-share validation produces visual context.
7. Livecast engine ranks fantasy impact and moment priority.
8. Commentary provider drafts a short personalized call.
9. TTS provider streams audio chunks when enabled.
10. Client renders Huddle phases: empty, pregame, live, live-audio, recap.

See [architecture](docs/architecture.md) for the full data flow.

## Product Experience

The Huddle experience is intentionally phase-based:

- `empty`: first-run onboarding.
- `pregame`: matchup and host preview.
- `live`: video-dominant show when a stream/screen share/VOD is attached.
- `live-audio`: radio-style show when no stream is attached.
- `recap`: postgame summary and share/export path.

See [product experience](docs/product-experience.md) and [design system](docs/design-system.md).

## Media Assets

The app uses:

- `/public/huddle/*` for product/host artwork.
- `/public/media-cache/manifest.json` for team/player/generated media.
- provider media when cached and permitted.
- initials/fallback badges when media is missing.

Run:

```bash
npm run media:cache
```

The cache script avoids downloading unofficial remote player/team media unless explicitly directed. See [media assets](docs/media-assets.md).

## Testing

Default checks:

```bash
npm run test
npm run build
```

The default suite does not require API keys or spend credits. Optional real-provider checks are separated:

```bash
npm run test:providers
```

See [testing](docs/testing.md).

## Rights Boundary

Huddle does not fetch unauthorized broadcasts, bypass DRM, redistribute game video, or scrape paid streams. For ESPN, YouTube TV, cable apps, and anything behind login/DRM, use browser screen share from a source you are allowed to watch. Official play-by-play remains the source of truth for scores and stats.

## Documentation Map

- [Product experience](docs/product-experience.md)
- [Design system](docs/design-system.md)
- [Architecture](docs/architecture.md)
- [Providers](docs/providers.md)
- [Livecast engine](docs/livecast-engine.md)
- [Video ingest](docs/video-ingest.md)
- [API keys](docs/api-keys.md)
- [Media assets](docs/media-assets.md)
- [ESPN Fantasy](docs/espn-fantasy.md)
- [Testing](docs/testing.md)
