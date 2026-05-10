# Product Experience

Huddle Radio is a personalized sports show for a league room. The product should help a first-time user answer three questions quickly:

1. What do I connect?
2. What am I watching?
3. What will Huddle do for my friends and me?

Everything else is secondary. Provider diagnostics, model stack details, latency metrics, media cache details, and validation internals are useful, but they are not the primary product.

## Experience Principles

- Lead with the show, not the configuration.
- Use user language: `Start live show`, `Add stream`, `Connect fantasy`, `Meet hosts`.
- Keep technical details available but tucked away.
- Make demo mode feel like a trial show, not a fake dashboard.
- When no stream is attached, make the product feel intentionally radio-first rather than broken-video-first.
- Treat fantasy points as narrative stakes, not just numbers.
- Make host personalities visible and consistent.
- Never imply that a visual observation is official game data.

## User Journey

### First Run

Goal: reduce confusion and get the user to a working show.

The empty state should show:

- brand and left nav,
- a simple headline,
- host artwork/personality,
- three setup cards:
  - connect fantasy,
  - choose what you are watching,
  - meet/tune hosts,
- a clear demo CTA.

The user should not need to understand providers, model presets, or WebSockets to begin.

### Pregame

Goal: establish the show.

Pregame should show:

- countdown or readiness state,
- matchup,
- hosts and their opening turns,
- fantasy storyline,
- players to watch,
- CTA to start or add stream.

It should feel like a sports pre-show, not a setup panel.

### Live With Stream

Goal: make the video primary and keep Huddle as a companion layer.

Live-with-stream should show:

- large video or screen-share preview,
- score/game state overlay,
- active host callout,
- fantasy impact,
- right rail with moments and host status,
- bottom player/transport.

For screen share, the app should explain that ESPN, YouTube TV, cable apps, and DRM/login video should be shared from the browser/OS instead of pasted as a URL.

### Live Audio / No Stream

Goal: make no-stream mode feel deliberate.

When there is no stream, the product should not show an empty black video void. It should show:

- a live moment hero,
- player/team media,
- score and clock,
- animated waveform,
- host conversation,
- recent highlights,
- fantasy impact,
- persistent bottom player.

The copy should make clear that Huddle is following official play-by-play and not claiming visual observations.

### Recap

Goal: turn the session into something shareable.

Recap should show:

- final score or latest score,
- turning point,
- best host moment,
- matchup shift,
- highlight list,
- export/share CTA.

## Phase Model

The client derives a local `HuddlePhase` in `src/client/huddleViewModel.ts`:

```text
empty      no prepared show and no commentary
pregame    show prepared, not live, no commentary yet
live       live with stream/screen-share/VOD
live-audio live without stream
recap      stopped/final after commentary exists
```

The phase model is intentionally client-local. Backend contracts remain stable while the product presentation evolves.

## Host Personas

The app currently presents three persistent hosts:

- Maya: Analyst
- Theo: Fan
- Cam: Wildcard

Today, host turns are derived from the existing commentary stream in the client. A later backend pass can generate host-specific dialogue, voice selection, timing, interruptions, and memory.

## Fantasy as Story

Fantasy data should appear as:

- rivalry state,
- matchup pressure,
- player spotlight,
- swing explanation,
- “this helped Alex / hurt Maya” style copy.

Keep raw metrics available, but do not lead with tables of provider data. A good live card should say what changed and why the room cares.

## Empty State Requirements

A first-time user with an ESPN fantasy league and an ESPN/YouTube TV/cable stream should understand:

- ESPN Fantasy can be connected by league ID, season, week, and cookies for private leagues.
- Sleeper can be connected by league ID.
- Demo mode is available immediately.
- Authenticated/DRM streams should use screen share.
- Direct URL is only for permitted embeddable streams or VOD.
- Hosts and friends can be tuned later.

## Copy Guidelines

Prefer:

- `Start live show`
- `Add stream`
- `Use screen share`
- `Connect fantasy`
- `Ready`
- `On air`
- `Signal issue`
- `Following official play-by-play`

Avoid in the main UI:

- `WebSocket`
- `Provider health`
- raw HTTP status text
- model IDs unless in settings/diagnostics
- unprocessed provider error strings
- long transcript blocks

## Failure Modes

When something is missing:

- No fantasy: offer demo, ESPN, Sleeper.
- No sports data: offer demo game or ESPN scoreboard.
- No stream: switch to live-audio mode.
- Cannot validate video: keep the show running from official play-by-play and avoid visual claims.
- No TTS key: use mock/browser speech or text-only host turns.
- Provider error: show plain-language recovery, keep details in diagnostics.

## Future Product Improvements

- A proper Create Show wizard instead of modal-like setup panels.
- Host style tuning with presets such as chill, analyst, chaotic, family.
- Room invite and shared session state.
- Multi-host audio with separate voices.
- Moment clipping and share cards.
- Live “quiet mode” when the broadcast needs room.
- Better onboarding for private ESPN cookies.
- League history and recurring rivalries.
- Real win probability and fantasy matchup probability.
