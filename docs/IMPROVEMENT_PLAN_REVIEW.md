# 治理方案 v2.1 架构评审记录（2026-11-17）

> **评审对象**：[docs/IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) v2（577 行，2026-11-17 初稿；评审后已修订为 v2.1）
> **基线**：`main @ 91bf379`；评审全程只读，未联网、未跑浏览器/模型。
> **方法**：3 个独立只读评审（目标架构 / 迁移与治理 / 红队）+ Lead 复核与裁决；评审输入为 plan v2、ARCHITECTURE.md、AGENTS.md、BACKLOG、4 份并行设计文档与关键代码/门禁工具。
> **原则**：本记录逐条给出「接受 / 部分接受 / 拒绝 + 理由」；所有裁决已回写 plan v2.1。评审报告是过程产物（不入库），关键证据在 §6 可复现。

---

## 0. 总裁决

**诊断通过，处方减重并重排。** v2 的五项病证证据（配置 4 处实测不一致、模型 prompt 25 处/重复 53%、6 处文档断点、7 组同构、8 组重复路径）经三份评审独立复核成立；需要修改的是**目标架构表达与治理程序重量**：

| 维度 | v2 初稿 | 评审后 v2.1 |
|---|---|---|
| 规模 | 41–59 人日（P0 6–9 / P1 15–20 / P2 20–30） | **~34–52 人日**（P0 10–14 / P1 12–18 / 条件 P2 12–20） |
| 目标架构 | L0–L5 单一图 + 单一编排 + 4 端口 + sdk | **依赖分层 L0–L6(+L1.5) + 执行阶段 S0–S5 双图**；共享执行内核 + 3 源适配器 + 套件聚合器；**仅保留真边界** |
| 砍掉 | — | `sdk.ts`、BrowserPort/AppPort/TargetResolutionPort、单一 `runJourney` 编排、handler 进程内化 |
| 降级 | — | 6 组 fail-fast 门禁 → 2 fail + 2 warn；新 ADR 文件 → CHANGELOG `## Decisions`；B3/B4 全量迁移 → 选择性；W4-5/B7 移出 |
| 新增前置 | — | **0.8 等价证据 lane**、**0.9 seam/符号归属冻结表**、T1/T2/T3 停手触发器、P2 条件启动 |
| 保留资产 | — | 证据化诊断、先收语义再拆文件、facade 拆分、生成物 + 负向自测、硬规则禁区 |

一句话：从「程序化治理」改为 **「证据化治理 + 最小充分架构」**——每项治理便宜到不会半途而废，每个架构决策都有可验证边界。

---

## 1. 评审结论摘要

- **目标架构评审（14 条）**：W1–W4 可照做；§3 目标架构不能直接作为实施依据。核心问题：L 编号偷换（执行阶段顶替依赖分层）、层图漏 8 个已存在面、engine↔model 方向与 prompt registry 归属自相矛盾、重试上移 kernel 违反 flow 控制流、端口真伪混杂、Ctx 现状误判、包身份未定先造 sdk、并行设计未登记。
- **迁移治理评审（18 条）**：诊断成立但迁移设计有三处结构性缺陷——**等价验收在 CI 不可复现**（dry 不执行引擎、inspect 含时序字段、trace 非确定）、**per-file 只减不增与最高 churn 文件对撞**（executor 61 次提交/17 天）、**W1-b 边界会在 P2 被重画（搬两次）**。另外：6 组一工具是新 god tool（约 1000–1600 行，超过它自己给新文件定的 800 行上限）；B7/W4-5 重复改同一批 schema-gen 数据；`exports["."]` 是 DSH 插件安装门，不能被 sdk 替换。
- **红队评审（9 条）**：诊断可信，处方过重约 2–3 倍；最贵的批次撞最高 churn 文件（近 17 天 151 次提交中 executor/app-runner/ctx 分别 61/49/35 次）；`sdk.ts` 与 CHANGELOG 已记录的 M0 决策（「首次发布不承诺 `import 'amberflow'` 引擎 API，消费面以 CLI 为准」）冲突；6 组 fail-fast 门禁有两次腐烂前科（bridge.yml 的 vitest job 永久红被删、checks.yml 的 schema snapshot 门禁长期红）；单作者 trunk（368 提交 / 2 merge）下 owner 表与 PR 仪式会空转；建议 MVG 3 件 ≈12–15 人日作为 fallback。

---

## 2. 关键发现与裁决

