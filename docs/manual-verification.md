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
npm run verify:nemotron       # one-shot Nemotron endpoint ping
npm run build                 # production build green
npm run dev                   # start Next.js + Fastify
```

Confirm:

- [ ] All three test commands exit 0.
- [ ] `npm run dev` shows `Next.js Local: http://localhost:3000` and
      `Server listening at http://127.0.0.1:8787`.
- [ ] `curl -s http://localhost:3000/api/markets?sport=nfl | jq '.count'`
      returns a positive integer (real Kalshi + Polymarket data).
- [ ] `curl -s -X POST http://localhost:3000/api/vision/observe -H "content-type: application/json" -d '{"frame":{"id":"x","capturedAt":"2026-05-10T20:00:00Z","source":"screen-share","width":1,"height":1,"dataUrl":"data:image/jpeg;base64,QUJD"}}' | jq '.observation.id'`
      returns a UUID.

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

- [ ] Reload the page or click Stop. The SSE connection closes;
      `localhost:8787` log shows `live.stream.cancelled` for the
      session.
- [ ] Close the tab. No orphaned `Server listening` warnings, no
      runaway ticks in either terminal.

## Common failure modes to look for

- **Console errors about `window is not defined`** → SSR bug, likely
  in a new `useState` initializer that touches `window`.
- **EventSource immediately closes with no events** → check
  `/api/live/start` returned a sessionId; if 400/404, request shape
  doesn't match the LivecastRequestSchema.
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
