# AmberFlow 命令行重设计

> 状态：设计方案（本文只描述目标形态与迁移路径，不改运行行为）
> 范围：面向使用者的 CLI；引擎、执行器、应用包格式不动
> 一句话：把「按源码模块组织的 46 个 npm script」收敛成「按用户任务组织的 1 个 `amber` 命令」。

---

## 0. 结论先行

目标形态：

```text
amber                         # 首页：状态 + 应用列表 + 下一步
amber run [应用]              # 运行（应用 / 计划 / 一次性目标）
amber record [页面]           # 演示一次 → 生成应用
amber plan ...                # 手工计划：new/show/add/edit/rm/move/check/run
amber apps ...                # 应用：list/show/check/path/remove
amber doctor                  # 环境、配置、决策源体检
amber config ...              # 配置：path/show/get/set/unset/init
amber model ...               # 本地模型：status/fetch/path
amber dev ...                 # 维护者命令：suite/matrix/bench/verify/parity/measure/...
```

五条硬规则：

1. **一个入口**：用户只需要记住 `amber`；`npm start` 只保留为兼容别名。
2. **动词优先**：`run / record / plan / apps / doctor / config / model` 对应七类用户任务，而不是七个源码文件。
3. **默认帮助只展示 8 个命令**：实验性、测量型、一次性工具全部收进 `amber dev`。
4. **同一动作、同一语义**：`run` 在所有用户入口都走同一套决策源解析、输出和退出码；测量臂（`dev suite`）必须显式标注自己的臂，不混进日常面。
5. **旧命令不立刻删**：旧 npm script 保留一个版本，打印迁移提示后转发到新命令。

`amber` 由 `package.json` 的 `bin` 提供：在 checkout 内用 `npx amber ...`，执行过 `npm link` 或全局安装后可直接用 `amber ...`。本文示例默认已经 link；没有 link 时把 `amber` 换成 `npx amber` 即可。

---

## 1. 现状审计

### 1.1 规模数字

| 项目 | 数量 | 说明 |
|---|---:|---|
| `package.json` scripts | 46 | 用户需要从 46 个名字里找到自己要的那个 |
| CLI 入口文件 | 15+ | `start`、`app-runner`、`plan-cli`、`plan-flow`、`semantic-flow`、`learn`、`bench`、`apps_suite`、`apps_matrix`、`spec-to-pack`、`model-fetch`、`provider-baselines`、`ip-config`、`camera-entry`、`picker-server` … |
| 旗标名 | 约 59 | 扫描 15 个入口文件得到（含少量内部参数） |
| 应用包 | 20 | `apps/*/app.mjs`（声明式数据脚本；旧 `pack.json` 仍可读），其中 3 个是测量型 |
| 「跑一条流程」的入口 | 6 | `start` / `apps` / `plan-cli run` / `semantic` / `bench` / `apps:suite` |
| 「创建一条流程」的入口 | 5+ | `start --goal` / `learn` / `plan:flow` / `plan-cli new` / `apps:gen` / 手写 `app.mjs` |

### 1.2 用户旅程中的摩擦

**第一次使用者**

```bash
npm ci && npx playwright install chromium
npm start
```

这一步体验很好；但接下来要换自己的页面，文档给出的是：

```bash
npm start -- --goal "把商品加入购物车" --url <页面>
npm run apps -- --app <id> --headful
npm run learn -- --url <页面>
npm run plan:flow -- --goal "..." --seed <页面> --app <id>
npm run plan-cli -- add 1 "..." --signal 'css_text_equals=#id|文本'
```

五个入口，五种「先做什么」的心智模型。新用户无法判断：
「我要录一条流程，还是生成一份计划，还是直接跑一个应用？」

**流程作者**

`plan-cli` 用数字下标编辑：

```bash
npm run plan-cli -- add 1 "打开购物车" --signal 'url_contains=cart.html'
npm run plan-cli -- del 1
```

删掉第 1 步后，原来的第 2 步变成第 1 步；脚本里写死的下标全部失效。没有稳定 ID，也没有 `--at` 之类的显式位置参数。

**CI / 维护者**

```bash
npm run apps:suite -- --real-model   # README 里这么写
```

但 `apps_suite.ts` 的 `parseArgs` 根本没有 `--real-model`，而且代码默认臂已经是 `arm: "real"`；帮助文本却还写着「默认臂是脚本桩，`--real-model` 换真模型」。**文档、帮助、代码三份口径不一致。**

**Windows 用户**

`apps_suite.ts` 的默认产物目录是字面量 `/tmp/amberflow-suite`，在 Windows 上会落到当前盘符根目录的 `\tmp\...`；而 `app-runner` 用的是 `os.tmpdir()`。同一类产物，两个默认落点。

### 1.3 问题清单

#### P0：直接影响「能不能用起来」

| # | 问题 | 证据 / 影响 |
|---|---|---|
| P0-1 | 入口按实现分，不按任务分 | 46 个 script；用户要先知道 `apps` 和 `apps:suite`、`plan-cli` 和 `plan:flow` 的区别 |
| P0-2 | `npm run X -- --flag` 的 `--` 摩擦 | 所有文档示例都带 `--`；复制到 PowerShell / CI 容易丢参数 |
| P0-3 | 同一动作默认值不同 | `apps` 默认真模型；`suite` 曾经默认桩；`learn` 默认 headless（录制却看不见） |
| P0-4 | 帮助是碎片化的 | 每个入口自己维护 `USAGE`；`bench`、`apps:matrix`、`provider-baselines` 连 `--help` 都没有；没有全局命令索引 |
| P0-5 | 文档承诺与代码行为不符 | `learn` 的 usage 写「不做任何参数也能用」，`connectPage` 却在没有 `--url` / `--cdp` 时直接抛错 |
| P0-6 | 没有统一输出契约 | 有的命令有 `--json`，有的没有；日志写 stdout，管道里混入人类文案；退出码分散在各文件 |

#### P1：用久了会反复踩

| # | 问题 | 证据 / 影响 |
|---|---|---|
| P1-1 | 旗标命名不一致 | `--dry` vs `--dry-run`；`--no-sources`；`--force-hints off` 只有一个合法值；`--learn-hints` vs `--hint-memory`；`--model` vs `--provider` |
| P1-2 | 位置参数不稳定 | `plan-cli add/edit/del/move` 全部用数字下标；删一步后全部错位 |
| P1-3 | 实验旗标混入日常面 | `--ablate`、`--tiered-hint`、`--conf-floor`、`--nominate-provider`、`--drift-limit`、`--no-verify-backfill` 和 `--headful` 出现在同一层帮助里 |
| P1-4 | 配置只认仓库目录 | `configs/amberflowrc.json` 是 checkout 内的机器配置；用户级安装没有自己的配置位置，密钥留在 checkout 目录里 |
| P1-5 | 默认落点不一致 | `apps` 用 `os.tmpdir()`；`suite` 用 `/tmp`；`learn` 用 `mkdtemp`；`plan-cli` 用仓库根 `.task_plan.json` |
| P1-6 | 非交互行为不统一 | `apps` 无参数「列应用 + exit 2」；`plan-cli` 无参数「usage + exit 1」；`learn` 交互；`start` 直接跑 demo |

#### P2：命名与可发现性

