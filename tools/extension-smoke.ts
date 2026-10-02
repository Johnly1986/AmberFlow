#!/usr/bin/env node
/**
 * MV3 extension end-to-end smoke — the TypeScript twin of
 * `test_extension_load.py` (Path B), and the shared harness of
 * `ts/tests/extension.test.ts`.
 *
 *   node --experimental-strip-types tools/extension-smoke.ts
 *
 * The loop it runs, field for field the same as the Python test:
 *   local static server (the twin of `python -m http.server 8899`) → unpacked
 *   chromium (MV3, `--headless=new`) → `testpages/product.html` → dispatch the
 *   `laya-trigger` DOM hook → content.js extracts the page state → the MV3
 *   service worker POSTs it to picker-server → the decision comes back → the
 *   panel renders the candidates → clicking one clicks the PAGE element.
 *
 * The protocol it exercises (read off `extension/`, which is used verbatim):
 *   - `content.js:92` — `document.addEventListener("laya-trigger", runPicker)`
 *     is a payload-free DOM event on `document` that runs the SAME handler as
 *     the Ctrl+Shift+K command (`background.js:6-11` sends
 *     `{type:"PICKER_TRIGGER"}` to the tab, `content.js:85-87` listens for it).
 *     The DOM hook exists because Playwright cannot evaluate inside an MV3
 *     service worker on this chromium.
 *   - `content.js:70` sends `{type:"PICKER_STATE", state: extractState()}`;
 *     `extractState()` yields `{url, title, main_text (first 600 chars of
 *     <main>), visible_buttons (visible button/a innerText, <= 20)}`.
 *   - `background.js:15` POSTs `{state}` to `http://127.0.0.1:8765/pick` and
 *     answers `{ok:true, decision}` or `{ok:false, error}` — so the picker
 *     server CANNOT move off 8765 (the port is hardcoded in the extension).
 *   - `content.js:27-67` renders `#laya-panel`: heading =
 *     `decision.reason || "laya suggestion"`, one `<button>` per candidate with
 *     text `` `${label}  ${(p*100).toFixed(1)}%` `` whose onclick runs
 *     `clickBySelector(candidate.selector)`; it self-removes after 15 s.
 *   - `decision.auto_execute === true` skips the panel and clicks `selector`.
 *
 * Exit codes: 0 PASS, 1 FAIL, 2 SKIP (no full chromium / extension or fixtures
 * missing / 127.0.0.1:8765 busy / the extension never registered a service
 * worker). `tests/extension.test.ts` asserts on `runExtensionScenario()`'s
 * observations, so the scenario is implemented once and never forked.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import * as browserEnv from "../src/browser-env.ts";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  startPickerServer,
  type PickerLike,
  type PickerServerHandle,
} from "../src/picker-server.ts";
import type { PickDecision } from "../src/picker.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `extension/` and `testpages/` live at the repo root, one level above `tools/`. */
export const EXTENSION_DIR = path.resolve(HERE, "..", "extension");
export const TESTPAGES_DIR = path.resolve(HERE, "..", "testpages");
/** The DOM-event hook of `content.js:92`; the hotkey reaches the same handler. */
export const TRIGGER_EVENT = "laya-trigger";
/** `background.js:4` hardcodes this address, so the server has no port freedom. */
export const PICKER_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The environment cannot run this test at all (no full chromium build, no
 * extension on disk, port 8765 taken, extension never loaded...). The test
 * turns this into `ctx.skip()`; a plain `Error` is a real failure.
 */
export class EnvUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EnvUnavailable";
  }
}

/* ------------------------------------------------------------------ preflight */

export interface Preflight {
  ok: boolean;
  reason: string;
}

/**
 * Sync environment check (usable in `describe.skipIf`).
 *
 * `chromiumCandidates()` returns the headless shell too, but MV3 extensions only
 * load in the full build — the same split `browser_env.launchKwargs` encodes.
 */
