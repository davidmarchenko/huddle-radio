# Vendor Resilience & Data Gaps — Work Plan

This is the implementation plan for hardening Huddle Radio's vendor dependencies and closing the data gaps that limit personalization quality. It is the working document for the items raised in the May 2026 vendor audit.

For broader context see `architecture.md` (component layout) and `providers.md` (current provider list). For pre-MVP improvements already shipped see `painpoints-and-improvements.md`.

---

## 1. Current vendor surface

| Vendor | Endpoint | Used for | Auth | Backup today |
| --- | --- | --- | --- | --- |
| OpenAI | `api.openai.com` (Responses + Vision) | Commentary text **and** video frame validation | `OPENAI_API_KEY` | `LocalCommentaryProvider` (templated text). No vision fallback. |
| ElevenLabs | `wss://api.elevenlabs.io/v1/text-to-speech` | Streaming TTS for all hosts | `ELEVENLABS_API_KEY` | `MockTTSProvider` (metadata only — silent). Browser TTS exists but isn't wired into the live show. |
| ESPN scoreboard (unofficial) | `site.api.espn.com/apis/site/v2/sports/<sport>/scoreboard` | All live game state and play-by-play, 7 sports | None | `DemoSportsDataProvider` only. |
| ESPN Fantasy (unofficial) | `lm-api-reads.fantasy.espn.com/apis/v3/games/ffl` | ESPN league rosters | `ESPN_SWID` + `ESPN_S2` cookies for private leagues | None — connection failure blocks the user. |
| Sleeper | `api.sleeper.app/v1` | Sleeper league rosters | None (public read-only) | None. |

**Stubbed but unused** (env vars exist, no provider class):
- `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` — Yahoo Fantasy.
- `SPORTRADAR_API_KEY` — paid live data.
- `SPORTSDATAIO_API_KEY` — paid live data.
- `FAL_KEY` — image generation.
- `NEMOTRON_ENDPOINT` / `NEMOTRON_API_KEY` — present in the `MODEL_PROVIDER` enum but no class exists.

---

## 2. Risk inventory

### Single-points-of-failure
- **OpenAI is doubly load-bearing.** Commentary text + vision validation share one vendor and one key. An OpenAI outage degrades both layers simultaneously.
- **ESPN scoreboard is the only live-data source.** Unofficial endpoint that ESPN may break without notice. No paid backup.
- **ElevenLabs is the only voice path with audio.** `MockTTSProvider` is metadata-only. A real outage means a literally silent show.

### Latent correctness bugs
- **Cross-provider player ID drift.** Sleeper IDs ≠ ESPN scoreboard IDs ≠ ESPN Fantasy IDs. The "On your lineup" eyebrow matches `play.playerIds[]` against `roster.starters[].id`, which works in demo because we control both sides. The moment a real ESPN/Sleeper league is connected with real ESPN scoreboard plays, that match silently fails.
- **`statusName` for unknown ESPN states** falls through to `"scheduled"` — most edge states are now caught by the postponed mapping but novel states still bucket as Upcoming.

### Cost/scale exposure
- Per-play commentary = 1 OpenAI Responses call. At 5s cadence × 60-min show = **~720 OpenAI calls per show, per concurrent listener.** No usage cap, no rate limit guard, no caching of identical play descriptions.
- Per-host voices triple the ElevenLabs WebSocket sessions per show.
- Vision validation runs every captured frame.
- `/api/sports/games` hits ESPN per-request with no edge cache. One viral moment → ESPN rate-limits us.

### Data gaps blocking richer personalization
Documented per-workstream below.

---

## 3. Workstream catalog

Each workstream has:
- **Goal** — what the user-visible / operational outcome is
- **Scope** — concrete code changes
- **Effort** — S (≤1 day), M (≤1 week), L (≤2 weeks), XL (≥2 weeks)
- **Depends on** — which earlier workstream(s) must land first
- **Open questions** — things to resolve before / during

---

### W1 — Cross-provider player ID resolver — **shipped (2026-05-09)**

