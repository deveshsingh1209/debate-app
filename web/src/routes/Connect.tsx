import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DoorStatus } from '../../../shared/types';
import { anyReady, markConnectSeen, useDoors } from '../lib/doors';
import { CopyLine, DoorChip, TickText } from '../components/DoorBits';
import { RoomSettings } from '../components/RoomSettings';

/** "just now", "12 s ago", "3 min ago". */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  return `${Math.round(s / 60)} min ago`;
}

function DoorCard({ door, onUse, onRecheck, checking, now }: {
  door: DoorStatus;
  onUse: () => void;
  onRecheck: () => void;
  checking: boolean;
  now: number;
}) {
  const ready = door.state === 'ready';
  const steps = (
    <ol className="cx-steps">
      {door.steps.map((s, i) => (
        <li key={i}>
          <span className="cx-step-t"><TickText text={s.text} /></span>
          {s.copy && <CopyLine value={s.copy} />}
        </li>
      ))}
    </ol>
  );
  return (
    <section className={`cx-card ${door.state}`} aria-labelledby={`cx-${door.id}`}>
      <header className="cx-head">
        <h2 id={`cx-${door.id}`} className="cx-title">{door.title}</h2>
        <DoorChip state={door.state} />
      </header>
      <p className="cx-blurb">{door.blurb}</p>
      <p className="cx-summary" aria-live="polite">{door.summary}</p>
      {door.fix && (
        <div className={`feed-note ${door.state === 'problem' ? 'err' : 'warn'} cx-fix`}>
          <b>How to fix</b>
          <TickText text={door.fix} />
        </div>
      )}
      {ready ? (
        <details className="cx-again">
          <summary>How this was set up</summary>
          {steps}
        </details>
      ) : (
        steps
      )}
      {door.note && <p className="cx-note">{door.note}</p>}
      <footer className="cx-foot">
        <button type="button" className="btn sm" onClick={onRecheck} disabled={checking}>
          {checking ? 'Checking…' : 'Re-check'}
        </button>
        <span className="cx-when">Checked {ago(door.checkedAt, now)}</span>
        {ready && (
          <button type="button" className="btn sm outline-cyan cx-use" onClick={onUse}>
            Start a debate with this
          </button>
        )}
      </footer>
    </section>
  );
}

/**
 * Connect your AI: the four ways to run debates, each with its live status,
 * plain steps, copy buttons for the exact commands, and a Re-check. Shown
 * once on first run when nothing is connected, and linked from the deck and
 * the settings menu after that.
 */
export default function Connect() {
  const nav = useNavigate();
  const { info, checking, error, recheck } = useDoors({ fresh: true });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    markConnectSeen();
    const t = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [info]);

  const someReady = anyReady(info?.doors);

  return (
    <div className="page-scroll">
      <div className="deck connect">
        <div className="deck-head">
          <h1 className="deck-title">Connect your AI</h1>
          <div className="deck-tools">
            <RoomSettings />
            <button className="btn sm" onClick={() => nav('/')}>Back to the deck</button>
          </div>
        </div>

        <p className="cx-lede">
          Debates run on this computer, on your own AI account. You need just <b>one</b> of these four. Pick the one you
          already pay for, follow its steps, and press Re-check. Keys stay in a file on this computer and are never shown
          back here.
        </p>

        <div className="cx-bar">
          <button type="button" className="btn" onClick={() => void recheck()} disabled={checking}>
            {checking ? 'Checking…' : 'Re-check all'}
          </button>
          {someReady && (
            <button type="button" className="btn primary" onClick={() => nav('/new')}>
              Start a new debate
            </button>
          )}
          {info?.mock && <span className="cx-when">Demo mode: debates are scripted and need none of these.</span>}
        </div>

        {error && (
          <div className="feed-note err" style={{ marginBottom: 20 }}>
            <b>Could not check</b>
            {error}
          </div>
        )}

        {!info && !error && <p className="cx-summary">Checking your AI connections…</p>}

        {info && (
          <div className="cx-grid">
            {info.doors.map((d) => (
              <DoorCard
                key={d.id}
                door={d}
                now={now}
                checking={checking}
                onRecheck={() => void recheck()}
                onUse={() => nav(`/new?door=${d.id}`)}
              />
            ))}
          </div>
        )}

        <p className="cx-foot-note">
          Not sure which to pick? If you have a Claude Pro or Max plan, use <b>Claude: sign in</b>. If you have ChatGPT Plus
          or Pro, use <b>ChatGPT: Codex sign-in</b>. An API key bills each debate to that account instead. Step-by-step help
          for each is in <code className="cx-code">docs/CONNECT-YOUR-AI.md</code>, and <code className="cx-code">npm run doctor</code> checks
          all four from a terminal.
        </p>
      </div>
    </div>
  );
}
