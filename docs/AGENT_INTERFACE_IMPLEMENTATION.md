# Agent 接口实施文档

状态：产品与架构审查完成，分阶段实施
范围：DSH 桥工具、`amber` CLI、应用包运行时暴露面
不在范围：执行器内部算法、决策模型协议、线上用例内容

---

## 0. 结论

当前 AmberFlow 对 Agent 暴露的是一个**运行接口**，不是一个**作者接口**：

- 已有一个完整应用时：`apps → run → 看摘要/报告` 的闭环成立。
- 从零开始、边看页面边改步骤时：缺少“看页面、单步跑、改一步、看结构化失败”的闭环。

因此需要补的不是新执行器，而是**同一执行器之上的 Agent 工作面**。核心判断：

1. 应用包（`apps/<id>`）作为 Agent 的默认项目格式；语义模板用于跨站迁移，`plan` CLI 作为底层能力，不暴露给 Agent 作为首选入口。
2. CLI 的 JSON 输出是唯一契约；DSH 桥只做薄适配，不重新实现参数语义和摘要语义。
3. 新增 `inspect`、`app show/check`、分段 `run`、数据型 `app edit`，全部复用现有 `extractElements`、`hintCandidates`、`runSubgoalWithRetries`、`checkSignal`、`browserSession`。
4. 不引入离线夹具；验收继续走 `online/` 真实站点与用户作用域临时应用。

---

## 1. 产品审查

### 1.1 用户与任务

目标用户不是“会写 Playwright 的工程师”，而是一个 **DSH 会话里的 Agent**：

- 能调用工具，能读文件，但不应被要求先学习 AmberFlow 的全部内部格式。
- 拿到一句目标和起始 URL，需要先观察，再逐步建立可重复的流程。
- 失败后要能定位到具体步骤，并在下一次调用中修正，而不是整条流程重来。
- 最终产物要能交给人和线上回归，而不是一次性脚本。

用户的 Job to be done：

> 在真实站点上，把一句目标逐步变成一条可重复执行、可验收、可回归的流程。

### 1.2 当前产品面

| 层 | 入口 | 现在能做什么 |
|---|---|---|
| CLI | `amber run / apps / plan / record / online / doctor / config` | 作者、运行、验收、回归都有入口，但分散 |
| DSH 桥 | `amberflow_apps / _run / _learn / _plan` | 只有列表、运行、录制、语义规划 |
| 格式 | app pack、plan JSON、语义 flow、online case | 四套格式，四种“下一步” |

### 1.3 产品问题

1. **只有运行，没有观察**
   Agent 无法通过桥看页面元素和候选 hint；`_learn` 却要求它先给出 `script` 动作列表。顺序是反的。

2. **只有整跑，没有小步**
   `run` 没有 `only_step / from_step / max_steps`。调第 2 步也要重跑第 1 步和数据腿；有工具步时还会重复副作用。

3. **只有生成，没有编辑**
   `_learn` / `_plan` 都是“全有或全无”。失败时返回一个错误字符串，没有“哪一步、看到了什么、候选是什么”。

4. **桥没有暴露已有的好能力**
   `amber apps show --json` 已能返回完整 journey / invariants；`apps check --json` 已能返回 problems；`doctor --json` 已能返回环境状态。桥一个都没接。

5. **失败摘要不可调试**
   `_run` 只回 `blocked: [{desc, obstacle}]`，没有 `steps[]`、`resultPath`、`outDir`、`method/confidence/stop_code`；Agent 只能去读 Markdown。

6. **格式选择成本高**
   Agent 不知道该从 `apps new`、`_learn`、`_plan` 还是 `plan` CLI 开始；四种格式的失败语义也不同。

7. **接口契约不一致**
   已修正：`amber online --list/--validate --json` 现在输出 JSON；`amber run --help` 不再写已删除的 `dev` 退出码。仍需统一：桥输出没有 `schemaVersion/status/next`，CLI 和桥对 `ok` 的定义不完全一致。

