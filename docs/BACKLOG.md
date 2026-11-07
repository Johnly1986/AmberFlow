# 工程优化待办（Backlog）

> 定位：记录**已确认要做**的引擎/应用层优化待办。每条含现状锚点（`路径:行号`，以 2026-10-31 快照
> `377f194..fa2cd63` 为准）、目标与验收标准；实施完成后在条目标注完成提交号，并同步 CHANGELOG。
> 来源：项目所有者 2026-10-31 提出三项方向性优化。

---

## 1. 统一决策函数入口：规划决策与流程执行同源

**状态**：done（2026-11-01 落地）｜ **优先级建议**：P1

> **落地记录（2026-11-01，前提变更后重定义范围）**：项目方前提——**规划任务在 Agent 内完成，
> 本系统不做独立规划**。据此本条从「两条 LLM 入口合并」改为「收缩 + 重接」：
>
> - 引擎内 LLM 规划/重规划面**移除**（原验收 #2 的「规划侧改走 provider spec」以此形式落地）：
>   `LLMPlanner`、`plan-cli new --llm`、`plan-cli run --replan`（及 `amber plan new/run` 的
>   `--llm`/`--replan` 转发）与 `PLANNER_MODEL` 配置键都不再存在；被挡子目标以
>   `blocked + obstacle` 结构化结果返回，由 Agent 决定下一步。
> - `llmEscalator`（步级决策，非规划）由 `src/model/provider-escalator.ts` 承接：经
>   `DecisionProvider.askChoice` 闭集窄问（池外 → null，双层 fail-closed），原裸读
>   `OPENAI_*` 的实现删除；接线为 opt-in（`--escalate`），`askChoice` 计入 `countedProvider`
>   咨询计数（满足原验收 #1/#3）。
> - `plan-cli run` 接入与 start/apps/online 相同的决策源解析（满足原验收 #4：
>   同一 `--provider` 覆盖对执行与 escalation 同时生效）。
> - `OPENAI_BASE_URL`/`OPENAI_API_KEY` 只剩事后审计（`LLMAuditor`）一个消费者；
>   边界说明见 `docs/DECISION_SERVICE_CONFIG.md` §6。

### 现状（问题，落地前存档）

决策目前有**两个不同入口**，行为与可观测性不一致：

| 入口 | 位置 | 走 provider 缝？ |
|---|---|---|
| 流程执行（flow 应用/线上套件的逐步决策） | `src/app/app-runner.ts:2189,2239` → `resolveProviderSpec` / `applySpecToRuntime` | ✅ capabilities 自报、`score_kind`、`conf_floor`、`withDecisionCache`、`countingRuntime`、审计计数齐全 |
| 规划/恢复（plan 生成、低置信恢复 rung） | `src/engine/planner.ts:66-118` 的 `llmEscalator`；`src/cli/plan-cli.ts --llm` | ❌ 裸读 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `PLANNER_MODEL`，硬编码 OpenAI `/chat/completions` 协议，无 capabilities/闸门/缓存/计数 |

后果：同一个换模型/消融动作在两条入口上语义不同（provider 三件套只管执行侧；
`OPENAI_*` 只管规划侧）；横评、缓存命中、决策审计（`decisions` 块）对规划侧不可见；
新增 provider 时要改两处协议代码。

### 目标

规划决策（计划生成、恢复 rung）与流程执行共用**同一个决策函数入口**——即统一走
`src/model/decision-provider.ts` 的 provider 缝（或在其上封装单一门面），
capabilities/`score_kind`/`conf_floor`/缓存/计数/审计对两条路径同语义。

### 验收标准

1. `llmEscalator`（或其替代）作为 provider 接入缝：自报 capabilities、支持
   `score_kind`/floor，出题/答案仍受"只能选已存在 ref、fail-closed"约束。
2. plan-cli 与 planner 的 LLM 调用不再直读 `OPENAI_*`（改由 provider spec 解析）；
   保留 `--provider` 仅实验/消融的既有纪律。
3. 决策审计：规划侧调用出现在与执行侧同构的 decisions/trace 记录里（含缓存命中）。
4. 横评/消融：同一 `--provider` 覆盖对两条路径同时生效。

### 涉及文件

`src/engine/planner.ts`、`src/cli/plan-cli.ts`、`src/model/decision-provider.ts`、
`src/app/app-runner.ts`、`docs/DECISION_SERVICE_CONFIG.md`（配置说明同步）。

---

## 2. 候选元素列表上移应用层：浏览器相关代码抽离出引擎

**状态**：open ｜ **优先级建议**：P2（架构重构，需先定接口）

### 现状（问题）

候选元素列表的**生产与筛选**全部在引擎层，且与浏览器实现强耦合：

- `src/engine/extraction.ts`：元素池扫描/筛选（`extractElements:680`、
  `extractRowsPerElement:731`、`candidateMeta:722`、AX 主源、宽扫伪按钮 `:814`）
  直接持有 `PageLike` 并在页面内执行 JS 探针；`MAX_ELEMENTS:352`、
  `WIDE_POOL_ELEMENTS:357` 两个预算常量也在引擎层。
