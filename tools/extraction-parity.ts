/**
 * Cross-runtime extraction parity: run the TS port over the fixtures the Python
 * reference just dumped (`tools/dump_extraction.py`) and compare the element
 * tuples field by field. Any drift in ordering, labels, hrefs, frame namespacing
 * or the shadow/DOM walk shows up as a named diff.
 *
 *   python3 ts/tools/dump_extraction.py
 *   cd ts && node --experimental-strip-types tools/extraction-parity.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import * as browserEnv from "../src/browser-env.ts";
import { extractElements } from "../src/extraction.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");
const ref = JSON.parse(fs.readFileSync(path.join(here, "extraction-python.json"), "utf-8")) as {
  fixtures: string[];
  elements: Record<string, Array<Record<string, unknown>>>;
};
const FIELDS = ["ref", "tag", "label", "data_test", "href", "frame"] as const;

const browser: any = await browserEnv.launch({ chromium } as never);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

let mismatched = 0;
for (const rel of ref.fixtures) {
  await page.goto(pathToFileURL(path.join(REPO, rel)).href, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  const elems = await extractElements(page as never);
  const got = Object.values(elems)
    .map((e) => Object.fromEntries(FIELDS.map((f) => [f, (e as Record<string, unknown>)[f] ?? null])))
    .sort((a, b) => String(a.ref).localeCompare(String(b.ref)));
  const want = ref.elements[rel]!;
  const same = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${same ? "OK  " : "DIFF"} ${rel}: ts=${got.length} python=${want.length}`);
  if (!same) {
    mismatched++;
    for (let i = 0; i < Math.max(got.length, want.length); i++) {
      if (JSON.stringify(got[i]) !== JSON.stringify(want[i])) {
        console.log(`   [${i}] ts=${JSON.stringify(got[i])}`);
        console.log(`   [${i}] py=${JSON.stringify(want[i])}`);
        if (i > 4) break;
      }
    }
  }
}
await browser.close();

if (mismatched) {
  console.log(`\nVERDICT: ${mismatched}/${ref.fixtures.length} fixtures differ`);
  process.exit(1);
}
console.log(`\nVERDICT: extractElements 与 Python 参考实现在 ${ref.fixtures.length} 个夹具上逐元素一致`);
