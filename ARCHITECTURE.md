# 架构

AmberFlow 是一个**冻结计划执行器**：流程由人（或规划器）给出，执行器逐步解析目标、动作、验证完成信号。模型只做选择/风险/完成票，不生成动作，也不产生完成结论。

应用的作者模型只有一种：`apps/<id>/app.mjs` 里的 `flow(ctx)` 脚本。控制流在脚本里（`if` / `for` / `while` / 函数），引擎负责“一步之内”的元素池、目标解析、闸门、动作、完成信号与证据。

## 1. 不变量

架构不变量（本文件负责的两条）：

- **一个执行器**：`BrowserMiddleware.run` 是唯一执行循环；flow 脚本的 `ctx.step` / `ctx.run`、计划 CLI、线上套件都复用它，不分叉。
- **单一应用作者模型**：只有 `meta` + `flow(ctx)`。`meta` 是唯一声明面，步骤是运行期事实，不存在静态步骤表。

行为硬规则（完成只认信号、值只来自计划/观察、失败是结果、不绕过反爬、证据不进仓库、危险步/人工步/凭据纪律）的唯一出处见 [AGENTS.md](AGENTS.md) 的「硬规则」一节——这里不重复，改规则只改那一处。

## 2. 分层

```
signals.ts       完成信号语言：url_contains / css_* / 组合器 / manual
extraction.ts    单次 JS 扫描元素池（主 frame + 同源子 frame + shadow root）
rules.ts         确定性规则：导航、affordance、hint 分档匹配
        ↓
executor.ts      BrowserMiddleware：唯一执行循环
                 发现元素 → 规则/计划点名 hint → 模型选择 → 闸门 → 风险 → 动作 → inert 检查 → 信号验证
        ↓
planner.ts       runPlan / runSubgoalWithRetries：计划级执行
plan.ts          TaskPlan / PlanningRules：计划 JSON、加载期校验、槽位、when/retries
        ↓
app/             应用层：flow 脚本加载（meta → IR）、运行期 ctx、轨迹、适配器、运行器
        ↓
cli/             amber 命令入口 + 线上套件入口
```

### 2.1 执行器

每一步：

1. 扫描当前页面，得到元素池（ref/tag/label/属性/可见性）。
2. 计划有 `target_hint` / `target_hints` 时按 hint 解析；有 hint 时 hint 权威，miss 才交给模型。
3. 没有 hint 时先跑确定性规则（导航、affordance），再问决策模型。
4. 置信度低于 floor、风险高、动作不可执行，都走显式分支；不静默继续。
5. 动作后比较 URL/文本/输入值；无变化记为 `inert`，元素被禁止，不会在同一子目标里反复点。
6. 每步后检查完成信号；只有信号成立才 done。

`when` 是前提守卫，不成立时该步不执行（`stopCode="precondition_skipped"`，由脚本决定怎么处理）。纯导航用 `ctx.arrive`：只导航 + 等信号，不做元素选择、不花模型。

### 2.2 应用层（flow 脚本）

应用是**用户作用域的一段 JS 流程**，不是仓库内置代码：

- 位置：`$AMBERFLOW_HOME/apps/<id>/app.mjs`（也接受 `app.js` / `app.ts`，运行期 `import()`）。仓库 `apps/`（若存在）只是开发夹具，不是内置应用。
- 形态：
  ```js
  export const meta = (kit) => ({ id, label, goal, hosts, slots, sources, policy, pace, invariants, ... });
  export async function flow(ctx) { /* 普通 JS 控制流 */ }
  ```
