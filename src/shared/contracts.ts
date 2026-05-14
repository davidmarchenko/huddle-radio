export type ProviderStatus = "ready" | "degraded" | "disabled" | "error";

export type ProviderHealth = {
  id: string;
  label: string;
  status: ProviderStatus;
  detail: string;
  latencyMs?: number;
};

export type FriendProfile = {
  id: string;
  name: string;
  favoriteTeam: string;
  rosterId?: string;
  rivalryNotes?: string;
};

/**
 * The person the show is being made for. Hosts address them by name and
 * are aware of which fantasy roster is theirs. Without this, every show
 * collapses into generic third-person play-by-play.
 */
export type Listener = {
  name: string;
  rosterId?: string;
  favoriteTeam?: string;
};

export type GroupSettings = {
  listener: Listener;
  friends: FriendProfile[];
  tone: "family" | "pg" | "chaos";
  homeTeamBias: "balanced" | "fantasy-first" | "favorite-team-first";
};

export type FantasyPlayer = {
  id: string;
  name: string;
  position: string;
  proTeam: string;
  projectedPoints: number;
  currentPoints: number;
};

export type FantasyRoster = {
  id: string;
  ownerName: string;
  teamName: string;
  starters: FantasyPlayer[];
  bench: FantasyPlayer[];
};

export type FantasyMatchup = {
  id: string;
  week: number;
  rosters: FantasyRoster[];
};

export type FantasyLeagueState = {
  provider: string;
  leagueId: string;
  leagueName: string;
  // Use the broad SportLeague union so a single user can hold NBA, MLB,
  // NHL etc. leagues in addition to NFL — the app aggregates across them.
  sport: SportLeague;
  season: string;
  scoringSummary: string;
  matchups: FantasyMatchup[];
  updatedAt: string;
};

export type SportsPlay = {
  id: string;
  type: "pass" | "rush" | "touchdown" | "first-down" | "turnover" | "field-goal" | "other";
  excitement: 1 | 2 | 3 | 4 | 5;
  clock: string;
  quarter: string;
  possession: string;
  headline: string;
  description: string;
  playerIds: string[];
  team: string;
  score: {
    away: number;
    home: number;
  };
  occurredAt: string;
};

export type SportLeague = "nfl" | "nba" | "wnba" | "mlb" | "nhl" | "ncaaf" | "ncaab" | "soccer" | "other";

/**
 * A free-form signal from a non-play-by-play source — fan reactions
 * (Reddit, Bluesky), beat-reporter posts, deeper stats from sport-
 * specific official APIs, contextual blurbs (Wikipedia, AI search
 * grounding). The aggregator dedupes across sources, ranks by
 * importance, and surfaces a top-N to the commentary prompt so the
 * AI hosts can weave in colour the official scoreboard doesn't carry.
 *
 * `kind` lets the prompt builder bucket signals (the model is told
 * "here are 3 reactions and 2 stats, sample for colour"). `source`
 * stays as a string union we extend per provider — the aggregator
 * uses it for trust-ranking when it has to pick between two near-
 * duplicate items. `score` is a 0..1 importance from the provider's
 * point of view (engagement, recency, etc.) and gets re-weighted by
 * the aggregator with recency + active-play affinity.
 */
export type EnrichmentSignal = {
  id: string;
  source:
    | "reddit"
    | "bluesky"
    | "nba-stats"
    | "mlb-stats"
    | "nhl-stats"
    | "espn-news"
    | "wiki"
    | "perplexity"
    /** Cross-show callback — claim a host made in a prior show that
     *  matches the current play's player or team. Surfaced by the
     *  CallbackEnrichmentProvider out of the per-listener claims store. */
    | "callback"
    /** Visual color the model saw in the current frame — bench
     *  reactions, body language, sideline drama, crowd intensity.
     *  Emitted by the VisionEnrichmentProvider from the per-tick
     *  VideoObservation. The model is the source of truth, so trust
     *  is high — second only to official stat APIs. */
    | "vision";
  kind: "reaction" | "play-detail" | "context" | "news" | "stat";
  text: string;
  score: number;
  occurredAt: string;
  refs?: {
    playerId?: string;
    teamId?: string;
    playId?: string;
  };
  /** When the aggregator merges near-duplicates from different sources,
   *  the lower-trust voices fold in here so the prompt can quote them
   *  ("ESPN: …; Reddit also lit up: …"). Empty on first-source items. */
  voices?: Array<{ source: EnrichmentSignal["source"]; text: string }>;
};