**Goal:** Listener-roster personalization works against real Sleeper and ESPN data, not only demo. Fixes the latent bug where `playerIds[]` from ESPN scoreboard plays don't match `roster.starters[].id` from a Sleeper roster.

**Shipped:** `src/server/playerIdResolver.ts` with seed `src/server/data/playerIdMap.json` (refresh via `npm run build-player-ids`). ESPN scoreboard now extracts `lastPlay.athletesInvolved[].id` and resolves to canonical Sleeper-namespace IDs. ESPN Fantasy player IDs resolve at roster normalization. Sleeper passes through (its IDs are canonical). Diagnostics: `/api/diagnostics/player-ids` and a boot log of registered count. Sport keying prevents cross-sport collisions.

**Scope:**
- New `src/server/playerIdResolver.ts` (or `shared/`) with a static lookup table mapping `{ provider, externalId } → canonicalId`. Bootstrap from a JSON file shipped with the repo (e.g. NFL active rosters). Refresh on a cron later.
- `EspnSportsDataProvider.normalizePlay()` writes canonical IDs into `play.playerIds` instead of ESPN-native IDs.
- `SleeperFantasyProvider` and `EspnFantasyProvider` write canonical IDs into roster `starters[].id` and `bench[].id`.
- Cache layer keyed by sport so resolution is O(1).
- Telemetry: log a counter when a resolution miss happens (helps build the table over time).

**Effort:** M (lookup table is the bulk; integration is a few touches per provider).

**Depends on:** Nothing. Critical to land first because every other workstream is downstream of correctness here.

**Open questions:**
- Source of truth for the bootstrap mapping? Sleeper publishes a free `players/nfl` endpoint that includes ESPN IDs. Could be the spine.
- How aggressively to refresh? NFL roster moves week-to-week.
- Do we need a per-sport resolver, or one global table with `(sport, externalId)`?

---

### W2 — Multi-LLM commentary fallback — **shipped (2026-05-09)**

**Shipped:** `CommentaryProviderChain` (`src/providers/commentaryProviderChain.ts`) wraps an ordered list of providers with a per-provider timeout (default 8s), advances on error/timeout, surfaces fallback hits via `getFallbackStats()`. New providers `AnthropicCommentaryProvider` (Messages API) and `GeminiCommentaryProvider` (generateContent) consume the same `CommentaryDraftInput` and reuse the persona prompts so vendor-specific tuning isn't needed. Persona/payload code extracted into `src/providers/commentaryPrompts.ts` for share. Factory: `createCommentaryProvider()` only adds vendors whose env keys are present, so the no-fallback default is unchanged. New env vars: `ANTHROPIC_API_KEY`, `ANTHROPIC_COMMENTARY_MODEL`, `GOOGLE_API_KEY`, `GEMINI_COMMENTARY_MODEL`, `COMMENTARY_PROVIDER_TIMEOUT_MS` (all optional). Hardened the credential-leak scrub regex to also catch `"api key"` with whitespace.

(Original plan below.)

### W2 — Multi-LLM commentary fallback

**Scope:**
- Define a thin `CommentaryProvider` chain: `[OpenAI → Anthropic → Gemini → Local]`. Each tries in order with a short timeout (~3s) and returns the first success.
- Add `AnthropicCommentaryProvider` (Messages API) and `GeminiCommentaryProvider` (generateContent). Both consume the same `CommentaryDraftInput` and produce the same `string` output, so the persona/opener prompts work unchanged.
- New env vars: `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`. Optional. Provider only activates when the key is present.
- Health surface: each provider reports its own status; the chain reports the highest-tier provider that's `ready`.
- Metric: count fallback hits per provider so we know if OpenAI is degrading.

**Effort:** M (each provider is one class; chaining logic is small).

**Depends on:** Nothing.

**Open questions:**
- Do we keep OpenAI as primary, or A/B by host? Maya's analytical voice might land better with Claude; Cam's hot takes might suit Gemini. Worth experimenting once both providers are live.
- Should the chain also apply to vision validation? OpenAI vision is loadbearing — an Anthropic vision fallback would close that gap too.

