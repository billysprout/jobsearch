# OpenClaw — hardened sandbox instance

Fully-contained OpenClaw deployment: the gateway container IS the agent sandbox.
Read `SECURITY-REVIEW.md` for the full adversarial threat model, verification
results, and residual-risk register.

**Status: LIVE** (since 2026-08-22) — strict profile active (no exec/process tools
inside the sandbox), dedicated z.ai coding-plan key, WhatsApp + Telegram channels
both linked, local model fallback chain (colibri + Gemma 4 via Ollama) wired in for
when z.ai is quota-exhausted (current z.ai key: exhausted, resets 2026-08-29 — the
fallback chain is what's actually serving traffic right now, confirmed delivering
on both channels).

## Start / stop

```bash
cd C:\claw-code-local\openclaw-sandbox
docker compose up -d                       # egress + frontend + gateway
curl http://127.0.0.1:18789/healthz        # expect {"ok":true,...}
docker compose stop                        # shut down (state persists in named volumes)
docker compose down -v                     # WIPE all state — config, sessions, workspace
```

Control UI: **http://127.0.0.1:18789/** → paste `OPENCLAW_GATEWAY_TOKEN` from `.env`.

## Everyday operations

```bash
docker compose logs -f egress   # every denied outbound connection (exfil/injection attempts)
docker compose run --rm cli status                        # operator CLI (shares gateway netns)
docker compose run --rm cli security audit                # static audit (0 critical)
bash verify-sandbox.sh                                    # 10 escape-path tests
```

Known quirk: `security audit --deep` reports `missing scope: operator.read` — token auth
itself is enforced (wrong token → `unauthorized`); see SECURITY-REVIEW.md §5.

## Changing things

- **Tool profile**: strict (active, `strict-config.json`) ↔ standard (`hardened-config.json`, exec allowed inside the container): `bash setup.sh config && docker compose restart openclaw-gateway` after editing which file setup.sh merges, or pipe the JSON per §7 of the security review.
- **Swap the z.ai key**: edit `ZAI_API_KEY` in `.env`, then `docker compose up -d --force-recreate openclaw-gateway`.
- **Add a messaging channel later**: run `bash setup.sh egress-setup` first if it needs outbound registration, configure the channel via the CLI, and keep `dmPolicy: pairing` + `requireMention: true`. Revisit SECURITY-REVIEW.md §3 row 15 — channels reintroduce the untrusted-input leg.
- **Upgrade the image**: `bash setup.sh pull` (re-pins the digest) then `docker compose up -d`.
- **Install/upgrade a plugin** (operator-only, agent must be stopped):
  `docker compose stop openclaw-gateway && bash setup.sh egress-setup && docker compose run --rm cli plugins install <pkg>@<exact-version> && bash setup.sh egress-lockdown && docker compose up -d`.
- **Apply config changes directly** (bypass the merge-script bug below): `docker compose run -T --rm --no-deps --entrypoint node openclaw-gateway -e "..."` reading/writing `/home/node/.openclaw/openclaw.json`. This is how every config change in this doc was actually applied.

## WhatsApp channel

**Status: LIVE** (linked 2026-08-23). Single-operator DM allowlist + daily job digest via cron.
Full threat-model notes: SECURITY-REVIEW.md §3 row 15, §4 R9–R13.

```bash
docker compose run --rm cli channels status --probe          # linked/connected/health check
docker compose run --rm cli channels login --channel whatsapp   # (re-)pair via QR — run interactively, scan fast
docker compose run --rm cli channels logout --channel whatsapp  # unlink (revoke from this side)
docker compose run --rm cli cron list                        # see the job-digest / colibri-followup schedules
docker compose run --rm cli cron run <job-id>                # fire a cron job manually (debug)
```

**How it was set up**: channel `@openclaw/whatsapp`, installed via npm fallback (ClawHub
fetch was denied — `clawhub.ai` isn't in the egress allowlist, not investigated further).
Config: `channels.whatsapp` in `openclaw.json` — `dmPolicy: allowlist`, single-number
`allowFrom`, `groupPolicy: disabled`, read receipts/calls/reactions/pluginHooks all off.
Linked via QR (`cli channels login --channel whatsapp`).

Creds persist at `~/.openclaw/credentials/whatsapp/` inside the `openclaw-config` volume —
survives restarts, wiped only by `docker compose down -v`. You can also unlink from the
phone side: WhatsApp → Linked Devices → remove this device.

**Egress**: `.whatsapp.net` + `.whatsapp.com` are permanent allowlist entries, plus the
exact host `raw.githubusercontent.com`. That last one is a real gotcha: Baileys (the
WhatsApp transport) calls `fetchLatestBaileysVersion()` — a fetch to
`raw.githubusercontent.com` — on *every* connect, not just first login. It's wrapped in a
try/catch that falls back to a bundled version on failure, so it never throws, but
WhatsApp's servers reject that stale fallback version outright, and the gateway then loops
reconnecting every 2–5s. Wasn't anticipated in the original plan (only `.whatsapp.net`/
`.whatsapp.com` were scoped). Verified by locking egress back down and restarting: the
reconnect loop resumed immediately, confirming causation. Full writeup: SECURITY-REVIEW.md
§4 R12.