| # | 问题 | 证据 / 影响 |
|---|---|---|
| P2-1 | script 命名混用 `:` 和 `-` | `plan-cli`、`plan:flow`、`apps:gen`、`apps:suite`、`model:fetch`、`cache:measure` |
| P2-2 | 资源名和动作名混在一起 | `apps` 既是「列出」又是「运行」；`semantic` 是引擎名不是任务名 |
| P2-3 | 术语泄漏 | 用户看到 `pack`、`journey`、`subgoal`、`invariant`、`slot`、`provider`、`ablate`，但文档没有一张统一的人话对照表 |
| P2-4 | 没有补全 / 拼写建议 | 打错命令只得到一段 usage；不支持 bash/zsh/fish/PowerShell completion |
| P2-5 | 版本与契约不可见 | 没有 `--version`；没有 JSON schema 版本；脚本无法稳定消费输出 |

### 1.4 应该保留的优点

重设计不是推倒重来。以下行为必须保留：

- `npm start` 零配置跑通内置示例；
- `doctor` 的「缺什么 + 一条补齐命令」体例；
- 退出码能区分「没跑完」「用法错」「危险步未放行」「质量门禁」；
- 「跳过不等于通过」「模型没出场就说没出场」的诚实口径；
- 中文人类输出 + 英文机器键的既有习惯；
- 所有危险动作默认拒绝，必须显式放行。

---

## 2. 设计目标与原则

### 2.1 目标

| 目标 | 可验收的标准 |
|---|---|
| 第一次成功更快 | 全新 checkout 到第一条绿色结果 ≤ 2 条命令，且不需要任何旗标 |
| 心智模型更小 | 默认帮助 ≤ 8 个命令；用户命令最多两级子命令，`dev` 下允许 `providers baseline` 这类工具分组 |
| 同名同义 | `run` 在所有入口使用同一套决策源、输出和退出码 |
| 可脚本化 | 所有用户命令支持 `--json`；stdout 只输出结果，进度写 stderr |
| 可发现 | 每个命令有 3 个可复制示例；命令/旗标打错有「你是不是想…」 |
| 可迁移 | 旧 npm script 至少保留一个版本，并打印新写法 |
| 跨平台 | 默认路径来自 `os.tmpdir()` / `AMBERFLOW_HOME`，不出现字面量 `/tmp` |

### 2.2 原则

1. **任务优先，模块靠后**：用户想的是「跑、录、改、查、体检」，不是 `app-runner` / `plan-flow`。
2. **一个动词只表示一件事**：`run` 就是执行；`record` 就是录制；`plan` 就是计划编辑；`dev` 才是实验。
3. **渐进披露**：默认帮助只显示日常命令；`amber help --all` 或 `amber dev` 才显示实验旗标。
4. **默认安全**：`--help`、`doctor`、`apps check` 零副作用；`--dry-run` 不执行步骤（`run --goal` 仍需打开页面生成计划并写 `--save-plan`）；危险动作必须 `--allow-dangerous`；非 TTY 永不等待输入。
5. **机器可读是契约**：`--json` 输出带 `schema_version` 的单一对象；人类文案不进入 stdout。
6. **兼容层而不是大爆炸**：旧命令转发到新命令，旧旗标在解析前归一化，一个版本后再删除。
7. **单一出处**：命令表、帮助、补全、退出码、旗标定义都来自一个 registry，不再每个文件手写一份 `USAGE`。

### 2.3 考虑过但放弃的方案

| 方案 | 为什么不选 |
|---|---|
| 保留 npm scripts，只改命名 | `--` 摩擦、无全局帮助、无统一输出，根问题没解决 |
| 名词优先：`amber app run` | 最常用的动作多一层；新用户先想到「跑」而不是「应用」 |
| 只做一个巨大的 `amber` 交互式 TUI | 不可脚本化、CI 不可用；DSH 插件已经承担 GUI 角色 |
| 直接删旧脚本 | 会打断现有 CI、文档、DSH 桥和用户肌肉记忆；迁移成本不可控 |
| 把所有实验命令也放进默认帮助 | 默认帮助会重新膨胀成 46 项，违背目标 |

---

## 3. 目标命令面

### 3.1 命令树

```text
amber
├── run       [应用 | --plan [文件] | --goal 目标 --url 页面 | --demo]
├── record    [页面 | --cdp ws://…]
├── plan
│   ├── new / show / add / edit / rm / move / check / reset / run
├── apps
│   ├── list / show / check / path / remove
├── doctor
├── config
│   ├── path / show / get / set / unset / init / edit
├── model
│   ├── status / fetch / path
├── help      [命令] / --all
├── completion <bash|zsh|fish|powershell>
└── dev
    ├── suite / matrix / verify
    ├── bench / parity / measure / providers
    ├── shortlist / generate / induce / plan-flow
    ├── semantic / serve / legacy
```

### 3.2 首页 + 七个用户命令

| 命令 | 回答的问题 | 典型用法 |
|---|---|---|
| `amber` | 我现在能做什么？ | `amber` |
| `amber run` | 跑一条已经存在的流程 | `amber run demo-app --headful` |
| `amber record` | 我手动做一遍，把它变成应用 | `amber record https://shop.example.com --name add-to-cart` |
| `amber plan` | 我要手写 / 修改一份计划 | `amber plan add "打开购物车" --signal url_contains=cart.html` |
| `amber apps` | 我有哪些应用？这个包对不对？ | `amber apps list` / `amber apps check demo-app` |
| `amber doctor` | 为什么跑不起来？ | `amber doctor` |
| `amber config` | 这台机器到底用了什么配置？ | `amber config show` |
| `amber model` | 本地决策模型装没装？怎么装？ | `amber model fetch --from /models/laya` |

`amber` 本身是首页；`run` 到 `model` 是七个用户命令。加上 `dev`，默认帮助正好 8 个条目；`help` / `completion` 是全局工具，不占日常命令表。

`amber dev` 不回答问题，只服务维护者；默认帮助里只留一行「维护者命令见 `amber dev --help`」。

### 3.3 明确不做

- 不引入 YAML 配置；继续用 JSON。
- 不在 CLI 里做完整 TUI；交互只用于「选一个应用」「确认一次危险动作」。
- 不改变应用包 schema、计划 schema、执行器语义。
- 不把 `provider` 的规范名改掉；只增加 `auto` / `local` / `rules` 三个友好别名。
- 不删除测量能力；只是把它们从日常面移到 `amber dev`。

---

## 4. 命令详设

### 4.1 `amber`（无参数）

行为：

1. 读配置、做轻量体检（不启动浏览器）；
2. 打印三行状态：Node / Chromium / 决策源；
3. 列出用户应用和内置应用（最多 10 个，标注来源）；
4. 给一条「下一步」命令。

示例：

```text
AmberFlow 1.0

  Node        22.14.0  ✓
  Chromium    1.58.0   ✓
  决策源      auto → token-plan（配置文件）

应用（1 个用户 / 20 个内置）
  add-to-cart   把商品加入购物车              ~/.amberflow/apps/add-to-cart
  demo-app      应用包示范：CLI + 浏览器      apps/demo-app
  ...

下一步：
  amber run demo-app                 先跑一个内置示例
  amber record https://your.site     录一条自己的流程
  amber doctor                       环境有问题时先体检
```

非 TTY 下不打印彩色、不等待输入，直接输出同样的文字并 exit 0。

### 4.2 `amber run`

这是最重要的命令，承担原来 `start`、`apps`、`plan-cli run` 三条路径。

```text
amber run [应用] [选项]
amber run --plan [文件] [选项]
amber run --goal "<目标>" --url <页面> [--save-plan <文件>] [选项]
amber run --demo [--save-plan <文件>] [选项]
```

模式解析（互斥，冲突即 exit 2）：

