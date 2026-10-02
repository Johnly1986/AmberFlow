/**
 * Parity guard: the corpus expectations come from the PYTHON reference
 * (`tools/gen_parity_corpus.py` runs `layaapp.rules`), so this test fails the
 * moment the TS port drifts from the implementation the project has measured.
 * Regenerate after a deliberate Python-side change:
 *     python3 ts/tools/gen_parity_corpus.py
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractSlots, type ElemPool } from "../src/extraction.ts";
import { affordanceRule, hintMatch, navRule } from "../src/rules.ts";

interface Case {
  name: string;
  kind: "hint" | "nav" | "affordance" | "slots";
  elems?: ElemPool;
  hint?: string | null;
  instruction?: string;
  expected: unknown;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(
  fs.readFileSync(path.join(here, "..", "tools", "parity-corpus.json"), "utf-8"),
) as { cases: Case[] };

describe("cross-implementation parity (TS vs Python reference)", () => {
  it(`holds for all ${cases.length} corpus cases`, () => {
    const mismatches: string[] = [];
    for (const c of cases) {
      const got =
        c.kind === "hint" ? hintMatch(c.hint!, c.elems!)
        : c.kind === "nav" ? navRule(c.instruction!, c.elems!)
        : c.kind === "affordance" ? affordanceRule(c.instruction!, c.elems!, c.hint ?? undefined)
        : extractSlots(c.instruction!);
      if (JSON.stringify(got) !== JSON.stringify(c.expected)) {
        mismatches.push(`${c.name}: ts=${JSON.stringify(got)} python=${JSON.stringify(c.expected)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
