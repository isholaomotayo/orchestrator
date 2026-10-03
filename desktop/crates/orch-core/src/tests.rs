use super::*;

fn run(id: &str, bucket: Bucket) -> RunSummary {
    serde_json::from_value(serde_json::json!({
        "runId": id, "title": format!("Run {id}"), "autonomy": "guided", "bucket": bucket,
        "driver": { "kind": "none", "presence": "absent" }, "actions": [], "dismissed": false,
    }))
    .unwrap()
}

fn snapshot(runs: Vec<RunSummary>) -> Box<Snapshot> {
    Box::new(Snapshot {
        cursor: "i.0".into(),
        project: ProjectInfo {
            project_id: "p".into(),
            repo_root: "/r".into(),
            name: "r".into(),
            capabilities: vec![],
            attention: Default::default(),
        },
        runs,
        attention: vec![],
        decisions: vec![],
        pool: None,
    })
}

fn notifies(effects: &[Effect]) -> Vec<&Notification> {
    effects
        .iter()
        .filter_map(|e| {
            if let Effect::Notify(n) = e {
                Some(n)
            } else {
                None
            }
        })
        .collect()
}

#[test]
fn what_was_already_waiting_at_connect_is_inbox_not_a_notification() {
    let mut s = AppState::default();
    let fx = s.apply(Input::Snapshot(snapshot(vec![run("a", Bucket::NeedsYou)])));
    assert!(notifies(&fx).is_empty());
    assert!(fx.contains(&Effect::Badge(1)));
    assert_eq!(s.inbox().len(), 1);
}

#[test]
fn a_transition_to_needs_you_notifies_once() {
    let mut s = AppState::default();
    s.apply(Input::Snapshot(snapshot(vec![run("a", Bucket::Working)])));
    let up = |s: &mut AppState, b| {
        s.apply(Input::Server(ServerEvent::RunUpserted {
            project_id: "p".into(),
            run: Box::new(run("a", b)),
        }))
    };
    assert_eq!(notifies(&up(&mut s, Bucket::NeedsYou)).len(), 1);
    assert!(
        notifies(&up(&mut s, Bucket::NeedsYou)).is_empty(),
        "same bucket again is silent"
    );
    assert!(
        notifies(&up(&mut s, Bucket::Working)).is_empty(),
        "working is never a notification"
    );
}

#[test]
fn a_relaunch_with_persisted_keys_does_not_repeat() {
    let mut first = AppState::default();
    first.apply(Input::Snapshot(snapshot(vec![run("a", Bucket::Working)])));
    first.apply(Input::Server(ServerEvent::RunUpserted {
        project_id: "p".into(),
        run: Box::new(run("a", Bucket::Blocked)),
    }));
    let keys = first.notified_keys().clone();
    let mut second = AppState::new(keys);
    second.apply(Input::Snapshot(snapshot(vec![run("a", Bucket::Working)])));
    let fx = second.apply(Input::Server(ServerEvent::RunUpserted {
        project_id: "p".into(),
        run: Box::new(run("a", Bucket::Blocked)),
    }));
    assert!(notifies(&fx).is_empty());
}

#[test]
fn escalated_attention_notifies_per_item_and_level() {
    let mut s = AppState::default();
    s.apply(Input::Snapshot(snapshot(vec![])));
    let item = |id: &str, level| AttentionItem {
        id: id.into(),
        kind: "awaiting-agent".into(),
        run_id: Some("a".into()),
        feature_id: None,
        summary: "waited 11 min".into(),
        escalate: true,
        level: Some(level),
        at: None,
        decision_id: None,
    };
    let fx = s.apply(Input::Server(ServerEvent::AttentionUpdated {
        project_id: "p".into(),
        items: vec![item("x1", 1)],
    }));
    assert_eq!(
        notifies(&fx)[0].title,
        "A stage is waiting for a chat agent"
    );
    let fx = s.apply(Input::Server(ServerEvent::AttentionUpdated {
        project_id: "p".into(),
        items: vec![item("x1", 1)],
    }));
    assert!(notifies(&fx).is_empty());
    let fx = s.apply(Input::Server(ServerEvent::AttentionUpdated {
        project_id: "p".into(),
        items: vec![item("x2", 2)],
    }));
    assert_eq!(
        notifies(&fx).len(),
        1,
        "the escalated replacement is a new alert"
    );
}

#[test]
fn the_inbox_puts_people_first_and_hides_finished_runs() {
    let mut s = AppState::default();
    s.apply(Input::Snapshot(snapshot(vec![
        run("w", Bucket::Working),
        run("d", Bucket::Done),
        run("n", Bucket::NeedsYou),
        run("u", Bucket::Unattended),
    ])));
    let ids: Vec<&str> = s.inbox().iter().map(|(_, r)| r.run_id.as_str()).collect();
    assert_eq!(ids, ["n", "u", "w"]);
}

