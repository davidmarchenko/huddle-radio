import type {
  FantasyPlayer,
  MarketSnapshot,
  MentionCue,
  SportsGameState,
  TeamMeta,
  WordTiming
} from "../shared/contracts";

/**
 * Extract audio-synced entity mentions from a single TTS turn.
 *
 * Inputs:
 *   - `wordTimings`: the per-word timing array from the TTS provider
 *     (Inworld today; others later)
 *   - `lineIndex`: which line of the multi-turn commentary this is,
 *     stamped onto every cue so the client can route them to the right
 *     transcript block
 *   - entity sources: listener roster, current game's team meta,
 *     relevant markets, and the listener's display name
 *
 * The matcher is intentionally lightweight — substring + word-boundary
 * checks against the joined text. We avoid a heavy NER model because
 * the entity universe is small (≤20 players, 2 teams, 2-3 market
 * sources, 1 listener) and known up-front. False positives are gated by:
 *   - Word-boundary matching for short tokens (3-4 chars) so "Cam" the
 *     host doesn't fire as a player named "Cam"
 *   - Host names ("Maya", "Theo", "Cam") are an explicit blocklist
 *   - One cue per (entity, line) — repeated mentions in the same turn
 *     fire ONCE, on the first hit. Avoids spammy chip-storms.
 *
 * Returns cues sorted by `startMs` so the client can iterate them in
 * playback order.
 */
