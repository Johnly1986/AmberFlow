---
description: "从会话侧调用 AmberFlow 冻结计划浏览器引擎的 harness 接口：四个工具，用于列出应用、端到端运行一个应用、用「目标 + 页面 + 录好的动作清单」录制流程，以及规划站点无关的流程。一条旅程可以混用多种应用类型（web/cli/ssh/stdio）。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-amberflow-bridge

[English](README.md) | 中文

## 概述

`dsh-amberflow-bridge` 把一个外部浏览器引擎暴露成四个面向模型的工具。AmberFlow 只规划一次，之后每一步都在**本地**决策，把 DOM 信号当作唯一的完成真相，并且能从一次演示里录制流程；本桥不添加任何自己的浏览器逻辑，只调用那个 checkout 的命令行并归纳其产物。同一个应用可以在一条旅程里混用**多种应用类型**——web/cli/ssh/stdio（交互式进程，如游戏）——清单会报告类型组合以及运行所需的本机服务（例如 ssh 需要可达的本机 sshd）。插件的**配置页**（设置 → 插件 → 本 bundle 的行 → 配置）只设置三个字段，用来配置**线上决策模型**（token-plan SystemOne）：模型 URL、Token Key、ModelName。`amberflow_apps` 列出已声明的应用，并说明每个包是由 spec 生成的、由演示录制的、手写的，还是纯数据源。`amberflow_run` 端到端运行一个应用，返回完成情况、**只列失败**的步骤、拒绝项与不变量结果；加上 `dry` 时则只返回展开后的计划，不执行任何一步。`amberflow_learn` 用一个目标、一个页面和一份录好的动作清单来录制流程，并报告那次"零模型调用回放"，正是它决定录制的流程是否可复现到值得保存。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

用一个 AmberFlow checkout 的路径挂载本插件。不是 checkout 的路径会在**加载期**失败而不是第一次调用时失败，所以打错字会在组装阶段就暴露：

```yaml
repoPath: null                  # optional; resolves config > AMBERFLOW_REPO > the checkout the plugin sits in
nodeBin: null                   # optional; defaults to the running interpreter
timeoutMs: 900000               # optional; live runs are slow by nature
allowDangerous: false           # optional; gates dry-run-gated tool steps
toolPrefix: amberflow          # optional; the model-visible tool-name prefix
envMode: inherit                # optional; `allowlist` 会把会话机密挡在子进程环境之外
forwardEnv: []                  # optional; `allowlist` 模式下额外转发的环境变量名
keepRuns: 30                    # optional; 保留最新的 $TMPDIR/dsh-amberflow-* 目录数；0 关闭回收
```

### 何时选择它

当一次会话要驱动的流程必须保持可复现时选择它：引擎拒绝发明目标，只依据 DOM 信号报告完成，并且
除非"零模型调用回放"仍然通过，否则拒绝保存录制的流程。若任务依赖页面看起来是什么样，或者没有
可调用的 checkout，就应该改选像素级浏览器工具。

<a id="understand-the-implementation"></a>
把它作为 bundle 装进一个 profile —— `dsh plugin --profile <名称> add <路径或包名>`（插件窗口跑的是同一个
操作）。支持三种通道：

- **路径 / link**（本仓库的开发形态）：`dsh plugin --profile web add /绝对路径/AmberFlow/integrations/dsh-bridge`
  安装嵌套包；它的 `cordis.patch.yml` 按包名寻址插件。
- **git 直装引擎仓库本身**：`dsh plugin --profile <名称> add github:Johnly1986/AmberFlow` 安装仓库根
  ——根 `dsh.bundle` 指向 `dsh-bundle.yml`，行寻址 `amberflow/dsh-plugin`（包 subpath）。克隆就是整个
  引擎，插件据此自定位 checkout；本包不跑任何构建脚本，因此**无需 `allowBuilds` 授权**（若 pnpm 列出
  带安装脚本的依赖 `onnxruntime-node`、`protobufjs`，只需批准这两个名）。长期信任的安装请锁 commit
  （`#<sha>`），并在 profile 启动的机器上执行一次 `npx playwright install chromium`。ONNX 决策模型
  是刻意不进 git 的大产物：规则模式的运行与 `learn` 的零模型回放只需要克隆本身；要让模型兜底，就
  在 checkout 里跑一条 `npm run model:fetch -- --from <url|本地路径>`（SHA256 先验后换；`npm run
  doctor` 会点名缺哪件）。没有它运行照常，只是摘要会明写 `model: off(missing)`，真需要模型的步骤
  在装载处响亮地失败而不是瞎猜。
