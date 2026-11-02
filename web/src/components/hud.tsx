import { useEffect, useState, type ReactNode } from 'react';
import type { DebateStatus } from '../../../shared/types';
import { STATUS_LABEL, statusTone } from '../lib/format';

/** Corner brackets for panels. tone: default hairline, 'accent' cyan, 'warn' amber. */
export function Brackets({ tone }: { tone?: 'accent' | 'warn' }) {
  const cls = tone === 'accent' ? 'brk accent' : tone === 'warn' ? 'brk warn' : 'brk';
  return (
    <>
      <span className={`${cls} tl`} />
      <span className={`${cls} tr`} />
      <span className={`${cls} bl`} />
      <span className={`${cls} br`} />
    </>
  );
}

export function Chip({
  tone,
  pulse,
  dot,
  children,
}: {
  tone?: 'cyan' | 'amber' | 'green' | 'red' | 'ghost';
  pulse?: boolean;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`chip ${tone ?? ''} ${pulse ? 'pulse' : ''}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function StatusChip({ status }: { status: DebateStatus }) {
  const live = status === 'meeting' || status === 'wrapup' || status === 'reporting';
  return (
    <Chip tone={statusTone(status)} dot pulse={live}>
      {STATUS_LABEL[status]}
    </Chip>
  );
}

export function BootSplash({ line = 'Establishing link' }: { line?: string }) {
  return (
    <div className="boot">
      <div className="b-line">{line}</div>
    </div>
  );
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return match;
}

/** Ticking elapsed-time hook. Returns ms since `from`, frozen at `until` when provided. */
export function useElapsed(from: number, until?: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return (until ?? now) - from;
}
