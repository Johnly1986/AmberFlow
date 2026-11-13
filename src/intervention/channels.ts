/**
 * 介入 / 救援中断模块 —— 内建通道（TTY / StructuredStop / FailFast / Handler 桥接）。
 *
 * 设计出处：docs/INTERVENTION_RESCUE_MODULE.md（v2）§4 通道顺序链。
 * 允许依赖：node:* + support 两叶子。桥侧禁止 suspend（900s 墙钟 + stdio 会杀进程产生
 * 半救援状态）——桥只允许 stop + 转述，manualHandler 继续不接线。
 *
 * 顺序链（架构收窄接口后的统一形态）：
 *   显式注入 handler（synchronous，可 suspend）
 *     > TTY（synchronous，等真人；保留 Enter/n 习惯，久无输入只提醒不杀）
 *       > FailFast / StructuredStop（异步，stop：序列化请求 + 结构化停）
 *         > none（unavailable：批处理/无应答者，立即停，绝不 sleep 等人）
 */

import type { RescueChannel, RescueOutcome, RescueRequest } from "../support/intervention-contract.ts";

/**
 * TTY 通道：等真人；保留 Enter/n 习惯（不自动杀、默认无超时——加了就是行为变更，§7）。
 * 久无输入只提醒不杀（反模式清单：CI 默认等 30s/900s 不可接受；本通道缺省永不超时）。
 */
export function ttyChannel(prompt: (req: RescueRequest, signal?: AbortSignal) => Promise<RescueOutcome>): RescueChannel {
  return { id: "tty", synchronous: true, resolve: (req, signal) => prompt(req, signal) };
}

/**
 * 显式 handler 桥接通道：把宿主注入的确认函数（ctx.manual 的 manualRunner /
 * journey 的 manualHandler）适配成 RescueChannel——映射归 adapter，这里只做桥接形状。
 */
export function handlerChannel(
  id: string,
  handler: (req: RescueRequest, signal?: AbortSignal) => Promise<RescueOutcome> | RescueOutcome,
): RescueChannel {
  return {
    id,
    synchronous: true,
    resolve: (req, signal) => Promise.resolve(handler(req, signal)),
  };
}

/**
 * FailFast 通道（stop 模式专用）：不等待、不问人——序列化请求进结果、立即结构化停。
 * 与 ctx.manual 的 `--manual-fail-fast` 语义同源：非交互批处理遇到人工步直接 needs_human。
 */
export function failFastChannel(): RescueChannel {
  return {
    id: "fail-fast",
    synchronous: false,
    resolve: async () => ({ status: "unavailable", reason: "fail-fast: manual step needs a human; not waiting", at: Date.now() }),
  };
}

/**
 * StructuredStop 通道（stop 模式专用）：Agent / 桥面——结构化停、引擎不等待、Agent 只向
 * 用户问一次。`resolve` 永不真正挂起（synchronous:false）；请求经 result.rescue 序列化。
 */
export function structuredStopChannel(): RescueChannel {
  return {
    id: "structured-stop",
    synchronous: false,
    resolve: async () => ({ status: "unavailable", reason: "structured-stop: serialized into result.rescue; caller answers asynchronously", at: Date.now() }),
  };
}

/**
 * 无通道（none）：批处理 / 无应答者——立即 unavailable 退出，绝不等待。
 * 这是顺序链的兜底终点（§4：`none（unavailable：批处理/无应答者，立即停，绝不 sleep 等人）`）。
 */
export function noChannelOutcome(reason: string): RescueOutcome {
  return { status: "unavailable", reason, at: Date.now() };
}
