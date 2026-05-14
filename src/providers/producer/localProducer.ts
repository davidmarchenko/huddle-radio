/**
 * LocalProducer — deterministic, dependency-free producer.
 *
 * Two roles:
 *
 *   1. Test substrate. The dedup aggregator + host-prompt path can be
 *      exercised end-to-end without an LLM key by pairing this with
 *      LocalCommentaryProvider.
 *   2. Last-resort fallback in production. If the LLM producer
 *      (Anthropic / OpenAI) fails or times out, the engine falls
 *      back to this so the show keeps moving. It won't pick the
 *      cleverest angle, but it picks A correct one.
 *
 * Heuristic priority order — first match wins for the lead beat,
 * then we fill remaining slots with the next-best signals:
 *
 *   1. Active listener cue (push-to-talk question deserves an answer)
 *   2. Market swing >5¢ (the news beat — the line moved on us)
 *   3. High-trust enrichment signal that names a player on the play
 *   4. Pregame angle hint (rotation through matchup math / odds /
 *      lineup outlook etc., already chosen by showEngine)
 *   5. The play itself (always available — the floor)
 *
 * Beats are kept short (max 3) so the output is a focused tick, not
 * a kitchen sink. Lead host is picked by source kind: Cam takes hot
 * takes / market swings, Maya takes stat-anchored beats, Theo
 * frames + handles handoffs.
 */

import type { HostId } from "../../shared/contracts";
import type { ProducerAgent, ProducerBeat, ProducerDirective, ProducerInput } from "./types";

const ID = "local-producer";
const LABEL = "Local Producer";

export class LocalProducer implements ProducerAgent {
  id = ID;
  label = LABEL;

