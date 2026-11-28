/**
 * `verify:decision-headers` —— 额外请求头（`AMBERFLOW_DECISION_HEADERS`）确实上路。
 *
 * 为什么需要这条 lane：有些网关要求**路由头**而不只是 Bearer（如 OpenCode Go 的
 * `x-opencode-session`）——只发 Authorization 时请求停在鉴权前一步，错误串读起来却像
 * "模型没权限"，排查方向完全跑偏。这里用本地桩服务把"服务端到底收到什么头"钉成事实。
 *
 * 覆盖：① 配置的头真的发出去；② Authorization 与路由头**两回事**、互不覆盖；
 * ③ 空配置/坏 JSON 不发头且不崩（降级为"服务端拒绝"，而不是计划崩掉）；
 * ④ 同名头以配置为准（显式意图优先）。
 */
import http from "node:http";
import assert from "node:assert/strict";
import { serviceHeaders } from "../src/model/decision-service.ts";
import { systemOneClient, type SystemOneProfile } from "../src/model/system-one-client.ts";

interface Received {
  headers: Record<string, string>;
  body: string;
}

const failures: string[] = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((e) => {
      failures.push(name);
      console.error(`  FAIL ${name}: ${(e as Error).message}`);
    });
}

/** 桩服务：记下每请求的头与体，回一份最小的合法 System One 答复。 */
async function startStub(): Promise<{ origin: string; seen: Received[]; close(): Promise<void> }> {
  const seen: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      seen.push({ headers, body });
      res.setHeader("content-type", "application/json");
      // 空 probs + null choice：客户端解得出形状即可，本 lane 只关心请求头。
      res.end(JSON.stringify({ choice: null, probs: {}, passthrough: true, confidence: 0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}/v1/systemone`,
    seen,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e === undefined ? resolve() : reject(e)))),
  };
}

/** 一个最小 profile：只替换端点/认证/额外头，其余走既有默认。 */
function profileOf(origin: string, headers: () => Record<string, string>, auth: () => string): SystemOneProfile {
  return {
    name: "lane-stub",
    version: "1",
    label: "lane-stub",
    capabilities: { choice: true, risk: false, done: false, shortlist: false, score_kind: "calibrated_prob" },
    resolveEndpoint: () => origin,
    endpointHint: "lane",
    resolveAuth: auth,
    resolveHeaders: headers,
    extraBody: () => ({}),
    minOptions: 1,
    validateChoiceInPool: true,
    choiceInstructions: (goal) => `pick one for: ${goal}`,
    riskInstructions: (goal, action) => `risk of ${action} for ${goal}`,
    doneInstructions: (goal) => `is ${goal} done`,
    unreachableHint: "lane stub",
  };
}

async function main(): Promise<number> {
  const stub = await startStub();
  try {
    // ① 配置的头真的发出去；② 与 Authorization 并存、互不覆盖。
    await check("配置的路由头与 Authorization 同时上路", async () => {
      const client = systemOneClient(profileOf(
        stub.origin,
        () => serviceHeaders({ AMBERFLOW_DECISION_HEADERS: '{"x-opencode-session":"sess-42"}' } as NodeJS.ProcessEnv),
        () => "key-abc",
      ));
      await client.pick({
        goal: "g", page: null as never, elems: { "@e1": { tag: "button", label: "Go" } as never },
        forbidden: new Set(), notes: null, narrow: null, k: 8,
      } as never).catch(() => undefined);
      const got = stub.seen.at(-1);
      assert.ok(got !== undefined, "请求已发出");
      assert.equal(got.headers["x-opencode-session"], "sess-42", "路由头到达服务端");
      assert.equal(got.headers["authorization"], "Bearer key-abc", "身份头仍在（两者是两回事）");
    });

    // ③ 空配置不发头；坏 JSON 不发头且不崩。
    await check("空配置不发额外头", async () => {
      const before = stub.seen.length;
      const client = systemOneClient(profileOf(stub.origin, () => serviceHeaders({} as NodeJS.ProcessEnv), () => ""));
      await client.pick({
        goal: "g", page: null as never, elems: { "@e1": { tag: "button", label: "Go" } as never },
        forbidden: new Set(), notes: null, narrow: null, k: 8,
      } as never).catch(() => undefined);
      assert.equal(stub.seen.length, before + 1, "请求照发");
      const got = stub.seen.at(-1)!;
      assert.equal(got.headers["x-opencode-session"], undefined, "没有配置就不该有该头");
    });

    await check("坏 JSON 降级为不带头（不崩）", () => {
      assert.deepEqual(serviceHeaders({ AMBERFLOW_DECISION_HEADERS: "{not json" } as NodeJS.ProcessEnv), {},
        "坏 JSON → 空头表");
      assert.deepEqual(serviceHeaders({ AMBERFLOW_DECISION_HEADERS: "[1,2]" } as NodeJS.ProcessEnv), {},
        "数组不是头对象");
      assert.deepEqual(serviceHeaders({ AMBERFLOW_DECISION_HEADERS: '{"a":1,"b":"x"}' } as NodeJS.ProcessEnv), { b: "x" },
        "非字符串值被丢弃，字符串值保留");
    });

    // ④ 配置里的同名头覆盖缺省（显式意图优先）。
    await check("同名头以配置为准", async () => {
      const client = systemOneClient(profileOf(
        stub.origin,
        () => serviceHeaders({ AMBERFLOW_DECISION_HEADERS: '{"content-type":"application/json; charset=utf-8"}' } as NodeJS.ProcessEnv),
        () => "",
      ));
      await client.pick({
        goal: "g", page: null as never, elems: { "@e1": { tag: "button", label: "Go" } as never },
        forbidden: new Set(), notes: null, narrow: null, k: 8,
      } as never).catch(() => undefined);
      const got = stub.seen.at(-1)!;
      assert.match(got.headers["content-type"] ?? "", /charset=utf-8/, "配置值覆盖缺省 content-type");
    });
  } finally {
    await stub.close();
  }
  if (failures.length > 0) {
    console.error(`verify-decision-headers: ${failures.length} 项未过`);
    return 1;
  }
  console.log("verify-decision-headers: OK — 额外请求头按配置上路、与 Authorization 分离、坏配置降级不崩");
  return 0;
}

process.exit(await main());