/**
 * Prediction-market snapshot. One per outcome (a single yes/no
 * contract). Aggregated from Kalshi + Polymarket; the source field
 * tells the consumer which exchange this came from so the UI can
 * attribute appropriately ("K" / "P" chips).
 *
 * `yesPriceCents` is the implied probability ×100, in [0, 100].
 * Both venues quote in different units natively (Kalshi in dollars
 * 0.00–1.00, Polymarket in midpoint 0.0–1.0); the provider
 * normalizes to cents because that's what humans say on the radio
 * ("Chiefs at 64 cents to win").
 */
export type MarketSnapshot = {
  source: "kalshi" | "polymarket";
  externalId: string;            // Kalshi ticker or Polymarket condition_id
  sport: SportLeague;
  /**
   * Best-effort game association. ESPN game ID when we can match,
   * otherwise undefined — the AI hosts can still cite the market by
   * its title even without a game match. Match logic lives in the
   * marketsProvider, not on the consumers.
   */
  gameId?: string;
  marketKind: "moneyline" | "spread" | "total" | "player-prop" | "futures" | "other";
  /** Human-readable title — what the host should say on-air. */
  title: string;
  /** "Chiefs to win" / "Mahomes over 285 pass yds" / etc. */
  outcomeLabel: string;
  yesPriceCents: number;         // 0..100
  /** Cents change in the last 5 minutes; positive = market warming. */
  recentDeltaCents?: number;
  volume24hUsd?: number;
  /** Wall-clock timestamp the snapshot was sourced from upstream. */
  observedAt: string;
  /**
   * Canonical upstream URL for this market when known. Polymarket
   * uses event slugs (`/event/{slug}`), Kalshi uses event/series
   * tickers (`/markets/{series}/{event}`) — neither maps cleanly from
   * the snapshot's externalId alone, so providers populate this
   * directly from API fields. Undefined means we couldn't construct
   * a reliable URL and the UI should hide the "View on X" CTA.
   */
  marketUrl?: string;
  /**
   * Polymarket CLOB token ID for the YES side. Required by the
   * /prices-history endpoint — the public conditionId can't query
   * history. Populated from event.markets[].clobTokenIds[idx]. Only
   * set on polymarket snapshots; undefined for kalshi (which queries
   * history by ticker via the externalId already).
   */
  clobTokenId?: string;
};

export type MarketHistoryPoint = {
  /** ISO timestamp of the sample. */
  ts: string;
  /** YES-side price in cents (0..100). */
  priceCents: number;
};

export type SportsGameState = {
  provider: string;
  gameId: string;
  sport: SportLeague;
  awayTeam: string;
  homeTeam: string;
  awayMeta?: TeamMeta;
  homeMeta?: TeamMeta;
  status: "scheduled" | "live" | "final" | "demo" | "postponed";
  currentPlay?: SportsPlay;
  recentPlays: SportsPlay[];
  updatedAt: string;
};

export type TeamMeta = {
  abbreviation: string;
  displayName?: string;
  shortName?: string;
  logo?: string;
  color?: string;
  alternateColor?: string;
};

export type SportsGameOption = {
  id: string;
  label: string;
  shortName: string;
  sport: SportLeague;
  awayTeam: string;
  homeTeam: string;
  awayMeta?: TeamMeta;
  homeMeta?: TeamMeta;
  score: {
    away: number;
    home: number;
  };
  status: SportsGameState["status"];
  startsAt?: string;
  detail: string;
  broadcast?: string;
};

export type NewsItem = {
  id: string;
  title: string;
  source: string;
  url?: string;
  publishedAt: string;
  playerIds?: string[];
  team?: string;
};

export type VideoMode = "stream-url" | "screen-share" | "vod";

export type VideoSourceConfig = {
  mode: VideoMode;
  url?: string;
};