- `src/engine/executor.ts` 直接创建浏览器会话（`browserSession:737`）并消费上述池。
- 后果：引擎核心（决策/闸门/信号语义）无法脱离浏览器实现测试与复用；
  "候选列表怎么筛"是**策略**，却与"怎么扫页面"的**机制**绑死在同一层。

### 目标

按所有者方向：**筛选后的浏览器候选元素列表在应用层实现**；浏览器相关代码
（页面扫描、JS 探针、CDP 监听、会话创建）从引擎抽离到应用层。引擎只消费
"已筛选、已排序的候选列表"这一纯数据契约。

### 验收标准

1. 定义候选列表的生产者契约（输入：页面观测；输出：排序后的候选 + 每候选元数据），
   契约不含 Playwright 类型。
2. `extraction.ts` 的扫描/筛选/宽扫实现移至应用层（`src/app/` 或应用侧适配器）；
   引擎 `executor.ts` 不再 import 浏览器扫描实现，只依赖契约。
3. 现有行为逐字节等价：同页面同参数下候选列表、ref 编号、宽扫触发点不变
   （用既有 `inspect --json` / dry 快照对比验收）。
4. 决策模型/提示词面（criteria view）不改内容——只改生产者所在层。

### 涉及文件

`src/engine/extraction.ts`、`src/engine/executor.ts`、`src/app/*`（新契约与适配器）、
`src/cli/commands/inspect.ts`。

---

## 3. 候选列表重要性排序：候选窗口随未命中指数递增

**状态**：open ｜ **优先级建议**：P2（依赖 #2 的契约先行）

### 现状（问题）

候选窗口是**固定预算 + 一次性加宽**：

- 主池固定 `MAX_ELEMENTS = 40`（`src/engine/extraction.ts:352`）；
- 低置信恢复只有**一次**更宽窗口 `WIDE_POOL_ELEMENTS = 120`（`:357`；
  `executor.ts:580 WIDER_ELEMENTS`——"ONE wider look"），错过即 blocked；
- 已有可复用的排序素材：`elemFamily`/`filterElemsByFamily`/`orderElemsByFamily`
  （`extraction.ts:56,195,209`）、`lexicalOverlap`（`:792`）——但只用于族过滤与词面
  消歧，不决定"谁进窗口"。
- 无 `--wide` 时人工介入； tiered 短名单 k=8 在窗口**之内**再收窄，窗口本身不动。

### 目标

1. **重要性排序**：为候选建立可解释的重要性分（建议输入：交互性/可见性、AX 角色
   权重、主 frame 优先、与 goal 词面重叠、历史命中），窗口按排序取 top-K。
2. **指数递增窗口**：未命中时窗口按指数扩大（40 → 80 → 160 → …，上限可配，
   例如 `WIDE_POOL_ELEMENTS` 的 2–4 倍封顶），替代"固定预算 + 恰好一次宽扫"；
   每轮扩窗都走同一排序取前 K。
3. 可观测：audit/trace 记录每轮窗口大小、排序 top 依据、扩窗触发原因
   （第几次未命中）。

### 验收标准

1. 死目标页面（既有 dead-target 场景）上：miss → 扩窗链自动完成，最终窗不小于
   今天的宽扫预算且行为等价；命中即停，不再扩。
2. 排序可解释：同一页面两次扫描的排序结果确定（同输入同输出）；
   trace 能回答"为什么它在窗口里"。
3. 预算上限仍有硬顶（防失控），硬顶值单源声明并可被 inspect `--max-elements` 覆盖。
4. 既有 `--wide`/tiered 语义不回归（宽扫伪按钮通道随扩窗轮次按既有规则展开）。

### 涉及文件

`src/engine/extraction.ts`（排序与窗口策略）、`src/engine/executor.ts`（扩窗循环）、
`src/cli/commands/inspect.ts`（`--wide` 对齐）、`src/support/config-schema.ts`（如需可配）。

---

## 实施顺序建议

#3 依赖 #2 的候选契约；#1 独立可先行。建议顺序：**#1 → #2 → #3**；
每条独立成提交，行为等价性验收先行（#2 的逐字节对比是硬门）。
**进度（2026-11-07）**：#1 已完成（规划归 Agent 前提下重定义落地，见条目内落地记录）；**#2 / #3 仍开放**（验收标准不变）。相邻的实施队列第 7 项（T4/T3/T7 依赖评审，`369f895`）与第 8 项（U2a/U2b learn 观测面与值管道，`5d11e0b`/`c1e1f71`）均已落地，且**未新增运行时依赖**——下节依赖评审的结论对新能力面同样成立；learn 的可见性/值候选只扩观测与生成面（`schema-gen.ts` F38/F39），不改运行时 judge/池语义。

---

## 依赖评审（队列第 7 项：T4 JSONPath / T3 accname / T7 声明校验）

