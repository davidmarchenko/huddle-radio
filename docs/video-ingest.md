# Video Ingest

Huddle accepts video context only when the user provides a permitted source. The app does not scrape broadcasts, bypass DRM, fetch paid streams, or redistribute video.

## Supported Modes

### Screen Share

Best for:

- ESPN,
- YouTube TV,
- cable provider apps,
- authenticated streaming sites,
- DRM-protected players,
- anything behind login.

Why: browser screen share lets the user decide what they are allowed to show. It also avoids trying to fetch or bypass a protected stream URL.

### Stream URL

Best for:

- permitted HLS URL,
- permitted MP4 URL,
- same-origin demo stream,
- CORS-enabled stream that the user has rights to use.

Limitations:

- many third-party videos cannot be sampled because of CORS/canvas tainting,
- YouTube watch URLs should be embedded, not fetched,
- protected streams will not work as raw URLs.

### VOD

Best for:

- permitted demo media,
- local/replay clips,
- QA of frame validation and player UI.

## Rights Boundary

The app must not:

- scrape official broadcasts,
- bypass DRM,
- defeat geo/access controls,
- capture content the user cannot legally access,
- redistribute video to other users,
- store full copyrighted game video unless explicitly permitted.

The app may:

- let a user screen-share something they are allowed to watch,
- process user-provided permitted VOD,
- use licensed provider feeds when configured,
- use official play-by-play as the source of truth.

## Browser Capture Constraints

Frame validation works by capturing a small browser-side frame when possible.

Generally capturable:

- screen share,
- same-origin video,
- CORS-enabled video,
- local demo/VOD.

Generally not capturable:

- YouTube iframes,
- DRM video,
- cross-origin video without CORS,
- protected players that block canvas reads.

When capture is blocked, Huddle should keep running in data-only/live-audio mode and avoid visual claims.

## YouTube Handling

YouTube URLs are converted into embed URLs for playback/preview when possible.

Important:

- Huddle does not download YouTube video.
- Huddle does not sample pixels from YouTube iframes.
- For live commentary with visual context from YouTube TV or a YouTube player, use screen share.

## Stream Validation

When `MODEL_PROVIDER=openai-vision`, the app can submit a captured frame to:

```text
POST /api/video/validate-frame
```

The model returns:

- status: `sports-event`, `not-sports`, `uncertain`, or `unavailable`,
- confidence,
- sport,
- evidence,
- reason,
- validation timestamp.

Validation is not official scoring. It is a guardrail and context signal.

## No-Stream Mode

No-stream mode is a first-class experience:

- official play-by-play drives the show,
- player/team media anchors the moment,
- waveform and host conversation create radio feel,
- right rail shows score, fantasy impact, and highlights.

Copy should make clear that the show is following play-by-play, not visually watching a broadcast.

## Future Video Work

- Better browser capture UX and permissions guidance.
- Sample cadence tuned to moment priority.
- Audio event detection from permitted streams.
- Provider-specific ingest adapters for licensed feeds.
- More robust sports-event classification.
- Visual confidence shown only in diagnostics unless it affects UX.
- Clip generation from user-permitted/local sources.
