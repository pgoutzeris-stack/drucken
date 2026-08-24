#!/usr/bin/env bash
# Installiert Helfer und/oder Agent als LaunchAgent, damit sie mit dem Mac starten.
#
#   bash bridge/install.sh helper   nur den lokalen Helfer (127.0.0.1)
#   bash bridge/install.sh agent    nur den Agenten fuer die Warteschlange
#   bash bridge/install.sh both     beides (Standard)
set -euo pipefail

WHAT="${1:-both}"
case "$WHAT" in
  helper|agent|both) ;;
  *) echo "Unbekannt: $WHAT — erlaubt sind helper, agent, both" >&2; exit 2 ;;
esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
  echo "node wurde nicht gefunden. Installieren: brew install node" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.roots-print"

install_one() {
  local label="$1" script="$2" log="$3"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  cat > "$plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/bridge/$script</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.roots-print/$log.log</string>
  <key>StandardErrorPath</key><string>$HOME/.roots-print/$log.err.log</string>
</dict>
</plist>
PLIST_EOF
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  echo "$label geladen."
}

if [ "$WHAT" = "helper" ] || [ "$WHAT" = "both" ]; then
  install_one com.roots.printbridge roots-print-bridge.js bridge
fi
if [ "$WHAT" = "agent" ] || [ "$WHAT" = "both" ]; then
  install_one com.roots.printagent roots-print-agent.js agent
fi

sleep 2
if [ "$WHAT" != "agent" ]; then
  echo "Helfer-Token: $(cat "$HOME/.roots-print/token" 2>/dev/null || echo '(wird beim ersten Start angelegt)')"
  echo "Test:         curl -s http://127.0.0.1:7331/api/health"
fi
if [ "$WHAT" != "helper" ]; then
  HASH="$(node "$REPO/bridge/roots-print-agent.js" --hash 2>/dev/null || true)"
  echo "Agent-Hash:   ${HASH:-(node fehlt)}"
  echo "              Diesen Hash im Tool unter Verbindung / Agent freischalten eintragen."
fi
