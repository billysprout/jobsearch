#!/usr/bin/env bash
# register-engine-units.sh - install the engine keep-alive as a systemd USER
# unit (Linux) or a LaunchAgent (macOS): runs ensure-engines.sh at login and
# daily at 06:45. Idempotent; re-running refreshes the definition.
#
# Usage: register-engine-units.sh --kit-root /path/to/kit
set -euo pipefail

KIT_ROOT="."
while [ $# -gt 0 ]; do
  case "$1" in
    --kit-root) KIT_ROOT="$2"; shift ;;
    *) ;;
  esac; shift
done
ENSURE="$KIT_ROOT/engine/ensure-engines.sh"
chmod +x "$ENSURE" 2>/dev/null || true
OS="$(uname -s)"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    OK: %s\n' "$1"; }

if [ "$OS" = "Darwin" ]; then
  step "macOS LaunchAgent"
  PLIST="$HOME/Library/LaunchAgents/org.jobscrape.engines.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.jobscrape.engines</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$ENSURE</string>
    <string>--kit-root</string><string>$KIT_ROOT</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>45</integer></dict>
  <key>StandardOutPath</key><string>$KIT_ROOT/engine/launchd.log</string>
  <key>StandardErrorPath</key><string>$KIT_ROOT/engine/launchd.log</string>
</dict></plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  ok "LaunchAgent loaded (runs at login + daily 06:45)"
else
  step "Linux systemd user unit"
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/jobscrape-engines.service" <<EOF
[Unit]
Description=jobscrape engine keep-alive (colibri + ollama health-check/start)

[Service]
Type=oneshot
ExecStart=$ENSURE --kit-root $KIT_ROOT
RemainAfterExit=no

[Install]
WantedBy=default.target
EOF
  TIMER_DIR="$(dirname "$UNIT_DIR")/systemd/user"
  mkdir -p "$TIMER_DIR"
  cat > "$TIMER_DIR/jobscrape-engines.timer" <<EOF
[Unit]
Description=daily 06:45 jobscrape engine keep-alive

[Timer]
OnCalendar=*-*-* 06:45:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now jobscrape-engines.service 2>/dev/null || true
  systemctl --user enable --now jobscrape-engines.timer 2>/dev/null || true
  ok "systemd user unit + timer enabled (runs at login + daily 06:45)"
  if command -v loginctl >/dev/null && [ "$(loginctl show-user "$USER" -p Linger 2>/dev/null | cut -d= -f2)" != "yes" ]; then
    printf '    note: engines only start at login. For headless start-at-boot:\n      sudo loginctl enable-linger %s\n' "$USER"
  fi
fi
