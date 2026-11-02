/**
 * SQLite from Node itself (`node:sqlite`), so installing the app compiles
 * nothing: no Visual Studio, no Xcode tools, no build-essential. It replaced
 * better-sqlite3, which published no prebuilt binaries for 13.x.
 *
 * Every SQLite open in the app and its scripts goes through `openDb`, which
 * keeps the settings better-sqlite3 gave us (a 5 s busy timeout) and loads the
 * module quietly; `transaction` stands in for better-sqlite3's `db.transaction`.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

export type { DatabaseSync, StatementSync };

/** The oldest Node with `node:sqlite` available without a flag. Launchers and the doctor check the same number. */
export const MIN_NODE = '22.13.0';

/** better-sqlite3's default; how long a write waits for another connection's lock. */
const BUSY_TIMEOUT_MS = 5000;

const EXPERIMENTAL_SQLITE = 'SQLite is an experimental feature';

/**
 * Node 22.13-24.14 and 25.0-25.6 print "ExperimentalWarning: SQLite is an
 * experimental feature" the first time the module loads (24.15 and 25.7
 * stopped). That line would be the first thing a non-coder sees in the start
 * window, so it is dropped here, and only it: the filter is in place for the
 * single synchronous load and is removed straight after. Every other warning
 * still prints.
 */
export function withoutSqliteWarning<T>(fn: () => T): T {
  const emit = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (typeof msg === 'string' && msg.startsWith(EXPERIMENTAL_SQLITE)) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return fn();
  } finally {
    process.emitWarning = emit;
  }
}

function loadSqlite(): typeof import('node:sqlite') {
  let mod: typeof import('node:sqlite') | undefined;
  try {
    // getBuiltinModule rather than an import: a static import would load (and warn) before any code here runs.
    mod = withoutSqliteWarning(() => (typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : undefined));
  } catch {
    mod = undefined;
  }
  if (!mod?.DatabaseSync) {
    throw new Error(
      `This app needs Node.js ${MIN_NODE} or newer for its built-in database; you have ${process.versions.node}. ` +
        'Install the current "LTS" version from https://nodejs.org and start the app again.'
    );
  }
  return mod;
}

let sqlite: typeof import('node:sqlite') | undefined;

export function openDb(file: string, opts: { readOnly?: boolean } = {}): DatabaseSync {
  sqlite ??= loadSqlite();
  // readOnly opens without SQLITE_OPEN_CREATE, so a missing file is an error rather than a new empty database.
  const db = new sqlite.DatabaseSync(file, { readOnly: !!opts.readOnly });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

const depth = new WeakMap<DatabaseSync, number>();

/**
 * Wraps `fn` so each call runs in one transaction: committed when it returns,
 * rolled back when it throws. A nested call becomes a savepoint, as in
 * better-sqlite3. `fn` must be synchronous.
 */
export function transaction<A extends unknown[], R>(db: DatabaseSync, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const level = depth.get(db) ?? 0;
    const sp = `tx_${level}`;
    db.exec(level ? `SAVEPOINT ${sp}` : 'BEGIN');
    depth.set(db, level + 1);
    try {
      const out = fn(...args);
      db.exec(level ? `RELEASE ${sp}` : 'COMMIT');
      return out;
    } catch (err) {
      // Some errors (a full disk, for one) make SQLite roll back by itself; the original error is the one to report.
      try { db.exec(level ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    } finally {
      depth.set(db, level);
    }
  };
}
