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

**状态**：done（2026-11-17，2.2b 完成）：契约 `CandidateProducer`（engine，纯结构类型）+ app 生产者 `src/app/candidate-source.ts` + 扫描实现 `src/app/candidate-scan.ts`（367 行，`extractElements`+4 助手逐字节搬移、split hash 一致）；engine `extraction.ts` 1959→1612 且扫描 import 清零；验收：examples golden、verify:offline、verify:runtime:offline 4/4（buildMiddleware→app producer→app 扫描）、inspect/dry 口径不变 ｜ **优先级建议**：P2（已收口）

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

**状态**：open（前置已满足：#2 候选契约 2.2b 完成；本项是**行为变更特性**，按 P2「零行为变更」纪律冻结结束后启动）｜ **优先级建议**：P2

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

## 4. executor.ts 按功能划分拆分：第二波文件级外搬 + run() 提九阶段

**状态**：open ｜ **优先级建议**：**P1**（本评审裁定：拆分窗口内**冻结新机制进 `run()`**；先落
RunCtx + evidence collector，再 4c/4d）

> 本评审裁定（2026-11-16）：executor.ts 拆分升为 P1。窗口期内不再往 `run()` 加新机制；先落
> RunCtx（四组记账闭包收敛）+ evidence collector（行锚/帧/DRF 证据单点），再动 4c/4d。

**来源**：2026-11-13 executor.ts 内部逻辑解读 + 功能耦合度实测；细化为 IMPROVEMENT_PLAN.md §4 F2 第二波 / F3 的可执行版（该文行号锚点已声明漂移，本条以**符号名**定位）。
**总纪律**（沿用 IMPROVEMENT_PLAN §8 禁区）：同门面机械拆分——`BrowserMiddleware` 类名与 `run()` 签名逐字节不变；`src/index.ts` 的 `export *` 零改动（新文件由类内薄委托转发，facade re-export 先例：executor-types/executor-pure/eval-snippets）；**不另写执行器、不改任何语义**。

### 现状（2026-11-13 实测）

executor.ts 头部注释区、类型区、纯函数区、报告尾（`runReportTail`）已外搬（F2 第一波，`2c73d71` 等）。
剩余类体按功能簇实测 `this.` 耦合度（行数为当日快照，以符号定位为准）：

| 功能簇 | 符号 | 规模 | `this.` 耦合 | 处置 |
|---|---|---|---|---|
| 滚动/范围原语 | `_scrollIntoViewWithEvidence` / `scrollIntoView` / `_scrollContainerForElement` / `_scrollWithLoc` / `scrollContainer` / `scrollDocument` / `setRange` | ~306 行 | 只碰 **5 个成员**（`_locatorFor`/`_resolveOne`/三个滚动私有） | **外搬最优**（deps 最少） |
| 单动作事务 | `actOnce` / `_resolveOne` / `_domFallbackResolve` / `resolveCommandRef` | ~452 行 | 19 个成员（`snapshot`/`occludedReason`/`_hintOpts`/歧义诊断…) | 外搬（中） |
| 动作执行族 | `_executeElement` / `_clickOnly` / `_optionCandidates` | ~245 行 | 7 个成员（`fillReadback`/敏感值账/`_slotValue`…) | 外搬（中低） |
| 风险/感知/值绑定 | `isRisky` / `isDone` / `snapshot` / `occludedReason` / `dryRunProbe` / `_slotValue` 等 | ~510 行 | 持有 `decision`/`agent`/`ready()`/`_lastProbeError` 等**调用内私有状态** | **留类内**（执行语义本体，外搬=搬空） |
| 主循环 | `run()` | ~2400 行 | 138 处 `this.` | **不拆文件**，只提九阶段私有函数（④） |

### 目标（四个子项，每项独立提交、可单独 revert）

- **4a** `src/engine/scroll.ts`：滚动/范围原语外搬为模块级函数；deps = `{_locatorFor, _resolveOne}` 显式注入；类内保留同签名薄委托方法。
- **4b** `src/engine/action-exec.ts`：`_executeElement` 族外搬；deps = `{fillReadback, secretSlotKeys, _secretValuesSeen(跨步累计语义注明), _slotValue, _isSubmit, _locatorFor, _clickOnly}`。
- **4c** `src/engine/act-once.ts`：单动作事务簇外搬；deps 接口显式声明（含 `_lastProbeError`/`_takeActionabilityDetail` 的「同一次调用内消费」纪律）。
- **4d** `run()` 提九阶段私有方法（IMPROVEMENT_PLAN F3 原案）：`runSetup` / `runFrameGate` / 循环内 `runPoolGate` / `runDeclaredTargets`（命令空间 walk + FW8 身份回捞 + DRF） / `runModelPick`（ask/floor/宽扫/升级/裁决） / `runActionPhase`（dry 探针/风险确认/执行/stale/clickAt/upload） / `runPostAction`（动作后账/done 轮询/manual/inert/anti-repeat） / `runReportTail`（✅ 已抽出）；四组记账闭包（`stop`/`forbid`+`forbidWhy`/`noteSkipped`/`unforbid`+`pruneForbids`）升为一个 run 上下文对象，**零语义差**。

### 验收标准

1. 每子项一个独立提交，`npm run check` 必过；任一子项可单独 revert。
2. 4a/4b/4c：`amber inspect --url <URL> --json` 拆分前后**逐字节一致**；session 内 scroll/setRange/fill/upload 各冒烟一次（实测证据路径，与最近两次有头窗口验证同法）。
3. 4d：`npm run test -- --tier smoke` 冒烟 + **1 个 core case 的 trace JSON 除时间戳外一致**；`run()` 与类名逐字节不变；九阶段合计行数与拆分前持平（纯搬移，不借机改写）。
4. 拆分后 executor.ts 类体只剩「执行循环 + 感知/风险服务」，预期 ≤ ~4300 行（4a-c 后）；巨型函数（run）降至 9 个 200-400 行阶段。
5. 禁区复核：完成只认信号（`checkSignal` 裁决点不被搬动）；`confirmSafe` 默认拒绝方向不动；`forbid`/`stop` 唯一出口纪律不破；`checkSignal`/`DESTRUCTIVE_PATTERNS` 等共享语言不复制第二份。

### 已知风险（搬家最易破的三处，实施时逐条对照）

