#!/usr/bin/env bash
# Build Orchestrator.app for local use: a real bundle id (macOS only delivers
# notifications to bundled apps) and the orchestrator:// URL scheme, ad-hoc
# signed. Distribution signing/notarization needs a Developer ID; pass
# SIGN_IDENTITY="Developer ID Application: …" to use one.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
cargo build --release -p orch-app
APP="target/Orchestrator.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/release/orchestrator-desktop "$APP/Contents/MacOS/Orchestrator"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Orchestrator</string>
  <key>CFBundleDisplayName</key><string>Orchestrator</string>
  <key>CFBundleIdentifier</key><string>dev.orchestrator.desktop</string>
  <key>CFBundleExecutable</key><string>Orchestrator</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>dev.orchestrator.desktop.open</string>
      <key>CFBundleURLSchemes</key><array><string>orchestrator</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST
codesign --force --sign "${SIGN_IDENTITY:--}" "$APP"
echo "Built $APP (version $VERSION). Open it with: open \"$APP\""
