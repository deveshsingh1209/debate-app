import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './lib/api';
import { BootSplash } from './components/hud';
import { useDeferredPending } from './lib/phase';
import Gate from './routes/Gate';
import Deck from './routes/Deck';
import NewDebate from './routes/NewDebate';
import Connect from './routes/Connect';
import WarRoom from './routes/WarRoom';
import Report from './routes/Report';
// Rehearsal is a local-only bench: bundled in dev, stripped from production.
import Rehearsal from './routes/Rehearsal';

function RequireAuth({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api
      .me()
      .then((v) => live && setOk(!!v?.ok))
      .catch(() => live && setOk(false));
    return () => {
      live = false;
    };
  }, []);
  // A session check usually resolves instantly. Rendering a splash for 60ms
  // and tearing it down reads as a bug, so nothing is shown until the wait is
  // long enough to be worth acknowledging.
  const showSplash = useDeferredPending(ok === null);
  if (ok === null) return showSplash ? <BootSplash /> : null;
  if (!ok) return <Navigate to="/gate" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/gate" element={<Gate />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Deck />
          </RequireAuth>
        }
      />
      <Route
        path="/connect"
        element={
          <RequireAuth>
            <Connect />
          </RequireAuth>
        }
      />
      <Route
        path="/new"
        element={
          <RequireAuth>
            <NewDebate />
          </RequireAuth>
        }
      />
      <Route
        path="/debate/:id"
        element={
          <RequireAuth>
            <WarRoom />
          </RequireAuth>
        }
      />
      <Route
        path="/debate/:id/report"
        element={
          <RequireAuth>
            <Report />
          </RequireAuth>
        }
      />
      {/* Motion + audio bench: local dev only, never served on the domain. */}
      {import.meta.env.DEV && <Route path="/rehearsal" element={<Rehearsal />} />}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
