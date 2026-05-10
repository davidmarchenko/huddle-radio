# Media Assets

Media is a first-class part of Huddle. A sports show without player photos, team marks, host art, and motion feels empty. The app should use media confidently while respecting provider rights.

## Asset Sources

Product art:

```text
public/huddle/
```

Current files:

- `empty-hosts.png`
- `pregame-studio.png`
- `live-player-art.png`

Cached/generated sports media:

```text
public/media-cache/
public/media-cache/manifest.json
public/media-cache/assets/
```

Micro icons:

```text
public/icons/micro/
```

Reference images:

```text
docs/Reference Images/
```

## Runtime Usage

The React app loads `/media-cache/manifest.json` and uses the media manifest for:

- score bugs,
- team matchup cards,
- fantasy impact cards,
- player portraits in live moments,
- play/highlight rows,
- media cache diagnostics.

If an asset is missing or fails to load, `MediaAvatar` falls back to initials.

## Media Cache Script

Run:

```bash
npm run media:cache
```

Useful variants:

```bash
npm run media:cache -- --dry-run
npm run media:cache -- --out public/media-cache
npm run media:cache -- --sleeper-league-id 123456789
npm run media:cache -- --include-espn-demo --assume-rights
```

The script:

- creates generated fallback SVGs,
- can cache Sleeper avatars for a connected league,
- can cache selected ESPN demo media only when explicitly directed,
- writes `manifest.json`,
- records source, rights, status, SHA-256, byte size, local path, and public path.

## Rights Policy

Generated fallback assets:

- safe to ship.

Sleeper avatars:

- can be cached for a connected league/user context.

Licensed provider media:

- can be cached/displayed according to provider terms.

ESPN public CDN images:

- useful for local demos,
- not the recommended production source,
- should not be treated as permanent public-domain assets.

NFL team logos/player likenesses:

- require the correct provider/license before public or commercial use.

## Manifest Shape

Each manifest asset records:

- `id`
- `label`
- `kind`
- `source`
- `rights`
- `status`
- `url`
- `localPath`
- `publicPath`
- `sha256`
- `bytes`
- `reason`

The UI should not assume every candidate is cached. It must handle `skipped`, `failed`, and missing manifest states.

## Adding Media Sources

Add a media source by emitting `MediaAssetCandidate` objects from `src/shared/mediaAssets.ts` or a provider-specific helper.

Required fields:

- stable `id`,
- `kind`,
- human-readable `label`,
- `source`,
- explicit `rights`,
- optional `url`,
- optional metadata.

Only remote assets with these rights are downloaded:

- `provider-permitted`,
- `provider-licensed`,
- `user-provided`.

## Product Guidelines

Use media prominently when it carries the story:

- player portrait in the live moment hero,
- team logos in score/matchup contexts,
- host art in onboarding/pregame,
- right rail images for fantasy impact.

Avoid:

- tiny-only logo usage,
- decorative stock-like imagery that does not identify the game/player,
- media-free live states,
- showing broken image icons,
- hiding all media behind diagnostics.

## Current Limitations

- Host identities mostly use initials and bundled art.
- Media cache is local/static, not a production CDN pipeline.
- Player/team ID mapping is still MVP-level.
- Rights are recorded but not enforced by an account/license system.
- The waveform is visual state, not full audio-analysis sync.

## Future Work

- Licensed media provider adapter.
- CDN upload/publish step.
- Better team/player ID map.
- Host portrait system.
- Per-league user avatars.
- Image optimization and responsive variants.
- Media QA snapshots in tests.
