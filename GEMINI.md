# Gemini CLI Instructions

This repository ships a portable multi-agent pipeline skill declared in `.pipeline/skill.json` (Planner → Coder self-healing loop → Tester → Reviewer, live dashboard at http://localhost:4600).

For non-trivial feature or refactoring requests:
1. Invoke: `bash .pipeline/spawn.sh "<user requirements>"`
2. When it exits, read `.pipeline/review_report.md` and report the verdict.

Isolation rules:
- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you are the pipeline orchestrator.
- If `.pipeline/.lock` exists, a pipeline run is active — do not start overlapping autonomous work.
- Do not auto-fix errors seen inside `.pipeline_sandbox/`; the self-healing orchestrator manages them.
