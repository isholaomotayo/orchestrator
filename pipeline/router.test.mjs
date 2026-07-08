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
