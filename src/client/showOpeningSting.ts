/**
 * Short "show starting" audio cue. Plays the instant the listener
 * hits Listen — fills the 10-20s gap before the LLM commentary +
 * Inworld TTS produce their first chunk. Without it the demo feels
 * broken (silence after a button press) even though the engine is
 * cooking the opener in the background.
 *
 * Design: a soft 3-note rising motif (root → fifth → octave) over
 * ~1.2s, played through a triangle-wave oscillator with a fast
 * attack and a long exponential release so the tail trails into
 * the ambient bed instead of cutting hard. Sits at ~-18 dBFS so
 * it's clearly audible but won't startle. Single shot — never
 * loops, never blocks.
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

export function playShowOpeningSting(ctx: AudioContext): void {
  const start = ctx.currentTime;
  // A gentle low-pass softens the leading edge so it reads as
  // "warm chime" rather than "alarm beep." 2.2 kHz lets enough
  // harmonics through to feel present without sounding shrill.
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 2200;
  filter.Q.value = 0.7;

  const master = ctx.createGain();
  master.gain.value = 1;
  filter.connect(master).connect(ctx.destination);

  const notes: Array<{ freq: number; offset: number }> = [
    { freq: ROOT_HZ, offset: 0 },
    { freq: FIFTH_HZ, offset: NOTE_SPACING_SEC },
    { freq: OCTAVE_HZ, offset: NOTE_SPACING_SEC * 2 }
  ];

  for (const note of notes) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = note.freq;
    const env = ctx.createGain();
    env.gain.value = 0;
    osc.connect(env).connect(filter);

    const noteStart = start + note.offset;
    // Attack to peak, then exponential decay to silence. Linear
    // attack avoids the click of an instant ramp; exponential
    // release matches how plucked notes naturally die out.
    env.gain.setValueAtTime(0, noteStart);
    env.gain.linearRampToValueAtTime(PEAK_GAIN, noteStart + ATTACK_SEC);
    // exponentialRampToValueAtTime can't reach 0, so target a
    // near-zero floor and let the disconnect handle the tail.
    env.gain.exponentialRampToValueAtTime(0.0001, noteStart + ATTACK_SEC + DECAY_SEC);
    osc.start(noteStart);
    osc.stop(noteStart + ATTACK_SEC + DECAY_SEC + 0.05);
  }
}
