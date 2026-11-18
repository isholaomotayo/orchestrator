// End to end on the CLI surface with runner "claude": the real engine drives a
// fake `claude` binary on PATH that speaks stream-json. The checks fail after
// the first coder cycle, forcing a fix cycle, which must resume the coder's
// session — or, when the CLI refuses the resume, rerun that cycle cold. No
// model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipelinePaths } from './state.mjs';

const ENGINE = new URL('./orchestrator.mjs', import.meta.url).pathname;
const STAGES = ['planner', 'plan_reviewer', 'designer', 'coder', 'tester', 'reviewer', 'handoff', 'reporter'];
const FILES = { planner: 'specs.md', plan_reviewer: 'plan_review.md', coder: 'changes.md', tester: 'test_suite.md', reviewer: 'review_report.md', handoff: 'handoff.md', reporter: 'reporter.md' };
const pad = (s) => s.padEnd(260, ' ');
const VALID = {
  planner: pad('# Specification\n\n## Objective\nAdd the module.\n\n## Failure Modes\n| ID | Case |\n|---|---|\n| E1 | empty input |\n\n## 3. Tracer-Bullet Tickets\n\n### Ticket 1: Module\n- **Files:** src/mod.js\n- **Dependencies:** None\n\n## Acceptance\nTests pass.\n'),
  plan_reviewer: pad('# PLAN APPROVAL REVIEW\n\n## Verdict: APPROVED\n\n## Spec Coverage\nAll rows covered.\n\n## Required Revisions\nNone.\n'),
  coder: pad('## Fix Cycle 1\nImplemented src/mod.js.\n\n## Self-Review\nE1 handled in src/mod.js:3.\n'),
  tester: pad('# Test Suite\n\n## Coverage Map\n| E1 | mod.test.js |\n\n## Uncovered\nNone.\n'),
  reviewer: pad('# Review\n\n## Verdict: APPROVED\n\n## Spec Coverage\n| ID | Status | Evidence |\n|---|---|---|\n| E1 | covered | mod.test.js |\n'),
  handoff: pad('# Handoff\n\nAll done; nothing pending.\n'),
  reporter: pad('## Summary\nAdded the module with a test.\n'),
};

