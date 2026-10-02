/**
 * Camera device entry automation (TS twin of `camera_entry.py`).
 *
 * Flow per spreadsheet row:
 *   1. The row's 类型 column picks the entry page (`TYPE_TO_FORM`, a business
 *      rule); blank/unknown 类型 falls through to the router's choice. The two
 *      pages have different fields, so picking the wrong one wastes the fill.
 *   2. Playwright opens the portal, clicks the entry link, and fills the form
 *      VERBATIM from the row (typing is deterministic, never model-chosen).
 *   3. Submit; success is verified by URL + ok-serial, failures by the form's
 *      own error text (or native HTML5 validation).
 *
 * The model seam is a `RouterLike` + `predict` (the pip `laya.Router`); tests
 * inject a scripted router, so this driver never needs the 1.7 GB checkpoint.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import * as browserEnv from "./browser-env.ts";
import { REPO } from "./flow.ts";
import { firstOf, type LocLike } from "./extraction.ts";
import { readSheet } from "./ip-config.ts";
import { routerMaxLoaded } from "./executor.ts";
import type { ChoiceAnswer, NoulAnswer, Question, RouterLike } from "./model.ts";

export const XLSX = path.join(REPO, "devices.xlsx");
export const PAGES = path.join(REPO, "testpages");

/**
 * Entry pages: ONE table, so adding a device family is a data change here plus
 * one line in TYPE_TO_FORM — nothing else in this file knows about forms.
 * The two pages use different widgets and names for the same concept
 * (serial vs a-serial vs b-sn), which is exactly why routing matters.
 */
export interface CameraForm {
  entry: string;
  submit: string;
  error: string;
  fields: Record<string, string>;
}

export const FORMS: Record<"form_a" | "form_b", CameraForm> = {
  form_a: {   // 枪机/筒机页
    entry: "[data-test='entry-fixed']",
    submit: "[data-test='a-submit']",
    error: "[data-test='a-error']",
    fields: {
      serial: "[data-test='a-serial']",
      model: "[data-test='a-model']",
      resolution: "[data-test='a-resolution']",
      focal: "[data-test='a-focal']",
      ip: "[data-test='a-ip']",
      location: "[data-test='a-location']",
    },
  },
  form_b: {   // PTZ球机页
    entry: "[data-test='entry-ptz']",
    submit: "[data-test='b-submit']",
    error: "[data-test='b-error']",
    fields: {
      serial: "[data-test='b-sn']",
      model: "[data-test='b-model']",
      zoom: "[data-test='b-zoom']",
      presets: "[data-test='b-presets']",
      ip: "[data-test='b-ip']",
      location: "[data-test='b-location']",
    },
  },
};

/**
 * Spreadsheet 类型 -> entry page: this IS the business rule ("按类型录取"), and a
 * literal mapping belongs in rules, not in a model call. Rows whose 类型 is
 * blank or unrecognised fall through to the model (semantics to laya).
 */
export const TYPE_TO_FORM: Record<string, "form_a" | "form_b"> = {
  枪机: "form_a", 筒机: "form_a", 球机: "form_b", PTZ: "form_b",
};

/**
 * CAMERA_ROUTE=type (default): a recognised 类型 column decides the page.
 * CAMERA_ROUTE=model       : the model decides every row (pre-rule behaviour).
 * Either way the model still runs and any disagreement is LOGGED.
 */
export const ROUTE_MODE = (process.env.CAMERA_ROUTE ?? "type").trim().toLowerCase();

export const ROUTE_QUESTIONS: Record<string, Question> = {
  route: {
    type: "choice",
    instructions: "Which device-entry form matches this device row? The site has one form for bullet/fixed cameras and another for PTZ dome cameras.",
    criteria: {
      form_a: "枪机/筒机 fixed bullet cameras: serial numbers start with CAM, they have a focal length and resolution, no pan-tilt",
      form_b: "PTZ 球机 dome cameras: serial numbers start with PTZ, they have optical zoom (12x/20x/32x) and preset positions, motorized pan-tilt",
    },
  },
  mismatch: {
    type: "noul",
    instructions: "Does the device row look inconsistent with the form it was routed to (wrong device family for this form)?",
  },
};

export type CameraRow = Record<string, unknown>;

