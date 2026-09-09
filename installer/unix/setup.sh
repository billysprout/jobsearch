#!/usr/bin/env bash
# jobscrape kit setup - macOS / Linux.
# Mirrors setup.ps1: docker -> ollama -> gemma -> .env -> config seed ->
# compose up -> optional colibri -> probe. Idempotent; safe to re-run.
#
# Usage: ./setup.sh [--with-colibri] [--skip-probe] [--port 8790] [--at 07:00]
set -euo pipefail

KIT_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$KIT_ROOT/deploy"
JOBSCRAPE_DIR="$KIT_ROOT/jobscrape"
ENGINE_DIR="$KIT_ROOT/engine"

WITH_COLIBRI=0; SKIP_PROBE=0; PORT=8790; RUN_AT="07:00"
while [ $# -gt 0 ]; do
  case "$1" in
    --with-colibri) WITH_COLIBRI=1 ;;
    --skip-probe)   SKIP_PROBE=1 ;;
    --port)         PORT="$2"; shift ;;
    --at)           RUN_AT="$2"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac; shift
done

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    OK: %s\n' "$1"; }
warn() { printf '    !! %s\n' "$1" >&2; }

SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

# --- 1/7 Docker --------------------------------------------------------------
step "1/7 Docker"
if docker info >/dev/null 2>&1; then
  ok "docker engine already running"
else
  if ! command -v docker >/dev/null; then
    case "$(uname -s)" in
      Darwin)
        echo "    Installing Docker Desktop (brew)..."
        command -v brew >/dev/null || { warn "install Homebrew first (https://brew.sh), then re-run"; exit 1; }
        brew install --cask docker ;;
      Linux)
        echo "    Installing docker engine (get.docker.com)..."
        curl -fsSL https://get.docker.com | $SUDO sh
        $SUDO usermod -aG docker "$USER" || true
        warn "log out/in once for the docker group to apply (or run setup with sudo)" ;;
    esac
  fi
  echo "    Waiting for the docker engine..."
  for i in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 10
  done
  docker info >/dev/null 2>&1 || { warn "docker engine not reachable - start Docker Desktop / the daemon and re-run"; exit 1; }
  ok "docker engine is up"
fi

# --- 2/7 Ollama ---------------------------------------------------------------
step "2/7 Ollama"
if ! command -v ollama >/dev/null; then
  case "$(uname -s)" in
    Darwin) brew install ollama ;;
    Linux)  curl -fsSL https://ollama.com/install.sh | sh ;;
  esac
fi
ok "ollama CLI present"
if ! curl -s --max-time 4 http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "    starting ollama serve..."
  (nohup ollama serve >>"$ENGINE_DIR/engines.log" 2>&1 &)
  sleep 3
fi
curl -s --max-time 4 http://127.0.0.1:11434/api/tags >/dev/null \
  && ok "ollama server up on :11434" \
  || warn "ollama not reachable - gemma fallback unavailable until it runs"

# --- 3/7 gemma ----------------------------------------------------------------
step "3/7 gemma4 model (fallback ranker)"
if curl -s --max-time 5 http://127.0.0.1:11434/api/tags | grep -q "gemma4-e2b-64k"; then
  ok "gemma4-e2b-64k already present"
else
  # gemma4-e2b-64k is NOT a registry model - it's a local 64k-context variant
  # of the public gemma4:e2b (CI-proven 2026-09-09: `ollama pull
  # gemma4-e2b-64k` fails on every machine except the one that created the
  # variant by hand). Pull the public base, then build the variant.
  echo "    pulling gemma4:e2b (a few GB, one time)..."
  ollama pull gemma4:e2b || warn "ollama pull failed - ranking falls back to heuristics until this succeeds"
  if curl -s --max-time 5 http://127.0.0.1:11434/api/tags | grep -q "gemma4:e2b"; then
    # Temp file, not `-f -`: stdin Modelfiles proved unreliable on the CI
    # runner's ollama ("no Modelfile or safetensors files found").
    MF="$(mktemp)"
    printf 'FROM gemma4:e2b\nPARAMETER num_ctx 65536\n' > "$MF"
    echo "    creating the 64k-context variant (gemma4-e2b-64k)..."
    ollama create gemma4-e2b-64k -f "$MF" \
      || warn "ollama create failed - ranking falls back to heuristics until this succeeds"
    rm -f "$MF"
    curl -s --max-time 5 http://127.0.0.1:11434/api/tags | grep -q "gemma4-e2b-64k" \
      && ok "gemma4-e2b-64k ready (base gemma4:e2b + num_ctx 65536)"
  fi
fi

# --- 4/7 .env -----------------------------------------------------------------
step "4/7 secrets (.env)"
ENV_FILE="$DEPLOY_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  ok "deploy/.env already exists - keeping it"
else
  TOKEN="$(openssl rand -hex 32)"
  sed -e "s/^JOBSCRAPE_CONFIG_TOKEN=.*/JOBSCRAPE_CONFIG_TOKEN=$TOKEN/" \
      -e "s/^JOBSCRAPE_CONFIG_PORT=.*/JOBSCRAPE_CONFIG_PORT=$PORT/" \
      -e "s/^JOBSCRAPE_RUN_AT=.*/JOBSCRAPE_RUN_AT=$RUN_AT/" \
      "$DEPLOY_DIR/.env.example" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "wrote deploy/.env with a fresh API token"
