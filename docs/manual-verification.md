# Manual Verification — Golden Path

The automated suites (`npm test`, `npm run test:providers`) cover the
data plane — route handlers, providers, engine logic, prompt
assembly, WebVTT formatting. They do **not** cover anything that
needs a browser: mic / camera permissions, audio playback, the
`MediaRecorder` capture pipeline, real EventSource behavior, or the
visual flash on the markets ticker.

Walk this checklist before any deploy or live demo. Time budget:
~7 minutes if everything is green; longer when something needs a
fix.

## Pre-flight

```bash
npm run test                  # 360+ unit + integration tests
npm run test:providers        # opt-in real-API smoke (needs keys in .env.local)
npm run test:browser          # Playwright golden-path + video-stage specs
npm run verify:nemotron       # one-shot Nemotron endpoint ping
npm run build                 # production build green
npm run dev                   # start Next.js + Fastify together
```

Confirm:

- [ ] All four test commands exit 0.
- [ ] `npm run dev` shows `Next.js Local: http://localhost:3000` and
      `Server listening at http://127.0.0.1:8787`.
- [ ] `curl -s 'http://localhost:3000/api/markets?sport=nfl' | jq '.count'`
      returns a positive integer (real Kalshi + Polymarket data).
- [ ] `curl -s -X POST http://localhost:3000/api/vision/observe -H "content-type: application/json" -d '{"frame":{"id":"x","capturedAt":"2026-05-10T20:00:00Z","source":"screen-share","width":1,"height":1,"dataUrl":"data:image/jpeg;base64,QUJD"}}' | jq '.observation.id'`
      returns a UUID.

### Production-mode smoke (proves the Vercel-shaped bundle works)

Vercel does **not** run our Fastify process — it only runs the
Next.js Route Handlers. To verify the bundle works without Fastify
backing it, run prod-mode locally:

```bash
npm run build && npm run start   # NODE_ENV=production, no Fastify
```

Confirm in a second terminal:

- [ ] `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/`
      returns `200`.
- [ ] `curl -s -o /dev/null -w "%{http_code}\n" 'http://localhost:3000/api/markets?sport=nfl'`
      returns `200`.
- [ ] `curl -s -N -X POST -H 'content-type: application/json' -d '{"providerMode":"demo","sportsDataMode":"demo","sportsGameId":"demo-kc-det","group":{"listener":{"name":"Alex","rosterId":"r"},"tone":"pg","homeTeamBias":"fantasy-first","friends":[{"id":"f1","name":"Sam","favoriteTeam":"DET"}]},"video":{"mode":"stream-url","url":""},"ttsEnabled":false,"cadenceMs":3000}' http://localhost:3000/api/live/stream | head -c 400`
      streams SSE; the first non-preamble event is `event: session-ready` carrying a `sessionId`.
- [ ] `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health`
      returns `404` — legacy Fastify-only diagnostics intentionally
      do not exist on Vercel, and `next start` is configured to skip
      the dev rewrite that proxies to localhost:8787.
- [ ] Archive + read a clip:
      ```bash
      B64=$(printf 'real-audio-bytes' | base64)
      curl -s -X POST -H 'content-type: application/json' \
        -d "{\"listenerId\":\"01234567-89ab-cdef-0123-456789abcdef\",\"mimeType\":\"audio/wav\",\"audioBase64\":\"$B64\"}" \
        http://localhost:3000/api/clips
      # → { id, url, mimeType, byteLength }
      curl -s -o /tmp/clip.bin "http://localhost:3000$URL_FROM_ABOVE"
      ```
      `/tmp/clip.bin` matches the bytes you posted (file-store path).
      On Vercel with `BLOB_READ_WRITE_TOKEN` set, the POST returns a
      Blob CDN url instead and `/api/clips/[id]` 404s (clients use
      `metadata.url` directly).

## Browser walkthrough

Open `http://localhost:3000` in Chrome (Safari and Firefox also OK,
but Chrome is where `getDisplayMedia` + `MediaRecorder` are most
reliable).

### Discover → start

- [ ] The discover view renders without console errors.
- [ ] Picking a demo game advances to the pregame view.
- [ ] Pregame rail shows: Matchup card, Vegas line card (if
      `THE_ODDS_API_KEY` set), **"What the markets say"** card
      with 1–4 prediction-market rows.
- [ ] Click "Start demo show" — within ~3 seconds the page advances
      to live and the opener commentary appears.

### Live show — visual surfaces

- [ ] **Score bug** updates with current scores + game clock.
- [ ] **Markets ticker** sits next to the score bug; rows show
      Kalshi / Polymarket pills + cents prices.
- [ ] **"Nemotron sees"** panel appears on the rail with a green
      pulsing dot, validation status, confidence %, and an evidence
      bullet or two.
- [ ] Host turns scroll into the conversation panel every ~5s.

### Cue host (push-to-talk)

- [ ] **Cue host** button is visible under the live host strip.
- [ ] Hold the button → browser prompts for microphone permission.
      Grant it.
