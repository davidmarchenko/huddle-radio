# Huddle Radio

A personalized AI sports producer that turns any game into a live audio
show made for you and your friends. It pulls fantasy state, official
play-by-play, broadcast video/audio, and live prediction-market prices
into a multi-host on-air conversation that knows your roster and reacts
to the same signals you do.

## The pitch

Three multimodal AI surfaces, one model:

- **Nemotron Nano Omni — vision** watches the broadcast frame-by-frame
  via NVIDIA's hosted catalog (or a self-hosted NIM container) and
  surfaces what it sees in a "Nemotron sees" panel
  (`docs/nim-on-prem.md`).
- **Nemotron Nano Omni — ASR** transcribes broadcast audio and the
  listener's push-to-talk "Cue host" button (W18). The same word-level
  timestamps power karaoke-style WebVTT subtitles for shareable clips.
- **Nemotron Nano Omni — subtitles** generates a `.vtt` track for any
  archived TTS clip via `POST /api/clip/subtitles` so a moment can
  ship to a group chat with synced captions.

Live market signals from Kalshi (`KXNFL`, `KXNBA`, `KXMLBGAME`, …) and
Polymarket land in two places:

- A **score-bug-adjacent ticker** that surfaces 2-3 relevant markets
  for the active game and refreshes every 8 seconds.
- The **commentary engine itself** — a swing detector triggers a
  "warming/cooling" lead when a market moves >5¢, and the persona
  prompts cite Kalshi/Polymarket prices on-air.

Listener feedback closes the loop: hold the **Cue host** button, ASR
transcribes your question, the show queues it, and the next host turn
addresses it directly.

## Current Reality

Huddle Radio runs as a Next.js 16 app (App Router + Turbopack) with a
Fastify shim hosting the long-running websocket show until the
SSE-based migration completes. Provider seams exist for ESPN Fantasy,
Sleeper, ESPN scoreboard data, OpenAI commentary/vision, ElevenLabs
streaming TTS, Kalshi, Polymarket, and Nemotron Nano Omni
(vision/ASR/subtitles).

## What It Is

Huddle should feel like a live sports media product, not a fantasy admin dashboard.

- The first screen helps a new user create a show: connect fantasy, choose what they are watching, and meet the hosts.
- Pregame mode frames the matchup, host personalities, storylines, and players to watch.
- Live mode prioritizes the broadcast or, when no stream is attached, a radio-style moment hero with player/team media and host conversation.
- Postgame mode turns the session into a shareable recap.
- Technical provider health and diagnostics are available, but they should stay out of the main show experience.

## Current Reality

Works now:

- Multi-host live show with three personas (Maya, Theo, Cam), each
  with separate voices and persona prompts.
- Demo fantasy league and scripted NFL plays; ESPN Fantasy adapter
  for public + cookie-auth private leagues; Sleeper read path.
- ESPN scoreboard adapter for NFL/NBA/MLB/NHL/WNBA/NCAA.
- YouTube embed for legal live URLs; screen-share flow for ESPN,
  YouTube TV, cable apps, and other authenticated/DRM surfaces.
- OpenAI / Anthropic / Gemini commentary provider chain with local
  fallback; per-provider timeout + budget cap.
- Nemotron Nano Omni for vision (`POST /api/vision/observe`), ASR
  (`POST /api/asr/transcribe`), and clip subtitles
  (`POST /api/clip/subtitles`).
- "Nemotron sees" panel surfaces what the vision model is observing.
- Push-to-talk **Cue host** button: ASR-transcribed listener cues
  ride into the next host turn via the WebSocket.
- Live Kalshi + Polymarket markets ticker next to the score bug,
  refreshed every 8s. Swing detector fires "warming/cooling" leads
  when a market moves >5¢.
- Sportradar / SportsDataIO adapters as paid live-data backups.
- ElevenLabs WebSocket TTS with per-host voice routing.
- Mock/local model + TTS fallbacks; media cache for team/player art.
- Clip archiving to Vercel Blob with parallel WebVTT subtitle
  generation, downloadable from the share card.
- Yahoo OAuth scaffold; show history persisted to Upstash Redis.
- 340+ unit/integration tests covering providers, engine, route
  handlers, WebSocket protocol, and view-model helpers.

