import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AttentionTracker, Coalescer, type Attention } from '../../../shared/attention';
import type { DebateSummary } from '../../../shared/types';
import { api } from '../lib/api';
import { freshKey, needsYouCount, notificationCopy } from '../lib/attention-view';
import { setAttentionBadge, showNotification } from '../lib/notify';

const HIDDEN_POLL_MS = 15_000;
const VISIBLE_POLL_MS = 30_000;
const WINDOW_MS = 30_000;

/**
 * Watches every debate's attention state from GET /api/debates and turns a
 * transition into a browser notification, plus a count in the tab title and a
 * dot on the favicon. Renders nothing. Polls every 15s while the tab is
 * hidden (the case that matters) and more lazily while it is visible.
 */
export function AttentionWatcher() {
  const nav = useNavigate();
  const location = useLocation();
  const viewing = location.pathname.match(/^\/debate\/([^/]+)/)?.[1] ?? null;

  const state = useRef({
    rows: [] as DebateSummary[],
    fresh: new Set<string>(),
    viewing,
    tracker: new AttentionTracker(),
    primed: false,
  });
  state.current.viewing = viewing;

  const navRef = useRef(nav);
  navRef.current = nav;

  useEffect(() => {
    const s = state.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    // Changes that come due together become one notification.
    let batch: { id: string; kind: Attention; title?: string }[] = [];
    const flush = () => {
      const changes = batch;
      batch = [];
      if (!changes.length) return;
      const copy = notificationCopy(changes);
      showNotification(copy, () => navRef.current(copy.path));
    };
    const coalescer = new Coalescer(
      (id, kind) => {
        if (!batch.length) queueMicrotask(flush);
        batch.push({ id, kind, title: s.rows.find((r) => r.id === id)?.title });
      },
      { windowMs: WINDOW_MS, stillWanted: (id) => !!s.rows.find((r) => r.id === id)?.attention }
    );

    const render = () => {
      const visible = document.visibilityState === 'visible';
      // Looking at a debate acknowledges its report or error.
      if (visible && s.viewing) for (const k of [...s.fresh]) if (k.startsWith(`${s.viewing}|`)) s.fresh.delete(k);
      setAttentionBadge(needsYouCount(s.rows, { fresh: s.fresh, viewing: s.viewing, visible }));
    };

    const poll = async () => {
      try {
        const rows = await api.listDebates();
        if (stopped) return;
        s.rows = rows;
        const changes = s.tracker.observeAll(
          rows.map((r) => ({ id: r.id, attention: r.attention && r.attentionKey ? { kind: r.attention, key: r.attentionKey } : null })),
          s.primed
        );
        s.primed = true;
        const visible = document.visibilityState === 'visible' && document.hasFocus();
        for (const c of changes) {
          const row = rows.find((r) => r.id === c.id);
          if (row?.attentionKey) s.fresh.add(freshKey(c.id, row.attentionKey));
          // Nobody needs a notification for the debate they are looking at.
          if (visible && s.viewing === c.id) continue;
          coalescer.push(c.id, c.kind);
        }
        render();
      } catch {
        /* signed out or server restarting: try again next tick */
      }
      if (!stopped) schedule();
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(poll, document.visibilityState === 'hidden' ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);
    };

    const onVisibility = () => {
      render();
      if (document.visibilityState === 'visible') void poll();
      else schedule();
    };

    void poll();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      coalescer.stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
      setAttentionBadge(0);
    };
  }, []);

  // Moving to a debate acknowledges it and refreshes the badge at once.
  useEffect(() => {
    const s = state.current;
    if (document.visibilityState === 'visible' && viewing) {
      for (const k of [...s.fresh]) if (k.startsWith(`${viewing}|`)) s.fresh.delete(k);
    }
    setAttentionBadge(needsYouCount(s.rows, { fresh: s.fresh, viewing, visible: document.visibilityState === 'visible' }));
  }, [viewing]);

  return null;
}
