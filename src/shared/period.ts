import type { SportLeague } from "./contracts";

/**
 * Sport-aware game-period model.
 *
 * The play feed from any upstream sports provider (ESPN, Sportradar,
 * SportsDataIO, demo fixtures) carries a "what part of the game are
 * we in" signal. Different sports name that thing differently:
 *
 *   football / basketball   → quarter   (Q1-Q4, OT)
 *   hockey                  → period    (P1-P3, OT, SO)
 *   baseball                → inning    (1st, 2nd, ... with top/bot)
 *   soccer                  → half      (H1, H2, ET)
 *
 * Historically `SportsPlay.quarter` was a free-form string the
 * provider already formatted ("Q4", "Bot 7th", "P3"). That mixed
 * presentation into the data model — baseball games rendered as
 * "Q9" because the ESPN provider unconditionally prefixed "Q".
 *
 * The fix is to keep the period RAW in the play record (number +
 * semantic kind) and run all formatting through `formatPeriodLabel`.
 * That gives us one place to tweak conventions (e.g. ever decide
 * basketball should read "OT2" vs "2OT") and one place to test it.
 */

export type PeriodKind =
  /** Football, basketball, plus any sport whose default convention
   *  is "quarters of equal length". */
  | "quarter"
  /** Hockey — periods, with OT and SO past regulation. */
  | "period"
  /** Baseball — innings, with explicit top/bottom split. */
  | "inning"
  /** Soccer — halves, with extra time / penalties past regulation. */
  | "half";

export type PeriodInfo = {
  /** Raw period number from upstream. 0 means pregame/unknown — the
   *  formatter renders that as empty or the shortDetail fallback. */
  number: number;
  /** Semantic — drives the formatter's prefix and overtime rules.
   *  Derived from the sport at producer time so a play carries
   *  enough info to format itself without a sport lookup. */
  kind: PeriodKind;
  /** Baseball only: which half-inning the play happened in. Carried
   *  through from upstream when available (ESPN's possession field
   *  for MLB encodes the half). */
  half?: "top" | "bottom";
  /** Free-form short label the provider gave us. Preferred over the
   *  formatter's output for baseball — ESPN's "Bot 7th" already
   *  encodes inning + half richer than (number, kind, half) alone.
   *  For other sports it's a fallback for pre-game / final states
   *  where `number === 0`. */
  shortDetail?: string;
};

/** Best-guess kind for a sport when the producer doesn't carry one
 *  explicitly. Used by snapshot migration (legacy plays with a
 *  string-only `quarter`) and by demo fixtures. */
export function periodKindForSport(sport: SportLeague): PeriodKind {
  switch (sport) {
    case "mlb":
      return "inning";
    case "nhl":
      return "period";
    case "soccer":
      return "half";
    case "nfl":
    case "ncaaf":
    case "nba":
    case "wnba":
    case "ncaab":
    case "other":
    default:
      return "quarter";
  }
}

/**
 * Render a period for the UI scoreline / hero meta / commentary
 * prompt. Sport-aware so baseball reads "9th" not "Q9" and hockey
 * reads "P3" not "Q3".
 *
 * Takes just the period — the `kind` field already encodes which
 * sport family we're in, so callers don't have to thread the
 * SportLeague through. When the upstream provider gave us a rich
 * `shortDetail` string with a digit in it (e.g. "Bot 7th", "End 2nd"),
 * prefer it for inning kind — those carry top/bottom information
 * the (number, kind, half) tuple may not.
 */
export function formatPeriodLabel(period: PeriodInfo): string {
  const { number, kind, half, shortDetail } = period;
  // Pre-game / unknown — defer to the upstream short text or empty.
  if (number <= 0) return shortDetail ?? "";

  // Prefer the provider's rich short string for baseball — "Bot 7th"
  // is more useful than constructing "T7" / "B7" from parts.
  if (kind === "inning" && shortDetail && /\d/.test(shortDetail)) {
    return shortDetail;
  }

  switch (kind) {
    case "quarter":
      if (number <= 4) return `Q${number}`;
      return number === 5 ? "OT" : `OT${number - 4}`;
    case "period":
      if (number <= 3) return `P${number}`;
      if (number === 4) return "OT";
      return "SO";
    case "inning": {
      const prefix = half === "top" ? "Top " : half === "bottom" ? "Bot " : "";
      return `${prefix}${number}${ordinalSuffix(number)}`;
    }
    case "half":
      if (number <= 2) return `H${number}`;
      return "ET";
  }
}

