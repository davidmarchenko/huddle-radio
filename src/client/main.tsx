"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActiveProviderSummary,
  ClientServerEvent,
  FantasyImportPreview,
  FantasyImpact,
  FantasyLeagueState,
  FantasyPlayer,
  FrameValidationResponse,
  FantasyRoster,
  GameOdds,
  GroupSettings,
  HostId,
  ListenerCue,
  LivecastCommentary,
  MarketSnapshot,
  NewsItem,
  ProviderDiagnostics,
  ProviderHealth,
  SportLeague,
  SportsGameOption,
  SportsGameState,
  SportsPlay,
  StreamValidation,
  VideoFrameSnapshot,
  VideoMode
} from "../shared/contracts";
import {
  createMediaLookupIndex,
  mediaAssetUrl,
  resolvePlayerMedia,
  resolveTeamMedia,
  type CachedMediaAsset,
  type MediaCacheManifest,
  type MediaLookupIndex
} from "../shared/mediaManifest";
import type { ModelStackProfile } from "../shared/modelStack";
import { HOST_PERSONAS } from "../shared/hostPersonas";
import { buildProductReadiness } from "../shared/productReadiness";
import { buildSessionDirector, type SessionDirectorPlan, type SessionDirectorStepState } from "../shared/sessionDirector";
import { buildTranscriptExport } from "../shared/transcriptExport";
import { createYouTubeEmbedUrl, isYouTubeUrl } from "../shared/videoLinks";
import { pickRelevantMarketsForGame } from "../shared/marketsRelevance";
import { startMicRecording, type MicRecording } from "./audioCapture";
import { closeSession, sendCue, sendFrame, sendNudge, startLiveSession } from "./liveSession";
import { claimShowLeadership, newTabId, watchForLeadershipChange } from "./showLeader";
import { DebugPanel } from "./DebugPanel";
import { demoLeagueState, demoLeagues } from "../providers/demoData";
import {
  applyProfileToGroup,
  buildPriorContext,
  formatRelativeTime,
  sportNounForContext,
  type LeagueClaim,
  type ShowHistoryEntry,
  type UserProfile
} from "./profileMemory";
import {
  HUDDLE_HOSTS,
  buildFantasySpotlight,
  buildFriendMatchups,
  buildHostTurns,
  buildListenerGameSpotlights,
  buildListenerRecapHighlight,
  buildListenerStakes,
  buildMatchupStory,
  buildRecapSummary,
  buildTonightAtAGlance,
  buildSetupSteps,
  deriveHuddlePhase,
  showHasStream,
  type HuddleHostTurn,
  type HuddlePhase,
  type HuddleSetupStep
} from "./huddleViewModel";

