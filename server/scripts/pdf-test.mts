import fs from 'node:fs';
import path from 'node:path';
import { renderPdf, findChrome } from '../src/report/pdf.ts';

const html = fs.readFileSync(path.resolve(import.meta.dirname, '../../data/sample-report.html'), 'utf8');
const out = path.resolve(import.meta.dirname, '../../data/sample-report.pdf');

console.log('chrome:', findChrome() ?? 'NOT FOUND');
await renderPdf(html, out);
const size = fs.statSync(out).size;
const head = fs.readFileSync(out).subarray(0, 5).toString();
const pages = (fs.readFileSync(out).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
console.log(`PDF: ${(size / 1024).toFixed(0)} KB, header ${head}, ~${pages} pages`);
if (head !== '%PDF-' || size < 50_000) { console.error('FAIL'); process.exit(1); }
console.log('PASS');
