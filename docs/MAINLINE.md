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
| **L0 support** | `src/support/*`（paths / config-schema / config-store / rcfile / apply-config-env / merge-env / amberflow-home / pace / sleep / cli-args / intervention-contract / intervention-texts / **decision-provider-contract**） | node:* 仅 | 叶子层；provider 接口类型契约下沉至此，engine 只 import 契约、model 实现 |
| **L1 共享语言/叶子** | `signals` + `signal-ops`、`hint`、`click-at`、`surface`、`plan`（类型）、`pystr`、路径解析、host-envelope、**`src/prompts/`（模型提示词单源，规划中 0.4）** | L0 | 纯语言/数据；engine 与 model 都可 import |
| **L1.5 intervention** | `src/intervention/`（合同/文本零依赖 + runtime 只依赖 L0 两叶子）；`src/app/intervention-adapter.ts` 是唯一适配 | L0 两叶子 + node:* | 见 [INTERVENTION_RESCUE_MODULE.md](INTERVENTION_RESCUE_MODULE.md) §2；**不反向依赖 app/engine/model/cli/browser/data** |
| **L2 机制** | `browser-env`、`tool-signals`、`extraction`（pool-js/identity/frame-scope）、`actions`、`rules`、`settle`、`dataset`、`datasource`（传输/来源） | L0–L1 | 页面扫描、动作、稳定门、数据腿等机制 |
| **L3 决策** | `src/model/*`（provider 协议 / 缓存 / ONNX / prompt views / 审计） | L0–L2（经契约） | 实现 L0 的 provider 契约；现有 `model→engine` 反向边见 §1.2 |
| **L4 执行** | `executor`、`planner`、`bindings`、`observe`、`pool-view`、`picker`、`audit` | L0–L2 + 契约 | 唯一执行循环；只消费契约与机制，不 import 具体 provider 装配 |
| **L5 应用** | `src/app/*`（ctx / runner / adapters / trace / report / session-runtime / session-export / intervention-adapter） | L0–L4 | flow 运行期面；session-runtime 是**调试面**（复用 createCtx，不是第 5 个 ctx 实现） |
| **L6 入口** | `src/cli/*`、`src/online/*`、`src/flow/*`（归纳）、`tools/*`、`integrations/dsh-bridge/*` | 全部下层 | 入口层；bridge 是宿主集成（called, not embedded） |

### 1.1 目录 → 层映射（门禁按此断言）

| 目录 | 层 |
|---|---|
| `src/support/` | L0 |
| `src/prompts/`（规划中） | L1 |
| `src/intervention/` | L1.5 |
| `src/browser/`、`src/data/`、`src/engine/`（extraction/rules/settle 等）、`src/flow/` | L2（`src/engine/executor.ts` / planner / bindings / observe / picker / audit 为 L4；候选扫描实现已归 `src/app/candidate-scan.ts`，engine extraction 仅保留共享机制/类型，2.2b） |
| `src/model/` | L3 |
| `src/app/` | L5 |
| `src/cli/`、`src/online/`、`tools/`、`integrations/dsh-bridge/` | L6 |

### 1.2 已登记反向边（只减不增）

| 方向 | 现状 | 收缩路径 |
|---|---|---|
| engine → model | 约 9 处（`executor.ts`、`executor-pure.ts`、`executor-types.ts`、`picker.ts` 等，具体以 grep 为准） | provider 接口契约下沉 L0 + 组合根注入（P2 W5-3，条件） |
| model → engine | 约 7 处（`decision-provider.ts`、`hint-memory.ts`、`decision-openai.ts`、`decision-service.ts`、`decision-tokenplan.ts`、`page-context.ts`、`provider-escalator.ts`） | prompt views / 页面文本渲染迁 L1 或经契约（W4 证据 spec 后收缩） |

**门禁口径**：不追 `grep=0` 的审美目标；新代码不得新增反向边，已有边按批次减少并在此表登记。

> 2.2b-0（BACKLOG #2）：`model/page-context` 与 `data/source-validate` 的扫描依赖已改为显式注入（不再 import `extractElements`）；engine 内扫描实现待 2.2b 搬 app 层后从 extraction 移除。

---

## 2. 执行阶段 S0–S5（主线目标态）

