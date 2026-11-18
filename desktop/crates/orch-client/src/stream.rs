//! The live event stream, resumed with Last-Event-ID across disconnects.

use crate::{SharedClient, client::Client, sse::SseParser};
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

/// Runs until `tx` is closed, subscribed to every project the server has.
/// Starts from `cursor` (the first snapshot's) and reconnects with backoff from
/// the last frame id it saw, so no event is missed across the snapshots or a
/// drop. After a failed connection it asks `rediscover` for the live server:
/// a restarted server has a new token (and often a new port), and its new
/// instance id makes it answer the old cursor with a reset.
pub async fn run_event_stream(
    shared: SharedClient,
    cursor: Option<String>,
    rediscover: fn(&Client) -> Option<Client>,
    tx: async_channel::Sender<StreamEvent>,
) {
    let mut last_id: Option<String> = cursor;
    let mut backoff_ms = 500u64;
    loop {
        if tx.is_closed() {
            return;
        }
        let client = shared.read().unwrap_or_else(|e| e.into_inner()).clone();
        match client
            .events_request(&[], last_id.as_deref())
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
        if let Some(fresh) = rediscover(&client) {
            *shared.write().unwrap_or_else(|e| e.into_inner()) = fresh;
            backoff_ms = 500;
            continue;
        }
        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(15_000);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, RwLock};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// The first request starts from the snapshot cursor and has no project
    /// filter, so nothing published in between, and no later project, is missed.
    #[tokio::test]
    async fn the_stream_starts_from_the_snapshot_cursor_for_every_project() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap();
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = "event: hello\ndata: {\"instanceId\":\"i1\",\"cursor\":\"i1.9\",\"heartbeatMs\":15000,\"api\":\"v1\"}\n\n";
            let _ = sock
                .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes())
                .await;
            head
        });
        let shared = Arc::new(RwLock::new(Client::new(base, "t")));
        let (tx, rx) = async_channel::unbounded();
        let stream = tokio::spawn(run_event_stream(shared, Some("i1.5".into()), |_| None, tx));
        assert!(matches!(rx.recv().await.unwrap(), StreamEvent::Connected { .. }));
        let head = server.await.unwrap().to_lowercase();
        rx.close();
        stream.abort();
        assert!(head.starts_with("get /api/v1/events http/1.1"), "no project filter: {head}");
        assert!(head.contains("last-event-id: i1.5"), "resumes from the snapshot cursor: {head}");
    }
}
