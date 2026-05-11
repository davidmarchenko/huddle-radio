/**
 * Subtle ambient bed for the live show. NOT music, NOT a stadium roar —
 * just a low, lightly-shifting pink-noise pad that fills the gaps
 * between turn-sets so the app doesn't feel dead when a host isn't
 * speaking. Ducks under TTS playback automatically.
 *
 * Design: Voss-McCartney pink noise into a low-pass filter (≈400 Hz)
 * plus a slow LFO on a second filter to give a "room breathing"
 * character without being noticeable. The bed sits at -28 dBFS in
 * the gap, ducks to -50 dBFS under speech.
 *
 * Generated client-side so we don't ship an audio asset. ~50 lines of
 * Web Audio plumbing total. Idempotent: starting an already-running
 * bed is a no-op; stopping a stopped bed is too.
 */

type BedState = {
  ctx: AudioContext;
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  output: GainNode;
  stopped: boolean;
};

const TARGET_GAIN_IDLE = 0.06; // ~-24 dBFS — felt, not heard
const TARGET_GAIN_DUCKED = 0.012; // ~-38 dBFS — barely there
const FADE_IN_SEC = 1.2;
const FADE_OUT_SEC = 0.8;
const DUCK_SEC = 0.18;

/**
 * Build a Voss-style pink noise buffer. A few seconds is plenty since
 * we loop it; longer than ~6s wastes memory. We layer 7 octaves of
 * white-noise updates at decreasing rates, giving the characteristic
 * 1/f spectrum that sounds like a distant crowd.
 */
function buildPinkNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(seconds * sampleRate);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < length; i += 1) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    data[i] = pink * 0.11; // headroom — output gain trims again
  }
  return buffer;
}

let active: BedState | undefined;

export function startAmbientBed(ctx: AudioContext): void {
  if (active && !active.stopped) return; // idempotent
  if (active) {
    // A previous bed exists but was stopped — let it tear down before re-creating.
    active = undefined;
  }

  const buffer = buildPinkNoiseBuffer(ctx, 4);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  // Low-pass at ~420 Hz strips the hiss; pink noise + this filter
  // sits in the chest range without being identifiable as noise.
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 420;
  filter.Q.value = 0.6;

  // Slow LFO on the filter cutoff (±30 Hz around 420) gives a
  // breathing quality without being noticeable. Very slow — 0.08 Hz.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.08;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 30;
  lfo.connect(lfoGain).connect(filter.frequency);

  // Master gain — animate this for fades + ducking.
  const output = ctx.createGain();
  output.gain.value = 0;
  source.connect(filter).connect(output).connect(ctx.destination);

  source.start();
  lfo.start();
  // Fade in. Use linearRamp so we hit exact target — exponentialRamp
  // can't reach 0 or move from 0.
  const now = ctx.currentTime;
  output.gain.linearRampToValueAtTime(TARGET_GAIN_IDLE, now + FADE_IN_SEC);

  active = { ctx, source, filter, lfo, lfoGain, output, stopped: false };
}

export function duckAmbientBed(): void {
  if (!active || active.stopped) return;
  const now = active.ctx.currentTime;
  const g = active.output.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(TARGET_GAIN_DUCKED, now + DUCK_SEC);
}

export function unduckAmbientBed(): void {
  if (!active || active.stopped) return;
  const now = active.ctx.currentTime;
  const g = active.output.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(TARGET_GAIN_IDLE, now + DUCK_SEC);
}

export function stopAmbientBed(): void {
  if (!active || active.stopped) return;
  const state = active;
  state.stopped = true;
  const now = state.ctx.currentTime;
  const g = state.output.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + FADE_OUT_SEC);
  // Tear down nodes after the fade — without this they keep running
  // (and consuming CPU) for the rest of the page lifetime.
  window.setTimeout(() => {
    try { state.source.stop(); } catch { /* already stopped */ }
    try { state.lfo.stop(); } catch { /* already stopped */ }
    try { state.source.disconnect(); } catch { /* ok */ }
    try { state.filter.disconnect(); } catch { /* ok */ }
    try { state.lfoGain.disconnect(); } catch { /* ok */ }
    try { state.output.disconnect(); } catch { /* ok */ }
  }, FADE_OUT_SEC * 1000 + 100);
  active = undefined;
}
