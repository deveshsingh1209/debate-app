import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useDebate } from '../lib/stream';
import { fmtClock, statusIsLive } from '../lib/format';
import { BootSplash, useElapsed, useMediaQuery } from '../components/hud';
import { PhaseTrack } from '../components/PhaseTrack';
import { HoldButton } from '../components/HoldButton';
import { Roster } from '../components/Roster';
import { Transcript } from '../components/Transcript';
import { MissionRail } from '../components/MissionRail';
import { Dock } from '../components/Dock';
import { Countdown, ThinkingPanel, ProcessingBay, StagePanel } from '../components/Cinematic';
import { MotionBar, DecisionsLedger, TokenMeter } from '../components/MotionHud';
import { TableStrip } from '../components/Floor';
import { RoomSettings } from '../components/RoomSettings';
import { Sound } from '../lib/voice';
import { PROVIDER_LABEL, providerOfConfig } from '../../../shared/models';

export default function WarRoom() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { state, actions } = useDebate(id);
  const narrow = useMediaQuery('(max-width: 1100px)');
  const [drawer, setDrawer] = useState<'roster' | 'mission' | null>(null);
  const [countdown, setCountdown] = useState(false);
  const seen = useRef({ status: '', decisions: 0, motions: 0, concessions: 0, streams: 0, report: false, asked: false, booted: false });
  /** When the live overlap cue last played, so the same cut is not cued twice when it lands in the log. */
  const liveCutAt = useRef(0);

  /**
   * Audio + theatre driven by real events, never on a timer:
   * the countdown fires the moment the room actually goes into session.
   *
   * CEREMONY IS FOR THINGS THAT JUST HAPPENED, NEVER FOR HISTORY.
   * Opening this page mid-session bootstraps from the whole event log, and the
   * initial status is a placeholder ('intake') until that lands. Without the
   * `booted` latch, the placeholder-to-real jump reads as a live transition and
   * a reload re-runs the opening countdown over a debate that is an hour old —
   * which is exactly how a refresh ended up pinning the overlay again. The
   * first pass after load adopts the session as it stands and stays silent.
   */
  const motionsOpened = state.feed.reduce((n, f) => n + (f.fk === 'motion' ? 1 : 0), 0);
  const concessions = state.feed.reduce((n, f) => n + (f.fk === 'concession' ? 1 : 0), 0);
  const cutOffs = state.feed.reduce((n, f) => n + (f.fk === 'msg' && (f.ev.cutOff || f.ev.kind === 'interjection') ? 1 : 0), 0);
  useEffect(() => {
    const s = seen.current;
    if (!state.loaded) return;
    if (!s.booted) {
      s.booted = true;
      s.status = state.status;
      s.decisions = state.decisions.length;
      s.motions = motionsOpened;
      s.concessions = concessions;
      s.streams = cutOffs;
      s.report = !!state.reportPath;
      return;
    }
    if (state.status && state.status !== s.status) {
      if (state.status === 'meeting' && s.status && s.status !== 'paused') {
        setCountdown(true);            // plan approved, session opening
      }
      s.status = state.status;
    }

    // The chair's gavel: twice when a motion opens, once when it is ruled.
    if (motionsOpened > s.motions) Sound.play('gavel', 2);
    else if (state.decisions.length > s.decisions) Sound.play('gavel', 1);
    s.motions = motionsOpened;
    s.decisions = state.decisions.length;

    // Someone moved.
    if (concessions > s.concessions) Sound.play('concession');
    s.concessions = concessions;

    // A turn cut off (the live cut is handled where the second stream starts).
    if (cutOffs > s.streams && Date.now() - liveCutAt.current > 15_000) Sound.play('interrupt');
    s.streams = cutOffs;

    if (state.reportPath && !s.report) Sound.play('report');
    s.report = !!state.reportPath;

    // The panel needs the founder.
    const needsUser = !!state.pendingQuestion || state.pendingClarify.length > 0;
    if (needsUser && !s.asked) { Sound.play('alert'); s.asked = true; }
    if (!needsUser) s.asked = false;
  }, [state.loaded, state.status, state.decisions.length, motionsOpened, concessions, cutOffs, state.reportPath, state.pendingQuestion, state.pendingClarify.length]);

  /** Two voices at once: the interruption cue fires as the second one starts, not when the log catches up. */
  const liveStreams = state.streams.length;
  const lastStreams = useRef(0);
  useEffect(() => {
    if (seen.current.booted && liveStreams > 1 && lastStreams.current <= 1) {
      Sound.play('interrupt');
      liveCutAt.current = Date.now();
    }
    lastStreams.current = liveStreams;
  }, [liveStreams]);

  /**
   * The floating panel slot (thinking panel / stage panel) sits over the tail
   * of the feed, so the feed must reserve its measured height the same way it
   * reserves the dock's. Before this, the feed reserved a default 92px while
   * the panel grew far taller and 45%-transparent, so the newest transcript
   * lines rendered THROUGH it: the overlap in the founder's screenshot.
   */
  const [tpSlotEl, setTpSlotEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    /**
     * Callback ref + state, deliberately. The slot div only exists in the
     * meeting layout and WarRoom mounts during intake, so a mount-only effect
     * armed against nothing and the reserve stayed zero for the whole session
     * (verified live: panel 240px tall, --tp-h unset, transcript underneath).
     * The no-deps variant fixed that by re-arming on EVERY render, which tears
     * down and rebuilds the observer on each streamed token and strips the
     * property in every cleanup, flickering the feed's padding. Keying on the
     * element itself re-arms exactly when the slot appears or leaves, and
     * never in between.
     */
    const root = document.documentElement;
    if (!tpSlotEl) { root.style.removeProperty('--tp-h'); return; }
    const ro = new ResizeObserver(([entry]) => {
      root.style.setProperty('--tp-h', `${Math.ceil(entry.contentRect.height)}px`);
    });
    ro.observe(tpSlotEl);
    return () => { ro.disconnect(); root.style.removeProperty('--tp-h'); };
  }, [tpSlotEl]);

  /**
   * The floor changes hands: the quietest cue there is, once per new speaker,
   * never per token. The old per-seat chimes, the thinking drone and the
   * spoken announcements are gone: an hour of them was the opposite of a
   * tense room (docs/PHASE3-UI-PLAN.md, decision 4).
   */
  const lastSpeaker = useRef<string | null>(null);
  useEffect(() => {
    const who = state.speaking.speaker;
    if (!who) return;
    if (seen.current.booted && lastSpeaker.current && who !== lastSpeaker.current) Sound.play('tick');
    lastSpeaker.current = who;
  }, [state.speaking.speaker]);

  /**
   * Failsafe. The countdown is a full-screen modal: if its beat sheet ever
   * fails to finish, the whole session becomes unwatchable behind it. Its own
   * timers are the primary dismissal; this is the floor under them, set well
   * past the longest scripted beat (6.4s). Deps are a boolean and a stable
   * setter, so this never churns on re-render.
   */
  useEffect(() => {
    if (!countdown) return;
    const t = setTimeout(() => setCountdown(false), 12_000);
    return () => clearTimeout(t);
  }, [countdown]);

  const terminal = !statusIsLive(state.status);
  const elapsed = useElapsed(state.createdAt, terminal ? state.updatedAt : null);

  if (state.fatal) {
    return (
      <div className="boot">
        <div style={{ textAlign: 'center' }}>
          <div className="b-line" style={{ animation: 'none', color: 'var(--red)' }}>
            {state.fatal}
          </div>
          <button className="btn sm" style={{ marginTop: 18 }} onClick={() => nav('/')}>
            Back to deck
          </button>
        </div>
      </div>
    );
  }
  if (!state.loaded) return <BootSplash line="Reconstructing war room" />;

  const paused = state.status === 'paused';
  const dimmed = !!(
    (state.pendingApproval && state.pendingApproval !== 'panel') ||
    state.pendingQuestion ||
    state.pendingClarify.length > 0
  );

  /**
   * The phases that can sit silent for minutes. Dossier reading happens during
   * intake but deserves its own copy, so it is distinguished by whether the
   * brief has landed yet.
   */
  const bayPhase = (() => {
    if (state.speaking.phase) return null;              // someone is talking, no bay
    if (state.status === 'intake') {
      return state.dossier === null && state.feed.some((f) => f.fk === 'system' && /dossier/i.test(f.text))
        ? 'dossier'
        : 'intake';
    }
    if (state.status === 'panel_design') return 'panel_design';
    if (state.status === 'planning') return 'planning';
    if (state.status === 'reporting') return 'reporting';
    return null;
  })();

  const speaker = state.speaking.speaker ? state.personas[state.speaking.speaker] : undefined;
  const lastDirection =
    state.lastBids?.bids.find((b) => b.speaker === state.speaking.speaker)?.hook ?? null;

  return (
    <div className="warroom">
      <AnimatePresence>
        {countdown && (
          <Countdown
            key="cine"
            panelSize={state.personaOrder.filter((id) => !state.personas[id]?.isModerator).length}
            motionTitle={state.plan?.items?.[0]?.title}
            onDone={() => setCountdown(false)}
          />
        )}
      </AnimatePresence>

      <div className="hud">
        <button className="btn sm icon" onClick={() => nav('/')} title="Back to the deck" aria-label="Back to the deck">
          <span aria-hidden>‹</span>
        </button>
        <h1 className="hud-title" title={state.topic}>
          {state.title || 'Untitled'}
        </h1>
        <div className="hud-sep" />
        <PhaseTrack status={state.status} />
        <div className="hud-spacer" />

        <div className="hud-group">
          {state.config && <span className="chip">{PROVIDER_LABEL[providerOfConfig(state.config)]}</span>}
          {state.config?.autonomy === 'autonomous' && <span className="chip amber">Autonomous</span>}
        </div>
        <div className="hud-sep" />
        <div className="hud-stat opt">
          <span className="v">{fmtClock(elapsed)}</span>
          <span className="k">Elapsed</span>
        </div>
        <div className="hud-stat opt">
          <span className="v">{state.messageCount}</span>
          <span className="k">Messages</span>
        </div>
        <TokenMeter state={state} />
        <div className="hud-sep" />
        <span
          className={`conn-dot ${state.connection === 'live' ? 'live' : 'down'}`}
          role="img"
          aria-label={state.connection === 'live' ? 'Connected' : `Connection: ${state.connection}`}
          title={`Link: ${state.connection}`}
        />
        <RoomSettings />

        {!terminal && (
          <>
            <button className={`btn sm ${paused ? 'outline-cyan' : ''}`} onClick={() => (paused ? actions.resume() : actions.pause())}>
              {paused ? 'Resume' : 'Pause'}
            </button>
            <HoldButton label="Hold to end" holdLabel="Ending…" onConfirm={() => actions.end()} />
          </>
        )}
        {terminal && state.reportPath && (
          <button className="btn sm outline-cyan" onClick={() => nav(`/debate/${id}/report`)}>
            Report
          </button>
        )}

        <div className="rail-toggles">
          <button className="btn sm" onClick={() => setDrawer(drawer === 'roster' ? null : 'roster')}>
            Panel
          </button>
          <button className="btn sm" onClick={() => setDrawer(drawer === 'mission' ? null : 'mission')}>
            Record
          </button>
        </div>
      </div>

      <div className="wr-body">
        <div className="rail">
          <div className="rail-head">
            <span className="uplabel bright">The panel</span>
            <span className="uplabel">{Math.max(0, state.personaOrder.length - 1) || ''}</span>
          </div>
          <Roster state={state} />
        </div>

        <div className="wr-centre">
          <MotionBar state={state} />
          {paused && state.quotaPause && (
            <div className="quota-banner" role="status">
              <b>Paused: waiting for quota</b>
              {state.quotaPause.resumesAt
                ? <>, resumes ~{new Date(state.quotaPause.resumesAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}{state.quotaPause.stated ? '' : ' (first try; it backs off if the window has not reset)'}</>
                : null}
              . Nothing is lost or cut; Resume tries now.
            </div>
          )}
          {['meeting', 'paused', 'wrapup'].includes(state.status) && <TableStrip state={state} />}
          <AnimatePresence>
            {bayPhase && (
              <ProcessingBay
                key={bayPhase}
                phase={bayPhase}
                files={state.dossier?.files ?? undefined}
              />
            )}
          </AnimatePresence>
          <Transcript state={state} dimmed={dimmed} onOpenReport={() => nav(`/debate/${id}/report`)} />
        </div>
        <div className="tp-slot" ref={setTpSlotEl}>
          {/**
            * No AnimatePresence here, deliberately. Exit animations require a
            * frame loop to finish, and when frames are throttled (background
            * tab, busy main thread) the exiting panels never leave: verified
            * live with TWELVE stacked panels forming a 1074px wall over the
            * transcript. The standing rule is that decorative animation must be
            * structurally incapable of covering the feed, so panels unmount
            * instantly; only the entrance animates, and an entrance cannot
            * outlive its element.
            */}
          {state.speaking.phase && (
            <ThinkingPanel
              key={`${state.speaking.speaker}-${state.speaking.phase}`}
              persona={speaker}
              direction={lastDirection}
              phase={state.speaking.phase}
            />
          )}
          {/* Nobody is speaking, but the room is working. Without this the
              longest stretches of the session looked like a hang. */}
          {!state.speaking.phase && <StagePanel stage={state.stage} />}
        </div>

        <div className="rail right">
          <div className="rail-head">
            <span className="uplabel bright">Decisions</span>
            <span className="uplabel">{state.decisions.length || ''}</span>
          </div>
          <DecisionsLedger decisions={state.decisions} />
          <div className="rail-head" style={{ marginTop: 18 }}>
            <span className="uplabel bright">Agenda and research</span>
          </div>
          <MissionRail state={state} />
        </div>

        {/* Narrow-screen drawers */}
        <AnimatePresence>
          {narrow && drawer && (
            <>
              <motion.div
                key="veil"
                className="drawer-veil"
                initial={{ opacity: 1 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setDrawer(null)}
              />
              <motion.div
                key={drawer}
                className={`drawer ${drawer === 'roster' ? 'left' : 'right'}`}
                initial={{ x: drawer === 'roster' ? '-100%' : '100%' }}
                animate={{ x: 0 }}
                exit={{ x: drawer === 'roster' ? '-100%' : '100%' }}
                transition={{ type: 'spring', stiffness: 260, damping: 28 }}
              >
                <div className="rail-head">
                  <span className="uplabel bright">{drawer === 'roster' ? 'The panel' : 'The record'}</span>
                  <button className="btn sm" onClick={() => setDrawer(null)}>
                    Close
                  </button>
                </div>
                {drawer === 'roster' ? (
                  <Roster state={state} />
                ) : (
                  <>
                    <div className="rail-head">
                      <span className="uplabel bright">Decisions</span>
                      <span className="uplabel">{state.decisions.length || ''}</span>
                    </div>
                    <DecisionsLedger decisions={state.decisions} />
                    <div className="rail-head" style={{ marginTop: 18 }}>
                      <span className="uplabel bright">Agenda and research</span>
                    </div>
                    <MissionRail state={state} />
                    <div className="rail-head" style={{ marginTop: 18 }}>
                      <span className="uplabel bright">Budget and usage</span>
                    </div>
                    <TokenMeter state={state} expanded />
                  </>
                )}
              </motion.div>
            </>
          )}
        </AnimatePresence>

        <Dock state={state} actions={actions} />
      </div>
    </div>
  );
}
