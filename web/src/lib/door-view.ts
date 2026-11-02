/**
 * Pure helpers for the four doors on the web side (no DOM, no fetch), so the
 * selftest can run them under node.
 */
import type { DoorState, DoorStatus } from '../../../shared/types';
import { PROVIDERS, isProvider, type Provider } from '../../../shared/models';

/**
 * The door a new debate starts on: the one asked for (a ?door= link from the
 * Connect screen) if it is ready, else the first ready door in the app's
 * order, else the one asked for, else Claude.
 */
export function defaultDoor(doors: DoorStatus[] | null | undefined, wanted?: string | null): Provider {
  const want = isProvider(wanted) ? wanted : null;
  const ready = (p: Provider) => doors?.find((d) => d.id === p)?.state === 'ready';
  if (want && ready(want)) return want;
  return PROVIDERS.find(ready) ?? want ?? 'claude';
}

export const anyReady = (doors: DoorStatus[] | null | undefined): boolean => !!doors?.some((d) => d.state === 'ready');

export const STATE_LABEL: Record<DoorState, string> = {
  ready: 'Ready',
  needs_setup: 'Needs setup',
  problem: 'Problem',
};

/** The chip class for a state (system.css: go / amber / stop). */
export const STATE_CHIP: Record<DoorState, string> = {
  ready: 'go',
  needs_setup: 'amber',
  problem: 'stop',
};

/** "a fix with `a command` in it" -> alternating plain and code segments. */
export function splitTicks(text: string): { code: boolean; text: string }[] {
  return text.split('`').map((t, i) => ({ code: i % 2 === 1, text: t })).filter((s) => s.text);
}
