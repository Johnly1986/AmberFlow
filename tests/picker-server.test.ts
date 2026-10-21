/**
 * picker-server tests: a REAL `node:http` server driven through global `fetch`,
 * with the picker injected so no checkpoint — and no onnxruntime — is needed.
 *
 * The request bodies are the ones the extension actually sends:
 * `content.js:extractState()` builds the `state` object, `background.js` wraps
 * it as `{ state }` and POSTs it to `<SERVER>/pick`, then `content.js` reads
 * `decision.auto_execute` / `.selector` / `.reason` / `.candidates`.
 * The server must therefore be field-for-field transparent.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  createPickerServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  main,
  parseServerArgs,
  startPickerServer,
  type PickerLike,
  type PickerServerHandle,
} from "../src/cli/picker-server.ts";
import { ACTIONS, QuickActionPicker, type PickDecision } from "../src/engine/picker.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer } from "../src/model/model.ts";

/* ------------------------------------------------------------------ fixtures */

interface Script {
  action?: string;
  actionConf?: number;
  irreversible?: number;
  attack?: number;
}

/**
 * A real `QuickActionPicker` over a scripted runtime: the exact production pick
 * path (three gates) with the model replaced. `agent` carries a fake device so
 * `/health` has something to report.
 */
function scriptedPicker(script: Script = {}, device = "cpu"): QuickActionPicker {
  const action = script.action ?? "add_to_cart";
  const confidence = script.actionConf ?? 0.94;
  const agent = scriptedAgent((key): Answer | undefined => {
    if (key === "action") {
      const probabilities: Record<string, number> = { [action]: confidence };
      const rest = (1 - confidence) / (Object.keys(ACTIONS).length - 1);
      for (const label of Object.keys(ACTIONS)) if (!(label in probabilities)) probabilities[label] = rest;
      return { choice: action, probabilities, confidence };
    }
    if (key === "irreversible") return { noul: script.irreversible ?? 0.1 };
    if (key === "page_attack") return { noul: script.attack ?? 0.0 };
    return undefined;
  });
  installLayaRuntime(scriptedRuntime(agent));
  return new QuickActionPicker({ device });
}

/** Verbatim shape from `extension/content.js:extractState()` + `background.js`. */
function extensionBody(): { state: Record<string, unknown> } {
  return {
    state: {
      url: "https://shop.example.com/p/123",
      title: "Wireless Mouse X200 - Example Shop",
      main_text: "Wireless Mouse X200. $29.99. In stock. Add to cart now. Free shipping on orders over $50.",
      visible_buttons: ["Add to cart", "Buy now", "Specifications", "Reviews (132)"],
    },
  };
}