1. **位置性 ref**：`forbid`/`pruneForbids` 依赖「重新抽池后按元素签名重剪」——跨文件传 forbidden 状态时不得改变重剪次序。
2. **私有状态语义**：`_lastActionabilityDetail`/`_lastProbeError`（单次调用内消费）与 `_secretValuesSeen`（跨步累计、不随 run 重置）外搬时必须写进 deps 类型注释，防止语义漂移。
3. **鸭子类型缝**：新文件签名只用 `PageLike`/`AnyLoc`/`Elem`（结构类型），不引入具体 Playwright 类型——避免 `as unknown as` 强转（全仓 87 处）扩散到新文件。

### 涉及文件

`src/engine/executor.ts`、新增 `src/engine/scroll.ts` / `action-exec.ts` / `act-once.ts`、`src/index.ts`（零改动，验收项）。

### 与 #2/#3 的顺序关系

4a-4c 与 #2/#3 无文件交集，可随时并行；**4d（runModelPick/runDeclaredTargets 阶段）与 #2 的候选契约改的是 `run()` 的同一段**——两个重构不要同时动它：要么 4d 先行（契约冻结前），要么排在 #2 落地之后。

---

## in-row:<token> 行锚后续立项（2026-11-16 批 1 落地后）

**状态**：open（批 1 已收口：解析/匹配/数据面/回捞/回退/建议/observe 闭环/三案诊断；见
`docs/ROW_ANCHOR_HINT_PLAN.md` §5 批 1 + CHANGELOG F82 批）｜ 来源：行锚 hint 方案（评审
通过 v1.0）批 1 实施复审记录

| # | 项 | 说明 | 关联 |
|---|---|---|---|
| 1 | `findByHint` 支持 `in-row:` | **已实施（批 2 遗留收编 `13cd7ca`）**：`plan check --probe` 的旧匹配器已适配行锚——in-row = `rules.rowMatch` 同口径（row_texts 任一行 includes、仅小写折叠）、row-index = `row_index` 整数全等；四类尾缀组合 = 独立 AND；两消费面池都经 `addNearContext` 采集。原"未适配"表述作废（与第 9 行"已实施"统一） | 方案批 2（已收口） |
| 2 | apps check hint-lint in-row 语义提醒 | hint-lint（declaration-scan 消费面）经 parseHint 自动继承形状位；"in-row 写在非重复组元素上 = 恒落空"可做静态提醒（需要声明面重复组事实，先例：nearToken 提醒） | 方案批 2 |
| 3 | 歧义证据反向提示"改用 in-row" | on_ambiguous 兜底命中的场景里，候选带同文案重复组事实时建议"改用 `<label> in-row:<token>`"——逐步挤出运气兜底；触发条件设计见方案 §8.7 | 方案批 2 |
| 4 | 桥 ElementView 透传 row_texts / row_index | 引擎 observe/inspect 面已产 `row_texts`（≤6 行 × ≤40，dup 门控）与 `row_index`（1-based 组序）——照抄入口走 hint_candidates 的 in-row/row-index 候选 | **批 3 已收口**：`element-view.ts` 白名单两键（`row_texts` ≤6×≤40 strArray、`row_index` num 透传；仅重复组元素携带，非重复组不出键——桥不补字段）；AGENT_INTERFACE ElementView 表同步 |
| 5 | 词边界档位 / 多 token 组合（`in-row:a>b`） | row_texts 是已切分原子行、碰撞面小一个量级——有实测碰撞证据再议；`>` 词法已保留 | 批 3 首项（induceHint 行锚/桥透传/deny-list）已落地，本项仍开放（§2 非目标维持） |
| 6 | NFKC 归一（全角 fail-closed 放行） | 两面新增归一层 = 纯漂移面（两轮架构评审仲裁否决）；等实站全角案例再议 | 方案 §8.8 |
| 7 | OBSERVE_JS 大重复网格时延实测 | 100+ 同文按钮的 observe 爬升成本需 ctrip 实测一次；超标则 observe 侧爬升帽降 4 层（与 run 面 8 层不同帽需写入契约）或拆批 1b（同条目两步、不可跨迭代） | 方案 §8.10 / R9 |
| 8 | deny-list 可配化 | SKU 恰似数字被护栏误杀的调优出口——词元启发式的放行表配置化 | **批 3 已收口**：`meta.policy.hint_token_allow`（≤16 项、每项非空无空白 ≤40 字符、小写折叠；非法 = config_error）——表内词元跳过价格/时段 deny 模式直接参与第 5 档生成（结构约束不退让）；缺省不写 = 逐字节不变；面覆盖 = run 面歧义 + ctx.observe，inspect/session/桥面缺省（F58 同款边界）；配置面选 meta.policy 的理由留档（站点内容特征 → per-app，全局键跨站点污染） |
| 9 | 批 2/批 3 主链 | **row-index 顺序行锚（批 2 首项）——已实施**（`docs/ROW_INDEX_HINT_PLAN.md` v1.0 契约 c2ee024；a38e674）；**批 2 遗留收编——已实施**（13cd7ca + E 项流转修复：findByHint 行锚适配 / apps check hint-lint 行锚提醒 / 歧义证据 row_index 事实 / probe expect "failed" 类型联合收编 / 规划面诊断三案 additive 接线 + id 缺失命令不再静默丢弃）；**批 3 首项——induceHint 记忆产物带行锚（双参形态，复用 suggestHints 第 5/6 档）+ 桥 ElementView 透传 row_texts/row_index（#4 同批收口）+ deny-list 可配化（meta.policy.hint_token_allow，#8 同批收口）**；criteriaView [near] 演进（另议） | 方案 §5 |

**示例（批 1 已收口的闭环）**：`订票 in-row:sc7960` 在 15 个同名订票按钮的列表页唯一命中
SC7960 那一卡的按钮——token 来自 `inspect`/`ctx.observe` 的 `hint_candidates`（同一 hintMatch
自证「恰好唯一命中」），row_texts 由 dup 门控采集（≤6 行 × ≤40 字符、连续数字 ≥5 位行救援
纯数字订单号）；token 无匹配时 reason 列真实行词元 ≤8，撞多行走 `target_ambiguous` 零动作。

---

## 2026-11-16 架构评审后续立项（F85 收口后）

