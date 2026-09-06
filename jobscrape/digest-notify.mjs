// digest-notify.mjs — pushes today's job digest summary to Telegram.
//
// Mirrors mcp-colibri/colibri-followup.mjs's shape deliberately: a plain
// script, no LLM turn involved, silent when there's nothing new to report
// instead of a cron "announce" mechanism spamming a "nothing to report"
// message every cycle.
//
// Deployment: this file is source-of-truth here in the repo, but it RUNS
// inside the gateway container (it needs the gateway's own CLI + token to
// send WhatsApp messages, same as colibri-followup.mjs) — copy it into the
// openclaw-workspace volume the same way scrape.mjs's writeToVolume tar-pipes
// digest/postings in:
//
//   docker run --rm -v openclaw-sandbox_openclaw-workspace:/w \
//     -v "<repo>/jobscrape:/src:ro" alpine \
//     sh -c "cp /src/digest-notify.mjs /w/digest-notify.mjs"
//
// Then register it as a second `--command` cron job the same way
// colibri-followup was registered (that registration isn't itself stored in
// this repo — inspect the existing colibri-followup cron entry via
// `docker compose run --rm cli cron list` / the openclaw-config volume and
// duplicate its shape for this script, pointing at
// /home/node/.openclaw/workspace/digest-notify.mjs; keep
// `delivery.mode: none` like colibri-followup — cron auto-sets `announce` by
// default even for command payloads). Suggested schedule: once daily,
// shortly after the 07:00 jobscrape task.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripEmDash } from "./text-filter.mjs";

const DIGEST_DIR = process.env.JOBS_DIGEST_DIR || "/home/node/.openclaw/workspace/jobs/digest";
// Telegram target is the operator's numeric chat ID (same value as the
// channel's allowFrom — @usernames are not valid send targets).
const TARGET = process.env.COLIBRI_NOTIFY_TARGET || "8953024654";
const CHANNEL = process.env.COLIBRI_NOTIFY_CHANNEL || "telegram";
const TOP_N = parseInt(process.env.JOBS_NOTIFY_TOP_N || "5", 10);
// One-line marker of the last date already notified, so re-running this
// script later the same day (e.g. a second manual jobscrape run) doesn't
// re-send — same-day reruns *append* to the summary rather than replace it,
// so there's no cheap "is this new" signal besides the date itself.
const STATE_FILE = process.env.JOBS_NOTIFY_STATE_FILE || "/home/node/.openclaw/workspace/jobs/.last-notified";

const TRACK_LABELS = {
  esports: "Esports / Gaming Ops",
  "it-devops": "IT / Sysadmin / DevOps",
  "producer-pm": "Producer / Project Management",
};

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const stamp = todayStamp();
  const summaryPath = join(DIGEST_DIR, `${stamp}-summary.json`);

  if (!existsSync(summaryPath)) {
    // Nothing scraped yet today (task hasn't run, or ran but found nothing
    // new) — exit silently, no output, no message sent.
    return;
  }

  if (existsSync(STATE_FILE) && readFileSync(STATE_FILE, "utf8").trim() === stamp) {
    return; // already notified for today's digest
  }

  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (!summary.length) return;

  const byTrack = {};
  for (const r of summary) (byTrack[r.track] ||= []).push(r);

  let text = `Job digest — ${stamp}`;
  for (const [track, items] of Object.entries(byTrack)) {
    text += `\n\n*${TRACK_LABELS[track] || track}*`;
    for (const r of items.slice(0, TOP_N)) {
      text += `\n${r.score} — ${r.company}: ${r.title}\n${r.url}`;
    }
  }

  console.error(`[digest-notify] sending ${summary.length} posting(s) across ${Object.keys(byTrack).length} track(s)`);

  execFileSync(process.execPath, [
    "dist/index.js", "message", "send",
    "--channel", CHANNEL,
    "--target", TARGET,
    "--message", stripEmDash(text),
  ], { cwd: "/app", stdio: ["ignore", "pipe", "pipe"] });

  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, stamp);
  console.error(`[digest-notify] delivered + marked ${stamp} as notified`);
}

main().catch(err => {
  console.error(`[digest-notify] fatal: ${err.message}`);
  process.exit(1);
});