export function preflight(): Preflight {
  const full = browserEnv.chromiumCandidates().filter((c) => !path.basename(c).includes("headless"));
  if (!full.length) {
    return { ok: false, reason: "no full chromium build found (only the headless shell); run `npx playwright install chromium`" };
  }
  if (!fs.existsSync(path.join(EXTENSION_DIR, "manifest.json"))) {
    return { ok: false, reason: `unpacked extension not found at ${EXTENSION_DIR}` };
  }
  for (const fixture of ["product.html", "cart.html"]) {
    if (!fs.existsSync(path.join(TESTPAGES_DIR, fixture))) {
      return { ok: false, reason: `fixture ${fixture} not found in ${TESTPAGES_DIR}` };
    }
  }
  return { ok: true, reason: "" };
}

/* --------------------------------------------------------------- static server */

export interface StaticServer {
  url: string;
  root: string;
  close(): Promise<void>;
}

/**
 * The `python -m http.server 8899 --directory testpages` twin: a tiny read-only
 * file server on an ephemeral port (the extension does not know the port, only
 * the page URL does, so there is no reason to fight over 8899).
 */
export async function startStaticServer(root: string = TESTPAGES_DIR): Promise<StaticServer> {
  const server = http.createServer((req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad request");
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad request");
      return;
    }
    const file = path.resolve(root, `.${decoded === "/" ? "/product.html" : decoded}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream",
        "Content-Length": data.length,
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => { server.off("listening", onListening); reject(err); };
    const onListening = (): void => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, DEFAULT_HOST);
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  return {
    root,
    url: `http://${DEFAULT_HOST}:${port}`,
    async close(): Promise<void> {
      if (!server.listening) return;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();   // keep-alive sockets would stall close()
      });
    },
  };
}

/* ------------------------------------------------------------- scripted picker */

export type DecisionScript = (state: Record<string, unknown>) => PickDecision;

export interface ScriptedPicker {
  /** the injectable `PickerLike` — no ONNX, no 1.7 GB checkpoint */
  picker: PickerLike;
  /** every `state` object the extension actually POSTed, in order */
  requests: Array<Record<string, unknown>>;
  /** replace the decision the next request returns */
  script(next: DecisionScript): void;
}

export function createScriptedPicker(initial: DecisionScript): ScriptedPicker {
  let current = initial;
  const requests: Array<Record<string, unknown>> = [];
  const picker: PickerLike = {
    agent: { device: "scripted" },   // /health has a device without a model
    pick(state: Record<string, unknown>): PickDecision {
      requests.push(state);
      return current(state);
    },
  };
  return { picker, requests, script: (next) => { current = next; } };
}

/**
 * The Python test's shape: the confidence gate hands the decision to the human
 * picker, whose candidate list includes `open_cart` (the one the test clicks).
 */
export function panelDecision(): PickDecision {
  return {
    action: "open_cart",
    probabilities: { open_cart: 0.94, add_to_cart: 0.05, search: 0.01 },
    selector: "a[data-test='cart-link']",
    auto_execute: false,
    reason: "low confidence 0.42 < 0.6 -- show human picker",
    guards: { attack_p: 0, irreversible_p: 0.1, confidence: 0.42 },
    candidates: [
      { label: "open_cart", probability: 0.94, selector: "a[data-test='cart-link']" },
      { label: "add_to_cart", probability: 0.05, selector: "button[data-test='add-to-cart']" },
      { label: "search", probability: 0.01, selector: "input[data-test='search-box']" },
    ],
  };
}

/** The other branch of content.js: `auto_execute` clicks, no panel is rendered. */
export function autoExecuteDecision(): PickDecision {
  return {
    action: "add_to_cart",
    probabilities: { add_to_cart: 0.94 },
    selector: "button[data-test='add-to-cart']",
    auto_execute: true,
    reason: null,
    guards: { attack_p: 0, irreversible_p: 0.1, confidence: 0.94 },
    candidates: [],
  };
}

/**
 * The panel row `content.js:44` renders. `innerText` collapses the double space
 * it writes, so the expected string has a single space.
 */
export function expectedRows(decision: PickDecision): string[] {
  return decision.candidates.map((c) => `${c.label} ${(c.probability * 100).toFixed(1)}%`);
}