口径：**S1 = 不修订不能按原方案推进；S2 = 必须降级/改写；S3 = 保留但补约束**。

### 2.1 目标架构（评审 A）

| # | S | 发现 | 裁决 | 回写位置 |
|---|---|---|---|---|
| A1 | S1 | v2 用 L0–L5「执行阶段」顶替 v1 的 L0–L6「依赖分层表」，且全文无 L1.5；ARCHITECTURE.md:24、intervention-contract.ts:5、host-envelope.ts:2 仍按 v1 编号引用 | **接受**：v1 L0–L6 保留为唯一依赖分层表并补全模块；v2 的 L0–L5 改名「执行阶段 S0–S5」；MAINLINE 同时含两图与目录→层映射 | §3.1 |
| A2 | S1 | 目标层图漏 8 个已存在面：model/intervention(L1.5)/browser/data/online/flow/support/bridge（以及 tools） | **接受**：补完整「顶层模块 × 层位 × 允许 import」表；未登记目录由 mainline 门禁报红 | §3.1 |
| A3 | S1 | engine↔model 方向矛盾：W5-3 要 engine 不 import model，但 prompt registry 放 `src/model/` 且 executor 内联兜底 prompt 必须引用；model→engine 现有 7 条反向边未登记 | **接受**：prompt registry 落 **L1 共享叶子**（`src/prompts/`）；`DecisionProvider` 接口契约下沉共享叶子；不把「grep=0」当目标，改为「组合根唯一 + run-scoped 注入 + 现有反向边登记并逐步收缩」 | §3.1/§3.2/§4.4/§4.5 |
| A4 | S1 | 「重试语义单点」上移 kernel 违反 flow 控制流（只有 plan/suite 有声明式 retries；flow 的 ctx.step 是单次调用） | **接受**：kernel 只提供 attempt 记账/stop 分类；重试归 plan/suite **源适配器**，flow 显式不重试 | §3.1/§4.5 |
| A5 | S2 | `runJourney` 撞正在退役的 journey IR；source 漏 one-shot goal/record/session 与 suite 聚合层 | **部分接受**：更名 `runExecution`；创作/调试面（session、record、one-shot goal）不进内核；suite 聚合器作为源之上薄层单列；`journey` **只冻结不改名**（90 处引用，改名非零行为） | §3.1/§4.5 |
| A6 | S2 | 端口真伪混杂：BrowserPort/AppPort 是伪端口；TargetResolutionPort 与 BACKLOG #2 方向相反且与既有 policy 同名不同义；DecisionPort 签名丢了 capabilities/askChoice | **接受**：只保留真边界——`DecisionProvider`（alias 现有接口）、`BrowserSessionFactory`、`DataLeg`；TargetResolution 改为执行器内部阶段函数 + 单恢复策略表；不追端口美学 | §3.1/§4.5/§3.3 |
| A7 | S2 | Ctx 契约误判现状：`Ctx` 接口与三实现已存在（ctx-types.ts:431，session-runtime 复用 createCtx），缺的是三面行为矩阵与离线 conformance | **接受**：改为「接口不变 + 行为矩阵 + `tools/ctx-conformance.ts`（fake PageLike 离线 diff）」；删除「第 5 个类 ctx」表述 | §4.5/W5-2 |
| A8 | S2 | 包身份未定先规划 sdk；`exports["."]` 已是 DSH 插件入口；CHANGELOG 已记录 CLI-only 的 M0 决策 | **接受**：**砍 sdk**；删 `src/index.ts` 的 "Public surface" 宣称（internal）；不改 `exports["."]`；包身份 ADR 为 P0 决策项；extension 可立删、picker-server deprecated | §4.5/W5-4、§10 |
| A9 | S2 | 入口/进程边界不清：bin 垫片、bridge、npm scripts 是三类入口；进程内化会引入 provider 模块级全局与 env 串扰 | **接受**：MAINLINE 登记三类入口；bridge/session 的进程边界是契约，保留；`buildMiddleware(config)` run-scoped 注入替代全局 install；handler 进程内化延后且不设 KPI | §3.1/§4.5/§3.4 |
| A10 | S2 | P2 合并编排缺 plan/suite 结果形状与等价验收 | **接受**：先定义 `RunOutcome` 核心包络，各源结果形状逐字节保留；验收按 flow/plan/suite 三条 | §3.1/§4.5/§7 |
| A11 | S3 | 并行设计未登记：STATE_LAYER（已实施）、PACE（已实施）、INTERVENTION（实施中）、RUN_TAKEOVER（proposal）与新目标架构互有硬约束 | **接受**：§10 增「并行设计登记表（状态/约束/文件面/前置）」；W1-c 以「携带 StateCursor、钩子顺序不变」为验收；W1-b 运行期区以 intervention 步 4/5 为前置；attach 归 session-runtime | §10/§4.5/§6 |
| A12 | S3 | 命名混淆：TargetResolutionPort 与 policy targetResolution 同词不同义；`StepRequest` 已被 flow 使用；trace/result/report 横跨 app 与 online | **接受**：内部阶段函数命名为 `resolveTarget`；引擎步输入名 `EngineStepSpec`；产物面按源归属，不占层号 | §3.1 |

