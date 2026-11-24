/**
 * `amber pilot` 的**兜底指令分派面**（从 pilot-runtime 拆出，守其 800 行硬上限）。
 *
 * 纪律不变（与 session 同源）：stdin 每行一个 JSON 对象；resume/redirect/finish/abort
 * 闭集；单行失败 = 回执一条错误后继续等下一条，不杀会话；只有 finish(信号验证成立)/
 * abort/EOF 关闭会话。状态所有权仍在 PilotRuntime——本模块只经 `PilotCommandTarget`
 * 读写它的公开面，不持有第二份状态（拆文件不是第二套语义）。
 */
import { NAVIGATION_GOTO_TIMEOUT_MS } from "../support/tuning.ts";
import type { ElemPool } from "../engine/elem-model.ts";
import { disallowedHost, type AnyPage } from "../engine/executor.ts";
import { urlOf } from "../engine/extraction.ts";
import { settle } from "../engine/settle.ts";
import type { PilotLedger } from "./pilot-ledger.ts";
import {
  PILOT_AGENT_COMMANDS,
  type PilotAgentCommand, type PilotHandoff, type PilotOptions, type PilotRecordLine, type PilotStopCode,
} from "./pilot-contract.ts";
import { errMsg, isObj, nonEmpty } from "./session-runtime-contract.ts";
import { clipText } from "../support/text.ts";

/** 分派面需要的运行时公开面（唯一实现 = PilotRuntime；本模块不另存状态）。 */
export interface PilotCommandTarget {
  readonly driverMode: "model" | "agent";
  readonly opts: PilotOptions;
  readonly hosts: string[] | null;
  readonly slots: Record<string, string>;
  readonly forbidden: Set<string>;
  readonly ledger: PilotLedger;
  readonly lastPool: ElemPool | null;
  readonly lastPickedRef: string | null;
  readonly stepCount: number;
  handoffOpen: PilotHandoff | null;
  resumeHint: string | null;
  /** resume 字符串值的待注入值（hint 命中时按命中目标的键落地）。 */
  pendingValue: string | null;
  inertRun: number;
  finished: boolean;
  aborted: boolean;
  stopCode: PilotStopCode | null;
  fallbackCount: number;
  respond(obj: Record<string, unknown>): void;
  /** 未决值需求的值袋键（needs_value 记录的键；null = 无未决值需求）。 */
  valueNeedKey(): string | null;
  page(): Promise<AnyPage>;
  redirectReset(): void;
  signalHeld(spec: Record<string, unknown>): Promise<boolean>;
  record(line: PilotRecordLine): void;
}

/**
 * 兜底指令入口：空行/坏 JSON/未知指令都只是**单行失败**（回执已发、继续等下一条）。
 * 返回 "stay"（继续等）| "drive"（回驾驶轮）| "close"（收尾）。
 */
export async function handlePilotLine(target: PilotCommandTarget, line: string): Promise<"stay" | "drive" | "close"> {
  if (target.stopCode === "budget_exceeded") {   // 预算终态：续驾驶指令一律结构化拒绝
    target.respond({ type: "command_result", ok: false, code: "budget_exhausted", reason: "max steps reached — terminal" });
    return "stay";
  }
  const raw = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
  if (raw.trim() === "") return "stay";
  let req: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObj(parsed)) throw new Error("not an object");
    req = parsed;
  } catch (e) {
    target.respond({ type: "error", ok: false, code: "config_error", reason: `bad JSONL: ${errMsg(e)}` });
    return "stay";
  }
  const cmd = req["cmd"] ?? req["type"];
  if (typeof cmd !== "string" || !(PILOT_AGENT_COMMANDS as readonly string[]).includes(cmd)) {
    target.respond({
      type: "error", ok: false, code: "config_error",
      reason: `pilot commands are ${PILOT_AGENT_COMMANDS.join(" | ")} (got ${JSON.stringify(cmd)})`,
    });
    return "stay";
  }
  return await handlePilotCommand(target, cmd as PilotAgentCommand, req);
}