| # | 项 | 说明 | 状态 |
|---|---|---|---|
| 1 | 桥 typecheck 纳入门禁 | 桥（`integrations/dsh-bridge`）尚无独立 tsc 门禁——先修既有 tsc 错误，再把桥 typecheck 接入 `npm run check`/CI，防止桥侧类型漂移逃过 PR 门禁 | open（需先修 bridge 既有 tsc 错误） |
| 2 | row-index 编号基统一到页级全量收集 | 当前编号基 = 各面收集到的成员（池面 `POOL_SEL`+heuristic vs 回捞/observe 面 `ADMIT_SEL` 两个元素宇宙）；跨面 N 可移植的前提 = 同名组成员在两集合都在场。统一到**页级全量收集（合并 POOL_SEL/ADMIT_SEL 口径）**后 N 才无条件可移植；池帽仍只截尾、编号是页面前缀。文档口径：照抄 inspect 候选前用 `ctx.observe`/run 复核 | open（有实测不可移植案例再排期） |
| 3 | F72 `rehydrate_rescan` 的 miss+strict 路径 RunReport 缺重扫事实 | 评审 P2：act hint miss 且 `act_hint:"strict"` 时，RunReport/汇总未带 `rehydrate_rescan` 重扫事实（trace 行有、报告尾缺），归因链断一截 | open（待收口） |

**已收口（本轮 F85 一并关闭）**：`resolved_by` / F75 决策步 DOM 回退的歧义证据（同一
`hintCandidates` 谓词 + `skipped_actions` 已统一）；行锚消费面 fail-closed（F85）见 CHANGELOG
与 `docs/ROW_ANCHOR_HINT_PLAN.md` §10。

---

## 实施顺序建议

#3 依赖 #2 的候选契约；#1 独立可先行。建议顺序：**#1 → #2 → #3**；
每条独立成提交，行为等价性验收先行（#2 的逐字节对比是硬门）。
#4 的 4a-4c（文件级外搬）与 #2/#3 无依赖、可随时穿插；**4d（run() 提函数）与 #2 改 run() 同段，须前后错开**（见 #4 末节）。
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

## P0/P1 落地后遗留（2026-11-09，来自 10 轮评估 + 架构评审 + 实施 A–F）

- P2：`ctx.hints` 改名/文档化（现为多 hint 构造器，文档已注明）；observe 附带"全准入面 verify 列表"（更强 hint 自证）；`ignore_frame_origins` 配置化（广告 frame 默认排除已做，显式配置仍可加）；候选池自动滚动采集（pool_scroll 实验，带成本上限）；`scroll` 命令接像素 `by`。
- P2：steps_failed 是否计入 recovered；false_done guard 的短页正文阈值（400 字符）与登录词表可配化；`deniedFrameUrl` 死代码移除；report.html 摘要补失败步行。
- P2：A5 文档已澄清（switchTab 双面跟随，R10 判误诊）；若再现"动作面在原页"症状，按 trace 归因（done 锚点）排查。

## 挂起分支 `feat/dry-branch-lint` 归档决定（2026-11-10）

- **结论**：该分支无主线未吸收的工作；已打归档 tag（`archive/feat-dry-branch-lint` → `8168834`）后删除分支。
- **证据**：`git rev-list --left-right --count main...feat/dry-branch-lint` = `14 1`；唯一独有提交 `8168834` 只新增 `src/app/declaration-scan.ts`（796 行、纯函数零接线）；主线上该文件内容 sha256 与分支一致（`27ecca5a…`），且主线已接线 4 处（`hint-lint.ts` / `apps-rehearsal.ts` / `apps.ts` / `rules.ts`）。
- **未采纳范围（显式记录，非遗漏）**：收集器的消费面在 task-10 阶段收窄到 **hint 形状位**（`hint-lint.ts`：nearToken/裸词/attrSubstr-on-label 三类静态提醒）；挂起工作流的**族声明校验 / `declarationLint` 契约字段 / dynamic 计数外显**未接出——这是新的范围决策，等真实需求。
- **恢复条件**：需要 `apps check` 对"分支内声明形状"做 problem 级校验（而不仅是 hint 语义 warning）时，从 tag `archive/feat-dry-branch-lint` 起（对应设计/验收标准见任务沉淀记录）。

---

## frame:<origin> 后续立项（2026-11-15 实施复审）

**状态**：open（E1–E6 批已收口 #1/#2/#4/#5/#7/#8/#9；剩余 #3 跨帧同签名不合并、#6 >6 帧/每帧池配额）｜ 来源：`frame:<origin>` 帧限定 hint 落地（`bc400ca..8358c92`，规格 `docs/FRAME_SCOPE_HINT_PLAN.md` §13）+ 实现复审（CONDITIONAL APPROVE）

| # | 项 | 说明 | 关联 |
|---|---|---|---|
| 1 | **within 权威对等** | FW8/F64 不看 within、DRF-text 忽略 within、四处合成池无 `anchor_ids` → 回捞面 `#x within:#p` 可能操作锚外 #x | **E1 已收口（同帧）**：五池 anchors（`ANCHOR_JS` 单一出处）+ FW8/F64/DRF-text/A3 消费 within；跨帧 within 维持文档边界（`anchor_ids` 是帧内文档祖先链，E 批规格 §3/§12） |
| 2 | `findByHint` 支持 `within:` | 组合后缀的帧链过滤已修（B-1）；但 within 作用域在该面不校验 | **E3 已收口**：`findByHint` 帧链过滤后按 `anchor_ids` 过滤（`rules.anchorChainMatch`，单层 membership/链嵌套序同一语义）；必修点同批修复——任一后缀存在即用剥离后 base（旧实现「无 frame 有 within」保留整串 → attr 正则/induceHint 精确串匹配全落空），无后缀 = 原串逐字节；`frame:`+`within:` 组合成全语义（见 CHANGELOG E3） |
| 3 | 跨帧同签名不合并 | `firstIfSame` 仍按 tag/label/href/data_test 合并（run 命令步直接执行一个）；需独立立项 + 开关 | D2 边界 |
| 4 | `read/extract/collect/judge` 帧限定对称化 | `locatorAnyFrame` 逐帧 OR，无法指定帧——act 可按帧而读不能 | **E4 已收口**：读/判面 CSS 选择器支持 ` frame:<origin链>` 尾缀（`splitFrameSuffixFromSelector` 唯一剥离 + `locatorAnyFrame`/`countAnyFrame` 帧过滤；值不合法=整串按原 CSS 处理；ctx.read/extract 不抛 frame_not_allowed——null/0/[] + trace `frame_evidence`；done/when 走 F45② 升级且 probe suffix-aware；无尾缀路径逐字节不变；见 CHANGELOG E4 批 + WITHIN_PARITY_PLAN §6） |
| 5 | hintMemory / `induceHint` 帧限定 | 记忆产物不带 `frame:`——跨帧同名回放歧义→回退模型（无误动作） | **E5 已收口**：`induceHint` 对子帧元素（`frame_path` 非空）产 ` frame:<own origin>` 尾缀，主帧产物逐字节不变；未知 origin 帧不加（不产死 hint）；回放 `currentHint → hintMatch → parseHint` 零新增代码；`amber start` 的主帧 `page.click` 面对子帧产物走既有结构化拒绝。**边界（D2）**：同 origin 父子/兄弟帧仍可能歧义（只带 own origin 单段）；见 CHANGELOG E5 批 + WITHIN_PARITY_PLAN §7 |
| 6 | >6 帧 / 每帧池配额 | `framesOf ≤6`、窗口 40/120 跨帧共享主帧优先 | 需先测量 |
| 7 | `matchedChains` 截断标记 | 证据链 >4 条去重截断时无 truncated 标记 | **E6 已收口（方案编号 #12）**：`probeExcludedHint` 去重与截断解耦——`matched_chains_total` = 全量 distinct 链数、列表仍 ≤4、超出时 `matched_chains_truncated:true`；`frameTargetStopReason` 截断时在 `hit chain(s):` 段末带总数/未列出数，≤4 条时文案逐字节不变 |
| 8 | 整串 `frame:` 诊断 | `frame:<origin>` 无 hint 主体时不点名"缺少主体"（显式失败仍在） | **E6 已收口（方案编号 #13）**：`describeFrameSuffixRejection` 对首词即 `frame:` 的整串形状补「缺少 hint 主体（必须写成 `<hint> frame:<origin>`）」诊断；带未闭合 `[` 守卫（`[data-x=frame:o]` 值内伪后缀不误报）；带主体时新旧逐字节相同 |
| 9 | 文档：大写 origin / 属性词示例 | hint 先 lowercase——`FRAME:HTTPS://A.COM` 会被识别为合法尾缀（符合 `i` 旗标）；`findByHint` 的 `[DATA-TEST=x]` 属性名/值正则大小写敏感（新旧一致、既有边界）——文档各补一句示例 | **E6 已收口**：`docs/APP_SCRIPT_AUTHORING.md` 的 hint 尾缀段补「大小写与整串形状」（大写 origin 合法 + `[DATA-TEST=x]` 不命中而 `[data-test=x]` 命中 + 整串 frame: 缺主体诊断） |