**状态**：done（实施队列第 7 项，2026-11-01 落地 `369f895`）——三项结论在落地后仍成立：仓库运行时依赖保持 3 个。

> 结论：**三项都不引入新依赖**（仓库运行时依赖保持 3 个）。评审目标不是"有没有库"，
> 而是"这个能力是否真的需要第三方实现"——三项的语义面都小于任何候选库，且引入会把
> 引擎的失败语义交给外部默认值（更有害）。以下是逐项证据、候选与将来采用条件。

### T4 JSONPath —— 不引入 `jsonpath` / `jsonpath-plus` / `jsonpath-rfc9535`

- **现状**：`src/browser/tool-signals.ts` 的 `json_path_equals` 复用
  `src/data/datasource.ts:528` 的 `resolve()`——**一份**路径解析器同时服务数据腿与工具信号；
  支持点路径、`[index]`、`[-index]`、`[]` 映射（数据腿既有能力），约 30 行。
- **候选库**：`jsonpath`（老牌，语法超集）、`jsonpath-plus`（RFC 9535 倾向，带 eval 面）、
  `jsonpath-rfc9535`（严格子集）。它们都会带来：新依赖 + 与数据腿解析器**两套语义**
  （同一路径在两个观察面结果可能不同）+ 库默认的静默语义（无匹配返回空数组而不是"缺值"）。
- **不采用理由**：本项只需 `$` / `$.` / `$[0]` 前缀归一（`normalizeJsonPath`，10 行），
  归一后仍走既有 `resolve()`；旧无 `$` 路径逐字节不变。引入库会破坏"同一份解析器"
  的构造性质，且 RFC 9535 完整语法（过滤/递归/通配）**没有消费者**——加了就是死代码。
- **将来采用条件**：出现真实需求要在工具信号里做过滤/递归/通配（`$..x[?(@.y>1)]`），
  且**数据腿与工具信号同时迁移**到同一个库（先写迁移对照测试证明旧路径逐字节不变）；
  或 RFC 9535 成为对外契约（第三方按标准写路径）时。

### T3 accname —— 不引入 `dom-accessibility-api`

- **现状**：控件身份与 label 的匹配走既有词面投影（`Elem.label` 提取期合成；
  `docs/APP_SCRIPT_AUTHORING.md` §4.5 的 name/id/data-test/label 两档匹配），
  没有计算 accessible name 的完整算法。
- **候选库**：`dom-accessibility-api`（W3C accname 计算，含 aria-labelledby、aria-describedby、
  隐藏节点、递归名字等）。
- **不采用理由**：本项是 **plan 面 needs_value 的文案**——要在 reason 里区分
  "键不在袋 / 值为空 / 控件-label 不匹配"并给已声明 slots 与候选摘要，
  不改变绑定解析语义、不改变匹配结果。引入 accname 会改变"控件身份是什么"这一**匹配输入**，
  属于行为变更（可能让既有应用命中变化），且库依赖 DOM 实现（浏览器外 dry 面不可用）。
  当前只需要把**已有观察**（候选 label/name）写进 reason。
- **将来采用条件**：需要让引擎按 W3C accname 决定"控件叫什么"（例如 aria-labelledby 跨节点
  合成的按钮/输入框），且评估过对既有 hint/绑定匹配的迁移影响；届时 accname 只作为
  `Elem.label` 的**生产者**接入，匹配层不动，并保留旧投影的 A/B 开关与逐字节回归对照。

### T7 声明校验 —— 不引入 `ajv` / `zod`

- **现状**：声明面校验全部是**手写小闭集**：`app-meta.ts`（未知字段）、`app-pack.ts`
  （step keys）、`app-adapters.ts`（各 adapter 块键/类型）、`tool-signals.ts`
  （算子/参数个数/载荷）、`ctx.ts`（运行期同款校验）。错误文案是产品面的一部分
  （点名 unknown + known、给出改法），并被 dry/`apps check` 与运行期共用。
- **候选库**：`ajv`（JSON Schema，运行时依赖 + 编译缓存）、`zod`（TS 优先，schema 即代码）。
- **不采用理由**：本项只需给 `ctx.run` 声明加**顶层未知键**拒绝、给工具信号叶子加
  **载荷类型/正则可编译**校验——闭集很小（十几个键、七种叶子），手写 20 行即可，
  且天然复用既有 `problems: string[]` 口径与中文文案。引入 schema 库会新增依赖、
  把"unknown + known"文案变成库默认错误，并需要为动态 adapter 键集维护 schema 生成。
- **将来采用条件**：声明面增长到**多来源共享同一份 schema**（例如对外发布 JSON Schema、
  编辑器补全、第三方应用包校验），或键集/条件校验复杂到手写开始重复（>100 行且出现
  三处同构校验）；届时优先选零运行时依赖的编译期方案，并把既有文案做成自定义错误映射。

**共同验收口径**：三项都不改绑定解析/完成信号语义；新校验只在声明面（dry/`apps check`
与运行期同文案）；新增诊断只写 `reason`/trace/报告，不改变成功路径产物形状。
