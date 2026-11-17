import test from 'node:test';
import assert from 'node:assert/strict';
import { heuristicRoute, stateDefaultStage } from './router.mjs';

test('heuristicRoute matches single stage keywords', () => {
  assert.deepEqual(heuristicRoute('Create a design and write the spec'), { stage: 'planner', ambiguous: false });
  assert.deepEqual(heuristicRoute('Fix the bug in implementation'), { stage: 'coder', ambiguous: false });
  assert.deepEqual(heuristicRoute('Run the test and check coverage'), { stage: 'tester', ambiguous: false });
  assert.deepEqual(heuristicRoute('Do a security review and give a verdict'), { stage: 'reviewer', ambiguous: false });
});

test('heuristicRoute handles case insensitivity', () => {
  assert.deepEqual(heuristicRoute('BUG ERROR REFRACTOR'), { stage: 'coder', ambiguous: false });
  assert.deepEqual(heuristicRoute('TEST SUITE'), { stage: 'tester', ambiguous: false });
});

test('heuristicRoute resolves highest score correctly', () => {
  // coder has 2 matches ('bug', 'error'), planner has 1 ('spec')
  assert.deepEqual(heuristicRoute('this bug has an error in the spec'), { stage: 'coder', ambiguous: false });
});

test('heuristicRoute detects ambiguity on ties', () => {
  // coder has 1 ('bug'), tester has 1 ('test')
  assert.deepEqual(heuristicRoute('bug and test'), { stage: null, ambiguous: true });
});

test('heuristicRoute detects ambiguity on no keyword match', () => {
  assert.deepEqual(heuristicRoute('hello world'), { stage: null, ambiguous: true });
  assert.deepEqual(heuristicRoute(''), { stage: null, ambiguous: true });
  assert.deepEqual(heuristicRoute(null), { stage: null, ambiguous: true });
});

test('stateDefaultStage selects running stage', () => {
  const status = {
    stages: [
      { name: 'planner', status: 'passed' },
      { name: 'coder', status: 'running' },
      { name: 'tester', status: 'pending' },
      { name: 'reviewer', status: 'pending' },
    ]
  };
  assert.equal(stateDefaultStage(status), 'coder');
});

test('stateDefaultStage selects first non-passed stage if none running', () => {
  const status = {
    stages: [
      { name: 'planner', status: 'passed' },
      { name: 'coder', status: 'passed' },
      { name: 'tester', status: 'pending' },
      { name: 'reviewer', status: 'pending' },
    ]
  };
  assert.equal(stateDefaultStage(status), 'tester');
});

test('stateDefaultStage falls back to coder if all passed', () => {
  const status = {
    stages: [
      { name: 'planner', status: 'passed' },
      { name: 'coder', status: 'passed' },
      { name: 'tester', status: 'passed' },
      { name: 'reviewer', status: 'passed' },
    ]
  };
  assert.equal(stateDefaultStage(status), 'coder');
});

test('stateDefaultStage handles invalid or empty status', () => {
  assert.equal(stateDefaultStage(null), 'coder');
  assert.equal(stateDefaultStage({}), 'coder');
  assert.equal(stateDefaultStage({ stages: [] }), 'coder');
});

test('classifyWithLlm hands the runner its native model id, not the family', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { classifyWithLlm } = await import('./router.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-'));
  const argsFile = path.join(dir, 'args');
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho coder\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  try {
    const stage = await classifyWithLlm({ text: 'x', status: { models: { stages: { planner: 'opus-5' } } }, config: {}, runner: 'claude' });
    assert.equal(stage, 'coder');
    const args = fs.readFileSync(argsFile, 'utf8').split('\n');
    assert.notEqual(args[args.indexOf('--model') + 1], 'opus-5');
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
