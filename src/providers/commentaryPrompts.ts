import type { CommentaryKind, DialogueLine, EnrichmentSignal, FantasyRoster, GameOdds, GroupSettings, HostId, ListenerCue, MarketSnapshot, NewsItem, PlayerSeasonStats, SportsPlay, VideoObservation, FantasyImpact, MomentCue } from "../shared/contracts";
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
  /**
   * Listener's locked picks parlay status, summarized for the
   * persona prompt. Plain prose ("Listener parlay: 3/4 hitting.
   * Bubble: Mahomes needs 1 more TD"). When set, ONE turn may
   * reference the parlay state — anchors the show in the listener's
   * actual stake without name-dropping every leg.
   */
  pickContext?: string;
  /**
   * Pre-digested editorial directive from the ProducerAgent. When
   * present, the host LLM uses the producer-driven prompt path: the
   * payload shrinks to {host, listener, directive, showState,
   * recentCommentary} and the system prompt instructs the LLM to
   * follow the directive's beats in order. When absent, the legacy
   * raw-field path runs unchanged (markets/news/picks/enrichment
   * fields all consulted directly).
   *
   * Optional so callers can incrementally migrate; tests for the
   * legacy path keep working without modification.
   */
  directive?: import("./producer/types").ProducerDirective;
  /**
   * Cross-provider color from the EnrichmentAggregator: fan reactions
   * (Reddit, Bluesky), official deep stats, news blurbs, AI grounding.
   * Already deduped, ranked, and trimmed by the aggregator. Persona
   * prompts may quote ONE per turn — and only when it adds context
   * the listener wouldn't get from the official play feed alone.
   */
  enrichmentSignals?: EnrichmentSignal[];
  /**
   * Server-suggested angle for THIS pregame tick. The engine rotates
   * through (matchup-math / odds / listener-stake / news / starter /
   * market-swing / friend-rivalry) on each forced duplicate-play tick
   * so the model lands on a different beat each time instead of
   * recycling the same talking points before kickoff.
   *
   * Absent during live play — once real plays start arriving, the
   * play itself is the anchor.
   */
  pregameAngleHint?: string;
  /**
   * Slate context — set when the show is in discovery-driven slate
   * mode. The opener references it ("eight games tonight, three of
   * your starters live") so the listener immediately understands
   * the show is surveying their slate, not bound to a single game.
   * Absent for single-game shows.
   */
  slateContext?: import("../server/slateRanker").SlateContext;
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
  // --- FRICTION QUOTA — load-bearing -------------------------------
  "- REAL FRICTION QUOTA: when the output has 2+ turns, AT LEAST ONE host must take a position another host visibly DISAGREES with. Not 'Sure, but...' (agreement theater). Not 'Mmhmm.' (mute acknowledgment). An actual counter — 'No, that's the wrong frame,' '[skeptical] you're describing the floor, not the ceiling,' 'That's a great way to lose your week.' The disagreement can be brief; it just needs to land. If you can't find one because the moment is one-sided, the friction can be self-aimed (a host calling out their OWN earlier take that didn't hold). What's banned is three hosts in a row nodding along.",
  "- Use the asker / explainer / reactor pattern but VARY who fills which slot. Sometimes Theo frames + Maya explains + Cam mocks; sometimes Cam opens with a take + Theo pushes back + Maya lands the data. Don't run the same order twice in a row.",
  "- recentCommentary is what we ALREADY said on this show. If a thread is open (an earlier prediction is now resolvable, a tangent went unfinished, a host was wrong) and it fits this play, take the callback. Don't manufacture callbacks when they don't land — but when they DO, that's the show.",
  "- DO NOT REPEAT YOURSELF. If recentCommentary already covered a beat (a stat, a take, a player angle, a matchup observation), that beat is OFF THE TABLE for this turn unless something material has changed. Find a NEW angle: a different player, a different stat lens, a different storyline. Re-stating the same opinion in fresh words still counts as repetition — listeners hear it. If genuinely nothing new is available, write a SHORT reactive turn (15-25 words) rather than padding a recycled take.",
  "- ANCHOR every turn to a specific live signal in the payload — `play.headline`, a `markets` price/swing, an `analytics` number, a `news` headline, a `listenerCues` message, or a moment from `recentCommentary` you're explicitly responding to. Generic 'big slate tonight' filler is banned. The listener should be able to tell WHICH PIECE OF DATA prompted each turn.",
  // --- POSITIVE SHAPES that displace radio-DJ filler ----------------
  //
  // 2026 prompt-engineering research (arXiv 2503.13510, "Pink Elephant
  // Problem" 16x.engineer) shows stacked "DO NOT" rules in long
  // system prompts prime the forbidden tokens and degrade output.
  // Convert each common filler into a SHAPE the model can do
  // instead — show what good looks like, displace the smell.
  "- TURN SHAPE — every turn carries ONE of these payloads or it's not earning its breath:",
  "    a) a SPECIFIC consequence (player + number + downstream effect) — 'Kelce just took your floor from 12 to 17' beats 'this matters for your week'.",
  "    b) a NAMED disagreement with another host (steel-man + reject) — 'Cam, the throw was good; the YAC was lucky' beats 'big play'.",
  "    c) a CALLBACK to recentCommentary that pays off or undoes a prior take — 'two ticks ago you said no first-half TD' beats 'cashing checks'.",
  "    d) a CONCRETE single number with a unit and a meaning — 'six targets through three quarters, that's a role' beats 'putting up points'.",
  "    e) a SHORT REACTION (5-20 words) when the moment doesn't need more — 'Mmhmm.' / 'Yeah, I'm not buying it.' beats padding a recycled take.",
  "  If the turn you're writing doesn't have one of (a)-(e), stop and write a shorter turn instead of reaching for a transition phrase.",
  "- WHEN AGREEING, ADVANCE. 'Right, but here's why it matters for the second half' is allowed. 'Right, exactly, big play' is not — pure affirmation is a missed turn, not a turn.",
  "- TRANSITION PHRASES are a code smell. Phrases like 'this matters,' 'big play,' 'rack points,' 'warm market,' 'first drive matters for fantasy rhythm,' 'a touchdown is a touchdown,' 'getting their footing' signal you don't have the take yet. The fix is never the transition phrase — the fix is writing one of the (a)-(e) shapes above, or writing a shorter turn.",
  "- LISTENER CUE direct questions get DIRECT answers. If `listenerCues` contains a yes/no roster question ('should I start X?', 'should I trade Y while hot?'), exactly ONE turn must give a clear yes/no with one sentence of reasoning anchored to the actual roster/matchup data — not a hedge, not a 'depends on your league.' Hedges are fine on a separate beat; the asked question gets a verdict.",
  "- In PREGAME (play is a `-pre-` placeholder with no real action yet), each tick must cover a DIFFERENT angle from the last one. Rotation order to draw from: matchup math → odds line → listener stake / parlay status → news headline → starter outlook → market swing → friend rivalry. If `pregameAngleHint` is in the payload, lead the first turn on that angle.",

  // --- SPEAK, DON'T TYPE — the single most important rule -----------
  "- THIS IS SPOKEN AUDIO. Every turn must read naturally OUT LOUD. If a sentence looks like a stat sheet, a fantasy app subtitle, or something you'd text — rewrite it. Test: would a real broadcaster say this with their mouth, or only type it with their thumbs?",
  "- TEAM NAMES: never airport-code abbreviations (NO 'MIN at SA', 'LAL vs OKC', 'NYG-DAL'). Say 'Wolves at Spurs', 'Lakers vs OKC' (only when the city itself is the casual call), or 'Minnesota and San Antonio.' On first mention use the nickname; on later mentions either short nickname ('the Wolves') or 'they.'",
  "- PLAYER NAMES: spell them out conversationally. Use last names ('Jokic,' 'Tatum,' 'Edwards') or first names when the room is familiar ('Shai,' 'LeBron'). Avoid initial-only shortcuts ('SGA,' 'KD,' 'CMC,' 'AD') unless a host says the full name first AND it's natural to the persona. NEVER stack a shortcut with a stat ('SGA at 22.5' — bad).",
  "- NUMBERS ARE SPOKEN, NOT WRITTEN. Round to whole numbers in casual talk ('around 28 a night,' 'roughly 22'). Avoid decimal points unless the half matters — a 3.5-point spread or a 50.5 over/under is fine ('three and a half,' 'fifty and a half'); '28.1' is NEVER fine in speech. Drop trailing-decimal-zero entirely.",
  "- ONE NUMBER PER OUTPUT, MAXIMUM. Across all turns combined, cite at most ONE specific number — and only if it earns its place in a take. No stat lists. No 'X at A, Y at B, Z at C' triplets. If you need three numbers to make a point, the take isn't there yet.",
  "- AVOID FANTASY-APP SHORTHAND in spoken text: 'ppg,' 'rpg,' 'apg,' 'snap%,' 'EPA,' 'tgt share' — none of these survive being spoken. Translate: 'snap%' → 'snap rate' or 'how often he's on the field'; 'ppg' → 'a night' or 'a game'; 'EPA' → 'efficiency' or skip entirely.",

  // --- CONVERSATIONAL DEVICES — write these FREELY ------------------
  "- WRITE LIKE PEOPLE TALK. The ElevenLabs v3 dialogue engine is built to deliver verbal fillers, breath sounds, laughter, and interruptions naturally — and they're what makes a turn feel HUMAN. Use them. Don't be precious about it.",
  "- Inline fillers IN THE TEXT (not tags): 'uhhh,' 'hmm,' 'I mean,' 'you know,' 'so — like,' 'wait.' Use ~1-2 per turn when natural. Match the host: Theo / Cam use warm fillers liberally; Maya uses DRY ones — 'sure,' 'right,' 'mmhmm,' 'yeah no' — fewer in count but landed deliberately. Dry doesn't mean fewer beats — it means different beats.",
  "- Interruptions and overlaps: use a hyphen at the END of a phrase to cut a host off ('the throw was-'), then have the next host JUMP IN with `[jumping in]` or just resume the thought. Use this on major moments where the crew genuinely talks over each other.",
  "- Trailing off: ellipses for a host losing the thread or being lost in the moment ('I mean... yeah').",
  "- Audio tags are LIBERAL when they fit, not gated. The model handles overuse better than underuse — sparse tags make turns sound robotic. Allowed and encouraged:",
  "    `[laughs]`, `[laughs softly]`, `[chuckles]`, `[giggles]`, `[snorts]`",
  "    `[sigh]`, `[sighs]`, `[sighs softly]`, `[exhales]`, `[gasps]`",
  "    `[deadpan]`, `[skeptical]`, `[sarcastic]`, `[whispers]`, `[mutters]`",
  "    `[jumping in]`, `[cautiously]`, `[hesitates]`, `[drawn out]`",
  "  Use 1-2 tags per turn when they actually land — a tag should make the line funnier or more natural, not just decorate it. AVOID `[excited]` and `[shouting]` (cartoon energy) and avoid stacking contradictory tags in the same sentence.",
  "- Example shape — sounds like real people talking:",
  "    Maya: 'Through three quarters Hill has six targets. The role is there.'",
  "    Cam: '[laughs softly] You and your target share, Maya.'",
  "    Theo: 'No, she's right — the volume is the volume. [sigh] I just want one of these to break.'",
  "- COUNTER-EXAMPLE — never write turns that sound like this:",
  "    BAD: 'We're pre-tip on MIN-SA, but you've got Jokic at 28.1, SGA at 22.5, Tatum at 18.7 — that's a nice rollercoaster.'",
  "    Why it fails: airport-code matchup ('MIN-SA'), player-initial shortcut ('SGA'), three decimal stats stacked in one breath. Nobody talks like that.",
  "    BETTER: 'Big slate, big names. Jokic, Shai, Tatum — three of your guys all going off in the same window. Pick a couch position, you're gonna need it.'",
  "- Turn length: VARY IT. Real conversation has short beats (5-15 words: a reaction, a one-liner) interleaved with longer beats (30-60 words: a take, an explanation). Aim for at least one short reactive turn whenever you have ≥2 turns in the output. A turn that's all setup with no payoff is a failed turn — cut it shorter.",
  "- Short-turn examples (the kind of beats that make a podcast feel like a podcast):",
  "    Theo: 'Yeah, I'm not buying it.'",
  "    Cam: '[snorts] Maya. You said this last week.'",
  "    Maya: 'Mmhmm.'",
  "    Theo: 'Wait — hold on. Run that back.'",
  "  These would be lifeless in a stat-sheet prompt; they're the actual texture of three people talking. Use them.",

  // --- CHARACTER + PERSONA -----------------------------------------
  "- Stay in each host's voice. The Hosts block at the top of this prompt is the canonical definition — `description`, `directive`, and `speechTics` per host. Don't generalize, don't reinvent: if Maya's tics list says 'Mmhmm' / 'Sure' / 'Yeah, no,' those are her dry beats. If Cam's directive says 'one sharp take per turn,' don't soften it. Treat the persona block as the contract; this rule is the pointer to it.",
  "- The first turn is spoken by the `leadHostId` in the input. Subsequent turns rotate.",
  "- Direct address controls the next speaker. If a host addresses another host BY NAME in a question, callout, or handoff ('Maya, what do you see?' / 'Cam — push back on that' / 'Theo, run it back'), the VERY NEXT turn MUST be from that addressed host. Do not skip them, do not have a third host answer for them. If you don't want to force a specific handoff, don't name a host at the end of the turn — address the room or the listener instead.",
  "- Across the WHOLE output (not per turn — across every turn combined), name the listener AT MOST ONCE. After that first mention, address them as 'you' / 'your team' — never repeat the name. Hearing your own name 3-4 times in a clip is the #1 thing that makes this sound robotic, so default to zero name uses if nothing earns it. Reference their actual starters when relevant; never invent players or numbers. Hedge ('through three quarters,' 'on the season') when a fact isn't in the provided data.",
  "- If `listener.name` is null / empty / missing, the listener has not claimed an identity yet. Address them as 'you,' 'tonight's listener,' or 'the room' — NEVER invent a name like 'Alex,' 'David,' etc. NEVER emit a leading comma or vocative-followed-by-empty pattern like ', welcome' or ', what's up' — start the line with the actual greeting. The demo persona is OFF; treat the listener as anonymous.",
  "- If `friends` is empty, there are no real friends in this league — do NOT invent friend names ('Maya,' 'Devon,' 'Alex' as a friend, etc.). Skip any 'your friend X' beats; the only addressee is the listener themselves. (Maya as a HOST name is fine — that's a real host on the show.)",
  "- Avoid generic radio openers ('welcome back, folks,' 'big play here'). Open on the take or the news.",
  "- If `odds` is provided, exactly ONE turn across the whole output may cite the line/total/moneyline. Never lead with it; never recommend a bet.",
  "- If `analytics` carries stats for a named player, ONE turn may weave in ONE number — and it must obey the spoken-numbers rule above (round to whole numbers, no fantasy-app shorthand, translate 'snap%' → 'snap rate' etc.). Skip if forced — a number for the sake of a number is the opposite of entertainment, and a number that sounds like a spreadsheet is worse.",
  "- If `markets` carries live prediction-market prices, ONE turn may quote ONE price ('Kalshi has them at 64 cents'); attribute the source. Never recommend a trade.",
  "- If `marketSwing` is set, the FIRST turn opens with it — that's the news beat. Name the side, source, direction, magnitude in cents.",
  "- If `listenerCues` includes a recent push-to-talk message, ONE turn addresses it conversationally ('you asked about ...'). Don't quote verbatim, don't list cues.",
  "- If `pickContext` is set, ONE turn may weave in the listener's parlay state — name the bubble player, what they need, and the rooting interest. Don't list every leg. Don't recommend bets. If a leg just hit, lean into it briefly.",
  "- If `enrichmentSignals` carries fan-reaction or extra-color items (source: reddit / bluesky / nba-stats / espn-news / etc.), ONE turn may paraphrase ONE signal as crowd flavor — 'fans on the subreddit are losing it' / 'beat writers calling this Wilson's best quarter of the year.' Paraphrase, don't quote verbatim; never read out a username; treat reddit/bluesky as 'fans' and nba-stats/espn-news as 'the numbers' or 'the beat.' Skip if nothing in the list adds beyond what the play feed already says.",
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