8. **人工步骤不可恢复**
   `manual` 步在非 TTY 下失败；桥没有“人工完成后继续”的会话机制，真实登录/验证码场景无法落地。

### 1.4 产品决策

- **默认项目格式 = app pack**：它能表达数据腿、浏览器步、工具步、人工步、不变量，是生产形态。
- **语义模板 = 迁移工具**：同一流程要跑多个站点时使用；不作为 Agent 首次落地入口。
- **`plan` CLI = 高级/底层**：保留给需要逐步编辑 TaskPlan 的调用方，不新增桥工具。
- **online = 回归层**：流程落地后跑，不参与首次编写。
- **作者路径固定为**：

```text
status → inspect → app create → app set-step → app check → run only-step → 修正
       → run from-step → run full → online
```

产品上不再增加第五种“Agent 专用格式”；所有新增工具都作用于 app pack。

---

## 2. 架构审查

### 2.1 不可破坏的原则

1. **唯一执行循环**：`BrowserMiddleware.run`；应用和线上套件不得另写执行器。
2. **完成只认信号**：`checkSignal` 是唯一完成判据；模型的 done 只是 advisory。
3. **冻结计划**：运行期不改计划形状；分支只来自声明式 `next`。
4. **数据与逻辑分离**：站点知识放配置/数据，不写进共享层。
5. **产物可审计**：结果 JSON、报告、截图、DOM 是运行证据，不进仓库。

### 2.2 现状分层

```text
engine/       extraction, signals, executor, planner (runSubgoalWithRetries)
app/          AppPack, runApp, adapters, declarative
flow/         semantic flow, plan-flow, signal induction
online/       case loader, suite runner, evidence
cli/          amber commands; online entry
dsh-bridge/   4 tools + service; subprocess to CLI
```

### 2.3 架构缺陷

1. **桥不是薄适配**
   `bridge.ts` 自己维护 `runArgs`、`runProcess`、`summarizeRun` 等一套投影，且投影字段少于结果本身；CLI 与桥可能漂移（已经出现：`provider` 描述仍写“laya-onnx 默认”，实际默认由三件套决定）。

2. **结果对象已有能力，桥没有投影**
   `AppRunResult` 有 `subgoals[]`、`step_traces[]`、`invariants[]`、`model_status`；`_run` 只回摘要。`outDir` / `${app}-result.json` 已存在，但没有出现在桥输出里。

3. **运行器没有“段落”概念**
   `runApp` 固定跑 `expanded.steps` 全量；要在不新写执行器的前提下支持单步，需要在 `runApp` 内增加“选中步骤集合 + 跳过 end-state 验收”的选项，而不是在桥里另起循环。

4. **观察原语没有出口**
   `extractElements`、`hintCandidates`、`hintMatch` 都在引擎里，但 CLI/桥没有只读入口。

5. **格式入口没有路由**
   `plan`（TaskPlan）、app pack、semantic flow 的职责在文档里，但 Agent 的工具描述里没有“从哪开始”的决策规则。

### 2.4 目标架构

```text
CLI JSON（唯一契约）
  ├── inspect       只读页面观察
  ├── apps show/check/set-step
  ├── run … only/from/max
  ├── online …
  └── doctor
        ↑
DSH bridge（薄适配：拼 argv、解析 JSON、投影有界摘要）
```

新增 **Agent 视图模块**，避免 CLI 和桥各自定义状态语义：

- `src/app/agent-view.ts`（新）
  - `toAgentRunView(result, paths)`：把 `AppRunResult` 投影成稳定、有界的 `status/steps/failure/artifacts`
  - CLI 的 `--json` 直接调用它；桥在自己的 `summarizeRun` 里按同一组字段投影（桥是独立包，
    不跨 rootDir import；两边都以 `AppRunResult` + result JSON 为唯一真相）

---

## 3. 目标接口

### 3.1 统一返回契约

CLI 继续使用现有 envelope（`schema_version / command / ok / exit_code / data / diagnostics / next / error`）。桥输出保持扁平，增加：