const defaultGroup: GroupSettings = {
  listener: { name: "Alex", rosterId: "roster-alex", favoriteTeam: "KC" },
  tone: "pg",
  homeTeamBias: "fantasy-first",
  friends: [
    { id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex", rivalryNotes: "you are one Kelce catch away from unbearable confidence" },
    { id: "maya", name: "Maya", favoriteTeam: "DET", rosterId: "roster-maya", rivalryNotes: "do not pretend you were calm during that drive" }
  ]
};

// Profile + multi-sport identity primitives live in profileMemory so the
// pure helpers (applyProfileToGroup, buildPriorContext) can be unit-tested
// without touching React.

type PersistedSettings = {
  providerMode?: "demo" | "sleeper" | "espn";
  sportsDataMode?: "demo" | "espn";
  sportsGameId?: string;
  sleeperLeagueId?: string;
  espnLeagueId?: string;
  espnSeason?: number;
  week?: number;
  cadenceSeconds?: number;
  videoMode?: VideoMode;
  videoUrl?: string;
  ttsEnabled?: boolean;
  speechRate?: number;
  group?: GroupSettings;
  customLeagueJson?: string;
  showAdvanced?: boolean;
  profile?: UserProfile;
  profileNudgeDismissed?: boolean;
  pastShows?: ShowHistoryEntry[];
};

type SetupPane = "league" | "stream" | "friends" | "voice" | "diagnostics";

const defaultProviderSummary: ActiveProviderSummary = {
  fantasy: "Demo Fantasy",
  sportsData: "Demo Sports Data",
  news: "Demo News",
  video: "User Video Source",
  model: "Mock Multimodal Model",
  commentary: "Local Commentary",
  tts: "Mock/Browser TTS"
};

const persisted = loadPersistedSettings();
const listenerId = getOrCreateListenerId();

function App() {
  const [providerMode, setProviderMode] = useState<"demo" | "sleeper" | "espn">(persisted.providerMode ?? "demo");
  // Default to live ESPN so the discover feed shows real NFL games out
  // of the box. The public ESPN scoreboard needs no auth. Users can
  // still flip to "Demo" via the chip toggle for scripted predictable
  // playback during testing.
  const [sportsDataMode, setSportsDataMode] = useState<"demo" | "espn">(persisted.sportsDataMode ?? "espn");
  const [sportsGameId, setSportsGameId] = useState(persisted.sportsGameId ?? "");
  const [sleeperLeagueId, setSleeperLeagueId] = useState(persisted.sleeperLeagueId ?? "");
  const [espnLeagueId, setEspnLeagueId] = useState(persisted.espnLeagueId ?? "");
  const [espnSeason, setEspnSeason] = useState(persisted.espnSeason ?? new Date().getFullYear());
  const [week, setWeek] = useState(persisted.week ?? 7);
  // 10s default: lines up with the multi-speaker turn length so audio
  // playback keeps pace with commentary generation. Listener can dial
  // faster (3s) or slower (15s) via the cadence slider; tighter than
  // ~6s starts queuing audio because each turn is ~8-12s of speech.
  const [cadenceSeconds, setCadenceSeconds] = useState(persisted.cadenceSeconds ?? 10);
  const [videoMode, setVideoMode] = useState<VideoMode>(persisted.videoMode ?? "stream-url");
  const [videoUrl, setVideoUrl] = useState(persisted.videoUrl ?? "");
  const [videoNotice, setVideoNotice] = useState(() => initialVideoNotice(persisted.videoUrl));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [setupPane, setSetupPane] = useState<SetupPane>("league");
  // Always start with TTS on. A previous "demo rehearsal" path
  // wrote `ttsEnabled: false` into localStorage for many users, which
  // silently disabled audio across subsequent sessions. Force-default
  // to true so the audio path always engages; users can still toggle
  // off via the checkbox during the session if needed.
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [speechRate, setSpeechRate] = useState(persisted.speechRate ?? 1);
  const [group, setGroup] = useState<GroupSettings>(normalizeGroupSettings(persisted.group));
  const [profile, setProfile] = useState<UserProfile | undefined>(persisted.profile);
  const [profileNudgeDismissed, setProfileNudgeDismissed] = useState(persisted.profileNudgeDismissed ?? false);
  // Multi-session memory: archived shows so the listener has continuity
  // across sessions (sidebar history + cross-show LLM context).
  const [pastShows, setPastShows] = useState<ShowHistoryEntry[]>(persisted.pastShows ?? []);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [profileEditorIntent, setProfileEditorIntent] = useState<ProfileModalIntent>("edit");
  const [pendingRosterClaim, setPendingRosterClaim] = useState(false);
  const [fantasy, setFantasyState] = useState<FantasyLeagueState>();
  // Multi-sport: every league the user has connected, indexed by sport.
  // `fantasy` stays as the "active league" for the live show context;
  // `connectedLeagues` accumulates across sports so spotlights and the
  // discover landing can aggregate everywhere the user has roster equity.
  const [connectedLeagues, setConnectedLeagues] = useState<FantasyLeagueState[]>([]);
  const setFantasy = useCallback((league: FantasyLeagueState | undefined) => {
    setFantasyState(league);
    if (league) {
      setConnectedLeagues((current) => {
        const filtered = current.filter((entry) => entry.sport !== league.sport);
        return [...filtered, league];
      });
    }
  }, []);
  const [customLeague, setCustomLeague] = useState<FantasyLeagueState | undefined>(() => parseCustomLeague(persisted.customLeagueJson).league);
  const [customLeagueJson, setCustomLeagueJson] = useState(persisted.customLeagueJson ?? JSON.stringify(demoLeagueState, null, 2));
  const [customLeagueError, setCustomLeagueError] = useState("");
  const [game, setGame] = useState<SportsGameState>();
  const [sportsGames, setSportsGames] = useState<SportsGameOption[]>([]);
  const [sportsGamesStatus, setSportsGamesStatus] = useState("Games load with the selected data source.");
  // Sports whose ESPN scoreboard fetch failed on the last refresh.
  // Surfaced as a discover-page notice so missing games aren't silent.
  const [failedSports, setFailedSports] = useState<Array<{ sport: SportLeague; label: string }>>([]);
  // Per-set dismissal: keyed by the sorted list of failing sport IDs,
  // so dismissing one set of failures doesn't suppress later notices
  // about a different set.
  const [dismissedFailedSportsKey, setDismissedFailedSportsKey] = useState<string>("");
  // Pregame storylines fetched fresh per game pick. Empty until a game
  // is selected; refreshed when sport/teams change.
  const [pregameNews, setPregameNews] = useState<NewsItem[]>([]);
  // Vegas line for the picked game. Undefined until a real game is
  // picked AND the server has THE_ODDS_API_KEY configured.
  const [pregameOdds, setPregameOdds] = useState<GameOdds | undefined>(undefined);
  const [plays, setPlays] = useState<SportsPlay[]>([]);
  const [commentary, setCommentary] = useState<LivecastCommentary[]>([]);
  const [ttsLatencyByCommentary, setTtsLatencyByCommentary] = useState<Record<string, number>>({});
  /** Which turn within each commentary is currently being spoken. Drives
   *  the on-screen transcript so we never show a turn that hasn't
   *  started playing — fixes the "user sees the script for unspoken
   *  thoughts" problem. Key: commentary.id, value: lineIndex of the
   *  active turn (the latest one whose audio has started). */
  const [activeTurnByCommentary, setActiveTurnByCommentary] = useState<Record<string, number>>({});
  // Pick the text the listener is hearing right now for a given
  // commentary. Falls back to the first turn until audio starts (the
  // server stamps every TTS chunk with its turn index; the dispatcher
  // bumps activeTurnByCommentary as each turn's audio lands). Used by
  // every surface that captions the show — the player card, the live
  // rail, the feed rows — so nothing leaks a script of unspoken thoughts.
  const displayedTurnText = useCallback(
    (item: LivecastCommentary | undefined): string | undefined => {
      if (!item) return undefined;
      const turns = item.lines && item.lines.length > 0 ? item.lines : undefined;
      if (!turns) return item.text;
      const idx = Math.min(activeTurnByCommentary[item.id] ?? 0, turns.length - 1);
      return turns[idx]?.text ?? item.text;
    },
    [activeTurnByCommentary]
  );
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [providers, setProviders] = useState<ActiveProviderSummary>(defaultProviderSummary);
  const [mediaManifest, setMediaManifest] = useState<MediaCacheManifest>();
  const [mediaStatus, setMediaStatus] = useState("Loading media cache");
  const [importPreview, setImportPreview] = useState<FantasyImportPreview>();
  const [diagnostics, setDiagnostics] = useState<ProviderDiagnostics>();
  const [modelStack, setModelStack] = useState<ModelStackProfile>();
  const [importStatus, setImportStatus] = useState("Ready to validate");
  const [frameCaptureStatus, setFrameCaptureStatus] = useState("Frame validation waits for livecast start.");
  const [lastObservation, setLastObservation] = useState<LivecastCommentary["observation"]>();
  // Most recent market-swing event from the server. The MarketsTicker
  // uses its externalId to flash the matching row in sync with the
  // host leading with that swing on-air.
  const [lastMarketSwing, setLastMarketSwing] = useState<{ source: string; externalId: string; deltaCents: number; emittedAt: number } | undefined>();
  const [status, setStatus] = useState("Idle");
  const [livecastActive, setLivecastActive] = useState(false);
  const [showPrepared, setShowPrepared] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  // viewingHome decouples "what the user is looking at" from "is a
  // livecast running". Lets users return to discover while a show
  // continues playing in a floating mini-player. Initial value reads
  // the URL so deep-linking to /watch/{id} works.
  const [viewingHome, setViewingHome] = useState(() => !window.location.pathname.startsWith("/watch"));
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioLevels, setAudioLevels] = useState(WAVEFORM_BARS);
  const [formError, setFormError] = useState("");
  const [screenStream, setScreenStream] = useState<MediaStream>();
  const liveSessionRef = useRef<import("./liveSession").LiveSessionHandle | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioQueueRef = useRef<Promise<void>>(Promise.resolve());
  // W9: per-commentary audio capture for clip archival. Keyed by
  // commentary id; each value is the ordered list of base64 chunks the
  // server streamed via TTS events. Bounded so a long show with mock
  // TTS doesn't bloat memory — only commentaries with actual audio
  // bytes get stored.
  const clipChunksRef = useRef<Map<string, { mimeType: string; chunks: string[] }>>(new Map());
  const frameTimerRef = useRef<number | undefined>(undefined);
  const livecastSessionRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  // Stable per-page-load tab id for cross-tab leader election. Sticks
  // for the lifetime of this document; reloads mint a new one (which
  // is correct — the post-reload session must displace the pre-reload
  // one since the engine for it is also stranded).
  const tabIdRef = useRef<string>(newTabId());

  const closeDrawer = useCallback(() => setShowAdvanced(false), []);
  useDialogA11y(showAdvanced, drawerRef, closeDrawer);

  // Cross-tab leader election: if another tab in this browser starts
  // a show after this one, that tab broadcasts a takeover and we
  // close our session so two engines don't race + double-bill TTS.
  useEffect(() => {
    return watchForLeadershipChange(tabIdRef.current, () => {
      const handle = liveSessionRef.current;
      if (!handle) return;
      console.log("[huddle.leader] usurped by another tab — closing this session");
      void closeSession(handle);
      liveSessionRef.current = null;
      setLivecastActive(false);
      setStatus("Show moved to another tab");
    });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({
      providerMode,
      sportsDataMode,
      ...(sportsGameId ? { sportsGameId } : {}),
      ...(providerMode === "sleeper" && sleeperLeagueId ? { sleeperLeagueId, week: String(week) } : {}),
      ...(providerMode === "espn" && espnLeagueId ? { espnLeagueId, espnSeason: String(espnSeason), week: String(week) } : {})
    });
    void fetch(`/api/bootstrap?${params.toString()}`)
      .then((response) => response.json())
      .then((payload) => {
        if (payload.fantasy) setFantasy(payload.fantasy);
        if (payload.game) setGame(payload.game);
        if (!persisted.group && payload.group?.friends) setGroup(payload.group);
        setHealth(Array.isArray(payload.health) ? payload.health : []);
        setProviders(payload.providers ?? defaultProviderSummary);
      })
      .catch(() => setStatus("Backend unavailable"));
  }, []);

  useEffect(() => {
    void refreshMediaManifest();
    void refreshDiagnostics();
    void refreshModelStack();
  }, []);

  useEffect(() => {
    savePersistedSettings({
      providerMode,
      sportsDataMode,
      sportsGameId,
      sleeperLeagueId,
      espnLeagueId,
      espnSeason,
      week,
      cadenceSeconds,
      videoMode,
      videoUrl,
      ttsEnabled,
      speechRate,
      group,
      customLeagueJson,
      showAdvanced,
      profile,
      profileNudgeDismissed,
      pastShows
    });
  }, [providerMode, sportsDataMode, sportsGameId, sleeperLeagueId, espnLeagueId, espnSeason, week, cadenceSeconds, videoMode, videoUrl, ttsEnabled, speechRate, group, customLeagueJson, showAdvanced, profile, profileNudgeDismissed, pastShows]);

  useEffect(() => {
    void refreshSportsGames(sportsDataMode);
  }, [sportsDataMode]);

  // Connect → claim flow: if the user just connected a league via the
  // profile modal, reopen the modal focused on the roster picker once
  // the new league state lands. Resets the flag so it only fires once.
  useEffect(() => {
    if (pendingRosterClaim && fantasy && fantasy.matchups.some((m) => m.rosters.length > 0)) {
      setProfileEditorIntent("sync");
      setProfileEditorOpen(true);
      setPendingRosterClaim(false);
    }
  }, [pendingRosterClaim, fantasy]);

  // Sync viewingHome with browser back/forward navigation.
  useEffect(() => {
    const handlePopState = () => {
      const onWatchRoute = window.location.pathname.startsWith("/watch");
      setViewingHome(!onWatchRoute);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!videoRef.current) return;
    if (videoMode === "screen-share" && screenStream) {
      videoRef.current.srcObject = screenStream;
      return;
    }
    videoRef.current.srcObject = null;
    if (isYouTubeUrl(videoUrl)) {
      videoRef.current.removeAttribute("src");
    } else if ((videoMode === "stream-url" || videoMode === "vod") && videoUrl) {
      videoRef.current.src = videoUrl;
    } else {
      videoRef.current.removeAttribute("src");
    }
  }, [screenStream, videoMode, videoUrl]);

  const topImpacts = useMemo(() => commentary[0]?.fantasyImpacts ?? [], [commentary]);
  const momentBoard = useMemo(() => commentary.map((item) => item.moment).filter((moment) => moment.priority !== "routine").slice(0, 5), [commentary]);
  const mediaIndex = useMemo(() => createMediaLookupIndex(mediaManifest), [mediaManifest]);
  const youtubeEmbedUrl = useMemo(() => (videoMode === "screen-share" ? undefined : createYouTubeEmbedUrl(videoUrl)), [videoMode, videoUrl]);
  const hasVideoSource = videoMode === "screen-share" ? Boolean(screenStream) : Boolean(videoUrl);
  const isLive = livecastActive;
  const usingMockTts = health.some((item) => item.id === "mock-tts");
  const rosterOptions = useMemo(
    () => fantasy?.matchups.flatMap((matchup) => matchup.rosters.map((roster) => ({ id: roster.id, label: `${roster.ownerName} - ${roster.teamName}` }))) ?? [],
    [fantasy]
  );
  const matchupTotals = useMemo(
    () =>
      fantasy?.matchups[0]?.rosters.map((roster) => ({
        id: roster.id,
        ownerName: roster.ownerName,
        teamName: roster.teamName,
        team: rosterPrimaryTeam(roster, group),
        points: [...roster.starters].reduce((total, player) => total + player.currentPoints, 0)
      })) ?? [],
    [fantasy, group]
  );
  const leadingRoster = useMemo(() => [...matchupTotals].sort((left, right) => right.points - left.points)[0], [matchupTotals]);
  const trailingRoster = useMemo(() => [...matchupTotals].sort((left, right) => left.points - right.points)[0], [matchupTotals]);
  const playerSpotlight = useMemo(() => {
    const players = fantasy?.matchups.flatMap((matchup) => matchup.rosters.flatMap((roster) => roster.starters.map((player) => ({ ...player, ownerName: roster.ownerName })))) ?? [];
    const teamsInGame = game ? new Set([game.awayTeam, game.homeTeam]) : undefined;
    const eligible = teamsInGame ? players.filter((player) => teamsInGame.has(player.proTeam)) : players;
    return eligible.sort((left, right) => right.currentPoints - left.currentPoints)[0];
  }, [fantasy, game]);
  const averageLatency = useMemo(() => {
    if (commentary.length === 0) return undefined;
    const totals = commentary.reduce(
      (acc, item) => {
        acc.model += item.latency.modelResponseMs;
        acc.endToEnd += item.latency.endToEndMs;
        const tts = ttsLatencyByCommentary[item.id];
        if (tts !== undefined) {
          acc.tts += tts;
          acc.ttsCount += 1;
        }
        return acc;
      },
      { model: 0, endToEnd: 0, tts: 0, ttsCount: 0 }
    );
    return {
      model: Math.round(totals.model / commentary.length),
      endToEnd: Math.round(totals.endToEnd / commentary.length),
      tts: totals.ttsCount ? Math.round(totals.tts / totals.ttsCount) : undefined
    };
  }, [commentary, ttsLatencyByCommentary]);
  const dataModeText = `Session: fantasy ${providers.fantasy}; sports ${providers.sportsData}; commentary ${providers.commentary}; voice ${providers.tts}.`;
  const productReadiness = useMemo(
    () =>
      buildProductReadiness({
        fantasy,
        group,
        providers,
        health,
        modelStack,
        streamValidation: lastObservation?.validation,
        ttsEnabled,
        hasVideoSource,
        mediaCacheReady: Boolean(mediaManifest)
      }),
    [fantasy, group, providers, health, modelStack, lastObservation, ttsEnabled, hasVideoSource, mediaManifest]
  );
  const producerBrief = useMemo(
    () => buildProducerBrief({ fantasy, group, game, providers, readinessLevel: productReadiness.level, validation: lastObservation?.validation }),
    [fantasy, group, game, providers, productReadiness.level, lastObservation]
  );
  const directorPlan = useMemo(
    () =>
      buildSessionDirector({
        readiness: productReadiness,
        providers,
        fantasy,
        game,
        group,
        streamValidation: lastObservation?.validation,
        isLive,
        commentaryCount: commentary.length,
        playCount: plays.length,
        averageLatency
      }),
    [productReadiness, providers, fantasy, game, group, lastObservation, isLive, commentary.length, plays.length, averageLatency]
  );
  const huddlePhase = useMemo(
    () =>
      deriveHuddlePhase({
        showPrepared,
        isLive,
        hasVideoSource: showHasStream(videoMode, hasVideoSource),
        commentaryCount: commentary.length,
        gameStatus: game?.status
      }),
    [showPrepared, isLive, videoMode, hasVideoSource, commentary.length, game?.status]
  );
  useEffect(() => {
    document.querySelector(".huddle-main")?.scrollTo({ top: 0, behavior: "smooth" });
  }, [huddlePhase]);
  // Track when the current live session began so the archive entry can
  // record duration / start timestamp.
  const showStartRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (huddlePhase === "live" || huddlePhase === "live-audio") {
      if (!showStartRef.current) showStartRef.current = new Date().toISOString();
    }
  }, [huddlePhase]);
  const archivedShowRef = useRef<string | undefined>(undefined);
  const pregameReadiness = useMemo(() => {
    const leagueConnected =
      (providerMode === "sleeper" && sleeperLeagueId.trim().length > 0) ||
      (providerMode === "espn" && espnLeagueId.trim().length > 0);
    // "Stream picked" only counts when the user has *actively* picked
    // something. The bootstrap call hydrates a default demo game, so
    // checking `game` alone gives a false positive.
    const streamPicked = hasVideoSource || sportsGameId.trim().length > 0;
    const requirements = [
      {
        id: "league",
        label:
          providerMode === "sleeper"
            ? "Connect your Sleeper league"
            : providerMode === "espn"
              ? "Connect your ESPN league"
              : "Connect a fantasy account",
        met: leagueConnected
      },
      {
        id: "stream",
        label: "Pick a game, stream URL, or screen share",
        met: streamPicked
      }
    ];
    const canStart = demoMode || requirements.every((req) => req.met);
    return { canStart, requirements };
  }, [providerMode, sleeperLeagueId, espnLeagueId, hasVideoSource, sportsGameId, demoMode]);

  const setupSteps = useMemo(
    () => buildSetupSteps({ providerMode, sportsDataMode, hasVideoSource, friendCount: group.friends.length }),
    [providerMode, sportsDataMode, hasVideoSource, group.friends.length]
  );
  const hostTurns = useMemo(() => buildHostTurns({ commentary, game, group }), [commentary, game, group]);
  const matchupStory = useMemo(() => buildMatchupStory(fantasy), [fantasy]);
  const fantasySpotlight = useMemo(() => buildFantasySpotlight({ impacts: topImpacts, league: fantasy, game }), [topImpacts, fantasy, game]);
  const recapSummary = useMemo(() => buildRecapSummary({ commentary, game, league: fantasy }), [commentary, game, fantasy]);
  // Multi-sport: every league we have data for. Demo mode pulls from the
  // bundled demo leagues across sports plus any custom league the user
  // pasted in. Real mode reads every actual connection the user made.
  // Sport-keyed dedupe so a custom NFL league replaces the demo NFL one.
  const allLeagues = useMemo<FantasyLeagueState[]>(() => {
    if (providerMode === "demo") {
      // Demo leagues seed a fictional roster ("Alex", "Maya") with real
      // player rosters. Surfacing them before the user has a profile
      // leaks demo identity into the listener-stakes, matchup totals,
      // and friend chips. Gate so brand-new users see an empty fantasy
      // state until they either set up a profile or explicitly start
      // the demo show — at which point we accept the demo persona.
      if (!profile && !demoMode) return [];
      const map = new Map<string, FantasyLeagueState>();
      for (const league of demoLeagues) map.set(league.sport, league);
      if (customLeague) map.set(customLeague.sport, customLeague);
      return Array.from(map.values());
    }
    return connectedLeagues;
  }, [providerMode, customLeague, connectedLeagues, profile, demoMode]);
  // Hoist applyProfileToGroup into a single memo. Five view-models
  // below all need the same merged listener identity; calling the
  // resolver in each one re-scans the league rosters per memo on
  // every state change.
  const effectiveGroup = useMemo(
    () => applyProfileToGroup(group, profile, allLeagues, game?.sport),
    [group, profile, allLeagues, game?.sport]
  );
  const listenerStakes = useMemo(
    () => buildListenerStakes({ group: effectiveGroup, leagues: allLeagues, game }),
    [effectiveGroup, allLeagues, game]
  );
  const listenerSpotlights = useMemo(
    () => buildListenerGameSpotlights({ games: sportsGames, leagues: allLeagues, group: effectiveGroup }),
    [effectiveGroup, allLeagues, sportsGames]
  );
  const listenerRecapHighlight = useMemo(
    () => buildListenerRecapHighlight({ commentary, group: effectiveGroup, leagues: allLeagues, game }),
    [effectiveGroup, allLeagues, commentary, game]
  );
  const tonightGlance = useMemo(
    () => buildTonightAtAGlance({ group: effectiveGroup, leagues: allLeagues, games: sportsGames }),
    [effectiveGroup, allLeagues, sportsGames]
  );
  const friendMatchups = useMemo(
    () => buildFriendMatchups({ group: effectiveGroup, leagues: allLeagues, game }),
    [effectiveGroup, allLeagues, game]
  );

  // Pregame storylines: fetch the latest beat-writer items for the
  // active game's sport / teams whenever the user picks a new game.
  // Vegas line for the picked game. Fetched once per game pick — lines
  // move on the order of minutes, so we don't need to repoll.
  useEffect(() => {
    if (!game) {
      setPregameOdds(undefined);
      return;
    }
    const params = new URLSearchParams({
      gameId: game.gameId,
      sport: game.sport,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam
    });
    let cancelled = false;
    fetch(`/api/odds?${params.toString()}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`odds ${response.status}`))))
      .then((payload: { odds?: GameOdds }) => {
        if (cancelled) return;
        setPregameOdds(payload.odds);
      })
      .catch(() => {
        if (cancelled) return;
        setPregameOdds(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [game?.gameId, game?.sport, game?.awayTeam, game?.homeTeam]);

  // Empty until a game is selected; cleared on sport/team change.
  useEffect(() => {
    if (!game) {
      setPregameNews([]);
      return;
    }
    const teams = [game.awayTeam, game.homeTeam].filter(Boolean);
    // Listener starters playing in this game — gives the news provider
    // hooks for player-specific items when those land later.
    const playerIds = (listenerStakes?.startersInGame ?? []).map((player) => player.id);
    const params = new URLSearchParams({
      sport: game.sport,
      teams: teams.join(","),
      ...(playerIds.length ? { playerIds: playerIds.join(",") } : {})
    });
    let cancelled = false;
    fetch(`/api/news/storylines?${params.toString()}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`storylines ${response.status}`))))
      .then((payload: { news?: NewsItem[] }) => {
        if (cancelled) return;
        setPregameNews(Array.isArray(payload.news) ? payload.news : []);
      })
      .catch(() => {
        if (cancelled) return;
        setPregameNews([]);
      });
    return () => {
      cancelled = true;
    };
  }, [game?.gameId, game?.sport, game?.awayTeam, game?.homeTeam, listenerStakes?.startersInGame]);

  // W8: pastShows lives in localStorage (already hydrated above when
  // we read `persisted.pastShows`). The cross-device sync via
  // /api/history/shows ran on the Fastify codepath; that route was
  // never ported to Next.js because the demo + interview deploy is
  // single-device. Re-introducing it requires a persistence layer
  // (Upstash Redis is already a dep — see SessionRegistry for the
  // pattern). Until then, history is per-device.

  // Archive the show into pastShows once it transitions to recap. The
  // archived entry feeds future-show prior-context callbacks ("last
  // week Mahomes burned you").
  useEffect(() => {
    if (huddlePhase !== "recap") return;
    if (commentary.length === 0) return;
    const sessionKey = `${game?.gameId ?? "no-game"}-${commentary[commentary.length - 1]?.id ?? "none"}`;
    if (archivedShowRef.current === sessionKey) return;
    archivedShowRef.current = sessionKey;
    const startedAt = showStartRef.current ?? new Date().toISOString();
    showStartRef.current = undefined;
    const listenerRosterId = listenerStakes?.status === "ready"
      ? profile?.leagues?.find((entry) => entry.sport === game?.sport)?.rosterId ?? profile?.rosterId
      : undefined;
    let topMoment: ShowHistoryEntry["topMoment"];
    if (listenerRosterId) {
      let bestAbs = 0;
      for (const item of commentary) {
        const impact = item.fantasyImpacts.find((candidate) => candidate.rosterId === listenerRosterId);
        if (impact && Math.abs(impact.pointsDelta) > bestAbs) {
          bestAbs = Math.abs(impact.pointsDelta);
          topMoment = { playerName: impact.playerName, pointsDelta: impact.pointsDelta, hostText: item.text };
        }
      }
    }
    const entry: ShowHistoryEntry = {
      id: crypto.randomUUID(),
      startedAt,
      endedAt: new Date().toISOString(),
      sport: game?.sport ?? "other",
      gameId: game?.gameId ?? "unknown",
      gameLabel: game ? `${game.awayTeam} vs ${game.homeTeam}` : "Show",
      // Only tag history entries with the listener's identity when there's
      // a real profile. Otherwise the entry inherits "Alex" from the demo
      // group seed and seeds wrong identity into local history + backend.
      listenerName: profile?.name ?? "Listener",
      listenerTeamName: profile ? listenerStakes?.teamName : undefined,
      finalScore: game?.currentPlay ? { away: game.currentPlay.score.away, home: game.currentPlay.score.home } : undefined,
      topMoment,
      marginShift: profile ? listenerStakes?.margin : undefined,
      totalCommentary: commentary.length
    };
    setPastShows((current) => [entry, ...current].slice(0, 25));
    // localStorage is the only persistence layer right now. The
    // Fastify-era POST to /api/history/shows was removed alongside
    // the GET when the routes weren't ported to Next.js — see the
    // hydration effect above for the rationale.
  }, [huddlePhase, commentary, game, group.listener?.name, listenerStakes, profile]);

  const startLivecast = async (overrides?: { sportsGameId?: string; sportsDataMode?: "demo" | "espn"; bypassReadiness?: boolean }) => {
    const effectiveGameId = overrides?.sportsGameId ?? sportsGameId;
    const effectiveDataMode = overrides?.sportsDataMode ?? sportsDataMode;
    const validation = validateLivecastStart({ providerMode, sleeperLeagueId, espnLeagueId, videoMode, videoUrl });
    if (validation) {
      setFormError(validation);
      setStatus("Needs setup");
      return;
    }
    if (!demoMode && !overrides?.bypassReadiness && !pregameReadiness.canStart) {
      const unmet = pregameReadiness.requirements.filter((req) => !req.met).map((req) => req.label).join(", ");
      setFormError(`Missing setup: ${unmet}. Open setup or switch to demo mode.`);
      setStatus("Needs setup");
      return;
    }
    // Browsers require AudioContext creation/resume to happen during a
    // user gesture. Create it here so subsequent WebSocket-driven audio
    // playback has a non-suspended context to route through.
    const AudioContextConstructor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioContextConstructor) {
      if (!audioContextRef.current || audioContextRef.current.state === "closed") {
        audioContextRef.current = new AudioContextConstructor();
      }
      void audioContextRef.current.resume().catch(() => undefined);
    }
    livecastSessionRef.current += 1;
    setShowPrepared(true);
    const sessionId = livecastSessionRef.current;
    setFormError("");
    const previousSession = liveSessionRef.current;
    liveSessionRef.current = null;
    if (previousSession) void closeSession(previousSession);
    if (frameTimerRef.current) {
      window.clearInterval(frameTimerRef.current);
      frameTimerRef.current = undefined;
    }
    setLivecastActive(true);
    setAudioPlaying(false);
    setAudioLevels(WAVEFORM_BARS);
    setStatus("Connecting");
    setPlays([]);
    setCommentary([]);
    setTtsLatencyByCommentary({});
    setActiveTurnByCommentary({});
    setLastObservation(undefined);
    setFrameCaptureStatus("Connecting frame capture");

    const effectiveGroup = applyProfileToGroup(group, profile, allLeagues, game?.sport);
    // Cross-show memory: brief callback the LLM can weave into the
    // opener if it lands naturally. Most-recent same-sport same-listener
    // first; otherwise the most-recent show overall.
    const priorContext = buildPriorContext(pastShows, game?.sport, effectiveGroup.listener?.name);

    // Frame pump — runs after we have a session handle.
    const startFramePump = (handle: import("./liveSession").LiveSessionHandle) => {
      const sendLatestFrame = async () => {
        const frame = await captureCurrentFrame({ videoRef, videoMode, videoUrl, screenStream, youtubeEmbedUrl });
        if (livecastSessionRef.current !== sessionId || !handle.isOpen()) return;
        setFrameCaptureStatus(
          frame.blockedReason
            ? frame.blockedReason
            : `Captured ${frame.width}x${frame.height} frame for validation.`
        );
        await sendFrame(handle, frame);
      };
      void sendLatestFrame();
      frameTimerRef.current = window.setInterval(() => {
        if (livecastSessionRef.current === sessionId && handle.isOpen()) void sendLatestFrame();
      }, Math.max(3000, cadenceSeconds * 1000));
    };

    const handle = await startLiveSession(
      {
        providerMode,
        sportsDataMode: effectiveDataMode,
        sportsGameId: effectiveGameId || undefined,
        sleeperLeagueId: sleeperLeagueId || undefined,
        espnLeagueId: espnLeagueId || undefined,
        espnSeason,
        week,
        group: effectiveGroup,
        customLeague: providerMode === "demo" ? customLeague : undefined,
        video: { mode: videoMode, url: videoUrl || undefined },
        ttsEnabled,
        cadenceMs: cadenceSeconds * 1000,
        priorContext
      },
      {
        onOpen: () => {
          if (livecastSessionRef.current !== sessionId) return;
          setStatus("Live");
        },
        onError: (msg) => {
          if (livecastSessionRef.current !== sessionId) return;
          setStatus(msg);
        },
        onClose: () => {
          if (livecastSessionRef.current !== sessionId) return;
          if (frameTimerRef.current) {
            window.clearInterval(frameTimerRef.current);
            frameTimerRef.current = undefined;
          }
          liveSessionRef.current = null;
          setLivecastActive(false);
          setAudioPlaying(false);
          setAudioLevels(WAVEFORM_BARS);
          setStatus("Stopped");
        },
        onSessionLost: () => {
          // 410 from any POST means our session lives on a different
          // Function instance than the one we just hit. Engines can't
          // migrate, so the only recovery is a fresh start. Bypass
          // pregame readiness so the user doesn't have to re-validate
          // setup that already passed once.
          if (livecastSessionRef.current !== sessionId) return;
          setStatus("Reconnecting");
          void startLivecast({
            sportsGameId: effectiveGameId || undefined,
            sportsDataMode: effectiveDataMode,
            bypassReadiness: true
          });
        },
        onEvent: (message) => {
          if (livecastSessionRef.current !== sessionId) return;
          if (message.type === "snapshot") {
        setFantasy(message.fantasy);
        setGame(message.game);
        setHealth(Array.isArray(message.health) ? message.health : []);
        setProviders(message.providers);
      }
      if (message.type === "play") {
        setGame(message.game);
        // Dedup by play.id: ESPN's pre-game scoreboard returns the
        // same placeholder play (id ending in `-pre-0-0.0`) on every
        // tick. Without this guard the play array fills with
        // duplicates and React fires "duplicate key" warnings for
        // every render. Keep the existing entry's position; refresh
        // its data only.
        setPlays((current) => {
          const filtered = current.filter((existing) => existing.id !== message.play.id);
          return [message.play, ...filtered].slice(0, 8);
        });
      }
      if (message.type === "commentary") {
        setLastObservation(message.commentary.observation);
        setCommentary((current) => [message.commentary, ...current].slice(0, 10));
        if (ttsEnabled && usingMockTts && "speechSynthesis" in window) {
          const utterance = new SpeechSynthesisUtterance(message.commentary.text);
          utterance.rate = speechRate;
          utterance.onstart = () => {
            if (livecastSessionRef.current === sessionId) setAudioPlaying(true);
          };
          utterance.onend = () => {
            if (livecastSessionRef.current === sessionId) setAudioPlaying(false);
          };
          utterance.onerror = () => {
            if (livecastSessionRef.current === sessionId) setAudioPlaying(false);
          };
          window.speechSynthesis.speak(utterance);
        }
      }
      if (message.type === "observation") setLastObservation(message.observation);
      if (message.type === "tts") {
        setStatus(message.audio.provider === "mock-tts" ? "Live with browser voice" : "Live with ElevenLabs audio chunks");
        setTtsLatencyByCommentary((current) => ({ ...current, [message.audio.commentaryId]: message.audio.latencyMs }));
        // Swap the on-screen transcript to the currently-spoken turn.
        // Server stamps every chunk with its turn index; we just keep
        // the highest one we've seen so re-renders never retract a
        // turn that's already been shown.
        if (typeof message.audio.lineIndex === "number") {
          const lineIdx = message.audio.lineIndex;
          const commId = message.audio.commentaryId;
          setActiveTurnByCommentary((current) => {
            const existing = current[commId] ?? -1;
            if (lineIdx <= existing) return current;
            return { ...current, [commId]: lineIdx };
          });
        }
        if (message.audio.base64Audio) {
          // W9: stash chunks for later clip archival. Mock TTS never
          // provides bytes, so this only fills for the real ElevenLabs
          // path — exactly the audio worth sharing.
          const entry = clipChunksRef.current.get(message.audio.commentaryId) ?? { mimeType: message.audio.mimeType, chunks: [] };
          // Per-show memory cap: ~6MB of base64 (≈4.5MB binary) per
          // commentary. Beyond that we silently stop appending so a
          // runaway TTS stream doesn't OOM the tab; the share blurb
          // falls back to text-only.
          const SOFT_CAP_CHARS = 6_000_000;
          const totalChars = entry.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          if (totalChars + message.audio.base64Audio.length <= SOFT_CAP_CHARS) {
            entry.chunks.push(message.audio.base64Audio);
          }
          if (!clipChunksRef.current.has(message.audio.commentaryId)) {
            clipChunksRef.current.set(message.audio.commentaryId, entry);
          }
          // Across-show cap: keep at most 12 commentary's worth of
          // audio in memory. Older commentaries are dropped — the
          // listener can only share the most recent few highlights.
          if (clipChunksRef.current.size > 12) {
            const oldestKey = clipChunksRef.current.keys().next().value;
            if (oldestKey) clipChunksRef.current.delete(oldestKey);
          }
          audioQueueRef.current = audioQueueRef.current.then(() => {
            if (livecastSessionRef.current !== sessionId) return;
            return playBase64Audio(message.audio.base64Audio!, message.audio.mimeType, {
              audioContext: audioContextRef.current ?? undefined,
              isCancelled: () => livecastSessionRef.current !== sessionId,
              onAudioStart: (audio) => {
                if (livecastSessionRef.current !== sessionId) return;
                currentAudioRef.current = audio;
                setAudioPlaying(true);
              },
              onAudioEnd: (audio) => {
                if (currentAudioRef.current === audio) currentAudioRef.current = null;
                if (livecastSessionRef.current === sessionId) setAudioPlaying(false);
                if (livecastSessionRef.current === sessionId) setAudioLevels(WAVEFORM_BARS);
              },
              onAudioLevel: (levels) => {
                if (livecastSessionRef.current === sessionId) setAudioLevels(levels);
              }
            });
          });
        }
      }
      if (message.type === "health") setHealth(Array.isArray(message.health) ? message.health : []);
      if (message.type === "status") {
        // Server-side acknowledgements (e.g. nudge confirmation) — surface
        // briefly in the existing status string.
        setStatus(message.message);
      }
      if (message.type === "market-swing") {
        setLastMarketSwing({
          source: message.source,
          externalId: message.externalId,
          deltaCents: message.deltaCents,
          emittedAt: Date.now()
        });
        setStatus(
          `${message.outcome} ${message.direction === "warming" ? "▲" : "▼"} ${Math.abs(message.deltaCents)}¢ on ${message.source === "kalshi" ? "Kalshi" : "Polymarket"}`
        );
      }
      if (message.type === "cue-ack") {
        // The host folded our cues into a turn. Surface the answer link
        // for a beat so the listener sees it landed.
        setStatus(`Cue answered: ${message.commentaryId.slice(0, 8)}`);
      }
      if (message.type === "error") {
        setStatus(message.message);
      }
        }
      }
    );
    if (!handle) {
      // startLiveSession already called onError; just clean up.
      setLivecastActive(false);
      return;
    }
    liveSessionRef.current = handle;
    // Announce leadership so any sibling tab in this browser closes
    // its show — single-engine-per-browser keeps credit burn predictable.
    claimShowLeadership(handle.sessionId, tabIdRef.current);
    startFramePump(handle);
  };

  // Navigate back to discover. If a livecast is running, KEEP it running
  // — the show continues in a floating mini-player. The user can re-enter
  // it by clicking the mini-player or by visiting /watch/{gameId}.
  const goHome = () => {
    setViewingHome(true);
    if (window.location.pathname !== "/") {
      window.history.pushState({ view: "home" }, "", "/");
    }
  };

  const returnToShow = () => {
    setViewingHome(false);
    if (sportsGameId && window.location.pathname !== `/watch/${sportsGameId}`) {
      window.history.pushState({ view: "show", gameId: sportsGameId }, "", `/watch/${sportsGameId}`);
    }
  };

  // Listener nudge: pick which host gets the next turn. The server
  // overrides selectHost for one tick. Caller decides feedback (toast,
  // button highlight) — this only sends the message.
  const nudgeHost = (hostId: HostId) => {
    const handle = liveSessionRef.current;
    if (!handle || !handle.isOpen()) return;
    void sendNudge(handle, hostId);
  };

  // W18: Cue host. The button captures a short mic clip, ships it to
  // /api/asr/transcribe (Nemotron Nano Omni), then forwards the
  // transcript to the live show as a cue the persona may answer on
  // the next tick. We hand the button the post-transcribe submitter
  // and let it own its own recording state — App just relays the
  // SSE-session payload.
  const submitListenerCue = useCallback((cue: ListenerCue) => {
    const handle = liveSessionRef.current;
    if (!handle || !handle.isOpen()) return false;
    void sendCue(handle, cue);
    return true;
  }, []);

  // W9: archive a moment's audio as a clip and return the public URL.
  // Returns undefined when no audio was captured (mock TTS path) or
  // when the upload fails — the caller falls back to text-only share.
  // Merge a commentary turn's TTS audio chunks into a single base64
  // payload + mime type. Shared by archiveClip (which uploads the
  // bytes for sharing) and getClipSubtitles (which posts the bytes
  // to ASR for caption generation). Returns undefined when nothing
  // was captured for that turn (mock TTS path, etc.).
  const buildClipPayload = useCallback((commentaryId: string): { audioBase64: string; mimeType: string } | undefined => {
    const captured = clipChunksRef.current.get(commentaryId);
    if (!captured || captured.chunks.length === 0) return undefined;
    let totalLength = 0;
    const decoded: Uint8Array[] = [];
    for (const chunk of captured.chunks) {
      try {
        const bytes = Uint8Array.from(atob(chunk), (char) => char.charCodeAt(0));
        decoded.push(bytes);
        totalLength += bytes.byteLength;
      } catch {
        return undefined;
      }
    }
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const bytes of decoded) {
      merged.set(bytes, offset);
      offset += bytes.byteLength;
    }
    let binary = "";
    for (let i = 0; i < merged.length; i++) binary += String.fromCharCode(merged[i]);
    return { audioBase64: btoa(binary), mimeType: captured.mimeType };
  }, []);

  const archiveClip = useCallback(async (commentaryId: string): Promise<string | undefined> => {
    const payload = buildClipPayload(commentaryId);
    if (!payload) return undefined;
    // Try the client-direct Blob upload first. Vercel Functions cap
    // POST bodies at ~4.5MB on Hobby/Pro Node runtimes; our TTS clips
    // can run 6–8MB base64 and would silently fail on the legacy
    // server-side path in production. handleUpload via
    // @vercel/blob/client uploads straight to the Blob CDN with a
    // signed token minted by /api/clips/upload-token.
    //
    // When BLOB_READ_WRITE_TOKEN isn't set (local dev), the token
    // route returns 404 and we fall back to the legacy POST against
    // the FileClipStore-backed handler.
    try {
      const { upload } = await import("@vercel/blob/client");
      const bytes = Uint8Array.from(atob(payload.audioBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: payload.mimeType });
      const extension = payload.mimeType.includes("mp3")
        ? "mp3"
        : payload.mimeType.includes("ogg")
          ? "ogg"
          : payload.mimeType.includes("wav")
            ? "wav"
            : payload.mimeType.includes("mp4") || payload.mimeType.includes("aac")
              ? "m4a"
              : "webm";
      const result = await upload(`clips/${listenerId}/${commentaryId}.${extension}`, blob, {
        access: "public",
        handleUploadUrl: "/api/clips/upload-token",
        contentType: payload.mimeType
      });
      return result.url;
    } catch (error) {
      // 404 from the token route = Blob isn't configured. Fall
      // through to the server-side path. Other errors (auth, size
      // cap, network) also fall through so a working FileClipStore
      // can still archive the clip.
      const message = error instanceof Error ? error.message : "";
      if (message && !/404|not configured/i.test(message)) {
        // Log non-404 failures for visibility but don't surface to
        // user — share UI just falls back to text-only.
        console.warn("[clip] direct Blob upload failed, falling back to server", message);
      }
    }
    try {
      const response = await fetch("/api/clips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listenerId, commentaryId, mimeType: payload.mimeType, audioBase64: payload.audioBase64 })
      });
      if (!response.ok) return undefined;
      const result = await response.json() as { url?: string };
      return result.url;
    } catch {
      return undefined;
    }
  }, [buildClipPayload, listenerId]);

  // W21 client half: post the captured TTS audio for this turn to
  // the Nemotron ASR + WebVTT route and return the caption track.
  // Independent of archiveClip so the share UX can show separate
  // progress for "uploading clip" vs "transcribing for captions."
  const getClipSubtitles = useCallback(
    async (commentaryId: string): Promise<{ vtt: string; text: string } | undefined> => {
      const payload = buildClipPayload(commentaryId);
      if (!payload) return undefined;
      const audio = {
        id: commentaryId,
        capturedAt: new Date().toISOString(),
        source: "broadcast" as const,
        mimeType: payload.mimeType,
        dataUrl: `data:${payload.mimeType};base64,${payload.audioBase64}`
      };
      try {
        const response = await fetch("/api/clip/subtitles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ audio })
        });
        if (!response.ok) return undefined;
        const result = (await response.json()) as { vtt?: string; text?: string };
        if (!result.vtt) return undefined;
        return { vtt: result.vtt, text: result.text ?? "" };
      } catch {
        return undefined;
      }
    },
    [buildClipPayload]
  );

  // Unmount cleanup. Without this, navigating away or closing the tab
  // mid-show leaves the live session open server-side and the ESPN/TTS
  // tick interval running. Using refs (no deps) so the effect runs
  // exactly once on mount/unmount.
  useEffect(() => {
    return () => {
      const handle = liveSessionRef.current;
      liveSessionRef.current = null;
      if (handle) void closeSession(handle);
      if (frameTimerRef.current) {
        window.clearInterval(frameTimerRef.current);
        frameTimerRef.current = undefined;
      }
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close().catch(() => undefined);
      }
      audioContextRef.current = null;
      window.speechSynthesis?.cancel();
      clipChunksRef.current.clear();
    };
  }, []);

  const stopLivecast = () => {
    livecastSessionRef.current += 1;
    const handle = liveSessionRef.current;
    liveSessionRef.current = null;
    if (handle) void closeSession(handle);
    if (frameTimerRef.current) {
      window.clearInterval(frameTimerRef.current);
      frameTimerRef.current = undefined;
    }
    // Reset cross-show refs so a fresh `Start` doesn't reuse old state.
    clipChunksRef.current.clear();
    showStartRef.current = undefined;
    archivedShowRef.current = undefined;
    audioQueueRef.current = Promise.resolve();
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.removeAttribute("src");
      currentAudioRef.current.load();
      currentAudioRef.current = null;
    }
    window.speechSynthesis?.cancel();
    setLivecastActive(false);
    setAudioPlaying(false);
    setAudioLevels(WAVEFORM_BARS);
    setShowPrepared(false);
    setDemoMode(false);
    setCommentary([]);
    setPlays([]);
    setTtsLatencyByCommentary({});
    setActiveTurnByCommentary({});
    setLastObservation(undefined);
    setFrameCaptureStatus("Livecast stopped.");
    setStatus("Stopped");
    setViewingHome(true);
    if (window.location.pathname !== "/") {
      window.history.pushState({ view: "home" }, "", "/");
    }
  };

  const prepareDemoRehearsal = () => {
    stopLivecast();
    setProviderMode("demo");
    setSportsDataMode("demo");
    setSportsGameId("");
    setVideoMode("stream-url");
    setVideoUrl("");
    setShowPrepared(true);
    setDemoMode(true);
    setFantasy(customLeague ?? demoLeagueState);
    setGame({
      provider: "demo-sports-data",
      gameId: "demo-kc-det",
      sport: "nfl",
      awayTeam: "KC",
      homeTeam: "DET",
      status: "demo",
      recentPlays: [],
      updatedAt: new Date().toISOString()
    });
    setProviders((current) => ({
      ...current,
      fantasy: customLeague ? "Custom Demo Fantasy" : "Demo Fantasy",
      sportsData: "Demo Sports Data"
    }));
    setImportPreview(buildLocalPreview(customLeague ?? demoLeagueState));
    setImportStatus("Demo rehearsal ready.");
    setStatus("Ready");
    setVideoNotice("Clean demo mode can run without video. Voice is off so rehearsals do not spend TTS credits.");
    setFrameCaptureStatus("Demo rehearsal prepared without video validation.");
    setLastObservation(undefined);
    setPlays([]);
    setCommentary([]);
    setTtsLatencyByCommentary({});
    setActiveTurnByCommentary({});
    void refreshSportsGames("demo");
    void refreshDiagnostics("demo");
  };

  const startScreenShare = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      setScreenStream(stream);
      setVideoMode("screen-share");
      setVideoNotice("Screen share connected. The browser controls what is visible to the model provider.");
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setScreenStream(undefined);
        setVideoNotice("Screen share ended.");
      });
    } catch {
      setVideoNotice("Screen share was cancelled or blocked by the browser.");
    }
  };

  const validateFrameNow = async () => {
    setFrameCaptureStatus("Capturing frame for manual validation");
    const frame = await captureCurrentFrame({ videoRef, videoMode, videoUrl, screenStream, youtubeEmbedUrl });
    setFrameCaptureStatus(frame.blockedReason ? frame.blockedReason : `Captured ${frame.width}x${frame.height} frame for manual validation.`);
    if (frame.blockedReason) {
      setLastObservation({
        id: crypto.randomUUID(),
        source: videoMode,
        summary: frame.blockedReason,
        confidence: 0,
        observedAt: new Date().toISOString(),
        latencyMs: 0,
        usedFrame: false,
        validation: {
          status: "unavailable",
          confidence: 0,
          evidence: [frame.blockedReason],
          reason: frame.blockedReason,
          validatedAt: new Date().toISOString()
        }
      });
      return;
    }
    try {
      const response = await fetch("/api/vision/observe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          frame,
          video: { mode: videoMode, url: videoUrl || undefined },
          play: game?.currentPlay
        })
      });
      if (!response.ok) throw new Error(`Validation failed with ${response.status}`);
      const payload = (await response.json()) as FrameValidationResponse;
      setLastObservation(payload.observation);
      setFrameCaptureStatus("Manual validation completed.");
    } catch (error) {
      setFrameCaptureStatus(error instanceof Error ? error.message : "Manual validation failed.");
    }
  };

  const updateFriend = (id: string, field: "name" | "favoriteTeam" | "rivalryNotes", value: string) => {
    setGroup((current) => ({
      ...current,
      friends: current.friends.map((friend) => (friend.id === id ? { ...friend, [field]: value } : friend))
    }));
  };

  const updateFriendRoster = (id: string, rosterId: string) => {
    setGroup((current) => ({
      ...current,
      friends: current.friends.map((friend) => (friend.id === id ? { ...friend, rosterId: rosterId || undefined } : friend))
    }));
  };

  const addFriend = () => {
    const nextNumber = group.friends.length + 1;
    setGroup((current) => ({
      ...current,
      friends: [
        ...current.friends,
        {
          id: crypto.randomUUID(),
          name: `Friend ${nextNumber}`,
          favoriteTeam: game?.homeTeam ?? "DET",
          rosterId: rosterOptions[nextNumber - 1]?.id,
          rivalryNotes: ""
        }
      ]
    }));
  };

  const removeFriend = (id: string) => {
    setGroup((current) => ({
      ...current,
      friends: current.friends.length > 1 ? current.friends.filter((friend) => friend.id !== id) : current.friends
    }));
  };

  const refreshHealth = async () => {
    setStatus((current) => (current === "Idle" ? "Refreshing health" : current));
    try {
      // /api/health is currently Fastify-only — on Vercel deploys the
      // route 404s. Treat that as "diagnostics unavailable" rather
      // than a fatal error so the rest of the UI keeps working.
      const response = await fetch("/api/health");
      if (!response.ok) {
        setStatus((current) => (current === "Refreshing health" ? "Diagnostics unavailable on this deploy" : current));
        return;
      }
      const payload = (await response.json()) as { health: ProviderHealth[]; providers: ActiveProviderSummary };
      setHealth(Array.isArray(payload.health) ? payload.health : []);
      setProviders(payload.providers ?? providers);
      setStatus((current) => (current === "Refreshing health" ? "Idle" : current));
    } catch {
      setStatus((current) => (current === "Refreshing health" ? "Diagnostics unavailable on this deploy" : current));
    }
  };

  const refreshDiagnostics = async (mode: "demo" | "espn" = sportsDataMode) => {
    // Same Vercel caveat as refreshHealth — fail soft on 404.
    try {
      const response = await fetch(`/api/diagnostics?${new URLSearchParams({ sportsDataMode: mode }).toString()}`);
      if (!response.ok) return;
      const payload = (await response.json()) as ProviderDiagnostics;
      setDiagnostics(payload);
    } catch {
      // Diagnostics view degrades silently on Vercel deploys.
    }
  };

  const refreshSportsGames = async (mode: "demo" | "espn" = sportsDataMode) => {
    try {
      setSportsGamesStatus(mode === "espn" ? "Loading ESPN scoreboard games." : "Demo game selected.");
      const response = await fetch(`/api/sports/games?${new URLSearchParams({ sportsDataMode: mode }).toString()}`);
      if (!response.ok) throw new Error(`Game list failed with ${response.status}`);
      const payload = (await response.json()) as { games: SportsGameOption[]; failedSports?: Array<{ sport: SportLeague; label: string }> };
      const games = Array.isArray(payload.games) ? payload.games : [];
      setSportsGames(games);
      setFailedSports(Array.isArray(payload.failedSports) ? payload.failedSports : []);
      if (sportsGameId && !games.some((item) => item.id === sportsGameId)) setSportsGameId("");
      setSportsGamesStatus(games.length ? `${games.length} game option(s) available.` : "No games returned for this source.");
    } catch (error) {
      setSportsGames([]);
      setFailedSports([]);
      setSportsGamesStatus(error instanceof Error ? error.message : "Unable to load game options.");
    }
  };

  const refreshModelStack = async () => {
    const response = await fetch("/api/model-stack");
    const payload = (await response.json()) as ModelStackProfile;
    setModelStack(payload);
  };

  const refreshMediaManifest = async () => {
    try {
      setMediaStatus("Loading media cache");
      // /api/media-cache reads the manifest from disk and returns an
      // empty stub if the local cache hasn't been populated. The old
      // direct-fetch of /media-cache/manifest.json 404s on Vercel
      // because the cache directory is gitignored.
      const response = await fetch(`/api/media-cache?t=${Date.now()}`);
      if (!response.ok) throw new Error("No media cache found yet.");
      const manifest = (await response.json()) as MediaCacheManifest;
      const hasAssets = Array.isArray(manifest.assets) && manifest.assets.length > 0;
      setMediaManifest(hasAssets ? manifest : undefined);
      setMediaStatus(hasAssets ? "Media cache loaded" : "Media cache empty");
    } catch (error) {
      setMediaManifest(undefined);
      setMediaStatus(error instanceof Error ? error.message : "Media cache unavailable");
    }
  };

  const loadLeague = async () => {
    const validation =
      providerMode === "sleeper" && !sleeperLeagueId.trim()
        ? "Enter a Sleeper league ID before loading."
        : providerMode === "espn" && !espnLeagueId.trim()
          ? "Enter an ESPN league ID before loading."
          : "";
    if (validation) {
      setFormError(validation);
      setStatus("Needs setup");
      return;
    }
    setFormError("");
    setStatus("Loading league");
    try {
      const params = new URLSearchParams({
        providerMode,
        sportsDataMode,
        ...(sportsGameId ? { sportsGameId } : {}),
        ...(providerMode === "sleeper" ? { sleeperLeagueId, week: String(week) } : {}),
        ...(providerMode === "espn" ? { espnLeagueId, espnSeason: String(espnSeason), week: String(week) } : {})
      });
      const response = await fetch(`/api/bootstrap?${params.toString()}`);
      if (!response.ok) throw new Error(`Load failed with ${response.status}`);
      const payload = await response.json();
      if (payload.fantasy) setFantasy(payload.fantasy);
      if (payload.game) setGame(payload.game);
      setHealth(Array.isArray(payload.health) ? payload.health : []);
      setProviders(payload.providers ?? providers);
      await loadImportPreview();
      setShowPrepared(true);
      setStatus("Idle");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to load league");
    }
  };

  const loadImportPreview = async () => {
    const validation =
      providerMode === "sleeper" && !sleeperLeagueId.trim()
        ? "Enter a Sleeper league ID before validating."
        : providerMode === "espn" && !espnLeagueId.trim()
          ? "Enter an ESPN league ID before validating."
          : "";
    if (validation) {
      setImportStatus(validation);
      setImportPreview(undefined);
      return;
    }
    setImportStatus("Validating league");
    const params = new URLSearchParams({
      providerMode,
      ...(providerMode === "sleeper" ? { sleeperLeagueId, week: String(week) } : {}),
      ...(providerMode === "espn" ? { espnLeagueId, espnSeason: String(espnSeason), week: String(week) } : {})
    });
    const response = await fetch(`/api/fantasy/preview?${params.toString()}`);
    const preview = (await response.json()) as FantasyImportPreview;
    setImportPreview(preview);
    if (preview.league) {
      setFantasy(preview.league);
      setProviders((current) => ({ ...current, fantasy: providerLabel(providerMode) }));
    }
    setImportStatus(preview.message);
  };

  const applyCustomLeague = () => {
    const result = parseCustomLeague(customLeagueJson);
    if (result.error || !result.league) {
      setCustomLeagueError(result.error ?? "Custom league JSON did not produce a league.");
      return;
    }
    setCustomLeagueError("");
    setCustomLeague(result.league);
    setFantasy(result.league);
    setProviderMode("demo");
    setProviders((current) => ({ ...current, fantasy: "Custom Demo Fantasy" }));
    setImportPreview(buildLocalPreview(result.league));
    setImportStatus("Custom demo league is ready for livecast.");
    setShowPrepared(true);
  };

  const resetCustomLeague = () => {
    const json = JSON.stringify(demoLeagueState, null, 2);
    setCustomLeagueJson(json);
    setCustomLeague(undefined);
    setCustomLeagueError("");
    setFantasy(demoLeagueState);
    setProviders((current) => ({ ...current, fantasy: "Demo Fantasy" }));
    setImportPreview(buildLocalPreview(demoLeagueState));
    setImportStatus("Demo league is ready for livecast.");
    setShowPrepared(true);
  };

  const clearTranscript = () => {
    setCommentary([]);
    setPlays([]);
    setTtsLatencyByCommentary({});
    setActiveTurnByCommentary({});
  };

  const openSetup = (pane: SetupPane = setupPane) => {
    setSetupPane(pane);
    setShowAdvanced(true);
  };

  const chooseEspnSetup = () => {
    setProviderMode("espn");
    setSportsDataMode("espn");
    setDemoMode(false);
    setProviders((current) => ({ ...current, fantasy: "ESPN Fantasy", sportsData: "ESPN Scoreboard" }));
    void refreshDiagnostics("espn");
    openSetup("league");
  };

  const chooseSleeperSetup = () => {
    setProviderMode("sleeper");
    setDemoMode(false);
    setProviders((current) => ({ ...current, fantasy: "Sleeper Fantasy" }));
    openSetup("league");
  };

  const chooseScreenShareSetup = () => {
    setVideoMode("screen-share");
    openSetup("stream");
  };

  const chooseUrlSetup = () => {
    setVideoMode("stream-url");
    openSetup("stream");
  };

  const pickSportsGameInline = (gameId: string) => {
    setSportsGameId(gameId);
    const selected = sportsGames.find((item) => item.id === gameId);
    if (selected) {
      setGame((current) => ({
        provider: sportsDataMode === "espn" ? "espn-scoreboard" : "demo-sports-data",
        gameId: selected.id,
        sport: "nfl",
        awayTeam: selected.awayTeam,
        homeTeam: selected.homeTeam,
        status: selected.status,
        recentPlays: current?.gameId === selected.id ? current.recentPlays : [],
        currentPlay: current?.gameId === selected.id && current.currentPlay ? current.currentPlay : sportsGameOptionPlay(selected),
        updatedAt: new Date().toISOString()
      }));
    }
  };

  const setSportsDataModeInline = (mode: "demo" | "espn") => {
    setSportsDataMode(mode);
    setSportsGameId("");
    setProviders((current) => ({ ...current, sportsData: mode === "espn" ? "ESPN Scoreboard" : "Demo Sports Data" }));
    void refreshSportsGames(mode);
    void refreshDiagnostics(mode);
  };

  const connectFantasyInline = async (provider: "sleeper" | "espn", leagueId: string) => {
    if (!leagueId.trim()) return false;
    setDemoMode(false);
    if (provider === "sleeper") {
      setProviderMode("sleeper");
      setSleeperLeagueId(leagueId.trim());
      setProviders((current) => ({ ...current, fantasy: "Sleeper Fantasy" }));
    } else {
      setProviderMode("espn");
      setSportsDataMode("espn");
      setEspnLeagueId(leagueId.trim());
      setProviders((current) => ({ ...current, fantasy: "ESPN Fantasy", sportsData: "ESPN Scoreboard" }));
      void refreshDiagnostics("espn");
    }
    return true;
  };

  const startScreenShareInline = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      setScreenStream(stream);
      setVideoMode("screen-share");
      setVideoNotice("Screen share connected. The browser controls what is visible to the model provider.");
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setScreenStream(undefined);
        setVideoNotice("Screen share ended.");
      });
      return true;
    } catch {
      setVideoNotice("Screen share was cancelled or blocked by the browser.");
      return false;
    }
  };

  /**
   * Stage a game for preview without opening the WebSocket. Lands the
   * UI in the `pregame` phase where the matchup card, Vegas line, news
   * storylines, listener stakes, and friend matchups are visible. The
   * user explicitly commits via the "Start show" CTA on the pregame
   * page, which calls `pickAndStartLivecast` for the same gameId.
   *
   * Why split: previously, tapping any game card opened a WebSocket
   * and started TTS streaming immediately — heavy commitment for a
   * "let me see what this matchup is" tap. Browsing seven sports of
   * games shouldn't burn vendor budget per tap.
   */
  const pickGameForPreview = (gameId: string, dataMode: "demo" | "espn") => {
    setViewingHome(false);
    if (window.location.pathname !== `/watch/${gameId}`) {
      window.history.pushState({ view: "show", gameId }, "", `/watch/${gameId}`);
    }
    setSportsGameId(gameId);
    if (dataMode !== sportsDataMode) {
      setSportsDataMode(dataMode);
      setProviders((current) => ({ ...current, sportsData: dataMode === "espn" ? "ESPN Scoreboard" : "Demo Sports Data" }));
    }
    const selected = sportsGames.find((item) => item.id === gameId);
    if (selected) {
      setGame((current) => ({
        provider: dataMode === "espn" ? "espn-scoreboard" : "demo-sports-data",
        gameId: selected.id,
        sport: selected.sport,
        awayTeam: selected.awayTeam,
        homeTeam: selected.homeTeam,
        awayMeta: selected.awayMeta,
        homeMeta: selected.homeMeta,
        status: selected.status,
        recentPlays: current?.gameId === selected.id ? current.recentPlays : [],
        currentPlay: current?.gameId === selected.id && current.currentPlay ? current.currentPlay : sportsGameOptionPlay(selected),
        updatedAt: new Date().toISOString()
      }));
      // Multi-sport: swap the active fantasy league to the one matching
      // this game's sport. If the user has no league for this sport,
      // leave fantasy as-is so the live show still runs (just without
      // listener-roster takes).
      const leagueForSport = allLeagues.find((entry) => entry.sport === selected.sport);
      if (leagueForSport) {
        setFantasyState(leagueForSport);
      }
    }
    // Demo mode bypasses the readiness gate so users can listen without
    // a connected fantasy account. They can still hit "connect" later
    // via the discover header.
    setDemoMode(true);
    // showPrepared=true is what `deriveHuddlePhase` watches for to
    // route into `pregame` — without it we'd fall back to `empty`.
    setShowPrepared(true);
  };

  /**
   * Explicit "Start show" — opens the WebSocket. Routed via the
   * pregame page's primary CTA after the user has previewed the
   * matchup. Direct callers (sample CTA on landing, recap → start
   * a new show) still go straight here.
   */
  const pickAndStartLivecast = (gameId: string, dataMode: "demo" | "espn") => {
    pickGameForPreview(gameId, dataMode);
    startLivecast({ sportsGameId: gameId, sportsDataMode: dataMode, bypassReadiness: true });
  };

  const setStreamUrlInline = (url: string) => {
    setVideoMode("stream-url");
    setVideoUrl(url);
    setVideoNotice(
      url
        ? isYouTubeUrl(url)
          ? "YouTube preview enabled. Playback depends on the video allowing embeds."
          : "Stream URL set. Playback will start when the show goes live."
        : ""
    );
  };


  const exportTranscript = () => {
    const exportText = buildTranscriptExport({ fantasy, game, providers, commentary });
    const blob = new Blob([exportText], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fantasy-livecast-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const claimedTeamName = useMemo(() => {
    if (!profile) return undefined;
    // Pick the right league for the current game's sport. Each sport
    // can have its own claimed team name in the listener's profile.
    const league = game?.sport
      ? allLeagues.find((entry) => entry.sport === game.sport)
      : allLeagues[0];
    if (!league) return undefined;
    const claim = game?.sport && profile.leagues
      ? profile.leagues.find((entry) => entry.sport === game.sport)
      : undefined;
    const rosterId = claim?.rosterId ?? profile.rosterId;
    const rosters = league.matchups.flatMap((matchup) => matchup.rosters);
    const matched = rosterId
      ? rosters.find((roster) => roster.id === rosterId)
      : rosters.find((roster) => roster.ownerName.toLowerCase() === profile.name.toLowerCase());
    return matched?.teamName;
  }, [profile, allLeagues, game?.sport]);

  // Live region for audio playback state — visually hidden but read
  // by screen readers when audioPlaying flips. Without this, AT users
  // never hear that the show went live.
  const audioStatusMessage = livecastActive
    ? audioPlaying
      ? "Audio playing"
      : "Audio paused"
    : "Stream stopped";

  return (
    <main className={showAdvanced ? `huddle-app phase-${huddlePhase} producer-open` : `huddle-app phase-${huddlePhase}`}>
      <div role="status" aria-live="polite" className="hr-sr-only">{audioStatusMessage}</div>
      <HuddleExperience
        phase={huddlePhase}
        game={game}
        fantasy={fantasy}
        group={group}
        hosts={HUDDLE_HOSTS}
        hostTurns={hostTurns}
        setupSteps={setupSteps}
        matchupStory={matchupStory}
        fantasySpotlight={fantasySpotlight}
        recapSummary={recapSummary}
        plays={plays}
        commentary={commentary}
        matchupTotals={matchupTotals}
        mediaIndex={mediaIndex}
        youtubeEmbedUrl={youtubeEmbedUrl}
        hasVideoSource={hasVideoSource}
        videoRef={videoRef}
        videoMode={videoMode}
        videoUrl={videoUrl}
        status={status}
        audioPlaying={audioPlaying}
        audioLevels={audioLevels}
        ttsEnabled={ttsEnabled}
        onPrepareDemo={prepareDemoRehearsal}
        onStart={startLivecast}
        onStop={stopLivecast}
        onOpenSettings={() => openSetup("league")}
        onOpenStream={() => openSetup("stream")}
        onOpenFriends={() => openSetup("friends")}
        onChooseEspn={chooseEspnSetup}
        onChooseSleeper={chooseSleeperSetup}
        onChooseScreenShare={chooseScreenShareSetup}
        onChooseUrl={chooseUrlSetup}
        onExportRecap={exportTranscript}
        onVideoError={() => setVideoNotice("The browser could not load that media URL. Demo commentary still works.")}
        onGoHome={goHome}
        demoMode={demoMode}
        pregameReadiness={pregameReadiness}
        emptySetup={{
          providerMode,
          sleeperLeagueId,
          espnLeagueId,
          sportsGames,
          sportsGamesStatus,
          sportsDataMode,
          sportsGameId,
          videoMode,
          videoUrl,
          hasScreenShare: Boolean(screenStream),
          failedSports,
          dismissedFailedSportsKey,
          onDismissFailedSports: () =>
            setDismissedFailedSportsKey(
              [...failedSports].map((entry) => entry.sport).sort().join("|")
            ),
          onConnectFantasy: connectFantasyInline,
          onSetSportsDataMode: setSportsDataModeInline,
          onPickSportsGame: pickSportsGameInline,
          onSetStreamUrl: setStreamUrlInline,
          onStartScreenShare: startScreenShareInline,
          onRefreshGames: () => void refreshSportsGames(sportsDataMode)
        }}
        onPickAndStart={pickAndStartLivecast}
        onPickGame={pickGameForPreview}
        viewingHome={viewingHome}
        livecastActive={livecastActive}
        onReturnToShow={returnToShow}
        profile={profile}
        onOpenProfile={(intent: ProfileModalIntent = "edit") => {
          setProfileEditorIntent(intent);
          setProfileEditorOpen(true);
        }}
        showProfileNudge={!profile && !profileNudgeDismissed}
        onDismissProfileNudge={() => setProfileNudgeDismissed(true)}
        claimedTeamName={claimedTeamName}
        providerMode={providerMode}
        listenerStakes={listenerStakes}
        listenerSpotlights={listenerSpotlights}
        listenerRecapHighlight={listenerRecapHighlight}
        allLeagues={allLeagues}
        pastShows={pastShows}
        tonightGlance={tonightGlance}
        onNudgeHost={nudgeHost}
        onSubmitCue={submitListenerCue}
        observation={lastObservation}
        modelLabel={providers.model}
        marketSwing={lastMarketSwing}
        onArchiveClip={archiveClip}
        onGetClipSubtitles={getClipSubtitles}
        pregameNews={pregameNews}
        pregameOdds={pregameOdds}
        friendMatchups={friendMatchups}
      />
      <div className="legacy-control-room" aria-hidden="true">
      <header className="room-header">
        <div className="room-title">
          <p className="eyebrow">Fantasy Livecast</p>
          <h1>Live audio room</h1>
          <p>{game ? `${game.awayTeam} at ${game.homeTeam}` : "Demo watch party"} · {fantasy?.leagueName ?? "Demo league"} · {group.friends.length} friends · {ttsEnabled ? "voice on" : "voice off"}</p>
        </div>
        <div className="room-command">
          <div className="status-pill" data-status={status.toLowerCase().includes("live") ? "live" : status.toLowerCase().includes("need") || status.toLowerCase().includes("error") ? "error" : "idle"}>
            <span />
            {status}
          </div>
          <button className="secondary compact icon-label" onClick={() => openSetup("league")}>
            <MicroIcon name="ai-settings" />
            Setup
          </button>
        </div>
      </header>

      <section className="room-grid" aria-label="Livecast room">
        <section className="stage-card" aria-label="Game stage">
          <div className="stage-media">
            {youtubeEmbedUrl ? (
              <iframe
                className="video-frame"
                title="YouTube sports stream preview"
                src={youtubeEmbedUrl}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            ) : (
              <video ref={videoRef} controls={hasVideoSource} autoPlay muted playsInline onError={() => setVideoNotice("The browser could not load that media URL. Demo commentary still works.")} />
            )}
            {!videoUrl && videoMode !== "screen-share" && (
              <div className="studio-poster room-poster">
                {!isLive && commentary.length === 0 ? (
                  <FirstRunSetup
                    fantasy={fantasy}
                    game={game}
                    group={group}
                    providerMode={providerMode}
                    sportsDataMode={sportsDataMode}
                    videoMode={videoMode}
                    videoUrl={videoUrl}
                    ttsEnabled={ttsEnabled}
                    onEspn={chooseEspnSetup}
                    onSleeper={chooseSleeperSetup}
                    onScreenShare={chooseScreenShareSetup}
                    onUrl={chooseUrlSetup}
                    onFriends={() => openSetup("friends")}
                    onDemo={prepareDemoRehearsal}
                    onStart={startLivecast}
                    startBlocked={directorPlan.mode === "blocked"}
                  />
                ) : (
                  <>
                    <section className="cast-player-card" aria-label="Livecast player">
                      <div className="cast-art" aria-hidden="true">
                        <Waveform isPlaying={audioPlaying} levels={audioLevels} />
                      </div>
                      <div className="cast-copy">
                        <span>{isLive ? "Now casting" : "Ready to cast"}</span>
                        <strong>{commentary[0]?.moment.headline ?? (game ? `${game.awayTeam} at ${game.homeTeam}` : "Demo watch party")}</strong>
                        <p>{displayedTurnText(commentary[0]) ?? (isLive ? "Following play-by-play, stats, and fantasy swings in real time." : "Personalized audio commentary is staged and ready.")}</p>
                      </div>
                    </section>
                    <div className="cast-controls">
                      {isLive ? (
                        <button className="secondary icon-label" onClick={stopLivecast}>
                          <MicroIcon name="stop" />
                          Stop livecast
                        </button>
                      ) : (
                        <button className="icon-label" onClick={() => startLivecast()} disabled={directorPlan.mode === "blocked"}>
                          <MicroIcon name="play" />
                          Start livecast
                        </button>
                      )}
                      <button className="secondary icon-label" onClick={() => openSetup("stream")}>
                        <MicroIcon name="live-video" />
                        Add stream
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            <ScoreBug game={game} mediaIndex={mediaIndex} />
            <MarketsTicker game={game} swing={lastMarketSwing} />
            <FantasyMatchupFloat matchupTotals={matchupTotals} mediaIndex={mediaIndex} />
          </div>
        </section>

        <aside className="host-rail" aria-label="AI host">
          <LiveRail
            plan={directorPlan}
            producerBrief={producerBrief}
            commentary={commentary}
            game={game}
            plays={plays}
            topImpacts={topImpacts}
            isLive={isLive}
            providerMode={providerMode}
            sportsDataMode={sportsDataMode}
            videoMode={videoMode}
            hasVideoSource={hasVideoSource}
            group={group}
            ttsEnabled={ttsEnabled}
            displayedTurnText={displayedTurnText}
            onStart={startLivecast}
            onStop={stopLivecast}
            onValidate={validateFrameNow}
            onOpenSetup={() => openSetup("league")}
            onDemo={prepareDemoRehearsal}
          />
        </aside>
      </section>

      <section className="story-dock" aria-label="Watch party story">
        <article className="story-card rivalry-card">
          <div className="story-heading">
            <MicroIcon name="trophy" />
            <span>Rivalry</span>
          </div>
          {matchupTotals.length === 0 ? (
            <p className="empty">Load a matchup to set the stakes.</p>
          ) : (
            <>
              <div className="rivalry-scoreboard">
                {matchupTotals.map((roster) => <ScoreRow key={roster.id} roster={roster} mediaIndex={mediaIndex} />)}
              </div>
              <p>{leadingRoster && trailingRoster ? `${leadingRoster.ownerName} leads ${trailingRoster.ownerName} by ${Math.abs(leadingRoster.points - trailingRoster.points).toFixed(1)}.` : "A close one is brewing."}</p>
            </>
          )}
        </article>
        <article className="story-card angle-card">
          <div className="story-heading">
            <MicroIcon name="controller" />
            <span>Host angle</span>
          </div>
          <strong>{directorPlan.cues[0] ?? "Keep the call tight and personal."}</strong>
          <div className="friend-chip-row">
            {group.friends.slice(0, 4).map((friend) => (
              <span key={friend.id}>{friend.name}</span>
            ))}
          </div>
          <p>{group.tone === "chaos" ? "Bigger jokes, sharper swings." : group.tone === "family" ? "Clean, warm, easy to share." : "PG banter with real fantasy stakes."}</p>
        </article>
        <article className="story-card pulse-card">
          <div className="story-heading">
            <MicroIcon name="live-video" />
            <span>Now</span>
          </div>
          <strong>{commentary[0]?.moment.headline ?? topImpacts[0]?.playerName ?? "Waiting for the first swing"}</strong>
          <p>{commentary[0]?.moment.summary ?? (topImpacts[0] ? `${topImpacts[0].ownerName} ${topImpacts[0].pointsDelta > 0 ? "gains" : "loses"} ${Math.abs(topImpacts[0].pointsDelta)}.` : "The host will light this up once the first play lands.")}</p>
        </article>
        <article className="story-card next-card">
          <div className="story-heading">
            <MicroIcon name="play" />
            <span>Watch next</span>
          </div>
          <strong>{plays[0]?.headline ?? (playerSpotlight ? `${playerSpotlight.name} is the fantasy spotlight` : "First play incoming")}</strong>
          <p>{plays[0]?.description ?? (playerSpotlight ? `${playerSpotlight.ownerName} has ${playerSpotlight.currentPoints.toFixed(1)} from ${playerSpotlight.proTeam ?? "their lineup"}.` : "Start the livecast to generate the first moment.")}</p>
        </article>
      </section>

      </div>
      {showAdvanced && (
        <aside
          className="producer-drawer"
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="producer-drawer-title"
        >
          <div className="drawer-head">
            <div>
              <p className="eyebrow">Settings</p>
              <h2 id="producer-drawer-title">{setupPaneTitle(setupPane)}</h2>
              <p>{setupPaneDescription(setupPane)}</p>
            </div>
            <button className="secondary compact" onClick={closeDrawer}>Close</button>
          </div>

          <nav className="setup-tabs" aria-label="Setup sections">
            {(["league", "stream", "friends", "voice", "diagnostics"] as SetupPane[]).map((pane) => (
              <button key={pane} className={setupPane === pane ? "active" : ""} onClick={() => setSetupPane(pane)}>
                {setupPaneTitle(pane)}
              </button>
            ))}
          </nav>

          <div className="producer-grid">
            <section className={setupPane === "stream" ? "producer-mini-player is-active" : "producer-mini-player is-hidden"}>
              <ScoreBug game={game} mediaIndex={mediaIndex} />
              <div>
                <strong>{game ? `${game.awayTeam} at ${game.homeTeam}` : "Demo watch party"}</strong>
                <span>{videoNotice}</span>
              </div>
              <button className="secondary compact" onClick={validateFrameNow}>Validate frame</button>
            </section>

            <ControlGroup title="Quick Start" className={setupPane === "league" ? "is-active" : "is-hidden"}>
              <div className="quick-start">
                <strong>Clean demo rehearsal</strong>
                <span>Uses demo fantasy, scripted plays, no video, and voice off. Good for checking the livecast flow without provider noise.</span>
                <button className="secondary" onClick={prepareDemoRehearsal}>Prepare demo run</button>
              </div>
            </ControlGroup>

            <ControlGroup title="League and game" className={setupPane === "league" ? "is-active primary-pane" : "is-hidden"}>
              <label>
                Fantasy source
                <select
                  value={providerMode}
                  onChange={(event) => {
                    const nextMode = event.target.value as "demo" | "sleeper" | "espn";
                    setProviderMode(nextMode);
                    setImportPreview(undefined);
                    setImportStatus("Ready to validate");
                    if (nextMode === "demo") {
                      setFantasy(customLeague ?? demoLeagueState);
                      setProviders((current) => ({ ...current, fantasy: customLeague ? "Custom Demo Fantasy" : "Demo Fantasy" }));
                    }
                  }}
                >
                  <option value="demo">Demo league</option>
                  <option value="sleeper">Sleeper league</option>
                  <option value="espn">ESPN league</option>
                </select>
              </label>
              <label>
                Sports data source
                <select
                  value={sportsDataMode}
                  onChange={(event) => {
                    const nextMode = event.target.value as "demo" | "espn";
                    setSportsDataMode(nextMode);
                    setSportsGameId("");
                    setProviders((current) => ({ ...current, sportsData: nextMode === "espn" ? "ESPN Scoreboard" : "Demo Sports Data" }));
                    void refreshDiagnostics(nextMode);
                  }}
                >
                  <option value="demo">Demo scripted plays</option>
                  <option value="espn">ESPN public scoreboard</option>
                </select>
              </label>
              <label>
                Game
                <select
                  value={sportsGameId}
                  onChange={(event) => {
                    setSportsGameId(event.target.value);
                    const selected = sportsGames.find((item) => item.id === event.target.value);
                    if (selected) {
                      setGame((current) => ({
                        provider: sportsDataMode === "espn" ? "espn-scoreboard" : "demo-sports-data",
                        gameId: selected.id,
                        sport: "nfl",
                        awayTeam: selected.awayTeam,
                        homeTeam: selected.homeTeam,
                        status: selected.status,
                        recentPlays: current?.gameId === selected.id ? current.recentPlays : [],
                        currentPlay: current?.gameId === selected.id && current.currentPlay ? current.currentPlay : sportsGameOptionPlay(selected),
                        updatedAt: new Date().toISOString()
                      }));
                    }
                  }}
                >
                  <option value="">{sportsDataMode === "espn" ? "Auto-select live or next game" : "Demo scripted game"}</option>
                  {sportsGames.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.shortName} - {option.detail}
                    </option>
                  ))}
                </select>
                <span className="hint">{sportsGamesStatus}</span>
              </label>
              <div className="import-wizard">
                <div>
                  <strong>Fantasy Import Wizard</strong>
                  <span>{importStatus}</span>
                </div>
                <button className="secondary compact" onClick={loadImportPreview}>Validate</button>
              </div>
              {providerMode === "sleeper" && (
                <>
                  <label>
                    Sleeper league ID
                    <input value={sleeperLeagueId} onChange={(event) => setSleeperLeagueId(event.target.value)} placeholder="1234567890" />
                  </label>
                  <label>
                    Week
                    <input type="number" min="1" max="22" value={week} onChange={(event) => setWeek(Number(event.target.value))} />
                  </label>
                  <button className="secondary" onClick={loadLeague}>Load Sleeper league</button>
                </>
              )}
              {providerMode === "espn" && (
                <>
                  <label>
                    ESPN league ID
                    <input value={espnLeagueId} onChange={(event) => setEspnLeagueId(event.target.value)} placeholder="123456" />
                  </label>
                  <label>
                    ESPN season
                    <input type="number" min="2018" max="2100" value={espnSeason} onChange={(event) => setEspnSeason(Number(event.target.value))} />
                  </label>
                  <label>
                    Scoring period / week
                    <input type="number" min="1" max="22" value={week} onChange={(event) => setWeek(Number(event.target.value))} />
                  </label>
                  <button className="secondary" onClick={loadLeague}>Load ESPN league</button>
                  <p className="hint">Public ESPN leagues may load by ID. Private leagues require server-side ESPN_SWID and ESPN_S2 in .env.</p>
                </>
              )}
              {providerMode === "demo" && (
                <div className="custom-demo-editor">
                  <div className="section-heading">
                    <h2>Custom Demo League</h2>
                    <div>
                      <button className="secondary compact" onClick={resetCustomLeague}>Sample</button>
                      <button className="secondary compact" onClick={applyCustomLeague}>Apply</button>
                    </div>
                  </div>
                  <textarea value={customLeagueJson} onChange={(event) => setCustomLeagueJson(event.target.value)} aria-label="Custom demo league JSON" spellCheck={false} />
                  <p className={customLeagueError ? "form-error" : "hint"}>{customLeagueError || "Edit roster/player IDs here, then apply. Scripted plays match players by id."}</p>
                </div>
              )}
            </ControlGroup>

            <ControlGroup title="Stream" className={setupPane === "stream" ? "is-active primary-pane" : "is-hidden"}>
              <div className="segmented">
                {(["stream-url", "screen-share", "vod"] as VideoMode[]).map((mode) => (
                  <button key={mode} className={videoMode === mode ? "active" : ""} onClick={() => setVideoMode(mode)}>
                    {mode.replace("-", " ")}
                  </button>
                ))}
              </div>
              {videoMode !== "screen-share" ? (
                <label>
                  Stream or VOD URL
                  <input
                    value={videoUrl}
                    onChange={(event) => {
                      setVideoUrl(event.target.value);
                      setVideoNotice(
                        event.target.value
                          ? isYouTubeUrl(event.target.value)
                            ? "YouTube preview enabled. Playback depends on the video allowing embeds."
                            : "Using a user-provided video source. Keep it licensed or otherwise permitted."
                          : "Demo mode can run without video."
                      );
                    }}
                    onError={() => setVideoNotice("The browser could not load that media URL. Demo commentary still works.")}
                    placeholder="https://..."
                  />
                </label>
              ) : (
                <button className="secondary" onClick={startScreenShare}>Start screen share</button>
              )}
              <p className="hint">{videoNotice}</p>
              <button className="secondary" onClick={validateFrameNow}>Validate current frame</button>
              <StreamValidationPanel observation={lastObservation} frameCaptureStatus={frameCaptureStatus} onValidate={validateFrameNow} onScreenShare={startScreenShare} />
            </ControlGroup>

            <ControlGroup title="Friends" className={setupPane === "friends" ? "is-active primary-pane" : "is-hidden"}>
              <p className="hint">Add the people in the room, match them to rosters, and give the host one personal note to play with.</p>
              {group.friends.map((friend) => (
                <div className="friend-editor" key={friend.id}>
                  <input value={friend.name} onChange={(event) => updateFriend(friend.id, "name", event.target.value)} aria-label="Friend name" />
                  <input value={friend.favoriteTeam} onChange={(event) => updateFriend(friend.id, "favoriteTeam", event.target.value)} aria-label="Favorite team" />
                  <select value={friend.rosterId ?? ""} onChange={(event) => updateFriendRoster(friend.id, event.target.value)} aria-label="Fantasy roster">
                    <option value="">No roster</option>
                    {rosterOptions.map((roster) => (
                      <option key={roster.id} value={roster.id}>{roster.label}</option>
                    ))}
                  </select>
                  <button className="icon-button" onClick={() => removeFriend(friend.id)} aria-label={`Remove ${friend.name}`}>-</button>
                  <input value={friend.rivalryNotes ?? ""} onChange={(event) => updateFriend(friend.id, "rivalryNotes", event.target.value)} aria-label="Rivalry note" />
                </div>
              ))}
              <button className="secondary" onClick={addFriend}>Add friend</button>
            </ControlGroup>

            <ControlGroup title="Voice and tone" className={setupPane === "voice" ? "is-active primary-pane" : "is-hidden"}>
              <label>
                Tone
                <select value={group.tone} onChange={(event) => setGroup({ ...group, tone: event.target.value as GroupSettings["tone"] })}>
                  <option value="family">Family</option>
                  <option value="pg">PG</option>
                  <option value="chaos">Chaos</option>
                </select>
              </label>
              <label>
                Commentary priority
                <select value={group.homeTeamBias} onChange={(event) => setGroup({ ...group, homeTeamBias: event.target.value as GroupSettings["homeTeamBias"] })}>
                  <option value="fantasy-first">Fantasy first</option>
                  <option value="favorite-team-first">Favorite team first</option>
                  <option value="balanced">Balanced</option>
                </select>
              </label>
              <label className="toggle">
                <input type="checkbox" checked={ttsEnabled} onChange={(event) => setTtsEnabled(event.target.checked)} />
                Speak commentary
              </label>
              <label>
                Commentary cadence
                <input type="range" min="3" max="15" value={cadenceSeconds} onChange={(event) => setCadenceSeconds(Number(event.target.value))} />
                <span className="hint">{cadenceSeconds}s between calls</span>
              </label>
              <label>
                Voice speed
                <input type="range" min="0.8" max="1.25" step="0.05" value={speechRate} onChange={(event) => setSpeechRate(Number(event.target.value))} />
                <span className="hint">{speechRate.toFixed(2)}x browser voice speed</span>
              </label>
            </ControlGroup>

            <ControlGroup title="Diagnostics" className={setupPane === "diagnostics" ? "is-active primary-pane" : "is-hidden"}>
              <div className="diagnostic-actions">
                <button className="secondary compact" onClick={refreshHealth}>Health</button>
                <button className="secondary compact" onClick={refreshMediaManifest}>Media</button>
                <button className="secondary compact" onClick={refreshModelStack}>Models</button>
                <button className="secondary compact" onClick={() => void refreshDiagnostics()}>Providers</button>
              </div>
              <div className="provider-stack-list">
                {Object.entries(providers).map(([key, value]) => (
                  <div className="provider-row" key={key}>
                    <span>{labelize(key)}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <div className="media-cache-summary">
                <strong>{mediaStatus}</strong>
                {mediaManifest ? (
                  <>
                    <span>{cacheCount(mediaManifest, "cached")} cached, {cacheCount(mediaManifest, "generated")} generated</span>
                    <small>Updated {new Date(mediaManifest.generatedAt).toLocaleString()}</small>
                  </>
                ) : (
                  <span>Run npm run media:cache to create local assets.</span>
                )}
              </div>
              {modelStack ? <ModelStackView stack={modelStack} /> : <p className="empty">Waiting for model stack.</p>}
              <div className="health-stack">
                {health.map((item) => (
                  <div className="health-row" key={item.id}>
                    <span data-status={item.status} />
                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </div>
                  </div>
                ))}
              </div>
              {diagnostics?.checks.map((check) => (
                <div className="diagnostic-row" key={check.id}>
                  <span data-status={check.status} />
                  <div>
                    <strong>{check.label}</strong>
                    <small>{check.detail}</small>
                  </div>
                </div>
              ))}
            </ControlGroup>

            <SetupGuide
              pane={setupPane}
              providerMode={providerMode}
              sportsDataMode={sportsDataMode}
              videoMode={videoMode}
              friendCount={group.friends.length}
              ttsEnabled={ttsEnabled}
            />

            {formError && <p className="form-error">{formError}</p>}
          </div>
        </aside>
      )}
      <ProfileModal
        open={profileEditorOpen}
        profile={profile}
        leagues={allLeagues}
        demoMode={demoMode}
        intent={profileEditorIntent}
        onClose={() => setProfileEditorOpen(false)}
        onSave={(next) => {
          setProfile(next);
          setProfileEditorOpen(false);
          setProfileNudgeDismissed(true);
          setPendingRosterClaim(false);
        }}
        onConnectFantasy={async (provider, leagueId) => {
          // After a successful connection, mark that we should reopen
          // to claim the roster. The league effect below picks this up
          // once the new league lands.
          const ok = await connectFantasyInline(provider, leagueId);
          if (ok) setPendingRosterClaim(true);
          return ok;
        }}
        onPrepareDemo={() => {
          prepareDemoRehearsal();
          setProfileEditorIntent("demo");
        }}
      />
      <DebugPanel />
    </main>
  );
}

/**
 * W19: Markets overlay. Sits next to the ScoreBug and surfaces the
 * 2-3 most-relevant Kalshi/Polymarket prices for the game, refreshed
 * every 8 seconds. This is the listener-facing read on what the
 * crowd thinks while the hosts are talking — the AI ticker matches
 * the price the persona may also cite on-air.
 *
 * Renders nothing (silent) when there are no relevant markets so the
 * overlay doesn't clutter sports/leagues that aren't covered yet.
 */
function MarketsTicker({
  game,
  swing
}: {
  game?: SportsGameState;
  /** Most recent market-swing event from the live show. When present, the matching row flashes briefly. */
  swing?: { source: string; externalId: string; deltaCents: number; emittedAt: number };
}) {
  const [snapshots, setSnapshots] = useState<MarketSnapshot[]>([]);
  // Flash state: which row id to highlight, cleared after the
  // animation duration so a stale swing doesn't keep glowing.
  const [flashKey, setFlashKey] = useState<string | undefined>();
  useEffect(() => {
    if (!swing) return;
    const key = `${swing.source}:${swing.externalId}`;
    setFlashKey(key);
    const timer = window.setTimeout(() => {
      setFlashKey((current) => (current === key ? undefined : current));
    }, 4500);
    return () => window.clearTimeout(timer);
    // emittedAt changes on every new swing, even for the same market,
    // so the flash retriggers cleanly when the same row moves twice.
  }, [swing?.source, swing?.externalId, swing?.emittedAt]);

  useEffect(() => {
    if (!game?.sport) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const response = await fetch(`/api/markets?sport=${encodeURIComponent(game.sport)}`, {
          cache: "no-store"
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { snapshots?: MarketSnapshot[] };
        if (cancelled) return;
        setSnapshots(Array.isArray(payload.snapshots) ? payload.snapshots : []);
      } catch {
        // Silent — markets are an enhancement, not a blocker. The
        // ticker hides itself when there are no relevant snapshots.
      }
    };

    void tick();
    timer = setInterval(tick, 8000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [game?.sport]);

  const relevant = useMemo(() => {
    if (!game?.sport || snapshots.length === 0) return [];
    return pickRelevantMarketsForGame(
      snapshots,
      { sport: game.sport, teams: [game.awayTeam, game.homeTeam] },
      3
    );
  }, [snapshots, game?.sport, game?.awayTeam, game?.homeTeam]);

  if (!relevant.length) return null;

  return (
    <div className="markets-ticker" aria-label="Live prediction market prices">
      <span className="markets-ticker-eyebrow">Markets</span>
      <ul>
        {relevant.map((snapshot) => {
          const delta = snapshot.recentDeltaCents ?? 0;
          const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
          const key = `${snapshot.source}:${snapshot.externalId}`;
          const isFlashing = flashKey === key;
          return (
            <li
              key={key}
              data-source={snapshot.source}
              data-direction={direction}
              className={isFlashing ? "is-flashing" : undefined}
            >
              <span className="markets-ticker-source">{snapshot.source === "kalshi" ? "Kalshi" : "Polymarket"}</span>
              <span className="markets-ticker-title" title={snapshot.title}>{snapshot.outcomeLabel}</span>
              <span className="markets-ticker-price">
                {snapshot.yesPriceCents}¢
                {delta !== 0 && (
                  <em className={`markets-ticker-delta is-${direction}`}>
                    {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}¢
                  </em>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * W20: "Nemotron sees" panel. Shows the listener what the vision
 * model is currently observing in the broadcast (or screen-share)
 * frame, with model attribution and freshness. Hidden silently when
 * no observation has landed yet so the rail isn't a placeholder
 * before the first frame analysis.
 *
 * Pulls from the same `lastObservation` state already set by the
 * commentary/observation websocket events — the panel is purely a
 * read view, no extra fetches.
 */
function NemotronSeesPanel({
  observation,
  modelLabel
}: {
  observation?: LivecastCommentary["observation"];
  modelLabel?: string;
}) {
  if (!observation) return null;
  const validation = observation.validation;
  const status = validation?.status ?? "unavailable";
  const confidencePct = Math.round((validation?.confidence ?? observation.confidence ?? 0) * 100);
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(observation.observedAt)) / 1000));
  const evidence = validation?.evidence?.slice(0, 3) ?? [];
  const headline =
    status === "sports-event"
      ? `${(validation?.sport ?? "Sports").replace(/^./, (c) => c.toUpperCase())} broadcast confirmed`
      : status === "not-sports"
        ? "Frame doesn't look like a sporting event"
        : status === "uncertain"
          ? "Visual context uncertain"
          : "Waiting on a usable frame";
  return (
    <article className="huddle-card nemotron-sees-card" data-status={status}>
      <header className="nemotron-sees-header">
        <span className="eyebrow nemotron-eyebrow">
          <span className="nemotron-dot" aria-hidden="true" />
          Nemotron sees
        </span>
        <span className="nemotron-meta">{modelLabel ?? "Nano Omni"}</span>
      </header>
      <h3>{headline}</h3>
      <p className="nemotron-summary">{observation.summary}</p>
      <div className="nemotron-metrics">
        <Metric label="Confidence" value={`${confidencePct}%`} />
        <Metric label="Frame" value={observation.usedFrame ? "live" : "—"} />
        <Metric label="Updated" value={ageSeconds < 5 ? "just now" : `${ageSeconds}s ago`} />
      </div>
      {evidence.length > 0 && (
        <ul className="nemotron-evidence">
          {evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ScoreBug({ game, mediaIndex }: { game?: SportsGameState; mediaIndex: MediaLookupIndex }) {
  return (
    <div className="score-bug" aria-label="Score">
      <div>
        <MediaAvatar src={game?.awayMeta?.logo} asset={resolveTeamMedia(mediaIndex, game?.awayTeam)} label={game?.awayTeam ?? "AWAY"} size="sm" />
        <span>{game?.awayTeam ?? "AWAY"}</span>
        <strong>{game?.currentPlay?.score.away ?? 0}</strong>
      </div>
      <div>
        <MediaAvatar src={game?.homeMeta?.logo} asset={resolveTeamMedia(mediaIndex, game?.homeTeam)} label={game?.homeTeam ?? "HOME"} size="sm" />
        <span>{game?.homeTeam ?? "HOME"}</span>
        <strong>{game?.currentPlay?.score.home ?? 0}</strong>
      </div>
      <div>
        <span>Clock</span>
        <strong>{game?.currentPlay ? `${game.currentPlay.quarter} ${game.currentPlay.clock}` : "Demo"}</strong>
      </div>
    </div>
  );
}

function MicroIcon({ name }: { name: "ai-settings" | "controller" | "export" | "live-video" | "party" | "play" | "stop" | "trophy" }) {
  return <span className="micro-icon" data-icon={name} aria-hidden="true" />;
}

function HuddleExperience({
  phase,
  game,
  fantasy,
  group,
  hosts,
  hostTurns,
  setupSteps,
  matchupStory,
  fantasySpotlight,
  recapSummary,
  plays,
  commentary,
  matchupTotals,
  mediaIndex,
  youtubeEmbedUrl,
  hasVideoSource,
  videoRef,
  status,
  audioPlaying,
  audioLevels,
  ttsEnabled,
  onPrepareDemo,
  onStart,
  onStop,
  onOpenSettings,
  onOpenStream,
  onOpenFriends,
  onChooseEspn,
  onChooseSleeper,
  onChooseScreenShare,
  onChooseUrl,
  onExportRecap,
  onVideoError,
  demoMode,
  pregameReadiness,
  emptySetup,
  onPickAndStart,
  onPickGame,
  onGoHome,
  viewingHome,
  livecastActive,
  onReturnToShow,
  profile,
  onOpenProfile,
  showProfileNudge,
  onDismissProfileNudge,
  claimedTeamName,
  providerMode,
  listenerStakes,
  listenerSpotlights,
  listenerRecapHighlight,
  allLeagues,
  pastShows,
  tonightGlance,
  onNudgeHost,
  onSubmitCue,
  onArchiveClip,
  onGetClipSubtitles,
  observation,
  modelLabel,
  marketSwing,
  pregameNews,
  pregameOdds,
  friendMatchups
}: {
  phase: HuddlePhase;
  game?: SportsGameState;
  fantasy?: FantasyLeagueState;
  group: GroupSettings;
  hosts: typeof HUDDLE_HOSTS;
  hostTurns: HuddleHostTurn[];
  setupSteps: HuddleSetupStep[];
  matchupStory: ReturnType<typeof buildMatchupStory>;
  fantasySpotlight: ReturnType<typeof buildFantasySpotlight>;
  recapSummary: ReturnType<typeof buildRecapSummary>;
  plays: SportsPlay[];
  commentary: LivecastCommentary[];
  matchupTotals: Array<{ id: string; ownerName: string; teamName: string; team?: string; points: number }>;
  mediaIndex: MediaLookupIndex;
  youtubeEmbedUrl?: string;
  hasVideoSource: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoMode: VideoMode;
  videoUrl: string;
  status: string;
  audioPlaying: boolean;
  audioLevels: number[];
  ttsEnabled: boolean;
  onPrepareDemo: () => void;
  onStart: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
  onOpenStream: () => void;
  onOpenFriends: () => void;
  onChooseEspn: () => void;
  onChooseSleeper: () => void;
  onChooseScreenShare: () => void;
  onChooseUrl: () => void;
  onExportRecap: () => void;
  onVideoError: () => void;
  demoMode: boolean;
  pregameReadiness: { canStart: boolean; requirements: Array<{ id: string; label: string; met: boolean }> };
  emptySetup: EmptyStateSetup;
  onPickAndStart: (gameId: string, dataMode: "demo" | "espn") => void;
  onPickGame: (gameId: string, dataMode: "demo" | "espn") => void;
  onGoHome: () => void;
  viewingHome: boolean;
  livecastActive: boolean;
  onReturnToShow: () => void;
  profile?: UserProfile;
  onOpenProfile: (intent?: ProfileModalIntent) => void;
  showProfileNudge: boolean;
  onDismissProfileNudge: () => void;
  claimedTeamName?: string;
  providerMode: "demo" | "sleeper" | "espn";
  listenerStakes?: ReturnType<typeof buildListenerStakes>;
  listenerSpotlights: ReturnType<typeof buildListenerGameSpotlights>;
  listenerRecapHighlight?: ReturnType<typeof buildListenerRecapHighlight>;
  allLeagues: FantasyLeagueState[];
  pastShows: ShowHistoryEntry[];
  tonightGlance?: ReturnType<typeof buildTonightAtAGlance>;
  onNudgeHost: (hostId: HostId) => void;
  onSubmitCue?: (cue: ListenerCue) => boolean;
  onArchiveClip?: (commentaryId: string) => Promise<string | undefined>;
  onGetClipSubtitles?: (commentaryId: string) => Promise<{ vtt: string; text: string } | undefined>;
  observation?: LivecastCommentary["observation"];
  modelLabel?: string;
  marketSwing?: { source: string; externalId: string; deltaCents: number; emittedAt: number };
  pregameNews: NewsItem[];
  pregameOdds?: GameOdds;
  friendMatchups: ReturnType<typeof buildFriendMatchups>;
}) {
  // Effective view: home overrides phase. Phase still drives downstream
  // logic (player bar visibility, etc.) but the rendered surface is
  // discover when viewingHome is true.
  const showHome = viewingHome || phase === "empty";
  const gameLabel = showHome ? "Choose a game" : game ? `${game.awayTeam} at ${game.homeTeam}` : "Choose a game";
  const roomLabel = showHome
    ? "Connect fantasy · choose stream · meet hosts"
    : `${fantasy?.leagueName ?? "Your league"} · ${group.friends.length} friend${group.friends.length === 1 ? "" : "s"} · ${ttsEnabled ? "voice on" : "voice off"}`;
  return (
    <>
      <HuddleSidebar fantasy={fantasy} allLeagues={allLeagues} group={group} phase={showHome ? "empty" : phase} profile={profile} pastShows={pastShows} onOpenSettings={onOpenSettings} onOpenFriends={onOpenFriends} onGoHome={onGoHome} onOpenProfile={onOpenProfile} />
      <section className="huddle-main" aria-label="Huddle Radio">
        {!showHome && <HuddleTopBar phase={phase} status={status} roomLabel={roomLabel} gameLabel={gameLabel} onOpenSettings={onOpenSettings} demoMode={demoMode} onGoHome={onGoHome} profile={profile} claimedTeamName={claimedTeamName} providerMode={providerMode} />}
        {showHome && (
          <HuddleDiscover
            setup={emptySetup}
            readiness={pregameReadiness}
            demoMode={demoMode}
            mediaIndex={mediaIndex}
            onPickAndStart={onPickAndStart}
            onPickGame={onPickGame}
            onPrepareDemo={onPrepareDemo}
            onOpenSetup={onOpenSettings}
            profile={profile}
            onOpenProfile={onOpenProfile}
            showProfileNudge={showProfileNudge}
            onDismissProfileNudge={onDismissProfileNudge}
            listenerSpotlights={listenerSpotlights}
            tonightGlance={tonightGlance}
          />
        )}
        {!showHome && phase === "pregame" && (
          <HuddlePregame
            game={game}
            fantasy={fantasy}
            hosts={hosts}
            hostTurns={hostTurns}
            matchupStory={matchupStory}
            fantasySpotlight={fantasySpotlight}
            matchupTotals={matchupTotals}
            mediaIndex={mediaIndex}
            onStart={onStart}
            onOpenStream={onOpenStream}
            onOpenSettings={onOpenSettings}
            onBackToDiscover={onGoHome}
            demoMode={demoMode}
            readiness={pregameReadiness}
            listenerStakes={listenerStakes}
            news={pregameNews}
            odds={pregameOdds}
            friendMatchups={friendMatchups}
            profile={profile}
          />
        )}
        {!showHome && phase === "live" && (
          <HuddleLiveWithStream
            game={game}
            hostTurns={hostTurns}
            fantasySpotlight={fantasySpotlight}
            matchupTotals={matchupTotals}
            mediaIndex={mediaIndex}
            youtubeEmbedUrl={youtubeEmbedUrl}
            hasVideoSource={hasVideoSource}
            videoRef={videoRef}
            onVideoError={onVideoError}
            onStop={onStop}
            observation={observation}
            modelLabel={modelLabel}
            marketSwing={marketSwing}
          />
        )}
        {!showHome && phase === "live-audio" && (
          <HuddleLiveAudio
            game={game}
            fantasy={fantasy}
            hosts={hosts}
            hostTurns={hostTurns}
            plays={plays}
            fantasySpotlight={fantasySpotlight}
            matchupTotals={matchupTotals}
            mediaIndex={mediaIndex}
            onStop={onStop}
            listenerStakes={listenerStakes}
            onNudgeHost={onNudgeHost}
            onSubmitCue={onSubmitCue}
            observation={observation}
            modelLabel={modelLabel}
            profile={profile}
          />
        )}
        {!showHome && phase === "recap" && (
          <HuddleRecap
            game={game}
            hosts={hosts}
            hostTurns={hostTurns}
            recapSummary={recapSummary}
            plays={plays}
            commentary={commentary}
            fantasySpotlight={fantasySpotlight}
            mediaIndex={mediaIndex}
            onStart={onStart}
            onExportRecap={onExportRecap}
            listenerStakes={listenerStakes}
            listenerRecapHighlight={listenerRecapHighlight}
            onArchiveClip={onArchiveClip}
            onGetClipSubtitles={onGetClipSubtitles}
            profile={profile}
          />
        )}
      </section>
      {!showHome && (
        <HuddlePlayerBar
          phase={phase}
          game={game}
          hostTurns={hostTurns}
          audioPlaying={audioPlaying}
          audioLevels={audioLevels}
          onStart={onStart}
          onStop={onStop}
          onOpenStream={onOpenStream}
        />
      )}
      {showHome && livecastActive && game && (
        <MiniPlayer
          game={game}
          mediaIndex={mediaIndex}
          audioPlaying={audioPlaying}
          audioLevels={audioLevels}
          onExpand={onReturnToShow}
          onStop={onStop}
        />
      )}
    </>
  );
}

function HuddleSidebar({ fantasy, allLeagues, group, phase, profile, pastShows, onOpenSettings, onOpenFriends, onGoHome, onOpenProfile }: { fantasy?: FantasyLeagueState; allLeagues: FantasyLeagueState[]; group: GroupSettings; phase: HuddlePhase; profile?: UserProfile; pastShows: ShowHistoryEntry[]; onOpenSettings: () => void; onOpenFriends: () => void; onGoHome: () => void; onOpenProfile: () => void }) {
  // Resolve which roster (if any) belongs to the profile so the sidebar
  // can show the user's actual fantasy team name instead of the first
  // roster in the league. Auto-match by ownerName if no explicit pick.
  const claimedRoster = useMemo(() => {
    if (!fantasy || !profile) return undefined;
    const all = fantasy.matchups.flatMap((matchup) => matchup.rosters);
    if (profile.rosterId) return all.find((roster) => roster.id === profile.rosterId);
    return all.find((roster) => roster.ownerName.toLowerCase() === profile.name.toLowerCase());
  }, [fantasy, profile]);
  // Multi-sport: list every league the listener owns a roster in.
  // Empty when no profile or no matching rosters — degrades gracefully.
  const claimedSports = useMemo(() => {
    if (!profile) return [] as Array<{ sport: SportLeague; teamName: string; leagueName: string }>;
    const out: Array<{ sport: SportLeague; teamName: string; leagueName: string }> = [];
    for (const league of allLeagues) {
      const rosters = league.matchups.flatMap((matchup) => matchup.rosters);
      const claim = profile.leagues?.find((entry) => entry.sport === league.sport);
      const rosterId = claim?.rosterId ?? profile.rosterId;
      const matched = rosterId
        ? rosters.find((roster) => roster.id === rosterId)
        : rosters.find((roster) => roster.ownerName.toLowerCase() === profile.name.toLowerCase());
      if (matched) {
        out.push({ sport: league.sport, teamName: matched.teamName, leagueName: league.leagueName });
      }
    }
    return out;
  }, [allLeagues, profile]);

  return (
    <aside className="huddle-sidebar">
      <div className="huddle-brand">
        <span className="brand-mark" />
        <strong>huddle</strong>
        <b>RADIO</b>
      </div>
      <nav className="huddle-nav" aria-label="Huddle navigation">
        <button className={phase === "empty" ? "active" : ""} onClick={onGoHome}>Home</button>
        <button onClick={onOpenSettings}>Settings</button>
      </nav>
      {profile && (
        <section className="league-room-card">
          <span>League room</span>
          <strong>{fantasy?.leagueName ?? "Redraft League"}</strong>
          <p>{group.friends.length} friends ready for the show.</p>
          <button className="secondary compact" onClick={onOpenFriends}><span className="icon icon-league" aria-hidden="true" />Invite friends</button>
        </section>
      )}
      {pastShows.length > 0 && (
        <section className="show-history-card" aria-label="Your past shows">
          <span className="show-history-eyebrow">
            <span className="icon icon-history" aria-hidden="true" />Your shows
          </span>
          <ul className="show-history-list">
            {pastShows.slice(0, 4).map((entry) => (
              <li key={entry.id} className="show-history-item">
                <span className={`show-history-sport icon ${sportIcon(entry.sport)}`} aria-hidden="true" />
                <div>
                  <strong>{entry.gameLabel}</strong>
                  <span>
                    {formatRelativeTime(entry.endedAt)}
                    {entry.topMoment ? ` · ${entry.topMoment.playerName} ${entry.topMoment.pointsDelta > 0 ? "+" : ""}${entry.topMoment.pointsDelta.toFixed(1)}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <button type="button" className="user-card user-card--button" onClick={onOpenProfile} aria-label={profile ? "Edit your profile" : "Set up your profile"}>
        {profile ? (
          <>
            <HostAvatar label={profile.name} accent="violet" />
            <div>
              <strong>{profile.name}</strong>
              <span>{claimedRoster?.teamName ?? profile.favoriteTeam ?? "Tap to claim a team"}</span>
              {claimedSports.length > 1 && (
                <small className="user-card-sports" aria-label={`Connected to ${claimedSports.length} leagues`}>
                  {claimedSports.map((entry) => (
                    <span key={entry.sport} className={`user-card-sport-chip user-card-sport-chip--${entry.sport}`} title={`${entry.teamName} · ${entry.leagueName}`}>
                      <span className={`icon ${sportIcon(entry.sport)}`} aria-hidden="true" />
                      {sportLabel(entry.sport)}
                    </span>
                  ))}
                </small>
              )}
            </div>
          </>
        ) : (
          <>
            <span className="user-card-pending" aria-hidden="true">
              <span className="icon icon-user" />
            </span>
            <div>
              <strong>Set up your profile</strong>
              <span>Tell us who you are</span>
            </div>
          </>
        )}
      </button>
    </aside>
  );
}

function HuddleTopBar({
  phase,
  status,
  roomLabel,
  gameLabel,
  onOpenSettings,
  demoMode,
  profile,
  claimedTeamName,
  providerMode
}: {
  phase: HuddlePhase;
  status: string;
  roomLabel: string;
  gameLabel: string;
  onOpenSettings: () => void;
  demoMode: boolean;
  onGoHome: () => void;
  profile?: UserProfile;
  claimedTeamName?: string;
  providerMode: "demo" | "sleeper" | "espn";
}) {
  const live = phase === "live" || phase === "live-audio";
  const statusLabel = /status code|error|failed|unavailable/i.test(status) ? "Signal issue" : status;
  // Persistent identity claim. The opener says it once; the topbar says
  // it for the whole show.
  const starring = profile?.name && (live || phase === "pregame" || phase === "recap");
  const heading = starring
    ? `Starring ${profile.name}${claimedTeamName ? ` · ${claimedTeamName}` : ""}`
    : (live ? "Live sports talk" : "Personalized show room");
  // Connection-method badge. Tells listener at a glance whether what
  // they're hearing is fake or real, without breaking immersion.
  const connectionBadge = (() => {
    if (demoMode || providerMode === "demo") return { label: "Demo data", tone: "demo" as const, title: "Running on bundled demo data." };
    if (providerMode === "sleeper") return { label: "Synced · Sleeper", tone: "sync" as const, title: "Hosts are reading your real Sleeper roster." };
    if (providerMode === "espn") return { label: "Synced · ESPN", tone: "sync" as const, title: "Hosts are reading your real ESPN roster." };
    return undefined;
  })();
  return (
    <header className="huddle-topbar">
      <div>
        <span className="eyebrow">Huddle Radio</span>
        <strong>{heading}</strong>
        <p>{gameLabel} · {roomLabel}</p>
      </div>
      <div className="huddle-top-actions">
        {connectionBadge && (
          <span className={`source-badge source-badge--${connectionBadge.tone}`} title={connectionBadge.title}>
            <span className={`icon ${connectionBadge.tone === "sync" ? "icon-share-link" : "icon-sparkle"}`} aria-hidden="true" />
            {connectionBadge.label}
          </span>
        )}
        <span className={live ? "on-air-pill is-live" : "on-air-pill"}>{live ? "On air" : statusLabel}</span>
        <button className="secondary compact" onClick={onOpenSettings}><span className="icon icon-settings" aria-hidden="true" />Settings</button>
      </div>
    </header>
  );
}

type EmptyStateSetup = {
  providerMode: "demo" | "sleeper" | "espn";
  sleeperLeagueId: string;
  espnLeagueId: string;
  sportsGames: SportsGameOption[];
  sportsGamesStatus: string;
  sportsDataMode: "demo" | "espn";
  sportsGameId: string;
  videoMode: VideoMode;
  videoUrl: string;
  hasScreenShare: boolean;
  failedSports: Array<{ sport: SportLeague; label: string }>;
  dismissedFailedSportsKey: string;
  onDismissFailedSports: () => void;
  onConnectFantasy: (provider: "sleeper" | "espn", leagueId: string) => Promise<boolean>;
  onSetSportsDataMode: (mode: "demo" | "espn") => void;
  onPickSportsGame: (gameId: string) => void;
  onSetStreamUrl: (url: string) => void;
  onStartScreenShare: () => Promise<boolean>;
  onRefreshGames: () => void;
};

function HuddleEmptyState({
  hosts,
  onPrepareDemo,
  onStart,
  readiness,
  setup
}: {
  hosts: typeof HUDDLE_HOSTS;
  setupSteps: HuddleSetupStep[];
  onPrepareDemo: () => void;
  onStart: () => void;
  readiness: { canStart: boolean; requirements: Array<{ id: string; label: string; met: boolean }> };
  setup: EmptyStateSetup;
}) {
  const leagueMet = readiness.requirements.find((req) => req.id === "league")?.met ?? false;
  const streamMet = readiness.requirements.find((req) => req.id === "stream")?.met ?? false;
  const allMet = readiness.canStart;
  const initialStep: "league" | "stream" | null = !leagueMet ? "league" : !streamMet ? "stream" : null;
  const [expanded, setExpanded] = useState<"league" | "stream" | null>(initialStep);
  const toggle = (step: "league" | "stream") => setExpanded((current) => (current === step ? null : step));
  const advance = (after: "league" | "stream") => {
    setExpanded(after === "league" ? "stream" : null);
  };
  return (
    <section className="huddle-empty">
      <div className="empty-actions">
        {allMet ? (
          <button onClick={onStart}>Start show <span className="icon icon-broadcast" aria-hidden="true" /></button>
        ) : (
          <button onClick={onPrepareDemo}>Try demo show <span className="icon icon-play" aria-hidden="true" /></button>
        )}
      </div>
      <div className="empty-host-art" aria-label={`${hosts.map((host) => `${host.name}, ${host.role}`).join(", ")} are ready in the studio`} />
      <div className="empty-copy">
        <h1>Let’s get <span>your show</span> started.</h1>
        <p>Connect your fantasy account, pick what you’re watching, and we’ll build your live show around it.</p>
      </div>
      <div className="empty-steps is-reference-layout">
        <EmptyStepLeague
          met={leagueMet}
          expanded={expanded === "league"}
          onToggle={() => toggle("league")}
          setup={setup}
          onComplete={() => advance("league")}
        />
        <EmptyStepStream
          met={streamMet}
          expanded={expanded === "stream"}
          onToggle={() => toggle("stream")}
          setup={setup}
          onComplete={() => advance("stream")}
        />
      </div>
      <div className="empty-note">
        <span className="empty-note-icon" aria-hidden="true"><span className="icon icon-podcast" /></span>
        <p>{allMet
          ? <>You’re ready to go live. Hit <strong>Start show</strong> up top to begin.<br />We can’t wait to talk ball with you.</>
          : <>Not ready to connect yet? Hit <strong>Try demo show</strong> up top to hear what Huddle sounds like.<br />We can’t wait to talk ball with you.</>}</p>
      </div>
    </section>
  );
}

function EmptyStepLeague({
  met,
  expanded,
  onToggle,
  setup,
  onComplete
}: {
  met: boolean;
  expanded: boolean;
  onToggle: () => void;
  setup: EmptyStateSetup;
  onComplete: () => void;
}) {
  const [provider, setProvider] = useState<"sleeper" | "espn" | null>(
    setup.providerMode === "sleeper" ? "sleeper" : setup.providerMode === "espn" ? "espn" : null
  );
  const [leagueId, setLeagueId] = useState(
    setup.providerMode === "sleeper" ? setup.sleeperLeagueId : setup.providerMode === "espn" ? setup.espnLeagueId : ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!provider) return setError("Pick Sleeper or ESPN first.");
    if (!leagueId.trim()) return setError("Enter your league ID.");
    setError("");
    setBusy(true);
    try {
      const ok = await setup.onConnectFantasy(provider, leagueId);
      if (ok) onComplete();
      else setError("Couldn’t connect. Double-check the league ID.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      className={`empty-step${met ? " is-complete" : ""}${expanded ? " is-expanded" : ""}`}
      data-met={met ? "true" : "false"}
    >
      <button type="button" className="empty-step-toggle" onClick={onToggle} aria-label={expanded ? "Collapse step" : "Expand step"} aria-expanded={expanded}>
        <b aria-hidden="true">{met ? "" : "1"}</b>
        <div className="empty-step-summary">
          <span className="empty-step-title">Connect your fantasy</span>
          <p>{met
            ? `${provider === "sleeper" ? "Sleeper" : provider === "espn" ? "ESPN" : "Fantasy"} league connected.`
            : "Link your league so we can talk about your team, your matchups, and what matters most."}</p>
        </div>
        <span className="empty-step-chevron" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="empty-step-form">
          <div className="provider-chips" role="radiogroup" aria-label="Fantasy provider">
            <button
              type="button"
              role="radio"
              aria-checked={provider === "sleeper"}
              className={provider === "sleeper" ? "provider-chip is-selected" : "provider-chip"}
              onClick={() => setProvider("sleeper")}
            >
              <img src="/icons/Logos/Sleeper.png" alt="" />Sleeper
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={provider === "espn"}
              className={provider === "espn" ? "provider-chip is-selected" : "provider-chip"}
              onClick={() => setProvider("espn")}
            >
              <img src="/icons/Logos/ESPN.png" alt="" />ESPN
            </button>
            <button type="button" className="provider-chip is-disabled" disabled title="Yahoo coming soon">
              <img src="/icons/Logos/Yahoo.png" alt="" />Yahoo
              <span className="provider-chip-soon">soon</span>
            </button>
          </div>
          {provider && (
            <label className="empty-step-field">
              <span>{provider === "sleeper" ? "Sleeper league ID" : "ESPN league ID"}</span>
              <input
                value={leagueId}
                onChange={(event) => setLeagueId(event.target.value)}
                placeholder={provider === "sleeper" ? "1234567890" : "123456"}
                onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
              />
            </label>
          )}
          {error && <p className="empty-step-error">{error}</p>}
          <div className="button-row">
            <button className="secondary" onClick={() => void submit()} disabled={busy}>
              {busy ? "Connecting…" : "Connect"}<span className="icon icon-arrow-right" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function EmptyStepStream({
  met,
  expanded,
  onToggle,
  setup,
  onComplete
}: {
  met: boolean;
  expanded: boolean;
  onToggle: () => void;
  setup: EmptyStateSetup;
  onComplete: () => void;
}) {
  const [tab, setTab] = useState<"games" | "url" | "screen">(
    setup.videoMode === "screen-share" ? "screen" : setup.videoUrl ? "url" : "games"
  );
  const [urlValue, setUrlValue] = useState(setup.videoUrl);
  useEffect(() => {
    // Auto-fetch ESPN games when this card is opened on the games tab.
    if (expanded && tab === "games" && setup.sportsGames.length === 0) {
      setup.onRefreshGames();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, tab]);
  const submitUrl = () => {
    setup.onSetStreamUrl(urlValue);
    if (urlValue.trim()) onComplete();
  };
  const submitScreen = async () => {
    const ok = await setup.onStartScreenShare();
    if (ok) onComplete();
  };
  return (
    <article
      className={`empty-step${met ? " is-complete" : ""}${expanded ? " is-expanded" : ""}`}
      data-met={met ? "true" : "false"}
    >
      <button type="button" className="empty-step-toggle" onClick={onToggle} aria-label={expanded ? "Collapse step" : "Expand step"} aria-expanded={expanded}>
        <b aria-hidden="true">{met ? "" : "2"}</b>
        <div className="empty-step-summary">
          <span className="empty-step-title">Choose what you’re watching</span>
          <p>{met
            ? setup.videoMode === "screen-share"
              ? "Screen share connected."
              : setup.videoUrl
                ? "Stream URL set."
                : `Game picked.`
            : "Pick a live game from the schedule, paste a stream URL, or share your screen."}</p>
        </div>
        <span className="empty-step-chevron" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="empty-step-form">
          <div className="stream-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "games"} className={tab === "games" ? "is-active" : ""} onClick={() => setTab("games")}>
              <span className="icon icon-calendar" aria-hidden="true" />NFL games
            </button>
            <button role="tab" aria-selected={tab === "url"} className={tab === "url" ? "is-active" : ""} onClick={() => setTab("url")}>
              <span className="icon icon-broadcast" aria-hidden="true" />Stream URL
            </button>
            <button role="tab" aria-selected={tab === "screen"} className={tab === "screen" ? "is-active" : ""} onClick={() => setTab("screen")}>
              <span className="icon icon-shows" aria-hidden="true" />Screen share
            </button>
          </div>
          {tab === "games" && (
            <div className="games-picker" role="tabpanel">
              <div className="games-picker-header">
                <div className="segmented small">
                  <button className={setup.sportsDataMode === "espn" ? "active" : ""} onClick={() => setup.onSetSportsDataMode("espn")}>Live (ESPN)</button>
                  <button className={setup.sportsDataMode === "demo" ? "active" : ""} onClick={() => setup.onSetSportsDataMode("demo")}>Demo</button>
                </div>
                <button className="secondary compact" onClick={setup.onRefreshGames}>
                  <span className="icon icon-arrow-up" aria-hidden="true" />Refresh
                </button>
              </div>
              {setup.sportsGames.length === 0 ? (
                <p className="empty-step-error">{setup.sportsGamesStatus}</p>
              ) : (
                <ul className="games-list">
                  {setup.sportsGames.map((option) => {
                    const status = statusLabel(option.status);
                    const detail = (option.detail ?? "").trim();
                    const showDetail = detail.length > 0 && detail.toLowerCase() !== status.toLowerCase();
                    return (
                      <li key={option.id}>
                        <button
                          type="button"
                          className={setup.sportsGameId === option.id ? "game-row is-selected" : "game-row"}
                          onClick={() => { setup.onPickSportsGame(option.id); onComplete(); }}
                        >
                          <span className="game-row-teams">
                            <strong>{option.awayTeam}</strong>
                            <em>at</em>
                            <strong>{option.homeTeam}</strong>
                          </span>
                          <span className="game-row-meta">
                            {showDetail && <span className="game-row-detail">{detail}</span>}
                            <span className={`game-row-status game-row-status--${option.status}`}>{status}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
          {tab === "url" && (
            <div className="empty-step-stream-url" role="tabpanel">
              <label className="empty-step-field">
                <span>Stream or VOD URL</span>
                <input
                  value={urlValue}
                  onChange={(event) => setUrlValue(event.target.value)}
                  placeholder="https://www.youtube.com/watch?v=…"
                  onKeyDown={(event) => { if (event.key === "Enter") submitUrl(); }}
                />
              </label>
              <p className="empty-step-hint">YouTube, Twitch, M3U8, or any direct video URL.</p>
              <div className="button-row">
                <button className="secondary" onClick={submitUrl}>Use this URL <span className="icon icon-arrow-right" aria-hidden="true" /></button>
              </div>
            </div>
          )}
          {tab === "screen" && (
            <div className="empty-step-screen" role="tabpanel">
              <p className="empty-step-hint">Share a tab, window, or display — useful for ESPN, YouTube TV, or anything behind a login.</p>
              <div className="button-row">
                <button className="secondary" onClick={() => void submitScreen()}>
                  <span className="icon icon-shows" aria-hidden="true" />{setup.hasScreenShare ? "Replace screen share" : "Start screen share"}
                </button>
              </div>
              {setup.hasScreenShare && <p className="empty-step-hint">Screen share is active. You can change it anytime.</p>}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

type ProfileModalIntent = "edit" | "demo" | "sync";

/**
 * Modal a11y: Escape closes the modal, focus is trapped while open,
 * and focus returns to the previously-focused element on close.
 *
 * Pass a ref pointing at the dialog root. Call site is responsible for
 * `role="dialog"` / `aria-modal="true"` on that element.
 */
function useDialogA11y(open: boolean, dialogRef: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const focusables = Array.from(
        node.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
      ).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("tabindex") !== "-1");
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      // Restore focus to whatever the user had before opening the
      // modal — without this, keyboard users land on <body> after
      // close and lose their place in the page.
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [open, dialogRef, onClose]);
}

function ProfileModal({
  open,
  profile,
  leagues,
  demoMode,
  intent,
  onClose,
  onSave,
  onConnectFantasy,
  onPrepareDemo
}: {
  open: boolean;
  profile?: UserProfile;
  leagues: FantasyLeagueState[];
  demoMode: boolean;
  intent: ProfileModalIntent;
  onClose: () => void;
  onSave: (profile: UserProfile) => void;
  onConnectFantasy: (provider: "sleeper" | "espn", leagueId: string) => Promise<boolean>;
  onPrepareDemo: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useDialogA11y(open, dialogRef, onClose);
  const [name, setName] = useState(profile?.name ?? "");
  const [favoriteTeam, setFavoriteTeam] = useState(profile?.favoriteTeam ?? "");
  // Multi-sport: rosterId per sport, keyed by SportLeague. Profile may
  // already have entries via `leagues`; legacy single rosterId fills in.
  const initialRosterBySport = useMemo(() => {
    const map: Partial<Record<SportLeague, string>> = {};
    for (const claim of profile?.leagues ?? []) map[claim.sport] = claim.rosterId;
    return map;
  }, [profile?.leagues]);
  const [rosterIdBySport, setRosterIdBySport] = useState<Partial<Record<SportLeague, string>>>(initialRosterBySport);
  const [error, setError] = useState("");
  const [connectProvider, setConnectProvider] = useState<"sleeper" | "espn" | null>(null);
  const [leagueIdInput, setLeagueIdInput] = useState("");
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState("");

  useEffect(() => {
    if (open) {
      setName(profile?.name ?? "");
      setFavoriteTeam(profile?.favoriteTeam ?? "");
      setRosterIdBySport(initialRosterBySport);
      setError("");
      setConnectProvider(null);
      setLeagueIdInput("");
      setConnectError("");
    }
  }, [open, profile, initialRosterBySport]);

  // Per-league roster lists, each tagged with its sport.
  const leagueSections = useMemo(() => {
    const trimmed = name.trim().toLowerCase();
    return leagues.map((league) => {
      const rosters = league.matchups.flatMap((matchup) =>
        matchup.rosters.map((roster) => ({ ...roster, week: matchup.week }))
      );
      const suggested = trimmed
        ? rosters.find((roster) => roster.ownerName.toLowerCase() === trimmed)?.id
        : undefined;
      return { league, rosters, suggested };
    });
  }, [leagues, name]);

  if (!open) return null;

  const submitProfile = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Pick a name — it's how the hosts will address you.");
      return;
    }
    // Resolve a roster claim per league: explicit pick → suggested
    // ownerName match → undefined (the league won't show personalized
    // takes for that sport).
    const resolvedClaims: LeagueClaim[] = [];
    for (const section of leagueSections) {
      const picked = rosterIdBySport[section.league.sport] ?? section.suggested;
      if (!picked) continue;
      const matched = section.rosters.find((roster) => roster.id === picked);
      if (!matched) continue;
      resolvedClaims.push({
        sport: section.league.sport,
        provider: section.league.provider === "sleeper" || section.league.provider === "espn" ? section.league.provider : "demo",
        leagueId: section.league.leagueId,
        leagueName: section.league.leagueName,
        rosterId: matched.id,
        teamName: matched.teamName
      });
    }
    // Legacy `rosterId` keeps single-league flows working; pick the
    // first claim as the canonical fallback.
    const primary = resolvedClaims[0];
    onSave({
      name: trimmedName,
      favoriteTeam: favoriteTeam.trim().toUpperCase() || undefined,
      rosterId: primary?.rosterId,
      leagues: resolvedClaims.length > 0 ? resolvedClaims : undefined
    });
  };

  const submitConnect = async () => {
    if (!connectProvider) return;
    if (!leagueIdInput.trim()) {
      setConnectError("Enter your league ID.");
      return;
    }
    setConnectError("");
    setConnectBusy(true);
    try {
      const ok = await onConnectFantasy(connectProvider, leagueIdInput.trim());
      if (!ok) setConnectError("Couldn't connect — double-check the league ID.");
      else {
        setConnectProvider(null);
        setLeagueIdInput("");
      }
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Couldn't connect.");
    } finally {
      setConnectBusy(false);
    }
  };

  // Frame the modal differently based on the user's path. Same fields,
  // different copy + emphasis so demo and sync feel intentional.
  const isFirstRun = !profile;
  const totalRosters = leagueSections.reduce((sum, section) => sum + section.rosters.length, 0);
  const showConnect = intent !== "demo" && totalRosters === 0;
  const headerCopy = (() => {
    if (intent === "demo") return { eyebrow: "Try the demo as you", title: "Take the demo for a spin", body: "We'll spin up demo leagues across sports. Pick a team in each — the hosts will treat them as yours so you can hear how it feels." };
    if (intent === "sync") return { eyebrow: "Bring your leagues in", title: "Connect your fantasy", body: "Hosts will read your real lineup per sport, call out your matchup, and react when your starters move the needle." };
    if (totalRosters === 0) return { eyebrow: "Your profile", title: "Make this show yours", body: "Tell the hosts who you are. Optionally connect a real fantasy league so they can talk about your actual roster." };
    return { eyebrow: "Your profile", title: isFirstRun ? "Claim your teams" : "Edit your profile", body: "Pick the roster that's yours in each league. The hosts will use the right one based on which game you're watching." };
  })();

  return (
    <div className="profile-modal-backdrop" onMouseDown={onClose}>
      <div className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-modal-title" ref={dialogRef} onMouseDown={(event) => event.stopPropagation()}>
        <header className="profile-modal-header">
          <div>
            <span className="eyebrow"><span className="icon icon-user" aria-hidden="true" />{headerCopy.eyebrow}</span>
            <h2 id="profile-modal-title">{headerCopy.title}</h2>
            <p>{headerCopy.body}</p>
          </div>
          <button className="secondary compact" type="button" onClick={onClose} aria-label="Close">
            <span className="icon icon-close" aria-hidden="true" />
          </button>
        </header>
        <div className="profile-modal-body">
          <label className="profile-field">
            <span>Name</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Mahomes Mahomies"
              autoFocus
              maxLength={40}
            />
            <small>How the hosts will say your name on the air.</small>
          </label>
          <label className="profile-field">
            <span>Favorite team <em>(optional)</em></span>
            <input
              type="text"
              value={favoriteTeam}
              onChange={(event) => setFavoriteTeam(event.target.value.toUpperCase())}
              placeholder="e.g. KC, DET, LAL"
              maxLength={5}
            />
            <small>Used to bias the show toward your team when relevant.</small>
          </label>

          {leagueSections.map((section) => {
            if (section.rosters.length === 0) return null;
            const selected = rosterIdBySport[section.league.sport];
            return (
              <div className="profile-field profile-league-section" key={`${section.league.sport}-${section.league.leagueId}`}>
                <span className="profile-league-heading">
                  <span className={`icon ${sportIcon(section.league.sport)}`} aria-hidden="true" />
                  {section.league.leagueName}
                  <em className="profile-league-sport">{sportLabel(section.league.sport)}</em>
                </span>
                {demoMode && <small style={{ marginTop: 0 }}>Demo league — pick anyone to feel how it works.</small>}
                <div className="profile-roster-list">
                  {section.rosters.map((roster) => (
                    <button
                      key={roster.id}
                      type="button"
                      className={`profile-roster-option${selected === roster.id ? " is-selected" : ""}${!selected && section.suggested === roster.id ? " is-suggested" : ""}`}
                      onClick={() =>
                        setRosterIdBySport((current) => ({ ...current, [section.league.sport]: roster.id }))
                      }
                    >
                      <strong>{roster.teamName}</strong>
                      <span>{roster.ownerName} · Week {roster.week}</span>
                      {!selected && section.suggested === roster.id && <em>matches your name</em>}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}

          {showConnect && (
            <div className="profile-field profile-connect">
              <span>Connect a real league <em>(optional)</em></span>
              {!connectProvider && (
                <>
                  <small>Hosts will read your actual roster and matchup. We won't post anything to your account.</small>
                  <div className="profile-connect-providers">
                    <button type="button" className="secondary" onClick={() => { setConnectProvider("sleeper"); setConnectError(""); }}>
                      <span className="icon icon-share-link" aria-hidden="true" />Sleeper
                    </button>
                    <button type="button" className="secondary" onClick={() => { setConnectProvider("espn"); setConnectError(""); }}>
                      <span className="icon icon-share-link" aria-hidden="true" />ESPN
                    </button>
                  </div>
                  <button type="button" className="profile-skip-link" onClick={onPrepareDemo}>
                    Skip for now — try the demo
                  </button>
                </>
              )}
              {connectProvider && (
                <>
                  <div className="profile-connect-form">
                    <input
                      type="text"
                      value={leagueIdInput}
                      onChange={(event) => setLeagueIdInput(event.target.value)}
                      placeholder={connectProvider === "sleeper" ? "Sleeper league ID" : "ESPN league ID"}
                      maxLength={32}
                    />
                    <button type="button" className="primary" onClick={submitConnect} disabled={connectBusy}>
                      {connectBusy ? "Connecting…" : "Connect"}
                    </button>
                  </div>
                  <button type="button" className="profile-skip-link" onClick={() => { setConnectProvider(null); setLeagueIdInput(""); setConnectError(""); }}>
                    Pick a different provider
                  </button>
                  {connectError && <p className="profile-field-error">{connectError}</p>}
                </>
              )}
            </div>
          )}

          {error && <p className="profile-field-error">{error}</p>}
        </div>
        <footer className="profile-modal-footer">
          <button className="secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="button" onClick={submitProfile}>{totalRosters > 0 ? "Save profile" : "Save & continue"}</button>
        </footer>
      </div>
    </div>
  );
}

function MiniPlayer({
  game,
  mediaIndex,
  audioPlaying,
  audioLevels,
  onExpand,
  onStop
}: {
  game: SportsGameState;
  mediaIndex: MediaLookupIndex;
  audioPlaying: boolean;
  audioLevels: number[];
  onExpand: () => void;
  onStop: () => void;
}) {
  const awayScore = game.currentPlay?.score.away ?? 0;
  const homeScore = game.currentPlay?.score.home ?? 0;
  const showScore = game.status === "live" || game.status === "final";
  return (
    <aside className="mini-player" aria-label="Active show — click to return">
      <button type="button" className="mini-player-body" onClick={onExpand}>
        <div className="mini-player-thumb" aria-hidden="true">
          <span className="mini-player-side">
            <MediaAvatar src={game.awayMeta?.logo} asset={resolveTeamMedia(mediaIndex, game.awayTeam)} label={game.awayTeam} size="sm" />
            {showScore && <span className="mini-player-score">{awayScore}</span>}
          </span>
          <span className="mini-player-vs">{showScore ? "—" : "@"}</span>
          <span className="mini-player-side">
            <MediaAvatar src={game.homeMeta?.logo} asset={resolveTeamMedia(mediaIndex, game.homeTeam)} label={game.homeTeam} size="sm" />
            {showScore && <span className="mini-player-score">{homeScore}</span>}
          </span>
          <span className="mini-player-live-pill">
            <span className="mini-player-live-dot" aria-hidden="true" />LIVE
          </span>
        </div>
        <div className="mini-player-meta">
          <strong>{game.awayTeam} at {game.homeTeam}</strong>
          <span>Huddle Radio · {audioPlaying ? "Playing" : "On air"}</span>
          <Waveform isPlaying={audioPlaying} levels={audioLevels} />
        </div>
      </button>
      <div className="mini-player-actions">
        <button type="button" className="secondary compact" onClick={onExpand} aria-label="Expand show">
          <span className="icon icon-arrow-up" aria-hidden="true" />
        </button>
        <button type="button" className="secondary compact" onClick={onStop} aria-label="Stop show">
          <span className="icon icon-stop" aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}

function statusLabel(status: SportsGameOption["status"]): string {
  if (status === "live") return "Live";
  if (status === "scheduled") return "Upcoming";
  if (status === "final") return "Final";
  if (status === "postponed") return "Postponed";
  return status.replace(/_/g, " ");
}

function sportLabel(sport: SportLeague): string {
  switch (sport) {
    case "nfl": return "NFL";
    case "ncaaf": return "NCAAF";
    case "nba": return "NBA";
    case "wnba": return "WNBA";
    case "ncaab": return "NCAAM";
    case "mlb": return "MLB";
    case "nhl": return "NHL";
    case "soccer": return "Soccer";
    default: return sport.toUpperCase();
  }
}

function sportIcon(sport: SportLeague): string {
  switch (sport) {
    case "nfl":
    case "ncaaf": return "icon-football";
    case "nba":
    case "wnba":
    case "ncaab": return "icon-ball";
    case "mlb": return "icon-baseball";
    case "nhl": return "icon-stadium";
    case "soccer": return "icon-soccer";
    default: return "icon-football";
  }
}

function HuddleDiscover({
  setup,
  readiness,
  demoMode,
  mediaIndex,
  onPickAndStart,
  onPickGame,
  onPrepareDemo,
  onOpenSetup,
  profile,
  onOpenProfile,
  showProfileNudge,
  onDismissProfileNudge,
  listenerSpotlights,
  tonightGlance
}: {
  setup: EmptyStateSetup;
  readiness: { canStart: boolean; requirements: Array<{ id: string; label: string; met: boolean }> };
  demoMode: boolean;
  mediaIndex: MediaLookupIndex;
  /** Sample CTA / explicit "start now" intents — opens the WebSocket. */
  onPickAndStart: (gameId: string, dataMode: "demo" | "espn") => void;
  /** Game-card / glance taps — stage for preview, do NOT cast yet. */
  onPickGame: (gameId: string, dataMode: "demo" | "espn") => void;
  onPrepareDemo: () => void;
  onOpenSetup: () => void;
  profile?: UserProfile;
  onOpenProfile: (intent?: ProfileModalIntent) => void;
  showProfileNudge: boolean;
  onDismissProfileNudge: () => void;
  listenerSpotlights: ReturnType<typeof buildListenerGameSpotlights>;
  tonightGlance?: ReturnType<typeof buildTonightAtAGlance>;
}) {
  const [search, setSearch] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [sportFilter, setSportFilter] = useState<SportLeague | "all">("all");
  const leagueMet = readiness.requirements.find((req) => req.id === "league")?.met ?? false;
  const showSetupBanner = !leagueMet && !demoMode && !setupDismissed;

  const sportCounts = useMemo(() => {
    const counts = new Map<SportLeague, number>();
    for (const game of setup.sportsGames) {
      counts.set(game.sport, (counts.get(game.sport) ?? 0) + 1);
    }
    return counts;
  }, [setup.sportsGames]);

  const sportChips = useMemo(() => {
    const order: Array<{ id: SportLeague; label: string; icon: string }> = [
      { id: "nfl", label: "NFL", icon: "icon-football" },
      { id: "ncaaf", label: "NCAAF", icon: "icon-football" },
      { id: "nba", label: "NBA", icon: "icon-ball" },
      { id: "wnba", label: "WNBA", icon: "icon-ball" },
      { id: "ncaab", label: "NCAAM", icon: "icon-ball" },
      { id: "mlb", label: "MLB", icon: "icon-baseball" },
      { id: "nhl", label: "NHL", icon: "icon-stadium" }
    ];
    return order.filter((entry) => (sportCounts.get(entry.id) ?? 0) > 0);
  }, [sportCounts]);

  const filteredGames = useMemo(() => {
    const query = search.trim().toLowerCase();
    return setup.sportsGames.filter((game) => {
      if (sportFilter !== "all" && game.sport !== sportFilter) return false;
      if (!query) return true;
      return (
        game.awayTeam.toLowerCase().includes(query) ||
        game.homeTeam.toLowerCase().includes(query) ||
        (game.shortName ?? "").toLowerCase().includes(query) ||
        (game.detail ?? "").toLowerCase().includes(query)
      );
    });
  }, [setup.sportsGames, search, sportFilter]);

  const sections = useMemo(() => {
    const live = filteredGames.filter((game) => game.status === "live");
    const upcoming = filteredGames.filter((game) => game.status === "scheduled");
    const final = filteredGames.filter((game) => game.status === "final");
    const demo = filteredGames.filter((game) => game.status === "demo");
    // Postponed games stay visible but get their own quiet bucket so
    // they don't pollute Upcoming. Hide entirely when there are none.
    const postponed = filteredGames.filter((game) => game.status === "postponed");
    const yours = filteredGames
      .filter((game) => listenerSpotlights.has(game.id))
      .sort((left, right) => {
        const leftTop = listenerSpotlights.get(left.id)?.topStarter?.projectedPoints ?? 0;
        const rightTop = listenerSpotlights.get(right.id)?.topStarter?.projectedPoints ?? 0;
        return rightTop - leftTop;
      });
    // Discover spans the next ~7 days of games (see ESPN scoreboard
    // dates window in espnSportsDataProvider) — copy reflects the
    // actual horizon, not the original same-night assumption.
    const yoursLine = profile?.name
      ? `${profile.name}, your starters in the next week's slate.`
      : "Your starters across the next week's games.";
    return [
      ...(yours.length > 0
        ? [{ id: "yours", title: "Your players this week", subtitle: yoursLine, icon: "icon-trophy-winner", games: yours, isListener: true as const }]
        : []),
      { id: "live", title: "Live now", subtitle: "Tap any game to drop into a live Huddle", icon: "icon-live-video", games: live, isListener: false as const },
      { id: "upcoming", title: "Upcoming", subtitle: "Set a reminder or queue a pre-game show", icon: "icon-clock", games: upcoming, isListener: false as const },
      { id: "recap", title: "Recent", subtitle: "Catch up on what you missed with a recap show", icon: "icon-history", games: final, isListener: false as const },
      { id: "postponed", title: "Postponed", subtitle: "Games on hold — back when they're rescheduled.", icon: "icon-clock", games: postponed, isListener: false as const },
      { id: "demo", title: "Demo", subtitle: "Scripted show — no real data needed", icon: "icon-sparkle", games: demo, isListener: false as const }
    ].filter((section) => section.games.length > 0);
  }, [filteredGames, listenerSpotlights, profile?.name]);

  return (
    <section className="huddle-discover">
      <header className="discover-header">
        <div className="discover-search">
          <span className="icon icon-search" aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search teams, matchups, or shows"
            aria-label="Search games"
          />
        </div>
        <div className="discover-actions">
          {demoMode && <span className="demo-mode-pill" title="Running on demo data">Demo mode</span>}
          <button className="secondary compact" onClick={onPrepareDemo}>
            <span className="icon icon-play" aria-hidden="true" />Try demo
          </button>
          <button className="secondary compact" onClick={onOpenSetup}>
            <span className="icon icon-settings" aria-hidden="true" />Connect league
          </button>
        </div>
      </header>

      <nav className="discover-categories" aria-label="Categories">
        <button
          className={sportFilter === "all" ? "discover-chip is-selected" : "discover-chip"}
          type="button"
          onClick={() => setSportFilter("all")}
        >
          <span className="icon icon-dashboard" aria-hidden="true" />
          All <span className="discover-chip-count">{setup.sportsGames.length}</span>
        </button>
        {sportChips.map((entry) => (
          <button
            key={entry.id}
            className={sportFilter === entry.id ? "discover-chip is-selected" : "discover-chip"}
            type="button"
            onClick={() => setSportFilter(entry.id)}
          >
            <span className={`icon ${entry.icon}`} aria-hidden="true" />
            {entry.label} <span className="discover-chip-count">{sportCounts.get(entry.id) ?? 0}</span>
          </button>
        ))}
        <span className="discover-divider" aria-hidden="true" />
        <button
          className={setup.sportsDataMode === "espn" ? "discover-chip is-selected" : "discover-chip"}
          type="button"
          onClick={() => setup.onSetSportsDataMode("espn")}
        >
          <span className="icon icon-satellite" aria-hidden="true" />
          Live (ESPN)
        </button>
        <button
          className={setup.sportsDataMode === "demo" ? "discover-chip is-selected" : "discover-chip"}
          type="button"
          onClick={() => setup.onSetSportsDataMode("demo")}
        >
          <span className="icon icon-sparkle" aria-hidden="true" />
          Demo
        </button>
        <button className="discover-chip-icon" type="button" onClick={setup.onRefreshGames} aria-label="Refresh games">
          <span className="icon icon-loop" aria-hidden="true" />
        </button>
      </nav>


      {showProfileNudge && (
        <article className="discover-banner discover-banner--profile">
          <div>
            <span className="eyebrow"><span className="icon icon-radio" aria-hidden="true" />Hear it before you set anything up</span>
            <strong>Listen to a 60-second sample show.</strong>
            <p>Three named hosts, real-time fantasy commentary, personalized to a sample lineup. No sign-up. Customize after — once you know if it's for you.</p>
          </div>
          <div className="discover-banner-actions discover-banner-actions--split">
            <button className="primary" onClick={() => onPickAndStart("demo-kc-det", "demo")}>
              <span className="icon icon-play" aria-hidden="true" />Listen to a sample
            </button>
            <button className="secondary" onClick={() => onOpenProfile("demo")}>
              <span className="icon icon-sparkle" aria-hidden="true" />Try the demo as me
            </button>
            <button className="secondary" onClick={() => onOpenProfile("sync")}>
              <span className="icon icon-share-link" aria-hidden="true" />Connect my league
            </button>
            <button className="profile-skip-link" onClick={onDismissProfileNudge} aria-label="Dismiss profile nudge">
              Not now
            </button>
          </div>
        </article>
      )}

      {showSetupBanner && (
        <article className="discover-banner">
          <div>
            <span className="eyebrow"><span className="icon icon-target" aria-hidden="true" />Personalize this</span>
            <strong>Connect your fantasy league for tailored takes.</strong>
            <p>We'll talk about your team, your matchups, and the trades you actually care about.</p>
          </div>
          <div className="discover-banner-actions">
            <button className="primary" onClick={() => setSetupOpen((v) => !v)}>
              {setupOpen ? "Hide setup" : "Connect league"}
            </button>
            <button className="secondary compact" onClick={() => setSetupDismissed(true)} aria-label="Dismiss banner">
              Not now
            </button>
          </div>
          {setupOpen && (
            <DiscoverSetupForm setup={setup} onComplete={() => setSetupOpen(false)} />
          )}
        </article>
      )}

      {(() => {
        const failedKey = [...setup.failedSports].map((entry) => entry.sport).sort().join("|");
        if (failedKey === "" || failedKey === setup.dismissedFailedSportsKey) return null;
        return (
          <article className="notice is-warn" role="status" aria-live="polite">
            <span className="icon icon-warning" aria-hidden="true" />
            <div>
              <strong>
                {setup.failedSports.length === 1
                  ? `${setup.failedSports[0].label} scoreboard temporarily unavailable.`
                  : `${setup.failedSports.length} scoreboards temporarily unavailable: ${setup.failedSports.map((entry) => entry.label).join(", ")}.`}
              </strong>
              <p>Other sports loaded normally. Tap refresh to retry.</p>
            </div>
            <button className="secondary compact" onClick={setup.onRefreshGames}>
              <span className="icon icon-loop" aria-hidden="true" />Retry
            </button>
            <button
              className="secondary compact icon-only"
              onClick={setup.onDismissFailedSports}
              aria-label="Dismiss notice"
            >
              <span className="icon icon-close" aria-hidden="true" />
            </button>
          </article>
        );
      })()}

      {sections.length === 0 && profile && tonightGlance && tonightGlance.perSport.length > 0 && (
        <TonightAtAGlanceCard glance={tonightGlance} onPickGame={(gameId) => onPickGame(gameId, setup.sportsDataMode)} />
      )}

      {sections.length === 0 && (
        <div className="discover-empty">
          <span className="icon icon-podcast" aria-hidden="true" />
          <strong>No games match that search.</strong>
          <p>{setup.sportsGames.length === 0
            ? setup.sportsGamesStatus
            : "Try clearing your search or switching the data source."}</p>
        </div>
      )}

      {sections.map((section, sectionIndex) => (
        <section key={section.id} className={section.isListener ? "discover-section discover-section--listener" : "discover-section"}>
          <header>
            <div>
              <h2><span className={`icon ${section.icon}`} aria-hidden="true" />{section.title}</h2>
              <p>{section.subtitle}</p>
            </div>
            <span className="discover-section-count">{section.games.length}</span>
          </header>
          <div className="discover-grid">
            {sectionIndex === 0 && profile && tonightGlance && tonightGlance.perSport.length > 0 && (
              <TonightAtAGlanceCard glance={tonightGlance} onPickGame={(gameId) => onPickGame(gameId, setup.sportsDataMode)} />
            )}
            {section.games.map((game) => (
              <GameCard
                key={`${section.id}-${game.id}`}
                game={game}
                mediaIndex={mediaIndex}
                onClick={() => onPickGame(game.id, setup.sportsDataMode)}
                spotlight={listenerSpotlights.get(game.id)}
              />
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}

function TonightAtAGlanceCard({ glance, onPickGame }: { glance: NonNullable<ReturnType<typeof buildTonightAtAGlance>>; onPickGame: (gameId: string) => void }) {
  return (
    <article className="tonight-glance-card" aria-label="Your fantasy week at a glance">
      <header className="tonight-glance-header">
        <span className="eyebrow">
          <span className="icon icon-sparkle" aria-hidden="true" />
          {glance.listenerName}, your fantasy week
        </span>
        <h2>Your week at a glance</h2>
        {glance.perSport.length > 1 && (
          <p>{`${glance.perSport.length} leagues across ${new Set(glance.perSport.map((entry) => entry.sport)).size} sports — biggest stakes first.`}</p>
        )}
      </header>
      <div className="tonight-glance-grid">
        {glance.perSport.map((entry) => {
          const margin = entry.margin;
          const tone: "lead" | "trail" | "even" = margin > 0.05 ? "lead" : margin < -0.05 ? "trail" : "even";
          const marginLine = entry.opponentTeamName
            ? margin > 0.05
              ? `Up ${margin.toFixed(1)} on ${entry.opponentOwnerName ?? entry.opponentTeamName}`
              : margin < -0.05
                ? `Down ${Math.abs(margin).toFixed(1)} to ${entry.opponentOwnerName ?? entry.opponentTeamName}`
                : `Dead even with ${entry.opponentOwnerName ?? entry.opponentTeamName}`
            : `No matchup opponent yet`;
          return (
            <div key={`${entry.sport}-${entry.leagueName}`} className={`tonight-glance-tile tone-${tone}`}>
              <header>
                <span className={`tonight-glance-sport icon ${sportIcon(entry.sport)}`} aria-hidden="true" />
                <div>
                  <strong>{entry.teamName}</strong>
                  <span>{sportLabel(entry.sport)} · {entry.leagueName}</span>
                </div>
              </header>
              <p className="tonight-glance-margin">{marginLine}</p>
              {entry.topSwing && (
                <p className="tonight-glance-swing">
                  <span className="tonight-glance-swing-label">Top swing:</span>
                  <strong>{entry.topSwing.position} {entry.topSwing.name}</strong>
                  <span>{entry.topSwing.proTeam} · {entry.topSwing.projectedPoints.toFixed(1)} proj</span>
                </p>
              )}
              {entry.startersInPlayCount > 0 && (
                <small className="tonight-glance-meta">
                  {entry.startersInPlayCount} {entry.startersInPlayCount === 1 ? "starter" : "starters"} in play · {entry.totalStartersProjected.toFixed(1)} total proj
                </small>
              )}
              {entry.suggestedGameId && entry.suggestedGameLabel && (
                <button
                  type="button"
                  className="primary compact tonight-glance-cta"
                  onClick={() => onPickGame(entry.suggestedGameId!)}
                >
                  <span className="icon icon-play" aria-hidden="true" />
                  Start {entry.suggestedGameLabel} show
                </button>
              )}
            </div>
          );
        })}
      </div>
    </article>
  );
}

function GameCard({
  game,
  mediaIndex,
  onClick,
  spotlight
}: {
  game: SportsGameOption;
  mediaIndex: MediaLookupIndex;
  onClick: () => void;
  spotlight?: { starters: { name: string; position: string; proTeam: string; projectedPoints: number }[]; topStarter?: { name: string; position: string; projectedPoints: number } };
}) {
  const status = statusLabel(game.status);
  const detail = (game.detail ?? "").trim();
  const showDetail = detail.length > 0 && detail.toLowerCase() !== status.toLowerCase();
  const startTime = game.startsAt ? formatGameTime(game.startsAt) : null;
  const showScore = game.status === "live" || game.status === "final";
  const awayScore = game.score?.away ?? 0;
  const homeScore = game.score?.home ?? 0;
  const leader: "away" | "home" | "tie" =
    game.status === "final"
      ? awayScore > homeScore
        ? "away"
        : homeScore > awayScore
          ? "home"
          : "tie"
      : "tie";
  const metaParts: string[] = [];
  if (showScore && showDetail) metaParts.push(detail);
  else if (game.status === "scheduled" && startTime) metaParts.push(startTime);
  else if (showDetail) metaParts.push(detail);
  if (game.broadcast) metaParts.push(game.broadcast);
  const metaLine = metaParts.join(" · ") || "Huddle Radio";
  const awayLogo = game.awayMeta?.logo ?? mediaAssetUrl(resolveTeamMedia(mediaIndex, game.awayTeam));
  const homeLogo = game.homeMeta?.logo ?? mediaAssetUrl(resolveTeamMedia(mediaIndex, game.homeTeam));
  const awayColor = game.awayMeta?.color ? `#${game.awayMeta.color}` : null;
  const homeColor = game.homeMeta?.color ? `#${game.homeMeta.color}` : null;
  const thumbStyle = awayColor || homeColor
    ? {
        backgroundImage: `radial-gradient(ellipse 60% 80% at 0% 50%, ${awayColor ?? "transparent"}33, transparent 65%), radial-gradient(ellipse 60% 80% at 100% 50%, ${homeColor ?? "transparent"}33, transparent 65%)`
      }
    : undefined;
  return (
    <button type="button" className={spotlight ? "game-card has-listener" : "game-card"} onClick={onClick}>
      <div className="game-card-thumb" style={thumbStyle} aria-hidden="true">
        <div className="game-card-badges">
          <span className={`game-card-status game-card-status--${game.status}`}>
            {game.status === "live" && <span className="game-card-live-dot" aria-hidden="true" />}
            {status.toUpperCase()}
          </span>
          <span className="game-card-sport">
            <span className={`icon ${sportIcon(game.sport)}`} aria-hidden="true" />
            {sportLabel(game.sport)}
          </span>
          {spotlight && (
            <span className="game-card-listener" title={spotlight.starters.map((s) => `${s.name} (${s.position})`).join(", ")}>
              <span className="icon icon-trophy-winner" aria-hidden="true" />
              {spotlight.starters.length === 1 ? "Yours" : `${spotlight.starters.length} of yours`}
            </span>
          )}
        </div>
        <div className="game-card-rows">
          <div className={`game-card-row${leader === "away" ? " is-leader" : leader === "home" ? " is-trailer" : ""}`}>
            <TeamLogo logo={awayLogo} abbr={game.awayTeam} />
            <span className="game-card-abbr">{game.awayTeam}</span>
            {showScore ? (
              <span className="game-card-score">{awayScore}</span>
            ) : (
              <span className="game-card-score game-card-score--placeholder">–</span>
            )}
          </div>
          <div className={`game-card-row${leader === "home" ? " is-leader" : leader === "away" ? " is-trailer" : ""}`}>
            <TeamLogo logo={homeLogo} abbr={game.homeTeam} />
            <span className="game-card-abbr">{game.homeTeam}</span>
            {showScore ? (
              <span className="game-card-score">{homeScore}</span>
            ) : (
              <span className="game-card-score game-card-score--placeholder">–</span>
            )}
          </div>
        </div>
      </div>
      <div className="game-card-meta">
        <span className="game-card-detail">{metaLine}</span>
        {spotlight?.topStarter && (
          <span className="game-card-spotlight">
            <span className="icon icon-user-filled" aria-hidden="true" />
            {spotlight.topStarter.position} {spotlight.topStarter.name} · {spotlight.topStarter.projectedPoints.toFixed(1)} proj
          </span>
        )}
      </div>
    </button>
  );
}

function TeamLogo({ logo, abbr }: { logo?: string; abbr: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [logo]);
  if (logo && !failed) {
    return <img className="game-card-logo" src={logo} alt="" loading="lazy" onError={() => setFailed(true)} />;
  }
  return <span className="game-card-logo game-card-logo--fallback">{abbr.slice(0, 3)}</span>;
}

function DiscoverSetupForm({ setup, onComplete }: { setup: EmptyStateSetup; onComplete: () => void }) {
  const [provider, setProvider] = useState<"sleeper" | "espn" | null>(
    setup.providerMode === "sleeper" ? "sleeper" : setup.providerMode === "espn" ? "espn" : null
  );
  const [leagueId, setLeagueId] = useState(
    setup.providerMode === "sleeper" ? setup.sleeperLeagueId : setup.providerMode === "espn" ? setup.espnLeagueId : ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!provider) return setError("Pick Sleeper or ESPN first.");
    if (!leagueId.trim()) return setError("Enter your league ID.");
    setError("");
    setBusy(true);
    try {
      const ok = await setup.onConnectFantasy(provider, leagueId);
      if (ok) onComplete();
      else setError("Couldn't connect. Double-check the league ID.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="discover-banner-form">
      <div className="provider-chips" role="radiogroup" aria-label="Fantasy provider">
        <button
          type="button"
          role="radio"
          aria-checked={provider === "sleeper"}
          className={provider === "sleeper" ? "provider-chip is-selected" : "provider-chip"}
          onClick={() => setProvider("sleeper")}
        >
          <img src="/icons/Logos/Sleeper.png" alt="" />Sleeper
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={provider === "espn"}
          className={provider === "espn" ? "provider-chip is-selected" : "provider-chip"}
          onClick={() => setProvider("espn")}
        >
          <img src="/icons/Logos/ESPN.png" alt="" />ESPN
        </button>
        <button type="button" className="provider-chip is-disabled" disabled>
          <img src="/icons/Logos/Yahoo.png" alt="" />Yahoo
          <span className="provider-chip-soon">soon</span>
        </button>
      </div>
      {provider && (
        <label className="empty-step-field">
          <span>{provider === "sleeper" ? "Sleeper league ID" : "ESPN league ID"}</span>
          <input
            value={leagueId}
            onChange={(event) => setLeagueId(event.target.value)}
            placeholder={provider === "sleeper" ? "1234567890" : "123456"}
            onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
          />
        </label>
      )}
      {error && <p className="empty-step-error">{error}</p>}
      <div className="button-row">
        <button className="primary" onClick={() => void submit()} disabled={busy}>
          {busy ? "Connecting…" : "Connect"} <span className="icon icon-arrow-right" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function formatGameTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) {
      return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
    return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) +
      " · " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function HuddlePregame({
  game,
  fantasy,
  hosts,
  hostTurns,
  matchupStory,
  fantasySpotlight,
  matchupTotals,
  mediaIndex,
  onStart,
  onOpenStream,
  onOpenSettings,
  onBackToDiscover,
  demoMode,
  readiness,
  listenerStakes,
  news,
  odds,
  friendMatchups,
  profile
}: {
  game?: SportsGameState;
  fantasy?: FantasyLeagueState;
  hosts: typeof HUDDLE_HOSTS;
  hostTurns: HuddleHostTurn[];
  matchupStory: ReturnType<typeof buildMatchupStory>;
  fantasySpotlight: ReturnType<typeof buildFantasySpotlight>;
  matchupTotals: Array<{ id: string; ownerName: string; teamName: string; team?: string; points: number }>;
  mediaIndex: MediaLookupIndex;
  onStart: () => void;
  onOpenStream: () => void;
  onOpenSettings: () => void;
  /** Optional — when present, the pregame layout shows a "Back to discover" link so the preview flow doesn't trap. */
  onBackToDiscover?: () => void;
  demoMode: boolean;
  readiness: { canStart: boolean; requirements: Array<{ id: string; label: string; met: boolean }> };
  listenerStakes?: ReturnType<typeof buildListenerStakes>;
  news?: NewsItem[];
  odds?: GameOdds;
  friendMatchups?: ReturnType<typeof buildFriendMatchups>;
  profile?: UserProfile;
}) {
  const startLabel = demoMode ? "Start demo show" : "Start live show";
  const unmet = readiness.requirements.filter((req) => !req.met);
  // Personalize only when there's a real profile. Without one, the
  // group falls back to the "Alex" demo persona, which is correct for
  // demo mode but a bug for a real new user — they'd see "Tonight's
  // show, Alex" pulled from default seed data.
  const hasListener = Boolean(profile) && listenerStakes?.status === "ready";
  const gameLabel = game ? `${game.awayTeam} at ${game.homeTeam}` : undefined;
  const heroEyebrow = hasListener
    ? `Tonight's show, ${listenerStakes!.listenerName}`
    : (demoMode ? "Pregame · demo rehearsal" : "Pregame show");
  const heroHeadline = hasListener && listenerStakes!.opponent
    ? `${listenerStakes!.teamName ?? "Your team"} vs ${listenerStakes!.opponent.teamName}`
    : (gameLabel ?? "Almost ready");
  const heroSub = hasListener
    ? `${listenerStakes!.stakesLine} · ${gameLabel ?? "Your matchup"} · Week ${fantasy?.matchups[0]?.week ?? 7}`
    : (fantasy
      ? `Week ${fantasy.matchups[0]?.week ?? 7} · ${fantasy.leagueName}`
      : (demoMode ? "Demo rehearsal — tap Start when ready" : "Tap Start when you're ready to go live"));
  return (
    <section className="pregame-layout">
      <div className="pregame-hero">
        <span className="eyebrow"><span className="icon icon-clock" aria-hidden="true" />{heroEyebrow}</span>
        <h1>{heroHeadline}</h1>
        <p>{heroSub}</p>
        <HostStudio hosts={hosts} turns={hostTurns} />
        {!readiness.canStart && unmet.length > 0 && (
          <div className="pregame-checklist" role="status" aria-live="polite">
            <span className="eyebrow"><span className="icon icon-check" aria-hidden="true" />Before you go live</span>
            <ul>
              {readiness.requirements.map((req) => (
                <li key={req.id} data-met={req.met ? "true" : "false"}>
                  <span className="check" aria-hidden="true" />
                  <span>{req.label}</span>
                </li>
              ))}
            </ul>
            <button className="secondary compact" onClick={onOpenSettings}>
              <span className="icon icon-settings" aria-hidden="true" />Open setup
            </button>
          </div>
        )}
        <div className="button-row">
          <button
            className="primary"
            onClick={onStart}
            disabled={!readiness.canStart}
            aria-disabled={!readiness.canStart}
            title={readiness.canStart ? undefined : `Connect: ${unmet.map((req) => req.label).join(", ")}`}
          >
            <span className="icon icon-broadcast" aria-hidden="true" />{startLabel}
          </button>
          <button className="secondary" onClick={onOpenStream}><span className="icon icon-plus" aria-hidden="true" />Add stream</button>
          {onBackToDiscover && (
            // Back to discover keeps preview-mode browsing fluid: tap a
            // game → see its preview → swap to a different game without
            // any cast having opened.
            <button className="secondary compact" onClick={onBackToDiscover}>
              <span className="icon icon-arrow-left" aria-hidden="true" />Pick a different game
            </button>
          )}
        </div>
      </div>
      <aside className="pregame-rail">
        {profile && listenerStakes && <ListenerStakesCard stakes={listenerStakes} />}
        {profile && friendMatchups && friendMatchups.length > 0 && <FriendMatchupsCard matchups={friendMatchups} />}
        <MatchupCard game={game} mediaIndex={mediaIndex} />
        {odds && <OddsCard odds={odds} />}
        <MarketsBoardCard game={game} />
        {news && news.length > 0 ? (
          <NewsStorylineCard
            news={news}
            extras={[matchupStory.line, fantasySpotlight.body].filter(Boolean) as string[]}
          />
        ) : (
          <StorylineCard icon="icon-target" title="Storylines to watch" items={[matchupStory.line, fantasySpotlight.body, "The hosts will stay quiet when the game needs room."]} />
        )}
        <RostersCard matchupTotals={matchupTotals} mediaIndex={mediaIndex} />
      </aside>
    </section>
  );
}

function ListenerStakesCard({ stakes }: { stakes: NonNullable<ReturnType<typeof buildListenerStakes>> }) {
  if (stakes.status !== "ready") {
    return (
      <article className="huddle-card listener-stakes-card listener-stakes-empty">
        <span className="eyebrow"><span className="icon icon-user" aria-hidden="true" />Your show</span>
        <h3>Welcome, {stakes.listenerName}</h3>
        <p>{stakes.stakesLine}</p>
      </article>
    );
  }
  const marginTone = stakes.margin > 0.05 ? "lead" : stakes.margin < -0.05 ? "trail" : "even";
  return (
    <article className={`huddle-card listener-stakes-card stakes-${marginTone}`}>
      <span className="eyebrow"><span className="icon icon-user-filled" aria-hidden="true" />Your show, {stakes.listenerName}</span>
      <header className="listener-stakes-header">
        <strong>{stakes.teamName ?? "Your roster"}</strong>
        {stakes.opponent && (
          <span className="listener-stakes-vs">vs {stakes.opponent.teamName}</span>
        )}
      </header>
      <p className="listener-stakes-line">{stakes.stakesLine}</p>
      {stakes.startersInGame.length > 0 && (
        <div className="listener-stakes-starters">
          <span className="listener-stakes-label">Starting in this game</span>
          <ul>
            {stakes.startersInGame.slice(0, 4).map((player) => (
              <li key={player.id}>
                <strong>{player.name}</strong>
                <span>{player.position} · {player.proTeam}</span>
                <b>{player.projectedPoints.toFixed(1)} proj</b>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function ListenerHighlightCard({ highlight, listenerName, gameLabel, sport, onArchiveClip, onGetClipSubtitles }: { highlight: NonNullable<ReturnType<typeof buildListenerRecapHighlight>>; listenerName: string; gameLabel?: string; sport?: SportLeague; onArchiveClip?: (commentaryId: string) => Promise<string | undefined>; onGetClipSubtitles?: (commentaryId: string) => Promise<{ vtt: string; text: string } | undefined> }) {
  const isWin = highlight.kind === "win";
  const eyebrow = isWin ? `${listenerName}, your moment of the show` : `${listenerName}, the play that stung`;
  const deltaLabel = `${highlight.pointsDelta > 0 ? "+" : ""}${highlight.pointsDelta.toFixed(1)} pts`;
  const hostName = highlight.hostId && highlight.hostId in HOST_PERSONA_NAMES
    ? HOST_PERSONA_NAMES[highlight.hostId as HostId]
    : undefined;
  // Group-chat-ready blurb. Self-contained so a friend opening the
  // message understands what it is. Includes attribution + product hook.
  const shareText = useMemo(() => {
    const lines: string[] = [];
    lines.push(`🎙️ on Huddle Radio`);
    if (hostName) lines.push(`${hostName}: "${shortenForCard(highlight.hostText, 200)}"`);
    else lines.push(`"${shortenForCard(highlight.hostText, 220)}"`);
    lines.push("");
    const sportTag = sport ? sportNounForContext(sport) : "Fantasy";
    const stakeLine = `${listenerName}'s ${highlight.playerName} ${highlight.pointsDelta > 0 ? "+" : ""}${highlight.pointsDelta.toFixed(1)} tonight${gameLabel ? ` · ${gameLabel}` : ""} · ${sportTag}`;
    lines.push(stakeLine);
    return lines.join("\n");
  }, [hostName, highlight, listenerName, gameLabel, sport]);
  const [shareState, setShareState] = useState<"idle" | "copied" | "shared" | "failed">("idle");
  // W21: cached subtitle track for this clip. Generated in parallel
  // with the archive upload so the user sees a "Captions ready"
  // affordance without an extra click.
  const [subtitles, setSubtitles] = useState<{ vtt: string; text: string } | undefined>();
  const [subtitleStatus, setSubtitleStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const handleShare = async () => {
    // Try to archive the moment's audio first so the share blurb can
    // include a real clip link. Falls through silently to text-only on
    // any failure (no audio captured, network error, etc.). Kick off
    // subtitle generation in parallel so the captions track is ready
    // by the time the user looks for it.
    let clipUrl: string | undefined;
    if (highlight.commentaryId && onArchiveClip) {
      const captionTask =
        onGetClipSubtitles && subtitleStatus !== "ready"
          ? (() => {
              setSubtitleStatus("loading");
              return onGetClipSubtitles(highlight.commentaryId!).then(
                (track) => {
                  if (track) {
                    setSubtitles(track);
                    setSubtitleStatus("ready");
                  } else {
                    setSubtitleStatus("failed");
                  }
                },
                () => setSubtitleStatus("failed")
              );
            })()
          : Promise.resolve();
      try {
        clipUrl = await onArchiveClip(highlight.commentaryId);
      } catch {
        clipUrl = undefined;
      }
      // Don't block the share text on captions — but await so the
      // network request isn't cancelled by component unmount.
      void captionTask;
    }
    const finalText = clipUrl ? `${shareText}\n${new URL(clipUrl, window.location.origin).toString()}` : shareText;
    // Mobile: native share sheet. Desktop: clipboard fallback.
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: "Huddle Radio · Moment of the show", text: finalText });
        setShareState("shared");
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(finalText);
        setShareState("copied");
      } else {
        setShareState("failed");
      }
    } catch (error) {
      // navigator.share() throws AbortError when user dismisses the sheet
      // — don't treat that as a failure, just reset.
      if (error instanceof Error && error.name === "AbortError") {
        setShareState("idle");
        return;
      }
      setShareState("failed");
    }
    window.setTimeout(() => setShareState("idle"), 2200);
  };
  const buttonLabel =
    shareState === "copied" ? "Copied!" :
    shareState === "shared" ? "Shared!" :
    shareState === "failed" ? "Try again" :
    "Share moment";
  return (
    <article className={`huddle-card listener-highlight-card highlight-${isWin ? "win" : "loss"}`}>
      <span className="eyebrow">
        <span className={`icon ${isWin ? "icon-trophy-winner" : "icon-flag"}`} aria-hidden="true" />
        {eyebrow}
      </span>
      <header className="listener-highlight-header">
        <strong>{highlight.playerName}</strong>
        <b>{deltaLabel}</b>
      </header>
      <p className="listener-highlight-play">{highlight.playHeadline}</p>
      <blockquote className="listener-highlight-quote">{shortenForCard(highlight.hostText, 220)}</blockquote>
      <div className="listener-highlight-actions">
        <button
          type="button"
          className={`secondary compact listener-highlight-share${shareState !== "idle" ? ` is-${shareState}` : ""}`}
          onClick={handleShare}
          aria-live="polite"
        >
          <span className={`icon ${shareState === "copied" || shareState === "shared" ? "icon-check" : "icon-share"}`} aria-hidden="true" />
          {buttonLabel}
        </button>
        {subtitleStatus === "loading" && (
          <span className="listener-highlight-captions is-loading" aria-live="polite">Generating captions…</span>
        )}
        {subtitleStatus === "ready" && subtitles && (
          <a
            className="listener-highlight-captions is-ready"
            href={`data:text/vtt;charset=utf-8,${encodeURIComponent(subtitles.vtt)}`}
            download={`huddle-${highlight.commentaryId ?? "clip"}.vtt`}
          >
            Download captions (.vtt)
          </a>
        )}
        {subtitleStatus === "failed" && (
          <span className="listener-highlight-captions is-failed">Captions unavailable</span>
        )}
      </div>
    </article>
  );
}

const HOST_PERSONA_NAMES: Record<HostId, string> = {
  maya: "Maya",
  theo: "Theo",
  cam: "Cam"
};

function shortenForCard(text: string, max: number) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trim()}…`;
}

function HuddleLiveWithStream({
  game,
  hostTurns,
  fantasySpotlight,
  matchupTotals,
  mediaIndex,
  youtubeEmbedUrl,
  hasVideoSource,
  videoRef,
  onVideoError,
  onStop,
  observation,
  modelLabel,
  marketSwing
}: {
  game?: SportsGameState;
  hostTurns: HuddleHostTurn[];
  fantasySpotlight: ReturnType<typeof buildFantasySpotlight>;
  matchupTotals: Array<{ id: string; ownerName: string; teamName: string; team?: string; points: number }>;
  mediaIndex: MediaLookupIndex;
  youtubeEmbedUrl?: string;
  hasVideoSource: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onVideoError: () => void;
  onStop: () => void;
  observation?: LivecastCommentary["observation"];
  modelLabel?: string;
  marketSwing?: { source: string; externalId: string; deltaCents: number; emittedAt: number };
}) {
  return (
    <section className="live-layout">
      <div className="video-stage">
        {youtubeEmbedUrl ? (
          <iframe title="Sports stream preview" src={youtubeEmbedUrl} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen />
        ) : (
          <video ref={videoRef} controls={hasVideoSource} autoPlay muted playsInline onError={onVideoError} />
        )}
        <ScoreBug game={game} mediaIndex={mediaIndex} />
        <MarketsTicker game={game} swing={marketSwing} />
        <div className="live-callout">{fantasySpotlight.body}</div>
        <FantasyMatchupFloat matchupTotals={matchupTotals} mediaIndex={mediaIndex} />
      </div>
      <aside className="on-air-panel">
        <NemotronSeesPanel observation={observation} modelLabel={modelLabel} />
        <HostTurns turns={hostTurns} />
        <button className="secondary" onClick={onStop}><span className="icon icon-stop" aria-hidden="true" />Stop show</button>
      </aside>
    </section>
  );
}

type CueState =
  | { kind: "idle" }
  | { kind: "recording"; recording: MicRecording }
  | { kind: "transcribing" }
  | { kind: "delivered"; text: string; clearedAt: number }
  | { kind: "error"; message: string };

/**
 * Push-to-talk cue button. Hold to record, release to transcribe and
 * forward to the live show. Self-contained — owns its mic state and
 * the call to /api/asr/transcribe so the parent only needs to relay
 * the resulting cue to the websocket.
 *
 * The button auto-resets a few seconds after a delivered cue so the
 * UI doesn't permanently display an old transcript. Errors stick
 * around longer (mic denial, network) so the listener notices.
 */
function CueHostButton({ onSubmit }: { onSubmit: (cue: ListenerCue) => boolean }) {
  const [state, setState] = useState<CueState>({ kind: "idle" });
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Auto-clear the "delivered" preview after a few seconds so the
  // button is fresh for the next cue without forcing the listener to
  // dismiss.
  useEffect(() => {
    if (state.kind !== "delivered") return;
    const timer = window.setTimeout(() => {
      setState((current) => (current.kind === "delivered" ? { kind: "idle" } : current));
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const begin = useCallback(async () => {
    if (stateRef.current.kind !== "idle" && stateRef.current.kind !== "delivered" && stateRef.current.kind !== "error") {
      return;
    }
    try {
      const recording = await startMicRecording({ label: "Cue host", maxDurationMs: 18000 });
      setState({ kind: "recording", recording });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Microphone unavailable."
      });
    }
  }, []);

  const finish = useCallback(async () => {
    const current = stateRef.current;
    if (current.kind !== "recording") return;
    setState({ kind: "transcribing" });
    try {
      const audio = await current.recording.stop();
      // Drop sub-300ms taps — usually accidental. Keeps the cue queue
      // free of junk transcripts.
      if ((audio.durationMs ?? 0) < 300) {
        setState({ kind: "idle" });
        return;
      }
      const response = await fetch("/api/asr/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio })
      });
      if (!response.ok) throw new Error(`ASR failed (${response.status}).`);
      const transcript = (await response.json()) as { id: string; text: string; confidence?: number };
      const text = transcript.text.trim();
      if (!text) {
        setState({ kind: "error", message: "Didn't catch that — try again." });
        return;
      }
      const cue: ListenerCue = {
        id: transcript.id || crypto.randomUUID(),
        text,
        capturedAt: audio.capturedAt,
        confidence: transcript.confidence
      };
      const sent = onSubmit(cue);
      if (!sent) {
        setState({ kind: "error", message: "Show isn't live — start the show to send cues." });
        return;
      }
      setState({ kind: "delivered", text, clearedAt: Date.now() });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Cue failed."
      });
    }
  }, [onSubmit]);

  const cancel = useCallback(() => {
    if (stateRef.current.kind !== "recording") return;
    stateRef.current.recording.cancel();
    setState({ kind: "idle" });
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    void begin();
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    void finish();
  };

  const isHot = state.kind === "recording";
  const label =
    state.kind === "recording"
      ? "Listening…"
      : state.kind === "transcribing"
        ? "Transcribing…"
        : state.kind === "delivered"
          ? `Cue sent: "${state.text}"`
          : state.kind === "error"
            ? state.message
            : "Hold to talk to the hosts";

  return (
    <div className={`cue-host-button-wrap${isHot ? " is-hot" : ""}`} role="group" aria-label="Cue the hosts">
      <button
        type="button"
        className={`cue-host-button${isHot ? " is-recording" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => {
          // Treat leaving the button mid-press as a cancel — the user
          // changed their mind. Releasing inside still submits.
          if (stateRef.current.kind === "recording") cancel();
        }}
        aria-pressed={isHot}
        disabled={state.kind === "transcribing"}
      >
        <span className="cue-host-mic" aria-hidden="true">●</span>
        <span className="cue-host-label">{isHot ? "Hold and speak" : "Cue host"}</span>
      </button>
      <p className="cue-host-status">{label}</p>
    </div>
  );
}

function HuddleLiveAudio({
  game,
  fantasy,
  hosts,
  hostTurns,
  plays,
  fantasySpotlight,
  matchupTotals,
  mediaIndex,
  onStop,
  listenerStakes,
  onNudgeHost,
  onSubmitCue,
  observation,
  modelLabel,
  profile
}: {
  game?: SportsGameState;
  fantasy?: FantasyLeagueState;
  hosts: typeof HUDDLE_HOSTS;
  hostTurns: HuddleHostTurn[];
  plays: SportsPlay[];
  fantasySpotlight: ReturnType<typeof buildFantasySpotlight>;
  matchupTotals: Array<{ id: string; ownerName: string; teamName: string; team?: string; points: number }>;
  mediaIndex: MediaLookupIndex;
  onStop: () => void;
  listenerStakes?: ReturnType<typeof buildListenerStakes>;
  onNudgeHost: (hostId: HostId) => void;
  onSubmitCue?: (cue: ListenerCue) => boolean;
  observation?: LivecastCommentary["observation"];
  modelLabel?: string;
  profile?: UserProfile;
}) {
  const latestPlay = plays[0] ?? game?.currentPlay;
  const rawSpotlightPlayer = findPlayPlayer(fantasy, latestPlay) ?? findSpotlightPlayer(fantasy, fantasySpotlight.title);
  // Only surface the fantasy spotlight player's headshot when their team is
  // actually playing in this game — otherwise we'd show an NFL headshot
  // (Mahomes etc.) on top of an NBA broadcast.
  const spotlightPlayer = rawSpotlightPlayer && (rawSpotlightPlayer.proTeam === game?.awayTeam || rawSpotlightPlayer.proTeam === game?.homeTeam)
    ? rawSpotlightPlayer
    : undefined;
  const playerAsset = spotlightPlayer ? resolvePlayerMedia(mediaIndex, spotlightPlayer) : undefined;
  const focusTeam = latestPlay?.team ?? spotlightPlayer?.proTeam ?? game?.awayTeam;
  const teamAsset = resolveTeamMedia(mediaIndex, focusTeam);
  const teamLogoUrl = focusTeam === game?.awayTeam ? game?.awayMeta?.logo : focusTeam === game?.homeTeam ? game?.homeMeta?.logo : undefined;
  const awayScore = latestPlay?.score.away ?? game?.currentPlay?.score.away ?? 0;
  const homeScore = latestPlay?.score.home ?? game?.currentPlay?.score.home ?? 0;
  const scoreLine = game ? `${game.awayTeam} ${awayScore} - ${game.homeTeam} ${homeScore}` : "Live show";
  const meta = latestPlay ? `${latestPlay.quarter} · ${latestPlay.clock}` : "Official play-by-play";
  const heroHeadline = formatLiveMomentHeadline(latestPlay?.headline ?? fantasySpotlight.title);
  const heroDescription = formatLiveMomentDescription(latestPlay?.description ?? fantasySpotlight.body);
  // If the latest play touched a listener starter, the hero gets a
  // gold "Your lineup" eyebrow so the listener instantly sees their
  // skin in the moment — not just hosts talking around them.
  const listenerPlayer = (() => {
    if (!profile || listenerStakes?.status !== "ready" || !latestPlay) return undefined;
    const ids = new Set(latestPlay.playerIds);
    return listenerStakes.startersInGame.find((player) => ids.has(player.id));
  })();
  // Whichever host just spoke gets a 6-second active highlight in the
  // strip — keeps the listener aware that there are real personalities
  // taking turns, not a single anonymous voice.
  const latestTurnHostId = hostTurns.length ? hostTurns[hostTurns.length - 1].host.id : undefined;
  const latestTurnId = hostTurns.length ? hostTurns[hostTurns.length - 1].id : undefined;
  const [activeHostId, setActiveHostId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!latestTurnHostId) return;
    setActiveHostId(latestTurnHostId);
    const timer = window.setTimeout(() => setActiveHostId(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [latestTurnId, latestTurnHostId]);
  // Listener nudged a host — show "queued" treatment until the next
  // turn arrives. Cleared when latestTurnId changes (server delivered).
  const [queuedHostId, setQueuedHostId] = useState<HostId | undefined>(undefined);
  useEffect(() => {
    if (queuedHostId) setQueuedHostId(undefined);
    // Intentionally only reset when a new turn lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestTurnId]);
  const handleNudge = (hostId: HostId) => {
    setQueuedHostId(hostId);
    onNudgeHost(hostId);
  };
  return (
    <section className="audio-live-layout">
      <div className="moment-hero">
        <div className="live-action-backdrop" aria-hidden="true" />
        <div className="live-hero-copy">
          {listenerPlayer ? (
            <span className="eyebrow eyebrow-on-lineup"><span className="icon icon-trophy-winner" aria-hidden="true" />On your lineup · {listenerPlayer.position} {listenerPlayer.name}</span>
          ) : (
            <span className="eyebrow"><span className="icon icon-live-video" aria-hidden="true" />Now live</span>
          )}
          <h1>{heroHeadline}</h1>
          <p>{heroDescription}</p>
          <div className="live-scoreline">
            <span>{scoreLine}</span>
            <b>{meta}</b>
          </div>
        </div>
        <div className="live-hero-media">
          <div className="live-player-portrait">
            <MediaAvatar src={playerAsset ? undefined : teamLogoUrl} asset={playerAsset ?? teamAsset} label={spotlightPlayer?.name ?? latestPlay?.team ?? "Live"} />
          </div>
          <div className="voice-orb" aria-hidden="true"><Waveform isPlaying levels={[22, 44, 28, 58, 34, 72, 42, 64, 30, 50, 24]} /></div>
        </div>
        <div className="live-host-strip" role="group" aria-label="Tap a host to make them speak next">
          {hosts.map((host) => {
            const isActive = activeHostId === host.id;
            const isQueued = queuedHostId === host.id;
            const stateClass = [isActive ? "is-active" : "", isQueued ? "is-queued" : ""].filter(Boolean).join(" ");
            const label = isActive ? "On mic" : isQueued ? "Up next" : `Tap for ${host.name}`;
            return (
              <button
                key={host.id}
                type="button"
                data-accent={host.accent}
                className={stateClass || undefined}
                onClick={() => handleNudge(host.id as HostId)}
                disabled={isActive}
                aria-pressed={isQueued}
                aria-label={`Cue ${host.name} to speak next`}
              >
                <HostAvatar label={host.name} accent={host.accent} />
                <strong>{host.name}</strong>
                <span>{isActive || isQueued ? label : host.role}</span>
              </button>
            );
          })}
        </div>
        {onSubmitCue && <CueHostButton onSubmit={onSubmitCue} />}
      </div>
      <section className="live-conversation">
        <header>
          <span className="eyebrow"><span className="icon icon-radio" aria-hidden="true" />Host conversation</span>
          <button className="secondary compact" onClick={onStop}><span className="icon icon-stop" aria-hidden="true" />Stop show</button>
        </header>
        <HostTurns turns={hostTurns} />
      </section>
      <aside className="audio-live-rail">
        <NemotronSeesPanel observation={observation} modelLabel={modelLabel} />
        <MatchupCard game={game} mediaIndex={mediaIndex} />
        <article className="huddle-card fantasy-impact-card">
          <span className="eyebrow"><span className="icon icon-trophy-winner" aria-hidden="true" />Fantasy impact</span>
          <div className="impact-player">
            <MediaAvatar src={playerAsset ? undefined : teamLogoUrl} asset={playerAsset ?? teamAsset} label={spotlightPlayer?.name ?? fantasySpotlight.title} />
            <div>
              <strong>{spotlightPlayer?.name ?? fantasySpotlight.title}</strong>
              <p>{fantasySpotlight.body}</p>
            </div>
          </div>
          <div className="impact-matchup-mini">
            {matchupTotals.slice(0, 2).map((roster) => <ScoreRow key={roster.id} roster={roster} mediaIndex={mediaIndex} />)}
          </div>
        </article>
        <RecentHighlights plays={plays} game={game} mediaIndex={mediaIndex} />
      </aside>
    </section>
  );
}

function HuddleRecap({
  game,
  hosts,
  hostTurns,
  recapSummary,
  plays,
  commentary,
  fantasySpotlight,
  mediaIndex,
  onStart,
  onExportRecap,
  listenerStakes,
  listenerRecapHighlight,
  onArchiveClip,
  onGetClipSubtitles,
  profile
}: {
  game?: SportsGameState;
  hosts: typeof HUDDLE_HOSTS;
  hostTurns: HuddleHostTurn[];
  recapSummary: ReturnType<typeof buildRecapSummary>;
  plays: SportsPlay[];
  commentary: LivecastCommentary[];
  fantasySpotlight: ReturnType<typeof buildFantasySpotlight>;
  mediaIndex: MediaLookupIndex;
  onStart: () => void;
  onExportRecap: () => void;
  listenerStakes?: ReturnType<typeof buildListenerStakes>;
  listenerRecapHighlight?: ReturnType<typeof buildListenerRecapHighlight>;
  onArchiveClip?: (commentaryId: string) => Promise<string | undefined>;
  onGetClipSubtitles?: (commentaryId: string) => Promise<{ vtt: string; text: string } | undefined>;
  profile?: UserProfile;
}) {
  const hasListener = Boolean(profile) && listenerStakes?.status === "ready";
  const recapTitle = hasListener
    ? `${listenerStakes!.listenerName}, your show is in the books`
    : recapSummary.title;
  const recapSubtitle = hasListener
    ? listenerStakes!.stakesLine
    : recapSummary.subtitle;
  return (
    <section className="recap-layout">
      <header className="recap-hero">
        <span className="eyebrow"><span className="icon icon-medal" aria-hidden="true" />Postgame show</span>
        <h1>{recapTitle}</h1>
        <p>{recapSubtitle}</p>
        <div className="host-row">{hosts.map((host) => <HostAvatar key={host.id} label={host.name} accent={host.accent} />)}</div>
      </header>
      <section className="recap-grid">
        <article className="huddle-card wide-card">
          <span className="eyebrow"><span className="icon icon-radio" aria-hidden="true" />Host recap</span>
          <HostTurns turns={hostTurns} />
        </article>
        {listenerRecapHighlight && hasListener && (
          <ListenerHighlightCard
            highlight={listenerRecapHighlight}
            listenerName={listenerStakes!.listenerName}
            gameLabel={game ? `${game.awayTeam} vs ${game.homeTeam}` : undefined}
            sport={game?.sport}
            onArchiveClip={onArchiveClip}
            onGetClipSubtitles={onGetClipSubtitles}
          />
        )}
        {profile && listenerStakes && <ListenerStakesCard stakes={listenerStakes} />}
        <MatchupCard game={game} mediaIndex={mediaIndex} />
        <StorylineCard icon="icon-flag" title="The turning point" items={[recapSummary.turningPoint, fantasySpotlight.body]} />
        <StorylineCard icon="icon-star-filled" title="Best host moment" items={[recapSummary.hostMoment, recapSummary.matchupShift]} />
        <RecentHighlights plays={plays} game={game} mediaIndex={mediaIndex} />
        <StorylineCard icon="icon-megaphone-loud" title="Show stats" items={[`${commentary.length} generated calls in this show.`]} />
      </section>
      <div className="button-row">
        <button className="primary" onClick={onStart}><span className="icon icon-broadcast" aria-hidden="true" />Go live again</button>
        <button className="secondary" onClick={onExportRecap}><span className="icon icon-export" aria-hidden="true" />Export transcript</button>
      </div>
    </section>
  );
}

function HuddlePlayerBar({ phase, game, hostTurns, audioPlaying, audioLevels, onStart, onStop, onOpenStream }: { phase: HuddlePhase; game?: SportsGameState; hostTurns: HuddleHostTurn[]; audioPlaying: boolean; audioLevels: number[]; onStart: () => void; onStop: () => void; onOpenStream: () => void }) {
  const isLive = phase === "live" || phase === "live-audio";
  const isEmpty = phase === "empty";
  const isPregame = phase === "pregame";
  const playerStatus = isEmpty
    ? "Connect your league, pick a game, and choose how you watch."
    : hostTurns[0]?.text ?? "Ready for the first call.";
  const showLabel = isEmpty
    ? "Not playing"
    : game ? `${game.awayTeam} vs ${game.homeTeam}` : (isPregame ? "Pregame" : isLive ? "Live show" : "Not playing");
  return (
    <footer className="huddle-player">
      <div className="player-show">
        <div className="mini-host-stack">
          {HUDDLE_HOSTS.map((host) => <HostAvatar key={host.id} label={host.name} accent={host.accent} size="sm" />)}
        </div>
        <div>
          <strong>Huddle Radio</strong>
          <span>{showLabel}</span>
        </div>
      </div>
      <button
        className="player-main-button"
        onClick={isLive ? onStop : onStart}
        aria-label={isLive ? "Stop show" : isEmpty ? "Try demo show" : isPregame ? "Start show" : "Play"}
      >
        <span className={`icon ${isLive ? "icon-stop" : "icon-play"}`} aria-hidden="true" />
      </button>
      <Waveform isPlaying={audioPlaying} levels={audioLevels} />
      <div className="player-controls">
        <button className="secondary compact">More calm</button>
        <button className="secondary compact">More analysis</button>
        <button className="secondary compact">Roast opponent</button>
        <button className="secondary compact" onClick={onOpenStream}><span className="icon icon-broadcast" aria-hidden="true" />Stream</button>
      </div>
      <p role="status" aria-live="polite">{playerStatus}</p>
    </footer>
  );
}

function HostStudio({ hosts, turns }: { hosts: typeof HUDDLE_HOSTS; turns: HuddleHostTurn[] }) {
  return (
    <section className="host-studio">
      <div className="studio-art" aria-hidden="true">
        {hosts.map((host) => (
          <span key={host.id} data-accent={host.accent}>
            <strong>{host.name}</strong>
            <small>{host.role}</small>
          </span>
        ))}
      </div>
      <div className="host-cards">
        {hosts.map((host) => (
          <article className="host-card" data-accent={host.accent} key={host.id}>
            <HostAvatar label={host.name} accent={host.accent} size="lg" />
            <strong>{host.name}</strong>
            <span>{host.role}</span>
            <p>{host.description}</p>
          </article>
        ))}
      </div>
      <HostTurns turns={turns.slice(0, 3)} compact />
    </section>
  );
}

function HostTurns({ turns, compact = false }: { turns: HuddleHostTurn[]; compact?: boolean }) {
  return (
    // role=log + aria-live=polite tells screen readers each new
    // commentary turn is content that should be announced as it
    // arrives. atomic=false so only the new turn is read, not the
    // whole transcript on every update.
    <div
      className={compact ? "host-turns compact" : "host-turns"}
      role="log"
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions"
    >
      {turns.map((turn) => (
        <article className="host-turn" data-accent={turn.host.accent} key={turn.id}>
          <HostAvatar label={turn.host.name} accent={turn.host.accent} />
          <div>
            <header>
              <strong>{turn.host.name}</strong>
              <span>{turn.host.role}</span>
              {turn.time && <small>{turn.time}</small>}
            </header>
            <p>{turn.text}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function HostAvatar({ label, accent, size = "md" }: { label: string; accent: "violet" | "orange" | "gold"; size?: "sm" | "md" | "lg" }) {
  return (
    <span className="host-avatar" data-accent={accent} data-size={size}>
      {initialsForUi(label).slice(0, 2)}
    </span>
  );
}

function MatchupCard({ game, mediaIndex }: { game?: SportsGameState; mediaIndex: MediaLookupIndex }) {
  return (
    <article className="huddle-card matchup-card">
      <span className="eyebrow">
        <span className="icon icon-stadium" aria-hidden="true" />
        Tonight’s matchup
      </span>
      <div className="matchup-line">
        <div>
          <MediaAvatar src={game?.awayMeta?.logo} asset={resolveTeamMedia(mediaIndex, game?.awayTeam)} label={game?.awayTeam ?? "AWAY"} />
          <strong>{game?.awayTeam ?? "Away"}</strong>
          <b>{game?.currentPlay?.score.away ?? 0}</b>
        </div>
        <span>at</span>
        <div>
          <MediaAvatar src={game?.homeMeta?.logo} asset={resolveTeamMedia(mediaIndex, game?.homeTeam)} label={game?.homeTeam ?? "HOME"} />
          <strong>{game?.homeTeam ?? "Home"}</strong>
          <b>{game?.currentPlay?.score.home ?? 0}</b>
        </div>
      </div>
      <p>{game?.currentPlay ? `${game.currentPlay.quarter} · ${game.currentPlay.clock}` : "Pregame show is warming up."}</p>
    </article>
  );
}

function StorylineCard({ title, items, icon = "icon-flag" }: { title: string; items: string[]; icon?: string }) {
  return (
    <article className="huddle-card">
      <span className="eyebrow"><span className={`icon ${icon}`} aria-hidden="true" />{title}</span>
      <div className="storyline-list">
        {items.filter(Boolean).slice(0, 4).map((item) => <p key={item}>{item}</p>)}
      </div>
    </article>
  );
}

/**
 * Friend matchup posture for the active sport. Renders each friend's
 * current lead/trail vs their opponent so the listener can tell where
 * the room's drama actually is — not just their own roster.
 */
function FriendMatchupsCard({ matchups }: { matchups: ReturnType<typeof buildFriendMatchups> }) {
  return (
    <article className="huddle-card friend-matchups-card">
      <span className="eyebrow"><span className="icon icon-league" aria-hidden="true" />Friend stakes</span>
      <ul className="friend-matchups-list">
        {matchups.slice(0, 4).map((entry) => {
          const tone: "lead" | "trail" | "even" = entry.margin > 0.05 ? "lead" : entry.margin < -0.05 ? "trail" : "even";
          return (
            <li key={entry.friendId} className={`friend-matchup-item tone-${tone}`}>
              <strong>{entry.friendName}</strong>
              <span className="friend-matchup-team">{entry.teamName}</span>
              <span className="friend-matchup-line">{entry.stakeLine}</span>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

/**
 * News-driven pregame storylines. Renders real beat-writer items with
 * source + relative-time attribution. Falls back to `extras` (matchup
 * story / spotlight body) when news is sparse.
 */
function OddsCard({ odds }: { odds: GameOdds }) {
  const spread = odds.spread != null ? formatSpread(odds.spread, odds.homeTeam, odds.awayTeam) : undefined;
  const total = odds.total != null ? `O/U ${odds.total.toFixed(1)}` : undefined;
  const homeMl = odds.moneyline?.home != null ? formatMoneyline(odds.moneyline.home) : undefined;
  const awayMl = odds.moneyline?.away != null ? formatMoneyline(odds.moneyline.away) : undefined;
  return (
    <article className="huddle-card odds-card">
      <span className="eyebrow"><span className="icon icon-chart" aria-hidden="true" />Vegas line</span>
      <ul className="odds-card-list">
        {spread && <li><strong>Spread</strong><span>{spread}</span></li>}
        {total && <li><strong>Total</strong><span>{total}</span></li>}
        {(homeMl || awayMl) && (
          <li>
            <strong>Moneyline</strong>
            <span>{[odds.awayTeam && awayMl && `${odds.awayTeam} ${awayMl}`, odds.homeTeam && homeMl && `${odds.homeTeam} ${homeMl}`].filter(Boolean).join(" · ")}</span>
          </li>
        )}
      </ul>
      {odds.book && <p className="odds-card-book">via {odds.book}</p>}
    </article>
  );
}

/**
 * Pregame markets board. Same data source as the live MarketsTicker
 * (W19), but rendered as a vertical card for the pregame rail so the
 * listener understands the betting context before the show starts.
 *
 * Refreshes once on mount, plus a slow 30s poll while the user lingers
 * on the pregame screen. Hidden silently when no relevant markets
 * exist for the game's sport so an uncovered league doesn't show a
 * skeleton card.
 */
function MarketsBoardCard({ game }: { game?: SportsGameState }) {
  const [snapshots, setSnapshots] = useState<MarketSnapshot[]>([]);

  useEffect(() => {
    if (!game?.sport) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const response = await fetch(`/api/markets?sport=${encodeURIComponent(game.sport)}`, {
          cache: "no-store"
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { snapshots?: MarketSnapshot[] };
        if (cancelled) return;
        setSnapshots(Array.isArray(payload.snapshots) ? payload.snapshots : []);
      } catch {
        // Silent — pregame markets are atmosphere, not a blocker.
      }
    };
    void tick();
    timer = setInterval(tick, 30000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [game?.sport]);

  const relevant = useMemo(() => {
    if (!game?.sport || snapshots.length === 0) return [];
    return pickRelevantMarketsForGame(
      snapshots,
      { sport: game.sport, teams: [game.awayTeam, game.homeTeam] },
      4
    );
  }, [snapshots, game?.sport, game?.awayTeam, game?.homeTeam]);

  if (!relevant.length) return null;

  return (
    <article className="huddle-card markets-board-card">
      <span className="eyebrow">
        <span className="icon icon-chart" aria-hidden="true" />
        What the markets say
      </span>
      <ul className="markets-board-list">
        {relevant.map((snapshot) => {
          const delta = snapshot.recentDeltaCents ?? 0;
          const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
          return (
            <li key={`${snapshot.source}:${snapshot.externalId}`} data-source={snapshot.source}>
              <div className="markets-board-row-meta">
                <span className="markets-board-source">
                  {snapshot.source === "kalshi" ? "Kalshi" : "Polymarket"}
                </span>
                <strong>{snapshot.outcomeLabel}</strong>
                <span className="markets-board-title" title={snapshot.title}>{snapshot.title}</span>
              </div>
              <div className="markets-board-row-price">
                <b>{snapshot.yesPriceCents}¢</b>
                {delta !== 0 && (
                  <em className={`markets-board-delta is-${direction}`}>
                    {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}¢
                  </em>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function formatSpread(spread: number, homeTeam: string, awayTeam: string): string {
  // The Odds API returns the home spread directly. Negative = home
  // favored (e.g. -3.5 means home is laying 3.5).
  if (spread < 0) return `${homeTeam} ${spread.toFixed(1)}`;
  if (spread > 0) return `${awayTeam} -${spread.toFixed(1)}`;
  return "PICK";
}

function formatMoneyline(price: number): string {
  return price > 0 ? `+${price}` : String(price);
}

function NewsStorylineCard({ news, extras }: { news: NewsItem[]; extras: string[] }) {
  return (
    <article className="huddle-card storyline-news-card">
      <span className="eyebrow"><span className="icon icon-megaphone-loud" aria-hidden="true" />Storylines to watch</span>
      <ul className="storyline-news-list">
        {news.slice(0, 3).map((item) => (
          <li key={item.id} className="storyline-news-item">
            <strong>{item.title}</strong>
            <span>
              {item.source}
              {item.publishedAt ? ` · ${formatRelativeTime(item.publishedAt)}` : ""}
            </span>
          </li>
        ))}
        {news.length === 0 && extras.slice(0, 2).map((line) => (
          <li key={line} className="storyline-news-item storyline-news-item--fallback">
            <strong>{line}</strong>
          </li>
        ))}
      </ul>
      {news.length > 0 && extras.length > 0 && (
        <p className="storyline-news-fallback-note">{extras[0]}</p>
      )}
    </article>
  );
}

function RostersCard({ matchupTotals, mediaIndex }: { matchupTotals: Array<{ id: string; ownerName: string; teamName: string; team?: string; points: number }>; mediaIndex: MediaLookupIndex }) {
  return (
    <article className="huddle-card">
      <span className="eyebrow"><span className="icon icon-pie-chart" aria-hidden="true" />Live matchup</span>
      <div className="roster-list">
        {matchupTotals.slice(0, 2).map((roster) => <ScoreRow key={roster.id} roster={roster} mediaIndex={mediaIndex} />)}
      </div>
    </article>
  );
}

function RecentHighlights({ plays, game, mediaIndex }: { plays: SportsPlay[]; game?: SportsGameState; mediaIndex: MediaLookupIndex }) {
  return (
    <article className="huddle-card">
      <span className="eyebrow"><span className="icon icon-graph-bar" aria-hidden="true" />Recent highlights</span>
      <div className="highlight-list">
        {plays.length ? plays.slice(0, 4).map((play) => <PlayRow key={play.id} play={play} game={game} mediaIndex={mediaIndex} />) : <p className="empty">Waiting for the first moment.</p>}
      </div>
    </article>
  );
}

function FirstRunSetup({
  fantasy,
  game,
  group,
  providerMode,
  sportsDataMode,
  videoMode,
  videoUrl,
  ttsEnabled,
  onEspn,
  onSleeper,
  onScreenShare,
  onUrl,
  onFriends,
  onDemo,
  onStart,
  startBlocked
}: {
  fantasy?: FantasyLeagueState;
  game?: SportsGameState;
  group: GroupSettings;
  providerMode: "demo" | "sleeper" | "espn";
  sportsDataMode: "demo" | "espn";
  videoMode: VideoMode;
  videoUrl: string;
  ttsEnabled: boolean;
  onEspn: () => void;
  onSleeper: () => void;
  onScreenShare: () => void;
  onUrl: () => void;
  onFriends: () => void;
  onDemo: () => void;
  onStart: () => void;
  startBlocked: boolean;
}) {
  const videoLabel = videoMode === "screen-share" ? "Screen share selected" : videoUrl ? "Stream URL added" : "No video yet";
  return (
    <section className="first-run" aria-label="Set up your livecast">
      <div className="first-run-hero">
        <span>Start here</span>
        <h2>Build a livecast for your fantasy group</h2>
        <p>Connect a league, choose the game feed, add the stream you are already allowed to watch, then let the host call the moments for your friends.</p>
      </div>

      <div className="setup-path">
        <article className="setup-step is-ready">
          <div className="step-number">1</div>
          <div>
            <span>Fantasy group</span>
            <strong>{providerMode === "demo" ? "Demo league loaded" : fantasy?.leagueName ?? "Connect your league"}</strong>
            <p>{providerMode === "espn" ? "ESPN can load public leagues; private leagues need cookies in setup." : providerMode === "sleeper" ? "Sleeper needs only a league ID." : "Use demo now, or connect ESPN/Sleeper when ready."}</p>
            <div className="setup-actions">
              <button className="secondary compact" onClick={onEspn}>ESPN</button>
              <button className="secondary compact" onClick={onSleeper}>Sleeper</button>
            </div>
          </div>
        </article>

        <article className={sportsDataMode === "espn" ? "setup-step is-ready" : "setup-step"}>
          <div className="step-number">2</div>
          <div>
            <span>Game data</span>
            <strong>{sportsDataMode === "espn" ? "ESPN scoreboard selected" : game ? `${game.awayTeam} at ${game.homeTeam}` : "Pick a game feed"}</strong>
            <p>Use demo scripted plays for rehearsal, or ESPN public scoreboard for real scores and play state.</p>
            <div className="setup-actions">
              <button className="secondary compact" onClick={onEspn}>Use ESPN data</button>
            </div>
          </div>
        </article>

        <article className={videoUrl || videoMode === "screen-share" ? "setup-step is-ready" : "setup-step is-needed"}>
          <div className="step-number">3</div>
          <div>
            <span>Stream</span>
            <strong>{videoLabel}</strong>
            <p>For YouTube TV, ESPN, cable apps, or DRM video, use screen share. For permitted VOD or embeddable YouTube, paste a URL.</p>
            <div className="setup-actions">
              <button className="secondary compact" onClick={onScreenShare}>Screen share</button>
              <button className="secondary compact" onClick={onUrl}>Paste URL</button>
            </div>
          </div>
        </article>

        <article className="setup-step is-ready">
          <div className="step-number">4</div>
          <div>
            <span>Friends and voice</span>
            <strong>{group.friends.length} friends · {ttsEnabled ? "voice on" : "voice off"}</strong>
            <p>Set names, teams, rivalry notes, tone, and whether the host speaks out loud.</p>
            <div className="setup-actions">
              <button className="secondary compact" onClick={onFriends}>Edit group</button>
            </div>
          </div>
        </article>
      </div>

      <div className="first-run-footer">
        <button className="icon-label" onClick={onStart} disabled={startBlocked}>
          <MicroIcon name="play" />
          Start with current setup
        </button>
        <button className="secondary icon-label" onClick={onDemo}>
          <MicroIcon name="controller" />
          Try clean demo
        </button>
      </div>
    </section>
  );
}

const WAVEFORM_BARS = [32, 58, 42, 76, 48, 64, 36, 84, 52, 70, 40, 62, 90, 54, 68, 46, 78, 34, 58, 74, 44, 88, 50, 66, 38, 72, 56, 82, 42, 60, 92, 48, 70, 36, 64, 80, 52, 74, 40, 68, 86, 46, 62, 78, 34, 58, 72, 44];

function Waveform({ isPlaying, levels }: { isPlaying: boolean; levels: number[] }) {
  return (
    <div className={isPlaying ? "waveform is-playing" : "waveform"} aria-hidden="true">
      {levels.map((height, index) => (
        <span
          key={index}
          style={{
            "--bar-height": `${height}%`,
            animationDelay: `${index * -82}ms`
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

function FantasyMatchupFloat({ matchupTotals, mediaIndex }: { matchupTotals: Array<{ id: string; ownerName: string; teamName: string; team?: string; points: number }>; mediaIndex: MediaLookupIndex }) {
  if (matchupTotals.length === 0) return null;
  const sorted = [...matchupTotals].sort((left, right) => right.points - left.points);
  const leader = sorted[0];
  const trailer = sorted[sorted.length - 1];
  const margin = leader && trailer && leader.id !== trailer.id ? Math.abs(leader.points - trailer.points).toFixed(1) : "0.0";

  return (
    <aside className="fantasy-float" aria-label="Fantasy matchup points">
      <div className="fantasy-float-teams">
        {matchupTotals.slice(0, 2).map((roster) => (
          <div className="fantasy-float-team" key={roster.id}>
            <MediaAvatar asset={resolveTeamMedia(mediaIndex, roster.team)} label={roster.team ?? roster.ownerName} size="sm" />
            <span>{roster.ownerName}</span>
            <strong>{roster.points.toFixed(1)}</strong>
          </div>
        ))}
      </div>
      {leader && trailer && leader.id !== trailer.id && <p>{leader.ownerName} +{margin}</p>}
    </aside>
  );
}

function HostLowerThird({ commentary, plan, isLive }: { commentary?: LivecastCommentary; plan: SessionDirectorPlan; isLive: boolean }) {
  const headline = commentary?.moment.headline ?? (isLive ? "Listening for the next moment" : "Ready for the first call");
  const text = commentary?.text ?? plan.cues[0] ?? "Start the livecast when the room is ready.";
  return (
    <div className="host-lower-third">
      <span>{isLive ? "AI Host Live" : "AI Host Standby"}</span>
      <strong>{headline}</strong>
      <p>{text}</p>
    </div>
  );
}

function LiveRail({
  plan,
  producerBrief,
  commentary,
  game,
  plays,
  topImpacts,
  isLive,
  providerMode,
  sportsDataMode,
  videoMode,
  hasVideoSource,
  group,
  ttsEnabled,
  displayedTurnText,
  onStart,
  onStop,
  onValidate,
  onOpenSetup,
  onDemo
}: {
  plan: SessionDirectorPlan;
  producerBrief: ProducerBrief;
  commentary: LivecastCommentary[];
  game?: SportsGameState;
  plays: SportsPlay[];
  topImpacts: FantasyImpact[];
  isLive: boolean;
  providerMode: "demo" | "sleeper" | "espn";
  sportsDataMode: "demo" | "espn";
  videoMode: VideoMode;
  hasVideoSource: boolean;
  group: GroupSettings;
  ttsEnabled: boolean;
  /** Resolves a commentary item to the text the listener is hearing
   *  right now — never a future turn's script. */
  displayedTurnText: (item: LivecastCommentary | undefined) => string | undefined;
  onStart: () => void;
  onStop: () => void;
  onValidate: () => void;
  onOpenSetup: () => void;
  onDemo: () => void;
}) {
  const latest = commentary[0];
  const feedItems = buildLiveFeedItems({ game, plays, commentary, impacts: topImpacts, producerBrief, displayedTurnText });
  if (!isLive && commentary.length === 0) {
    return (
      <section className="setup-rail-card" data-mode={plan.mode}>
        <div className="rail-score">
          <div>
            <span className="eyebrow"><span className="icon icon-flag" aria-hidden="true" />Next steps</span>
            <h2>Get to first cast</h2>
          </div>
          <strong>{plan.score}</strong>
        </div>
        <div className="rail-checklist">
          <SetupCheck ok={providerMode !== "demo"} label="Connect fantasy" detail={providerMode === "demo" ? "Demo league is loaded. Connect ESPN or Sleeper for your group." : `${providerMode.toUpperCase()} selected.`} />
          <SetupCheck ok={sportsDataMode !== "demo"} label="Choose game data" detail={sportsDataMode === "demo" ? "Demo plays are active. ESPN scoreboard can follow real games." : "ESPN scoreboard selected."} />
          <SetupCheck ok={hasVideoSource} label="Add stream" detail={hasVideoSource ? `${modeLabel(videoMode)} selected.` : "Use screen share for ESPN, YouTube TV, or cable apps."} />
          <SetupCheck ok={group.friends.length > 0} label="Personalize friends" detail={`${group.friends.length} friends · ${ttsEnabled ? "voice on" : "voice off"}.`} />
        </div>
        <div className="rail-actions setup-actions-rail">
          <button className="icon-label" onClick={onOpenSetup}>
            <MicroIcon name="ai-settings" />
            Open setup
          </button>
          <button className="secondary compact icon-label" onClick={onDemo}>
            <MicroIcon name="controller" />
            Demo
          </button>
        </div>
        <p className="setup-help">Already watching in ESPN, YouTube TV, or a cable app? Use screen share. Direct URLs only work for permitted VOD or embeddable streams.</p>
      </section>
    );
  }
  return (
    <section className="live-rail-card" data-mode={plan.mode}>
      <div className="rail-score">
        <div>
          <span className="eyebrow"><span className="icon icon-broadcast" aria-hidden="true" />Live feed</span>
          <h2>{isLive ? "On air" : plan.mode === "blocked" ? "Needs setup" : "Ready"}</h2>
        </div>
        <strong>{plan.score}</strong>
      </div>

      <div className="rail-actions">
        <button className="icon-label" onClick={onStart} disabled={isLive || plan.mode === "blocked"}>
          <MicroIcon name="play" />
          {isLive ? "Live now" : "Start livecast"}
        </button>
        <button className="secondary compact icon-label" onClick={onStop} disabled={!isLive}>
          <MicroIcon name="stop" />
          Stop
        </button>
        <button className="secondary compact icon-label" onClick={onValidate}>
          <MicroIcon name="live-video" />
          Validate
        </button>
      </div>

      <div className="rail-now">
        <span>{latest ? latest.moment.priority : "pregame"}</span>
        <strong>{latest?.moment.headline ?? "Pregame angle locked"}</strong>
        <p>{displayedTurnText(latest) ?? producerBrief.lines[0] ?? "The host will mix play-by-play, fantasy impact, and group context."}</p>
      </div>

      <div className="moment-feed" aria-label="Moment by moment updates">
        {feedItems.map((item) => (
          <article className="feed-item" data-kind={item.kind} key={item.id}>
            <span>{item.kind}</span>
            <strong>{item.title}</strong>
            <p>{item.body}</p>
            {item.meta && <small>{item.meta}</small>}
          </article>
        ))}
      </div>
    </section>
  );
}

function SetupCheck({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="setup-check" data-ok={ok}>
      <span>{ok ? "OK" : "TO DO"}</span>
      <div>
        <strong>{label}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function buildLiveFeedItems({
  game,
  plays,
  commentary,
  impacts,
  producerBrief,
  displayedTurnText
}: {
  game?: SportsGameState;
  plays: SportsPlay[];
  commentary: LivecastCommentary[];
  impacts: FantasyImpact[];
  producerBrief: ProducerBrief;
  displayedTurnText: (item: LivecastCommentary | undefined) => string | undefined;
}) {
  const items: Array<{ id: string; kind: string; title: string; body: string; meta?: string }> = [];
  if (game) {
    items.push({
      id: `score-${game.updatedAt}`,
      kind: "Score",
      title: `${game.awayTeam} ${game.currentPlay?.score.away ?? 0}, ${game.homeTeam} ${game.currentPlay?.score.home ?? 0}`,
      body: game.currentPlay?.headline ?? `Game status: ${game.status}.`,
      meta: game.currentPlay ? `${game.currentPlay.quarter} · ${game.currentPlay.clock}` : game.status
    });
  }
  commentary.slice(0, 2).forEach((item) => {
    items.push({
      id: `call-${item.id}`,
      kind: "Host",
      title: item.moment.headline,
      body: item.moment.summary || displayedTurnText(item) || item.text,
      meta: `${item.moment.priority} · ${item.latency.endToEndMs}ms`
    });
  });
  impacts.slice(0, 3).forEach((impact, index) => {
    items.push({
      id: `impact-${impact.rosterId}-${impact.playerName}-${index}`,
      kind: "Fantasy",
      title: `${impact.playerName} ${impact.pointsDelta >= 0 ? "+" : ""}${impact.pointsDelta}`,
      body: `${impact.ownerName} · ${impact.reason}`,
      meta: impact.teamName
    });
  });
  plays.slice(0, 4).forEach((play) => {
    items.push({
      id: `play-${play.id}`,
      kind: "Play",
      title: play.headline,
      body: play.description,
      meta: `${play.quarter} · ${play.clock} · ${play.team}`
    });
  });
  if (items.length === 0) {
    producerBrief.lines.slice(0, 3).forEach((line, index) => {
      items.push({
        id: `brief-${index}`,
        kind: index === 0 ? "News" : "Setup",
        title: index === 0 ? "Pregame brief" : "Producer cue",
        body: line
      });
    });
  }
  return items.slice(0, 8);
}

function ControlGroup({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`control-group ${className}`.trim()}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function SessionSummary({
  providers,
  videoMode,
  hasVideoSource,
  validation,
  ttsEnabled,
  showAdvanced,
  onToggleAdvanced
}: {
  providers: ActiveProviderSummary;
  videoMode: VideoMode;
  hasVideoSource: boolean;
  validation?: StreamValidation;
  ttsEnabled: boolean;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
}) {
  const videoText = validation
    ? validation.status === "sports-event"
      ? `Validated ${validation.sport ?? "sports"}`
      : validation.status === "unavailable"
        ? "Preview only"
        : validation.status
    : hasVideoSource
      ? "Needs validation"
      : "No video";
  const cards = [
    { label: "Fantasy", value: providers.fantasy },
    { label: "Sports", value: providers.sportsData },
    { label: "Video", value: `${modeLabel(videoMode)} - ${videoText}` },
    { label: "Voice", value: ttsEnabled ? providers.tts : "Off for rehearsal" }
  ];
  return (
    <section className="session-summary">
      {cards.map((card) => (
        <div className="session-card" key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
        </div>
      ))}
      <button className="secondary compact" onClick={onToggleAdvanced}>{showAdvanced ? "Close setup" : "Setup"}</button>
    </section>
  );
}

function modeLabel(mode: VideoMode) {
  if (mode === "screen-share") return "Screen share";
  if (mode === "vod") return "VOD";
  return "Stream";
}

function setupPaneTitle(pane: SetupPane) {
  if (pane === "league") return "League";
  if (pane === "stream") return "Stream";
  if (pane === "friends") return "Friends";
  if (pane === "voice") return "Voice";
  return "Diagnostics";
}

function setupPaneDescription(pane: SetupPane) {
  if (pane === "league") return "Connect fantasy data and choose the game source.";
  if (pane === "stream") return "Add a permitted stream, VOD, or screen share.";
  if (pane === "friends") return "Map friends to rosters and add rivalry context.";
  if (pane === "voice") return "Tune tone, speaking mode, and livecast pacing.";
  return "Check provider health, models, media, and credentials.";
}

function setupPaneGuide(pane: SetupPane) {
  if (pane === "league") {
    return {
      title: "Start here",
      body: "Pick your fantasy source first, then choose the official game feed. Demo data is fine for rehearsal; ESPN or Sleeper makes it yours.",
      steps: ["Choose fantasy provider", "Choose game data", "Validate the import"]
    };
  }
  if (pane === "stream") {
    return {
      title: "Bring the game in",
      body: "Use screen share for ESPN, YouTube TV, cable apps, or anything behind a login. Paste URLs only when the video allows browser playback.",
      steps: ["Select input type", "Add or share the stream", "Validate the frame"]
    };
  }
  if (pane === "friends") {
    return {
      title: "Make it personal",
      body: "The best calls come from roster ownership plus one sharp friend detail. Keep notes short and specific.",
      steps: ["Add friends", "Match each roster", "Write one rivalry note"]
    };
  }
  if (pane === "voice") {
    return {
      title: "Shape the host",
      body: "Tone controls what the host is allowed to say. Cadence controls how often the show interrupts the game.",
      steps: ["Pick tone", "Choose commentary priority", "Set speaking cadence"]
    };
  }
  return {
    title: "Keep the booth honest",
    body: "Diagnostics are for confidence checks, not first-run setup. Use them when a provider, model, or media asset feels off.",
    steps: ["Check health", "Confirm models", "Review provider status"]
  };
}

function SetupGuide({
  pane,
  providerMode,
  sportsDataMode,
  videoMode,
  friendCount,
  ttsEnabled
}: {
  pane: SetupPane;
  providerMode: "demo" | "sleeper" | "espn";
  sportsDataMode: "demo" | "espn";
  videoMode: VideoMode;
  friendCount: number;
  ttsEnabled: boolean;
}) {
  const guide = setupPaneGuide(pane);
  const facts = [
    `Fantasy: ${providerMode === "demo" ? "demo rehearsal" : providerMode.toUpperCase()}`,
    `Game feed: ${sportsDataMode === "espn" ? "ESPN scoreboard" : "scripted demo"}`,
    `Video: ${modeLabel(videoMode)}`,
    `${friendCount} friend${friendCount === 1 ? "" : "s"}`,
    `Voice ${ttsEnabled ? "on" : "off"}`
  ];
  return (
    <aside className="setup-guide" aria-label={`${setupPaneTitle(pane)} guidance`}>
      <p className="eyebrow">Guide</p>
      <h3>{guide.title}</h3>
      <p>{guide.body}</p>
      <ol>
        {guide.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="setup-facts">
        {facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
      </div>
    </aside>
  );
}

function CommentaryCard({ item, ttsLatency, activeTurn }: { item: LivecastCommentary; ttsLatency?: number; activeTurn?: number }) {
  // Multi-turn commentary, rendered as a single "now speaking" caption.
  // We pick the turn whose audio is currently playing (server stamps
  // every TTS chunk with its turn index; the dispatcher tracks the
  // highest seen). This keeps the on-screen text in lockstep with
  // what's actually being spoken — no scripts of unspoken thoughts,
  // no overlap, no "simulation of brains." The audio is the
  // experience; the caption mirrors it.
  const turns = item.lines && item.lines.length > 0
    ? item.lines
    : [{ hostId: item.hostId, text: item.text }];
  // Until the first TTS chunk lands (activeTurn undefined), preview
  // the first turn so the card isn't blank. Once audio starts the
  // dispatcher advances activeTurn through the turns in order.
  const turnIndex = activeTurn !== undefined ? Math.min(activeTurn, turns.length - 1) : 0;
  const turn = turns[turnIndex];
  const persona = HOST_PERSONAS[turn.hostId];
  return (
    <article className="commentary-card" data-priority={item.moment.priority}>
      <div className="moment-banner">
        <span>{item.moment.priority}</span>
        <strong>{item.moment.headline}</strong>
        <b>{item.moment.score}</b>
      </div>
      <div className="commentary-monologue" data-accent={persona.accent}>
        <span className="commentary-monologue__speaker">
          {persona.name}
          {turns.length > 1 && (
            <span className="commentary-monologue__turn-count"> · turn {turnIndex + 1} of {turns.length}</span>
          )}
        </span>
        <p className="commentary-monologue__text">{turn.text}</p>
      </div>
      <div className="metrics">
        <span>model {item.latency.modelResponseMs}ms</span>
        <span>text {item.latency.textGenerationMs}ms</span>
        <span>tts {ttsLatency === undefined ? "n/a" : `${ttsLatency}ms`}</span>
        <span>end-to-end {item.latency.endToEndMs}ms</span>
      </div>
    </article>
  );
}

function MomentRow({ moment }: { moment: LivecastCommentary["moment"] }) {
  return (
    <div className="moment-row" data-priority={moment.priority}>
      <div>
        <strong>{moment.headline}</strong>
        <span>{moment.summary}</span>
      </div>
      <b>{moment.score}</b>
      <div className="evidence-list">
        {moment.reasons.map((reason) => (
          <span key={reason}>{reason}</span>
        ))}
      </div>
    </div>
  );
}

function LaunchReadiness({
  summary,
  brief,
  onValidate,
  onLoadLeague
}: {
  summary: ReturnType<typeof buildProductReadiness>;
  brief: ProducerBrief;
  onValidate: () => void;
  onLoadLeague: () => void;
}) {
  const visibleItems = summary.items.filter((item) => item.level !== "ready").slice(0, 4);
  const items = visibleItems.length ? visibleItems : summary.items.slice(0, 4);
  return (
    <section className="launch-readiness" data-level={summary.level}>
      <div className="launch-header">
        <div>
          <span className="eyebrow">Launch Readiness</span>
          <h2>{summary.headline}</h2>
        </div>
        <div className="readiness-level">{summary.level.replace("-", " ")}</div>
      </div>
      <div className="readiness-grid">
        <div className="checklist">
          {items.map((item) => (
            <div className="check-row" key={item.id}>
              <span data-level={item.level} />
              <div>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </div>
            </div>
          ))}
        </div>
        <div className="producer-brief">
          <strong>{brief.title}</strong>
          {brief.lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      </div>
      {summary.nextActions.length > 0 && (
        <div className="next-actions">
          {summary.nextActions.slice(0, 2).map((action) => (
            <span key={action}>{action}</span>
          ))}
          <button className="secondary compact" onClick={onLoadLeague}>Validate league</button>
          <button className="secondary compact" onClick={onValidate}>Validate video</button>
        </div>
      )}
    </section>
  );
}

function BroadcastDirector({
  plan,
  isLive,
  canExport,
  onStart,
  onStop,
  onValidate,
  onExport
}: {
  plan: SessionDirectorPlan;
  isLive: boolean;
  canExport: boolean;
  onStart: () => void;
  onStop: () => void;
  onValidate: () => void;
  onExport: () => void;
}) {
  return (
    <section className="broadcast-director" data-mode={plan.mode}>
      <div className="director-score">
        <div>
          <span className="eyebrow">Broadcast Director</span>
          <h2>{plan.headline}</h2>
        </div>
        <strong>{plan.score}</strong>
      </div>
      <div className="director-body">
        <div className="run-of-show" aria-label="Run of show">
          {plan.steps.slice(0, 5).map((step) => (
            <div className="director-step" data-state={step.state} key={step.id}>
              <span>{stepStateSymbol(step.state)}</span>
              <div>
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </div>
            </div>
          ))}
        </div>
        <div className="director-cues">
          <strong>Live cues</strong>
          {plan.cues.map((cue) => (
            <span key={cue}>{cue}</span>
          ))}
          <strong>Fallback path</strong>
          {plan.fallbackPlan.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>
      <div className="director-actions">
        <button onClick={onStart} disabled={isLive || plan.mode === "blocked"}>Start livecast</button>
        <button className="secondary compact" onClick={onStop} disabled={!isLive}>Stop</button>
        <button className="secondary compact" onClick={onValidate}>Validate video</button>
        <button className="secondary compact" onClick={onExport} disabled={!canExport}>Export recap</button>
      </div>
    </section>
  );
}

function stepStateSymbol(state: SessionDirectorStepState) {
  if (state === "done") return "OK";
  if (state === "active") return "ON";
  if (state === "blocked") return "!";
  return "?";
}

function LeaguePreview({ preview, fantasy, mediaIndex }: { preview?: FantasyImportPreview; fantasy?: FantasyLeagueState; mediaIndex: MediaLookupIndex }) {
  const league = preview?.league ?? fantasy;
  const summary = preview?.summary ?? (league ? summarizeLeagueForUi(league) : undefined);
  const missingMedia = league ? missingPlayerMediaCount(league, mediaIndex) : 0;
  const readiness = [
    ...(preview?.readiness ?? []),
    {
      id: "media-assets",
      label: "Player media",
      ok: Boolean(league) && missingMedia === 0,
      detail: league ? (missingMedia ? `${missingMedia} player(s) using fallback or missing media.` : "Cached player media available for this league.") : "Load a league to check media."
    }
  ];

  if (!league || !summary) return <p className="empty">Validate or load a league to preview readiness.</p>;

  return (
    <div className="league-preview">
      <strong>{summary.leagueName}</strong>
      <span>Season {summary.season}, week {summary.week}</span>
      <div className="preview-grid">
        <Metric label="Rosters" value={String(summary.rosterCount)} />
        <Metric label="Matchups" value={String(summary.matchupCount)} />
        <Metric label="Players" value={String(summary.playerCount)} />
      </div>
      <div className="checklist">
        {readiness.map((item) => (
          <div className="check-row" key={item.id}>
            <span data-ok={item.ok} />
            <div>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelStackView({ stack }: { stack: ModelStackProfile }) {
  const rows = [
    { id: "commentary", label: "Commentary", ...stack.commentary },
    { id: "realtime", label: "Realtime", ...stack.realtime },
    { id: "multimodal", label: "Video model", ...stack.multimodal },
    { id: "tts", label: "Voice", ...stack.tts }
  ];
  return (
    <div className="model-stack">
      <strong>Preset: {stack.preset.toUpperCase()}</strong>
      {rows.map((row) => (
        <div className="model-row" key={row.id}>
          <span data-status={row.status} />
          <div>
            <strong>{row.label}</strong>
            <small>{row.provider} / {row.model}</small>
            <small>{row.role}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function StreamValidationPanel({
  observation,
  frameCaptureStatus,
  onValidate,
  onScreenShare
}: {
  observation?: LivecastCommentary["observation"];
  frameCaptureStatus: string;
  onValidate: () => void;
  onScreenShare: () => void;
}) {
  const validation = observation?.validation;
  return (
    <div className="stream-validation">
      <div className="validation-status" data-status={validation?.status ?? "unavailable"}>
        <span />
        <strong>{validation ? validationLabel(validation) : "Waiting for validation"}</strong>
      </div>
      <small>{frameCaptureStatus}</small>
      <div className="validation-actions">
        <button className="secondary compact" onClick={onValidate}>Validate now</button>
        <button className="secondary compact" onClick={onScreenShare}>Use screen share</button>
      </div>
      {observation && (
        <>
          <p>{observation.summary}</p>
          <div className="preview-grid">
            <Metric label="Confidence" value={validation ? `${Math.round(validation.confidence * 100)}%` : `${Math.round(observation.confidence * 100)}%`} />
            <Metric label="Frame" value={observation.usedFrame ? "used" : "not used"} />
            <Metric label="Model" value={`${observation.latencyMs}ms`} />
          </div>
          {validation?.evidence?.length ? (
            <div className="evidence-list">
              {validation.evidence.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function findPlayPlayer(league: FantasyLeagueState | undefined, play?: SportsPlay): (FantasyPlayer & { ownerName?: string }) | undefined {
  if (!league || !play?.playerIds.length) return undefined;
  const players = league.matchups.flatMap((matchup) =>
    matchup.rosters.flatMap((roster) =>
      [...roster.starters, ...roster.bench].map((player) => ({ ...player, ownerName: roster.ownerName }))
    )
  );
  return players.find((player) => play.playerIds.includes(player.id));
}

function findSpotlightPlayer(league: FantasyLeagueState | undefined, title: string): (FantasyPlayer & { ownerName?: string }) | undefined {
  if (!league) return undefined;
  const normalizedTitle = title.toLowerCase();
  return league.matchups
    .flatMap((matchup) =>
      matchup.rosters.flatMap((roster) =>
        [...roster.starters, ...roster.bench].map((player) => ({ ...player, ownerName: roster.ownerName }))
      )
    )
    .find((player) => normalizedTitle.includes(player.name.toLowerCase()));
}

function formatLiveMomentHeadline(headline: string) {
  const clean = headline.replace(/\s+/g, " ").trim();
  const playerLead = clean.match(/^([A-Z][A-Za-z'.-]+)\s+(.+)$/);
  if (!playerLead) return clean;
  const [, lastName, rest] = playerLead;
  const compactRest = rest
    .replace(/\s+for a chunk gain$/i, "")
    .replace(/\s+for a short touchdown$/i, "")
    .replace(/\s+at the goal line$/i, "")
    .replace(/\s+before halftime$/i, "")
    .replace(/\s+with\s+.+$/i, "")
    .replace(/\s+after\s+.+$/i, "");
  if (compactRest.length <= 34) return `${lastName}. ${sentenceCase(compactRest)}.`;
  const firstBeat = compactRest.split(/\s+(?:for|on|to|and)\s+/i)[0];
  return firstBeat && firstBeat.length <= 34 ? `${lastName}. ${sentenceCase(firstBeat)}.` : clean;
}

function formatLiveMomentDescription(description: string) {
  const clean = description.replace(/\s+/g, " ").replace(/\*\*/g, "").trim();
  return clean.length > 156 ? `${clean.slice(0, 153).trim()}...` : clean;
}

function sentenceCase(text: string) {
  if (!text) return text;
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

function ScoreRow({ roster, mediaIndex }: { roster: { ownerName: string; teamName: string; team?: string; points: number }; mediaIndex: MediaLookupIndex }) {
  return (
    <div className="score-row">
      <MediaAvatar asset={resolveTeamMedia(mediaIndex, roster.team)} label={roster.teamName} />
      <div>
        <strong>{roster.ownerName}</strong>
        <span>{roster.teamName}</span>
      </div>
      <b>{roster.points.toFixed(1)}</b>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ImpactRow({ impact, mediaIndex }: { impact: FantasyImpact; mediaIndex: MediaLookupIndex }) {
  const asset = resolvePlayerMedia(mediaIndex, { name: impact.playerName });
  return (
    <div className="impact-row">
      <MediaAvatar asset={asset} label={impact.playerName} />
      <div>
        <strong>{impact.playerName}</strong>
        <span>{impact.ownerName}</span>
      </div>
      <b>{impact.pointsDelta > 0 ? "+" : ""}{impact.pointsDelta}</b>
    </div>
  );
}

function PlayRow({ play, game, mediaIndex }: { play: SportsPlay; game?: SportsGameState; mediaIndex: MediaLookupIndex }) {
  const logoUrl = play.team === game?.awayTeam
    ? game?.awayMeta?.logo
    : play.team === game?.homeTeam
      ? game?.homeMeta?.logo
      : undefined;
  return (
    <div className="play-row">
      <MediaAvatar src={logoUrl} asset={resolveTeamMedia(mediaIndex, play.team)} label={play.team} size="sm" />
      <div>
        <small>{play.quarter} {play.clock}</small>
        <strong>{play.headline}</strong>
        <span>{play.description}</span>
      </div>
    </div>
  );
}

function MediaAvatar({ asset, src, label, size = "md" }: { asset?: CachedMediaAsset; src?: string; label: string; size?: "sm" | "md" }) {
  const [failed, setFailed] = useState(false);
  const resolved = failed ? undefined : (src ?? mediaAssetUrl(asset));
  const initials = initialsForUi(label);

  useEffect(() => {
    setFailed(false);
  }, [asset?.id, src]);

  return (
    <span className="media-avatar" data-size={size} title={asset ? `${asset.label} (${asset.source})` : label}>
      {resolved ? <img src={resolved} alt="" onError={() => setFailed(true)} /> : <span>{initials}</span>}
    </span>
  );
}

async function playBase64Audio(
  base64Audio: string,
  mimeType: string,
  options: {
    audioContext?: AudioContext;
    isCancelled: () => boolean;
    onAudioStart: (audio: HTMLAudioElement) => void;
    onAudioEnd: (audio: HTMLAudioElement) => void;
    onAudioLevel: (levels: number[]) => void;
  }
) {
  if (options.isCancelled()) return;
  const bytes = Uint8Array.from(atob(base64Audio), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const audio = new Audio(url);
  let settled = false;
  let animationFrame: number | undefined;
  let analyserNode: AnalyserNode | undefined;
  let sourceNode: MediaElementAudioSourceNode | undefined;
  const finish = (resolve: () => void) => {
    if (settled) return;
    settled = true;
    if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
    options.onAudioEnd(audio);
    resolve();
  };
  try {
    // Only attach the analyser if the caller provided a running AudioContext
    // (created during a user gesture in startLivecast). Connecting an audio
    // element to a suspended context silences playback in modern browsers.
    if (options.audioContext && options.audioContext.state !== "closed") {
      try {
        if (options.audioContext.state === "suspended") {
          await options.audioContext.resume().catch(() => undefined);
        }
        if (options.audioContext.state === "running") {
          sourceNode = options.audioContext.createMediaElementSource(audio);
          analyserNode = options.audioContext.createAnalyser();
          analyserNode.fftSize = 128;
          sourceNode.connect(analyserNode);
          analyserNode.connect(options.audioContext.destination);
          const frequencyData = new Uint8Array(analyserNode.frequencyBinCount);
          const sampleAudio = () => {
            if (settled || options.isCancelled() || !analyserNode) return;
            analyserNode.getByteFrequencyData(frequencyData);
            options.onAudioLevel(toWaveformLevels(frequencyData, WAVEFORM_BARS.length));
            animationFrame = window.requestAnimationFrame(sampleAudio);
          };
          animationFrame = window.requestAnimationFrame(sampleAudio);
        }
      } catch {
        // If wiring the analyser fails (already connected, etc.), fall back
        // to plain HTMLAudio playback so audio still reaches the speakers.
        sourceNode = undefined;
        analyserNode = undefined;
      }
    }
    options.onAudioStart(audio);
    try {
      await audio.play();
    } catch (error) {
      // Most common cause: browser autoplay policy blocked the play
      // because the AudioContext wasn't unlocked by a user gesture.
      // Log so we can tell autoplay-block apart from "audio decoded
      // and played silently for some other reason."
      console.warn("[huddle.tts] audio.play() rejected", error instanceof Error ? error.message : error);
      finish(() => undefined);
      return;
    }
    await new Promise<void>((resolve) => {
      audio.addEventListener("ended", () => finish(resolve), { once: true });
      audio.addEventListener("error", (event) => {
        console.warn("[huddle.tts] audio element error", (event as Event & { message?: string }).message ?? "(no detail)");
        finish(resolve);
      }, { once: true });
      audio.addEventListener("pause", () => finish(resolve), { once: true });
    });
  } finally {
    if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
    try { sourceNode?.disconnect(); } catch { /* noop */ }
    try { analyserNode?.disconnect(); } catch { /* noop */ }
    options.onAudioEnd(audio);
    URL.revokeObjectURL(url);
  }
}

function toWaveformLevels(frequencyData: Uint8Array, barCount: number) {
  const bucketSize = Math.max(1, Math.floor(frequencyData.length / barCount));
  return Array.from({ length: barCount }, (_, index) => {
    const start = index * bucketSize;
    const end = Math.min(frequencyData.length, start + bucketSize);
    let total = 0;
    for (let cursor = start; cursor < end; cursor += 1) total += frequencyData[cursor] ?? 0;
    const average = total / Math.max(1, end - start);
    return Math.max(12, Math.min(96, Math.round(12 + (average / 255) * 84)));
  });
}

function validateLivecastStart(input: { providerMode: "demo" | "sleeper" | "espn"; sleeperLeagueId: string; espnLeagueId: string; videoMode: VideoMode; videoUrl: string }) {
  if (input.providerMode === "sleeper" && !input.sleeperLeagueId.trim()) {
    return "Enter a Sleeper league ID or switch back to demo mode.";
  }
  if (input.providerMode === "espn" && !input.espnLeagueId.trim()) {
    return "Enter an ESPN league ID or switch back to demo mode.";
  }
  if (input.videoMode !== "screen-share" && input.videoUrl.trim()) {
    try {
      new URL(input.videoUrl);
    } catch {
      return "Enter a valid stream/VOD URL, or leave it blank for demo mode.";
    }
  }
  return "";
}

function parseCustomLeague(json?: string): { league?: FantasyLeagueState; error?: string } {
  if (!json?.trim()) return {};
  try {
    const parsed = JSON.parse(json) as FantasyLeagueState;
    if (!parsed.leagueId || !parsed.leagueName || !Array.isArray(parsed.matchups)) {
      return { error: "Custom league JSON needs leagueId, leagueName, and matchups." };
    }
    for (const matchup of parsed.matchups) {
      if (!Array.isArray(matchup.rosters)) {
        return { error: "Each matchup needs a rosters array." };
      }
      for (const roster of matchup.rosters) {
        if (!roster.id || !roster.ownerName || !Array.isArray(roster.starters) || !Array.isArray(roster.bench)) {
          return { error: "Each roster needs id, ownerName, starters, and bench." };
        }
      }
    }
    return {
      league: {
        ...parsed,
        provider: "custom-demo",
        updatedAt: new Date().toISOString()
      }
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Custom league JSON could not be parsed." };
  }
}

function loadPersistedSettings(): PersistedSettings {
  try {
    const raw = window.localStorage.getItem("fantasy-livecast-settings");
    const settings = raw ? (JSON.parse(raw) as PersistedSettings) : {};
    if (settings.videoUrl && /(?:dQw4w9WgXcQ|never-gonna-give-you-up|rick-astley)/i.test(settings.videoUrl)) {
      settings.videoUrl = "";
      settings.videoMode = "stream-url";
    }
    return settings;
  } catch {
    return {};
  }
}

/**
 * Per-device listener UUID for the W8 backend. The server treats it as
 * opaque; the device-side generates it once and reuses across sessions.
 * On environments without a real `crypto.randomUUID` (older Safari) we
 * fall back to a Math.random-based id which is fine for an opaque key.
 */
function getOrCreateListenerId(): string {
  const KEY = "huddle-listener-id";
  try {
    const existing = window.localStorage.getItem(KEY);
    if (existing && /^[A-Za-z0-9_-]{1,128}$/.test(existing)) return existing;
    const fresh = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `lid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    window.localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return `lid-${Date.now().toString(36)}`;
  }
}

/**
 * Merge the user-provided profile into the GroupSettings sent to the
 * server. The hosts read `group.listener` to know who they're talking
 * to; without this merge, the demo "Alex" identity leaks into every
 * show. If the user hasn't claimed a roster yet, we best-effort match
 * by ownerName so a connected league still personalizes correctly.
 */
function normalizeGroupSettings(group?: GroupSettings): GroupSettings {
  if (!group || !Array.isArray(group.friends)) return defaultGroup;
  return {
    listener: group.listener ?? defaultGroup.listener,
    tone: group.tone ?? defaultGroup.tone,
    homeTeamBias: group.homeTeamBias ?? defaultGroup.homeTeamBias,
    friends: group.friends.length ? group.friends : defaultGroup.friends
  };
}

function buildLocalPreview(league: FantasyLeagueState): FantasyImportPreview {
  return {
    ok: true,
    providerMode: "demo",
    league,
    summary: summarizeLeagueForUi(league),
    readiness: [
      { id: "league-load", label: "League loaded", ok: true, detail: `${league.leagueName} loaded locally.` },
      { id: "matchups", label: "Matchups found", ok: league.matchups.length > 0, detail: `${league.matchups.length} matchup(s).` },
      { id: "players", label: "Players normalized", ok: uniquePlayerCount(league) > 0, detail: `${uniquePlayerCount(league)} unique player(s).` }
    ],
    message: "Local league is ready for livecast."
  };
}

function summarizeLeagueForUi(league: FantasyLeagueState): NonNullable<FantasyImportPreview["summary"]> {
  const rosters = league.matchups.flatMap((matchup) => matchup.rosters);
  const players = new Map<string, { proTeam: string }>();
  let starterCount = 0;
  let benchCount = 0;
  let missingRosterNames = 0;
  let missingPlayerTeams = 0;
  for (const roster of rosters) {
    if (!roster.ownerName) missingRosterNames += 1;
    starterCount += roster.starters.length;
    benchCount += roster.bench.length;
    for (const player of [...roster.starters, ...roster.bench]) {
      players.set(player.id, { proTeam: player.proTeam });
      if (!player.proTeam || player.proTeam === "FA") missingPlayerTeams += 1;
    }
  }
  return {
    leagueName: league.leagueName,
    season: league.season,
    week: league.matchups[0]?.week ?? 1,
    rosterCount: rosters.length,
    matchupCount: league.matchups.length,
    playerCount: players.size,
    starterCount,
    benchCount,
    missingRosterNames,
    missingPlayerTeams
  };
}

function missingPlayerMediaCount(league: FantasyLeagueState, mediaIndex: MediaLookupIndex) {
  const players = new Map<string, { id: string; name: string }>();
  for (const matchup of league.matchups) {
    for (const roster of matchup.rosters) {
      for (const player of [...roster.starters, ...roster.bench]) players.set(player.id, player);
    }
  }
  return [...players.values()].filter((player) => !resolvePlayerMedia(mediaIndex, player)).length;
}

function uniquePlayerCount(league: FantasyLeagueState) {
  const ids = new Set<string>();
  for (const matchup of league.matchups) {
    for (const roster of matchup.rosters) {
      for (const player of [...roster.starters, ...roster.bench]) ids.add(player.id);
    }
  }
  return ids.size;
}

function providerLabel(providerMode: "demo" | "sleeper" | "espn") {
  if (providerMode === "espn") return "ESPN Fantasy";
  if (providerMode === "sleeper") return "Sleeper Fantasy";
  return "Demo Fantasy";
}

function sportsGameOptionPlay(option: SportsGameOption): SportsPlay {
  return {
    id: `selected-${option.id}`,
    type: "other",
    excitement: option.status === "live" ? 3 : 1,
    clock: option.detail,
    quarter: option.status === "live" ? "Live" : option.status === "final" ? "Final" : "Pregame",
    possession: option.awayTeam,
    headline: option.shortName,
    description: option.detail,
    playerIds: [],
    team: option.awayTeam,
    score: option.score,
    occurredAt: option.startsAt ?? new Date().toISOString()
  };
}

type ProducerBrief = {
  title: string;
  lines: string[];
};

function buildProducerBrief(input: {
  fantasy?: FantasyLeagueState;
  group: GroupSettings;
  game?: SportsGameState;
  providers: ActiveProviderSummary;
  readinessLevel: string;
  validation?: StreamValidation;
}): ProducerBrief {
  const rosters = input.fantasy?.matchups[0]?.rosters ?? [];
  const leader = rosters
    .map((roster) => ({
      ownerName: roster.ownerName,
      teamName: roster.teamName,
      points: roster.starters.reduce((total, player) => total + player.currentPoints, 0)
    }))
    .sort((a, b) => b.points - a.points)[0];
  const mappedFriends = input.group.friends.filter((friend) => friend.rosterId).map((friend) => friend.name);
  const gameLine = input.game ? `${input.game.awayTeam} at ${input.game.homeTeam} (${input.game.status})` : "No game loaded yet";
  const validationLine = input.validation
    ? input.validation.status === "sports-event"
      ? `Visual context verified: ${input.validation.sport ?? "sports"} at ${Math.round(input.validation.confidence * 100)}%.`
      : `Visual context limited: ${input.validation.status}.`
    : "Visual context not validated yet.";

  return {
    title: input.readinessLevel === "ready" ? "Producer brief: go live with confidence" : "Producer brief: runnable, watch the gaps",
    lines: [
      `${input.fantasy?.leagueName ?? "No league"} | ${gameLine}`,
      leader ? `Current matchup edge: ${leader.ownerName}'s ${leader.teamName} (${leader.points.toFixed(1)} pts).` : "No matchup leader yet.",
      mappedFriends.length ? `Personalized for ${mappedFriends.join(", ")}.` : "Friend-to-roster mapping needs attention.",
      `${input.providers.commentary} + ${input.providers.tts}. ${validationLine}`
    ]
  };
}

async function captureCurrentFrame(input: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoMode: VideoMode;
  videoUrl: string;
  screenStream?: MediaStream;
  youtubeEmbedUrl?: string;
}): Promise<VideoFrameSnapshot> {
  const base = {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    source: input.videoMode,
    width: 0,
    height: 0,
    dataUrl: ""
  };

  if (input.youtubeEmbedUrl) {
    return {
      ...base,
      blockedReason: "YouTube embeds cannot be pixel-sampled by the browser. Use screen share to validate this stream visually."
    };
  }
  if (input.videoMode === "screen-share" && !input.screenStream) {
    return {
      ...base,
      blockedReason: "Start screen share before validating video frames."
    };
  }
  if (!input.videoUrl && input.videoMode !== "screen-share") {
    return {
      ...base,
      blockedReason: "No stream or VOD URL is available for frame capture."
    };
  }

  const video = input.videoRef.current;
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
    return {
      ...base,
      blockedReason: "Video is not ready for frame capture yet."
    };
  }

  try {
    const maxWidth = 512;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas context unavailable.");
    context.drawImage(video, 0, 0, width, height);
    return {
      ...base,
      width,
      height,
      dataUrl: canvas.toDataURL("image/jpeg", 0.62)
    };
  } catch (error) {
    return {
      ...base,
      blockedReason: error instanceof DOMException && error.name === "SecurityError"
        ? "The browser blocked frame capture for this cross-origin media. Use screen share or a CORS-enabled video URL."
        : error instanceof Error
          ? error.message
          : "Frame capture failed."
    };
  }
}

function validationLabel(validation: StreamValidation) {
  if (validation.status === "sports-event") return `${validation.sport ?? "Sports"} event verified`;
  if (validation.status === "not-sports") return "Not a sporting event";
  if (validation.status === "uncertain") return "Sports validation uncertain";
  return "Stream validation unavailable";
}

function savePersistedSettings(settings: PersistedSettings) {
  try {
    window.localStorage.setItem("fantasy-livecast-settings", JSON.stringify(settings));
  } catch {
    // localStorage can be disabled; the app should keep running without persistence.
  }
}

function rosterPrimaryTeam(roster: FantasyRoster, group: GroupSettings): string | undefined {
  const friendTeam = group.friends.find((friend) => friend.rosterId === roster.id)?.favoriteTeam;
  if (friendTeam) return friendTeam;
  const startersByTeam = roster.starters.reduce<Record<string, number>>((counts, player) => {
    if (!player.proTeam || player.proTeam === "FA") return counts;
    counts[player.proTeam] = (counts[player.proTeam] ?? 0) + 1;
    return counts;
  }, {});
  return Object.entries(startersByTeam).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function cacheCount(manifest: MediaCacheManifest, status: string) {
  return manifest.counts?.[status] ?? manifest.assets.filter((asset) => asset.status === status).length;
}

function initialsForUi(label: string): string {
  const words = label
    .replace(/['.]/g, "")
    .split(/\s+|&|-|_/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

function labelize(value: string) {
  if (value === "tts") return "TTS";
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

function initialVideoNotice(videoUrl?: string) {
  if (!videoUrl) return "Demo mode can run without video.";
  return isYouTubeUrl(videoUrl) ? "YouTube preview enabled. Playback depends on the video allowing embeds." : "Using a user-provided video source. Keep it licensed or otherwise permitted.";
}

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { message?: string }> {
  state: { message?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : "The control room could not render." };
  }

  render() {
    if (this.state.message) {
      return (
        <main className="app-shell">
          <section className="render-error">
            <h1>Control room render failed</h1>
            <p>{this.state.message}</p>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

export { App, AppErrorBoundary };
