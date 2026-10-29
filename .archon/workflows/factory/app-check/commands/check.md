# Black-box factory app check

Test the prepared checkout at `$INPUTS.checkout` (merged commit `$INPUTS.merged`) as a user. Do not edit it, push, comment, or inspect the PR description. The issue body below is the acceptance contract; MISSION.md supplies the core journeys.

Issue: $INPUTS.issue

```markdown
$INPUTS.issue_body
```

Changed files: `$INPUTS.files`. Depth: `$INPUTS.depth`. App config: `$INPUTS.config`.

1. `cd` to the prepared checkout. Read MISSION.md and the issue criteria. Load `agent-browser skills get core --full` before browser work.
2. Choose a free localhost port. Start the configured command with the configured port variable and a fresh temporary DB variable. Record only that PID in `$ARTIFACTS_DIR/app-check/app.pid`; wait for the configured health path. Never kill by name or close browser sessions you did not open.
3. At light depth, start/smoke and check each criterion. At normal depth, also exercise each criterion through the UI and the core add/list/toggle/remove journeys. At deep depth, cover boundary/error states too.
4. When holdouts are enabled, only now read scenario files in the configured holdout directory. Run every scenario at deep depth; at normal depth run those relevant to the changed behavior; none at light. Report only its `H-<id>`, verdict, and visible result.
5. Save screenshots, logs, and observations under `$ARTIFACTS_DIR/app-check/`. Open every screenshot you cite. Close only browser sessions you opened and stop only the recorded app PID.

Write `report.md` and `result.json` there. `result.json` is `{ "overall": "PASS|FAIL", "lines": [string...], "summary": string }`. Every line must be exactly:

`C<n>  PASS|FAIL|INCOMPLETE  <one sentence>  evidence: <file>`

or `H-<id>` in place of `C<n>`. Use one evidence file per line, relative to the app-check artifact folder or absolute. INCOMPLETE means the check could not finish and counts as failure. Overall is PASS only if every line passes. Put the identical lines in report.md. Return the same object.