```json
{
  "schemaVersion": 1,
  "ok": true,
  "status": "passed",
  "data": {},
  "artifacts": {
    "outDir": "/tmp/...",
    "resultPath": "/tmp/.../app-result.json",
    "reportPath": "/tmp/.../app-report.md"
  },
  "next": ["amberflow_run ..."],
  "error": null
}
```

`status` 取值：

```text
passed | partial | failed | blocked | invalid | skipped | needs_human | infra_error
```

约定：

- `ok` 表示**本次请求范围成功**；`status=partial` 时 `ok` 可为 true。
- `verified` 单独表示“完整旅程 + 不变量成立”；单步/分段跑 `verified=false`。
- `next` 是可执行的下一步建议，不是自然语言。
- `steps[]` 默认有界（最多 20 条），超出的步骤给 `truncated: true` 和 `resultPath`。

### 3.2 工具/命令清单

#### P0

| 工具 | CLI | 作用 |
|---|---|---|
| `amberflow_status` | `amber doctor --json` | 环境、模型层级、浏览器、配置来源；密钥掩码 |
| `amberflow_inspect` | `amber inspect --json` | 只读页面观察：标题、URL、有界元素、候选 hint |
| `amberflow_app_show` | `amber apps show <id> --json` | 完整 pack + 脚本模式 + 下一步 |
| `amberflow_app_check` | `amber apps check <id> --json` | 静态校验，不开浏览器 |
| `amberflow_run` 扩展 | `amber run <id> --only-step/--from-step/--max-steps` | 单步/分段/完整运行 |
| `amberflow_online` | `amber online <tier> --json` | 线上回归（先 list/validate，再 run） |

#### P1

| 工具 | CLI | 作用 |
|---|---|---|
| `amberflow_app_create` | `amber apps new --format pack` | 创建数据型应用骨架 |
| `amberflow_app_set_step` | `amber apps set-step` | 原子增改一个步骤并校验 |
| `amberflow_app_remove_step` | `amber apps remove-step` | 删除一个步骤并 reindex |
| `amberflow_app_set_invariant` | `amber apps set-invariant` | 替换结束态验收条件 |
| `amberflow_manual_resume` | `amber run --resume <session>` | 人工步骤完成后继续 |

#### P2

- `_learn` / `_plan` 的失败诊断（replay failing、blocked steps、gate observations）。
- 语义模板的运行期 hint 回填可视化。
- 会话级浏览器复用，减少单步调试的启动成本。

### 3.3 关键参数

`amberflow_inspect`：

```json
{
  "url": "https://example.com",
  "goal": "可选，用于候选排序",
  "max_elements": 60,
  "include_text": true,
  "headful": false
}
```

有界输出：`elements` 最多 `max_elements`；文本截断并标 `truncated`；不返回整页 HTML。

`amberflow_run` 新增：

```json
{
  "only_step": 2,
  "from_step": 2,
  "max_steps": 1,
  "no_sources": true,
  "trace": true
}
```

规则：

- `only_step` / `from_step` 以 `expanded.steps` 的声明序号为准。
- 分段运行默认**不检查 end-state 不变量**；`verified=false`。
- 跳过前置工具步导致缺值时，返回 `status=blocked`、`stop_code=needs_value`，不猜值。
- 数据腿仍默认运行；调试建议 `no_sources=true`，需要数据时单独跑一次。

`amberflow_app_set_step`：

```json
{
  "app": "my-app",
  "index": 1,
  "step": {
    "desc": "点击 next",
    "start_url": "https://example.com/",
    "target_hint": "next",
    "signal": { "url_contains": "page-2" }
  }
}
```

只允许数据型应用；写入后立即 `validateApp`，失败不落盘；使用 `packToScriptSource` 生成固定形状的 `app.mjs`，不写任意 `flow(ctx)` 代码。

---

## 4. 分阶段实施

### Phase 0：接口一致性（本轮已做）

- `amber online --list --json`、`--validate --json` 输出 JSON；`--list` 增加 goal。
- `amber run --help` 删除已移除的 `dev` 退出码，统一为 `0/1/2/3/130`。
- 文件：`src/cli/online.ts`、`src/cli/registry.ts`。

