#!/usr/bin/env bash
# Installs the ROOTS Print Bridge as a LaunchAgent so it starts with the Mac.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.roots.printbridge.plist"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
  echo "node wurde nicht gefunden. Installieren: brew install node" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.roots-print"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.roots.printbridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/bridge/roots-print-bridge.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.roots-print/bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/.roots-print/bridge.err.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

sleep 1
echo "Helfer installiert."
echo "Token: $(cat "$HOME/.roots-print/token" 2>/dev/null || echo '(wird beim ersten Start angelegt)')"
echo "Test:  curl -s http://127.0.0.1:7331/api/health"
