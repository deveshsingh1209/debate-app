import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { CFG, PASSWORD_FILE, generatedPassword } from './config.ts';
// Early, so the Telegram token is out of process.env before anything can copy it.
import { startNotifications } from './notify/index.ts';
import { guard, isLoopback } from './auth.ts';
import { registerApi, type EngineFacade } from './api.ts';
import { startBackups } from './db.ts';
import { backfillOfficeExtractions } from './context.ts';

async function main() {
  /**
   * Local by default. Listening anywhere but loopback without a password
   * would hand the debates, and the credentials the agents spend, to anyone
   * on the network, so that combination refuses to start.
   */
  if (!isLoopback(CFG.host) && !CFG.accessPassword) {
    console.error(
      `[debate] refusing to start: HOST=${CFG.host} is reachable from other machines, so ACCESS_PASSWORD must be set. ` +
        'Set it in .env, or leave HOST unset to stay on 127.0.0.1.'
    );
    process.exit(1);
  }

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 60 * 1024 * 1024, files: 40, fields: 10 },
  });
  app.addHook('onRequest', guard);
  // Unexpected failures: details to the terminal, a plain sentence to the browser.
  app.setErrorHandler((err: any, _req, reply) => {
    const status = Number(err?.statusCode) >= 400 && Number(err?.statusCode) < 500 ? Number(err.statusCode) : 500;
    if (status >= 500) {
      console.error('[debate] request failed:', err);
      return reply.code(500).send({ error: 'Something went wrong on the server. Details are in the terminal where the app is running.' });
    }
    return reply.code(status).send({ error: String(err?.message ?? 'bad request').slice(0, 200) });
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('referrer-policy', 'no-referrer');
    return payload;
  });

  /**
   * MOCK=1 runs the REAL engine with scripted models (engine/mock-live.ts), so
   * the mock exercises the live floor end to end. MOCK_ENGINE=scripted keeps
   * the older player, which replays a fixed script without the engine.
   */
  const scriptedPlayer = CFG.mock && (process.env.MOCK_ENGINE ?? '').trim() === 'scripted';
  if (CFG.mock && !scriptedPlayer) console.log(`[debate] MOCK: real engine, scripted models (scenario "${(await import('./engine/mock-live.ts')).installMockModels()}")`);
  const engine: EngineFacade = scriptedPlayer
    ? (await import('./engine/mock.ts')).MockEngine
    : (await import('./engine/runner.ts')).Engine;

  registerApi(app, engine);

  // Static SPA (production build). In dev, Vite serves the app and proxies /api.
  //
  // wildcard MUST be true. With wildcard:false @fastify/static enumerates the
  // directory once at boot and registers a route per file, so a rebuild that
  // writes new content-hashed filenames is invisible until a restart: the
  // browser then requests a bundle that 404s, falls through to the SPA
  // handler, receives index.html as JavaScript, and renders a blank page.
  const webDist = path.resolve(process.cwd(), 'web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: true,
      setHeaders(res, filePath) {
        // Hashed assets are immutable; the shell must never be cached.
        if (filePath.endsWith('.html')) res.header('cache-control', 'no-store, must-revalidate');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      // Never hand HTML to a request for a build asset: fail loudly instead,
      // so a stale or missing bundle is obvious rather than a blank screen.
      if (req.method === 'GET' && req.url.startsWith('/assets/')) {
        return reply.code(404).type('text/plain').send('asset not found');
      }
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply
          .type('text/html')
          .header('cache-control', 'no-store, must-revalidate')
          .send(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8'));
      }
      reply.code(404).send({ error: 'not found' });
    });
  }

  startBackups();
  backfillOfficeExtractions();
  startNotifications(); // before resumeAll, so resumed debates are seeded, not announced
  engine.resumeAll();

  await app.listen({ port: CFG.port, host: CFG.host });
  console.log(
    `[debate] ${CFG.mock ? 'MOCK ' : ''}server on http://${CFG.host}:${CFG.port} (data: ${CFG.dataDir})` +
      (CFG.accessPassword ? ' · password required' : '')
  );
  if (generatedPassword) {
    // Printed this once, on the start that created it; later starts only say where it is.
    const bar = '='.repeat(64);
    console.log(
      `\n${bar}\n  SIGN-IN PASSWORD (generated for this container, shown only now)\n\n      ${generatedPassword}\n\n` +
        `  It is saved in ${PASSWORD_FILE} (your data folder),\n  so it stays the same after a restart. To choose your own, set\n  ACCESS_PASSWORD and delete that file.\n${bar}\n`
    );
  } else if (process.env.AUTO_ACCESS_PASSWORD === '1' && fs.existsSync(PASSWORD_FILE) && CFG.accessPassword) {
    console.log(`[debate] sign-in password: the one in ${PASSWORD_FILE} (your data folder)`);
  }
}

main().catch((err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[debate] port ${CFG.port} is already in use. Stop the other program or set PORT in .env (for example PORT=${CFG.port + 1}).`);
  } else if (err?.code === 'EACCES' || err?.code === 'EPERM') {
    console.error(`[debate] no permission to start (${err.code}). Check that ${CFG.dataDir} is writable, or run \`npm run doctor\`.`);
  } else {
    console.error('[debate] could not start. Run `npm run doctor` for a checklist. Details:', err);
  }
  process.exit(1);
});
