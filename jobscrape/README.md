# jobscrape — Host-side job scraping pipeline

Scrapes job boards on the **Windows host** and writes ranked digests into
the OpenClaw sandbox workspace volume. The sandbox agent reads the files
locally — no web access or trust-boundary changes needed.

## Quick start

Install dependencies once (currently just `pdfkit`, for the PDF outputs below):

```bash
npm install
```

```bash
# Fastest dev mode: fetch + keyword filter, heuristic scores, stdout only
node scrape.mjs --once --dry-run --limit 5 --no-colibri

# Same thing, as the bundled dev profile (dry-run + limit 5 + heuristic-only
# chain, all from configs/dev.json — no flags needed)
node scrape.mjs --once --profile dev

# Full run with colibri ranking (one posting per call; colibri is the
# bottleneck — see "Tuning throughput")
node scrape.mjs --once

# Re-run: dedupe kicks in, only new postings are processed
node scrape.mjs --once --no-colibri

# Also draft cover letters for the top 3 ranked postings (needs profile.md)
node scrape.mjs --once --drafts
```

## Run modes

| Flag | Effect |
|------|--------|
| `--once` | Required. Single run then exit. |
| `--profile NAME` | Overlay `configs/NAME.json` on `configs/base.json`. Precedence: this flag > `JOBSCRAPE_PROFILE` env > `production`. See "Configuration & profiles". |
| `--dry-run` | Output digest to stdout, skip volume write, skip drafting. |
| `--no-colibri` | Force the scorer chain to `keyword-heuristic` only (fast, no colibri). |
| `--limit N` | Cap candidates after selection (default: `selection.limit`, 40). |
| `--drafts [N]` | Draft cover letters for the top N ranked postings (default 3) via colibri, using `profile.md`. Off by default — extra colibri calls on top of ranking, and colibri throughput is already why `--limit` is capped at 10 in production. No-op (with a logged reason) if `profile.md` doesn't exist or `--no-colibri` is set. See "Cover-letter drafting" below. |

`configs/base.json`'s `colibri.heuristicSkipThreshold` (default 70) lets very
confident keyword matches skip colibri ranking entirely and go straight to
the digest with a heuristic score — trades a little ranking precision for
more colibri budget spent on postings that are actually ambiguous. Set to
`null` to send every candidate through colibri.

## Configuration & profiles

All tuning lives in config — there are no magic numbers left in the pipeline
code. Three layers deep-merge (plain objects recurse, **arrays replace
wholesale**, `null` is a meaningful "off"):

1. `config.mjs` `DEFAULTS` — the schema and every knob's built-in default
2. `configs/base.json` — the repo's actual content (tracks, ATS slugs,
   keywords, sources); checked in, applies to every run
3. `configs/<profile>.json` — per-run overlays. `production.json` sets
   `selection.limit: 10` (the 07:00 task also passes `--limit 10`), enables the
   `recency` (30 days) and `blocklist` (empty — edit `filterConfig.blocklist`)
   filters, and reserves 3 of the 10 slots for non-curated sources;
   `dev.json` is the fast no-colibri dry-run.

The validator rejects unknown keys (with a Levenshtein suggestion for
typos), requires each track to have `label` + `keywords` + `description`
(the description feeds the generated colibri prompt), and enforces that
every configured filter/scorer name exists in the registry and the scorer
chain ends in a terminal stage. Legacy keys: `dailyCap` is dropped with a
warning (read by nothing — the cap is `selection.limit`); a top-level
`perCompanyMax` still aliases to `selection.perCompanyMax`, with a nudge to
move it.

Knob map (full defaults in `config.mjs`):

