// render-resume.mjs — renders jobscrape/profile.md as a plain resume PDF and
// pushes it to the sandbox workspace volume. Format conversion only: no AI
// involvement, nothing tailored per-posting — see pdf.mjs's profileToResumePdf
// for exactly what it does and doesn't do.
//
// Usage:
//   node render-resume.mjs              # write resume.pdf to the workspace volume
//   node render-resume.mjs --out FILE   # also (or only, with --local-only) save a local copy
//   node render-resume.mjs --local-only # skip the volume write entirely

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { profileToResumePdf } from "./pdf.mjs";
import { writeFilesToVolume } from "./volume-writer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = resolve(__dirname, "profile.md");
const config = JSON.parse(readFileSync(resolve(__dirname, "config.json"), "utf8"));

const args = process.argv.slice(2);
const LOCAL_ONLY = args.includes("--local-only");
const outIdx = args.indexOf("--out");
const LOCAL_OUT = outIdx !== -1 ? args[outIdx + 1] : null;

async function main() {
  if (!existsSync(PROFILE_PATH)) {
    console.error("[render-resume] jobscrape/profile.md not found (copy profile.example.md and fill it in) — nothing to render");
    process.exit(1);
  }

  const profile = readFileSync(PROFILE_PATH, "utf8");
  console.error("[render-resume] rendering profile.md -> PDF...");
  const pdfBuffer = await profileToResumePdf(profile);

  if (LOCAL_OUT) {
    writeFileSync(LOCAL_OUT, pdfBuffer);
    console.error(`[render-resume] wrote local copy -> ${LOCAL_OUT}`);
  }

  if (LOCAL_ONLY) {
    console.error("[render-resume] --local-only set, skipping volume write");
    return;
  }

  await writeFilesToVolume({
    volume: config.workspaceVolume,
    // Workspace root, not jobs/ — this isn't a scraped job artifact.
    targetPath: "/home/node/.openclaw/workspace",
    stagingDir: resolve(__dirname, "staging", "resume"),
    files: [{ relPath: "resume.pdf", content: pdfBuffer }],
  });
  console.error("[render-resume] wrote resume.pdf to the workspace volume");
}

main().catch(e => {
  console.error(`[render-resume] FATAL: ${e.message}`);
  process.exit(1);
});
