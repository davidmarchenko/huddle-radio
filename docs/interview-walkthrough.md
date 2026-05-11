# Interview Demo Walkthrough — Huddle Radio

**URL to share:** https://huddle-radio.vercel.app
**Interviewer time budget:** 60–90 seconds for the live demo, then questions.

---

## The 30-second pitch (before clicking anything)

> "Huddle Radio is a personalized AI sports producer. It watches the same broadcast you're watching, knows your fantasy roster and your group's banter, and produces a three-host audio show in your ear that talks about *your* matchup, in real time. The headline integration is Nvidia Nemotron Nano Omni — one omni-modal model handles the vision (what's happening on screen), the ASR (your push-to-talk cues), and contributes commentary. The fallback chain pulls in OpenAI for text and ElevenLabs for voice."

---

## The 60–90 second click-through

### 1. Land on the page (5s)
Discover surface explains the product in two lines. Point out the three personas (Maya / Theo / Cam) — that's the producer-team metaphor.

### 2. Click "Listen to a sample" (10s)
Scripted KC vs DET demo show starts. Within ~5 seconds, the first commentary card lands in the rail.

> "I'm running this in mock mode for the demo, but the data path is identical: SSE stream from the live engine, the same prompt builder, the same persona rotation. With keys, this is real Nemotron + ElevenLabs."

### 3. Point out the rail (15s)
Three things to call out:
- **Host conversation** — Maya/Theo/Cam each have a persona. The engine picks who speaks based on a deterministic selector (last-speaker, sport, listener stake). Not random.
- **Nemotron sees panel** *(if visible — appears once a frame lands)* — this is the per-tick vision observation. In mock mode it shows the demo blurb; with the key, Nemotron returns a real frame analysis.
- **Markets ticker** *(scroll if needed — bottom of stage)* — live Kalshi + Polymarket data, updates every couple of seconds. Real prediction-market prices, not mocked.

### 4. Hit "Cue host" (15s)
Hold-to-talk button. With the mic off / faked, mention:
> "When you hold this, your audio goes through Nemotron Nano Omni's ASR — it returns word-level timestamps that we use to render karaoke captions on the shared clip. The transcript gets merged into the next host turn so the AI references what you just said."

### 5. (If time) Open setup → paste a YouTube URL (10s)
The video stage transitions from audio-only to live-with-iframe. The same SSE stream now carries `frame` events back to the server every ~5s — Nemotron observes those frames and that observation feeds the next commentary turn.

---

## Architecture talking points (for follow-up questions)

### "Why Nemotron specifically?"
- **Omni-modal**: one model handles vision + ASR + text → fewer round-trips, lower latency, simpler stack.
- **Nvidia-hosted endpoint**: `integrate.api.nvidia.com/v1` is OpenAI-compatible, so the provider is a drop-in next to OpenAI in our chain.
- **Word-level ASR**: the karaoke-caption story for shared clips depends on it.
- **Self-hostable via NIM**: gives a credible production story for a prediction-market shop or fantasy platform that wants to keep audio off third-party clouds.

### "How does the live show actually run on Vercel?"
- Browser POSTs the `LivecastRequest` to `/api/live/stream` and consumes the SSE response via `fetch` + `ReadableStream`. The same Function instance that answers this POST creates the `ShowEngine` locally — engine and SSE consumer are guaranteed colocated, no cross-instance race. The first event the server emits is `{type:"session-ready", sessionId}` so the client knows what to send to the companion POSTs.
- Push-style state (frames from the screen, ASR cues, host nudges) flows back via `POST /api/live/{frame,cue,nudge}` against that sessionId. SSE response stays open up to 300s (Hobby cap; 800s on Pro).
- A `SessionRegistry` (in-process default; Upstash Redis when configured) lets follow-up POSTs that land on a different Function instance return `410 WRONG_INSTANCE` instead of silently dropping. The client handles 410 by restarting `startLiveSession` against the same `LivecastRequest`.

### "How big is the test surface?"
- 433 vitest tests (route handlers, providers, engine logic, prompt assembly)
- 5 Playwright specs (golden-path + video-stage)
- 7 opt-in real-API smoke tests (Nemotron / OpenAI / ElevenLabs / Kalshi / Polymarket) that run against live vendors when keys are present
- GitHub Actions runs typecheck + tests + build + Playwright on every PR

### "Where would this break at production scale?"
- Engine state lives in process — multi-instance is solved for routing (the registry) but not for engine migration. A real production version moves the engine to a stateful runtime (Cloudflare Durable Objects, Convex, or a long-running worker). The registry interface is the seam.
- Vercel Function maxDuration caps the SSE stream at 300s on Hobby. Browsers auto-reconnect; the client gets a fresh sessionId and the show continues from the engine's restored state.
- TTS quota is the linear cost driver — every commentary turn is a few hundred tokens of audio. ElevenLabs flash_v2_5 is the right pick (latency + cost) but not free.

---

## What the demo is honest about

- Audio playback is mock-mode unless `ELEVENLABS_API_KEY` is set on Vercel.
- Vision observation is mock-mode unless `NEMOTRON_API_KEY` is set.
- Commentary text is local-LLM fallback unless `OPENAI_API_KEY` or `NEMOTRON_API_KEY` is set.
- Markets data is **always real** — Kalshi REST is unauthenticated.
- ESPN / Yahoo / Sleeper integrations work for *your* leagues with your env-set credentials, but the public demo runs the bundled demo league.

To add the AI keys to the live deploy:

```bash
vercel env add NEMOTRON_API_KEY production    # then OPENAI_API_KEY, ELEVENLABS_API_KEY, etc.
vercel deploy --prod                            # picks up the new env
```

After that, every visitor's commentary burns *your* AI quota. For a public demo URL, gate it (Vercel Deployment Protection → password) or share only with the interviewer.

---

## If something breaks during the live demo

| Symptom | Quick fallback |
|---|---|
| First commentary takes >10s | Reload — usually a cold-start blip |
| Host turns stop scrolling | Click Stop, then Listen to a sample again |
| Markets ticker empty | Vendor side issue (Kalshi/Polymarket); show the rest |
| Page won't load | Check status: `curl -s -o /dev/null -w "%{http_code}\n" https://huddle-radio.vercel.app/` |
