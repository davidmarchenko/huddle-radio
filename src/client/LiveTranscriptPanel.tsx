import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  HostId,
  LivecastCommentary,
  MentionCue,
  WordTiming
} from "../shared/contracts";
import { HUDDLE_HOSTS } from "./huddleViewModel";

const HOSTS_BY_ID = Object.fromEntries(HUDDLE_HOSTS.map((host) => [host.id, host]));

// Audio tag tokens (e.g. `[deadpan]`, `[laughs]`, `[chuckles softly]`)
// are performance cues, not spoken words. Inworld CREATIVE mode
// consumes them during synthesis; if any leak through into
// wordTimings we don't want them painted into the visible transcript.
// Inworld occasionally splits a multi-word tag across multiple tokens
// (`[chuckles` + `softly]`), so we filter at the SEQUENCE level —
// drop any token that sits inside an unclosed `[...]` span. The
// pure-regex check below remains for callers that only have a
// single token in hand.
const AUDIO_TAG_PATTERN = /^\s*\[[a-z_][a-z_\s]*\]\s*$/i;
function isAudioTagToken(text: string): boolean {
  return AUDIO_TAG_PATTERN.test(text);
}

/** Drop every token that's part of an audio-tag span — whether the
 *  whole tag is in one token (`[laughs]`), split across two
 *  (`[chuckles` + `softly]`), or fully tokenized
 *  (`[`, `chuckles`, `softly`, `]`). Tokens with NO bracket and not
 *  inside a span survive. Order-preserving. */