/* -------------------------------------------------------------------- browser */

export interface ExtensionSession {
  context: BrowserContext;
  profileDir: string;
  /** `chrome-extension://<id>/background.js` — proof the extension really loaded */
  serviceWorkerUrl: string;
  close(): Promise<void>;
}

/** Waits for the MV3 service worker (the extension's registration signal). */
export async function waitForServiceWorker(context: BrowserContext, timeoutMs = 10_000): Promise<string> {
  const existing = context.serviceWorkers();
  if (existing.length) return existing[0]!.url();
  const worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  return worker.url();
}

/**
 * Launch chromium with the unpacked extension. `launchKwargs(true, dir)` already
 * encodes the MV3 rules (full build only, `--headless=new` instead of
 * `chrome-headless-shell`, `--no-sandbox` under root); the only addition here is
 * that the context must be PERSISTENT: playwright's default args include
 * `--disable-extensions`, which wins over `--load-extension` for a plain
 * `chromium.launch()`, while `launchPersistentContext` is also what
 * `browser_env.launch_persistent_context` uses on the Python side.
 */
export async function launchExtensionSession(): Promise<ExtensionSession> {
  const options = browserEnv.launchKwargs(true, EXTENSION_DIR);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-ext-profile-"));
  const cleanupProfile = (): void => fs.rmSync(profileDir, { recursive: true, force: true });
  let context: BrowserContext;
  try {
    type PersistentOptions = Parameters<typeof chromium.launchPersistentContext>[1];
    context = await chromium.launchPersistentContext(profileDir, options as unknown as PersistentOptions);
  } catch (err) {
    cleanupProfile();
    throw err;
  }
  let serviceWorkerUrl: string;
  try {
    serviceWorkerUrl = await waitForServiceWorker(context);
  } catch (err) {
    await context.close().catch(() => {});
    cleanupProfile();
    throw err;
  }
  return {
    context,
    profileDir,
    serviceWorkerUrl,
    async close(): Promise<void> {
      await context.close().catch(() => {});
      cleanupProfile();
    },
  };
}

/* ------------------------------------------------------------------- driving */

/**
 * Dispatches `laya-trigger` until the picker server has recorded one more
 * request. The event can only be lost while the content script is still being
 * injected, so this retries instead of sleeping a fixed 1500 ms like the Python
 * test; it stops the moment the request lands, which keeps the trigger count at
 * exactly one.
 */
export async function triggerUntilRequest(
  page: Page,
  requests: readonly unknown[],
  before: number,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const dispatch = `document.dispatchEvent(new Event(${JSON.stringify(TRIGGER_EVENT)}))`;
  while (Date.now() < deadline) {
    await page.evaluate(dispatch);
    const settle = Date.now() + 1_500;   // the HTTP hop is localhost; give it room
    while (Date.now() < settle) {
      if (requests.length > before) return true;
      await sleep(50);
    }
  }
  return false;
}

export interface PanelView {
  /** first line of `#laya-panel` innerText = `decision.reason` */
  heading: string;
  /** the lines carrying a `%` — the candidate rows, as the Python test reads them */
  candidates: string[];
}

/** `#laya-panel` as the Python test reads it (wait_for_selector + inner_text). */
export async function waitForPanel(page: Page, timeoutMs = 20_000): Promise<PanelView> {
  await page.locator("#laya-panel").waitFor({ state: "visible", timeout: timeoutMs });
  const text = await page.locator("#laya-panel").innerText();
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return { heading: lines[0] ?? "", candidates: lines.slice(1).filter((line) => line.includes("%")) };
}

/** Poll a condition; `false` keeps waiting, anything else is the result. */
export async function waitFor<T>(
  check: () => Promise<T | false>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(50);
  }
}

/* ------------------------------------------------------------------- scenario */

export interface ExtensionE2EEnv {
  staticServer: StaticServer;
  pickerServer: PickerServerHandle;
  scripted: ScriptedPicker;
  session: ExtensionSession;
  /** Tears everything down; safe to call twice. */
  close(): Promise<void>;
}