**Plugin trust note**: the installed `whatsapp` plugin loads with no install/load-path
provenance (gateway logs it explicitly). Do **not** "fix" this with `plugins.allow` — that
key is a global allowlist, not an "also trust this one," and setting it to `["whatsapp"]`
silently drops all 8 bundled plugins (browser, canvas, device-pair, file-transfer,
memory-core, ollama, phone-control, talk-voice) on restart. Left unset; see
SECURITY-REVIEW.md §4 R13.

**2026-08-24: a Meta WhatsApp Business Cloud API migration was scoped and started (dedicated
bot number, custom channel plugin, Tailscale Funnel ingress) then abandoned before any
credential existed — the fresh Business Portfolio got an automatic Meta anti-abuse
restriction the same day it was created, blocking app-claiming entirely. WhatsApp above is
staying exactly as it is; see "Telegram channel" below for the replacement plan instead.**

## Telegram channel

**Status: LIVE** (linked 2026-08-24). Second channel, added alongside WhatsApp — WhatsApp
above stays linked and untouched. Telegram was picked after the Meta Cloud API route (see
note above) hit a same-day account restriction with no clean appeal path. Unlike Meta,
OpenClaw has a **native, bundled Telegram channel plugin** — no custom plugin code
needed — and the bot token came from @BotFather in about a minute, no business
verification.

**No ingress needed**: this channel runs OpenClaw's default **long polling** transport
(grammY runner) — no public URL, no webhook, no Tailscale Funnel mapping, nothing inbound
at all. The gateway reaches out to `api.telegram.org` and pulls messages, same outbound-only
shape as the WhatsApp/Baileys leg.

```bash
docker compose run --rm cli channels status --probe            # linked/connected/health check
docker compose run --rm cli gateway call channels.start --params '{"channel":"telegram"}'
  # manual (re-)start — see the gotcha below for why this is sometimes needed
```

**How it was set up**: bot created via @BotFather (`/newbot`), bot username
`@billyclaw3_bot`. Token stored as `TELEGRAM_BOT_TOKEN` in `.env` — picked up automatically
by the plugin (no `botToken` needed in `openclaw.json`, the docs confirm the env var is
honored for the default account). Config: `channels.telegram` in `openclaw.json` —
`dmPolicy: allowlist`, single numeric `allowFrom` (the operator's Telegram user ID, found
via `curl https://api.telegram.org/bot<token>/getUpdates` after sending the bot one
message — `@username` is *not* accepted, only the numeric ID), `groupPolicy: disabled`.
Note: unlike the WhatsApp config, `pluginHooks` is **not** a valid field on
`channels.telegram` — including it fails config validation outright (`invalid config: must
not have additional properties: "pluginHooks"`), it's WhatsApp-schema-specific.

**Egress gotcha**: `api.telegram.org` was added to `egress/extra-domains.txt`, but editing
that file alone isn't enough — squid caches the ACL file contents at startup and doesn't
watch it for changes. A running egress container needs an explicit reload:
```bash
docker compose exec egress squid -k reconfigure
```
Without this, the channel reports `probe failed, error:fetch failed | Proxy response (403)
!== 200 when HTTP Tunneling` even though the domain is correctly listed in the file.