- [ ] The button shows "Listening…" while held; release after 2–3s.
- [ ] Status pill shows "Transcribing…" then briefly
      "Cue sent: <your transcript>".
- [ ] Within the next host turn the persona references your cue.
- [ ] Status pill updates to "Cue answered: <id>".

### Markets-aware flash (when active markets exist)

- [ ] Wait through 2–3 ticks. If a real market moves ≥5¢, the matching
      row in the markets ticker flashes gold for ~4.5s in sync with
      the host call. The status pill mirrors:
      "<Outcome> ▲ X¢ on Kalshi/Polymarket".
- [ ] **If no swing fires**: this is expected when markets are flat or
      the sport is offseason. Not a bug.

### Audio playback (if `ELEVENLABS_API_KEY` set)

- [ ] Audio plays through speakers without crackling.
- [ ] Waveform animates in sync with playback.
- [ ] No console errors related to AudioContext.

### Recap → share with captions

- [ ] Click "Stop show". Recap view renders.
- [ ] The "Moment of the show" card has a **Share moment** button.
- [ ] Click it. Within ~1s the action row shows "Generating
      captions…" then "Download captions (.vtt)".
- [ ] Click the captions link. A `.vtt` file downloads with the
      `WEBVTT\n\n` header and at least one cue if any TTS audio was
      captured.

### Teardown

- [ ] Reload the page or click Stop. The SSE EventSource closes;
      the Next.js terminal shows `live.stream.cancelled` for the
      session (the engine listens for the AbortController on the SSE
      route).
- [ ] Close the tab. No orphaned `Server listening` warnings, no
      runaway ticks in either terminal. The in-process session store
      grace-times the engine after ~5s of detachment.

## Vercel deploy verification

**Live production URL:** https://huddle-radio.vercel.app

For a quick one-shot verification of the live deploy after any
push to main, run:

```bash
node scripts/probeLiveDemo.mjs                          # default URL
node scripts/probeLiveDemo.mjs https://your-preview.vercel.app
```

The probe drives the same golden-path flow the local Playwright
spec covers but against the deployed URL — visit, start a sample
show, confirm host turns scroll in, confirm Cue button mounts.
Exits non-zero on any check failure so it's CI-friendly.

For deeper manual checks (markets count, clip round-trip, etc.):

- [ ] `curl -s -o /dev/null -w "%{http_code}\n" <preview-url>/`
      returns `200`.
- [ ] `curl -s '<preview-url>/api/markets?sport=nfl' | jq '.count'`
      returns a positive integer.
- [ ] `curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'content-type: application/json' -d '{}' <preview-url>/api/clips/upload-token`
      returns `404` if `BLOB_READ_WRITE_TOKEN` is unset (intentional
      — client falls back to legacy POST). `200` once Blob is
      provisioned via the dashboard Storage tab.
- [ ] Open `<preview-url>/`, click "Listen to a sample" — within ~5s
      the live UI mounts and host turns scroll in. The SSE
      handshake works through Vercel's edge.
- [ ] Vercel Functions log (Dashboard → Functions tab) shows
      `live.start.ok` then `live.stream.attached` events with the
      same sessionId. No ECONNREFUSED. No `localhost:8787` references.

## Common failure modes to look for

- **Console errors about `window is not defined`** → SSR bug, likely
  in a new `useState` initializer that touches `window`.
- **`POST /api/live/stream` returns 4xx** → request shape doesn't match
  the LivecastRequestSchema. The 400 body's `error` field tells you
  which field failed. The stream itself can't fail mid-handshake on
  the client side anymore — the engine is created on the same
  instance that answers the POST, so cross-instance routing is
  impossible by construction.
- **Routes 500 with ECONNREFUSED on `npm run start`** → the dev-only
  rewrite to localhost:8787 is firing in production mode. Check that
  `next.config.ts`'s `REWRITE_TO_FASTIFY` guard reads
  `process.env.NODE_ENV !== "production"`. `next start` sets
  NODE_ENV=production automatically.
- **Routes 500 with ERR_REQUIRE_ESM on Vercel** → the build is using
  Turbopack instead of webpack. The build script *must* read
  `next build --webpack`. Turbopack's NFT drags our outer
  package.json (type:module) into Function bundles for routes with
  non-trivial import graphs, and Vercel's `___next_launcher.cjs`
  refuses the `require()` of an ESM-scoped route.js. Webpack's NFT
  doesn't trip this.
- **Mic prompt never appears** → either the browser blocked permissions
  globally, or `getUserMedia` threw silently. Check DevTools console.
- **Markets ticker never appears** → either `/api/markets?sport=<x>`
  returned an empty array (offseason; expected), or no markets match
  the team names (heuristic miss).
- **Captions download is empty / WEBVTT-only** → no `NEMOTRON_API_KEY`
  is set, so ASR returned an empty transcript. Expected without the
  key.

## When something breaks

Add a regression test in `src/test/` that would have caught it,
**then** fix the bug. The data plane is well-covered now (~360 tests);
the gap is in browser-level behavior. Each manual finding is a
candidate for a new Playwright spec.
