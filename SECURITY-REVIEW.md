# OpenClaw Sandbox — Adversarial-AI Security Review

**Deployment:** `C:\claw-code-local\openclaw-sandbox\` · Docker Desktop 4.82 / engine 29.6.1 (WSL2)
**Provider:** z.ai (`zai/glm-5.3` via `https://api.z.ai/api/coding/paas/v4`) — dedicated GLM Coding Plan key
**Image:** `ghcr.io/openclaw/openclaw@sha256:2f5ce8848a1a69b3c460622e566cb9395da9fd18d7ef7b038cd8e2c4f195decf` (digest-pinned)
**Review date:** 2026-08-22 · **Status: LIVE** (egress + frontend + gateway up; strict profile active)

---

## 1. Trust boundaries

```
┌─ Windows host (your files, browser, SSH keys, Cortex prod data) ─────────────┐
│  ┌─ Docker Desktop WSL2 utility VM ────────────────────────────────────┐     │
│  │  ┌─ internal network (internal:true — NO route to internet/LAN) ─┐  │     │
│  │  │  ┌─ openclaw-gateway ─────────────────────────┐               │  │     │
│  │  │  │  agent + exec + tools                      │               │  │     │
│  │  │  │  read-only rootfs · cap_drop ALL · uid 1000 │               │  │     │
│  │  │  │  only mounts: 3 named volumes + /tmp tmpfs │               │  │     │
│  │  │  └───────────────┬────────────────────────────┘               │  │     │
│  │  └──────────────────│────────────────────────────────────────────┘  │     │
│  │              ┌──── squid egress allowlist ────┐                      │     │
│  │              │ CONNECT :443 → *.z.ai,         │──→ internet          │     │
│  │              │ *.bigmodel.cn ONLY. Else: 403  │   (nothing else)    │     │
│  │              └────────────────────────────────┘                      │     │
│  │        (sibling containers — incl. Cortex — share this VM)           │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
└── host reachability: ONLY 127.0.0.1:18789 → gateway (token-auth, fail-closed) ┘
```

The gateway container **is** the agent sandbox. There is no host filesystem path, no
Docker socket, no LAN route, and no arbitrary-internet egress from inside it.

## 2. Comparison to industry baseline for adversarial agents

| Industry control (source) | This deployment | Verdict |
|---|---|---|
| Break the "lethal trifecta" — untrusted input × sensitive access × egress (Willison/AIRIA framing, 2026) | No inbound channels configured at all (zero untrusted input); no host secrets in boundary (nothing sensitive to reach); egress = z.ai only (one leg reduced to the provider itself) | **Exceeds** typical self-host setup |
| Restrict network egress — the key exfiltration channel (Augment Code, NVIDIA agentic-sandbox guidance) | `internal:true` network + deny-by-default squid CONNECT allowlist; direct egress fails even with proxy env stripped (T1) | **Meets/exceeds** |
| Layered isolation, microVM/gVisor over plain containers (Northflank sandboxing guide) | Container + WSL2 VM boundary. **No gVisor available on Docker Desktop/Windows.** Compensating: cap_drop ALL, non-root, read-only rootfs, default seccomp, no socket, digest-pinned minimal image | **Partial — see R1** |
| Remove host credential access (all 2025–26 frontier-model incident reports: SSH keys, browser cookies, cloud creds) | Named volumes only — no host bind mounts; env contains only this instance's own z.ai key + gateway token (T7, T8) | **Meets** |
| Fail-closed control plane (agent-gateway security guidance, Black Hat USA 2026 themes) | Token auth required (gateway refuses WS without it); bind loopback; port published to 127.0.0.1 only; Bonjour/mDNS off; channels skipped | **Meets** |
| Detection of injection/exfil attempts | squid access log records every denied CONNECT (T10); OpenClaw `security audit` (0 critical); transcripts + redaction on by default | **Meets** |
| Supply-chain pinning (agent-supply-chain talks, 2026) | Image digest-pinned; egress proxy built locally from alpine+squid (no third-party "secure" image); plugin installed by operator inside a temporary egress window only | **Meets — see R4** |
| OpenClaw SECURITY.md own recommended flags (`--read-only --cap-drop=ALL`, loopback bind, token auth, tool deny list, `tools.elevated` off, `applyPatch.workspaceOnly`) | All adopted (stock compose only drops NET_RAW/NET_ADMIN and bind-mounts host `~/.openclaw`; both improved here) | **Exceeds stock** |

