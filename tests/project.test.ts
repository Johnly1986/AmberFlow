/**
 * Project-level guards. These are not about behaviour — they protect the
 * properties that make the port usable as a project:
 *
 *  - `node --experimental-strip-types` is the tool-script runtime (parity tools,
 *    plan CLI). It cannot strip TypeScript PARAMETER PROPERTIES, so a stray
 *    `constructor(public x: T)` silently breaks every tool script that imports
 *    the module. The guard below failed for real during the migration.
 *  - the public surface must actually export the application layer
 *    (`layaapp/__init__.py`'s twin).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".ts"));

/** Matches `constructor(` … `public|private|protected|readonly X` in parameters. */
function hasParameterProperty(src: string): boolean {
  const ctors = [...src.matchAll(/constructor\s*\(([\s\S]*?)\)\s*\{/g)];
  return ctors.some((m) => /\b(public|private|protected)\s+\w+\s*[:?=]/.test(m[1]!) ||
    /(^|[,(\s])readonly\s+\w+\s*[:?=]/.test(m[1]!));
}

describe("strip-only compatibility (tool scripts run on node --experimental-strip-types)", () => {
  it.each(files)("%s has no constructor parameter properties", (f) => {
    const src = fs.readFileSync(path.join(SRC, f), "utf-8");
    expect(hasParameterProperty(src), `${f}: parameter property breaks strip-only`).toBe(false);
  });

  it("the checker catches a real parameter property (not a no-op guard)", () => {
    expect(hasParameterProperty("class A { constructor(public x: number) {} }")).toBe(true);
    expect(hasParameterProperty("class A { x: number; constructor(x: number) { this.x = x; } }")).toBe(false);
    // a readonly ARRAY type is not a parameter property
    expect(hasParameterProperty("class A { constructor(x: readonly string[]) {} }")).toBe(false);
  });
});

describe("public surface (the layaapp/__init__ twin)", () => {
  it("exports the application layer", () => {
    for (const name of [
      "BrowserMiddleware", "browserSession", "TaskPlan", "PlanningRules", "checkSignal",
      "runPlan", "runSubgoalWithRetries", "LLMPlanner", "ScriptedPlanner",
      "extractElements", "hintLookup", "criteriaView", "esig", "firstIfSame", "extractSlots",
      "navRule", "affordanceRule", "hintMatch", "MockAuditor", "getAuditor",
      "QuickActionPicker", "createLayaOnnxRuntime", "installLayaRuntime",
      "loadSpec", "deriveSubgoals", "migrationMetrics", "snapshotText",
      "main", "BenchMiddleware", "buildPlan", "settingsUrl",
    ]) {
      expect(api, `missing export: ${name}`).toHaveProperty(name);
    }
    // `datasource` is namespaced because its `main` would collide with plan-cli's
    expect(typeof api.datasource.runSource).toBe("function");
    expect(typeof api.datasource.main).toBe("function");
  });

  it("keeps the two `main`s reachable and distinct", () => {
    expect(api.main).not.toBe(api.datasource.main);
  });
});

describe("package scripts keep the verification entry points", () => {
  it("exposes typecheck/test/parity/plan-cli", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf-8"));
    for (const s of ["typecheck", "test", "parity", "parity:extraction", "parity:executor", "plan-cli"]) {
      expect(Object.keys(pkg.scripts), `missing script ${s}`).toContain(s);
    }
  });
});
