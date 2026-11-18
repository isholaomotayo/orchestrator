//! A dashboard server restart: the new server has a new token and port. The
//! client must find it, reconnect its stream there, and send later requests
//! with the new token instead of failing with 401 forever. Skips without node.

use orch_client::{discovery, Client, ClientEvent, ClientHandle, StreamEvent};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap()
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// Kills the server even when an assertion panics, so a failing run leaks nothing.
struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn server(root: &Path) -> Server {
    Server(Command::new("node")
        .arg(repo_root().join("pipeline/ui-server.mjs"))
        .current_dir(root)
        .env("PIPELINE_UI_PORT", free_port().to_string())
        .env("ORCHESTRATOR_HOME", root.join(".orch-home"))
        .env("PIPELINE_UI_IDLE_TIMEOUT_MS", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap())
}

fn newest_record(not_instance: Option<&str>) -> orch_contract::ServerRecord {
    for _ in 0..200 {
        if let Some(r) = discovery::live_servers().into_iter().find(|r| Some(r.instance_id.as_str()) != not_instance) {
            return r;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("no server registered itself");
}

fn recv_until(handle: &ClientHandle, deadline: Duration, mut pred: impl FnMut(&ClientEvent) -> bool) -> bool {
    let end = Instant::now() + deadline;
    while Instant::now() < end {
        match handle.events.try_recv() {
            Ok(ev) if pred(&ev) => return true,
            Ok(_) => {}
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    false
}

#[test]
fn after_a_server_restart_the_client_follows_the_new_server_and_token() {
    if Command::new("node").arg("--version").stdout(Stdio::null()).status().is_err() {
        eprintln!("node not installed; skipping");
        return;
    }
    let root = std::env::temp_dir().join(format!("orch-restart-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    write(&root.join(".pipeline/config.json"), r#"{"uiIdleTimeoutMs":0}"#);
    write(&root.join(".pipeline/runs/r1/status.json"), r#"{"overall":"done","verdict":"APPROVED","stages":[]}"#);
    write(&root.join(".pipeline/runs/r1/events.jsonl"), "");
    std::env::set_var("ORCHESTRATOR_HOME", root.join(".orch-home"));

    let first = server(&root);
    let record = newest_record(None);
    let handle = ClientHandle::connect(Client::from_record(&record)).unwrap();
    assert!(
        recv_until(&handle, Duration::from_secs(10), |ev| matches!(ev, ClientEvent::Stream(StreamEvent::Connected { instance_id }) if *instance_id == record.instance_id)),
        "connected to the first server"
    );

    drop(first);
    let _second = server(&root);
    let fresh = newest_record(Some(&record.instance_id));
    assert_ne!(fresh.token, record.token, "a restart issues a new token");
    assert!(
        recv_until(&handle, Duration::from_secs(30), |ev| matches!(ev, ClientEvent::Stream(StreamEvent::Connected { instance_id }) if *instance_id == fresh.instance_id)),
        "the stream reconnected to the new server"
    );
    // A refresh now goes to the new server with its token, not a 401.
    handle.refresh();
    let mut error = None;
    assert!(
        recv_until(&handle, Duration::from_secs(10), |ev| {
            if let ClientEvent::Error(e) = ev { error = Some(e.clone()); }
            matches!(ev, ClientEvent::Snapshot(s) if s.runs.iter().any(|r| r.run_id == "r1"))
        }),
        "a refresh after the restart returns a snapshot (last error: {error:?})"
    );
    let _ = std::fs::remove_dir_all(&root);
}
