/**
 * QuickActionPicker tests: the three gates, driven by a scripted model runtime
 * (no checkpoint). Ported from the picker's measured guard behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTIONS, buildQuestions, DESTRUCTIVE, QuickActionPicker } from "../src/picker.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer } from "../src/model.ts";

interface Script { action?: string; actionConf?: number; irreversible?: number; attack?: number }

function install(script: Script): void {
  const agent = scriptedAgent((key): Answer | undefined => {
    if (key === "action") {
      const probs: Record<string, number> = { [script.action ?? "add_to_cart"]: script.actionConf ?? 0.9 };
      for (const k of Object.keys(ACTIONS)) if (!(k in probs)) probs[k] = (1 - (script.actionConf ?? 0.9)) / (Object.keys(ACTIONS).length - 1);
      return { choice: script.action ?? "add_to_cart", probabilities: probs, confidence: script.actionConf ?? 0.9 };
    }
    if (key === "irreversible") return { noul: script.irreversible ?? 0.1 };
    if (key === "page_attack") return { noul: script.attack ?? 0.0 };
    return undefined;
  });
  installLayaRuntime(scriptedRuntime(agent));
}

beforeAll(() => install({}));
afterAll(() => installLayaRuntime(null));

const pick = async (s: Script) => {
  install(s);
  const p = new QuickActionPicker({});
  return p.pick({ url: "https://shop.example/p/1", title: "Product", main_text: "Wireless Mouse" });
};

describe("action registry", () => {
  it("carries the nine actions and two destructive ones (Python parity)", () => {
    expect(Object.keys(ACTIONS)).toHaveLength(9);
    expect([...DESTRUCTIVE].sort()).toEqual(["apply_coupon", "checkout"]);
    expect(ACTIONS.add_to_cart![1]).toBe("button[data-test='add-to-cart']");
  });

  it("builds the three guard questions with a criteria map for the choice", () => {
    const q = buildQuestions();
    expect(Object.keys(q)).toEqual(["action", "irreversible", "page_attack"]);
    expect(Object.keys(q.action!.criteria as Record<string, unknown>)).toHaveLength(9);
  });
});

describe("the three gates", () => {
  it("auto-executes a confident, safe action and reports the selector", async () => {
    const d = await pick({ action: "add_to_cart", actionConf: 0.94, irreversible: 0.1 });
    expect(d.auto_execute).toBe(true);
    expect(d.reason).toBeNull();
    expect(d.selector).toBe("button[data-test='add-to-cart']");
    expect(d.guards.attack_p).toBe(0);
    expect(d.candidates).toHaveLength(3);
  });

  it("blocks on suspected prompt injection before anything else", async () => {
    const d = await pick({ attack: 0.99 });
    expect(d.auto_execute).toBe(false);
    expect(d.reason).toContain("suspected prompt injection");
    expect(d.reason).toContain("0.99");
  });

  it("hands low confidence to the human picker with top candidates", async () => {
    const d = await pick({ actionConf: 0.31 });
    expect(d.auto_execute).toBe(false);
    expect(d.reason).toContain("low confidence 0.31 < 0.6");
  });

  it("requires confirmation for an irreversible action", async () => {
    const d = await pick({ action: "product_details", actionConf: 0.9, irreversible: 0.83 });
    expect(d.auto_execute).toBe(false);
    expect(d.reason).toBe("destructive/irreversible -- requires user confirmation");
  });

  it("requires confirmation for a destructive action even at low irreversible score", async () => {
    const d = await pick({ action: "checkout", actionConf: 0.9, irreversible: 0.05 });
    expect(d.auto_execute).toBe(false);
    expect(d.reason).toContain("requires user confirmation");
  });

  it("honours the (formerly hardcoded) irreversible threshold", async () => {
    install({ action: "product_details", actionConf: 0.9, irreversible: 0.4 });
    const p = new QuickActionPicker({}, 0.6, 0.95, 0.3);   // tightened gate
    const d = await p.pick({ url: "u" });
    expect(d.auto_execute).toBe(false);
    expect(d.reason).toContain("requires user confirmation");
  });
});
