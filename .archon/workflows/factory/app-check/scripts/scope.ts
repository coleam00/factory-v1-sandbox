import type { FactoryConfig } from "../../../../scripts/factory-config.ts";
import { emit, env, jsonEnv, matchingFiles, postStatus } from "../../.shared/utils.ts";

export function scopeDecision(config: FactoryConfig, files: string[], labels: string[]) {
  const depth = config.app_check.depth === "auto"
    ? labels.includes("archon-size-l") ? "deep" : labels.includes("archon-size-s") ? "light" : "normal"
    : config.app_check.depth;
  if (!config.app_check.enabled || config.app_check.trigger === "never") return { run: false, depth, reason: "skipped: app check disabled" };
  if (config.app_check.trigger === "frontend" && matchingFiles(files, config.app_check.frontend_paths).length === 0)
    return { run: false, depth, reason: "skipped: no front-end change" };
  return { run: true, depth, reason: "selected" };
}

if (import.meta.main) {
  const decision = scopeDecision(jsonEnv<FactoryConfig>("config", {} as FactoryConfig), jsonEnv("files", []), jsonEnv("labels", []));
  if (!decision.run) postStatus(env("repo_path"), env("head"), "success", "factory/app-check", decision.reason);
  emit(decision);
}
