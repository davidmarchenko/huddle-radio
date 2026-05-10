# Pain Points and Implemented Improvements

This document records major product/engineering improvements made during the MVP build. It is not the design source of truth; use `Foundation Doc.md`, `product-experience.md`, and `design-system.md` for the current product direction.

## Early Product Gaps

1. Starting Sleeper mode without a league ID failed late.
   - Added client and server validation with clearer setup messaging.

2. The livecast cadence was fixed.
   - Added a 3-15 second commentary cadence control and backend support.

3. Group personalization was hard-coded.
   - Added friend add/remove, favorite team editing, rivalry notes, and roster mapping.

4. Commentary did not respect user priorities.
   - Added fantasy-first, favorite-team-first, and balanced priority modes.

5. Voice playback had no pacing control.
   - Added browser voice speed control and avoided duplicate browser speech when ElevenLabs chunks are active.

6. Video source state was opaque.
   - Added video/source notices for demo, licensed URL, screen-share, and load-error paths.

7. Transcript handling was missing.
   - Added clear/export actions, then later demoted transcript from the main live surface so the app feels more like a media product.

8. Fantasy context was too thin.
   - Added matchup context and starter-aware fantasy impact rows.

9. Latency was buried per-card.
   - Added latency and readiness instrumentation, then moved technical details behind diagnostics.

10. Provider health was static.
    - Added manual refresh and periodic WebSocket health updates during a live session.

## Huddle Radio Reset

11. The app felt like a fantasy/control dashboard instead of a show.
    - Rebuilt the client shell around Huddle Radio phases: empty, pregame, live, live-audio, and recap.

12. First-time users had no clear path.
    - Added a first-run onboarding surface for fantasy connection, game/stream choice, and host setup.

13. No-stream mode looked broken.
    - Reframed it as a radio-style live show with moment hero, player/team media, host conversation, highlights, and fantasy impact.

14. Technical details crowded the main experience.
    - Demoted providers, model stack, media cache, latency, and diagnostics into secondary settings/diagnostic surfaces.

15. Media assets were underused.
    - Added Huddle art and media-cache usage for player portraits, team logos, score/matchup cards, and live moments.

16. Motion was missing.
    - Added waveform, ambient, portrait, and host-turn motion with reduced-motion fallbacks.

17. The bottom player fought the UI.
    - Reworked it toward a compact audio transport instead of a duplicate dashboard.

18. Raw backend/status text leaked into the product.
    - Added safer display labels such as `On air` and `Signal issue`.

## Remaining Pain Points

- Setup still needs a cleaner wizard.
- CSS should be consolidated after the visual direction stabilizes.
- Waveform animation should eventually use real audio analysis.
- Host personas need true backend orchestration and distinct voices.
- Provider ID mapping must mature before real production data.
- Visual regression tests should compare against the reference images.
