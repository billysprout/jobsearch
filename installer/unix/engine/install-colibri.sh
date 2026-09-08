#!/usr/bin/env bash
# install-colibri.sh - colibri engine + GLM-5.2 int4 weights (macOS/Linux).
# Latest GitHub release (prebuilt) + Hugging Face weights + engine keep-alive
# unit (systemd user service on Linux, LaunchAgent on macOS). Idempotent.
#
# Usage: install-colibri.sh --kit-root /path/to/kit
set -euo pipefail

REPO="JustVugg/colibri"
HF_REPO="mastouri/GLM-5.2-colibri-int4-g64-with-int8-mtp"
MIN_FREE_DISK_GB=420
MIN_RAM_GB=16

KIT_ROOT="."
while [ $# -gt 0 ]; do
  case "$1" in
    --kit-root) KIT_ROOT="$2"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac; shift
done
ENGINE_DIR="$KIT_ROOT/engine"
COLIBRI_DIR="$ENGINE_DIR/colibri"
MODEL_DIR="$ENGINE_DIR/glm52"
OS="$(uname -s)"; ARCH="$(uname -m)"

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    OK: %s\n' "$1"; }
warn() { printf '    !! %s\n' "$1" >&2; }

# --- prereqs ---
step "prerequisites"
FREE_KB="$(df -Pk "$KIT_ROOT" | awk 'NR==2 {print $4}')"
FREE_GB=$((FREE_KB / 1024 / 1024))
echo "    free disk: ${FREE_GB} GB (need ${MIN_FREE_DISK_GB} GB)"
[ "$FREE_GB" -lt "$MIN_FREE_DISK_GB" ] && { warn "not enough disk - aborting colibri install (gemma-only stays active)"; exit 1; }
RAM_GB=0
case "$OS" in
  Darwin) RAM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 )) ;;
  Linux)  RAM_GB=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024 / 1024 )) ;;
esac
[ "$RAM_GB" -lt "$MIN_RAM_GB" ] && warn "this machine has ${RAM_GB} GB RAM; colibri wants ${MIN_RAM_GB} GB+ (it will run, slowly)"
command -v python3 >/dev/null || { warn "python3 required (colibri launcher + weight downloads)"; exit 1; }
ok "prerequisites satisfied"

# --- engine release ---
step "colibri engine (GitHub release)"
if [ -f "$COLIBRI_DIR/.installed" ]; then
  ok "already installed at $COLIBRI_DIR"
else
  case "$OS" in
    Darwin) PATTERN="macos|darwin" ;;
    Linux)  PATTERN="linux" ;;
  esac
  case "$ARCH" in arm64|aarch64) ARCHPAT="aarch64|arm64" ;; *) ARCHPAT="x86_64|amd64" ;; esac
  echo "    resolving latest release..."
  ASSET_URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | python3 -c "
import json, re, sys
rel = json.load(sys.stdin)
pat = rf'({os_pat}).*({arch_pat}).*\.(tar\.gz|tgz|zip)$'
for a in rel['assets']:
    if re.search(pat, a['name'], re.I):
        print(a['browser_download_url']); break
else:
    sys.exit('no matching release asset')
" os_pat="$PATTERN" arch_pat="$ARCHPAT")"
  FNAME="$(basename "$ASSET_URL")"
  echo "    downloading $FNAME ..."
  curl -fL "$ASSET_URL" -o "/tmp/$FNAME"
  mkdir -p "$COLIBRI_DIR"
  case "$FNAME" in
    *.zip) unzip -o "/tmp/$FNAME" -d "$COLIBRI_DIR" ;;
    *)     tar xzf "/tmp/$FNAME" -C "$COLIBRI_DIR" ;;
  esac
  rm -f "/tmp/$FNAME"
  echo "release $ASSET_URL" > "$COLIBRI_DIR/.installed"
  chmod +x "$COLIBRI_DIR"/coli* 2>/dev/null || true
  ok "colibri extracted to $COLIBRI_DIR"
fi

# --- weights ---
step "GLM-5.2 int4 weights from Hugging Face (~400 GB)"
if [ -f "$MODEL_DIR/.complete" ]; then
  ok "weights already present at $MODEL_DIR"
else
  python3 -m pip install -U "huggingface_hub[cli]" >/dev/null
  HF_CLI="$(python3 -c 'import sys; print(sys.exec_prefix)')/bin/huggingface-cli"
  [ -x "$HF_CLI" ] || HF_CLI="huggingface-cli"
  mkdir -p "$MODEL_DIR"
  echo "    downloading $HF_REPO - this is the long step (resumes if interrupted)..."
  "$HF_CLI" download "$HF_REPO" --local-dir "$MODEL_DIR"
  echo "done" > "$MODEL_DIR/.complete"
  ok "weights downloaded to $MODEL_DIR"
fi

# --- keep-alive unit ---
step "registering the engine keep-alive unit"
bash "$ENGINE_DIR/register-engine-units.sh" --kit-root "$KIT_ROOT"
printf '\ncolibri installed. The scraper picks it up on the next run.\n'
