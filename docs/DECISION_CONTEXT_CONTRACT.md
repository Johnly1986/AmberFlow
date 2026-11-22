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

## DC7 责任边界：引擎喂什么，驾驶面喂什么

> 目的：把「决策所需的信息」按**事实/意图**划一条稳定的边界，消除当前「两面各建一套账本」
> 的重复与漂移。`elems`（候选池）是引擎抽取产物，**归引擎喂**；驾驶面不得自建候选面，
> 也不得自建禁选/已试账本。

### DC7.1 三条原则

- **R1 事实归引擎**：可由引擎自证、与页面/元素/动作结果相关的信息（候选池与结构事实、命中
  关系、页状态、aria 名称、禁选与已试账本、单元归属、attempts/outcome）由引擎单点提供；
  驾驶面**不得复制**（复制即漂移，实测：pilot 自建裸 ref 禁选 + 弱 inert 判据，与 run 面
  `RunAccounting`/`outcome-memory` 分叉）。
- **R2 意图归驾驶面**：目标语义（总目标/子目标措辞）、声明 hint/slot、face 策略（预算、
  driver 模式、歧义策略）由驾驶面提供；引擎**不臆测意图**（缺值仍 `needs_value`，缺目标
  仍 `target_not_found`，绝不代填）。
- **R3 组装与裁剪归引擎**：题面装配（投影白名单、行渲染、有界化、层预算、能力档裁剪、
  缓存指纹）是引擎单点职责；驾驶面只传参数与「段」（Face-specific segment），不得绕过
  白名单自行加字段。

### DC7.2 归属表（逐类）

| 信息 | 归属 | 现状 | 要求 |
|---|---|---|---|
| `elems` 候选池（含 label/tag/role/hints） | **引擎** | 引擎抽取（`_extractPoolSettled`），但由驾驶面传入 `pickProposal` | 引擎侧单点入口自取：面不得换池/裁剪池（聚合容器等**投影期**过滤在引擎内） |
| 结构事实（`kind`/`contains_candidate`/`prominence`/`row_texts`/`row_index`/`frame_*`） | **引擎** | 采集期产出，`modelProjectionOf` 剥离 | 由引擎按**模型面白名单**决定暴露哪些（当前全剥，见 DC7.3 缺口） |
| 可命中性（covered/zero-size/offscreen/ancestor） | **引擎** | `FN_HIT_RELATION` 探针（引擎） | 引擎在选中前判定并作为 L1 事实/注记提供 |
| 禁选 + 已试账本（tries/outcome/last） | **引擎** | run 面引擎（`RunAccounting`/`outcome-memory`）；**pilot 自建 `PilotLedger`** | 上收为引擎单源（按 esig），两面共享；面只声明作用域（run/subgoal/leg） |
| 页状态（url/title/main_text/state digest） | **引擎** | `urlOf`/`stateText`/`_buildStateDigest`（引擎） | 引擎按层预算裁剪；S5 档由面**声明策略**、引擎执行 |
| notes（逐候选负面证据） | **引擎** | pilot 从自建账本生成；run 用 `outcome-memory` | 引擎从共享账本生成（面不组装） |
| aria 名称对齐 | **引擎** | `ariaInteractiveLines`（引擎） | 引擎 |
| goal / instruction（意图） | **驾驶面** | pilot `drivingGoal`（含步史）、run `instruction`、session `goal` | 面只传意图；**步史移出 goal**（改独立段/注记，防回声） |
| 声明 hint / slot / values | **驾驶面** | 面提供 | 面 |
| 预算 / driver 模式 / 歧义与风险策略 | **驾驶面** | `maxSteps`/`driver`/`onAmbiguous` | 面声明、引擎执行 |
| L3 计划叙事 | **驾驶面（段）** | run 面 `RunScope`/plan 适配器 | 面以「段」注入，引擎校验形状与预算（DC1.3/1.4） |
| L4 站点知识 / site-facts | **引擎（数据）+ 面声明** | app `meta.site`、site-facts | 引擎读数据层，面只声明用哪个站点/来源 |
| 投影白名单 / 有界化 / 缓存指纹 / 能力档 | **引擎** | `modelProjectionOf`（手写两处）、`askSig`/`notesKey` | 引擎单点 + **白名单断言**（DC7.3） |