### Phase 1：暴露已有能力（P0，低风险）

1. 新增 `src/app/agent-view.ts`：
   - 输入 `AppRunResult`、`outDir`。
   - 输出 `status/verified/partial/steps/failure/artifacts/next`。
   - 不改变现有 CLI 的人类可读输出。

2. 扩展 `RunSummary` / `_run` 输出：
   - `outDir`、`resultPath`、`reportPath`、`steps[]`、`failure`。
   - `steps[]` 从 `result.step_traces`（bridge 默认 `captureTraces: true`）或 `result.subgoals` 投影。
   - 保留现有 `ok/exitCode/completed/blocked/invariants/model/decisions` 字段，全部是加法。

3. 桥新增三个薄工具：
   - `_status`：调 `amber doctor --json`，投影模型 tier、浏览器、配置来源。
   - `_app_show`：调 `amber apps show <id> --json`，返回 pack + mode + problems?（problems 留给 check）。
   - `_app_check`：调 `amber apps check <id> --json`，返回 `ok/problems`。

4. 更新桥工具描述：删除已不存在的内置 apps/probe/生成器描述；把 `provider` 描述改成“省略时按三件套自动选择”。

验收：

- 桥输出在完整跑、失败跑、dry 跑三种情况下字段稳定。
- `amber apps show/check --json` 与桥结果一致。
- `npm run check` 通过。

### Phase 2：`inspect`（P0，观察面）

1. `src/engine/extraction.ts` 或 `src/engine/rules.ts` 增加 `suggestHints(elem)`：
   - 候选按稳定性排序：`data-test` → `id` / `name` → role+label → 可见文本。
   - 每个候选都用 `hintMatch` 验证只命中该元素；命不中就丢弃。
2. 新增 `src/cli/commands/inspect.ts`：
   - `browserSession(headless)` → `goto` → `extractElements` → `suggestHints`。
   - 只读，不点击、不填值、不调用模型。
   - 关闭会话；失败也关闭。
3. 注册 `inspect` 命令到 `registry.ts` / `main.ts`。
4. 桥新增 `_inspect`：调 CLI JSON，投影有界元素列表。
5. 更新 `README` / `CLAUDE.md` 命令清单。

验收：

- `amber inspect --url https://books.toscrape.com/ --json` 返回非空元素和候选 hint。
- 对 `quotes.toscrape.com` 登录页能返回 `Username/Password` 输入框。
- 对 `file://` 或非法 URL 返回 exit 2。
- 不产生点击副作用。

### Phase 3：单步/分段运行（P0，调试面）

1. `src/app/app-runner.ts` 增加 `RunSegment`：
   ```ts
   interface RunSegment {
     onlyStep?: number;
     fromStep?: number;
     maxSteps?: number;
     skipInvariants?: boolean;
     captureTraces?: boolean;
   }
   ```
2. 在 `expanded.steps` 构建后计算 `startIndex/endIndex`；`while` 循环只在段内前进。
3. `next` 边跳出段时停止并记录 `segment_stop: "next_outside_segment"`。
4. 段内不跑 end-state 不变量；完整跑保持原逻辑。
5. CLI 旗标加入 `src/support/cli-args.ts`：`only-step`、`from-step`、`max-steps`、`trace`。
6. 结果增加 `partial: true`、`verified: boolean`、`segment: {from,to}`；`AppRunResult.ok` 只表示本次范围成功。
7. 桥 `_run` 增加同名参数，输出 `steps/failure/artifacts`。

验收：

- 对用户作用域临时 app（如 3 步）：
  - `only_step=1` 只执行第 1 步，`status=partial`，`verified=false`。
  - 第 1 步失败时 `step=1`、`stop_code` 可见。
  - `from_step=2` 不执行第 1 步。
  - 完整跑仍 `status=passed`、`verified=true`。
- 数据腿/工具步前置缺值时返回结构化 `needs_value`，不抛裸栈。

### Phase 4：应用编辑（P1，闭环面）

