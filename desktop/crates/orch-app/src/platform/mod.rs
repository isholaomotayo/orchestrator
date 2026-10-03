//! The few things GPUI does not do for us. macOS only; elsewhere they are no-ops.

/// Show `count` on the Dock icon, or clear it at zero.
///
/// Call from the main thread, which is where GPUI runs its effects. If that
/// ever changes this does nothing rather than touch AppKit off-thread.
#[cfg(target_os = "macos")]
pub fn set_dock_badge(count: u32) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    use objc2_foundation::NSString;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let label = (count > 0).then(|| NSString::from_str(&count.to_string()));
    NSApplication::sharedApplication(mtm)
        .dockTile()
        .setBadgeLabel(label.as_deref());
}

#[cfg(not(target_os = "macos"))]
pub fn set_dock_badge(_count: u32) {}
