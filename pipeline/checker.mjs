// Deterministic verification: runs configured test/lint/typecheck commands,
// parses pass/fail counts, and writes .pipeline/checker_report.md for the Coder.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { appendEvent } from './state.mjs';

function runCommand(cmd, cwd, timeoutMs) {
  const res = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
  });
  const output = [res.stdout || '', res.stderr || ''].filter(Boolean).join('\n').trim();
  return {
    ok: res.status === 0 && !res.error,
    exitCode: res.status,
    timedOut: res.error?.code === 'ETIMEDOUT',
    output,
  };
}

// Extract passed/failed test counts from common runner outputs.
// Supports: node --test (TAP), jest, vitest, mocha, pytest.
export function parseTestCounts(output) {
  const patterns = [
    // node --test TAP: "# pass 3" / "# fail 1"
    { pass: /^#\s*pass\s+(\d+)/m, fail: /^#\s*fail\s+(\d+)/m },
    // jest/pytest style: "3 passed" / "1 failed"
    { pass: /(\d+)\s+passed/, fail: /(\d+)\s+failed/ },
    // mocha: "3 passing" / "1 failing"
    { pass: /(\d+)\s+passing/, fail: /(\d+)\s+failing/ },
  ];
  for (const p of patterns) {
    const passMatch = output.match(p.pass);
    if (passMatch) {
      const failMatch = output.match(p.fail);
      return { passedCount: parseInt(passMatch[1], 10), failedCount: failMatch ? parseInt(failMatch[1], 10) : 0 };
    }
  }
  return { passedCount: null, failedCount: null };
}

function fence(text, limit = 12000) {
  const body = text.length > limit ? text.slice(-limit) + '\n[... truncated, showing last portion]' : text;
  return '```\n' + (body || '(no output)') + '\n```';
}

export function runChecks({ cwd, config, paths }) {
  const results = {};
  for (const name of ['lint', 'typecheck', 'test']) {
    const cmd = config.checks[name];
    if (!cmd) {
      results[name] = { skipped: true, ok: true, output: '' };
      continue;
    }
    appendEvent(paths, { stage: 'checker', type: 'check_start', check: name, cmd });
    results[name] = runCommand(cmd, cwd, config.checkTimeoutMs);
    appendEvent(paths, {
      stage: 'checker',
      type: 'check_end',
      check: name,
      ok: results[name].ok,
      exitCode: results[name].exitCode,
    });
  }

  const counts = parseTestCounts(results.test.output || '');
  const isPassed = results.lint.ok && results.typecheck.ok && results.test.ok;
  // If the runner didn't emit counts, fall back to a binary signal so the
  // regression guardrail still has something monotonic to compare.
  const passedCount = counts.passedCount ?? (results.test.ok ? 1 : 0);
  const failedCount = counts.failedCount ?? (results.test.ok ? 0 : 1);

  const report = [
    '## Verification Status',
    `- Overall Status: ${isPassed ? 'PASS' : 'FAIL'}`,
    `- Total Tests Passed: ${passedCount}`,
    `- Total Tests Failed: ${failedCount}`,
    '',
    '## Test Executions',
    '### Linter Output',
    results.lint.skipped ? '(skipped — no lint command configured)' : fence(results.lint.output),
    '',
    '### Type-Checker Output',
    results.typecheck.skipped ? '(skipped — no typecheck command configured)' : fence(results.typecheck.output),
    '',
    '### Test Suite Output',
    fence(results.test.output),
    '',
    '## Actionable Failure Insights',
    isPassed
      ? 'All checks green. No action required.'
      : 'Inspect the failing output above. Fix the root cause at the exact file paths and assertions shown — do not weaken or remove tests.',
    '',
  ].join('\n');

  fs.writeFileSync(paths.checkerReport, report);
  return { isPassed, passedCount, failedCount, results };
}