| 输入 | 行为 |
|---|---|
| `amber run <应用>` | 按 id 或路径加载应用数据文件（`app.mjs` / 旧 `pack.json`），跑完整旅程 |
| `amber run --plan [文件]` | 跑计划 JSON；新入口不给文件时用默认 `./.amberflow/plan.json`。旧 `plan-cli run` 由兼容层转发，仍用旧默认 `.task_plan.json`，不随新入口改变 |
| `amber run --goal ... --url ...` | 一次性：打开页面 → 演示一步 → 归纳信号 → 执行；生成的计划默认保存到 `./.amberflow/plan.json`，用 `--save-plan` 改。旧 `start --goal` 由兼容层转发，仍以 `.task_plan.json` 为保存位置（旧 `start --plan` 即该位置） |
| `amber run --demo` | 旧 `npm start` 的开箱计划（`testpages/`，2 步）；不是参考应用包 `demo-app` |
| `amber run` + TTY | 列出应用并让用户选一个 |
| `amber run` + 非 TTY | 列出应用，提示 `amber run <id>`，exit 2，不替用户选 |
| 应用 + `--goal` 同时给 | 用法错误，说明二选一 |

`demo-app` 是 `apps/demo-app/app.mjs` 里的参考应用（数据腿 + 浏览器腿 + 验收条件）；`--demo` 是旧 `npm start` 的零配置开箱计划。两者都保留，但不要互相替代，也不要用同一个结果 JSON 做等价性断言。

`--plan` 只与 `--plan` 模式搭配；`--goal` / `--demo` 要保存计划用 `--save-plan`。`--demo` + `--plan`、`--goal` + `--plan` 都是用法错误（只有兼容层会把旧 `start --plan` 翻译成 `--save-plan`）。

常用旗标：

| 旗标 | 含义 |
|---|---|
| `--headful` / `--headless` | 显示 / 不显示浏览器窗口；`run` 默认 headless，`record` 默认 headful |
| `--dry-run` | 只展开、校验、打印计划，不执行步骤、不跑数据腿；`run --goal` 例外：为归纳信号仍需打开页面，并把生成的计划写到 `--save-plan` |
| `--plan [文件]` | **输入**的计划文件；省略值用默认 `./.amberflow/plan.json`（仅 `run --plan`） |
| `--save-plan <文件>` | **生成**计划的保存位置（`run --goal` / `run --demo`）；默认 `./.amberflow/plan.json`；旧 `start --plan` 由兼容层映射到这里 |
| `--out <目录>` | 结果 JSON / Markdown 的落点；默认 `os.tmpdir()/amberflow/runs/<run-id>` |
| `--slot k=v` | 覆盖包声明的参数；可重复；键未声明即 exit 2 |
| `--provider <名字>` | 决策源；默认 `auto` |
| `--skip-data` | 跳过数据腿（旧 `--no-sources`） |
| `--allow-dangerous` | 放行危险工具步；不带则结构化拒绝并 exit 3 |
| `--remember` | 开启学习环 sidecar（旧 `--learn-hints`） |
| `--memory <文件>` | 指定 sidecar 落点 |
| `--reset` / `--replan` / `--confirm allow\|ask\|deny` | 仅 `--plan` 模式：重置步骤状态 / 重新规划 / 人工确认策略 |
| `--json` / `--quiet` / `--verbose` | 输出契约，见 §5.3 |

示例：

```bash
amber run --demo
amber run demo-app
amber run demo-app --headful
amber run transfer-slowjet --dry-run
amber run --goal "把无线鼠标加入购物车" --url https://shop.example.com/p/1
amber run --goal "把无线鼠标加入购物车" --url https://shop.example.com/p/1 --save-plan ./plans/cart.json
amber run --plan ./.amberflow/plan.json --reset
```

`amber run demo-app` 的人类输出：

```text
✔ demo-app  5/5 步 · 2 条验收条件成立 · 4.2s
  决策：rule 5 · 模型 0 · 缓存 0/0
  产物：<os.tmpdir>/amberflow/runs/2026-10-23T09-12-01/demo-app-result.json
  下一步：amber run demo-app --headful
```

失败时：

```text
✘ transfer-slowjet  17/19 步
  卡在：第 3 步「记录最低价」
  原因：完成信号未成立（#log 未出现 "Recorded"）
  下一步：amber run transfer-slowjet --headful   看现场
          amber run transfer-slowjet --verbose    看逐步骤判定
```

### 4.3 `amber record`

承担旧 `learn`，并修掉「无参数也能用」的文档谎言。

```text
amber record [页面] [选项]
```

行为：

| 输入 | 行为 |
|---|---|
| `amber record <url>` | 打开可见浏览器，导航到该页，开始录制 |
| `amber record --cdp ws://…` | 连接用户已开的浏览器；退出只断开，不关闭 |
| `amber record` + TTY | 打开可见浏览器到 `about:blank`，让用户自己导航；按 Enter 开始录制 |
| `amber record` + 非 TTY | 用法错误，提示给 `--url`（配合 `--script`）或 `--cdp`；单独 `--script` 不够，因为回放仍需要一个页面 |

旗标：

| 旗标 | 含义 |
|---|---|
| `--name <id>` | 应用 id；默认从域名 + 目标生成 slug |
| `--id <id>` | 兼容旧名；等价 `--name` |
| `--goal "<一句话>"` | 目标；默认用页面标题 |
| `--out <目录>` | 录制 / 回放中间产物（截图、动作回放）的落点；默认 `os.tmpdir()/amberflow/record/<id>` |
| `--pack-dir <目录>` | 应用包落点；默认 `$AMBERFLOW_HOME/apps`（`~/.amberflow/apps`） |
| `--yes` | 不再逐条确认（CI / Agent） |
| `--json` | 输出结构化结果 |
| `--script <文件>` | 用录好的动作回放，不做现场演示（CI）；仍需 `--url` 或 `--cdp` |
| `--headless` | 无窗口录制；默认 `record` 是 headful |

兼容层：旧 `learn` / `agent` 默认 headless，转发到 `record` 时若用户未显式给 `--headful`，就注入 `--headless`；新 `record` 默认 headful。

示例：

```bash
amber record https://shop.example.com --name add-to-cart
amber record --cdp ws://127.0.0.1:9222 --goal "把商品加入购物车"
amber record https://shop.example.com --script ./demo-actions.json --yes --json
```

退出码：0 = 已验证并落盘；1 = 回放未通过（不落盘）；2 = 用法 / 页面错误；3 = 被策略或确认挡住。

成功输出：

```text
✔ 已录制 add-to-cart（2 步）
  零模型回放：通过
  包：~/.amberflow/apps/add-to-cart/app.mjs
  下一步：amber run add-to-cart
```

### 4.4 `amber plan`

承担旧 `plan-cli`，并修掉数字下标的脆弱性。

```text
amber plan new "<目标>" [--url <页面>] [--llm] [--max <N>] [--save-plan <文件>]
amber plan show [--plan <文件>]
amber plan add "<描述>" (--signal <op=value> | --signal-file <json>) [--url <页面>] [--target <hint>] [--at <编号|id>] [--plan <文件>]
amber plan edit <编号|id> [--desc ...] [--signal ... | --signal-file <json>] [--url ...] [--target ...] [--plan <文件>]
amber plan rm <编号|id> [--plan <文件>]
amber plan move <编号|id> --to <位置> [--plan <文件>]
amber plan check [--plan <文件>]
amber plan reset [--plan <文件>]
amber plan run [--plan <文件>] [--reset] [--replan] [--confirm allow|ask|deny]
```

关键变化：

1. **默认文件**从仓库根 `.task_plan.json` 改为 `./.amberflow/plan.json`；`--plan` 只指定**输入**计划，`--save-plan` 只指定**输出**计划（`plan new` 与 `run --goal/--demo` 用它）。
   这样用户在自己的工作目录跑，不会把计划写进引擎 checkout。
