# Testing

The default test suite should be fast, deterministic, and free of provider charges.

## Default Checks

Run:

```bash
npm run test
npm run build
```

`npm run test` uses Vitest. `npm run build` runs TypeScript and Vite production build.

## Optional Provider Checks

Run:

```bash
npm run test:providers
```

Provider smoke tests are intentionally separate. They should only call real services when the relevant keys exist.

## Current Coverage

The suite covers:

- fantasy impact ranking,
- livecast engine output,
- commentary safety/variety basics,
- demo provider contracts,
- Sleeper provider normalization,
- ESPN Fantasy provider normalization,
- ESPN scoreboard provider behavior,
- Fastify REST endpoints,
- WebSocket livecast flow,
- media asset helpers,
- media manifest lookup,
- video link handling,
- transcript export,
- product readiness,
- session director logic,
- Huddle phase/view-model helpers,
- OpenAI vision provider mocked behavior.

## Important Test Files

```text
src/test/fantasyImpact.test.ts
src/test/livecastEngine.test.ts
src/test/livecastFlow.test.ts
src/test/websocketLivecast.test.ts
src/test/serverApp.test.ts
src/test/huddleViewModel.test.ts
src/test/mediaAssets.test.ts
src/test/mediaManifest.test.ts
src/test/sessionDirector.test.ts
src/test/productReadiness.test.ts
src/test/videoLinks.test.ts
src/test/providerSmoke.test.ts
```

## What To Test When Changing UI

For Huddle phase/UI changes:

- phase selection from show/live/commentary/final state,
- no-stream vs stream layout inputs,
- host turn derivation,
- fantasy spotlight,
- recap summary,
- media fallback behavior,
- start/stop flow in browser,
- empty state clarity.

Automated tests currently cover the view-model layer, not pixel-perfect UI.

## Manual Browser QA

At `http://localhost:5173`, check:

1. Empty state is self-explanatory for a first-time user.
2. Demo show starts without keys.
3. Pregame has matchup, hosts, and CTA.
4. Live no-stream mode does not show an empty video void.
5. Player/team media appears when cached.
6. Bottom player does not block primary controls.
7. Stop moves the app out of live/on-air state.
8. Settings/diagnostics are available but not the main experience.
9. Stream setup explains screen share for ESPN/YouTube TV/cable apps.
10. Reduced/no provider keys still produce a usable demo.

## Testing API Keys

Default tests should not require:

- `OPENAI_API_KEY`,
- `ELEVENLABS_API_KEY`,
- ESPN cookies,
- Sportradar/SportsDataIO keys.

If a test needs a real provider, place it behind `npm run test:providers` or mock the provider.

## Regression Risks

High-risk areas:

- WebSocket lifecycle and timers,
- TTS streaming and audio state,
- ESPN private cookie handling,
- media manifest lookup/fallback,
- CSS overrides near the end of `styles.css`,
- start/stop phase transitions,
- provider error redaction.

## Before Merging Larger Changes

Run:

```bash
npm run test
npm run build
```

Then do browser QA for:

- empty,
- pregame,
- live with no stream,
- live with screen share or VOD,
- recap.

## Future Test Improvements

- Playwright screenshots for Huddle phases.
- Visual regression checks against `docs/Reference Images`.
- Browser tests for Stop button and bottom player behavior.
- Mock audio-level tests for waveform state.
- Contract tests for future licensed sports data provider.
- Accessibility checks for keyboard/focus states.
