import { describe, expect, test } from "bun:test";
import { DEFAULTS, parseFactoryConfig } from "../../../../scripts/factory-config.ts";

describe("factory config", () => {
  test("defaults missing keys", () => {
    const config = parseFactoryConfig("app_check:\n  trigger: always\n");
    expect(config.app_check.trigger).toBe("always");
    expect(config.app_check.frontend_paths).toEqual(DEFAULTS.app_check.frontend_paths);
    expect(config.app.start).toBe("bun src/server.ts");
  });
  test("rejects unknown enum values by defaulting", () => {
    expect(parseFactoryConfig("human_in_the_loop: reckless\n").human_in_the_loop).toBe("standard");
  });
});
