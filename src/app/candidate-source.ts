/**
 * 应用层候选生产者（BACKLOG #2「候选列表上移应用层」的 app 层落点）。
 *
 * 2.2a 应用层占位实现：`extract(req)` 参数逐字转调引擎扫描 `extraction.extractElements`，
 * 与 `engine` 默认生产者（`candidate-contract.createEngineCandidateProducer`）同口径，
 * 行为逐字节等价——本步只把**真实代码路径**切到 app 层（所有经 `buildMiddleware` 的入口
 * 默认注入本实现），不改变任何候选/ref 结果。
 *
 * 2.2b 计划：把扫描/筛选/排序实现搬入本文件（或 app 子模块），删除 engine 侧默认实现；
 * 那时应用层生产者才真正拥有"候选列表怎么来"的决定权，引擎只保留契约消费。
 *
 * 纪律：本文件是 app 层，允许且只允许向 engine 借**结构契约/扫描实现**；不 import
 * Playwright 具体类型，不新增页面 I/O 侧效应（页面读取/探测全部由被调用的引擎扫描完成）。
 */
import { extractElements, type ElemPool } from "../engine/extraction.ts";
import type { CandidateExtractRequest, CandidateProducer } from "../engine/candidate-contract.ts";

/**
 * 创建 app 层候选生产者：当前转调 `extractElements`，请求字段→实参逐字映射
 * （缺省语义与引擎默认实现一致：`jsProbe` 缺省 true、`maxElements` 缺省按预算档）。
 */
export function createAppCandidateProducer(): CandidateProducer {
  return {
    extract: (req: CandidateExtractRequest): Promise<ElemPool> =>
      extractElements(req.page, req.jsProbe ?? true, req.maxElements, {
        ...(req.widgets === undefined ? {} : { widgets: req.widgets }),
        ...(req.quotas === undefined ? {} : { quotas: req.quotas }),
        ...(req.candidatePriority === undefined ? {} : { candidatePriority: req.candidatePriority }),
        ...(req.surface === undefined ? {} : { surface: req.surface }),
        ...(req.hosts === undefined ? {} : { hosts: req.hosts }),
        ...(req.poolQuotaMode === undefined ? {} : { poolQuotaMode: req.poolQuotaMode }),
      }),
  };
}
