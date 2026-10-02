/** Auditor tests — ported from the Python behaviour (mock verdicts + env gate). */
import { afterEach, describe, expect, it } from "vitest";
import { getAuditor, LLMAuditor, MockAuditor } from "../src/audit.ts";

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

describe("MockAuditor (offline/CI path)", () => {
  it("approves a clean trace whose goal signal fired", () => {
    const v = new MockAuditor().audit("buy a mouse", [{ desc: "click add", executed: true }], true);
    expect(v).toEqual({ verdict: "APPROVE", reasons: ["trace clean, goal signal present"], auditor: "mock" });
  });

  it("rejects a risky step executed without confirmation", () => {
    const v = new MockAuditor().audit("buy", [{ desc: "pay now", risky: true, executed: true, confirmed: false }], true);
    expect(v.verdict).toBe("REJECT");
    expect(v.reasons[0]).toContain("risky step executed without confirmation: pay now");
  });

  it("rejects when the goal-completion signal never fired", () => {
    const v = new MockAuditor().audit("buy", [], false);
    expect(v.verdict).toBe("REJECT");
    expect(v.reasons).toContain("goal-completion signal never fired");
  });

  it("does not flag a confirmed risky step", () => {
    const v = new MockAuditor().audit("buy", [{ desc: "pay", risky: true, executed: true, confirmed: true }], true);
    expect(v.verdict).toBe("APPROVE");
  });
});

describe("getAuditor (env gate)", () => {
  it("falls back to the mock when the endpoint is unconfigured", () => {
    expect(getAuditor()).toBeInstanceOf(MockAuditor);
  });

  it("falls back to the mock on a half-configured env (key without base url)", () => {
    process.env.OPENAI_API_KEY = "k";
    expect(getAuditor()).toBeInstanceOf(MockAuditor);
  });

  it("builds an LLMAuditor when both env vars are present", () => {
    process.env.OPENAI_API_KEY = "k";
    process.env.OPENAI_BASE_URL = "https://llm.example/v1/";
    const a = getAuditor();
    expect(a).toBeInstanceOf(LLMAuditor);
    expect((a as LLMAuditor).baseUrl).toBe("https://llm.example/v1");   // trailing slash trimmed
    expect((a as LLMAuditor).model).toBe("gpt-4o-mini");
  });
});
