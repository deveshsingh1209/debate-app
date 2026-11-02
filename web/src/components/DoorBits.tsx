import { useEffect, useRef, useState } from 'react';
import type { DoorState } from '../../../shared/types';
import { copyText, splitTicks, STATE_CHIP, STATE_LABEL } from '../lib/doors';

/** Plain text with `commands` set as code. */
export function TickText({ text }: { text: string }) {
  return (
    <>
      {splitTicks(text).map((s, i) => (s.code ? <code key={i} className="cx-code">{s.text}</code> : <span key={i}>{s.text}</span>))}
    </>
  );
}

export function DoorChip({ state }: { state: DoorState }) {
  return <span className={`chip ${STATE_CHIP[state]} cx-chip`}>{STATE_LABEL[state]}</span>;
}

/** One exact thing to type or paste, with a Copy button that says when it worked. */
export function CopyLine({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState<'ok' | 'fail' | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copyText(value);
    setDone(ok ? 'ok' : 'fail');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(null), 1800);
  };
  return (
    <div className="cx-copy">
      <code className="cx-copy-v" title={value}>{value}</code>
      <button type="button" className="btn sm cx-copy-b" onClick={copy} aria-label={`Copy ${label ?? value}`}>
        {done === 'ok' ? 'Copied' : done === 'fail' ? 'Select and copy' : 'Copy'}
      </button>
      <span className="sr-only" aria-live="polite">{done === 'ok' ? 'Copied to the clipboard' : ''}</span>
    </div>
  );
}