1. `amber apps new --format pack` 或 `apps create` 生成数据型骨架。
2. `amber apps set-step`：
   - 读取 `parseDeclarativeScript` / `resolveApp` 得到 AppPack。
   - 修改 `journey[index]`，校验 `validateSignalSpec`、`target_hint`、`hosts`。
   - 用 `packToScriptSource` 写回；临时文件 + rename；失败回滚并报 problems。
   - 只允许 `mode=declarative`；flow 脚本拒绝并指路到文件系统。
3. `amber apps remove-step`：删除 + 重排 index；至少保留一步。
4. `amber apps set-invariant`：替换验收条件并校验。
4. 桥新增 `_app_create` / `_app_set_step` / `_app_remove_step`，每个写入后自动 `_app_check`，失败返回 `invalid` 和 problems。

验收：

- 创建 → 加 2 步 → check 通过 → run only_step 通过 → 完整跑通过。
- 非法 signal/hint 不落盘，返回具体 problem。
- 不覆盖非声明式应用。

### Phase 5：线上与人工交接（P1/P2）

1. 桥新增 `_online`：`list/validate/run`，输出 `tier/passed/failed/skipped/evidencePath/cases[]`。
2. `amber online` 的 `--list/--validate` JSON 已就绪；补 `cases[]` 的 `goal/subgoals/invariants`。
3. 人工步：
   - 非交互调用遇到 manual 步直接返回 `status=needs_human` + result/report 路径，不启动浏览器。
   - 不自动过、不伪造 TTY；人工在终端跑 `amber run` 完成。
   - 跨进程 `--resume` 不做（见 §10 的设计边界）。
4. `_learn` / `_plan` 失败时补 `problems` / `blocked_steps` / `gate`，仍保持“不通过不落盘”。

---

## 5. 文件级改动清单

| 文件 | 改动 |
|---|---|
| `src/support/cli-args.ts` | 增加 segment/trace 旗标 |
| `src/app/app-runner.ts` | RunSegment、段内循环、partial/verified、结果字段 |
| `src/app/agent-view.ts` | 新：CLI Agent 运行视图（桥按同一字段契约投影） |
| `src/cli/commands/inspect.ts` | 新：只读页面观察 |
| `src/cli/commands/apps.ts` | `set-step` / `remove-step` / `set-invariant` / `new --format pack` |
| `src/cli/registry.ts` | 注册 `inspect`、新 flags、帮助文案 |
| `src/cli/main.ts` | dispatch `inspect` |
| `src/cli/online.ts` | list/validate JSON（已完成） |
| `src/engine/extraction.ts` / `rules.ts` | `suggestHints` |
| `src/app/declarative.ts` | 复用 `packToScriptSource`，不新增序列化器 |
| `integrations/dsh-bridge/src/index.ts` | 新工具 schema/描述 |
| `integrations/dsh-bridge/src/service.ts` | `status/inspect/appShow/appCheck/appEdit/online` 服务函数 |
| `integrations/dsh-bridge/src/bridge.ts` | argv 构造、JSON 解析、有界摘要 |
| `docs/AGENT_INTERFACE_IMPLEMENTATION.md` | 本文档 |
| `README.md` / `CLAUDE.md` | 文档入口与命令清单 |

---

## 6. 验收标准

### 通用

- `npm run check` 通过（typecheck + 配置示例一致性 + online validate）。
- `npm run online -- --tier smoke` 7/7 通过，行为不回退。
- `npm run online -- --tier core` 通过。
- 所有新增 CLI 命令有 `--json`，错误遵循 exit 0/1/2/3。
- 所有新增桥工具输出有 `schemaVersion/ok/status/next/artifacts`，且不返回密钥。

### 逐步落地场景

用 `$AMBERFLOW_HOME/apps` 下的临时应用（不提交）走通：

1. `status` 看到模型 provider 与浏览器。
2. `inspect` 看到目标页元素与候选 hint。
3. `app_create` + `app_set_step` 建两步。
4. `app_check` 通过。
5. `run only_step=1` 成功，`partial=true`。
6. 故意改错 hint，`only_step=1` 返回 `blocked` + `step=1` + `stop_code`。
7. 改回，`from_step=2` 成功。
8. `run` 完整跑通过，`verified=true`。
9. `online --tier smoke` 通过。

