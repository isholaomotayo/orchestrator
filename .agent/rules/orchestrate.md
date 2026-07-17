# Orchestrator pipeline rules (Antigravity)

Always-on rules for any Antigravity chat session working in a repository that contains the `/orchestrate` pipeline (`.pipeline/orchestrate.sh`).

- Any pipeline invocation from this chat MUST include `--mode chat --host-client antigravity`. You (this chat session) are the driver for every stage.
- NEVER delegate pipeline stages to an external agent CLI (`claude`, `cursor-agent`, `codex`, `gemini`) and never pass `--runner`. Complete each stage from `.pipeline/stage-handoff.json` in this chat, then run `bash .pipeline/orchestrate.sh --continue`.
- If `handoff.model` names a model that is not available in Antigravity, use your active chat model instead and record it as `"actualModel"` in `stage-handoff.json`.
- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY outside an active chat handoff. Never auto-fix errors observed inside `.pipeline_sandbox/` — the self-healing orchestrator owns them.
- If `.pipeline/.lock` exists, a pipeline run is active — do not start overlapping autonomous work.
- If the pipeline refuses with exit code 3, the current repo is the orchestrator SOURCE repository — do not target it; install the pipeline into the consumer project instead (maintainers only: `--allow-self` / `ORCH_ALLOW_SELF=1`).
