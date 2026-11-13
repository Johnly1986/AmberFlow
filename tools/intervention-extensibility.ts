/**
 * 可扩张性机械断言（§8 步 1 验收，v2 新增）：
 * 注册一个 `kind: "test"` 且**不改编排代码**，dry 路径全绿——把「一条注册 + 一条 texts +
 * 编排零改」变成可测试命题。
 *
 * 不进 npm run check（避免测试代码进产物面）；作为步 1 的独立验收脚本存在，
 * 落地过程与总验收各跑一次。
 */

import { RESCUE_TEXTS } from "../src/support/intervention-texts.ts";
import { createRescueState, resolveRescue, shadowRescue, validateRescueRequest } from "../src/intervention/index.ts";
import type { RescueRequest } from "../src/support/intervention-contract.ts";

const problems: string[] = [];

/* ---- 1. 注册 kind:"test"：一条注册 + 一条 texts，编排代码零改 ---------------- */

type TestKinds = "action" | "value" | "authorization" | "test";
const TEST_KINDS = {
  action:        { stop_code: "needs_human", who_can_fix: "human-action",        text: "action"        },
  value:         { stop_code: "needs_value", who_can_fix: "human-value",         text: "value"         },
  authorization: { stop_code: "needs_human", who_can_fix: "human-authorization", text: "authorization" },
  test:          { stop_code: "needs_human", who_can_fix: "human-action",        text: "test"          },
} as const satisfies Record<TestKinds, { stop_code: string; who_can_fix: string; text: string }>;

// texts 同步加一条（键集一致性由编译期断言钉死；先经 RESCUE_TEXTS_AS_KINDS 把
// Record<string,…> 收窄回 kind 字面量键——运行时断言保证键集一致，编译期只认窄类型）：
const BASE_TEXTS: Record<"action" | "value" | "authorization", unknown> = RESCUE_TEXTS as Record<
  "action" | "value" | "authorization",
  unknown
>;
const TEST_TEXTS: Record<keyof typeof TEST_KINDS, unknown> = {
  ...BASE_TEXTS,
  test: {
    summary: "测试 kind：扩张性断言用（不进生产注册表）。",
    human_question: "测试（Enter = 完成；n = 放弃）",
    next_actions: ["回终端按 Enter", "放弃：输入 n"],
    agent_hint: { fact: "test kind", recommended_action: "none", stop_condition: "none" },
  },
};
const _kindCheck: Record<keyof typeof TEST_KINDS, unknown> = TEST_TEXTS;
void _kindCheck;

/* ---- 2. 编排零改下的 dry 全绿 ---------------------------------------------- */

// 构造 test kind 的请求走既有 validateRescueRequest / shadowRescue / resolveRescue——
// 这些函数是步 1 写死的编排实现，未为 test kind 改一行：
const state = createRescueState("run-test", true);
const req: RescueRequest = {
  request_id: `${state.nextSeq()}`,
  run_id: "run-test",
  seq: 0,
  kind: "test" as never,
  mode: "stop",
  why_stuck: {
    summary: "测试求援（扩张性断言）",
    stop_code: "needs_human",
    step_id: "s1",
    evidence: { dry: true },
  },
  what_would_unblock: ["回终端按 Enter"],
};
try {
  validateRescueRequest(req);
} catch (e) {
  problems.push(`新 kind 校验失败（编排不应解释 kind 语义）: ${e instanceof Error ? e.message : String(e)}`);
}

// 去重键对新 kind 同样生效（(run_id, kind, step_id)）：
state.register(req);
if (state.dedupe("test" as never, "s1") === null) {
  problems.push("新 kind 未走去重键 (run_id, kind, step_id)——注册扩张不应要求改编排");
}

// dry 红线：dry 面 resolveRescue 不弹通道（这里 mode=stop 天然不产生 Outcome）：
const shadows: unknown[] = [];
shadowRescue(
  { run_id: "run-test", state, onShadow: (r) => shadows.push(r) },
  req,
  { status: "unavailable", by: "tty" },
  "needs_human",
);
if (shadows.length !== 1) problems.push("影子记录未落（应恰好一条）");

// suspend + 无通道 → unavailable（立即停，绝不 sleep 等人）：
const outcome = await resolveRescue(
  { run_id: "run-test", state },
  { ...req, request_id: "run-test:1", seq: 1, mode: "suspend" },
  { ttyAvailable: false },
);
if (outcome?.status !== "unavailable") {
  problems.push(`无通道 suspend 应立即 unavailable（got ${JSON.stringify(outcome)}）`);
}

// 通道抛错兜底 → unavailable + reason 截获：
const outcome2 = await resolveRescue(
  { run_id: "run-test", state },
  { ...req, request_id: "run-test:2", seq: 2, mode: "suspend" },
  {
    handler: () => { throw new Error("EPIPE: stdin closed"); },
  },
);
if (outcome2?.status !== "unavailable" || !(outcome2.reason ?? "").includes("EPIPE")) {
  problems.push(`通道抛错应兜底 unavailable + reason 截获（got ${JSON.stringify(outcome2)}）`);
}

// what_would_unblock 超限拒收（config_error，不静默截断）：
try {
  validateRescueRequest({
    ...req,
    what_would_unblock: ["a", "b", "c", "d"],
  });
  problems.push("what_would_unblock >3 条未拒收（应 config_error）");
} catch {
  /* 预期拒收 */
}

// 迟到应答丢弃语义（first-answer-wins 的取消侧）：
const outcome3 = await resolveRescue(
  { run_id: "run-test", state },
  { ...req, request_id: "run-test:3", seq: 3, mode: "suspend" },
  {
    handler: async () => ({ status: "fulfilled", at: Date.now() }),
    signal: AbortSignal.abort("test"),
  },
);
if (outcome3?.status !== "cancelled") {
  problems.push(`abort 后的 fulfilled 应记 cancelled（got ${JSON.stringify(outcome3)}）`);
}

if (problems.length) {
  console.error("FAIL: 可扩张性断言未过——「一条注册 + 一条 texts + 编排零改」不成立");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("PASS: kind:'test' 注册扩张——编排零改，dry 路径全绿（校验/去重/影子/unavailable/兜底 catch/迟到应答全过）");