### DC7.3 现状缺口（改造成本与顺序）

1. **双账本**：`PilotLedger`（面）与 `RunAccounting`/`outcome-memory`（引擎）并存——上收引擎。
2. **`pickProposal` 由面传池与禁选**：引擎侧应提供单点入口
   `ask(page, scope, accounting, intent, profile)`（v5 契约形状），内部自取池、投影、账本、状态、
   裁剪；面只传意图 + 询问策略（可选段 S4 起）。
3. **模型面字段手写白名单**：`modelProjectionOf` 的 guard+解构两处列举无断言——加
   `MODEL_FACE_FIELDS` 闭集与断言（泄漏/漏剥双检）。
4. **能力档 `context` 未实施**：DC4 的 `none|minimal|full` 仍是提案；未声明 provider 时上文静默丢弃
   （仅 `context_skipped` 计数）——补声明并在产物里如实报告「哪层带/未带」。
5. **goal 混步史**：pilot 的 `drivingGoal` 把「已完成」拼进 goal——改为独立段/注记（防回声）。

迁移纪律：**S0a** characterization 门禁（确定性 provider 钉住请求/返回序列与 leg/attempt 生命周期，
零运行路径变更）→ **S0b** 账本适配（`RunAccounting`+`OutcomeMemory` 组成 `DecisionAccounting`，
**不删旧账**，逐项验证语义一致）→ **S1** 引擎 `ask` 实现 + 仅切 pilot `modelVote`（新旧双臂含成功票与宽扫）
→ **S2** run 以 `runModelPick` 整段接入（不得逐点换）→ **S3** 白名单断言 + `capabilities.context` +
Ports 接线 → **S4** 结构化段 + 步史迁出 goal（单独 A/B）。

### DC7.5 接口抽象（面向未来应用类型与 face）

**契约文件**：`src/engine/decision-ask-contract.ts`（**仅类型 + 两个常量**（`VERSION`/`LADDER_CODES`），无运行行为；对 `executor.ts` 只有 type-only 引用（`ModelPickPhase`，无运行时加载）——S1 批次才接实现与消费面；`ModelPickPhase` 后续建议下沉 `executor-types`）。

**两个方向**（四轮复审收敛后 v5，`DECISION_ASK_CONTRACT_VERSION = 5`；**未冻结**——冻结条件见复核记录）：
- 面 → 引擎：`ask(page, scope, accounting, intent, profile)`——`page` **复用 L0 `ProviderPage`**
  （含 `title()`；面持有的资源句柄——执行期页面与账本都是 `mw.run()` 调用内局部状态，引擎不存在
  可"自取"的成员）；`scope` = `DecisionLifetime`（`attempt{runId,subgoalId,attempt}` /
  `pilot-leg{runId,leg}`；跨 attempt 的 outcome-memory 由**工厂组合注入**，不压进一个 id），实例由
  **引擎工厂**创建；`intent` = `goal`/`instruction` + 声明锚点 `anchor` + 可选 `segments[]`（S1 不开放，
  S4 结构化）；`profile` = `face`/`confFloor`/`candidatePriority`/`tieredHint`（**缺省 false**，与执行期
  一致）/`reobserve`/`expectedFamily`/`adjudicate`/`stepTimeoutMs`（**阶梯硬约束**）/`needs[]`。
  **不含 elems/forbidden/notes**，也**不含驾驶循环策略与 remainingSteps**（driver/ambiguity/riskVote
  留在各面执行层——不属于一次询问）；anchor = 当前声明 hint（curHint）的权威语义
  （`actHint:"strict"` 不回退），窄问仅显式 tiered。
