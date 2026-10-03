//! Every payload recorded from a real ui-server (scripts/record-contract-fixtures.mjs)
//! must parse into the contract types. This is what keeps the Rust client and
//! the Node server from drifting apart.

use orch_contract::*;
use std::path::PathBuf;

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tests/contract/fixtures/v1")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn health_and_server_record() {
    let health: Health = serde_json::from_str(&fixture("health.json")).unwrap();
    assert!(health.supports_v1());
    let record: ServerRecord = serde_json::from_str(&fixture("server-record.json")).unwrap();
    assert_eq!(record.api_versions, ["v1"]);
}

#[test]
fn projects_and_snapshot() {
    let list: ProjectList = serde_json::from_str(&fixture("projects.json")).unwrap();
    assert_eq!(list.projects.len(), 1);
    let snap: Snapshot = serde_json::from_str(&fixture("snapshot.json")).unwrap();
    let buckets: Vec<Bucket> = snap.runs.iter().map(|r| r.bucket).collect();
    for b in [
        Bucket::AwaitingAgent,
        Bucket::Unattended,
        Bucket::Blocked,
        Bucket::NeedsYou,
        Bucket::Done,
    ] {
        assert!(
            buckets.contains(&b),
            "{b:?} missing from the recorded snapshot"
        );
    }
    assert!(
        !buckets.contains(&Bucket::Unknown),
        "every recorded bucket is known to this client"
    );
    let halted = snap.runs.iter().find(|r| r.run_id == "r-halted").unwrap();
    let resume = halted
        .action("run.resume")
        .expect("a recoverable halt offers resume");
    assert!(resume.enabled || resume.disabled_reason.is_some());
}

#[test]
fn run_detail_and_commands() {
    let detail: serde_json::Value = serde_json::from_str(&fixture("run-detail.json")).unwrap();
    let _run: RunSummary = serde_json::from_value(detail["run"].clone()).unwrap();
    let results: Vec<CommandResult> = serde_json::from_str(&fixture("commands.json")).unwrap();
    let statuses: Vec<CommandStatus> = results.iter().map(|r| r.status).collect();
    assert_eq!(
        statuses,
        [
            CommandStatus::Applied,
            CommandStatus::Duplicate,
            CommandStatus::Rejected
        ]
    );
    assert!(results[2].error.as_ref().unwrap().message.contains("done"));
}

#[test]
fn recorded_event_stream_decodes() {
    let text = fixture("events.sse");
    let mut kinds = Vec::new();
    for block in text.split("\n\n") {
        let event = block
            .lines()
            .find_map(|l| l.strip_prefix("event: "))
            .unwrap_or("");
        let data = block
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .collect::<Vec<_>>()
            .join("\n");
        if event.is_empty() {
            continue;
        }
        let decoded = ServerEvent::decode(event, &data).unwrap_or_else(|e| panic!("{event}: {e}"));
        assert!(
            !matches!(decoded, ServerEvent::Unknown { .. }),
            "{event} should be a known event"
        );
        kinds.push(event.to_string());
    }
    for k in ["hello", "run.event", "run.upserted"] {
        assert!(kinds.iter().any(|x| x == k), "{k} not recorded");
    }
}

#[test]
fn unknown_values_degrade_instead_of_failing() {
    let run: RunSummary = serde_json::from_value(serde_json::json!({
        "runId": "x", "autonomy": "something-new", "bucket": "brand_new_bucket",
        "driver": { "kind": "telepathy", "presence": "elsewhere" }, "actions": [], "dismissed": false, "futureField": 1,
    })).unwrap();
    assert_eq!(run.bucket, Bucket::Unknown);
    assert_eq!(run.autonomy, Autonomy::Unknown);
    assert!(matches!(
        ServerEvent::decode("run.teleported", "{}").unwrap(),
        ServerEvent::Unknown { .. }
    ));
}

