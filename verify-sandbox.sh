#!/usr/bin/env bash
# Escape-path verification for the OpenClaw sandbox.
# Each test maps to a row in SECURITY-REVIEW.md. All must pass before go-live.
set -uo pipefail
export MSYS_NO_PATHCONV=1   # git-bash: stop /path mangling in docker args
cd "$(dirname "$0")"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $1"; }

run_gw() { # run_gw [KEY=VAL env overrides...] -- <node -e script>
  local overrides=()
  while [ "$1" != "--" ]; do overrides+=( -e "$1" ); shift; done
  shift
  docker compose run -T --rm --no-deps ${overrides[@]+"${overrides[@]}"} \
    --entrypoint node openclaw-gateway -e "$@" 2>&1 | grep -v "^ Container "
}

echo "== T1: direct egress is topologically impossible (proxy env stripped) =="
OUT="$(run_gw NODE_USE_ENV_PROXY=0 HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= -- \
  'fetch("https://api.z.ai",{signal:AbortSignal.timeout(8000)}).then(()=>console.log("REACHED")).catch(e=>console.log("BLOCKED:",e.cause&&e.cause.code||e.message))')"
echo "$OUT" | grep -q "BLOCKED" && ok "T1 direct fetch blocked (no route out / no DNS)" || bad "T1 direct fetch NOT blocked: $OUT"

echo "== T2: z.ai reachable through allowlist proxy (model API must work) =="
OUT="$(run_gw -- \
  'fetch("https://api.z.ai/api/paas/v4/chat/completions",{method:"POST",headers:{"content-type":"application/json"},body:"{}",signal:AbortSignal.timeout(20000)}).then(r=>console.log("HTTP",r.status)).catch(e=>console.log("ERR:",e.cause&&e.cause.code||e.message))')"
echo "$OUT" | grep -qE "HTTP (200|401|400)" && ok "T2 z.ai reachable via proxy ($(echo "$OUT" | grep -oE 'HTTP [0-9]+' | head -1))" || bad "T2 z.ai NOT reachable via proxy: $OUT"

echo "== T3: arbitrary host denied by allowlist (exfil channel closed) =="
OUT="$(run_gw -- \
  'fetch("https://example.com",{signal:AbortSignal.timeout(10000)}).then(r=>console.log("LEAK HTTP",r.status)).catch(e=>console.log("DENIED:",e.cause&&e.cause.code||e.message))')"
echo "$OUT" | grep -qE "DENIED|BLOCKED" && ok "T3 example.com denied" || bad "T3 example.com LEAKED: $OUT"

echo "== T4: no docker socket mounted (container-escape path removed) =="
OUT="$(run_gw -- 'console.log(require("fs").existsSync("/var/run/docker.sock")?"PRESENT":"ABSENT")')"
echo "$OUT" | grep -q "ABSENT" && ok "T4 /var/run/docker.sock absent" || bad "T4 docker.sock PRESENT"

echo "== T5: read-only root filesystem =="
OUT="$(run_gw -- 'try{require("fs").writeFileSync("/ro-probe","x");console.log("WRITABLE")}catch(e){console.log("EROFS")}')"
echo "$OUT" | grep -q "EROFS" && ok "T5 rootfs is read-only" || bad "T5 rootfs WRITABLE"

echo "== T6: all Linux capabilities dropped =="
OUT="$(run_gw -- 'const s=require("fs").readFileSync("/proc/self/status","utf8");const l=s.split("\n").find(l=>l.startsWith("CapEff"));console.log(l.replace(/\s+/g,""))')"
echo "$OUT" | grep -q "CapEff:0000000000000000" && ok "T6 CapEff=0 (cap_drop ALL)" || bad "T6 capabilities remain: $OUT"

echo "== T7: container env holds no secrets beyond the two this instance owns =="
OUT="$(run_gw -- 'console.log(Object.keys(process.env).sort().join("\n"))')"
UNEXPECTED="$(echo "$OUT" | grep -vE '^(HOME|PATH|HOSTNAME|TERM|TZ|NODE_VERSION|YARN_VERSION|NODE_USE_ENV_PROXY|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|OPENCLAW_[A-Z_]+|ZAI_API_KEY|OTEL[A-Z_]*|BROWSER|COREPACK_HOME|NODE_ENV|PLAYWRIGHT_BROWSERS_PATH)$' || true)"
[ -z "$UNEXPECTED" ] && ok "T7 env surface as designed" || bad "T7 unexpected env vars: $UNEXPECTED"

echo "== T8: host file system unreachable (named volumes only) =="
# assert on MOUNT POINTS (column 2) — the device column legitimately contains /dev/*
OUT="$(docker compose run -T --rm --no-deps --entrypoint sh openclaw-gateway \
  -c 'awk "\$2 !~ /^\/(proc|sys|dev|run)(\/|\$)/ && \$2 !~ /^\/etc\// {print \$2}" /proc/mounts' 2>&1 | grep -v "^ Container " | sort -u)"
BAD_MOUNTS="$(echo "$OUT" | grep -vE '^(/|/tmp|/usr/sbin/docker-init|/home/node/\.openclaw|/home/node/\.openclaw/workspace|/home/node/\.config/openclaw|/home/node/\.npm)$' || true)"
echo "$OUT" | grep -q "^/home/node/\.openclaw$" && [ -z "$BAD_MOUNTS" ] \
  && ok "T8 mount points = root + tmpfs + 3 named volumes only" || bad "T8 unexpected mounts: $BAD_MOUNTS (all: $OUT)"

echo "== T9: config present on its own volume (setup completed) =="
OUT="$(run_gw -- 'console.log(require("fs").statSync("/home/node/.openclaw/openclaw.json").isFile()?"cfg-ok":"missing")')"
echo "$OUT" | grep -q "cfg-ok" && ok "T9 openclaw.json in place on config volume" || bad "T9 config missing: $OUT"

echo "== T10: egress proxy logs denials (detection control works) =="
OUT="$(docker compose logs egress 2>&1 | tail -80)"
echo "$OUT" | grep -qiE "TCP_DENIED" && ok "T10 squid logged denial(s) from T3 (detection alive)" || bad "T10 no denial lines in egress log — check detection"

echo
echo "RESULT: $PASS passed, $FAIL failed"
exit $FAIL