**示例（#9，E6 收口）**：`Close FRAME:HTTPS://A.COM` 与 `Close frame:https://a.com` 等价——hint 先整串
lowercase（`i` 旗标），`parseHint` 的 `frameChain` 归一为小写规范 origin；但 `findByHint`
（`plan check --probe`）的属性词正则大小写敏感——`[DATA-TEST=x]` 不命中、`[data-test=x]` 才命中
（act hint 侧不受影响，`parseHint` 先折叠；新旧一致、既有边界）。整串 `frame:https://a.com`
（无 hint 主体）按旧形状落空，失败 reason 点名「缺少 hint 主体」——写成 `Close frame:https://a.com`。

**E 批复审遗留微项（2026-11-15 架构师 APPROVE 后记录，均为低优先级）**：
① hint.ts:323 运行时文案「段首 # 可选」与 F69 新口径（首段必须 #）不一致——待 E56-G10 基线重置时一并改；
② HINT_HEAD 小写 id Map 可加 `document.getElementById` 快路径（miss 才建映射，within 低频面非紧迫）；
③ N7 组合信号树（all_of 内叶子）经新接入点的直测断言（现由 G8a+G3e 传递覆盖）。

---

## P2 出口演练发现（2026-11-17）

**状态**：done（P2-1/P2-2 已收口；桥字段穿透由 P2 条件项 W4-4 于 §6.10 收口：5→2，共享契约 + 生成物）｜**来源**：`docs/IMPROVEMENT_PLAN.md` §6.5 C 的 5 项扩展演练（临时 worktree 真实补丁 → 计数 → 回滚，未入库）。两项缺口均落在已登记 P2 条件项（W4-4 / W5-3）边界内；W5-3 亦已由 §6.10 收口。

| # | 项 | 现状锚点（演练实测改动面） | 目标 / 验收 |
|---|---|---|---|
| P2-1 ✅ `85ebdfa` | provider 注册清单单点 | 新 provider 实测 **3 处**：adapter + `src/model/decision-provider.ts:resolveProviderSpec` 的动态注册 + `src/cli/commands/doctor.ts` 的注册清单（两处各自 import 同一批模块） | **已收口**：`registerAllProviders()` 幂等单点，三面（解析/doctor/start --doctor）共用；doctor `--json` 与未知 provider 列表改前=改后逐字节一致；新增 provider = adapter + 清单 1 行 |
| P2-2 ✅ `accd0e3` | 配置键作用点并入 schema | 新配置键实测 **3 手写处**：`src/support/config-schema.ts` + 消费点 + `tools/config-example.ts` 的 `WHERE_USED` 作用点表（缺 `WHERE_USED` 时生成器 exit 2，用户需读报错才知道要补）；生成物 3 份由 `npm run config:example` 刷新 | **已收口**：`ConfigKeySpec.usedAt` 必填（缺失 exit 2 点名键）+ 消费点 = 2 处；手写 `WHERE_USED` 删除，3 份生成物逐字节不变 |


## 14. 会话 close 后子进程/浏览器句柄不退出（事件循环不收口）

**状态**：✅ `8a33616`（2026-11-19 盲测/探针过程发现）｜ **优先级建议**：P2

> **现状锚点**：`src/app/session-runtime.ts`（close 语义）+ `integrations/dsh-bridge/src/session.ts`（terminate/reap，`taskkill /T /F` 兜底）。一次性 throwaway 探针进程在 dispatch `close` 后事件循环不退出、浏览器子进程句柄存活，需 `process.exit` 收尾；真实桥面是否同样受影响未系统核查。
>
> **目标**：核查桥面 `close`/reaper 路径是否总能收口浏览器子进程与事件循环（含 headful、persistent context、未关 tab 等形态）；若存在泄漏形态，修到 close 后进程可自然退出，验收 = 连续 open/close 循环后进程数回到基线。
>
> **来源**：候选池批 2 探针过程发现（dev-pool，2026-11-19）。
>
> **收口（`8a33616`）**：泄漏形态清单核查结论——① CLI 行循环形态（close 请求/EOF 两路）本就经入口 finally 走 `finish`，真浏览器探针实证 exit 0、chromium 进程数回基线（delta=0），无泄漏；② bridge 常驻宿主的 `taskkill /T /F` 兜底保证子进程树必死（强制收口、非自然退出——边界如实记录，不改它）；③ 真正的泄漏形态 = **无入口循环的直调 dispatch 驱动**（一次性 embedder），探针实证事件循环不退出。修法 = `doClose` 在摘要算好后于本调用内 `await finish("closed")`（close 语义自包含；`finish` 幂等，两条真实路径行为不变）。进程级验收 = `npm run verify:session:close`（`d74bd47`，非门禁 lane）：C1×N 连续 open/close 循环 + C2(eof) + C3(embedder) 全部 exit 0 且 chromium 零残留。