2. **稳定引用**：`add` 返回 `id`；有 `id` 的步骤优先按 id 解析，没有才用 1-based 编号。显示时同时给两者：
   ```text
   [1] id=open-cart  pending  打开购物车
   ```
   `id` 由描述 slug + 短哈希生成，冲突时加后缀；旧计划没有 `id` 也能继续用，第一次编辑时补上。
3. **插入位置显式化**：`--at 2` 或 `--at open-cart`，不再把「插到第几步」藏在第二个位置参数里；`move --to` 的目标是移动后的 1-based 位置。新 CLI 的编号统一 1-based，与显示 `[1]` 一致；旧 `plan-cli` 的 0-based 数字下标由兼容层转换，避免旧脚本错位。
4. **`plan run` 与 `run --plan` 是同一个执行器**，输出和退出码完全一致；保留 `plan run` 只是顺手的捷径。
5. **信号语法保持兼容**：`--signal css_text_equals=#id|文本` 继续可用；新增 `--signal-file <json>` 给复杂信号，避免 shell 转义地狱。`add` 必须二选一，`edit` 最多给一个；同时给 exit 2。`plan new --llm` 可用 `--max N` 限制生成步数（默认 8）。
6. **旧子命令别名**：`del` → `rm`，`--file` → `--plan`，`--hint` → `--target`；兼容层保留一个版本。

示例：

```bash
amber plan new "把商品加入购物车" --url https://shop.example.com/p/1
amber plan add "打开购物车" --signal url_contains=cart.html --target '#cart-link'
amber plan add "应用优惠券" --signal 'css_text_contains=[data-test=coupon-msg]|Coupon applied' --at 2
amber plan check
amber plan run --reset
```

### 4.5 `amber apps`

```text
amber apps list [--json]
amber apps show <应用> [--json]
amber apps check [<应用>] [--json]
amber apps path <应用>
amber apps remove <应用> [--yes] [--force]
```

职责：

- `list`：id、label、步骤数、类型（旅程 / 测量）、来源（用户 / 内置）、路径。
- `show`：目标、步骤摘要、参数、hosts、验收条件、`generated_from`；不执行任何东西。
- `check`：加载期校验 + `PlanningRules`，不开浏览器；不给应用时校验全部可发现应用；坏包 exit 2。
- `path`：只打印包路径，方便 `cd $(amber apps path foo)`（PowerShell：`Set-Location (amber apps path foo)`）。
- `remove`：只删用户作用域 `$AMBERFLOW_HOME/apps/<id>`；内置包拒绝删除，除非 `--force`。

示例：

```bash
amber apps list
amber apps show demo-app
amber apps check transfer-slowjet
cd "$(amber apps path demo-app)"
```

### 4.6 `amber doctor`

```text
amber doctor [--json] [--fix] [--verbose]
```

检查项：

- Node ≥ 22.6；
- Playwright / Chromium（完整版与 headless shell 分开报）；
- 本地决策模型三件套（图 / 权重 / tokenizer）；
- 决策源解析结果：`auto → local | provider | rules`，以及来源（flag / env / 项目配置 / 用户配置 / 默认）；
- 配置文件的层叠情况与密钥掩码；
- 应用目录可写、可发现的应用数；
- 可选：`OPENAI_BASE_URL` / `OPENAI_API_KEY`。

`--fix` 只执行安全、可逆的修复：创建配置目录、`npx playwright install chromium`；不会自动下载 1.7 GB 模型，也不会覆盖已有产物。

输出示例：

```text
AmberFlow doctor

  Node          22.14.0  ✓
  Chromium      1.58.0   ✓
  决策模型      off(missing)：缺权重 laya_dec.onnx.data
                → amber model fetch --from <url 或本地路径>
  决策源        auto → rules（本地产物不齐，且未配置在线 provider）
  配置文件      ~/.amberflow/config.json（2 项）· 环境变量（1 项）
  应用          21 个（1 个用户 / 20 个内置）

下一步：
  amber run demo-app                 规则模式也能跑
  amber model fetch --from <路径>    需要模型兜底时
```

退出码：0 = 核心项齐全；2 = 有阻塞项（Node / Chromium 缺失，或配置非法）。

### 4.7 `amber config`

```text
amber config path [--project]
amber config show [--json]
amber config get <KEY>
amber config set <KEY> <VALUE> [--project]
amber config unset <KEY> [--project]
amber config init [--project]
amber config edit [--project]
```

配置层叠（后者覆盖前者）：

```text
内建默认
  < 旧 rc      configs/amberflowrc.json（只读兼容）
  < 用户配置   ~/.amberflow/config.json
  < 项目配置   ./.amberflow/config.json
  < 环境变量
  < CLI 旗标
```

- `config path` 打印用户、项目、当前生效文件的路径；`--project` 只打印项目配置。
- `config set` 默认写用户配置；`--project` 写当前目录的项目配置。
- 显式 `--config <文件>` 优先于 `--project`：它直接替换层叠中的用户/项目两层，而不是再叠一层。
- 只接受白名单键；未知键立即 exit 2，并列出可用键。
- 密钥类键（`*_API_KEY`、`*_SECRET`、`*_PASSWORD`）写入时提示风险；`show` / `show --json` 只回显掩码长度。
- 旧 `configs/amberflowrc.json` 继续读取，但 `doctor` 会提示迁移到用户配置；迁移完成后不再写旧文件。

### 4.8 `amber model`

```text
amber model status [--json]
amber model fetch --from <url|路径> [--to <onnx>] [--sha256-onnx <hex>] [--sha256-data <hex>] [--tokenizer <路径|url>] [--sha256-tokenizer <hex>] [--force]
amber model path
```

`fetch` 完全复用现有 `model-fetch` 的四条纪律：先验后换、校验点名、不覆盖已有、不留半途态。CLI 只改入口与输出。

`--to` 是 ONNX **文件**路径（不是目录），默认沿用 `LAYA_ONNX_MODEL` 约定；tokenizer 仍装到该文件同目录的 `tokenizer/`。旧 `model:fetch --out FILE` 在兼容层映射到 `--to`；新命令不再用 `--out` 指定模型文件，以保持 `--out` 只表示输出目录的规则。

### 4.9 `amber dev`

维护者/实验命令的统一归宿。默认帮助只显示分组，不展开所有旗标。

```text
amber dev suite [--only id,id] [--json] [--provider NAME] [--ablate]
amber dev matrix [--json]
amber dev verify
amber dev bench [--cases 文件] [--out 目录] [--provider NAME] [--fixtures-only] ...
amber dev parity [rules|extraction|executor|datasource|ctrip|transfer|all]
amber dev measure <cache|hints|calibration|contribution|nominations|probes|metrics|gate>
amber dev providers <baseline|probe|nominate> [--apps ...] [--providers ...] [--out ...]
amber dev generate [--list|--check|--write ...]
amber dev shortlist
amber dev induce ...
amber dev plan-flow ...
amber dev semantic --app ID --site KEY ...
amber dev serve picker [--host HOST] [--port PORT]
amber dev legacy <ip-config|camera-entry|long-task|path-a|tune-guard>
```

约定：

- `dev verify` 就是现有 `npm run verify` 的同一套门禁：`typecheck` + 全量 `vitest run` + 六层 parity；成功 0，失败 1。它不是测量门禁，所以不用 4。
- `dev parity all` 顺序跑六层，承接旧 `test:parity`；`dev parity <layer>` 只跑一层。
- `dev suite` 的 `--ablate` 是布尔开关（旧 `apps:suite --ablate` 同义）；默认臂仍是真模型。
- `dev` 还承接 `bench:fixtures`、`shortlist`、`probe:tokenplan`、`nominate:online/context` 等旧脚本，具体映射见 §6.1。
- `dev` 命令可以不稳定，但**不能**静默改变日常命令的默认值。
- `dev` 的 `--json` 与用户命令使用同一个 envelope。
- `--real-model` 这类只存在于旧文档的旗标不再保留；统一用 `--provider laya-onnx`，`suite` 默认就是真模型。
- 退出码 4 只属于 `dev` 的测量门禁（例如套件「模型边际为 0」）。