- **npm 或 tarball**：`pnpm pack` 打包；根 package.json 就是 bundle，git 通道的行为原样沿用。

声明了 `dsh.bundle` 的包在安装时会自动加入 `dsh.profile.bundles`，因此四个工具无需手写 profile
补丁即可用；live profile 会在下一次配置重载时生效。`AMBERFLOW_REPO` 覆盖解析出的 checkout 路径；
而不是 checkout 的路径会在加载期失败。

### 从另一个插件里调用

其它插件可以注入服务，而不是去调工具。本桥提供 `ctx.amberflow`，含 `listApps`、`run`、`learn`——
和工具跑的是同一份代码，因此部署闸门与失败诊断不会在两个入口之间漂移。工具是面向模型的门，
服务是面向插件的门；它不需要 `callId`、不需要 signal、也不需要知道工具名。

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-amberflow-bridge'

const Consumer = {
  name: 'consumer',
  inject: ['amberflow'],
  apply(ctx: Context) {
    return ctx.amberflow.run({ app: 'learned-cart', noModel: true })
  },
}
```

## 理解实现

每个工具都是一层薄封装：拼装 argv、带硬超时地跑一个子进程，然后归纳命令行写下的产物。

- `amberflow_apps` 只读 `apps/<id>/pack.json`：不用浏览器、不用模型、不起子进程。没有 `pack.json` 但
  带 `sources/` 的目录是**纯数据源应用**，会以 `data-source` 列出，因为别的包正是按名字引用它们。
- `amberflow_run` 启动 `src/app-runner.ts --app <id> --out <dir>` 并读取 `<id>-result.json`。
  摘要只列失败项；完整的逐步表格留在 `<id>-report.md` 里，结果会给出它的路径，需要细节时再读。
  摘要还带一行**模型层级**（`model: on` / `off(missing)` / `off(rules-only)`）与"决策来源"小计
  （`rule 19 · laya 1 (conf 0.31) · laya:reobserve 1 · cache 命中 6/12 forwards`）——用户一眼看清
  这次跑在哪一层、模型出场没有（`docs/LAYA_VALUE_PLAN.md` P0/P1）。
  `dry` 只展开计划并把它返回：那次运行不写任何产物、不校验任何东西，因此被报成一次展开，而不是
  PASS/FAIL。
- `amberflow_learn` 启动 `tools/learn.ts --json --yes`：它把流程跑一遍，从观测到的状态变化里归纳
  每步的完成信号与结束态不变量，并且只在"零模型调用回放"通过时才保存包；桥会原样报告那次回放。
  `script` 是必填的：命令行唯一的另一个动作来源是人在交互式终端上的现场演示，而工具调用既没有终端
  也没有 stdin，且桥恒定传 `--yes`。缺少 `script` 的调用会在**启动任何进程之前**被拒绝。

### 多类型应用（web / cli / ssh / stdio）

应用支持器层允许一条旅程混用应用类型：浏览器步（`web`）、本地命令（`cli`）、`ssh` 远端命令、
交互式进程（`stdio`，例如逐行应答提示的游戏）可以出现在同一个 `journey` 里，引擎按每步的
`adapter` 分派。步骤产出的值也能传递：步骤可声明 `returns`，后续步骤消费具名值（进程参数里的
`{dataset:NAME}`，或浏览器侧的 `{from:"dataset"}` 命令绑定）。

桥在花一次运行之前先把会话需要的信息摆出来：

- 清单每一行带 `types`——旅程的适配器组合，例如 `web×2 · cli×3 · ssh×1 · stdio×1`（排序固定；
  纯数据源为空）——以及 `requires`——运行所需的本机服务，例如 `ssh` 需要可达的本机 sshd；
- 运行摘要会重复这两个字段（仅当应用混用类型 / 声明了本机依赖时），这样"因本机缺服务而 blocked/
  refused"的运行是可解释的，而不是一头雾水。

桥本身**不调用任何 LLM**：决策兜底是 checkout 的本地 ONNX 模型，`learn` 的落盘门槛是零模型调用回放。
LLM 门（LLM 规划器、或语义流的升级老师）是命令行层的可选项，需要运行 checkout 的机器上有 `OPENAI_*`
——它们不是插件的前置要求。

### 看着浏览器跑（有头运行）

每个浏览器入口都能用 `--headful` 显形：

| 面 | 怎么开 |
|---|---|
| 引擎 CLI | `npm run apps -- --app <id> --headful`；`npm run semantic -- --app <模板> --site <key> --headful`；`npm run plan:flow -- … --headful`；`node tools/learn.ts --headful` |
| DSH 工具 | `…_run` 传 `headful: true`（应用包与语义模板都支持）、`…_plan` 传 `headful: true`、`…_learn` 传 `headful: true`（或用 `cdp` 直接驱动你已经开着的浏览器） |

两点要知道：

- **窗口开在"跑引擎的那台机器"上**（也就是部署主机），不会出现在 DSH 的浏览器页面里。服务器无显示器时
  要给它一个显示并去看那个显示：
  ```bash
  xvfb-run -a -s "-screen 0 1440x900x24" dsh --profile web --no-open --port 3080   # 整个宿主跑在虚拟显示下
  # 或只包一次运行：xvfb-run -a npm run apps -- --app demo-app --headful
  # 要人眼看：再配 x11vnc / noVNC，或用 ffmpeg -f x11grab -i $DISPLAY 抓帧
  ```
- 有头需要**完整 chromium**。本机实测：`--headful` 起的是 `chromium-*/chrome` 且命令行里**没有**
  `--headless`（真窗口，已在虚拟显示上抓到画面），默认起的是 `chrome-headless-shell --headless`。
  只有 headless shell 的机器上，有头运行会直接点名缺什么（`npx playwright install chromium`），
  不会甩一句 Playwright 的天书。

### 配置页：线上决策模型（token-plan SystemOne）

bundle 自带一个浏览器半，在 `plugins.row.config` 注册自己的行配置页：设置 → 插件 → 本 bundle →
`amberflow-bridge` 那一行会出现**配置**入口。页面只显示三个字段（它们是插件 Config 里**全部**的
`.volatile()` 字段），用于配置引擎执行步骤时的**决策模型**：

| 字段 | 转发到引擎 CLI 的环境变量 | 含义 |
|---|---|---|
| **决策模型 URL** | `TOKEN_PLAN_ENDPOINT` | token-plan 兼容模式基址（如 `https://…/compatible-mode/v1`）；桥自动补 `/systemone`（已带后缀则原样） |
| **决策模型 Token Key** | `TOKEN_PLAN_API_KEY` | bearer token；只写不读——Host 不回传，页面只显示"已配置/未设置" |
| **决策模型名 ModelName** | `TOKEN_PLAN_MODEL` | 决策模型 id（如 `decision-model-preview`）；留空用 provider 默认 |