/** Voice-only subset of the shared rules. Used by the producer-driven
 *  prompt path — the data-field rules are dropped because the producer
 *  has already chosen which signals matter, so the host LLM doesn't
 *  need to reason about raw field presence. */
const VOICE_ONLY_RULES = SHARED_HARD_RULES.filter((rule) => {
  // Drop rules that start with "If `<field>` is set/provided" — those
  // are about WHICH raw signal to use, which the producer now decides.
  // The voice / persona / TTS / safety rules stay.
  return !/^- If `(odds|analytics|markets|marketSwing|listenerCues|pickContext|enrichmentSignals)`/.test(rule);
});

/**
 * Directive-driven system prompt. The producer has already chosen the
 * beats; the host LLM converts each beat into the requested number
 * of dialogue turns, in the directive's order, with the directive's
 * lead host. Much shorter than the legacy prompt because the host
 * LLM no longer reasons about field presence — it just delivers.
 */
export function buildDirectivePlaySystemPrompt(persona: HostPersona): string {
  return [
    "You are the master producer of Huddle Radio's host crew. The PRODUCER has chosen what's worth talking about this turn — your job is to deliver it as a multi-host conversation that sounds like real radio.",
    "",
    buildHostsBlock(),
    "",
    `LEAD host for the FIRST beat is ${persona.name} (id: "${persona.id}"). ${persona.description}`,
    "",
    "How to read the `directive`:",
    "- `beats` is an ORDERED list of what to talk about this turn. Convert each beat into the indicated number of dialogue turns; total `turns` = sum of every beat's `turnCount`.",
    "- The FIRST turn of each beat must be spoken by `beat.leadHostId` — this is how listener-nudge handoffs and producer beat assignments thread through. Don't override.",
    "- `beat.topic` is the subject; `beat.angle` is the framing. Don't restate them verbatim — ground the dialogue in them.",
    "- `beat.sourceKind` tells you the signal class behind the beat:",
    "    `play` — react to live action.",
    "    `market` — name the source + cents; never recommend a bet.",
    "    `enrichment` — paraphrase as crowd flavor; never quote a username.",
    "    `vision` — narrate what the broadcast is showing as live observation ('camera just cut to the bench, they're losing it'); the model literally saw it this tick.",
    "    `listener` — address the listener directly once.",
    "    `callback` — name the host you're calling back and pay off their take with what's true now.",
    "    `banter` — no new game action. Lower energy, room conversation, not a take.",
    "    `handoff` — listener just switched games mid-show. Wrap the prior game in one breath, tee up the new matchup. Don't say 'welcome to' — the broadcast didn't restart.",
    "- `showState` is the running editorial summary — for continuity. Don't quote it.",
    "- The directive replaces the old per-field rules: there is NO odds / markets / news / analytics / listenerCues / pickContext / enrichmentSignals fields in the payload. If you want to talk about something, it must come from a beat.",
    "",
    "Arc position (`directive.arcPosition`) — what this point in the show means:",
    "- `cold-open`: first 60s of the show. Set the room temperature; no 'welcome back, folks.'",
    "- `climax`: a major moment just landed. Let it breathe — short reactions over analysis.",
    "- `act-break`: period boundary. Reflect, callback, lower energy.",
    "- `pivot`: game is decided. Counter-program rather than narrate the lopsided score.",
    "- `close`: last minute. Wrap one storyline; foreshadow next listen.",
    "- (otherwise) — default voice rules apply.",
    "",
    "Room state (`directive.rapport`) — what's actually happening between the hosts right now:",
    "- `openThreads`: takes hosts have put down that the room hasn't paid off yet (each: hostId + text).",
    "- `runningBits`: phrases the room has used multiple times.",
    "- `quietHost`: a host who hasn't spoken in 3+ ticks (null when nobody is).",
    "- `tonalEnergy` (0-10): rolling read of room loudness. ≥8 = we've been loud; ≤3 = we've been dry.",
    "- `ticksDelivered`: how many turns into the show we are.",
    "This is the room as it is. Read it; respond to what fits the moment.",
    "",
    "How this room actually sounds — three co-hosts who listen to each other:",
    "",
    "  Theo: 'Wilson with the dagger from the wing — that's her fourth.'",
    "  Maya: '[deadpan] mmhmm. Storm bench is just watching.'",
    "  Cam: 'And I told you. Two turns ago. I told you—'",
    "  Theo: '—you told us, fine.'",
    "",
    "  Cam: 'Lakers are taking this in a walk.'",
    "  Maya: 'Sure, the offense is real. The bench is two-deep though.'",
    "  Theo: 'There it is. There's the Maya answer.'",
    "",
    "  Maya: 'Through three he has six targets. The role is there.'",
    "  Cam: '[laughs softly] You and your target share, Maya.'",
    "  Theo: 'No, she's right — the volume is the volume. [sigh] I just want one of these to break.'",
    "",
    "Notice in those: hosts engage before launching their own takes. Sentences sometimes get finished by the next host. Disagreement is more often agree-then-pivot than flat 'no.' When someone's been quiet, they get pulled in. Open threads come back when they fit. Not every turn does every move — they happen when they fit. Aim for that texture.",
    "",
    "Direct address controls handoff: if you name a host at the END of your turn, the very next turn MUST be from that host. If you don't want to force a handoff, address the room or the listener instead.",
    "",
    "Hard rules (voice / safety only — the producer handles signal selection):",
    ...VOICE_ONLY_RULES,
    "",
    ...OUTPUT_SCHEMA_BLOCK
  ].join("\n");
}

