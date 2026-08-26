# profile.md — work history for cover-letter drafting

Copy this file to `profile.md` (gitignored — never committed, same pattern as
`.env`/`.env.example`) and fill it in with your actual background. `draft.mjs`
reads `profile.md` and hands it to colibri alongside each posting to generate
a draft cover letter. If `profile.md` doesn't exist, `--drafts` is a no-op
(logs a warning and skips drafting entirely) rather than sending colibri a
placeholder.

Keep this concise — everything here gets prepended to every draft prompt, and
colibri's usable context shrinks fast once prefill time is on the table (see
the parent README's colibri section). A few tight paragraphs beats a full
resume dump.

---

## Summary

One or two sentences: who you are professionally, what you're looking for.

## Experience

- **[Most recent role]** — [Company], [dates]. 2-3 bullets on what you
  actually did, weighted toward accomplishments relevant to the tracks in
  `config.json` (esports/gaming ops, IT/DevOps, producer/PM).
- **[Prior role]** — [Company], [dates]. Same.

## Skills

Comma-separated or bulleted list of concrete skills/tools relevant to the
tracks you're targeting.

## Preferences

- Comp floor:
- Location/remote constraints:
- Anything you want every draft to avoid claiming or emphasizing:
