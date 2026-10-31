/**
 * secret-scan —— M0 的**泄露门**（纯离线：不开浏览器、不调模型）。
 *
 * 证明三件事：
 *   1. `meta.secretSlots` 显式声明的槽位会被掩码；
 *   2. 名称启发（password/token/api_key/...）在未显式声明时也掩码；
 *   3. 掩码后的 result JSON / report.md / dry JSON 三个输出面**零 canary 命中**。
 *
 * 为什么不是只测一个函数：泄露事故通常发生在"函数对了、某个出口忘了接"。这里按
 * **输出面**断言，而不是按实现细节断言；将来新增出口时，把新出口加进 `surfaces` 即可。
 *
 * 用法：node --experimental-strip-types tools/secret-scan.ts
 * 退出码：0 = 零命中；1 = 有泄露或掩码失效。
 */
import { MASKED_SLOT, maskSecretSlots, scrubSecrets, secretSlotKeys, secretValuesFromSlots } from "../src/app/redaction.ts";
import { appReportMarkdown, type AppRunResult } from "../src/app/app-runner.ts";

const problems: string[] = [];
const canary = `CANARY-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/* ---- 1. 显式声明 + 名称启发 ---- */
const declared = ["username", "password", "api_key", "token", "otp", "coupon"];
const keys = secretSlotKeys(declared, ["password"]);
const expectedSecret = ["password", "api_key", "token", "otp"];
for (const k of expectedSecret) {
  if (!keys.has(k)) problems.push(`secretSlotKeys 漏掉敏感槽位 ${JSON.stringify(k)}`);
}
for (const k of ["username", "coupon"]) {
  if (keys.has(k)) problems.push(`secretSlotKeys 误伤非敏感槽位 ${JSON.stringify(k)}`);
}

const rawSlots = {
  username: "alice",
  password: canary,
  api_key: canary,
  token: canary,
  otp: canary,
  coupon: "SAVE10",
};
const masked = maskSecretSlots(rawSlots, keys);
for (const k of expectedSecret) {
  if (masked[k] !== MASKED_SLOT) problems.push(`maskSecretSlots 未掩码 ${JSON.stringify(k)}：${JSON.stringify(masked[k])}`);
}
if (masked["username"] !== "alice" || masked["coupon"] !== "SAVE10") {
  problems.push("maskSecretSlots 误掩码了非敏感槽位");
}

/* ---- 2. 三个输出面：result JSON / report.md / dry JSON ---- */
const fake: AppRunResult = {
  app: "secret-scan",
  label: "secret-scan",
  goal: "证明敏感槽位不进产物",
  pack_path: "",
  plan_path: "",
  slots: masked,
  completed: "1/1",
  subgoals: [],
  tool_steps: [],
  invariants: [],
  sources: [],
  source_slots: maskSecretSlots({ token: canary, note: "ok" }, keys) as Record<string, string>,
  ok: true,
  verified: true,
  secs: 0,
};
const secretValues = secretValuesFromSlots(rawSlots, keys);
// 深扫兜底：值被流程写进 logs/step_traces/trace 等其它字段时也必须被抹掉。
const leaky = {
  ...fake,
  logs: [{ i: 0, desc: `typed ${canary}`, result: { value: canary } }],
  step_traces: [{
    index: 0, id: "s1", desc: `login ${canary}`, status: "done",
    hows: [], descs: [`type ${canary}`], methods: [],
    result: { evidence: { filled: canary } },
  }],
};
const scrubbed = scrubSecrets(leaky, secretValues);
const traceLike = scrubSecrets({ events: [{ desc: `login ${canary}`, result: { value: canary } }] }, secretValues);
const surfaces: Record<string, string> = {
  "result.json": JSON.stringify(fake, null, 2),
  "report.md": appReportMarkdown(fake),
  "dry.json": JSON.stringify({ slots: masked, problems: [] }, null, 2),
  "scrubbed-result.json": JSON.stringify(scrubbed, null, 2),
  "trace.json": JSON.stringify(traceLike, null, 2),
};
for (const [name, text] of Object.entries(surfaces)) {
  if (text.includes(canary)) problems.push(`${name} 仍包含 canary 明文`);
  if (!text.includes(MASKED_SLOT)) problems.push(`${name} 未见掩码标记 ${JSON.stringify(MASKED_SLOT)}`);
}

/* ---- 3. 报告 ---- */
if (problems.length > 0) {
  console.error("secret-scan: FAIL");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`secret-scan: OK（3 个输出面零命中；canary=${canary.length} chars 已掩码）`);
