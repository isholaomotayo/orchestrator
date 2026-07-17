# Gemini CLI Instructions

This repository ships `/orchestrate` — a portable multi-agent pipeline declared in `.pipeline/skill.json` (Planner → Coder self-healing loop → Tester → Reviewer, with a live dashboard whose URL is dynamically selected and saved to `.pipeline/ui.url` to prevent port drift).

## For `/orchestrate` or non-trivial feature/refactoring requests:

1. **Pre-flight**: if `.pipeline/.lock` exists, a pipeline run is active — do not start overlapping autonomous work.
2. **Model selection (required before starting)**: Ask the user:
   > Use automatic cost-optimized models per stage, or pick models manually for Planner / Coder / Tester / Reviewer?
   - **Automatic** → pass `--model-profile auto`
   - **Manual** → collect four model IDs, then pass `--model-profile manual --models '{"planner":"...","coder":"...","tester":"...","reviewer":"..."}'`
   This is the **only** pre-run question.
3. **Invoke** (you are a chat session — always pass `--mode chat --host-client gemini`; never pass `--runner` and never delegate stages to another agent CLI; exit code 3 means this is the orchestrator SOURCE repo, which must not be targeted):
   ```bash
   bash .pipeline/orchestrate.sh "<user requirements>" --mode chat --host-client gemini --model-profile auto
   ```
4. **Tell the user** to open the live dashboard URL from `.pipeline/ui.url` (do not hardcode 4600).
5. When it exits, read `.pipeline/review_report.md` and report the verdict.

## Isolation rules

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you are the pipeline orchestrator.
- If `.pipeline/.lock` exists, a pipeline run is active — do not start overlapping autonomous work.
- Do not auto-fix errors seen inside `.pipeline_sandbox/`; the self-healing orchestrator manages them.