/**
 * Bring the whole rig up: static fixtures + picker-server on 8765 + chromium
 * with the unpacked extension. Throws `EnvUnavailable` for anything that means
 * "this box cannot run it" and cleans up after itself on the way out.
 */
export async function setupExtensionE2E(): Promise<ExtensionE2EEnv> {
  const pre = preflight();
  if (!pre.ok) throw new EnvUnavailable(pre.reason);
  const staticServer = await startStaticServer();
  let pickerServer: PickerServerHandle | null = null;
  let session: ExtensionSession | null = null;
  const close = async (): Promise<void> => {
    await session?.close().catch(() => {});
    await pickerServer?.close().catch(() => {});
    await staticServer.close().catch(() => {});
  };
  try {
    const scripted = createScriptedPicker(() => panelDecision());
    try {
      pickerServer = await startPickerServer({
        picker: scripted.picker, host: DEFAULT_HOST, port: DEFAULT_PORT, log: () => {},
      });
    } catch (err) {
      throw new EnvUnavailable(`${PICKER_URL} is not available (${message(err)}) — background.js hardcodes it`);
    }
    try {
      session = await launchExtensionSession();
    } catch (err) {
      throw new EnvUnavailable(`the unpacked MV3 extension could not be loaded (${message(err)})`);
    }
    return { staticServer, pickerServer, scripted, session, close };
  } catch (err) {
    await close();
    throw err;
  }
}

export interface ExtensionScenario {
  /** `chrome-extension://<id>/background.js` */
  serviceWorkerUrl: string;
  /** page URLs served by the local static server */
  productUrl: string;
  cartUrl: string;
  /** phase 1 — the human picker path */
  panelHeading: string;
  panelCandidates: string[];
  /** the exact state the server received (content.js:extractState) */
  panelState: Record<string, unknown>;
  /** where clicking the `open_cart` candidate navigated the page */
  clickedUrl: string;
  /** phase 2 — the auto-execute path */
  autoState: Record<string, unknown>;
  autoButtonText: string;
  autoCartCount: string;
  autoPanelPresent: boolean;
  /** every POST /pick this run made, in order (exactly 2: one per phase) */
  requests: Array<Record<string, unknown>>;
}

export interface ScenarioOptions {
  log?: (line: string) => void;
}

/**
 * The Python test's three assertions plus the auto-execute branch, as one run:
 * there is no way to restart the rig per assertion without paying for a browser
 * launch each time, and the observations are returned, not asserted, here.
 */
