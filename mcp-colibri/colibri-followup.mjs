// colibri-followup.mjs — checks mcp-colibri for ask_colibri jobs that
// finished but were never confirmed delivered, and pushes them to WhatsApp
// directly via this gateway's own CLI. Deliberately NOT an agent turn: no
// LLM involved, so it can stay completely silent when there's nothing
// pending instead of always producing some text a cron "announce" would
// then deliver as spam. Deployed into the workspace volume and run by the
// "colibri-followup" cron job (a --command payload) every 10 minutes.
//
// Lives at /home/node/.openclaw/workspace/colibri-followup.mjs inside the
// gateway container (writable — unlike the rest of the read-only rootfs).

import { execFileSync } from "node:child_process";

const MCP_URL = process.env.COLIBRI_MCP_URL || "http://mcp-colibri:3000";
const TARGET = process.env.COLIBRI_NOTIFY_TARGET || "+18604026205";
const CHANNEL = process.env.COLIBRI_NOTIFY_CHANNEL || "whatsapp";

async function main() {
  const res = await fetch(`${MCP_URL}/pending`);
  if (!res.ok) {
    console.error(`[colibri-followup] pending check failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const jobs = await res.json();
  if (!jobs.length) {
    // Nothing pending — exit silently, no output, no message sent.
    return;
  }

  console.error(`[colibri-followup] ${jobs.length} pending result(s)`);

  for (const job of jobs) {
    const label = job.partial
      ? `Colibri result (job ${job.id.slice(0, 8)}, PARTIAL — connection died mid-generation: ${job.error})`
      : `Colibri result (job ${job.id.slice(0, 8)})`;
    const text = `${label}:\n\n${job.result}`;
    try {
      execFileSync(process.execPath, [
        "dist/index.js", "message", "send",
        "--channel", CHANNEL,
        "--target", TARGET,
        "--message", text,
      ], { cwd: "/app", stdio: ["ignore", "pipe", "pipe"] });

      const ack = await fetch(`${MCP_URL}/pending/${job.id}/ack`, { method: "POST" });
      if (!ack.ok) {
        console.error(`[colibri-followup] job=${job.id} sent but ack failed: HTTP ${ack.status}`);
      } else {
        console.error(`[colibri-followup] job=${job.id} delivered + acked`);
      }
    } catch (err) {
      console.error(`[colibri-followup] job=${job.id} delivery FAILED: ${err.message}`);
      // Leave undelivered — next run (10 min) retries.
    }
  }
}

main().catch(err => {
  console.error(`[colibri-followup] fatal: ${err.message}`);
  process.exit(1);
});
