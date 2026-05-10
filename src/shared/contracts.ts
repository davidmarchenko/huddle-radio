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
  cadenceMs?: number;
  /** Cross-show memory derived from the client's localStorage history. */
  priorContext?: string;
};

export type ActiveProviderSummary = {
  fantasy: string;
  sportsData: string;
  news: string;
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

export type ProviderDiagnostics = {
  generatedAt: string;
  providers: ActiveProviderSummary;
  health: ProviderHealth[];
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

export type LivecastCommentary = {
  id: string;
  kind: CommentaryKind;
  hostId: HostId;
  text: string;
  fantasyImpacts: FantasyImpact[];
  moment: MomentCue;
  observation: VideoObservation;
  play: SportsPlay;
  createdAt: string;
  latency: LatencyMetrics;
};

export type LatencyMetrics = {
  videoIngestMs: number;
  modelResponseMs: number;
  textGenerationMs: number;
  ttsFirstAudioMs?: number;
  endToEndMs: number;
};

export type TTSAudioChunk = {
  id: string;
  commentaryId: string;
  provider: string;
  mimeType: string;
  base64Audio?: string;
  isFinal: boolean;
  latencyMs: number;
};

export type ClientServerEvent =
  | { type: "snapshot"; fantasy: FantasyLeagueState; game: SportsGameState; health: ProviderHealth[]; providers: ActiveProviderSummary }
  | { type: "play"; play: SportsPlay; game: SportsGameState }
  | { type: "commentary"; commentary: LivecastCommentary }
  | { type: "observation"; observation: VideoObservation }
  | { type: "tts"; audio: TTSAudioChunk }
  | { type: "health"; health: ProviderHealth[] }
  | { type: "status"; message: string; level: "info" | "warn" }
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
  health(): Promise<ProviderHealth>;
}
