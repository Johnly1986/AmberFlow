/**
 * Cross-implementation parity check: run the SAME corpus through the TS port and
 * compare against the expectations computed by the Python reference implementation
 * (`tools/gen_parity_corpus.py` writes them with `layaapp.rules`).
 *
 * This is the mechanical proof that the port is equivalent instead of merely
 * "tests copied over": any branch that drifted shows up as a named mismatch.
 *
 *   cd ts && node --experimental-strip-types tools/parity.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractSlots, type ElemPool } from "../src/engine/extraction.ts";
import { affordanceRule, hintMatch, navRule } from "../src/engine/rules.ts";

interface Case {
  name: string;
  kind: "hint" | "nav" | "affordance" | "slots";
  elems?: ElemPool;
  hint?: string | null;
  instruction?: string;
  expected: unknown;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(here, "parity-corpus.json"), "utf-8")) as { cases: Case[] };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

let failed = 0;
const mismatches: string[] = [];
for (const c of corpus.cases) {
  const got =
    c.kind === "hint" ? hintMatch(c.hint!, c.elems!)
    : c.kind === "nav" ? navRule(c.instruction!, c.elems!)
    : c.kind === "affordance" ? affordanceRule(c.instruction!, c.elems!, c.hint ?? undefined)
    : extractSlots(c.instruction!);
  if (!same(got, c.expected)) {
    failed++;
    mismatches.push(`${c.name}: ts=${JSON.stringify(got)} python=${JSON.stringify(c.expected)}`);
  }
}

console.log(`parity: ${corpus.cases.length - failed}/${corpus.cases.length} cases identical`);
if (failed) {
  console.log("MISMATCHES:");
  for (const m of mismatches) console.log("  -", m);
  process.exit(1);
}
console.log("VERDICT: TS 移植与 Python 参考实现逐例一致（hint 语法 / nav / affordance / slots）");
