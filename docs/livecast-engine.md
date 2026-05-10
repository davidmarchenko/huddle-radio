# Livecast Engine

The livecast engine turns game state into a personalized spoken sports moment.

Core files:

- `src/engine/livecastEngine.ts`
- `src/engine/fantasyImpact.ts`
- `src/shared/sessionDirector.ts`
- `src/shared/transcriptExport.ts`
- `src/client/huddleViewModel.ts`

## Inputs

The engine and commentary layer use:

- normalized fantasy league state,
- current play-by-play event,
- model/video observation,
- friend/group settings,
- optional news context,
- recent commentary memory.

## Output

Each generated item is a `LivecastCommentary`:

- `id`
- `text`
- `fantasyImpacts`
- `moment`
- `observation`
- `play`
- `createdAt`
- `latency`

The client turns this into:

- host turns,
- live moment hero,
- recent highlights,
- fantasy impact cards,
- recap summaries.

## Fantasy Impact

`rankFantasyImpacts` estimates which rostered players were affected by a play.

Current MVP behavior:

- matches play `playerIds` against rostered players,
- estimates point delta from play type,
- prioritizes starters,
- sorts by absolute impact.

Limitations:

- does not fully model provider scoring settings,
- does not consume official stat deltas,
- does not yet model negative plays deeply,
- depends on player ID alignment.

Production direction:

- use provider scoring settings,
- consume official play/stat deltas,
- support ID mapping across fantasy/stats/media providers,
- calculate matchup win probability swings.

## Moment Cue Scoring

`assessMomentCue` scores each play and produces a `MomentCue`:

- `priority`: `routine`, `notable`, `major`, `interrupt`,
- `headline`,
- `summary`,
- `reasons`,
- `targetFriendIds`,
- `score`.

Signals include:

- touchdowns,
- turnovers,
- field goals,
- excitement,
- fantasy swing,
- affected friends,
- rivalry context.

The UI uses moment priority for live pacing and labels. Future work can use priority to dynamically shorten cadence, interrupt less important calls, or trigger shareable clips.

## Commentary Strategy

Generated commentary should be:

- short enough for real-time TTS,
- specific to the play,
- grounded in official play-by-play,
- personalized to owners and rivalry notes,
- aware of tone (`family`, `pg`, `chaos`),
- clear when no video stream is attached,
- free of secrets and raw provider metadata.

Do:

- mention who was helped or hurt,
- mention the fantasy reason,
- keep the sentence count low,
- use recent commentary to avoid repetition.

Do not:

- claim visual facts from an unavailable stream,
- expose API keys, cookies, or provider debug text,
- turn every routine play into a huge moment,
- over-explain the system.

## Commentary Providers

Local:

- deterministic fallback,
- good for tests and no-key demos.

OpenAI:

- used when `COMMENTARY_PROVIDER=auto|openai` and `OPENAI_API_KEY` is present,
- default model comes from `src/shared/modelStack.ts`,
- `OPENAI_REASONING_EFFORT=none` by default for speed.

The fallback text is still assembled before provider drafting. If the model provider fails, the app can continue with local commentary.

## Model Observation

The multimodal model observation is separate from official sports data.

Current roles:

- mock/local observation for demos,
- OpenAI vision frame validation,
- future Nemotron-compatible multimodal observation.

Observation may inform color/context. It should not override official score, clock, or stat facts.

## TTS Strategy

TTS is intentionally downstream from commentary:

1. Commentary text is generated.
2. Browser receives the commentary event.
3. TTS provider streams chunks.
4. Client marks audio/waveform state.

ElevenLabs is the current low-latency target through WebSocket TTS. Mock TTS keeps tests and local demos free.

## Latency Metrics

Each call records:

- `videoIngestMs`,
- `modelResponseMs`,
- `textGenerationMs`,
- `ttsFirstAudioMs`,
- `endToEndMs`.

Use these metrics to decide whether a provider should be used for live moments, pregame/recap only, or not at all.

## Session Director

`src/shared/sessionDirector.ts` builds an operator-level plan:

- readiness score,
- mode,
- checklist,
- live cues,
- fallback path.

This is a product guide for the UI, not the source of truth for sports facts.

Expected modes include:

- live-ready,
- data-only,
- demo-rehearsal,
- blocked.

## Huddle View Model

`src/client/huddleViewModel.ts` maps commentary/game/fantasy state to product surfaces:

- phase,
- setup steps,
- host turns,
- matchup story,
- fantasy spotlight,
- recap.

This is where presentation language belongs. Provider objects and raw diagnostics should not leak into the main show UI.

## Recap Export

`buildTranscriptExport` creates a Markdown recap with:

- provider context,
- biggest moment,
- biggest fantasy swing,
- moment priority,
- average latency,
- transcript text.

The recap should become more shareable over time: richer cards, clips, social export, and league history.

## Guardrails

- Official play-by-play is source of truth.
- Model observation is contextual and non-authoritative.
- Video must be user-provided/permitted.
- Do not leak secrets.
- Do not generate unsafe harassment from rivalry notes.
- Respect selected tone.
- Keep no-stream mode honest: “following official play-by-play,” not “watching the broadcast.”

## Future Engine Work

- Multi-host turn generation with distinct voices.
- Real dialogue timing and interruption logic.
- Rolling memory of jokes, rivalry history, and earlier drives.
- Win probability and fantasy playoff stakes.
- Injury/penalty caution rules.
- Better quote avoidance and news attribution.
- Dynamic cadence from moment priority.
- Real audio-level waveform sync.
