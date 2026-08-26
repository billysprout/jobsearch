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

# Full run with colibri ranking (chunks of 3 postings)
node scrape.mjs --once

# Full run writing to the sandbox workspace volume
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
| `--dry-run` | Output digest to stdout, skip volume write, skip drafting. |
| `--no-colibri` | Use heuristic keyword scores only (fast, no colibri). |
| `--limit N` | Cap candidates after pre-filter (default 40). |
| `--drafts [N]` | Draft cover letters for the top N ranked postings (default 3) via colibri, using `profile.md`. Off by default — extra colibri calls on top of ranking, and colibri throughput is already why `--limit` is capped at 10 in production. No-op (with a logged reason) if `profile.md` doesn't exist or `--no-colibri` is set. See "Cover-letter drafting" below. |

`config.json`'s `colibri.heuristicSkipThreshold` (default 70) lets very
confident keyword matches skip colibri ranking entirely and go straight to
the digest with a heuristic score — trades a little ranking precision for
more colibri budget spent on postings that are actually ambiguous. Set to
`null` to send every candidate through colibri, like before.

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
WhatsApp-visible digest, `state/seen.json`, and `state/digest-<date>.json`. `--dry-run`
still writes nothing at all, as before.

## Colibri offline behavior

If colibri (localhost:8000) is unreachable or times out:
- The pipeline falls back to **heuristic keyword scores** automatically.
- The digest header shows `colibri: OFFLINE (heuristic scores)`.
- Postings are never lost — colibri is purely a ranking enhancement.
- Re-run later with colibri available (clear `state/seen.json` to re-score).

## Editing the company list

Edit `config.json` → `ats.<source>` to add/remove companies. Each entry needs
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

## Digest push to WhatsApp

`digest-notify.mjs` reads today's `digest/<date>-summary.json` (written by
`scrape.mjs` every run) and pushes the top postings per track to WhatsApp,
mirroring `mcp-colibri/colibri-followup.mjs`'s pattern: a plain script, no
LLM turn, silent when there's nothing new. It runs **inside the gateway
container** (needs the gateway's own CLI + token to send), not on the host —
see the deployment/cron-registration notes in the file's header comment.

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
| `scrape.mjs` | Orchestrator, CLI, state mgmt, streams ranked chunks to the digest as they complete |
| `sources.mjs` | Per-board fetchers, normalize to common shape |
| `colibri.mjs` | Colibri client, batch ranking, heuristic fallback, mcp-colibri busy-check, per-chunk `onChunkRanked` callback |
| `draft.mjs` | Cover-letter drafting via colibri, from `profile.md` — writes `.md` + `.pdf` |
| `pdf.mjs` | Shared PDF renderer (pdfkit) — cover letters and the resume, format-only, no AI |
| `render-resume.mjs` | Renders `profile.md` → `resume.pdf`, pushes to the workspace volume root |
| `volume-writer.mjs` | Shared tar-pipe-into-docker-volume writer, used by `scrape.mjs` and `render-resume.mjs` |
| `digest-notify.mjs` | WhatsApp digest push (deployed into the gateway container — see its header) |
| `config.json` | Tracks, keywords, ATS slugs, WWR categories, caps |
| `package.json` | npm deps (currently just `pdfkit`) — run `npm install` once |
| `profile.md` | Your actual background (gitignored, same as `.env`) — copy from `profile.example.md` |
| `profile.example.md` | Template for `profile.md` |
| `register-task.ps1` | Windows Scheduled Task registration (07:00 daily, 6h timeout) |
| `state/seen.json` | Dedupe state (url-hash set, auto-created) |
| `staging/` | Temp dir for volume writes (auto-created, gitignored) |
| `logs/` | Scheduler log output (auto-created) |
