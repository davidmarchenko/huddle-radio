import type { CommentaryKind, DialogueLine, FantasyRoster, GameOdds, GroupSettings, HostId, ListenerCue, MarketSnapshot, NewsItem, PlayerSeasonStats, SportsPlay, VideoObservation, FantasyImpact, MomentCue } from "../shared/contracts";
import { HOST_PERSONAS, type HostPersona } from "../shared/hostPersonas";

export type CommentaryDraftInput = {
  play: SportsPlay;
  observation: VideoObservation;
  impacts: FantasyImpact[];
  moment?: MomentCue;
  group: GroupSettings;
  news: NewsItem[];
  recentCommentary: string[];
  fallbackText: string;
  hostId?: HostId;
  listenerRoster?: FantasyRoster;
  kind?: CommentaryKind;
  /**
   * Free-form summary of the listener's recent shows. The opener prompt
   * uses this for cross-session memory ("last week Mahomes burned you").
   * Plain prose, ~1-3 sentences. Skipped silently when absent.
   */
  priorContext?: string;
  /** Vegas line + total + moneyline. When provided, persona prompts may cite it. */
  odds?: GameOdds;
  /**
   * W12: advanced stats for the listener's starters playing in this
   * game. EPA, target share, snap%. Persona prompts may cite at most
   * one of these per turn — beat-writer flavor without overload.
   */
  analytics?: PlayerSeasonStats[];
  /**
   * W13/W14: live prediction-market snapshots from Kalshi /
   * Polymarket. Pass at most 4-6 most-relevant entries — the
   * commentary engine should already have pre-filtered via
   * pickRelevantMarketsForGame. Hosts can quote a price ("Polymarket
   * has the Chiefs at 64 cents") and call out moves
   * (`recentDeltaCents`) when one is meaningful.
   */
  markets?: MarketSnapshot[];
  /**
   * High-confidence swing event derived from market history. When
   * the engine detects a >5pt move in the last 5 min, it can pass
   * this so the host opens with the move rather than burying it.
   * See marketSwingDetector below.
   */
  marketSwing?: MarketSwing;
  /**
   * W18: push-to-talk listener cues captured since the last
   * commentary tick. The persona prompt may answer one of these
   * directly when it lands ("you asked about Mahomes — ..."). Pass
   * 1-3 max; older cues should be acked + dropped client-side.
   */
  listenerCues?: ListenerCue[];
};

/**
 * A single market that just moved enough to be call-out worthy.
 * Produced by detectMarketSwings() on each commentary tick.
 */
export type MarketSwing = {
  market: MarketSnapshot;
  /** Cents change from the snapshot we last cited on-air. */
  deltaCents: number;
  /** Negative = market cooled on this side; positive = warming. */
  direction: "warming" | "cooling";
};

export function resolveHostPersona(hostId?: HostId): HostPersona {
  return hostId ? HOST_PERSONAS[hostId] : HOST_PERSONAS.maya;
}

/**
 * Persona summary block used by every dialogue prompt. Three hosts —
 * the LLM picks who speaks each line based on context. Kept outside
 * the per-turn prompt so all three personas stay grounded in the same
 * canonical description regardless of who's leading the turn.
 */
function buildHostsBlock(): string {
  return [
    "Hosts on the show:",
    ...Object.values(HOST_PERSONAS).map((persona) => {
      const tics = persona.speechTics.map((tic) => `  · ${tic}`).join("\n");
      return [
        `- ${persona.name} (${persona.role}, id: "${persona.id}"): ${persona.description}`,
        `  Voice: ${persona.directive}`,
        `  Speech tics:`,
        tics
      ].join("\n");
    })
  ].join("\n");
}