行为：

- **provider 默认值**：URL 与 Token 都设置后，桥给应用运行（`amberflow_run`）自动加
  `--provider token-plan`，插件无需每次传参就走线上决策模型；显式传 `provider` 仍优先，消融臂
  （`ablate`）不会继承这个默认值。
- **改完即生效，不用重启**：`.volatile()` 字段由 Loader 提交到运行中的引用，桥在
  `loader/volatile-update` 事件里重读；此后启动的 CLI 调用即使用新端点。保存持久化到 profile 的
  `cordis.patch.yml`。
- **留空 = 本地决策面**：空字段不注入任何环境变量，"不配置"的部署继续用本地 ONNX 决策模型
  （或 rules-only）；桥本身仍然不需要模型 key。
- **作用域**：这是 **SystemOne 执行** 的决策模型；LLM 门（LLM 规划器、审计、语义升级）是另一条
  路径，仍从环境变量读 `OPENAI_*`。`plan` 工具的规划阶段与 semantic-template 运行仍走各自的决策面，
  这个页面暂时不会覆盖它们。
- **编辑仅限 loopback 页面（宿主策略）。** 经非 loopback 地址打开页面时 `ctx.remote.$host.isLoopback`
  为假，Harness 把 settings 切成 memory 模式：远程页面既不读也不写 Host 配置。因此远程打开时行页面会
  显示一段说明而不是表单——请在 Host 本机、或通过 SSH 隧道（`ssh -L 8080:127.0.0.1:3080 <host>`）编辑。
  在 loopback 页面保存的值对所有运行生效，也包括从远程页面发起的运行。
- **只能改这三个字段**：`repoPath`/`nodeBin`/`timeoutMs`/`allowDangerous`/`toolPrefix`/`envMode`/
  `forwardEnv`/`keepRuns` 仍写在 `cordis.patch.yml`（普通字段的变更会重挂插件；`toolPrefix` 甚至
  会改工具名，不能做成热更新）。