---

## 5. 全局约定

### 5.1 旗标分层

**全局（所有命令）**

下列旗标对全部用户命令及其子命令统一接受；各命令详设只列专属旗标，不再逐条重复 `--json` / `--yes` 等全局项。只读命令上的 `--yes` 是无操作。

| 旗标 | 说明 |
|---|---|
| `-h, --help` | 显示帮助并 exit 0 |
| `-V, --version` | 显示版本 |
| `--json` | 机器可读输出；stdout 只有 JSON |
| `-q, --quiet` | 只输出最终结论 |
| `--verbose` | 输出逐步骤判定、配置来源、调试信息 |
| `--no-color` | 禁用颜色（也尊重 `NO_COLOR`） |
| `--yes` | 非交互确认；不隐含 `--allow-dangerous` |
| `--config <文件>` | 指定配置文件 |
| `--timeout <秒>` | 覆盖单步/整体超时（按命令定义） |

**命令专属（详见 §4）**

- `run`：`--headful` / `--headless`、`--dry-run`、`--plan`、`--save-plan`、`--out`、`--slot`、`--provider`、`--skip-data`、`--allow-dangerous`、`--remember`、`--memory`、`--reset`、`--replan`、`--confirm`。
- `record`：`--name` / `--id`、`--goal`、`--cdp`、`--url`、`--out`、`--pack-dir`、`--script`、`--headless` / `--headful`。
- `plan`：`--plan` / `--save-plan`、`--url`、`--target`、`--signal` / `--signal-file`、`--at`、`--to`、`--max`、`--llm`。

**高级（默认帮助隐藏）**

`--ablate`、`--without-hints`、`--tiered-hint`、`--min-confidence`、`--nominate-provider`

别名归一化（解析前自动转换，保证旧脚本继续工作）：

| 旧写法 | 新写法 |
|---|---|
| `--dry` | `--dry-run` |
| `--no-sources` | `--skip-data` |
| `--force-hints off` | `--without-hints` |
| `--learn-hints` | `--remember` |
| `--hint-memory FILE` | `--memory FILE` |
| `--conf-floor N` | `--min-confidence N` |
| `--hint H` | `--target H` |
| `--file FILE` | `--plan FILE`（`plan new` 时映射到 `--save-plan FILE`） |
| `--id ID`（record） | `--name ID` |
| `--headful`（record） | 无操作（`record` 默认已 headful） |
| `--list`（apps） | `apps list`（仅兼容层） |
| `--app ID`（apps） | 位置参数 `amber run ID`（仅兼容层） |
| `del`（plan 子命令） | `rm` |
| 旧 `start --plan FILE` | `--save-plan FILE`（仅 `run --demo/--goal` 兼容层） |
| `--confirm-safe`（旧 apps） | 无操作（新入口默认拒绝危险动作，不再需要单独开关） |
| `--out FILE`（仅旧 `model:fetch`） | `--to FILE`（兼容层；新命令的 `--out` 只表示输出目录） |
| `--real-model` | 无操作（`suite` 默认已是真模型），打印一次提示 |

别名按命令生效：`--id` 只用于 `record`，`--app` 只用于旧 `apps` 入口；新命令不再暴露这些别名。

### 5.2 命名规则

- 命令：小写动词/名词，不加冒号：`run`、`record`、`plan`、`apps`、`doctor`、`config`、`model`、`dev`。
- 子命令：小写动词：`list`、`show`、`check`、`add`、`edit`、`rm`、`move`、`fetch`、`status`。
- 旗标：小写 kebab-case，完整单词；只有 `-h` / `-V` / `-q` 是短选项。
- 布尔旗标默认正向；关闭默认开启的行为才用 `--no-*` / `--without-*`。
- 列表参数优先可重复（`--slot k=v --slot k2=v2`），同时接受逗号分隔以兼容旧脚本。
- 路径类旗标语义固定：`--out` 永远是输出目录，`--plan` 永远是输入的计划文件，`--save-plan` 永远是生成的计划文件，`--config` 永远是配置文件。唯一例外是兼容层的旧 `model:fetch --out FILE`，它只映射到 `--to FILE`，不出现在新命令面。

### 5.3 输出契约

**人类输出（默认）**

- 进度/日志写 stderr；
- 最终结论写 stdout；
- 默认只给「结果 + 原因 + 下一步」，逐步骤细节在 `--verbose`；
- 颜色只在 TTY 且未设 `NO_COLOR` 时启用；
- 行宽尽量 ≤ 100，照顾 Windows 终端。

**机器输出（`--json`）**

stdout 只输出一个 JSON 对象，不混入任何人类文案；进度写 stderr。

成功：

```json
{
  "schema_version": 1,
  "command": "run",
  "ok": true,
  "exit_code": 0,
  "data": {
    "app": "demo-app",
    "completed": "5/5",
    "skipped": 0,
    "steps": [],
    "invariants": [],
    "decisions": { "rule": 5, "model": 0, "cache_hits": 0 },
    "artifacts": {
      "result_json": "<os.tmpdir>/amberflow/runs/<run-id>/demo-app-result.json",
      "report_md": "<os.tmpdir>/amberflow/runs/<run-id>/demo-app-report.md"
    }
  },
  "diagnostics": [],
  "next": ["amber run demo-app --headful"]
}
```

失败：

```json
{
  "schema_version": 1,
  "command": "run",
  "ok": false,
  "exit_code": 2,
  "error": {
    "code": "USAGE",
    "message": "未知参数 --dryy",
    "hint": "你是不是想用 --dry-run？",
    "next": ["amber run demo-app --dry-run"]
  }
}
```

约定：

- `command` 用完整命令路径：`run`、`apps list`、`dev suite`。
- `ok` 只在 `exit_code === 0` 时为 `true`；`INCOMPLETE` 也带 `data`（步骤结果），同时 `error.code = "INCOMPLETE"`。
- `next` 永远是字符串数组，元素是可复制命令；没有下一步时给空数组。
- `data.skipped` 必须存在；跳过不算通过。
- `--json` 与 `--quiet` 同时给时，`--json` 优先；`--help` 仍输出人类帮助，不输出 JSON。

### 5.4 退出码

| 码 | 名称 | 含义 |
|---:|---|---|
| 0 | `OK` | 成功 |
| 1 | `INCOMPLETE` | 跑了，但有步骤未完成 / 验收条件不成立 |
| 2 | `USAGE` | 参数、配置、前置条件错误；**未产生副作用** |
| 3 | `BLOCKED` | 被策略或人工确认挡住：危险步未放行、非 TTY 无法确认、运行中缺模型 |
| 4 | `QUALITY_GATE` | 仅 `amber dev` 的测量门禁失败（如套件模型边际为 0） |
| 130 | `INTERRUPTED` | Ctrl-C / SIGINT |

规则：

- 用法错误永远先于副作用；坏配置不允许先跑数据腿再报错。
- 「跳过」不算通过；`--json` 里必须有 `skipped` 字段。
- `--help` 永远 exit 0。
- Windows 上 Ctrl-C 的进程码不是 130 时，CLI 统一归一化为 130；脚本只需认这一个值。

### 5.5 错误格式

所有可预期错误统一为：

