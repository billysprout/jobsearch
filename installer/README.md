# jobscrape kit

A daily job-board watcher: fetches postings from Greenhouse, Lever, Ashby,
Workable, Remotive, RemoteOK and Hacker News "Who's Hiring", ranks them
against your tracks/keywords with a local LLM, and writes a scored digest to
a folder you can read every morning.

Everything runs on your machine. No accounts, no cloud, no data leaves your
network except the job-board fetches themselves.

## What it installs

| Piece | What it is | Where |
|---|---|---|
| Docker | runs the three containers below | your OS package manager |
| Ollama | local LLM server | host |
| gemma4-e2b-64k | the ranking model you get by default | Ollama |
| the stack | scraper + config API + status page | Docker Compose |
| colibri *(optional)* | a heavier, higher-quality ranking engine | host, ~400 GB weights |

Requirements: 8 GB RAM minimum (16 GB comfortable), ~10 GB disk for the
default install, **~420 GB extra disk + 16 GB RAM for the optional colibri
engine**.

## Quickstart

**Windows** (PowerShell, from the unzipped folder):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
```

**macOS / Linux**:

```sh
bash setup.sh
```

The script is idempotent — if it stops midway (a reboot, a closed laptop),
just run it again. It will:

1. Install Docker and Ollama if missing
2. Download the gemma4 ranking model (a few GB)
3. Generate a private API token into `deploy/.env`
4. Seed your config from a friendly example
5. Ask whether you want the optional **colibri** engine (~400 GB download —
   skipping is the normal choice; gemma ranking is good)
6. Start everything and run a small dry-run probe so you can see it work

To pre-answer the colibri question: `-WithColibri` / `--with-colibri`.

## Where things land

- **Digests**: `deploy/digests/digest/<date>.md` — the daily scored list,
  with per-posting cards in `deploy/digests/postings/`
- **Status page**: `http://127.0.0.1:8790/?token=...` (token in
  `deploy/.env`) — edit tracks, keywords, watched companies, blocklists;
  changes apply on the next run
- **Logs**: `deploy/logs/run-<date>.log` (scrape) and
  `deploy/logs/<date>.log` (compose)
- **Schedule**: daily at 07:00 local (`JOBSCRAPE_RUN_AT` in `deploy/.env`)
- **State**: `deploy/state/` — delete it to reset what the scraper has seen

## Docker without Docker Desktop (colima)

Any Docker that speaks the standard CLI works. If you use
[colima](https://github.com/abiosoft/colima) instead of Docker Desktop,
one difference matters: Docker Desktop forwards `host.docker.internal` to
your machine's loopback, colima routes it to the VM's gateway (your real
IP) - which a default Ollama (bound to `127.0.0.1`) never answers. Widen
the bind before starting the stack:

```sh
OLLAMA_HOST=0.0.0.0 ollama serve
```

Everything else is identical - the compose file already maps
`host.docker.internal` to the host gateway.

## Ranking, briefly

Default ranking is **gemma**: a 5B local model, ~15-60 s per posting. If you
installed colibri, it ranks first and gemma only covers its mistakes. The
digest marks which engine scored each entry (`ranker` field, and the header
line names the engine).

## Stopping / uninstalling

```sh
cd deploy && docker compose down         # stop
cd deploy && docker compose down -v      # stop + drop nothing (no volumes here)
```

The engine keep-alive task (`JobScrape-EngineServe` scheduled task on
Windows, `jobscrape-engines` systemd unit / LaunchAgent on macOS) can be
removed with Task Scheduler / `systemctl --user disable jobscrape-engines.timer`
/ `launchctl unload ~/Library/LaunchAgents/org.jobscrape.engines.plist`.
Docker, Ollama and the models are left installed; remove them like any other
app. Deleting the unzipped folder removes everything else.
