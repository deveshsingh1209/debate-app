import { CUE_SPEC, DEFAULT_VOLUME, createLimiter, type Cue, type SoundScope, type SoundSettings } from './sound-core';

/**
 * The room's sound. Synthesised with the Web Audio API at the moment it plays:
 * no audio files, nothing to download, nothing to 404.
 *
 * Off by default. The founder turns it on from the room's settings, and that
 * click is the user gesture browsers require, so no AudioContext is created
 * before someone asks for sound. A founder who turned it on last time gets it
 * back on their first click or key press (armAudio).
 *
 * Quiet by design: a master gain at 35% by default, soft attacks, short tails,
 * one cue per event that matters, and the limits in sound-core.ts. Reduced
 * motion also means fewer sounds: only the key cues (gavel, your call, report)
 * unless the founder asks for all of them.
 *
 * Sound is never the only signal. Every cue has a visual twin on screen.
 */

const KEY = 'debate.sound.v2';
const listeners = new Set<() => void>();

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function load(): SoundSettings {
  const base: SoundSettings = { enabled: false, volume: DEFAULT_VOLUME, scope: prefersReducedMotion() ? 'key' : 'all' };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const v = JSON.parse(raw) as Partial<SoundSettings>;
    return {
      enabled: v.enabled === true,
      volume: typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1 ? v.volume : base.volume,
      scope: v.scope === 'key' || v.scope === 'all' ? v.scope : base.scope,
    };
  } catch {
    return base;
  }
}

let settings: SoundSettings = typeof window === 'undefined' ? { enabled: false, volume: DEFAULT_VOLUME, scope: 'all' } : load();
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let unavailable = false;
const limiter = createLimiter();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  listeners.forEach((f) => f());
}

/** Create the context. Only ever called from a user gesture. */
function start(): boolean {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume();
    return true;
  }
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = settings.volume;
    // A gentle limiter so two cues landing together never clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    master.connect(comp).connect(ctx.destination);
    void ctx.resume();
    return true;
  } catch {
    unavailable = true;
    listeners.forEach((f) => f());
    return false;
  }
}

// ---------- synthesis primitives ----------

function env(g: GainNode, t0: number, peak: number, attack: number, decay: number) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

function osc(freq: number, t0: number, peak: number, decay: number, type: OscillatorType = 'sine', attack = 0.008) {
  if (!ctx || !master) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  env(g, t0, peak, attack, decay);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + attack + decay + 0.05);
}

let noiseBuf: AudioBuffer | null = null;
function noise(t0: number, peak: number, decay: number, centre: number, q: number) {
  if (!ctx || !master) return;
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = centre;
  bp.Q.value = q;
  const g = ctx.createGain();
  env(g, t0, peak, 0.002, decay);
  src.connect(bp).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + decay + 0.05);
}

// ---------- the cues ----------

/** A soft wooden knock: a filtered click over a low body. Twice to open a motion. */
function gavel(t0: number, level: number, knocks: number) {
  for (let i = 0; i < knocks; i++) {
    const t = t0 + i * 0.16;
    noise(t, 0.5 * level, 0.07, 1150, 3.5);
    osc(118, t, 0.55 * level, 0.22, 'sine', 0.003);
    osc(236, t, 0.12 * level, 0.09, 'triangle', 0.003);
  }
}

/** The quietest thing in the app: a short, high blip. */
function tick(t0: number, level: number) {
  osc(1480, t0, 0.18 * level, 0.05, 'sine', 0.004);
}

/** A cut: two quick notes falling, slightly dry. */
function interrupt(t0: number, level: number) {
  osc(784, t0, 0.22 * level, 0.07, 'triangle', 0.003);
  osc(587, t0 + 0.075, 0.22 * level, 0.1, 'triangle', 0.003);
  noise(t0, 0.06 * level, 0.03, 2400, 1.2);
}

/** A small bell: a fifth with a faint inharmonic partial, long soft tail. */
function concession(t0: number, level: number) {
  osc(1046.5, t0, 0.2 * level, 1.1, 'sine', 0.006);
  osc(1568, t0 + 0.06, 0.12 * level, 0.9, 'sine', 0.006);
  osc(2793, t0, 0.03 * level, 0.35, 'sine', 0.004);
}

/** Done: a slow rising triad. */
function report(t0: number, level: number) {
  [523.25, 659.25, 783.99].forEach((f, i) => osc(f, t0 + i * 0.12, 0.2 * level, 0.6, 'sine', 0.01));
}

/** Someone needs you: two soft notes, up then level. */
function alert(t0: number, level: number) {
  osc(660, t0, 0.2 * level, 0.18, 'triangle', 0.01);
  osc(880, t0 + 0.16, 0.2 * level, 0.28, 'triangle', 0.01);
}

function render(cue: Cue, variant?: number) {
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.01;
  const level = CUE_SPEC[cue].level;
  switch (cue) {
    case 'gavel': return gavel(t0, level, variant === 2 ? 2 : 1);
    case 'tick': return tick(t0, level);
    case 'interrupt': return interrupt(t0, level);
    case 'concession': return concession(t0, level);
    case 'report': return report(t0, level);
    case 'alert': return alert(t0, level);
  }
}

export const Sound = {
  get settings(): SoundSettings { return settings; },
  get unavailable(): boolean { return unavailable; },
  /** True when a cue would actually be heard right now. */
  get live(): boolean { return settings.enabled && !!ctx && ctx.state === 'running'; },

  /** Call from a click: turning sound on IS the user gesture. */
  enable(on: boolean) {
    settings = { ...settings, enabled: on };
    if (on) start();
    save();
  },
  setVolume(v: number) {
    settings = { ...settings, volume: Math.min(1, Math.max(0, v)) };
    if (master && ctx) master.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.05);
    save();
  },
  setScope(scope: SoundScope) {
    settings = { ...settings, scope };
    save();
  },
  subscribe(f: () => void): () => void {
    listeners.add(f);
    return () => { listeners.delete(f); };
  },

  /**
   * Play a cue if sound is on, the scope allows it and the limits do. Never
   * creates an AudioContext: before the founder's gesture this is silent.
   * `variant` 2 on the gavel is the double knock that opens a motion.
   */
  play(cue: Cue, variant?: number) {
    if (!settings.enabled || !ctx) return;
    if (settings.scope === 'key' && !CUE_SPEC[cue].key) return;
    if (!limiter.allow(cue, performance.now())) return;
    if (ctx.state === 'suspended') void ctx.resume();
    render(cue, variant);
  },

  /** For the settings preview and the rehearsal bench: ignores scope and limits, not the switch. */
  preview(cue: Cue, variant?: number) {
    if (!settings.enabled) return;
    if (!start()) return;
    render(cue, variant);
  },
};

/**
 * Re-arm sound on the first gesture of a new page load, but only for a founder
 * who turned it on before. Nobody else ever gets an AudioContext.
 */
export function armAudio() {
  if (typeof document === 'undefined') return;
  const arm = () => {
    if (settings.enabled) start();
    document.removeEventListener('pointerdown', arm);
    document.removeEventListener('keydown', arm);
  };
  document.addEventListener('pointerdown', arm, { passive: true });
  document.addEventListener('keydown', arm);
}