## 15. DSH 桥层无回归测试基建（JSONL 缝存在但无已提交测试）

**状态**：✅ `d74bd47`（2026-11-19 候选池批 2 review 过程发现）｜ **优先级建议**：P2

> **现状锚点**：`integrations/dsh-bridge/src/session.ts`（SessionManager 的 `spawnArgv` 测试缝——可注入 fake-engine JSONL 真跑桥面代码）+ `integrations/dsh-bridge/DEVELOPING.md`。桥目录无任何已提交测试：F6 `wide_scan` 桥面透传（commit c0c669d）的验收靠一次性探针脚本（.session_tmps，不入库），透传回归（白名单投影丢字段类）在现有门禁下不可检测——`npm run check` 不含桥层，桥自有 tsconfig 亦无测试。
>
> **目标**：建桥层最小回归 harness（fake-engine JSONL 缝 + 若干透传断言：act 失败响应的 additive 键组 wide_scan/ambiguity/overlay/dedup_dropped 各一条），接入桥侧构建门禁；验收 = 断言存在且 `tsc -b` + 断言全绿。
>
> **来源**：候选池批 2 review（lead 复核发现 wide_scan 桥面不可达，2026-11-19）。
>
> **收口（`d74bd47`）**：harness = `integrations/dsh-bridge/test/`（`node --test` + fake-engine JSONL 缝经 `spawnArgv` 注入，纯进程内、零浏览器、离线）；断言五组——wide_scan（hint 行优先/≤40 行/clip/pool_size 如实/缺键形状不变）、ambiguity 失败面 + 成功面、snapshot `window` 审计块（windowAudit/dedup_dropped 透传 + 缺键形状不变）、open/goto 往返 + engineFailure 投影。门禁接入选**主仓 check 新步**（`bridge:test`，14→15 步）——依据：断言是确定性进程内事实（fake-engine、零浏览器、<30s），白名单投影丢字段正是 PR 门禁该拦的回归类；桥目录无 package.json，为测试单建会割裂门禁面。断言面配套：引擎 doSnapshot additive 带 `window`（windowAudit 有界证据）+ 桥 `windowAuditEvidence` 有界透传（overlay 断言面不在桥 session op 闭集内，如实缺位——windowAudit/dedup_dropped 经 snapshot 面覆盖）。

## 16. pilot 自主驾驶的规则误配与访问循环守卫（消融实测发现）

**状态**：**P0 + P1 已落地（2026-11-21，守卫账本 + L2 注记走既有 notes 通道）；P2（DecisionContext/能力档/桥面生成链）待做**｜ **优先级建议**：P2

> **现状锚点**：`src/app/pilot-runtime.ts` driveOnce 规则档 + anti-repeat（inertRun）。消融实测（books.toscrape，见 PILOTED_WALKTHROUGH_PLAN §7）：goal 词 "book" 被 affordanceRule 命中侧栏类目 "Books"，与模型互乒乓——URL 每步都变 ⇒ `ok+changed` 动作永不进禁选、inert 判定捕获不到，6 步预算无声烧尽；budget_exceeded 交接的 why_stuck 只见终点、不见循环成因。
>
> **第二变体（2026-11-20 真站用例复测，Google Maps）**：DOM 状态 **toggle、URL 不变**——goal 词 "Hours" 被 affordanceRule 命中筛选按钮，同元素连续 7 次点击、面板开↔关每步 `changed=true` ⇒ inertRun 每轮清零（`inert = !ok || changed!==true`）、元素永不进禁选（准入条件同为 `!ok || changed!==true`）；且 `driveOnce` 每轮重抽池**不做 `carryForbidden` 平移**（唯一的 esig 翻译在模型宽扫路径），ref 重编号（实测 e15→e18）让 ref 键禁选天然失效——run 面禁选按 esig 键、驾驶面按裸 ref，两面漂移。规则档本身零「已试过」记忆：`affordanceRule` 无 exclude 参数，每轮按 goal 词面重新匹配。
>
> **目标**：①**已试/禁选记账入决策上下文 L2（运行史）**：驾驶账本按 esig 记 `{desc, tries, last_outcome}`，作为 L2 运行史段（与 run 面 `RunAccounting` 同族、带溯源标签）进模型票请求——上文改变输入不改变裁决权（DC1.5）；规则档 exclude 与防循环守卫从**同一账本**派生（同 esig 连续 ≥2 次 = inert 并禁选，URL 乒乓与 DOM toggle 两类通杀），不再是 pilot 本地补丁；②禁选集按 esig 平移（`driveOnce` 每轮抽池后 `carryForbidden`，修 ref 漂移失效）；③评估自主驾驶（无声明 hint）时规则档对 chrome/侧栏词面的免疫或降档。验收 = 消融同任务 + Maps Hours toggle 两形态复测均不再无声烧预算，停因可读。
>
> **来源**：2026-11-20 pilot 消融双臂实测（PILOTED_WALKTHROUGH_PLAN §7）：纯 model 4 配置 0/4 到达，其中 2 个配置由该循环形态烧尽预算。第二变体来源：2026-11-20 Google→Maps 用例重测（pilot 轨迹 `/tmp/dsh-amberflow-pilot-HljChy`：8 次 `picked_by=rule` 点击 Hours，`inert_run:0`、`forbidden:["e15"]`，e18 七次从未进禁选）。

