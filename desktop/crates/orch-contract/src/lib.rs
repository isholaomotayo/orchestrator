//! The orchestrator's `/api/v1` contract as Rust types.
//!
//! Mirrors `pipeline/contract/v1/*.schema.json`. Every enum has an `Unknown`
//! variant and every optional field defaults, so a newer server never breaks
//! an older app: unknown values degrade to "unknown", they do not fail to parse.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `GET /healthz` — no token needed.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub service: String,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub server_version: Option<String>,
    #[serde(default)]
    pub api_versions: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

impl Health {
    pub fn supports_v1(&self) -> bool {
        self.service == "pipeline-ui" && self.api_versions.iter().any(|v| v == "v1")
    }
}

/// `~/.orchestrator/servers/<instanceId>.json`, written 0600 by each server.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerRecord {
    pub instance_id: String,
    pub port: u16,
    pub pid: u32,
    pub token: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub api_versions: Vec<String>,
    #[serde(default)]
    pub server_version: Option<String>,
}

impl ServerRecord {
    pub fn base_url(&self) -> String {
        self.url
            .clone()
            .unwrap_or_else(|| format!("http://127.0.0.1:{}", self.port))
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttentionCounts {
    #[serde(default)]
    pub needs_you: u32,
    #[serde(default)]
    pub total: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub project_id: String,
    pub repo_root: String,
    pub name: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub attention: AttentionCounts,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ProjectList {
    pub projects: Vec<ProjectInfo>,
}

/// Who executes stages. Fixed for a run's life.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Surface {
    Host,
    Cli,
    #[serde(other)]
    Unknown,
}

/// Who decides at gates. Editable mid-run.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Autonomy {
    Guided,
    Autonomous,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Overall {
    Running,
    AwaitingChat,
    AwaitingPlanApproval,
    Done,
    Halted,
    #[serde(other)]
    Unknown,
}

/// The one status vocabulary every UI renders; computed by the server.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Bucket {
    NeedsYou,
    Unattended,
    Blocked,
    AwaitingAgent,
    AgentWorking,
    Working,
    Done,
    #[serde(other)]
    Unknown,
}

impl Bucket {
    /// Buckets that mean a person should look.
    pub fn wants_attention(self) -> bool {
        matches!(
            self,
            Bucket::NeedsYou | Bucket::Unattended | Bucket::Blocked
        )
    }