export function extractMentionCues(input: {
  text: string;
  wordTimings: WordTiming[];
  lineIndex: number;
  starters?: FantasyPlayer[];
  game?: SportsGameState;
  markets?: MarketSnapshot[];
  listenerName?: string;
  playerImageByName?: Map<string, string>;
}): MentionCue[] {
  if (input.wordTimings.length === 0) return [];

  // Build the token index — we map each (lowercase) word in
  // wordTimings to its position so a substring match against the full
  // text can be located in the timing array. Punctuation and
  // whitespace tokens are skipped — they have no semantic content.
  const tokens = input.wordTimings.map((w, idx) => ({ idx, lower: w.text.toLowerCase().trim() }));
  const wordTokens = tokens.filter((t) => /\w/.test(t.lower));

  const cues: MentionCue[] = [];
  const fired = new Set<string>(); // dedupe within this turn

  const fireCue = (cue: MentionCue) => {
    const key = `${cue.entityType}:${cue.entityId}`;
    if (fired.has(key)) return;
    fired.add(key);
    cues.push(cue);
  };

  const startMsForToken = (tokenIdx: number): number | undefined => {
    return input.wordTimings[tokenIdx]?.startMs;
  };

  // Find the first index in wordTokens where a consecutive sequence
  // matches `phrase` (case-insensitive, word-by-word). Returns the
  // token index in the FULL wordTimings array (so we can grab
  // startMs), or -1 if no match.
  const findPhraseStart = (phrase: string): number => {
    const needleParts = phrase
      .toLowerCase()
      .split(/\s+/)
      .map((p) => p.replace(/[^\w'-]/g, ""))
      .filter((p) => p.length > 0);
    if (needleParts.length === 0) return -1;
    for (let i = 0; i <= wordTokens.length - needleParts.length; i += 1) {
      let ok = true;
      for (let j = 0; j < needleParts.length; j += 1) {
        const tokenWord = wordTokens[i + j].lower.replace(/[^\w'-]/g, "");
        if (tokenWord !== needleParts[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return wordTokens[i].idx;
    }
    return -1;
  };

  // --- Players (listener's starters) -----------------------------------
  const HOST_NAMES = new Set(["maya", "theo", "cam"]);
  for (const player of input.starters ?? []) {
    if (HOST_NAMES.has(player.name.toLowerCase())) continue;
    // Try the full name first, then last name only — hosts often drop
    // first names ("Mahomes connects").
    const fullName = player.name;
    const parts = fullName.split(/\s+/).filter(Boolean);
    const lastName = parts.length > 1 ? parts[parts.length - 1] : undefined;
    const candidates = [fullName, lastName].filter((v): v is string => typeof v === "string" && v.length > 2);
    for (const candidate of candidates) {
      const idx = findPhraseStart(candidate);
      if (idx < 0) continue;
      const startMs = startMsForToken(idx);
      if (startMs == null) continue;
      fireCue({
        id: `${input.lineIndex}-player-${player.id}`,
        lineIndex: input.lineIndex,
        startMs,
        entityType: "player",
        entityId: player.id,
        label: player.name,
        detail: `${player.position} · ${player.proTeam}`,
        imageUrl: input.playerImageByName?.get(player.name.toLowerCase())
      });
      break; // one cue per player per turn
    }
  }

  // --- Teams (current game) --------------------------------------------
  const teamSlots: Array<{ side: "home" | "away"; abbr: string; meta?: TeamMeta }> = [];
  if (input.game) {
    teamSlots.push({ side: "away", abbr: input.game.awayTeam, meta: input.game.awayMeta });
    teamSlots.push({ side: "home", abbr: input.game.homeTeam, meta: input.game.homeMeta });
  }
  for (const slot of teamSlots) {
    const labels = [slot.meta?.shortName, slot.meta?.displayName, slot.abbr]
      .filter((v): v is string => typeof v === "string" && v.length > 1);
    for (const label of labels) {
      // Skip 2-letter abbreviations as phrase hits — too noisy
      // ("LA" in "Las Vegas"). Need 3+ characters at the token level.
      if (label.length < 3) continue;
      const idx = findPhraseStart(label);
      if (idx < 0) continue;
      const startMs = startMsForToken(idx);
      if (startMs == null) continue;
      fireCue({
        id: `${input.lineIndex}-team-${slot.abbr}`,
        lineIndex: input.lineIndex,
        startMs,
        entityType: "team",
        entityId: slot.abbr,
        label: slot.meta?.shortName ?? slot.meta?.displayName ?? slot.abbr,
        detail: slot.side === "home" ? "Home" : "Away",
        imageUrl: slot.meta?.logo,
        accentColor: slot.meta?.color
      });
      break;
    }
  }

  // --- Market sources --------------------------------------------------
  const marketSources: Array<{ id: "polymarket" | "kalshi"; label: string }> = [
    { id: "polymarket", label: "Polymarket" },
    { id: "kalshi", label: "Kalshi" }
  ];
  for (const source of marketSources) {
    const idx = findPhraseStart(source.label);
    if (idx < 0) continue;
    const startMs = startMsForToken(idx);
    if (startMs == null) continue;
    // Pick the most-relevant market from this source for the detail
    // line (highest absolute swing). Hosts who say "Polymarket has
    // them at 64 cents" don't always name the market — surface the
    // most-newsworthy one as context.
    const fromSource = (input.markets ?? []).filter((m) => m.source === source.id);
    const top = fromSource.sort((a, b) => Math.abs(b.recentDeltaCents ?? 0) - Math.abs(a.recentDeltaCents ?? 0))[0];
    fireCue({
      id: `${input.lineIndex}-market-${source.id}`,
      lineIndex: input.lineIndex,
      startMs,
      entityType: "market-source",
      entityId: source.id,
      label: source.label,
      detail: top ? `${top.outcomeLabel} ${top.yesPriceCents}¢` : undefined
    });
  }

  // --- Listener stake --------------------------------------------------
  if (input.listenerName && input.listenerName.length > 2) {
    const idx = findPhraseStart(input.listenerName);
    if (idx >= 0) {
      const startMs = startMsForToken(idx);
      if (startMs != null) {
        fireCue({
          id: `${input.lineIndex}-listener`,
          lineIndex: input.lineIndex,
          startMs,
          entityType: "listener-stake",
          entityId: "self",
          label: input.listenerName,
          detail: "You're up"
        });
      }
    }
  }

  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}