#[test]
fn the_feed_keeps_order_and_ignores_replayed_events() {
    let mut s = AppState::default();
    let ev = |seq, text: &str| {
        Input::Server(ServerEvent::RunEvent {
            project_id: "p".into(),
            run_id: "a".into(),
            seq,
            event: serde_json::json!({ "type": "agent_output", "stage": "coder", "text": text }),
        })
    };
    s.apply(ev(1, "one"));
    s.apply(ev(2, "two"));
    s.apply(ev(2, "two again"));
    let feed: Vec<String> = s.feed("p", "a").into_iter().map(|l| l.text).collect();
    assert_eq!(feed, ["one", "two"]);
}

#[test]
fn a_reset_asks_for_a_fresh_snapshot() {
    let mut s = AppState::default();
    assert!(s
        .apply(Input::Resnapshot {
            reason: "server_restarted".into()
        })
        .contains(&Effect::Resnapshot));
}

fn decision(id: &str, run: &str) -> orch_contract::Decision {
    serde_json::from_value(serde_json::json!({
        "decisionId": id, "runId": run, "kind": "merge-approval", "status": "open",
        "question": "Merge it?", "options": ["approve", "request-changes"], "recommended": "approve",
        "artifacts": ["review_report.md"],
    }))
    .unwrap()
}

fn attention_for(decision_id: &str) -> AttentionItem {
    serde_json::from_value(serde_json::json!({
        "id": format!("att-{decision_id}"), "kind": "merge-approval", "runId": "a",
        "summary": "ready to merge", "decisionId": decision_id,
    }))
    .unwrap()
}

#[test]
fn open_decisions_are_listed_under_their_run() {
    let mut s = AppState::default();
    let mut snap = snapshot(vec![run("a", Bucket::NeedsYou), run("b", Bucket::Working)]);
    snap.decisions = vec![decision("d1", "a"), decision("d2", "b")];
    s.apply(Input::Snapshot(snap));
    let ids: Vec<_> = s.decisions_for("p", "a").iter().map(|d| d.decision_id.as_str()).collect();
    assert_eq!(ids, ["d1"]);
    assert!(s.decisions_for("p", "nope").is_empty());
}

#[test]
fn attention_naming_an_unknown_decision_asks_for_a_fresh_snapshot() {
    let mut s = AppState::default();
    s.apply(Input::Snapshot(snapshot(vec![run("a", Bucket::NeedsYou)])));
    let attention = |s: &mut AppState| {
        s.apply(Input::Server(ServerEvent::AttentionUpdated {
            project_id: "p".into(),
            items: vec![attention_for("d1")],
        }))
    };
    assert!(attention(&mut s).contains(&Effect::Resnapshot), "decisions never stream, so fetch them");
    let mut snap = snapshot(vec![run("a", Bucket::NeedsYou)]);
    snap.decisions = vec![decision("d1", "a")];
    s.apply(Input::Snapshot(snap));
    assert!(!attention(&mut s).contains(&Effect::Resnapshot), "known decision: nothing to fetch");
}

#[test]
fn pause_all_targets_only_live_autonomous_runs() {
    let mut s = AppState::default();
    let auto = |id: &str, b: Bucket, dismissed: bool| -> RunSummary {
        let mut r = run(id, b);
        r.autonomy = orch_contract::Autonomy::Autonomous;
        r.dismissed = dismissed;
        r
    };
    s.apply(Input::Snapshot(snapshot(vec![
        auto("live", Bucket::Working, false),
        auto("done", Bucket::Done, false),
        auto("gone", Bucket::Blocked, true),
        run("guided", Bucket::Working),
    ])));
    assert_eq!(s.autonomous_runs(), vec![("p".to_string(), "live".to_string())]);
}

#[test]
fn pause_all_pauses_only_pools_with_live_autonomous_work() {
    let mut s = AppState::default();
    let pooled = |id: &str| -> RunSummary {
        let mut r = run(id, Bucket::Working);
        r.autonomy = orch_contract::Autonomy::Autonomous;
        r.feature_id = Some("F1".into());
        r
    };
    let mut plain = run("solo", Bucket::Working);
    plain.autonomy = orch_contract::Autonomy::Autonomous;
    s.apply(Input::Snapshot(snapshot(vec![pooled("t1"), pooled("t2")])));
    let mut other = snapshot(vec![plain]);
    other.project.project_id = "q".into();
    s.apply(Input::Snapshot(other));
    let plan = s.pause_all_plan();
    assert_eq!(plan.pools, vec!["p".to_string()], "no pool in project q, so nothing to pause there");
    assert_eq!(plan.runs.len(), 3);
}

#[test]
fn attention_is_listed_under_its_run() {
    let mut s = AppState::default();
    let mut snap = snapshot(vec![run("a", Bucket::NeedsYou)]);
    snap.attention = vec![attention_for("d1")];
    s.apply(Input::Snapshot(snap));
    assert_eq!(s.attention_for("p", "a").len(), 1);
    assert!(s.attention_for("p", "b").is_empty());
}
