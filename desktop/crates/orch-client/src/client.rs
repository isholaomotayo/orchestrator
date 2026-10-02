//! Typed `/api/v1` calls. Every call carries the server's bearer token.

use orch_contract::*;
use serde::de::DeserializeOwned;
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("server answered {status}: {body}")]
    Status { status: u16, body: String },
    #[error("not an orchestrator v1 server")]
    NotV1,
}

#[derive(Clone)]
pub struct Client {
    pub base: String,
    token: String,
    http: reqwest::Client,
}

pub const CLIENT_KIND: &str = "desktop";

impl Client {
    pub fn new(base: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            base: base.into(),
            token: token.into(),
            http: reqwest::Client::new(),
        }
    }

    pub fn from_record(record: &ServerRecord) -> Self {
        Self::new(record.base_url(), record.token.clone())
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, ClientError> {
        let res = self
            .http
            .get(format!("{}{}", self.base, path))
            .bearer_auth(&self.token)
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            return Err(ClientError::Status {
                status: status.as_u16(),
                body: res.text().await.unwrap_or_default(),
            });
        }
        Ok(res.json().await?)
    }

    pub async fn health(&self) -> Result<Health, ClientError> {
        let h: Health = self
            .http
            .get(format!("{}/healthz", self.base))
            .send()
            .await?
            .json()
            .await?;
        if h.supports_v1() {
            Ok(h)
        } else {
            Err(ClientError::NotV1)
        }
    }

    pub async fn projects(&self) -> Result<Vec<ProjectInfo>, ClientError> {
        Ok(self.get::<ProjectList>("/api/v1/projects").await?.projects)
    }

    pub async fn snapshot(&self, project_id: &str) -> Result<Snapshot, ClientError> {
        self.get(&format!("/api/v1/projects/{project_id}/snapshot"))
            .await
    }

    pub async fn run_events(
        &self,
        project_id: &str,
        run_id: &str,
        after_seq: u64,
        limit: u32,
    ) -> Result<Value, ClientError> {
        self.get(&format!(
            "/api/v1/projects/{project_id}/runs/{run_id}/events?afterSeq={after_seq}&limit={limit}"
        ))
        .await
    }

    /// Send a command. `command_id` makes a retry (or double click) harmless.
    pub async fn command(
        &self,
        project_id: &str,
        kind: &str,
        run_id: Option<&str>,
        args: Value,
        command_id: Option<String>,
    ) -> Result<CommandResult, ClientError> {
        let body = Command {
            command_id: command_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            kind: kind.to_string(),
            run_id: run_id.map(str::to_string),
            args,
            client: ClientInfo {
                kind: CLIENT_KIND.into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
        };
        let res = self
            .http
            .post(format!(
                "{}/api/v1/projects/{project_id}/commands",
                self.base
            ))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await?;
        let status = res.status();
        if status.is_client_error() && status.as_u16() != 400 {
            return Err(ClientError::Status {
                status: status.as_u16(),
                body: res.text().await.unwrap_or_default(),
            });
        }
        Ok(res.json().await?)
    }

    pub(crate) fn events_request(
        &self,
        projects: &[String],
        last_event_id: Option<&str>,
    ) -> reqwest::RequestBuilder {
        let mut req = self
            .http
            .get(format!(
                "{}/api/v1/events?projects={}",
                self.base,
                projects.join(",")
            ))
            .bearer_auth(&self.token)
            .header("Accept", "text/event-stream");
        if let Some(id) = last_event_id {
            req = req.header("Last-Event-ID", id);
        }
        req
    }
}