  async produce(input: ProducerInput): Promise<ProducerDirective> {
    const beats: ProducerBeat[] = [];
    const draft = input.draft;

    // The engine may force a specific lead host (listener nudge,
    // closing-handoff carry-forward). Producer respects this for
    // every beat it generates — overriding it would silently break
    // the listener-cued host feature.
    //
    // When NO host is forced and the rapport tracker reports a host
    // hasn't spoken in 4+ ticks, the producer promotes that host as
    // the soft lead. This keeps the room balanced without breaking
    // explicit overrides.
    const rapport = input.rapportState;
    const quietHost = rapport ? findQuietHost(rapport) : undefined;
    const forcedLead = draft.hostId ?? quietHost;

    // Game-pivot mode short-circuits everything else. The broadcast
    // is continuous — we are NOT closing and re-opening the show —
    // but the underlying play feed just changed. Producer emits ONE
    // handoff beat that wraps the prior game and tees up the new
    // one. Per-show state (rapport, claims, recentCommentary) is
    // preserved by the engine; the producer just shapes the
    // editorial moment.
    if (input.gamePivotMode) {
      return {
        beats: buildGamePivotBeats({
          pivot: input.gamePivotMode,
          forcedLead
        }),
        showState: `Mid-show pivot: leaving ${input.gamePivotMode.fromSummary}; moving to ${input.gamePivotMode.toSummary}.`,
        // Treat the pivot as an act-break in arc terms — it's a
        // structural transition, not a close. Lets the host LLM
        // apply act-break voice rules (reflective, lower-energy)
        // to the handoff.
        arcPosition: "act-break",
        rapportState: rapport
      };
    }

    // Opener mode short-circuits everything else — this is the
    // one-shot show-start moment. Producer emits opener-specific
    // beats that anchor on the listener's roster + matchup.
    if (input.openerMode) {
      return {
        beats: buildOpenerBeats({ draft, forcedLead }),
        showState: "Show just opened — first impression matters most.",
        arcPosition: input.arcDirective?.position ?? "cold-open",
        rapportState: rapport
      };
    }

    // Banter mode short-circuits the normal beat cascade. The
    // engine sets it when there's no new game action but the show
    // shouldn't go silent — we emit pure conversation beats
    // anchored on RapportState (open threads, running bits,
    // who's been quiet) instead of the play/enrichment slate.
    if (input.banterMode) {
      return {
        beats: buildBanterBeats({ rapport, forcedLead, quietHost }),
        showState: summarizeShowState(input),
        arcPosition: input.arcDirective?.position,
        rapportState: rapport
      };
    }

    // Arc directive shapes the slate BEFORE the priority cascade.
    // For pivot mode, drop the play-anchored beat in favor of a
    // counter-program beat so we don't grind through bad news.
    const arc = input.arcDirective;
    if (arc?.position === "pivot") {
      beats.push({
        topic:
          "Pivot off the lopsided game — talk about the listener's other lineup tonight, the friend-room rivalry, or the slate at large.",
        angle: "counter-program: the game is decided, find a fresher rooting interest",
        leadHostId: forcedLead ?? "theo",
        turnCount: 2,
        sourceKind: "callback"
      });
    }
    if (arc?.position === "cold-open") {
      beats.push({
        topic:
          `Cold open: ${draft.play.team ? `${draft.play.team} are in this game` : "the matchup tonight"}. Name the matchup, name the listener once, foreshadow the first storyline.`,
        angle: "establish the room — energetic, not over-stuffed",
        leadHostId: forcedLead ?? "theo",
        turnCount: 2,
        sourceKind: "play"
      });
    }
    if (arc?.position === "climax") {
      // Override the routine play handling — climax deserves panel
      // reaction regardless of moment priority alignment.
      beats.push({
        topic: `Climax moment: ${draft.play.headline || draft.play.description || "the play that just landed"}.`,
        angle: "let it breathe — lead frames it big, peers react, no routine analysis until it lands",
        leadHostId: forcedLead ?? "theo",
        turnCount: 3,
        sourceKind: "play"
      });
    }
    if (arc?.position === "act-break") {
      beats.push({
        topic: "Act-break reflection — what we've seen this half + a callback to a host's earlier take.",
        angle: "callback opportunity; reset the room before the next half",
        leadHostId: forcedLead ?? "maya",
        turnCount: 2,
        sourceKind: "callback"
      });
    }
    if (arc?.position === "close") {
      beats.push({
        topic: "Close: wrap the dominant storyline of this show; foreshadow the next listen; leave one open thread.",
        angle: "wrap-and-tease",
        leadHostId: forcedLead ?? "theo",
        turnCount: 2,
        sourceKind: "callback"
      });
    }
    // Once the arc has spoken, fall through to the standard cascade
    // for any remaining slots.
    if (beats.length >= 3) {
      return {
        beats: beats.slice(0, 3),
        showState: summarizeShowState(input),
        arcPosition: arc?.position,
        rapportState: rapport
      };
    }

    // 1. Listener cue — direct address always wins.
    const cue = (draft.listenerCues ?? []).find((c) => c.text.trim().length > 0);
    if (cue) {
      beats.push({
        topic: `Listener asked: "${cue.text.slice(0, 140)}". Answer it directly.`,
        angle: "address the listener by name once, then answer the question",
        leadHostId: forcedLead ?? "theo", // Theo is the host who naturally addresses the listener.
        turnCount: 2,
        sourceKind: "listener"
      });
    }

    // 2. Market swing — the line moved, that's a news beat.
    if (draft.marketSwing) {
      const swing = draft.marketSwing;
      beats.push({
        topic: `${swing.market.title} just moved ${Math.abs(swing.deltaCents)}¢ on ${swing.market.outcomeLabel} (${swing.direction}) on ${swing.market.source}.`,
        angle: "lead with the move, name the source, don't recommend a bet",
        leadHostId: forcedLead ?? "cam", // Cam handles hot price action.
        turnCount: 2,
        sourceKind: "market"
      });
    }

    // Eval-loop feedback: when recent turns scored low on a
    // dimension, prefer the matching corrective beat.
    const eval_ = input.evalSnapshot;
    const reliable = eval_ && eval_.sampleSize >= 3;
    const lowSpecificity = reliable && eval_!.meanSpecificity <= 4.5;
    const lowCallbacks = reliable && eval_!.meanCallbacks <= 4 && draft.recentCommentary.length > 0;
    const lowFriction = reliable && eval_!.meanFriction <= 4 && draft.recentCommentary.length > 0;

    // 2.5 Callback inject — fires when EITHER the eval feedback says
    // callbacks have been weak OR the rapport tracker has an
    // unacknowledged open thread that fits this play. The rapport
    // path is more specific (we know exactly which thread to land);
    // the eval-feedback path is a generic corrective.
    const fittingOpenThread = rapport
      ? findFittingOpenThread(rapport, draft)
      : undefined;
    if (fittingOpenThread) {
      beats.push({
        topic: `Land the open thread: ${fittingOpenThread.hostId} earlier said "${truncate(fittingOpenThread.text, 120)}" — and now this play. Connect them explicitly.`,
        angle: "callback to a still-open thread the room hasn't paid off; lead with the host's name",
        // Prefer a host OTHER than the thread owner so the callback
        // feels like the room engaging with the take, not the take's
        // owner doubling down.
        leadHostId: forcedLead ?? pickCallbackLead(fittingOpenThread.hostId),
        turnCount: 2,
        sourceKind: "callback"
      });
    } else if (lowCallbacks) {
      beats.push({
        topic: `Callback corrective: pull a thread from the most recent prior turn — extend it, push back on it, or pay it off.`,
        angle: "use recentCommentary to land a thread we left open; don't manufacture one if nothing fits",
        leadHostId: forcedLead ?? "maya",
        turnCount: 1,
        sourceKind: "callback"
      });
    }

    // 3. Best enrichment signal — fans / beat reporters / wiki / stats /
    //    callbacks. When specificity has been dragging, prefer a
    //    stat-source signal so the next turn anchors on a real
    //    number. Callbacks (cross-show host claims) get their own
    //    sourceKind tag so the UI chip + telemetry distinguish them
    //    from generic enrichment.
    const enrichment = lowSpecificity
      ? pickBestStatEnrichment(draft) ?? pickBestEnrichmentSignal(draft)
      : pickBestEnrichmentSignal(draft);
    if (enrichment) {
      const isCallback = enrichment.source === "callback";
      const isVision = enrichment.source === "vision";
      const isStat = enrichment.source.endsWith("-stats");
      beats.push({
        topic: isCallback
          ? `Cross-show callback: ${truncate(enrichment.text, 200)}`
          : isVision
            ? `Visual color: ${truncate(enrichment.text, 180)}`
            : `Crowd color: ${truncate(enrichment.text, 180)} (source: ${enrichment.source})`,
        angle: isCallback
          ? "land the callback — name the host who said it last show, then check it against what's happening tonight"
          : isVision
            ? "narrate what the broadcast is showing — speak it as live observation, not as a separate fact"
            : isStat
              ? "weave the number into a stat-anchored take"
              : "paraphrase as crowd reaction; don't quote verbatim" +
                (lowFriction ? "; one host should push back on the take" : ""),
        leadHostId: forcedLead ?? (isStat || isVision ? "maya" : "cam"),
        turnCount: isCallback ? 2 : 1,
        sourceKind: isCallback ? "callback" : isVision ? "vision" : "enrichment"
      });
    }

    // 4. Pregame angle hint — when scheduled / pre-tip the engine
    //    rotates through matchup math / odds / lineup so we don't
    //    loop the same talking points.
    if (draft.pregameAngleHint) {
      beats.push({
        topic: `Pregame angle: ${draft.pregameAngleHint}`,
        angle: "anchor on this specific angle so we don't recycle prior pregame ticks",
        leadHostId: forcedLead ?? pickPregameLead(draft.pregameAngleHint),
        turnCount: 2,
        sourceKind: "pregame"
      });
    }

    // 5. The play itself — always include as the floor beat unless
    //    we already have 3 beats from higher-priority signals.
    if (beats.length < 3) {
      const playLead = forcedLead ?? playLeadHost(draft);
      beats.push({
        topic: `Play: ${draft.play.headline || draft.play.description || "live action"}.`,
        angle: draft.moment?.priority === "interrupt" || draft.moment?.priority === "major"
          ? "panel reaction; the lead frames it, peers react, one short callback if a recentCommentary thread fits"
          : "brief read; don't manufacture a panel for a routine play",
        leadHostId: playLead,
        turnCount: turnCountForMoment(draft),
        sourceKind: "play"
      });
    }

    return {
      beats: beats.slice(0, 3),
      showState: summarizeShowState(input),
      arcPosition: arc?.position,
      rapportState: rapport
    };
  }

