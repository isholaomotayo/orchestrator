//! orch-client against a real ui-server (Node): discovery through the server
//! registry, snapshot, a live upsert after a status change, and a command.
//! Skips when `node` is not installed.

use orch_client::{discovery, Client, ClientEvent, ClientHandle, StreamEvent};
use orch_contract::{Bucket, CommandStatus, ServerEvent};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Server {
    child: Child,
    root: PathBuf,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn start() -> Option<Server> {
    if Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .status()
        .is_err()
    {
        return None;
    }
    let root = std::env::temp_dir()
        .join(format!("orch-e2e-{}", uuid::Uuid::new_v4()))
        .canonicalize()
        .unwrap_or_else(|_| {
            let p = std::env::temp_dir().join(format!("orch-e2e-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            p.canonicalize().unwrap()
        });
    std::fs::create_dir_all(&root).unwrap();
    write(
        &root.join(".pipeline/config.json"),
        r#"{"uiIdleTimeoutMs":0}"#,
    );
    write(
        &root.join(".pipeline/runs/r1/status.json"),
        r#"{"overall":"done","verdict":"APPROVED","stages":[]}"#,
    );
    write(&root.join(".pipeline/runs/r1/events.jsonl"), "");
    let child = Command::new("node")
        .arg(repo_root().join("pipeline/ui-server.mjs"))
        .current_dir(&root)
        .env("PIPELINE_UI_PORT", free_port().to_string())
        .env("ORCHESTRATOR_HOME", root.join(".orch-home"))
        .env("PIPELINE_UI_IDLE_TIMEOUT_MS", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    std::env::set_var("ORCHESTRATOR_HOME", root.join(".orch-home"));
    Some(Server { child, root })
}

fn recv_until(
    handle: &ClientHandle,
    deadline: Duration,
    mut pred: impl FnMut(&ClientEvent) -> bool,
) -> bool {
    let end = Instant::now() + deadline;
    while Instant::now() < end {
        match handle.events.try_recv() {
            Ok(ev) => {
                if pred(&ev) {
                    return true;
                }
            }
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    false
}

#[test]
fn discover_snapshot_live_update_and_command() {
    let Some(server) = start() else {
        eprintln!("node not installed; skipping");
        return;
    };
    let mut record = None;
    for _ in 0..100 {
        record = discovery::live_servers().into_iter().next();
        if record.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let record = record.expect("the server registered itself");
    let handle = ClientHandle::connect(Client::from_record(&record)).unwrap();

    let mut project = None;
    assert!(
        recv_until(&handle, Duration::from_secs(10), |ev| {
            if let ClientEvent::Snapshot(s) = ev {
                project = Some(s.project.project_id.clone());
                s.runs
                    .iter()
                    .any(|r| r.run_id == "r1" && r.bucket == Bucket::Done)
            } else {
                false
            }
        }),
        "snapshot arrives"
    );
    assert!(
        recv_until(&handle, Duration::from_secs(10), |ev| matches!(
            ev,
            ClientEvent::Stream(StreamEvent::Connected { .. })
        )),
        "stream connects"
    );

    write(
        &server.root.join(".pipeline/runs/r1/status.json"),
        r#"{"overall":"halted","haltReason":"INTERRUPTED","stages":[]}"#,
    );
    assert!(
        recv_until(&handle, Duration::from_secs(10), |ev| matches!(ev,
        ClientEvent::Stream(StreamEvent::Server(ServerEvent::RunUpserted { run, .. })) if run.run_id == "r1" && run.bucket == Bucket::Blocked)),
        "a status change arrives as a typed upsert"
    );

    let request = handle.command(
        project.as_deref().unwrap(),
        "run.dismiss",
        Some("r1"),
        serde_json::json!({ "reason": "e2e" }),
    );
    assert!(
        recv_until(&handle, Duration::from_secs(10), |ev| matches!(ev,
        ClientEvent::CommandDone { request: r, result: Ok(res) } if *r == request && res.status == CommandStatus::Applied)),
        "the command is applied"
    );

    open_decision_is_typed_and_answerable(&server, &handle, project.as_deref().unwrap());
    control_commands_are_accepted(&handle, project.as_deref().unwrap());
}

/// A decision the pool opened shows up typed in the snapshot (it never streams),
/// and answering it by command resolves it.
fn open_decision_is_typed_and_answerable(server: &Server, handle: &ClientHandle, project: &str) {
    write(
        &server.root.join(".pipeline/control/decisions.jsonl"),
        concat!(
            r#"{"decisionId":"d-e2e","ts":"2026-10-03T00:00:00Z","status":"open","runId":"r1","featureId":"F1","kind":"question","stage":"coder","question":"Keep going?","options":["yes","no"],"recommended":"yes","artifacts":["review_report.md"]}"#,
            "\n"
        ),
    );
    write(
        &server.root.join(".pipeline/control/attention.jsonl"),
        concat!(
            r#"{"type":"item","id":"att-e2e","ts":"2026-10-03T00:00:00Z","kind":"question","runId":"r1","decisionId":"d-e2e","summary":"Keep going?"}"#,
            "\n"
        ),
    );
    handle.refresh();
    assert!(
        recv_until(handle, Duration::from_secs(10), |ev| {
            matches!(ev, ClientEvent::Snapshot(s)
                if s.decisions.iter().any(|d| d.decision_id == "d-e2e"
                    && d.options == ["yes", "no"]
                    && d.recommended.as_deref() == Some("yes")
                    && d.run_id.as_deref() == Some("r1"))
                && s.attention.iter().any(|a| a.decision_id.as_deref() == Some("d-e2e")))
        }),
        "the decision and its attention item arrive typed"
    );
    let request = handle.command(
        project,
        "decision.answer",
        Some("r1"),
        serde_json::json!({ "decisionId": "d-e2e", "answer": "yes" }),
    );
    assert!(
        recv_until(handle, Duration::from_secs(10), |ev| matches!(ev,
        ClientEvent::CommandDone { request: r, result: Ok(res) } if *r == request && res.status == CommandStatus::Applied)),
        "the answer is applied"
    );
    handle.refresh();
    assert!(
        recv_until(handle, Duration::from_secs(10), |ev| {
            matches!(ev, ClientEvent::Snapshot(s) if s.decisions.iter().all(|d| d.decision_id != "d-e2e"))
        }),
        "an answered decision is no longer open"
    );
}

/// The exact commands behind the autonomy control, "Pause all autonomy" and Acknowledge.
fn control_commands_are_accepted(handle: &ClientHandle, project: &str) {
    let cases = [
        (
            "run.set_autonomy",
            Some("r1"),
            serde_json::json!({ "autonomy": "guided" }),
        ),
        (
            "pool.pause",
            None,
            serde_json::json!({ "reason": "Paused from the desktop app" }),
        ),
        (
            "attention.ack",
            None,
            serde_json::json!({ "id": "att-e2e" }),
        ),
    ];
    for (kind, run, args) in cases {
        let request = handle.command(project, kind, run, args);
        assert!(
            recv_until(handle, Duration::from_secs(10), |ev| matches!(ev,
            ClientEvent::CommandDone { request: r, result: Ok(res) } if *r == request && res.status == CommandStatus::Applied)),
            "{kind} is applied"
        );
    }
}
