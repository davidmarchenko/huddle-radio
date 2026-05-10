# API Keys and Environment

Do not commit real keys. Put local credentials in `.env`; `.env` is ignored by Git. The backend loads `.env` on startup through `dotenv`.

Start from:

```bash
cp .env.example .env
```

Restart `npm run dev` after changing `.env`.

## No-Key Mode

The app works without credentials:

```bash
MODEL_PRESET=local
COMMENTARY_PROVIDER=local
MODEL_PROVIDER=mock
TTS_PROVIDER=mock
FANTASY_PROVIDER=demo
SPORTS_DATA_PROVIDER=demo
NEWS_PROVIDER=demo
```

This uses:

- demo fantasy,
- scripted demo sports data,
- demo news,
- mock model observation,
- local commentary,
- mock/browser-compatible TTS.

Use this for UI work, tests, and demos where provider noise would distract.

## SOTA Mode

The current SOTA target stack is configured with:

```bash
MODEL_PRESET=sota
COMMENTARY_PROVIDER=auto
MODEL_PROVIDER=openai-vision
TTS_PROVIDER=auto

OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.2
OPENAI_FAST_MODEL=gpt-5-mini
OPENAI_REASONING_EFFORT=none
OPENAI_REALTIME_MODEL=gpt-realtime
OPENAI_REALTIME_FAST_MODEL=gpt-realtime-mini

ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=Xb7hH8MSUJpSbSDYk0k2
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
ELEVENLABS_EXPRESSIVE_MODEL_ID=eleven_v3
```

Resolution behavior:

- `COMMENTARY_PROVIDER=auto` uses OpenAI when `OPENAI_API_KEY` exists and `MODEL_PRESET` is not `local`.
- `TTS_PROVIDER=auto` uses ElevenLabs when `ELEVENLABS_API_KEY` exists and `MODEL_PRESET` is not `local`.
- Tests force local/mock providers unless explicitly running provider smoke tests.

## Model Presets

`MODEL_PRESET=sota`

- commentary: `OPENAI_MODEL`,
- TTS: `ELEVENLABS_MODEL_ID`,
- target for best quality/latency available in this app.

`MODEL_PRESET=fast`

- commentary: `OPENAI_FAST_MODEL`,
- realtime target: `OPENAI_REALTIME_FAST_MODEL`.

`MODEL_PRESET=local`

- use local/mock paths,
- useful for development and tests.

## OpenAI

Currently used for:

- commentary generation through `OpenAICommentaryProvider`,
- optional frame validation through `OpenAIVisionModelProvider`.

Environment:

```bash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.2
OPENAI_FAST_MODEL=gpt-5-mini
OPENAI_REASONING_EFFORT=none
OPENAI_REALTIME_MODEL=gpt-realtime
OPENAI_REALTIME_FAST_MODEL=gpt-realtime-mini
```

Realtime is planned/scaffolded. The current live loop does not yet run a full browser audio/video realtime session.

## ElevenLabs

Currently used for:

- streaming TTS chunks from generated commentary.

Environment:

```bash
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=Xb7hH8MSUJpSbSDYk0k2
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
ELEVENLABS_EXPRESSIVE_MODEL_ID=eleven_v3
```

If no key exists, the app falls back to mock/browser-compatible TTS behavior.

## ESPN Fantasy

ESPN Fantasy uses unofficial ESPN fantasy endpoints.

Public leagues may only need:

```bash
ESPN_LEAGUE_ID=
ESPN_SEASON=2026
```

Private leagues need cookies from your own ESPN account:

```bash
ESPN_SWID=
ESPN_S2=
```

Keep these server-side. Never paste them into client code, screenshots, or committed docs.

## Sleeper

Sleeper is read-only and does not require an API key.

```bash
SLEEPER_LEAGUE_ID=
SLEEPER_WEEK=
```

## Nemotron

Scaffolded for future multimodal observation:

```bash
MODEL_PROVIDER=nemotron
NEMOTRON_MODEL=nvidia/nemotron-3-nano-omni
NEMOTRON_ENDPOINT=
NEMOTRON_API_KEY=
```

Current state: planned/scaffolded, not a production-ready integration.

## Future Provider Keys

These are placeholders and are not currently used by the MVP:

```bash
YAHOO_CLIENT_ID=
YAHOO_CLIENT_SECRET=
SPORTRADAR_API_KEY=
SPORTSDATAIO_API_KEY=
FAL_KEY=
```

## Provider Smoke Tests

Default tests do not call paid APIs:

```bash
npm run test
```

Optional provider checks:

```bash
npm run test:providers
```

This command only exercises real providers when the relevant keys exist.

## Secret Hygiene

- Never commit `.env`.
- Never paste real keys into docs.
- Redact provider errors before showing them in UI.
- Keep ESPN cookies server-side.
- Rotate any key that was pasted into a chat, screenshot, issue, or commit.
