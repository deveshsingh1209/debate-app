/**
 * Import debates from an old data directory (for example a backup of a
 * hosted install) into this one.
 *
 *   npm run import-backup -- <path-to-old-data-dir>
 *
 * What comes across: the debates and events tables, and each debate's
 * workspace (uploaded context, transcript, reports, scratch files).
 *
 * What never comes across: accounts, auth codes, grant requests, sessions,
 * the session-secret file, recovery keys, .env files, token ciphertext, any
 * per-debate Codex login (codex-home/, auth.json), *.key files, and backups.
 *
 * The source is read-only: its SQLite files are copied to a temporary
 * directory and opened there, and the script checks afterwards that no
 * source file changed. Debates already present here are skipped, so running
 * it twice is safe.
 *
 * Imported debates that were mid-run are not resumed automatically, because
 * resuming spends model quota: a debate that was in the meeting is set to
 * `paused` (press Resume to continue); one that was in any other working
 * phase is marked `error` with a note. Their agent sessions lived on the old
 * machine, so the experts' session ids are cleared and they rebuild context
 * from the transcript.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerOfConfig } from '../../shared/models.ts';
import { openDb, transaction } from '../src/sqlite.ts';

const src = process.argv[2];
if (!src) {
  console.error('usage: npm run import-backup -- <path-to-old-data-dir>');
  process.exit(2);
}
const srcDir = path.resolve(src);
const srcDb = path.join(srcDir, 'debate.db');
if (!fs.existsSync(srcDb)) {
  console.error(`No debate.db in ${srcDir}`);
  process.exit(2);
}

// Destination: this install's data dir (DATA_DIR or ./data). Importing db.ts
// creates the schema if this is a fresh install.
const { default: dest } = await import('../src/db.ts');
const { CFG } = await import('../src/config.ts');
if (path.resolve(CFG.dataDir) === srcDir) {
  console.error('Source and destination are the same directory.');
  process.exit(2);
}

const VALID_ID = /^d_[A-Za-z0-9_-]{4,32}$/;
const TERMINAL = new Set(['complete', 'error', 'cancelled']);
const WAITING = new Set(['clarifying', 'goal_approval', 'panel_approval', 'plan_approval', 'paused']);
/** Never copied out of a workspace, at any depth. */
const EXCLUDED_DIRS = new Set(['codex-home']);
const isExcludedFile = (name: string) =>
  name === 'auth.json' || name === 'session-secret' || name.endsWith('.key') || name.startsWith('.env') || name === '.debate-recovery-key' || name === '.access-password';

// ---- snapshot the source so nothing ever opens it for writing ----

const fingerprint = (files: string[]) =>
  files.filter((f) => fs.existsSync(f)).map((f) => {
    const s = fs.statSync(f);
    return `${f}:${s.size}:${s.mtimeMs}`;
  }).join('|');

const srcDbFiles = ['', '-wal', '-shm'].map((s) => srcDb + s);
const before = fingerprint(srcDbFiles);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-import-'));
for (const f of srcDbFiles) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(tmp, path.basename(f)));
const old = openDb(path.join(tmp, 'debate.db'));

// ---- debates and events ----

const exists = dest.prepare('SELECT 1 FROM debates WHERE id = ?');
const insertDebate = dest.prepare(
  `INSERT INTO debates (id, title, topic, goal, status, config, personas, plan, meta, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`
);
const insertEvent = dest.prepare(`INSERT INTO events (debate_id, seq, ts, type, payload) VALUES (?,?,?,?,?)`);

const rows = old.prepare('SELECT * FROM debates ORDER BY created_at').all() as any[];
const imported: string[] = [];
const skipped: string[] = [];
const statusChanges: string[] = [];
let events = 0;

const importOne = transaction(dest, (r: any) => {
  const config = JSON.parse(r.config);
  config.provider = providerOfConfig(config);

  const meta = JSON.parse(r.meta || '{}');
  delete meta.limitPause;
  let status: string = r.status;
  if (!TERMINAL.has(status)) {
    meta.sessions = {};
    meta.lastSeen = {};
    if (status === 'meeting') status = 'paused';
    else if (!WAITING.has(status)) {
      meta.importNote = `Imported while "${status}". Not resumed automatically, because that would spend model quota.`;
      status = 'error';
    }
    if (status !== r.status) statusChanges.push(`${r.id}: ${r.status} -> ${status}`);
  }

  insertDebate.run(
    r.id, r.title, r.topic, r.goal, status, JSON.stringify(config), r.personas, r.plan,
    JSON.stringify(meta), r.created_at, r.updated_at
  );
  const evs = old.prepare('SELECT seq, ts, type, payload FROM events WHERE debate_id = ? ORDER BY seq').all(r.id) as any[];
  for (const e of evs) insertEvent.run(r.id, e.seq, e.ts, e.type, e.payload);
  events += evs.length;
});

for (const r of rows) {
  if (!VALID_ID.test(r.id)) { skipped.push(`${r.id} (unrecognised id)`); continue; }
  if (exists.get(r.id)) { skipped.push(`${r.id} (already here)`); continue; }
  importOne(r);
  imported.push(r.id);
}
old.close();
fs.rmSync(tmp, { recursive: true, force: true });

// ---- workspaces ----

let filesCopied = 0;
const excluded: string[] = [];

function copyTree(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, ent.name);
    const b = path.join(to, ent.name);
    if (ent.isSymbolicLink()) { excluded.push(`${a} (symlink)`); continue; }
    if (ent.isDirectory()) {
      if (EXCLUDED_DIRS.has(ent.name)) { excluded.push(a); continue; }
      copyTree(a, b);
    } else if (ent.isFile()) {
      if (isExcludedFile(ent.name)) { excluded.push(a); continue; }
      fs.copyFileSync(a, b);
      filesCopied++;
    }
  }
}

for (const id of imported) {
  const from = path.join(srcDir, 'debates', id);
  if (fs.existsSync(from) && fs.lstatSync(from).isDirectory()) copyTree(from, path.join(CFG.dataDir, 'debates', id));
}

// ---- report ----

const after = fingerprint(srcDbFiles);
console.log(`\nImported ${imported.length} debate${imported.length === 1 ? '' : 's'} (${events} events, ${filesCopied} workspace files) into ${CFG.dataDir}`);
if (skipped.length) console.log(`Skipped ${skipped.length}: ${skipped.join(', ')}`);
if (statusChanges.length) console.log(`Not resumed automatically:\n  ${statusChanges.join('\n  ')}`);
if (excluded.length) console.log(`Left behind on purpose (${excluded.length}):\n  ${excluded.join('\n  ')}`);
console.log('Not imported: accounts, auth codes, grant requests, session-secret, recovery keys, .env, backups/.');
if (before !== after) {
  console.error('WARNING: a source database file changed during the import.');
  process.exit(1);
}
console.log('Source left untouched.');
