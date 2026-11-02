import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Bid, Persona } from '../../../shared/types';
import type { BidRound, DebateState } from '../lib/stream';
import { IRRITATED, SeatAvatar, heatWord } from './Seat';

const BID_TTL = 7000;

/** Keeps the latest bid round visible for BID_TTL ms after it lands. */
function useLiveBids(lastBids: BidRound | null): BidRound | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!lastBids) return;
    const left = BID_TTL - (Date.now() - lastBids.at);
    if (left <= 0) return;
    const t = setTimeout(() => force((n) => n + 1), left + 50);
    return () => clearTimeout(t);
  }, [lastBids]);
  if (!lastBids || Date.now() - lastBids.at > BID_TTL) return null;
  return lastBids;
}

const STANCE_SHORT: Record<number, string> = { [-2]: 'Against', [-1]: 'Leans against', 0: 'Undecided', 1: 'Leans for', 2: 'For' };

function PersonaCard({
  p,
  speaking,
  bid,
  isWinner,
  index,
  heat,
  handUp,
  stance,
}: {
  p: Persona;
  speaking: 'talking' | 'thinking' | null;
  bid: Bid | null;
  isWinner: boolean;
  index: number;
  heat?: number;
  handUp?: boolean;
  stance?: number;
}) {
  const [open, setOpen] = useState(false);
  const style = { '--pc': p.color } as React.CSSProperties;
  const stateCls = speaking === 'talking' ? 'speaking' : bid ? 'bidding' : '';
  const hot = heat !== undefined && heat >= IRRITATED;

  return (
    <motion.div
      className={`roster-card ${stateCls}${hot ? ' hot' : ''}`}
      style={style}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      initial={{ x: -8 }}
      animate={{ x: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34, delay: Math.min(index, 8) * 0.04 }}
      title={bid ? `Bid ${bid.urgency}/10: ${bid.hook}` : p.tagline}
    >
      <div className="rc-top">
        <SeatAvatar persona={p} state={speaking === 'talking' ? 'speaking' : speaking} heat={heat} handUp={handUp} size={34} />
        <div className="rc-id">
          <div className="rc-name">
            <span className="rc-name-t">{p.name}</span>
            {p.isModerator && <span className="mod-badge">Chair</span>}
          </div>
          <div className="rc-role">{p.role}</div>
        </div>
        <div className="rc-state">
          {speaking === 'talking' && <span className="rc-now speaking">Speaking</span>}
          {speaking === 'thinking' && <span className="rc-now">Composing</span>}
          {!speaking && hot && <span className="rc-now hot">{heatWord(heat!).replace(/^./, (c) => c.toUpperCase())}</span>}
          {!speaking && !hot && handUp && <span className="rc-now">Hand up</span>}
        </div>
      </div>
      {stance !== undefined && Number.isFinite(stance) && (
        <div className="rc-stance" aria-label={`Stance on this motion: ${STANCE_SHORT[Math.round(stance)] ?? stance}`}>
          <span className="rc-stance-track" aria-hidden>
            <span className="rc-stance-dot" style={{ left: `${((Math.max(-2, Math.min(2, stance)) + 2) / 4) * 100}%` }} />
          </span>
          <span className="rc-stance-k">{STANCE_SHORT[Math.round(stance)] ?? ''}</span>
        </div>
      )}

      <AnimatePresence>
        {bid && (
          <motion.div
            className={`rc-bid ${isWinner ? 'winner' : ''}`}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="bu">
              <span>{isWinner ? 'Floor granted' : 'Bidding'}</span>
              <span className="num">Urgency {bid.urgency}/10</span>
            </div>
            {bid.hook}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            className="rc-detail"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="rc-tagline" style={{ marginTop: 0 }}>
              {p.tagline}
            </div>
            <span className="uplabel">Bio</span>
            {p.bio}
            <span className="uplabel">Biases</span>
            {p.biases}
            <span className="uplabel">Style</span>
            {p.style}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function Roster({ state }: { state: DebateState }) {
  const bids = useLiveBids(state.lastBids);
  const bidBySpeaker = useMemo(() => {
    const m = new Map<string, Bid>();
    if (bids) for (const b of bids.bids) m.set(b.speaker, b);
    return m;
  }, [bids]);

  if (state.personaOrder.length === 0) {
    return (
      <div className="rail-scroll">
        <div className="rail-empty">The panel has not been seated yet. The chair proposes it after intake.</div>
      </div>
    );
  }

  return (
    <div className="rail-scroll">
      {state.personaOrder.map((pid, i) => {
        const p = state.personas[pid];
        if (!p) return null;
        return (
          <PersonaCard
            key={pid}
            p={p}
            index={i}
            speaking={
              state.streams.some((s) => s.speaker === pid)
                ? 'talking'
                : state.speaking.speaker === pid ? state.speaking.phase : null
            }
            heat={state.floor?.heat[pid]}
            handUp={state.floor?.handsUp.includes(pid)}
            stance={state.beliefs[pid]?.stance}
            bid={bidBySpeaker.get(pid) ?? null}
            isWinner={bids?.winner === pid}
          />
        );
      })}
    </div>
  );
}
