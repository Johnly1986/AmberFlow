# AmberFlow

**决策任务流引擎**，就是把一次"决策"拆成一串可编排的任务节点（取数 → 校验 → 打分 → 判规则 → 执行），由引擎按预设流程自动调度执行、并返回带依据的结果的运行时系统。

应用只有一种格式：`$AMBERFLOW_HOME/apps/<id>/app.mjs` 里的 `export const meta` + `export async function flow(ctx)`。流程默认由**决策语句**组成：一次 `ctx.step(goal, { done })` 只写目标与完成证据，点哪里交给引擎；控制流（分支、循环、重试、子流程）只在真实需要时写 JavaScript。引擎负责“一步之内”的元素池、目标解析、闸门、动作、完成信号与证据。

仓库不携带离线演示、复刻站、冻结语料或提交进版本控制的线上运行结果；也不内置演示应用。验证方式是**真实站点测试套件**（`online/`）：它可离线校验，联网运行时把证据写到仓库外。

## 安装

需要 Node ≥ 22.6。

```bash
npm ci
npx playwright install chromium
npm run doctor
```

`npm run doctor` 会点名 Node、chromium、决策模型产物与配置来源；缺什么给什么命令。

## 快速开始

```bash
# 1) 生成一个可跑的 flow 骨架（默认落到 $AMBERFLOW_HOME/apps/<id>/app.mjs）
npx amber apps new my-app --goal "把商品加入购物车" --url https://shop.example.com/p/1

# 2) 只读观察真实页面，拿元素与候选 hint
npx amber inspect --url https://shop.example.com/p/1 --json

# 3) 编辑 app.mjs，然后离线校验调用序列（不开浏览器、不调模型）
npx amber apps check my-app
npx amber apps explain my-app

# 4) dry-run → 用执行预算试跑 → 完整运行
npx amber run my-app --dry-run
npx amber run my-app --max-steps 3 --trace
npx amber run my-app --trace

# 等价入口：npm run apps -- --app my-app
```

`--max-steps N` 是 `ctx.step` / `ctx.arrive` 的**执行预算**，不是“从第 N 步开始”。脚本按自己的控制流执行，预算用满时以 `partial` 停下（status=`partial`、exit 0、`verified=false`），已执行的步骤与 trace 保留。

一次性目标仍然可用（演示 → 计划 → 执行，不落成应用）：

```bash
npm start -- --goal "把商品加入购物车" --url https://shop.example.com/p/1
```

## 应用模型

- **位置**：`$AMBERFLOW_HOME/apps/<id>/app.mjs`（默认 `~/.amberflow/apps`）。用户作用域，跟着用户走，不写进 checkout。
- **形状**：`export const meta = (kit) => ({ id, label, goal, hosts, slots, invariants, ... })` 只声明应用级事实；`export async function flow(ctx) { ... }` 是唯一流程。没有静态步骤表，也没有第二种应用格式。
- **不是仓库分享品**：仓库 `apps/`（若存在）只是开发夹具，不是内置应用；没有开箱 demo。应用正文请以用户目录里的 `app.mjs` 为准。
- **调试靠调用序列**：`apps show --code` 看当前源码与版本锚点，`apps explain` 看 dry 调用序列，`ctx.step` 的 `id` 与 `--trace` 提供稳定锚点。

```bash
npx amber apps list                          # 列出可运行应用（用户 + 仓库夹具）
npx amber apps show my-app --code            # 路径、meta、当前源码、版本 sha
npx amber apps explain my-app                # dry 跑一遍 flow，展示调用序列
npx amber apps check my-app                  # 加载 + dry 调用序列校验（exit 2 = 有问题）
npx amber apps path my-app                   # 唯一可写位置
npx amber apps remove my-app --yes --force   # 删除（非 TTY 必须 --yes）
```

完整作者接口见 [docs/APP_SCRIPT_AUTHORING.md](docs/APP_SCRIPT_AUTHORING.md)；Agent / DSH 桥的稳定契约见 [docs/AGENT_INTERFACE.md](docs/AGENT_INTERFACE.md)。

### 录制一个应用

```bash
# 演示一次，归纳完成信号，生成 flow 脚本；零模型调用回放不过就不落盘
npx amber record https://shop.example.com --name my-app --goal "把商品加入购物车"

# 用录好的动作回放（CI / Agent）
npx amber record https://shop.example.com --script ./demo-actions.json --yes --json

npm run learn       # 同一入口的 npm 脚本（不传参数时现场演示）
```

