# Orchestrator v2 — Roadmap-driven worker pool — Implementation Plan

**Date:** 2026-09-06
**Design:** [2026-09-06-orchestrator-v2-pool-design.md](../specs/2026-09-06-orchestrator-v2-pool-design.md)

Each task is one Conventional Commit with tests written first. `npm test`,
`npm run typecheck` and (once M4/U2 lands) `npm run build:ui -- --check` must be
green at every commit, and v1 single-run `/orchestrate` must keep working at
every commit.

**M0 — Specs** · T0 `docs/superpowers/specs/2026-09-06-orchestrator-v2-pool-design.md` + `plans/2026-09-06-orchestrator-v2-pool.md` (this plan in house style).

**M1 — Engine foundations** (pure modules first; E1–E3 parallelisable)
- E1 `state.mjs`: `pipelinePaths(repoRoot,{runId})`, `resolvePipelineRel`, `acquireLockFile`, `appendLine`; `integrity.mjs` uses `resolvePipelineRel`. Tests: no-runId deep-equals today; run-scoped nesting; prompts/config stay root; lock refuses live pid.
- E2 `run-registry.mjs`: ids, run.json, verb log, brief. Tests: format/regex/sortability/uniqueness; verb round-trip + unknown-verb rejection; brief header mismatch rejected.
- E3 `worktrees.mjs`. Tests on a temp git repo (pattern from evals/run.mjs:61-76): symlink resolves; porcelain empty right after creation (proves skip-worktree); `changedFiles`/`commitRunWork` exclude `.pipeline`; `removeRunWorktree` refuses dirty/unmerged, succeeds after merge.
- E4 `orchestrator.mjs` flags `--run-id --worktree --branch --base-ref --brief-file --feature-id --ticket-id`; sandbox block → `createRunWorktree`; `--sandbox` = `--worktree auto`; archive gated on `!runId`; `--base-ref` override; verb hooks in `setStage`/`finalize`/`requestPlanApproval`. Verify with the zero-LLM host-mode harness: v1 unchanged; `--run-id x --worktree auto` writes `runs/x/status.json` and leaves root `status.json` untouched. Verify once with a real `claude -p` that `Write(.pipeline/…)` allow/deny rules match through the symlink (Risk 1).
- E5 Seeded starts + `tickets.mjs`: `--specs-file`, `--changes-file`, `--start-at tester`, `--plan-only`, `--research` (+ `research_prompt.txt`, artifact `report.md`). Tests: parser on the planner skeleton; slice passes `validateArtifact`; scheduler respects deps/maxParallel/file overlap.

**M2 — Roadmap, supervisor, merge, pool CLI**
- E6 `roadmap.mjs` + `roadmap_prompt.txt`. Tests: frontmatter subset with line numbers; DAG/cycle; status preserved across recompiles; `nextFeature` sequential semantics.
- E7 `snapshot.mjs` + `attention.mjs`: `classifyRun`, `classifyEvent`, `buildSnapshot`, `renderDigest`, attention read/append/ack, decisions open/resolve/list. Tests: busy-state table (unknown never → busy); stale → escalate timing with injected clock; four sections exactly; open decisions persist until resolved; digest golden text.
- E8 `merging.mjs` with injected `exec`. Tests: full transition table incl. error edges; `gh`/`glab` stdout parsing; live gate refuses `CONFLICTING|BLOCKED|stale head|closed`; autoMerge still gated; local-only; fake `gh` on PATH.
- E9 `pool.mjs` (library + CLI verbs) + `writePrimaryMirror`. Tests: every verb on a temp control tree; `decide` writes the right followup + `resume-requested`; `attention peek --hook-stop` exit-2-once; mirror passes `ensureStageEntries` with `pool` set.
- E10 `supervisor.mjs` + `pool.integration.test.mjs`: temp git repo, `customRunners.fake` script that pattern-matches the TASK text (spec with two disjoint-`Files:` tickets / edit + `changes.md` with Self-Review / tests + `test_suite.md` / `review_report.md` APPROVED), `maxParallel:2`, `merge.mode:'local-only'`, `autoMerge:true`, no plan approval. Drive `tick()` under a 60 s ceiling; assert two ticket runs alive in the same tick, commits on ticket branches, integration APPROVED, feature `landed`, base fast-forwarded, worktrees cleaned, F2 started from `landedSha`, snapshot contract string present, root `status.json.pool` set. Second test: fake `BLOCK` verdict → decision opened → `pool decide` + `tick()` resumes.
- E11 Entry points: orchestrate.sh `roadmap`/`pool` subcommands, `--roadmap`, supervisor start with existing UI-port discovery, `role:'supervisor'` lock hint; ui-server pool-aware `continueRun`/`cancelRun`, `listRuns` gains `live`/`kind`.

