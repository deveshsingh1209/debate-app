#!/usr/bin/env node
/**
 * Fails if any installed package would compile native code at install time
 * (node-gyp, prebuild-install, node-pre-gyp, cmake-js, or a binding.gyp that
 * npm builds by default). Installing the app must need no compiler on any
 * system; CI runs this right after `npm ci` on Linux, macOS and Windows.
 *
 * Prebuilt native binaries (esbuild, rolldown, lightningcss, sharp's @img
 * packages, fsevents) are fine: they are downloaded, not built.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILDERS = /\b(node-gyp|prebuild-install|node-pre-gyp|cmake-js)\b/;
const found = [];
let seen = 0;

function visit(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.name.startsWith('@')) { visit(p); continue; }
    const pj = path.join(p, 'package.json');
    if (fs.existsSync(pj)) {
      seen++;
      let j = {};
      try { j = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { /* not a package */ }
      const s = j.scripts ?? {};
      const install = ['preinstall', 'install', 'postinstall'].map((k) => s[k]).filter(Boolean).join(' ; ');
      // npm runs `node-gyp rebuild` for a package with a binding.gyp and no install script of its own.
      const implicitGyp = fs.existsSync(path.join(p, 'binding.gyp')) && !s.install && !s.preinstall;
      if (BUILDERS.test(install) || implicitGyp) found.push(`${path.relative(root, p)}: ${install || 'binding.gyp'}`);
    }
    visit(path.join(p, 'node_modules'));
  }
}

for (const nm of ['node_modules', 'server/node_modules', 'web/node_modules']) visit(path.join(root, nm));

if (!seen) {
  console.error('no-native-build: no installed packages found; run `npm ci` first.');
  process.exit(2);
}
if (found.length) {
  console.error(`no-native-build: ${found.length} package(s) would compile at install time:\n  ${found.join('\n  ')}`);
  process.exit(1);
}
console.log(`no-native-build: ${seen} installed packages, none compiles native code at install.`);