// The fake CLI. Every call is logged to calls.jsonl with its stage and any
// --resume id. The coder's second call writes pass-marker, which turns the
// checks green. With refuse-resume present, a --resume call fails the way a
// CLI with an unknown session does.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv[0] === 'auth') { console.log('{"loggedIn":true}'); process.exit(0); }
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const stage = (/prompt for (\\w+)/.exec(at('--append-system-prompt') || '') || [])[1];
const resume = at('--resume');
const files = ${JSON.stringify(FILES)};
const valid = ${JSON.stringify(VALID)};
const calls = fs.existsSync('calls.jsonl') ? fs.readFileSync('calls.jsonl', 'utf8').trim().split('\\n').filter(Boolean).length : 0;
const mine = fs.existsSync('calls.jsonl') ? fs.readFileSync('calls.jsonl', 'utf8').split('\\n').filter((l) => l.includes('"stage":"' + stage + '"')).length : 0;
const message = at('-p') || '';
fs.appendFileSync('calls.jsonl', JSON.stringify({ stage, resume, n: calls + 1, taskBlock: message.includes('TASK BLOCK'), notes: message.includes('FOLLOW-UP NOTES') && message.includes('rename the helper'), message: message.slice(0, 300) }) + '\\n');
if (resume && fs.existsSync('refuse-resume')) {
  console.error('Error: No conversation found with session ID: ' + resume);
  process.exit(1);
}
const session = resume || ('sess-' + stage + '-' + (calls + 1));
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-5' }));
if (files[stage]) fs.writeFileSync('.pipeline/' + files[stage], valid[stage]);
if (stage === 'coder' && mine >= 1) fs.writeFileSync('pass-marker', '1');
// A note queued from the dashboard while the first coder cycle runs.
if (stage === 'coder' && mine === 0) { fs.mkdirSync('.pipeline/followups', { recursive: true }); fs.writeFileSync('.pipeline/followups/coder.txt', 'Please rename the helper.'); }
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: session, total_cost_usd: 0.001, num_turns: 1 }));
`;

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-e2e-')));
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'calls.jsonl\npass-marker\nrefuse-resume\nbin/\n');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  const paths = pipelinePaths(root);
  fs.mkdirSync(paths.prompts, { recursive: true });
  for (const stage of STAGES) fs.writeFileSync(path.join(paths.prompts, `${stage}_prompt.txt`), `prompt for ${stage}`);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(paths.config, JSON.stringify({
    bridge: { required: false }, agentTimeoutMs: 20000, agentRetries: 1,
    // Red until the coder's fix cycle writes pass-marker; never fewer passing tests.
    checks: { lint: '', typecheck: '', test: 'if [ -f pass-marker ]; then echo "# pass 4"; echo "# fail 0"; else echo "# pass 3"; echo "# fail 1"; exit 1; fi' },
  }));
  const calls = () => fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const run = () => spawnSync(process.execPath, [ENGINE, '--task', 'add a module', '--runner', 'claude', '--mode', 'cli', '--no-ui'], { cwd: root, encoding: 'utf8', timeout: 90000, env });
  return { root, paths, calls, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

const status = (paths) => JSON.parse(fs.readFileSync(paths.status, 'utf8'));
const events = (paths) => fs.readFileSync(paths.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('CLI e2e: the coder fix cycle resumes the session that wrote the code, and the run lands', () => {
  const r = repo();
  try {
    const res = r.run();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const s = status(r.paths);
    assert.equal(s.overall, 'done');
    assert.equal(s.verdict, 'APPROVED');
    const coder = r.calls().filter((c) => c.stage === 'coder');
    assert.equal(coder.length, 2, 'one initial cycle and one fix cycle');
    assert.equal(coder[0].resume, null, 'the first cycle starts cold');
    assert.equal(coder[1].resume, `sess-coder-${coder[0].n}`, 'the fix cycle resumes the first cycle\'s session');
    assert.equal(coder[0].taskBlock, true, 'a cold start carries the whole task');
    assert.equal(coder[1].taskBlock, false, 'the resumed session already has it: only the new instruction goes');
    assert.match(coder[1].message, /^Fix cycle 2: .*task you have been implementing in this session/);
    assert.equal(coder[1].notes, true, 'a note queued during cycle 1 reaches the resumed session');
    for (const other of r.calls().filter((c) => c.stage !== 'coder')) assert.equal(other.resume, null, `${other.stage} never resumes`);
    // The model the CLI reported, not the requested family.
    assert.equal(s.stages.find((st) => st.name === 'coder').actualModel, 'claude-sonnet-5');
    assert.equal(s.stages.find((st) => st.name === 'coder').modelSource, 'cli-observed');
  } finally { r.cleanup(); }
});

test('CLI e2e: when the CLI refuses the resume, the fix cycle reruns cold and the run still lands', () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.root, 'refuse-resume'), '1');
    const res = r.run();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(status(r.paths).overall, 'done');
    const coder = r.calls().filter((c) => c.stage === 'coder');
    assert.equal(coder.length, 3, 'cold cycle 1, refused resume, cold rerun of cycle 2');
    assert.ok(coder[1].resume, 'cycle 2 tried to resume first');
    assert.equal(coder[2].resume, null, 'then ran cold');
    assert.equal(coder[1].taskBlock, false, 'the resume attempt sent only the instruction');
    assert.equal(coder[2].taskBlock, true, 'the cold rerun sent the whole task again');
    const failed = events(r.paths).filter((e) => e.type === 'session_resume_failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].stage, 'coder');
    assert.equal(events(r.paths).filter((e) => e.type === 'agent_retry' && e.stage === 'coder').length, 0, 'the refused resume did not spend a retry');
  } finally { r.cleanup(); }
});
