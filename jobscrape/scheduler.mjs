// scheduler.mjs — daily run loop for containerized deployments.
//
// scrape.mjs is strictly one-shot (--once); scheduling was always external
// (Windows Task Scheduler on the authoring host). A friend's machine runs
// the stack as `docker compose up -d` and walks away — this module IS that
// external scheduler, inside the scraper container: sleep until the next
// run time, `node scrape.mjs --once` with inherited stdio (so the run-log
// tee in scrape.mjs keeps working unchanged), repeat. Container restart
// policy handles crashes; nothing here needs privileges.
//
// Usage:
//   node scheduler.mjs [--at HH:MM] [--scrape-args "..."] [--run-on-start]
//
//   --at HH:MM        local wall-clock run time (default 07:00; env
//                     JOBSCRAPE_RUN_AT). Recomputed each cycle, so DST
//                     shifts land on the same wall-clock time.
//   --scrape-args     extra argv for scrape.mjs, space-split (e.g.
//                     "--limit 10"). profile/state dir come from the
//                     environment like any other run.
//   --run-on-start    fire a run immediately at startup, then schedule
//                     (env JOBSCRAPE_RUN_ON_START=1). Handy for a first
//                     run right after setup; leave off to stay quiet until
//                     the scheduled hour.
//
// Missed-run semantics: none (deliberately). If the machine is off/asleep
// at the run time, the run is skipped and the next day's fires — matching
// Task Scheduler behavior, and a machine that was off overnight doesn't
// get a surprise CPU-heavy LLM batch on boot. setTimeout is re-armed per
// cycle, so host suspend/hibernate drift self-corrects on the next wake.

import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    at: process.env.JOBSCRAPE_RUN_AT || "07:00",
    runOnStart: /^(1|true|yes)$/i.test(process.env.JOBSCRAPE_RUN_ON_START || ""),
    scrapeArgs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--at") out.at = argv[++i] ?? out.at;
    else if (argv[i] === "--run-on-start") out.runOnStart = true;
    else if (argv[i] === "--scrape-args") out.scrapeArgs = String(argv[++i] ?? "").split(/\s+/).filter(Boolean);
  }
  return out;
}

// Validate HH:MM once at startup — a typo'd time should be a loud crash at
// `compose up`, not a silent schedule that never fires.
function parseClock(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  const h = m ? Number(m[1]) : NaN;
  const min = m ? Number(m[2]) : NaN;
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) {
    throw new Error(`scheduler: invalid --at time "${at}" (want HH:MM, 0-23:0-59, local time)`);
  }
  return { h, min };
}

function msUntilNext({ h, min }) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, min, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

function runOnce(scrapeArgs) {
  const argv = [resolve(__dirname, "scrape.mjs"), "--once", ...scrapeArgs];
  console.error(`[scheduler] firing: node ${argv.map(a => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
  // spawnSync + inherit: scrape.mjs's run-log tee captures everything anyway;
  // a nonzero exit must not kill the loop, just surface in the log.
  const res = spawnSync(process.execPath, argv, { stdio: "inherit" });
  if (res.error) console.error(`[scheduler] run failed to start: ${res.error.message}`);
  else if (res.status !== 0) console.error(`[scheduler] run exited ${res.status} (see logs/run-<date>.log)`);
  else console.error("[scheduler] run completed cleanly");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const clock = parseClock(opts.at);

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.error(`[scheduler] ${sig} — exiting`);
      process.exit(0);
    });
  }

  console.error(`[scheduler] up — daily at ${String(clock.h).padStart(2, "0")}:${String(clock.min).padStart(2, "0")} local`);

  if (opts.runOnStart) {
    console.error("[scheduler] run-on-start: firing an immediate run before scheduling");
    runOnce(opts.scrapeArgs);
  }

  for (;;) {
    const delay = msUntilNext(clock);
    const at = new Date(Date.now() + delay);
    console.error(`[scheduler] next run ${at.toISOString()} (in ${(delay / 3600000).toFixed(1)}h)`);
    await new Promise(r => setTimeout(r, delay));
    runOnce(opts.scrapeArgs);
  }
}

main().catch(e => {
  console.error(`[scheduler] fatal: ${e.message}`);
  process.exit(1);
});
