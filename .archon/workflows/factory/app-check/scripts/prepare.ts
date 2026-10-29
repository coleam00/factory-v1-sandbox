import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emit, env, run } from "../../.shared/utils.ts";

const base = env("base"), head = env("head"), pr = env("pr");
const temp = mkdtempSync(join(tmpdir(), "factory-app-check-"));
const artifactRoot = join(process.env.ARTIFACTS_DIR!, "app-check");
mkdirSync(artifactRoot, { recursive: true });
writeFileSync(join(artifactRoot, "temp-path.txt"), temp);
run(["git", "fetch", "origin", base, `pull/${pr}/head:refs/factory/app-check-${pr}`]);
run(["git", "worktree", "add", "--detach", temp, `origin/${base}`]);
run(["git", "merge", "--no-edit", head], { cwd: temp });
run(["bun", "install"], { cwd: temp });
emit({ temp, merged: run(["git", "rev-parse", "HEAD"], { cwd: temp }), prepared_at: Date.now() });