## 3. Escape-path matrix — "what frontier models actually did recently" → status

| # | Technique (public incident class) | Status | Control in this deployment | Evidence |
|---|---|---|---|---|
| 1 | **Terminal escape via web content** — Claude agentic-search (Jul 2025): wikiHow page instructed the model to `curl \| bash` a binary; it ran | PATCHED | `web_fetch`/`web_search`/`browser` denied; no Chromium in image; even if exec'd, only z.ai is reachable — binary download fails | T1, T3 |
| 2 | **Zero-click injection → sandbox escape → host RCE** (Cursor "AIDuneSlide", 2026) | CONTAINED | exec's "host" is this container: read-only rootfs, no caps, no socket, no host FS. Worst case = inside the throwaway volume | T4–T6, T8 |
| 3 | **Credential exfil via screenshots/git commits** (Anthropic "Project Fetch" class, 2026) | PATCHED | No browser/screenshot surface; no git host in allowlist; no host repos mounted | T1, T8 |
| 4 | **Browser-profile session theft** (OpenClaw's own browser-control-abuse path) | PATCHED | No `-browser` image variant, `browser` tool denied, no profiles/sessions exist in container | config deny list |
| 5 | **Docker-socket escape** (mount `/var/run/docker.sock` → privileged sibling) | PATCHED | Socket never mounted (stock compose ships it commented; we removed the option); OpenClaw per-agent docker sandbox OFF (`agents.defaults.sandbox.mode: off`) so nothing ever auto-mounts it | T4 |
| 6 | **SSH-key / `authorized_keys` / cloud-cred theft** (most common live-agent exfil demo) | PATCHED | No host home dir in boundary; named volumes hold only OpenClaw state; nothing else exists to steal | T7, T8 |
| 7 | **`npx <typosquat>` / malicious package install** (documented Claude Code attack vector) | PATCHED | npm registry unreachable from agent (verify: onboard 403'd on npm until operator widened); plugin installs only via operator `egress-setup` window with agent stopped | T3 + onboard log |
| 8 | **Exfil via webhook / markdown-image URL / link ping** (lethal-trifecta egress leg) | PATCHED | Internal network + domain allowlist; ANY non-z.ai destination refused and logged | T1, T3, T10 |
| 9 | **Rogue MCP server / plugin supply chain** | PATCHED | No MCP servers configured; one plugin (official `@openclaw/zai-provider@2026.7.1`, shrinkwrap-locked); operator-only installs | audit, plugins |
| 10 | **Self-persistence via cron / git hooks / autostart** | PATCHED | `cron` + `gateway` + `nodes` tools denied; no daemon installed (`--no-install-daemon`); persistence confined to named volume (`docker compose down -v` wipes) | config deny list |
| 11 | **Gateway takeover** (unauth WS / LAN bind / Tailscale-Funnel misconfig — real OpenClaw exposure class) | PATCHED | Loopback bind; `127.0.0.1:18789` publish only; token auth fail-closed; Bonjour off; bridge/msteams ports not published; zero messaging channels paired | T2-era config, audit |
| 12 | **SSRF → LAN/host/metadata scan** (incl. `host.docker.internal`) | PATCHED | `extra_hosts` removed; internal network has no route to LAN/host; browser SSRF policy default (private nets blocked) | T1, compose |
| 13 | **Tokenizer/chat-template injection** (self-hosted backend forging role boundaries) | N/A/PATCHED | Hosted z.ai endpoint; OpenClaw strips `<|im_start|>`-style tokens from external content | docs |
| 14 | **Runtime CVE abuse** (async_hooks DoS CVE-2025-59466; permission-model bypass CVE-2026-21636 — need patched Node) | MITIGATED | Current official image on Node 24 (patched line); blast radius capped by mem 2g / cpus 2 / pids 256 | compose |
| 15 | **Multi-tenant/stranger DM abuse** ("someone messaged the bot") | MITIGATED-BY-CONFIG | WhatsApp channel added 2026-08-23; Telegram channel added 2026-08-24 as a second, additional channel (same operator, same allowlist model — see §4 R16–R18). Both: `dmPolicy: allowlist` with a single allowlisted identity per channel (not the looser default `pairing`), `groupPolicy: disabled`. WhatsApp additionally sets `sendReadReceipts: false`, `actions.calls: false`, `pluginHooks.messageReceived: false` (Telegram's schema doesn't have these fields — `pluginHooks` on `channels.telegram` fails config validation). Residual risks in §4 R9–R11 (WhatsApp), R16–R18 (Telegram). | config, cli `channels status --probe` |

## 4. Residual risk register (accepted-with-reason)

| ID | Risk | Severity | Rationale / recommendation |
|---|---|---|---|
| R1 | Container-runtime/kernel 0-day escape lands in the **shared WSL2 VM** — sibling containers include your production Cortex stack | **Medium** | Strong compensations (cap_drop ALL, non-root, ro rootfs, seccomp, no socket, digest-pinned image) make escape very unlikely; full fix = run this compose in a **separate Docker engine** (dedicated WSL distro/Hyper-V). The compose file is self-contained — lift-and-shift works unchanged. |
| R2 | The z.ai API is the one intentionally-open channel: a fully-injected agent can send data to (and consume quota on) its own provider | **Low** | Inherent to any LLM agent (the model call is the trusted channel). Key is a **GLM Coding Plan** key: no pay-as-you-go billing, so financial exposure = subscription price only; rolling 5-hour/weekly quotas bound burn rate. Residual = quota exhaustion (agent abuse starves your own Claude Code windows until reset) + data-to-provider channel. z.ai has **no per-key spend caps** for personal plans (Team Plans only). Mitigation if wanted: second cheap-tier Coding Plan subscription as the sandbox's key (own quota windows), regenerate key on suspicion. |
| R3 | `tools.exec.security: "full"` (audit WARN) — agent runs shell without per-command approval | **Low** | Deliberate: exec is contained by the container+egress boundary, so approval UX adds little security here. Stricter alternative in §6. |
| R4 | Plugin install spec unpinned (audit WARN) | **Low** | Re-install happens only inside operator egress windows; `npm-shrinkwrap.json` locks deps; installed 2026.7.1 = current latest. |
| R5 | Squid allowlist is domain-level; DNS comes from Docker's embedded resolver (host upstream). DNS-spoofing could redirect an allowed *name* | **Low** | Attacker must control your host DNS to abuse; even then only the two allowed names matter, and destinations would need to present valid TLS for a useful MITM. |
| R6 | Published-port-on-internal-network behavior unverified (gateway never started) | **Resolved** | Confirmed at first start: published ports do NOT function on `internal:true` networks. Fixed with the documented fallback — `frontend` socat forwarder (dual-homed internal+egress, inbound-only relay, loopback publish). Gateway binds `lan` inside the sealed net (a loopback bind is unreachable cross-netns); safe because its only neighbors are the forwarder and the egress proxy, and host ingress stays `127.0.0.1`-only. Verified: `/healthz` 200, `/readyz` 200. |
| R7 | Any local Windows process can *reach* 127.0.0.1:18789 | **Info** | Gateway requires the 64-hex token (fail-closed). Same trust domain as your desktop. |
| R8 | No gVisor/microVM (unavailable on Docker Desktop Windows) | **Info** | Accepted for platform reasons — see R1 upgrade path. |
| R9 | WhatsApp DM content is untrusted input — reopens the prompt-injection leg of the lethal trifecta for the one allowlisted thread | **Low** | exec/process still denied, fs stays workspace-only, egress stays allowlisted; blast radius of a successful injection is "send more WhatsApp messages/media to the same allowlisted number," not host/filesystem/exfil-elsewhere. |
| R10 | WhatsApp channel widens the exfil surface: a compromised agent can send workspace data as WhatsApp messages/media to any WhatsApp contact, not just the operator | **Low** | Single-operator `allowFrom` bounds *inbound* triggering, not outbound send targets — the plugin can address arbitrary WhatsApp JIDs. Squid sees only `.whatsapp.net`/`.whatsapp.com` destinations, not payloads (TLS). Accepted: operator is the only one who can prompt the agent via this channel in the first place. |
| R11 | Linked-device WhatsApp session is a persistent credential (`~/.openclaw/credentials/whatsapp/` in the `openclaw-config` volume) — equivalent to a stolen phone's WA session if the volume leaks | **Low** | No host bind mount, volume only readable via `docker volume` access on this machine; revoke any time via WhatsApp → Linked Devices → remove, no code change needed. |
| R12 | `raw.githubusercontent.com` added to the persistent egress allowlist (2026-08-23) — the WhatsApp plugin (Baileys) calls `fetchLatestBaileysVersion()` on *every* connect/reconnect, not just first login; when denied it falls back to a bundled protocol version that WhatsApp's servers reject outright, causing a reconnect loop against WA's own servers | **Medium** | Broadest domain in either allowlist — GitHub raw content is a generic exfil/supply-chain vector, and squid does no `ssl_bump` here so it cannot scope the CONNECT to a path, only the exact host (`raw.githubusercontent.com`, no wildcard). Verified: without this domain, WhatsApp reconnects loop every 2–5s and fail identically to the original login failure (tested by locking egress down and restarting the gateway). Recommendation: revisit if `@openclaw/whatsapp` ever exposes a pinned-version config option, which would remove the need for this domain entirely. |
| R13 | Installed `whatsapp` plugin loads with no install/load-path provenance (gateway logs it explicitly: "treat as untracked local code") — it was fetched via the npm fallback (`@openclaw/whatsapp`) because ClawHub (`clawhub.ai`) is not in the egress allowlist and its own fetch was denied during install | **Low** | Plugin installs only happen inside operator-run, agent-stopped `egress-setup`/`egress-lockdown` windows (same control as R4/R7 in the escape-path matrix, row 7); the npm package name/scope matches the official plugin. Did not add `plugins.allow` to pin trust — that key is a global allowlist, not an "also trust this one," and setting it to `["whatsapp"]` silently dropped all 8 bundled plugins (browser, canvas, device-pair, file-transfer, memory-core, ollama, phone-control, talk-voice) on restart. Left unset; revisit if OpenClaw adds a way to pin trust for one plugin without excluding bundled ones. |
| R14 | `mcp-colibri`'s `/health` endpoint published to `127.0.0.1:8090` (2026-08-24) — a second loopback-only port alongside the frontend's gateway publish, so host-side `jobscrape` can check `jobs_running` before firing its own colibri calls | **Info** | GET-only, no auth, returns only a job counter/model id/timeout — no prompt content, no job results, no control surface (`ask_colibri`/`check_colibri` are not exposed here, stay MCP-SSE-only on the internal network). Same reachability tier as R7 (any local Windows process can reach it); accepted for the same reason — same trust domain as the desktop. |
| R15 | **[REJECTED, 2026-08-24]** A Meta WhatsApp Business Cloud API migration (dedicated bot number, custom channel plugin, Tailscale Funnel webhook ingress) was scoped and partially built, then abandoned before any credential was issued: the fresh Business Portfolio required for it was hit with an automatic Meta anti-abuse restriction ("prohibited from advertising, including claiming apps") the same day it was created, with no clean same-day appeal path. All Meta-specific prep (`graph.facebook.com` egress entry, `META_*` env placeholders, Funnel webhook plan) was removed rather than left dormant. WhatsApp channel above (R9–R13) is unaffected — it was never touched by this attempt. | **N/A** | If Meta Cloud API is revisited later, treat the account restriction as the actual blocker to resolve first (Meta's "Request review" flow), not a config problem — no amount of correct wiring bypasses it. |
| R16 | Telegram channel LIVE as a second, additional channel (linked 2026-08-24, bot `@billyclaw3_bot`) — `TELEGRAM_BOT_TOKEN` is a new persistent credential, same class as R11's WhatsApp session but for a dedicated bot account from day one, not the operator's personal identity | **Low** | Scoped to whatever the bot can do via the Telegram Bot API — no access to the operator's personal Telegram account or contacts. Revocable any time via @BotFather (`/revoke`). Lives in `.env` only (gitignored), same as every other secret in this deployment; not written into `openclaw.json` either (plugin reads it from the env var directly). Transport is long polling (outbound-only, gateway pulls from `api.telegram.org`) — unlike the rejected Meta plan (R15), this introduces **no inbound surface at all**, on the sandbox or the host; no Tailscale Funnel mapping needed. |
| R17 | Telegram DM content is untrusted input, same class as R9 for WhatsApp, and Telegram widens the exfil surface the same way R10 describes (a compromised agent can address arbitrary Telegram chat IDs, not just the allowlisted operator) | **Low** | Same mitigation shape as R9/R10: exec/process stay denied, fs stays workspace-only, egress stays allowlisted (`api.telegram.org` only) — blast radius of a successful injection is "send more Telegram messages," not host/filesystem/exfil-elsewhere. Config mirrors WhatsApp: `dmPolicy: allowlist` with single numeric `allowFrom` (the operator's Telegram user ID, not `@username` — the latter is rejected by config validation), `groupPolicy: disabled`. Verified live: a real message round-tripped through the allowlisted user and got a reply via the z.ai→ollama-local fallback chain. |
| R18 | `api.telegram.org` added to the egress allowlist (2026-08-24) — live and in active use | **Info** | Exact host, no wildcard — the only destination the Bot API needs (long polling and outbound sends both go through it). No `raw.githubusercontent.com`-style secondary-fetch gotcha found (unlike R12's Baileys surprise) — confirmed via live use, single endpoint only. Operational gotcha (not a security finding): squid caches the extra-domains file at startup and does not watch it for changes — adding a new domain to a *running* egress container needs `docker compose exec egress squid -k reconfigure`, or the channel fails with a 403 on the CONNECT tunnel despite the domain being correctly listed. |

## 5. Known issues (post-launch)

- **`security audit --deep` probe reports `missing scope: operator.read`** — OpenClaw 2026.7.1 quirk: token-authenticated WS sessions aren't granted operator scopes for the audit's self-describe probe. Tried and exhausted: env-ref token, literal token (+restart), `gateway.remote.token` client credential, explicit `--token` flag. **Auth itself is proven enforced**: a wrong token yields `unauthorized: gateway token mismatch`. Cosmetic for this deployment (containment unaffected); re-test after image upgrades. Static audit remains **0 critical**.
- Non-z.ai pricing-metadata fetches (LiteLLM/OpenRouter) fail at boot — the egress allowlist working as intended; they show as `TCP_DENIED` in the egress log (expected noise, useful as a heartbeat that logging works).

## 6. Go-live checklist (completed 2026-08-22)

```bash
cd C:\claw-code-local\openclaw-sandbox
bash verify-sandbox.sh              # expect 10/10 (re-runs with egress down: T2/T3/T10 need `bash setup.sh egress` first)
docker compose up -d                # start egress + gateway
curl http://127.0.0.1:18789/healthz # go-live check #3 (R6)
# Control UI: http://127.0.0.1:18789/  → paste OPENCLAW_GATEWAY_TOKEN from .env
docker compose logs -f egress       # watch for TCP_DENIED lines = injection/exfil attempts
```

Nuke-and-reset (wipes all agent state, keeps nothing): `docker compose down -v && rm .env`

## 7. Appendix — tool profiles

**Active profile (applied at launch): `strict-config.json`** — the "paranoid" profile from §6 is what's live: `exec` and `process` tools denied outright, `tools.exec.security: "deny"`, plus all baseline denials. The agent can read/write its workspace and answer via the model API, nothing else.

Relax to the standard profile (exec allowed inside the container) with:

```bash
bash setup.sh config   # re-applies hardened-config.json
docker compose restart openclaw-gateway
```

**Standard profile: `hardened-config.json`** (exec permitted, still confined to the sealed container + egress allowlist):

```json
{
  "tools": {
    "deny": ["gateway", "cron", "nodes", "sessions_spawn", "sessions_send", "browser", "web_search", "web_fetch", "exec", "process"],
    "fs": { "workspaceOnly": true, "read": { "workspaceOnly": true } },
    "exec": { "security": "deny", "ask": "always" },
    "elevated": { "enabled": false }
  }
}
```

## 8. Files

| Path | Purpose |
|---|---|
| `docker-compose.yml` | Hardened topology: egress + gateway + frontend (this design) |
| `egress/` | Squid allowlist proxy (Dockerfile + squid.conf + extra-domains.txt toggle) |
| `frontend/` | socat loopback forwarder (R6 fallback; inbound-only relay) |
| `hardened-config.json` | Standard tool/gateway policy overlay |
| `strict-config.json` | Strict profile — **active** (exec/process denied) |
| `scripts/merge-config.js` | Deterministic deep-merge into the config volume |
| `mcp-jobscrape/` | MCP tool server: agent-driven jobscrape configuration. Hardened like mcp-salary (read-only rootfs, cap_drop ALL, no-new-privileges, no host mounts); reaches only `host.docker.internal:8790` through the squid proxy |
| `jobscrape/config-server.mjs` | Host-side config/status service (:8790). Binds 0.0.0.0 — required for Docker's host-gateway route (same exposure class as colibri :8000) — but unlike colibri every route except `GET /health` is token-gated (constant-time compare, fail-closed without a token). Writes go through config.mjs validation → pre-write snapshot → atomic replace of exactly `configs/base.json` / `configs/production.json` |
| `jobscrape/register-config-server.ps1` | At-logon Scheduled Task for config-server.mjs (register-task.ps1 pattern) |
| `setup.sh` | Staged lifecycle: `env · pull · egress · egress-setup · egress-lockdown · onboard · config · audit · verify` |
| `verify-sandbox.sh` | The 10 escape-path tests (§3 evidence column) |
| `.env` | Secrets — gateway token + ZAI_API_KEY (gitignored, chmod 600) |
| Volumes | `openclaw-config` / `openclaw-workspace` / `openclaw-auth` (named volumes — the only writable state) |

**Secrets inventory:** `ZAI_API_KEY` (dedicated GLM Coding Plan key), `OPENCLAW_GATEWAY_TOKEN`
(64-hex, generated), and `JOBSCRAPE_CONFIG_TOKEN` (64-hex, generated — config-write power for
the host config-server, held by the gateway env + mcp-jobscrape container env) live in `.env`
on the host and in container env. The gateway token is
referenced by env in `openclaw.json` (never written into the config file). No other
credentials exist anywhere in the boundary.
