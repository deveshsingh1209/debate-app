/**
 * Light, dark, or whatever the system says. Stored per browser; applied as
 * `data-theme` on <html> before the first render (main.tsx imports this), so
 * there is no flash of the wrong theme.
 */
export type ThemePref = 'system' | 'dark' | 'light';
export type Theme = 'dark' | 'light';

const KEY = 'debate.theme';
const listeners = new Set<() => void>();

function systemTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch { /* private mode */ }
  return 'dark';
}

export function resolvedTheme(pref: ThemePref = themePref()): Theme {
  return pref === 'system' ? systemTheme() : pref;
}

export function applyTheme(): void {
  if (typeof document === 'undefined') return;
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', t);
}

export function setThemePref(p: ThemePref): void {
  try { localStorage.setItem(KEY, p); } catch { /* private mode */ }
  applyTheme();
  listeners.forEach((f) => f());
}

export function onThemeChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Follow the system when the founder chose "system". */
export function watchSystemTheme(): void {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (themePref() === 'system') { applyTheme(); listeners.forEach((f) => f()); }
  });
}