fi

# --- 5/7 config seed ------------------------------------------------------------
step "5/7 config seed"
BASE_CFG="$JOBSCRAPE_DIR/configs/base.json"
if [ -f "$BASE_CFG" ]; then
  ok "configs/base.json already exists - keeping it"
else
  cp "$JOBSCRAPE_DIR/configs/base.example.json" "$BASE_CFG"
  ok "seeded configs/base.json from the example"
fi

# --- 6/7 colibri (optional) ------------------------------------------------------
step "6/7 colibri engine (optional)"
if [ "$WITH_COLIBRI" -eq 0 ]; then
  printf '    colibri: ~400 GB weights, 16 GB+ RAM. Without it: gemma ranking.\n'
  printf '    Install colibri too? [y/N] '
  # CI gotcha (kit-macos runs #4 and #5): a headless step's stdin is an
  # open-but-silent pipe, so `read` neither succeeds nor EOFs - run #4 died
  # at EOF under set -e, run #5 blocked here forever after. -t 10 turns
  # both into the bare-Enter default: No.
  read -t 10 -r answer || answer=""
  [ "${answer:-n}" = "y" ] || [ "${answer:-n}" = "Y" ] && WITH_COLIBRI=1
fi
set_colibri() {
  python3 - "$1" <<'PYEOF'
import json, sys
path = "jobscrape/configs/base.json"
with open(path) as f: cfg = json.load(f)
cfg.setdefault("colibri", {})["enabled"] = sys.argv[1] == "true"
with open(path, "w") as f: json.dump(cfg, f, indent=2)
print(f"    OK: colibri.enabled={sys.argv[1]} in configs/base.json")
PYEOF
}
cd "$KIT_ROOT"
if [ "$WITH_COLIBRI" -eq 1 ]; then
  bash "$ENGINE_DIR/install-colibri.sh" --kit-root "$KIT_ROOT"
  set_colibri true
else
  ok "skipping colibri - ranking will use gemma"
  set_colibri false
fi

# --- 7/7 stack up + probe --------------------------------------------------------
step "7/7 starting the stack"
# Bind-mount sources must pre-exist: for missing paths the daemon creates
# + chowns them itself, and through colima's VM mount that chown is denied
# (kit-macos run #6). Docker Desktop tolerates it; pre-create everywhere.
mkdir -p "$DEPLOY_DIR/state" "$DEPLOY_DIR/logs" "$DEPLOY_DIR/digests"
( cd "$DEPLOY_DIR" && docker compose up -d --build )
ok "stack is up"

if [ "$SKIP_PROBE" -eq 0 ]; then
  echo "    dry-run probe (real engines, writes nothing; may take a few minutes)..."
  ( cd "$DEPLOY_DIR" && docker compose run --rm scraper node scrape.mjs --once --dry-run --limit 3 ) \
    && ok "probe run finished cleanly" \
    || warn "probe exited nonzero - check deploy/logs/"
fi

DIGESTS_ABS="$(cd "$DEPLOY_DIR" && pwd)/digests"
# Onboarding tail: hand over a ready-to-open status URL (loopback-only bind,
# so the token in it never leaves this machine) and auto-open it. Under CI
# the logs are public - print a redacted URL and skip the browser-open.
STATUS_TOKEN="$(sed -n 's/^JOBSCRAPE_CONFIG_TOKEN=//p' "$ENV_FILE")"
STATUS_PORT="$(sed -n 's/^JOBSCRAPE_CONFIG_PORT=//p' "$ENV_FILE")"
if [ "${CI:-false}" = "true" ]; then
  STATUS_URL="http://127.0.0.1:${STATUS_PORT:-$PORT}/?token=<redacted - see deploy/.env>"
  STATUS_HINT="               (open the URL above with the token from deploy/.env)"
else
  STATUS_URL="http://127.0.0.1:${STATUS_PORT:-$PORT}/?token=${STATUS_TOKEN}"
  STATUS_HINT="               (just opened in your browser; loopback-only - token stays local)"
  open "$STATUS_URL" >/dev/null 2>&1 || xdg-open "$STATUS_URL" >/dev/null 2>&1 || true
fi
printf '\njobscrape is installed.\n'
printf '  status page: %s\n' "$STATUS_URL"
printf '%s\n' "$STATUS_HINT"
printf '  digests:     %s/digest/<date>.md\n' "$DIGESTS_ABS"
printf '  schedule:    daily at %s (container restarts keep it alive)\n' "$RUN_AT"
printf '  logs:        %s/logs\n' "$DEPLOY_DIR"
if [ "$WITH_COLIBRI" -eq 0 ]; then
  printf '\n  colibri not installed. To add it later: ./setup.sh --with-colibri\n'
fi
printf '\nNext steps:\n'
printf '  1. Set your tracks, keywords and watched companies on the status page\n     (opened above) - changes apply on the next run.\n'
printf '  2. Want your first real digest now, without waiting for %s?\n       cd "%s" && docker compose run --rm scraper node scrape.mjs --once\n' "$RUN_AT" "$DEPLOY_DIR"
printf '  3. That is it - the scraper takes it from here, daily at %s.\n' "$RUN_AT"
