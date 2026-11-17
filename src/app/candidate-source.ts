/**
 * 应用层候选生产者（BACKLOG #2「候选列表上移应用层」的 app 层落点）。
 *
 * **真实实现（2.2b）**：`extract(req)` 参数逐字转调 app 层扫描实现
 * `./candidate-scan.ts`（从 engine/extraction 整函数搬来的 `extractElements`），
 * 所有经 `buildMiddleware` 的入口默认注入本 producer ⇒ "候选列表怎么来"由应用层拥有，
 * 引擎只消费 `CandidateProducer` 契约。行为与迁移前逐字节等价（纯搬移 + 参数映射不变）。
 *
 * 纪律：本文件是 app 层，允许向 engine 借**结构契约**；扫描实现必须留在 app 层
 * （engine 不再 import 扫描）。不 import Playwright 具体类型，不新增页面 I/O 侧效应。
 */
import { extractElements } from "./candidate-scan.ts";
import type { CandidateExtractRequest, CandidateProducer } from "../engine/candidate-contract.ts";
import type { ElemPool } from "../engine/extraction.ts";

/**
 * 创建 app 层候选生产者：转调 app 层 `extractElements`，请求字段→实参逐字映射
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
