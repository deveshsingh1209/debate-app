import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Sound } from '../lib/voice';
import { CUE_SPEC, type Cue } from '../lib/sound-core';
import { onThemeChange, setThemePref, themePref, type ThemePref } from '../design/theme';

/**
 * One small control for the room's sound and look. Closed, it says the one
 * thing worth knowing (sound on or off). Open: the sound switch, master
 * volume, which cues play, a preview, the way to Connect your AI, and the
 * theme.
 */

function useSound() {
  return useSyncExternalStore(Sound.subscribe, () => Sound.settings);
}
function useThemePref() {
  return useSyncExternalStore(onThemeChange, themePref);
}

const THEMES: { v: ThemePref; label: string }[] = [
  { v: 'dark', label: 'Dark' },
  { v: 'light', label: 'Light' },
  { v: 'system', label: 'System' },
];

export function RoomSettings() {
  const s = useSound();
  const theme = useThemePref();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const vol = Math.round(s.volume * 100);

  return (
    <div className="rs" ref={wrap}>
      <button
        className={`btn sm ghost rs-toggle${s.enabled ? ' on' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        title="Sound and display"
      >
        <span className={`rs-dot${s.enabled ? ' on' : ''}`} aria-hidden />
        {s.enabled ? 'Sound on' : 'Sound off'}
      </button>
      {open && (
        <div className="rs-pop" id={id} role="dialog" aria-label="Sound and display">
          <div className="rs-row">
            <span className="rs-k">Sound</span>
            <button
              className={`switch${s.enabled ? ' on' : ''}`}
              role="switch"
              aria-checked={s.enabled}
              onClick={() => {
                const on = !s.enabled;
                Sound.enable(on);
                if (on) Sound.preview('tick');
              }}
            >
              <span className="switch-knob" />
              <span className="sr-only">Sound</span>
            </button>
          </div>
          {Sound.unavailable && <div className="rs-note">This browser would not start audio. Everything you would hear is also on screen.</div>}

          <label className={`rs-row${s.enabled ? '' : ' off'}`}>
            <span className="rs-k">Volume</span>
            <input
              className="range"
              type="range"
              min={0}
              max={100}
              step={5}
              value={vol}
              disabled={!s.enabled}
              onChange={(e) => Sound.setVolume(Number(e.target.value) / 100)}
              onPointerUp={() => Sound.preview('tick')}
              onKeyUp={() => Sound.preview('tick')}
              aria-valuetext={`${vol}%`}
            />
            <span className="rs-v num">{vol}%</span>
          </label>

          <div className={`rs-row${s.enabled ? '' : ' off'}`}>
            <span className="rs-k">Cues</span>
            <div className="seg" role="radiogroup" aria-label="Which cues play">
              {(['all', 'key'] as const).map((v) => (
                <button
                  key={v}
                  role="radio"
                  aria-checked={s.scope === v}
                  className={`seg-opt${s.scope === v ? ' on' : ''}`}
                  disabled={!s.enabled}
                  onClick={() => Sound.setScope(v)}
                >
                  {v === 'all' ? 'All' : 'Key only'}
                </button>
              ))}
            </div>
          </div>
          {s.enabled && (
            <div className="rs-cues">
              {(Object.keys(CUE_SPEC) as Cue[]).filter((c) => s.scope === 'all' || CUE_SPEC[c].key).map((c) => (
                <button key={c} className="rs-cue" onClick={() => Sound.preview(c, c === 'gavel' ? 2 : undefined)} title={CUE_SPEC[c].note}>
                  {CUE_SPEC[c].label}
                </button>
              ))}
            </div>
          )}

          <div className="rs-row">
            <span className="rs-k">AI</span>
            <Link className="rs-link" to="/connect" onClick={() => setOpen(false)}>Connect your AI</Link>
          </div>

          <div className="rs-row">
            <span className="rs-k">Theme</span>
            <div className="seg" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button
                  key={t.v}
                  role="radio"
                  aria-checked={theme === t.v}
                  className={`seg-opt${theme === t.v ? ' on' : ''}`}
                  onClick={() => setThemePref(t.v)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