  async health() {
    return {
      id: ID,
      label: LABEL,
      status: "ready" as const,
      detail: "Local heuristic producer always available."
    };
  }
}

function pickBestEnrichmentSignal(draft: ProducerInput["draft"]) {
  const signals = draft.enrichmentSignals ?? [];
  if (signals.length === 0) return undefined;
  // Aggregator already sorted by score×trust×recency; first is best.
  return signals[0];
}

/** Prefer a high-trust stat-source signal (nba-stats / mlb-stats /
 *  nhl-stats) when the eval loop says specificity has been weak.
 *  Falls back to the best general signal at the call site. */
function pickBestStatEnrichment(draft: ProducerInput["draft"]) {
  const signals = draft.enrichmentSignals ?? [];
  return signals.find((s) => s.source.endsWith("-stats"));
}

function playLeadHost(draft: ProducerInput["draft"]): HostId {
  // Same persona-fit logic as selectHost, simplified:
  // - major / interrupt → Theo to anchor the moment
  // - stat-heavy play (lots of impacts) → Maya
  // - everything else → rotate among recentHostIds-aware picks (we
  //   don't have recentHostIds here; default to Theo as anchor).
  const priority = draft.moment?.priority;
  if (priority === "major" || priority === "interrupt") return "theo";
  if ((draft.impacts?.length ?? 0) >= 3) return "maya";
  return "theo";
}