---

### W3 — Vegas lines / odds integration — **shipped (2026-05-09)**

**Shipped:** `OddsApiProvider` (`src/providers/oddsApiProvider.ts`) hits The Odds API and parses spread/total/moneyline. New `GameOdds` type in `contracts.ts`. New endpoint `GET /api/odds?gameId&sport&homeTeam&awayTeam`. Factory `createOddsProvider()` returns a no-op when `THE_ODDS_API_KEY` is unset. Pregame UI gets an `OddsCard` (token-disciplined CSS) showing line/total/moneyline. Commentary payload extended with `odds`; play-prompt instructs personas to cite the line at most once and never make a betting recommendation. WebSocket handler fetches odds once at show-start and threads through both opener and per-tick commentary.

(Original plan below.)

### W3 — Vegas lines / odds integration

**Goal:** Pregame and live commentary cite real spreads, totals, and movement. Free, additive, makes every show meaningfully richer with no vendor risk (multiple free providers).

**Scope:**
- New `src/providers/oddsProvider.ts` interface + `OddsApiProvider` implementation (`api.the-odds-api.com` free tier, 500 req/mo per key).
- New endpoint `GET /api/odds?gameId=...` that resolves spread, total, moneyline, and movement-since-open for a game.
- Pregame: extend `NewsStorylineCard` (or add a sibling `OddsCard`) showing line + total + which way the line moved.
- LLM payload: include `odds` field in `CommentaryDraftInput` so the persona prompts can reference it ("Maya: at -3.5, this is exactly the script your QB needed").
- Live: surface a small "Live line" pill in the live audio header showing in-game spread movement (provider supports live).

**Effort:** M.

**Depends on:** Nothing — odds keys aren't tied to other vendors.

**Open questions:**
- Free tier is 500 req/mo. Need caching (W7) before this scales to real users.
- Different odds providers have wildly different live/in-game support; pick one before building.

---

### W4 — Real news / injury feed — **shipped (2026-05-09)**

**Shipped:** `EspnNewsProvider` (`src/providers/espnNewsProvider.ts`) reads `site.api.espn.com/apis/site/v2/sports/<path>/news`, filters items by team/player from the article `categories[]`, sorts newest-first. Wrapped in a `NewsProviderChain` with `DemoNewsProvider` as terminal fallback so a transient ESPN failure can't break the pregame card. Default mode `NEWS_PROVIDER=auto` activates the chain; `demo` keeps the old behavior. Player IDs from the article match against the canonical IDs from W1, so the same listener-roster filtering used for plays now works for news.

(Original plan below.)

### W4 — Real news / injury feed

**Goal:** Replace the demo storyline placeholders with actual beat-writer copy and injury reports. Pregame stops feeling scripted; live commentary can cite real context.

**Scope:**
- New `RealNewsProvider` implementation behind the existing `NewsProvider` interface. Two viable sources to pick from:
  - **ESPN news API** (unofficial, free): `site.api.espn.com/apis/site/v2/sports/<sport>/news`. Same risk profile as the scoreboard endpoint but proven-stable.
  - **Aggregated RSS** (Athletic / Rotoworld / FantasyPros): more sources, more parsing pain, potentially more legal complexity.
- `getLatest({ playerIds, teams, sport })` filters items where `categories[].team.id` or `headlines[].related[].player.id` match.
- Inject into the existing `/api/news/storylines` endpoint — `DemoNewsProvider` becomes the test/no-network fallback.
- Cap items per request, sort by `published` desc, dedupe by URL.

**Effort:** M.

**Depends on:** Nothing functional, but **W1** is needed if we want to filter news strictly to listener starters with cross-provider IDs.

**Open questions:**
- ESPN news vs RSS aggregator? ESPN keeps us in one vendor tree; RSS spreads risk but adds parsing surface.
- Caching TTL — news doesn't move every second, 5–10 min cache is probably fine.

---

### W5 — Yahoo Fantasy provider

