/**
 * The rules of the room's sound, with no audio in them, so they can be tested
 * without a browser (design.selftest.ts).
 *
 * The brief: quiet, never annoying. So every cue has its own minimum gap, the
 * whole room has a floor between any two cues, and a ten-second window caps
 * the total. A cue that would break a rule is dropped, never queued: a late
 * gavel is worse than no gavel.
 */

export type Cue = 'gavel' | 'tick' | 'interrupt' | 'concession' | 'report' | 'alert';

export interface CueSpec {
  /** Minimum gap before the same cue can play again. */
  minGapMs: number;
  /** Plays in "key cues only" mode (the default under reduced motion). */
  key: boolean;
  /** Relative loudness before the master volume, 0..1. */
  level: number;
  label: string;
  note: string;
}

export const CUE_SPEC: Record<Cue, CueSpec> = {
  gavel:      { minGapMs: 1500, key: true,  level: 0.9,  label: 'Gavel',             note: 'A motion opens or is ruled on' },
  tick:       { minGapMs: 1200, key: false, level: 0.35, label: 'Turn change',       note: 'Someone new takes the floor' },
  interrupt:  { minGapMs: 2000, key: false, level: 0.6,  label: 'Interruption',      note: 'A speaker is cut off' },
  concession: { minGapMs: 3000, key: false, level: 0.7,  label: 'Concession',        note: 'Someone changes position' },
  report:     { minGapMs: 8000, key: true,  level: 0.85, label: 'Report ready',      note: 'The session is written up' },
  alert:      { minGapMs: 6000, key: true,  level: 0.7,  label: 'Your call',         note: 'The chair needs the founder' },
};

/** No two cues closer than this, whatever they are. */
export const GLOBAL_GAP_MS = 250;
/** At most this many cues in any WINDOW_MS. */
export const WINDOW_MAX = 6;
export const WINDOW_MS = 10_000;

export interface Limiter {
  allow(cue: Cue, now: number): boolean;
}

export function createLimiter(): Limiter {
  const last: Partial<Record<Cue, number>> = {};
  let recent: number[] = [];
  let lastAny = -Infinity;
  return {
    allow(cue, now) {
      const spec = CUE_SPEC[cue];
      const prev = last[cue];
      if (prev !== undefined && now - prev < spec.minGapMs) return false;
      if (now - lastAny < GLOBAL_GAP_MS) return false;
      recent = recent.filter((t) => now - t < WINDOW_MS);
      if (recent.length >= WINDOW_MAX) return false;
      recent.push(now);
      last[cue] = now;
      lastAny = now;
      return true;
    },
  };
}

export type SoundScope = 'all' | 'key';

export interface SoundSettings {
  /** Off until the founder turns it on; that click is the gesture that starts audio. */
  enabled: boolean;
  /** Master volume, 0..1. Default quiet. */
  volume: number;
  scope: SoundScope;
}

export const DEFAULT_VOLUME = 0.35;
