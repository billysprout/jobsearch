---
name: tailor
description: Generate a job-posting-tailored resume via the local colibri model. Use when the user asks to tailor their resume for a posting from the jobscrape digests (e.g. "/tailor gh-riotgames-8120735" or "tailor my resume for the Riot TPM role").
---

# /tailor — tailored resume for a scraped job posting

Runs `jobscrape/tailor.mjs`, which feeds the master resume
(`jobscrape/resume.md`, with `[v1]`/`[v2]` wording variants), the candidate
profile, and the full job description to the local GLM-5.2-colibri model.
The model selects the relevant bullets, resolves each variant to the single
wording that best matches the posting, and emits a clean two-page markdown
resume. It is instructed never to invent facts.

## Steps

1. **Identify the posting.** If the user gave a posting ID (looks like
   `gh-riotgames-8120735`), use it directly. If they described the job
   (company/title), run `node jobscrape/tailor.mjs --list` from the repo
   root, find the best match among the listed IDs, and confirm the pick
   with the user if more than one plausibly matches.

2. **Run the tailoring.**
   ```
   node jobscrape/tailor.mjs --posting <id>
   ```
   This is a colibri call — expect **10+ minutes** (359 GB disk-streamed
   MoE; latency notes in the parent README). Use a generous Bash timeout
   (600000 ms max) and if it times out, offer to re-run it in the
   background instead. Warn the user before starting that this is slow.

3. **Surface the result.** On success the tailored resume is:
   - printed to stdout (capture and show it),
   - written to `postings/<id>-tailored.md` on the sandbox workspace
     volume (visible to the in-sandbox agent),
   - and optionally copied locally with `--out FILE`.

4. **Close the loop with the user.** The output is a DRAFT for the human
   to review and drop into their real resume template (the .docx master
   in Downloads). Verify especially: variant selection ([v1] vs [v2]
   claims should not leak into the text), metrics the user has not yet
   confirmed, and anything that reads as invented. colibri is instructed
   not to fabricate, but review is still the user's job.

## Flags

- `--date YYYY-MM-DD` — pin the lookup to one day's digest
- `--out FILE` — also save a local markdown copy
- `--local-only` — skip the workspace-volume write
- `--list` — show all tailorable posting IDs with scores

## Notes

- Tailoring writes only markdown. For the generic (untailored) PDF that
  already lives in the workspace, that's `render-resume.mjs` — different
  job, don't conflate them.
- Colibri must be running on the host (port 8000) or the call fails fast
  with a connection error.