- 引擎 → 面：`DecisionAskOutcome` 是**判别联合**（`picked/abstained/limit/no_model`，杜绝非法组合）。
  picked 再按 `origin` 判别（`rule|escalate` ⇒ `signal:null`；`model` ⇒ 完整投票信号）——规则分支
  没有模型票；回 `executionPool`（产出 ref 的那份**完整执行池**，宽扫后为宽池；**模型投影
  （`modelProjectionOf` 输出）永不返回执行面**；面只读）+ `target = {ref, sig}`（池已回，不再重复
  元素字段）+ `signal.proposal`（**复用执行期 `PickProposal` 单源**）+ `signal.scoreKind`（复用
  `ProviderCapabilities["score_kind"]` 闭集）+ `method/via/asked` + `run` 元数据（`Pick<ModelPickPhase,…>`，
  执行器后续动作与 trace 的连续性载体）+ `ladder[]`（阶梯**事件账**，不承担最终动作语义）；
  `abstained.reason.code` **直接复用执行期 `StopCode` 子集**（含 action_space_exhausted/
  step_names_no_target/hint_matched_nothing/nominated_family_empty 等，不新造近似码）；`limit`
  复用 `decision_service_choice_limit`；`no_model.asked` 为已付询问数（provider 首败也是"问过之后
  降级"）；全部带 `context.layers[]` 逐层回执（`sent/clipped/unsupported/absent/rejected`，**禁止
  静默丢弃**，DC1.3/DC4）。

**扩展协议**：
1. **新 face / 新应用类型**：`DecisionFaceKind` 是**开放注册**（app 层注册、引擎校验，未知面
   结构化拒收）——注册项 + 一个薄适配器（把该面状态折成 intent/profile，消费 outcome），引擎零改动；
   只有真正接模型的 face 才注册（确定性寻址面如 session 不注册，见映射表）。
2. **新面特有上文**：S1 **不开放** segments；S4 起用**结构化判别联合**段（plan=L3、history=L2），
   L4 站点知识由 `DecisionAskPorts.siteFacts` 端口生成（engine 禁 import 应用层实现），不作任意面
   文本；**不新增第六层**（DC1.2），层预算 `tuning` 单点 + 裁剪序 L4→L3→L2。
3. **新 provider 类型**：只实现 `DecisionProvider` 接口并声明 `capabilities`（含 DC4 的 `context` 档），
   引擎不 import 具体实现（MAINLINE 方向冻结）。
4. **版本纪律**：`DECISION_ASK_CONTRACT_VERSION` 变更 = seam 变更（DC5③），先改 MAINLINE seam 表 + A/B。

**现状调用点 → 未来 `ask` 映射**：
| 面 | 现状 | 接入 |
|---|---|---|
| pilot | `driveOnce → modelVote → mw.pickProposal(goal,page,elems,forbidden,notes)` | 接：`ask(page, scope{pilot-leg}, acct, intent{goal}, profile{face:"pilot"})`（driver/ambiguity 留 pilot 执行层；墙钟走 `stepTimeoutMs` 硬约束） |
| run | 选择段是**单一 phase** `runModelPick`（executor 内一次调用，窄问→全池回退/宽扫/窗口升级/族修复共享同一份 elems/forbidden/noted 视图），账本为 `run()` 内局部 `RunAccounting` | 接入单位 = **整个 `runModelPick` phase**（不是逐 `pickElement` 点换——五处共享视图，逐点换会撕裂同一视图）：`ask(page, scope{attempt}, acct, intent{instruction,anchor}, profile{face:"run",confFloor,candidatePriority,tieredHint,…})`；L3 段由 run 面注入 |
| session | **不接入**：`doAct` 是显式 target+op+value 的确定性 `actOnce`，模型零参与 | 无询问面；只有未来出现"歧义时模型裁决"需求才注册 |
| 规划期（Phase 2） | 无 | 独立 `PlanningRequest` seam（DC6 Phase 2，先改 MAINLINE） |

**架构复核记录（2026-11-21，独立评审四轮 + 调用链核对 + 只读审计）**：

