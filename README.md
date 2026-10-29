# Shelf

Shelf is a small, server-rendered personal reading list. Add books, mark them read or unread, and remove them; the data is stored locally in SQLite.

## Run

Requires [Bun](https://bun.sh/).

```sh
bun install
bun run dev
```

Open <http://localhost:3000>. Use `PORT` to choose another port and `SHELF_DB` to choose another database path (the default is `shelf.db`). For a non-watching process, run `bun start`.

## Test

```sh
bun test
bun run typecheck
```

## Factory

This repository adds a project-scoped software-factory layer to Archon's bundled SDLC pack. It does not copy or override any file under `.archon/workflows/sdlc/`.

### Workflows

- `factory-backlog --input repo_path=OWNER/REPO --input number=N` slices a PRD issue into ordered, deduplicated issues. Use `prd_path=path/to/prd.md` instead of `number` for a checked-in PRD. Each issue has Problem, Why, Why now, Outcome, Invariants, and Acceptance, and the first is a runnable end-to-end increment.
- `factory-holdouts --input repo_path=OWNER/REPO --input number=N` writes one to three private black-box scenarios for an issue. It writes only to the configured directory outside the checkout and never posts scenario content to GitHub.
- `factory-app-check --input repo_path=OWNER/REPO [--input pr=N]` selects the oldest eligible PR, including drafts (or the named PR), posts a pending status, merges its head into the selected base commit in a temporary worktree, runs the app through `agent-browser`, seals fresh evidence, and updates one marked PR comment. A failed or incomplete line posts `factory/app-check` failure. A non-front-end change posts success with a skip reason.
- `factory-manager --input repo_path=OWNER/REPO` runs one medium-tier policy agent. Bind it every 30 minutes or to attention events; the workflow contains no timer. It answers only decisions explicitly settled by `.archon/sdlc/policy/`, reports untouched questions and runs with no event for more than two hours, and suggests policy lines without writing them.

`factory/policy` is deterministic and does not parse issue prose. A PR touching a configured protected path fails that status unless the workflow is launched with a JSON `protected_grant` input whose `head` and `paths` exactly equal the selected head and complete changed protected-file set. For example: `--input protected_grant='{"head":"<full-head-sha>","paths":[".archon/factory.yaml"]}'`. Restrict this input to operator-launched runs; the workflow run and its recorded inputs are the audit record. Extra paths, a stale head, malformed JSON, and prose that merely mentions a path all deny the change. The app check still runs so an owner ruling does not hide behavioral evidence.

### Configuration

`.archon/factory.yaml` is the single factory configuration:

- `app_check.enabled` turns app checking on or off.
- `app_check.trigger` is `always`, `frontend`, or `never`. `frontend` matches changed files against `frontend_paths`.
- `app_check.depth` is `light`, `normal`, `deep`, or `auto`; auto maps `archon-size-s` to light, `archon-size-l` to deep, and other or missing sizes to normal.
- `holdouts.enabled` controls private scenarios; `holdouts.dir` must remain outside the repository so normal/deep checks can enumerate scenario IDs before the checker alone reads their contents. Missing configured scenarios fail closed.
- `protected_paths` contains repository-root globs checked by `factory/policy`.
- `human_in_the_loop` is `supervised`, `standard`, or `autonomous`.
- `app.start`, `port_env`, `db_env`, and `health_path` tell the black-box checker how to start an isolated app and detect readiness.

The human-in-the-loop preset is a declaration for the matching project policy in `.archon/sdlc/policy/merge.md`. Keep the corresponding lines there:

- `supervised`: `Ask first: every pull request requires an owner merge ruling.`
- `standard`: `Clear to merge: a bug fix, a small feature inside MISSION.md, tests or docs, with green CI.` and `Ask first: protected paths, schema/dependency changes, or product scope not settled by MISSION.md.`
- `autonomous`: `Clear to merge: every in-scope pull request with a Ready review, green required checks, and no protected path.` and `Ask first: only an explicit policy conflict or unresolved product-scope choice.`

The checked-in policy currently implements `standard`. Changing the preset without changing the policy lines does not silently broaden authority; the manager follows written policy.

### Merge protection

In GitHub branch protection for `main`, enable “Require status checks to pass before merging”, require the repository's CI check, `factory/app-check`, and `factory/policy`, and enable the strict “Require branches to be up to date before merging” option. Strict mode is required: GitHub commit statuses are attached to a head commit, so only the up-to-date rule prevents a previously green head from merging after the base advances but before another factory run posts a status. The app-check status description also carries a fingerprint of the exact base branch name and commit; selection ignores a status for any other base, preparation verifies both fetched commits, and publication turns the result into failure if the PR head or base changed while it ran.

Run this queue with one active launch per repository. For a native binding, use a repository-specific `resource`, `capacity: 1`, and `overlap: "skip"`; pending statuses also make later selectors skip the same head/base. A pending status older than two hours is eligible for a recovery run, while the original run's finalizer normally converts errors to failure immediately. Publication still re-reads the PR, so an accidental concurrent or delayed run cannot publish success for a stale combination. The bundled merge queue already refuses pending or failing checks, requires a clean merge state, and re-reads checks at the PR head. Do not make the app-check workflow itself merge PRs.

### Pack composition and order

Archon loads workflow names globally. To override a bundled SDLC workflow, place a workflow with the same bare YAML filename anywhere under this project's `.archon/workflows/`; the project workflow wins. Its commands and scripts do not fall through to the bundled workflow, so an override must carry every command and script it uses. This factory deliberately uses new bare names and may still `include:` bundled SDLC workflows when composition is needed.

The normal flow is:

1. Run `factory-backlog` for a PRD; created issues re-enter `archon-intake` through their normal issue events.
2. Intake triages each issue. On the plan route, or by hand before build, run `factory-holdouts` for private adjacent coverage.
3. `archon-build-queue` produces and reviews a PR.
4. Run `factory-app-check` while the PR is still a draft. Automatic selection includes drafts, so the required status can conclude before SDLC's CI node marks the PR ready and waits for required checks.
5. The SDLC CI node marks the PR ready; branch protection holds it while the app status is missing, pending, or failed.
6. `archon-merge-queue` merges only after its existing review/CI gate and the required app status pass.
7. Run `factory-manager` periodically or on attention to apply only decisions already covered by policy.

Factory workflow fixtures are dry-run stubs. They never create issues, comments, statuses, or merges; use `archon workflow test .archon/workflows/factory` to exercise them.

Keeping holdouts outside the checkout is context separation, not a filesystem security boundary. An unrestricted Codex process could read that directory; the workflow convention and prompt keep scenario contents out of implementer context and public output, but operating-system isolation is required for a hard boundary.
