/**
 * What the browser shows when debates need the founder: the count in the tab
 * title and favicon, and the words of a notification. Pure, so the qa
 * selftest covers it without a DOM.
 */
import type { Attention } from '../../../shared/attention';
import type { DebateSummary } from '../../../shared/types';

/** Kinds that stay "needs you" until the founder acts on them. */
const ACTIONABLE: ReadonlySet<Attention> = new Set(['question', 'approval', 'paused']);

export const freshKey = (id: string, key: string) => `${id}|${key}`;

/**
 * How many debates need the founder right now. Questions, gates and limit
 * pauses count while they are pending. Reports and errors count only if they
 * arrived while this tab was open and have not been looked at yet (`fresh`),
 * otherwise every finished debate would badge the tab forever. The debate
 * being looked at in a visible tab never counts.
 */
export function needsYouCount(
  rows: Pick<DebateSummary, 'id' | 'attention' | 'attentionKey'>[],
  opts: { fresh: ReadonlySet<string>; viewing: string | null; visible: boolean }
): number {
  let n = 0;
  for (const r of rows) {
    if (!r.attention || !r.attentionKey) continue;
    if (opts.visible && opts.viewing === r.id) continue;
    if (ACTIONABLE.has(r.attention) || opts.fresh.has(freshKey(r.id, r.attentionKey))) n++;
  }
  return n;
}

const HEADLINE: Record<Attention, string> = {
  question: 'A debate needs your answer',
  approval: 'A debate is waiting for your approval',
  paused: 'A debate is paused and needs you',
  error: 'A debate stopped with an error',
  report: 'A report is ready',
};

/** One notification for a batch of changes. Local only, so the title is fine to show. */
export function notificationCopy(changes: { id: string; kind: Attention; title?: string }[]): {
  title: string;
  body: string;
  /** Where clicking it goes. */
  path: string;
  tag: string;
} {
  if (changes.length === 1) {
    const c = changes[0];
    return {
      title: HEADLINE[c.kind],
      body: c.title?.trim() || 'Untitled debate',
      path: c.kind === 'report' ? `/debate/${c.id}/report` : `/debate/${c.id}`,
      tag: `debate-${c.id}`,
    };
  }
  return {
    title: `${changes.length} debates need you`,
    body: changes.map((c) => c.title?.trim() || 'Untitled debate').slice(0, 4).join(' · '),
    path: '/',
    tag: 'debate-several',
  };
}

export function badgeTitle(count: number, base: string): string {
  return count > 0 ? `(${count}) Needs you · ${base}` : base;
}