/**
 * Natural-language period for SPOKEN commentary. `formatPeriodLabel`
 * returns UI badge codes ("OT", "Q1", "P2") that read fine on a score
 * bug but sound robotic in a TTS feed — listener hears the literal
 * letters. Use this in any code path that builds text destined for
 * audio.
 *
 * Returns short phrases that fit naturally inside a sentence:
 *   "in overtime" / "early in the first" / "late in the third" /
 *   "top of the 7th" / "in extra time".
 *
 * Returns an empty string when there's nothing useful to say
 * (pre-game with no detail) so callers can branch cleanly.
 */
export function formatPeriodSpoken(period: PeriodInfo): string {
  const { number, kind, half, shortDetail } = period;
  if (number <= 0) return "";

  switch (kind) {
    case "quarter":
      if (number === 1) return "in the first quarter";
      if (number === 2) return "in the second quarter";
      if (number === 3) return "in the third quarter";
      if (number === 4) return "in the fourth quarter";
      return number === 5 ? "in overtime" : `in overtime`;
    case "period":
      if (number === 1) return "in the first period";
      if (number === 2) return "in the second period";
      if (number === 3) return "in the third period";
      if (number === 4) return "in overtime";
      return "in the shootout";
    case "inning": {
      const ord = `${number}${ordinalSuffix(number)}`;
      if (half === "top") return `in the top of the ${ord}`;
      if (half === "bottom") return `in the bottom of the ${ord}`;
      // shortDetail like "Bot 7th" is more natural than the bare ordinal.
      if (shortDetail && /\d/.test(shortDetail)) {
        return `in the ${shortDetail.toLowerCase().replace(/^bot /, "bottom of the ").replace(/^top /, "top of the ")}`;
      }
      return `in the ${ord}`;
    }
    case "half":
      if (number === 1) return "in the first half";
      if (number === 2) return "in the second half";
      return "in extra time";
  }
}

/**
 * Tag a raw period number with the sport-appropriate kind. Producers
 * use this when they have the raw integer from upstream but haven't
 * decided how to label it yet.
 */
export function periodFromNumber(
  number: number,
  sport: SportLeague,
  extras?: { half?: PeriodInfo["half"]; shortDetail?: string }
): PeriodInfo {
  return {
    number,
    kind: periodKindForSport(sport),
    half: extras?.half,
    shortDetail: extras?.shortDetail
  };
}

/**
 * Migration shim for snapshots / fixtures that were written before
 * the structured-period change. Parses strings like "Q3", "P2",
 * "Bot 7th", "End 2nd", "Halftime", or "Live" into a best-guess
 * PeriodInfo. Always lossy — meant only to keep already-rendered
 * games viewable, NOT as a producer path.
 */
export function periodFromLegacyString(value: string | undefined, sport: SportLeague): PeriodInfo {
  if (!value) return { number: 0, kind: periodKindForSport(sport) };
  const trimmed = value.trim();
  const kind = periodKindForSport(sport);
  // Try to pull out a digit run; treat the first one as the period.
  const digitMatch = /\d+/.exec(trimmed);
  const number = digitMatch ? Number.parseInt(digitMatch[0]!, 10) : 0;
  let half: PeriodInfo["half"] | undefined;
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("top")) half = "top";
  else if (lowered.startsWith("bot")) half = "bottom";
  return {
    number: Number.isFinite(number) ? number : 0,
    kind,
    half,
    // Keep the raw string around for sports (like baseball) where it
    // carries more info than the parsed parts.
    shortDetail: trimmed
  };
}

function ordinalSuffix(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}