- **初审：不通过（v1）**。P0：①`ask` 无 page/scope（执行期页面与账本都是 `mw.run()` 调用内局部状态，
  retry 每次重入）；②outcome 只有位置 `ref`（缺生效池/单元素快照/完整投票信号，`passesFloor` 不可复现）；
  ③session 映射错误（`doAct` 是确定性 `actOnce`，零模型，不得注册询问面）。
- **复审：v2 仍不通过**（初版修正不完整，"已修正"表述**撤销**）。新增 P0：
  ④ run 的接入单位是**整个 `runModelPick` phase**——五个 `pickElement` 点共享同一份 elems/forbidden/noted
  视图（窄问回退/宽扫/窗口升级/族修复），逐点换会撕裂视图；⑤ profile 缺现行选择参数（`confFloor`/
  `candidatePriority`/`tieredHint`/步超时），outcome 缺阶梯事实（窄问/宽扫/升级/族修复），run 的
  后续动作与 trace 无法保持；⑥ `DecisionAccounting.record(el,outcome,desc)` 单签名**无法同时**替代
  `RunAccounting.forbid(ref,el,why)` 与 `OutcomeMemory.record(key(url,instruction),sig,outcome)`——
  作用域禁选与跨作用域记忆是**两组语义**，必须分开建模。P1：询问页需 `title()`（provider 渲染需要）、
  `signal` 实际缺 `entropyConf`（与"同形状"注释矛盾）、outcome 字段可非法组合（改判别联合）、
  reason/limit 码未闭集、零模型 lane 不能证明模型路径等价。
- **复审 3：v3 仍不通过**。P0：⑤ picked 强制模型 signal——规则分支无票（`method="rule:match"`、
  `conf=1.0`），执行器后续消费 `method/decisionKind/layaMargin/tierAsk/nominatedRepair/escalatedPick`；
  ⑥ 账本缺 pilot 守卫面（`changedLoop/unhittable/guardStop/loopTrip/evidence`）且 `recordOutcome` 丢
  `desc`——删 PilotLedger 则确定性守卫与交接证据必坏；⑦ `tieredHint` 缺省写反（执行期缺省 OFF），
  anchor"总是窄问回退"违背声明 hint 权威/`actHint:"strict"`；⑧ prune/notes 语义冲突（run `pruneStale`
  只删同 ref 签名失配 vs pilot 全量 esig 重映射；noted 仅 rank 档定文本 vs pilot 全部条目；
  `Outcome="inert"|"effective"` 与 esig 编码须单源）；⑨ `no_model.asked:0` 硬编码（provider 首败 =
  已问后降级）、reason 闭集缺 run 选择段停因码。P1：注册表须**组合根注入**（engine 禁 import
  应用层/site-facts，不许模块全局）；driver/ambiguity/riskVote 不属 pick；`budget.stepTimeoutMs`
  须**约束阶梯**而非只透传；段缺 rejected 回执。
- **复审 4（完整报告，基于 v3 工作树）**：verdict 不通过；其 P0-1/2/3 与 P1-1/3 已被 v4 吸收，
  本轮增量收敛为 v5：**类型单源复用**（`PickProposal`/`Sig`/`StopCode`/`ModelPickPhase`/
  `ProviderPage`/`score_kind`，删除结构复述防漂移）；outcome 字段更名 `executionPool` 并写明
  **模型投影永不返回执行面**；`target` 缩为 `{ref, sig}`；账本改**工厂绑定策略**（`prune`/`notesFor`/
  `forbiddenRefs` 按 lifetime 绑定，run=清 stale ref+rank 注记 / pilot=esig 重映射+全条目注记；
  `recordMemory` 收 `Sig` 与 `"inert"|"effective"` 闭集，effective 清旧 inert）；`DecisionAskPorts`
  组合根注入（faces/segments/siteFacts，engine 禁 import 应用层/site-facts，不许模块全局）；
  reason **复用 `StopCode`**、limit 复用 `decision_service_choice_limit`、`narrow_abstain` 移为
  ladder 事件；`ts` 统一 epoch ms（DC3 同形）；**批序改 S0a（characterization 门禁先行，钉住
  full/shortlist/rank-only/宽扫/rule/escalate/adjudicate/R2b/family-repair 与 leg/attempt 生命周期）
  → S0b（账本适配不删旧账，逐项验证 prune/notes/effective-清-inert/desc 一致）** → S1（仅切 pilot
  `modelVote`，新旧双臂含成功票与宽扫）→ S2（run 只在 `runModelPick` 整段接入）→ S3（白名单 +
  context 能力档）→ S4（结构化段 + 步史迁移单独 A/B）。
