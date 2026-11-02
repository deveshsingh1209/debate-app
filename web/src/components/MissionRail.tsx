import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AgendaItem } from '../../../shared/types';
import type { DebateState } from '../lib/stream';

function glyph(status: AgendaItem['status']): string {
  switch (status) {
    case 'pending':
      return '○'; // ○
    case 'active':
      return '▸'; // ▸
    case 'done':
      return '●'; // ●
    case 'added':
      return '+';
    case 'dropped':
      return '–';
  }
}

export function MissionRail({ state }: { state: DebateState }) {
  const [pulsing, setPulsing] = useState(false);
  const [openResearch, setOpenResearch] = useState<Record<string, boolean>>({});

  // Pulse the plan panel when a revision bump arrives.
  useEffect(() => {
    if (state.planPulse === 0) return;
    setPulsing(true);
    const t = setTimeout(() => setPulsing(false), 3000);
    return () => clearTimeout(t);
  }, [state.planPulse]);

  return (
    <div className="rail-scroll">
      {state.dossier && (
        <div className="rail-sec">
          <span className="chip cyan" title={state.dossier.brief}>
            <span className="dot" />
            Dossier loaded ({state.dossier.files} file{state.dossier.files === 1 ? '' : 's'})
          </span>
        </div>
      )}
      <div className="rail-sec">
        <div className="sec-head">
          <span className="uplabel bright">Agenda</span>
          {state.plan && state.plan.revision > 1 && <span className="uplabel">Revised {state.plan.revision - 1}×</span>}
        </div>
        <div className={`panel plan-panel ${pulsing ? 'pulsing' : ''}`} style={{ padding: '6px 8px' }}>
          {state.plan ? (
            <>
              <AnimatePresence>
                {pulsing && state.plan.rationale && (
                  <motion.div
                    className="plan-rationale"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                  >
                    {state.plan.rationale}
                  </motion.div>
                )}
              </AnimatePresence>
              {state.plan.items.map((it) => (
                <div key={it.id} className={`agenda-item ${it.status}`} title={it.detail}>
                  <span className="g">{glyph(it.status)}</span>
                  <span className="t">{it.title}</span>
                </div>
              ))}
            </>
          ) : (
            <div className="uplabel" style={{ padding: '12px 6px', display: 'block' }}>
              No agenda yet
            </div>
          )}
        </div>
      </div>

      <div className="rail-sec">
        <div className="sec-head">
          <span className="uplabel bright">Research</span>
          {state.researchOrder.length > 0 && (
            <span className="uplabel">{state.researchOrder.length} {state.researchOrder.length === 1 ? 'question' : 'questions'}</span>
          )}
        </div>
        {state.researchOrder.length === 0 && (
          <div className="uplabel" style={{ display: 'block', padding: '4px 2px' }}>
            Nothing looked up yet. Experts send questions here when they need facts.
          </div>
        )}
        {state.researchOrder.map((tid) => {
          const t = state.research[tid];
          if (!t) return null;
          const open = openResearch[tid] ?? false;
          return (
            <div key={tid} className="research-item">
              <div className="rstat">
                {t.status === 'started' ? (
                  <>
                    <span className="spin-glyph">◌</span>
                    <span className="uplabel" style={{ color: 'var(--amber)' }}>
                      Running
                    </span>
                  </>
                ) : (
                  <>
                    <span className="r-done" aria-hidden>●</span>
                    <span className="uplabel" style={{ color: 'var(--green)' }}>
                      Done
                    </span>
                  </>
                )}
              </div>
              <div
                className="rq"
                role={t.summary ? 'button' : undefined}
                tabIndex={t.summary ? 0 : undefined}
                aria-expanded={t.summary ? open : undefined}
                onClick={() => setOpenResearch((m) => ({ ...m, [tid]: !open }))}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenResearch((m) => ({ ...m, [tid]: !open })); } }}
              >
                {t.question || 'Research task'}
                {t.summary && <span className="r-more">{open ? 'Hide' : 'Read'}</span>}
              </div>
              <AnimatePresence>
                {open && t.summary && (
                  <motion.div className="rs" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                    {t.summary}
                    {/* The sources, with how each was attested (2b-4). Links only for http(s). */}
                    {t.citations && t.citations.length > 0 && (
                      <ol className="rs-sources">
                        {t.citations.map((c) => (
                          <li key={c.id} className={c.provenance === 'model_reported' ? 'unattested' : undefined}>
                            <span className="mono">{c.id}</span>{' '}
                            {/^https?:\/\//.test(c.url) ? <a href={c.url} target="_blank" rel="noopener noreferrer">{c.title || c.url}</a> : c.title || c.url}
                            {c.provenance === 'model_reported' && <span className="rs-prov"> · reported by the model, not attested by the tool</span>}
                          </li>
                        ))}
                      </ol>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {(state.assumptions.length > 0 || state.config?.autonomy === 'autonomous') && (
        <div className="rail-sec">
          <div className="sec-head">
            <span className="uplabel" style={{ color: 'var(--amber)' }}>
              Assumptions log
            </span>
            <span className="uplabel">{state.assumptions.length}</span>
          </div>
          {state.assumptions.length === 0 && (
            <div className="uplabel" style={{ display: 'block', padding: '4px 2px' }}>
              None logged yet
            </div>
          )}
          {state.assumptions.map((a, i) => (
            <motion.div key={i} className="assump-item" initial={{ opacity: 1, x: 14 }} animate={{ opacity: 1, x: 0 }} transition={{ type: 'spring', stiffness: 190, damping: 22 }}>
              <span className="ag">!</span>
              <span>{a}</span>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
