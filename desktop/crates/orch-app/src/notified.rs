//! Notification keys already shown, persisted so a relaunch never repeats one.

use std::collections::HashSet;
use std::path::PathBuf;

const KEEP: usize = 5000;

fn file() -> PathBuf {
    orch_client::discovery::orchestrator_home()
        .join("desktop")
        .join("notified.json")
}

pub fn load() -> HashSet<String> {
    std::fs::read_to_string(file())
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .collect()
}

pub fn save(keys: &HashSet<String>) {
    let path = file();
    let mut list: Vec<&String> = keys.iter().collect();
    list.sort();
    let start = list.len().saturating_sub(KEEP);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(&list[start..]) {
        let _ = std::fs::write(path, text);
    }
}