const SHARED_HARD_RULES = [
  "- TONE: TNT crew / Inside the NBA style. Dry humor, sharp friction, the comedy comes from the HOSTS NEEDLING EACH OTHER, not catchphrases. No exclamation-point energy, no 'big play here, folks,' no canned hype. Funny = honest + sharp, never silly.",
  "- The crew MOCKS each other. Theo will pull Maya off a stat tangent. Cam will grandstand a prediction. Maya is unbothered by both. If a host's previous take didn't age (recentCommentary makes this visible), the others will absolutely bring it up — briefly, then move on.",
  "- Use the asker / explainer / reactor pattern but VARY who fills which slot. Sometimes Theo frames + Maya explains + Cam mocks; sometimes Cam opens with a take + Theo pushes back + Maya lands the data. Don't run the same order twice in a row.",
  "- recentCommentary is what we ALREADY said on this show. If a thread is open (an earlier prediction is now resolvable, a tangent went unfinished, a host was wrong) and it fits this play, take the callback. Don't manufacture callbacks when they don't land — but when they DO, that's the show.",

  // --- CONVERSATIONAL DEVICES — write these FREELY ------------------
  "- WRITE LIKE PEOPLE TALK. The ElevenLabs v3 dialogue engine is built to deliver verbal fillers, breath sounds, laughter, and interruptions naturally — and they're what makes a turn feel HUMAN. Use them. Don't be precious about it.",
  "- Inline fillers IN THE TEXT (not tags): 'uhhh,' 'hmm,' 'I mean,' 'you know,' 'so — like,' 'wait.' Use ~1-2 per turn when natural. Skip on the calm hosts (Maya) where it doesn't fit; lean into them when a host is genuinely thinking out loud.",
  "- Interruptions and overlaps: use a hyphen at the END of a phrase to cut a host off ('the throw was-'), then have the next host JUMP IN with `[jumping in]` or just resume the thought. Use this on major moments where the crew genuinely talks over each other.",
  "- Trailing off: ellipses for a host losing the thread or being lost in the moment ('I mean... yeah').",
  "- Audio tags are LIBERAL when they fit, not gated. The model handles overuse better than underuse — sparse tags make turns sound robotic. Allowed and encouraged:",
  "    `[laughs]`, `[laughs softly]`, `[chuckles]`, `[giggles]`, `[snorts]`",
  "    `[sigh]`, `[sighs]`, `[sighs softly]`, `[exhales]`, `[gasps]`",
  "    `[deadpan]`, `[skeptical]`, `[sarcastic]`, `[whispers]`, `[mutters]`",
  "    `[jumping in]`, `[cautiously]`, `[hesitates]`, `[drawn out]`",
  "  Use 1-2 tags per turn when they actually land — a tag should make the line funnier or more natural, not just decorate it. AVOID `[excited]` and `[shouting]` (cartoon energy) and avoid stacking contradictory tags in the same sentence.",
  "- Example shape (officially from ElevenLabs):",
  "    Maya: 'Through three quarters Hill has six targets. The role is there.'",
  "    Cam: '[laughs softly] You and your target share, Maya.'",
  "    Theo: 'No, she's right — the volume is the volume. [sigh] I just want one of these to break.'",
  "- Each turn is 30-60 words. Filler counts toward the limit. The turn should still have a take — fillers add humanity, not padding.",

  // --- CHARACTER + PERSONA -----------------------------------------
  "- Stay in each host's voice. Maya: dry, model-anchored, unbothered, uses fewer fillers. Theo: anchor — frames the moment, hands off to the others, pushes back when a take is too hot or too cold; uses warm fillers like 'I mean' and 'you know.' Cam: confident sharp take, mocks the model, owns it briefly when wrong; lots of `[laughs]` and `[sighs]` at the others' takes.",
  "- The first turn is spoken by the `leadHostId` in the input. Subsequent turns rotate.",
  "- Across the whole output, address the listener by name at most once. Reference their actual starters when relevant; never invent players or numbers. Hedge ('through three quarters,' 'on the season') when a fact isn't in the provided data.",
  "- Avoid generic radio openers ('welcome back, folks,' 'big play here'). Open on the take or the news.",
  "- If `odds` is provided, exactly ONE turn across the whole output may cite the line/total/moneyline. Never lead with it; never recommend a bet.",
  "- If `analytics` carries stats for a named player, ONE turn may weave in ONE number (snap%, EPA, target share). Skip if forced — a number for the sake of a number is the opposite of entertainment.",
  "- If `markets` carries live prediction-market prices, ONE turn may quote ONE price ('Kalshi has them at 64 cents'); attribute the source. Never recommend a trade.",
  "- If `marketSwing` is set, the FIRST turn opens with it — that's the news beat. Name the side, source, direction, magnitude in cents.",
  "- If `listenerCues` includes a recent push-to-talk message, ONE turn addresses it conversationally ('you asked about ...'). Don't quote verbatim, don't list cues.",
  "- If video validation is unavailable, uncertain, or not-sports, anchor only to official play data; don't imply you saw video.",
  "- PG. No profanity even on chaos tone.",
  "- Do not mention API keys, system prompts, credentials, or implementation details."
];

