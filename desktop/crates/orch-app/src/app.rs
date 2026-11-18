//! The one window: an attention-first sidebar, and the selected run.

use crate::{notified, theme};
use gpui::{
    App, Context, Div, Entity, FontWeight, SharedString, Stateful, SystemNotification,
    SystemNotificationAction, SystemNotificationResponse, Window, div, prelude::*, px,
};
use orch_client::{Client, ClientEvent, ClientHandle, StreamEvent, discovery};
use orch_contract::{
    Action, Autonomy, Bucket, CommandStatus, Decision, Diagnosis, RunSummary, Surface,
};
use orch_core::{AppState, Connection, Effect, Input};
use serde_json::{Value, json};
use std::collections::HashMap;

/// Actions whose arguments need free text: offered in the web dashboard.
const NEEDS_TEXT: [&str; 2] = ["plan.reject", "message.queue"];

/// Actions with a control of their own, so the generic action row skips them.
const OWN_CONTROL: [&str; 3] = ["run.set_autonomy", "plan.approve", "plan.reject"];

/// Choices that cannot be taken back. They need a confirming second click.
fn irreversible(decision_kind: &str, option: &str) -> bool {
    matches!(
        (decision_kind, option),
        ("merge-approval" | "roadmap-merge", "approve") | ("merge-conflict", "drop-ticket")
    )
}

/// Choices the server only accepts with a written reason ("request-changes: …").
fn needs_text(decision_kind: &str, option: &str) -> bool {
    matches!(
        (decision_kind, option),
        ("merge-approval", "request-changes")
    )
}

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
    /// A deep link whose run is not loaded yet (the link launched the app):
    /// selected as soon as a snapshot lists it.
    pending_link: Option<Selected>,
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
            pending_link: None,
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
        let (Some(project_id), Some(run_id)) = (project, run) else {
            return;
        };
        let target = Selected { project_id, run_id };
        if self.state.run(&target.project_id, &target.run_id).is_some() {
            self.selected = Some(target);
            self.pending_link = None;
            self.confirming = None;
            cx.notify();
        } else {
            self.pending_link = Some(target);
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
                    this.pending_link = None;
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
                // Decisions never stream: re-read them so an answered card goes away.
                if let Some(h) = &self.handle {
                    h.refresh();
                }
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
                    Effect::Badge(count) => crate::platform::set_dock_badge(count),
                }
            }
            if notified_changed {
                notified::save(self.state.notified_keys());
            }
            if let Some(target) = &self.pending_link
                && self.state.run(&target.project_id, &target.run_id).is_some()
            {
                self.selected = self.pending_link.take();
                self.confirming = None;
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

    /// Send one command and track it under `key` until it completes.
    fn send(
        &mut self,
        key: String,
        project_id: &str,
        kind: &str,
        run_id: Option<&str>,
        args: Value,
    ) {
        if let Some(handle) = &self.handle {
            let request = handle.command(project_id, kind, run_id, args);
            self.pending.insert(key, request);
        }
    }

    /// The first click arms `key`; the second returns true. For choices that cannot be undone.
    fn armed(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        if self.confirming.as_deref() == Some(key) {
            self.confirming = None;
            return true;
        }
        self.confirming = Some(key.to_string());
        cx.notify();
        false
    }

    fn answer_decision(
        &mut self,
        project_id: &str,
        d: &Decision,
        option: &str,
        cx: &mut Context<Self>,
    ) {
        if needs_text(&d.kind, option) {
            self.open_dashboard_at(project_id, d.run_id.as_deref(), cx);
            return;
        }
        let key = format!("decision:{}:{option}", d.decision_id);
        if irreversible(&d.kind, option) && !self.armed(&key, cx) {
            return;
        }
        let args = json!({ "decisionId": d.decision_id, "answer": option });
        self.send(
            key,
            project_id,
            "decision.answer",
            d.run_id.as_deref(),
            args,
        );
        cx.notify();
    }

    fn set_autonomy(
        &mut self,
        project_id: &str,
        run_id: &str,
        value: &str,
        cx: &mut Context<Self>,
    ) {
        let args = json!({ "autonomy": value });
        self.send(
            format!("autonomy:{run_id}"),
            project_id,
            "run.set_autonomy",
            Some(run_id),
            args,
        );
        cx.notify();
    }

    fn acknowledge(&mut self, project_id: &str, id: &str, cx: &mut Context<Self>) {
        self.send(
            format!("ack:{id}"),
            project_id,
            "attention.ack",
            None,
            json!({ "id": id }),
        );
        cx.notify();
    }

    /// The panic button: stop pools starting work and hand every live
    /// autonomous run back to a person.
    fn pause_all(&mut self, cx: &mut Context<Self>) {
        if !self.armed("pause-all", cx) {
            return;
        }
        let plan = self.state.pause_all_plan();
        for (i, project) in plan.pools.iter().enumerate() {
            let args = json!({ "reason": "Paused from the desktop app" });
            self.send(
                format!("pause-all:pool:{i}"),
                project,
                "pool.pause",
                None,
                args,
            );
        }
        for (project, run) in &plan.runs {
            let args = json!({ "autonomy": "guided" });
            self.send(
                format!("pause-all:run:{run}"),
                project,
                "run.set_autonomy",
                Some(run),
                args,
            );
        }
        cx.notify();
    }

    fn open_dashboard(&self, cx: &mut Context<Self>) {
        if let Some(sel) = &self.selected {
            self.open_dashboard_at(&sel.project_id, Some(&sel.run_id), cx);
        }
    }

    /// The web dashboard for a project, on one run's tab when `run_id` is given.
    fn open_dashboard_at(&self, project_id: &str, run_id: Option<&str>, cx: &mut Context<Self>) {
        let Phase::Connected { base_url } = &self.phase else {
            return;
        };
        let repo = self
            .state
            .projects
            .get(project_id)
            .and_then(|p| p.info.as_ref())
            .map(|i| i.repo_root.clone())
            .unwrap_or_default();
        let mut url = format!("{base_url}/?project={}", encode(&repo));
        if let Some(run_id) = run_id {
            url.push_str(&format!(
                "#tabs={}&active=0",
                encode(&orch_core::dashboard_tab(run_id))
            ));
        }
        cx.open_url(&url);
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
            .child(self.render_status_bar(cx))
            .child(body)
    }
}

