# MAINLINE — 主线、分层与扩展边界（目标态）

> **状态**：P0 0.6/0.9 落地（2026-11-17，基线 `main @ 91bf379`）。本文件是「主线与分层」的唯一出处，配合 [ARCHITECTURE.md](../ARCHITECTURE.md) 阅读：
> ARCHITECTURE 讲**不变量与执行器**；本文件讲**依赖分层、执行阶段、入口/进程边界、扩展 seam**。
> 门禁：`npm run maintain:check` 的 `mainline` 组对本文档与仓库结构做静态断言（见 §8）。行号不写，一律符号名（本仓行号锚点已实测漂移）。
> 纪律：本文件登记的结构变更与 seam 变更必须先改本文件（或评审记录），再改代码；未登记的新顶层目录/入口由门禁报红。

---

## 1. 依赖分层 L0–L6(+L1.5)

> 唯一分层表。只允许**向下或同层** import；现有反向边登记为待收缩例外，**不得新增**。

| 层 | 模块/文件 | 允许依赖 | 说明 |
|---|---|---|---|
| **L0 support** | `src/support/*`（paths / config-schema / config-store / rcfile / apply-config-env / merge-env / amberflow-home / pace / sleep / cli-args / intervention-contract / intervention-texts / **decision-provider-contract** / **page-like**） | node:* 仅 | 叶子层；**provider 接口类型契约（W5-3 已落地）与页面形状纯类型**在此，engine 只 import 契约、model 实现 |
| **L1 共享语言/叶子** | `signals` + `signal-ops`、`hint`、`click-at`、`surface`、`plan`（类型）、`pystr`、路径解析、host-envelope、**`src/prompts/`（模型提示词单源，P0 0.4 已落地）** | L0 | 纯语言/数据；engine 与 model 都可 import |
| **L1.5 intervention** | `src/intervention/`（合同/文本零依赖 + runtime 只依赖 L0 两叶子）；`src/app/intervention-adapter.ts` 是唯一适配 | L0 两叶子 + node:* | 见 [INTERVENTION_RESCUE_MODULE.md](INTERVENTION_RESCUE_MODULE.md) §2；**不反向依赖 app/engine/model/cli/browser/data** |
| **L2 机制** | `browser-env`、`tool-signals`、`extraction`（pool-js（+core）/identity/frame-scope/**elem-model/page-shapes**；页面形状类型已下沉 L0 `support/page-like.ts`，extraction re-export）、`actions`、`rules`、`settle`、`dataset`、`datasource`（传输/来源；字段映射配置驱动，W3-4） | L0–L1 | 页面扫描、动作、稳定门、数据腿等机制；**数据/报表机制不认识站点/业务字段**（扫词门禁） |
| **L3 决策** | `src/model/*`（provider 协议 / 缓存 / ONNX / prompt views / 审计） | L0–L2（经契约） | 实现 L0 的 provider 契约；现有 `model→engine` 反向边见 §1.2 |
| **L4 执行** | `executor`（实现片段：executor-phases/actions/resolve 模块；类名/`run()` 冻结）、`planner`、`bindings`、`observe`、`pool-view`、`picker`、`audit` | L0–L2 + 契约 | 唯一执行循环；只消费契约与机制，不 import 具体 provider 装配 |
| **L5 应用** | `src/app/*`（ctx（+runtime/step/tools/read/nav/scroll/manual 模块；ctx.ts 为组装面）/ runner / adapters / trace / report / session-runtime（+contract/evidence/entry）/ session-export / pilot-runtime（+contract/commands/value-need/vote/evidence/ledger/ask-adapter，`pilot-ask-adapter.ts` 为 DC7 询问适配器）/ intervention-adapter） | L0–L4 | flow 运行期面；session-runtime 是**调试面**（复用 createCtx，不是第 5 个 ctx 实现）；pilot-runtime 是**模型驾驶走查面**（组合既有原语：抽池/pick/actOnce/checkSignal，不另写执行器） |
| **L6 入口** | `src/cli/*`、`src/online/*`、`src/flow/*`（归纳）、`tools/*`、`integrations/dsh-bridge/*` | 全部下层 | 入口层；bridge 是宿主集成（called, not embedded） |

### 1.1 目录 → 层映射（门禁按此断言）

| 目录 | 层 |
|---|---|
| `src/support/` | L0 |
| `src/prompts/` | L1 |
| `src/intervention/` | L1.5 |
| `src/browser/`、`src/data/`、`src/engine/`（extraction/rules/settle 等）、`src/flow/` | L2（`src/engine/executor.ts` / planner / bindings / observe / picker / audit / session-lease / **run-execution** / **run-scope** / **decision-seam** / **decision-ask**（契约 `decision-ask-contract.ts`，实现 `decision-ask.ts` 为目标）/ **decision-accounting**（`decision-accounting.ts`，账本工厂）/ **decision-pick**（`decision-pick-phase.ts` + `decision-pick-host.ts`，run 选择段实现与装配）为 L4；候选扫描实现已归 `src/app/candidate-scan.ts`，engine extraction 仅保留共享机制/类型，2.2b） |
| `src/model/` | L3 |
| `src/app/` | L5 |
| `src/cli/`、`src/online/`、`tools/`、`integrations/dsh-bridge/` | L6 |

### 1.2 已登记反向边（只减不增）

| 方向 | 现状 | 收缩路径 |
|---|---|---|
| engine → model | 约 8 处（`executor.ts`、`executor-types.ts`、`executor-middleware-types.ts`、`picker.ts` 等，具体以 grep 为准）；W5-3 收口后 `decision-provider` 引用 **engine=0**（3 个 runtime 函数经 `DecisionRuntimeHooks` 注入，装配在 `src/app/decision-runtime.ts`；`DecisionProvider` 类型走 L0 契约）；engine 仍 import `model/model.ts` 的 legacy `LayaRuntime` 门与 `decision-probe`/`hint-memory`（行为要求本身如此） | 剩余 prompt views/页面文本渲染迁 L1（W4 后续） |
| model → engine | 约 **6** 处（`decision-provider.ts`、`hint-memory.ts`、`decision-openai.ts`、`decision-service.ts`、`decision-tokenplan.ts`、`page-context.ts`）；`provider-escalator.ts` 已改本地结构类型，不再 import engine | prompt views / 页面文本渲染迁 L1 或经契约（W4 证据 spec 后收缩） |

**门禁口径**：不追 `grep=0` 的审美目标；新代码不得新增反向边，已有边按批次减少并在此表登记。

> 2.2b-0（BACKLOG #2）：`model/page-context` 与 `data/source-validate` 的扫描依赖已改为显式注入（不再 import `extractElements`）；engine 内扫描实现待 2.2b 搬 app 层后从 extraction 移除。

---

## 2. 执行阶段 S0–S5（主线目标态）

```
S0 入口三类    引擎入口（bin/amber.mjs → cli/main.ts → registry）
               宿主集成（DSH bridge / amber session 子进程；进程边界=契约）
               开发/创作脚本（npm start / apps / learn / test / plan-cli / extension；非产品主线）
S1 执行内核    runExecution(deps, source)                                  ← 已落地（§6.10；src/engine/run-execution.ts，294 行）
               共享：SessionLease(惰性创建/finally 关闭；`src/engine/session-lease.ts`) · RunScope(run_id/outDir/planPath/today；`src/engine/run-scope.ts`)
                     RunScope 目标字段中的 budget/deadline/trace/result/warnings 仍归各源；StopClassifier(停因分类：`classifyStop`/`budgetExhausted`) · mask/scrub · artifacts 交接 · attempt 记账
               不共享：重试（归源）、sleep（归 pace 应用点）、业务判定（归 ctx/checkSignal）
S2 源适配器    flow    : 两面——`runScriptApp`（loadScriptApp → flow(ctx)；完成 = ctx.done 不变量）与 `runApp`（声明式 journey，冻结）；重试/分支 = 脚本控制流
               plan    : TaskPlan 子目标循环 + retries/replan + NEVER_RETRY_CODES 查询；结果 = RunPlanResult
               suite   : 用例 preflight/case 执行/oracle/证据；case 结果 = CaseOutcome
               四源真实调用点 = 4；等价证据 = `tools/verify-run-execution.ts`（非门禁四源 canonical lane）
S3 套件聚合器  tier 选择、exit code 0/1/2/3、--require-all、证据目录（源之上薄层，不是第 5 套编排；退出码/probe 期望单点已落 src/online/suite-aggregate.ts）
S4 引擎步装配  execStep(ports, EngineStepSpec)                               ← 规划中（P2 条件）
               仅引擎步；工具步由 Ctx 契约的 toolRunner 单列，不进执行器
S5 唯一循环    BrowserMiddleware.run（不变，不重写）
               组合根：buildMiddleware(config)（P1 工厂，run-scoped 注入，禁全局 install）
非主线        session-runtime（attach/调试，复用 createCtx）· record/learn · 一次性 goal（演示→归纳→执行）
```

**现状与目标的差距**：S1 内核已落地——4 套编排（`runPlan`/`runSubgoalWithRetries`、`runScriptApp`/`runApp`、`runOneCase`）全部经 `runExecution` 组合根，真实 `new BrowserMiddleware` = 1（`buildMiddleware` 工厂）。剩余：S4 `execStep(ports, EngineStepSpec)` 引擎步装配仍为规划态；`ctx` 行为矩阵 / `tools/ctx-conformance.ts` 仍条件保留。

---

## 3. 入口与进程边界（三类）

| 类别 | 入口 | 进程/边界 | 纪律 |
|---|---|---|---|
| **① 引擎入口** | `bin/amber.mjs` → `src/cli/main.ts` → `src/cli/registry.ts`（12 命令 + help/version/completion） | 当前部分 handler 经 `ctx.runEntry` 子进程转交旧入口（12 个调用点） | 新增命令只改 registry + handler + help-map；不新增第二命令表 |
| **② 宿主集成** | `integrations/dsh-bridge/*`；`amber session` 长驻子进程 | **进程边界是契约**：bridge 只拼 CLI/解析 JSON/投影摘要（called, not embedded），spawn 是有意设计 | 不改 `package.json` `exports["."]`（= DSH 插件安装门）；`src/app/app-runner.ts` 路径本身是桥契约（checkout 探测 + spawn），**不得移动/改名**（A1 起它是 facade：运行面在 app-runner-types/policy/tool-step/declared，路径与入口 guard 不变） |
| **③ 开发/创作脚本** | `npm start` / `apps` / `learn` / `test` / `plan-cli` / `tools/*` / MV3 extension | 非产品主线 | 新旗标只进 registry；**extension 已删除（P2-2.3）**；picker-server 2.0.x 保留、2.1.0 移除（期间不新增消费者） |

> **会话面闭集单源**（session 请求 op / act op / drive 的 cmd·driver / max_steps 与 idle 界）：唯一数据表 = `src/support/session-contract.ts`，桥侧唯一投影 = 生成物 `integrations/dsh-bridge/src/session-contract.generated.ts`（`tools/session-contract-gen.ts --check` 校验过期，并与引擎契约 `src/app/session-runtime-contract.ts` 逐值交叉校验；桥不手抄闭集）。
>
> **会话面 cap 单源**（handoff 三层投影 cap / 会话响应证据块白名单与 cap / ElementView 行上限）：同一份表 `src/support/session-contract.ts` 的 `SESSION_HANDOFF_CAP_TABLE`（字段 × producer·engine·bridge 三列）、`SESSION_EVIDENCE_CAP_TABLE`（scroll/range/ambiguity/miss/wide 五块）、`SESSION_ELEMENT_VIEW_LIMITS`（上限）与 `SESSION_ELEMENT_VIEW_FIELDS`（字段合同：字段 × 引擎两面键名 × 桥面键名 × 出现面 × cap × 可否作动作地址）；桥侧投影 = 生成物 `session-contract.generated.ts` 的 `BRIDGE_HANDOFF_CAPS`/`BRIDGE_EVIDENCE_*` 与 `integrations/dsh-bridge/src/element-view.constants.generated.ts`（同一 `--check` 判过期，生成器按引擎实测行为与引擎常量/内嵌 JS 静态 pin 逐项交叉校验；字段合同另做表 ↔ 三面源码的双向交叉校验，并断言「动作地址只来自 `hint_candidates`」）。桥 `element-view.ts`/`session.ts` 只读生成常量，不写数值字面量。

**进程内化**（handler 不再 spawn）：**延后**，不在 P0/P1 承诺。任何内进程化必须保持退出码矩阵与 JSON envelope 逐字节一致，并先解决 provider 装配的 run-scoped 注入（禁模块级全局）。

---

## 4. Seam / 符号归属冻结表（0.9）

> W1-b 只允许搬移「稳定区」；下表 seam 的任何变更 = 架构变更，先改本表 + 评审记录，再改代码。
> 表中「目标模块」是 P1/P2 的规划归属；当前实现位置允许暂时不一致，但不得出现第二份实现。

| Seam | 当前/目标归属 | 允许调用方 | 冻结状态 | 变更协议 |
|---|---|---|---|---|
| `browserSession` / 会话生命周期 | `src/browser/browser-env.ts`（`browserSession` 唯一实现）+ 生命周期模板 `src/engine/session-lease.ts`（经 `runExecution` 供 flow/declared-flow/plan/suite 四源共用） | executor、ctx、tools、session-runtime、runExecution | **冻结**（P1 只允许 `buildMiddleware` 收口，不改语义；§6.10 起生命周期统一经内核） | 改创建/关闭顺序必须 A/B + 会话生命周期测试 |
| RunScope（run_id/outDir/planPath/today） | `src/engine/run-scope.ts`（L4，唯一解析点）；四源经 `runExecution` 接入 | runExecution 与四源适配器 | **字段只减不增**：budget/deadline/trace/result/warnings 仍归各源，新增字段先改本表 | 默认值/所有权变更必须 A/B（四源归一化结果） |
| `BrowserMiddleware.run` | `src/engine/executor.ts` | 唯一执行循环；ctx/planner/online 经装配调用 | **逐字节冻结**（类名 + `run()` 签名不变；不另写执行器）；`maintain mainline` 断言两字面存在 | 九阶段提函数=P2 条件，每阶段独立 PR + 0.8 证据（运行期 lane 已就绪）；九阶段已落地（4d 完成） |
| `RunOptions` 组装（引擎步） | `src/engine/planner.ts:runOnce` 与 `src/app/ctx.ts:runOneStep` | 两条路径 | **冻结**（不新增第 4 个 RunOptions；P2 execStep 合并） | 能力面新增必须双端 + 等价验收 |
| 工具步装配 | `src/app/app-runner.ts:runToolStep` + `Ctx.toolRunner` | ctx.run / dangerous | **冻结**（不进引擎步装配） | 独立变更 + 危险步确认链 review |
| `DecisionProvider` 接口 | `src/support/decision-provider-contract.ts`（L0，W5-3 已落地）+ 实现 `src/model/decision-provider.ts` 与各 provider | engine（仅契约类型 + 注入面）、model（实现）、组合根（装配） | **方向冻结**：engine 不 import 具体实现；3 个 runtime 函数（`decisionProviderOrNull`/`layaProvider`/`decisionFailureFact`）经 `DecisionRuntimeHooks` 注入（§6.10），engine `grep model/decision-provider`=0 | 契约变更需 model/engine 双侧 typecheck + rules-only 消融 |
| 决策源装配（resolve/build） | 各处 `resolveProviderSpec → applySpecToRuntime → installLayaRuntime` → **`buildMiddleware({face,confirmPolicy,options})`（P1-1.5 已落地，provider 解析仍在入口）**；runtime 函数组合根 `src/app/decision-runtime.ts`（§6.10） | 入口/组合根 | **冻结**：组合根唯一，构造点唯一；`buildMiddleware` 缺省注入 `appDecisionRuntime`（显式优先） | 任一新入口不得自建 `new BrowserMiddleware`；per-face confirm 策略必填 |
| `runExecution` 内核 | `src/engine/run-execution.ts`（L4；`runExecution(deps, source)` + `RunExecution` 面） | 四源适配器（flow/declared-flow/plan/suite） | **冻结**：SessionLease/RunScope/mw 装配入口/pace/attempt/停因分类/artifact 交接单点；**不共享** retry/sleep/业务判定 | 新增源适配器先改本表 + MAINLINE §2；内核不得内嵌 sleep；行为等价以四源 lane 为准 |
| 决策询问契约 `DecisionAsk` | `src/engine/decision-ask-contract.ts`（纯结构类型 v6：`ask(page, scope, accounting, intent, profile)`，**类型单源复用执行期**（`PickProposal`/`Sig`/`StopCode`/`ModelPickPhase`/`ProviderPage`/`score_kind`），outcome 判别联合（picked 按 `origin` 再判别：rule/escalate 无模型信号）；回 `executionPool`（模型投影永不外返回）；账本**工厂按 lifetime 绑定策略**（作用域禁选/守卫账本/跨作用域记忆三语义分立）；`DecisionAskPorts` 组合根注入；实现 `src/engine/decision-ask.ts`（S1 一期：pilot 询问）+ **run 选择段** `src/engine/decision-pick-phase.ts`（S2：8 分支搬移拆分）+ 装配 `decision-pick-host.ts`（旧 `runModelPick` 已退役；golden 由退役前实现录制，见 `tools/verify-decision-run-parity.ts`）；前置 S0a 门禁 + S0b 账本适配已完成；**run 的接入单位 = 选择段整段 phase（S2 已切换到 `runDecisionPick`；v6 起默认统一编排）**；**v6（决策平面统一 P3）**：run 选择段默认走统一编排 `decision-pick-unified.ts`（`decision-pick-arm.ts` 分派，`decision-pick-phase.ts` 保留为 A/B 对照臂）；question kind 闭集 pick/risk/done，risk/done 经 `decision-questions.ts` 访问面 | engine 只依赖类型；接入面（pilot/run/未来应用类型）构造 `intent/profile` 并消费 `outcome`；session 确定性 actOnce **不注册** | **方向冻结（提案·复审四轮：v1/v2/v3 不通过，v4 部分吸收，v5 收敛；S0a/S0b/S1/S2/S2-Stage-3/S3 已落地，未冻结）**：面不得自传候选池/禁选/注记；face/段/site-facts 经 Ports 组合根注入（引擎校验，禁模块全局）；reason/limit 直接复用执行期闭集；冻结前须过模型路径等价（provider stub 消融 + 真站 A/B） | 形状变更 = seam 变更（DC5③）：先改本表 + A/B；不得新增第六层上文，面特有上文走 `DecisionSegment` 登记（S1 不开放） |
| `DecisionRuntimeHooks` 注入契约 | engine 类型面 `src/engine/executor-middleware-types.ts`；实现 `src/app/decision-runtime.ts`（L5） | engine 执行器只消费类型；app 层装配 | **方向冻结**：engine 不 import model 实现；新增 hook 需 engine/app 双侧 typecheck | rules-only 消融 trace 一致；`grep model/decision-provider src/engine`=0 |
| 模型 prompt | `src/prompts/`（L1 叶子，P0 0.4 已落地） | model providers + executor legacy 兜底（P2 收编） | **方向冻结**（不放 src/model；不 import 实现） | 文本变更 version+1 + 快照 hash + A/B 证据 |
| Ctx 契约 | `src/app/ctx-types.ts`（接口已存在） | flow 脚本、ctx-dry/replay、session-runtime | **接口冻结**；缺行为矩阵 | 新增原语需 matrix + conformance + dry/replay 同步 |
| 执行结果包络 | `src/app/app-runner.ts:AppRunResult` + `planner:RunPlanResult` + `online/types:CaseOutcome` | 各源 | **冻结**；目标 P2 `RunOutcome` 核心包络 | 各源形状逐字节保留；新字段只增不改 |
| 候选/目标解析恢复链 | `extraction` + `declared.ts`（DRF）/`identity.ts`（FW8）/executor `_liveDomIdFallback`/`_domFallbackResolve` | executor | **冻结**（不新增第 5 条） | 恢复策略表单源；与 BACKLOG #2 候选契约排他 |
| 候选生产者 `CandidateProducer` | 契约 `src/engine/candidate-contract.ts`（engine，纯结构类型，无 Playwright 类型）；实现 `src/app/candidate-scan.ts` + `src/app/candidate-source.ts`（L5，app 层唯一扫描实现） | engine executor 只消费契约；`buildMiddleware` 默认注入 app producer | **方向冻结**（2.2b 完成）：engine 不得 import 扫描实现；新增实现 = 架构变更 | 扫描实现变更跑运行期 lane + examples golden；纯搬移走 split-check |
| 证据/产物落盘 | `app/trace.ts`、`app/app-report-view.ts`、`data/report-view.ts`、`src/online/report.ts` | 各源 | 稳定区（允许 W1-b 纯搬） | 产物字段逐字节 + 不提交仓库 |
| fixtures/engine | `fixtures/engine/*.html` | 仅 `verify:offline` / `verify:runtime:offline` 非门禁 lane | 稳定 | 不进 `npm run check`；新夹具只服务等价验证 |
| 运行期等价 lane | `tools/verify-runtime-offline.ts`、`tools/golden/runtime/**` | 非门禁（需 chromium）；跑 `BrowserMiddleware.run` 的 **8 个确定性场景**（成功/停因/遮挡/precondition/upload/scroll/range/actionable-ancestor-retarget） | 稳定 | 运行期重构前后对比；`--record` 同场景两次一致才入库 |
| 编排等价 lane | `tools/verify-run-execution.ts`、`tools/golden/run-execution/**`、`fixtures/engine/run-execution/**`（§6.10） | 非门禁（需 chromium）；四源（flow/declared-flow/plan/suite）canonical JSON，rules-only 零模型、外部请求 0 | 稳定 | 内核/适配器迁移前后对比；基线在干净 HEAD 副本 `--record` 两次一致才入库 |

> 非门禁证据 lane 清单：抽取面 `verify:offline`、运行期 `verify:runtime:offline`、四源编排 `verify:run-execution`、人工话术 `golden-manual`，以及会话/动作/决策面 `verify:act-lock` / `verify:session-range` / `verify:session-drive` / `verify:poolless-actions` / `verify:dedup-controls` / `verify:frame-budget` / `verify:frame-exempt` / `verify:app-stop-context` / `verify:decision-accounting` / `verify:decision-ask-parity`、`verify:decision-endpoint-parity` / `verify:run-view-parity`，失败路径/校验 `verify:record-failure` / `verify:ctx-validate` / `verify:rehydrate-rescan`；聚合 `npm run verify:lanes` 顺序跑其中 19 条（不含较重的 `verify:runtime:offline`）。脚本清单唯一出处 = `package.json`，本文不抄全表。

> **规则词面归一单源**（`src/engine/rules.ts` 的 goal 侧与候选 label 侧）：切词模式唯一出处 = `src/engine/rule-vocab.ts`（`ASCII2`/`ASCII4`/`CJK1`/`CJK2`/`words`），两侧不得各持一套正字面量；`namedPhraseOverrides` 只把「goal 逐词点名了哪个多词 label」这一**字面事实**补回 `affordanceRule`（仅在本已有点名结果上重排、绝不把无命中变成命中），命中词仍只来自 `STOP_TOKENS`/`ROLE_TOKENS`/`FILLER_TOKENS` 三张通用词表——引擎词面不认具体站点/业务词。证据 lane = `tools/verify-rule-vocab.ts`（非门禁、零网络、合成池：正向 + 三类反例 + 归一对称性）。

> 池外回退面补全（bugfix，受本节「候选/目标解析恢复链」冻结约束）：`actOnce` 的 `el === null` 分支按 op 分派（fill/select/hover 走各自 locator 原语；不支持的 op 结构化 `action_unsupported`，绝不退化成点击），A3 `_domFallbackResolve` 合成行补 `name`/`href` 投影——这是**补全既有回退面**，不新增第 5 条解析链；验证 lane = `tools/verify-poolless-actions.ts` + `fixtures/engine/poolless/`（非门禁）。

### 4.1 文件预留（并行设计）

| 计划 | 预留文件/区域 | 约束 |
|---|---|---|
| INTERVENTION（v1 实施完成 2026-11-17） | `src/intervention/*`、`src/app/intervention-adapter.ts`、`src/app/intervention-result.ts`、`src/app/intervention-shadow.ts`、`support/intervention-*.ts`、`app-runner.ts` 人工步区、`bridge.ts` rescue 映射区 | 步 4/5 + 默认切换已完成（W1-c 前置满足）；仍不得在预留区做无关搬移 |
| STATE_LAYER（已实施） | `src/engine/settle.ts`、executor 状态钩子、`ctx.runtime.epoch`、policy 键 | W1-c 九阶段必须携带 StateCursor、钩子顺序不变 |
| PACE（已实施） | `src/support/pace.ts` | kernel 内不加 sleep；unit 边界留源适配器 |
| RUN_TAKEOVER（proposal） | `session-runtime` attach 面、result/evidence artifacts | attach 是调试面，不进 runExecution |
| PILOTED_WALKTHROUGH（已实施） | `src/app/pilot-runtime.ts`、`pilot-contract.ts`、`pilot-commands.ts`、`pilot-value-need.ts`、`session-runtime`/`session-driver` 的 drive 面、`middleware-factory` 的 `pilot` face | 驾驶面只组合既有原语；`FACE_POLICY.pilot=default-deny`；产物恒带 `pilot:true`；停因/指令双闭集在 pilot-contract 单源 |
| BACKLOG #2/#3/#4 | candidate 契约、窗口递增、RunCtx + evidence collector | #4 是 W1-c 唯一前置；#2 决策先于 resolve 面改造 |

---

## 5. 命名表（同一概念只用一个词）

| 规范词 | 指代 | 避免 |
|---|---|---|
| **执行器 / executor** | `BrowserMiddleware`（`src/engine/executor.ts`） | 用它指 app runner / CLI |
| **执行内核 / runExecution** | 共享 session/scope/stop/artifact/attempt 的编排内核（P2） | `runJourney`（journey 是退役概念） |
| **源适配器 / source adapter** | flow / plan / suite-case 三类驱动 | 把产品面叫「编排」 |
| **套件聚合器** | `online/runner` 的 tier/exit/evidence 薄层 | 叫「第 5 套编排」 |
| **ctx** | live/dry/replay 三种实现；session-runtime 是调试面 | 「第 5 个 ctx」 |
| **journey** | **legacy**：恒空的声明式 IR，仅 learn 回放用；冻结不改名 | 新概念命名复用 journey |
| **prompts** | `src/prompts/` 模型提示词（L1） | 与 Agent 提示词（grammar/playbook/help/schema）混称 |
| **package surface** | CLI + DSH 插件；**无引擎库导入 API** | 叫「公共库 / Public surface」 |

---

## 6. 并行设计与状态（登记）

| 计划 | 状态 | 与本主线的关系 |
|---|---|---|
| [STATE_LAYER_PLAN.md](STATE_LAYER_PLAN.md) | 已实施 | W1-c 的验收约束；ctx 行为矩阵收录 epoch/settle |
| [PACE_UNIFICATION_PLAN.md](PACE_UNIFICATION_PLAN.md) | 已实施 | kernel 共享 pace 工具，不内嵌 sleep |
| [INTERVENTION_RESCUE_MODULE.md](INTERVENTION_RESCUE_MODULE.md) | 已实施（v1 完成：步 0-5 + 默认切换） | L1.5 已登记；W1-c 前置；文件预留见 §4.1 |
| [RUN_TAKEOVER_AND_DOM_CONTEXT_PLAN.md](RUN_TAKEOVER_AND_DOM_CONTEXT_PLAN.md) | proposal | attach 归 session-runtime；失败现场四件套进 artifacts |
| [BACKLOG.md](BACKLOG.md) #2/#3/#4 | #2 done（2.2b）、#4 done（4d 九阶段）、#3 ready | #3 候选窗口指数递增可启动（契约/生产者已就位） |
| IMPROVEMENT_PLAN v2.1 | **已收口（2026-11-17；P0/P1/P2 出口核对见其 §6.1/§6.2/§6.5；§6.5 D 条件项四项 + 桥 TS2375 由 §6.10 收口）** | 本文件是其 §3.1/§4.5 的落地形态；仍延期项见 plan §6.10 F |

---

## 7. 目标态与当前差距（只作路线引用，不重复计划全文）

| 维度 | 当前（HEAD edebfe6） | 目标（P1/P2） |
|---|---|---|
| 编排 | **内核 + 四源适配器**（`runExecution`，§6.10 已落地） | kernel + 源适配器 + 套件聚合器（已达成；S4 execStep 仍条件） |
| mw 装配 | **1 处真实构造**（`src/app/middleware-factory.ts`，6 入口共用） | 1 个 `buildMiddleware` 工厂 + 2 个调试面（P1 已达成） |
| 入口 | 19 个，三类混编 | 三类登记 + 进程边界明确（P0 本文件） |
| 公共面 | `src/index.ts` 25 导出/0 消费者，宣称 Public surface | 删宣称；exports 表锁定；无 sdk（P1/P2） |
| 决策契约 | engine 只 import L0 契约 + `DecisionRuntimeHooks` 注入；`grep model/decision-provider src/engine`=0（§6.10） | 契约下沉 L0 + 组合根注入（已达成） |
| ctx | 接口已存在，行为差异散落注释 | 行为矩阵 + `tools/ctx-conformance.ts`（仍条件） |

---

## 8. 门禁（mainline 组，`npm run maintain:check`）

| 断言 | 口径 |
|---|---|
| 本文档存在且含 `L1.5`、`S0`、`S5`、三类入口 | 防止层表/阶段图回到空洞 |
| 所有顶层 `src/` 目录与 `integrations/dsh-bridge`、`tools` 在 §1.1 目录→层映射中出现 | 未登记目录报红 |
| `src/index.ts` 仓内 importer = 0 | 公共面不自欺 |
| `new BrowserMiddleware(` 真实构造数 ≤ 基线（1，工厂内唯一构造；注释行不算） | 装配点只减不增（P1-1.5 工厂已把 6 处收到 1 处） |
| `ctx.runEntry(` 调用点数 ≤ 基线（12） | 子进程转交只减不增 |
| `npm run site-knowledge:check`（src 站点/业务词零命中） | W3-4：数据/报表机制不认业务字段；词表/白名单在工具内逐条登记 |
| 命名表/入口表/预留表存在 | 文档真值最低线 |

> 门禁实现见 `tools/maintain/mainline.ts`；基线值在 `tools/maintain/baseline.json` 的 `mainline` 节，`--update` 只许下调。
> 不影响本文件「目标态」表述：门禁断言的是**不新增**，不是要求当前就达到目标态。

---

## 9. 变更协议

1. 新增顶层目录/入口类别 → 先改本文件 §1.1/§3，并同步 `ARCHITECTURE.md`。
2. 新增/移动 seam → 先改 §4，再改代码；W1-b 只搬 §4 标记为稳定区的部分。
3. 新增 source adapter / 内核职责 → 先改 §2，再进 P2 批次。
4. 任何公共面（exports/entry）变更 → 先有包身份 ADR（已定：CLI + DSH 插件、无引擎库 API）。
5. 未登记的结构变更由 `maintain:check` 报红；门禁本身也进 `npm run check`（负向自测见 `--self-test`）。
