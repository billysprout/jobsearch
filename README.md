# jobscrape

A daily job-board watcher that runs entirely on your own machine. Every
morning it fetches new postings from Greenhouse, Lever, Ashby, Workable,
Remotive, RemoteOK and Hacker News "Who's Hiring", ranks them against your
tracks and keywords with a local LLM, and writes a scored digest to read
with your coffee.

No accounts. No cloud. Nothing leaves your network except the job-board
fetches themselves.

## Install

You need the kit zip (`jobscrape-kit-*.zip`), about 10 GB of disk, and 8 GB
RAM (16 GB is comfortable). Unzip it, open a terminal **in the unzipped
folder**, and run one command:

**Mac / Linux:**

```sh
bash setup.sh
```

**Windows (PowerShell):**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
```

The installer is idempotent — if anything interrupts it (reboot, closed
laptop), just run it again. It installs Docker and Ollama if missing,
downloads the gemma ranking model (a few GB, one time), asks whether you
also want the optional **colibri** engine (a ~420 GB download — skipping is
the normal choice; gemma ranking is good), starts everything, and runs a
small dry-run so you can watch it work.

Pre-answer the engine question with `--with-colibri` (`-WithColibri` on
Windows). `--port 8790` and `--at 07:00` set the status-page port and the
daily run time.

When setup finishes it opens the status page (your config editor — tracks,
keywords, watched companies) in the browser, with the token already filled
in. To see a real digest immediately instead of waiting for the morning
run: `cd deploy && docker compose run --rm scraper node scrape.mjs --once`.

## Every morning

- **Your digest** — `deploy/digests/digest/<date>.md`, the scored list;
  per-posting cards land in `deploy/digests/postings/`
- **Status page** — `http://127.0.0.1:8790/?token=...` (token in
  `deploy/.env`): edit tracks, keywords, watched companies, blocklists;
  changes apply on the next run
- **Schedule** — daily at 07:00 local (`JOBSCRAPE_RUN_AT` in `deploy/.env`)
- **Logs** — `deploy/logs/`

## Stopping / uninstalling

```sh
cd deploy && docker compose down    # stop the stack
```

Then delete the unzipped folder — that removes everything except Docker,
Ollama and the models, which uninstall like any other app. (The optional
engine keep-alive task is removed via Task Scheduler on Windows or
`launchctl`/`systemctl` on Mac/Linux — details in the README inside the
kit.)

## For the curious

- The kit zip is built from this repo by `installer/build-kit.ps1`; the
  full kit documentation is `installer/README.md` and ships inside the zip.
- Every step is proven on real Mac hardware by GitHub Actions:
  [`kit-macos-smoke`](.github/workflows/kit-macos-smoke.yml) runs the exact
  friend install end-to-end (scrape, ranking, digest, status page), and
  [`kit-macos-gatekeeper`](.github/workflows/kit-macos-gatekeeper.yml)
  verifies the kit passes macOS quarantine and antivirus scanning.
- Operator docs for the OpenClaw sandbox this project grew out of live in
  [AGENTS.md](AGENTS.md).