/**
 * Directive-driven payload — much smaller than buildCommentaryPayload.
 * Drops the raw signal fields entirely (markets, news, analytics, etc.)
 * because the producer has already filtered them down to beats.
 */
export function buildDirectivePayload(input: CommentaryDraftInput, persona: HostPersona) {
  const listener = input.group.listener;
  const roster = input.listenerRoster;
  const directive = input.directive!; // caller guarantees this branch
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
      // Normalize empty / whitespace name to null so the prompt
      // rule "if listener.name is empty/missing, address as 'you'"
      // is unambiguous. Passing "" through let the LLM produce a
      // ", welcome" artifact on prod (empty name → `${name}, welcome`
      // pattern leaks the comma even when the model "knows" the name
      // is absent). null forces the model to take the no-name branch.
      name: listener.name?.trim() ? listener.name.trim() : null,
      favoriteTeam: listener.favoriteTeam,
      fantasyTeamName: roster?.teamName,
      starters: (roster?.starters ?? []).map((p) => ({
        name: p.name,
        position: p.position,
        proTeam: p.proTeam,
        currentPoints: p.currentPoints
      }))
    },
    tone: input.group.tone,
    priority: input.group.homeTeamBias,
    friends: input.group.friends.map((friend) => ({
      name: friend.name,
      favoriteTeam: friend.favoriteTeam,
      rosterId: friend.rosterId,
      rivalryNotes: friend.rivalryNotes
    })),
    slate: input.slateContext
      ? {
          totalGames: input.slateContext.totalGames,
          starterGames: input.slateContext.starterGames,
          upcomingHighlights: input.slateContext.upcomingHighlights
        }
      : null,
    directive: {
      beats: directive.beats,
      showState: directive.showState,
      arcPosition: directive.arcPosition ?? null,
      rapport: directive.rapportState
        ? {
            // Keep the host LLM payload minimal — only the fields it
            // actually uses. The full RapportState lives on the
            // engine; this is the slice the LLM should reason over.
            openThreads: directive.rapportState.openThreads.map((t) => ({
              hostId: t.hostId,
              text: t.text,
              acknowledged: t.acknowledged
            })),
            runningBits: directive.rapportState.runningBits.map((b) => ({
              phrase: b.phrase,
              occurrences: b.occurrences
            })),
            quietHost: pickPayloadQuietHost(directive.rapportState),
            tonalEnergy: directive.rapportState.tonal.energy,
            ticksDelivered: directive.rapportState.ticksDelivered
          }
        : null
    },
    recentCommentary: input.recentCommentary.slice(0, 4)
  };
}