- `meta` 是**唯一声明面**：`app-meta.ts` 的 `lowerMeta` 把它投影成内部 `AppPack` IR（不在磁盘上存在），未知 meta 字段加载期响亮拒绝。IR 的 `journey` 永远为空——步骤在运行期由脚本产生，保留该字段只为复用既有校验/报告形状。
- 加载与校验：`app-script.ts` 的 `loadScriptApp` 负责 `import`、跑 `meta(kit)`、`lowerMeta`、`validateApp`；坏脚本就是配置错误，不静默降级。脚本不被项目 `tsconfig.json` include，也不 import 仓库模块（`kit` 由引擎注入）。
- 运行期：`ctx.ts` 的 `createCtx` 是唯一运行期面。`ctx.step(goal, { id?, act?, done, url?, slots?, when?, timeoutMs? })` 一步之内复用 `BrowserMiddleware.run`；`act` 缺省 = 由规则/决策层选目标（决策语句的默认写法），`ctx.hint()` 只在需要稳定锚点时给出；`ctx.done()` 用同一页面验收结束态不变量；`ctx.fail(code, reason)` 抛结构化 `StopError`。
- 预算：`ctx.budget` 记录 `ctx.step` / `ctx.arrive` / `ctx.run` / 人工步的执行次数；`amber run --max-steps N` 用满时以 `budget_exceeded` 停下，结果为 `partial`（已执行的步骤是事实，不是配置错误）。
- 执行轨迹：`ctx` 的每次调用进 `AppTrace`（`trace.ts`）：`script_sha256` + `inputs_sha256` + 逐次调用；`--emit-trace` 落盘，`--replay` 按同一条轨迹重放（版本/槽位不一致直接拒跑）。
- 工具步：`ctx.run(...)` 走与应用支持器（cli / ssh / stdio）同一份校验/展开/执行实现；危险步必须有 `dryRunArgs`，默认拒绝，拒绝与干跑失败都是结构化结果。
- 人工步：`ctx.manual(...)` 由运行器提供的人工处理器执行（TTY 终端提示；非 TTY 返回 `needs_human`，不假装有人、不拉有头浏览器）。**未完成的人工步永远不能变绿**：即使脚本吞掉返回值，运行仍是 `status=needs_human`、`verified=false`。
- 节奏：`meta.pace.between_steps_ms` 由 `ctx` 在两次执行步之间等待，`between_actions_ms` 由执行器用于子目标内动作间隔；优先级本次显式 > `meta.pace` > 环境变量 > 0。
- dry 回路：`dryRunFlow` 用 `createDryCtx` 在同一套调用序列上做静态校验（信号、命令、hosts 信封），不打开浏览器、不调模型；`amber apps check/explain` 与 `amber run --dry-run` 都走它。

`ctx` 拿不到 `page`/locator、模型文本或分数，只能看到 `{ ok, stopCode, reason?, evidence }` 这类结构化结果——这是“脚本管走向、引擎管一步之内”的边界。

### 2.3 录制与信号归纳

`tools/learn.ts`（`amber record` / `npm run learn`）从一次真实演示归纳完成信号与结束态不变量，再把录制结果生成成 flow 脚本：

1. 采集演示动作与每一步的 before/after 页面状态。
2. `src/flow/signal-induction.ts` 从状态差归纳候选信号：必须判别（前 false 后 true）、稳定、可复现；没把握时返回 `{manual:true}` 而不是猜。
3. 用回放形状的运行归纳结束态不变量（演示会话会累积状态，回放每步重新导航，结束态可能不同）。
4. `app-meta.ts` 的 `packToFlowSource` 把内部 IR 生成为 `app.mjs` 源码。
5. **零模型调用回放门**：生成脚本用规则档完整跑一遍必须通过才落盘；不过就不写文件，并报 `replay-failed`。

### 2.4 计划文件与一次性目标

`amber plan` / `amber run --plan` 仍然存在，服务于“先把计划写成文件、再执行”的用法；`amber run --goal ... --url ...` 是一次性目标：演示 → 归纳计划 → 执行并落 `--save-plan`。两者都是执行器之上的入口，不是第二种应用格式；应用仍然只有 `app.mjs`。

## 3. 决策模型

`src/model/decision-provider.ts` 是 provider 缝：

