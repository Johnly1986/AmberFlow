/**
 * `amber pilot` 的现场证据与步间投影（pilot-runtime 拆分；方案见
 * docs/PILOTED_WALKTHROUGH_PLAN.md §PW1/§PW2）。
 *
 * 两件事共用一条纪律：**每件独立失败、独立缺字段——证据/投影失败不掩盖停因本身**。
 *   - 交接四件套（PW1）：截图 / DOM（>2MB 截断注明总长）/ 池快照（最近一轮抽池的
 *     ElemPool 原样落盘）/ observe 明细；
 *   - agent 驾驶的步间候选投影（--driver agent）：observe 契约行的有界子集
 *     （ref/tag/label/hint_candidates——hint_candidates 本就经 hintMatch 自证唯一命中）。
 */
import fs from "node:fs";
import path from "node:path";
import { urlOf } from "../engine/extraction.ts";
import type { ObserveResult } from "../engine/observe.ts";
import type { AnyPage } from "../engine/executor.ts";
import type { ElemPool } from "../engine/elem-model.ts";
import { sleep } from "../support/sleep.ts";
import { bounded, isObj } from "./session-runtime-contract.ts";
import type { PilotHandoff } from "./pilot-contract.ts";

/** DOM 快照落盘上限（超长截断并注明总长，避免长页把证据目录写爆）。 */
const DOM_SNAPSHOT_CAP_BYTES = 2_000_000;
/** agent 步间投影的观察窗（观察面缺省档）：40 会先被侧栏/章元素占满，正文候选不可见。 */
const STEP_REQUEST_OBSERVE_MAX = 120;

/** 观察闭包的形状（pilot-runtime 注入 ctx().observe）。 */
export type PilotObserve = (opts: { max: number }) => Promise<ObserveResult>;

/** 停驶现场四件套：各自独立落盘、独立失败、独立缺字段。 */
export async function handoffEvidence(a: {
  page: AnyPage;
  outDir: string;
  stepCount: number;
  lastPool: ElemPool | null;
  observe: PilotObserve;
}): Promise<PilotHandoff["evidence_refs"]> {
  const { page, outDir, stepCount, lastPool, observe } = a;
  const refs: PilotHandoff["evidence_refs"] = {};
  try {
    const shot = path.join(outDir, `handoff-${stepCount}.png`);
    await bounded(() => page.screenshot?.({ path: shot }), 5000);
    refs.screenshot = shot;
  } catch { /* 截图失败不掩盖停因 */ }
  try {
    const dom = path.join(outDir, `handoff-${stepCount}.dom.html`);
    // DOM 读取有界（卡死页面不能拖住交接）：bounded 是弃值 race，这里要拿回文本，
    // 用 Promise.race 自己兜超时；失败/无 content = 如实缺字段。
    const html = await Promise.race([
      Promise.resolve().then(() => page.content?.() ?? "").catch(() => ""),
      sleep(5000).then(() => ""),
    ]);
    if (html !== "") {
      fs.writeFileSync(
        dom,
        html.length > DOM_SNAPSHOT_CAP_BYTES
          ? `${html.slice(0, DOM_SNAPSHOT_CAP_BYTES)}\n<!-- truncated: ${html.length} bytes total -->`
          : html,
        "utf8",
      );
      refs.dom = dom;
    }
  } catch { /* DOM 落盘失败不掩盖停因 */ }
  try {
    if (lastPool !== null) {
      const p = path.join(outDir, `handoff-${stepCount}.pool.json`);
      fs.writeFileSync(p, JSON.stringify(lastPool, null, 2), "utf8");
      refs.pool_snapshot = p;
    }
  } catch { /* 池快照失败不掩盖停因 */ }
  try {
    const obs = await observe({ max: 120 });
    const p = path.join(outDir, `handoff-${stepCount}.observe.json`);
    fs.writeFileSync(p, JSON.stringify(obs, null, 2), "utf8");
    refs.observe = p;
  } catch { /* observe 失败如实缺字段 */ }
  return refs;
}

/**
 * agent 驾驶的步间候选投影：observe 契约行的 ref/tag/label/hint_candidates 有界子集
 * （Agent 照抄 hint_candidates 进 resume.hint 即确定性执行）。observe 失败 = 空候选，
 * Agent 仍可读证据目录/redirect/abort。
 */
/**
 * agent 驾驶的步间投影（`--driver agent`）：候选行有界投影后经 respond 写出；浏览器已死 =
 * 空候选（投影失败不掩盖收尾）。与 `handoffEvidence` 同族：每件事实独立失败，不抛整块。
 */
export async function emitStepRequest(args: {
  respond: (obj: Record<string, unknown>) => void;
  page: AnyPage | null;
  observe: PilotObserve;
  lastPool: ElemPool | null;
  goal: string;
  step: number;
}): Promise<void> {
  const view = args.page === null
    ? { url: "", poolSize: 0, candidates: [] as Array<Record<string, unknown>> }
    : await agentStepCandidates({ page: args.page, observe: args.observe, lastPool: args.lastPool });
  args.respond({
    type: "step_request", unsolicited: true, pilot: true, driver: "agent",
    step: args.step, goal: args.goal, url: view.url, pool_size: view.poolSize, candidates: view.candidates,
  });
}

export async function agentStepCandidates(a: {
  page: AnyPage;
  observe: PilotObserve;
  lastPool: ElemPool | null;
}): Promise<{ url: string; poolSize: number; candidates: Array<Record<string, unknown>> }> {
  const { page, observe, lastPool } = a;
  let url = "";
  const candidates: Array<Record<string, unknown>> = [];
  let poolSize = lastPool === null ? 0 : Object.keys(lastPool).length;
  try {
    url = urlOf(page);
    const obs = await observe({ max: STEP_REQUEST_OBSERVE_MAX });
    poolSize = obs.counts?.elements ?? poolSize;
    for (const el of obs.elements ?? []) {
      if (!isObj(el)) continue;
      const row: Record<string, unknown> = {};
      for (const k of ["ref", "tag", "label", "hint_candidates"] as const) {
        const v = (el as Record<string, unknown>)[k];
        if (v !== undefined) row[k] = v;
      }
      if (Object.keys(row).length > 0) candidates.push(row);
    }
  } catch { /* observe 失败 = 空候选：如实投影，Agent 仍有 redirect/abort 出口 */ }
  return { url, poolSize, candidates };
}