| Key | Meaning |
|-----|---------|
| `selection.limit` / `perCompanyMax` | run cap / round-robin cap per company per priority tier |
| `selection.sourcePriorities` / `unknownSourcePriority` | candidate ordering tiers (curated ATS → boards → unknown) |
| `selection.reservedSlots` / `reservedSourcePriority` | hold the last N slots for generic boards so a curated flood can't squeeze them out (0 = off) |
| `filters` / `scorers` / `filterConfig` | stage chains by name + per-stage options — see "Pipeline stages" |
| `fetch.userAgent` / `fetch.timeoutMs` | request identity; `timeoutMs` null = no timeout (opt-in AbortSignal) |
| `fetch.hn.*` | HN Who-is-Hiring fetch shape (hits per page, excerpt caps) |
| `output.digestStatePruneDays` / `topNPerTrack` / `cardExcerptChars` / `tableCellChars` | digest-state retention, summary top-N, card/table sizing |
| `colibri.generation.*` | max tokens per posting, temperature, prompt excerpt size, one-line/fit-notes caps. **These shape the prompt bytes — changing them costs one full KV-cache re-prefill of the local model.** |
| `colibri.busyCheck.*` | mcp-colibri `/health` politeness polling |
| `colibri.chunkSize` / `heuristicSkipThreshold` | postings per colibri call (keep at 1 — the parser trusts the id of a single-posting chunk); heuristic pre-gate threshold (null = off) |
| `scoring.keyword.*` | heuristic score = distinct keyword hits × pointsPerKeyword × track weight, capped at scoreCap |
| `draft.*` / `tailor.*` | cover-letter / resume-tailoring generation budgets |
| `tracks.<key>.{label, description, keywords, weight}` | the taxonomy — single source of truth for the colibri prompt, the parser whitelist, the digest layout, and the push summary |

## Pipeline stages

The pipeline is two named chains, resolved against explicit tables in
`pipeline/registry.mjs` (deliberately no dynamic `import()` — a config value
never decides what file gets loaded; adding a stage is a code change: new
module + one registry row):

- **filters** (default `["keyword-match"]`) run before dedupe, so a posting
  a dropped filter never matched is never marked seen and can surface later
  when the filter changes. Interface: `init(config)` → params, `apply(postings,
  params)` → `{ kept, dropped, byReason }`.
- **scorers** (default `["keyword-gate", "colibri", "keyword-heuristic"]`)
  run in order, each receiving the previous stage's `missed`:
  `keyword-gate` ranks high-confidence keyword matches without colibri,
  `colibri` ranks the rest (streaming each chunk to the digest; outage-hit
  chunks defer to `state/pending-colibri.json` for a real retry), and the
  terminal `keyword-heuristic` fills anything left (a colibri response that
  succeeded but parsed to nothing — never an outage). The last scorer must
  be terminal; `validateChains` enforces all of this at startup.

Available stages beyond the defaults: `filters: ["recency"]` (drop postings
older than `filterConfig.recency.maxAgeDays`; postings with no parseable
date are kept unless `keepUnknownDate: false`) and `filters: ["blocklist"]`
(never show `filterConfig.blocklist.companies` or titles matching
`titlePatterns` regexes — non-compiling patterns are a startup error). Both
run pre-dedupe, so un-blocking something later lets it resurface instead of
having been burned as seen.

## Tuning throughput

Colibri scores one posting at a time and can take 1-10+ minutes each — that
is why production caps `selection.limit` at 10 and the pre-gate skips
high-confidence matches. `selection.reservedSlots` reserves room for
board postings when curated ATS companies are prolific; `--profile dev`
(`dryRun` + heuristic-only chain) runs the whole pipeline in seconds.

## Scheduling

Register a daily Windows Scheduled Task (07:00, auto-starts if missed):

```powershell
# Run once as admin
cd C:\claw-code-local\openclaw-sandbox\jobscrape
powershell -ExecutionPolicy Bypass -File register-task.ps1
```

Manual trigger: `schtasks /Run /TN OpenClaw-JobScrape`
Remove: `Unregister-ScheduledTask -TaskName OpenClaw-JobScrape`

Logs append to `logs/run-YYYY-MM-DD.log` when run via the task scheduler.

