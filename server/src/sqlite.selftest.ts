/**
 * The built-in SQLite port: an existing database written by better-sqlite3
 * (server/fixtures/debate-better-sqlite3.db, made by 0.1.0) opens unchanged,
 * reads back the same rows, takes new writes; transactions, WAL, busy timeout,
 * backups and the targeted ExperimentalWarning filter all hold.
 *   npx tsx server/src/sqlite.selftest.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, transaction, withoutSqliteWarning, MIN_NODE } from './sqlite.ts';

// Any warning Node prints about SQLite during this run is a failure (Node 22.13-24.14 and 25.0-25.6 would print one).
const warnings: string[] = [];
process.on('warning', (w) => warnings.push(`${w.name}: ${w.message}`));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-sqlite-'));
fs.copyFileSync(new URL('../fixtures/debate-better-sqlite3.db', import.meta.url), path.join(dir, 'debate.db'));
process.env.DATA_DIR = dir;
const { default: db, Debates, Events, backupDb } = await import('./db.ts');

// 1. The old file reads back exactly as 0.1.0 read it.
{
  const list = Debates.list();
  assert.deepEqual(list.map((d) => [d.id, d.status, d.messageCount, d.attentionKey]), [
    ['fixture-c', 'intake', 0, 'question:q1'],
    ['fixture-a', 'meeting', 5, 'approval:plan'],
    ['fixture-b', 'paused', 1, 'paused'],
  ]);
  assert.equal(list[0].title, 'Untitled one');
  assert.deepEqual(list[1].config, { profile: 'standard' });
  assert.equal(typeof list[1].createdAt, 'number');

  const a = Debates.get('fixture-a')!;
  assert.equal(a.topic, 'Should the bakery open a second shop in Leeds — and when? (ünïcödé ✓)');
  assert.equal(a.goal, 'Decide yes/no and timing');
  assert.deepEqual(a.personas.map((p) => p.name), ['Ada', 'Bo']);
  assert.equal(a.plan, null);
  assert.equal(a.meta.spentUsd, 1.25);
  assert.deepEqual(a.meta.sessions, { p1: 's-1' });
  assert.equal(Debates.get('fixture-b')!.meta.limitPause?.kind, 'session');
  assert.equal(Debates.get('missing'), null);

  const evs = Events.since('fixture-a');
  assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal((evs[0] as any).text, 'Turn 0 — “quoted” 🍞');
  assert.deepEqual(Events.since('fixture-a', 4).map((e) => e.seq), [5, 6]);
  assert.deepEqual(Events.recent('fixture-a', 2).map((e) => e.seq), [5, 6]);
  assert.equal(Events.lastSeq('fixture-a'), 6);
  assert.equal(Events.lastSeq('missing'), 0);
}

// 2. Writes: new events continue the sequence, patches land, removal is complete.
{
  const ev = Events.append('fixture-a', { type: 'message', from: 'p1', text: 'new' } as any);
  assert.equal(ev.seq, 7);
  assert.equal(typeof ev.ts, 'number');
  assert.equal(Events.lastSeq('fixture-a'), 7);
  Debates.patch('fixture-a', { status: 'complete' });
  assert.equal(Debates.get('fixture-a')!.status, 'complete');
  const d = Debates.create('d_new1', 'Fresh topic', { profile: 'quick' } as any);
  assert.equal(d.status, 'intake');
  Debates.remove('d_new1');
  assert.equal(Debates.get('d_new1'), null);
  assert.equal(Events.lastSeq('d_new1'), 0);
}

// 3. Settings carried over from better-sqlite3.
{
  assert.equal((db.prepare('PRAGMA journal_mode').get() as any).journal_mode, 'wal');
  assert.equal((db.prepare('PRAGMA synchronous').get() as any).synchronous, 1); // NORMAL
  assert.equal((db.prepare('PRAGMA busy_timeout').get() as any).timeout, 5000);
}

// 4. transaction(): commit, rollback on throw, nested savepoints.
{
  const t = openDb(':memory:');
  t.exec('CREATE TABLE x (v INTEGER)');
  const ins = t.prepare('INSERT INTO x VALUES (?)');
  const count = () => (t.prepare('SELECT COUNT(*) n FROM x').get() as any).n;
  const add = transaction(t, (n: number) => { ins.run(n); return n * 2; });
  assert.equal(add(1), 2);
  assert.equal(count(), 1);
  const bad = transaction(t, () => { ins.run(2); throw new Error('boom'); });
  assert.throws(bad, /boom/);
  assert.equal(count(), 1);
  const outer = transaction(t, () => {
    ins.run(3);
    assert.throws(transaction(t, () => { ins.run(4); throw new Error('inner'); }), /inner/);
    transaction(t, () => ins.run(5))();
  });
  outer();
  assert.deepEqual((t.prepare('SELECT v FROM x ORDER BY v').all() as any[]).map((r) => r.v), [1, 3, 5]);
  // A failed transaction leaves the connection usable.
  add(6);
  assert.equal(count(), 4);
  t.close();
}

// 5. Backups (VACUUM INTO) still work and open read-only; a missing file is not silently created.
{
  const r = backupDb(2);
  assert.ok(r && r.bytes > 0);
  const ro = openDb(r!.file, { readOnly: true });
  assert.equal((ro.prepare('SELECT COUNT(*) n FROM debates').get() as any).n, 3);
  assert.throws(() => ro.exec('DELETE FROM debates'), /readonly/i);
  ro.close();
  assert.throws(() => openDb(path.join(dir, 'nope.db'), { readOnly: true }));
  assert.ok(!fs.existsSync(path.join(dir, 'nope.db')));
}

// 6. The warning filter drops the SQLite ExperimentalWarning and nothing else, and is removed afterwards.
{
  const emit = process.emitWarning;
  const seen: string[] = [];
  const spy = (w: Error) => seen.push(w.message);
  process.on('warning', spy);
  withoutSqliteWarning(() => {
    process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
    process.emitWarning('expected: not about SQLite', 'SelftestWarning');
  });
  assert.equal(process.emitWarning, emit);
  process.emitWarning('expected: after the filter', 'SelftestWarning');
  await new Promise((r) => setImmediate(r));
  process.off('warning', spy);
  assert.deepEqual(seen, ['expected: not about SQLite', 'expected: after the filter']);
  warnings.length = 0;
}

assert.match(MIN_NODE, /^22\.13\.0$/);
await new Promise((r) => setImmediate(r));
assert.deepEqual(warnings.filter((w) => /sqlite/i.test(w)), []);
db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('sqlite selftest: ok');