async function postPick(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/pick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function withServer(
  picker: PickerLike,
  run: (handle: PickerServerHandle) => Promise<void>,
): Promise<void> {
  const handle = await startPickerServer({ picker, port: 0, log: () => {} });
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterAll(() => installLayaRuntime(null));

/* -------------------------------------------------- the extension's contract */

describe("picker-server: the extension's HTTP contract", () => {
  it("GET /health returns the Python body {status, device}", async () => {
    await withServer(scriptedPicker(), async (handle) => {
      const res = await fetch(`${handle.url}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual({ status: "ok", device: "cpu" });
    });
  });

  it("POST /pick accepts background.js's {state:{url,title,main_text,visible_buttons}}", async () => {
    await withServer(scriptedPicker({ action: "add_to_cart", actionConf: 0.94, irreversible: 0.1 }), async (handle) => {
      const res = await postPick(handle.url, extensionBody());
      expect(res.status).toBe(200);
      const decision = (await res.json()) as PickDecision;

      // the seven fields of picker.pick(), nothing renamed or dropped
      expect(Object.keys(decision).sort()).toEqual(
        ["action", "auto_execute", "candidates", "guards", "probabilities", "reason", "selector"],
      );
      expect(decision.action).toBe("add_to_cart");
      expect(decision.selector).toBe("button[data-test='add-to-cart']");
      expect(decision.auto_execute).toBe(true);
      expect(decision.reason).toBeNull();
      expect(decision.guards).toEqual({ attack_p: 0, irreversible_p: 0.1, confidence: 0.94 });
      expect(decision.candidates).toHaveLength(3);
      expect(decision.candidates[0]).toEqual(
        { label: "add_to_cart", probability: 0.94, selector: "button[data-test='add-to-cart']" },
      );
      const total = Object.values(decision.probabilities).reduce((a, b) => a + b, 0);
      expect(Math.abs(total - 1)).toBeLessThan(1e-9);
      for (const candidate of decision.candidates) {
        expect(candidate.selector).toBe(ACTIONS[candidate.label]![1]);
      }
    });
  });

  it("passes a decision object through byte-for-byte (fake picker)", async () => {
    // Values the extension reads: selector, auto_execute, reason, candidates[].
    const literal: PickDecision = {
      action: "search",
      probabilities: { search: 0.7, add_to_cart: 0.2, checkout: 0.1 },
      selector: "input[data-test='search-box']",
      auto_execute: false,
      reason: "low confidence 0.70 < 0.6",
      guards: { attack_p: 0.01, irreversible_p: 0.02, confidence: 0.7 },
      candidates: [
        { label: "search", probability: 0.7, selector: "input[data-test='search-box']" },
        { label: "add_to_cart", probability: 0.2, selector: "button[data-test='add-to-cart']" },
        { label: "checkout", probability: 0.1, selector: "a[data-test='checkout']" },
      ],
    };
    let seenState: unknown = null;
    const picker: PickerLike = {
      agent: { device: "cpu" },
      async pick(state) { seenState = state; return literal; },
    };
    await withServer(picker, async (handle) => {
      const res = await postPick(handle.url, extensionBody());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(literal);
    });
    // the extension's state reaches the picker unmodified
    expect(seenState).toEqual(extensionBody().state);
  });

  it("POST /pick works without a Content-Type header (FastAPI ignores it)", async () => {
    await withServer(scriptedPicker(), async (handle) => {
      const res = await fetch(`${handle.url}/pick`, {
        method: "POST",
        body: JSON.stringify(extensionBody()),
      });
      expect(res.status).toBe(200);
    });
  });

  it("normalises a trailing slash instead of FastAPI's 307 redirect", async () => {
    await withServer(scriptedPicker(), async (handle) => {
      const res = await fetch(`${handle.url}/health/`, { redirect: "manual" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", device: "cpu" });
    });
  });
});

/* ---------------------------------------------------- the three gate branches */

describe("picker-server: auto_execute gates survive the HTTP hop", () => {
  const reason = async (handle: PickerServerHandle, body: unknown = extensionBody()): Promise<PickDecision> =>
    (await (await postPick(handle.url, body)).json()) as PickDecision;

  it("auto-executes a confident, safe action", async () => {
    await withServer(scriptedPicker({ action: "add_to_cart", actionConf: 0.94, irreversible: 0.1 }), async (h) => {
      const decision = await reason(h);
      expect(decision.auto_execute).toBe(true);
      expect(decision.reason).toBeNull();
    });
  });

  it("blocks suspected prompt injection before anything else", async () => {
    await withServer(scriptedPicker({ attack: 0.99 }), async (h) => {
      const decision = await reason(h);
      expect(decision.auto_execute).toBe(false);
      expect(decision.reason).toBe("blocked: suspected prompt injection on page (p=0.99)");
      expect(decision.guards.attack_p).toBe(0.99);
    });
  });

  it("hands low confidence to the human picker", async () => {
    await withServer(scriptedPicker({ actionConf: 0.31 }), async (h) => {
      const decision = await reason(h);
      expect(decision.auto_execute).toBe(false);
      expect(decision.reason).toContain("low confidence 0.31 < 0.6");
      expect(decision.reason).toContain("show human picker");
    });
  });

  it("requires confirmation for destructive/irreversible actions", async () => {
    await withServer(scriptedPicker({ action: "checkout", actionConf: 0.9, irreversible: 0.05 }), async (h) => {
      const decision = await reason(h);
      expect(decision.auto_execute).toBe(false);
      expect(decision.reason).toBe("destructive/irreversible -- requires user confirmation");
    });
  });

  it("applies request thresholds to the resident picker (Python mutates it too)", async () => {
    const picker = scriptedPicker({ action: "add_to_cart", actionConf: 0.55, attack: 0.81, irreversible: 0.1 });
    await withServer(picker, async (h) => {
      // defaults: attack 0.81 < 0.95, confidence 0.55 < 0.6 -> low confidence
      const first = await reason(h);
      expect(first.auto_execute).toBe(false);
      expect(first.reason).toContain("low confidence 0.55 < 0.6");

      // PickRequest overrides both gates
      const second = await reason(h, { ...extensionBody(), confidence_threshold: 0.5, attack_threshold: 0.8 });
      expect(second.auto_execute).toBe(false);
      expect(second.reason).toBe("blocked: suspected prompt injection on page (p=0.81)");
      expect(picker.conf_threshold).toBe(0.5);
      expect(picker.attack_threshold).toBe(0.8);

      // ...and they stick for the next request, exactly like picker_server.py
      const third = await reason(h);
      expect(third.reason).toBe("blocked: suspected prompt injection on page (p=0.81)");
    });
  });

  it("a lowered confidence_threshold lets a safe action auto-execute", async () => {
    await withServer(scriptedPicker({ action: "add_to_cart", actionConf: 0.55 }), async (h) => {
      const decision = await reason(h, { ...extensionBody(), confidence_threshold: 0.5 });
      expect(decision.auto_execute).toBe(true);
      expect(decision.reason).toBeNull();
    });
  });
});

/* ------------------------------------------------- pydantic validation parity */

describe("picker-server: validation failures are 422 like pydantic v2", () => {
  it("rejects malformed JSON with json_invalid", async () => {
    await withServer(scriptedPicker(), async (h) => {
      const res = await postPick(h.url, "{not json");
      expect(res.status).toBe(422);
      const body = (await res.json()) as { detail: Array<Record<string, unknown>> };
      expect(body.detail[0]!.type).toBe("json_invalid");
      expect(body.detail[0]!.loc).toEqual(["body", 0]);
      expect(body.detail[0]!.msg).toBe("JSON decode error");
    });
  });

  it("rejects a missing state field with type=missing", async () => {
    await withServer(scriptedPicker(), async (h) => {
      const res = await postPick(h.url, { confidence_threshold: 0.5 });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { detail: Array<Record<string, unknown>> };
      expect(body.detail[0]).toEqual({
        type: "missing", loc: ["body", "state"], msg: "Field required",
        input: { confidence_threshold: 0.5 },
      });
    });
  });

  it("rejects an empty body as a missing required body", async () => {
    await withServer(scriptedPicker(), async (h) => {
      const res = await postPick(h.url, "");
      expect(res.status).toBe(422);
      const body = (await res.json()) as { detail: Array<Record<string, unknown>> };
      expect(body.detail[0]!.type).toBe("missing");
      expect(body.detail[0]!.loc).toEqual(["body"]);
    });
  });

  it("rejects a non-dict state and a non-object body", async () => {
    await withServer(scriptedPicker(), async (h) => {
      const badState = await postPick(h.url, { state: [] });
      expect(badState.status).toBe(422);
      expect(((await badState.json()) as { detail: Array<Record<string, unknown>> }).detail[0]!.type)
        .toBe("dict_type");

      const badBody = await postPick(h.url, [1, 2, 3]);
      expect(badBody.status).toBe(422);
      expect(((await badBody.json()) as { detail: Array<Record<string, unknown>> }).detail[0]!.type)
        .toBe("model_attributes_type");
    });
  });

  it("enforces the 0..1 bounds on both thresholds", async () => {
    await withServer(scriptedPicker(), async (h) => {
      const high = await postPick(h.url, { ...extensionBody(), confidence_threshold: 1.5 });
      expect(high.status).toBe(422);
      expect(((await high.json()) as { detail: Array<Record<string, unknown>> }).detail[0]!.type)
        .toBe("less_than_equal");

      const low = await postPick(h.url, { ...extensionBody(), attack_threshold: -0.1 });
      expect(low.status).toBe(422);
      expect(((await low.json()) as { detail: Array<Record<string, unknown>> }).detail[0]!.type)
        .toBe("greater_than_equal");

      const garbage = await postPick(h.url, { ...extensionBody(), confidence_threshold: "abc" });
      expect(garbage.status).toBe(422);
      expect(((await garbage.json()) as { detail: Array<Record<string, unknown>> }).detail[0]!.type)
        .toBe("float_parsing");
    });
  });

  it("accepts explicit null thresholds (pydantic Optional)", async () => {
    await withServer(scriptedPicker(), async (h) => {
      const res = await postPick(h.url, { ...extensionBody(), confidence_threshold: null, attack_threshold: null });
      expect(res.status).toBe(200);
    });
  });

  it("answers 404 / 405 the way FastAPI does", async () => {
    await withServer(scriptedPicker(), async (h) => {
      const missing = await fetch(`${h.url}/nope`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ detail: "Not Found" });

      const wrongMethod = await fetch(`${h.url}/pick`);
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("POST");
      expect(await wrongMethod.json()).toEqual({ detail: "Method Not Allowed" });

      const healthPost = await fetch(`${h.url}/health`, { method: "POST" });
      expect(healthPost.status).toBe(405);
      expect(healthPost.headers.get("allow")).toBe("GET");
    });
  });

  it("rejects an oversized body with 413 and still answers cleanly", async () => {
    await withServer(scriptedPicker(), async (h) => {
      const huge = JSON.stringify({ state: { main_text: "x".repeat(MAX_BODY_BYTES + 1024) } });
      const res = await postPick(h.url, huge);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ detail: "Request body too large" });
    });
  });
});

/* ------------------------------------------------------------------ lifecycle */

describe("picker-server: lifecycle", () => {
  it("defaults to 127.0.0.1:8765 (same as picker_server.py / background.js)", async () => {
    const handle = createPickerServer({ picker: scriptedPicker() });
    expect(handle.host).toBe(DEFAULT_HOST);
    expect(handle.port).toBe(DEFAULT_PORT);
    expect(handle.url).toBe("http://127.0.0.1:8765");
    await handle.close();
  });

  it("start() binds port 0 ephemerally and updates url/port", async () => {
    const handle = createPickerServer({ picker: scriptedPicker(), port: 0, log: () => {} });
    expect(handle.port).toBe(0);
    await handle.start();
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
    await handle.close();
  });

  it("close() is idempotent, including on a never-started handle", async () => {
    const started = await startPickerServer({ picker: scriptedPicker(), port: 0, log: () => {} });
    await started.close();
    await started.close();
    await expect(started.close()).resolves.toBeUndefined();

    const neverStarted = createPickerServer({ picker: scriptedPicker() });
    await neverStarted.close();
    await expect(neverStarted.close()).resolves.toBeUndefined();
  });

  it("serves repeatedly across start/close rounds without leaking", async () => {
    const picker = scriptedPicker();
    for (let round = 0; round < 3; round++) {
      const handle = await startPickerServer({ picker, port: 0, log: () => {} });
      const res = await fetch(`${handle.url}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", device: "cpu" });
      await handle.close();
    }
  });

  it("can restart the same handle after close()", async () => {
    const handle = createPickerServer({ picker: scriptedPicker(), port: 0, log: () => {} });
    await handle.start();
    const firstPort = handle.port;
    await handle.close();
    expect(handle.server.listening).toBe(false);
    await handle.start();
    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(`${handle.url}/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(extensionBody()),
    });
    expect(res.status).toBe(200);
    expect(handle.port).not.toBe(0);
    expect(firstPort).toBeGreaterThan(0);
    await handle.close();
  });

  it("loads the default picker lazily, exactly once", async () => {
    let loads = 0;
    const picker = scriptedPicker();
    const handle = createPickerServer({
      port: 0,
      log: () => {},
      loadPicker: async () => { loads += 1; return picker; },
    });
    expect(loads).toBe(0);
    await handle.start();
    expect(loads).toBe(0); // start() must not touch the runtime
    expect(await (await fetch(`${handle.url}/health`)).json()).toEqual({ status: "ok", device: "cpu" });
    expect(loads).toBe(1);
    await fetch(`${handle.url}/health`);
    expect(loads).toBe(1);
    await handle.close();
  });

  it("reports 500 (not a crash) when the picker blows up", async () => {
    const picker: PickerLike = {
      agent: { device: "cpu" },
      pick() { throw new Error("checkpoint exploded"); },
    };
    await withServer(picker, async (handle) => {
      const res = await postPick(handle.url, extensionBody());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ detail: "Internal Server Error" });
      // the server survives and keeps serving
      expect((await fetch(`${handle.url}/health`)).status).toBe(200);
    });
  });
});

/* -------------------------------------------------------------------- the CLI */

describe("picker-server: CLI", () => {
  it("parses --host / --port, with the Python defaults", () => {
    expect(parseServerArgs([])).toEqual({ host: DEFAULT_HOST, port: DEFAULT_PORT, help: false });
    expect(parseServerArgs(["--port", "9000", "--host", "0.0.0.0"]))
      .toEqual({ host: "0.0.0.0", port: 9000, help: false });
    expect(parseServerArgs(["--port=0"]).port).toBe(0);
    expect(parseServerArgs(["--host=::1", "--port=1"]).host).toBe("::1");
    expect(parseServerArgs(["--help"]).help).toBe(true);
    expect(parseServerArgs(["-h"]).help).toBe(true);
  });

  it("rejects bad arguments with exit code 2", async () => {
    const lines: string[] = [];
    const deps = { picker: scriptedPicker(), log: (line: string) => lines.push(line) };
    expect(await main(["--port", "abc"], deps)).toBe(2);
    expect(await main(["--port", "70000"], deps)).toBe(2);
    expect(await main(["--port"], deps)).toBe(2);
    expect(await main(["--nope"], deps)).toBe(2);
    expect(lines.some((line) => line.includes("--port must be an integer"))).toBe(true);
  });

  it("prints usage and exits 0 on --help (without listening)", async () => {
    const lines: string[] = [];
    expect(await main(["--help"], { picker: scriptedPicker(), log: (line) => lines.push(line) })).toBe(0);
    expect(lines.join("\n")).toContain("/health");
    expect(lines.join("\n")).toContain("8765");
  });

  it("serves until aborted, then closes the socket", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    const running = main(["--port", "0"], {
      picker: scriptedPicker(),
      log: (line) => lines.push(line),
      signal: controller.signal,
    });
    await waitFor(() => lines.some((line) => line.includes("listening on")));
    const url = lines.find((line) => line.includes("listening on"))!.split("listening on ")[1]!;
    expect(url.startsWith("http://127.0.0.1:")).toBe(true);
    expect((await fetch(`${url}/health`)).status).toBe(200);

    controller.abort();
    expect(await running).toBe(0);
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });
});
