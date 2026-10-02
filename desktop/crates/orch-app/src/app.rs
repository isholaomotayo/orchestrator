//! The one window: an attention-first sidebar, and the selected run.

use crate::{notified, theme};
use gpui::{
    App, Context, Div, Entity, FontWeight, SharedString, Stateful, SystemNotification,
    SystemNotificationAction, SystemNotificationResponse, Window, div, prelude::*, px,
};
use orch_client::{Client, ClientEvent, ClientHandle, StreamEvent, discovery};
use orch_contract::{Action, Bucket, CommandStatus, RunSummary, Surface};
use orch_core::{AppState, Connection, Effect, Input};
use serde_json::{Value, json};
use std::collections::HashMap;

/// Actions whose arguments need free text: offered in the web dashboard.
const NEEDS_TEXT: [&str; 2] = ["plan.reject", "message.queue"];

#[derive(Clone)]
struct Selected {
    project_id: String,
    run_id: String,
}

enum Phase {
    /// No live server found; these known projects can start one.
    NoServer {
        known: Vec<String>,
        starting: Option<String>,
        error: Option<String>,
    },
    Connected {
        base_url: String,
    },
}

pub struct OrchestratorApp {
    state: AppState,
    phase: Phase,
    handle: Option<ClientHandle>,
    selected: Option<Selected>,
    /// action id -> request number, while a command is in flight.
    pending: HashMap<String, u64>,
    /// An action awaiting its confirming second click.
    confirming: Option<String>,
    toast: Option<(SharedString, bool)>,
    title: String,
}

