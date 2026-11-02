import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { BudgetProfile, DiversityFlag, Persona, SessionScope } from '../../../shared/types';
import { BUDGET_PROFILES } from '../../../shared/budget';
import type { ClarifyChainItem, DebateActions, DebateState } from '../lib/stream';
import { ApiError } from '../lib/api';
import { Brackets } from './hud';
import { NotifyToggle } from './NotifyToggle';
import { primeNotifications } from '../lib/notify';

/* ---------------- revise affordance ---------------- */

function ReviseBox({
  onSend,
  onCancel,
  busy,
  placeholder,
}: {
  onSend: (feedback: string) => void;
  onCancel: () => void;
  busy: boolean;
  placeholder: string;
}) {
  const [text, setText] = useState('');
  return (
    <motion.div initial={{ opacity: 1, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} style={{ width: '100%' }}>
      <textarea className="field" rows={2} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      <div className="dock-actions" style={{ marginTop: 8 }}>
        <button className="btn warn sm" disabled={busy || !text.trim()} onClick={() => onSend(text.trim())}>
          Send revision
        </button>
        <button className="btn sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </motion.div>
  );
}

function ApproveRow({
  approveLabel,
  onApprove,
  onRevise,
  busy,
  revisePlaceholder,
}: {
  approveLabel: string;
  onApprove: () => void;
  onRevise: (feedback: string) => void;
  busy: boolean;
  revisePlaceholder: string;
}) {
  const [revising, setRevising] = useState(false);
  return (
    <div className="dock-actions">
      {!revising && (
        <>
          <button className="btn primary" onClick={onApprove} disabled={busy}>
            {approveLabel}
          </button>
          <button className="btn warn" onClick={() => setRevising(true)} disabled={busy}>
            Revise
          </button>
        </>
      )}
      {revising && <ReviseBox busy={busy} placeholder={revisePlaceholder} onSend={onRevise} onCancel={() => setRevising(false)} />}
    </div>
  );
}

/* ---------------- question / clarify ---------------- */

function OptionsCard({
  kicker,
  question,
  context,
  options,
  allowCustom,
  busy,
  onAnswer,
}: {
  kicker: string;
  question: string;
  context?: string;
  options: { label: string; description?: string }[];
  allowCustom: boolean;
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [custom, setCustom] = useState('');
  return (
    <div className="dock-card">
      <div className="dock-kicker">
        <span className="chip amber pulse">
          <span className="dot" />
          {kicker}
        </span>
      </div>
      <div className="dock-title">{question}</div>
      {context && <div className="dock-context">{context}</div>}
      <div className="opt-grid">
        {options.map((o) => (
          <button key={o.label} className="opt-card" disabled={busy} onClick={() => onAnswer(o.label)}>
            <div className="ol">{o.label}</div>
            {o.description && <div className="od">{o.description}</div>}
          </button>
        ))}
      </div>
      {allowCustom && (
        <div className="custom-row">
          <input
            className="field"
            placeholder="or type your own"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && custom.trim()) onAnswer(custom.trim());
            }}
          />
          <button className="btn outline-cyan" disabled={busy || !custom.trim()} onClick={() => onAnswer(custom.trim())}>
            Send
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------- clarify chain ---------------- */

/**
 * One question of a clarify batch. Keyed by questionId from the parent so the
 * custom-text field resets naturally when the founder steps between questions.
 * An already-given answer renders selected (or prefilled, if it was typed) and
 * stays editable; `locked` means the server refused to reopen it.
 */
function ClarifyStep({
  item,
  step,
  total,
  busy,
  locked,
  onSubmit,
  onBack,
  onNext,
}: {
  item: ClarifyChainItem;
  step: number;
  total: number;
  busy: boolean;
  locked: boolean;
  onSubmit: (answer: string) => void;
  onBack?: () => void;
  onNext?: () => void;
}) {
  const q = item.ev;
  const given = item.answer;
  const [custom, setCustom] = useState(given !== null && !q.options.includes(given) ? given : '');
  return (
    <div className="dock-card">
      <div className="dock-kicker">
        <span className="chip amber pulse">
          <span className="dot" />
          Clarification needed
        </span>
        {total > 1 && (
          <span className="dock-progress">
            Question {step} of {total}
          </span>
        )}
      </div>
      <div className="dock-title">{q.question}</div>
      {given !== null && !locked && (
        <div className="dock-context">
          Answered. Pick a different option or edit the text to change it — or Next to leave it as is.
        </div>
      )}
      {locked && (
        <div className="feed-note warn" style={{ margin: '8px 0 2px' }}>
          <b>Already taken</b>
          The panel has already taken this answer{given !== null ? ` ("${given}")` : ''} — it can no longer be changed.
        </div>
      )}
      <div className="opt-grid">
        {q.options.map((o) => (
          <button key={o} className={`opt-card${given === o ? ' sel' : ''}`} disabled={busy || locked} onClick={() => onSubmit(o)}>
            <div className="ol">{o}</div>
          </button>
        ))}
      </div>
      {q.allowCustom && !locked && (
        <div className="custom-row">
          <input
            className="field"
            placeholder={given !== null ? 'or type a different answer' : 'or type your own'}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && custom.trim()) onSubmit(custom.trim());
            }}
          />
          <button className="btn outline-cyan" disabled={busy || !custom.trim()} onClick={() => onSubmit(custom.trim())}>
            {given !== null ? 'Amend' : 'Send'}
          </button>
        </div>
      )}
      {(onBack || onNext) && (
        <div className="dock-actions">
          {onBack && (
            <button className="btn sm" disabled={busy} onClick={onBack}>
              ‹ Back
            </button>
          )}
          {onNext && (
            <button className="btn sm" disabled={busy} onClick={onNext}>
              Next ›
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A batch of clarifying questions walked as one chain instead of N surprise
 * modals. The founder sees where he is ("Question 2 of 3") and can step Back
 * to an answer already given and change it.
 *
 * Answers still go to the server one at a time, the moment they are given, so
 * an answered question survives a dead tab. Re-sending a changed answer relies
 * on the server amending the stored one; a server that cannot amend (or a
 * batch the engine has already consumed) answers 409, which is surfaced as
 * "already taken" on that question rather than as an error. A single question
 * (total === 1) renders with none of the chain chrome — exactly the old card.
 */
function ClarifyChain({
  chain,
  onAnswer,
}: {
  chain: ClarifyChainItem[];
  onAnswer: (questionId: string, answer: string) => Promise<void>;
}) {
  const total = chain.length;
  const firstOpen = chain.findIndex((it) => it.answer === null);
  const [cursor, setCursor] = useState(firstOpen === -1 ? 0 : firstOpen);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Questions the server refused to reopen: the panel already holds these.
  const [taken, setTaken] = useState<Record<string, true>>({});

  // The chain can shrink if the batch is answered from another tab; never
  // point past the end of it.
  const k = Math.min(cursor, total - 1);
  const item = chain[k];

  const goTo = (i: number) => {
    setErr(null);
    setCursor(i);
  };

  /** After answering question k, walk to the next unanswered question. */
  const advance = () => {
    // The answer event may not have folded yet, so treat k as answered here.
    const after = chain.findIndex((it, i) => i > k && it.answer === null);
    if (after !== -1) return goTo(after);
    const anywhere = chain.findIndex((it, i) => i !== k && it.answer === null);
    if (anywhere !== -1) return goTo(anywhere);
    // Nothing left: the dock closes when the last answer event folds.
  };

  const submit = async (ans: string) => {
    const qid = item.ev.questionId;
    if (item.answer !== null && item.answer === ans) {
      // Nothing changed — walking on costs nothing and sends nothing.
      advance();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onAnswer(qid, ans);
      advance();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Today's engine keeps the first answer it was given; an upgraded
        // engine says this only once the batch is consumed. Either way the
        // truth for the founder is the same: this answer is already taken.
        setTaken((t) => ({ ...t, [qid]: true }));
      } else {
        setErr(e instanceof Error ? e.message : 'That did not go through. Try again.');
      }
    } finally {
      // Pendings clear via the event stream; small grace period keeps buttons calm.
      setTimeout(() => setBusy(false), 400);
    }
  };

  const locked = !!taken[item.ev.questionId];
  return (
    <>
      {err && (
        <div className="feed-note err" style={{ margin: '0 0 10px' }}>
          <b>Not sent</b>
          {err}
        </div>
      )}
      <ClarifyStep
        key={item.ev.questionId}
        item={item}
        step={k + 1}
        total={total}
        busy={busy}
        locked={locked}
        onSubmit={submit}
        onBack={k > 0 ? () => goTo(k - 1) : undefined}
        onNext={k < total - 1 && (item.answer !== null || locked) ? () => goTo(k + 1) : undefined}
      />
    </>
  );
}

/* ---------------- panel reveal ---------------- */

function HoloCard({ p, index, reputation }: { p: Persona; index: number; reputation?: string }) {
  const [open, setOpen] = useState(false);
  const style = { '--pc': p.color } as React.CSSProperties;
  return (
    <motion.div
      className="holo-card"
      style={style}
      onClick={() => setOpen((o) => !o)}
      initial={{ opacity: 1, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34, delay: 0.08 + Math.min(index, 8) * 0.07 }}
    >
      <div className="holo-mono">{p.initials}</div>
      <div className="holo-name">
        {p.name}
        {p.isModerator && <span className="mod-badge">Chair</span>}
      </div>
      <div className="holo-role">{p.role}</div>
      <div className="holo-tagline">“{p.tagline}”</div>
      <div className="holo-chips">
        {p.expertise.slice(0, open ? undefined : 3).map((e) => (
          <span key={e} className="holo-chip">
            {e}
          </span>
        ))}
      </div>
      {open && (
        <motion.div className="holo-detail" initial={{ opacity: 1 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
          {reputation && (
            <>
              <span className="uplabel">Known for</span>
              {reputation}
            </>
          )}
          <span className="uplabel">Bio</span>
          {p.bio}
          <span className="uplabel">Personality</span>
          {p.personality}
          <span className="uplabel">Biases</span>
          {p.biases}
          <span className="uplabel">Style</span>
          {p.style}
        </motion.div>
      )}
    </motion.div>
  );
}

export function PanelReveal({
  personas,
  rationale,
  reputations = {},
  diversity = null,
  busy,
  onApprove,
  onRevise,
}: {
  personas: Persona[];
  rationale: string | null;
  reputations?: Record<string, string>;
  diversity?: DiversityFlag | null;
  busy: boolean;
  onApprove: () => void;
  onRevise: (feedback: string) => void;
}) {
  const [revising, setRevising] = useState(false);
  return (
    <motion.div className="reveal-veil" initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }}>
      <div className="reveal-head">
        <h2>The proposed panel</h2>
        {rationale && (
          <motion.p className="reveal-rationale" initial={{ opacity: 1 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}>
            {rationale}
          </motion.p>
        )}
        {diversity && !diversity.ok && (
          <div className="reveal-flag" role="note">
            <strong>These experts may sound too alike.</strong> {diversity.problems.join(' ')} You can approve them as they are, or press Revise and ask for a different mix.
          </div>
        )}
      </div>
      <div className="holo-grid">
        {personas.map((p, i) => (
          <HoloCard key={p.id} p={p} index={i} reputation={reputations[p.id]} />
        ))}
      </div>
      <motion.div
        className="reveal-actions"
        initial={{ opacity: 1, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 + Math.min(personas.length, 8) * 0.07, type: 'spring', stiffness: 380, damping: 34 }}
      >
        {!revising ? (
          <>
            <button className="btn primary lg" onClick={onApprove} disabled={busy}>
              Approve panel
            </button>
            <button className="btn warn lg" onClick={() => setRevising(true)} disabled={busy}>
              Revise
            </button>
          </>
        ) : (
          <div style={{ width: 'min(560px, 90%)' }}>
            <ReviseBox
              busy={busy}
              placeholder="What should change about the roster? Swap an expert, shift the balance, add a domain."
              onSend={onRevise}
              onCancel={() => setRevising(false)}
            />
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

/* ---------------- the dock ---------------- */

/**
 * The chair's sizing, stated before the session runs.
 *
 * Deliberately NOT a set of dials. The founder hires the panel the way you
 * hire a consultant: he says what he wants decided, the chair says what that
 * takes and what it costs, and pushback happens in words through the same
 * revise box as everything else ("this feels too big, two motions is plenty").
 * The first version fixed the shape in prompt text and the founder discovered
 * the price when the meter had already run; the failed second draft swung the
 * other way and asked him to pick expert counts himself, which is the chair's
 * job, not his.
 */
function ScopeCard({ scope, onProfile }: { scope: SessionScope; onProfile?: (p: BudgetProfile) => Promise<void> }) {
  const { estimate: est } = scope;
  const [busy, setBusy] = useState(false);
  return (
    <div className="scope-card">
      <div className="sc-head">
        <span className="label brass">The chair's sizing</span>
        {est.highUsd > 0 && (
          <span className="sc-est num" title="Uncalibrated estimate; actual cost may be much higher. No limit is applied.">
            Unverified estimate: ~${est.lowUsd.toFixed(2)}<span className="sc-dash">–</span>${est.highUsd.toFixed(2)}
          </span>
        )}
      </div>
      <div className="sc-shape">
        <span><b className="num">{scope.motions}</b> motion{scope.motions === 1 ? '' : 's'}</span>
        <span className="sc-sep" />
        <span><b className="num">{scope.experts}</b> experts</span>
        <span className="sc-sep" />
        <span><b className="num">{scope.roundsPerMotion}</b> rounds each</span>
        <span className="sc-sep" />
        <span>{scope.depth} depth</span>
      </div>
      {scope.rationale && <div className="sc-why">{scope.rationale}</div>}
      {est.profile && (
        <div className="sc-profile">
          <span>
            <b>{BUDGET_PROFILES[est.profile].label} room.</b> {est.profileReason ?? BUDGET_PROFILES[est.profile].blurb}
          </span>
          {onProfile &&
            (Object.keys(BUDGET_PROFILES) as BudgetProfile[])
              .filter((p) => p !== est.profile)
              .map((p) => (
                <button
                  key={p}
                  className="btn sm ghost"
                  disabled={busy}
                  title={BUDGET_PROFILES[p].blurb}
                  onClick={() => { setBusy(true); onProfile(p).finally(() => setBusy(false)); }}
                >
                  Use {BUDGET_PROFILES[p].label.toLowerCase()}
                </button>
              ))}
        </div>
      )}
      {/* Estimates from the capped era (2b-2) still show what they promised. */}
      {est.caps && !est.profile && (
        <div className="sc-caps">
          <b>{est.caps.profile[0].toUpperCase() + est.caps.profile.slice(1)} budget, caps at the time:</b>{' '}
          {est.caps.usdCap !== null && <>${est.caps.usdCap} · </>}
          {est.caps.flagshipCap} flagship calls · {est.caps.turnCap} spoken turns. No longer applied.
        </div>
      )}
      <div className="sc-basis">
        <b>{est.turns} agent turns projected.</b> {est.basis} Too big or too small? Say so in a revision and the session is re-sized with the goal.
      </div>
    </div>
  );
}

export function Dock({ state, actions }: { state: DebateState; actions: DebateActions }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  /**
   * Publish the dock's real height so the transcript can reserve exactly that
   * much. The feed used to hardcode 120px while this card grows past 800px
   * with a multi-option question, so the newest messages — the ones being
   * ruled on — sat underneath it with no scroll left to reach them.
   */
  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el) {
      root.style.removeProperty('--dock-h');
      return;
    }
    const ro = new ResizeObserver(([entry]) => {
      root.style.setProperty('--dock-h', `${Math.ceil(entry.contentRect.height)}px`);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--dock-h');
    };
  });

  const fire = async (fn: () => Promise<void>) => {
    void primeNotifications(); // an answer or approval click is a gesture; ask here if never asked
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      // A silent failure here is the worst case: the card stays up looking
      // wedged and the user has no idea their approval never landed.
      setErr(e instanceof Error ? e.message : 'That did not go through. Try again.');
    } finally {
      // Pendings clear via the event stream; small grace period keeps buttons calm.
      setTimeout(() => setBusy(false), 400);
    }
  };

  const approval = state.pendingApproval;
  const question = state.pendingQuestion;
  /**
   * The clarify batch renders as one navigable chain, not pendingClarify[0]
   * as N sequential modals. The fallback rebuild covers a state where pending
   * questions exist without a chain (should not happen — both fold from the
   * same events — but a wedged dock with no way to answer is the worst case).
   */
  const chain =
    state.clarifyChain ?? (state.pendingClarify.length ? state.pendingClarify.map((ev) => ({ ev, answer: null })) : null);
  const clarifyOpen = !!chain && chain.some((it) => it.answer === null);

  // Panel approval renders as the full reveal overlay, not the bottom dock.
  const showPanelReveal = approval === 'panel' && state.personaOrder.length > 0;
  const dockContent = !showPanelReveal && (approval === 'goal' || approval === 'plan' || question || clarifyOpen);

  return (
    <>
      {/* No AnimatePresence on state-critical chrome: a wedged exit/enter
          handshake must never be able to hide an approval or question card. */}
      {showPanelReveal && (
        <PanelReveal
          key={`reveal-${state.panelRationale ?? ''}`}
          personas={state.personaOrder.map((id) => state.personas[id]).filter(Boolean)}
          rationale={state.panelRationale}
          reputations={state.reputations}
          diversity={state.panelDiversity}
          busy={busy}
          onApprove={() => fire(() => actions.approve('panel', 'approve'))}
          onRevise={(fb) => fire(() => actions.approve('panel', 'revise', fb))}
        />
      )}

      {dockContent && (
          <motion.div
            ref={ref}
            className="dock"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 210, damping: 26 }}
          >
            <Brackets tone="warn" />
            {err && <div className="feed-note err" style={{ margin: '0 0 10px' }}><b>Not sent</b>{err}</div>}
            {approval === 'goal' && state.goal && (
              <div className="dock-card">
                <div className="dock-kicker">
                  <span className="chip amber pulse">
                    <span className="dot" />
                    Goal approval required
                  </span>
                </div>
                <div className="dock-title">{state.goal.title}</div>
                <div className="dock-body">{state.goal.goal}</div>
                {state.scope && <ScopeCard scope={state.scope} onProfile={state.config?.profile ? actions.setProfile : undefined} />}
                <NotifyToggle compact />
                <ApproveRow
                  key={state.goal.goal}
                  approveLabel="Approve goal"
                  busy={busy}
                  onApprove={() => fire(() => actions.approve('goal', 'approve'))}
                  onRevise={(fb) => fire(() => actions.approve('goal', 'revise', fb))}
                  revisePlaceholder="What should the goal say instead?"
                />
              </div>
            )}

            {approval === 'plan' && (
              <div className="dock-card">
                <div className="dock-kicker">
                  <span className="chip amber pulse">
                    <span className="dot" />
                    Agenda approval required
                  </span>
                </div>
                <div className="dock-title">Opening discussion plan</div>
                <div className="dock-body agenda-preview">
                  {state.plan?.items.map((it, i) => (
                    <div key={it.id} className="agenda-item pending">
                      <span className="g mono" style={{ color: 'var(--cyan)' }}>
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span className="t">
                        <span style={{ color: 'var(--txt)' }}>{it.title}</span>
                        {it.detail && <span style={{ color: 'var(--faint)' }}> · {it.detail}</span>}
                      </span>
                    </div>
                  ))}
                </div>
                <ApproveRow
                  key={`plan-${state.plan?.revision ?? 0}-${state.plan?.rationale ?? ''}`}
                  approveLabel="Approve plan"
                  busy={busy}
                  onApprove={() => fire(() => actions.approve('plan', 'approve'))}
                  onRevise={(fb) => fire(() => actions.approve('plan', 'revise', fb))}
                  revisePlaceholder="What should change in the agenda?"
                />
              </div>
            )}

            {question && (
              <OptionsCard
                key={question.questionId}
                kicker="Marcus needs your call"
                question={question.question}
                context={question.context}
                options={question.options}
                allowCustom={question.allowCustom}
                busy={busy}
                onAnswer={(ans) => fire(() => actions.answer(question.questionId, ans))}
              />
            )}

            {clarifyOpen && !question && chain && (
              <ClarifyChain
                key={chain[0]?.ev.questionId ?? 'clarify'}
                chain={chain}
                onAnswer={(qid, ans) => actions.answer(qid, ans)}
              />
            )}
          </motion.div>
      )}
    </>
  );
}
