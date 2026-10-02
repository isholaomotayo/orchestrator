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