### 2.2 迁移与治理（评审 B）

| # | S | 发现 | 裁决 | 回写位置 |
|---|---|---|---|---|
| B1 | S1 | 运行期拆分的等价证据在 CI 不可复现：dry 只展开调用序列、inspect JSON 含 `saw_at`/`wait_ms`、trace 受模型/时序影响 → W1-b/W1-c/W5-2 实质盲拆 | **接受**：新增 **0.8 等价证据 lane**（examples canonical golden + 搬迁符号源码 hash 工具 + inspect 归一化子集；运行时 lane 与 fixtures 处置二选一），未过 0.8 不启动运行期拆分 | §6/§7 |
| B2 | S1 | per-file「只减不增」与最高 churn 文件对撞（executor 61 次提交/17 天），严格 no-growth 会压制开发或 rubber-stamp | **接受**：baseline 改「上限式 + 超标文件/函数计数 ratchet + merge-base 防手改上调 + allowlist 理由/90 天过期」；活跃文件只在声明 freeze window 内 no-growth | §5.1 |
| B3 | S1 | 6 组一工具是新 god tool（约 1000–1600 行，超自定 800 行上限）；与 config-example/prompt-hit 职责重复 | **接受**：拆 `tools/maintain/`（dispatcher ≤300 行 + size/comments/mainline/docs 模块）+ prompt-hit 加 model 组 + config-example 加 docs 三向；**2 fail + 2 warn**，按前置分批启用 | §5.1 |
| B4 | S1 | 0.1 启用的门禁组超前于其前置物（mainline 依赖 0.6、constants 依赖 1.1） | **接受**：0.1a 只开 size/docs；mainline 随 0.6、constants 随 1.1、comments/prompts 转 fail 随清理完成 | §5.1/§6 |
| B5 | S1 | W1-b 模块边界在 P2 被 W5-2/W5-3 重画 → 搬两次；`run-options.ts` 与已有 3 个 `RunOptions` 同名冲突 | **接受**：新增 **0.9 seam/符号归属冻结表**（先于 W1-b）；W1-b 只搬边界稳定区（app-pack/datasource/extraction 纯区/app-runner 外围）；ctx-step/decision-setup 归 W5；不新增第 4 个 `RunOptions` | §4.1/§6 |
| B6 | S1 | W5-1 统一 6 处装配缺 confirm 安全语义对等验收（app-runner 默认拒绝 vs start/online 自动放行） | **接受**：factory 的 confirm/掩码/pace 必须是 per-face 必填策略；start/online 的自动放行**单独立项复核**，不在本次收编 | §4.5/W5-1 |
| B7 | S2 | 与 INTERVENTION 实施中冲突：步 0-3+5 半边已改 app-runner/executor，正是 W1-b/W1-c 同函数区 | **接受**：运行期拆分以 intervention 步 4/5 + 默认切换为前置；§6 增文件预留（file reservation） | §6/§10 |
| B8 | S2 | W1-c 未接 BACKLOG #4 裁定（4d 前置 RunCtx+evidence collector、与 #2 同段顺序约束） | **接受**：W1-c 改写为「BACKLOG #4 的可执行版」，不另造 scroll/resolve-chain 映射；先 2.0 决策（发布/特征冻结）+ #2/#3 决策 | §4.1/§6 |
| B9 | S2 | 目标自相矛盾：新函数 ≤150 vs 九阶段 200–400 行 vs createCtx ≤300 vs「≥300 行函数 0」 | **接受**：planned phase 函数显式例外（≤400）；删除「0」硬目标，改为 report + 新增不得超标 | §3.4/§4.1 |
| B10 | S2 | §7 多条验收不可执行/未定义（canonical diff 未定义 normalize、inspect 非逐字节、trace 非确定） | **接受**：验证矩阵改三栏（CI 可重复 / 本地人工一次性 / 不可验证则拆小）；normalize 复用 `tools/golden-manual.ts` 先例；每批点名页面/用例 | §7 |
| B11 | S2 | 仓库有确定性资产未纳入：`fixtures/engine/` 4 个静态页 0 引用（死资产），且 AGENTS「无离线夹具」与事实矛盾；row-anchor-check 合成断言先例未推广 | **接受**：0.8 决定 fixtures 命运（接入非门禁运行时 lane 或删除并修正 AGENTS）；推广「合成输入 + 内存断言」模式到同构收口 | §6/§7 |
| B12 | S2 | B7（schema-gen 历史副本）无批次且与 W4-5 重复改同一批数据；plan 数字已过期（实测最长 statement 6830/3544/3337 字符） | **接受**：W4-5 砍；B7 移出（不做 CHANGELOG→schema-gen 迁移）；只保留 STOP_NEXT 每键 ≤120 + F 编号可解析门禁 | §4.2/§4.4 |
| B13 | S2 | 发布物隐藏依赖：`exports["."]` 是 DSH 插件安装门，W5-4「指向 sdk」会破坏 git-install；extension 未进 files；picker-server 仅 index 引用 | **接受**：不改 `exports["."]`；不建 sdk；index.ts 转 internal；extension 立删；picker-server 先 deprecated | §4.5/W5-4 |
| B14 | S2 | W1-a 与 0.7 重复（判空/掩码已在 0.7 做） | **接受**：0.7 关闭这两项；W1-a 只留 pickRow/帧谓词/会话创建/决策探测 | §4.1 |
| B15 | S2 | env 白名单低估：实测 33 处直读（19 个变量名、10 个文件）+ 2 处动态下标；plan 白名单只列 5 个 support 文件 | **接受**：先列全 10 文件与例外（平台变量/占位符/legacy 审计/桥），再定义「白名单外 0」 | §4.3 |
| B16 | S2 | 成本低估 1.6–2 倍；P1 最重是 B3/B4 迁移与 W1-b 证据 | **部分接受**：先减范围（B3/B4 选择性、sdk/端口/进程内化移出），再按「保留项」重估（P0 10–14 / P1 12–18 / P2 12–20，P2 条件） | §0/§6 |
| B17 | S3 | journey 改名不是零行为（90 处引用，含 CLI 输出/校验文案） | **接受**：只冻结、不改名 | §4.5 |
| B18 | S3 | 数字口径漂移：§5.1 引用的「795 行误报」在附录 A 没有；env「30 处」、mw「6 处」含注释 | **接受**：附录 A 补全复现命令；门禁计数一律跳过注释/字符串；正文改为 33 处/6 处真实构造 + 1 行注释 | 附录 A |

