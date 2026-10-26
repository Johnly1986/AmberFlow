# 架构

AmberFlow 是一个**冻结计划执行器**：计划由人（或规划器）给出，执行器逐步解析目标、动作、验证完成信号。模型只做选择/风险/完成票，不生成动作，也不产生完成结论。

## 1. 不变量

- **完成只认可验证信号**：URL 或 DOM 事实成立才算 done；模型的完成票只是 advisory。
- **一个执行器**：`BrowserMiddleware.run` 是唯一执行循环；应用层、线上套件、计划 CLI 都复用它，不分叉。
- **值只来自计划或观察**：模型不能发明槽位值；缺值返回结构化 `needs_value`。
- **失败是结果**：动作失败/元素不可达/配置错误都变成 trace 与结构化停因，不把异常甩给调用方。
- **不绕过反爬**：遇到风控/登录墙按 `blocked` / `login_required` 记录并停止；不伪造指纹、不轮换代理、不代过验证码。
- **证据不进仓库**：线上运行结果、截图、DOM 快照、真实站点冻结语料都不提交；只保留声明与运行时产物。

## 2. 分层

```
signals.ts       完成信号语言：url_contains / css_* / 组合器 / manual
extraction.ts    单次 JS 扫描元素池（主 frame + 同源子 frame + shadow root）
rules.ts         确定性规则：导航、affordance、hint 分档匹配
        ↓
executor.ts      BrowserMiddleware：唯一执行循环
                 发现元素 → 规则/计划点名 hint → 模型选择 → 闸门 → 风险 → 动作 → inert 检查 → 信号验证
        ↓
planner.ts       runPlan / runSubgoalWithRetries：一个子目标的重试、计划级执行
plan.ts          TaskPlan / PlanningRules：计划 JSON、加载期校验、槽位、when/next/retries
        ↓
app/             应用层：数据腿、浏览器步、工具步、结束态不变量
flow/            语义流 / 计划流 / 信号归纳：跨站模板与运行期回填
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

`retries` 是**整步重跑**（重新导航、重新扫描、重新问），不是在同一页反复点。`when` 是前提守卫，不成立时记为 `skipped`（完成的一种，不是失败）。`target_hints` 支持一个子目标里按顺序完成多个动作。

### 2.2 应用层

应用是用户作用域的数据配置，不是仓库内置代码：

- 位置：`$AMBERFLOW_HOME/apps/<id>/app.mjs`（或旧 `pack.json`）。
- 形态：声明式 `app.mjs`（`META` / `DATA` / `JOURNEY`）或 `flow(ctx)` 脚本。
- 旅行 = 数据腿 + 混合步骤（浏览器/CLI/SSH/stdio）+ 结束态不变量。
- 工具步沿用 CLI transport（argv 数组、env allowlist、超时、版本钉），危险步必须先干跑再确认。
- 人工步 `{manual:true}`：引擎显示页面并等待人确认，记录 `manual_steps`；非 TTY 不假装有人。

应用运行器 `src/app/app-runner.ts` 持有会话，在旅程结束后用同一页面求不变量；不把混合旅程交给只懂 DOM 的 `runPlan`。

### 2.3 语义流与计划流

`src/flow/semantic-flow.ts` 执行 site-agnostic 模板：模板只声明页面角色 + 语义目标 + 契约信号，站点知识在 `apps/<id>/sites/<site>.profile.json`。运行期三级解析：已学 hint → 模型现场选 → 老师提名；提名只有在 DOM/URL 信号成立后才回填。

`src/flow/plan-flow.ts` 把“一句话 + 种子页”变成模板与站点档案：逐步执行、从两次独立演示归纳完成信号、页面角色/参数/绑定观察进档案；整跑回放门不过就不落盘。

`src/flow/signal-induction.ts` 从一次演示的 before/after 归纳候选信号：必须判别（前 false 后 true）、稳定句柄、跨演示可复现；否则返回 `{manual:true}` 而不是猜。

## 3. 决策模型

`src/model/decision-provider.ts` 是 provider 缝：

- 线上服务由三件套选择：`AMBERFLOW_DECISION_BASE_URL` / `_MODEL` / `_API_KEY`；地址在即线上，无地址即本地。
- 本地默认 `laya-onnx`，`AMBERFLOW_DECISION_MODEL=english|multilingual` 选 checkpoint。
- `AMBERFLOW_DECISION_PROTOCOL` 可选覆盖线协议（`systemone` / `openai-decisions`）；不是 provider 键。
- `--provider NAME` 仅本次实验/消融/兼容旧适配器。
- 模型产物不齐时如实写 `off(missing)` 并走规则档，不装一个每步都抛的 runtime。

`withDecisionCache` 对确定性模型做精确键缓存；`countingRuntime` 统计咨询次数（命中缓存也算咨询）；两者在 `applySpecToRuntime` 里统一安装。

## 4. 线上测试套件

`online/` 是仓库唯一的测试声明层，`src/online/` 是运行器。

### 4.1 声明

- `online/sites/*.json`：`hosts`（白名单）、`home`、`locale`、`device`、`blocked_markers`、`login_markers`、`timeout_ms`。
- `online/cases/{smoke,core,deep,probe}/*.json`：`id` / `site` / `tier` / `goal` / `subgoals[]` / `invariants[]` / 可选 `oracle` / `expect`。
- 子目标复用 `TaskPlan` 语法；`target_hint` 允许（线上用例是站点特定测试），但不允许 `file://` 或旧夹具路径。
- 日期占位符 `{{today}}` / `{{today+7d}}` / `{{next_monday}}`；凭据 `{{env:NAME|default}}`，加载期只校验格式，运行期才解析。

### 4.2 校验与运行

`src/online/case.ts` 在加载期拒绝：非 http(s) URL、host 不在白名单、缺失 signal、非 probe 缺 invariant、明文凭据、旧夹具路径。`npm run online:validate` 就是这道门禁。

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
src/app/          应用包、适配器、运行器、轨迹、数据集
src/flow/         语义流、计划流、信号归纳
src/cli/          amber 命令与线上套件入口
src/browser/      chromium、工具信号
src/data/         通用数据腿
online/           站点档案 + 用例声明
docs/             当前有效的设计/接入文档
```

## 6. 验证

- PR：`npm run check`（typecheck + `online --validate`），不访问外网。
- 手动/定时：`npm run online -- --tier smoke`、`core`，有网络与模型时再跑 `deep`；`probe` 单独跑并按 3 退出。
- 线上任务产物作为 CI artifact 保存；仓库内不留运行结果。
