import type { FactoryConfig } from "../../../../scripts/factory-config.ts";
import { emit, env, jsonEnv, matchingFiles, postStatus } from "../../.shared/utils.ts";

export function datedScopeAllows(body: string, paths: string[]): boolean {
  const sections = [...body.matchAll(/^#{1,6}\s+Current scope[^\r\n]*(\d{4}-\d{2}-\d{2})[^\r\n]*$([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/gim)];
  const dated = sections.filter(match => Boolean(match[1]) && !Number.isNaN(Date.parse(match[1]!))).at(-1)?.[2] ?? "";
  return paths.length > 0 && paths.every(path => dated.includes(path) || dated.includes(path.split("/")[0] + "/"));
}

if (import.meta.main) {
  const config = jsonEnv<FactoryConfig>("config", {} as FactoryConfig), files = jsonEnv<string[]>("files", []);
  const protectedFiles = matchingFiles(files, config.protected_paths);
  const ok = protectedFiles.length === 0 || datedScopeAllows(env("issue_body"), protectedFiles);
  const description = ok ? "policy clear" : "protected path: needs an owner ruling";
  postStatus(env("repo_path"), env("head"), ok ? "success" : "failure", "factory/policy", description);
  emit({ ok, protected_files: protectedFiles, description });
}
