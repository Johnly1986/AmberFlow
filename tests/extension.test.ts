/**
 * MV3 extension end-to-end test — the TypeScript port of `test_extension_load.py`
 * (Path B, 48 lines): content script → background service worker → picker-server
 * → panel DOM → the candidate click.
 *
 * The scenario itself lives in `tools/extension-smoke.ts` (which is also the
 * hand-run CLI `node --experimental-strip-types tools/extension-smoke.ts`); this
 * file asserts on its observations, so the two never drift.
 *
 * Protocol, read off `extension/` (used verbatim, never patched):
 *   - the driver is a payload-free DOM event on `document`
 *     (`content.js:92` → `laya-trigger`), which runs the SAME handler as the
 *     Ctrl+Shift+K command. Playwright cannot evaluate inside an MV3 service
 *     worker on this chromium, which is why the hook exists at all.
 *   - `content.js:70` sends `{type:"PICKER_STATE", state}`; the worker
 *     (`background.js:15`) POSTs `{state}` to `http://127.0.0.1:8765/pick`.
 *   - the panel is `#laya-panel`, its first line is `decision.reason` and each
 *     candidate is a `<button>` reading `` `${label}  ${(p*100).toFixed(1)}%` ``;
 *     clicking it runs `clickBySelector(candidate.selector)` on the page.
 *   - `decision.auto_execute === true` clicks `selector` without a panel.
 *
 * The rig is real chromium + a real `node:http` picker-server; only the picker is
 * injected (a scripted decision), so no ONNX checkpoint is ever loaded. When the
 * box cannot host it (no full chromium build, extension/fixtures missing, port
 * 8765 busy, extension never registers its service worker) the suite SKIPS with
 * the reason printed — `npm test` must not go red for a missing display.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  EnvUnavailable,
  autoExecuteDecision,
  expectedRows,
  panelDecision,
  preflight,
  runExtensionScenario,
  type ExtensionScenario,
} from "../tools/extension-smoke.ts";

const ready = preflight();
if (!ready.ok) console.log(`[extension e2e] skipped: ${ready.reason}`);

describe.skipIf(!ready.ok)("extension e2e: unpacked MV3 + real picker-server (Path B)", () => {
  let scenario: ExtensionScenario | null = null;
  let unavailable = "";

  beforeAll(async () => {
    try {
      scenario = await runExtensionScenario({ log: (line) => console.log(`[extension e2e] ${line}`) });
    } catch (err) {
      // An environment that cannot run this is a skip (see EnvUnavailable);
      // anything else is a real regression and must stay red.
      if (err instanceof EnvUnavailable) unavailable = err.message;
      else throw err;
    }
  }, 180_000);

  const need = (ctx: { skip: () => void }): ExtensionScenario => {
    if (!scenario) {
      console.log(`[extension e2e] skipped: ${unavailable}`);
      ctx.skip();
    }
    return scenario as ExtensionScenario;
  };

  it("the content script's state reaches the server verbatim (content.js → worker → POST /pick)", async (ctx) => {
    const result = need(ctx);
    // the extension really loaded: MV3 service worker registered from disk
    expect(result.serviceWorkerUrl).toMatch(/^chrome-extension:\/\/[a-z]+\/background\.js$/);
    // one POST per dispatched `laya-trigger`, no duplicate triggers
    expect(result.requests).toHaveLength(2);

    // `state` is exactly what `content.js:extractState()` builds
    const state = result.panelState;
    expect(Object.keys(state).sort()).toEqual(["main_text", "title", "url", "visible_buttons"]);
    expect(state.url).toBe(result.productUrl);
    expect(state.title).toBe("Wireless Mouse X200 - Example Shop");
    expect(String(state.main_text)).toContain("Ergonomic 2.4GHz wireless mouse with USB receiver");
    expect(String(state.main_text)).toContain("Free shipping on orders over $50");
    expect((state.visible_buttons as string[])).toContain("Add to cart");
    expect((state.visible_buttons as string[]).some((label) => /cart/i.test(label))).toBe(true);
    // it stays a compact signal, not a DOM dump
    expect((state.visible_buttons as string[]).length).toBeLessThanOrEqual(20);
    expect(String(state.main_text).length).toBeLessThanOrEqual(600);
  });

  it("the panel renders the server's decision, and a candidate click clicks the page element", async (ctx) => {
    const result = need(ctx);
    const decision = panelDecision();
    // heading = `decision.reason || "laya suggestion"` (content.js:38)
    expect(result.panelHeading).toBe(decision.reason);
    // every candidate row, formatted `(probability * 100).toFixed(1)%`
    expect(result.panelCandidates).toEqual(expectedRows(decision));
    // clicking `open_cart` ran clickBySelector("a[data-test='cart-link']") on the page
    expect(result.clickedUrl).toBe(result.cartUrl);
  });

  it("auto_execute clicks the page element instead of rendering a panel", async (ctx) => {
    const result = need(ctx);
    expect(autoExecuteDecision().auto_execute).toBe(true);
    expect(result.autoState.url).toBe(result.productUrl);
    // the fixture's own click handler proves the page element was clicked
    expect(result.autoButtonText).toContain("Added");
    expect(result.autoCartCount).toBe("1");
    expect(result.autoPanelPresent).toBe(false);
  });
});