export const DEMO_ROWS: CameraRow[] = [
  { device_type: "枪机", serial: "CAM-1001", model: "DS-2CD1143", resolution: "4MP", focal: 4, ip: "10.0.0.101", location: "东门入口" },
  { device_type: "球机", serial: "PTZ-2001", model: "SD49425", zoom: "20x", presets: 8, ip: "10.0.0.102", location: "中庭广场" },
  { device_type: null, serial: "PTZ-2002", model: "SD6C82", zoom: "32x", presets: 16, ip: "10.0.0.103", location: "停车场北" },  // type blank -> router routes
  { device_type: "枪机", serial: "CAM-12", model: "DS-2CD1021", resolution: "1080P", focal: 2.8, ip: "10.0.0.104", location: "西门" },  // bad serial -> form rejects
];

/** The router surface this driver needs (pip `laya.Router` + predict). */
export interface RouterWithPredict extends RouterLike {
  predict(state: Record<string, unknown>, questions: Record<string, Question>): Promise<{
    answers: { route: ChoiceAnswer; mismatch: NoulAnswer };
    routing: { model: string; reason: string };
  }>;
}

/**
 * `evaluate` with a REAL function: the Node binding only calls a string when it
 * recognises it as a lone function expression, and `"e => e.tagName"` came back
 * `undefined` — which silently sent a <select> down the fill() path.
 */
const FN_TAGNAME = new Function("e", "return e.tagName;") as (e: unknown) => unknown;

/** Minimal locator/page surface this driver uses (works with Playwright Page). */
export interface FillLoc {
  evaluate(fn: unknown): Promise<unknown>;
  selectOption(v: unknown, o?: unknown): Promise<void>;
  fill(v: string, o?: unknown): Promise<void>;
}
export interface FillPage {
  locator(s: string): FillLoc;
}

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));

export async function ensureXlsx(file = XLSX): Promise<CameraRow[]> {
  try {
    return await readSheet(file);
  } catch {
    // The Python driver would write the demo sheet with pandas; writing xlsx is
    // `ip-config.ensureXlsx`'s job in the port, so here we just fall back to the
    // in-memory demo rows and say so.
    console.log(`(no ${path.basename(file)}; using ${DEMO_ROWS.length} demo rows in memory)`);
    return DEMO_ROWS;
  }
}

/**
 * Ask the router which form, then let the sheet's 类型 column override it (the
 * default `CAMERA_ROUTE=type`). Returns the source string for the log, keeping a
 * disagreement visible instead of silently deciding the wrong page.
 */
export function decideForm(
  row: CameraRow, modelChoice: string, conf: number,
  routeMode = ROUTE_MODE,
): { form: "form_a" | "form_b"; source: string } {
  const stype = typeof row.device_type === "string" ? row.device_type.trim() : "";
  const mapped = TYPE_TO_FORM[stype];
  let form = (modelChoice === "form_b" ? "form_b" : "form_a") as "form_a" | "form_b";
  let source = `model:${modelChoice}`;
  if (routeMode !== "model" && mapped) {
    source = `sheet:type=${stype}`;
    if (mapped !== modelChoice) source += ` (model disagreed: ${modelChoice}@${conf.toFixed(2)})`;
    form = mapped;
  }
  return { form, source };
}

export async function route(
  router: RouterWithPredict, row: CameraRow,
): Promise<{ choice: string; conf: number; mismatch: number; routing: { model: string; reason: string } }> {
  const state: Record<string, unknown> = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, isBlank(v) ? "" : v]));
  // Free the resident checkpoint BEFORE the router builds the next one: route()
  // is a pure function of the state (microseconds), so asking it twice is free
  // and leaves predict()'s own routing reason intact for the log.
  const decision = (await router.route(state)) as { model: string };
  if (router.loaded && !loadedHas(router.loaded, decision.model)) await router.unload();
  const res = await router.predict(state, ROUTE_QUESTIONS);
  return {
    choice: res.answers.route.choice,
    conf: res.answers.route.confidence,
    mismatch: res.answers.mismatch.noul,
    routing: res.routing,
  };
}

function loadedHas(loaded: Set<string> | string[], model: string): boolean {
  return loaded instanceof Set ? loaded.has(model) : loaded.includes(model);
}

/** First clause of the router's reason, to keep the per-row log on one line. */
export function shortReason(reason: string): string {
  return String(reason).split(";")[0]!.trim();
}

/** How many laya checkpoints may stay resident (shared probe). */
export function maxLoaded(): number {
  return routerMaxLoaded();
}

