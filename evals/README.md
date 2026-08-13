# Pipeline evals

The unit suite proves the orchestrator's *machinery* works. These evals answer a
different question: **did a change to a prompt, a model, or an effort level make
the pipeline better or worse at actually fixing code?**

Without this, every prompt edit is a guess. With it, a change is a number.

## Running

```bash
node evals/run.mjs --runner claude
```

Each task is run in a throwaway copy of its fixture repo, so evals never touch
your working tree. Results land in `evals/results/<timestamp>.json` and a summary
table is printed.

> **These runs invoke real agents and cost real tokens.** A full pass over the
> task set is roughly one pipeline run per task. Start with `--task <id>`.

Useful flags:

| Flag | Meaning |
|---|---|
| `--task <id>` | Run a single task instead of the whole set |
| `--runner <name>` | Agent CLI to drive the run (default: auto-detect) |
| `--model-profile auto\|manual` | Passed through to the orchestrator |
| `--models <json>` | Per-stage model override, for A/B-ing a profile |
| `--repeat <n>` | Run each task n times — pipelines are stochastic, n=1 is an anecdote |
| `--keep` | Leave the temp workspaces on disk for inspection |

## Comparing two configurations

```bash
node evals/run.mjs --repeat 3 --models '{"planner":"opus-5","coder":"sonnet-5","tester":"sonnet-5","reviewer":"opus-5"}'
node evals/run.mjs --repeat 3 --models '{"planner":"sonnet-5","coder":"sonnet-5","tester":"sonnet-5","reviewer":"sonnet-5"}'
node evals/compare.mjs evals/results/<a>.json evals/results/<b>.json
```

## Task format

`evals/tasks/*.json`:

```jsonc
{
  "id": "fix-off-by-one",
  "fixture": "off-by-one",          // directory under evals/fixtures/
  "task": "The paginate() helper drops the last page. Fix it.",
  "assertions": {
    "verdict": "APPROVED",           // required final verdict
    "checksPass": true,              // suite green at the end
    "filesChanged": ["src/paginate.js"],   // must have been modified
    "filesUnchanged": ["src/unrelated.js"], // must NOT have been touched
    "testsNotWeakened": true,        // final test count >= starting count
    "maxCycles": 3                   // coder fix cycles it should not exceed
  }
}
```

Assertions are scored independently, so a run that fixes the bug but takes four
cycles is distinguishable from one that never fixes it — a single pass/fail
would hide that.

## Adding a task

1. Create `evals/fixtures/<name>/` — a minimal repo with `package.json`, a
   failing test, and the bug. Keep it small; the point is to isolate one
   behaviour, not to simulate a real codebase.
2. Verify `npm test` fails there for the right reason.
3. Add `evals/tasks/<id>.json`.
4. Run it once and read the artifacts before trusting the score.
