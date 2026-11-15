# dsh-fallback-models

A DeepSeek Harness (DSH) plugin that continues a turn on the next model of a configured chain when a model request keeps failing, is refused or is blocked by a provider's content filter. It hooks DSH's request recovery point, after `@deepseek-ai/dsh-llm-retry` has used up its attempts.

## Layout

- `src/policy.js`: which failures may trigger a switch; `src/refusal.js`: refusal and content-filter detection; `src/fallback.js`: the switch and the restore of the session model; `src/notify.js`: the optional message per switch and where it goes; `src/config.js`: settings schema (global chain and per-preset chains); `client.js`: the settings page.
- Tests are in `test/`; each file covers one of those layers. Implementation decisions: `docs/decisions.md`.

## Rules

- Checks: `npm run check` and `npm test`. Node 22 or later.
- For any one failure each model gets at most one attempt, so loops cannot occur. Keep that invariant.
- Switch only on failures that reach the recovery point and where another model could plausibly help.
- An empty chain leaves behaviour unchanged.
- The npm package is `@soffits/dsh-fallback-models`; the client module is registered under that scoped name.
- License: MIT.

## Working on the project

- Everything in the repo (code, docs, commits) is English, except translations and files deliberately in another language.
- User-facing text is English first. Only when a project is localised at all, French is the second full language (a real translation); Chinese may be added when it's cheap, but the README and release notes don't mention it. No localisation layer is added just to have one.
- Ordinary implementation choices are yours: decide, write the choice and its one-line reason under the right system group of `docs/decisions.md` (replacing any line it supersedes, no dates), and mention it in your report. Product decisions (what players get, direction, scope, taste) belong to the maintainers and live in `docs/roadmap.md` only; ask about those.
- If a requested approach looks weaker than an alternative, say so with the reason before building it.
- Report each state separately: implemented, tested (which checks, which real run), committed, pushed, CI. Say plainly what was not verified.
- Commit on a branch as you go. Merge to `main`, tag, release or publish only when the task asks for it.
- Work only in this checkout, on the current branch. Make no folders or worktrees outside it; builds people test come from the build's own output folder, given by path. Temporary files go under the build folder or a git-ignored path and are removed when done.

## Delegating to subagents

Do the work yourself, in your own session, by default: design, code, fixes and review. A subagent starts cold, re-reads what you already know and hands back a summary you must check, so it usually costs more than it saves. Hand off only work that is simple and would burn your context for little (a mechanical sweep over many files, a long log to search, a bulk rename), to a smaller, cheaper model that fits the job.

- A brief says what and why, not how: the goal, the decisions that apply, the non-obvious constraints, which files it owns, the checks that decide "done", and a progress file to write early and update after each step. Leave out methods nobody chose, so a capable model can find a better way.
- When you do hand off, parallel subagents only on disjoint files. Each shared helper has one owner; tell the others to use it or wait for it.
- A subagent's summary is a claim. Read its diff and rerun the checks before building on it.
- If a review is asked for, the reviewer is at least as strong as the writer (a weaker reviewer makes strong code worse) and marks each finding *likely* (hits ordinary use: data loss, crash, wrong result) or *rare* (hostile input, odd timing, limits nobody reaches). Fix the likely ones with a regression test; put rare ones in `docs/queue.md` unless the fix is cheap and local.

## Long work

- Any run can be cut off (limits, restarts, context compaction). For work longer than a few steps, keep `docs/progress/<task>.md`: the goal, what is done, decisions, what is next. Update it after each meaningful step so a fresh session resumes without redoing work. End it with `## Final` (what was done, checked, left over). It is a working note: when the work merges, move what lasts into the decisions and queue docs and delete the file.
- Finish the whole goal in one run. Don't end your turn to "wait" for something while work remains you can do.
- Leftovers and known bugs go into `docs/queue.md` the moment you find them, not into a promise in your report.

## Before building

- Before writing any non-trivial component, search the community and current research for maintained libraries and better approaches. Check the licence (MIT/Apache/BSD/CC0 to ship; GPL, non-commercial and unlicensed work only as ideas, reimplemented), upkeep, and that it runs on our versions. Adopt, adapt or write our own, and record why in `docs/decisions.md`.
- Take versions of languages, tools, frameworks and dependencies from current official sources, not memory; they change faster than training data.

## Code

- No backward compatibility while the project has no users: when a format or name changes, change it everywhere and delete the old one.
- Few general mechanisms, no special cases. When something breaks, fix the shared layer or the data, not the one call site. No hard-coded lists of names, no matching on error text, hostnames or model names as a substitute for a real signal.
- Define each list, limit or constant once and derive variants from it.
- Reproduce a bug before fixing it; a confident guess from reading code is often wrong. If two fixes built on one assumption fail, the assumption is the bug.
- CI is where tests run. Locally, compile and run only a quick check you need while writing; push the branch and let CI run the suites.
- Keep CI time low. CI runs on pull requests and `main`, not on every branch push. One release is one branch and one pull request (no stacked PRs per feature). Commit locally as often as you like; push and open the PR when the first sizeable part compiles, keep working on the same branch, and push the next batch when ready (a newer push cancels the older run). Don't sit watching a run (no sleep-and-poll loops): keep working and check its result between steps; when nothing but the CI result is left, say so in your report and end the turn. Never wait on a test run: if a local run is truly needed (a failure CI can't explain), run it in the background, keep writing code, and fix what it reports when it ends. Write each check once, at the cheapest level that can see it (unit test when no running game or server is needed, an integration or game test only for what needs one, a client or screenshot test only for what needs the screen), and extend an existing test before adding one that repeats its setup. Docs-only changes start no run (`paths-ignore` on both triggers), but GitHub judges a pull request by its whole diff, so push docs and progress notes together with the next code batch, never alone to a PR that has code.
- If a test can't pass, explain why in the progress file. Never loosen or move an assertion to make it green.
- Split a file by responsibility before it grows past about 500 lines (generated code and static data excepted).
- No dead code, commented-out code or bare `TODO`; unfinished work is in `docs/queue.md`.
- README and other public docs are for users. Notes for maintainers and agents go here or in `docs/`.

## Git

- Conventional Commits, one-line subjects, a body only when the why isn't obvious. The repo's local author identity is set on purpose; commits use it as configured, since rewriting authors later means rewriting history.
- Squash merges by default. Whoever merges a branch deletes it, local and remote, in the same step (`gh pr merge --squash --delete-branch`), removes its worktree and runs `git fetch --prune`; only `main` and the current release branch stay.
- PR titles are Conventional Commit subjects (`feat: ...`, `fix(scope): ...`), because a squash merge makes the title the commit on the default branch; CI checks it.
- Versions follow semver, and the bump comes from the commit types since the last tag, not from feel: below 1.0, `feat` or a breaking change (`!` / `BREAKING CHANGE`) is a minor bump and `fix`/`perf` a patch; from 1.0, breaking is major, `feat` minor, `fix` patch; docs/ci/chore/test alone need no release. The release check (`.github/workflows/release-check.yml`, `.github/scripts/release-bump-check.py`) fails a tag whose bump is too small; run the script with the new version before tagging.
- In GitHub Actions, reference well-known actions by major tag (`@v5`), not by commit SHA.