export type VideoFrameSnapshot = {
  id: string;
  dataUrl: string;
  capturedAt: string;
  source: VideoMode;
  width: number;
  height: number;
  blockedReason?: string;
};

export type StreamValidation = {
  status: "sports-event" | "not-sports" | "uncertain" | "unavailable";
  confidence: number;
  sport?: "football" | "basketball" | "baseball" | "soccer" | "hockey" | "other";
  evidence: string[];
  reason: string;
  validatedAt: string;
  frameAgeMs?: number;
};

export type VideoObservation = {
  id: string;
  source: VideoMode;
  summary: string;
  confidence: number;
  observedAt: string;
  latencyMs: number;
  validation?: StreamValidation;
  usedFrame?: boolean;
  /** Visible color worth narrating that the play feed can't tell us:
   *  bench reactions, body language, sideline drama, crowd intensity,
   *  fashion. Empty array when the frame is generic (no distinctive
   *  color visible) — the right answer most ticks. The model fills
   *  this when prompted; the VisionEnrichmentProvider consumes it
   *  and emits each entry as an EnrichmentSignal so the producer
   *  can pick visual color as a beat. */
  color?: string[];
};

export type FantasyImpact = {
  rosterId: string;
  ownerName: string;
  teamName: string;
  playerName: string;
  isStarter: boolean;
  pointsDelta: number;
  reason: string;
};

export type MomentCue = {
  priority: "routine" | "notable" | "major" | "interrupt";
  headline: string;
  summary: string;
  reasons: string[];
  targetFriendIds: string[];
  score: number;
};

export type LivecastRequest = {
  providerMode: "demo" | "sleeper" | "espn";
  /**
   * @deprecated The sports backend is derived from `sportsGameId` —
   * `demo-*` ids → demo provider, sport-prefixed ids (`nba-...`, `nfl-...`)
   * → ESPN, `sportradar:` / `sportsdataio:` → paid feeds. Sending this
   * field has no effect; kept on the type for back-compat with serialized
   * old clients only.
   */
  sportsDataMode?: "demo" | "espn";
  sportsGameId?: string;
  sleeperLeagueId?: string;
  espnLeagueId?: string;
  espnSeason?: number;
  week?: number;
  customLeague?: FantasyLeagueState;
  group: GroupSettings;
  video: VideoSourceConfig;
  latestFrame?: VideoFrameSnapshot;
  ttsEnabled: boolean;
  /**
   * Optional per-request TTS provider override. When set, wins over the
   * server's RESOLVED_TTS_PROVIDER for the duration of this show. Lets
   * the listener flip between ElevenLabs / Fish / Inworld at runtime
   * from the UI without an env edit + restart. "auto" / undefined keep
   * the config-resolved default.
   */
  ttsProviderOverride?: "auto" | "elevenlabs" | "fish" | "inworld" | "mock";
  cadenceMs?: number;
  /** Cross-show memory derived from the client's localStorage history. */
  priorContext?: string;
  /**
   * W18: pending listener cues — push-to-talk transcripts the
   * listener has spoken since the last commentary tick. The next
   * draft can fold them in (e.g. "you asked about Mahomes — he's
   * 4-for-7 right now"). Capped client-side to the most recent few.
   */
  listenerCues?: ListenerCue[];
  /**
   * Per-device listener id for the picks feature. When set, the
   * server engine fetches the listener's locked parlay for this
   * gameId and pipes a structured pickContext into the commentary
   * prompt — hosts can then react to "your parlay is 3-of-4 with
   * Mahomes needing 1 more TD" naturally during the show.
   */
  picksListenerId?: string;
  /**
   * Discovery-driven slate mode. When set with 2+ entries, the
   * engine ranks these candidates against the listener's roster +
   * group settings, picks the top entry as the opening game, and
   * auto-pivots to the next ranked entry whenever the current game
   * flips to `final`. The opener acknowledges the slate breadth
   * instead of anchoring on a single matchup. Mutually informative
   * with `sportsGameId` — passing both is allowed; slate wins,
   * `sportsGameId` is ignored.
   *
   * Empty / single-entry arrays fall through to the legacy
   * single-game path (a 1-game "slate" is just a single game).
   */
  slate?: SportsGameOption[];
};

