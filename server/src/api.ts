import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CFG, debateDir } from './config.ts';
import { Debates, Events, displayTitle } from './db.ts';
import { Hub } from './sse.ts';
import { registerAuthRoutes, authRequired, isSignedIn, csrfToken } from './auth.ts';
import { providerAvailability } from './agents/sdk.ts';
import { UPLOAD_LIMITS } from './context.ts';
import { telegramEnabled } from './notify/index.ts';
import { PROVIDERS, type Provider } from '../../shared/models.ts';
import { DEFAULT_PROFILE_CHOICE, isProfile } from '../../shared/budget.ts';
import { emptyUsage } from '../../shared/types.ts';
import type { DebateDetail, DoorsInfo, SessionInfo } from '../../shared/types.ts';
import { doorStatus, doorsInfo } from './doors/index.ts';
import { REPORT_CSP_HEADER, withReportCsp } from './report/csp.ts';

const createSchema = z.object({
  topic: z.string().trim().min(8, 'Give the panel a topic, or attach a dossier and say "read the files".').max(5000),
  config: z.object({
    // The founder picks a provider door, never a model: models.ts casts seats.
    provider: z.enum(PROVIDERS as [Provider, ...Provider[]]),
    mode: z.enum(['directed', 'freeforall']),
    autonomy: z.enum(['interactive', 'autonomous']),
    // How deep the room argues. 'auto' (the default) lets the intake pick: hard calls go deep.
    profile: z.enum(['auto', 'quick', 'standard', 'deep']).default(DEFAULT_PROFILE_CHOICE),
    // Optional dollar ceiling. Off unless set; at it the founder is asked to extend.
    ceilingUsd: z.number().positive().max(100_000).nullable().optional(),
  }),
});

/** Engine facade — real or mock, same surface. */
export interface EngineFacade {
  create(topic: string, config: any, files?: { filename: string; buffer: Buffer }[]): string;
  get(id: string): any | null;
  resumeAll(): void;
  remove(id: string): void;
}

/** Debate ids are generated as `d_<base64url>`; anything else is not one of ours. */
const VALID_ID = /^d_[A-Za-z0-9_-]{4,32}$/;

