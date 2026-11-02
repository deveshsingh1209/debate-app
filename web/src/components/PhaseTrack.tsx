import type { DebateStatus } from '../../../shared/types';
import { PHASES, STATUS_LABEL, phaseIndex, statusTone } from '../lib/format';

/** Mission-phase HUD track: 8 diamond stations + live status label. */
export function PhaseTrack({ status }: { status: DebateStatus }) {
  const idx = phaseIndex(status);
  const tone = statusTone(status);
  const labelCls = tone === 'amber' ? 'amber' : tone === 'red' ? 'red' : tone === 'green' ? 'green' : '';
  return (
    <div className="phase-track" title={PHASES.map((p, i) => `${i === idx ? '>' : ' '} ${p}`).join('\n')}>
      {PHASES.map((p, i) => (
        <div key={p} className={`phase-node ${i < idx ? 'done' : ''} ${i === idx ? 'now' : ''}`}>
          {i > 0 && <span className="phase-link" />}
          <span className="phase-pip" title={p} />
        </div>
      ))}
      <span className={`phase-label ${labelCls}`}>{STATUS_LABEL[status]}</span>
    </div>
  );
}