    pub fn label(self) -> &'static str {
        match self {
            Bucket::NeedsYou => "Waiting on you",
            Bucket::Unattended => "Nobody driving",
            Bucket::Blocked => "Blocked",
            Bucket::AwaitingAgent => "Waiting for a chat agent",
            Bucket::AgentWorking => "Chat agent working",
            Bucket::Working => "Working",
            Bucket::Done => "Done",
            Bucket::Unknown => "Unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum DriverKind {
    HostSession,
    CliProcess,
    None,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Presence {
    Active,
    Quiet,
    Stalled,
    Absent,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Driver {
    pub kind: DriverKind,
    pub presence: Presence,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub last_activity_at: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub lease_expires_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StageRef {
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub cycle: u32,
    #[serde(default)]
    pub max_cycles: Option<u32>,
    #[serde(default)]
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Danger {
    None,
    Confirm,
    Destructive,
    #[serde(other)]
    Unknown,
}

/// An action the server would accept right now, or why not.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    /// Also the command `type` to send.
    pub id: String,
    pub label: String,
    pub enabled: bool,
    #[serde(default)]
    pub disabled_reason: Option<String>,
    #[serde(default)]
    pub primary: bool,
    pub danger: Danger,
    #[serde(default)]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub feature_id: Option<String>,
    #[serde(default)]
    pub ticket_id: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub surface: Option<Surface>,
    #[serde(default)]
    pub runner: Option<String>,
    #[serde(default)]
    pub host_client: Option<String>,
    pub autonomy: Autonomy,
    #[serde(default)]
    pub overall: Option<Overall>,
    pub bucket: Bucket,
    #[serde(default)]
    pub stage: Option<StageRef>,
    pub driver: Driver,
    #[serde(default)]
    pub waiting_since: Option<String>,
    #[serde(default)]
    pub handoff_id: Option<String>,
    #[serde(default)]
    pub halt_reason: Option<String>,
    #[serde(default)]
    pub halt_class: Option<String>,
    #[serde(default)]
    pub dismissed: bool,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub actions: Vec<Action>,
}

impl RunSummary {
    pub fn action(&self, id: &str) -> Option<&Action> {
        self.actions.iter().find(|a| a.id == id)
    }
}

/// One pending attention item (`attention.jsonl`, deduped by the server).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub feature_id: Option<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub escalate: bool,
    #[serde(default)]
    pub level: Option<u32>,
    #[serde(default)]
    pub at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub cursor: String,
    pub project: ProjectInfo,
    pub runs: Vec<RunSummary>,
    #[serde(default)]
    pub attention: Vec<AttentionItem>,
    #[serde(default)]
    pub decisions: Vec<Value>,
    #[serde(default)]
    pub pool: Option<Value>,
}

/// The `data:` of each server-sent event, tagged by its `event:` name.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerEvent {
    Hello {
        instance_id: String,
        cursor: String,
        heartbeat_ms: u64,
    },
    Reset {
        reason: String,
    },
    RunUpserted {
        project_id: String,
        run: Box<RunSummary>,
    },
    RunEvent {
        project_id: String,
        run_id: String,
        seq: u64,
        event: Value,
    },
    AttentionUpdated {
        project_id: String,
        items: Vec<AttentionItem>,
    },
    PoolUpdated {
        project_id: String,
        snapshot: Value,
    },
    /// An event this client does not know yet; kept so nothing is silently lost.
    Unknown {
        event: String,
        data: Value,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloData {
    instance_id: String,
    cursor: String,
    #[serde(default)]
    heartbeat_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetData {
    reason: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunUpsertedData {
    project_id: String,
    run: RunSummary,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunEventData {
    project_id: String,
    run_id: String,
    seq: u64,
    event: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttentionData {
    project_id: String,
    items: Vec<AttentionItem>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PoolData {
    project_id: String,
    snapshot: Value,
}

impl ServerEvent {
    /// Decode one SSE frame. A known event with a malformed body is an error;
    /// an unknown event name is `Unknown`, never an error.
    pub fn decode(event: &str, data: &str) -> Result<ServerEvent, serde_json::Error> {
        Ok(match event {
            "hello" => {
                let d: HelloData = serde_json::from_str(data)?;
                ServerEvent::Hello {
                    instance_id: d.instance_id,
                    cursor: d.cursor,
                    heartbeat_ms: d.heartbeat_ms,
                }
            }
            "reset" => {
                let d: ResetData = serde_json::from_str(data)?;
                ServerEvent::Reset { reason: d.reason }
            }
            "run.upserted" => {
                let d: RunUpsertedData = serde_json::from_str(data)?;
                ServerEvent::RunUpserted {
                    project_id: d.project_id,
                    run: Box::new(d.run),
                }
            }
            "run.event" => {
                let d: RunEventData = serde_json::from_str(data)?;
                ServerEvent::RunEvent {
                    project_id: d.project_id,
                    run_id: d.run_id,
                    seq: d.seq,
                    event: d.event,
                }
            }
            "attention.updated" => {
                let d: AttentionData = serde_json::from_str(data)?;
                ServerEvent::AttentionUpdated {
                    project_id: d.project_id,
                    items: d.items,
                }
            }
            "pool.updated" => {
                let d: PoolData = serde_json::from_str(data)?;
                ServerEvent::PoolUpdated {
                    project_id: d.project_id,
                    snapshot: d.snapshot,
                }
            }
            other => ServerEvent::Unknown {
                event: other.to_string(),
                data: serde_json::from_str(data).unwrap_or(Value::Null),
            },
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub kind: String,
    pub version: String,
}

/// `POST /api/v1/projects/:id/commands`. Reuse `command_id` to retry safely.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub command_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub args: Value,
    pub client: ClientInfo,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandStatus {
    Applied,
    Rejected,
    Duplicate,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub command_id: String,
    pub status: CommandStatus,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<CommandError>,
    #[serde(default)]
    pub output_tail: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
}