**Restart-loop breaker gotcha**: iterating on the config above (each fix required
`docker compose up -d --force-recreate openclaw-gateway`) tripped OpenClaw's own
restart-loop breaker ("6 unclean boot(s) within 300000ms") — which then suppressed
autostart for **every** channel, including WhatsApp, not just the one being configured.
Gateway itself was fine (`Gateway reachable`); this only blocks channel autostart. Fixed
per-channel without a further restart:
```bash
docker compose run --rm cli gateway call channels.start --params '{"channel":"whatsapp"}'
docker compose run --rm cli gateway call channels.start --params '{"channel":"telegram"}'
```
Windows/PowerShell note: the `--params '{"channel":"..."}'` JSON argument gets mangled by
PowerShell's quoting before it reaches Docker (`SyntaxError: Expected property name or '}'
in JSON`) — this one needs the Bash tool/Git Bash, not PowerShell.

**Egress**: `api.telegram.org` is a permanent allowlist entry — see SECURITY-REVIEW.md
§4 R16–R18 for the residual-risk writeup.

## Job search pipeline (`jobscrape/`)

Headless scrape pipeline that runs **outside** the sandbox (Windows host, plain Node,
no Docker) — deliberately, so the untrusted-input leg (`web_fetch`/`browser`) never has to
reopen inside the sandbox. Writes results into the sandbox's workspace volume via a
tar-pipe through a one-off alpine container. See `jobscrape/README.md` for full operator
docs; summary here.

**Sources**: RemoteOK, Remotive, HN "Who is Hiring", Greenhouse ATS (Riot Games, Epic
Games, Roblox, Discord, Bungie), Workable ATS (Cloud9 — the real esports Cloud9,
added 2026-08-24 once the correct ATS was confirmed, see gotcha below), Ashby ATS
(Ramp, Vanta). Disabled: WWR (Cloudflare 403), Lever (v0 API deprecated).

**Cover-letter drafts** (`--drafts`, added 2026-08-24): opt-in, drafts cover letters
for the top N ranked postings via colibri using `jobscrape/profile.md` (gitignored —
copy `profile.example.md`). Never submits anything; writes
`postings/<id>-draft.md` for a human to read and send. Off by default — see
`jobscrape/README.md`.

**Colibri coordination** (added 2026-08-24): `mcp-colibri`'s `/health` is now
published to `127.0.0.1:8090` (loopback only, GET-only, no auth — see
SECURITY-REVIEW.md §4 R14) so the host-side scrape can check `jobs_running`
before firing its own colibri calls and back off briefly if an in-conversation
`ask_colibri` job is mid-flight. Best-effort, fails open.

**Not built — a "task tracker tangent":** turning `seen.json`/the digest into a
full application-status tracker (applied/interviewing/rejected, follow-up
reminders) was considered and deliberately deferred — that's a different kind of
tool than "finds and ranks postings," and deserves its own scoped design rather
than growing out of dedupe state as a side effect. See `jobscrape/README.md`.

**Pipeline**: fetch all sources → word-boundary keyword pre-filter (3 tracks: esports,
IT/DevOps, producer-PM) → drop already-seen postings → sort so curated ATS sources
(Greenhouse) outrank generic boards before applying `--limit` → rank via colibri (or
heuristic fallback) → mark only the ranked set as seen → merge into today's accumulated
digest → write.

**Debug snapshots** — every run (including `--dry-run`) overwrites two inspection files
so "why didn't X show up" can be answered by reading a file instead of writing a
throwaway script:
- `jobscrape/state/last-run-matched.json` — everything that matched a track keyword this
  run, **before** the seen-filter (includes postings already surfaced in an earlier run).
  Each entry carries `matchedTrack`/`matchedKeyword` so you can see *why* it matched.
- `jobscrape/state/last-run-eligible.json` — the subset of the above that was **not**
  already seen — the actual pool `--limit`/source-priority sorting drew candidates from.
  If a posting is in `matched` but not `eligible`, it was filtered out here as
  already-seen; if it's not in `matched` at all, it never passed the keyword filter.

Both are gitignored (`jobscrape/state/`) — runtime output, not source.

**Scheduling**: Windows Task Scheduler, task `OpenClaw-JobScrape`, daily 07:00,
`--limit 10` (see colibri throughput note below for why the cap is that low —
`jobscrape/register-task.ps1` registers it).

**Bugs found and fixed in this pipeline (2026-08-24), all from tracing one digest that
only ever surfaced one low-quality posting:**
- **Substring keyword matching.** `"aws"` matched inside `"laws"`, `"draws"`,
  `"withdraws"` — turned random retail/admin postings into false "it-devops" hits. Fixed
  with word-boundary matching (`keywords.mjs`, shared by `scrape.mjs` and `colibri.mjs`'s
  heuristic fallback).
- **Company names as keywords.** `"riot games"`, `"epic games"`, `"valve"`, `"blizzard"`,
  `"esl"` were literal keywords — since Greenhouse postings include the company name in
  the matched text, *every single posting* at Riot/Epic auto-matched "esports" regardless
  of role (legal counsel, treasury analyst, litigation paralegal all "matched"). Removed;
  kept role-specific terms (`valorant`, `fortnite`, `tournament`, etc.) which still catch
  genuinely relevant postings without the company-identity shortcut. Also removed
  `"team manager"`/`"team ops"`/`"roster"`/`"on-call"` — too generic, matched retail store
  manager postings.
- **Wrong Cloud9.** `ats.greenhouse.cloud9` was hitting an unrelated company's Greenhouse
  board (Wellness Advisor / Retail Store Supervisor postings) — the real Cloud9 esports
  org uses **Workable**, not Greenhouse, so there's no correct Greenhouse slug to
  substitute. Removed from the tracked list rather than guessing wrong.
- **Dedupe-before-filter ordering.** The original pipeline marked *every fetched*
  posting as "seen" before checking if it matched any track — so a posting that never had
  a real chance was burned from consideration forever. Reordered: filter first, dedupe
  only the matches.
- **`--limit` applied in fetch order.** Sources are fetched remoteok → remotive → hn →
  greenhouse; capping the *raw fetch order* meant noisy high-volume sources (remoteok, hn)
  consumed the entire cap before the curated Greenhouse companies were ever reached — so
  no genuinely relevant posting ever survived to the ranking stage. Fixed by sorting
  matched-and-unseen candidates by source priority (curated ATS first) before capping.
- **Same-day digest overwrite.** Two runs on the same day used the same output filename
  and silently clobbered each other — a richer first run's results replaced by a thinner
  second run's, with no warning. Fixed: today's rankings now accumulate in
  `state/digest-<date>.json` and merge across same-day runs instead of overwriting.
- **`--dry-run` wasn't actually dry.** State mutation (`seen.json` writes) happened
  unconditionally before the dry-run check, so even a "just checking" run permanently
  burned postings from future consideration. Fixed: dry-run is now fully side-effect-free.
- **State was fully poisoned** by the above bugs — `seen.json` had accumulated every
  postable the buggy pipeline ever touched, matched or not. Reset (backed up first) for a
  clean start once the fixes landed.

Net effect of the fixes: a test run went from "1 result, a retail job in Chicago" to "10
candidates, all genuinely relevant Riot Games roles" with the same source data.

**Colibri ranking throughput is the real constraint on `--limit`.** Colibri scores one
posting at a time (`chunkSize: 1`) and each call can take 1–10+ minutes depending on
prompt size (see colibri section below) — `--limit 40` (the script's own default) would
run for hours. `--limit 10` is a deliberate tradeoff baked into the registered task, not a
forgotten default.

## Local models

Two local models are wired in, for different reasons — colibri as a private/no-quota
option the agent can explicitly reach for, Gemma 4 as an automatic fallback when z.ai is
unavailable. Both run on the **Windows host**, reached from inside the sandbox exclusively
via `host.docker.internal` through the squid egress proxy — no new egress surface either
way, since that ACL already existed.

```
gateway/mcp-colibri (internal network only, extra_hosts: host.docker.internal:host-gateway)
  → squid (internal + egress networks, plain-HTTP ACL for host.docker.internal)
    → host.docker.internal:<port>
      → colibri (:8000) or Ollama (:11434) on the Windows host
