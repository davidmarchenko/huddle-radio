# Design System

This document captures the intended Huddle Radio visual language so future UI work does not drift back into a debug dashboard.

## Product Mood

Huddle should feel like:

- a premium audio/media app,
- a cozy live sports room,
- editorial but not static,
- playful through motion and host personality,
- elegant before loud.

It should not feel like:

- a betting terminal,
- a fantasy spreadsheet,
- a cheap comic book,
- a generic SaaS dashboard,
- a technical control room.

## Visual References

The source-of-truth references live in:

```text
docs/Reference Images/
```

Current files:

- `Empty State.png`
- `Landing Page.png`
- `PreGame Show.png`
- `Live Session.png`
- `Live Game No Stream.png`
- `Post Game Recap.png`

Before redesigning a surface, compare against those images and the Foundation Doc.

## Layout System

### App Shell

Use:

- persistent left navigation,
- main show canvas,
- contextual right rail only when useful,
- persistent bottom audio player outside empty mode.

Avoid:

- giant technical page titles,
- showing every setting at once,
- floating cards inside floating cards,
- cramped debug panels,
- blank video placeholders.

### Main Phases

Empty:

- centered onboarding,
- host art,
- three cards,
- one clear primary CTA.

Pregame:

- large editorial countdown/readiness headline,
- host/studio card,
- matchup rail.

Live with stream:

- video dominant,
- overlays for score and host callout,
- bottom audio transport.

Live audio:

- moment hero,
- player/team media,
- animated waveform,
- host conversation,
- recent highlights/fantasy impact rail.

Recap:

- narrative summary,
- final/last score,
- turning point,
- host moment,
- highlight list.

## Color

Base:

- dark navy/slate foundation,
- warm purple/lavender depth,
- peach/coral accent for energy,
- gold accent sparingly for wildcard/spotlight moments.

Do not let the app become:

- all neon green,
- all purple,
- beige comic-book panels,
- sportsbook red/green.

Color should communicate state:

- live/on-air: warm coral or vivid pink,
- ready/success: soft green only in small doses,
- host identity: Maya violet, Theo orange, Cam gold,
- warnings: amber/coral, not loud red unless critical.

## Typography

Use large editorial type for the main show moment only.

Rules:

- Keep headings short.
- Prefer punchy moment headlines: `Gibbs. Breaks loose.`
- Use body copy for detail.
- Avoid wrapping long play-by-play into six-line headlines.
- Do not use negative letter spacing.
- Do not scale font size directly with viewport width except through bounded `clamp()`.

## Motion

Motion should make the app feel alive without becoming noisy.

Use:

- animated waveform bars for audio/live state,
- soft ambient background drift,
- subtle player portrait/ring motion,
- host turn entrance animation,
- bottom player transitions,
- reduced-motion support.

Avoid:

- constant bouncing UI,
- decorative blobs/orbs with no purpose,
- motion that hides information,
- waveform motion that implies synced real audio unless it is driven by audio levels.

Current limitation: waveform levels are visual state from app audio/chunk activity, not full audio-analysis synchronization.

## Media Assets

Use media as a primary product surface:

- player portraits in live moments,
- team logos in score/matchup areas,
- host artwork in empty/pregame,
- generated/fallback avatars only when provider media is absent.

Do not hide media in tiny badges only. If a player is the story, their image should visibly anchor the moment.

## Components

### Bottom Player

The player should feel like Spotify/YouTube audio:

- show title,
- current game,
- play/stop,
- waveform/progress area,
- a few contextual actions.

It should not:

- obscure the main action,
- duplicate the full right rail,
- expose technical diagnostics,
- contain five unrelated buttons.

### Right Rail

Use right rail for live contextual information:

- score/matchup,
- fantasy impact,
- recent highlights,
- next moment,
- stream/source status.

Avoid putting the transcript here by default. Hide transcript/export behind a secondary action unless the user asks for text.

### Setup

Setup should be contextual and progressive:

- first-run cards for high-level choices,
- focused panels for ESPN/Sleeper/stream details,
- diagnostics under Settings.

Avoid a giant catch-all menu that mixes friends, JSON, providers, video, models, and health checks in one wall.

## Accessibility

Minimum expectations:

- Buttons use semantic `button`.
- Images used decoratively have empty alt text.
- Media/avatar labels are available through title/nearby text.
- Motion has `prefers-reduced-motion` fallbacks.
- Text must fit containers at common desktop widths.
- Main CTAs must remain keyboard reachable.

## Implementation Notes

Main files:

- `src/client/main.tsx`
- `src/client/styles.css`
- `src/client/huddleViewModel.ts`

The CSS currently contains legacy design experiments. The latest Huddle overrides live near the end of `styles.css` so they win over earlier iterations. A future cleanup should delete stale blocks once the product direction stabilizes.

## Design Debt

Known design debt:

- CSS needs consolidation into a smaller token/component structure.
- Setup still needs a more polished first-class wizard.
- The bottom player should eventually use real audio analysis for waveform sync.
- Host avatars are initials/placeholders instead of a full illustration/avatar system.
- Empty state still needs more polished provider-specific flows.
- Responsive/mobile behavior should get a dedicated pass.