```text
错误：<一句人话>
提示：<怎么改 / 你是不是想…>
下一步：<可复制命令>
```

- 不打印堆栈；只有 `--verbose` 才附带异常栈。
- 命令/旗标打错做编辑距离建议：`amber rn` 输出「错误：未知命令 'rn'」「提示：你是不是想用 'run'？」和「下一步：amber run --help」。
- 非 TTY 缺确认参数时，指出具体旗标（`--yes` / `--allow-dangerous`），不等待输入。

### 5.6 帮助与补全

```text
amber --help                 # 全局
amber help run               # 等价 amber run --help
amber run --help             # 每个命令都有
amber help --all             # 包含 dev 与高级旗标
amber completion bash|zsh|fish|powershell
```

每条帮助固定包含：

1. 一句话用途；
2. 语法；
3. 3 个可复制示例；
4. 常用旗标 + 高级旗标（折叠）；
5. 退出码；
6. 相关命令。

### 5.7 路径与默认值

| 对象 | 默认 | 覆盖 |
|---|---|---|
| 用户配置 | `~/.amberflow/config.json` | `--config` |
| 项目配置 | `./.amberflow/config.json` | `--config` |
| 用户应用 | `~/.amberflow/apps` | `AMBERFLOW_HOME` / `record --pack-dir` |
| 输入计划文件 | `./.amberflow/plan.json` | `--plan` |
| 生成计划文件 | `./.amberflow/plan.json` | `--save-plan` |
| 运行产物 | `os.tmpdir()/amberflow/runs/<run-id>` | `--out` |
| 录制中间产物 | `os.tmpdir()/amberflow/record/<id>` | `record --out` |
| 套件产物 | `os.tmpdir()/amberflow/suite/<provider>` | `--out` / `AMBERFLOW_SUITE_OUT` |
| 模型产物 | 现有 `LAYA_ONNX_MODEL` 约定 | `--to` / 环境（旧 `model:fetch --out FILE` 仅兼容层） |
| 旧 rc 文件 | `configs/amberflowrc.json`（只读兼容） | `--config` |

目标形态不再新增字面量 `/tmp`；Windows 与 POSIX 都走 `os.tmpdir()`。现有代码里的 `/tmp`（`apps_suite`、`bench`、模型默认路径）在 Phase 3 一并清理；模型默认路径改为 `os.tmpdir()/laya_dec.onnx` 时，`doctor` 必须打印实际路径，旧路径仍可通过 `LAYA_ONNX_MODEL` 指定。

### 5.8 交互与非交互

- 只有需要交互的命令才在 TTY 下等待输入；非 TTY 一律 fail fast，并给出显式旗标。`amber` 首页、`doctor`、`apps list`、`--json` 等只读路径不等待输入。
- `amber run` 无应用 + TTY：编号选择；默认不选危险应用。
- `amber record` 无参数 + TTY：打开可见浏览器，用户自己导航。
- 所有 `[y/N]` 默认 `N`；`--yes` 才自动 `Y`。
- `--allow-dangerous` 是独立许可，`--yes` 不能代替它。

### 5.9 术语表（用户界面）

| 内部术语 | 用户界面用词 |
|---|---|
| app pack | 应用 |
| journey / subgoal | 步骤 |
| invariant | 验收条件 |
| slot | 参数 |
| target_hint | 目标 |
| signal | 完成信号 |
| provider | 决策源（本地模型 / 在线服务 / 规则） |
| ablate | 消融实验（只在 dev 出现） |
| hint memory | 记忆 |
| sources | 数据源 |
| plan | 计划 |

内部代码可以继续用原词；CLI 的帮助、报告、错误信息统一用右列。

---

## 6. 迁移方案

### 6.1 旧命令 → 新命令

| 旧命令 | 新命令 | 兼容策略 |
|---|---|---|
| `npm start` | `amber run --demo` | `start` 保留，转发 |
| `npm start -- --goal ... --url ...` | `amber run --goal ... --url ...` | 旧参数归一化 |
| `npm start -- --plan FILE` | `amber run --demo --save-plan FILE` 或 `amber run --goal ... --save-plan FILE` | 旧 `--plan` 是保存位置，兼容层映射到 `--save-plan` |
| `npm start -- --doctor` / `npm run doctor` | `amber doctor` | `doctor` script 保留 |
| `npm run apps`（无参数） | `amber apps list` | 保留 script；兼容层仍按旧行为列应用后 exit 2，不默认走 `run` |
| `npm run apps -- --list` | `amber apps list` | 保留 script |
| `npm run apps -- --app X` | `amber run X` | `--app` 作为位置参数别名 |
| `npm run apps -- --app X --dry` | `amber run X --dry-run` | `--dry` 归一化 |
| `npm run learn ...` | `amber record --headless ...` | 保留 script；未显式给 `--headful` 时注入 `--headless`（旧 `learn` 默认），`--id` → `--name`，`--out` / `--pack-dir` 语义不变 |
| `npm run agent ...` | `amber record --yes --json --headless ...` | 保留 script；未显式给 `--headful` 时注入 `--headless`（旧 `agent` 默认），页面 / 脚本参数继续透传 |
| `npm run plan-cli -- ...` | `amber plan ...` | 保留 script；`del` → `rm`，`--hint` → `--target`，`--file` → `--plan`（`new` 时 → `--save-plan`）；未给 `--file` 时注入旧默认 `.task_plan.json` |
| `npm run plan:flow -- ...` | `amber dev plan-flow ...` | 先进 dev；使用量足够再提升 |
| `npm run semantic -- ...` | `amber dev semantic ...` | 保留 script |
| `npm run apps:gen ...` | `amber dev generate ...` | 保留 script |
| `npm run apps:suite ...` | `amber dev suite ...` | 保留 script；`--real-model` 无操作 |
| `npm run apps:matrix` | `amber dev matrix` | 保留 script |
| `npm run bench ...` | `amber dev bench ...` | 保留 script |
| `npm run bench:fixtures ...` | `amber dev bench --fixtures-only ...` | 保留 script |
| `npm run shortlist` | `amber dev shortlist` | 保留 script |
| `npm run induce ...` / `apps:induce` | `amber dev induce ...` | 保留 script |
| `npm run providers:baseline ...` | `amber dev providers baseline ...` | 保留 script |
| `npm run probe:tokenplan` | `amber dev providers probe` | 保留 script |
| `npm run nominate:online` / `nominate:context` | `amber dev providers nominate [--context]` | 保留 script |
| `npm run model:fetch ...` | `amber model fetch ...` | 保留 script；`--out FILE` → `--to FILE`，`--sha256-tokenizer` / `--tokenizer` 透传 |
| `npm run verify` | `amber dev verify` | CI 可继续用 script；定义见 §4.9 |
| `npm run parity*` | `amber dev parity [layer]` | 保留 script |
| `npm run test:parity` | `amber dev parity all` | 保留 script；顺序跑六层 |
| `npm run cache:measure` | `amber dev measure cache` | 保留 script |
| `npm run hint:measure` | `amber dev measure hints` | 保留 script |
| `npm run calibration` | `amber dev measure calibration` | 保留 script |
| `npm run model:contribution` | `amber dev measure contribution` | 保留 script |
| `npm run probes:baseline` | `amber dev measure probes` | 保留 script |
| `npm run metrics` | `amber dev measure metrics` | 保留 script |
| `npm run gate:signals` | `amber dev measure gate` | 保留 script |
| `npm run nominate:measure` | `amber dev measure nominations` | 保留 script |
| `npm run picker-server` | `amber dev serve picker` | 保留 script |
| `npm run ip-config` / `camera-entry` | `amber dev legacy ...` 或直接用 `apps/ip-config`、`apps/camera-entry` | 标记 legacy |
| `npm run test` / `test:watch` / `test:bridge` / `test:bridge:offline` / `typecheck` / `prepare` | 保留为仓库生命周期 / 测试脚本，不进入 `amber` 命令面 | 不迁移 |