> **产品研判（2026-11-21，子代理只读研判，已复核）**：
> - 定性 **7:3**：主因是驾驶面确定性守卫缺口，不是决策上下文饥饿。决定性事实：Hours 循环 7 次点击**全部 `picked_by=rule`、模型零票**——只改模型上文的方案对本例零效果；批复「记账入决策上下文」方向对，但须落成「**一张 esig 键账本、两个出口**」。
> - run 面已用三件套兜住同形态、pilot 未复用：`run-context.ts` 的 RunAccounting（esig+forbidWhy/skippedActions）、`model/outcome-memory.ts`（sig 键 forbid|rank 双档）、`executor-phases-b.ts` 的 `maxEffectiveRepeats → no_progress`（同 esig 第 3 次执行而 done 未成立即停）。pilot 自建弱版（`inert = !ok || changed!==true`、裸 ref 禁选、规则档无 exclude）是缺陷来源。
> - 推荐**混合(c)**：账本单源 → 出口①确定性守卫（规则档 exclude + 同 esig 连续无进展 → `no_progress` 停，不依赖 provider 能力申报）；出口②L2 上文注记（rank 档，只解决"停得明白/下一步往哪走"）。
> - L2 **不必先开新请求面**：`ChoiceRequest.notes`（ref→注记）已被 `criteriaView` 消费、`layaProvider.pick` 已传 notes ⇒ `minimal` 档天然满足；`ProviderCapabilities.context` 目前尚不存在（DC4 仍是提案）。
> - 分期：**P0 守卫**（不依赖 §17、不改契约，消 90% 无声烧预算）→ **P1 L2 走既有 notes 通道**（溯源+字符上限+rank）→ **P2** 才补 DecisionContext/能力档/桥面生成链/MAINLINE seam。§17 非 P0 前置；但 §17 拍板须与 P1 同批对齐「redirect 清步史／账本是否清段／预算不清零」三处口径（研判建议：redirect 带预算重开档 + 账本随步史清段）。
> - 验收锚：fixtures 复现 DOM toggle 与 URL 乒乓两形态 → ≤3 步停、`stop_code=no_progress`、evidence 带 esig+tries+last_outcome；8 步预算不再落 `budget_exceeded`；stub/laya 双臂同 esig 重复执行=0 且 `model_asks` 不增；单次 ask criteria 字符增幅 ≤10%、`evidence_truncated` 不新增、墙钟劣化 ≤10%；run 面逐字节不变。

## 17. pilot budget_exceeded 后兜底死局：redirect 的预算语义待拍板

**状态**：**已实现（预算终态退出口径，非①/②）**｜ **优先级建议**：P2（已收口）

> **实现**：`budget_exceeded` = **终态**——`pilot-entry` 驾驶循环在预算用尽后直接收尾（不再读兜底指令），`pilot-runtime.handleLine` 对所有续驾驶指令回 `code:"budget_exhausted"` 结构化拒绝；`unblockHintsFor` 文案改为「起新 pilot 并增大 --max-steps（本 run 不再接受 resume/redirect）」。验收：CLI 实测 `exit 3` + 单条 `pilot_end`、stdin 里的 resume 行未被消费；`verify:pilot` 预算场景断言 resume 被拒 + drive 仍终态。

> **现状锚点**：`src/app/pilot-runtime.ts` drive 的预算门先于 resume/redirect 生效。混合臂实测：budget_exceeded 交接后 Agent 发 `resume`（hint 到位）被消费且回执 ok，但预算已花光，下一轮 drive 立即再次 budget_exceeded——兜底指令被「成功消费」却无效，纯烧一条指令；unblock 提示如实指向「新起 pilot / 增大 --max-steps」。
>
> **目标**：产品拍板二选一——①redirect 显式带预算重开档（语义：换目标=新驾驶，与「步史清段重新累计」一致）；②保持死局但 resume/redirect 在 budget_exceeded 交接上直接回 config_error（不再「成功消费」无效指令）。验收 = 消融剧本复测无无效消费。
>
> **来源**：2026-11-20 pilot 消融混合臂实测（PILOTED_WALKTHROUGH_PLAN §7）。

## 18. 提取面的「可动作单元」归一：从池源头消除伪歧义

**状态**：**S2 已落地（2026-11-21，提取面同卡兄弟折叠）；S3（unit: 行提示）/ S4（末端折叠退役）待做**｜ **优先级建议**：P2

> **现状锚点**：extraction 把卡片容器、覆盖链接（按 aria-label）、可见标题 div 各自独立收编为同 label 候选（Maps 结果卡实测：`a.hfpxzc` 与 `div.qBF1Pd` 同 label、共享 `role=article` 卡片、互不包含）。同单元折叠目前发生在**解析末端**（`executor-actionability.foldNestedDuplicates`：DOM 包含 → 最低公共祖先 + 组内唯一 native），每步动作都要页面探测（盖章 → LCA → 清章）。
>
> **目标**：把「同一 hit-receiver 等价类」前移到**抽取/准入面**——同卡片/同行的候选在收编时归一为一个单元代表（native 优先、或实际接收点击者），池内不再并存同 label 的同单元候选：伪歧义从源头消失、动作时零探测成本；真歧义（跨行/跨卡、一卡双 native 控件）语义不变。判据单源 = `FN_HIT_RELATION` 的命中关系 + 既有 `row_texts` / `row_index` 行锚机制，不建第二套。实施注意：会改变三面候选构成——runtime lane golden、§3.2 验收矩阵、消融复测都要过，需独立批次。
>
> **来源**：2026-11-20 Maps 用例重测（同卡兄弟伪歧义，`/tmp/dsh-amberflow-pilot-*` 与会话证据）+ 批复意见「兜底之上找根本性优化策略」。