```
S0 入口三类    引擎入口（bin/amber.mjs → cli/main.ts → registry）
               宿主集成（DSH bridge / amber session 子进程；进程边界=契约）
               开发/创作脚本（npm start / apps / learn / test / plan-cli / extension；非产品主线）
S1 执行内核    runExecution(source, deps)                                  ← 规划中（P2 条件；SessionLease 已落地并接入 suite + flow 两面，plan 面待接）
               共享：SessionLease(惰性创建/finally 关闭) · RunScope{run_id,outDir,budget,deadline,trace,result,warnings}
                     StopClassifier(停因→退出码) · mask/scrub · artifacts 落盘 · attempt 记账
               不共享：重试（归源）、sleep（归 pace 应用点）、业务判定（归 ctx/checkSignal）
S2 源适配器    flow    : loadScriptApp → flow(ctx)；重试/分支 = 脚本控制流；完成 = ctx.done 不变量
               plan    : TaskPlan 子目标循环 + retries/replan + NEVER_RETRY_CODES 查询；结果 = RunPlanResult
               suite   : 用例 preflight/case 执行/oracle/证据；case 结果 = CaseOutcome
S3 套件聚合器  tier 选择、exit code 0/1/2/3、--require-all、证据目录（源之上薄层，不是第 5 套编排）
S4 引擎步装配  execStep(ports, EngineStepSpec)                               ← 规划中（P2 条件）
               仅引擎步；工具步由 Ctx 契约的 toolRunner 单列，不进执行器
S5 唯一循环    BrowserMiddleware.run（不变，不重写）
               组合根：buildMiddleware(config)（P1 工厂，run-scoped 注入，禁全局 install）
非主线        session-runtime（attach/调试，复用 createCtx）· record/learn · 一次性 goal（演示→归纳→执行）
```

**现状与目标的差距**：当前 4 套编排（`runPlan`/`runSubgoalWithRetries`、`ctx.runOneStep`、`runScriptApp`/`runApp`、各入口自建 mw）与 6 处真实 `new BrowserMiddleware`。P1 先做 `buildMiddleware` 工厂；P2 在满足启动条件后引入 `runExecution` 内核与源适配器。

---

## 3. 入口与进程边界（三类）

| 类别 | 入口 | 进程/边界 | 纪律 |
|---|---|---|---|
| **① 引擎入口** | `bin/amber.mjs` → `src/cli/main.ts` → `src/cli/registry.ts`（11 命令 + help/version/completion） | 当前部分 handler 经 `ctx.runEntry` 子进程转交旧入口（12 个调用点） | 新增命令只改 registry + handler + help-map；不新增第二命令表 |
| **② 宿主集成** | `integrations/dsh-bridge/*`；`amber session` 长驻子进程 | **进程边界是契约**：bridge 只拼 CLI/解析 JSON/投影摘要（called, not embedded），spawn 是有意设计 | 不改 `package.json` `exports["."]`（= DSH 插件安装门）；`src/app/app-runner.ts` 路径本身是桥契约（checkout 探测 + spawn），**不得移动/改名** |
| **③ 开发/创作脚本** | `npm start` / `apps` / `learn` / `test` / `plan-cli` / `tools/*` / MV3 extension | 非产品主线 | 新旗标只进 registry；**extension 已删除（P2-2.3）**，picker-server deprecated 一版后评估移除 |

**进程内化**（handler 不再 spawn）：**延后**，不在 P0/P1 承诺。任何内进程化必须保持退出码矩阵与 JSON envelope 逐字节一致，并先解决 provider 装配的 run-scoped 注入（禁模块级全局）。

---

## 4. Seam / 符号归属冻结表（0.9）

> W1-b 只允许搬移「稳定区」；下表 seam 的任何变更 = 架构变更，先改本表 + 评审记录，再改代码。
> 表中「目标模块」是 P1/P2 的规划归属；当前实现位置允许暂时不一致，但不得出现第二份实现。