**Timeout: 6 hours** (`register-task.ps1`'s `ExecutionTimeLimit`, matches the repo's other
long-running-local-model budget — `egress/squid.conf`'s `client_lifetime`). Was 3h; a
colibri-backed run genuinely got that close (started 7:00:01 AM, still mid-ranking-call at
8:35 AM) on nothing more than ordinary disk-tier-offloaded colibri latency, no bug involved.
On timeout, Windows hard-kills the whole process tree (`TerminateProcess` — no graceful
shutdown) — this drops the TCP connection to colibri mid-request, which colibri's own
disconnect-detection notices and cleanly `CANCEL`s server-side (see `openai_server.py`'s
`client_disconnected` + the generation loop's per-token cancel check); nothing hangs
computing into the void on colibri's side either way.

**Streaming, not batch-at-the-end**: `scrape.mjs` persists and publishes each ranked chunk
to the digest as soon as colibri returns it (`persistAndPublish` in `scrape.mjs`, plumbed
through `colibri.mjs`'s `rankPostings(..., onChunkRanked)` callback) rather than
accumulating everything in memory and writing once at the end. A timeout at any point loses
at most the one chunk in flight — everything ranked before that is already on the
digest, `state/seen.json`, and `state/digest-<date>.json`. `--dry-run`
still writes nothing at all, as before.

## Colibri offline behavior

If colibri (localhost:8000) is unreachable or times out:
- The affected chunks are **deferred, not degraded**: they go to
  `state/pending-colibri.json` (never heuristic-scored into the digest) and
  are retried — pending-first — on the next run.
- Only a response that *succeeded but parsed to nothing* falls to the
  terminal heuristic scorer, as a gap-fill.
- `--no-colibri` is different: an explicit opt-out that heuristic-scores
  everything now (including anything sitting in the pending queue).
- The digest banner says OFFLINE only for heuristic-only runs; a mid-run
  outage doesn't flip the banner for entries colibri did score.

## Editing the company list

Edit `configs/base.json` → `ats.<source>` to add/remove companies. Each entry needs
the board slug (the URL path segment) and a display label.

| ATS | Slug = | Verify a slug works |
|-----|--------|----------------------|
| Greenhouse | board name in `boards-api.greenhouse.io/v1/boards/{slug}/jobs` | `curl https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` |
| Lever | company subdomain in `jobs.lever.co/{slug}` | `curl https://api.lever.co/v0/postings/{slug}?mode=json` |
| Workable | account name in `apply.workable.com/{slug}/` | `curl https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true` |
| Ashby | job board name in `jobs.ashbyhq.com/{slug}` | `curl https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` |

**Always verify before adding.** The Cloud9/Greenhouse bug (see the bug list
above) was exactly this: a slug that returned HTTP 200 but was the wrong
company. A 200 response with a `jobs` array isn't enough — check the company
name in the response actually matches who you think you're adding.

## Workspace layout (inside sandbox)

```
/home/node/.openclaw/workspace/
  resume.pdf              -- rendered from profile.md, see "Resume PDF" below
  jobs/
    README.md              -- explainer for the agent
    digest/2026-08-23.md   -- ranked table grouped by track
    postings/<id>.md       -- full card per posting
    postings/<id>-draft.md   -- cover-letter draft (only with --drafts)
    postings/<id>-draft.pdf  -- same letter, formatted as PDF
```

`resume.pdf` sits at the workspace root, not under `jobs/` — it isn't a scraped job
artifact, it's a candidate asset (see "Resume PDF" below). Both writes go through the same
`volume-writer.mjs` tar-pipe as everything else here.

## Source details

| Source | Format | Status |
|--------|--------|--------|
| RemoteOK | JSON API | Active (~200 postings), needs real User-Agent |
| Remotive | JSON API | Active, remote-only board |
| We Work Remotely | RSS per category | **Disabled** — Cloudflare challenge blocks programmatic access (403) |
| Hacker News | Algolia API | Active, "Who is Hiring" monthly thread, top-level comments only |
| Greenhouse ATS | JSON API per company | Active (verified: epicgames, roblox, discord, riotgames, bungie) |
| Lever ATS | JSON API per company | **Disabled** — v0 public API deprecated (404), v1 requires auth |
| Workable ATS | JSON widget API per company | Active (verified: cloud9 — the real esports Cloud9, on the correct ATS this time) |
| Ashby ATS | JSON Job Board API per company | Active (verified: ramp, vanta) |

## Cover-letter drafting

`--drafts [N]` generates draft cover letters for the top N ranked postings
(default 3) via colibri, using `profile.md` (copy `profile.example.md` and
fill in your actual background — `profile.md` is gitignored, same as
`.env`). Drafts land in the workspace volume as `postings/<id>-draft.md`,
same place as the regular posting cards, **plus a formatted
`postings/<id>-draft.pdf`** of the same letter (via `pdf.mjs`, rendered from
`profile.md`'s `## Candidate` name/contact block as the letterhead — nothing
extra sent to colibri for this, it's pure formatting of text colibri already
generated). They are **never submitted anywhere** — this stops at "here's a
draft, go read and send it yourself." See `draft.mjs` for the generation
logic and prompt.

`profile.md`'s Preferences section (comp floor, location constraints,
anything drafts should avoid claiming) ships blank — fill it in before
relying on `--drafts` for real; nothing in the pipeline enforces it, it's
just there for you to have filled in.

Deliberately did not build application submission (filling out ATS forms,
auto-clicking apply) — that means the agent handling your PII against
third-party login/captcha flows, a materially different risk than "reads job
boards and writes markdown," and most ATS terms of service don't love
automated submission either.

## Resume PDF

`node render-resume.mjs` renders `profile.md` as a plain resume-shaped PDF
(`pdf.mjs`'s `profileToResumePdf` — lightweight line-based markdown handling:
`#`/`##` headers, `-` bullets, `**bold**`) and pushes it to the workspace
volume as `resume.pdf`. **Format conversion only** — no AI involvement, no
per-posting tailoring, nothing invented; it lays out exactly what's already
in `profile.md`. On-demand, not part of the daily scrape (`profile.md` only
changes when you edit it) — re-run manually after editing.

```bash
node render-resume.mjs               # render + push to the workspace volume
node render-resume.mjs --out FILE    # also save a local copy
node render-resume.mjs --local-only --out FILE   # local copy only, skip the volume write
```

Per-posting AI-tailored resumes (as opposed to this static conversion) were
deliberately not built — resume accuracy is higher-stakes than a cover
letter's (a fabricated line is worse there), and it deserves its own
scoped design rather than folding into this on the side.

## Application tracking — a "task tracker tangent"

An earlier round of ideas included turning `state/seen.json` into a full
`applications.json` (status: applied/interviewing/rejected/offer, follow-up
reminders, etc.). Deliberately **not built** — that's a task-tracker feature
wearing a job-scraper's clothes, a different kind of tool than "finds and
ranks postings." If it's wanted later it deserves its own scoped design
rather than growing out of `seen.json` as a side effect.

## Digest push

The live daily checkin is OpenClaw's own `job-digest` cron (`docker compose run
--rm cli cron list`): an isolated agent turn reads the newest
`digest/<date>-summary.json` and OpenClaw announces the turn's output to the
configured channel — **Telegram** since 2026-08-28 (`telegram:8953024654`,
previously WhatsApp).

`digest-notify.mjs` is a scripted alternative that isn't currently registered
as a cron job: a plain script, no LLM turn, silent when there's nothing new
(mirrors `mcp-colibri/colibri-followup.mjs`). It reads today's
`digest/<date>-summary.json` and pushes the top postings per track itself,
with Telegram defaults now too. It runs **inside the gateway container**
(needs the gateway's own CLI + token to send), not on the host — see the
deployment/cron-registration notes in the file's header comment.

## Coordinating with `ask_colibri`

`colibri.mjs` checks `mcp-colibri`'s `/health` (published to
`127.0.0.1:8090` — see `docker-compose.yml` and SECURITY-REVIEW.md §4 R14)
before firing each ranking call, and backs off briefly if an in-conversation
`ask_colibri` job is running. Colibri serializes requests, so without this a
daily scrape and a live agent query landing at the same time would silently
queue behind each other with no indication why. Best-effort only — fails
open (no-op) if that port isn't reachable, never blocks a run on
infrastructure that isn't there.

## File inventory

| File | Purpose |
|------|---------|
| `scrape.mjs` | Orchestrator + CLI: fetch → filter chain → dedupe → select → scorer chain, streaming ranked chunks to the digest as they complete |
| `config.mjs` | Config schema (`DEFAULTS`), deep-merge layering, validation, `--profile` resolution, legacy aliases |
| `configs/base.json` | Repo content: tracks/keywords, ATS slugs, sources, WWR categories |
| `configs/production.json` | Production overlay (`selection.limit: 10`) |
| `configs/dev.json` | Fast dev profile: dry-run, limit 5, heuristic-only chain, fetch timeout |
| `state.mjs` | All `state/` IO (seen, pending-colibri, digest state, debug snapshots); formats frozen |
| `sources.mjs` | Per-board fetchers, normalize to common shape (`fetch.*` config) |
| `keywords.mjs` | Word-boundary keyword matching + parametrized heuristic scoring |
| `colibri.mjs` | Colibri client: SSE streaming rank, parse/clamp, heuristic scoring, mcp-colibri busy-check |
| `pipeline/registry.mjs` | Filter/scorer name→stage tables, interface contract, chain validation |
| `pipeline/prompt.mjs` | Generates the colibri system prompt + track whitelist from `config.tracks` (KV-cache-stable) |
| `pipeline/selection.mjs` | Source priority tiers, round-robin company interleave, limit cap, reservedSlots |
| `pipeline/render.mjs` | Digest/summary/card/README rendering — pure functions over (rankings, config) |
| `filters/keyword-match.mjs` | Default filter: word-boundary track-keyword matching (pre-dedupe) |
| `filters/recency.mjs` | Opt-in: drop postings older than `filterConfig.recency.maxAgeDays` |
| `filters/blocklist.mjs` | Opt-in: drop blocked companies / title-matching regexes |
| `scorers/keyword-gate.mjs` | Pre-gate: heuristic-confident postings skip colibri |
| `scorers/colibri-rank.mjs` | Colibri scorer: streaming publish, outage defer, malformed→missed |
| `scorers/keyword-heuristic.mjs` | Terminal scorer: `--no-colibri` mode + malformed-gap fill |
| `draft.mjs` | Cover-letter drafting via colibri, from `profile.md` — writes `.md` + `.pdf` |
| `pdf.mjs` | Shared PDF renderer (pdfkit) — cover letters and the resume, format-only, no AI |
| `render-resume.mjs` | Renders `profile.md` → `resume.pdf`, pushes to the workspace volume root |
| `tailor.mjs` | Per-posting AI-tailored resume via colibri, from `resume.md` (master) |
| `volume-writer.mjs` | Shared tar-pipe-into-docker-volume writer, used by `scrape.mjs`, `render-resume.mjs`, `tailor.mjs` |
| `text-filter.mjs` | `stripEmDash` for generated output artifacts (prompts never pass through it) |
| `digest-notify.mjs` | Standalone single-file digest push script, Telegram defaults (dormant — the `job-digest` agent-turn cron is the live checkin) |
| `diag-readonly.mjs` | Read-only pipeline diagnostics — re-runs matching/scoring against live sources, writes nothing |
| `package.json` | npm deps (currently just `pdfkit`) — run `npm install` once |
| `profile.md` | Your actual background (gitignored, same as `.env`) — copy from `profile.example.md` |
| `profile.example.md` | Template for `profile.md` |
| `register-task.ps1` | Windows Scheduled Task registration (07:00 daily, 6h timeout) |
| `state/seen.json` | Dedupe state (`source:id` strings, auto-created) |
| `state/pending-colibri.json` | Postings deferred during a colibri outage, retried next run |
| `state/last-run-{matched,eligible}.json` | Per-run debug snapshots (overwritten every run, incl. dry-run) |
| `test/` | `node --test` suite: config, keywords, prompt goldens, scorer chain (mock SSE colibri), selection, filters, render, VCR byte-parity |
| `staging/` | Temp dir for volume writes (auto-created, gitignored) |
| `logs/` | Scheduler log output (auto-created) |