转发器不能只是静态一行：统一走 `main.ts legacy <旧命令名> ...`，由 `legacy.ts` 按旧参数分流（例如 `apps --list` 走 `apps list`，`apps --app X` 走 `run X`）。

`tests/repo-integrity.test.ts` 断言旧 script 名存在，`bench/smoke.sh` 也直接调用旧 script。Phase 0 先补转发器契约断言；最迟在 Phase 4 删除转发器前，把这两处切到新命令并同步删除旧断言。

旧 `learn` / `agent` 默认 headless，旧 `plan-cli` 默认 `.task_plan.json`，旧 `start --plan` 是保存位置；兼容层必须保持这些默认，不随新命令改变。

### 6.2 `package.json` 瘦身

迁移完成后，`scripts` 保留 10 个：4 个仓库入口（`start` / `doctor` / `cli` / `verify`）+ `prepare` 生命周期钩子 + 5 个测试/类型辅助（`test` / `test:watch` / `test:bridge` / `test:bridge:offline` / `typecheck`）：

```json
{
  "scripts": {
    "prepare": "node scripts/bootstrap.mjs",
    "start": "node --experimental-strip-types src/cli/legacy-start.ts",
    "doctor": "node --experimental-strip-types src/cli/main.ts doctor",
    "cli": "node --experimental-strip-types src/cli/main.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:bridge": "npm --prefix integrations/dsh-bridge run test",
    "test:bridge:offline": "npm --prefix integrations/dsh-bridge run build && npx vitest run --root integrations/dsh-bridge tests/bridge.spec.ts tests/service.spec.ts tests/client.spec.ts",
    "typecheck": "tsc --noEmit",
    "verify": "node --experimental-strip-types src/cli/main.ts dev verify"
  }
}
```

`legacy-start.ts` 不重写业务：它只做参数映射（无参数 / `--demo` → `run --demo`，`--doctor` → `doctor`，`--goal/--url` → `run --goal/--url`，`--plan` → `--save-plan`），然后调用 `main.ts`。过渡期（Phase 0–2）`start` 仍指向现有 `src/cli/start.ts`，确保 `npm start` 行为逐字节不变；Phase 3 再切到适配器。旧 `npm start` 在没给 `--plan` 时仍默认写 `.task_plan.json`；适配器要显式传 `--save-plan .task_plan.json`，不要把它变成新入口的 `.amberflow/plan.json`。

这 10 个里有 9 个沿用旧 script 名（`cli` 为新增）。Phase 3 仍保留旧 46 个 script，其中未进入最终清单的 37 个全部作为转发器；Phase 4 删除这 37 个后，脚本总数（含新增的 `cli`）才收敛为最终 10 个。转发器统一走 `main.ts legacy <旧命令名>`，由 `legacy.ts` 分流，而不是静态写死新命令：

```json
"apps": "node --experimental-strip-types src/cli/main.ts legacy apps",
"apps:suite": "node --experimental-strip-types src/cli/main.ts legacy apps:suite"
```

转发器只在 TTY 打印一次：

```text
[deprecated] npm run apps 将在下个版本移除；列表用 amber apps list，运行用 amber run <应用>
```

非 TTY / `--json` 不打印，避免污染管道。

`verify` 在最终形态调用 `dev verify`；`dev verify` 内部复用 `tsc --noEmit`、`vitest run` 和六层 parity，不能简单转调即将删除的 `test:parity`。

### 6.3 README 重写

`package.json` 增加 `"bin": { "amber": "bin/amber.mjs" }`。checkout 内用 `npx amber`；`npm link` 或全局安装后直接用 `amber`。README 第一次出现命令时说明这一点，避免用户以为 `npm ci` 会自动把 `amber` 放进 PATH。

首页安装段落只保留 3 条命令（放在一个代码块里）：

```bash
# 1. 装（prepare 会引导 Chromium；离线环境再手动跑 npx playwright install chromium）
npm ci

# 2. 跑
npm start                       # 等价 npx amber run --demo

# 3. 体检 / 下一步
npx amber doctor
```

命令速查表覆盖 7 个用户命令 + `dev`（见 §3.2），所有示例统一用 `amber`（未 link 时用 `npx amber`）；维护者命令移到 `docs/CLI_DEV.md`，README 只留链接。

### 6.4 实施架构

```text
bin/
  amber.mjs                 # 兼容 Windows 的启动垫片：用 process.execPath 重新 exec
src/cli/
  main.ts                   # 唯一入口：全局旗标 → 命令分发 → 错误映射
  registry.ts               # 命令名、摘要、用法、示例、旗标、退出码（单一出处）
  context.ts                # cwd/env/stdout/stderr/tty/signal/clock
  output.ts                 # 人类渲染 + JSON envelope + 颜色
  errors.ts                 # UsageError / ConfigError / BlockedError / QualityGateError
  args.ts                   # parseArgs 包装 + 通用旗标 + 拼写建议
  legacy.ts                 # 旧旗标归一化 + 旧命令转发
  legacy-start.ts           # `npm start` 的三种旧用法适配（demo / doctor / goal）
  commands/
    run.ts / record.ts / plan.ts / apps.ts
    doctor.ts / config.ts / model.ts / dev.ts
```

要点：

- **不重写引擎**：`run` 调用现有 `app-runner` / `start` 的实现；`record` 调用 `learn`；`plan` 调用 `plan-cli`；`dev` 调用现有 `tools/*`。CLI 只是门面。
- 现有各文件的 `main(argv)` 改为接收一个 `CommandContext`（或适配器包一层），避免 `--json` 时人类日志混进 stdout。
- `bin/amber.mjs` 不直接 import TS；用 `spawn(process.execPath, ["--experimental-strip-types", mainTs, ...args], { stdio: "inherit" })`，并把 SIGINT / SIGTERM 转发给子进程。用 `spawn` 而不是 `spawnSync`，这样长任务能被 Ctrl-C 正常中断并得到 130。Windows 不需要 shebang 技巧。
- 可选的发布形态：`tsc` 编译到 `dist/`，`bin` 指向 `dist/cli/main.js`，去掉实验性 flag；不阻塞本期。

### 6.5 分阶段落地

| 阶段 | 交付物 | 风险 |
|---|---|---|
| Phase 0：地基 | `registry` / `main` / `output` / `errors` / `legacy`；所有旧命令可转发；`amber --help` 可用；契约测试；补转发器断言，保持 `repo-integrity` 与 `bench/smoke.sh` 可跑 | 低，不改行为 |
| Phase 1：高频面 | `run`、`apps`、`doctor`、`config`；`--json` 统一；README 首页改造；`bin` / `npx amber` 可用 | 中，需要输出适配 |
| Phase 2：创作面 | `record`、`plan`、`model`；修无参数录制；稳定 ID；默认计划路径；`--save-plan` | 中，涉及交互与兼容 |
| Phase 3：维护面 | `dev` 全量迁移；保留旧 46 个 script（含转发器）；补全；docs/CLI_DEV.md；弃用提示；清理 `/tmp` 字面量 | 中高，CI/文档面广 |
| Phase 4：清理 | 删除 37 个弃用转发器，把 `repo-integrity` / `bench/smoke.sh` 切到新命令，旧 46 个 script 收敛为最终 10 个；发布 v2 | 低，但需一个版本窗口 |

### 6.6 验收清单