---

## 7. 风险与兼容

| 风险 | 处理 |
|---|---|
| 单步跑跳过数据腿/工具步导致缺值 | 返回 `needs_value`，要求显式 `slots` 或先跑前置段 |
| 单步跑误判为“已验收” | `status=partial`、`verified=false`；完整跑才 `passed` |
| inspect 被用于绕过反爬 | 只读、不点击、不轮换指纹；不实现验证码/挑战绕过 |
| 桥写 app.mjs 引入代码执行 | 只写数据型声明脚本；flow 脚本只读 |
| 桥与引擎版本漂移 | 新增字段/工具全部加法；旧工具名与旧字段保留；`schemaVersion` 标记 |
| 无单元测试导致回归 | 所有新增行为走真实站点 online 验收；接口层只做 typecheck + JSON 契约测试（不引入夹具） |
| 多格式选择仍复杂 | 文档与工具描述固定“app pack 默认路径”；`plan`/语义模板降级为迁移工具 |

---

## 8. 开放问题

1. `inspect` 是否需要返回截图路径？建议 P1 返回路径，不内联图片。
2. `app edit` 是否允许修改 data 源？建议先只改 journey/invariants，data 改动需要重新跑数据腿。
3. 人工步的 `sessionDir` 生命周期与清理策略，需要与现有 artifact 目录治理统一。
4. 是否需要把 app pack 直接提升为 online case（减少重复声明）？可作为后续独立设计。
5. 桥是否要暴露 `config` 写能力？默认不暴露；只读 `status`，凭据仍走本机配置。

---

## 9. 实施顺序

```text
Phase 0（已完成）
Phase 1 暴露已有能力       ← 先让 Agent 看得到 show/check/doctor/resultPath
Phase 2 inspect            ← 再让 Agent 看得到页面
Phase 3 单步/分段 run      ← 再让 Agent 改得动一步
Phase 4 app 编辑           ← 再让 Agent 结构化落地
Phase 5 online / 人工交接  ← 最后补回归与真实登录
```

原则：**先暴露，后新增；先只读，后写入；先 CLI，后桥。**

---

## 10. 落地状态（2026-10-27）

已落地并通过真实站点/DSH 工具验证：

- Phase 0：`online --list/--validate --json`、帮助退出码一致性。
- Phase 1：`agent-view.ts`；`amber run --json` 与桥的 `status/verified/partial/steps/failure/artifacts`；
  `_status` / `_app_show` / `_app_check`；`resultPath/outDir`。
- Phase 2：`amber inspect` + `suggestHints` + `_inspect`；在 books/quotes 等真实页面通过。
- Phase 3：`RunSegment`（`only_step/from_step/max_steps`）与 `partial/verified/segment`；
  CLI 与桥同名参数；未执行的段外步骤在结果中标 `skipped`，不再误报 blocked。
- Phase 4：`apps new --format pack`、`apps set-step`、`apps remove-step`、`apps set-invariant`；
  桥的 `_app_create` / `_app_set_step` / `_app_set_invariant` / `_app_remove_step`。
- Phase 5：`_online`（list/validate/run）；`_learn` 回放失败返回 failed invariants；
  `_plan` 失败返回 gate + blocked steps；人工步在非交互调用中直接返回 `status=needs_human`
  （不拉 headed 浏览器、不自动过、不假装有人在）。

P2 设计边界（有意不做，不属于“未完成”）：

- 人工步的跨进程 `--resume` 不做：没有人在场时，引擎不能保持一个“等人操作”的浏览器会话；
  当前行为是明确返回 `needs_human`，人工在终端跑 `amber run` 完成。若将来要做，必须单独评审
  持久会话、凭据与清理，不能顺手塞进桥。
- `--manual` 在无显示器环境不硬拉 headed 浏览器；非交互调用使用 `manual_fail_fast` 直接返回。
