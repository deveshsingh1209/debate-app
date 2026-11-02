import type { DebateStatus } from '../../../shared/types';

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], { day: '2-digit', month: 'short' });
}

export const STATUS_LABEL: Record<DebateStatus, string> = {
  intake: 'Intake',
  clarifying: 'Clarifying',
  goal_approval: 'Goal approval',
  panel_design: 'Panel design',
  panel_approval: 'Panel approval',
  planning: 'Planning',
  plan_approval: 'Plan approval',
  meeting: 'In session',
  wrapup: 'Closing statements',
  reporting: 'Writing report',
  complete: 'Complete',
  paused: 'Paused',
  error: 'Error',
  cancelled: 'Cancelled',
};

export const DIVIDER_LABEL: Partial<Record<DebateStatus, string>> = {
  intake: 'Intake / clarity check',
  panel_design: 'Panel assembly',
  planning: 'Agenda drafting',
  meeting: 'Meeting in session',
  wrapup: 'Closing statements',
  reporting: 'Report generation',
  complete: 'Debate complete',
  paused: 'Paused',
  cancelled: 'Cancelled',
  error: 'Engine error',
};

export type StatusTone = 'cyan' | 'amber' | 'green' | 'red' | 'ghost';

export function statusTone(s: DebateStatus): StatusTone {
  switch (s) {
    case 'complete':
      return 'green';
    case 'error':
      return 'red';
    case 'cancelled':
      return 'ghost';
    case 'paused':
    case 'goal_approval':
    case 'panel_approval':
    case 'plan_approval':
    case 'clarifying':
      return 'amber';
    default:
      return 'cyan';
  }
}

export function statusIsLive(s: DebateStatus): boolean {
  return s !== 'complete' && s !== 'error' && s !== 'cancelled';
}

/** Mission-phase track: 8 stations mapped from DebateStatus. */
export const PHASES = ['INTAKE', 'GOAL', 'PANEL', 'PLAN', 'MEETING', 'WRAPUP', 'REPORT', 'DONE'] as const;

export function phaseIndex(s: DebateStatus): number {
  switch (s) {
    case 'intake':
    case 'clarifying':
      return 0;
    case 'goal_approval':
      return 1;
    case 'panel_design':
    case 'panel_approval':
      return 2;
    case 'planning':
    case 'plan_approval':
      return 3;
    case 'meeting':
    case 'paused':
      return 4;
    case 'wrapup':
      return 5;
    case 'reporting':
      return 6;
    case 'complete':
    case 'error':
    case 'cancelled':
      return 7;
  }
}
