#!/usr/bin/env bash
# ensure-engines.sh - keep-alive payload: health-check colibri (:8000) and
# Ollama (:11434), start only what is down. Runs from the systemd user unit /
# LaunchAgent (see register-engine-units.sh) at login + daily 06:45, and is
# safe to run by hand.
#
# Usage: ensure-engines.sh --kit-root /path/to/kit
set -u

KIT_ROOT="."
while [ $# -gt 0 ]; do
  case "$1" in
    --kit-root) KIT_ROOT="$2"; shift ;;
    *) ;;
  esac; shift
done
ENGINE_DIR="$KIT_ROOT/engine"
COLIBRI_DIR="$ENGINE_DIR/colibri"
MODEL_DIR="$ENGINE_DIR/glm52"
LOG_FILE="$ENGINE_DIR/engines.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$LOG_FILE"; }
up()  { curl -s --max-time 4 "$1" >/dev/null 2>&1; }

log "=== ensure-engines start ==="

# --- Ollama ---
if up "http://127.0.0.1:11434/api/tags"; then
  log "ollama already up on :11434"
elif command -v ollama >/dev/null; then
  log "starting ollama serve"
  (nohup ollama serve >>"$LOG_FILE" 2>&1 &)
else
  log "ollama not installed - skipping (gemma fallback unavailable)"
fi

# --- colibri ---
if [ ! -f "$COLIBRI_DIR/.installed" ]; then
  log "colibri not installed - skipping (gemma-only ranking)"
elif up "http://127.0.0.1:8000/health"; then
  log "colibri already up on :8000"
else
  COLI=""
  [ -x "$COLIBRI_DIR/coli" ] && COLI="$COLIBRI_DIR/coli"
  [ -z "$COLI" ] && [ -f "$COLIBRI_DIR/coli" ] && COLI="python3 $COLIBRI_DIR/coli"
  if [ -n "$COLI" ]; then
    log "starting colibri (model: $MODEL_DIR)"
    export COLI_MODEL="$MODEL_DIR"
    (cd "$COLIBRI_DIR" && nohup $COLI serve --model "$MODEL_DIR" >>"$LOG_FILE" 2>&1 &)
    for _ in $(seq 1 20); do
      up "http://127.0.0.1:8000/health" && { log "colibri is up on :8000"; break; }
      sleep 5
    done
    up "http://127.0.0.1:8000/health" || log "colibri did not answer /health within 100s (weights still loading?)"
  else
    log "no colibri launcher found in $COLIBRI_DIR - inspect the release layout"
  fi
fi

log "=== ensure-engines done ==="
