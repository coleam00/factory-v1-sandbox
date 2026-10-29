---
name: factory-manager
description: Safely tend Archon attention items from explicit project policy.
---

# Factory manager

Run in periodic mode when invoked by `factory-manager`, or interactively when a person asks.

1. Run `archon workflow attention --json` and parse the current attention items.
2. Read all files in `.archon/sdlc/policy/`, including `maintainers.json` only for identity context.
3. For each item, answer only when one policy line clearly and directly selects one offered choice. From the fresh attention output, use `archon workflow answer <run-id> --occurrence <occurrence-id> --choose <choice-id>` with optional `--text`. Never infer product scope, approve protected paths, resolve conflicting lines, or treat silence as permission.
4. Leave every ambiguous or uncovered item unanswered and put it in the report with its choices and why policy does not settle it.
5. Inspect run/event timestamps available from the CLI. Report a running run as stuck only after more than two hours with no new event. Never cancel, kill, retry, or mutate a run.
6. For every recurring decision shape observed, suggest one concise policy line that would settle it next time. Suggestions are report text only; never edit policy.
7. Report answered items with the exact policy line used, unanswered items, stuck runs, and policy suggestions. In interactive mode, show the same report before taking any additional action.

If the attention command or policy cannot be read reliably, answer nothing and report the error.
