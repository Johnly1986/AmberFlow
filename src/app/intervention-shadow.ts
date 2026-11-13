/**
 * 介入 / 救援中断模块 —— 影子记录器装配件（docs/INTERVENTION_RESCUE_MODULE.md §8 步 2 后半）。
 *
 * 影子三决定：
 *   ① 旧路径权威：只旁路构造 RescueRequest + 计算 outcome，不调任何交互通道、
 *      不改任何返回值 / trace / 预算（构造与映射归 intervention-adapter.ts 单源）；
 *   ② sidecar 只写 `outDir/rescue-shadow.json`，独立开关 `AMBERFLOW_RESCUE_SHADOW=1`
 *      （仅此值生效），默认产物零字节不变、不进 result；
 *   ③ 不做切换。
 *
 * 本文件只负责：开关判定 + 一个 run 一份的记录器（内存累积、flush 才碰文件系统）。
 * ctx.ts 只依赖最小鸭子接口 `{ noteShadow(...) }`（ctx-types.ts），由 app-runner 在
 * 开关开启时用 adapter 的实现适配注入。
 */
import fs from "node:fs";
import path from "node:path";
import type { RescueShadowRecord } from "../support/intervention-contract.ts";
import { createRescueState, type RescueChain, type RescueState } from "../intervention/index.ts";

/** 影子模式总开关：仅 `AMBERFLOW_RESCUE_SHADOW=1` 生效（其余值一律视为关）。 */
export function isRescueShadowEnabled(): boolean {
  return process.env.AMBERFLOW_RESCUE_SHADOW === "1";
}

/** 影子记录器：一个 run 一份；records 在内存累积，flush 才碰文件系统。 */
export interface ShadowRecorder {
  readonly chain: RescueChain;
  readonly records: RescueShadowRecord[];
  /** 写 `<outDir>/rescue-shadow.json`（2 空格缩进）；失败静默（影子不掩盖运行结果）。 */
  flush(outDir: string): void;
}

export function createShadowRecorder(runId: string): ShadowRecorder {
  const records: RescueShadowRecord[] = [];
  const state: RescueState = createRescueState(runId, false);
  const chain: RescueChain = {
    run_id: runId,
    state,
    onShadow: (record) => { records.push(record); },
  };
  return {
    chain,
    records,
    flush(outDir: string): void {
      try {
        fs.writeFileSync(path.join(outDir, "rescue-shadow.json"), `${JSON.stringify(records, null, 2)}\n`);
      } catch { /* sidecar 失败不影响运行结果 */ }
    },
  };
}
