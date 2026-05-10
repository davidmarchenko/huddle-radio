# Design Audit — Huddle Radio

Baseline assessment of the current client UI versus the reference images and `docs/design-system.md`. This document is the work backlog for the design pass.

Status: pre-revision baseline. Updated when each surface is revised.

---

## Source-of-truth artifacts

- References: `docs/Reference Images/{Empty State, Landing Page, PreGame Show, Live Session, Live Game No Stream, Post Game Recap}.png`
- Design intent: `docs/design-system.md`, `docs/product-experience.md`, `docs/Foundation Doc.md`
- Current code: `src/client/main.tsx` (~3.3K lines), `src/client/styles.css` (~7.9K lines)

---

## Cross-cutting findings

These are not phase-specific. They affect every surface and should be fixed in the foundations stage before per-phase work.

### F1. CSS has at least three competing layers

`styles.css` contains three `:root` / global blocks that all set body, button, color palette:

- **Lines 1–1120** — original "Fantasy Livecast" theme. Inter font, neon green primary button (`#21c47b`), Unsplash stock background image hardcoded.
- **Lines 1121–~2545** — "Studio" theme. Different green (`--studio-green: #67f5b5`), blue accent, separate tokens, second Unsplash background.
- **Lines 6062–7903** — current "Huddle" override. Violet/peach/gold tokens (`--huddle-violet: #9b6cff`, `--huddle-peach: #ff806d`, `--huddle-gold: #f7bd46`), proper dark navy gradient background, no stock image. This block wins via specificity and order.

The override only wins for selectors scoped under `.huddle-app`. Anything outside that scope (legacy `.legacy-control-room`, plain `body`, plain `button`) still inherits the green theme and stock image, which is why mobile zoom and scroll-bounce can flash the wrong colors.

Within the override layer there are also duplicate definitions (`.live-rail-card` appears at lines 2546, 3071, 3436, 3945, 4462; `.live-hero-copy` at 4831 and 5740; `.live-player-portrait` at 4854, 5031, 5787). Order-of-source determines which wins. This makes any visual change unpredictable.

**Action:** in foundations, hoist a single `:root` token block to the top, scope all legacy blocks under `.legacy-control-room` (which is `aria-hidden`), then collapse duplicates inside the Huddle layer.

### F2. Typography is generic

Both the legacy and Huddle layers declare `font-family: Inter, ui-sans-serif, system-ui, ...`. The design doc explicitly calls for "large editorial type for the main show moment" and an editorial/magazine mood. Inter does not deliver that. No display font is loaded.

**Action:** pair a distinctive editorial display font with a refined body font. Candidates to evaluate (in priority order, all on Google Fonts, all dark-UI-friendly):

- Display: **Fraunces** (variable axis, modern editorial), **Tobias / Söhne Display** alternatives like **PP Editorial New** (license-permitting), or **Instrument Serif** for a more elegant sports-magazine feel.
- Body: **Inter Tight** or **Geist** (still clean but more characterful than stock Inter), or **Söhne** alternative **Switzer**.

The references have a near-magazine editorial feel for the H1 ("Let's get *your show* started.", "Diggs. 41 yards. Unbelievable."), italicized accent on a single word — a serif or hybrid would land that better than any sans.

### F3. External background image hardcoded

`body` references `https://images.unsplash.com/...` in two places. This breaks offline dev, leaks an external request, and the Huddle layer doesn't actually want it.

**Action:** remove. The Huddle layer's gradient is sufficient.

### F4. Button defaults still leak the legacy gradient

The base `button` rule (line ~1162) still sets `background: linear-gradient(135deg, var(--studio-green), #d7ffe9)`. Anywhere a button isn't under `.huddle-app` (or where specificity ties), it can render that gradient briefly during boot/transitions.

**Action:** reset base `button` to inherit, then style intentionally inside `.huddle-app`.

### F5. No motion primitives system

Waveform, ambient drift, pulse-live, host-enter all exist as one-off keyframes scattered in the CSS. There is no shared `--motion-fast / --motion-base / --motion-slow` duration scale and no shared easing tokens. `prefers-reduced-motion` handling is inconsistent.