- [ ] 全新 checkout 到第一条绿色结果 ≤ 2 条命令（`npm ci`（自带 Chromium 引导）+ `npm start`），无需旗标；离线安装另计。
- [ ] `amber --help` 只列 7 个用户命令 + `dev`，不出现实验旗标。
- [ ] 每个用户命令都有 `--help`、`--json`、3 个示例。
- [ ] `amber run --demo` 与 `npm start` 的步骤判定、跳过数、退出码一致；新命令额外写结果 JSON，不要求两份 JSON 逐字节相同。`amber run demo-app` 是另一条参考应用包流程。
- [ ] `amber run <app> --dry-run` 零浏览器、零数据腿、零副作用。
- [ ] `amber run --goal ... --save-plan X` 把生成的计划写到 X；`amber run --plan X` 只读取 X。
- [ ] 非 TTY 下没有任何命令等待输入；缺参数时 exit 2/3 并给旗标。
- [ ] `amber doctor` 能点名缺件并给一条可复制命令。
- [ ] 所有用户命令共用 §5.4 退出码；契约测试覆盖。
- [ ] `amber apps list --json` 可被脚本解析；stdout 无人类文案。
- [ ] Windows 默认路径来自 `os.tmpdir()` / `AMBERFLOW_HOME`，目标形态不新增 `/tmp`。
- [ ] 迁移窗口内（Phase 0–3），旧 npm script、`bench/smoke.sh`、`tests/repo-integrity.test.ts` 仍可跑；TTY 打印迁移提示。
- [ ] 未执行 `npm link` 时 `npx amber ...` 可用；README 中用户路径不再出现 `npm run X -- --flag`。
- [ ] 迁移窗口内（Phase 0–3），旧 `learn` / `agent` 仍默认 headless、旧 `plan-cli` 仍默认 `.task_plan.json`、旧 `start` 无参数仍写 `.task_plan.json`、旧 `start --plan` 仍表示保存位置。

### 6.7 风险与对策

| 风险 | 对策 |
|---|---|
| 旧脚本 / DSH 桥依赖旧旗标 | `legacy.ts` 归一化；旧 script 走 `legacy <name>` 分流；保留一个版本；契约测试覆盖旧写法 |
| `--json` 被人类日志污染 | 输出层强制 stdout/stderr 分离；现有 `main` 逐步接 `Context`；Phase 1 先包 `console` |
| 默认值改变导致行为回归 | 只改新入口默认，不改引擎；旧 `learn` / `agent` 未给 `--headful` 时注入 `--headless`；旧 `plan-cli` 未给 `--file` 时，`new` 注入 `--save-plan .task_plan.json`、其余子命令注入 `--plan .task_plan.json`；旧 `start` 无参数仍用 `.task_plan.json`、旧 `start --plan` 映射到 `--save-plan`；新入口在文档中写清 |
| 默认计划/产物路径改变 | 新入口用新路径；旧入口继续旧路径；`doctor` 打印实际路径 |
| `--plan` 语义变化 | 新入口只把 `--plan` 当输入；生成计划用 `--save-plan`；兼容层单独翻译旧 `start --plan` |
| 静态转发器无法处理 `--list` / `--app` 分流 | 所有旧 script 统一调用 `main.ts legacy <old-name>`，由代码分流，不写死目标命令 |
| `bench/smoke.sh` / `repo-integrity` 仍引用旧 script | Phase 0 先补转发器断言；Phase 3 继续保留旧 script；Phase 4 删除转发器前把两者切到新命令 |
| `amber` 不在 PATH | `package.json` 声明 `bin`；README 用 `npx amber`；`npm link` 作为可选步骤；错误提示里给出替代命令 |
| provider 改名破坏配置 | 规范名不变；只加 `auto` / `local` / `rules` 别名 |
| 用户配置迁移丢密钥 | 旧 `configs/amberflowrc.json` 只读兼容；`config init` 不覆盖已有文件 |
| 帮助文本再次漂移 | 帮助由 registry 生成；README 示例进 smoke test |
| Windows 启动垫片复杂 | `spawn` + `process.execPath`，转发 SIGINT / SIGTERM，不用 shell；Phase 3 可选编译到 `dist/` |

---

## 7. 附录

### 7.1 建议的 `amber --help`

以下示例假定 `amber` 已在 PATH；未 `npm link` 时用 `npx amber`。

```text
AmberFlow — 冻结计划的浏览器自动化

用法：
  amber <命令> [选项]

日常命令：
  run       运行应用、计划或一次性目标
  record    演示一次，生成应用
  plan      创建 / 编辑 / 校验计划
  apps      列出 / 查看 / 校验应用
  doctor    环境、配置、决策源体检
  config    查看 / 修改机器配置
  model     本地决策模型状态与安装

维护者：
  dev       套件、基准、对拍、测量（amber dev --help）

全局选项：
  -h, --help       显示帮助
  -V, --version    显示版本
  --json           机器可读输出
  -q, --quiet      只输出结论
  --verbose        输出逐步骤细节
  --no-color       禁用颜色

示例：
  amber run --demo
  amber run demo-app
  amber record https://shop.example.com --name add-to-cart
  amber doctor

退出码：0=成功 1=未完成 2=用法/配置错误 3=被策略挡住 4=质量门禁（仅 dev） 130=中断
```

### 7.2 一次典型的新用户会话

```bash
$ npm ci
$ npm link                      # 之后可直接用 amber；不 link 就把下面的 amber 换成 npx amber
$ npm start
✔ 开箱任务  2/2 步 · 验收条件成立
  下一步：amber run demo-app       看一个完整应用包

$ amber record https://shop.example.com --name add-to-cart
页面：Shop
目标：把商品加入购物车
...
✔ 已录制 add-to-cart（2 步）
  包：~/.amberflow/apps/add-to-cart/app.mjs

$ amber run add-to-cart
✔ add-to-cart  2/2 步
  下一步：amber run add-to-cart --remember

$ amber apps list
add-to-cart   把商品加入购物车    2 步   用户
demo-app      应用包示范          5 步   内置
...

$ amber doctor
...
```

### 7.3 待确认的产品决策

以下四项建议在实现前拍板：

1. **命令名**：`amber`（推荐）还是 `af`。建议主名 `amber`，`af` 作为可选别名。
2. **`record` 默认可见**：录制工具默认 headful（推荐），CI 用 `--headless --script`。
3. **旧脚本保留期**：保留一个 minor 版本（推荐），还是立即删除。建议保留并打印弃用提示。
4. **`--plan` 的单一语义**：只做输入，生成计划用 `--save-plan`（推荐）；旧 `start --plan` 由兼容层翻译。这样不必在同一个旗标上区分「读」和「写」。

---

## 8. 参考

- `README.md`：当前命令速查与示例
- `package.json`：46 个 npm scripts；迁移后保留 10 个（`start` / `doctor` / `cli` / `verify` + `prepare` + 5 个测试/类型辅助）
- `src/cli/start.ts`、`src/app/app-runner.ts`、`src/cli/plan-cli.ts`
- `tools/learn.ts`、`tools/apps_suite.ts`、`tools/spec-to-pack.ts`
- `src/flow/plan-flow.ts`、`src/flow/semantic-flow.ts`
- `src/support/rcfile.ts`、`src/support/cli-args.ts`
- `src/app/amberflow-home.ts`：用户作用域与 `~/.amberflow/apps`
- `bench/smoke.sh`、`.github/workflows/checks.yml`、`tests/repo-integrity.test.ts`：迁移时必须同步的 CI / 脚本名断言
- `integrations/dsh-bridge/src/bridge.ts`：DSH 桥对 `learn` / `apps` / `plan-flow` 的 argv 约定