`--apps-dir <目录>` 是应用落点；默认 `$AMBERFLOW_HOME/apps`，不要写进 checkout。

## 命令一览

| 命令 | 用途 |
|---|---|
| `npx amber run <id\|app.mjs>` | 运行 flow 应用；`--dry-run` / `--trace` / `--max-steps N` / `--slot k=v` / `--today YYYY-MM-DD` / `--allow-dangerous` / `--manual-fail-fast` |
| `npx amber run --plan [文件]` | 运行计划文件（`--reset` / `--replan` / `--confirm allow\|ask\|deny`） |
| `npx amber run --goal "..." --url ...` | 一次性目标：演示 → 计划 → 执行（`--save-plan`） |
| `npx amber record [页面]` | 演示一次，生成 flow 应用（`--name` / `--goal` / `--apps-dir` / `--script`） |
| `npx amber apps list` | 列出应用 |
| `npx amber apps show <id\|脚本>` | 查看 meta、路径、版本 sha；`--code` 返回完整源码 |
| `npx amber apps new <id>` | 生成可跑的 flow 骨架（`--goal` / `--host` / `--url` / `--dir` / `--print` / `--force`） |
| `npx amber apps check [<id\|脚本>]` | 加载 + dry 调用序列校验 |
| `npx amber apps explain <id\|脚本>` | dry 调用序列与人话视图 |
| `npx amber apps path <id>` | 打印应用脚本路径 |
| `npx amber apps remove <id>` | 删除应用（`--yes` / `--force`） |
| `npx amber inspect --url <URL>` | 只读观察页面元素与候选 hint（不点击、不输入、不调模型） |
| `npx amber plan new/show/add/edit/rm/move/check/reset/run` | 计划文件的创建、编辑、校验与执行 |
| `npx amber doctor` | 环境、配置、决策源体检（`--fix` 只做安全可逆修复） |
| `npx amber config show/get/set/unset/init/path/edit` | 全局 / 项目配置 |
| `npx amber model status/fetch/path` | 本地决策模型状态与安装 |
| `npx amber test --validate\|--list\|--tier ...` | 真实站点测试套件 |
| `npm start -- --goal ... --url ...` | 一次性目标（npm 入口） |
| `npm run apps -- --app <id>` | 运行用户作用域应用（与 `amber run <id>` 同一运行器） |
| `npm run check` | `typecheck` + 配置示例一致性 + 线上用例离线校验（PR 门禁） |
| `npm run test -- --tier ...` | 真实站点测试套件（联网） |
| `npm run learn` | 演示一次，生成 flow 应用 |
| `npm run agent -- --goal ... --url ...` | 外层 Agent 的一次录制调用（`learn --json --yes`） |
| `npm run plan-cli -- ...` | 计划 CRUD / 执行入口 |
| `npm run model:fetch -- --from <url\|路径>` | 安装本地决策模型产物 |
| `npm run config:example` | 从配置 schema 重新生成示例 |
| `npm run picker-server` | MV3 扩展的本地模型服务 |

完整帮助：`npx amber --help`、`npx amber <command> --help`。命令表的唯一出处是 `src/cli/registry.ts`。

## 线上测试套件

`online/` 是仓库唯一的测试声明层（**不是**应用流程格式，也不是应用的第二作者面）：

```
online/
  sites/*.json          # 站点档案：hosts / home / locale / device / 风控与登录标记
  cases/smoke/*.json    # 单页可达 + 关键地标
  cases/core/*.json     # 2–6 步短流程
  cases/deep/*.json     # 有状态长流程
  cases/probe/*.json    # 风控/可达性探针，非门禁
```

```bash
npm run test:validate                  # 离线校验全部 site/case（PR 门禁）
npm run test -- --tier smoke           # 快速可达性
npm run test -- --tier core            # 短流程
npm run test -- --tier deep            # 长流程
npm run test -- --tier probe           # 探针，非门禁
npm run test -- --case books-category --headful
npm run test -- --list
```

**用例格式**：`id` / `site` / `tier` / `goal` / `subgoals[]` / `invariants[]` / 可选 `oracle`、`expect`。子目标复用执行器计划语法：`desc`、`start_url`、`target_hint`、`target_hints`、`signal`、`slots`、`when`、`retries`。Case 只能引用真实 `http(s)` URL；`file://`、旧夹具路径、明文凭据会在加载期被拒绝。日期用 `{{today}}` / `{{today+7d}}` / `{{next_monday}}`，凭据用 `{{env:NAME|default}}`。