| Seam | 当前/目标归属 | 允许调用方 | 冻结状态 | 变更协议 |
|---|---|---|---|---|
| `browserSession` / 会话生命周期 | `src/browser/browser-env.ts` + `src/app/app-runner.ts`（会话创建两处） | executor、ctx、tools、session-runtime | **冻结**（P1 只允许 `buildMiddleware` 收口，不改语义） | 改创建/关闭顺序必须 A/B + 会话生命周期测试 |
| `BrowserMiddleware.run` | `src/engine/executor.ts` | 唯一执行循环；ctx/planner/online 经装配调用 | **逐字节冻结**（类名 + `run()` 签名不变；不另写执行器）；`maintain mainline` 断言两字面存在 | 九阶段提函数=P2 条件，每阶段独立 PR + 0.8 证据（运行期 lane 已就绪）；九阶段已落地（4d 完成） |
| `RunOptions` 组装（引擎步） | `src/engine/planner.ts:runOnce` 与 `src/app/ctx.ts:runOneStep` | 两条路径 | **冻结**（不新增第 4 个 RunOptions；P2 execStep 合并） | 能力面新增必须双端 + 等价验收 |
| 工具步装配 | `src/app/app-runner.ts:runToolStep` + `Ctx.toolRunner` | ctx.run / dangerous | **冻结**（不进引擎步装配） | 独立变更 + 危险步确认链 review |
| `DecisionProvider` 接口 | 当前 `src/model/decision-provider.ts` → 目标 `src/support/decision-provider-contract.ts`（L0） | engine（仅契约类型）、model（实现）、组合根（装配） | **方向冻结**：engine 不 import 具体实现 | 契约变更需 model/engine 双侧 typecheck + rules-only 消融 |
| 决策源装配（resolve/build） | 各处 `resolveProviderSpec → applySpecToRuntime → installLayaRuntime` → **`buildMiddleware({face,confirmPolicy,options})`（P1-1.5 已落地，provider 解析仍在入口）** | 入口/组合根 | **冻结**：组合根唯一，构造点唯一（P1 已达成）；run-scoped provider 注入留 P2 | 任一新入口不得自建 `new BrowserMiddleware`；per-face confirm 策略必填 |
| 模型 prompt | 目标 `src/prompts/`（L1 叶子） | model providers + executor legacy 兜底（P2 收编） | **方向冻结**（不放 src/model；不 import 实现） | 文本变更 version+1 + 快照 hash + A/B 证据 |
| Ctx 契约 | `src/app/ctx-types.ts`（接口已存在） | flow 脚本、ctx-dry/replay、session-runtime | **接口冻结**；缺行为矩阵 | 新增原语需 matrix + conformance + dry/replay 同步 |
| 执行结果包络 | `src/app/app-runner.ts:AppRunResult` + `planner:RunPlanResult` + `online/types:CaseOutcome` | 各源 | **冻结**；目标 P2 `RunOutcome` 核心包络 | 各源形状逐字节保留；新字段只增不改 |
| 候选/目标解析恢复链 | `extraction` + `declared.ts`（DRF）/`identity.ts`（FW8）/executor `_liveDomIdFallback`/`_domFallbackResolve` | executor | **冻结**（不新增第 5 条） | 恢复策略表单源；与 BACKLOG #2 候选契约排他 |
| 候选生产者 `CandidateProducer` | 契约 `src/engine/candidate-contract.ts`（engine，纯结构类型，无 Playwright 类型）；实现 `src/app/candidate-scan.ts` + `src/app/candidate-source.ts`（L5，app 层唯一扫描实现） | engine executor 只消费契约；`buildMiddleware` 默认注入 app producer | **方向冻结**（2.2b 完成）：engine 不得 import 扫描实现；新增实现 = 架构变更 | 扫描实现变更跑运行期 lane + examples golden；纯搬移走 split-check |
| 证据/产物落盘 | `app/trace.ts`、`app/app-report-view.ts`、`data/report-view.ts`、`online/report.ts` | 各源 | 稳定区（允许 W1-b 纯搬） | 产物字段逐字节 + 不提交仓库 |
| fixtures/engine | `fixtures/engine/*.html` | 仅 `verify:offline` / `verify:runtime:offline` 非门禁 lane | 稳定 | 不进 `npm run check`；新夹具只服务等价验证 |
| 运行期等价 lane | `tools/verify-runtime-offline.ts`、`tools/golden/runtime/**` | 非门禁（需 chromium）；跑 `BrowserMiddleware.run` 的 4 个确定性场景 | 稳定 | 运行期重构前后对比；`--record` 同场景两次一致才入库 |