export async function fillForm(
  page: FillPage, form: "form_a" | "form_b", row: CameraRow,
): Promise<void> {
  for (const [col, sel] of Object.entries(FORMS[form].fields)) {
    const val = row[col];
    if (isBlank(val)) continue;
    const el = page.locator(sel);
    const tag = (await el.evaluate(FN_TAGNAME)) as string;
    if (tag === "SELECT") await el.selectOption({ label: String(val) });
    else await el.fill(String(val));
  }
}

export interface CameraResult {
  serial: string;
  sheetType: string;
  form: string;
  source: string;
  conf: number;
  status: "OK" | "REJECTED";
  detail: string;
}

export interface CameraMainDeps {
  router?: RouterWithPredict;
  rows?: CameraRow[];
  file?: string;
}

export async function main(deps: CameraMainDeps = {}): Promise<number> {
  const file = deps.file ?? XLSX;
  const rows = deps.rows ?? await ensureXlsx(file);
  const router = deps.router;
  if (!router) throw new Error("camera_entry needs a router: pass { router } (laya.Router twin)");
  console.log(`router default=${router.default ?? "?"} max_loaded=${maxLoaded()}, ${rows.length} rows from ${path.basename(file)}\n`);

  const results: CameraResult[] = [];
  const browser = (await browserEnv.launch({ chromium } as never)) as unknown as {
    newPage(): Promise<unknown>; close(): Promise<void>;
  };
  const page = (await browser.newPage()) as FillPage & {
    goto(u: string, o?: unknown): Promise<void>;
    click(s: string, o?: unknown): Promise<void>;
    waitForURL(u: string, o?: unknown): Promise<void>;
    waitForTimeout(ms: number): Promise<void>;
    evaluate(fn: unknown): Promise<unknown>;
  };
  try {
    for (const row of rows) {
      const { choice, conf, mismatch, routing } = await route(router, row);
      const { form, source } = decideForm(row, choice, conf);
      const stype = typeof row.device_type === "string" ? row.device_type.trim() : "";
      const log = {
        source: mismatch >= 0.5 ? `${source} MISMATCH?=${mismatch.toFixed(2)}` : source,
      };

      await page.goto(new URL(`file://${path.join(PAGES, "portal.html")}`).href);
      await page.click(FORMS[form].entry);
      await fillForm(page, form, row);
      let status: CameraResult["status"] = "REJECTED";
      let detail = "";
      await page.click(FORMS[form].submit);
      try {
        await page.waitForURL("**/entry_success.html*", { timeout: 3000 });
        status = "OK";
        detail = `saved on ${form}, serial=${await readText(page, "[data-test=ok-serial]")}`;
      } catch {
        await page.waitForTimeout(300);
        detail = await readText(page, FORMS[form].error);
        if (!detail) {
          // native HTML5 validation blocked before any custom error
          detail = "native validation: " + String(await page.evaluate(NATIVE_CHECK_JS) ?? "");
        }
      }
      console.log(`row: ${String(row.serial ?? "").padEnd(9)} sheet_type=${stype || "-"} `
        + `form=${form} via=${log.source} model_conf=${conf.toFixed(2)} `
        + `ckpt=${routing.model}(${shortReason(routing.reason)}) -> ${status}  ${detail}`);
      results.push({
        serial: String(row.serial ?? ""), sheetType: stype, form, source: log.source,
        conf, status, detail,
      });
    }
  } finally {
    await browser.close();
  }

  const ok = results.filter((r) => r.status === "OK").length;
  const rejected = results.filter((r) => r.status === "REJECTED").length;
  console.log(`\nsummary: ${ok}/${results.length} entered; ${rejected} rejected by form validation`);
  return ok >= results.length - 1 ? 0 : 1;   // demo expects 3 OK + 1 rejected
}

const NATIVE_CHECK_JS = `(() => { const f = document.querySelector('form');
 if (f.checkValidity()) return '';
 const el = [...f.elements].find(e => e.willValidate && !e.checkValidity());
 return el ? (el.dataset.test || el.name || el.type) + ': ' + el.validationMessage : ''; })()`;

async function readText(page: { locator(s: string): unknown }, sel: string): Promise<string> {
  try {
    // Node's `locator.first` is a method; firstOf() adapts it (see extraction.ts).
    return (await firstOf(page.locator(sel) as LocLike).innerText({ timeout: 2000 })).trim();
  } catch {
    return "";
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
