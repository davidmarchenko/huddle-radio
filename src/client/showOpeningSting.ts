/**
 * Short procedural audio cues for show start + end. Plays the
 * instant the listener hits Listen / Stop so the demo feels
 * intentional — without these the gap before the LLM commentary +
 * Inworld TTS produce their first chunk (10-20s) reads as broken,
 * and a silent Stop reads as an accidental tap.
 *
 * Design: a soft 3-note motif over ~1.2s, played through a
 * triangle-wave oscillator with a fast attack and a long
 * exponential release so the tail trails into the ambient bed
 * instead of cutting hard. Sits at ~-18 dBFS so it's clearly
 * audible but won't startle. Single shot — never loops, never
 * blocks.
 *
 * Same procedural-Web-Audio pattern as ambientBed.ts; no audio
 * asset shipped.
 */

const ROOT_HZ = 392; // G4 — warm midrange
const FIFTH_HZ = 587; // D5
const OCTAVE_HZ = 784; // G5
const NOTE_SPACING_SEC = 0.18;
const ATTACK_SEC = 0.012;
const DECAY_SEC = 0.55;
const PEAK_GAIN = 0.12; // ~-18 dBFS

function playMotif(
  ctx: AudioContext,
  notes: Array<{ freq: number; offset: number }>
): void {
  const start = ctx.currentTime;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 2200;
  filter.Q.value = 0.7;
  const master = ctx.createGain();
  master.gain.value = 1;
  filter.connect(master).connect(ctx.destination);
  for (const note of notes) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = note.freq;
    const env = ctx.createGain();
    env.gain.value = 0;
    osc.connect(env).connect(filter);
    const noteStart = start + note.offset;
    env.gain.setValueAtTime(0, noteStart);
    env.gain.linearRampToValueAtTime(PEAK_GAIN, noteStart + ATTACK_SEC);
    env.gain.exponentialRampToValueAtTime(0.0001, noteStart + ATTACK_SEC + DECAY_SEC);
    osc.start(noteStart);
    osc.stop(noteStart + ATTACK_SEC + DECAY_SEC + 0.05);
  }
}

/** Rising motif on show start — root → fifth → octave. Reads as
 *  "lights coming up, hosts taking the desk." */
export function playShowOpeningSting(ctx: AudioContext): void {
  playMotif(ctx, [
    { freq: ROOT_HZ, offset: 0 },
    { freq: FIFTH_HZ, offset: NOTE_SPACING_SEC },
    { freq: OCTAVE_HZ, offset: NOTE_SPACING_SEC * 2 }
  ]);
}

/** Descending motif on show stop — octave → fifth → root (reverse
 *  of the opener). Reads as "wrapping up, signing off." Symmetry
 *  with the opening cue makes the bookend feel intentional. */
export function playShowClosingSting(ctx: AudioContext): void {
  playMotif(ctx, [
    { freq: OCTAVE_HZ, offset: 0 },
    { freq: FIFTH_HZ, offset: NOTE_SPACING_SEC },
    { freq: ROOT_HZ, offset: NOTE_SPACING_SEC * 2 }
  ]);
}