Not production-ready yet:

- WebSocket transport for the live show — fine for local dev and
  any host that supports long-lived connections (Render, Fly,
  Railway), but Vercel deploys need the in-progress SSE migration.
- Production auth/accounts.
- Broadcast redistribution or any DRM bypass. The app only accepts
  user-provided / permitted sources.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

For the cleanest no-key demo:

1. Click `Create show +`.
2. Start the demo show.
3. Leave stream empty to test the live audio/no-stream experience.
4. Use `Stream` or setup controls to add a permitted URL or screen share.

The dev command starts both:

- Next.js on `http://localhost:3000` (App Router + Turbopack).
- Fastify on `http://localhost:8787` for the long-running show
  WebSocket and any unmigrated `/api/*` routes. The Next.js config
  rewrites `/api/*` and `/ws/*` to Fastify during the migration; as
  each route ports to a Route Handler (see `src/app/api/*`), its
  rewrite entry comes out of `next.config.ts`.

Verify the Nemotron endpoint (hosted catalog or local NIM) with:

```bash
npm run verify:nemotron
```

See `docs/nim-on-prem.md` for the on-prem NIM cutover.

## Deploying to Vercel

The app is configured for one-click Vercel deploys via `vercel.json`.
Every demo-critical surface (live show via SSE, vision, ASR,
subtitles, markets, clip storage) runs as a Next.js Route Handler
under `src/app/api/`. The legacy Fastify server is **only** needed
for local dev — it does not deploy.

```bash
npm i -g vercel
vercel link            # link to a project (or 'vercel' to create one)
vercel env pull .env.local   # populate local env from Vercel
vercel deploy          # preview deploy
vercel deploy --prod   # production
```

### Provisioning storage

The clip-share flow needs Vercel Blob in production (filesystem-
backed `FileClipStore` only works locally — Vercel Functions have
read-only / ephemeral filesystems). Vercel Blob is a first-party
product enabled from the dashboard, not the marketplace `integration
add` command:

1. Open https://vercel.com/dashboard/stores → **Create Database** →
   **Blob**.
2. Connect the store to this project.
3. `vercel env pull .env.local --yes` to grab the auto-provisioned
   `BLOB_READ_WRITE_TOKEN`.

When `BLOB_READ_WRITE_TOKEN` is set, two paths activate
automatically — no code change:

- **`getDefaultClipStore()`** swaps from `FileClipStore` to
  `BlobClipStore` (server-side upload, used by the legacy
  `/api/clips` POST and any internal callers).
- **`/api/clips/upload-token`** mints short-lived signed tokens so
  the browser can upload directly to the Blob CDN via
  `@vercel/blob/client`'s `upload()`. The client tries this path
  first (bypasses the ~4.5 MB Function body cap on Vercel) and
  falls back to the server POST when the token route returns 404
  (e.g. local dev without the token set).

### Function configuration (`vercel.json`)

`src/app/api/live/stream/route.ts` is the SSE endpoint — it holds
the response open for the lifetime of the show. Capped at **300s**
to stay within the Hobby plan limit; client `EventSource` auto-
reconnects past that and a fresh session starts via
`POST /api/live/start`. Pro/Enterprise can bump to 800s.

Other long-running routes (vision/ASR/subtitles) are configured at
60–90s — generous enough that a single Nemotron call has slack
without leaving idle Functions billable.

### Known limitations on Vercel

- **In-process session store.** `showSessionStore.ts` keeps active
  `ShowEngine` instances in a module-level `Map`. Works under low
  traffic when Vercel pins repeat requests to the same instance;
  multi-instance traffic could land cue/frame POSTs on the wrong
  instance. Multi-instance correctness requires either Redis-
  backing the session state or pulling the engine onto a separate
  long-lived host (Render/Fly). See showSessionStore.ts docstring.
- **Fastify-only routes.** `/api/health`, `/api/model-stack`,
  `/api/diagnostics`, `/api/history/shows` haven't been ported. They
  fail silently on Vercel; the UI surfaces that consume them are
  diagnostics-only and degrade cleanly.
- **WebSocket (`/ws/livecast`).** Doesn't deploy. The client uses
  the SSE path on Vercel; the WS path is local-dev only.

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
