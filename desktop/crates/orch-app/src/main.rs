//! Orchestrator Desktop (M1): a native, optional companion to the /orchestrate
//! skill. Everything it shows comes from a dashboard server's /api/v1; it never
//! reads .pipeline/ itself and never owns the server, so the skill works the
//! same with the app closed.

mod app;
mod notified;
mod theme;

use gpui::{App, Bounds, WindowBounds, WindowOptions, prelude::*, px, size};
use gpui_platform::application;

fn main() {
    // URLs arrive before any window exists (and without an app context), so
    // they are queued and drained by a task once the view is up.
    let (links_tx, links_rx) = async_channel::unbounded::<String>();
    let app = application();
    app.on_open_urls(move |urls| {
        for url in urls {
            let _ = links_tx.try_send(url);
        }
    });
    app.run(move |cx: &mut App| {
        cx.set_app_identity("dev.orchestrator.desktop", "Orchestrator");
        let bounds = Bounds::centered(None, size(px(1180.), px(760.)), cx);
        let view = cx.new(app::OrchestratorApp::new);
        app::OrchestratorApp::install_global_handlers(&view, cx);
        let links_view = view.clone();
        cx.spawn(async move |cx| {
            while let Ok(url) = links_rx.recv().await {
                links_view.update(cx, |this, cx| this.open_link(&url, cx));
            }
        })
        .detach();
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(gpui::TitlebarOptions {
                    title: Some("Orchestrator".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            move |_, _| view,
        )
        .expect("failed to open the Orchestrator window");
        cx.activate(true);
    });
}