### 2.3 红队（评审 C）

| # | S | 发现 | 裁决 | 回写位置 |
|---|---|---|---|---|
| C1 | S1 | 处方过重 2–3 倍（41–59 人日 ≈ 单人 2–3 个月 vs 仓库寿命 46 天/368 提交） | **部分接受**：范围砍约 30–40%、P2 条件化、成本重估；但保留 phased roadmap 作为选项而非仪式 | §0/§6 |
| C2 | S1 | 最贵批次撞最高 churn 文件（executor/app-runner/ctx 占近 17 天提交 53%） | **接受**：低 churn 优先；运行期拆分 P2 条件 + freeze window + T1 停手触发器 | §6/§8 |
| C3 | S1 | sdk 与 M0 决策冲突（CHANGELOG 明写 CLI-only） | **接受**：同 A8，砍 sdk | §4.5 |
| C4 | S2 | 新建 DECISIONS.md 是第四本历史账（CHANGELOG + schema-gen F 表 + docs 计划文档 + ADR） | **接受**：不新建文件；历史归宿 = CHANGELOG `## Decisions`（≤40 条，只收被禁设计/事故/为什么）；B3/B4 全量迁移取消 | §4.2/§10 |
| C5 | S2 | 6 组 fail-fast 门禁低估维护成本，已有腐烂前科（bridge.yml/checks.yml） | **接受**：同 B3；加 T2「门禁反噬」触发器 | §5/§8 |
| C6 | S2 | Goodhart 指标（touch-count/行数/注释占比/函数规模/mw 计数）会诱导错误行为 | **接受**：主指标改为「同一语义实现份数 = 1」；行数/函数/注释占比降为 report/warn；扩展 KPI 改为演练定性 + 文件数参考 | §3.4/§3.5/§9 |
| C7 | S2 | MVG 3 件 ≈12–15 人日应作为 fallback；缺停手触发器 | **接受**：MVG 作为 P0 未达标时的收缩路径；T1/T2/T3 进 §8 | §6/§8 |
| C8 | S3 | 只投 2 周的 5 项清单 | **接受**：作为 P0 最小范围（与 0.1a/0.2/0.3/0.4/0.7 大体一致） | §6 |
| C9 | S3 | 2.0.0 发布口径三种说法 | **接受**：以 README「2.0.0 未发布」为当前事实；任何公共面变更前需 `npm view` 核实（联网）+ 身份 ADR | §8/§10 |

