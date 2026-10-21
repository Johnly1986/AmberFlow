/**
 * Camera-entry driver tests: the form/type tables vs the real fixtures, the
 * sheet-type business rule, the router seam, verbatim filling (including the
 * <select> path) and the four-row demo run (3 entered + 1 rejected).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEMO_ROWS, FORMS, PAGES, TYPE_TO_FORM, XLSX, decideForm, fillForm, main, route, shortReason,
  type RouterWithPredict,
} from "../src/cli/camera-entry.ts";
import type { ChoiceAnswer, NoulAnswer } from "../src/model/model.ts";

const html = (f: string): string => fs.readFileSync(path.join(PAGES, f), "utf-8");

describe("form tables match the fixtures", () => {
  it("every selector exists on its page", () => {
    const a = html("camera_a.html");
    const b = html("camera_b.html");
    const portal = html("portal.html");
    for (const sel of [FORMS.form_a.entry, FORMS.form_b.entry]) {
      expect(portal).toContain(sel.match(/data-test='([^']+)'/)![1]!);
    }
    for (const [k, sel] of Object.entries(FORMS.form_a.fields)) {
      expect(a, `form_a.${k}`).toContain(sel.match(/data-test='([^']+)'/)![1]!);
    }
    expect(a).toContain("a-submit");
    for (const [k, sel] of Object.entries(FORMS.form_b.fields)) {
      expect(b, `form_b.${k}`).toContain(sel.match(/data-test='([^']+)'/)![1]!);
    }
    expect(b).toContain("b-submit");
  });

  it("maps the sheet's device families to the two pages", () => {
    expect(TYPE_TO_FORM).toEqual({ 枪机: "form_a", 筒机: "form_a", 球机: "form_b", PTZ: "form_b" });
  });
});

describe("decideForm — the sheet's 类型 column is a first-class rule", () => {
  it("lets a recognised type override the model (and logs a disagreement)", () => {
    const r = decideForm({ device_type: "枪机" }, "form_b", 0.3);
    expect(r.form).toBe("form_a");
    expect(r.source).toBe("sheet:type=枪机 (model disagreed: form_b@0.30)");
  });

  it("follows the model when the type is blank or unknown", () => {
    expect(decideForm({ device_type: null }, "form_b", 0.92).form).toBe("form_b");
    expect(decideForm({ device_type: "" }, "form_a", 0.92).form).toBe("form_a");
    expect(decideForm({ device_type: "摄像机" }, "form_b", 0.92)).toMatchObject({ form: "form_b" });
  });

  it("CAMERA_ROUTE=model makes the model decide every row", () => {
    expect(decideForm({ device_type: "枪机" }, "form_b", 0.8, "model")).toEqual({
      form: "form_b", source: "model:form_b",
    });
  });
});

describe("route() — the Router seam", () => {
  const makeRouter = () => {
    const calls: string[] = [];
    const loaded = new Set<string>();
    const router: RouterWithPredict = {
      default: "english",
      loaded,
      route: (state) => {
        calls.push("route");
        const serial = String((state as { serial?: unknown }).serial ?? "");
        return { model: serial.startsWith("PTZ") ? "multilingual" : "english", reason: "script detection; details" };
      },
      unload: () => { calls.push("unload"); loaded.clear(); },
      load: async () => { throw new Error("not used"); },
      predict: async () => {
        calls.push("predict");
        return {
          answers: {
            route: { choice: "form_b", probabilities: { form_b: 0.92 }, confidence: 0.92 } as ChoiceAnswer,
            mismatch: { noul: 0.1 } as NoulAnswer,
          },
          routing: { model: "multilingual", reason: "script detection; details" },
        };
      },
    };
    return { router, calls, loaded };
  };

  it("returns choice/conf/mismatch/routing and frees a resident checkpoint before a swap", async () => {
    const { router, calls, loaded } = makeRouter();
    loaded.add("english");                       // a checkpoint is resident
    const r = await route(router, { serial: "PTZ-2001", device_type: null });
    expect(r).toMatchObject({ choice: "form_b", conf: 0.92, mismatch: 0.1 });
    expect(r.routing.model).toBe("multilingual");
    expect(calls).toEqual(["route", "unload", "predict"]);   // unload BEFORE predict
    expect(shortReason(r.routing.reason)).toBe("script detection");
  });

  it("does not unload when the checkpoint is already the right one", async () => {
    const { router, calls, loaded } = makeRouter();
    loaded.add("multilingual");
    await route(router, { serial: "PTZ-2001" });
    expect(calls).not.toContain("unload");
  });

  it("cleans NaN/None cells into empty strings before routing", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const router = {
      default: "english", loaded: new Set<string>(),
      route: (s: Record<string, unknown>) => { seen.push(s); return { model: "english" }; },
      unload: () => {}, load: async () => { throw new Error("x"); },
      predict: async () => ({
        answers: { route: { choice: "form_a", probabilities: {}, confidence: 0.5 }, mismatch: { noul: 0 } },
        routing: { model: "english", reason: "r" },
      }),
    } as unknown as RouterWithPredict;
    await route(router, { serial: "CAM-1", focal: Number.NaN, location: null });
    expect(seen[0]).toEqual({ serial: "CAM-1", focal: "", location: "" });
  });
});

describe("fillForm — verbatim values, <select> by label", () => {
  it("fills inputs and selects the option by its visible label, skipping blanks", async () => {
    const w = await openPage("camera_a.html");
    try {
      await fillForm(w.page, "form_a", {
        serial: "CAM-1001", model: "DS-2CD1143", resolution: "4MP", focal: 4,
        ip: "10.0.0.101", location: "东门入口",
      });
      expect(await w.value("[data-test=a-serial]")).toBe("CAM-1001");
      expect(await w.value("[data-test=a-resolution]")).toBe("4MP");   // <select> picked by label
      expect(await w.value("[data-test=a-focal]")).toBe("4");
      expect(await w.value("[data-test=a-location]")).toBe("东门入口");

      await w.page.reload();
      await fillForm(w.page, "form_a", { serial: "CAM-2", focal: null });
      expect(await w.value("[data-test=a-serial]")).toBe("CAM-2");
      expect(await w.value("[data-test=a-model]")).toBe("");
      expect(await w.value("[data-test=a-resolution]")).toBe("");
    } finally {
      await w.close();
    }
  }, 60_000);
});

describe("main() — the demo sheet end to end", () => {
  it("enters three devices and reports the fourth rejected by the form", async () => {
    expect(fs.existsSync(XLSX)).toBe(true);
    const router = scriptedRouter();
    const code = await main({ router });
    expect(code).toBe(0);       // demo contract: 3 OK + 1 rejected
    expect(DEMO_ROWS).toHaveLength(4);
  }, 120_000);
});

/** A router that infers the family from the serial prefix (what laya roughly does). */
function scriptedRouter(): RouterWithPredict {
  return {
    default: "english",
    loaded: new Set<string>(),
    route: (state) => ({ model: String((state as { serial?: unknown }).serial ?? "").startsWith("PTZ")
      ? "multilingual" : "english", reason: "scripted; ok" }),
    unload: () => {},
    load: async () => { throw new Error("not used"); },
    predict: async (state) => {
      const serial = String((state as { serial?: unknown }).serial ?? "");
      const choice = serial.startsWith("PTZ") ? "form_b" : "form_a";
      return {
        answers: {
          route: { choice, probabilities: { [choice]: 0.92 }, confidence: 0.92 } as ChoiceAnswer,
          mismatch: { noul: 0.05 } as NoulAnswer,
        },
        routing: { model: "english", reason: "scripted; ok" },
      };
    },
  };
}

/** Minimal Playwright page helper (Node API: `.first` is a method). */
async function openPage(file: string) {
  const { chromium } = await import("playwright");
  const browserEnv = await import("../src/browser/browser-env.ts");
  const browser = (await browserEnv.launch({ chromium } as never)) as unknown as {
    newPage(): Promise<unknown>; close(): Promise<void>;
  };
  const page = (await browser.newPage()) as never as {
    goto(u: string, o?: unknown): Promise<void>;
    reload(): Promise<void>;
    locator(s: string): { inputValue(): Promise<string>; selectOption(v: unknown): Promise<void>; fill(v: string): Promise<void>; evaluate(fn: unknown): Promise<unknown> };
    close(): Promise<void>;
  };
  await page.goto(new URL(`file://${path.join(PAGES, file)}`).href);
  return {
    page,
    value: async (sel: string): Promise<string> => page.locator(sel).inputValue(),
    close: async () => { await browser.close(); },
  };
}
