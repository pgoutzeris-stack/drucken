#!/usr/bin/env bash
set -euo pipefail
for label in com.roots.printbridge com.roots.printagent; do
  PLIST="$HOME/Library/LaunchAgents/$label.plist"
  [ -f "$PLIST" ] || continue
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "$label entfernt."
done
echo "Token bleiben in ~/.roots-print/."
