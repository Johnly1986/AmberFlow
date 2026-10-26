# CLAUDE.md — AmberFlow 工程指南

## 仓库是什么

冻结计划的浏览器自动化中间件（TypeScript，Node ≥ 22.6）。计划由人给出，执行器逐步选元素、动作、检查可验证信号；模型只做选择/风险/完成票，不生成动作。仓库不包含单元测试、离线夹具、复刻站、生成器数据或真实站点冻结证据；验证由 `online/` 真实站点套件承担。

## 命令

```bash
npm ci
npx playwright install chromium
npm run doctor                         # 环境 / 配置 / 决策源体检
npm run check                          # typecheck + online --validate（PR 门禁）
npm run online -- --tier smoke         # 真实站点快速可达性
npm run online -- --tier core          # 短流程
npm run online -- --tier deep          # 长流程
npm run online -- --tier probe         # 风控/可达性探针，非门禁
npm run online -- --case <id> --headed
npm start -- --goal "..." --url ...    # 一次性目标：演示 → 计划 → 执行
npm run apps -- --app <id>             # 用户作用域应用
npm run learn                          # 演示一次，录成应用
npm run plan:flow -- --goal ... --seed <url> --app <id>
npm run semantic -- --app <id> --site <site>
npm run plan-cli -- ...
npm run model:fetch -- --from <url|路径>
npm run picker-server
```

没有 `npm test` / `npm run verify` / `bench/smoke.sh`；不要引用已删除的 `tests/`、`bench/`、`testpages/`、`apps/` 内置包、`transfer/`、`ctrip/`、`qunar/`、`semantic/`、`sites/` 或 `tools/` 旧工具。

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
- 不绕过反爬、不代过验证码、不保存账号密码；探针只记录环境事实。

## 架构

- `src/engine/executor.ts`：唯一执行循环 `BrowserMiddleware.run`。不要为应用层/线上套件另写执行器。
- `src/engine/signals.ts`：完成信号语言；`checkSignal` 同时回答“完成”和“when 是否适用”。
- `src/engine/plan.ts` / `planner.ts`：TaskPlan、PlanningRules、`runPlan`、`runSubgoalWithRetries`。
- `src/app/`：应用包运行时（数据腿 + 浏览器/工具/SSH/stdio 步 + 结束态不变量 + 人工步 + pace）。
- `src/flow/`：语义流、计划流、信号归纳。
- `src/model/`：决策提供者、SystemOne/OpenAI Decisions、缓存、学习、ONNX。
- `src/cli/`：amber 命令与 `online` 入口。
- `src/online/`：线上用例加载、校验、运行、独立 oracle、证据。
- `src/data/datasource.ts`：通用数据腿；站点知识放配置，不写进引擎。

## 决策模型配置

线上只用三件套：`AMBERFLOW_DECISION_BASE_URL` / `_MODEL` / `_API_KEY`。有地址即线上；无地址用本地 `laya-onnx`，`AMBERFLOW_DECISION_MODEL=english|multilingual` 选 checkpoint。`AMBERFLOW_DECISION_PROTOCOL` 可选覆盖协议；`--provider` 仅本次实验/消融，不写进配置。详细说明 `docs/DECISION_SERVICE_CONFIG.md`。

## 硬规则

- 完成只认信号；模型 done 票只是 advisory。
- 值只来自计划/观察；缺值返回 `needs_value`，不猜。
- 动作失败/不可达/配置错误变成结构化结果与 trace，不抛裸栈给用户。
- 危险工具步必须干跑 + 人类确认；默认拒绝。
- 人工步不自动过；非 TTY 不假装有人。
- 凭据只从环境/本机配置按名读；用例里只允许 env 占位符。
- 运行产物、截图、DOM、真实站点记录不进仓库；`.gitignore` 已覆盖 `online-runs/`。
- 新增站点/用例优先写成数据；共享层不认识具体站点。

## 文档

`README.md`、`ARCHITECTURE.md`、`docs/APP_SCRIPT_AUTHORING.md`、`docs/MANUAL_STEPS_AND_PACE.md`、`docs/DECISION_SERVICE_CONFIG.md`。不要引用已删除的旧报告/基准/应用清单。
