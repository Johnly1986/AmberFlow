/**
 * 候选生产者契约（BACKLOG #2 第一步）：**引擎只依赖这个纯数据契约**去取元素池。
 *
 * 定位：扫描/筛选/排序的实现即将上移应用层（2.2）；本文件先把"请求什么、返回什么"
 * 固化成结构类型，引擎侧调用点只认 `CandidateProducer.extract(req)`——下一批应用层
 * 注入自己的实现即可，执行器不用再改。契约本身不做新行为、不起浏览器、不做页面 I/O
 * 之外的决策（页面读取的副作用由实现方负责，默认实现完全沿用既有引擎扫描）。
 *
 * 纪律：
 *   - 不 import Playwright 具体类型（`PageLike` 是引擎结构类型，兼容注入的 page/session）；
 *   - 纯数据入参/出参（`ElemPool` + 可选的步级预算元数据）；
 *   - 默认实现是**临时**的：内部转调 `extraction.extractElements`，参数逐字搬移，
 *     行为与改造前逐字节等价。2.2 把扫描实现搬到 app 层后，本默认实现随之删除/降级。
 */
import { extractElements, type ElemPool, type PageLike, type PoolQuotas } from "./extraction.ts";
import type { SurfacePolicy } from "./surface.ts";

/** 一次候选抽取请求（字段与 `extraction.extractElements` 的实参面一一对应）。 */
export interface CandidateExtractRequest {
  /** 结构页面类型（Playwright 的 Page 与引擎注入面都满足它；无具体类型 import）。 */
  page: PageLike;
  /** 是否跑交互控件探测（缺省 true，与 `extractElements` 一致）。 */
  jsProbe?: boolean;
  /** 池上限：缺省 = `extractElements` 的 `MAX_ELEMENTS`；宽扫传 `WIDER_ELEMENTS`。 */
  maxElements?: number;
  /** 抽控件面（`jsInteractiveWidgets` 前置探针）；宽扫用 true。 */
  widgets?: boolean;
  /** A2 分桶配额；`null` = main-first 回退面（与 `extractElements` 同义）。 */
  quotas?: PoolQuotas | null;
  /** A2：`meta.policy.candidate_priority`（缺省 "bucketed"）。 */
  candidatePriority?: "bucketed" | "main-first";
  /** U3：`meta.policy.surface.native_activation`（缺省 window）。 */
  surface?: SurfacePolicy;
  /** P0-D：host 信封（只从信封内 frame 抽池；null = 今天的全帧面）。 */
  hosts?: string[] | null;
  /** E1-b：池配额模型（缺省 "legacy"）。 */
  poolQuotaMode?: "legacy" | "quota";
  /**
   * 步级剩余预算（毫秒）——**纯元数据**：默认实现不使用（`extractElements` 无此参数），
   * 留给 2.2 应用层生产者决定 settle/扫描预算；引擎只负责如实传递。
   */
  deadlineMs?: number;
}

/** 候选生产者：引擎唯一依赖的抽池 seam（默认实现见 `createEngineCandidateProducer`）。 */
export interface CandidateProducer {
  extract(req: CandidateExtractRequest): Promise<ElemPool>;
}

/**
 * 临时默认实现：包当前引擎扫描 `extractElements`，参数逐字搬移（缺省语义不变）。
 * 2.2 扫描实现上移应用层后由应用层注入的 producer 取代；在那之前这是唯一实现。
 */
export function createEngineCandidateProducer(): CandidateProducer {
  return {
    extract: (req) =>
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