function pickPayloadQuietHost(state: NonNullable<ReturnType<typeof structuredClone>> & {
  hostStanding: { maya: { ticksSinceLastSpoke: number }; theo: { ticksSinceLastSpoke: number }; cam: { ticksSinceLastSpoke: number } };
}): string | null {
  const standings = Object.entries(state.hostStanding) as Array<[string, { ticksSinceLastSpoke: number }]>;
  const sorted = [...standings].sort((a, b) => b[1].ticksSinceLastSpoke - a[1].ticksSinceLastSpoke);
  const top = sorted[0];
  return top && top[1].ticksSinceLastSpoke >= 3 ? top[0] : null;
}

/**
 * Directive-driven OPENER prompt. The producer has already chosen
 * the open's beats (frame the listener / pull a starter / hand off)
 * — the host LLM converts each into the requested number of dialogue
 * turns. Reuses the same directive payload as the play path, so the
 * host LLM's reading model is consistent across kinds.
 */
export function buildDirectiveOpenerSystemPrompt(persona: HostPersona): string {
  return [
    "You are the master producer of Huddle Radio's host crew. The PRODUCER has chosen the SHOW OPENER's beats — your job is to deliver them as the very first thing the listener hears. The whole show pivots on whether they smile in the first 15 seconds. Write for ENTERTAINMENT.",
    "",
    buildHostsBlock(),
    "",
    `LEAD host for the FIRST beat is ${persona.name} (id: "${persona.id}"). ${persona.description}`,
    "",
    "How to read the `directive`:",
    "- `beats` is an ORDERED list — convert each beat into the indicated number of dialogue turns; total `turns` = sum of every beat's `turnCount`.",
    "- The FIRST turn of each beat must be spoken by `beat.leadHostId` — don't override.",
    "- `beat.topic` is the subject; `beat.angle` is the framing. Don't restate them verbatim — ground the dialogue in them.",
    "- The directive replaces the old per-field rules: there is NO odds / markets / news / analytics / listenerCues / pickContext fields in the payload. Anchor only on what the directive gives you + the listener block.",
    "",
    "Opener-specific guidance:",
    "- Avoid 'welcome back, folks,' 'welcome to the show,' or any canned radio open. Open on a take, a tease, or a warm but specific address.",
    "- If `slate` is in the payload, the show is in DISCOVERY mode — it's surveying tonight's whole slate, not bound to one game. The lead beat should signal that breadth ('three of your guys live tonight, here's where we're starting') instead of pretending only one game exists. `slate.totalGames` / `slate.starterGames` / `slate.upcomingHighlights` are the editorial inputs. When `slate` is absent, the show is single-game and the opener anchors on the matchup as usual.",
    "- Mention the listener's name AT MOST ONCE across the whole open. After that first mention, address as 'you' / 'your team.' If `listener.name` is empty, never invent a name — address as 'you' / 'tonight's listener.'",
    "- Reference the listener's actual starters (`listener.starters`) when a beat anchors on the lineup. Never invent players or numbers.",
    "- Each turn 30-60 words. Total open ~45-60 seconds of audio. ONE audio tag across the whole open if it lands (e.g., a `[laughs]` or `[deadpan]`).",
    "",
    "How this room actually sounds:",
    "",
    "  Theo: 'Marc — welcome in. Storm Surge tonight, you've got Wilson, Plum, Loyd, all going at the Aces.'",
    "  Maya: '[deadpan] All three. In one game. Stress-test for the couch.'",
    "  Cam: 'Wilson hangs thirty on you tonight. Lock it in.'",
    "",
    "Notice: name lands ONCE, the team and starters get named naturally, the third turn is short and punchy and hands off into live action. That's the texture.",
    "",
    "Direct address controls handoff: if you name a host at the END of your turn, the very next turn MUST be from that host.",
    "",
    "Hard rules (voice / safety only — the producer handles signal selection):",
    ...VOICE_ONLY_RULES,
    "",
    ...OUTPUT_SCHEMA_BLOCK
  ].join("\n");
}

