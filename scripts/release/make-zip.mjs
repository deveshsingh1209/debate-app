#!/usr/bin/env node
/**
 * Builds the release download: release/debate-app-<version>.zip.
 *
 *   node scripts/release/make-zip.mjs            # from the committed tree (HEAD)
 *   node scripts/release/make-zip.mjs --notes    # also release/release-notes.md from CHANGELOG.md
 *
 * Contents: every file git tracks at HEAD, inside one top-level folder
 * `debate-app-<version>/`, with each file's git mode. The launchers are
 * stored as Unix 0755, so on macOS and Linux they open with a double-click
 * straight from the unzipped folder. (GitHub's own "Download ZIP" drops
 * those bits; the README's right-click / chmod fallback covers that case.)
 *
 * No node_modules and no build output: the launcher installs and builds on
 * first start. That keeps the zip small and means this project never
 * redistributes its dependencies (one of them, the Claude Agent SDK, is
 * not open source; see THIRD_PARTY_NOTICES.md).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (args, enc = 'utf8') => execFileSync('git', args, { cwd: root, encoding: enc, maxBuffer: 1 << 30 });

const version = JSON.parse(git(['show', 'HEAD:package.json'])).version;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) throw new Error(`package.json version is not semver: ${version}`);
const name = `debate-app-${version}`;

const UNIX = 3;
const files = {};
let exec = 0;
// git ls-tree gives "<mode> blob <sha>\t<path>" for every tracked file at HEAD.
for (const line of git(['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean)) {
  const [meta, file] = line.split('\t');
  const [mode, type, sha] = meta.split(' ');
  if (type !== 'blob') continue;                       // submodules have no content to ship
  const unixMode = mode === '100755' ? 0o100755 : mode === '120000' ? 0o120777 : 0o100644;
  if (mode === '100755') exec++;
  const data = new Uint8Array(execFileSync('git', ['cat-file', 'blob', sha], { cwd: root, maxBuffer: 1 << 30 }));
  files[`${name}/${file}`] = [data, { os: UNIX, attrs: (unixMode << 16) >>> 0, level: 9 }];
}

const outDir = path.join(root, 'release');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${name}.zip`);
fs.writeFileSync(out, zipSync(files, { mtime: new Date(git(['log', '-1', '--format=%cI', 'HEAD']).trim()) }));
console.log(`${path.relative(root, out)}: ${Object.keys(files).length} files, ${exec} executable, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);

if (process.argv.includes('--notes')) {
  const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const m = log.match(new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  if (!m) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const body = m[1].split('\n').filter((l) => !/^\[[^\]]+\]: /.test(l)).join('\n');   // drop the link references
  fs.writeFileSync(path.join(outDir, 'release-notes.md'), body.trim() + '\n');
  console.log('release/release-notes.md written from CHANGELOG.md');
}
