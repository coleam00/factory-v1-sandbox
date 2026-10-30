# Shelf

Shelf is a small, server-rendered personal reading list. Add books, mark them read or unread, remove them, and filter or order the shelf; the data is stored locally in SQLite.

## Run

Requires [Bun](https://bun.sh/).

```sh
bun install
bun run dev
```

Open <http://localhost:3000>. Use `PORT` to choose another port and `SHELF_DB` to choose another database path (the default is `shelf.db`). For a non-watching process, run `bun start`.

To download a JSON copy of the shelf, open `/books/export.json` at the listening URL printed when Shelf starts (for example, `http://localhost:3000/books/export.json`); the complete reading list downloads as `shelf.json`.

## Test

```sh
bun test
bun run typecheck
```

## Factory

This repository adopts the project-scoped factory package alongside Archon's bundled SDLC pack. It does not copy or override files under `.archon/workflows/sdlc/`.

### Workflows

- `factory-backlog --input repo_path=OWNER/REPO --input number=N` slices a PRD issue into ordered, deduplicated issues. Use `prd_path=path/to/prd.md` instead of `number` for a checked-in PRD.
- `factory-holdouts --input repo_path=OWNER/REPO --input number=N` writes private black-box scenarios only to the configured external directory. It never posts scenario content to GitHub.
- `factory-app-check --input repo_path=OWNER/REPO [--input pr=N]` checks an eligible PR head merged with the current base head, runs the isolated app through `agent-browser`, seals evidence, and publishes the `factory/app-check` and `factory/policy` statuses.
- `factory-manager --input repo_path=OWNER/REPO` answers only attention decisions explicitly settled by `.archon/sdlc/policy/`. It reports untouched questions and stale runs and can suggest policy lines without writing them.
- `factory-deploy --input revision=<full-commit-sha>` performs only the revision-aware deployment documented in `DEPLOY.md`. It is never scheduled or enabled by setup.
- `factory-setup` validates `.archon/factory.yaml`, applies managed autonomy blocks while preserving surrounding policy prose, and writes supported project model configuration.

Factory workflow fixtures are dry-run stubs. They do not create issues, comments, statuses, merges, triggers, or deployments. Exercise them with:

```sh
archon workflow test .archon/workflows/factory
```

### Configuration and setup

`.archon/factory.yaml` is the project-owned factory configuration:

- `project.repo_host` and `project.repo_path` identify `github.com/coleam00/factory-v1-sandbox`.
- `app_check.enabled` controls app checking. `app_check.trigger` is `always`, `frontend`, or `never`; `frontend` matches changed files against `frontend_paths`.
- `app_check.depth` is `light`, `normal`, `deep`, or `auto`. Auto maps `archon-size-s` to light, `archon-size-l` to deep, and other or missing sizes to normal.
- `holdouts.enabled` controls private scenarios. `holdouts.path` is the absolute external Shelf holdout path. Do not inspect that directory during implementation.
- `protected_paths` contains repository-root globs checked by `factory/policy`.
- `autonomy` selects the `supervised`, `standard`, or `autonomous` managed policy preset.
- `app.prepare`, `app.start`, `app.port_env`, `app.database_env`, and `app.health_path` tell app-check how to prepare and start an isolated app and detect readiness.
- `models.assistant` is explicitly `codex`. Empty `models.tiers` and `models.aliases` inherit the all-Codex profiles from the sandbox Archon home.
- `triggers.enabled` remains `false`. The root operator owns the existing external timer configurations and schedules, so setup does not generate or register replacements.

After changing factory configuration, run setup from this checkout and inspect the completed run and exact diff:

```sh
archon workflow run factory-setup --detach
archon workflow attention --json
archon workflow get <run-id> --json
git diff -- .archon
```

Setup writes only marked managed blocks in triage, build, and merge policy files. Shelf-specific prose, `rulings.md`, and `maintainers.json` remain project-owned. With triggers disabled, setup writes no trigger JSON and never installs or fires a timer.

### App-check and merge protection

`factory-app-check` tests a PR head merged with the current base tip. Publication rereads the PR and fails if its head or base changed. A pending status older than two hours is eligible for recovery. Evidence must be newer than preparation, every check line must cite a real file, and `INCOMPLETE` is failure.

GitHub branch protection for `main` should require the repository CI check, `factory/app-check`, and `factory/policy`, with strict up-to-date branches enabled. Protected-path changes fail closed unless an operator-launched run supplies an exact grant for the selected head and complete changed protected-file set. The workflow does not merge PRs.

### External holdouts

Holdouts remain outside the checkout at the absolute project-specific `holdouts.path`. Public reports contain scenario IDs and visible outcomes, not scenario text. External placement is context separation, not an operating-system security boundary; use host-level isolation when a hard boundary is required.

### Deployment

`DEPLOY.md` authorizes a later root-operator acceptance deployment on localhost port 4197. It does not authorize setup to deploy and grants no production, remote-host, cloud, or database-migration authority. A later operator may run `factory-deploy` only for an exact full commit SHA and must verify health plus deployed revision as documented there.

### Pack composition

Archon loads project workflows beside its bundled workflows. This package uses factory-specific names and leaves the bundled SDLC pack in the engine checkout. The normal path is backlog slicing, native intake and build queues, holdout writing where required, app-check, native merge queue, and policy-bound management. Deployment remains a separate explicit operator action.