/**
 * Stable version hash of the active commentary-prompt code. SHA-256
 * (first 12 hex chars) over the rendered text of every prompt variant
 * for a canonical persona — opener, play, directive-opener,
 * directive-play. Any edit to a rule, schema block, persona-block
 * builder, or shared-rule list flips the hash; persona data changes
 * don't (we hash with Theo fixed).
 *
 * Eval store joins per-turn scores to this hash so a regression in
 * one prompt variant is attributable to the exact code-version that
 * shipped it — without it, every iteration is "did stayTuned drop
 * because of last week's edit or this morning's?"
 *
 * Computed lazily + memoized; cheap to call from every TurnSummary.
 */
let cachedPromptVersion: string | undefined;
export function getCommentaryPromptVersion(): string {
  if (cachedPromptVersion) return cachedPromptVersion;
  const canonical = resolveHostPersona("theo");
  const rendered = [
    buildOpenerSystemPrompt(canonical),
    buildPlaySystemPrompt(canonical),
    buildDirectiveOpenerSystemPrompt(canonical),
    buildDirectivePlaySystemPrompt(canonical)
  ].join("\n---\n");
  // Lightweight FNV-1a hash — avoids pulling in node:crypto from a
  // shared/* module that also imports into client surfaces. 12 hex
  // chars is enough collision-resistance for a versioning tag (16^12
  // ≈ 2.8 × 10^14 buckets vs. our handful of prompt versions). Format
  // mirrors short Git SHAs so it reads naturally in eval reports.
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = BigInt("0xFFFFFFFFFFFFFFFF");
  for (let i = 0; i < rendered.length; i += 1) {
    hash = (hash ^ BigInt(rendered.charCodeAt(i))) & mask;
    hash = (hash * prime) & mask;
  }
  cachedPromptVersion = hash.toString(16).padStart(16, "0").slice(0, 12);
  return cachedPromptVersion;
}

