/**
 * npm run eval -- <debate-id|path> [options]
 *
 * Evaluates one saved debate offline. Makes no model call.
 *
 *   <ref>               a debate id (data/debate.db, then data/debates/<id>/transcript.md),
 *                       or a path to an event-log .json or a transcript.md
 *   --json              print the evaluation as JSON
 *   --judge             print the prompt a model judge would receive (stdout)
 *   --schema            print the JSON schema for the judge's answer
 *   --evidence          re-grade the run's claims under the P1 evidence rules: before/after counts,
 *                       every claim moved and why, and first-person anecdotes told as fact
 *   --compare <old> <new>   markdown comparison of two runs (old first)
 *   --out <file>        write the output to a file instead of stdout
 *   --judge-with        refuses unless EVAL_ALLOW_MODEL_CALLS=1; no model client is wired in
 *   --check <file>      validate a judge's JSON answer against the rubric
 */
import fs from 'node:fs';
import { ALLOW_ENV, checkJudgement, compare, evaluate, judgePrompt, judgeSchema, load, modelCallRefusal, renderEvaluation, renderEvidenceAudit } from './eval-lib.ts';

async function main() {
  const args = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const valued = new Set(['--out', '--check', '--compare']);
  const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
  const emit = (text: string) => {
    const out = val('--out');
    if (out) { fs.writeFileSync(out, text.endsWith('\n') ? text : `${text}\n`); console.error(`wrote ${out}`); }
    else console.log(text);
  };

  if (flag('--schema')) return emit(JSON.stringify(judgeSchema(), null, 2));
  if (flag('--check')) {
    const problems = checkJudgement(JSON.parse(fs.readFileSync(val('--check')!, 'utf8')));
    console.log(problems.length ? `Invalid:\n- ${problems.join('\n- ')}` : 'Valid judge output.');
    process.exit(problems.length ? 1 : 0);
  }
  if (flag('--judge-with')) {
    const refusal = modelCallRefusal();
    if (refusal) { console.error(refusal); process.exit(3); }
    console.error(`${ALLOW_ENV}=1 is set, but this kit ships no model client: it only produces the prompt. Run --judge and send it yourself. Nothing was sent.`);
    process.exit(3);
  }

  const ref = val('--compare') ?? positional[0];
  if (!ref) {
    console.error('Usage: npm run eval -- <debate-id|path> [--judge] [--evidence] [--json] [--schema] [--compare <old> <new>] [--out <file>]');
    process.exit(2);
  }
  const first = await load(ref);
  const evalFirst = evaluate(first);

  if (flag('--compare')) {
    const newRef = positional[0];
    if (!newRef) { console.error('usage: npm run eval -- --compare <old> <new>'); process.exit(2); }
    const second = evaluate(await load(newRef));
    return emit(compare(evalFirst, second).markdown);
  }
  if (flag('--judge')) return emit(judgePrompt(first, evalFirst));
  if (flag('--evidence')) return emit(renderEvidenceAudit(evalFirst.id, evalFirst.evidence));
  if (flag('--json')) return emit(JSON.stringify(evalFirst, null, 2));
  emit(renderEvaluation(evalFirst));
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