function turnCountForMoment(draft: ProducerInput["draft"]): 1 | 2 | 3 {
  const priority = draft.moment?.priority;
  if (priority === "interrupt" || priority === "major") return 3;
  if (priority === "notable") return 2;
  return 1;
}

/** Build the single beat that moves the show from one game to the
 *  next without closing the broadcast. The lead host (Theo by
 *  default — he's the room's anchor) wraps the prior game in one
 *  breath and pivots into the new matchup. Two turns: the wrap +
 *  the tee-up. Kept short on purpose — the listener just changed
 *  channels and wants to land in the new game fast. */
function buildGamePivotBeats(input: {
  pivot: NonNullable<ProducerInput["gamePivotMode"]>;
  forcedLead?: HostId;
}): ProducerBeat[] {
  const lead = input.forcedLead ?? "theo";
  return [
    {
      topic: `Game pivot: wrap ${input.pivot.fromSummary}, then move to ${input.pivot.toSummary}. Bridge with ONE breath ("alright, that one's in the books") — don't re-open the show, don't say "welcome to."`,
      angle: "structural transition, not a re-open. Lower energy than a tip — name what just ended, name what's next, hand off into the new game.",
      leadHostId: lead,
      turnCount: 2,
      sourceKind: "handoff"
    }
  ];
}

/** Build the opener beat slate. The opener is the one moment the
 *  listener is GUARANTEED to hear — it should anchor on the listener
 *  by name + their team + their starters, foreshadow a storyline,
 *  and set the room's tone. Three beats by default (frame, color,
 *  hand-off into live action) so the LLM has clear lanes; degrades
 *  to two when the listener has no roster loaded. */
