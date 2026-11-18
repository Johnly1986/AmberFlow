# 决策上下文契约（Decision Context Contract）v1.0

> 状态：**提案 v1.0（设计出处先行，实施登记待批次）**。
> 先例：`docs/INTERVENTION_RESCUE_MODULE.md` 同款流程——设计文档先行，v1 实施后在本文件补记状态，并在实施批次内于 `src/cli/schema-gen.ts` 登记 F 号（statement + truth 同批落地，遵守失效引用纪律：F 号不引用尚不存在的代码）。
> 本文件是"决策模型上文信息"契约条款的**唯一出处**；`src/support/decision-provider-contract.ts` 是其 L0 数据形状的唯一出处（实施批次落地）。
> 关联：`docs/DECISION_SERVICE_CONFIG.md`（决策源三件套）、`docs/INTERVENTION_RESCUE_MODULE.md`（监督面）、`src/prompts/evidence-prompts.ts`（分级预算）、`src/model/laya-format.ts`（截断单源）、`docs/MAINLINE.md`（seam 冻结表——Phase 2 新请求面属 seam 变更，先改 MAINLINE 再改代码）。

## 背景（实证依据）

同 label 网格（携程 7 颗"订票"）模型不可区分：`row_texts` 被剥离出模型投影（F82），模型面只剩等值 label；停因恢复路径"失忆重试"：重试决策不带"上一次为何停"。两者同根：**决策接口的上下文饥饿**。本契约把"上文信息"从优化项升格为两期必要输入。

## DC1 原则条款

- **DC1.1 两期必要输入**：执行期与规划期的决策模型调用必须携带上文信息；无上文段的请求 = 契约违规（缺省省略仅允许在 provider 能力档不支持时，见 DC3 能力矩阵）。
- **DC1.2 分层闭集**：上文分五层——L0 任务 / L1 页面 / L2 运行史 / L3 计划叙事 / L4 站点知识；每层内容与出处在 §DC2 单点定义，请求侧不得发明第六层。
- **DC1.3 有界与裁剪序**：每层独立字符预算；总预算超限按 **L4→L3→L2** 顺序裁剪，**L0/L1 恒在**；任何裁剪必须逐层如实回传（复用 `laya-format` 的截断单源与 `evidence_truncated` 既有链，不复制实现）。
- **DC1.4 溯源强制**：每段上文带来源标签 `{kind, ref, ts?, version?}`（合法 kind：`probe` / `trace` / `site-facts` / `memory` / `slots` / `plan`）；无溯源标签的上文段不得进入请求——审计链在输入侧不断。
- **DC1.5 裁决权不变**：上文改变模型**输入**，不改变模型**权力**——① done 裁决唯一出自 `checkSignal`（D2）；② 值采纳唯一走声明面/确认面（提案≠填入，红线②）；③ 作者显式声明（行锚/`target_hint`）压过模型判断（F85）；④ 危险动作 dry-run+确认面不受影响。

## DC2 五层内容定义（唯一出处）

| 层 | 执行期内容 | 规划期内容 | 采集出处（直通，不新增采集面） |
|---|---|---|---|
| L0 任务 | 当前步 goal/instruction | 用户目标 + 约束 + hosts/device 环境事实 | 请求字段（现状） |
| L1 页面 | 池投影 + StateDigest（现状字段不动） | probe/inspect 产出的页面事实摘要 | `StateDigestPayload` / probe 报告 |
| L2 运行史 | `forbidden[{ref,why}]`、`notes`、attempts、noteSkipped | （作为"上版运行事实"输入） | `RunAccounting` 四组记账直通 |
| L3 计划叙事 | `plan.goal` + `progress[{id,status,stop_code?}]` + `position` + 数据腿产出摘要 | 起草输入（前版 plan 即 L3） | RunScope / plan 适配器 |
| L4 站点知识 | site-facts digest + hint-memory（url+subgoal 权威 hints） | 同左 + 上版 plan 与停因历史 | site-facts / hint-memory / online-runs 摘要 |

## DC3 请求形状（L0 纯数据文本草案）

执行期：`ChoiceRequest` / `ClosedSetRequest` 增**可选** `context?: DecisionContext`——缺省省略 = 现行为逐字节不变；provider 按 `ProviderCapabilities` 声明是否消费（能力矩阵分档）。

