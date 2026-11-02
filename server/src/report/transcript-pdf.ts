import type { DebateEvent, Persona } from '../../../shared/types.ts';
import type { DebateRow } from '../db.ts';
import { inlineFontCss } from './fonts.ts';
import { REPORT_CSP } from './csp.ts';

/**
 * The session as a group chat.
 *
 * The founder gets two documents: the report, which is the argument distilled
 * into decisions, and this, which is the argument itself. A markdown dump was
 * the wrong shape for the second one. Nobody reads a debate as a flat document;
 * they read it the way they read any other room they were not in, as a thread,
 * with faces attached to the voices and the moments that mattered pinned in
 * place.
 *
 * So it is typeset as a chat: each expert keeps their own colour from the live
 * session, the founder sits on the right the way you sit on the right of your
 * own conversations, motions open as day-dividers, and a ruling is a pinned
 * card rather than another line of talk. Everything in here also exists in
 * transcript.md on the app; this is the copy you would actually forward.
 */

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

const dayOf = (ts: number) =>
  new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** Readable ink on a persona's own colour, so avatars stay legible in print. */
function inkFor(hex: string): string {
  const h = hex.replace('#', '');
  if (h.length < 6) return '#ffffff';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#12181f' : '#ffffff';
}

function initialsOf(p: Persona): string {
  if (p.initials) return p.initials.slice(0, 2).toUpperCase();
  return p.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

interface Speaker {
  name: string;
  role: string;
  color: string;
  initials: string;
}

const DESKS: Record<string, Speaker> = {
  research: { name: 'Research desk', role: 'Outside facts', color: '#4a7fa5', initials: 'RD' },
  quant: { name: 'Quant desk', role: 'Computed from your files', color: '#2f8f74', initials: 'QD' },
};

export function renderTranscriptHtml(row: DebateRow, events: DebateEvent[], userName?: string | null): string {
  // Whose words the right-hand bubbles are. Unnamed, your own transcript
  // reads as an anonymous voice arguing with a named panel; named wrongly, it
  // reads as somebody else's session.
  const me = (userName || '').trim() || 'You';
  const byId = new Map(row.personas.map((p) => [p.id, p]));
  const speakerOf = (id: string): Speaker => {
    if (DESKS[id]) return DESKS[id];
    const p = byId.get(id);
    if (!p) return { name: id, role: '', color: '#6b7580', initials: id.slice(0, 2).toUpperCase() };
    return { name: p.name, role: p.role, color: p.color || '#6b7580', initials: initialsOf(p) };
  };

  const speakerNameOf = new Map<string, string>();
  for (const ev of events) if (ev.type === 'message') speakerNameOf.set(ev.id, speakerOf(ev.speaker).name);

  const parts: string[] = [];
  let lastDay = '';
  let lastSpeaker = '';
  let motionNo = 0;

  for (const ev of events) {
    const day = dayOf(ev.ts);
    if (day !== lastDay) {
      parts.push(`<div class="daysep"><span>${esc(day)}</span></div>`);
      lastDay = day;
      lastSpeaker = '';
    }

    if (ev.type === 'motion_open') {
      motionNo = ev.index;
      parts.push(`<div class="motion">
  <div class="m-tag">Motion ${ev.index} of ${ev.total}</div>
  <div class="m-title">${esc(ev.title)}</div>
  <div class="m-text">${esc(ev.motion)}</div>
</div>`);
      lastSpeaker = '';
      continue;
    }

    if (ev.type === 'decision') {
      const d = ev.decision;
      const dissents = d.dissents?.length
        ? `<div class="d-diss"><span class="d-lbl">Standing dissent${d.dissents.length === 1 ? '' : 's'}</span>${d.dissents
            .map((x) => `<div><b>${esc(x.expert)}</b> ${esc(x.position)}</div>`)
            .join('')}</div>`
        : '';
      const open = d.undecidable
        ? `<div class="d-open"><span class="d-lbl">Undecidable without</span> ${esc(d.undecidable.evidenceNeeded)} <i>(${esc(d.undecidable.who)})</i></div>`
        : '';
      parts.push(`<div class="ruling">
  <div class="r-head"><span class="r-pin">Ruling</span><span class="r-grade g-${esc(d.evidence)}">${esc(d.evidence)}</span></div>
  <div class="r-motion">${esc(d.motionTitle)}</div>
  <div class="r-text">${esc(d.decision)}</div>
  <div class="r-owner"><span class="d-lbl">Owner</span> ${esc(d.owner)}</div>
  ${d.rationale ? `<div class="r-why">${esc(d.rationale)}</div>` : ''}
  ${dissents}${open}
</div>`);
      lastSpeaker = '';
      continue;
    }

    // The record has to show the reversal. A chat log that prints a ruling and
    // then argues the same motion again, with nothing in between, reads as a
    // transcription fault rather than as the room changing its mind.
    if (ev.type === 'motion_reopened') {
      parts.push(`<div class="joined">Motion reopened · ${esc(ev.title)} · ${esc(ev.because)}</div>`);
      lastSpeaker = '';
      continue;
    }

    if (ev.type === 'panel_amended') {
      parts.push(`<div class="joined">${esc(ev.persona.name)} joined the room · ${esc(ev.persona.role)}</div>`);
      lastSpeaker = '';
      continue;
    }

    if (ev.type === 'answer') {
      const head = lastSpeaker === 'user' ? '' : `<div class="mename">${esc(me)}</div>`;
      parts.push(`<div class="row me">
  ${head}<div class="bub">${esc(ev.answer).replace(/\n/g, '<br>')}<span class="t">${time(ev.ts)}</span></div>
</div>`);
      lastSpeaker = 'user';
      continue;
    }

    if (ev.type === 'compute_done' && ev.computable) {
      const figs = ev.figures
        .map((f) => `<div class="f"><span class="fv">${esc(f.value)}</span><span class="fl">${esc(f.label)}</span><span class="fs">${esc(f.source)}</span></div>`)
        .join('');
      parts.push(`<div class="row">
  <div class="av" style="background:${DESKS.quant.color};color:${inkFor(DESKS.quant.color)}">QD</div>
  <div class="col">
    <div class="who">Quant desk <span class="ro">computed, not argued</span></div>
    <div class="bub card">
      <div class="q">${esc(ev.question)}</div>
      ${figs ? `<div class="figs">${figs}</div>` : ''}
      <div>${esc(ev.answer)}</div>
      <span class="t">${time(ev.ts)}</span>
    </div>
  </div>
</div>`);
      lastSpeaker = 'quant';
      continue;
    }

    if (ev.type !== 'message') continue;

    const sp = speakerOf(ev.speaker);
    const isMarcus = ev.speaker === 'marcus';
    const same = lastSpeaker === ev.speaker;
    const tag =
      ev.kind === 'closing' ? '<span class="kind">closing</span>'
      : ev.kind === 'interjection' ? '<span class="kind int">interrupts</span>'
      : ev.kind === 'research' ? '<span class="kind">brief</span>'
      : '';
    // Realism-engine turns (Phase 2b): who was talked over, and where a turn was cut.
    const overName = ev.overlap ? speakerNameOf.get(ev.overlap.with) : undefined;
    const overTag = overName ? `<span class="kind int">over ${esc(overName)}</span>` : '';
    const cutTag = ev.cutOff ? `— <span class="ro">cut off by ${esc(speakerOf(ev.cutOff.by).name)}</span>` : '';

    parts.push(`<div class="row${isMarcus ? ' chair' : ''}${same ? ' cont' : ''}">
  ${same ? '<div class="av ghost"></div>' : `<div class="av" style="background:${sp.color};color:${inkFor(sp.color)}">${esc(sp.initials)}</div>`}
  <div class="col">
    ${same && !overTag ? '' : `<div class="who" style="color:${sp.color}">${esc(sp.name)}${sp.role ? ` <span class="ro">${esc(sp.role)}</span>` : ''}${tag}${overTag}</div>`}
    <div class="bub"${isMarcus ? ' data-chair' : ''}>${esc(ev.text).replace(/\n/g, '<br>')}${cutTag}<span class="t">${time(ev.ts)}</span></div>
  </div>
</div>`);
    lastSpeaker = ev.speaker;
  }

  const roster = row.personas
    .map((p) => `<li><span class="ra" style="background:${p.color};color:${inkFor(p.color)}">${esc(initialsOf(p))}</span><span class="rn">${esc(p.name)}</span><span class="rr">${esc(p.role)}</span></li>`)
    .join('');

  const started = events.length ? dayOf(events[0].ts) : '';
  const msgs = events.filter((e) => e.type === 'message').length;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">
<title>${esc(row.title)} — transcript</title>
<style>${inlineFontCss(['Rajdhani', 'Inter', 'JetBrains Mono'])}</style>
<style>
  :root {
    --ink: #12181f; --ink2: #3d4752; --mut: #78838f;
    --line: #e3e7ec; --wash: #f4f6f8; --chair: #8a6510;
    --ui: 'Inter', -apple-system, system-ui, sans-serif;
    --disp: 'Rajdhani', 'Inter', sans-serif;
    --mono: 'JetBrains Mono', ui-monospace, monospace;
  }
  @page { size: A4; margin: 14mm 12mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--ui); font-size: 11.5px; line-height: 1.55; color: var(--ink2); background: #fff; }
  .wrap { max-width: 186mm; margin: 0 auto; }

  /* ---- cover ---- */
  .cover { min-height: 240mm; display: flex; flex-direction: column; justify-content: space-between; break-after: page; }
  .cv-top { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid var(--ink); padding-bottom: 8px; }
  .cv-brand { font-family: var(--mono); font-size: 9.5px; letter-spacing: .3em; color: var(--ink); }
  .cv-kind { font-family: var(--mono); font-size: 9px; letter-spacing: .18em; color: var(--mut); text-transform: uppercase; }
  h1 { font-family: var(--disp); font-weight: 700; font-size: 38px; line-height: 1.08; color: var(--ink); margin: 40mm 0 0; }
  .cv-sub { font-size: 13px; color: var(--ink2); margin: 10px 0 0; max-width: 130mm; }
  .cv-meta { font-family: var(--mono); font-size: 10px; color: var(--mut); margin-top: 14px; letter-spacing: .04em; }
  .roster { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
  .roster li { display: grid; grid-template-columns: 26px 1fr; gap: 4px 10px; padding: 7px 0; border-bottom: 1px solid var(--line); align-items: center; }
  .ra { grid-row: span 2; width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        font-family: var(--mono); font-size: 9.5px; font-weight: 500; }
  .rn { font-weight: 600; color: var(--ink); font-size: 12px; }
  .rr { font-size: 10.5px; color: var(--mut); grid-column: 2; }

  /* ---- the thread ---- */
  .daysep { display: flex; align-items: center; gap: 10px; margin: 18px 0 12px; break-after: avoid; }
  .daysep::before, .daysep::after { content: ''; flex: 1; height: 1px; background: var(--line); }
  .daysep span { font-family: var(--mono); font-size: 8.5px; letter-spacing: .18em; text-transform: uppercase; color: var(--mut); }

  .row { display: grid; grid-template-columns: 30px 1fr; gap: 9px; margin: 9px 0; break-inside: avoid; }
  .row.cont { margin-top: 3px; }
  .av { width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        font-family: var(--mono); font-size: 10px; font-weight: 500; }
  .av.ghost { background: none; }
  .col { min-width: 0; }
  .who { font-size: 11.5px; font-weight: 600; margin-bottom: 3px; }
  .ro { font-weight: 400; color: var(--mut); font-size: 10px; }
  .kind { font-family: var(--mono); font-size: 8px; letter-spacing: .12em; text-transform: uppercase;
          color: var(--mut); border: 1px solid var(--line); padding: 1px 5px; margin-left: 6px; }
  .kind.int { color: #b4552e; border-color: #f0d4c6; }

  .bub { position: relative; background: var(--wash); border: 1px solid var(--line); border-radius: 3px 12px 12px 12px;
         padding: 8px 11px 16px; color: var(--ink2); }
  .bub[data-chair] { background: #fdf8ec; border-color: #eadfc4; }
  .t { position: absolute; right: 9px; bottom: 4px; font-family: var(--mono); font-size: 8px; color: var(--mut); }

  .row.me { grid-template-columns: 1fr; justify-items: end; }
  .row.me .mename { font-size: 7.6pt; font-weight: 600; color: var(--dim); margin: 0 2px 2px 0; text-align: right; }
  .row.me .bub { background: #e8f2f7; border-color: #cfe3ee; border-radius: 12px 3px 12px 12px; max-width: 78%; color: var(--ink); }

  .bub.card .q { font-family: var(--mono); font-size: 9.5px; letter-spacing: .04em; color: var(--mut);
                 text-transform: uppercase; margin-bottom: 7px; line-height: 1.5; }
  .figs { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1px;
          background: var(--line); border: 1px solid var(--line); margin: 0 0 8px; }
  .f { background: #fff; padding: 6px 8px; display: flex; flex-direction: column; gap: 1px; }
  .fv { font-family: var(--mono); font-size: 13px; color: #2f8f74; font-weight: 500; }
  .fl { font-size: 10px; color: var(--ink); }
  .fs { font-family: var(--mono); font-size: 8px; color: var(--mut); overflow-wrap: anywhere; }

  /* ---- pinned moments ---- */
  .motion { border: 1px solid var(--line); border-left: 3px solid var(--ink); background: #fff;
            padding: 10px 13px; margin: 20px 0 12px; break-inside: avoid; }
  .m-tag { font-family: var(--mono); font-size: 8.5px; letter-spacing: .2em; text-transform: uppercase; color: var(--mut); }
  .m-title { font-family: var(--disp); font-weight: 700; font-size: 17px; color: var(--ink); margin: 3px 0 5px; }
  .m-text { font-size: 11.5px; color: var(--ink2); }

  .ruling { border: 1px solid #cfe0d8; background: #f3f9f6; padding: 11px 13px; margin: 14px 0; break-inside: avoid; }
  .r-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
  .r-pin { font-family: var(--mono); font-size: 8.5px; letter-spacing: .2em; text-transform: uppercase; color: #2f7d63; }
  .r-grade { font-family: var(--mono); font-size: 8.5px; letter-spacing: .14em; text-transform: uppercase;
             border: 1px solid currentColor; padding: 1px 6px; color: var(--mut); }
  .g-measured { color: #2f8f74; } .g-observed { color: #8a6510; } .g-assumed { color: #b4552e; }
  .r-motion { font-family: var(--mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--mut); }
  .r-text { font-family: var(--disp); font-weight: 600; font-size: 15px; line-height: 1.35; color: var(--ink); margin: 4px 0 6px; }
  .r-owner, .r-why, .d-diss, .d-open { font-size: 10.5px; margin-top: 4px; }
  .r-why { color: var(--ink2); border-left: 1px solid #cfe0d8; padding-left: 8px; }
  .d-lbl { font-family: var(--mono); font-size: 8px; letter-spacing: .14em; text-transform: uppercase; color: var(--mut); }
  .d-diss div { margin-top: 2px; }
  .d-open { color: #8a6510; }

  .joined { text-align: center; font-family: var(--mono); font-size: 9px; letter-spacing: .1em;
            color: var(--mut); margin: 12px 0; }
</style></head>
<body><div class="wrap">
<section class="cover">
  <div>
    <div class="cv-top"><span class="cv-brand">THE DEBATE APP</span><span class="cv-kind">Full transcript</span></div>
    <h1>${esc(row.title)}</h1>
    <p class="cv-sub">${esc(row.goal ?? row.topic)}</p>
    <div class="cv-meta">${esc(started)} · ${msgs} contributions · ${row.personas.length} in the room</div>
  </div>
  <div>
    <ul class="roster">${roster}</ul>
  </div>
</section>
${parts.join('\n')}
</div></body></html>`;
}
