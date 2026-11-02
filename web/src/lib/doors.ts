import { useCallback, useEffect, useRef, useState } from 'react';
import type { DoorsInfo } from '../../../shared/types';
import { api } from './api';

export { anyReady, defaultDoor, splitTicks, STATE_CHIP, STATE_LABEL } from './door-view';

/**
 * The four doors' readiness, shared by the Connect screen and New Debate.
 * The server caches its probe for ~30 s; `recheck()` asks it to look again
 * (and re-read the keys in .env), which is what the Re-check buttons do.
 */
export function useDoors(opts: { fresh?: boolean } = {}) {
  const [info, setInfo] = useState<DoorsInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  const load = useCallback(async (fresh: boolean) => {
    setChecking(true);
    try {
      const next = await api.doors(fresh);
      if (!live.current) return;
      setInfo(next);
      setError(null);
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : 'Could not check your AI connections.');
    } finally {
      if (live.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void load(!!opts.fresh);
    return () => {
      live.current = false;
    };
  }, [load, opts.fresh]);

  return { info, checking, error, recheck: () => load(true) };
}

/** First-run: the Connect screen is shown once, unprompted, to someone with no door ready. */
const SEEN_KEY = 'debate.connect.seen';
export const connectSeen = (): boolean => {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return true; }
};
export const markConnectSeen = () => {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode: it shows again, harmlessly */ }
};

/**
 * Put text on the clipboard. The async Clipboard API needs a secure context
 * (localhost is one; a plain-HTTP LAN address is not), so a selected-textarea
 * copy is the fallback. Resolves false only when both fail.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