#[test]
fn a_blocked_completion_is_carried_and_absent_is_none() {
    let with: orch_contract::RunSummary = serde_json::from_value(serde_json::json!({
        "runId": "a", "title": "t", "autonomy": "guided", "bucket": "awaiting_agent",
        "driver": { "kind": "none", "presence": "absent" }, "actions": [], "dismissed": false,
        "completionBlocked": "lease expired for handoff h1",
    }))
    .unwrap();
    assert_eq!(with.completion_blocked.as_deref(), Some("lease expired for handoff h1"));
    let without: orch_contract::RunSummary = serde_json::from_value(serde_json::json!({
        "runId": "a", "title": "t", "autonomy": "guided", "bucket": "working",
        "driver": { "kind": "none", "presence": "absent" }, "actions": [], "dismissed": false,
    }))
    .unwrap();
    assert!(without.completion_blocked.is_none());
}

#[test]
fn a_diagnosis_parses_and_a_state_from_a_newer_server_does_not_break_it() {
    use orch_contract::{DoctorState, RunSummary};
    let parse = |state: &str| -> RunSummary {
        serde_json::from_value(serde_json::json!({
            "runId": "a", "title": "t", "autonomy": "guided", "bucket": "blocked",
            "driver": { "kind": "none", "presence": "absent" }, "actions": [], "dismissed": false,
            "diagnosis": {
                "state": state, "cause": "halt:INTERRUPTED", "explanation": "Halted with INTERRUPTED.",
                "waitingOn": "you", "since": null, "evidence": ["status.json: haltReason=INTERRUPTED"],
                "remedies": [
                    { "verb": "resume", "command": "run.resume", "safe": true, "auto": false, "reason": "continues from the step that failed" },
                    { "verb": "start-supervisor", "shell": "bash .pipeline/orchestrate.sh pool start", "safe": true, "auto": false, "reason": "starts it" }
                ],
                "underlying": { "state": "halted-recoverable" }
            },
        }))
        .unwrap()
    };
    let run = parse("halted-recoverable");
    let d = run.diagnosis.expect("diagnosis");
    assert_eq!(d.state, DoctorState::HaltedRecoverable);
    assert_eq!(d.waiting_on.as_deref(), Some("you"));
    assert_eq!(d.remedies[0].command.as_deref(), Some("run.resume"));
    assert!(d.remedies[1].shell.as_deref().unwrap().contains("pool start"));
    assert_eq!(parse("some-future-state").diagnosis.unwrap().state, DoctorState::Unknown);
    assert!(
        serde_json::from_value::<RunSummary>(serde_json::json!({
            "runId": "a", "title": "t", "autonomy": "guided", "bucket": "working",
            "driver": { "kind": "none", "presence": "absent" }, "actions": [], "dismissed": false,
        }))
        .unwrap()
        .diagnosis
        .is_none(),
        "an older server sends no diagnosis"
    );
}

#[test]
fn needs_attention_matches_the_cli_rule() {
    use orch_contract::{Diagnosis, DoctorState};
    let d = |state, waiting_on: Option<&str>| Diagnosis {
        state,
        cause: String::new(),
        explanation: String::new(),
        waiting_on: waiting_on.map(str::to_string),
        since: None,
        evidence: vec![],
        remedies: vec![],
    };
    assert!(!d(DoctorState::Finished, None).needs_attention());
    assert!(!d(DoctorState::Healthy, None).needs_attention());
    // A live chat agent holding the lease is somebody else's move...
    assert!(!d(DoctorState::Waiting, Some("claude-code")).needs_attention());
    // ...but a plan waiting on you is yours.
    assert!(d(DoctorState::Waiting, Some("you")).needs_attention());
    assert!(d(DoctorState::ParkedNoHost, Some("a chat agent")).needs_attention());
    assert!(d(DoctorState::Unknown, None).needs_attention(), "when in doubt, show it");
}

#[test]
fn doctor_states_have_plain_labels() {
    use orch_contract::DoctorState;
    assert_eq!(DoctorState::HaltedTerminal.label(), "Halted, needs you");
    assert_eq!(DoctorState::ParkedNoHost.label(), "Parked, nobody driving");
    assert_eq!(DoctorState::DeadEngine.label(), "Engine stopped");
    assert_eq!(DoctorState::Unknown.label(), "Unclear");
}
