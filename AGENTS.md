# AGENTS.md — AmberFlow 工程指南（Agent 指令的唯一内容枢纽）

> 本文件是跨 harness 共享的 Agent 指令**唯一内容出处**：Claude Code 经 `CLAUDE.md`
> 薄壳 `@AGENTS.md` 导入；Cursor / Codex / Copilot 等各自的入口文件也只做指针到这。
> 各 harness 特有机制写在各自的薄壳里，不写在这里。
> 引用纪律：命令表的唯一出处是 `src/cli/registry.ts`；配置键的唯一出处是
> `src/support/config-schema.ts`；本文件不再手抄这两张表。

## 引擎概述（概述层 · 唯一出处 `src/support/help-map.ts`，勿手抄）

> 以下逐字来自 `OVERVIEW_TEXT`，`npm run prompt-hit` overview 组校验；改概述先改模块。
> 三层提示词系统（概述/工具/提示层）的设计出处见 `docs/PROMPT_SYSTEM.md`。

```text
AmberFlow 是冻结计划的浏览器自动化引擎：计划由人给出（app.mjs 的 flow(ctx) 脚本），引擎逐步选元素、执行动作、验证完成信号；模型只做选择票，不生成动作，完成只认 DOM/工具信号。什么时候用：要在真实网站上自动化一条可验证的流程（采集、下单、巡检、回归），且希望每一步有结构化证据与完成裁决时。从哪开始：已安装 → amber doctor 体检；checkout 内 → node --experimental-strip-types src/cli/main.ts doctor（裸 amber 不在 PATH，npx amber 会挂住）。
```

## 仓库是什么

冻结计划的浏览器自动化中间件（TypeScript，Node ≥ 22.6）。计划由人给出，执行器逐步选元素、动作、检查可验证信号；模型只做选择/风险/完成票，不生成动作。应用只有一种格式：`$AMBERFLOW_HOME/apps/<id>/app.mjs` 的 `meta` + `flow(ctx)` 脚本。仓库不包含单元测试、离线夹具、复刻站、内置应用或真实站点冻结证据；验证由 `online/` 真实站点套件承担。

## 命令

```bash
npm ci
npx playwright install chromium
npm run doctor                         # 环境 / 配置 / 决策源体检
npm run check                          # typecheck + 配置示例一致性 + test:validate（PR 门禁）
npm run test -- --tier smoke         # 真实站点快速可达性
npm run test -- --tier core          # 短流程
npm run test -- --tier deep          # 长流程
npm run test -- --tier probe         # 风控/可达性探针，非门禁
npm run test -- --case <id> --headful
npm start -- --goal "..." --url ...    # 一次性目标：演示 → 计划 → 执行
# ⚠ 在 checkout 目录里 `npx amber …` 会**挂住不返回**：本包的 bin 没链进 node_modules/.bin，
# npx 会去解析远端同名包。就地可用的等价形式（下面每条 npx 行都适用）：
#   node --experimental-strip-types src/cli/main.ts <命令> …     或全局 `npm link` 后用 `amber …`
npx amber inspect --url <URL> --json   # 只读观察；写 done/act 之前先看这一页真的长什么样
npx amber apps new <id> --url <URL>    # 生成 flow 骨架（$AMBERFLOW_HOME/apps/<id>/app.mjs）
npx amber apps check <id>              # 加载 + dry 调用序列校验
npx amber apps explain <id>            # dry 调用序列
npx amber run <id> --trace             # 运行 flow 应用
npm run apps -- --app <id>             # 用户作用域应用（同一运行器）
npm run learn                          # 演示一次，录成应用
npx amber record https://<页面> --name <id>   # 同一入口的 CLI 形式
npm run model:fetch -- --from <url|路径>
npm run picker-server
```

`npm run test` 是真实站点套件，不是单元测试；没有 `npm run verify`。PR 门禁只走 `npm run check`，真实站点回归走 `npm run test`（声明数据在 `online/`）。

## 应用模型

- 只有一种格式：`$AMBERFLOW_HOME/apps/<id>/app.mjs`（也接受 `app.js` / `app.ts`），导出 `meta(kit)` 与 `flow(ctx)`。
- `meta` 是唯一声明面（id/label/goal/hosts/slots/requiredSlots/secretSlots/sources/device/site/notes/policy/pace/invariants/recordedFrom/generatedFrom）；未知字段加载期报错。
- 流程默认由决策语句组成（`ctx.step(goal, { done })`）；控制流只用于真实分支/循环/重试。没有静态步骤表。
- `ctx.step(goal, { id?, act?, done, url?, slots?, when?, timeoutMs? })`；`done` 必填，`act` 省略 = 引擎决策目标（默认决策语句写法）。`id` 进 trace / `step_traces` / failure；`ctx.fail(code, reason)` 抛结构化停因。
- `amber run --max-steps N` 是 `ctx.step` / `ctx.arrive` 的执行预算，不是“从第 N 步开始”；用满时 `status=partial`、exit 0、`verified=false`。
- 仓库 `apps/`（若存在）只是开发夹具；没有内置 demo 应用。应用正文以用户目录里的 `app.mjs` 为准。
- 硬编码 hint/URL/业务值只作为必要锚点/数据：优先 `meta.site.pages` + `ctx.openPage`、`meta.slots`/`ctx.source`，不要把选择逻辑写死在流程里。
- Agent / DSH 桥的稳定契约见 `docs/AGENT_INTERFACE.md`；作者指南见 `docs/APP_SCRIPT_AUTHORING.md`。

## 测试