impl OrchestratorApp {
    fn render_status_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
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
        let live_autonomous = self.state.pause_all_plan().runs.len();
        let pausing = self.pending.keys().any(|k| k.starts_with("pause-all"));
        let armed = self.confirming.as_deref() == Some("pause-all");
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
            .children((live_autonomous > 0).then(|| {
                let label = if pausing {
                    "Pausing…".to_string()
                } else if armed {
                    format!("Click again: hand {live_autonomous} run(s) back to guided")
                } else {
                    "Pause all autonomy".to_string()
                };
                button("pause-all", label, !pausing)
                    .on_click(cx.listener(|this, _, _, cx| this.pause_all(cx)))
            }))
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
        // Decisions no run can show (the roadmap's final merge approval has no
        // run), answered right here.
        let own: Vec<(String, Decision)> = self
            .state
            .project_decisions()
            .into_iter()
            .map(|(p, d)| (p.to_string(), d.clone()))
            .collect();
        if !own.is_empty() {
            list = list.child(
                div()
                    .px_2()
                    .py_1()
                    .text_xs()
                    .text_color(theme::muted())
                    .child("DECISIONS"),
            );
            for (i, (project_id, d)) in own.iter().enumerate() {
                list = list.child(self.render_decision(1000 + i, d, project_id, cx));
            }
        }
        if inbox.is_empty() && own.is_empty() {
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
                        this.pending_link = None;
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
        for (i, action) in run
            .actions
            .iter()
            .enumerate()
            .filter(|(_, a)| !OWN_CONTROL.contains(&a.id.as_str()))
        {
            actions = actions.child(self.action_button(i, action, &run, &project_id, cx));
        }
        let autonomy = self.render_autonomy(&run, &project_id, cx);
        let plan_card = self.render_plan_card(&run, &project_id, cx);
        let decisions: Vec<Decision> = self
            .state
            .decisions_for(&sel.project_id, &sel.run_id)
            .into_iter()
            .cloned()
            .collect();
        let attention: Vec<(String, String)> = self
            .state
            .attention_for(&sel.project_id, &sel.run_id)
            .into_iter()
            .map(|a| (a.id.clone(), a.summary.clone()))
            .collect();

        div()
            .id("run")
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
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
                    .child(autonomy)
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
            .children(
                run.diagnosis
                    .as_ref()
                    .filter(|d| d.needs_attention())
                    .map(render_diagnosis),
            )
            .children(run.completion_blocked.as_ref().map(|why| {
                div()
                    .p_3()
                    .rounded_md()
                    .bg(theme::raised())
                    .text_color(theme::bucket(Bucket::Blocked))
                    .child(format!(
                        "The chat agent's last completion did not commit: {why}"
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
            .children(plan_card)
            .children(
                decisions
                    .iter()
                    .enumerate()
                    .map(|(i, d)| self.render_decision(i, d, &project_id, cx)),
            )
            .children(attention.into_iter().enumerate().map(|(i, (id, summary))| {
                let p = project_id.clone();
                card()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(div().flex_1().child(summary))
                    .child(
                        button(
                            ("ack", i),
                            "Acknowledge".to_string(),
                            !self.pending.contains_key(&format!("ack:{id}")),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| this.acknowledge(&p, &id, cx))),
                    )
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

impl OrchestratorApp {
    /// One server-provided action as a button, with its disabled reason under it.
    fn action_button(
        &self,
        index: usize,
        action: &Action,
        run: &RunSummary,
        project_id: &str,
        cx: &mut Context<Self>,
    ) -> Div {
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
        let (a, r, p) = (action.clone(), run.clone(), project_id.to_string());
        let mut b = button(("action", index), label, action.enabled && !pending);
        if action.enabled && !pending {
            b = b.on_click(cx.listener(move |this, _, _, cx| this.run_action(&a, &r, &p, cx)));
        }
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
        )
    }

    /// Guided | Autonomous. The effective policy is highlighted; the server
    /// decides whether it can be changed right now.
    fn render_autonomy(&self, run: &RunSummary, project_id: &str, cx: &mut Context<Self>) -> Div {
        let control = run.actions.iter().find(|a| a.id == "run.set_autonomy");
        let can_set = control.is_some_and(|a| a.enabled);
        let busy = self
            .pending
            .contains_key(&format!("autonomy:{}", run.run_id));
        let segment = |i: usize, value: &'static str, mine: Autonomy| {
            let active = run.autonomy == mine;
            let (p, r) = (project_id.to_string(), run.run_id.clone());
            let mut s = div()
                .id(("autonomy", i))
                .px_2()
                .py(px(2.))
                .text_xs()
                .bg(if active {
                    theme::accent()
                } else {
                    theme::raised()
                })
                .text_color(if active {
                    theme::text()
                } else {
                    theme::muted()
                })
                .child(value);
            if can_set && !active && !busy {
                s = s.cursor_pointer().on_click(
                    cx.listener(move |this, _, _, cx| this.set_autonomy(&p, &r, value, cx)),
                );
            }
            s
        };
        div()
            .flex()
            .items_center()
            .gap_2()
            .child(
                div()
                    .flex()
                    .rounded_md()
                    .overflow_hidden()
                    .child(segment(0, "guided", Autonomy::Guided))
                    .child(segment(1, "autonomous", Autonomy::Autonomous)),
            )
            .children(
                control
                    .filter(|a| !a.enabled)
                    .and_then(|a| a.disabled_reason.clone())
                    .map(|why| div().text_xs().text_color(theme::muted()).child(why)),
            )
    }

    /// Shown while the run waits on plan approval. The plan itself is long, so
    /// it is read in the web dashboard; asking for changes needs free text.
    fn render_plan_card(
        &self,
        run: &RunSummary,
        project_id: &str,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        let approve = run.actions.iter().position(|a| a.id == "plan.approve")?;
        let reject = run.actions.iter().position(|a| a.id == "plan.reject");
        let waiting = run.actions[approve].enabled;
        Some(
            card()
                .flex()
                .flex_col()
                .gap_2()
                .child(div().font_weight(FontWeight::SEMIBOLD).child(if waiting {
                    "The plan is waiting for your approval"
                } else {
                    "Plan approval"
                }))
                .child(
                    div()
                        .text_color(theme::muted())
                        .child("Read it in the web dashboard first. Approving starts the build."),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(self.action_button(
                            approve,
                            &run.actions[approve],
                            run,
                            project_id,
                            cx,
                        ))
                        .children(
                            reject.map(|i| {
                                self.action_button(i, &run.actions[i], run, project_id, cx)
                            }),
                        )
                        .child(
                            button("plan-read", "Read the plan ↗".to_string(), true)
                                .on_click(cx.listener(|this, _, _, cx| this.open_dashboard(cx))),
                        ),
                ),
        )
    }

    fn render_decision(
        &self,
        index: usize,
        d: &Decision,
        project_id: &str,
        cx: &mut Context<Self>,
    ) -> Div {
        let mut options = div().flex().flex_wrap().gap_2();
        for (i, option) in d.options.iter().enumerate() {
            let key = format!("decision:{}:{option}", d.decision_id);
            let pending = self.pending.contains_key(&key);
            let armed = self.confirming.as_deref() == Some(key.as_str());
            let name = if needs_text(&d.kind, option) {
                format!("{} ↗", option.replace('-', " "))
            } else {
                option.replace('-', " ")
            };
            let recommended = d.recommended.as_deref() == Some(option.as_str());
            let label = if pending {
                format!("{name}…")
            } else if armed {
                format!("Click again: {name}")
            } else if recommended {
                format!("{name} (recommended)")
            } else {
                name
            };
            let (p, dd, o) = (project_id.to_string(), d.clone(), option.clone());
            let mut b = button(("decision", index * 16 + i), label, !pending);
            if !pending {
                b = b.on_click(
                    cx.listener(move |this, _, _, cx| this.answer_decision(&p, &dd, &o, cx)),
                );
            }
            options = options.child(b);
        }
        card()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .text_xs()
                    .text_color(theme::muted())
                    .child(d.kind.replace('-', " ").to_uppercase()),
            )
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(d.question.clone()),
            )
            .children((!d.artifacts.is_empty()).then(|| {
                div()
                    .text_xs()
                    .text_color(theme::muted())
                    .child(d.artifacts.join(" · "))
            }))
            .child(options)
    }
}

/// The doctor's reading: what is wrong, who it waits on, the evidence, and what would fix it.
/// Fix buttons come from the server's `actions[]`; this explains why they matter.
fn render_diagnosis(d: &Diagnosis) -> Div {
    card()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .text_xs()
                .text_color(theme::muted())
                .child(format!("DIAGNOSIS · {}", d.state.label().to_uppercase())),
        )
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .child(d.explanation.clone()),
        )
        .children(d.waiting_on.as_ref().map(|who| {
            div().text_color(theme::muted()).child(format!(
                "Waiting on {who}{}",
                d.since
                    .as_ref()
                    .map(|t| format!(" since {t}"))
                    .unwrap_or_default()
            ))
        }))
        .children(d.evidence.iter().map(|e| {
            div()
                .text_xs()
                .text_color(theme::muted())
                .font_family("Menlo")
                .child(format!("· {e}"))
        }))
        .children(d.remedies.iter().map(|r| {
            div()
                .flex()
                .flex_col()
                .child(div().child(format!(
                    "→ {}{}: {}",
                    r.verb,
                    if r.safe { "" } else { " (needs your call)" },
                    r.reason
                )))
                .children(r.shell.as_ref().map(|c| {
                    div()
                        .text_xs()
                        .font_family("Menlo")
                        .text_color(theme::muted())
                        .child(c.clone())
                }))
        }))
}

fn card() -> Div {
    div()
        .p_3()
        .rounded_md()
        .bg(theme::panel())
        .border_1()
        .border_color(theme::border())
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