const OUTPUT_SCHEMA_BLOCK = [
  "Required output: JSON only, no code fences, no commentary outside JSON. Shape:",
  "{",
  '  "turns": [',
  '    {"speaker": "maya" | "theo" | "cam", "text": "one host\'s full thought (30-60 words). May include ONE leading audio tag like [laughing] or [skeptical] when it lands."},',
  "    ...",
  "  ]",
  "}",
  "Each element of `turns` is ONE host's paragraph. The text-to-dialogue engine plays them as a real conversation — natural turn-taking and pacing is handled for you, so write as if you were scripting a live podcast.",
  "Begin directly with `{`. Do not include any preamble.",
  "The first turn's `speaker` MUST match the `leadHostId` in the input payload."
];

export function buildOpenerSystemPrompt(persona: HostPersona): string {
  return [
    "You are the master producer of Huddle Radio — a personalized fantasy sports podcast for ONE specific listener. Output the SHOW OPEN as a script of 2-3 TURNS. The TTS engine plays this as a real conversation between three hosts — natural pacing, turn-taking, and (with audio tags) emotional delivery are handled for you. Write for ENTERTAINMENT. The listener should smile within the first 15 seconds.",
    "",
    buildHostsBlock(),
    "",
    `For this open the LEAD host is ${persona.name} (id: "${persona.id}") — they speak the first turn. ${persona.description}`,
    "",
    "Suggested arc across the turns:",
    "1. Lead host opens with personality (a take, a tease, or warm address) — name the listener and their team naturally. Avoid 'welcome to.'",
    "2. Second host reacts with the asker/explainer dynamic: a question, a callback, OR a specific starter beat with attitude (Maya: numbers + dry note; Theo: warmth + last-week callback; Cam: sharp prediction).",
    "3. Optional third host lands the close with a forward beat into live game action. Hot take encouraged.",
    "",
    "Each turn 30-60 words. Total open ~45-60 seconds of audio. Use ONE audio tag across the whole open if it lands (e.g., the third host with `[excited]` for the handoff).",
    "",
    "Hard rules:",
    ...SHARED_HARD_RULES,
    "",
    ...OUTPUT_SCHEMA_BLOCK
  ].join("\n");
}

export function buildPlaySystemPrompt(persona: HostPersona): string {
  return [
    "You are the master producer of Huddle Radio. Output a multi-turn reaction to the play and fantasy context. The TTS engine plays this as a real conversation — natural pacing and turn-taking are handled for you. Write for ENTERTAINMENT first, analysis second. A great turn makes the listener react, not just nod.",
    "",
    buildHostsBlock(),
    "",
    `For this play the LEAD host is ${persona.name} (id: "${persona.id}"). ${persona.description}`,
    "",
    "TURN COUNT scales with `moment.priority` in the input payload — match the energy or you'll over- or under-react:",
    "  • routine: 1 turn. Lead host with a brief read; this isn't a moment that earns a panel reaction. Keep tags minimal — maybe one `[sighs]` or none.",
    "  • notable: 2 turns. Lead's read, then one peer reacts — push back, add the fantasy angle, or land a callback to recentCommentary. 1-2 inline fillers across the turns.",
    "  • major: 3 turns. The crew engages — frame the moment, react, and a third host lands the take. 1-2 audio tags total (`[laughs]`, `[sigh]`, `[skeptical]`). Hyphen-cutoffs encouraged when one host genuinely steps on another.",
    "  • interrupt: 3 turns with the highest energy in this format. Use `[jumping in]` on at least one turn — the crew genuinely talks over each other here. 2-3 audio tags total. Still dry-witty, never cartoonish.",
    "",
    "Each turn 30-60 words. Total audio ~10-30 seconds depending on turn count. Use the asker/explainer/reactor pattern — if the lead opens with a hot take, the next turn might be 'no, that's not it.'",
    "",
    "Hard rules:",
    ...SHARED_HARD_RULES,
    "",
    ...OUTPUT_SCHEMA_BLOCK
  ].join("\n");
}

