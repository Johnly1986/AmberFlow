/**
 * verify-ctx-validate —— `ctx.extract` 内联 `maxItems` 校验的验收 lane（纯离线，非门禁）。
 *
 * `validateExtractOptions` 是真实/dry/replay 共用的原语参数入口：inline spec 的 `maxItems`
 * 必须是整数 1..500（NaN/负数/小数/超界都是结构化 `config_error`，绝不静默 clamp/取整）。
 * 本 lane 三层断言：
 *   - 共享校验器直测：非法值抛 `config_error`，合法值与 named form、第二参 offset 行为不变；
 *   - dry ctx 面：`createDryCtx` 的 `ctx.extract` 同样在 check 期红（不是只拦真实面）；
 *   - `apps check` 同源路径：临时 app 脚本经 `loadScriptApp` + `dryRunFlow`，problems 点名 maxItems。
 *
 * 用法：node --experimental-strip-types tools/verify-ctx-validate.ts
 * 退出码：0 绿 / 1 红。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDryCtx } from "../src/app/ctx-dry.ts";
import { newTrace } from "../src/app/trace.ts";
import { StopError } from "../src/app/ctx-types.ts";
import { validateExtractOptions } from "../src/app/ctx-validate.ts";
import { dryRunFlow, loadScriptApp } from "../src/app/app-script.ts";

const problems: string[] = [];

/** 断言抛结构化 `config_error`（返回消息给人读的断言用）。 */
function expectConfigError(fn: () => unknown, label: string): string {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof StopError)) {
      problems.push(`${label}: 抛的不是 StopError（${e instanceof Error ? e.message : String(e)}）`);
      return "";
    }
    if (e.code !== "config_error") problems.push(`${label}: code=${e.code}（期望 config_error）`);
    return e.message;
  }
  problems.push(`${label}: 期望 config_error，但没有任何异常`);
  return "";
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A：共享校验器直测（真实/dry/replay 同一个入口）。 */
function caseValidatorDirect(): void {
  const spec = { rows: "li.item", fields: { text: "." } };
  const invalid: unknown[] = [NaN, -5, 2.7, 0, 501, "5", Infinity, null, {}];
  const messages = new Map<string, string>();
  for (const maxItems of invalid) {
    const label = maxItems === null ? "null" : String(maxItems);
    const msg = expectConfigError(
      () => validateExtractOptions({ ...spec, maxItems }, undefined),
      `validator maxItems=${label}`,
    );
    messages.set(label, msg);
    if (msg !== "" && !/spec\.maxItems must be an integer in \[1, 500\]/.test(msg)) {
      problems.push(`validator maxItems=${label}: 文案未点名 spec.maxItems（${msg}）`);
    }
  }
  if (!(messages.get("NaN") ?? "").includes("NaN")) {
    problems.push("validator NaN: 文案应显示 got NaN（不是 JSON 的 null）");
  }
  for (const maxItems of [1, 500, undefined]) {
    try {
      validateExtractOptions({ ...spec, maxItems }, undefined);
    } catch (e) {
      problems.push(`validator maxItems=${String(maxItems)}: 合法值不应抛错（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  // named form 与第二参 offset 的既有行为不变。
  if (validateExtractOptions("named", undefined) !== 0) problems.push("validator: named form 缺省 offset 应为 0");
  if (validateExtractOptions(spec, { offset: 3 }) !== 3) problems.push("validator: opts.offset=3 应回 3");
  expectConfigError(() => validateExtractOptions(spec, { offset: -1 }), "validator: opts.offset=-1 仍应 config_error");
  console.log("A(validator direct): invalid=9 blocked, valid=3 pass, named/offset 行为不变");
}

/** B：dry ctx 面（`apps check` 的同一落法）也拦非法 maxItems。 */
async function caseDryCtx(): Promise<void> {
  const trace = newTrace({ app: "lane-ctx-validate", script_sha256: "lane", inputs_sha256: "lane" });
  const ctx = createDryCtx({
    pack: { id: "lane-ctx-validate", goal: "lane", hosts: null },
    slots: {},
    runtime: { outDir: "(dry)", runId: "lane", today: "" },
    trace,
    slotKeys: new Set(),
  });
  for (const maxItems of [NaN, -5, 2.7]) {
    try {
      await ctx.extract({ rows: "li.item", fields: { text: "." }, maxItems });
      problems.push(`dry maxItems=${String(maxItems)}: 期望 config_error，但调用成功`);
    } catch (e) {
      if (!(e instanceof StopError) || e.code !== "config_error") {
        problems.push(`dry maxItems=${String(maxItems)}: 不是 config_error（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
  }
  const rows = await ctx.extract({ rows: "li.item", fields: { text: "." }, maxItems: 500 });
  if (rows.length !== 0) problems.push("dry 合法 maxItems=500: dry 应恒返回 []");
  const last = trace.events[trace.events.length - 1];
  if (last?.call !== "extract" || last.desc !== "inline:li.item") problems.push("dry 合法 maxItems=500: 轨迹事件与既有一致性丢失");
  console.log("B(dry ctx): NaN/-5/2.7 blocked, maxItems=500 pass, trace extract 事件照记");
}

/** C：`loadScriptApp` + `dryRunFlow`（apps check 的同源路径）把非法声明判 FAIL。 */
async function caseDryRunFlow(): Promise<void> {
  const dir = tmp("af-ctx-validate-app-");
  const badScript = path.join(dir, "bad-app.mjs");
  fs.writeFileSync(badScript, [
    "export function meta(kit) {",
    "  return { id: \"lane-extract-maxitems\", label: \"lane\", goal: \"lane\", hosts: [\"lane.example\"] };",
    "}",
    "export async function flow(ctx) {",
    "  await ctx.open(\"https://lane.example/probe.html\");",
    "  await ctx.extract({ rows: \"li.item\", fields: { text: \".\" }, maxItems: NaN });",
    "}",
    "",
  ].join("\n"));
  const bad = await dryRunFlow(await loadScriptApp(badScript), {});
  if (bad.problems.length === 0) problems.push("dryRunFlow: 非法 maxItems 未判 FAIL");
  else if (!bad.problems.some((p) => p.includes("spec.maxItems"))) {
    problems.push(`dryRunFlow: problems 未点名 spec.maxItems（${bad.problems.join(" | ")}）`);
  }
  const goodScript = path.join(dir, "good-app.mjs");
  fs.writeFileSync(goodScript, fs.readFileSync(badScript, "utf8").replace("maxItems: NaN", "maxItems: 500"));
  const good = await dryRunFlow(await loadScriptApp(goodScript), {});
  if (good.problems.length > 0) problems.push(`dryRunFlow: 合法 maxItems=500 被判 FAIL（${good.problems.join(" | ")}）`);
  console.log(`C(dryRunFlow): bad=${bad.problems.length > 0 ? "FAIL" : "PASS(漏拦)"} good=${good.problems.length === 0 ? "PASS" : "FAIL"}`);
}

async function main(): Promise<number> {
  caseValidatorDirect();
  await caseDryCtx();
  await caseDryRunFlow();
  if (problems.length > 0) {
    for (const p of problems) console.error(`verify-ctx-validate: FAIL — ${p}`);
    return 1;
  }
  console.log("verify-ctx-validate: OK — maxItems 非整数/越界在共享校验器、dry ctx、dryRunFlow 三面都是 config_error；合法值行为不变");
  return 0;
}

process.exitCode = await main();