**Action:** define motion tokens in foundations. Wrap all decorative animation in a single `@media (prefers-reduced-motion: reduce)` rule.

### F6. Token gaps

Existing `.huddle-app` tokens are good but missing:

- text colors for editorial display vs body vs muted vs subtle
- a real radius scale (just `--huddle-card` rounded edges, no scale)
- shadow scale (just inline shadows per component)
- z-index scale (currently `z-index: 35` magic number)
- spacing scale (every component sets its own padding/gap)

**Action:** extend tokens. Adopt these consistently in foundations.

---

## Phase-level deltas

Each phase entry compares the current rendered structure (from JSX + CSS reading) against the matching reference image, and lists what to change.

### P1. Empty State

Reference: `Empty State.png` — left nav, "Let's get *your show* started." H1, host trio illustration above it (purple-lit studio), three numbered setup cards with art, footer note with mic icon, "Create show +" top-right.

**Current structure** (from `HuddleEmptyState`, line 1566):

- Top-right "Create show +" and notification icon. ✓ Matches.
- `empty-host-art` div, currently styled as a CSS-only block (no actual host image). ✗ Reference shows a styled studio portrait of the three hosts.
- H1 "Let's get *your show* started." with span on "your show". ✓ Matches.
- Three `<article class="empty-step">` cards with number badges, art, title, copy, button. ✓ Structurally correct.
- Per-card art: card 1 is provider logos as text spans; card 2 is play orb + waveform; card 3 is host avatars + waveform. ✗ Reference shows richer art per card (provider rosette, prismatic waveform, host emoji-style avatars over animated bars).
- Bottom note: "Once you set this up, your show will appear here." ✓ Matches.

**Gaps to fix:**

1. **Hero illustration.** `empty-host-art` is currently empty/placeholder. Need either a generated host trio image or a CSS+SVG composition (three host avatars with rim lighting, studio backdrop, gradient halo). Reference uses what looks like an illustrated/3D-rendered trio — for now, build a CSS composition with three large host avatars + glow + grain overlay.
2. **Provider logos as real marks.** The `<span>` text fallbacks (🤖 / ESPN / Y! / NFL) need real logo treatment in card 1. Could use simple SVG marks or CSS-styled badges. Reference shows them as rounded square tiles in a row.
3. **Card 2 waveform** should be a true colorful waveform (purple→pink→peach gradient bars), not the same pulled-from-default monochrome. Reference uses a spectrum gradient.
4. **Card 3 avatars** look generic (initials). Reference uses character avatars (face emoji + colored ring per host). For now, upgrade `HostAvatar` to use a vector head silhouette + accent ring.
5. **Number badges (1/2/3).** Reference numbers are larger, in a contrasting circle/halo. Currently small `<b>` with default styling.
6. **Card hover state.** Reference cards lift on hover with a soft glow. Currently no hover treatment.
7. **Footer note.** The mic-circle icon (`<span aria-hidden="true">◉</span>`) is a text glyph. Replace with an SVG mic icon in a circle.
8. **Top-right "Create show +"** button styling — reference is solid violet button with right-aligned plus inside a small chip. Currently fine but the plus is a separate text span; tighten composition.
9. **CTA buttons.** Reference uses solid violet→peach gradient for primary, semi-transparent slate for secondary. Already partially implemented; verify gradient direction matches.
10. **Spacing.** Reference card grid has noticeable air; current `.empty-steps.is-reference-layout` may be tighter (need to verify at 1440px width).

### P2. Pregame

Reference: `PreGame Show.png` — three-column layout (sidebar / main / right rail), "We're live in 09:42" headline, large host studio image (three hosts on a couch in a lit studio), host conversation rows with waveforms, players to watch list, recent history rail, league room rail, bottom player.

**Current structure** (from `HuddlePregame`, line 1640):