export function registerApi(app: FastifyInstance, engine: EngineFacade) {
  registerAuthRoutes(app);

  app.get('/api/health', async () => ({ ok: true, uptime: process.uptime(), mock: CFG.mock }));

  /**
   * Who is here and what this machine can run. Public, because the app must
   * learn whether to show the password screen. The CSRF token rides along:
   * another origin cannot read this response, so it cannot learn the token.
   * Provider availability is booleans only, and only once signed in.
   */
  app.get('/api/me', async (req): Promise<SessionInfo> => {
    const ok = isSignedIn(req);
    return {
      ok,
      authRequired: authRequired(),
      csrfToken: csrfToken(req),
      providers: ok ? providerAvailability() : null,
      founderName: ok ? CFG.founderName || null : null,
      telegram: ok ? telegramEnabled() : false,
    };
  });

  /**
   * Readiness of the four doors, for the Connect screen and New Debate. No
   * model call. Plain text and states only: no key, token or account name
   * is ever in it. `?fresh=1` re-checks now and re-reads the keys in .env.
   */
  app.get('/api/doors', async (req): Promise<DoorsInfo> => {
    const fresh = String((req.query as any)?.fresh ?? '') === '1';
    return doorsInfo(fresh);
  });

  app.get('/api/debates', async () => Debates.list());

  app.post('/api/debates', async (req, reply) => {
    let body: unknown = req.body;
    const files: { filename: string; buffer: Buffer }[] = [];

    if ((req as any).isMultipart?.()) {
      const fields: Record<string, string> = {};
      /**
       * Every part is buffered, so the request as a whole is counted too:
       * @fastify/multipart limits each file, not their sum, and 40 files at
       * the per-file limit is gigabytes. Past the upload total the request
       * stops here, before the next part is read.
       */
      let received = 0;
      for await (const part of (req as any).parts()) {
        if (part.type === 'file') {
          const buffer: Buffer = await part.toBuffer();
          received += buffer.length;
          if (received > UPLOAD_LIMITS.maxTotal) {
            return reply.code(413).send({ error: `The files add up to more than ${UPLOAD_LIMITS.maxTotal / 1024 / 1024} MB. Upload fewer or smaller files.` });
          }
          files.push({ filename: part.filename ?? 'file', buffer });
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
      try {
        body = { topic: fields.topic, config: JSON.parse(fields.config ?? '{}') };
      } catch {
        return reply.code(400).send({ error: 'config field must be JSON' });
      }
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid' });

    // Refused here with a plain answer rather than three minutes into intake.
    // A cached "not ready" is re-checked once before refusing: it may have just been fixed.
    const provider = parsed.data.config.provider;
    if (!CFG.mock || CFG.mockRequireDoor) {
      let door = await doorStatus(provider);
      if (door.state !== 'ready') door = await doorStatus(provider, true);
      if (door.state !== 'ready') {
        return reply.code(400).send({ error: `${door.title} is not ready: ${door.summary} ${door.fix ?? ''}`.trim(), door: door.id });
      }
    }

    const id = engine.create(parsed.data.topic, parsed.data.config, files.length ? files : undefined);
    return { id };
  });

  /** 404 for anything that is not an existing debate. */
  const guard = (reply: any, id: string): boolean => {
    if (!VALID_ID.test(id) || !Debates.get(id)) {
      reply.code(404).send({ error: 'not found' });
      return false;
    }
    return true;
  };

  app.get('/api/debates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    const since = Number((req.query as any)?.since ?? 0) || 0;
    const row = Debates.get(id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    // Ensure it's driving after a restart, and unpark it if its credential has appeared.
    engine.get(id)?.retryCredential?.();
    const events = Events.since(id, since);
    const all = since === 0 ? events : Events.since(id, 0);
    const pendingQuestion = row.meta.pendingQuestionId
      ? (all.find((e) => e.type === 'question' && (e as any).questionId === row.meta.pendingQuestionId) as any) ?? null
      : null;
    const detail: DebateDetail = {
      id: row.id,
      title: displayTitle(row.title, row.topic),
      status: row.status,
      config: row.config,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: all.filter((e) => e.type === 'message').length,
      topic: row.topic,
      ownerName: CFG.founderName || null,
      goal: row.goal,
      personas: row.personas,
      plan: row.plan,
      events,
      pendingQuestion,
      pendingApproval: row.meta.pendingApproval,
      decisions: row.meta.decisions ?? [],
      activeMotionId: (row.plan?.items ?? []).find((i) => i.status === 'active')?.id ?? null,
      hasReport: fs.existsSync(path.join(debateDir(id), 'report.html')),
      hasPdf: fs.existsSync(path.join(debateDir(id), 'report.pdf')),
      hasTranscriptPdf: fs.existsSync(path.join(debateDir(id), 'transcript.pdf')),
      usage: row.meta.usage ?? emptyUsage(),
    };
    return detail;
  });

  app.get('/api/debates/:id/stream', (req, reply) => {
    const { id } = req.params as { id: string };
    // Every guard (host, origin, session) has already run in onRequest,
    // before the socket is hijacked.
    if (!guard(reply, id)) return reply;
    engine.get(id);
    const since = Number((req.query as any)?.since ?? 0) || 0;
    reply.hijack();
    Hub.subscribe(id, reply.raw, since);
  });

  app.post('/api/debates/:id/answer', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    const run = engine.get(id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    const b = req.body as any;
    const result = run.answer(String(b?.questionId ?? ''), String(b?.answer ?? '').slice(0, 4000));
    if (result === 'consumed') {
      return reply.code(409).send({ error: 'the panel has already taken this answer', result: 'consumed' });
    }
    return { ok: true, result };
  });

  app.post('/api/debates/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    const run = engine.get(id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    const b = req.body as any;
    const stage = String(b?.stage ?? '');
    const action = String(b?.action ?? '');
    if (!['goal', 'panel', 'plan'].includes(stage) || !['approve', 'revise'].includes(action)) {
      return reply.code(400).send({ error: 'bad stage/action' });
    }
    const ok = run.approve(stage, action, b?.feedback ? String(b.feedback).slice(0, 2000) : undefined);
    return ok ? { ok: true } : reply.code(409).send({ error: `not waiting on ${stage} approval` });
  });

  /** Override the profile (the intake's pick included) before the panel is designed. */
  app.post('/api/debates/:id/profile', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    const run = engine.get(id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    const p = (req.body as any)?.profile;
    if (!isProfile(p)) return reply.code(400).send({ error: 'profile must be quick, standard or deep' });
    return run.setProfile?.(p) ? { ok: true } : reply.code(409).send({ error: 'the panel is already being designed; the profile is fixed now' });
  });

  app.post('/api/debates/:id/end', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    const run = engine.get(id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    return run.end();
  });

  app.post('/api/debates/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    const run = engine.get(id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    return run.pause() ? { ok: true } : reply.code(409).send({ error: 'nothing to pause' });
  });

  app.post('/api/debates/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    const run = engine.get(id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    return run.resumeMeeting() ? { ok: true } : reply.code(409).send({ error: 'not paused' });
  });

  app.delete('/api/debates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    engine.remove(id);
    return { ok: true };
  });

  app.get('/api/debates/:id/report', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    const file = path.join(debateDir(id), 'report.html');
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'report not ready' });
    /**
     * Every word of this document is model-written. The renderer escapes it,
     * and the sandbox is the second wall: the report runs as an opaque origin,
     * so even a script that slipped through could not read the session
     * cookie or call this API. The policy also forbids every load and send,
     * so it could not carry the report's text anywhere either.
     */
    reply.type('text/html').header('content-security-policy', REPORT_CSP_HEADER);
    // The <meta> copy too, so a saved copy keeps the policy, whichever version wrote the file.
    return withReportCsp(fs.readFileSync(file, 'utf8'));
  });

  app.get('/api/debates/:id/report.pdf', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    const file = path.join(debateDir(id), 'report.pdf');
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'pdf not available' });
    const title = (Debates.get(id)?.title ?? 'debate-report').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
    reply.type('application/pdf').header('content-disposition', `attachment; filename="${title}.pdf"`);
    return fs.createReadStream(file);
  });

  /** The chat-styled transcript PDF. */
  app.get('/api/debates/:id/transcript.pdf', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    const file = path.join(debateDir(id), 'transcript.pdf');
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'pdf not available' });
    const title = (Debates.get(id)?.title ?? 'debate').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
    reply.type('application/pdf').header('content-disposition', `attachment; filename="${title}-transcript.pdf"`);
    return fs.createReadStream(file);
  });

  app.get('/api/debates/:id/transcript', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(reply, id)) return reply;
    const file = path.join(debateDir(id), 'transcript.md');
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'no transcript' });
    reply.type('text/markdown; charset=utf-8');
    return fs.readFileSync(file, 'utf8');
  });
}