- 线上服务由三件套选择：`AMBERFLOW_DECISION_BASE_URL` / `_MODEL` / `_API_KEY`；地址在即线上，无地址即本地。
- 本地默认 `laya-onnx`，`AMBERFLOW_DECISION_MODEL=english|multilingual` 选 checkpoint。
- `AMBERFLOW_DECISION_PROTOCOL` 可选覆盖线协议（`systemone` / `openai-decisions`）；不是 provider 键。
- `--provider NAME` 仅本次实验/消融。
- 模型产物不齐时如实写 `off(missing)` 并走规则档，不装一个每步都抛的 runtime。

`withDecisionCache` 对确定性模型做精确键缓存；`countingRuntime` 统计咨询次数（命中缓存也算咨询）；两者在 `applySpecToRuntime` 里统一安装。

## 4. 线上测试套件

`online/` 是仓库唯一的测试声明层，`src/online/` 是运行器。它是**测试声明格式**，不是应用流程格式。

### 4.1 声明

- `online/sites/*.json`：`hosts`（白名单）、`home`、`locale`、`device`、`blocked_markers`、`login_markers`、`timeout_ms`。
- `online/cases/{smoke,core,deep,probe}/*.json`：`id` / `site` / `tier` / `goal` / `subgoals[]` / `invariants[]` / 可选 `oracle` / `expect`。
- 子目标复用 `TaskPlan` 语法；`target_hint` 允许（线上用例是站点特定测试），但不允许 `file://` 或旧夹具路径。
- 日期占位符 `{{today}}` / `{{today+7d}}` / `{{next_monday}}`；凭据 `{{env:NAME|default}}`，加载期只校验格式，运行期才解析。

### 4.2 校验与运行

`src/online/case.ts` 在加载期拒绝：非 http(s) URL、host 不在白名单、缺失 signal、非 probe 缺 invariant、明文凭据、旧夹具路径。`npm run test:validate` 就是这道门禁。

`src/online/runner.ts`：

- 先做一次 preflight：网络错误 → `unreachable`；401/403/429/风控正文 → `blocked`；登录跳转/标记 → `login_required`。
- 通过后每个子目标走 `runSubgoalWithRetries`，最终用 `checkSignal` 求结束态不变量。
- 可选 `oracle` 由 `src/online/oracle.ts` 独立读页面（count/order/set/attr），不读执行器 trace。
- 每个 case 独立 browser context；设备面由 site/case 声明。
- 证据写 `$AMBERFLOW_HOME/online-runs/<run-id>/`，失败时截图 + DOM；**不提交**。

### 4.3 分层与退出码

- `smoke`：单页可达 + 关键地标，默认不依赖模型。
- `core`：短流程；`deep`：有状态长流程；`probe`：风控/可达性观测，非门禁。
- 退出码：0 全过；1 真失败；2 校验/用法错误；3 有 blocked/unreachable/login_required/未执行。`--require-all` 把 3 视为失败。

## 5. 目录

```
src/engine/       执行器、计划、信号、提取、规则、审计、动作
src/model/        决策提供者、服务协议、缓存、学习、ONNX
src/app/          flow 应用：加载器、meta 投影、运行期 ctx、轨迹、适配器、运行器
src/flow/         信号归纳与共享基础
src/cli/          amber 命令与线上套件入口
src/browser/      chromium、工具信号
src/data/         通用数据腿
integrations/
  dsh-bridge/     DSH 桥（只拼 CLI、解析 JSON、投影有界摘要）
online/           站点档案 + 用例声明
docs/             当前有效的设计/接入文档
```

## 6. 验证

- PR：`npm run check`（typecheck + 配置示例一致性 + `test:validate`），不访问外网。
- 作者回路：用用户作用域临时应用跑 `apps new → apps check → apps explain → run --dry-run → run --max-steps`。
- 手动/定时：`npm run test -- --tier smoke`、`core`，有网络与模型时再跑 `deep`；`probe` 单独跑并按 3 退出。
- 线上任务产物作为 CI artifact 保存；仓库内不留运行结果。