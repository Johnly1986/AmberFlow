# AmberFlow

冻结计划的浏览器自动化中间件：流程由人给出，执行器逐步选择元素并动作，**完成只认页面上的可验证信号**。模型只回答“这一步点哪里 / 这算不算风险 / 是否完成”，不生成动作。

仓库不再携带离线演示、复刻站、冻结语料或提交进版本控制的线上运行结果。验证方式是**真实站点测试套件**（`online/`）；它可离线校验，联网运行时把证据写到仓库外。

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
# 一次性目标：打开真实页面，做一次演示 → 归纳完成信号 → 点名目标 → 执行
npm start -- --goal "把商品加入购物车" --url https://shop.example.com/p/1

# 已有应用（用户作用域 $AMBERFLOW_HOME/apps）
npm run apps -- --app <id>

# 真实站点测试
npm run online -- --tier smoke
```

`npm start` 必须给 `--goal` 和 `--url`；不再有仓库自带页面的开箱 demo。`npm run online` 默认跑 smoke + core，probe 需显式选择。

## 线上测试套件

```
online/
  sites/*.json          # 站点档案：hosts / home / locale / device / 风控与登录标记
  cases/smoke/*.json    # 单页可达 + 关键地标
  cases/core/*.json     # 2–6 步短流程
  cases/deep/*.json     # 有状态长流程
  cases/probe/*.json    # 风控/可达性探针，非门禁
```

```bash
npm run online:validate                  # 离线校验全部 site/case（PR 门禁）
npm run online -- --tier smoke           # 快速可达性
npm run online -- --tier core            # 短流程
npm run online -- --tier deep            # 长流程
npm run online -- --tier probe           # 探针，非门禁
npm run online -- --case books-next-page --headed
npm run online -- --list
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

只要 `AMBERFLOW_DECISION_BASE_URL` 在，就走线上服务；没有地址才使用本地模型。不再需要 provider 配置键。本地模式用 `AMBERFLOW_DECISION_MODEL=english|multilingual` 选 checkpoint，权重位置用 `LAYA_ONNX_MODEL` / `LAYA_TOKENIZER_DIR`。

```bash
amber config show
amber doctor
```

`--provider NAME` 只用于本次实验/消融/兼容旧适配器，不写进配置。完整说明见 [docs/DECISION_SERVICE_CONFIG.md](docs/DECISION_SERVICE_CONFIG.md)。

## 应用与录制

应用是**用户本地的流程配置**，不是仓库分享品。仓库不再内置演示包或复刻站。

```bash
# 演示一次，录成应用（默认写 $AMBERFLOW_HOME/apps）
npm run learn

# 外层 Agent 的一次调用
npm run agent -- --goal "..." --url https://...

# 查看 / 校验
npm run apps -- --list
amber apps check <id>
```

应用可以声明数据腿、浏览器步、工具步、结束态不变量、人工步骤与运行节奏。作者指南见 [docs/APP_SCRIPT_AUTHORING.md](docs/APP_SCRIPT_AUTHORING.md)；人工步骤与 `pace` 见 [docs/MANUAL_STEPS_AND_PACE.md](docs/MANUAL_STEPS_AND_PACE.md)。

## 命令一览

| 命令 | 用途 |
|---|---|
| `npm start -- --goal ... --url ...` | 一次性目标：演示 → 计划 → 执行 |
| `npm run apps -- --app <id>` | 运行用户应用 |
| `npm run online -- --tier …` | 真实站点测试套件 |
| `npm run check` | `typecheck` + 线上用例离线校验 |
| `npm run doctor` | 环境、配置、决策源体检 |
| `npm run learn` | 演示一次，生成应用 |
| `npm run plan:flow` | 一句话 + 种子页 → 语义模板 + 站点档案 |
| `npm run semantic -- --app <id> --site <site>` | 运行语义模板 |
| `npm run plan-cli -- …` | 计划 CRUD 与执行 |
| `npm run model:fetch -- --from <url|路径>` | 安装本地决策模型产物 |
| `npm run picker-server` | MV3 扩展的本地模型服务 |

完整帮助：`npx amber --help`、`npx amber <command> --help`。

## 硬约束

- **完成信号是唯一真相**：模型说“完成了”只是 advisory；DOM/URL 信号成立才算完成。
- **不做离线夹具验证**：线上测试只跑真实 `http(s)`；不提交真实站点结果、截图或 golden 语料。
- **不绕过反爬**：遇到 challenge/登录墙按 `blocked`/`login_required` 记录并跳过；不伪造指纹、不轮换代理、不代过验证码。
- **凭据只从环境/本机配置按名读**：用例中只允许 `{{env:NAME}}`，运行产物掩码；不写进计划、包、报告或提交。
- **模型只选定/风险/完成票**：动作来自计划或用户演示，模型不生成自由文本动作。
- **人工步骤不自动过**：需要人确认/登录/2FA 的步骤由人完成，引擎只验证最终信号。

## 目录

```
src/
  engine/       执行器、计划、信号、提取、规则、审计
  model/        决策提供者、缓存、学习、ONNX 运行时
  app/          应用包运行时、适配器、轨迹、数据集
  flow/         语义流、计划流、信号归纳
  cli/          amber 命令入口
  browser/      chromium 与工具信号
  data/         通用数据腿（站点知识在配置里）
online/         真实站点测试套件（本仓库唯一的测试声明）
docs/           当前有效的设计/接入文档
```

## 文档

- [架构](ARCHITECTURE.md)
- [应用脚本作者指南](docs/APP_SCRIPT_AUTHORING.md)
- [人工步骤与运行节奏](docs/MANUAL_STEPS_AND_PACE.md)
- [统一决策服务配置](docs/DECISION_SERVICE_CONFIG.md)
- [工程约束与 Agent 指南](CLAUDE.md)

## 开发

```bash
npm run check                    # 类型检查 + 线上用例离线校验
npm run online -- --tier smoke   # 真实站点（需要网络）
```

仓库不包含单元测试、离线测试夹具或基准语料；合并请求的自动门禁只做类型检查与用例声明校验。真实站点的回归由手动/定时线上任务承担。