**Goal:** Unblock the largest unsupported fantasy platform. Yahoo Fantasy is roughly a third of the U.S. market and entirely missing today.

**Scope:**
- OAuth 2.0 flow. New routes:
  - `GET /api/fantasy/yahoo/auth-url` returns the consent URL.
  - `GET /api/fantasy/yahoo/callback` exchanges code for tokens, stores per-user.
  - `POST /api/fantasy/yahoo/refresh` for token refresh.
- New `YahooFantasyProvider` implementing `FantasyProvider`. Uses `fantasysports.yahooapis.com/fantasy/v2/...`.
- Token storage: localStorage-only is acceptable for now; backend storage is a W8 prereq.
- Profile modal: add Yahoo as a provider option alongside Sleeper / ESPN.

**Effort:** L. OAuth 2.0 redirect flow, token refresh, XML response parsing (Yahoo's API is XML-first), and rate-limiting all add up.

**Depends on:** Nothing technically, but **W8** (listener history backend) makes the per-user token storage cleaner.

**Open questions:**
- Yahoo requires HTTPS callback URLs even for local dev. Document a tunnel (ngrok / cloudflared) for testing.
- How long are tokens valid, and how do we handle re-auth gracefully mid-show?

---

### W6 — Multi-LLM vision fallback (paired with W2) — **shipped (2026-05-09)**

**Shipped:** Shared vision payload / parser / validator extracted to `src/providers/visionShared.ts`. New `AnthropicVisionModelProvider` (Messages API with base64 inline image) and `GeminiVisionModelProvider` (generateContent with `inline_data`). Wrapped in `VisionModelProviderChain` that treats both `unavailable` results and thrown errors as soft fails and advances. `MockModelProvider` is the never-throws terminal. Same `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` used by W2 also activate the vision fallback when set.

(Original plan below.)

### W6 — Multi-LLM vision fallback (paired with W2)

**Goal:** Same as W2 but for the vision/observation layer. Removes OpenAI single-point-of-failure for video frame validation.

**Scope:**
- Add `AnthropicVisionModelProvider` (Messages API supports image inputs) and/or `GeminiVisionModelProvider`.
- Chain into the existing `MODEL_PROVIDER` enum: `["mock", "openai-vision", "anthropic-vision", "gemini-vision", "nemotron"]`.
- Implement Nemotron path while we're in there (env vars exist; no class).
- Same chained-fallback pattern as W2: try primary, fall back on timeout/error, mock as last resort.

**Effort:** M.

**Depends on:** **W2** — share the same provider-chain abstraction.

---

### W7 — Edge cache for `/api/sports/games` — **shipped (2026-05-09)**

**Shipped:** `src/server/sportsGamesCache.ts` — per-sport in-memory cache with 30s fresh TTL + 120s stale-while-revalidate, in-flight request coalescing so a thundering herd never produces more than one ESPN call per sport. Per-sport keying means a transient WNBA failure does not poison NFL. `Cache-Control: public, max-age=30, stale-while-revalidate=120` on the response so a CDN or browser layer also caches. Diagnostics: `/api/diagnostics/sports-cache`.

(Original plan below.)

### W7 — Edge cache for `/api/sports/games`

**Goal:** Decouple our user count from our ESPN request count. Today every client GET hits ESPN directly through our server.

**Scope:**
- Server-side response cache keyed by `(sportsDataMode, day-of-window)`. 30-second TTL is enough for live-feel without flooding ESPN.
- Cache the `failedSports` field separately so a transient 1-sport failure doesn't poison the cache for all sports.
- Optionally serve stale-while-revalidate so a brief ESPN blip doesn't surface to users.
- When deployed: add `Cache-Control: public, max-age=30, stale-while-revalidate=120` header so a CDN or Vercel edge can also cache.

**Effort:** S.

**Depends on:** Nothing.

**Open questions:**
- Per-sport TTL or global? MLB live games change scores faster than NFL pregame.
- Where does the cache live in practice? In-memory works for one Fastify instance; multi-instance deploy needs Redis/etc.

---

### W8 — Listener-history backend

**Goal:** Move past-shows + memory off localStorage so it survives device switches, supports sharing, and feeds smarter cross-show callbacks.

**Scope:**
- Lightweight key-value backend (Postgres + a `shows` table is fine; SQLite for dev). Owner = listener identity (anonymous UUID until accounts exist).
- New endpoints:
  - `POST /api/history/shows` — archive a finished show.
  - `GET /api/history/shows?listenerId=...&limit=...` — paginated history.
  - `DELETE /api/history/shows/:id` — privacy.
- Client `pastShows` reads from the backend on app boot, falls back to localStorage when offline.
- New `priorContext` resolver in the server uses cross-device history to pick the best opener callback (currently single-device only).

**Effort:** L. Real data layer + auth boundaries + migration from localStorage.

**Depends on:** Nothing functional, but unlocks W5 (per-user Yahoo token storage), W9 (clip sharing needs backend storage), W10 (multi-listener watch parties need session identity).

**Open questions:**
- Listener identity — anonymous UUID is enough to start, but do we need real accounts (email magic link / OAuth) before W5 ships?
- Privacy / retention policy. How long do we keep show transcripts?

---

### W9 — Clip / show audio archival

**Goal:** "Share moment" today copies a text blurb. Archive actual TTS audio so the Web Share / clipboard payload links to a real 20-second audio clip.

**Scope:**
- Capture the streamed audio chunks per turn into an in-memory buffer keyed by commentary ID.
- On show end (or on user request), persist the listener's chosen turn(s) as MP3 blobs to S3-compatible storage.
- New endpoint: `POST /api/clips` returns a public short-link.
- Update `ListenerHighlightCard` share blurb to include the link.
- Optional: pre-generate a "show summary" 60-second composite so the recap page can offer "Hear the show in 60 seconds."

**Effort:** L. Audio buffering, storage, signed URLs, retention policy.

**Depends on:** **W8** (listener history) for ownership, **W2/W6** (resilient providers) so a degraded show doesn't archive empty audio.

**Open questions:**
- Audio rights — ElevenLabs ToS allows distribution but we should confirm at clip-share scale.
- Storage cost at scale; need cleanup policy.

---

### W10 — Sportradar / SportsDataIO paid live-data backup

**Goal:** Eliminate the ESPN-unofficial single point of failure for live game data. Only worth doing once production traffic justifies the bill (Sportradar starts ~$1k/mo).

**Scope:**
- New `SportradarSportsDataProvider` and/or `SportsDataIoProvider` implementing `SportsDataProvider`.
- Chain alongside ESPN in `createSportsDataProvider`: try paid → fall back to ESPN → fall back to demo.
- Reuse the player-ID resolver from **W1** for canonical IDs.

**Effort:** M (per provider) but real cost lives in the contract negotiation.

**Depends on:** **W1** (ID resolver) — without canonical IDs, swapping providers breaks personalization.

**Open questions:**
- Pick one. Paying both is wasteful.
- Do we need real-time NFL / NBA, or is the cheaper "delayed" feed enough? Live-feel suffers above ~5s latency.

---

### W11 — Cost guards and observability — **shipped (2026-05-09, partial)**

**Shipped:**
- `src/server/metrics.ts` central registry with counters (`showsStarted`, `showsCompleted`, `commentaryRequests`, `ttsRequests`, `webSocketsOpened`, `webSocketsClosed`) and chain registration so the commentary / news / vision fallback hits roll up.
- `/api/metrics` endpoint serializes the snapshot: counters, uptime, player-id resolver stats, sports-cache stats, per-chain fallback counts.
- `ShowUsageBudget` per-WebSocket budget. Tracks commentary character count (≈ tokens/4) and TTS character count. When either cap is exceeded, a per-show shim swaps the active provider to `LocalCommentaryProvider` / `MockTTSProvider` so a runaway show finishes without burning vendor budget. Defaults: 200K tokens / 60K TTS chars per show.
- WebSocket open/close + show-start counters wired through `incrementCounter()`.

**Deferred:** Per-IP rate limit on `/api/sports/games` and `/ws/livecast` (handle with `@fastify/rate-limit` plugin in a follow-up). Alerting webhooks (Slack / PagerDuty) — needs a chosen target.

(Original plan below.)

### W11 — Cost guards and observability

**Goal:** Know what shows cost, catch runaway loops, and rate-limit by listener.

**Scope:**
- Per-listener token counter per show. Hard cap (e.g. 50K tokens / show) → degrade to `LocalCommentaryProvider` rather than burn budget.
- Per-listener TTS minute counter with a similar cap.
- Per-IP rate limit on `/api/sports/games` and `/ws/livecast` open.
- Prometheus-style metrics endpoint surfacing: shows started, tokens consumed, TTS minutes, ESPN failure rate, provider fallback hits, cache hit rate.
- Alerting hook (PagerDuty / Slack webhook) when ESPN failure rate exceeds threshold.

**Effort:** M.

**Depends on:** **W2/W6/W10** for fallback paths to actually be usable when we hit caps.

---

### W12 — Advanced stats integration (DVOA / EPA / target share)

**Goal:** Beat-writer-grade analytics in commentary. Maya's analyst voice is currently constrained by what `play.score` and `currentPoints` give us — adding EPA, DVOA, target share, snap counts unlocks her actual persona.

**Scope:**
- Identify a feed: nflfastR/Football Outsiders public endpoints, ESPN's stats API, or paid providers (Sportradar advanced stats).
- New `AdvancedStatsProvider` interface: `getPlayerSeason(playerId, sport)` → snap counts, target share, EPA, etc.
- LLM payload: include in `CommentaryDraftInput` as an optional `analytics` field.
- UI: optional small advanced-stats badge on the listener stakes card.

**Effort:** L. Data wrangling is the long tail.

**Depends on:** **W1** (canonical IDs to map stats back to fantasy rosters).

---

## 4. Sequencing

The dependency graph determines order more than priority does. Suggested phases:

### Phase 1 — Correctness foundation (do first, can run in parallel)
- **W1** — Player ID resolver (unblocks W4, W10, W12).
- **W2** — Multi-LLM commentary fallback.
- **W7** — Edge cache for `/api/sports/games`.

These three are non-blocking on each other and individually small-to-medium. Landing them collapses the highest-severity risks before adding new features.

### Phase 2 — Data richness (after Phase 1)
- **W3** — Vegas lines (additive, no deps).
- **W4** — Real news (uses W1 for accurate filtering).
- **W6** — Multi-LLM vision fallback (extends W2's pattern).
- **W11** — Cost guards / observability (covers W2/W6 paths).

### Phase 3 — Platform expansion
- **W5** — Yahoo Fantasy.
- **W8** — Listener-history backend.
- **W9** — Clip archival (needs W8).

### Phase 4 — Production hardening
- **W10** — Paid live-data backup (only if traffic justifies).
- **W12** — Advanced stats (needs W1).

---

## 5. Out of scope for this plan

Listed for completeness; not work items here:
- DFS slate integration (DraftKings / FanDuel) — different audience, separate product call.
- Live multi-listener watch parties — needs W8 plus presence/socket fan-out infrastructure; treat as a separate epic.
- Native mobile app — the current responsive audit is a separate workstream.
- League chat / message-board surfacing — depends on per-platform OAuth scopes; revisit after W5.

---

## 6. Open product decisions

1. **Backup LLM choice — Anthropic, Google, or both?** Cost/quality tradeoff plus ops surface.
2. **Listener identity model.** Anonymous UUID is fine through W8, but W5 (Yahoo OAuth) and W9 (clip sharing) probably want real accounts. Decide before W5.
3. **Live-data tier.** ESPN-unofficial works for staging and early production. The point at which we move to paid (W10) is a business call, not a technical one — define the trigger metric.
4. **Audio retention policy** for W9 clips. Storage cost grows fast.
5. **Telemetry destination** for W11 metrics — self-hosted Prometheus, Grafana Cloud, Datadog, or just structured logs to start?
