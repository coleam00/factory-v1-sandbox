import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Depth = "auto" | "light" | "normal" | "deep";
export interface FactoryConfig {
  app_check: { enabled: boolean; trigger: "always" | "frontend" | "never"; frontend_paths: string[]; depth: Depth };
  holdouts: { enabled: boolean; dir: string };
  protected_paths: string[];
  human_in_the_loop: "supervised" | "standard" | "autonomous";
  app: { start: string; port_env: string; db_env: string; health_path: string };
}

export const DEFAULTS: FactoryConfig = {
  app_check: { enabled: true, trigger: "frontend", frontend_paths: ["public/**", "src/views.ts", "src/**/*.css"], depth: "auto" },
  holdouts: { enabled: true, dir: "~/.archon-v1test/holdouts/factory-v1-sandbox" },
  protected_paths: [".archon/**", ".github/**"],
  human_in_the_loop: "standard",
  app: { start: "bun src/server.ts", port_env: "PORT", db_env: "SHELF_DB", health_path: "/" },
};

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown, fallback: string[]) => Array.isArray(value) && value.every(v => typeof v === "string") ? value : fallback;
const choice = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;

export function parseFactoryConfig(raw: string): FactoryConfig {
  const root = object(Bun.YAML.parse(raw));
  const check = object(root.app_check), holdouts = object(root.holdouts), app = object(root.app);
  return {
    app_check: {
      enabled: typeof check.enabled === "boolean" ? check.enabled : DEFAULTS.app_check.enabled,
      trigger: choice(check.trigger, ["always", "frontend", "never"], DEFAULTS.app_check.trigger),
      frontend_paths: strings(check.frontend_paths, DEFAULTS.app_check.frontend_paths),
      depth: choice(check.depth, ["auto", "light", "normal", "deep"], DEFAULTS.app_check.depth),
    },
    holdouts: {
      enabled: typeof holdouts.enabled === "boolean" ? holdouts.enabled : DEFAULTS.holdouts.enabled,
      dir: typeof holdouts.dir === "string" && holdouts.dir.trim() ? holdouts.dir : DEFAULTS.holdouts.dir,
    },
    protected_paths: strings(root.protected_paths, DEFAULTS.protected_paths),
    human_in_the_loop: choice(root.human_in_the_loop, ["supervised", "standard", "autonomous"], DEFAULTS.human_in_the_loop),
    app: {
      start: typeof app.start === "string" && app.start.trim() ? app.start : DEFAULTS.app.start,
      port_env: typeof app.port_env === "string" && app.port_env.trim() ? app.port_env : DEFAULTS.app.port_env,
      db_env: typeof app.db_env === "string" && app.db_env.trim() ? app.db_env : DEFAULTS.app.db_env,
      health_path: typeof app.health_path === "string" && app.health_path.startsWith("/") ? app.health_path : DEFAULTS.app.health_path,
    },
  };
}

export function readFactoryConfig(path = resolve(".archon/factory.yaml")): FactoryConfig {
  try { return parseFactoryConfig(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULTS);
    throw error;
  }
}

if (import.meta.main) console.log(JSON.stringify(readFactoryConfig()));