/** 一条已校验指令的分派（resume/redirect/finish/abort 闭集）。 */
export async function handlePilotCommand(
  target: PilotCommandTarget, cmd: PilotAgentCommand, args: Record<string, unknown>,
): Promise<"stay" | "drive" | "close"> {
  target.fallbackCount += 1;
  // 值不落明文轨迹（与 pilot export 的「值已省略」同一纪律）：record 里 value 只留省略标记。
  // `note` 等非敏感协议字段刻意保留在 command 行：它唯一出口就是 pilot 自身 trace/record，
  // 不进会话/桥响应投影（投影只回 cmd/outcome 等固定键）。
  const masked = { ...args, ...(args["value"] === undefined ? {} : { value: "<已省略>" }) };
  target.record({ i: target.stepCount, ts: new Date().toISOString(), type: "command", command: cmd, args: masked });
  switch (cmd) {
    case "resume": {
      // agent 驾驶模式：resume 就是每步点名，无需 open handoff；model 模式 = 解除停因交接。
      if (target.handoffOpen === null && target.driverMode !== "agent") {
        target.respond({ type: "command_result", ok: false, code: "config_error", reason: "resume without an open handoff" });
        return "stay";
      }
      // resume.value 显式给值（红线②：值只能从这里或预声明 slots 来）：
      // 对象 = 多槽 k:v 全并入值袋（语义逐字节不变）；字符串 = 单值，键序
      // target（显式命名）→ needs_value 记录的目标键 → "resumed"（缺省兜底，真实标签永不命中它）。
      // 同时记 pendingValue：resume 另带 hint 时值跟 hint 目标走（命中时注入命中元素的键）。
      const value = args["value"];
      if (isObj(value)) {
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            target.slots[clipText(String(k), 40)] = String(v);
          }
        }
      } else if (typeof value === "string" && nonEmpty(value)) {
        const key = clipText(String(args["target"] ?? ""), 40) || target.valueNeedKey() || "resumed";
        target.slots[key] = value;
        target.pendingValue = value;
      }
      // resume.skip：把最近一次驾驶选中的目标加入禁选后继续（不点名换目标的兜底）。
      const skipped = args["skip"] === true && target.lastPickedRef !== null;
      if (skipped) {
        target.forbidden.add(target.lastPickedRef as string);
        const skippedEl = target.lastPool?.[target.lastPickedRef as string];
        if (skippedEl !== undefined) target.ledger.bump(skippedEl, "resume.skip", "skipped");
      }
      // resume.hint 点名收窄：写进下一步的规则档（hint 命中即确定性执行，零模型）。
      const hint = args["hint"];
      if (typeof hint === "string" && hint.trim() !== "") target.resumeHint = hint.trim();
      target.inertRun = 0;
      target.handoffOpen = null;
      target.respond({
        type: "command_result", ok: true, resumed: true, step: target.stepCount,
        ...(skipped ? { skipped: target.lastPickedRef } : {}),
      });
      return "drive";
    }
    case "redirect": {
      const url = args["url"];
      const goal = args["goal"];
      if (typeof url === "string" && nonEmpty(url)) {
        try {
          const page = await target.page();
          const bad = disallowedHost(url, target.hosts ?? undefined);
          if (bad !== null) throw new Error(bad);
          await page.goto(url, { timeout: NAVIGATION_GOTO_TIMEOUT_MS, waitUntil: "domcontentloaded" });
          try { await settle(page as never); } catch { /* settle 不抛 */ }
          target.redirectReset();
          target.respond({ type: "command_result", ok: true, redirected: true, url: urlOf(page) });
          return "drive";
        } catch (e) {
          target.respond({ type: "command_result", ok: false, code: "nav_failed", reason: errMsg(e) });
          return "stay";
        }
      }
      if (typeof goal === "string" && nonEmpty(goal)) {
        // redirect 只有 goal = 换总目标重驾驶（预算不清零；预算重置请起新 pilot）。
        target.opts.goal = clipText(goal, 400);
        target.redirectReset();
        target.respond({ type: "command_result", ok: true, redirected: true, goal_digest: clipText(goal, 200) });
        return "drive";
      }
      target.respond({ type: "command_result", ok: false, code: "config_error", reason: "redirect needs url or goal" });
      return "stay";
    }
    case "finish": {
      // 完成只认信号（红线③）：finish 声明最终信号（args.signal 或起会话时预声明的
      // --final-signal），checkSignal 验证成立才记 final_signal_held；不成立 = 单行被拒，
      // 交接保持打开，Agent 可 resume/redirect/abort。
      const argSig = args["signal"];
      const spec = isObj(argSig) && Object.keys(argSig).length > 0
        ? argSig
        : (isObj(target.opts.finalSignal) && Object.keys(target.opts.finalSignal).length > 0
          ? target.opts.finalSignal
          : null);
      if (spec === null) {
        target.respond({
          type: "command_result", ok: false, code: "config_error",
          reason: 'finish needs a signal: {"cmd":"finish","signal":{...}} or a pre-declared --final-signal',
        });
        return "stay";
      }
      if (!(await target.signalHeld(spec))) {
        target.respond({
          type: "command_result", ok: false, code: "signal_not_held", pilot: true,
          reason: "declared final signal does not hold on the current page",
        });
        return "stay";
      }
      target.finished = true;
      target.stopCode = "final_signal_held";
      target.respond({ type: "command_result", ok: true, finished: true, signal_held: true, pilot: true });
      return "close";
    }
    case "abort": {
      target.finished = true;
      target.aborted = true;   // 终止（落已走轨迹）：stop_code 保持最近一次停因
      target.respond({ type: "command_result", ok: true, aborted: true });
      return "close";
    }
  }
}
