//! Talking to orchestrator dashboard servers from a native app.
//!
//! Networking lives on a private tokio runtime (see [`ClientHandle`]); the UI
//! side only sees runtime-neutral channels, so any executor (GPUI's included)
//! can await them.

pub mod client;
pub mod discovery;
pub mod sse;
pub mod stream;

pub use client::{Client, ClientError};
pub use stream::StreamEvent;

use orch_contract::{CommandResult, ProjectInfo, Snapshot};
use serde_json::Value;
use std::sync::{Arc, RwLock};

/// The server connection every task uses. The stream replaces it when the
/// server restarts (new port or token), so refreshes and commands follow.
pub type SharedClient = Arc<RwLock<Client>>;

fn current(shared: &SharedClient) -> Client {
    shared.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// After a failed connection: the live server to use now, when it differs from
/// `client` (a restart writes a new registry record with a new token, often a
/// new port). The same address is preferred, else the newest server.
pub fn rediscover(client: &Client) -> Option<Client> {
    let servers = discovery::live_servers();
    let record = servers
        .iter()
        .find(|r| r.base_url() == client.base)
        .or_else(|| servers.first())?;
    (record.base_url() != client.base || record.token != client.token()).then(|| Client::from_record(record))
}

/// Everything the network side reports, in arrival order.
#[derive(Debug, Clone)]
pub enum ClientEvent {
    Projects(Vec<ProjectInfo>),
    Snapshot(Box<Snapshot>),
    Stream(StreamEvent),
    CommandDone {
        request: u64,
        result: Result<CommandResult, String>,
    },
    Error(String),
}

enum Request {
    Refresh,
    Command {
        request: u64,
        project_id: String,
        kind: String,
        run_id: Option<String>,
        args: Value,
        command_id: String,
    },
}

/// A connection to one server, driven from a dedicated 2-thread runtime.
pub struct ClientHandle {
    requests: async_channel::Sender<Request>,
    pub events: async_channel::Receiver<ClientEvent>,
    next_request: std::sync::atomic::AtomicU64,
}

impl ClientHandle {
    pub fn connect(client: Client) -> std::io::Result<ClientHandle> {
        let (events_tx, events_rx) = async_channel::unbounded();
        let (req_tx, req_rx) = async_channel::unbounded::<Request>();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        std::thread::Builder::new().name("orch-client".into()).spawn(move || {
            runtime.block_on(async move {
                let shared: SharedClient = Arc::new(RwLock::new(client));
                // Returns the cursor of the first snapshot: the stream resumes
                // from there, so a change published while the snapshots were
                // being fetched is replayed instead of lost.
                let refresh = |client: Client, tx: async_channel::Sender<ClientEvent>| async move {
                    let mut first_cursor = None;
                    match client.projects().await {
                        Ok(projects) => {
                            let ids: Vec<String> = projects.iter().map(|p| p.project_id.clone()).collect();
                            let _ = tx.send(ClientEvent::Projects(projects)).await;
                            for id in &ids {
                                match client.snapshot(id).await {
                                    Ok(s) => {
                                        first_cursor.get_or_insert_with(|| s.cursor.clone());
                                        let _ = tx.send(ClientEvent::Snapshot(Box::new(s))).await;
                                    }
                                    Err(e) => { let _ = tx.send(ClientEvent::Error(e.to_string())).await; }
                                }
                            }
                        }
                        Err(e) => { let _ = tx.send(ClientEvent::Error(e.to_string())).await; }
                    }
                    first_cursor
                };
                let cursor = refresh(current(&shared), events_tx.clone()).await;
                let (stream_tx, stream_rx) = async_channel::unbounded();
                // Every project, including ones registered after startup.
                tokio::spawn(stream::run_event_stream(shared.clone(), cursor, rediscover, stream_tx));
                let forward = events_tx.clone();
                tokio::spawn(async move {
                    while let Ok(ev) = stream_rx.recv().await {
                        if forward.send(ClientEvent::Stream(ev)).await.is_err() { return; }
                    }
                });
                while let Ok(req) = req_rx.recv().await {
                    match req {
                        Request::Refresh => { refresh(current(&shared), events_tx.clone()).await; }
                        Request::Command { request, project_id, kind, run_id, args, command_id } => {
                            let client = current(&shared);
                            let tx = events_tx.clone();
                            tokio::spawn(async move {
                                let result = client.command(&project_id, &kind, run_id.as_deref(), args, Some(command_id)).await.map_err(|e| e.to_string());
                                let _ = tx.send(ClientEvent::CommandDone { request, result }).await;
                            });
                        }
                    }
                }
            });
        })?;
        Ok(ClientHandle {
            requests: req_tx,
            events: events_rx,
            next_request: 0.into(),
        })
    }

    /// Re-fetch projects and snapshots (after a `Resnapshot`).
    pub fn refresh(&self) {
        let _ = self.requests.try_send(Request::Refresh);
    }

    /// Send a command; the result arrives as `ClientEvent::CommandDone` with
    /// the returned request number. One command id per call: never re-sent.
    pub fn command(&self, project_id: &str, kind: &str, run_id: Option<&str>, args: Value) -> u64 {
        let request = self
            .next_request
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let _ = self.requests.try_send(Request::Command {
            request,
            project_id: project_id.into(),
            kind: kind.into(),
            run_id: run_id.map(str::to_string),
            args,
            command_id: uuid::Uuid::new_v4().to_string(),
        });
        request
    }
}