- Two-region layout: `.pregame-hero` + `.pregame-rail`. ✗ Reference has three regions: hero/conversation in center, right rail with matchup/spotlight/history/league.
- `.pregame-hero` has eyebrow, H1 with countdown, sub-line, `<HostStudio>` component, button row.
- `<HostStudio>` (line 1899) renders avatars in `.studio-art` + intro turn + waveform. ✗ Reference shows full-bleed studio image, not avatars.
- `<MatchupCard>` in the rail.

**Gaps to fix:**

1. **Layout shift to three columns.** Add right rail with: tonight's matchup card (with team logos, kickoff, stadium), spotlights to watch (player rows with sparkline), recent history, league room. Currently only one rail item.
2. **Host studio hero image.** Replace the avatar grid with an actual full-bleed pregame studio composition. For MVP, use the same illustrated trio image from empty state, framed as a 16:9 banner with overlay gradient at the bottom and host name/role labels on top. Long-term: per-phase studio image.
3. **Live-in countdown styling.** The `<span>09:42</span>` is hardcoded text. Reference shows it in a contrasting accent (peach/gold) and large-format. Promote to actual ticking timer driven by show start time.
4. **Host conversation rows.** The reference shows each host with a pill badge ("Maya - Analyst"), avatar circle, dialogue line, mini waveform. Current `<HostTurns>` is plainer. Restyle.
5. **Players to watch.** Reference list shows player photo, name, position, last-game line, sparkline. Currently no equivalent on this surface.
6. **Recent history.** Reference shows a list of last few moments with mini score deltas. No current equivalent on pregame.
7. **League room.** Reference has a friend-grid with avatars + last-message-style rivalry note. Already exists in sidebar but the *right rail* version is denser.
8. **Bottom player.** Pregame should show the bottom player. ✓ Already does via `HuddlePlayerBar`.

### P3. Live with stream

Reference: `Live Session.png` — large 16:9 video, score bug top-left over video, fantasy callout below, host status rail right (Maya/Theo/Cam each with a status: "active/listening/standby"), right rail with key moments and recent highlights, matchup-mini under host rail, control row beneath video ("Quieter / More analysis / More energy / Roast opponent").

**Current structure** (from `HuddleLiveWithStream`, line 1684):

- Two-region: `.video-stage` + `.on-air-panel`. Stage holds video/iframe + ScoreBug + live-callout + matchup float.
- `<ScoreBug>` exists. ✓
- `<FantasyMatchupFloat>` exists. ✓
- `.on-air-panel` aside has `<HostTurns>` + stop button. ✗ Reference has structured host status (each host as a row with avatar, name, role, current status) plus key moments and recent highlights as separate cards.
- Control row missing entirely. ✗ Reference has four chip buttons under the player ("Quieter", "More analysis", "More energy", "Roast opponent"). The bottom player has these, but the reference shows them as a row directly under the video, separate from the player.

**Gaps to fix:**

1. **Right rail structure.** Replace the single `<HostTurns>` aside with a stack: on-air host card → key moments card → recent highlights card → live audio levels mini-meter (Maya: 128.6, Theo: 104.2 in reference).
2. **Score bug placement and styling.** Currently a float; reference has a more compact bug top-left with team marks and quarter clock.
3. **Fantasy callout under video.** The current `.live-callout` is a single text line. Reference is a full card: player headshot (Josh Allen), position chip, points delta (+6.2 pts), spark line.
4. **Control row chips.** New surface: row of 4 contextual chip buttons under video. (These exist in the bottom player; they should *also* live here, or move from bottom to here.)
5. **"Stop show" affordance.** Currently a secondary button in the right aside. Reference shows it integrated into the bottom player as the primary stop button. Move.

### P4. Live audio (no stream) — most distinctive surface

Reference: `Live Game No Stream.png` — three-column layout. Center: editorial moment H1 ("Diggs. 41 yards. Unbelievable.") in two-tone (white + peach for the verb), full-bleed action backdrop image of the player, three host status cards (Maya/Theo/Cam) with audio levels, host conversation feed below, "Interrupt hosts" button. Right rail: fantasy impact card with player photo + delta, key moments with score delta, scores & game flow with score graph. Bottom: control row + bottom player with central waveform orb.