- **S3 前半已交付（2026-11-22）**：`tools/verify-model-face.ts`（`npm run verify:model-face`）——
  `modelProjectionOf` 的**泄漏/过剥双检**（13 个采集期字段全剥离、核心字段全保留、输入不可变、快路径
  与 `esig` 不变、模型面键集合 = 白名单）。**S3 余下**：`capabilities.context` 档声明（与既有
  `state_digest` 的关系需一并定稿）+ `DecisionAskPorts` 的组合根接线 + doctor 的 face×layer×provider 矩阵。
- **S1 一期（最小切片）已交付（2026-11-22）**：`src/engine/decision-ask.ts` 实现 `ask` 的**当前
  `modelVote` 语义**（窄问 → `filter` 聚合容器剔除 → 账本 forbidden/notes → floor 闸门 → 低置信宽扫
  重问（宽池真变大才重问）→ 弃权/命中），floor 闸门 `gateOf`/`passesFloor` 单源上收引擎；
  `src/app/pilot-ask-adapter.ts` 把 mw+PilotLedger 折成 `DecisionAskHost`（含 `ready()` 折 rules-only）
  并维护 pilot-leg 作用域/`noteRedirect()`；pilot 的 `modelVote` 已切面（legacy 保留为对照臂）。
  双臂对照 `tools/verify-decision-ask-parity.ts`：**5 场景 × 3 臂（legacy/ask/newPath）零差异**
  （请求投影/返回投影/ref/conf/shape/via/asked/执行池 ref 序/命中 sig）。**S1.2 未接入**：
  escalate/adjudicate/R2b/族修复/窗口升级、`tieredHint` 窄问、`rules_first`、`limit`、`stepTimeoutMs`
  硬约束、L3/L4 段与 ports、跨作用域 memory。已知差异（记录）：ask 内部重新抽一次池（S1.1 用
  executionPool 复用消除）；宽扫重问的 notes 按宽池重算（legacy 复用窄池 notes，属改善）。
- **S2 已落地（2026-11-22，两阶段）**：Stage-1 = `runModelPick` 实现**搬移+拆分**到
  `src/engine/decision-pick-phase.ts`（536 行，13 helper 最大 54 行；旧实现原样保留作对照臂），
  阶段对照 lane `tools/verify-decision-run-parity.ts` **16 场景 × 两臂逐字段零差异** + `--self-test`
  负向自测（4 类扰动均被 diff 抓住）；Stage-2 = `executor.ts` 调用点经 `src/engine/decision-pick-host.ts`
  （126 行、纯 `import type`、engine 不 import app）切到 `runDecisionPick`——`executor.ts` 2785→2786 行、
  `run()` 持平 883 基线，旧 `runModelPick` 标 `@deprecated` 保留；切换前后 `verify:pilot` 12/12、
  `verify:decision-characterization` 11/11、`verify:runtime:offline` 8/8、parity 16/16 **逐字一致**。
  **Stage-3（未做）**：先给 parity 旧臂快照 golden，再删旧实现/re-export/清理 `phaseFunctions` 基线例外
  （`--update`，不手改 baseline）与注释里的符号引用。
