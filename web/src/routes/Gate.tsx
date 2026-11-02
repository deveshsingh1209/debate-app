import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../lib/api';
import { APP_NAME } from '../../../shared/types';

function Compass({ live }: { live: boolean }) {
  return (
    <div className={`compass ${live ? 'live' : ''}`} aria-hidden>
      {/* Colours from the tokens (style, not presentation attributes, so
          var() resolves), so the compass follows the theme. */}
      <svg viewBox="0 0 200 200">
        <circle cx="100" cy="100" r="86" fill="none" style={{ stroke: 'var(--accent-line)' }} strokeWidth="1.5" />
        <circle cx="100" cy="100" r="79" fill="none" style={{ stroke: 'var(--border)' }} strokeWidth="1" />
        <g className="rose">
          {Array.from({ length: 72 }, (_, i) => {
            const major = i % 9 === 0;
            const a = (i * 5 * Math.PI) / 180;
            const r1 = major ? 66 : 72;
            return (
              <line
                key={i}
                x1={100 + Math.sin(a) * r1}
                y1={100 - Math.cos(a) * r1}
                x2={100 + Math.sin(a) * 78}
                y2={100 - Math.cos(a) * 78}
                style={{ stroke: major ? 'var(--accent-line)' : 'var(--control)' }}
                strokeWidth={major ? 1.4 : 0.8}
              />
            );
          })}
        </g>
        <g className="needle">
          <path d="M100 34 L110 100 L100 118 L90 100 Z" style={{ fill: 'var(--accent-line)' }} />
          <path d="M100 166 L90 100 L100 82 L110 100 Z" style={{ fill: 'var(--control)' }} />
        </g>
        <circle cx="100" cy="100" r="6" style={{ fill: 'var(--ground)', stroke: 'var(--accent-line)' }} strokeWidth="1.5" />
      </svg>
    </div>
  );
}

/**
 * The sign-in screen. Only shown when the server has ACCESS_PASSWORD set
 * (required whenever it listens beyond 127.0.0.1); a default local install
 * goes straight to the deck.
 */
export default function Gate() {
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    api.me().then((m) => { if (live && m.ok) nav('/', { replace: true }); }).catch(() => {});
    return () => { live = false; };
  }, [nav]);

  const signIn = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.login(password);
      nav('/', { replace: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not sign in.');
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <motion.div initial={{ opacity: 1, scale: .9 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 110, damping: 15 }}>
        <Compass live={false} />
      </motion.div>

      <motion.div
        className="gate-title"
        initial={{ opacity: 1, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: .12, duration: .45, ease: [0.16, 1, 0.3, 1] }}
      >
        <h1 className="h-display">{APP_NAME}</h1>
      </motion.div>

      <motion.div className="doors" initial={{ opacity: 1, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .26, duration: .4 }}>
        <p className="gate-lede">This server is password protected. Enter the ACCESS_PASSWORD it was started with.</p>
        <input
          className="field"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && password) void signIn(); }}
        />
        {err && <div className="door-err">{err}</div>}
        <button className="btn primary wide" disabled={busy || !password} onClick={signIn}>
          {busy ? 'Signing in' : 'Sign in'}
        </button>
      </motion.div>
    </div>
  );
}
