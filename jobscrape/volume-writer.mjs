// volume-writer.mjs — writes files into the sandbox's openclaw-workspace
// docker volume via a tar-pipe through a one-off alpine container. Extracted
// from scrape.mjs so render-resume.mjs (and anything else host-side) can
// reuse the same mechanism without a live sandbox mount — see docker-compose.yml's
// "NOTHING from the host filesystem is mounted into this container" note for
// why this indirection exists at all.

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stripEmDash } from "./text-filter.mjs";

const execFileP = promisify(execFile);

/**
 * @param {{ volume: string, targetPath: string, stagingDir: string, files: Array<{relPath: string, content: string|Buffer}> }} params
 *   `targetPath` is the absolute in-volume directory files get extracted
 *   under (e.g. "/home/node/.openclaw/workspace/jobs" or just
 *   "/home/node/.openclaw/workspace"). `relPath` is relative to that.
 */
export async function writeFilesToVolume({ volume, targetPath, stagingDir, files }) {
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  for (const { relPath, content } of files) {
    const dest = join(stagingDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, stripEmDash(content));
  }

  console.error(`[volume] staging ${files.length} file(s) into ${volume}:${targetPath}`);

  // The named volume's root ("/w" once mounted here) IS
  // /home/node/.openclaw/workspace inside the gateway container — so a
  // targetPath under that prefix maps to the same subpath under /w.
  const volumeSubpath = targetPath.replace(/^\/home\/node\/\.openclaw\/workspace/, "") || "/";

  // Materialize the tar archive fully in memory first, then hand it to
  // `docker run` in one write, rather than streaming between two live
  // child processes via .pipe(). These archives are tiny (a handful of KB,
  // occasionally a few MB with PDFs) — the streaming approach isn't buying
  // anything, and on Windows piping execFile's stdout directly into another
  // execFile's stdin raced badly: docker's "tar: invalid tar magic" even
  // though the byte count tar reported writing matched what docker received.
  const tarArgs = ["-cf", "-", "-C", stagingDir, "."];
  const { stdout: tarBuffer } = await execFileP("tar", tarArgs, {
    encoding: "buffer",
    maxBuffer: 200 * 1024 * 1024,
  });

  const dockerArgs = [
    "run", "--rm", "-i",
    "-v", `${volume}:/w`,
    "alpine", "sh", "-c", `mkdir -p /w${volumeSubpath} && tar -xf - -C /w${volumeSubpath}`
  ];

  await new Promise((resolvePromise, reject) => {
    const dockerProc = execFile("docker", dockerArgs, { encoding: "buffer" }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`docker: ${err.message}${stderr ? `\n${stderr}` : ""}`));
      else resolvePromise();
    });
    dockerProc.stdin.end(tarBuffer);
  });
}