export async function runExtensionScenario(opts: ScenarioOptions = {}): Promise<ExtensionScenario> {
  const log = opts.log ?? ((): void => {});
  const env = await setupExtensionE2E();
  try {
    const { scripted, session } = env;
    const productUrl = `${env.staticServer.url}/product.html`;
    const cartUrl = `${env.staticServer.url}/cart.html`;
    log(`service worker  : ${session.serviceWorkerUrl}`);
    log(`page served at  : ${productUrl}`);

    /* 1. the guards hold the click back — the decision reaches the human panel */
    scripted.script(() => panelDecision());
    const page = await session.context.newPage();
    let panelHeading = "";
    let panelCandidates: string[] = [];
    let panelState: Record<string, unknown> = {};
    let clickedUrl = "";
    try {
      await page.goto(productUrl);
      const before = scripted.requests.length;
      if (!(await triggerUntilRequest(page, scripted.requests, before))) {
        throw new Error(`the content script never relayed PICKER_STATE (x${TRIGGER_EVENT} was dispatched repeatedly)`);
      }
      panelState = scripted.requests[before]!;
      const view = await waitForPanel(page);
      panelHeading = view.heading;
      panelCandidates = view.candidates;
      log(`panel heading   : ${panelHeading}`);
      log(`panel candidates: ${JSON.stringify(panelCandidates)}`);

      // clicking a candidate must click the PAGE element content.js resolved
      await page.locator("#laya-panel button", { hasText: "open_cart" }).click();
      await page.waitForURL("**/cart.html", { timeout: 5_000 });
      clickedUrl = page.url();
      log(`candidate click : navigated to ${path.basename(new URL(clickedUrl).pathname)}`);
    } finally {
      await page.close();
    }

    /* 2. auto_execute: content.js clicks directly, no panel */
    scripted.script(() => autoExecuteDecision());
    const autoPage = await session.context.newPage();
    let autoState: Record<string, unknown> = {};
    let autoButtonText = "";
    let autoCartCount = "";
    let autoPanelPresent = false;
    try {
      await autoPage.goto(productUrl);
      const before = scripted.requests.length;
      if (!(await triggerUntilRequest(autoPage, scripted.requests, before))) {
        throw new Error(`the content script never relayed PICKER_STATE on the auto-execute run`);
      }
      autoState = scripted.requests[before]!;
      autoButtonText = await waitFor(async () => {
        const text = await autoPage.locator("[data-test='add-to-cart']").innerText();
        return text.includes("Added") ? text : false;
      }, 5_000, "the auto-executed click to change the button");
      autoCartCount = await autoPage.locator("[data-test='cart-count']").innerText();
      autoPanelPresent = (await autoPage.locator("#laya-panel").count()) > 0;
      log(`auto exec       : button=${JSON.stringify(autoButtonText)} cart-count=${autoCartCount} panel=${autoPanelPresent}`);
    } finally {
      await autoPage.close();
    }

    if (scripted.requests.length !== 2) {
      throw new Error(`expected exactly 2 POST /pick (one per phase), got ${scripted.requests.length}`);
    }
    return {
      serviceWorkerUrl: session.serviceWorkerUrl,
      productUrl, cartUrl,
      panelHeading, panelCandidates, panelState, clickedUrl,
      autoState, autoButtonText, autoCartCount, autoPanelPresent,
      requests: scripted.requests,
    };
  } finally {
    await env.close();
  }
}

/* ------------------------------------------------------------------ reporting */

/** The CLI's own check list; the vitest twin asserts the same facts granularly. */
export function verifyScenario(result: ExtensionScenario): string[] {
  const failures: string[] = [];
  const wantRows = expectedRows(panelDecision());
  if (result.panelHeading !== panelDecision().reason) {
    failures.push(`panel heading ${JSON.stringify(result.panelHeading)} != reason ${JSON.stringify(panelDecision().reason)}`);
  }
  if (JSON.stringify(result.panelCandidates) !== JSON.stringify(wantRows)) {
    failures.push(`panel candidates ${JSON.stringify(result.panelCandidates)} != ${JSON.stringify(wantRows)}`);
  }
  if (result.clickedUrl !== result.cartUrl) {
    failures.push(`candidate click landed on ${result.clickedUrl}, expected ${result.cartUrl}`);
  }
  if (!result.autoButtonText.includes("Added")) {
    failures.push(`auto_execute did not click the page element (button text ${JSON.stringify(result.autoButtonText)})`);
  }
  if (result.autoCartCount !== "1") {
    failures.push(`auto_execute clicked ${result.autoCartCount} times, expected exactly 1`);
  }
  if (result.autoPanelPresent) failures.push("the auto-execute branch rendered #laya-panel");
  if (result.requests.length !== 2) failures.push(`expected 2 POST /pick, got ${result.requests.length}`);
  return failures;
}

export async function main(opts: ScenarioOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string): void => console.log(line));
  try {
    const result = await runExtensionScenario({ log });
    const failures = verifyScenario(result);
    if (failures.length) {
      for (const failure of failures) log(`FAIL: ${failure}`);
      log("extension e2e   : FAIL");
      return 1;
    }
    log("extension e2e   : PASS");
    return 0;
  } catch (err) {
    if (err instanceof EnvUnavailable) {
      log(`extension e2e   : SKIP — ${err.message}`);
      return 2;
    }
    log(`extension e2e   : FAIL — ${message(err)}`);
    return 1;
  }
}

/* Only when run as a CLI: `tests/extension.test.ts` imports this module. */
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (!process.env.VITEST && entry === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