### 4.1 文件预留（并行设计）

| 计划 | 预留文件/区域 | 约束 |
|---|---|---|
| INTERVENTION（v1 实施完成 2026-11-17） | `src/intervention/*`、`src/app/intervention-adapter.ts`、`src/app/intervention-result.ts`、`src/app/intervention-shadow.ts`、`support/intervention-*.ts`、`app-runner.ts` 人工步区、`bridge.ts` rescue 映射区 | 步 4/5 + 默认切换已完成（W1-c 前置满足）；仍不得在预留区做无关搬移 |
| STATE_LAYER（已实施） | `src/engine/settle.ts`、executor 状态钩子、`ctx.runtime.epoch`、policy 键 | W1-c 九阶段必须携带 StateCursor、钩子顺序不变 |
| PACE（已实施） | `src/support/pace.ts` | kernel 内不加 sleep；unit 边界留源适配器 |
| RUN_TAKEOVER（proposal） | `session-runtime` attach 面、result/evidence artifacts | attach 是调试面，不进 runExecution |
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
| [STATE_LAYER_PLAN.md](STATE_LAYER_PLAN.md) | 部分已实施 | W1-c 的验收约束；ctx 行为矩阵收录 epoch/settle |
| [PACE_UNIFICATION_PLAN.md](PACE_UNIFICATION_PLAN.md) | 已实施 | kernel 共享 pace 工具，不内嵌 sleep |
| [INTERVENTION_RESCUE_MODULE.md](INTERVENTION_RESCUE_MODULE.md) | 实施中 | L1.5 已登记；W1-c 前置；文件预留见 §4.1 |
| [RUN_TAKEOVER_AND_DOM_CONTEXT_PLAN.md](RUN_TAKEOVER_AND_DOM_CONTEXT_PLAN.md) | proposal | attach 归 session-runtime；失败现场四件套进 artifacts |
| [BACKLOG.md](BACKLOG.md) #2/#3/#4 | #2 done（2.2b）、#4 前置完成（4d）、#3 ready | #3 候选窗口指数递增可启动（契约/生产者已就位） |
| IMPROVEMENT_PLAN v2.1 | proposal（已评审） | 本文件是其 §3.1/§4.5 的落地形态 |

---

## 7. 目标态与当前差距（只作路线引用，不重复计划全文）

| 维度 | 当前（HEAD 91bf379） | 目标（P1/P2） |
|---|---|---|
| 编排 | 4 套 | kernel + 3 源适配器 + 套件聚合器（P2 条件） |
| mw 装配 | **1 处真实构造**（`src/app/middleware-factory.ts`，6 入口共用） | 1 个 `buildMiddleware` 工厂 + 2 个调试面（P1 已达成） |
| 入口 | 19 个，三类混编 | 三类登记 + 进程边界明确（P0 本文件） |
| 公共面 | `src/index.ts` 25 导出/0 消费者，宣称 Public surface | 删宣称；exports 表锁定；无 sdk（P1/P2） |
| 决策契约 | engine 直接 import model 装配/类型 | 契约下沉 L0 + 组合根注入（P2 条件） |
| ctx | 接口已存在，行为差异散落注释 | 行为矩阵 + `tools/ctx-conformance.ts`（P1/P2） |

---

## 8. 门禁（mainline 组，`npm run maintain:check`）

| 断言 | 口径 |
|---|---|
| 本文档存在且含 `L1.5`、`S0`、`S5`、三类入口 | 防止层表/阶段图回到空洞 |
| 所有顶层 `src/` 目录与 `integrations/dsh-bridge`、`tools` 在 §1.1 目录→层映射中出现 | 未登记目录报红 |
| `src/index.ts` 仓内 importer = 0 | 公共面不自欺 |
| `new BrowserMiddleware(` 真实构造数 ≤ 基线（1，工厂内唯一构造；注释行不算） | 装配点只减不增（P1-1.5 工厂已把 6 处收到 1 处） |
| `ctx.runEntry(` 调用点数 ≤ 基线（12） | 子进程转交只减不增 |
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