**Current structure** (from `HuddleLiveAudio`, line 1727):

- `.audio-live-layout` with three children: `.moment-hero` + `.live-conversation` + `.audio-live-rail`.
- Hero has: backdrop, copy block (eyebrow/h1/p/scoreline), media block (player portrait + voice orb with waveform), host strip (three hosts with avatars and roles).
- Conversation has eyebrow + stop button + `<HostTurns>`.
- Rail has matchup card + fantasy impact card + recent highlights.

**Gaps to fix:**

1. **Two-tone headline.** Reference splits headline color: white for setup ("Diggs. 41 yards.") + peach for punchline ("Unbelievable."). Current `<h1>` is single color. Use `formatLiveMomentHeadline` to wrap last clause in a span and color it.
2. **Backdrop image.** `.live-action-backdrop` is currently a CSS gradient. Should be a real player/team photo as backdrop with heavy darken+grain overlay. Source from `mediaIndex` if available, fallback to gradient.
3. **Player portrait.** Currently `<MediaAvatar>` (rounded). Reference shows a much larger framed cutout, top-aligned, almost as a poster. Resize and reposition.
4. **Host status cards.** Reference shows each host with a card: avatar, name, role pill (Analyst/Fan/Wildcard), live audio meter (peach bars). Current `.live-host-strip` is a simple row. Restyle as proper cards.
5. **"Interrupt hosts" button.** New button needed under host conversation. Reference styles it as a coral/peach pill.
6. **Fantasy impact card.** Currently functional but visually thin. Reference includes player photo (large), name, position chip, big points number, two scoreline rows, "View player results" link.
7. **Key moments card.** Reference shows each moment with mini icon, time, "+X pts" delta. Current `<RecentHighlights>` lists plays plainly. Restyle with delta chips.
8. **Scores & game flow chart.** Reference includes a small line chart of scoring progression. New surface entirely. Could defer to v2.
9. **Bottom player center waveform orb.** Reference shows a circular waveform "orb" in the center of the bottom player. Current `<HuddlePlayerBar>` has a flat waveform.
10. **"Live show" sidebar nav active state.** Sidebar has "Live Show" highlighted. ✓ Already correct.

### P5. Recap

Reference: `Post Game Recap.png` — center column: "The Allen Redemption Game 🔥" H1, sub-line, host recap rows with audio level visual, "The turning point" card with thumbnail, "Best host moment" card, "What's next" card with next opponent. Right rail: final score widget (BUF 31 / MIA 24), matchup shift dial (51.2% / 48.8%), key highlights, around the league. Top-right: huddle wordmark + share recap button.

**Current structure** (from `HuddleRecap`, line 1815):

- `.recap-hero` with eyebrow, H1, subtitle, host avatar row.
- `.recap-grid` with: host recap card (wide), MatchupCard, two StorylineCards, RecentHighlights, around-the-league card.
- Button row with "Go live again" + "Share recap".

**Gaps to fix:**

1. **Hero asymmetric layout.** Reference shows H1 left + huddle wordmark/share top-right + a small "Back to home" link. Currently the hero centers everything. Restructure to left-aligned hero with corner share action.
2. **Host recap rows with waveform visualization.** Reference shows each host's recap as a paragraph with a peach audio-level histogram next to it (representing what they said). Currently `<HostTurns>` is a plain text list.
3. **Final score card.** Reference is a styled boxed score: BUF 31 / MIA 24 with team logos. The current `<MatchupCard>` shows pregame matchup, not final result. Add a recap-specific final-score variant.
4. **Matchup shift dial.** New visual: a horizontal probability dial showing how the matchup ended (51.2% vs 48.8%). Could defer.
5. **The turning point card.** Reference has a thumbnail (action shot) + headline + delta. Current `<StorylineCard>` is text-only.
6. **Best host moment card.** Reference has the host avatar + waveform + their moment quote. Current is text-only StorylineCard.
7. **Key highlights pills.** Reference shows them as labeled pills with team color. Current `<RecentHighlights>` is plainer.
8. **What's next card.** Reference shows next week's opponent matchup + "Tap to fully customize" link. Currently shown as part of around-the-league text card. Promote to its own card with a clear CTA.