function buildOpenerBeats(input: {
  draft: ProducerInput["draft"];
  forcedLead?: HostId;
}): ProducerBeat[] {
  const draft = input.draft;
  const lead = input.forcedLead ?? "theo";
  const listener = draft.group.listener;
  const roster = draft.listenerRoster;
  const listenerName = listener.name?.trim();
  const teamName = roster?.teamName;
  const starters = roster?.starters ?? [];
  const topStarters = [...starters]
    .sort((a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0))
    .slice(0, 3);
  const matchupTeam = draft.play.team && draft.play.team !== "—" ? draft.play.team : undefined;
  const slate = draft.slateContext;

  const beats: ProducerBeat[] = [];

  // Beat 1 — lead host anchors: name the listener (once), name the
  // fantasy team, foreshadow what to watch tonight. Avoid 'welcome
  // back / welcome to' generic radio openers.
  // When slate context is present, the opener signals slate breadth
  // ("eight games tonight, three of your guys live") instead of
  // pretending only one game exists. Both branches still name the
  // listener + team + tone.
  const anchorTopic = slate
    ? [
        listenerName ? `Open by addressing ${listenerName}` : "Open by addressing the listener as 'you'",
        teamName ? `frame their fantasy squad ${teamName}` : "frame the listener's lineup",
        `name the slate breadth: ${slate.totalGames} games tonight, ${slate.starterGames} with their starters live`,
        matchupTeam ? `starting with ${matchupTeam}` : "starting with the lead game",
        slate.upcomingHighlights.length > 0
          ? `tease what's coming after: ${slate.upcomingHighlights.join(", ")}`
          : "tease tonight's flow",
        "warm, sharp, not over-stuffed."
      ].join("; ")
    : [
        listenerName ? `Open the show by addressing ${listenerName}` : "Open the show by addressing the listener as 'you'",
        teamName ? `frame their fantasy squad ${teamName} as the rooting interest` : "frame the listener's lineup as tonight's rooting interest",
        matchupTeam ? `name the matchup (${matchupTeam} are in this one)` : "tease tonight's slate",
        "set the room's tone — warm, sharp, not over-stuffed."
      ].join("; ");
  beats.push({
    topic: anchorTopic,
    angle: "establish the room with personality, not a 'welcome back, folks' canned intro; name the listener AT MOST ONCE across the whole open",
    leadHostId: lead,
    turnCount: 2,
    sourceKind: "play"
  });

  // Beat 2 — second host pulls a starter or roster detail. Maya gets
  // it when there's a stat anchor; Cam when there's a hot-take lane.
  if (topStarters.length > 0) {
    const top = topStarters[0];
    const otherStarters = topStarters.slice(1).map((p) => p.name).join(" / ");
    beats.push({
      topic: `Pull on the listener's lineup: ${top.name} at ${top.position} (${top.proTeam}) is the headliner${
        otherStarters.length > 0 ? `; ${otherStarters} are also in tonight` : ""
      }. Find ONE specific angle on the headliner — matchup, role, or a take.`,
      angle: "stat-anchored color OR a sharp prediction; one number max if any, no fantasy-app shorthand",
      leadHostId: lead === "maya" ? "cam" : "maya",
      turnCount: 2,
      sourceKind: "enrichment"
    });
  } else {
    // No roster loaded — pivot to the matchup so the open doesn't
    // dead-air on a missing data field.
    beats.push({
      topic: `Listener hasn't loaded a lineup yet — pivot to the matchup itself. ${
        matchupTeam ? `${matchupTeam} are in this one` : "Tonight's headline game"
      }. Tease one storyline you'll be watching.`,
      angle: "fill the lineup gap with matchup color; do not invent starters",
      leadHostId: lead === "theo" ? "cam" : "theo",
      turnCount: 1,
      sourceKind: "play"
    });
  }

  // Beat 3 — close the open with a hot take or hand-off into the
  // live game. Cam owns this when the room is fresh; otherwise the
  // current lead frames it. Keeping turnCount=1 so the open stays
  // ~45-60s of audio.
  beats.push({
    topic: "Close the open: ONE forward-looking take that hands off into the live show — a prediction, a thing to watch, or a callback to tee up.",
    angle: "punctuate the open; high-energy without being cartoonish; the next thing the listener hears is live game action",
    leadHostId: "cam",
    turnCount: 1,
    sourceKind: "play"
  });

  return beats;
}

/** Build the banter-only beat slate for a tick the engine has
 *  flagged as "fill the silence." Always emits at least one beat
 *  so the engine has something to send; prefers anchoring on an
 *  open thread or running bit when rapport state has one. */
