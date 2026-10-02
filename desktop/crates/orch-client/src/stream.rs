//! The live event stream, resumed with Last-Event-ID across disconnects.

use crate::{client::Client, sse::SseParser};
use futures_util::StreamExt;
use orch_contract::ServerEvent;
use std::time::Duration;

/// What the stream reports to whoever consumes it (the app's reducer).
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    Connected {
        instance_id: String,
    },
    Server(ServerEvent),
    /// The server could not replay what was missed: fetch a fresh snapshot.
    Resnapshot {
        reason: String,
    },
    Disconnected {
        reason: String,
        retry_in_ms: u64,
    },
}

/// Runs until `tx` is closed. Reconnects with backoff and resumes from the
/// last frame id it saw, so no event is missed or duplicated across a drop.
pub async fn run_event_stream(
    client: Client,
    projects: Vec<String>,
    tx: async_channel::Sender<StreamEvent>,
) {
    let mut last_id: Option<String> = None;
    let mut backoff_ms = 500u64;
    loop {
        if tx.is_closed() {
            return;
        }
        match client
            .events_request(&projects, last_id.as_deref())
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => {
                backoff_ms = 500;
                let mut parser = SseParser::new();
                let mut body = res.bytes_stream();
                let mut pending = Vec::<u8>::new();
                while let Some(chunk) = body.next().await {
                    let Ok(bytes) = chunk else { break };
                    pending.extend_from_slice(&bytes);
                    // Only decode up to the last complete UTF-8 boundary.
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(s) => s.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    for frame in parser.push(&text) {
                        if let Some(id) = &frame.id {
                            last_id = Some(id.clone());
                        }
                        let event = match ServerEvent::decode(&frame.event, &frame.data) {
                            Ok(ServerEvent::Hello { instance_id, .. }) => {
                                StreamEvent::Connected { instance_id }
                            }
                            Ok(ServerEvent::Reset { reason }) => StreamEvent::Resnapshot { reason },
                            Ok(other) => StreamEvent::Server(other),
                            Err(_) => continue, // a malformed frame is skipped, the stream continues
                        };
                        if tx.send(event).await.is_err() {
                            return;
                        }
                    }
                }
                let _ = tx
                    .send(StreamEvent::Disconnected {
                        reason: "stream ended".into(),
                        retry_in_ms: backoff_ms,
                    })
                    .await;
            }
            Ok(res) => {
                let _ = tx
                    .send(StreamEvent::Disconnected {
                        reason: format!("server answered {}", res.status()),
                        retry_in_ms: backoff_ms,
                    })
                    .await;
            }
            Err(err) => {
                let _ = tx
                    .send(StreamEvent::Disconnected {
                        reason: err.to_string(),
                        retry_in_ms: backoff_ms,
                    })
                    .await;
            }
        }
        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(15_000);
    }
}
