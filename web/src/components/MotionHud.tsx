import { useState } from 'react';
import { motion } from 'framer-motion';
import { RUNGS, type Decision } from '../../../shared/types';
import type { BudgetSnapshot } from '../../../shared/types';
import type { DebateState } from '../lib/stream';

/**
 * The three readouts the depth engine earned: where the session is in the
 * agenda, how deep the current argument has actually climbed, and what has
 * been ruled so far. Plus the budget and token meter.
 */

/* ---------------- motion + agenda + depth ladder ---------------- */

const AGENDA_WORD: Record<string, string> = {
  pending: 'not yet opened',
  active: 'on the floor',
  done: 'ruled',
  added: 'added by the chair',
  dropped: 'dropped',
};

export function MotionBar({ state }: { state: DebateState }) {
  const m = state.activeMotion;
  const r = state.motionRound;
  if (!m) return null;

  const rung = r?.rung ?? 0;
  const items = state.plan?.items ?? [];

  return (
    <motion.div
      className="mbar"
      initial={{ y: -4 }}
      animate={{ y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
    >
      <div className="mbar-top">
        <span className="mbar-k">
          Motion {m.index} of {m.total}
          {r && <span className="mbar-round"> · round {r.round}</span>}
        </span>
        {items.length > 1 && (
          <span className="agenda-pips" aria-label="Agenda">
            {items.map((it) => (
              <span
                key={it.id}
                className={`pip ${it.status}`}
                title={`${it.title}: ${AGENDA_WORD[it.status] ?? it.status}`}
                aria-label={`${it.title}: ${AGENDA_WORD[it.status] ?? it.status}`}
              />
            ))}
          </span>
        )}
      </div>
      <h2 className="mbar-title">{m.title}</h2>

      {/* The ladder: a motion cannot close below 'stress'. */}
      <div className="ladder" title="How deep the argument has gone. A motion cannot be ruled on until it reaches stress.">
        {RUNGS.map((step) => {
          const reached = rung >= step.rung;
          const current = rung === step.rung;
          return (
            <div key={step.rung} className={`rung ${reached ? 'on' : ''} ${current ? 'now' : ''}`} aria-current={current ? 'step' : undefined}>
              <span className="rung-dot" />
              <span className="rung-name">{step.name}</span>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

/* ---------------- decisions ledger ---------------- */

export function DecisionsLedger({ decisions }: { decisions: Decision[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!decisions.length) {
    return <div className="rail-empty">No motion ruled on yet. Each one closes with a written decision.</div>;
  }
  return (
    <div className="ledger">
      {decisions.map((d, i) => {
        const isOpen = open === d.motionId;
        return (
          <div key={d.motionId + i} className={`led ${isOpen ? 'open' : ''}`}>
            <button className="led-head" onClick={() => setOpen(isOpen ? null : d.motionId)} aria-expanded={isOpen}>
              <span className="led-n num">{i + 1}</span>
              <span className="led-t">{d.motionTitle}</span>
              <span className={`grade ${d.evidence}`}>{d.evidence}</span>
            </button>
            {isOpen && (
              <div className="led-body">
                <div className="led-decision">{d.decision}</div>
                <div className="led-owner"><span className="label">Owner</span> {d.owner}</div>
                {d.rationale && <div className="led-why">{d.rationale}</div>}
                {d.dissents.length > 0 && (
                  <div className="led-dissents">
                    <span className="label">Dissent{d.dissents.length === 1 ? '' : 's'}</span>
                    {d.dissents.map((x, j) => (
                      <div key={j}><b>{x.expert}</b> {x.position}</div>
                    ))}
                  </div>
                )}
                {d.undecidable && (
                  <div className="led-undecidable">
                    Undecidable without: {d.undecidable.evidenceNeeded} ({d.undecidable.who})
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- budget bar ---------------- */

/**
 * Spend against the pre-debate estimate's typical range. INFORMATION ONLY:
 * nothing in the room reads it and nothing stops on it (wt/budget). There is
 * no cap and no wind-down line; past the typical range it just says so.
 * Snapshots without an estimate (the capped era, or Codex with no per-token
 * bill) draw no bar.
 */
export function BudgetBar({ b, compact }: { b: BudgetSnapshot; compact?: boolean }) {
  const high = b.estimateHighUsd;
  if (!high || b.billing === 'none') return null;
  const ratio = b.spentUsd / high;
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const word = b.state === 'ceiling' ? 'At your ceiling' : ratio > 1 ? 'Past the typical range' : 'Within the typical range';
  const range = `$${(b.estimateLowUsd ?? 0).toFixed(2)}-${high.toFixed(2)}`;
  return (
    <span className={`budget ${b.state === 'ceiling' ? 'ceiling' : 'ok'}${compact ? ' compact' : ''}`}>
      <span
        className="budget-track"
        role="meter"
        aria-label={`Spend, ${b.profile} room`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`$${b.spentUsd.toFixed(2)} spent; a ${b.profile} room typically runs ${range}. Information only, no limit is applied.`}
      >
        <span className="budget-fill" style={{ transform: `scaleX(${pct / 100})` }} />
      </span>
      {!compact && (
        <span className="budget-k">
          {word} ({range}) · information only
        </span>
      )}
    </span>
  );
}

/* ---------------- token + budget meter ---------------- */

const compactN = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + 'K';
  return String(n);
};

export function TokenMeter({ state, expanded }: { state: DebateState; expanded?: boolean }) {
  const [open, setOpen] = useState(!!expanded);
  const u = state.usage;
  const totalIn = u.input + u.cacheWrite + u.cacheRead;
  const total = totalIn + u.output;
  const cachedPct = totalIn > 0 ? Math.round((u.cacheRead / totalIn) * 100) : 0;

  /**
   * The spend meter: information only, estimate vs actual. Nothing stops on
   * it. Old snapshots from the capped era still show their caps.
   */
  const b = state.budget;
  const payg = b?.billing === 'payg';
  const dollars = b && b.billing !== 'none';
  const spent = b ? b.spentUsd : u.costUsd;
  const rows: [string, string, string?][] = [
    ...(b
      ? ([
          ['Room', `${b.profile}${b.state === 'ceiling' ? ' · at your ceiling' : ''}`],
          ...(dollars
            ? ([
                [payg ? 'Spent (your key)' : 'Spent (plan equiv.)', `$${b.spentUsd.toFixed(2)}`],
                ...(b.estimateHighUsd ? [['Typical', `$${(b.estimateLowUsd ?? 0).toFixed(2)}-${b.estimateHighUsd.toFixed(2)}`]] : []),
                ['Projected', `$${b.projectedUsd.toFixed(2)}`],
                ['Limit', b.ceilingUsd ? `your ceiling $${b.ceilingUsd.toFixed(2)}` : b.capUsd ? `$${b.capUsd} (old cap)` : 'none'],
              ] as [string, string][])
            : []),
          ['Flagship calls', String(b.flagshipCalls)],
          ['Spoken turns', String(b.turns)],
        ] as [string, string][])
      : []),
    ['Input', compactN(u.input)],
    ['Output', compactN(u.output)],
    ['Cache write', compactN(u.cacheWrite)],
    ['Cache read', compactN(u.cacheRead), 'cheap'],
    ['Web searches', String(u.webSearches)],
    ['Agent turns', String(u.turns)],
  ];

  return (
    <div className={`meter ${open ? 'open' : ''}`}>
      <button
        className="meter-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={b ? (payg ? 'Live spend on your OpenAI key. Information only: no limit is applied unless you set a ceiling.' : 'Spend, for information. No limit is applied unless you set a ceiling.') : 'Token consumption'}
      >
        {b && <BudgetBar b={b} compact />}
        {(!b || dollars) && (
          <span className={`meter-cost num ${payg ? 'payg' : ''}`}>
            {payg ? 'spent ' : ''}${spent.toFixed(2)}
            {/* Only the founder's own ceiling is ever shown as a limit; an old capped-era cap is not. */}
            {b?.ceilingUsd ? <span className="meter-cap"> / ${b.ceilingUsd.toFixed(0)} ceiling</span> : null}
          </span>
        )}
        {(!b || !dollars) && (
          <>
            <span className="meter-total num">{compactN(total)}</span>
            <span className="meter-unit">tokens</span>
          </>
        )}
        <span className="meter-caret" aria-hidden>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="meter-body">
          {b && <BudgetBar b={b} />}
          {rows.map(([k, v, cls]) => (
            <div key={k} className={`meter-row ${cls ?? ''}`}>
              <span className="meter-k">{k}</span>
              <span className="meter-v num">{v}</span>
            </div>
          ))}
          {cachedPct > 0 && (
            <div className="meter-cached">
              <div className="meter-bar"><span style={{ width: `${cachedPct}%` }} /></div>
              <span className="meter-k">{cachedPct}% of input served from cache</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
