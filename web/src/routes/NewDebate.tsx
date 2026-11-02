import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import type { Autonomy, BudgetProfile, DebateConfig, DoorsInfo, ProfileChoice } from '../../../shared/types';
import { defaultDoor, STATE_LABEL, useDoors } from '../lib/doors';
import { TickText } from '../components/DoorBits';
import { BUDGET_PROFILES, DEFAULT_PROFILE_CHOICE } from '../../../shared/budget';
import { MODEL_IDS, PROVIDERS, PROVIDER_LABEL, modelName, type Provider } from '../../../shared/models';
import { api } from '../lib/api';
import { NotifyToggle } from '../components/NotifyToggle';
import { primeNotifications } from '../lib/notify';

/**
 * Includes the legacy Office trio on purpose: the server rejects them with an
 * explanation the founder actually sees. Filtering them out of the PICKER
 * just makes the file silently unselectable, which reads as a broken app.
 */
const ACCEPT =
  '.zip,.md,.txt,.pdf,.csv,.tsv,.json,.docx,.pptx,.xlsx,.ppt,.doc,.xls,.py,.ts,.tsx,.js,.jsx,.html,.css,.sql,.yaml,.yml,.png,.jpg,.jpeg,.gif,.webp';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DossierZone({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const add = (incoming: FileList | File[] | null) => {
    if (!incoming) return;
    const merged = [...files];
    for (const f of Array.from(incoming)) {
      if (!merged.some((m) => m.name === f.name && m.size === f.size)) merged.push(f);
    }
    onChange(merged);
  };

  return (
    <div className="setup-section" style={{ marginTop: -18 }}>
      <span className="uplabel bright">Files for the panel to read (optional)</span>
      <div
        className={`dossier-zone ${dragging ? 'dragging' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
      >
        <div className="dz-title">{dragging ? 'Release to attach' : 'Drop files or click to browse'}</div>
        <div className="dz-hint">Notes, documents, spreadsheets, PDFs. The panel reads them before it starts. One .zip or loose files.</div>
        <input
          tabIndex={-1}
          aria-hidden
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {files.length > 0 && (
        <div className="dz-list">
          {files.map((f, i) => (
            <motion.div key={`${f.name}-${f.size}`} className="dz-file" initial={{ opacity: 1, x: -10 }} animate={{ opacity: 1, x: 0 }}>
              <span className="fn">{f.name}</span>
              <span className="fs">{fmtSize(f.size)}</span>
              <button
                className="fx"
                title="Remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(files.filter((_, j) => j !== i));
                }}
                aria-label={`Remove ${f.name}`}
              >
                Remove
              </button>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

const CLAUDE_NOTE =
  `Marcus chairs on ${modelName(MODEL_IDS.claude.flagship)}, as do the experts, rulings, referee and report. ` +
  `Research and the dossier run on ${modelName(MODEL_IDS.claude.balanced)}; turn rewrites on ${modelName(MODEL_IDS.claude.fast)}. ` +
  'The full toolset: web research, and python over your uploaded files for measured numbers.';

/** The button names are PROVIDER_LABEL, the same four names as every other screen. */
const DOOR_COPY: Record<Provider, { desc: string; note: string }> = {
  claude: {
    desc: 'Runs on your own Claude Code login.',
    note: CLAUDE_NOTE,
  },
  anthropic: {
    desc: 'Runs on the ANTHROPIC_API_KEY in your .env, billed per token to your Anthropic account.',
    note: CLAUDE_NOTE,
  },
  openai: {
    desc: 'Runs on the OPENAI_API_KEY in your .env, billed per token.',
    note:
      `Hard seats run on ${modelName(MODEL_IDS.openai.flagship)}, research and the dossier on ${modelName(MODEL_IDS.openai.balanced)}, ` +
      `turn rewrites on ${modelName(MODEL_IDS.openai.fast)}. Web research through OpenAI's web search, with its sources cited. No quant desk on this door, so nothing is a measured number.`,
  },
  codex: {
    desc: 'Runs on your own Codex CLI login and ChatGPT plan.',
    note:
      `Same models as the OpenAI door, on your plan's usage window instead of a per-token bill. Speakers arrive whole rather than ` +
      'typing out live, turns run one at a time, and there is no quant desk. Web research works, but this door cannot show which pages ' +
      'its search returned, so its sources are labelled as reported by the model, and the room pauses while it searches.',
  },
};

/**
 * Which provider runs the debate. Never a model: the product casts every
 * seat (shared/models.ts). Every door can be picked, so its fix can be read
 * right here; Start stays off until the picked door is ready.
 */
function ProviderDoors({
  value,
  onChange,
  doors,
  checking,
  onRecheck,
}: {
  value: Provider;
  onChange: (p: Provider) => void;
  doors: DoorsInfo | null;
  checking: boolean;
  onRecheck: () => void;
}) {
  const nav = useNavigate();
  const status = (p: Provider) => doors?.doors.find((d) => d.id === p) ?? null;
  const picked = status(value);
  const blocked = !!picked && picked.state !== 'ready' && !doors?.mock;
  const refs = useRef<Partial<Record<Provider, HTMLButtonElement | null>>>({});
  /** One radio group: Tab lands on the picked way, the arrow keys move between them. */
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = PROVIDERS[(PROVIDERS.indexOf(value) + step + PROVIDERS.length) % PROVIDERS.length];
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="setup-section">
      <span className="uplabel bright" id="door-label">Which AI runs the debate</span>
      <div className="door-pick" role="radiogroup" aria-labelledby="door-label" onKeyDown={onKey}>
        {PROVIDERS.map((p) => {
          const st = status(p)?.state;
          return (
            <button
              key={p}
              ref={(el) => { refs.current[p] = el; }}
              type="button"
              role="radio"
              data-door={p}
              aria-checked={value === p}
              tabIndex={value === p ? 0 : -1}
              className={`door-opt${value === p ? ' on' : ''}`}
              onClick={() => onChange(p)}
              title={DOOR_COPY[p].desc}
            >
              <span className="door-name">{PROVIDER_LABEL[p]}</span>
              <span className={`door-state ${st ?? 'unknown'}`}>
                <span className={`cx-dot ${st ?? ''}`} aria-hidden />
                <span className="sr-only">, </span>
                {st ? STATE_LABEL[st] : 'Checking…'}
              </span>
            </button>
          );
        })}
      </div>
      {blocked && picked ? (
        <div className={`feed-note ${picked.state === 'problem' ? 'err' : 'warn'} nd-door-fix`} role="status">
          <b>{picked.title}: {STATE_LABEL[picked.state]}</b>
          <span>{picked.summary} </span>
          {picked.fix && <TickText text={picked.fix} />}
          <div className="nd-door-acts">
            <button type="button" className="btn sm" onClick={onRecheck} disabled={checking}>
              {checking ? 'Checking…' : 'Re-check'}
            </button>
            <button type="button" className="btn sm outline-cyan" onClick={() => nav('/connect')}>
              Step-by-step: Connect your AI
            </button>
          </div>
        </div>
      ) : (
        <p className="setup-note">
          {DOOR_COPY[value].desc} {DOOR_COPY[value].note}
        </p>
      )}
    </div>
  );
}

interface SwitchDef<T extends string> {
  value: T;
  name: string;
  desc: string;
  warnTone?: boolean;
}

function SwitchGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: SwitchDef<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  const idx = options.findIndex((o) => o.value === value);
  const active = options[idx];
  const share = 100 / options.length;
  return (
    <div className="setup-section">
      <span className="uplabel bright">{label}</span>
      <div className="switch-group" role="radiogroup" aria-label={label} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        <motion.div
          className={`switch-thumb ${active?.warnTone ? 'warntone' : ''}`}
          style={{ width: `${share}%` }}
          animate={{ left: `${idx * share}%` }}
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        />
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={`switch-opt ${o.value === value ? 'on' : ''} ${o.warnTone ? 'warntone' : ''}`}
            onClick={() => onChange(o.value)}
          >
            <div className="so-name">{o.name}</div>
            <div className="so-desc">{o.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function NewDebate() {
  const nav = useNavigate();
  const [topic, setTopic] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [autonomy, setAutonomy] = useState<Autonomy>('interactive');
  const [profile, setProfile] = useState<ProfileChoice>(DEFAULT_PROFILE_CHOICE);
  /** Optional spend ceiling, off by default. At it the room asks to extend; it never argues less. */
  const [ceilingOn, setCeilingOn] = useState(false);
  const [ceiling, setCeiling] = useState('25');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which doors are ready (GET /api/doors, re-checked on arrival). One debate
   * runs on one provider. The door starts on the first ready one, or the one
   * a "Start a debate with this" link asked for; once the founder picks one
   * by hand, a re-check never moves it.
   */
  const [params] = useSearchParams();
  const doors = useDoors({ fresh: true });
  const [provider, setProvider] = useState<Provider>(() => defaultDoor(null, params.get('door')));
  const picked = useRef(false);
  useEffect(() => {
    if (doors.info && !picked.current) setProvider(defaultDoor(doors.info.doors, params.get('door')));
  }, [doors.info, params]);
  const pick = (p: Provider) => {
    picked.current = true;
    setProvider(p);
  };
  const door = doors.info?.doors.find((d) => d.id === provider) ?? null;
  /** Start waits for the door to be known and ready. A failed check does not block: the server checks again. */
  const doorReady = !!doors.info?.mock || (door ? door.state === 'ready' : !!doors.error);

  const initiate = async () => {
    if (!topic.trim() || busy || !doorReady) return;
    void primeNotifications(); // this click is the gesture the permission prompt needs
    setBusy(true);
    setError(null);
    try {
      const cap = Number(ceiling);
      const config: DebateConfig = {
        // The floor director decides who speaks (2b-7): the stored mode no longer changes anything.
        provider, mode: 'directed', autonomy, profile,
        ...(ceilingOn && provider !== 'codex' && Number.isFinite(cap) && cap > 0 ? { ceilingUsd: cap } : {}),
      };
      const { id } = await api.createDebate(topic.trim(), config, files.length > 0 ? files : undefined);
      nav(`/debate/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to initiate');
      setBusy(false);
    }
  };

  return (
    <div className="page-scroll">
      <div className="setup">
        <motion.div initial={{ opacity: 1, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}>
          <div className="deck-head">
            <h1 className="deck-title">New debate</h1>
            <button className="btn sm" onClick={() => nav('/')}>
              Back to the deck
            </button>
          </div>
        </motion.div>


        <motion.div
          className="setup-section"
          initial={{ opacity: 1, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 150, damping: 20, delay: 0.05 }}
        >
          <label className="uplabel bright" htmlFor="topic">What should the panel decide?</label>
          <div>
            <textarea
              id="topic"
              className="field"
              style={{ minHeight: 150 }}
              placeholder="Describe the decision in a paragraph: the choice, the numbers you know, your limits and what you are leaning towards. The more you say, the sharper the panel gets."
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 1, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 150, damping: 20, delay: 0.09 }}>
          <DossierZone files={files} onChange={setFiles} />
        </motion.div>

        <motion.div initial={{ opacity: 1, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 150, damping: 20, delay: 0.12 }}>
          <ProviderDoors value={provider} onChange={pick} doors={doors.info} checking={doors.checking} onRecheck={() => void doors.recheck()} />
        </motion.div>

        <motion.div initial={{ opacity: 1, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 150, damping: 20, delay: 0.15 }}>
          <SwitchGroup<ProfileChoice>
            label="Depth"
            value={profile}
            onChange={setProfile}
            options={[
              { value: 'auto', name: 'Auto', desc: 'The chair reads the ask: hard or high-stakes calls get the deep room. You can change it when you approve the goal.' },
              ...(Object.keys(BUDGET_PROFILES) as BudgetProfile[]).map((p) => ({
                value: p as ProfileChoice,
                name: BUDGET_PROFILES[p].label,
                desc: BUDGET_PROFILES[p].blurb,
              })),
            ]}
          />
          {provider !== 'codex' && (
            <label className="setup-ceiling">
              <input type="checkbox" checked={ceilingOn} onChange={(e) => setCeilingOn(e.target.checked)} />
              <span>
                Ask me before spending more than $
                <input
                  className="field num"
                  type="number"
                  min={1}
                  step={1}
                  value={ceiling}
                  disabled={!ceilingOn}
                  onChange={(e) => setCeiling(e.target.value)}
                />
                {provider === 'openai' ? ' on my OpenAI key.' : provider === 'anthropic' ? ' on my Claude API key.' : ' of plan-equivalent usage.'} Off by default: no limit is applied, and at the ceiling you are asked to extend it, never given a thinner debate.
              </span>
            </label>
          )}
        </motion.div>

        <motion.div initial={{ opacity: 1, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 150, damping: 20, delay: 0.24 }}>
          <SwitchGroup
            label="Autonomy"
            value={autonomy}
            onChange={setAutonomy}
            options={[
              { value: 'interactive', name: 'Interactive', desc: 'You approve the goal, panel, and plan. Marcus asks you things.' },
              { value: 'autonomous', name: 'Autonomous', desc: 'The panel runs unattended, end to end.', warnTone: true },
            ]}
          />
          <AnimatePresence>
            {autonomy === 'autonomous' && (
              <motion.div
                className="auto-warning"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="aw-in">
                  <b>Autonomy warning</b>
                  The panel will decide everything without you and log its assumptions. It may drift from what you intended. You can still watch live and end it at any time.
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>


        <NotifyToggle />

        <motion.div
          className="initiate-row"
          initial={{ opacity: 1, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 150, damping: 20, delay: 0.3 }}
        >
          <button className="btn primary lg" onClick={initiate} disabled={!topic.trim() || busy || !doorReady}>
            {busy ? 'Starting…' : 'Start the debate'}
          </button>
          <span className="uplabel">
            {!doorReady
              ? door
                ? `Connect ${door.title} first (see above), or pick one that is ready`
                : 'Checking your AI connection…'
              : topic.trim()
                ? 'Panel assembly begins immediately'
                : 'Topic required'}
          </span>
        </motion.div>
        {error && (
          <div className="feed-note err" style={{ marginTop: 16 }}>
            <b>Could not start</b>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
