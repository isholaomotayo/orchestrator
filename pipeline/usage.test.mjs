import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUsage } from './usage.mjs';

test('readUsage totals cost incrementally and starts over when the file is replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const file = path.join(dir, 'events.jsonl');
  assert.deepEqual(readUsage(file), { costUsd: null, measured: 0, partial: true });
  fs.writeFileSync(file, `${JSON.stringify({ costUsd: 0.5 })}\n${JSON.stringify({ type: 'x' })}\n`);
  assert.deepEqual(readUsage(file), { costUsd: 0.5, measured: 1, partial: false });
  fs.appendFileSync(file, JSON.stringify({ costUsd: 0.25 })); // no newline yet
  assert.equal(readUsage(file).costUsd, 0.75);
  fs.appendFileSync(file, `\n${JSON.stringify({ costUsd: 1 })}\n`);
  assert.equal(readUsage(file).costUsd, 1.75, 'the unterminated line is not counted twice');
  fs.writeFileSync(`${file}.new`, `${JSON.stringify({ costUsd: 2 })}\n`);
  fs.renameSync(`${file}.new`, file);
  assert.equal(readUsage(file).costUsd, 2);
  fs.appendFileSync(file, 'not json\n');
  assert.equal(readUsage(file).partial, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
