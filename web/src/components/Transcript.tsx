import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Concession, Persona } from '../../../shared/types';
import type { DebateState, FeedItem, MessageEv, StreamingMsg } from '../lib/stream';
import { DIVIDER_LABEL, fmtTime, statusIsLive } from '../lib/format';
import { MODEL_INFO, modelName } from '../../../shared/models';

// Chrome colours come from the design tokens, so they follow the theme.
const RESEARCH_COLOR = 'var(--info)';
const USER_COLOR = 'var(--text)';

/**
 * `userName` is FOUNDER_NAME when set. 'You' is the fallback: vague but
 * never wrong.
 */
function speakerMeta(
  speaker: string,
  personas: Record<string, Persona>,
  userName?: string | null
): { name: string; color: string } {
  if (speaker === 'research') return { name: 'Research desk', color: RESEARCH_COLOR };
  if (speaker === 'user') return { name: userName || 'You', color: USER_COLOR };
  const p = personas[speaker];
  return { name: p?.name ?? speaker, color: p?.color ?? 'var(--dim)' };
}

function bubbleClass(kind: string): string {
  switch (kind) {
    case 'interjection':
      return 'bubble interject';
    case 'research':
      return 'bubble research';
    case 'marcus':
      return 'bubble marcus';
    case 'user':
      return 'bubble user';
    case 'closing':
      return 'bubble closing';
    case 'reaction':
      return 'bubble reaction';
    default:
      return 'bubble';
  }
}

/** Long briefs are clamped by default: the feed must stay readable. */
function DossierDrop({ files, brief }: { files: number; brief: string }) {
  const [open, setOpen] = useState(false);
  const long = brief.length > 600;
  return (
    <div className="dossier-drop">
      <b>Context dossier / {files} file{files === 1 ? '' : 's'} ingested</b>
      <div className={!open && long ? 'drop-clamp' : undefined}>{brief}</div>
      {long && (
        <button className="drop-more" onClick={() => setOpen(!open)}>
          {open ? 'Collapse brief' : `Read full brief (${Math.round(brief.length / 5)} words)`}
        </button>
      )}
    </div>
  );
}