```ts
/** 溯源标签（DC1.4；无标签的上文段不得进入请求）。 */
export interface DecisionContextSource {
  kind: "probe" | "trace" | "site-facts" | "memory" | "slots" | "plan";
  ref: string;            // 探针 id / run_id / site-facts 版本 / url+subgoal / 槽位名
  ts?: number;            // 产出时刻（epoch ms，可省）
  version?: string;       // 产出物版本（site-facts / plan_sha256 前缀，可省）
}

/** 分层预算与裁剪记账（DC1.3；truncated 层必须由请求方如实标注）。 */
export interface DecisionContextLayer {
  layer: "L0" | "L1" | "L2" | "L3" | "L4";
  budget_chars: number;
  used_chars: number;
  truncated: boolean;
  sources: DecisionContextSource[];
}

/** L3 计划叙事（执行期 = 进行中计划；规划期 = 前版 plan 摘要）。 */
export interface DecisionContextPlanSegment {
  goal: string;
  progress: Array<{ id: string; status: string; stop_code?: string }>;
  position: number;                 // 1-based 当前/起草位次
}

/** L2 运行史（RunAccounting 直通；字段与 run-context.ts 账本一一对应）。 */
export interface DecisionContextRunSegment {
  forbidden: Array<{ ref: string; why: string }>;
  notes: Record<string, string>;
  attempts: number;
}

/** L4 站点知识。 */
export interface DecisionContextSiteSegment {
  facts_digest: string;             // site-facts 有界摘要
  memory_hints: string[];           // hint-memory 权威 hints（url+subgoal 命中）
  prior_stops?: Array<{ run_id: string; stop_code: string; reason: string }>;
}

export interface DecisionContext {
  plan?: DecisionContextPlanSegment;   // L3
  run?: DecisionContextRunSegment;     // L2
  site?: DecisionContextSiteSegment;   // L4
  layers: DecisionContextLayer[];      // L0–L4 全列（含恒在层），记账面
}
```

规划期（**Phase 2，随方案 C 引入**；仅设计位，登记随实施批）：`PlanningRequest { goal, constraints, context（L1/L2/L4 必给，L3=前版 plan）, budgets } → PlanningOutcome { plan_draft }`；产出必须过 `PlanningRules` 离线校验与 `plan check --probe` 在线核对后方可执行。

观察值提案（**Phase 3**）：`ChoiceOutcome` 增可选 `value_proposals?: Array<{ field: string; value: string; provenance: DecisionContextSource; confidence: number }>`——**提案≠填入**；采纳唯一通道 = 确认面/声明化（值来源闭集不扩，红线②原文不变）。

## DC4 能力矩阵与预算

- 能力分档（`ProviderCapabilities` 增声明位）：`context: "none" | "minimal" | "full"`——`none` = 不消费（请求方可省略 context，DC1.1 豁免仅此一档）；`minimal` = L0/L1/L2（laya-onnx 本地档，受既有 token 单源约束）；`full` = L0–L4（决策服务档）。
- 预算常量进 `src/support/tuning.ts` 单点（env 可覆写，命名闭集）：`DECISION_CTX_L3_CHARS` / `DECISION_CTX_L4_CHARS` / `DECISION_CTX_SITE_FACTS_DIGEST_CHARS` / `DECISION_CTX_MEMORY_HINTS_MAX`；执行期总上下文预算并入既有分级预算框架（40/120/200 同族），裁剪实现复用 `fitText`。
- 请求方（执行器/规划面）负责按层装配、记账 `layers[]`、按 L4→L3→L2 裁剪；provider 只读不裁。

## DC5 门禁与验收

- **门禁**：① context 字段进桥面则走 `run-args-contract` 生成链（新增字段只改契约 + 重新生成，五处消费点不动）；② 模型提示词改动 = D7 全套（version+1 + `tools/golden/prompts` 快照 + 真站 A/B 一条）；③ Phase 2 新请求面 = seam 变更，先改 `docs/MAINLINE.md` 再动代码。
- **验收锚（真站 A/B，缺一不收）**：
  1. 同 label 七选一（ctrip 列表形）：加 L3 + 行上下文 vs 现状——`decisions.ladder` model 命中率、误点率（误点 = 0 容忍，误点即回退 rules-only）；
  2. 停因恢复路径：带 L2/L3 的重试 vs 现状失忆重试——恢复成功率、重试动作数；
  3. 规划期（Phase 2）：带 site-facts + 停因历史起草 vs 无上下文起草——probe 一次通过率、行锚词元准确率。

## DC6 实施分批与登记

| 批 | 内容 | 前置 |
|---|---|---|
| Phase 1 | 执行期 L2 直通 + L3 有界 + `DecisionContext` 类型与能力矩阵声明；rules-only 路径零行为变化（全点名 plan 下 model_asks 仍为 0） | 无（纯增量） |
| Phase 2 | 规划期 `PlanningRequest/Outcome`；先改 MAINLINE | 方案 C 架构评审通过 |
| Phase 3 | 观察值提案位 + 采纳闸 | Phase 1 + 确认面扩展评审 |

登记纪律：每实施批次一个 F 号（`statement` 写行为契约、`truth` 写实施文件单点），F 号与代码同批提交；本文件在该批次更新状态行（"提案"→"v1 已实施（批次记录见 CHANGELOG）"）。
