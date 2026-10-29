import { describe, expect, test } from "bun:test";
import { DEFAULTS } from "../../../../scripts/factory-config.ts";
import { matchingFiles } from "../../.shared/utils.ts";
import { oldestUnchecked } from "../scripts/select.ts";
import { scopeDecision } from "../scripts/scope.ts";
import { datedScopeAllows } from "../scripts/policy.ts";
import { evidenceProblems } from "../scripts/evidence.ts";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("app-check deterministic decisions", () => {
  test("matches anchored frontend globs", () => {
    expect(matchingFiles(["src/a/site.css", "src/views.ts", "src/server.ts"], DEFAULTS.app_check.frontend_paths)).toEqual(["src/a/site.css", "src/views.ts"]);
  });
  test("uses size labels for auto depth and skips backend-only changes", () => {
    expect(scopeDecision(DEFAULTS, ["src/server.ts"], ["archon-size-l"])).toEqual({ run: false, depth: "deep", reason: "skipped: no front-end change" });
    expect(scopeDecision(DEFAULTS, ["public/app.css"], ["archon-size-s"]).depth).toBe("light");
  });
  test("selects the oldest non-draft unchecked head", () => {
    const row = (number: number, createdAt: string, isDraft = false) => ({ number, createdAt, isDraft, headRefOid: `h${number}`, baseRefName: "main", files: [], body: "" });
    expect(oldestUnchecked([row(2, "2026-02-01"), row(1, "2026-01-01"), row(3, "2025-01-01", true)], new Set(["h1"]))?.number).toBe(2);
  });
  test("requires a dated current-scope ruling naming protected paths", () => {
    const body = "## Current scope (maintainer ruling on scope, 2026-10-29)\nOwner permits `.archon/` for this factory change.\n## Acceptance\nDone.";
    expect(datedScopeAllows(body, [".archon/factory.yaml"])).toBe(true);
    expect(datedScopeAllows("## Current scope\n.archon/", [".archon/factory.yaml"])).toBe(false);
  });
  test("seals evidence and rejects incomplete-as-pass", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-evidence-test-"));
    const preparedAt = Date.now();
    const evidence = join(root, "shot.txt");
    writeFileSync(evidence, "observed");
    utimesSync(evidence, new Date(preparedAt + 1000), new Date(preparedAt + 1000));
    const line = "C1  PASS  Add flow works.  evidence: shot.txt";
    expect(evidenceProblems({ overall: "PASS", lines: [line] }, line, root, preparedAt)).toEqual([]);
    const incomplete = "C1  INCOMPLETE  Browser stopped.  evidence: shot.txt";
    expect(evidenceProblems({ overall: "PASS", lines: [incomplete] }, incomplete, root, preparedAt)).toContain("overall must be FAIL");
  });
});