function buildBanterBeats(input: {
  rapport?: NonNullable<ProducerInput["rapportState"]>;
  forcedLead?: HostId;
  quietHost?: HostId;
}): ProducerBeat[] {
  const lead = input.forcedLead ?? input.quietHost ?? "theo";
  const rapport = input.rapport;

  // Anchor preference: unacknowledged open thread → running bit →
  // generic "what are you watching tonight" filler. Specific beats
  // out-rank generic ones because they ground the conversation in
  // something the listener has actually heard.
  const openThread = rapport?.openThreads.find((t) => !t.acknowledged);
  if (openThread) {
    return [
      {
        topic: `Banter: pull on the still-open thread — ${openThread.hostId} earlier said "${truncate(openThread.text, 140)}". Has it aged well? Push back, callback, or land it.`,
        angle: "low-key conversation, not a panel reaction. Lead with engagement, not a take.",
        leadHostId: lead,
        turnCount: 2,
        sourceKind: "banter"
      }
    ];
  }
  const bit = rapport?.runningBits[0];
  if (bit) {
    return [
      {
        topic: `Banter: lean into the running bit ("${bit.phrase}") — it's come up ${bit.occurrences} times now. Make it a known quantity in the room.`,
        angle: "the bit is the moment; everyone acknowledges it",
        leadHostId: lead,
        turnCount: 2,
        sourceKind: "banter"
      }
    ];
  }
  return [
    {
      topic:
        "Banter: nothing material on the field — fill the air with the room. Pick ONE: what someone's watching tonight on another screen, a friend-room rivalry, the slate at large, or a quick host-on-host bit. KEEP IT SHORT.",
      angle: "low-energy conversational beat, not a take. The next play will come.",
      leadHostId: lead,
      turnCount: 2,
      sourceKind: "banter"
    }
  ];
}

/** Find an unacknowledged open thread that fits the current play —
 *  match on team or player names appearing in the play's headline /
 *  description. Returns the most recent fitting thread when multiple
 *  match. */
function findFittingOpenThread(
  rapport: NonNullable<ProducerInput["rapportState"]>,
  draft: ProducerInput["draft"]
): NonNullable<ProducerInput["rapportState"]>["openThreads"][number] | undefined {
  const playText = `${draft.play.headline ?? ""} ${draft.play.description ?? ""}`.toLowerCase();
  if (playText.trim().length === 0) return undefined;
  const candidates = rapport.openThreads.filter((thread) => {
    if (thread.acknowledged) return false;
    const fragment = thread.text.toLowerCase().split(/\s+/).find((tok) => tok.length > 4);
    return fragment ? playText.includes(fragment) : false;
  });
  // Most recent first — usually freshest.
  return candidates[candidates.length - 1];
}

function pickCallbackLead(threadOwner: HostId): HostId {
  // Whoever isn't the thread owner. Prefer Theo when he's not the
  // owner (he's the room's anchor) else Maya, else Cam.
  const order: HostId[] = ["theo", "maya", "cam"];
  return order.find((h) => h !== threadOwner) ?? "theo";
}

/** Promote a host who hasn't spoken in 4+ ticks. Picks the longest-
 *  silent host first so the room stays balanced over many ticks. */
function findQuietHost(rapport: NonNullable<ProducerInput["rapportState"]>): HostId | undefined {
  const standings = Object.entries(rapport.hostStanding) as Array<[HostId, typeof rapport.hostStanding.maya]>;
  const quiet = standings
    .filter(([, s]) => s.ticksSinceLastSpoke >= 4)
    .sort((a, b) => b[1].ticksSinceLastSpoke - a[1].ticksSinceLastSpoke);
  return quiet.length > 0 ? quiet[0][0] : undefined;
}

function pickPregameLead(angleHint: string): HostId {
  const lower = angleHint.toLowerCase();
  if (lower.includes("odds") || lower.includes("market") || lower.includes("line")) return "cam";
  if (lower.includes("stat") || lower.includes("matchup math") || lower.includes("starter outlook")) return "maya";
  return "theo";
}

function summarizeShowState(input: ProducerInput): string {
  const recent = input.draft.recentCommentary ?? [];
  if (recent.length === 0) return "Show just opened; no prior turns to thread back to.";
  // Keep it short — the producer LLM (when present) will write
  // something richer. Local producer just notes how many turns we've
  // delivered + whether any obvious thread is open.
  const lastTurn = recent[0] ?? "";
  const lastEcho = lastTurn.length > 120 ? `${lastTurn.slice(0, 120)}…` : lastTurn;
  return `${recent.length} prior turn(s). Last beat: "${lastEcho}"`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
