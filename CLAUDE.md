# Book3 — session handoff note

Mobile-first PWA for one student of the teacher ("shuanmaker"): vocabulary from the student's own textbooks.
Learning forms: **選擇題 + 拼字** (no flashcards) and **克漏字** (短文多格 4 選 1 + 單句). Spin-off of Vocaboo
(`shuanmaker-web/vocab-app`, separate repo, **do not touch it**). Read `README.md` for data formats and build scripts.
Reply to the teacher in Traditional Chinese; keep customary English terms (push, repo, commit, VERSION, PWA, FSRS …) in English.

## Status
- Local git repo only (`main`), **no remote yet, nothing published**. Still needed from the teacher: an empty GitHub repo under
  `shuanmaker-web` (then `add_repo(..., access=push)`), the landing-page logo/illustration, and the real 核單 material.
- Name Book3, default theme lavender (`#9381E0`), icons = Vocaboo's (as requested).

## NEVER push before the teacher says CONFIRM ⚠️
"remember don't push before i CONFIRM." Make the change → verify it locally → show the result → **wait for an explicit OK** →
only then `git push`. Committing locally is fine; pushing, creating a remote branch or publishing in any other way is not.
This holds even after the site goes live (then students are on it too — treat `main` as production).

## Textbook order = unit order ⚠️
The textbook (龍騰) goes: **Lesson 1, 2, 3, Review 1, Lesson 4, 5, 6, Review 2, …** and the units must be in that order everywhere
(range picker, progress, cloze list). A unit number only sets the order:
- Lesson N → `@unit N` (shown as "Lesson N").
- Review units are slotted between lessons with a decimal and a display name: `@unit 3.5 Review 1`, `@unit 6.5 Review 2`
  (shown as Review 1 / Review 2, short tag R1 / R2 in narrow columns). Later reviews follow the same pattern (Review 3 comes after the
  lesson it follows, e.g. `@unit 8.5 Review 3` if it follows Lesson 8 — confirm against the book).
- Lessons not yet added (1–3, 7, 8 …) use their real number, so adding them later never renumbers existing units.
- The display name is defined in `words.txt`; `cloze.txt` repeats only the number. Never renumber an existing unit.

## Vocabulary rule (龍騰)
- Each lesson's vocabulary = **words in bold + words marked yellow** inside the lesson's **blue-dotted-line context passages**.
  (Title highlights are not inside the passages — only included when they clearly are vocabulary; tell the teacher.)
- Chinese for bold words is copied from the page; yellow-only words have no printed gloss → pos/中文 written by Claude and must be
  flagged for the teacher's review. Example sentence = the passage sentence the word appears in.
- A word already collected from an earlier unit (same spelling and part of speech) is **not** collected again; different senses may
  get their own entry (the builder separates same spelling by pos). List skipped words in the report to the teacher.
- Photos are the only source; transcribe from the page, never from memory. Phrases and proper nouns are included when bold/yellow.

## Cloze rule
- Each word bank has its own cloze set (`@bank` in `tools/material/cloze.txt`). 龍騰 questions are made **from the lesson passages**:
  short-passage cloze = the passage verbatim with vocabulary words blanked (answer = the original word), plus single-sentence questions.
- Distractors: same part of speech/form, clearly wrong in context, **never a second valid answer** (avoid synonyms/near-synonyms);
  the answer's word family must not appear elsewhere in the same passage (it gives it away); answer letters spread evenly.
- Question ids come from unit + order of appearance → only ever **add new questions at the END of a unit**.
- 核單 is still demo data (`@sample`); replace with real content when the teacher provides material.

## Workflow (the whole thing)
1. Edit `tools/material/words.txt` / `cloze.txt` (or app files). Build **words first, then cloze**:
   `python3 tools/build_words.py && python3 tools/build_cloze.py` (both validate and stop with line numbers).
2. Verify locally: `python3 -m http.server 8801` in the repo + headless Chromium (Playwright is installed), 390x844 viewport;
   actually drive the feature and look at screenshots. (Don't `pkill -f` a pattern that appears in your own command line.)
3. If anything students load changed (files in `sw.js` `CORE`: app/html/css/data/icons), **bump `VERSION` in `sw.js`** before publishing
   so returning students get the new version. Doc/tooling-only changes need no bump.
4. Commit locally with the attribution trailers the session asks for. **Push only after the teacher's CONFIRM.**

## Don't break students' saved data ⚠️
Progress (FSRS cards, answers, backups) lives in each student's own phone IndexedDB (`book3-v1`) — not recoverable if corrupted.
- Before any change, tell the teacher in one line whether it can affect existing features or saved progress.
- Data shape, storage keys, IndexedDB schema/version, backup format (`book3` tag) and `sw.js` must stay backward-compatible; migrations
  additive and non-destructive, flagged first.
- Word ids = `b{bank#}-{slug(word)}` (stable under reordering); new banks go at the END of `words.txt`; never reorder/delete `@bank` blocks.
- GitHub Pages shares one browser origin per account: keep the DB name `book3-v1` and cache prefix `book3-` unique (the service worker
  only deletes caches starting with `book3-`; Vocaboo's `v89` cache must survive).

## Conventions
- Keep all asset paths **relative** (site is served from a `/<repo>/` sub-path); `manifest.webmanifest` uses `start_url`/`scope` `./`.
- Vanilla static site, no build step; service worker is network-first with a 6s timeout and offline cache fallback; add new runtime
  assets to `CORE` in `sw.js`.
- Daily new-word quota is per bank and mode (`bank:mode`); learned = answered in both mcq and spell; mastered = learned + spell correct
  + stability ≥ 21 days. New-word order = textbook file order.