/**
 * A single push-to-talk message captured from the listener and
 * already transcribed by ASR. Lives long enough to ride along on the
 * next LivecastRequest, then is acked by the server.
 */
export type ListenerCue = {
  id: string;
  text: string;
  capturedAt: string;
  /** ASR confidence in [0, 1]; pass through so prompts can hedge. */
  confidence?: number;
};

export type ActiveProviderSummary = {
  fantasy: string;
  sportsData: string;
  news: string;
  /** Comma-joined list of active enrichment providers (Reddit, Bluesky, …)
   *  or "(none)" when no providers are configured. */
  enrichment: string;
  video: string;
  model: string;
  commentary: string;
  tts: string;
};

export type FantasyImportPreview = {
  ok: boolean;
  providerMode: "demo" | "sleeper" | "espn";
  league?: FantasyLeagueState;
  summary?: {
    leagueName: string;
    season: string;
    week: number;
    rosterCount: number;
    matchupCount: number;
    playerCount: number;
    starterCount: number;
    benchCount: number;
    missingRosterNames: number;
    missingPlayerTeams: number;
  };
  readiness: Array<{
    id: string;
    label: string;
    ok: boolean;
    detail: string;
  }>;
  message: string;
};

/**
 * Per-provider availability snapshot the client uses to render the
 * TTS picker. `id` matches LivecastRequest.ttsProviderOverride; `ready`
 * means an API key is configured (so picking it won't silently fall
 * back to mock). `current` is true for the env-resolved default.
 */
export type TtsProviderOption = {
  id: "elevenlabs" | "fish" | "inworld" | "mock";
  label: string;
  ready: boolean;
  current: boolean;
  description: string;
};

export type ProviderDiagnostics = {
  generatedAt: string;
  providers: ActiveProviderSummary;
  health: ProviderHealth[];
  ttsProviderOptions: TtsProviderOption[];
  checks: Array<{
    id: string;
    label: string;
    status: ProviderStatus;
    detail: string;
  }>;
};

export type FrameValidationResponse = {
  observation: VideoObservation;
};

export type HostId = "maya" | "theo" | "cam";

/**
 * Commentary kinds. `opener` is a one-shot emitted at livecast start that
 * addresses the listener and walks their actual lineup. `play` is the
 * normal per-play turn. Recap-style turns can be added later.
 */
export type CommentaryKind = "opener" | "play";

/**
 * One line of multi-speaker dialogue inside a commentary turn. Each
 * line gets TTS'd with the matching host's voice; the client UI renders
 * lines in order with speaker labels. Lines are short — ~100 chars
 * each — so the audio feels like a real conversation, not a montage of
 * paragraphs. The single-host model that preceded this lives on as the
 * degenerate `lines.length === 1` case (used by the local fallback).
 */
export type DialogueLine = {
  hostId: HostId;
  text: string;
};

export type LivecastCommentary = {
  id: string;
  kind: CommentaryKind;
  /** Primary speaker — first host in `lines`. Drives UI accent color + the host-rotation history. */
  hostId: HostId;
  /** Joined transcript across all lines. Kept for clip captions, search, and any non-audio surface. */
  text: string;
  /** Multi-speaker breakdown. Always non-empty; single-host commentary degenerates to one line. */
  lines: DialogueLine[];
  fantasyImpacts: FantasyImpact[];
  moment: MomentCue;
  observation: VideoObservation;
  play: SportsPlay;
  createdAt: string;
  latency: LatencyMetrics;
  /** Audio-synced entity mentions for the live transcript panel.
   *  Server-extracted at TTS time from the turn text + wordTimings:
   *  when the audio passes a cue's `startMs`, the client surfaces a
   *  small chip (player headshot, market price, listener stake) for
   *  ~3-4 seconds. One entry per mention per turn. */
  mentionCues?: MentionCue[];
  /** Source kinds the producer's beats drew on for this turn —
   *  ["enrichment", "market", "play"] etc. Surfaced in the
   *  transcript so listeners can see which signals informed the
   *  hosts. Empty / absent when the producer wasn't used (legacy
   *  raw-input path) or the show is in a fallback state. */
  producerBeats?: string[];
  /** Show-arc position when this turn fired (cold-open / climax /
   *  pivot / etc.). Surfaces in the transcript as an act-marker. */
  arcPosition?: string;
};

/**
 * Entity mention surfaced in the live transcript panel. Each cue is a
 * single moment in a turn's audio where a tracked entity is named.
 * The client uses `lineIndex` + `startMs` (relative to that line's
 * audio start) to time the chip's appearance.
 */
export type MentionCue = {
  id: string;
  /** Which line (turn) of the commentary this mention occurs in. */
  lineIndex: number;
  /** Start time within the line's audio (ms). */
  startMs: number;
  /** What kind of entity this is — drives which chip variant the client renders. */
  entityType: "player" | "team" | "market-source" | "listener-stake";
  /** Stable id for the entity. Player id, team abbreviation, market source name, or "self". */
  entityId: string;
  /** Display label — player name, team short name, etc. */
  label: string;
  /** Optional small accessory (price in cents for markets, stat line for players). */
  detail?: string;
  /** Optional image URL — player headshot or team logo. */
  imageUrl?: string;
  /** Optional brand color (hex without #) for chip accent. */
  accentColor?: string;
};

export type LatencyMetrics = {
  videoIngestMs: number;
  modelResponseMs: number;
  textGenerationMs: number;
  ttsFirstAudioMs?: number;
  endToEndMs: number;
};

/**
 * Word-level audio timing for the live transcript. Each entry is one
 * token (word, punctuation, or whitespace) with its millisecond start
 * and end relative to the start of THIS chunk's audio. The client uses
 * these to paint a karaoke-style transcript (current word emphasized,
 * past dimmed) and to fire mention chips when the audio crosses a
 * specific word's startMs.
 *
 * Providers that don't return timestamps (ElevenLabs flash, Fish, mock)
 * simply omit `wordTimings` and the client falls back to a non-synced
 * transcript treatment.
 */
export type WordTiming = {
  /** The exact token as it appears in the synthesized text. May be a
   *  word, a punctuation mark, or whitespace. Preserved verbatim so
   *  client-side rendering can rebuild the original string by joining
   *  in order. */
  text: string;
  /** Start of this token within the chunk's audio (ms, 0-based). */
  startMs: number;
  /** End of this token within the chunk's audio (ms). */
  endMs: number;
};

export type TTSAudioChunk = {
  id: string;
  commentaryId: string;
  provider: string;
  mimeType: string;
  base64Audio?: string;
  isFinal: boolean;
  latencyMs: number;
  /** Which turn in the multi-turn commentary this chunk belongs to (0-based).
   *  The client uses this to swap the on-screen transcript to the
   *  currently-spoken turn — so the listener never sees a turn that
   *  hasn't started playing yet. Optional for backward compatibility
   *  with mock/test providers that don't track turns. */
  lineIndex?: number;
  /** Host speaking this turn. Mirrors DialogueLine.hostId so the client
   *  doesn't need to cross-reference the commentary object when rendering. */
  lineHostId?: HostId;
  /** Per-word timings for the audio in this chunk. When present the
   *  client renders an audio-synced "live transcript" panel; when
   *  absent (provider doesn't support it) the client falls back to a
   *  static transcript. See WordTiming. */
  wordTimings?: WordTiming[];
  /** Entity mentions found in the corresponding line's text and timed
   *  via wordTimings. Server-extracted at TTS time and attached to
   *  the audio chunk so the client can fire mention chips as the
   *  audio crosses each cue's startMs. */
  mentionCues?: MentionCue[];
};

export type ClientServerEvent =
  | { type: "snapshot"; fantasy: FantasyLeagueState; game: SportsGameState; health: ProviderHealth[]; providers: ActiveProviderSummary }
  | { type: "play"; play: SportsPlay; game: SportsGameState }
  | { type: "commentary"; commentary: LivecastCommentary }
  | { type: "observation"; observation: VideoObservation }
  | { type: "tts"; audio: TTSAudioChunk }
  | { type: "health"; health: ProviderHealth[] }
  | { type: "status"; message: string; level: "info" | "warn" }
  /**
   * W18: server confirms it folded one or more cues into the most
   * recent commentary turn. The UI uses these ids to clear them
   * from the "queued cues" indicator.
   */
  | { type: "cue-ack"; cueIds: string[]; commentaryId: string }
  /**
   * Markets just moved meaningfully on this game. The persona prompt
   * is also being instructed to lead with this swing in the next
   * turn, so the UI can flash the ticker entry to mirror the call.
   * Source / outcome let the client identify which ticker row to
   * highlight; deltaCents + direction drive the visual treatment.
   */
  | {
      type: "market-swing";
      source: "kalshi" | "polymarket";
      externalId: string;
      title: string;
      outcome: string;
      fromCents: number;
      toCents: number;
      deltaCents: number;
      direction: "warming" | "cooling";
    }
  | { type: "error"; message: string };

export interface FantasyProvider {
  id: string;
  getLeagueState(input: { leagueId?: string; week?: number; season?: number }): Promise<FantasyLeagueState>;
  health(): Promise<ProviderHealth>;
}

export interface SportsDataProvider {
  id: string;
  getGameState(): Promise<SportsGameState>;
  nextPlay(): Promise<SportsPlay>;
  health(): Promise<ProviderHealth>;
}

/**
 * A single archived show. Written by the client when a show transitions
 * to the recap phase; the server-side W8 history backend stores these
 * per-listener so they survive device switches.
 */
export type ShowHistoryEntry = {
  id: string;
  startedAt: string;
  endedAt: string;
  sport: SportLeague;
  gameId: string;
  gameLabel: string;
  listenerName: string;
  listenerTeamName?: string;
  finalScore?: { away: number; home: number };
  topMoment?: { playerName: string; pointsDelta: number; hostText: string };
  marginShift?: number;
  totalCommentary: number;
};

export type GameOdds = {
  gameId: string;
  sport: SportLeague;
  /** Home team abbreviation (matches SportsGameOption.homeTeam). */
  homeTeam: string;
  /** Away team abbreviation. */
  awayTeam: string;
  /** Spread in points; positive = home favored, negative = away favored. */
  spread?: number;
  /** Over/under total. */
  total?: number;
  /** Moneyline pair. */
  moneyline?: { home?: number; away?: number };
  /** Direction the spread has moved since open: "home" / "away" / "stable". */
  movement?: "home" | "away" | "stable";
  /** Sportsbook the line came from (display only). */
  book?: string;
  fetchedAt: string;
};

/**
 * Beat-writer-grade analytics for a single player. Used by W12 to give
 * the persona prompts (especially Maya, the analyst voice) something
 * substantive to cite beyond raw fantasy points. All fields optional —
 * a partial record is still useful if e.g. EPA isn't available for
 * non-NFL sports.
 */
export type PlayerSeasonStats = {
  /** Canonical (Sleeper-namespace) player id. */
  canonicalId: string;
  name: string;
  sport: SportLeague;
  /** Season the stats apply to (e.g. "2025"). */
  season: string;
  position?: string;
  team?: string;
  snapPercent?: number;
  /** Estimated points added per play / drive — NFL/NCAAF. */
  epaPerPlay?: number;
  /** Defense-adjusted Value Over Average (Football Outsiders) — NFL only. */
  dvoa?: number;
  /** Target share for receivers / RBs (0–1). */
  targetShare?: number;
  /** Touches per game (RB) / receptions per game (WR/TE). */
  usagePerGame?: number;
  /** Fantasy points per game. */
  pointsPerGame?: number;
  /** Most recent meaningful trend, plain prose ("3-game heater," "QB1 last week"). */
  note?: string;
};

export interface AdvancedStatsProvider {
  id: string;
  /**
   * Look up season-to-date stats for a list of canonical player ids.
   * Players without a record are silently dropped — the LLM should
   * never cite a stat we don't have.
   */
  getPlayerSeason(input: { canonicalIds: string[]; sport: SportLeague; season?: string }): Promise<PlayerSeasonStats[]>;
  health(): Promise<ProviderHealth>;
}