- **S4 设计口径（未实施）**：①**步史移出 goal**——pilot 的 `drivingGoal` 目前把"已完成: …"拼进 goal
  （回声风险 + 缓存键抖动），S4 改为 `intent.segments=[{kind:"history", layer:"L2", text:…, provenance}]`，
  goal 只留目标原文；②**结构化段**——L3 plan narrative / L2 history 用判别联合（`{kind, layer, text,
  provenance}` 已定义，S4 把 `text` 的自由文本收紧为结构化字段渲染，防面借自由文本绕过白名单/注入敏感值）；
  ③**A/B 口径**：段注入改变题面 → 必须走 DC5 真站 A/B（同 label 七选一 + 停因恢复两条锚），且
  `--driver agent` 侧零影响；④**顺序**：S4 在 S3 的能力档与 Ports 接线之后（否则 `full` 档无段可带）。
- **S3 完整已落地（2026-11-22）**：`ProviderCapabilities.context?: "none"|"minimal"|"full"`（**只声明不改协议**）——
  本地 laya = `minimal`、decision-service/OpenAI Decisions = `full`、baselines 三个 + 工具 scripted-stub = `none`；
  实验 provider（jevk5/bailian/token-plan）**未声明**（doctor 呈现 none，保守）。`decision-ask` 逐层回执改为
  **按声明档裁剪**：`none/minimal` → L3/L4 `unsupported`；`full`/未声明且端口未接 → `absent`；提供了段但
  face/段未注册、层不符、无端口 → `rejected`（**不 abort**，picked/abstained 不变）。Ports 经
  `buildMiddleware({options.decisionAskPorts})` 组合根注入（WeakMap 寄存，不改执行器类型面）；`amber doctor`
  增只读 `decision context: provider=… context=… state_digest=…` 矩阵；新 lane `tools/verify-decision-context.ts`
  **47 项断言**全绿。**已知限制（接受）**：scripted-stub 消融档运行期经 laya legacy 分支呈 minimal（与 laya-onnx
  不可区分，要区分需动 executor 类型面，不做）。
- **S2-Stage-3 已落地（2026-11-22）**：先 `--record` 用**旧臂**录 16 场景 golden
  （`tools/golden/decision-run-parity/cases.json`，两遍一致才入盘）→ 再删旧 `runModelPick`（
  `executor-phases-b.ts` 607→196 行；`src/` 内 grep 为空）→ `--check` 用**新臂**对 golden **16/16 零差异**；
  退役后 `--record` 拒绝执行（防被检实现自证）。`executor.ts` import 直连 `runDecisionPick`（`run()` 持平 883）。
  **后续 baseline 维护待办（已登记）**：①专门提交用 `--update` 接受合法下调（`executor.ts 2833→2787` 等）；
  ②用专门手段删除 `phaseFunctions` 里的死条目 `executor-phases-b.ts#runModelPick`（`--update` 按设计不修剪
  allowlist）；③复跑 maintain。
- **当前状态：工作树 v5（**未提交、未冻结**；类型单源 / executionPool / 工厂绑定账本 / Ports 注入 /
  StopCode 复用 / ts 对齐 DC3；审计 P1 已修：`run` 元数据补 `conf`/`label`、`notesFor` 增可选作用域、
  `forbid/unforbid` pilot 不对称与 `entries≤8/不含守停现场` 写进契约、`ruleSkip` 的聚合容器归池构成事实）。
  批序：**S0a → S0b → S1 → S2 → S3 → S4**。冻结条件 = ①S1 实现后模型路径等价证据（provider stub 消融 + 真站 A/B，DC5 锚），
  ②闭集码与执行期停因分类的断言一致，③独立评审复看通过。**分批顺序**：S0（`RunAccounting`→
  `DecisionAccounting`，**双语义接口**，run 面逐字节不变）前置 → S1（ask 实现 + pilot 切面）→
  S2（run 以 `runModelPick` 整段接入）。

**验收**：契约本身零行为（typecheck + maintain 即可）；S1 切换后 §3.2 lane + `verify:runtime:offline`
对照（逐场景行为等价）——**零模型 lane 只证降级路径，模型路径等价另需 provider stub 消融 + 真站 A/B
（DC5 锚）**；新 face 接入 checklist = 注册项 + 适配器 + 一条 lane 场景（不新增 stopCode）。