> **架构研判（2026-11-21，子代理只读研判，已复核）**：
> - **落点 = 提取面页内 JS pass，扩既有公理 0**（`src/engine/pool-js-dedup.ts` 的 `__dedupPoolRows`）：单元归一与"一区域一候选去重"是**同一职责**，既有包含折叠只是缺了"互不包含的同卡兄弟"形态；不放 pool-view（只读投影）/candidates 窗口（配额子切片）/解析末端（现状：每动作 n+2 往返、`_resolveOne` 与 pilot ①′ 两处各写）。
> - **判据 = 三层合取**（页内一次算完，零新增往返）：同 label ∧ 同一 hit-receiver 等价类（`FN_HIT_RELATION` 归一）∧ LCA 是交互单元且非 body/html/main/列表泛容器 + 组内唯一 native。**代表元序**：self 可命中且 native → 实际接收点击者 → id-backed（护 `#id` 声明）→ 最深可动作后代 → 仍多解不折叠；折叠仅当 `actionCapabilities(rep) ⊇ 组内并集`。
> - **行锚边界**：行组键 `(frame, tag+label)` ⇒ **`row_index` 不同绝不折叠、跨帧绝不折叠**；`rules.ts` 的 `limit` 一字不改；非代表元的 `in-row:`/`row-index:` 声明会落空 → 只在 `target_not_found` 追加「已折叠进 `<rep>`」证据，绝不自动改写声明 hint。关系判据体抽成共享 JS 常量（新 `pool-js-hit.ts`），`eval-snippets.HIT_RELATION_JS`/池内片段/末端折叠三处同源内插，不建第二套语义。
> - **回归面**：`verify:offline` 现有 10 份 golden **必须逐字节不变**（真歧义/不同 label 夹具即防线）+ 新增行卡夹具 golden（池内 1 行 + `dedup_dropped.why:"unit-sibling"`）；`verify:runtime:offline` 7 场景（`stop-missing-target` 的 `pool_size` 若变需两次一致重录）；`verify:pilot` 的 `scenarioAmbiguous` 仍须 `target_ambiguous`、两个折叠场景的 `resolved_via:"nested-fold"` 证据会消失（断言改为"无折叠也到达"）；`online/` 四 tier；消融双臂；maintain size/split（搬 JS 片段须重钉 hash）。
> - **尺寸落点（实测）**：`pool-js.ts` 907/907、`extraction.ts` 1113/1113、`executor-pure.ts` 938/938 都压基线（加一行即红）；有空间：`pool-js-dedup.ts`(139)、`candidate-scan.ts`(496)、`eval-snippets.ts`(211)。落点 = JS 片段扩 `pool-js-dedup.ts` + 新 host 模块 `src/app/pool-unit.ts`（只做 flag 与证据整形）；`unit_role` 须同步进 `executor-pure.modelProjectionOf` 的 guard+解构两处剥离（否则泄进模型面）。
> - **分期**：S1 事实打标（flag off，零行为变更）→ S2 提取面剔除（原设想的 `decision.pool_unit_fold` **未实施、无 policy 键**——落地采用恒开、安全分离改用开关全量对照）→ S3 `unit:` 行提示（仅当模型仍投错）→ S4 末端折叠退役或留一版安全网。**S1 不可省**：把"判据对不对"与"行为变没变"拆开，避免拿 golden 变更掩盖判据错误。

## 19. verify:offline filter-bar 基线漂移（HEAD 既有）——**已结案（基线重录）**

**状态**：**closed（2026-11-22 重录 filter-bar 基线并复验全绿）**｜ **优先级建议**：P2（已收口）

> **排查证据（2026-11-22）**：①`git log 8bd7a35..HEAD -- src/engine/extraction.ts src/app/candidate-scan.ts src/engine/pool-view.ts src/engine/elem-model.ts src/support/tuning.ts src/engine/pool-js.ts src/engine/pool-js-core.ts` = **空**（金标记录以来池序/抽取源码零变更）；②同一工作树连跑两次 `--check` 的失败行**逐字节一致**（确定性，非抖动）；③净树 HEAD worktree 亦失败（非本会话引入）。⇒ 结论 = **基线在记录时即与环境不符**（提交时基线过期），不是当前行为变更；ref↔label 互换属位置性编号漂移，池构成语义未变。
>
> **处置**：只重录 `tools/golden/offline/filter-bar.json`（其余 10 份原样还原），`verify-offline --check` **11/11 全绿**。**长期建议（未做）**：该 lane 的投影对位置性 ref 序敏感，后续可将 `ref_order` 改为按 `(tag,label)` 多重集比较，从根上消除这类环境敏感漂移。

> **现象**：`tools/verify-offline.ts --check` 在**净树 HEAD**（`git worktree` 验证）亦失败：`filter-bar` 观测与金标不一致（首个差异为 `e20` vs `e22`：同 label 集、同 ref 集，仅 `订票` 按钮与筛选 `li` 的 ref↔label 映射互换了位置）。本批「提取面单元折叠」开关全量对照证明对该夹具**零影响**（折叠开/关两跑输出逐字节一致）。
>
> **判断**：金标记录于 `8bd7a35`（2026-11-19），此后无池构成源码提交（仅注释批）；怀疑为**环境相关**（Chromium/度量差异影响 prominence 排序平局）或更早未重录的运行期变更。不要盲目 `--record` 掩盖——先做一次双跑一致性 + 净树对照，确认是环境还是行为变更，再决定重录或修判据。
>
> **来源**：2026-11-21 本批实施时发现（`/tmp/af-head` 净树 worktree 复现）。

## 20. 决策上下文责任边界落地：引擎单点 `ask(page, scope, accounting, intent, profile)` + 账本上收（DC7）

**状态**：**S0a + S0b + S1 + S2 + S2-Stage-3 + S3 已落地**（S2 阶段对照 16/16；Stage-3 旧实现退役 + golden 单腿 16/16；S3 = capabilities.context + Ports + doctor 矩阵 + 47 断言 lane）；**S4 待做**；baseline 维护（死 phaseFunctions 条目 + `--update` 合法下调）另行提交｜ **优先级建议**：P1