**证据**：每次运行写 `$AMBERFLOW_HOME/online-runs/<run-id>/` 或 `--out` 指定目录，包含 `summary.json`、`report.md`、逐 case JSON，失败时附截图与 DOM。**运行结果不提交**；它是本次观察，不是下一次运行的 golden 文件。

**退出码**：`0` 全部应跑用例通过；`1` 有真实失败；`2` 用法/配置/校验错误；`3` 有 `blocked` / `unreachable` / `login_required` / 未执行（跳过不等于通过）。`--require-all` 把 `3` 视为失败。

站点不可达、风控挑战、需要登录都按事实分类；不绕过反爬、不代过验证码、不保存账号密码。探针用例只记录环境观测。

## 决策模型配置

线上服务使用**地址、密钥、模型**三件套：

```bash
amber config set AMBERFLOW_DECISION_BASE_URL https://<服务地址>/compatible-mode/v1
amber config set AMBERFLOW_DECISION_MODEL decision-model-preview
amber config set AMBERFLOW_DECISION_API_KEY sk-…
```

只要 `AMBERFLOW_DECISION_BASE_URL` 在，就走线上服务；没有地址才使用本地模型。本地模式用 `AMBERFLOW_DECISION_MODEL=english|multilingual` 选 checkpoint，权重位置用 `LAYA_ONNX_MODEL` / `LAYA_TOKENIZER_DIR`。

```bash
amber config show
amber doctor
```

`--provider NAME` 只用于本次实验/消融，不写进配置。配置键与默认值的唯一出处是 `src/support/config-schema.ts`；`configs/amberflowrc.example.json` 由 `npm run config:example` 生成。完整说明见 [docs/DECISION_SERVICE_CONFIG.md](docs/DECISION_SERVICE_CONFIG.md)。

## 硬约束

- **完成信号是唯一真相**：模型说“完成了”只是 advisory；DOM/URL 信号成立才算完成。
- **值只来自计划或观察**：模型不能发明槽位值；缺值返回结构化 `needs_value`，不猜。
- **不做离线夹具验证**：线上测试只跑真实 `http(s)`；不提交真实站点结果、截图或 golden 语料。
- **不绕过反爬**：遇到 challenge/登录墙按 `blocked` / `login_required` 记录并跳过；不伪造指纹、不轮换代理、不代过验证码。
- **凭据只从环境/本机配置按名读**：用例中只允许 `{{env:NAME}}`，运行产物掩码；不写进计划、应用或报告，也不提交。
- **模型只选定/风险/完成票**：动作来自脚本的 `ctx.step` / `ctx.run`，模型不生成自由文本动作。
- **人工步骤不自动过**：需要人确认/登录/2FA 的环节必须由人完成，引擎不假装有人在，也不会替人确认。
- **危险工具步默认拒绝**：必须有 `dryRunArgs`，干跑 → 人类确认 → 执行；`--allow-dangerous` 才放行，失败/拒绝都是结构化结果。

## 目录

```
src/
  engine/       执行器、计划、信号、提取、规则、审计
  model/        决策提供者、缓存、学习、ONNX 运行时
  app/          flow 应用：加载器、meta 投影、运行期 ctx、轨迹、适配器、运行器
  flow/         信号归纳与共享基础
  cli/          amber 命令入口
  browser/      chromium 与工具信号
  data/         通用数据腿（站点知识在配置里）
integrations/
  dsh-bridge/   DSH 桥：只拼 CLI、解析 JSON、投影有界摘要
online/         真实站点测试套件（本仓库唯一的测试声明）
docs/           当前有效的设计/接入文档
```

## 文档

- [架构](ARCHITECTURE.md)
- [Agent 接口（脚本化应用）](docs/AGENT_INTERFACE.md)
- [应用脚本作者指南](docs/APP_SCRIPT_AUTHORING.md)
- [人工步骤与运行节奏](docs/MANUAL_STEPS_AND_PACE.md)
- [统一决策服务配置](docs/DECISION_SERVICE_CONFIG.md)
- [工程约束与 Agent 指南](CLAUDE.md)

## 开发

```bash
npm run check                    # 类型检查 + 配置示例一致性 + 线上用例离线校验
npm run test -- --tier smoke   # 真实站点（需要网络）
```

仓库不包含单元测试、离线测试夹具或基准语料；合并请求的自动门禁只做类型检查与用例声明校验。真实站点的回归由手动/定时线上任务承担。