`online/` 是唯一测试声明层：

```
online/sites/*.json
online/cases/smoke/*.json
online/cases/core/*.json
online/cases/deep/*.json
online/cases/probe/*.json
```

- Case 只能引用真实 `http(s)` URL；`file://` 与旧夹具路径在 `src/online/case.ts` 加载期拒绝。
- 非 probe 至少一条结束态 `invariant`；`subgoals` 复用 `TaskPlan` 语法。
- 日期用 `{{today}}` / `{{today+7d}}` / `{{next_monday}}`；凭据只允许 `{{env:NAME|default}}`。
- 运行证据写 `$AMBERFLOW_HOME/online-runs/<run-id>/`，**不要提交**；失败截图/DOM 只作为本次观察。
- 退出码 0 全过、1 真失败、2 校验/用法、3 blocked/unreachable/未执行（跳过 ≠ 通过）。
- 不绕过反爬（不伪造指纹、不轮换代理、不规避风控/速率限制）；验证环节（登录/2FA/验证码等）可在用户授权下代过；凭据可由用户在本机配置/环境变量/受支持的凭据存储中保存、引擎按名读取，明文凭据不得进入用例/产物/仓库；探针只记录环境事实。

## 架构

- `src/engine/executor.ts`：唯一执行循环 `BrowserMiddleware.run`。不要为应用层/线上套件另写执行器。
- `src/engine/signals.ts`：完成信号语言；`checkSignal` 同时回答“完成”和“when 是否适用”。
- `src/engine/plan.ts` / `planner.ts`：TaskPlan、PlanningRules、`runPlan`、`runSubgoalWithRetries`。
- `src/app/app-script.ts`：`loadScriptApp`（import → `meta(kit)` → `lowerMeta` → `validateApp`）与 `dryRunFlow`。
- `src/app/app-meta.ts`：`meta` → 内部 IR 的唯一字段映射；未知字段在此拒绝。
- `src/app/ctx.ts`：`flow(ctx)` 的唯一运行期面（`step` / `arrive` / `manual` / `run` / `read` / `extract` / `done` / `fail` / 预算 / `meta.pace`）。
- `src/app/app-runner.ts`：`runScriptApp` 持有会话、跑脚本、在 `ctx.done()` 验收不变量、写 trace / result / report。
- `src/app/`：适配器、轨迹、数据集与运行器；应用层只有 flow 这一种作者模型。
- `src/flow/signal-induction.ts`：从演示 before/after 归纳候选信号（录制用）。
- `src/model/`：决策提供者、SystemOne/OpenAI Decisions、缓存、学习、ONNX。
- `src/cli/`：amber 命令与 `test` 入口。`src/cli/registry.ts` 是帮助与命令表的唯一出处。
- `src/online/`：线上用例加载、校验、运行、独立 oracle、证据。
- `src/data/datasource.ts`：通用数据腿；站点知识放配置，不写进引擎。

## 决策模型配置

线上只用三件套：`AMBERFLOW_DECISION_BASE_URL` / `_MODEL` / `_API_KEY`。有地址即线上；无地址用本地 `laya-onnx`，`AMBERFLOW_DECISION_MODEL=english|multilingual` 选 checkpoint。`AMBERFLOW_DECISION_PROTOCOL` 可选覆盖协议；`--provider` 仅本次实验/消融，不写进配置。详细说明 `docs/DECISION_SERVICE_CONFIG.md`。

## 硬规则

- 完成只认信号；模型 done 票只是 advisory。
- 值只来自计划/观察；缺值返回 `needs_value`，不猜。
- 动作失败/不可达/配置错误变成结构化结果与 trace，不抛裸栈给用户。
- 危险工具步必须干跑 + 人类确认；默认拒绝。
- **浏览器腿（M0 起默认安全）**：应用批量运行给执行器装的 `confirmFn` 缺省按干跑证据拒绝破坏性动作；`--confirm-unsafe` 或 `AMBERFLOW_CONFIRM_SAFE=0` 才恢复旧的「风险只记录不阻断」（`src/app/app-runner.ts` 的 `confirmSafe` 分支）。执行器自带的拒绝型 `DEFAULT_CONFIRM` 仍只在没人覆盖它时生效。
- 人工步不自动过；非 TTY 不假装有人。
- 凭据由用户在本机配置/环境变量/受支持的凭据存储中保存，引擎按名读取（本机配置文件已被 .gitignore）；用例里只允许 env 占位符，任何明文凭据不得进入用例/产物/仓库。
- 敏感槽位在 `meta.secretSlots` 声明（加载期校验必须是已声明槽位）；result/report/stdout/dry 输出前一律掩码为 `***`。`--slot k=v` 的明文会进进程参数/桥 argv，敏感值用 `--slot-file`（JSON）或 env/本机配置。
- 运行产物、截图、DOM、真实站点记录不进仓库；`.gitignore` 已覆盖 `online-runs/`。
- 新增站点/用例优先写成数据；共享层不认识具体站点。
- 应用脚本是进程内任意代码：信任边界 = “用户作用域 + 不放仓库”；结果带 `script_sha256`，沙箱未做。

## 文档

`README.md`、`ARCHITECTURE.md`、`docs/AGENT_INTERFACE.md`、`docs/APP_SCRIPT_AUTHORING.md`、`docs/MANUAL_STEPS_AND_PACE.md`、`docs/DECISION_SERVICE_CONFIG.md`、`docs/PROMPT_SYSTEM.md`（三层提示词系统设计与审查记录）。不要引用已删除的旧报告/基准/应用清单。