> **现状锚点**：①`elems`/`forbidden`/`notes` 由驾驶面传入 `mw.pickProposal`（引擎只做投影与渲染）——面可换池/裁剪池/自建账本；②pilot 自建 `PilotLedger`（esig 账本 + notes），与 run 面引擎侧 `RunAccounting`/`outcome-memory` 双账并存（P0/P1 的收益只在 pilot 面生效）；③模型面字段由 `executor-pure.modelProjectionOf` 手写 guard+解构两处剥离，无断言；④DC4 的 `capabilities.context` 档未实施，未声明 provider 时上文静默丢弃只记 `context_skipped`；⑤pilot 的 `drivingGoal` 把步史拼进 goal（回声风险）。
>
> **目标**（v4 复审后修正批序与签名）：按 DC7 三原则落 **S0a–S4**：引擎单点 `ask(page, scope, accounting, intent, profile)`（自取池/投影/账本/状态/裁剪，面只传意图+策略；类型单源复用执行期 `PickProposal`/`Sig`/`StopCode`/`ModelPickPhase`）→ **S0a** characterization 门禁（确定性 provider 钉住请求/返回序列与 leg/attempt 生命周期，不改运行路径）→ **S0b** 账本适配（`RunAccounting`+`OutcomeMemory` 组成 `DecisionAccounting`，**不删旧账**，逐项验证 prune/notes/effective-清-inert/desc 一致）→ S1 仅切 pilot `modelVote`（新旧双臂，含成功票与宽扫）→ S2 run 以 `runModelPick` 整段接入 → S3 `MODEL_FACE_FIELDS` 白名单断言 + `capabilities.context` → S4 结构化段 + 步史迁移（单独 A/B）。验收 = §3.2 lane + runtime lane + **模型 stub 新旧臂请求序列/选中元素/动作/停因等价** + 真站 A/B（DC5 锚）。
>
> **接口抽象（2026-11-21 追加）**：为「应用层以后可能拓展其他类型应用」，询问接口已固化为引擎侧纯契约
> `src/engine/decision-ask-contract.ts`（`DecisionAskIntent`/`Profile` → `DecisionAskOutcome`，面不得自传池/禁选/注记）；
> 新 face/新应用类型 = `DecisionFaceKind` 注册项 + 薄适配器（引擎零改动）；新面特有上文 = `DecisionSegment` 登记
> （不新增第六层）。MAINLINE seam 表已登记（方向冻结·提案）。
>
> **架构复核（2026-11-21，独立评审 + 调用链核对）**：初审**不通过**（v1 契约；v2 修正后被复审推翻，见下）。P0：①`ask` 缺 page/scope（执行期页面与 `RunAccounting` 是 `mw.run()` 调用内局部状态，retry 每次重入）；②outcome 只有位置 ref——缺生效池、单元素快照与完整投票信号（`shape/pTop1/entropyConf` 进 floor 闸门），且宽扫后 ref 指向宽池；③session 映射错误（`doAct` 是确定性 `actOnce`，零模型，不得注册询问面）。另：账本生命周期三类（attempt/run/pilot-leg）与三类池（模型/执行/宽扫证据）必须区分。契约已按此修正（`DECISION_ASK_CONTRACT_VERSION=2`：`page+scope+accounting` 入参、`pool/target/signal` 回执、face 开放注册、`anchor` 取代 `hints`、逐层回执带 status/chars）；**批次顺序修正为 S0（`RunAccounting`→`DecisionAccounting`，run 面逐字节不变）前置**，再 S1（ask 实现 + pilot 切面）。独立评审的完整报告在完成前失败（仅阶段结论入档；其证据已逐条对码核实）；其后评审者又以工作树 v2 完成第二轮复审。
>
> **复审 2（2026-11-21，v2 仍不通过）**：④ run 接入单位 = **整个 `runModelPick` phase**（executor 单次调用，窄问回退/宽扫/窗口升级/族修复共享同一份 elems/forbidden/noted——逐 `pickElement` 点换会撕裂视图）；⑤ profile 缺现行选择参数（`confFloor`/`candidatePriority`/`tieredHint`/步超时）、outcome 缺阶梯事实，run 后续动作与 trace 无法保持；⑥ `record(el,outcome,desc)` 单签名无法同时替代 `RunAccounting.forbid(ref,el,why)` 与 `OutcomeMemory.record(key(url,instruction),sig,outcome)`——作用域禁选与跨作用域记忆须分开建模。P1：询问页需 `title()`（`ProviderPage = PageLike & title`）、`signal` 缺 `entropyConf`、outcome 可非法组合、reason/limit 码未闭集、零模型 lane 不能证明模型路径等价。已改 v3，**未冻结**；初版「不通过→已修正」表述撤销。
>
> **复审 3（2026-11-21，v3 仍不通过）**：⑤ picked 强制模型 `signal`——规则分支无票（`method="rule:match"`、`conf=1.0`），executor 后续消费 `method/decisionKind/layaMargin/tierAsk/nominatedRepair/escalatedPick`；⑥ 账本缺 pilot 守卫面（`changedLoop/unhittable/guardStop/loopTrip/evidence`）且 `recordOutcome` 丢 `desc`——删 PilotLedger 则确定性守卫与交接证据必坏；⑦ `tieredHint` 缺省写反（执行期缺省 OFF，executor-types 805），anchor「总是窄问回退」违背声明 hint 权威/`actHint:"strict"`；⑧ prune/notes 语义冲突（run `pruneStale` 只删同 ref 签名失配 vs pilot 全量 esig 重映射；noted 仅 rank 档定文本 vs pilot 全部条目；`Outcome="inert"|"effective"` 与 esig 编码须单源）；⑨ `no_model.asked:0` 硬编码、reason 闭集缺 run 选择段停因码（`action_space_exhausted/step_names_no_target/hint_matched_nothing/nominated_family_empty/mismatch`）。P1：注册表须组合根注入（engine 禁 import 应用层/site-facts，不许模块全局）；driver/ambiguity/riskVote 不属 pick；`budget.stepTimeoutMs` 须约束阶梯；段缺 rejected 回执。**已改 v4**（origin 判别 + signal 可空 + phase 元数据 + ladder 闭集扩展；账本三语义分离 + `attemptNotes`/`memoryNotes` 分源 + `DecisionMemoryOutcome` 闭集；`tieredHint` 缺省 false + anchor 权威语义；`no_model.asked` 可数 + reason 闭集并入 run 停因码；`DecisionAskRegistry` 组合根注入；回执加 rejected；budget 约束阶梯；driver/ambiguity/riskVote 移出 profile），**仍未冻结**。冻结条件 = S1 后模型路径等价（provider stub 消融 + 真站 A/B）+ 闭集码与执行期停因分类断言一致 + 独立评审复看通过。
>
> **复审 4（2026-11-21，完整报告，基于 v3 工作树）**：verdict 不通过；P0-1/2/3 与 P1-1/3 已被 v4 吸收，增量收敛为 **v5**：类型单源复用（删结构复述防漂移）；outcome 字段更名 `executionPool` 并写明**模型投影永不返回执行面**、`target` 缩为 `{ref, sig}`；账本改**工厂按 lifetime 绑定策略**（prune/notesFor/forbiddenRefs；`recordMemory` 收 `Sig` 与 `"inert"|"effective"`，effective 清旧 inert；签名编码唯一 helper）；`DecisionAskPorts`（faces/segments/siteFacts）组合根注入，engine 禁 import 应用层/site-facts、不许模块全局；reason 复用 `StopCode`、limit 复用 `decision_service_choice_limit`、`narrow_abstain` 移为 ladder 事件；`ts` 统一 epoch ms；`stepTimeoutMs` 为阶梯硬约束；S1 不开放 segments（S4 结构化判别联合）。**批序改 S0a（characterization 先行）→ S0b（账本适配不删旧账）→ S1（仅 pilot 双臂）→ S2（runModelPick 整段）→ S3 → S4**。最终放行 = P0 全消 + 模型 stub 新旧臂请求序列/选中/动作/停因等价 + 既有 rules-only lane 不回归 + 危险 dry-run/default-deny 不变 + DC5 真站 A/B。
>
> **来源**：2026-11-21 决策上文审计（用户指示「理清引擎喂 vs 驾驶面喂，elems 归引擎」+「接口抽象」）。