function stripAudioTagSpans(tokens: WordTiming[]): WordTiming[] {
  const out: WordTiming[] = [];
  let inside = false;
  for (const token of tokens) {
    const text = token.text;
    const hasOpen = text.includes("[");
    const hasClose = text.includes("]");
    if (inside) {
      if (hasClose) inside = false;
      continue;
    }
    if (hasOpen) {
      if (!hasClose) inside = true;
      // Drop the open-bracket token whether the tag closes here or
      // continues into the next token.
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * Audio-synced transcript panel that replaces the static news feed
 * during the live phase. For each commentary turn we render:
 *
 *   - the speaker's avatar + name (accent-tinted, pulsing when active)
 *   - the turn text as a sequence of <span> tokens; when this turn is
 *     the *active* one and we have wordTimings, the spoken word lights
 *     up while past words dim and future words fade
 *   - entity mention chips that drop in when the audio crosses their
 *     `startMs` and fade out after a few seconds — player headshots,
 *     market sources with current prices, listener stake markers
 *
 * Past turns stay rendered as static (no karaoke) so the listener can
 * scan back. Without timestamps (other TTS providers) the panel
 * gracefully degrades to a regular live transcript.
 */

const MENTION_CHIP_VISIBLE_MS = 4000;

type LineTimingsMap = Map<string, { wordTimings?: WordTiming[]; mentionCues?: MentionCue[] }>;

type ActivePlayback = {
  commentaryId: string;
  lineIndex: number;
  elapsedMs: number;
} | null;

export function LiveTranscriptPanel({
  commentary,
  lineTimings,
  activePlayback,
  playedLineKeys,
  variant = "feed",
  livePulse = 1
}: {
  commentary: LivecastCommentary[];
  lineTimings: LineTimingsMap;
  activePlayback: ActivePlayback;
  /** Lines whose audio has actually started playing. Lines that
   *  have arrived (lineTimings populated) but haven't been played
   *  yet stay hidden so the listener doesn't read ahead of the
   *  audio. */
  playedLineKeys: Set<string>;
  /** Layout flavor. `feed` is the original vertical-scroll list used
   *  alongside a video. `spotlight` is the wide horizontal layout
   *  used in audio-only mode — one big active caption with a recent
   *  prior turn ghosted above it. */
  variant?: "feed" | "spotlight";
  /** 1.0..1.20 audio-amplitude scale piped into a CSS var so the
   *  active speaker's avatar pulses in time with the spoken audio
   *  rather than running a synthetic waveform. */
  livePulse?: number;
}) {
  // The newest commentary is at index 0 (engine prepends). For a
  // readable feed we render in reverse so the most recent turn is at
  // the BOTTOM and older turns scroll up — same reading direction as
  // a chat or live transcript window.
  const renderOrder = useMemo(() => [...commentary].reverse(), [commentary]);
  // Auto-scroll: when a new turn lands or the active turn changes,
  // scroll the panel so the active line is in view. We anchor on the
  // active turn's element when it exists; otherwise the latest turn.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (variant !== "feed") return;
    const node = scrollRef.current;
    if (!node) return;
    // Defer to next frame so the new turn has mounted before we scroll.
    const raf = window.requestAnimationFrame(() => {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [renderOrder.length, activePlayback?.commentaryId, activePlayback?.lineIndex, variant]);

  if (commentary.length === 0) {
    return (
      <article className="huddle-card live-transcript-card live-transcript-card--empty" data-variant={variant}>
        <span className="eyebrow">
          <span className="icon icon-broadcast" aria-hidden="true" />
          On air
        </span>
        <p className="live-transcript-empty">Hosts are warming up.</p>
      </article>
    );
  }

  if (variant === "spotlight") {
    return (
      <SpotlightTranscript
        commentary={commentary}
        lineTimings={lineTimings}
        activePlayback={activePlayback}
        playedLineKeys={playedLineKeys}
        livePulse={livePulse}
      />
    );
  }

  return (
    <article className="huddle-card live-transcript-card" data-variant={variant}>
      <header className="live-transcript-header">
        <span className="eyebrow">
          <span className="icon icon-broadcast" aria-hidden="true" />
          On air
        </span>
      </header>
      <div className="live-transcript-scroll" ref={scrollRef}>
        {renderOrder.map((turn) => (
          <TranscriptTurn
            key={turn.id}
            turn={turn}
            lineTimings={lineTimings}
            activePlayback={activePlayback}
            playedLineKeys={playedLineKeys}
          />
        ))}
      </div>
    </article>
  );
}

/**
 * Spotlight layout used for audio-only mode. Renders ONE caption at
 * a time — whichever line is currently being spoken — at large size
 * across the full width of its container, with the speaker's avatar
 * to the side scaling on the audio amplitude. The previous line
 * ghosts in above as small dimmed text so listeners can scan back
 * one beat without losing focus on what's happening NOW.
 *
 * Falls back to the most-recently-played line when no line is
 * actively playing (between turns, or just after audio ends), which
 * keeps the panel non-empty during the brief gaps.
 */
function SpotlightTranscript({
  commentary,
  lineTimings,
  activePlayback,
  playedLineKeys,
  livePulse
}: {
  commentary: LivecastCommentary[];
  lineTimings: LineTimingsMap;
  activePlayback: ActivePlayback;
  playedLineKeys: Set<string>;
  livePulse: number;
}) {
  // Flatten all (turn, line) pairs that the listener has actually
  // heard, preserving order. The active line + the one just before
  // it is what we show; older lines fall off but stay in the played
  // set so a quick scroll-back gesture (future) can re-surface them.
  const playedSequence = useMemo(() => {
    const out: Array<{ turn: LivecastCommentary; lineIndex: number; key: string }> = [];
    // commentary is newest-first; reverse so we walk chronologically.
    for (let i = commentary.length - 1; i >= 0; i -= 1) {
      const turn = commentary[i];
      for (let lineIndex = 0; lineIndex < turn.lines.length; lineIndex += 1) {
        const key = `${turn.id}:${lineIndex}`;
        if (playedLineKeys.has(key)) {
          out.push({ turn, lineIndex, key });
        }
      }
    }
    return out;
  }, [commentary, playedLineKeys]);

  // Active line is the canonical "now" if present; otherwise we fall
  // back to the most recently played line so the panel doesn't blank
  // out between turns.
  const activeIndex = useMemo(() => {
    if (!activePlayback) return playedSequence.length - 1;
    return playedSequence.findIndex(
      (entry) => entry.turn.id === activePlayback.commentaryId && entry.lineIndex === activePlayback.lineIndex
    );
  }, [activePlayback, playedSequence]);

  if (activeIndex < 0 || playedSequence.length === 0) {
    return (
      <article className="huddle-card live-transcript-card live-transcript-card--empty" data-variant="spotlight">
        <p className="live-transcript-empty">Hosts are warming up.</p>
      </article>
    );
  }
  const active = playedSequence[activeIndex];
  const prior = activeIndex > 0 ? playedSequence[activeIndex - 1] : undefined;
  const activeLine = active.turn.lines[active.lineIndex];
  const activeHost = activeLine ? HOSTS_BY_ID[activeLine.hostId] : undefined;
  const activeTimings = lineTimings.get(active.key);
  const isActive = activePlayback?.commentaryId === active.turn.id && activePlayback?.lineIndex === active.lineIndex;
  const elapsedMs = isActive ? activePlayback?.elapsedMs ?? 0 : Number.POSITIVE_INFINITY;
  return (
    <article
      className="huddle-card live-transcript-card live-transcript-card--spotlight"
      data-variant="spotlight"
      style={{ ["--live-pulse" as string]: livePulse.toFixed(3) }}
    >
      <div className="spotlight-stage">
        <div className="spotlight-speaker">
          <span
            className="spotlight-avatar"
            data-accent={activeHost?.accent ?? "violet"}
            data-active={isActive ? "true" : "false"}
          >
            {activeHost?.avatar ? (
              <img src={activeHost.avatar} alt="" />
            ) : (
              <span>{(activeHost?.name ?? activeLine?.hostId ?? "?").slice(0, 1).toUpperCase()}</span>
            )}
          </span>
          <strong>{activeHost?.name ?? activeLine?.hostId}</strong>
        </div>
        <div className="spotlight-captions">
          {prior && (
            <PriorCaption turn={prior.turn} lineIndex={prior.lineIndex} />
          )}
          <div className="spotlight-active-line" data-accent={activeHost?.accent ?? "violet"}>
            {activeTimings?.wordTimings && activeTimings.wordTimings.length > 0 ? (
              <KaraokeText wordTimings={activeTimings.wordTimings} elapsedMs={elapsedMs} />
            ) : (
              <span className="live-transcript-word is-current">{activeLine?.text ?? ""}</span>
            )}
            {activeTimings?.mentionCues && activeTimings.mentionCues.length > 0 && (
              <MentionChipRow
                cues={activeTimings.mentionCues}
                elapsedMs={isActive ? elapsedMs : Number.POSITIVE_INFINITY}
                isActive={isActive}
              />
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * Compact captions strip designed for the bottom player bar. One line
 * of karaoke-aligned text + a small speaker avatar tinted to the
 * host's accent. Falls back to the most-recently-played line when no
 * line is actively playing so the strip stays populated between
 * turns. Returns null when nothing has been spoken yet — the player
 * bar's existing status text covers that empty state.
 */
export function PlayerBarCaptions({
  commentary,
  lineTimings,
  activePlayback,
  playedLineKeys,
  livePulse = 1,
  isPaused
}: {
  commentary: LivecastCommentary[];
  lineTimings: LineTimingsMap;
  activePlayback: ActivePlayback;
  playedLineKeys: Set<string>;
  livePulse?: number;
  isPaused: boolean;
}) {
  // Find the active line — or the most recently played line as a
  // fallback so the strip doesn't blank out between turns. If the
  // active turn has fallen out of the commentary cap (e.g. the
  // listener has been paused while new turns streamed in and pushed
  // their line off the array), freeze on the oldest still-known
  // turn so the strip doesn't blank.
  const target = useMemo(() => {
    if (activePlayback) {
      const turn = commentary.find((c) => c.id === activePlayback.commentaryId);
      if (turn && turn.lines[activePlayback.lineIndex]) {
        return {
          turn,
          lineIndex: activePlayback.lineIndex,
          isActive: true,
          elapsedMs: activePlayback.elapsedMs
        };
      }
    }
    // commentary is newest-first; walk forward to find the latest
    // turn whose last line has actually been played.
    for (let i = 0; i < commentary.length; i += 1) {
      const turn = commentary[i];
      for (let lineIndex = turn.lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
        const key = `${turn.id}:${lineIndex}`;
        if (playedLineKeys.has(key)) {
          return { turn, lineIndex, isActive: false, elapsedMs: Number.POSITIVE_INFINITY };
        }
      }
    }
    // Last-resort fallback: nothing in the current commentary array
    // is in playedLineKeys, but the listener was clearly mid-show
    // (commentary is non-empty). Show the oldest available turn's
    // last line so the captions area never blanks during a long
    // pause. Better to show something they may not have played
    // than to flash an empty bar.
    if (commentary.length > 0) {
      const turn = commentary[commentary.length - 1];
      const lineIndex = turn.lines.length - 1;
      if (lineIndex >= 0) {
        return { turn, lineIndex, isActive: false, elapsedMs: Number.POSITIVE_INFINITY };
      }
    }
    return undefined;
  }, [activePlayback, commentary, playedLineKeys]);

  // Hooks must run unconditionally — pull the scroll ref + word-index
  // tracking out before the early-return so a render that finds
  // nothing-played-yet doesn't skip the hooks below it.
  const line = target ? target.turn.lines[target.lineIndex] : undefined;
  const timings = target ? lineTimings.get(`${target.turn.id}:${target.lineIndex}`) : undefined;
  const elapsedMs = target?.elapsedMs ?? 0;

  // Current word index, derived from wordTimings + elapsedMs. Updates
  // only at word boundaries (every 150-400ms) — not on every RAF tick
  // — so the scroll effect downstream doesn't thrash.
  const currentWordIdx = useMemo(() => {
    if (!timings?.wordTimings || timings.wordTimings.length === 0) return -1;
    for (let i = 0; i < timings.wordTimings.length; i += 1) {
      if (elapsedMs < timings.wordTimings[i].endMs) return i;
    }
    return timings.wordTimings.length - 1;
  }, [timings, elapsedMs]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // We animate the inner track's `transform: translateY` rather than
  // scrolling the container. scrollTo({ behavior: "smooth" }) gets
  // cancelled every time a new word fires (every 200-400ms), so the
  // animation never finishes — it just snaps. A CSS transition on
  // the track resolves cleanly each frame and never gets interrupted
  // mid-animation.
  const [trackOffset, setTrackOffset] = useState(0);

  // Reset offset when the active line changes — without this we'd
  // briefly show the END of the previous line for one frame before
  // the new line populates.
  useEffect(() => {
    setTrackOffset(0);
  }, [target?.turn.id, target?.lineIndex]);

  // Smoothly track the active word VERTICALLY, keeping it at the
  // container's center. The track has a leading spacer
  // (.player-captions-lead) sized so the FIRST line lands at center
  // initially without any translation — past that, the active word
  // glides up as audio progresses through the line, with peers
  // above (already spoken) and below (future) softening behind the
  // top/bottom blur overlays.
  useEffect(() => {
    const container = scrollRef.current;
    const track = trackRef.current;
    if (!container || !track || currentWordIdx < 0) return;
    const active = track.querySelector('[data-state="current"]') as HTMLElement | null;
    if (!active) return;
    const desired = active.offsetTop + active.offsetHeight / 2 - container.offsetHeight / 2;
    setTrackOffset(Math.max(0, desired));
  }, [currentWordIdx]);

  // No captions to show yet. Spotify/YouTube at rest don't fill the
  // captions slot with placeholder content — the play button itself is
  // the call to action; piling an avatar + equalizer + redundant
  // "tap play" label on top reads as visual noise. Render nothing
  // here and let the player bar use its idle path (HuddlePlayerBar
  // owns the empty state's caption slot rendering).
  if (!target || !line) return null;
  const host = HOSTS_BY_ID[line.hostId];
  return (
    <div
      className="player-captions"
      data-active={target.isActive ? "true" : "false"}
      data-paused={isPaused ? "true" : "false"}
      style={{ ["--live-pulse" as string]: livePulse.toFixed(3) }}
    >
      <span
        className="player-captions-avatar"
        data-accent={host?.accent ?? "violet"}
        data-active={target.isActive && !isPaused ? "true" : "false"}
        aria-hidden="true"
      >
        {host?.avatar ? (
          <img src={host.avatar} alt="" />
        ) : (
          <span>{(host?.name ?? line.hostId).slice(0, 1).toUpperCase()}</span>
        )}
      </span>
      <div className="player-captions-content" data-accent={host?.accent ?? "violet"}>
        {/* Speaker name carried as an SR-only label — the visible
            speaker identity now lives in the larger avatar to the
            left, matching the Apple-Music-style reference where
            avatar alone identifies who's speaking. */}
        <span className="player-captions-speaker visually-hidden">{host?.name ?? line.hostId}</span>
        {/* Frame holds the scroll container + the two overlays that
            paint the progressive blur at the top and bottom edges.
            The overlays are SIBLINGS of the scroll container (not
            children) so they stay pinned to the visible top/bottom
            instead of scrolling with the karaoke text. */}
        <div className="player-captions-frame">
          <div className="player-captions-scroll" ref={scrollRef}>
            <div
              className="player-captions-track"
              ref={trackRef}
              style={{ transform: `translateY(${-trackOffset}px)` }}
            >
              <span className="player-captions-lead" aria-hidden="true" />
              {timings?.wordTimings && timings.wordTimings.length > 0 ? (
                <KaraokeText wordTimings={timings.wordTimings} elapsedMs={elapsedMs} />
              ) : (
                <span className="live-transcript-word is-current">{line.text}</span>
              )}
              <span className="player-captions-tail" aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Floating mention chips for the player-bar captions. Players, market
 * sources, listener stake markers, and team callouts drop in above
 * the player bar as the audio crosses each cue's `startMs`. They
 * stay bright for ~4s after firing, then settle into a "static"
 * faded state until the line ends; once the next line begins they
 * disappear. Designed to live in the main app shell, not inside
 * huddle-player itself — they float just above the bar so a long
 * chip set doesn't push the captions around.
 */
export function FloatingMentionChips({
  commentary,
  lineTimings,
  activePlayback,
  playedLineKeys
}: {
  commentary: LivecastCommentary[];
  lineTimings: LineTimingsMap;
  activePlayback: ActivePlayback;
  playedLineKeys: Set<string>;
}) {
  // Pick the same target the captions are showing — active line if
  // any, otherwise most recently played line. Keeps chips in sync
  // with the karaoke without re-computing the search.
  const target = useMemo(() => {
    if (activePlayback) {
      const turn = commentary.find((c) => c.id === activePlayback.commentaryId);
      if (turn && turn.lines[activePlayback.lineIndex]) {
        return {
          key: `${turn.id}:${activePlayback.lineIndex}`,
          isActive: true,
          elapsedMs: activePlayback.elapsedMs
        };
      }
    }
    for (let i = 0; i < commentary.length; i += 1) {
      const turn = commentary[i];
      for (let lineIndex = turn.lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
        const key = `${turn.id}:${lineIndex}`;
        if (playedLineKeys.has(key)) {
          return { key, isActive: false, elapsedMs: Number.POSITIVE_INFINITY };
        }
      }
    }
    return undefined;
  }, [activePlayback, commentary, playedLineKeys]);

  if (!target) return null;
  const cues = lineTimings.get(target.key)?.mentionCues ?? [];
  const visibleCues = cues.filter((cue) => target.elapsedMs >= cue.startMs);
  if (visibleCues.length === 0) return null;
  return (
    <div className="floating-mention-chips" aria-live="polite">
      {visibleCues.map((cue) => {
        const isHot = target.isActive && target.elapsedMs - cue.startMs < MENTION_CHIP_VISIBLE_MS;
        return <MentionChip key={cue.id} cue={cue} isHot={isHot} />;
      })}
    </div>
  );
}

function PriorCaption({ turn, lineIndex }: { turn: LivecastCommentary; lineIndex: number }) {
  const line = turn.lines[lineIndex];
  if (!line) return null;
  const host = HOSTS_BY_ID[line.hostId];
  // Strip audio tags from the prior-line preview text — they're
  // performance cues, not words listeners want to scan back over.
  const text = line.text.replace(/\[[a-z_][a-z_\s]*\]/gi, "").replace(/\s+/g, " ").trim();
  return (
    <p className="spotlight-prior-line" data-accent={host?.accent ?? "violet"}>
      <span className="spotlight-prior-speaker">{host?.name ?? line.hostId}</span>
      <span className="spotlight-prior-text">{text}</span>
    </p>
  );
}

function TranscriptTurn({
  turn,
  lineTimings,
  activePlayback,
  playedLineKeys
}: {
  turn: LivecastCommentary;
  lineTimings: LineTimingsMap;
  activePlayback: ActivePlayback;
  playedLineKeys: Set<string>;
}) {
  // Filter lines to only those that have actually started playing
  // (or are currently active). Prevents the panel from rendering
  // queued-but-unplayed lines ahead of the audio — the user should
  // never read a turn before they hear it.
  const visibleLines = turn.lines
    .map((line, lineIndex) => ({ line, lineIndex }))
    .filter(({ lineIndex }) => {
      const key = `${turn.id}:${lineIndex}`;
      const isActive =
        activePlayback?.commentaryId === turn.id && activePlayback?.lineIndex === lineIndex;
      return isActive || playedLineKeys.has(key);
    });
  if (visibleLines.length === 0) return null;
  return (
    <section className="live-transcript-turn" data-commentary-id={turn.id}>
      {visibleLines.map(({ line, lineIndex }) => {
        const key = `${turn.id}:${lineIndex}`;
        const timings = lineTimings.get(key);
        const isActive =
          activePlayback?.commentaryId === turn.id && activePlayback?.lineIndex === lineIndex;
        return (
          <TranscriptLine
            key={key}
            text={line.text}
            hostId={line.hostId}
            wordTimings={timings?.wordTimings}
            mentionCues={timings?.mentionCues}
            isActive={isActive}
            elapsedMs={isActive ? activePlayback?.elapsedMs ?? 0 : undefined}
          />
        );
      })}
      <ProducerSourcesRow producerBeats={turn.producerBeats} arcPosition={turn.arcPosition} />
    </section>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  play: "play",
  market: "markets",
  news: "news",
  enrichment: "fans",
  vision: "vision",
  picks: "picks",
  listener: "listener",
  callback: "callback",
  pregame: "pregame",
  banter: "banter",
  handoff: "handoff"
};

const ARC_LABELS: Record<string, string> = {
  "cold-open": "Cold open",
  build: "Build",
  "mid-show": "Mid show",
  climax: "Climax",
  "act-break": "Act break",
  pivot: "Pivot",
  close: "Close"
};

/** Tiny chip row under each commentary turn — surfaces what signals
 *  the producer drew on (sources) + which act of the show this turn
 *  belongs to. Renders nothing when neither field is present
 *  (legacy raw-input path / opener with no producer). */
function ProducerSourcesRow({
  producerBeats,
  arcPosition
}: {
  producerBeats?: string[];
  arcPosition?: string;
}) {
  const beats = producerBeats ?? [];
  const uniq = Array.from(new Set(beats));
  if (uniq.length === 0 && !arcPosition) return null;
  return (
    <div className="transcript-producer-row" aria-label="Producer signal context">
      {arcPosition ? (
        <span className="transcript-arc-chip" data-arc={arcPosition}>
          {ARC_LABELS[arcPosition] ?? arcPosition}
        </span>
      ) : null}
      {uniq.map((kind) => (
        <span key={kind} className="transcript-source-chip" data-source={kind}>
          {SOURCE_LABELS[kind] ?? kind}
        </span>
      ))}
    </div>
  );
}

function TranscriptLine({
  text,
  hostId,
  wordTimings,
  mentionCues,
  isActive,
  elapsedMs
}: {
  text: string;
  hostId: HostId;
  wordTimings?: WordTiming[];
  mentionCues?: MentionCue[];
  isActive: boolean;
  elapsedMs?: number;
}) {
  const host = HOSTS_BY_ID[hostId];
  return (
    <div
      className="live-transcript-line"
      data-active={isActive ? "true" : "false"}
      data-accent={host?.accent ?? "violet"}
    >
      <div className="live-transcript-speaker">
        <span className="live-transcript-avatar" data-accent={host?.accent ?? "violet"}>
          {host?.avatar ? (
            <img src={host.avatar} alt="" />
          ) : (
            <span>{(host?.name ?? hostId).slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <strong>{host?.name ?? hostId}</strong>
      </div>
      <div className="live-transcript-text">
        {wordTimings && wordTimings.length > 0 ? (
          <KaraokeText
            wordTimings={wordTimings}
            elapsedMs={isActive ? elapsedMs ?? 0 : Number.POSITIVE_INFINITY}
          />
        ) : (
          // No timings (other TTS providers, or chunk hasn't arrived
          // yet) — render the full text without karaoke. Still readable.
          <span className={isActive ? "live-transcript-word is-current" : "live-transcript-word"}>
            {text}
          </span>
        )}
      </div>
      {mentionCues && mentionCues.length > 0 && (
        <MentionChipRow
          cues={mentionCues}
          elapsedMs={isActive ? elapsedMs ?? 0 : Number.POSITIVE_INFINITY}
          isActive={isActive}
        />
      )}
    </div>
  );
}

/**
 * Renders the line's text as a stream of word tokens. Each token
 * carries `data-state="spoken" | "future"` — strictly two states.
 *
 * "Spoken" words (elapsedMs ≥ token.startMs) are painted using
 * background-clip:text with a vertical accent gradient — the text
 * becomes a mask over a colored fill, which is the "gradient behind
 * the text" the reference uses. Future words stay in solid muted
 * grey. There's no per-word fill ramp, no font-weight change, no
 * third in-between state — just a clean flip at each word's
 * startMs, smoothed by a CSS color transition.
 *
 * `auto-scroll` and `current-word` semantics still need a separate
 * "current" marker for the DOM query that drives the vertical
 * scroll. We expose that via `data-current="true"` on whichever
 * word's spoken window encloses elapsedMs — without coupling it to
 * the visual state.
 */
function KaraokeText({
  wordTimings,
  elapsedMs
}: {
  wordTimings: WordTiming[];
  elapsedMs: number;
}) {
  // Filter audio tags (performance cues like `[deadpan]` or
  // `[chuckles softly]`) so they don't render as visible text. We
  // strip whole spans, not just single tokens, since Inworld
  // sometimes splits multi-word tags across multiple word timings.
  const visible = stripAudioTagSpans(wordTimings).filter(
    (token) => !isAudioTagToken(token.text)
  );
  return (
    <span className="live-transcript-karaoke" aria-live="polite">
      {visible.map((token, idx) => {
        // Three discrete states — past/current/future. Visually,
        // past + current are collapsed into one "spoken" treatment
        // by the player-bar CSS (a vertical accent gradient applied
        // via background-clip:text) so there is no mid-word fill
        // ramp. The "current" state is still emitted so the
        // auto-scroll effect can locate the active word.
        const state: "past" | "current" | "future" =
          elapsedMs >= token.endMs
            ? "past"
            : elapsedMs >= token.startMs
              ? "current"
              : "future";
        return (
          <span key={idx} className="live-transcript-word" data-state={state}>
            {token.text}
          </span>
        );
      })}
    </span>
  );
}

/**
 * Mention chips for the active line. Each chip appears when the audio
 * crosses its `startMs` and fades out after MENTION_CHIP_VISIBLE_MS.
 * Past lines (isActive=false) show all chips faded as a record of
 * what was mentioned; the active line drops them in time with the
 * spoken word.
 */
function MentionChipRow({
  cues,
  elapsedMs,
  isActive
}: {
  cues: MentionCue[];
  elapsedMs: number;
  isActive: boolean;
}) {
  // Visibility logic per cue:
  //   - active line + elapsed < startMs            → not yet visible
  //   - active line + startMs ≤ elapsed < startMs+window → bright
  //   - active line + elapsed ≥ startMs+window     → static (fade to muted)
  //   - past line                                  → static (fade to muted)
  const items = cues.map((cue) => {
    const visible = elapsedMs >= cue.startMs;
    const isHot = isActive && elapsedMs - cue.startMs < MENTION_CHIP_VISIBLE_MS;
    return { cue, visible, isHot };
  });
  if (!items.some((i) => i.visible)) return null;
  return (
    <div className="live-transcript-chips">
      {items
        .filter((i) => i.visible)
        .map(({ cue, isHot }) => (
          <MentionChip key={cue.id} cue={cue} isHot={isHot} />
        ))}
    </div>
  );
}

function MentionChip({ cue, isHot }: { cue: MentionCue; isHot: boolean }) {
  const accent = cue.accentColor ? `#${cue.accentColor}` : undefined;
  return (
    <span
      className="mention-chip"
      data-entity-type={cue.entityType}
      data-hot={isHot ? "true" : "false"}
      style={accent ? { borderColor: accent } : undefined}
    >
      {cue.imageUrl ? (
        <span className="mention-chip-thumb" style={accent ? { background: accent } : undefined}>
          <img src={cue.imageUrl} alt="" />
        </span>
      ) : (
        <span className="mention-chip-icon" aria-hidden="true">
          <ChipIcon type={cue.entityType} />
        </span>
      )}
      <span className="mention-chip-body">
        <strong>{cue.label}</strong>
        {cue.detail && <small>{cue.detail}</small>}
      </span>
    </span>
  );
}

function ChipIcon({ type }: { type: MentionCue["entityType"] }) {
  switch (type) {
    case "player":
      return <span className="icon icon-user" />;
    case "team":
      return <span className="icon icon-stadium" />;
    case "market-source":
      return <span className="icon icon-graph-bar" />;
    case "listener-stake":
      return <span className="icon icon-target" />;
    default:
      return <span className="icon icon-bookmark" />;
  }
}