---

## 3. 被拒绝的评审意见（透明记录）

| 意见 | 拒绝理由 |
|---|---|
| 「完全砍掉 P1/P2，只做 MVG 3 件」 | 拒绝作为最终形态，接受为 fallback 与停手触发器。用户明确要求「可维护 + 可扩展」；共享执行内核、ctx 行为矩阵、W1-a 同构收口有真实长期收益，且 P2 已条件化（发布/特性冻结决策 + 0.8 绿 + INTERVENTION 步 4/5 完成 + #2/#3 决策）。 |
| 「完全不拆大文件，只做语义收口」 | 拒绝为绝对规则，接受为默认策略（机会主义 + 边界稳定区）。`run()` 2685 行与 BACKLOG #4d 已有项目方裁定，不宜由本次评审单方面取消；但不设行数/函数数硬 KPI，且运行期拆分必须过 0.8/0.9 与 freeze window。 |
| 「保留 BrowserPort/TargetResolutionPort 以实现可测试性」 | 拒绝：仓库无单测、无第二浏览器实现，伪端口只会给唯一执行循环加间接层；可测试性用 fake PageLike + 合成断言解决（row-anchor-check 已证明该模式可行）。 |
| 「保留 sdk.ts 作为正式公共面」 | 拒绝：与 CHANGELOG M0 决策冲突，且 0 消费者；正确动作是删「Public surface」宣称、锁定 exports 表。 |
| 「新建 docs/DECISIONS.md」 | 拒绝：已成第四本历史账；并入 CHANGELOG `## Decisions`，以「约束未来代码」为收录标准。 |
| 「W1-c 立即在 P1 做」 | 拒绝：P2 条件；未过 0.8/0.9、未完成 INTERVENTION 步 4/5、未冻结窗口前启动等于盲拆最高 churn 文件。 |

---

## 4. 方案修订摘要（v2 → v2.1）

1. **§3.1 改为双图**：依赖分层 L0–L6（含 L1.5，补全 model/intervention/browser/data/online/flow/support/bridge/tools）+ 执行阶段 S0–S5（入口三类 → `runExecution` 内核 → 源适配器 → 套件聚合器 → `execStep` → 唯一循环）；端口收缩为 3 个真边界。
2. **W5 重写**：`runJourney` → `runExecution`；kernel 不承接重试；创作/调试面单列；`buildMiddleware` run-scoped + per-face policy；ctx 行为矩阵 + conformance；公共面砍 sdk、锁 exports、index internal；journey 只冻结。
3. **W4 降级**：PromptSpec 最小形态（id/version/role/lang/budget/consumers）放 L1 叶子；协议能力矩阵显式化；证据 spec 延后；W4-4 只做死链/站点名/长度 warn；W4-5 砍。
4. **W2 降级**：历史归宿并入 CHANGELOG `## Decisions`；P0 只清 C+B1+B2；B4 只迁「约束未来代码」的条目；B3 机会主义；B7 移出；B6 单独立项。
5. **W3 收敛**：tuning 只收 11 个已证多写概念，不建通用 literal gate；env 白名单补全 10 文件/例外；文档生成 + 三向 gate 保留。
6. **W1 重排**：新增 0.8（等价证据）/0.9（seam 冻结）前置；W1-a 只做剩余同构；W1-b 机会主义纯区；W1-c = BACKLOG #4 可执行版（P2 条件）；不新增第 4 个 RunOptions。
7. **§5 门禁降档**：`tools/maintain/` 拆分 + prompt-hit model 组 + config-example docs 三向；2 fail + 2 warn；上限式 baseline + merge-base + 90 天过期；负向自测进 check。
8. **§6 路线图/成本重估**：P0 10–14、P1 12–18、P2 12–20（条件），总 ~34–52；新增 MVG fallback 与 T1/T2/T3。
9. **§7 验证三栏化**：CI 可重复 / 本地人工 / 不可验证则拆小；0.8 lane 定义可重复等价实现；fixtures 二选一。
10. **§10 并行登记 + 包身份 ADR**：STATE_LAYER/PACE/INTERVENTION/RUN_TAKEOVER/BACKLOG #2/#3/#4 的状态、约束、文件面、前置入表。

