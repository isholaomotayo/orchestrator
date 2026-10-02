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
                let refresh = |client: Client, tx: async_channel::Sender<ClientEvent>| async move {
                    match client.projects().await {
                        Ok(projects) => {
                            let ids: Vec<String> = projects.iter().map(|p| p.project_id.clone()).collect();
                            let _ = tx.send(ClientEvent::Projects(projects)).await;
                            for id in &ids {
                                match client.snapshot(id).await {
                                    Ok(s) => { let _ = tx.send(ClientEvent::Snapshot(Box::new(s))).await; }
                                    Err(e) => { let _ = tx.send(ClientEvent::Error(e.to_string())).await; }
                                }
                            }
                            ids
                        }
                        Err(e) => { let _ = tx.send(ClientEvent::Error(e.to_string())).await; Vec::new() }
                    }
                };
                let ids = refresh(client.clone(), events_tx.clone()).await;
                let (stream_tx, stream_rx) = async_channel::unbounded();
                tokio::spawn(stream::run_event_stream(client.clone(), ids, stream_tx));
                let forward = events_tx.clone();
                tokio::spawn(async move {
                    while let Ok(ev) = stream_rx.recv().await {
                        if forward.send(ClientEvent::Stream(ev)).await.is_err() { return; }
                    }
                });
                while let Ok(req) = req_rx.recv().await {
                    match req {
                        Request::Refresh => { refresh(client.clone(), events_tx.clone()).await; }
                        Request::Command { request, project_id, kind, run_id, args, command_id } => {
                            let client = client.clone();
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