**M3 — Skills + reporter** (starts after E1; parallel with M2)
- S1 Registry plumbing: `stages.mjs`/`state.mjs`/`artifacts.mjs`/`adapters.mjs`/`integrity.mjs`/ui-server additions for `reporter`, pins, reports; `.gitignore` fix. Tests: `pipelineWriteDeny('coder')` contains reports/skills denies; `('reporter')` allows `reporter.md`.
- S2 `skills.mjs` + CLI + tests (pin/verify round trip, one-byte tamper → mismatch, extra file → mismatch, `omitSections`, `extractDiagramSpecs` rejections, `renderDiagrams` with fake deliver, allowances never emit deliver/preview/capture).
- S3 Injection wiring in `buildInvocation`/`runAgent`/`writeHostHandoff`/`runStageAgent`; strip `GH_TOKEN`/`GITHUB_TOKEN` from child env. adapters tests: prompt section after stage prompt; readOnly allowlist gains prefix.
- S4 `reporter_prompt.txt` + model/effort defaults.
- S5 `report.mjs` + tests (escaping `</title><script>` inert; `diffStats` two-repo + binary fixture; coverage join; theme tokens; iframe `sandbox` present, `allow-same-origin` absent).
- S6 `runReporterStage` + resume steps + RUN_FILES; fixture run with a custom echo runner producing a canned `reporter.md` with one valid and one invalid archify block → one iframe + one "omitted" note; `report.json` receipts match.

**M4 — Control room UI** (U1–U6 start immediately; legacy mode; U7+ need the snapshot contract from E7)
- U1 Extract `ui-api.mjs` + `ui-api.test.mjs`; fix exit-handler and `ui.url` bugs. U2 `pipeline/ui/dashboard.src.html` + `main.mjs` + `scripts/build-dashboard.mjs` + `build:ui --check` in CI (behaviour byte-identical; screenshots re-captured). U3 Extract pure modules + tests; http-guard rejects `Origin: null`; guard all `/api/*` POSTs. U4 Per-tab state refactor (legacy): `tabs.mjs`, in-tab stage strip, sidebar Runs list replaces `#run-select`, `#tabs=` serialization, shortcuts. U5 Run-scoped endpoints + logs + cost cache; incremental feed. U6 SSE v2 + dirty-tab model.
- U7 `/api/pool` + `pool` fixture + feature flag + `pool-tree.mjs` + sidebar four sections + `home` tab. U8 Run tab pool chrome (feature/branch/worktree chips, PR link, attention badges, dead-process banner) + `feature` tab. U9 `/api/report` + path-safety tests + `report` tab. U10 Review tab + `POST /api/pool/approve-merge|request-changes`. U11 Decisions inbox + `/api/decisions` + answer + title count. U12 Pool log tab. U13 Roadmap editor + `POST /api/roadmap` + pool footer controls + New feature modal. U14 Screenshots 06-09, README dashboard section.

**M5 — Coordinator skills, doctrine, release**
- C1 `skills/orchestrate/SKILL.md` v2 + `digest|catchup|unattended|notes` skills + hooks template + `orchestrate.sh hooks install`. C2 Doctrine edits across the seven rule files + SECURITY.md (grep for the old sentence). C3 installer MANAGED + bootstrap.sh + installer tests. C4 `package.json` 2.0.0, `skill.json`, REFERENCE.md, README (layout table, multiple repos, limitations, future improvements), `DEFAULT_REF`/`ORCHESTRATOR_REF` v2.0.0. C5 `npm run release:manifest -- --ref v2.0.0` from a clean checkout; `scaffold-manifest.mjs --verify` passes; tag.

## Verification

1. `npm test && npm run typecheck && npm run build:ui -- --check` at every commit.
2. Zero-LLM integration: `pool.integration.test.mjs` drives roadmap → parallel
   tickets → fan-in → integration review → local merge → next feature with a
   fake runner; `ui-api.test.mjs` covers every endpoint plus guard and path
   traversal rejections.
3. Real-runner smoke (maintainer, manual): a two-feature roadmap in a consumer
   fixture with `merge.mode: 'local-only'`, watched end to end in the dashboard.
4. PR mode against a scratch GitHub repo: PR body is `work-done.md`, merge is
   refused while checks are pending and succeeds after.
5. v1 regression: `/orchestrate "<single task>"` with no `control/` present
   behaves exactly as today; screenshots 01-05 unchanged.
6. Portability: `installer.mjs --plan` against a v1 consumer; fresh
   `bootstrap.sh` in an empty repo; `git check-ignore` checks.
7. Security: tampered skill → `mismatch` and the stage runs without it; hostile
   report text renders inert; built dashboard contains no `allow-same-origin`;
   `Origin: null` POST → 403.

## Out of scope

Remote or secondary coordinators on other hosts; terminal-multiplexer backends;
voice or relay integrations; multi-human collaboration; a pool eval task in
`evals/` (follow-up).