---

## 5. 决策记录（2026-11-17 项目方已拍板）

| # | 决策 | 状态 |
|---|---|---|
| 1 | **包身份 = CLI + DSH 插件，不承诺引擎库 API** | ✅ 已定：删 Public surface 宣称、锁 exports、不建 sdk |
| 2 | **plan 文件保留为可选适配器** | ✅ 已定：不删除 plan 用法；P2 后薄封装 |
| 3 | **批准修订后范围与 P2 条件** | ✅ 已定：P0 10–14 / P1 12–18 / P2 12–20（条件）；MVG fallback 生效 |
| 4 | **fixtures/engine 接入非门禁验证** | ✅ 已定：0.8 落地 `verify:offline` lane 骨架，不进 check；修正 AGENTS 表述 |

> 以上决策已回写 [方案 v2.1](IMPROVEMENT_PLAN.md) §10；P0 执行以方案 §6 批次表为准。

---

## 6. 评审证据索引（只读复现）

```bash
cd /root/coding/AmberFlow

# 包身份与 M0 决策
grep -n "首次发布不承诺" CHANGELOG.md            # 1568-1569：消费面以 CLI 为准
node -e 'const p=require("./package.json");console.log(p.version,p.exports["."])'  # 2.0.0 → DSH 桥
grep -n "2.0.0 未发布" README.md

# 门禁腐烂前科
grep -n "permanently red\|always died" .github/workflows/*.yml

# churn（近 3 周）
git log --since='2026-11-01' --oneline | wc -l                                # 151
git log --since='2026-11-01' --oneline -- src/engine/executor.ts | wc -l      # 61
git log --since='2026-11-01' --oneline -- src/app/app-runner.ts  | wc -l      # 49
git log --since='2026-11-01' --oneline -- src/app/ctx.ts         | wc -l      # 35
git log --merges --oneline | wc -l                                            # 2

# 目标架构现状
grep -rn "new BrowserMiddleware(" --include='*.ts' src | grep -v 'executor.ts:45' | wc -l  # 6
grep -n "export interface Ctx" src/app/ctx-types.ts                          # 431：契约已存在
grep -rn "process\.env\." --include='*.ts' src | wc -l                        # 33 处（19 变量/10 文件）+2 处下标
ls fixtures/engine/                                                          # 4 html + README；全仓 0 引用
grep -rn "fixtures/" --include='*.ts' src tools online | wc -l                # 0（死资产）

# 并行设计状态
ls src/intervention/                                                          # 已实施 306 行（L1.5）
grep -rn "settle\|StateFingerprint" --include='*.ts' src | wc -l              # STATE_LAYER 部分已实施
grep -rn "ATTACH\|takeover" --include='*.ts' src | wc -l                      # RUN_TAKEOVER 未实施
```

> 评审报告为过程产物（`/tmp/amberflow-arch-review/{target,migration,redteam}.md`），不入库；本记录只保留可复现证据与裁决。

---

## 7. 评审结论与下一步

- **结论**：方案方向与问题诊断通过；v2 的「目标架构」与「治理程序」在评审后修订为 v2.1，具备启动 P0 的条件。
- **建议**：批准 P0（0.1a → 0.2 → 0.3/0.4/0.5 → 0.6 → 0.7 → 0.8/0.9）；P1 在 P0 出口达标后启动；P2 在发布/特性冻结、0.8 证据 lane、INTERVENTION 步 4/5、BACKLOG #2/#3 决策四项满足后启动。
- **首个可执行批次**：0.1a（门禁骨架，size/docs 两组 + 负向自测）+ 0.2（配置文档真值与三向 gate）；两者可并行，均零行为变更。
- **若 P0 未达出口**：按 MVG fallback 收缩为「人读视图真值化 + 语义单源首批 + MAINLINE/新文件上限」三件，其余推迟；不得带着未关闭的等价风险进入 P2。
