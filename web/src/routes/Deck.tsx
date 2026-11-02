import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { DebateSummary } from '../../../shared/types';
import { api } from '../lib/api';
import { StatusChip } from '../components/hud';
import { RoomSettings } from '../components/RoomSettings';
import { fmtDate } from '../lib/format';
import { anyReady, connectSeen } from '../lib/doors';
import { PROVIDERS, PROVIDER_LABEL, providerOfConfig } from '../../../shared/models';
import { APP_NAME } from '../../../shared/types';

export default function Deck() {
  const nav = useNavigate();
  const [authRequired, setAuthRequired] = useState(false);
  const [debates, setDebates] = useState<DebateSummary[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Two-step delete: the first click arms, the second commits. */
  const remove = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.deleteDebate(id);
      setDebates((list) => (list ?? []).filter((x) => x.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete that debate.');
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  };

  const signOut = async () => {
    try {
      await api.logout();
    } finally {
      nav('/gate', { replace: true });
    }
  };

  /**
   * Is any AI connected? On first run with none, the Connect screen opens by
   * itself (once); after that the deck just says so, with the way there.
   */
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api
      .doors()
      .then((d) => {
        if (!live) return;
        const ok = d.mock || anyReady(d.doors);
        setConnected(ok);
        if (!ok && !connectSeen()) nav('/connect');
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [nav]);

  useEffect(() => {
    let live = true;
    api.me().then((m) => live && setAuthRequired(m.authRequired)).catch(() => {});
    api
      .listDebates()
      .then((d) => live && setDebates(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Failed to load library'));
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="page-scroll">
      <div className="deck">
        <div className="deck-head">
          <h1 className="deck-title">{APP_NAME}</h1>
          <div className="deck-tools">
            <button className="btn sm ghost" onClick={() => nav('/connect')}>Connect your AI</button>
            <RoomSettings />
            {authRequired && <button className="btn sm ghost" onClick={signOut}>Sign out</button>}
          </div>
        </div>

        {connected === false && (
          <div className="feed-note warn cx-deck-note" role="status">
            <b>No AI is connected yet</b>
            <span>Debates need one of four: {PROVIDERS.map((p) => PROVIDER_LABEL[p]).join(', ')}. It takes a few minutes. </span>
            <button className="btn sm outline-cyan" onClick={() => nav('/connect')}>Connect your AI</button>
          </div>
        )}

        <motion.button
          className="new-tile"
          onClick={() => nav('/new')}
          initial={{ y: 6 }}
          animate={{ y: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 34 }}
        >
          <h2>New debate</h2>
          <p>Hand the panel a decision. Expert agents argue it live, you steer, and a written report lands at the end.</p>
          <span className="go" aria-hidden>→</span>
        </motion.button>

        <h2 className="deck-sub">
          Past debates <span className="num">{debates ? debates.length : '–'}</span>
        </h2>

        {error && <div className="feed-note err"><b>Could not load the library</b>{error}</div>}

        {debates && debates.length === 0 && (
          <div className="deck-empty">
            <div className="big">No debates yet</div>
            <p>Start one above. Every debate you run, and its report, is kept here on this machine.</p>
          </div>
        )}

        <div className="lib-list">
          {debates?.map((d, i) => (
            <motion.div
              key={d.id}
              className="lib-row"
              role="link"
              tabIndex={0}
              onClick={() => nav(`/debate/${d.id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') nav(`/debate/${d.id}`); }}
              initial={{ y: 4 }}
              animate={{ y: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 34, delay: Math.min(i, 10) * 0.03 }}
            >
              <div className="lib-main">
                <div className="lib-title">{d.title}</div>
                <div className="lib-meta">
                  <StatusChip status={d.status} />
                  <span className="m">{PROVIDER_LABEL[providerOfConfig(d.config)]}</span>
                  {d.config.autonomy === 'autonomous' && <span className="m warn">Autonomous</span>}
                  <span className="m num">{d.messageCount} messages</span>
                  <span className="m num">{fmtDate(d.createdAt)}</span>
                </div>
              </div>
              <div className="lib-actions" onClick={(e) => e.stopPropagation()}>
                {d.status === 'complete' && (
                  <button className="btn sm outline-cyan" onClick={() => nav(`/debate/${d.id}/report`)}>
                    Report
                  </button>
                )}
                <button
                  className={`btn sm ${confirmId === d.id ? 'danger' : 'ghost'}`}
                  onClick={() => (confirmId === d.id ? remove(d.id) : setConfirmId(d.id))}
                  onBlur={() => setConfirmId((c) => (c === d.id ? null : c))}
                  disabled={busyId === d.id}
                  title="Delete this debate and everything it produced"
                >
                  {busyId === d.id ? 'Deleting' : confirmId === d.id ? 'Delete for good?' : 'Delete'}
                </button>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
