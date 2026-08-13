// Scoring for pipeline evals. Kept free of I/O and child processes so the
// grading rules are unit-testable without spending tokens on a real run.
import { parseVerdict } from '../pipeline/artifacts.mjs';

/**
 * Score one completed eval run against its task assertions.
 *
 * Each assertion is graded independently rather than collapsed into a single
 * pass/fail: "fixed the bug but burned every cycle doing it" and "never fixed
 * the bug" are both failures, and a harness that cannot tell them apart cannot
 * tell you whether a prompt change helped.
 *
 * @param {object} assertions  from the task file
 * @param {object} outcome     { status, reviewReport, changedFiles, checks, testCounts }
 * @returns {{ passed: boolean, score: number, results: Array }}
 */
export function scoreRun(assertions = {}, outcome = {}) {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

  if (assertions.verdict) {
    const verdict = outcome.status?.verdict
      ?? parseVerdict(outcome.reviewReport || '').verdict;
    add('verdict', verdict === assertions.verdict,
      `expected ${assertions.verdict}, got ${verdict ?? 'none'}`);
  }

  if (assertions.checksPass !== undefined) {
    const green = outcome.checks?.isPassed === true;
    add('checksPass', green === assertions.checksPass,
      green ? 'suite green' : 'suite red or never run');
  }

  if (assertions.completed !== undefined) {
    const done = outcome.status?.overall === 'done';
    add('completed', done === assertions.completed,
      `overall=${outcome.status?.overall ?? 'unknown'}${outcome.status?.haltReason ? ` (${outcome.status.haltReason})` : ''}`);
  }

  const changed = new Set(outcome.changedFiles || []);
  for (const f of assertions.filesChanged || []) {
    add(`changed:${f}`, changed.has(f), changed.has(f) ? 'modified' : 'not modified');
  }
  // Scope creep is a real failure mode of autonomous coding, and the only way to
  // catch it is to name the files that must stay untouched.
  for (const f of assertions.filesUnchanged || []) {
    add(`unchanged:${f}`, !changed.has(f), changed.has(f) ? 'was modified (scope creep)' : 'untouched');
  }

  if (assertions.testsNotWeakened) {
    const { before, after } = outcome.testCounts || {};
    const ok = !(Number.isFinite(before) && Number.isFinite(after)) || after >= before;
    add('testsNotWeakened', ok, `${before ?? '?'} -> ${after ?? '?'} tests`);
  }

  if (Number.isFinite(assertions.maxCycles)) {
    const used = outcome.status?.stages?.find((s) => s.name === 'coder')?.cycle ?? 0;
    add('maxCycles', used <= assertions.maxCycles, `used ${used}, budget ${assertions.maxCycles}`);
  }

  const passedCount = results.filter((r) => r.ok).length;
  return {
    passed: results.length > 0 && passedCount === results.length,
    score: results.length ? passedCount / results.length : 0,
    results,
  };
}

/** Aggregate repeated runs of the same task — one run of a stochastic pipeline is an anecdote. */
export function aggregate(runs) {
  if (!runs.length) return { n: 0, passRate: 0, meanScore: 0 };
  const passRate = runs.filter((r) => r.passed).length / runs.length;
  const meanScore = runs.reduce((a, r) => a + r.score, 0) / runs.length;
  const costs = runs.map((r) => r.costUsd).filter((c) => typeof c === 'number');
  return {
    n: runs.length,
    passRate,
    meanScore,
    meanCostUsd: costs.length ? costs.reduce((a, c) => a + c, 0) / costs.length : null,
    // Which assertions fail most often — the actionable part of a red eval.
    failuresByAssertion: runs.flatMap((r) => r.results.filter((x) => !x.ok).map((x) => x.name))
      .reduce((acc, name) => { acc[name] = (acc[name] || 0) + 1; return acc; }, {}),
  };
}
