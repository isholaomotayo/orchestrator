//! Finding dashboard servers: the per-user registry each server writes
//! (`~/.orchestrator/servers/<instanceId>.json`), filtered to live processes.

use orch_contract::ServerRecord;
use std::path::PathBuf;

pub fn orchestrator_home() -> PathBuf {
    if let Some(home) = std::env::var_os("ORCHESTRATOR_HOME") {
        return PathBuf::from(home);
    }
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(".orchestrator")
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

/// Every registered server whose process is alive, newest first.
pub fn live_servers() -> Vec<ServerRecord> {
    let dir = orchestrator_home().join("servers");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<ServerRecord> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|text| serde_json::from_str::<ServerRecord>(&text).ok())
        .filter(|r| pid_alive(r.pid))
        .collect();
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    out
}
