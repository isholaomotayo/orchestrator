//! App state for Orchestrator Desktop, with no IO and no UI.
//!
//! `AppState::apply` turns what the network side reports into state plus
//! `Effect`s (notify, badge, re-snapshot). The notification policy lives here
//! so it is tested without a window, a clock, or a server.

use orch_contract::{AttentionItem, Bucket, ProjectInfo, RunSummary, ServerEvent, Snapshot};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

/// What the network side reports (mapped 1:1 from `orch_client::ClientEvent`).
#[derive(Debug, Clone)]
pub enum Input {
    Projects(Vec<ProjectInfo>),
    Snapshot(Box<Snapshot>),
    Connected { instance_id: String },
    Disconnected { reason: String, retry_in_ms: u64 },
    Resnapshot { reason: String },
    Server(ServerEvent),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Connection {
    Connecting,
    Live { instance_id: String },
    Retrying { reason: String, retry_in_ms: u64 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Notification {
    /// Stable dedupe key: never notify the same key twice, across restarts.
    pub key: String,
    pub title: String,
    pub body: String,
    pub project_id: String,
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Notify(Notification),
    Badge(u32),
    Resnapshot,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FeedLine {
    pub seq: u64,
    pub stage: String,
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct ProjectState {
    pub info: Option<ProjectInfo>,
    pub runs: BTreeMap<String, RunSummary>,
    pub attention: Vec<AttentionItem>,
    /// Becomes true after the first snapshot: only later changes notify.
    pub primed: bool,
}

const FEED_LIMIT: usize = 500;

pub struct AppState {
    pub connection: Connection,
    pub projects: BTreeMap<String, ProjectState>,
    feeds: HashMap<(String, String), VecDeque<FeedLine>>,
    notified: HashSet<String>,
    last_badge: Option<u32>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(HashSet::new())
    }
}

impl AppState {
    /// `notified` is the persisted set of keys already shown, so a relaunch
    /// never repeats a notification.
    pub fn new(notified: HashSet<String>) -> Self {
        Self {
            connection: Connection::Connecting,
            projects: BTreeMap::new(),
            feeds: HashMap::new(),
            notified,
            last_badge: None,
        }
    }

    pub fn notified_keys(&self) -> &HashSet<String> {
        &self.notified
    }

    pub fn apply(&mut self, input: Input) -> Vec<Effect> {
        let mut effects = Vec::new();
        match input {
            Input::Projects(list) => {
                for info in list {
                    let id = info.project_id.clone();
                    self.projects.entry(id).or_default().info = Some(info);
                }
            }
            Input::Snapshot(snap) => {
                let p = self
                    .projects
                    .entry(snap.project.project_id.clone())
                    .or_default();
                p.info = Some(snap.project.clone());
                p.runs = snap
                    .runs
                    .iter()
                    .map(|r| (r.run_id.clone(), r.clone()))
                    .collect();
                p.attention = snap.attention.clone();
                // Anything already waiting when we connect is in the inbox, not a
                // fresh notification; mark it seen so it does not fire later either.
                if !p.primed {
                    for run in p.runs.values() {
                        self.notified.insert(run_key(&snap.project.project_id, run));
                    }
                    for item in &p.attention {
                        self.notified
                            .insert(attention_key(&snap.project.project_id, item));
                    }
                    p.primed = true;
                }
            }
            Input::Connected { instance_id } => self.connection = Connection::Live { instance_id },
            Input::Disconnected {
                reason,
                retry_in_ms,
            } => {
                self.connection = Connection::Retrying {
                    reason,
                    retry_in_ms,
                }
            }
            Input::Resnapshot { .. } => effects.push(Effect::Resnapshot),
            Input::Server(event) => self.apply_server(event, &mut effects),
        }
        let badge = self.badge_count();
        if self.last_badge != Some(badge) {
            self.last_badge = Some(badge);
            effects.push(Effect::Badge(badge));
        }
        effects
    }

    fn apply_server(&mut self, event: ServerEvent, effects: &mut Vec<Effect>) {
        match event {
            ServerEvent::RunUpserted { project_id, run } => {
                let p = self.projects.entry(project_id.clone()).or_default();
                let before = p.runs.get(&run.run_id).map(|r| r.bucket);
                let primed = p.primed;
                let run = *run;
                if primed && before != Some(run.bucket) {
                    if let Some(n) = notification_for(&project_id, &run) {
                        if self.notified.insert(n.key.clone()) {
                            effects.push(Effect::Notify(n));
                        }
                    }
                }
                p.runs.insert(run.run_id.clone(), run);
            }
            ServerEvent::RunEvent {
                project_id,
                run_id,
                seq,
                event,
            } => {
                if let Some(line) = feed_line(seq, &event) {
                    let feed = self.feeds.entry((project_id, run_id)).or_default();
                    if feed.back().is_none_or(|l| l.seq < line.seq) {
                        feed.push_back(line);
                        while feed.len() > FEED_LIMIT {
                            feed.pop_front();
                        }
                    }
                }
            }
            ServerEvent::AttentionUpdated { project_id, items } => {
                let p = self.projects.entry(project_id.clone()).or_default();
                if p.primed {
                    for item in items.iter().filter(|i| i.escalate) {
                        let key = attention_key(&project_id, item);
                        if self.notified.insert(key.clone()) {
                            effects.push(Effect::Notify(Notification {
                                key,
                                title: attention_title(&item.kind).into(),
                                body: item.summary.clone(),
                                project_id: project_id.clone(),
                                run_id: item.run_id.clone(),
                            }));
                        }
                    }
                }
                p.attention = items;
            }
            ServerEvent::PoolUpdated { .. }
            | ServerEvent::Hello { .. }
            | ServerEvent::Reset { .. }
            | ServerEvent::Unknown { .. } => {}
        }
    }

    /// Runs that want a person, plus escalated attention not already counted.
    pub fn badge_count(&self) -> u32 {
        self.projects
            .values()
            .map(|p| {
                p.runs
                    .values()
                    .filter(|r| !r.dismissed && r.bucket.wants_attention())
                    .count() as u32
            })
            .sum()
    }

    /// The inbox: runs needing a person first, oldest wait first within a bucket.
    pub fn inbox(&self) -> Vec<(&str, &RunSummary)> {
        let mut out: Vec<(&str, &RunSummary)> = self
            .projects
            .iter()
            .flat_map(|(pid, p)| {
                p.runs
                    .values()
                    .filter(|r| !r.dismissed && r.bucket != Bucket::Done)
                    .map(move |r| (pid.as_str(), r))
            })
            .collect();
        out.sort_by(|a, b| {
            a.1.bucket
                .cmp(&b.1.bucket)
                .then_with(|| a.1.waiting_since.cmp(&b.1.waiting_since))
        });
        out
    }

    pub fn feed(&self, project_id: &str, run_id: &str) -> Vec<FeedLine> {
        self.feeds
            .get(&(project_id.to_string(), run_id.to_string()))
            .map(|f| f.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn run(&self, project_id: &str, run_id: &str) -> Option<&RunSummary> {
        self.projects.get(project_id)?.runs.get(run_id)
    }
}

fn run_key(project_id: &str, run: &RunSummary) -> String {
    format!(
        "{project_id}:{}:{:?}:{}",
        run.run_id,
        run.bucket,
        run.handoff_id.as_deref().unwrap_or("")
    )
}

fn attention_key(project_id: &str, item: &AttentionItem) -> String {
    format!("{project_id}:attention:{}", item.id)
}

fn attention_title(kind: &str) -> &'static str {
    match kind {
        "awaiting-agent" => "A stage is waiting for a chat agent",
        "ticket-held" => "A ticket is held for repair",
        "supervisor-error" => "The roadmap supervisor is failing",
        "plan-approval" => "A plan needs your approval",
        "merge-conflict" => "A merge conflict needs a decision",
        _ => "The orchestrator needs you",
    }
}

/// Only transitions a person should act on, or a run finishing.
fn notification_for(project_id: &str, run: &RunSummary) -> Option<Notification> {
    let (title, body) = match run.bucket {
        Bucket::NeedsYou => (
            "Waiting on you",
            format!("{} — approve the plan or answer the decision.", run.title),
        ),
        Bucket::Blocked => (
            "Run blocked",
            format!(
                "{}: {}",
                run.title,
                run.halt_reason.as_deref().unwrap_or("halted")
            ),
        ),
        Bucket::Unattended => (
            "Nobody is driving",
            format!(
                "{} has waited for a chat agent for over 30 minutes.",
                run.title
            ),
        ),
        Bucket::Done => ("Run finished", run.title.clone()),
        _ => return None,
    };
    Some(Notification {
        key: run_key(project_id, run),
        title: title.into(),
        body,
        project_id: project_id.into(),
        run_id: Some(run.run_id.clone()),
    })
}

fn feed_line(seq: u64, event: &Value) -> Option<FeedLine> {
    let stage = event
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
    let text = match kind {
        "agent_output" => event
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                event.get("tool").and_then(Value::as_str).map(|t| {
                    format!(
                        "▸ {t} {}",
                        event.get("file").and_then(Value::as_str).unwrap_or("")
                    )
                })
            })?,
        "chat_handoff" => format!(
            "Handed to the chat agent ({})",
            event
                .get("artifact")
                .and_then(Value::as_str)
                .unwrap_or("artifact")
        ),
        "continue_rejected" => format!(
            "Continue rejected: {}",
            event.get("reason").and_then(Value::as_str).unwrap_or("")
        ),
        "check_end" => format!(
            "Check {} {}",
            event.get("check").and_then(Value::as_str).unwrap_or(""),
            if event.get("ok").and_then(Value::as_bool) == Some(true) {
                "passed"
            } else {
                "failed"
            }
        ),
        "pipeline_end" => format!(
            "Run ended: {}",
            event.get("overall").and_then(Value::as_str).unwrap_or("")
        ),
        "intervention" => format!(
            "Intervention: {}",
            event.get("action").and_then(Value::as_str).unwrap_or("")
        ),
        _ => return None,
    };
    Some(FeedLine { seq, stage, text })
}

#[cfg(test)]
mod tests;
