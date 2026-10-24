/**
 * 进程观察面的信号语言 —— 命令行工具当**动作腿**时的"完成真值"。
 *
 * 浏览器面的完成真值是 DOM（`src/engine/signals.ts` 的五个叶子 + 组合）。命令行工具没有 DOM，
 * 它的可验证事实是：**退出码、stdout、stderr、以及它写下的产物文件**。这里只是把同一套
 * 形状（叶子 + `all_of`/`any_of`/`not`）长在另一个观察面上，而**不是**新开一套语言：
 *   - 组合算子语义完全一致（递归、不能比叶子更宽松）；
 *   - 叶子同样是"可验证的事实"，不是"模型说完成了"；
 *   - 加载期校验和浏览器面一样严格（未知算子/参数个数）。
 *
 * 为什么叶子是这几个（每个都有真实消费者，见 apps/cli-report 与 tests/tool-signals.test.ts）：
 *   `exit_ok`            —— 退出码在 source 的 `exit_ok` 白名单里（最常用的"跑成功了"）
 *   `exit_code_equals`   —— 精确退出码（`grep`/`diff` 这类语义化退出码）
 *   `stdout_contains`    —— 产物里必须出现的事实
 *   `stderr_contains`    —— 失败原因/提示（"要登录"这类）
 *   `stdout_matches`     —— 形状断言（正则）
 *   `json_path_equals`   —— 结构化产物里的一个字段（复用数据源的路径语言）
 *   `file_exists` / `file_absent` —— 副作用落地了吗（不可逆动作的验收）
 */
import fs from "node:fs";
import path from "node:path";
import type { CliObservation } from "../data/datasource.ts";
import { REPO } from "../flow/flow.ts";
import { resolve } from "../data/datasource.ts";
import { validateSignalSpec, type SignalGrammar } from "../engine/signals.ts";

export type ToolSignal = Record<string, unknown>;

/** 叶子 + 组合算子（`exit_ok` 无参，与浏览器面的 `manual` 同型）。 */
export const TOOL_SIGNAL_OPS: Readonly<Record<string, number>> = {
  all_of: 1,
  any_of: 1,
  not: 1,
  exit_ok: 0,
  exit_code_equals: 1,
  stdout_contains: 1,
  stderr_contains: 1,
  stdout_matches: 1,
  json_path_equals: 2,
  file_exists: 1,
  file_absent: 1,
};

/**
 * 进程观察面的语法描述。**组合算子与递归规则不在这里**——它们来自
 * `signals.validateSignalSpec` 这唯一一份实现；本文件只声明"这个面的叶子有哪些"。
 */
export const TOOL_SIGNAL_GRAMMAR: SignalGrammar = {
  ops: TOOL_SIGNAL_OPS,
  label: "tool signal",
  listKnown: true,
};

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** `file_*` 的路径：绝对路径照用，相对路径按仓库根解析（与 start_url 同口径）。 */
export function artifactPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(REPO, p);
}

/**
 * 加载期校验：未知算子、参数个数、组合递归。**走的是与浏览器面同一个走查器**
 * （`signals.validateSignalSpec`），本文件只提供叶子算子表——所以"两套语法同构"
 * 不再是靠人成对改的纪律，而是构造性质。
 */
export function validateToolSignal(spec: ToolSignal, where = "signal"): string[] {
  return validateSignalSpec(spec, where, TOOL_SIGNAL_GRAMMAR);
}

/** 求值：一个叶子只看一个事实，组合只做逻辑（不可能比叶子更宽松）。 */
export function checkToolSignal(obs: CliObservation, spec: ToolSignal): boolean {
  if (typeof spec !== "object" || spec === null) return false;
  for (const [op, raw] of Object.entries(spec)) {
    const args = Array.isArray(raw) ? raw : [raw];
    switch (op) {
      case "all_of":
        if (!Array.isArray(raw) || !raw.every((x) => checkToolSignal(obs, x as ToolSignal))) return false;
        break;
      case "any_of":
        if (!Array.isArray(raw) || !raw.some((x) => checkToolSignal(obs, x as ToolSignal))) return false;
        break;
      case "not":
        if (checkToolSignal(obs, raw as ToolSignal)) return false;
        break;
      case "exit_ok":
        if (!obs.ok) return false;
        break;
      case "exit_code_equals":
        if (obs.code !== Number(args[0])) return false;
        break;
      case "stdout_contains":
        if (!obs.stdout.includes(s(args[0]))) return false;
        break;
      case "stderr_contains":
        if (!obs.stderr.includes(s(args[0]))) return false;
        break;
      case "stdout_matches":
        try {
          if (!new RegExp(s(args[0]), "s").test(obs.stdout)) return false;
        } catch {
          return false;
        }
        break;
      case "json_path_equals": {
        let parsed: unknown;
        try {
          parsed = JSON.parse(obs.stdout);
        } catch {
          return false;                                  // 不是 JSON -> 这个叶子不成立，不抛
        }
        const got = resolve(parsed, s(args[0]));
        if (s(got) !== s(args[1])) return false;
        break;
      }
      case "file_exists": {
        try {
          if (!fs.statSync(artifactPath(s(args[0]))).isFile()) return false;
        } catch {
          return false;
        }
        break;
      }
      case "file_absent": {
        try {
          fs.statSync(artifactPath(s(args[0])));
          return false;                                  // 存在 -> "不存在"不成立
        } catch {
          /* 不存在：成立 */
        }
        break;
      }
      default:
        return false;
    }
  }
  return true;
}