- **两种安装门都提供本页面**：bundle 带两个逐字一致的 client bundle——`client.js` 供 nested 的
  `integrations/dsh-bridge` 安装（模块 id = 包名，行 key `@deepseek-ai/dsh-amberflow-bridge#amberflow-bridge`），
  生成的 `client-root.js` 供仓库根安装（`dsh plugin add <repo>`；模块 id = 根包名 `amberflow`，
  行 key `amberflow#amberflow-bridge`）。仓库 bundle 的行名是**包根** `amberflow`——DSH 的 client
  扫描只服务包根行，所以手写的 profile patch 若要覆盖这一行必须写 `name: amberflow`
  （`amberflow/dsh-plugin` 这个导出别名仍能让旧的 Host-only patch 加载，但不会提供配置页）。只改
  `client.js`，再用 `node integrations/dsh-bridge/scripts/client-root-sync.mjs` 重新生成；测试会钉住生成结果。

### 信任边界

本桥会从 `repoPath` 启动一个外部进程，且不经过 harness 的沙箱策略，因此启用本插件意味着信任那个
checkout。除非部署把 `allowDangerous` 设为 true，危险的工具步一律被拒绝；在未开启的部署上请求它们
会被明确拒绝，而不是被悄悄降级。

<a id="further-exploration"></a>
## 进一步探索

- 本仓库的 `apps/README.md` —— 应用包怎么声明、四个工具所呈现的退出码契约，以及两条"会咬人"的规矩。
- 本插件所运行的 DSH 安装里的 `packages/core/tools` 与 `packages/browser-use/browser-use` ——
  测试所驱动的工具注册表，以及本桥所补充的树内浏览器自动化服务。

<a id="model-experience"></a>
## 模型体验

模型看到四个 schema 很窄的工具。`amberflow_run` 回答 PASS/FAIL、完成计数、不变量计数、带障碍文本
的失败步骤，以及报告路径；完成的步骤只是计数而不是逐行，所以六十步的旅程只用一行而不是一页。
**跑了但没被拒绝**的工具步也会被点名；若一次失败没有任何可点名的步骤，摘要会报出退出码或超时，
因此 FAIL 总会说明它是怎么失败的。`dry` 则改为回答展开后的
计划，让人不运行也能检查一条旅程。`amberflow_learn` 回答它被把关的那次回放（含模型调用次数），
因此不可复现的流程永远不会被报成"已学会"；没有 script 时它会立刻拒绝，不会先启动浏览器。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 真机测试需要 checkout 与 chromium（录制那条还需要 checkout 的 ONNX 产物）；缺一时会**跳过**并打印原因。
- 本桥刻意不叫 `tool-*`，因此不会进入自动生成的工具目录。
- 每次运行都会留下自己的临时目录——结果会指向其中的报告，所以那个目录必须比这次调用活得更久。
  产物按调用隔离，从不共享。`keepRuns` 限定最新的多少个 `dsh-amberflow-*` 目录会被保留；目录要
  距最后一次写入满一小时才可能被回收，慢速真机运行不会被删到自己头上。
- 应用清单现在会标注 `kind=probe`（测量型探针包——引擎拒绝经 app runner 运行它们）与
  `data-source`；`…_run` 会把引擎的探针拒绝翻译成同样的指引——但探针驱动本身仍未做成工具。
- 默认整体继承会话环境给子进程（"信任 checkout"是本插件声明的前提）。设 `envMode: allowlist`
  可只转发运行必需项加 `AMBERFLOW_*` 与 `forwardEnv` 列出的名字。
- 插件尚未暴露 checkout 同样提供的不变量归纳与批量套件工具。
- `amberflow_learn` 无法替你演示：录制**新**流程必须给一份录好的动作清单，因为命令行的现场录制器
  需要交互式终端。没有 script 的调用会被直接拒绝，而不是被放进引擎里失败。

### 开发备注

本包在两个层面被测。`tests/bridge.spec.ts` 把插件挂在一个**桩 checkout** 上，其命令行在本桥依赖的
几点上与真实命令行一致——`--dry` 打印计划且不写产物、`learn` 没有 `--script` 就拒绝、JSON 之前会有
（其中一行含花括号的）日志行——并通过 `ctx.tools.execute` 驱动四个工具，覆盖参数拼装、血统解析、
只列失败的归纳、加载期校验、各条拒绝路径与 dry 展开。`tests/live.spec.ts` 用同一条注册表路径驱动
**真实** checkout：以 `ablate` 消融臂跑一个录制的两步应用（不传就是真模型）、一次 `dry` 展开、一次被逼失败的运行（让 FAIL
判决对照真实产物）、无 script 的拒绝，以及一次真实的录制——它的"零模型调用回放"正是保存的前置条件。