```

### Colibri (GLM-5.2, 744B MoE, via `ask_colibri`)

Colibrì (`C:\c\colibri`, binary at `c/coli`) is **not a general model server** — it's a
bespoke C engine hand-written for GLM-5.2's exact architecture (MLA attention,
DeepSeek-style router, DSA sparse attention, a specific 78-layer MTP head; the only other
architecture it supports is OLMoE). It streams a 744B-parameter MoE model through ~25GB of
RAM by keeping the dense part resident and loading routed experts from disk on demand.
This is why it's slow, and why that's a deliberate tradeoff, not a bug.

**Launch**: `python coli serve --model D:\glm52_i4` (or wherever the converted int4
checkpoint lives), serves OpenAI-compatible API at `http://localhost:8000/v1`.

**Access from the agent**: a dedicated MCP tool server, `mcp-colibri/`, exposes
`ask_colibri` (fire) and `check_colibri` (poll) as MCP tools — see "The ask_colibri tool"
below for why it's fire-and-poll rather than a normal synchronous call, and for the whole
saga of getting a genuinely long-running local-model call to survive contact with an
HTTP stack built for fast cloud APIs.

**Model ID must match exactly.** OpenClaw's provider model ID must match what colibri
advertises at `/v1/models` byte-for-byte: `{"id":"glm-5.2-colibri"}` — not `glm-52` or any
other variant, or you get a silent "model not found."