---

## Component-level findings (cross-phase reusables)

### C1. `HostAvatar` (line 1945)

Currently renders initials inside a colored ring. Acceptable as a fallback but not what the references show. Long-term: replace with illustrated character avatars. Short-term: improve the ring (glow + accent halo) and use a single-color background that matches the host accent.

### C2. `Waveform` (line 2120)

Renders a row of bars with `<span>` elements driven by `levels[]` props. Good primitive. Issues:

- Bars are monochrome by default; references use a gradient (violet→pink→peach) that intensifies on `is-playing`.
- No reduced-motion fallback inside the component (relies on the global one).
- No size variant — all waveforms are the same height regardless of context (player bar, hero, host turn).

**Action:** add `variant` prop (`hero | host-turn | player-bar | inline`) that drives height and gradient.

### C3. `MediaAvatar` (line 2887)

Renders cached image or initials fallback. Works. Issues:

- No size variant for the live hero (where the reference wants a near-poster-sized portrait).
- Initials styling is generic; reference fallbacks for player avatars use jersey-colored circles.

### C4. `HuddlePlayerBar` (line 1865) — bottom player

Currently has: mini-host stack, show label, large play/stop button, waveform, four contextual chip buttons, status text. The references show:

- A central circular waveform "orb" (not a flat bar)
- Track progress slider (currently missing)
- Volume / scrub area (currently missing)
- Hosts on the left, with active host pulsing
- Show title + game on the left
- Contextual chips on the right

**Action:** rebuild the player layout to: `[hosts | show-info] [orb + waveform] [chips + transport]`. Add a track progress visual even if it's purely cosmetic to start.

### C5. `ScoreBug` (line 1325)

Functional. Could improve: quarter clock pill, possession indicator, team color swatches. Low priority.

### C6. `HuddleSidebar` (line 1517)

Pretty close to references. Issues:

- Brand "huddle RADIO" — the b/strong wordmark looks correct in the override layer. ✓
- Nav items: Home, Live Show, Shows, League, History, Clips, Settings. ✓ Match references.
- League room card: ✓ Match.
- User card: shows initials avatar + name + team. ✓ Match.
- Missing: the small "Place" or "ranking" badge ("3rd Place") seen in the recap reference's sidebar.

### C7. `HuddleTopBar` (line 1548)

The current structure is "eyebrow + bold + sub-line | status pill + settings". References vary by phase: empty has just `Create show +`, pregame has show identity, live has on-air pill + game audio toggle, recap has back-to-home + share. The current top-bar is uniform across phases. Need phase-conditional content.

---

## Suggested fix order

Following the Stage 0 → Stage 4 plan:

1. **Foundations (Stage 1)** — F1, F2, F3, F4, F5, F6. All are scoped to CSS architecture + token system + font loading. No JSX changes.
2. **Empty State (Stage 2.1)** — P1.1–P1.10 + C1 partial. Highest visibility, sets the bar.
3. **Pregame (Stage 2.2)** — P2.1–P2.8 + C7 phase-conditional top bar.
4. **Live Audio (Stage 2.3)** — P4.1–P4.10. Most distinctive surface.
5. **Live with Stream (Stage 2.4)** — P3.1–P3.5.
6. **Recap (Stage 2.5)** — P5.1–P5.8.
7. **Cross-cutting components (Stage 3)** — C2 waveform variants, C3 avatar variants, C4 player-bar rebuild, C5 score-bug polish.
8. **Cleanup (Stage 4)** — collapse legacy CSS layers, delete unused selectors, document final tokens in `design-system.md`.

---

## Out of scope for this pass

- Mobile/responsive layouts below 1024px.
- Real audio-level analysis driving the waveform.
- Generated host illustrations (use CSS+SVG composition or a single shared illustration for now).
- Real broadcast video player skinning (using browser default `<video>` controls is fine).
- Light-mode theme.
- Internationalization.
