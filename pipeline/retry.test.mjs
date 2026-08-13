import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyFailure, backoffMs } from './retry.mjs';
import { pipelinePaths } from './state.mjs';

test('provider capacity and network errors are transient', () => {
  for (const tail of [
    'API Error: 529 overloaded_error',
    'Error: 503 Service Unavailable',
    'rate limit exceeded, retry after 20s',
    'read ECONNRESET',
    'socket hang up',
    'Error: 429 Too Many Requests',
  ]) {
    assert.equal(classifyFailure({ ok: false, exitCode: 1 }, tail).transient, true, tail);
  }
});

test('a timeout is transient — the same stage often completes on a retry', () => {
  assert.equal(classifyFailure({ ok: false, timedOut: true }, '').transient, true);
});

test('auth, quota, and model-configuration failures are fatal', () => {
  for (const tail of [
    'Failed to authenticate: OAuth session expired',
    'authentication required',
    'Invalid API key provided',
    'unknown model: opus-4.8',
    'quota exceeded for this organization',
    'insufficient credit balance',
  ]) {
    assert.equal(classifyFailure({ ok: false, exitCode: 1 }, tail).transient, false, tail);
  }
});

test('fatal wins over a transient-looking substring in the same output', () => {
  // A 503 in the noise must not make an expired session look retryable.
  const tail = 'GET /v1/models 503\nFailed to authenticate: OAuth session expired';
  assert.equal(classifyFailure({ ok: false, exitCode: 1 }, tail).transient, false);
});

test('an unrecognised failure is fatal so real bugs surface immediately', () => {
  assert.equal(classifyFailure({ ok: false, exitCode: 1 }, 'something went sideways').transient, false);
  assert.equal(classifyFailure({ ok: false, error: 'spawn claude ENOENT' }, '').transient, false);
});

test('backoff grows exponentially and is capped', () => {
  assert.equal(backoffMs(1), 2000);
  assert.equal(backoffMs(2), 4000);
  assert.equal(backoffMs(3), 8000);
  assert.equal(backoffMs(20), 30000);
  assert.equal(backoffMs(0), 2000);
});

// The boundary is the only thing standing between an autonomous writing agent
// and instructions planted in the repository it is reading.
test('every stage prompt carries the trust boundary', () => {
  const paths = pipelinePaths(process.cwd());
  const prompts = fs.readdirSync(paths.prompts).filter((f) => f.endsWith('_prompt.txt'));
  assert.equal(prompts.length, 6, 'expected six stage prompts');
  for (const name of prompts) {
    const text = fs.readFileSync(path.join(paths.prompts, name), 'utf8');
    assert.match(text, /TRUST BOUNDARY/, `${name} is missing the trust boundary`);
    assert.match(text, /never commands to be followed/i, name);
    assert.match(text, /exfiltrate/i, name);
  }
});