/**
 * Single decision point for which prompt + payload variant to send.
 * Producer-driven path when the directive is present and non-empty;
 * legacy raw-payload path otherwise. All host LLM providers
 * (Anthropic / OpenAI / Gemini) call this so the choice stays in
 * one place — adding a new variant means editing here, not three
 * call sites.
 */
export function selectCommentaryPrompt(
  input: CommentaryDraftInput,
  persona: HostPersona,
  kind: CommentaryKind
): { system: string; payload: object } {
  if (input.directive && input.directive.beats.length > 0) {
    return {
      system:
        kind === "opener"
          ? buildDirectiveOpenerSystemPrompt(persona)
          : buildDirectivePlaySystemPrompt(persona),
      payload: buildDirectivePayload(input, persona)
    };
  }
  return {
    system: kind === "opener" ? buildOpenerSystemPrompt(persona) : buildPlaySystemPrompt(persona),
    payload: buildCommentaryPayload(input, persona)
  };
}

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
    "Turn length: vary it. Longer beats (30-60 words) for takes and explanations; short beats (5-20 words) for reactions, callbacks, and one-liners. At least one short reactive turn when there are ≥2 turns. Total audio ~10-30 seconds. Use the asker/explainer/reactor pattern — if the lead opens with a hot take, the next turn might be 'no, that's not it.'",
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
      // Normalize empty / whitespace name to null so the prompt
      // rule "if listener.name is empty/missing, address as 'you'"
      // is unambiguous. Passing "" through let the LLM produce a
      // ", welcome" artifact on prod (empty name → `${name}, welcome`
      // pattern leaks the comma even when the model "knows" the name
      // is absent). null forces the model to take the no-name branch.
      name: listener.name?.trim() ? listener.name.trim() : null,
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
    pickContext: input.pickContext ?? null,
    pregameAngleHint: input.pregameAngleHint ?? null,
    enrichmentSignals: (input.enrichmentSignals ?? []).slice(0, 8).map((signal) => ({
      source: signal.source,
      kind: signal.kind,
      text: signal.text,
      // Voices are alternate phrasings folded in by the aggregator's
      // fuzzy dedup. Keep the source so the host knows whether the
      // echo came from fans or beat reporters.
      voices: (signal.voices ?? []).slice(0, 2).map((voice) => ({
        source: voice.source,
        text: voice.text
      }))
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

export function parseDialogueResponse(
  raw: string,
  leadHostId: HostId,
  listenerName?: string
): DialogueLine[] | undefined {
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
    if (turns.length > 0) return dedupeListenerAddress(turns, listenerName);
  }

  // Single-turn shorthand: {speaker, text}.
  const single = parsed as { speaker?: unknown; text?: unknown };
  if (typeof single.text === "string") {
    const turn = coerceSingleTurn(single.speaker, single.text, leadHostId);
    if (turn) return dedupeListenerAddress([turn], listenerName);
  }

  return undefined;
}

/**
 * After the FIRST vocative use of the listener's name across all turns,
 * replace subsequent standalone occurrences with "you" / "You". The
 * prompt asks the model to mention the listener at most once but the
 * model often drops the name in 3-4 times — hearing "Marc" four times
 * in a 30-second open feels like a hostage video. Possessive forms
 * (`Marc's roster`) are preserved by the `(?!['’])` lookahead.
 * No-op when listenerName is empty (non-demo cast with no profile).
 */
function dedupeListenerAddress(
  lines: DialogueLine[],
  listenerName: string | undefined
): DialogueLine[] {
  const trimmed = listenerName?.trim();
  if (!trimmed) return lines;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b(?!['\\u2019])`, "gi");
  let firstSeen = false;
  return lines.map((line) => {
    const text = line.text.replace(pattern, (match, offset, full) => {
      if (!firstSeen) {
        firstSeen = true;
        return match;
      }
      // Pick "You" vs "you" based on whether we're at a sentence start.
      const prev = (full as string).slice(0, offset as number).trimEnd();
      const lastChar = prev[prev.length - 1];
      const sentenceStart = !prev || lastChar === "." || lastChar === "?" || lastChar === "!";
      return sentenceStart ? "You" : "you";
    });
    return { ...line, text };
  });
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
  // Direct-address handoff. If turn N ends by addressing another host
  // by name ("Maya, what's the stress point?" / "Cam — push back"),
  // turn N+1 MUST come from that host. The prompt rule above asks the
  // model to obey this; this is the belt-and-suspenders enforcement
  // for when it doesn't. Only fires on a trailing address — mid-turn
  // mentions ("Cam was right earlier") are too noisy to snap on.
  for (let i = 0; i + 1 < out.length; i += 1) {
    const addressed = detectTrailingHostAddress(out[i].text, out[i].hostId);
    if (addressed && addressed !== out[i + 1].hostId) {
      out[i + 1] = { ...out[i + 1], hostId: addressed };
    }
  }
  return out;
}

/**
 * Read the closing handoff (if any) from a finished dialogue block.
 * When the FINAL turn ends with a direct address to another host —
 * "Maya, math it up." / "Cam — push back on that." — return that
 * addressee so the engine can make them the lead host of the next
 * commentary block. Without this, addressed handoffs at end-of-block
 * become rhetorical (the named host never speaks), which sounds
 * broken on a live show.
 */
export function detectClosingHandoff(lines: DialogueLine[]): HostId | undefined {
  if (lines.length === 0) return undefined;
  const last = lines[lines.length - 1];
  return detectTrailingHostAddress(last.text, last.hostId);
}

/**
 * Look at the last ~80 chars of a turn and decide whether the speaker
 * is handing the floor to a specific other host. Triggers on a name
 * that's set off by punctuation ("Maya," / "Cam —") in the tail of the
 * line. Returns the addressed host id, or undefined when no clear
 * handoff signal is present. Skips self-references — a host saying
 * their own name isn't a handoff.
 */
function detectTrailingHostAddress(text: string, speaker: HostId): HostId | undefined {
  const tail = text.slice(-80);
  // Address patterns: "Name," or "Name -" or "Name —" or "Name." or
  // "Name?" or "Name!" anywhere in the tail. Word-boundary anchored.
  const pattern = /\b(maya|theo|cam)\b\s*[,\-—.?!:]/gi;
  let match: RegExpExecArray | null;
  let last: HostId | undefined;
  while ((match = pattern.exec(tail)) !== null) {
    const id = match[1].toLowerCase() as HostId;
    if (id !== speaker) last = id;
  }
  return last;
}

function coerceSingleTurn(speakerRaw: unknown, textRaw: string, leadHostId: HostId): DialogueLine | undefined {
  // Strip leading-vocative-with-empty-name artifacts: when the
  // listener is anonymous (listener.name=null in the payload) the
  // LLM occasionally still emits ", welcome in." — interpolating
  // an empty addressee leaves a leading comma + space. The prompt
  // forbids this but belt-and-suspenders here means a stray model
  // output never reaches the listener as `, welcome to your show.`
  const text = textRaw
    .trim()
    .replace(/^[,;:—–\-]\s+/, "")
    .trim();
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
 * and the local commentary fallback — surfaces where audio tags
 * (`[laughs]`, `[deadpan]`, `[jumping in]`) are read literally and
 * make the transcript look like stage directions. The karaoke
 * renderer filters them per-token at display time; this strips them
 * everywhere the joined string flows.
 */
const AUDIO_TAG_PATTERN = /\[[a-z_][a-z_\s]*\]/gi;
export function joinDialogueLines(lines: DialogueLine[]): string {
  return lines
    .map((line) => line.text.replace(AUDIO_TAG_PATTERN, "").replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0)
    .join(" ");
}