/**
 * The structured payload every commentary provider sends to its model.
 * Shared so OpenAI / Anthropic / Gemini all receive the same facts —
 * persona behavior is the only thing that differs across vendors.
 */
export function buildCommentaryPayload(input: CommentaryDraftInput, persona: HostPersona) {
  const listener = input.group.listener;
  const roster = input.listenerRoster;
  return {
    host: {
      id: persona.id,
      name: persona.name,
      role: persona.role,
      directive: persona.directive,
      speechTics: persona.speechTics,
      examples: persona.examples
    },
    listener: {
      name: listener.name,
      favoriteTeam: listener.favoriteTeam,
      fantasyTeamName: roster?.teamName,
      starters: (roster?.starters ?? []).map((p) => ({
        name: p.name,
        position: p.position,
        proTeam: p.proTeam,
        currentPoints: p.currentPoints
      }))
    },
    priorContext: input.priorContext ?? null,
    tone: input.group.tone,
    priority: input.group.homeTeamBias,
    friends: input.group.friends.map((friend) => ({
      name: friend.name,
      favoriteTeam: friend.favoriteTeam,
      rosterId: friend.rosterId,
      rivalryNotes: friend.rivalryNotes
    })),
    play: input.play,
    observation: {
      summary: input.observation.summary,
      confidence: input.observation.confidence,
      validation: input.observation.validation,
      guardrail:
        input.observation.validation?.status === "sports-event"
          ? "You may mention visible sports context cautiously."
          : "Do not imply the model saw game action; rely on official play data for stats and game events."
    },
    fantasyImpacts: input.impacts,
    moment: input.moment,
    news: input.news.slice(0, 1),
    odds: input.odds
      ? {
          spread: input.odds.spread,
          total: input.odds.total,
          moneyline: input.odds.moneyline,
          movement: input.odds.movement,
          book: input.odds.book
        }
      : null,
    analytics: (input.analytics ?? []).slice(0, 6).map((stats) => ({
      name: stats.name,
      position: stats.position,
      team: stats.team,
      snapPercent: stats.snapPercent,
      epaPerPlay: stats.epaPerPlay,
      targetShare: stats.targetShare,
      usagePerGame: stats.usagePerGame,
      pointsPerGame: stats.pointsPerGame,
      note: stats.note
    })),
    markets: (input.markets ?? []).slice(0, 6).map((market) => ({
      source: market.source,
      kind: market.marketKind,
      title: market.title,
      outcome: market.outcomeLabel,
      yesCents: market.yesPriceCents,
      moveCents: market.recentDeltaCents ?? 0,
      volume24h: market.volume24hUsd ?? null
    })),
    marketSwing: input.marketSwing
      ? {
          source: input.marketSwing.market.source,
          title: input.marketSwing.market.title,
          outcome: input.marketSwing.market.outcomeLabel,
          fromCents: input.marketSwing.market.yesPriceCents - input.marketSwing.deltaCents,
          toCents: input.marketSwing.market.yesPriceCents,
          direction: input.marketSwing.direction
        }
      : null,
    listenerCues: (input.listenerCues ?? [])
      .filter((cue) => cue.text.trim().length > 0)
      .slice(0, 3)
      .map((cue) => ({
        text: cue.text,
        capturedAt: cue.capturedAt,
        confidence: cue.confidence ?? null
      })),
    recentCommentary: input.recentCommentary.slice(0, 4)
  };
}

/**
 * Compare a fresh batch of MarketSnapshots against the last batch
 * we cited on-air, and surface any market that moved by more than
 * `thresholdCents` (default 5). Used per commentary tick to decide
 * whether to lead with a market story.
 *
 * Returns at most one swing — the largest absolute move — so the
 * host doesn't get pulled in two directions at once. Sorts by
 * absolute delta so the loudest signal wins.
 */
