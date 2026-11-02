import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { notifyPermission, notifyPref, primeNotifications, setNotifyPref } from '../lib/notify';

/**
 * The notifications switch, on the setup screen and the first gate. Turning
 * it on is the click that may show the browser's permission prompt; nothing
 * asks on page load. Says plainly what will happen on this machine.
 */
export function NotifyToggle({ compact = false }: { compact?: boolean }) {
  const [on, setOn] = useState(notifyPref);
  const [perm, setPerm] = useState(notifyPermission);
  const [telegram, setTelegram] = useState(false);

  useEffect(() => {
    const sync = () => {
      setOn(notifyPref());
      setPerm(notifyPermission());
    };
    window.addEventListener('debate-notify-pref', sync);
    window.addEventListener('focus', sync);
    let live = true;
    api.me().then((m) => live && setTelegram(!!m.telegram)).catch(() => {});
    return () => {
      live = false;
      window.removeEventListener('debate-notify-pref', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);

  const toggle = () => {
    const next = !on;
    setNotifyPref(next);
    setOn(next);
    if (next) void primeNotifications().then(setPerm);
  };

  let note: string;
  if (!on) note = 'Off. The tab title still shows "(1) Needs you" when a debate is waiting.';
  else if (perm === 'unsupported')
    note = 'This address cannot show browser notifications (they need http://localhost, http://127.0.0.1 or https). The tab title and icon will show a badge instead.';
  else if (perm === 'denied')
    note = 'Your browser has blocked notifications for this site. Allow them in the site settings, or rely on the tab title badge.';
  else if (perm === 'default') note = `Your browser will ask for permission when you ${compact ? 'approve' : 'start the debate'}.`;
  else note = 'You will get a notification when a debate needs your answer or approval, pauses, fails, or finishes. Only while this tab is open.';
  if (telegram) note += ' Telegram notifications are also on.';

  return (
    <div className="setup-section" style={compact ? { margin: '10px 0 0' } : undefined}>
      {!compact && <span className="uplabel bright">Notifications</span>}
      <div className="door-actions" style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        {/* Never the brass fill: the screen's one primary action is Start or Approve, not this. */}
        <button type="button" className={`btn ${compact ? 'sm' : ''} ${on ? 'outline-cyan' : 'ghost'}`} aria-pressed={on} onClick={toggle}>
          {on ? 'Notify me: on' : 'Notify me: off'}
        </button>
        {on && perm === 'default' && !compact && (
          <button type="button" className="btn ghost" onClick={() => void primeNotifications().then(setPerm)}>
            Allow now
          </button>
        )}
      </div>
      <p className="setup-note">{note}</p>
    </div>
  );
}
