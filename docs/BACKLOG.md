# 工程优化待办（Backlog）

> 定位：记录**已确认要做**的引擎/应用层优化待办。每条含现状锚点（`路径:行号`，以 2026-10-31 快照
> `377f194..fa2cd63` 为准）、目标与验收标准；实施完成后在条目标注完成提交号，并同步 CHANGELOG。
> 来源：项目所有者 2026-10-31 提出三项方向性优化。

---

## 1. 统一决策函数入口：规划决策与流程执行同源

**状态**：open ｜ **优先级建议**：P1

### 现状（问题）

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