**Squid needs a plain-HTTP ACL.** Colibri serves plain HTTP (no TLS), but squid's default
config only allows CONNECT tunnels. Added:
```
acl host_local dstdomain host.docker.internal
http_access allow host_local
```
This allows both plain HTTP and CONNECT to `host.docker.internal` — the one destination
outside the normal allowlisted-HTTPS-domains model.

**Prefill is expensive, decode is comparatively cheap.** A 4,092-token prompt (OpenClaw's
own system prompt size) takes ~30–60s just for prefill — 78 layers, each needing its
routed experts loaded from disk. Prefill trace looks like:
```
[prefill] layer 1/78 · 919 token
[prefill] layer 5/78 · 919 token
...
[prefill] layer 78/78 · 919 token
```
Then — with the code as originally deployed — **silence** until the whole response was
ready (see "The ask_colibri tool" for why, and the fix).

**KV-cache persistence makes retries nearly free.** Colibri persists its KV cache to disk
(`.coli_kv`) and matches request prefixes against it. Re-sending the *exact same prompt*
after a failed attempt gets a full cache hit — `prefix 922/922 token, prefill 0` — skipping
the entire expensive prefill phase. This made debugging the streaming/timeout issues below
far cheaper than it would otherwise have been: each retry only needed to pay for decode.

**`COLI_DEBUG` env var gives operator-side decode visibility** (discovered reading
`openai_server.py`, not something added — it already existed): `COLI_DEBUG=1` tees the
decoded output stream to colibri's own terminal stderr as tokens are generated (not just
prefill progress); `COLI_DEBUG=2` also tees the full rendered prompt colibri actually saw.
Set for one launch, doesn't persist: `$env:COLI_DEBUG = "1"` in the same PowerShell
session before `python coli serve ...`.

