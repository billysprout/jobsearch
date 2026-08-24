# jobscrape — Host-side job scraping pipeline

Scrapes job boards on the **Windows host** and writes ranked digests into
the OpenClaw sandbox workspace volume. The sandbox agent reads the files
locally — no web access or trust-boundary changes needed.

## Quick start

```bash
# Fastest dev mode: fetch + keyword filter, heuristic scores, stdout only
node scrape.mjs --once --dry-run --limit 5 --no-colibri

# Full run with colibri ranking (chunks of 3 postings)
node scrape.mjs --once

# Full run writing to the sandbox workspace volume
node scrape.mjs --once

# Re-run: dedupe kicks in, only new postings are processed
node scrape.mjs --once --no-colibri
```

## Run modes

| Flag | Effect |
|------|--------|
| `--once` | Required. Single run then exit. |
| `--dry-run` | Output digest to stdout, skip volume write. |
| `--no-colibri` | Use heuristic keyword scores only (fast, no colibri). |
| `--limit N` | Cap candidates after pre-filter (default 40). |

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

## Colibri offline behavior

If colibri (localhost:8000) is unreachable or times out:
- The pipeline falls back to **heuristic keyword scores** automatically.
- The digest header shows `colibri: OFFLINE (heuristic scores)`.
- Postings are never lost — colibri is purely a ranking enhancement.
- Re-run later with colibri available (clear `state/seen.json` to re-score).

## Editing the company list

Edit `config.json` → `ats.greenhouse` / `ats.lever` to add/remove companies.
Each entry needs the board slug (the URL path segment) and a display label.

**Greenhouse**: slug = the board name in `boards-api.greenhouse.io/v1/boards/{slug}/jobs`
**Lever**: slug = company subdomain in `jobs.lever.co/{slug}`

Verify a slug works: `curl https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`

## Workspace layout (inside sandbox)

```
/home/node/.openclaw/workspace/jobs/
  README.md              -- explainer for the agent
  digest/2026-08-23.md   -- ranked table grouped by track
  postings/<id>.md       -- full card per posting
```

## Source details

| Source | Format | Status |
|--------|--------|--------|
| RemoteOK | JSON API | Active (~200 postings), needs real User-Agent |
| Remotive | JSON API | Active, remote-only board |
| We Work Remotely | RSS per category | **Disabled** — Cloudflare challenge blocks programmatic access (403) |
| Hacker News | Algolia API | Active, "Who is Hiring" monthly thread, top-level comments only |
| Greenhouse ATS | JSON API per company | Active (verified: epicgames, roblox, discord, cloud9, riotgames) |
| Lever ATS | JSON API per company | **Disabled** — v0 public API deprecated (404), v1 requires auth |

## File inventory

| File | Purpose |
|------|---------|
| `scrape.mjs` | Orchestrator, CLI, state mgmt, workspace writer |
| `sources.mjs` | Per-board fetchers, normalize to common shape |
| `colibri.mjs` | Colibri client, batch ranking, heuristic fallback |
| `config.json` | Tracks, keywords, ATS slugs, WWR categories, caps |
| `register-task.ps1` | Windows Scheduled Task registration |
| `state/seen.json` | Dedupe state (url-hash set, auto-created) |
| `staging/` | Temp dir for volume writes (auto-created, gitignored) |
| `logs/` | Scheduler log output (auto-created) |