const Bubble = memo(function Bubble({
  ev,
  personas,
  userName,
  streamingText,
  overName,
  spokenOver,
}: {
  ev: Pick<MessageEv, 'speaker' | 'kind' | 'text'> & Partial<Pick<MessageEv, 'cutOff' | 'claims'>> & { ts?: number };
  personas: Record<string, Persona>;
  userName?: string | null;
  streamingText?: boolean;
  /** Who this turn talked over, already resolved to a name. */
  overName?: string | null;
  /** Someone talked over the end of this turn: from which character, and who. */
  spokenOver?: { fromChar: number; by: string } | null;
}) {
  const meta = speakerMeta(ev.speaker, personas, userName);
  const style = { '--sc': meta.color } as CSSProperties;
  const cut = ev.cutOff ? speakerMeta(ev.cutOff.by, personas, userName) : null;
  const cls = `${bubbleClass(ev.kind)}${cut ? ' is-cut' : ''}${overName ? ' is-over' : ''}${streamingText ? ' is-live' : ''}`;

  // The words someone else was already speaking over, set apart so the
  // overlap reads on the line itself, not only in a tag.
  const split = spokenOver && spokenOver.fromChar > 0 && spokenOver.fromChar < ev.text.length ? spokenOver.fromChar : null;

  return (
    <div className={cls} style={style} data-streaming={streamingText ? '1' : undefined}>
      <div className="bub-head">
        <span className="bub-name">{meta.name}</span>
        {ev.kind === 'interjection' && <span className="bub-tag intr">Interrupts</span>}
        {overName && <span className="bub-tag over">over {overName}</span>}
        {ev.kind === 'research' && <span className="bub-tag rsc">Research desk</span>}
        {ev.kind === 'closing' && <span className="bub-tag closing">Closing</span>}
        {ev.ts && <span className="bub-time num">{fmtTime(ev.ts)}</span>}
      </div>
      <div className="bub-body">
        {split !== null ? (
          <>
            {ev.text.slice(0, split)}
            <span className="spoken-over" title={`${spokenOver!.by} was already talking over this`}>{ev.text.slice(split)}</span>
          </>
        ) : (
          ev.text
        )}
        {cut && (
          <span className="bub-cut" style={{ '--pc': cut.color } as CSSProperties}>
            <span className="cut-rule" aria-hidden />
            <span className="cut-by">cut off by {cut.name}</span>
          </span>
        )}
        {streamingText && <span className="stream-caret" aria-hidden />}
      </div>
      {/* Evidence grades travel beside the speech now, not inside it (Phase 2b-3). */}
      {ev.claims && ev.claims.length > 0 && (
        <div className="bub-claims">
          {ev.claims.map((c, i) => (
            <span
              className="claim-chip"
              key={i}
              title={
                c.said && c.said !== c.grade
                  ? `${c.grade}: the speaker said ${c.said}, but nothing the founder or a cited source supplied backs it`
                  : c.grade === 'persona'
                    ? "persona: the panelist's own illustrative experience, not evidence about this business"
                    : `${c.grade}: the speaker's own grade for this claim`
              }
            >
              <span className={`grade ${c.grade}`}>{c.grade}</span> {c.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

const PAUSE_LABEL: Record<string, string> = {
  after_concession: 'A pause after that concession',
  unanswered: 'Nobody answers',
  tension: 'Silence in the room',
  chair: 'The chair waits',
};

/**
 * A silence, shown as one: the reason, its length, and (only when it arrives
 * while you watch) a hairline that runs for exactly as long as the room was
 * quiet. A reloaded debate shows the same beat, still.
 */
function PauseBeat({ ms, reason, live }: { ms: number; reason: string; live: boolean }) {
  const secs = Math.max(1, Math.round(ms / 1000));
  return (
    <div className={`pause-beat${live ? ' live' : ''}`} style={{ '--pause-ms': `${ms}ms` } as CSSProperties} role="note">
      <span className="pb-dots" aria-hidden><i /><i /><i /></span>
      <span className="pb-label">{PAUSE_LABEL[reason] ?? 'A pause'}</span>
      <span className="pb-len num">{secs}s</span>
      <span className="pb-run" aria-hidden />
    </div>
  );
}

const STANCES = [-2, -1, 0, 1, 2] as const;
const STANCE_WORD: Record<number, string> = { [-2]: 'firmly against', [-1]: 'leaning against', 0: 'undecided', 1: 'leaning for', 2: 'firmly for' };
const CONCESSION_KIND: Record<Concession['kind'], string> = {
  full: 'Concedes the point',
  partial: 'Gives ground',
  conditional: 'Concedes, on a condition',
  tactical: 'Gives ground, tactically',
};
const MOVED_BY: Record<Concession['movedBy']['kind'], string> = {
  evidence: 'the evidence',
  computation: 'a computed figure',
  argument: 'an argument',
  falsifier: 'a falsifier',
  founder: 'the founder',
  social: 'pressure in the room',
  unexplained: 'nothing stated',
};

/**
 * A belief changing is the event the whole room exists to produce, so it gets
 * its own card: who moved, from where to where on the motion, what moved
 * them, and what it cost them. The scale is the motion, against to for.
 */
function ConcessionCard({ c, personas, userName }: { c: Concession; personas: Record<string, Persona>; userName?: string | null }) {
  const who = speakerMeta(c.expert, personas, userName);
  const by = c.movedBy.who ? speakerMeta(c.movedBy.who, personas, userName).name : null;
  const from = Math.round(c.from.stance);
  const to = Math.round(c.to.stance);
  const hasScale = Number.isFinite(from) && Number.isFinite(to) && Math.abs(from) <= 2 && Math.abs(to) <= 2;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return (
    <div className="concession" style={{ '--sc': who.color } as CSSProperties}>
      <div className="cn-head">
        <span className="cn-who">{who.name}</span>
        <span className="cn-kind">{CONCESSION_KIND[c.kind] ?? 'Moves'}</span>
      </div>
      {hasScale && (
        <div
          className="cn-scale"
          role="img"
          aria-label={`From ${STANCE_WORD[from]} (${c.from.confidence} confidence) to ${STANCE_WORD[to]} (${c.to.confidence} confidence)`}
        >
          <span className="cn-end">Against</span>
          <span className="cn-track">
            <span
              className={`cn-span ${to > from ? 'up' : 'down'}`}
              style={{ left: `${((lo + 2) / 4) * 100}%`, width: `${((hi - lo) / 4) * 100}%` }}
            />
            {STANCES.map((s) => (
              <span
                key={s}
                className={`cn-stop${s === from ? ' from' : ''}${s === to ? ' to' : ''}`}
                style={{ left: `${((s + 2) / 4) * 100}%` }}
              />
            ))}
          </span>
          <span className="cn-end">For</span>
        </div>
      )}
      <div className="cn-meta">
        {hasScale && (
          <span>
            {STANCE_WORD[from]} → <b>{STANCE_WORD[to]}</b>
          </span>
        )}
        <span>
          moved by {MOVED_BY[c.movedBy.kind] ?? c.movedBy.kind}
          {by ? ` (${by})` : ''}
        </span>
      </div>
      {c.cost && <div className="cn-cost">What it cost: {c.cost}</div>}
    </div>
  );
}

function ComputeCard({ item }: { item: Extract<FeedItem, { fk: 'compute' }> }) {
  const [showWork, setShowWork] = useState(false);
  if (!item.computable) {
    return (
      <div className="quant-card dead">
        <div className="dc-head">
          <span className="label brass">Quant desk</span>
          <span className="grade assumed">not computable</span>
        </div>
        <div className="qc-q">{item.question}</div>
        <div className="dc-text">{item.answer}</div>
      </div>
    );
  }
  return (
    <div className="quant-card">
      <div className="dc-head">
        <span className="label brass">Quant desk</span>
        <span className="grade measured">measured</span>
      </div>
      <div className="qc-q">{item.question}</div>
      {item.figures.length > 0 && (
        <div className="qc-figs">
          {item.figures.map((f, i) => (
            <div className="qc-fig" key={i}>
              <span className="qf-v num">{f.value}</span>
              <span className="qf-l">{f.label}</span>
              {f.source && <span className="qf-s mono">{f.source}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="dc-text">{item.answer}</div>
      {item.reconciles !== null && (
        <div className={`qc-rec ${item.reconciles ? 'ok' : 'bad'}`}>
          {item.reconciles ? 'Figures reconcile against the totals in the source.' : 'These figures do NOT reconcile against the source totals.'}
        </div>
      )}
      {item.caveats.length > 0 && (
        <div className="qc-caveats">
          <span className="label">Caveats</span>
          {item.caveats.map((c, i) => <div key={i}>{c}</div>)}
        </div>
      )}
      {item.method && (
        <>
          <button className="drop-more" onClick={() => setShowWork(!showWork)}>
            {showWork ? 'Hide the work' : 'Show the work'}
          </button>
          {showWork && <pre className="qc-method mono">{item.method}</pre>}
        </>
      )}
    </div>
  );
}

function FeedRow({
  item,
  personas,
  userName,
  speakerOfMsg,
  overlapOf,
  live,
}: {
  item: FeedItem;
  personas: Record<string, Persona>;
  userName?: string | null;
  /** Message id -> speaker id, so an overlap can name who it talked over. */
  speakerOfMsg: Map<string, string>;
  /** Message id -> the turn that talked over it, from which character. */
  overlapOf: Map<string, { fromChar: number; speaker: string }>;
  /** This row arrived while the founder was watching. */
  live: boolean;
}) {
  switch (item.fk) {
    case 'msg': {
      const over = item.ev.overlap ? speakerOfMsg.get(item.ev.overlap.with) : undefined;
      const under = overlapOf.get(item.ev.id);
      return (
        <Bubble
          ev={{ ...item.ev, ts: item.ev.ts }}
          personas={personas}
          userName={userName}
          overName={over ? speakerMeta(over, personas, userName).name : null}
          spokenOver={under ? { fromChar: under.fromChar, by: speakerMeta(under.speaker, personas, userName).name } : null}
        />
      );
    }
    case 'aside':
      return (
        <div className="aside-line">
          <span className="aside-k">Aside</span>
          <span>
            <b>{speakerMeta(item.from, personas, userName).name}</b> to <b>{speakerMeta(item.to, personas, userName).name}</b>, quietly: {item.text}
          </span>
        </div>
      );
    case 'pause':
      return <PauseBeat ms={item.ms} reason={item.reason} live={live} />;
    case 'concession':
      return <ConcessionCard c={item.concession} personas={personas} userName={userName} />;
    case 'phase': {
      const label = DIVIDER_LABEL[item.status];
      if (!label) return null;
      const cls = item.status === 'meeting' || item.status === 'wrapup' || item.status === 'complete' ? 'major' : item.status === 'paused' ? 'amber' : '';
      return (
        <div className={`divider ${cls}`}>
          <span className="dv-line" />
          <span className="dv-label">{label}</span>
          <span className="dv-line" />
        </div>
      );
    }
    case 'system':
      return <div className="sys-line">{item.text}</div>;
    case 'casting': {
      /**
       * Which model runs which job. Fixed by the product (shared/models.ts);
       * older debates may also show re-casts from when the chair chose.
       * Ids the app no longer knows render as the raw id.
       */
      const c = item.casting;
      const LABEL: Record<string, string> = {
        chair: 'Marcus, the chair',
        floor: 'Experts on the floor',
        referee: 'Round referee',
        research: 'Research desk',
        ruling: 'Writing the rulings',
        summon: 'Seating a new expert',
        report: 'The final report',
        dossier: 'Reading the dossier',
        quant: 'The quant desk',
        repair: 'Fitting the report to the page',
        lint: 'Rewriting memo-like turns',
        react: 'Listener reactions',
        clerk: 'Starting stances and crux matching',
        persona: 'Writing the experts’ dossiers',
        // Older debates' sheets name the deleted bidding seat.
        bid: 'Floor bids',
      };
      return (
        <div className="cast-note">
          <div className="fn-head">
            <span className="label brass">Casting</span>
            <span className="fn-round">Chair on {modelName(c.chair)}</span>
          </div>
          {c.strategy && <div className="fn-why">{c.strategy}</div>}
          <ul className="cast-list">
            {c.entries.map((e) => {
              const m = MODEL_INFO[e.model];
              return (
                <li key={e.role}>
                  <div className="cast-row">
                    <span className="cast-job">{LABEL[e.role] ?? e.role}</span>
                    <span className="cast-model mono">{modelName(e.model)}</span>
                    {m?.inPerMTok !== undefined && (
                      <span className="cast-price num" title="USD per million tokens, input / output">
                        ${m.inPerMTok}/${m.outPerMTok}
                      </span>
                    )}
                  </div>
                  {e.why && <div className="cast-why">{e.why}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      );
    }
    case 'floor': {
      /**
       * The chair's note. Marcus assigns the floor rather than taking bids, so
       * without this a round is just a queue of people; with it you can see the
       * collision he is trying to force and who he is putting up against whom.
       */
      return (
        <div className="floor-note">
          <div className="fn-head">
            <span className="label brass">Chair's note</span>
            <span className="fn-round">Round {item.round}</span>
          </div>
          {item.why && <div className="fn-why">{item.why}</div>}
          <ol className="fn-slate">
            {item.slate.map((s, i) => (
              <li key={s.speaker + i}>
                <span className="fn-who" style={{ '--pc': personas[s.speaker]?.color ?? 'var(--muted)' } as CSSProperties}>
                  {personas[s.speaker]?.name ?? s.speaker}
                </span>
                <span className="fn-dir">{s.direction}</span>
              </li>
            ))}
          </ol>
        </div>
      );
    }
    case 'compute': {
      /**
       * The one card in the feed that is not somebody's opinion. Everything
       * about it is built to say so at a glance: the figures are set large in
       * the mono face, every one carries the file it came from, and the method
       * is one click away so the founder can check the arithmetic instead of
       * trusting it. A desk that says "not computable" gets the same prominence
       * as one that answers, because knowing a number cannot be had is worth as
       * much as the number.
       */
      return <ComputeCard item={item} />;
    }
    case 'audit': {
      const wrong = item.findings.filter((f) => f.verdict === 'wrong');
      return (
        <div className={`audit-card ${wrong.length ? 'flagged' : 'clean'}`}>
          <div className="dc-head">
            <span className="label brass">Numbers audit</span>
            <span className={`grade ${wrong.length ? 'assumed' : 'measured'}`}>
              {wrong.length ? `${wrong.length} wrong` : 'all hold'}
            </span>
          </div>
          <div className="au-sub">
            {item.checked} figure{item.checked === 1 ? '' : 's'} recomputed from your source files, after the room closed.
          </div>
          <div className="dc-text">{item.summary}</div>
          {item.findings.length > 0 && (
            <ul className="au-list">
              {item.findings.map((f, i) => (
                <li key={i} className={`au-${f.verdict}`}>
                  <span className="au-v">{f.verdict}</span>
                  <div className="au-body">
                    <div className="au-fig">{f.figure}</div>
                    <div className="au-re">{f.recomputed}</div>
                    {f.verdict === 'wrong' && f.impact && <div className="au-im">{f.impact}</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case 'motion':
      return (
        <div className="motion-open">
          <div className="mo-head">
            <span className="label brass">Motion {item.index} of {item.total}</span>
            <span className="mo-title h-display">{item.title}</span>
          </div>
          <div className="mo-text">{item.motion}</div>
        </div>
      );
    case 'decision': {
      const d = item.decision;
      return (
        <div className="decision-card">
          <div className="dc-head">
            <span className="label brass">Ruling</span>
            <span className={`grade ${d.evidence}`}>{d.evidence}</span>
          </div>
          <div className="dc-motion">{d.motionTitle}</div>
          <div className="dc-text">{d.decision}</div>
          <div className="dc-meta">
            <span className="label">Owner</span> <b>{d.owner}</b>
          </div>
          {d.rationale && <div className="dc-why">{d.rationale}</div>}
          {d.dissents.length > 0 && (
            <div className="dc-dissents">
              <span className="label">Standing dissent{d.dissents.length === 1 ? '' : 's'}</span>
              {d.dissents.map((x, i) => (
                <div key={i} className="dc-dissent"><b>{x.expert}</b> {x.position}</div>
              ))}
            </div>
          )}
          {d.undecidable && (
            <div className="dc-undecidable">
              <span className="label">Undecidable without</span> {d.undecidable.evidenceNeeded}
              <span className="dc-who"> · {d.undecidable.who}</span>
            </div>
          )}
        </div>
      );
    }
    case 'amend':
      return (
        <div className="amend-drop">
          <b>{item.name} joins the panel</b>
          <span className="amend-role">{item.role}</span>
          <span className="amend-why">Called in because: {item.reason}</span>
        </div>
      );
    case 'answer':
      return <Bubble ev={{ speaker: 'user', kind: 'user', text: item.text, ts: item.ts }} personas={personas} userName={userName} />;
    case 'convergence':
      return (
        <div className={`feed-note ${item.verdict === 'converged' ? 'ok' : 'warn'}`}>
          <b>{item.verdict === 'converged' ? 'Convergence reached' : 'Convergence check'}</b>
          {item.note}
        </div>
      );
    case 'dossier':
      return <DossierDrop files={item.files} brief={item.brief} />;
    case 'error':
      return (
        <div className="feed-note err">
          <b>Engine fault</b>
          {item.text}
        </div>
      );
  }
}

export function Transcript({
  state,
  dimmed,
  onOpenReport,
}: {
  state: DebateState;
  dimmed: boolean;
  onOpenReport: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const streams: StreamingMsg[] = state.streams;
  const streamedChars = streams.reduce((n, m) => n + m.text.length, 0);
  const speakerOfMsg = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of state.feed) if (it.fk === 'msg') m.set(it.ev.id, it.ev.speaker);
    for (const s of streams) m.set(s.id, s.speaker);
    return m;
  }, [state.feed, streams]);
  const overlapOf = useMemo(() => {
    const m = new Map<string, { fromChar: number; speaker: string }>();
    for (const it of state.feed) {
      if (it.fk === 'msg' && it.ev.overlap) m.set(it.ev.overlap.with, { fromChar: it.ev.overlap.fromChar, speaker: it.ev.speaker });
    }
    return m;
  }, [state.feed]);

  /**
   * Ceremony is for things that just happened, never for history: rows that
   * were already in the log when this screen opened (a reload, an imported
   * debate) render still. Only rows that arrive while the founder watches
   * get the entrance, and only once (the class stays, the animation does not
   * replay on re-render).
   */
  const [openedAt] = useState(() => Date.now());
  const rowTs = (it: FeedItem): number => (it.fk === 'msg' ? it.ev.ts : it.ts);
  // A streamed turn already made its entrance as a stream; when it lands in
  // the log it must not rise a second time.
  const streamed = useRef(new Set<string>());
  for (const s of streams) streamed.current.add(s.id);

  // Auto-scroll while pinned; instant (smooth lags behind token streams).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [state.feed.length, streamedChars, pinned]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    setPinned(atBottom);
  };

  const live = statusIsLive(state.status);

  return (
    <div className="feedwrap">
      <AnimatePresence>
        {state.reportPath && (
          <motion.div
            className="report-banner"
            initial={{ opacity: 1, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
          >
            <span className="rb-t">Report ready</span>
            <button className="btn sm outline-cyan" onClick={onOpenReport}>
              Open
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Focusable so the arrow keys and Page Up/Down can scroll the transcript. */}
      <div
        ref={scrollRef}
        className={`feed ${dimmed ? 'dimmed' : ''}`}
        onScroll={onScroll}
        tabIndex={0}
        role="region"
        aria-label="Transcript"
      >
        <div className="feed-inner">
          {state.feed.length === 0 && !streams.length && (
            <div className="sys-line" style={{ marginTop: 30 }}>
              The room has not started yet.
            </div>
          )}
          {state.feed.map((item) => {
            const fresh = rowTs(item) >= openedAt - 500;
            const rise = fresh && !(item.fk === 'msg' && streamed.current.has(item.key));
            return (
              <div key={item.key} className={rise ? 'row arrive' : 'row'}>
                <FeedRow
                  item={item}
                  personas={state.personas}
                  userName={state.ownerName}
                  speakerOfMsg={speakerOfMsg}
                  overlapOf={overlapOf}
                  live={fresh}
                />
              </div>
            );
          })}
          {/* Two people talking at once are shown at once: side by side on a
              wide screen, stacked on a phone, under one label. */}
          {streams.length > 0 && (
            <div className={streams.length > 1 ? 'crosstalk' : 'solo'}>
              {streams.length > 1 && <div className="crosstalk-k">Talking over each other</div>}
              <div className={streams.length > 1 ? 'crosstalk-lanes' : undefined}>
                {streams.map((m) => (
                  <div key={m.id} className="row arrive">
                    <Bubble
                      ev={{ speaker: m.speaker, kind: m.kind as MessageEv['kind'], text: m.text }}
                      personas={state.personas}
                      userName={state.ownerName}
                      streamingText
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          {live && pinned && (
            <div className="live-row">
              <span className="live-tick">
                <span className="dot" />
                Live
              </span>
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {!pinned && (
          <motion.button
            className="jump-pill"
            onClick={() => {
              setPinned(true);
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            initial={{ opacity: 1, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
          >
            Jump to live
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
