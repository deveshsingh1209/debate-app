/**
 * Browser notifications (plan section 6.1). On by default as a preference, but
 * the permission prompt only ever follows a click (the setup screen, the first
 * gate, or the toggle), never a page load. Where the Notification API is not
 * available (plain HTTP on a LAN host is not a secure context), the tab title
 * and favicon badge still work, and the toggle says so. No service worker:
 * notifications need an open tab; Telegram covers a closed one.
 */
import { badgeTitle } from './attention-view';

const PREF_KEY = 'debate.notify';
export const APP_NAME = 'The Debate App';

/** The founder's choice. On unless they turned it off. */
export function notifyPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setNotifyPref(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch { /* private mode: the choice lasts this page only */ }
  window.dispatchEvent(new Event('debate-notify-pref'));
}

/** The Notification API exists and this page may use it. */
export function notifySupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext;
}

export function notifyPermission(): NotificationPermission | 'unsupported' {
  return notifySupported() ? Notification.permission : 'unsupported';
}

/**
 * Call from a click handler, synchronously, before any await: browsers only
 * show the permission prompt in response to a user gesture.
 */
export function primeNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!notifySupported()) return Promise.resolve('unsupported');
  if (!notifyPref() || Notification.permission !== 'default') return Promise.resolve(Notification.permission);
  return Notification.requestPermission().then((p) => {
    window.dispatchEvent(new Event('debate-notify-pref'));
    return p;
  });
}

/** Show one notification if allowed. Clicking focuses the tab and runs onClick. */
export function showNotification(n: { title: string; body: string; tag: string }, onClick: () => void): boolean {
  if (!notifyPref() || notifyPermission() !== 'granted') return false;
  try {
    const note = new Notification(n.title, { body: n.body, tag: n.tag, icon: '/favicon.ico' });
    note.onclick = () => {
      window.focus();
      onClick();
      note.close();
    };
    return true;
  } catch {
    return false; // some platforms (Android Chrome) need a service worker; the badge still shows
  }
}

// ---------------------------------------------------------------- title + favicon badge

let baseTitle: string | null = null;
let baseIcon: HTMLImageElement | null = null;
let lastCount = -1;

function iconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.href = '/favicon.ico';
    document.head.appendChild(link);
  }
  return link;
}

function drawIcon(withDot: boolean) {
  const link = iconLink();
  if (!withDot) {
    link.href = '/favicon.ico';
    return;
  }
  const paint = () => {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    if (!g) return;
    if (baseIcon?.complete && baseIcon.naturalWidth) g.drawImage(baseIcon, 0, 0, 32, 32);
    g.beginPath();
    g.arc(23, 9, 8, 0, Math.PI * 2);
    g.fillStyle = '#f59e0b';
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = '#0b0f14';
    g.stroke();
    link.href = c.toDataURL('image/png');
  };
  if (!baseIcon) {
    baseIcon = new Image();
    baseIcon.onload = paint;
    baseIcon.onerror = paint;
    baseIcon.src = '/favicon.ico';
  } else paint();
}

/** "(1) Needs you · The Debate App" and a dot on the favicon; both cleared at zero. */
export function setAttentionBadge(count: number) {
  if (count === lastCount) return;
  if (baseTitle === null || lastCount <= 0) baseTitle = document.title || APP_NAME;
  lastCount = count;
  document.title = count > 0 ? badgeTitle(count, APP_NAME) : baseTitle;
  drawIcon(count > 0);
}