**Latency, measured on this deployment** (small sample — take as a feel for the shape, not
a guarantee): a tiny prompt (~11–16 tokens in) took ~6s warm-cache vs. ~68s cold-ish — an
~11x swing on essentially the same prompt size, meaning cache state (which experts are
already pinned/warm) matters more than prompt size at this scale. Colibri's own docs give
bands for larger prompts: 200–500 tokens in → 5–10 min, >500 tokens → 10+ min ("may exceed
15-min timeout — avoid"). Extrapolating with colibri's documented **superlinear** scaling
(a power-law fit to those bands gives exponent ≈1.31 — noticeably worse than linear, nowhere
near exponential) to a full ~4K-token coding-agent-style system prompt: roughly **2.6–7
hours**. Colibri cannot practically serve a full agentic coding system prompt — this is
exactly why `ask_colibri`'s tool description tells the calling model to keep prompts short.

### Gemma 4 E2B via Ollama (automatic z.ai fallback)

**Status**: LIVE 2026-08-23, triggered by the z.ai coding-plan key hitting its weekly
quota — `agents.defaults.model.fallbacks` needed something that actually works, not just
another z.ai tier (that was the failure mode: two z.ai tiers in the fallback chain,
neither reachable, no working fallback at all).

Colibri was considered and rejected for this role — wrong tool twice over: it can't load
Gemma 4 at all (architecture-locked), and even if it could, it's built to make a 744B
model bearable, not to be fast — the opposite of what an automatic fallback needs.

**Setup**: Ollama (already installed) running natively on the Windows host, port 11434.
Model `gemma4:e2b` pulled via `ollama pull gemma4:e2b` (7.2GB on disk). ~1.8GB VRAM when
loaded on an RTX 2080 (8GB) — auto-unloads after 5 min idle, so it doesn't permanently
compete with anything else using that GPU (which this machine's desktop/gaming use also
does — free VRAM fluctuates 1–5GB depending on what else is running; the model itself
fits easily either way).

**Context-size gotcha**: OpenClaw's generic `openai-completions` provider transport does
not forward `num_ctx` to Ollama's OpenAI-compatible endpoint — context size is fixed at
model-load time, and Ollama silently kept using its default (16384) regardless of
`contextWindow` in `openclaw.json`. Setting `OLLAMA_CONTEXT_LENGTH` as a user env var
didn't reliably propagate either (the Ollama tray app spawns its server child with its own
environment, not inheriting a shell's exported var). Fix: baked the context size into a
derived Modelfile instead of relying on any runtime override —
```
ollama create gemma4-e2b-32k -f Modelfile   # Modelfile: FROM gemma4:e2b + PARAMETER num_ctx 32768
```
Deterministic regardless of transport. Config: `models.providers.ollama-local` →
`http://host.docker.internal:11434/v1`, model id `gemma4-e2b-32k`, `contextWindow: 32768`,
`maxTokens: 2048`. Fallback chain: `["zai/glm-5-turbo", "ollama-local/gemma4-e2b-32k"]`
(primary stays `zai/glm-5.2`, untouched).

**The 32768 context config was itself not enough** — see "The real context-overflow bug"
below. That was a completely separate, global setting that ate most of the budget I'd just
raised.

**Update 2026-08-24: bumped to 65536.** Even after the `reserveTokensFloor` fix below, the
effective reserve for this model was still clamped to 16,384 (see that section's update) —
leaving only ~16K tokens of real prompt headroom on the 32K window, and an ordinary WhatsApp
thread overflowed it again (16,929 estimated tokens vs. a 16,384 budget — a 545-token miss,
compaction already at its floor with nothing left to cut). VRAM headroom was never the
constraint (only ~1.8GB of 8GB used at 32K context), so raised the actual window instead of
continuing to fight the reserve math: new tag `gemma4-e2b-64k` (`ollama create gemma4-e2b-64k
-f Modelfile` — same `FROM gemma4:e2b`, `PARAMETER num_ctx 65536`), `contextWindow: 65536` in
`openclaw.json`, fallback chain and alias updated to match, old `gemma4-e2b-32k` entries
removed rather than left stale. Confirmed via `ollama ps`: loads 100% on GPU at the new
context size, same ~1.8GB. Gateway picked up the config change via its existing hot-reload —
no restart needed.

## The real context-overflow bug: `reserveTokensFloor`

A live WhatsApp session hit `Context overflow: prompt too large for the model (precheck)`
on gemma4-e2b-32k *despite* the context window genuinely being 32768. Root cause, found by
reading OpenClaw's own compiled source: `agents.defaults.compaction.reserveTokensFloor`
defaults to **20,000 tokens**, globally, regardless of the model's actual context window.
For z.ai's huge-context cloud models that's negligible. For gemma4's 32,768-token window,
it consumed 61% of the *entire context* before the conversation even started — the real
input budget was 12,768 tokens, not the ~30,720 the `contextWindow`/`maxTokens` config
implied. A session with 15,224 estimated prompt tokens overflowed that shrunken budget,
failed to auto-compact twice, and errored out. This is a global setting — not model or
provider specific — and was silently starving the local fallback the whole time.

**Fix**: `agents.defaults.compaction.reserveTokensFloor: 4096` in `openclaw.json`.
Verified by re-running the exact session that failed (`cli agent --session-id <id>
--message ... --deliver`) — succeeded, `"route": "fits"`, delivered to WhatsApp. (The
effective reserve landed at 16,384 rather than exactly 4,096 — there's a second,
ratio-based reserve heuristic elsewhere that clamps it, roughly half the context window;
not chased further since the practical outcome — no more overflow — was already
confirmed.)

**Update 2026-08-24: found that second heuristic.** Read straight from OpenClaw's compiled
source (`attempt-tool-run-context.js` / `agent-compaction-constants.js`):
`MIN_PROMPT_BUDGET_TOKENS = 8000` and `MIN_PROMPT_BUDGET_RATIO = 0.5`, combined as
`minPromptBudget = min(MIN_PROMPT_BUDGET_TOKENS, contextWindow * MIN_PROMPT_BUDGET_RATIO)`,
then `effectiveReserveTokens = min(requestedReserveTokens, contextWindow - minPromptBudget)`.
This is a hardcoded platform floor, not exposed in `openclaw.json` — no matter how low
`reserveTokensFloor` is set, the effective reserve can't push prompt budget above roughly
50% of the context window (subject to the 8,000-token absolute floor once the window gets
large enough). It's also worth noting explicitly: OpenClaw's own generic
auto-compaction-failure message suggests raising `reserveTokensFloor` to 20,000+ regardless
of which model is active — that's fine advice for z.ai's huge-context cloud models, but
would be a direct regression back to the exact bug above if followed while the local
gemma4 fallback is the active model. This mechanism is also *why* raising gemma4's actual
context window (see the update above) was the real fix once the floor alone stopped
helping — it changes what 50% actually means, rather than continuing to fight a hardcoded
platform clamp on the reserve side.

## The `ask_colibri` tool: from synchronous, to fire-and-poll, to actually reliable

This tool went through three real bugs before it was solid. Worth the full story since
each one would silently recur if "fixed" only halfway.

**Bug 1 — synchronous calls collide with OpenClaw's session lock.** The original
`ask_colibri` blocked the calling turn for the whole colibri wait (minutes). OpenClaw
takes a per-session "prompt lock" while a turn runs but *releases it during long waits*
(so the gateway doesn't hang on inbound messages) — if a second message got processed
against the same session while the lock was released, the original slow turn would later
find the session file had changed underneath it and discard its own result entirely
(`EmbeddedAttemptSessionTakeoverError`). **Fix**: redesigned as fire-and-poll —
`ask_colibri` returns a `job_id` in milliseconds; `check_colibri` polls it separately. A
module-level job Map (not tied to any one MCP connection) tracks state so it survives
reconnects.

**Bug 2 — fire-and-poll alone doesn't push results back.** If the agent's turn ends with
"I'll check back" and nothing ever prompts it to actually check, the result just sits
`done` in the job store forever. **Fix**: a plain-shell `colibri-followup.mjs` script
(not an LLM turn — deliberately, so it can stay silent when nothing's pending instead of
having some cron "announce" mechanism deliver a "nothing to report" message every cycle),
run by a `--command`-payload cron job (`colibri-followup`, every 10 min, `delivery.mode:
none` set explicitly since cron auto-sets `announce` by default even for command
payloads). It checks `mcp-colibri`'s `/pending` endpoint (done-but-undelivered jobs) and
delivers via `node dist/index.js message send --channel whatsapp ...` directly from
inside the gateway container, which already has the gateway token as an env var — no new
credential surface. Deliberately does **not** mark a job delivered just because
`check_colibri` read it in-turn (the agent seeing a result doesn't guarantee it survives
to reach the user, per bug 1) — only a confirmed WhatsApp send acks a job. Worst case on
the happy path: a mild duplicate message, which beats a silently lost result.

**Bug 3 — `stream: false` silently starves the connection.** Even after the fire-and-poll
rewrite, real jobs kept failing with `Colibri request failed: fetch failed`, and colibri's
own terminal showed `ConnectionResetError: forcibly closed by the remote host` right after
a full prefill completed. Cause: `ask_colibri` requested `stream: false`, so colibri
buffers the *entire* response and sends nothing — no headers, nothing — until generation
fully finishes. Node's `undici` HTTP client has a default 5-minute headers-timeout; any
prompt colibri's own docs already flag as needing "10+ minutes" (>500 tokens) blows past
that every time. Compounding it: colibri's own server has a background keepalive thread
that pings the connection every ~10s of silence specifically to survive exactly this kind
of slow generation — but that code path only activates for `stream: true` requests, so
`stream: false` skipped colibri's own protection too. **Fix**: switched to `stream: true`
and incremental SSE parsing (the pattern `jobscrape/colibri.mjs` already used correctly —
this was a gap the fire-and-poll rewrite didn't close, not a new mistake). Confirmed via
colibri's own log: `"POST /v1/chat/completions HTTP/1.1" 200 -` now appears *immediately*,
before generation finishes, proving headers arrive right away.

**A fourth failure that turned out to be correct behavior, not a bug**: after the
streaming fix, a job still failed with `Colibri timed out after 900s` — but this was
`mcp-colibri`'s *own* `COLIBRI_TIMEOUT_MS` (15 min) firing exactly as designed, on a
prompt colibri's docs already predicted would take "10+ minutes" per its size. Not a
regression — the client-side timeout doing its job on a genuinely long request. Raised to
45 min (`COLIBRI_TIMEOUT_MS: 2700000`), staying under squid's `client_lifetime` (see
timeouts section below) with margin.

**Live progress, not just alive/dead.** Since the SSE parsing is incremental, the job
object now tracks `partialContent`/`chunkCount`/`lastChunkAt` as chunks arrive, not just
the final result. `check_colibri`'s "still running" response reports real progress
("N chars generated so far, last chunk Ys ago") instead of just elapsed time — "still in
prefill" (no output tokens yet) is now distinguishable from "decode has started."
**Same data also fixes partial-loss-on-disconnect**: if a connection dies mid-stream (a
timeout, a network blip, squid's hard cap), whatever had already streamed is preserved
and surfaced — `/pending` now also includes errored jobs that captured partial output,
clearly labeled `PARTIAL`, so the follow-up cron delivers "here's what colibri got through
before it died" instead of silently dropping an expensive, already-prefilled generation.

## Timeouts — what each one actually guards against

Every layer between the agent and colibri has its own timeout. None of them are arbitrary
red tape; each guards a genuinely distinct failure mode, and the actual bug in this
deployment was never "timeouts exist" — it was that the values were tuned for a fast cloud
API, not a 359GB disk-streamed local model.

| Layer | Value | Guards against |
|---|---|---|
| squid `connect_timeout` | 30s | Initial TCP handshake never completing (destination unreachable) |
| squid `request_timeout` | 30s | A client opening a connection but never finishing its request headers |
| squid `read_timeout` | 30 min | A connection going **idle** — no data, ever again, without closing cleanly (a crashed process, a network partition). Colibri's own streaming keepalive (~10s pings) keeps this fed during any real generation, so it should never legitimately fire for a live call. |
| squid `client_lifetime` | 60min → **6h** | A connection's **total wall-clock age**, not reset by activity — the one that actually got hit (job on a 922-token prompt, well before generation finished). This isn't really "protecting against colibri" — squid is a *shared* resource that also carries WhatsApp and z.ai traffic; without a cap, one leaked/stuck connection could eventually exhaust squid's capacity and take down unrelated traffic with it. Raised, not removed: 6h covers even the multi-hour coding-agent-prompt estimate above, with margin, while still bounding worst-case blast radius. Low-risk to raise here specifically because every destination this proxy allows is already tightly allowlisted — this only lets an already-trusted tunnel run longer, it opens nothing new. |
| Node `undici` headers-timeout | 5 min (default) | A server accepting a connection but never sending response headers — this is what killed the *first* `ask_colibri` failure (bug 3 above), now avoided by `stream: true` rather than by raising this. |
| `COLIBRI_TIMEOUT_MS` (mcp-colibri, mine) | 900s → 45 min | My own code giving up on one colibri call so a job doesn't sit unresolved in the job store forever if colibri genuinely hangs (not just slow). |

## Timezone

Set to `America/Los_Angeles` (PDT), verified.

## Operational gotchas (Docker/Windows/Git-Bash specifics)

- **`docker cp` fails on read-only containers.** The gateway has `read_only: true`;
  `docker cp` tries to write to the rootfs and fails. Workaround: a one-off helper
  container mounting the target *volume* (not the container): `docker run --rm -v
  <volume>:/workspace alpine sh -c '...'`. Named volumes (`openclaw-config`,
  `openclaw-workspace`) stay writable regardless of the container's `read_only` flag —
  `docker compose cp` into a path backed by one of those volumes works fine even though
  the rest of the rootfs doesn't.
- **`MSYS_NO_PATHCONV=1`** — Git Bash on Windows mangles Unix-style paths in docker
  arguments (`/home/node` → `C:/Program Files/Git/home/node`). Set this before any
  `docker exec`/`docker compose` command containing container paths.
- **`--force-recreate` ≠ rebuild.** `docker compose up -d --force-recreate` recreates
  containers with the *current image* but does not rebuild it. Changed `egress/squid.conf`
  or `mcp-colibri/src/*`? Run `docker compose build <service>` first — the image is what
  bakes in the change.
- **`scripts/merge-config.js` loses keys** when deep-merging into existing objects (e.g.
  a new provider added alongside an existing one silently didn't land). Workaround used
  throughout this doc: apply config changes directly via a `node -e` one-liner inside the
  container, bypassing the merge script entirely. Script still needs an actual fix.
- **Recreating a container kills whatever's mid-flight through it.** Both `mcp-colibri`
  (holds job state in memory) and `egress`/squid (proxies the actual connection) sever any
  in-progress colibri request on `--force-recreate`. When both a code fix and a live long
  job coexist: stage the change (edit + `docker compose build`, which doesn't touch the
  running container) and hold the actual recreate until the job resolves.
- **`plugins.allow` is a replace, not an add.** Setting it to trust one untracked plugin
  silently excludes every bundled plugin not also listed. See the WhatsApp section above.
- **Ollama env vars set via `[Environment]::SetEnvironmentVariable` don't reach an
  already-running tray-app-spawned server**, and won't reach a freshly relaunched one
  either unless set in the *same* process tree that launches it. Bake runtime parameters
  (like context size) into a derived Modelfile instead of relying on env-var propagation.

## Models

Verified working with this coding-plan key (probed 2026-08-22): `glm-5.3` (primary), `glm-5.2` (fallback #1), `glm-5-turbo` (fallback #2 + utility model), plus `glm-5.1`, `glm-4.7`, `glm-4.6`, `glm-4.5` — all selectable. Vision models (`glm-5v-turbo`, `4.6v`, `4.5v`) are not in the plan tier; the general pay-as-you-go endpoint (`/api/paas/v4`) has no balance on this key. Current key is weekly-quota-exhausted (resets 2026-08-29) — see local-model sections above for what's actually serving traffic until then.

Switch models: Control UI → Settings → Default models card, `/model` per conversation, or `docker compose run --rm cli models set zai/glm-5.2`.

## Layout

See SECURITY-REVIEW.md §8. Secrets live only in `.env` (gitignored, never committed).