impl OrchestratorApp {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            state: AppState::new(notified::load()),
            phase: Phase::NoServer {
                known: known_projects(),
                starting: None,
                error: None,
            },
            handle: None,
            selected: None,
            pending: HashMap::new(),
            confirming: None,
            toast: None,
            title: String::new(),
        };
        this.connect(cx);
        this
    }

    /// Deep links only navigate: `orchestrator://open?project=<id>&run=<id>`.
    /// They never perform an action, whatever the link says.
    pub fn open_link(&mut self, url: &str, cx: &mut Context<Self>) {
        let Some(query) = url.strip_prefix("orchestrator://open?") else {
            return;
        };
        let mut project = None;
        let mut run = None;
        for pair in query.split('&') {
            match pair.split_once('=') {
                Some(("project", v)) => project = Some(v.to_string()),
                Some(("run", v)) => run = Some(v.to_string()),
                _ => {}
            }
        }
        if let (Some(p), Some(r)) = (project, run)
            && self.state.run(&p, &r).is_some()
        {
            self.selected = Some(Selected {
                project_id: p,
                run_id: r,
            });
            self.confirming = None;
            cx.notify();
        }
    }

    /// Notification clicks select the run they were about.
    pub fn install_global_handlers(view: &Entity<Self>, cx: &mut App) {
        let view = view.clone();
        cx.on_system_notification_response(move |response, cx| {
            let SystemNotificationResponse { tag, .. } = response;
            view.update(cx, |this, cx| {
                // Tags are "<projectId>:<runId>:..." (see orch-core run keys).
                let mut parts = tag.split(':');
                if let (Some(p), Some(r)) = (parts.next(), parts.next())
                    && r != "attention"
                    && this.state.run(p, r).is_some()
                {
                    this.selected = Some(Selected {
                        project_id: p.into(),
                        run_id: r.into(),
                    });
                }
                cx.notify();
            });
            cx.activate(true);
        });
    }

    fn connect(&mut self, cx: &mut Context<Self>) {
        let Some(record) = discovery::live_servers().into_iter().next() else {
            self.phase = Phase::NoServer {
                known: known_projects(),
                starting: None,
                error: None,
            };
            return;
        };
        let base_url = record.base_url();
        match ClientHandle::connect(Client::from_record(&record)) {
            Ok(handle) => {
                let events = handle.events.clone();
                self.handle = Some(handle);
                self.phase = Phase::Connected { base_url };
                cx.spawn(async move |this, cx| {
                    while let Ok(event) = events.recv().await {
                        if this.update(cx, |app, cx| app.ingest(event, cx)).is_err() {
                            return;
                        }
                    }
                })
                .detach();
            }
            Err(err) => {
                self.phase = Phase::NoServer {
                    known: known_projects(),
                    starting: None,
                    error: Some(err.to_string()),
                }
            }
        }
    }

    fn ingest(&mut self, event: ClientEvent, cx: &mut Context<Self>) {
        let input = match event {
            ClientEvent::Projects(list) => Some(Input::Projects(list)),
            ClientEvent::Snapshot(snap) => Some(Input::Snapshot(snap)),
            ClientEvent::Stream(StreamEvent::Connected { instance_id }) => {
                Some(Input::Connected { instance_id })
            }
            ClientEvent::Stream(StreamEvent::Disconnected {
                reason,
                retry_in_ms,
            }) => Some(Input::Disconnected {
                reason,
                retry_in_ms,
            }),
            ClientEvent::Stream(StreamEvent::Resnapshot { reason }) => {
                Some(Input::Resnapshot { reason })
            }
            ClientEvent::Stream(StreamEvent::Server(ev)) => Some(Input::Server(ev)),
            ClientEvent::CommandDone { request, result } => {
                self.pending.retain(|_, r| *r != request);
                self.toast = Some(match result {
                    Ok(res) if res.status == CommandStatus::Rejected => (
                        res.error
                            .map(|e| e.message)
                            .unwrap_or_else(|| "Rejected".into())
                            .into(),
                        true,
                    ),
                    Ok(res) if res.status == CommandStatus::Duplicate => {
                        ("Already done.".into(), false)
                    }
                    Ok(_) => ("Done.".into(), false),
                    Err(err) => (err.into(), true),
                });
                None
            }
            ClientEvent::Error(err) => {
                self.toast = Some((err.into(), true));
                None
            }
        };
        if let Some(input) = input {
            let mut notified_changed = false;
            for effect in self.state.apply(input) {
                match effect {
                    Effect::Notify(n) => {
                        notified_changed = true;
                        cx.show_system_notification(SystemNotification {
                            tag: n.key.clone().into(),
                            title: n.title.into(),
                            body: n.body.into(),
                            actions: vec![SystemNotificationAction {
                                id: "open".into(),
                                label: "Open".into(),
                            }],
                        });
                    }
                    Effect::Resnapshot => {
                        if let Some(h) = &self.handle {
                            h.refresh()
                        }
                    }
                    Effect::Badge(_) => {}
                }
            }
            if notified_changed {
                notified::save(self.state.notified_keys());
            }
            if self.selected.is_none()
                && let Some((p, r)) = self.state.inbox().first()
            {
                self.selected = Some(Selected {
                    project_id: (*p).into(),
                    run_id: r.run_id.clone(),
                });
            }
        }
        cx.notify();
    }

    fn start_server(&mut self, repo: String, cx: &mut Context<Self>) {
        if let Phase::NoServer {
            starting, error, ..
        } = &mut self.phase
        {
            *starting = Some(repo.clone());
            *error = None;
        }
        cx.notify();
        let task = cx.background_executor().spawn(async move {
            std::process::Command::new("bash")
                .arg(format!("{repo}/.pipeline/orchestrate.sh"))
                .args(["ui", "--ensure", "--json"])
                .current_dir(&repo)
                .output()
        });
        cx.spawn(async move |this, cx| {
            let out = task.await;
            let _ = this.update(cx, |app, cx| {
                match out {
                    Ok(o) if o.status.success() => app.connect(cx),
                    Ok(o) => {
                        app.phase = Phase::NoServer {
                            known: known_projects(),
                            starting: None,
                            error: Some(String::from_utf8_lossy(&o.stderr).trim().to_string()),
                        }
                    }
                    Err(e) => {
                        app.phase = Phase::NoServer {
                            known: known_projects(),
                            starting: None,
                            error: Some(e.to_string()),
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn run_action(
        &mut self,
        action: &Action,
        run: &RunSummary,
        project_id: &str,
        cx: &mut Context<Self>,
    ) {
        if NEEDS_TEXT.contains(&action.id.as_str()) {
            self.open_dashboard(cx);
            return;
        }
        if action.danger != orch_contract::Danger::None
            && self.confirming.as_deref() != Some(action.id.as_str())
        {
            self.confirming = Some(action.id.clone());
            cx.notify();
            return;
        }
        self.confirming = None;
        let args: Value = match action.id.as_str() {
            "run.continue" => json!({ "handoffId": run.handoff_id }),
            "run.extend" => json!({ "extend": 3 }),
            "run.dismiss" => json!({ "reason": "Dismissed from the desktop app" }),
            "run.set_autonomy" => {
                json!({ "autonomy": if run.autonomy == orch_contract::Autonomy::Autonomous { "guided" } else { "autonomous" } })
            }
            _ => json!({}),
        };
        if let Some(handle) = &self.handle {
            let request = handle.command(project_id, &action.id, Some(&run.run_id), args);
            self.pending.insert(action.id.clone(), request);
        }
        cx.notify();
    }

    fn open_dashboard(&self, cx: &mut Context<Self>) {
        if let (Phase::Connected { base_url }, Some(sel)) = (&self.phase, &self.selected) {
            let repo = self
                .state
                .projects
                .get(&sel.project_id)
                .and_then(|p| p.info.as_ref())
                .map(|i| i.repo_root.clone())
                .unwrap_or_default();
            let tab = format!("run:{}", sel.run_id);
            cx.open_url(&format!(
                "{base_url}/?project={}#tabs={}&active=0",
                encode(&repo),
                encode(&tab)
            ));
        }
    }
}

impl Render for OrchestratorApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let badge = self.state.badge_count();
        let title = if badge > 0 {
            format!("Orchestrator — {badge} need you")
        } else {
            "Orchestrator".into()
        };
        if title != self.title {
            window.set_window_title(&title);
            self.title = title;
        }

        let body = match &self.phase {
            Phase::NoServer {
                known,
                starting,
                error,
            } => self
                .render_no_server(known.clone(), starting.clone(), error.clone(), cx)
                .into_any_element(),
            Phase::Connected { .. } => div()
                .flex()
                .flex_1()
                .size_full()
                .child(self.render_sidebar(cx))
                .child(self.render_run(cx))
                .into_any_element(),
        };
        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(theme::bg())
            .text_color(theme::text())
            .text_sm()
            .font_family(".SystemUIFont")
            .child(self.render_status_bar())
            .child(body)
    }
}

impl OrchestratorApp {
    fn render_status_bar(&self) -> impl IntoElement {
        let (dot, label) = match &self.state.connection {
            Connection::Live { .. } => (theme::bucket(Bucket::Done), "Live".to_string()),
            Connection::Connecting => (theme::muted(), "Connecting…".to_string()),
            Connection::Retrying {
                reason,
                retry_in_ms,
            } => (
                theme::bucket(Bucket::Blocked),
                format!("Reconnecting in {}s — {reason}", retry_in_ms / 1000),
            ),
        };
        let toast = self.toast.clone();
        div()
            .flex()
            .items_center()
            .gap_2()
            .px_4()
            .py_2()
            .bg(theme::panel())
            .border_b_1()
            .border_color(theme::border())
            .child(div().size(px(8.)).rounded_full().bg(dot))
            .child(div().text_color(theme::muted()).child(label))
            .child(div().flex_1())
            .children(toast.map(|(text, bad)| {
                div()
                    .px_2()
                    .rounded_md()
                    .bg(if bad {
                        theme::bucket(Bucket::Blocked)
                    } else {
                        theme::raised()
                    })
                    .child(text)
            }))
    }

    fn render_no_server(
        &self,
        known: Vec<String>,
        starting: Option<String>,
        error: Option<String>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div().flex().flex_col().gap_3().p_8()
            .child(div().text_xl().font_weight(FontWeight::SEMIBOLD).child("No orchestrator dashboard is running"))
            .child(div().text_color(theme::muted()).child("The app attaches to a project's dashboard server. Start one for a known project, or run `bash .pipeline/orchestrate.sh ui --ensure` in a project."))
            .children(error.map(|e| div().text_color(theme::bucket(Bucket::Blocked)).child(e)))
            .children(known.into_iter().enumerate().map(|(i, repo)| {
                let busy = starting.as_deref() == Some(repo.as_str());
                let label = if busy { "Starting…".to_string() } else { "Start dashboard".to_string() };
                let r = repo.clone();
                div().flex().items_center().gap_3()
                    .child(div().flex_1().child(repo.clone()))
                    .child(button(("start", i), label, !busy).on_click(cx.listener(move |this, _, _, cx| this.start_server(r.clone(), cx))))
            }))
            .child(button("retry", "Look again".to_string(), true).on_click(cx.listener(|this, _, _, cx| { this.connect(cx); cx.notify(); })))
    }

    fn render_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let inbox: Vec<(String, RunSummary)> = self
            .state
            .inbox()
            .into_iter()
            .map(|(p, r)| (p.to_string(), r.clone()))
            .collect();
        let selected = self.selected.clone();
        let mut list = div()
            .id("sidebar")
            .flex()
            .flex_col()
            .w(px(320.))
            .h_full()
            .overflow_y_scroll()
            .bg(theme::panel())
            .border_r_1()
            .border_color(theme::border())
            .p_2()
            .gap_1()
            .child(
                div()
                    .px_2()
                    .py_1()
                    .text_xs()
                    .text_color(theme::muted())
                    .child("INBOX"),
            );
        if inbox.is_empty() {
            list = list.child(
                div()
                    .px_2()
                    .text_color(theme::muted())
                    .child("Nothing in flight."),
            );
        }
        for (i, (project_id, run)) in inbox.into_iter().enumerate() {
            let is_selected = selected
                .as_ref()
                .is_some_and(|s| s.run_id == run.run_id && s.project_id == project_id);
            let project = self
                .state
                .projects
                .get(&project_id)
                .and_then(|p| p.info.as_ref())
                .map(|i| i.name.clone())
                .unwrap_or_default();
            let (pid, rid) = (project_id.clone(), run.run_id.clone());
            list = list.child(
                div()
                    .id(("run", i))
                    .flex()
                    .flex_col()
                    .gap_1()
                    .p_2()
                    .rounded_md()
                    .cursor_pointer()
                    .when(is_selected, |d| d.bg(theme::raised()))
                    .hover(|d| d.bg(theme::raised()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected = Some(Selected {
                            project_id: pid.clone(),
                            run_id: rid.clone(),
                        });
                        this.confirming = None;
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .size(px(8.))
                                    .rounded_full()
                                    .bg(theme::bucket(run.bucket)),
                            )
                            .child(div().flex_1().overflow_hidden().child(
                                if run.title.is_empty() {
                                    run.run_id.clone()
                                } else {
                                    run.title.clone()
                                },
                            )),
                    )
                    .child(div().text_xs().text_color(theme::muted()).child(
                        format!("{} · {}{}", run.bucket.label(), project,
                        run.stage.as_ref().map(|s| format!(" · {}", s.name)).unwrap_or_default()),
                    )),
            );
        }
        list
    }

    fn render_run(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(sel) = self.selected.clone() else {
            return div()
                .flex_1()
                .p_8()
                .text_color(theme::muted())
                .child("Select a run.")
                .into_any_element();
        };
        let Some(run) = self.state.run(&sel.project_id, &sel.run_id).cloned() else {
            return div()
                .flex_1()
                .p_8()
                .text_color(theme::muted())
                .child("That run is no longer listed.")
                .into_any_element();
        };
        let surface = match run.surface {
            Some(Surface::Host) => format!(
                "Chat session{}",
                run.host_client
                    .as_ref()
                    .map(|h| format!(" · {h}"))
                    .unwrap_or_default()
            ),
            Some(Surface::Cli) => format!(
                "CLI agent{}",
                run.runner
                    .as_ref()
                    .map(|r| format!(" · {r}"))
                    .unwrap_or_default()
            ),
            _ => "Unknown surface".into(),
        };
        let presence = format!(
            "Driver: {}{}",
            theme::presence(run.driver.presence),
            run.driver
                .host
                .as_ref()
                .map(|h| format!(" ({h})"))
                .unwrap_or_default()
        );
        let feed = self.state.feed(&sel.project_id, &sel.run_id);
        let project_id = sel.project_id.clone();

        let mut actions = div().flex().flex_wrap().gap_2();
        for (i, action) in run.actions.iter().enumerate() {
            let pending = self.pending.contains_key(&action.id);
            let confirming = self.confirming.as_deref() == Some(action.id.as_str());
            let mut label = if pending {
                format!("{}…", action.label)
            } else if confirming {
                format!("Click again: {}", action.label)
            } else {
                action.label.clone()
            };
            if NEEDS_TEXT.contains(&action.id.as_str()) {
                label.push_str(" ↗");
            }
            let (a, r, p) = (action.clone(), run.clone(), project_id.clone());
            let mut b = button(("action", i), label, action.enabled && !pending);
            if action.enabled && !pending {
                b = b.on_click(cx.listener(move |this, _, _, cx| this.run_action(&a, &r, &p, cx)));
            }
            actions = actions.child(
                div().flex().flex_col().gap_1().child(b).children(
                    (!action.enabled)
                        .then(|| action.disabled_reason.clone())
                        .flatten()
                        .map(|why| {
                            div()
                                .text_xs()
                                .text_color(theme::muted())
                                .max_w(px(260.))
                                .child(why)
                        }),
                ),
            );
        }

        div()
            .id("run")
            .flex()
            .flex_col()
            .flex_1()
            .h_full()
            .overflow_y_scroll()
            .p_6()
            .gap_4()
            .child(div().text_xl().font_weight(FontWeight::SEMIBOLD).child(
                if run.title.is_empty() {
                    run.run_id.clone()
                } else {
                    run.title.clone()
                },
            ))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(chip(
                        run.bucket.label().to_string(),
                        theme::bucket(run.bucket),
                    ))
                    .child(chip(surface, theme::raised()))
                    .child(chip(
                        format!("{:?}", run.autonomy).to_lowercase(),
                        theme::raised(),
                    ))
                    .child(chip(presence, theme::raised())),
            )
            .children(run.stage.as_ref().map(|s| {
                div().text_color(theme::muted()).child(format!(
                    "Stage: {} ({}){}",
                    s.name,
                    s.status,
                    s.max_cycles
                        .map(|m| format!(" · cycle {}/{m}", s.cycle))
                        .unwrap_or_default()
                ))
            }))
            .children(run.halt_reason.as_ref().map(|h| {
                div()
                    .p_3()
                    .rounded_md()
                    .bg(theme::raised())
                    .text_color(theme::bucket(Bucket::Blocked))
                    .child(format!(
                        "Halted: {h}{}",
                        run.halt_class
                            .as_ref()
                            .map(|c| format!(" ({c})"))
                            .unwrap_or_default()
                    ))
            }))
            .child(actions)
            .child(
                div().flex().gap_2().child(
                    button("dashboard", "Open in web dashboard ↗".to_string(), true)
                        .on_click(cx.listener(|this, _, _, cx| this.open_dashboard(cx))),
                ),
            )
            .child(div().text_xs().text_color(theme::muted()).child("ACTIVITY"))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .p_3()
                    .rounded_md()
                    .bg(theme::panel())
                    .font_family("Menlo")
                    .when(feed.is_empty(), |d| {
                        d.child(
                            div()
                                .text_color(theme::muted())
                                .child("No activity since the app connected."),
                        )
                    })
                    .children(feed.into_iter().rev().take(200).map(|line| {
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                div()
                                    .w(px(100.))
                                    .flex_none()
                                    .text_color(theme::muted())
                                    .child(if line.stage == "orchestrator" {
                                        "engine".to_string()
                                    } else {
                                        line.stage
                                    }),
                            )
                            .child(div().flex_1().child(line.text))
                    })),
            )
            .into_any_element()
    }
}

fn chip(text: String, bg: gpui::Rgba) -> Div {
    div()
        .px_2()
        .py(px(2.))
        .rounded_md()
        .bg(bg)
        .text_xs()
        .child(text)
}

fn button(id: impl Into<gpui::ElementId>, label: String, enabled: bool) -> Stateful<Div> {
    div()
        .id(id)
        .px_3()
        .py_1()
        .rounded_md()
        .bg(if enabled {
            theme::accent()
        } else {
            theme::raised()
        })
        .text_color(if enabled {
            theme::text()
        } else {
            theme::muted()
        })
        .when(enabled, |d| d.cursor_pointer().hover(|s| s.opacity(0.85)))
        .child(label)
}

fn known_projects() -> Vec<String> {
    let file = discovery::orchestrator_home().join("projects.json");
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| {
            std::path::Path::new(p)
                .join(".pipeline/orchestrate.sh")
                .exists()
        })
        .collect()
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