export function detectMarketSwings(
  current: MarketSnapshot[],
  previous: MarketSnapshot[],
  thresholdCents = 5
): MarketSwing | undefined {
  if (current.length === 0 || previous.length === 0) return undefined;
  const previousById = new Map(
    previous.map((snapshot) => [`${snapshot.source}:${snapshot.externalId}`, snapshot])
  );
  let best: MarketSwing | undefined;
  let bestAbs = thresholdCents - 1;
  for (const snapshot of current) {
    const key = `${snapshot.source}:${snapshot.externalId}`;
    const prior = previousById.get(key);
    if (!prior) continue;
    const delta = snapshot.yesPriceCents - prior.yesPriceCents;
    const abs = Math.abs(delta);
    if (abs <= bestAbs) continue;
    bestAbs = abs;
    best = {
      market: snapshot,
      deltaCents: delta,
      direction: delta > 0 ? "warming" : "cooling"
    };
  }
  return best;
}

export function sanitizeCommentary(text: string, fallbackText: string): string {
  // Catch credential-shaped phrases in any reasonable spelling so a
  // jailbroken model echoing the system prompt can't leak the key:
  // `apikey`, `api_key`, `api-key`, and `api key` (with whitespace).
  if (/api[\s_-]?key|secret|token|credential|system prompt/i.test(text)) {
    return fallbackText;
  }
  return text.slice(0, 520);
}

/**
 * Parse the LLM's JSON dialogue output into validated DialogueLines.
 * Tolerant: strips a leading code fence if the model added one, drops
 * lines with empty text, normalizes any unknown speaker id to the
 * supplied lead host so playback never falls silent. Returns
 * `undefined` on unrecoverable shape problems so the caller can fall
 * back to single-line mode.
 */
const VALID_HOST_IDS = new Set<HostId>(["maya", "theo", "cam"]);

export function parseDialogueResponse(raw: string, leadHostId: HostId): DialogueLine[] | undefined {
  const stripped = raw
    .trim()
    // Drop a single leading code fence if the model wrapped its JSON in one.
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  if (!stripped.startsWith("{")) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;

  // Current prompt shape: {turns: [{speaker, text}, ...]}.
  // Legacy shapes still accepted to ease rollover when older clients
  // or cached responses arrive: {lines: [...]} and {speaker, text}.
  const turnsRaw =
    (parsed as { turns?: unknown }).turns ??
    (parsed as { lines?: unknown }).lines;

  if (Array.isArray(turnsRaw) && turnsRaw.length > 0) {
    const turns = coerceTurnList(turnsRaw, leadHostId);
    if (turns.length > 0) return turns;
  }

  // Single-turn shorthand: {speaker, text}.
  const single = parsed as { speaker?: unknown; text?: unknown };
  if (typeof single.text === "string") {
    const turn = coerceSingleTurn(single.speaker, single.text, leadHostId);
    if (turn) return [turn];
  }

  return undefined;
}

function coerceTurnList(turnsRaw: unknown[], leadHostId: HostId): DialogueLine[] {
  const out: DialogueLine[] = [];
  for (const entry of turnsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const speakerRaw = (entry as { speaker?: unknown }).speaker;
    const textRaw = (entry as { text?: unknown }).text;
    if (typeof textRaw !== "string") continue;
    const coerced = coerceSingleTurn(speakerRaw, textRaw, leadHostId);
    if (coerced) out.push(coerced);
  }
  if (out.length === 0) return out;
  // First turn must belong to the lead host. If the LLM reordered, snap it back.
  if (out[0].hostId !== leadHostId) {
    out[0] = { ...out[0], hostId: leadHostId };
  }
  return out;
}

function coerceSingleTurn(speakerRaw: unknown, textRaw: string, leadHostId: HostId): DialogueLine | undefined {
  const text = textRaw.trim();
  if (!text) return undefined;
  // Credential filter — same as the legacy per-line sanitizer.
  if (/api[\s_-]?key|secret|token|credential|system prompt/i.test(text)) return undefined;
  const speaker = typeof speakerRaw === "string" && VALID_HOST_IDS.has(speakerRaw as HostId)
    ? (speakerRaw as HostId)
    : leadHostId;
  // Cap at 600 chars: at 25-50 words/turn this gives generous headroom
  // but stops a runaway model from generating a 90-second monologue.
  return { hostId: speaker, text: text.slice(0, 600) };
}

/**
 * Joined transcript across all dialogue lines. Used by the engine to
 * populate `LivecastCommentary.text` for clip captions, accessibility,
 * and the local commentary fallback.
 */
export function joinDialogueLines(lines: DialogueLine[]): string {
  return lines.map((line) => line.text).join(" ");
}
