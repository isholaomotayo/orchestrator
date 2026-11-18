//! Colours, kept in one place so views stay readable.

use gpui::{Rgba, rgb};
use orch_contract::{Bucket, Presence};

pub fn bg() -> Rgba {
    rgb(0x141417)
}
pub fn panel() -> Rgba {
    rgb(0x1c1c21)
}
pub fn raised() -> Rgba {
    rgb(0x26262c)
}
pub fn border() -> Rgba {
    rgb(0x33333b)
}
pub fn text() -> Rgba {
    rgb(0xececf1)
}
pub fn muted() -> Rgba {
    rgb(0x9a9aa6)
}
pub fn accent() -> Rgba {
    rgb(0x6d8cff)
}

pub fn bucket(b: Bucket) -> Rgba {
    match b {
        Bucket::NeedsYou => rgb(0xf59e0b),
        Bucket::Unattended => rgb(0xa1a1aa),
        Bucket::Blocked => rgb(0xef4444),
        Bucket::AwaitingAgent => rgb(0xa78bfa),
        Bucket::AgentWorking | Bucket::Working => rgb(0x60a5fa),
        Bucket::Done => rgb(0x34d399),
        Bucket::Unknown => rgb(0x71717a),
    }
}

pub fn presence(p: Presence) -> &'static str {
    match p {
        Presence::Active => "active",
        Presence::Quiet => "quiet",
        Presence::Stalled => "stalled",
        Presence::Absent => "nobody driving",
        Presence::Unknown => "unknown",
    }
}