export interface OddsProvider {
  id: string;
  /**
   * Fetch the current line for a specific game. Some providers identify
   * games by team pairing rather than provider id, so callers pass both.
   */
  getOdds(input: { gameId: string; sport: SportLeague; homeTeam: string; awayTeam: string }): Promise<GameOdds | undefined>;
  health(): Promise<ProviderHealth>;
}

export interface NewsProvider {
  id: string;
  /**
   * Latest news items relevant to the given players/teams. `sport` is
   * optional but lets sport-aware providers tailor copy (NFL: snap
   * counts; NBA: minutes; MLB: pitcher matchups, etc.).
   */
  getLatest(input: { playerIds: string[]; teams: string[]; sport?: SportLeague }): Promise<NewsItem[]>;
  health(): Promise<ProviderHealth>;
}

export interface VideoSourceProvider {
  id: string;
  observe(input: VideoSourceConfig): Promise<VideoObservation>;
  health(): Promise<ProviderHealth>;
}

export interface MultimodalModelProvider {
  id: string;
  observe(input: { video: VideoSourceConfig; play: SportsPlay; frame?: VideoFrameSnapshot }): Promise<VideoObservation>;
  health(): Promise<ProviderHealth>;
}

/**
 * A short slice of broadcast or microphone audio captured client-side
 * (MediaRecorder) or extracted server-side. Sent to ASR providers.
 *
 * `dataUrl` is the canonical transport — base64 keeps the route
 * handler stateless and survives a JSON round-trip. We accept short
 * (≤30s) chunks; longer audio gets split client-side so each request
 * fits under the 8 MB body limit.
 */
export type AudioClip = {
  id: string;
  capturedAt: string;
  /** Source of the audio — used for prompt selection + UI labelling. */
  source: "broadcast" | "microphone";
  /** Mime type returned by MediaRecorder, e.g. "audio/webm;codecs=opus". */
  mimeType: string;
  /** "data:audio/webm;base64,..." */
  dataUrl: string;
  /** Best-effort wall-clock duration. */
  durationMs?: number;
  /** Source-specific note, e.g. screen-share tab title or mic device label. */
  label?: string;
};

export type AsrWord = {
  text: string;
  /** Start offset within the clip, in milliseconds. */
  startMs: number;
  endMs: number;
  /** Provider-reported per-word confidence in [0, 1] when available. */
  confidence?: number;
};

export type AsrTranscript = {
  id: string;
  /** Plain-text transcript with normal casing + light punctuation. */
  text: string;
  /** Optional word-level timing — Nemotron Nano Omni emits these natively. */
  words?: AsrWord[];
  /** Detected spoken language tag, e.g. "en". */
  language?: string;
  /** Aggregate provider confidence in [0, 1]. */
  confidence?: number;
  /** Provider id that produced the transcript. */
  provider: string;
  observedAt: string;
  latencyMs: number;
  /** Raw provider response when debugging is helpful. */
  raw?: unknown;
};

export interface AsrProvider {
  id: string;
  /**
   * Transcribe a single short audio clip. Pass `play` so the prompt
   * can bias the model toward the right roster names + game state.
   */
  transcribe(input: { audio: AudioClip; play?: SportsPlay }): Promise<AsrTranscript>;
  health(): Promise<ProviderHealth>;
}

export interface TTSProvider {
  id: string;
  /**
   * Stream audio chunks for the given text. `hostId` lets the provider
   * route to a per-host voice when configured; providers that don't
   * support per-host voices ignore it.
   */
  synthesize(input: { commentaryId: string; text: string; hostId?: HostId }): AsyncIterable<TTSAudioChunk>;
  /**
   * Optional purpose-built multi-speaker generation. When implemented,
   * the engine sends ALL turns in a single call and gets back one
   * seamless audio asset with natural turn-taking + pacing handled by
   * the model (ElevenLabs Text-to-Dialogue). Providers without this
   * capability omit the method and the engine falls back to per-line
   * `synthesize` calls.
   */
  synthesizeDialogue?(input: {
    commentaryId: string;
    turns: Array<{ text: string; hostId?: HostId }>;
  }): Promise<TTSAudioChunk>;
  health(): Promise<ProviderHealth>;
}
