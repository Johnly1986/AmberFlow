# AmberFlow

> **冻结计划的浏览器自动化中间件**（TypeScript / Node ≥ 22.6）：LLM 只规划一次，执行由本地规则与决策模型逐步完成，演示一次后既可端侧执行，也可以手动规划。
>
> 规则保证可复现，Laya 保证不轻言放弃，信号保证不作弊。

## 安装运行

```bash
npm ci && npx playwright install chromium
npm link           # 可选但推荐：让统一入口 `amber` 进 PATH（`npm ci` 不会装它；跳过就用 `npx amber …`）
npm start          # 在仓库自带页面上跑一份真实计划：离线、零配置
npm run doctor     # 环境体检：Node / chromium / 决策模型 / 可选 provider / LLM，缺什么给什么命令
npm run apps -- --app ctrip-case --provider coin-flip   # 换决策模型跑（laya-onnx|stub|none|基线|jevk5|bailian|token-plan|自注册）
npm run providers:baseline   # 决策提供者对照台：零智能基线 first-candidate 是任何新模型要赢的线
```

成功的样子（`npm start` 会逐步打印判定依据，最后一行是结论）：

```
step 1: click a "Add to cart" (clicked, rule:match, conf=1.00)
结果：2/2   步骤 2   跳过 0   重试 0
```

> `npm start` 的计划检查点默认写在**用户作用域**：`$AMBERFLOW_HOME/task_plan.json`（默认 `~/.amberflow/`），不进 checkout；想换个位置就加 `--plan /tmp/my-plan.json`。
> 模型产物的默认下载落点是**项目目录 `models/`**（图 + 外置权重 + tokenizer 同处一地，已进 `.gitignore`）；换位置用 `LAYA_ONNX_MODEL`。

没有模型权重也能跑：计划点名了目标的步骤由**规则**解决；确实需要模型兜底的步骤会明确说明缺什么，而不是瞎猜或抛异常。

### 用在线决策模型（不装本地 1.7GB 产物）

```bash
cp configs/amberflowrc.example.json configs/amberflowrc.json   # 本机文件，已被 .gitignore 排除
```

编辑 `configs/amberflowrc.json`，只填三行（示例见模板 `_doc`；凭据只留在本机这个文件里）：

```json
{
  "AMBERFLOW_DEFAULT_DECISION_PROVIDER": "token-plan",
  "TOKEN_PLAN_ENDPOINT": "https://<你的网关主机>/compatible-mode/v1/systemone",
  "TOKEN_PLAN_API_KEY": "sk-…"
}
```

然后**任何命令都不需要加旗标**——`npm start`、`npm run apps`、`npm run apps:suite`、`npm run bench`、
`learn`、`plan-cli` 全走同一扇门选决策源（本地产物就绪→本地；配了 provider→在线；都没配→规则档并如实点名）：

```bash
npm run doctor                 # 确认：「决策档位 token-plan（tier=on）」+ 每个配置值的来源（文件/环境）
npm start -- --goal "…" --url <页面>          # 演示→归纳→执行，决策问线上模型
npm run apps -- --app demo-app --headful     # 有头跑一个应用（风险闸门用模型投票）
npm run bench -- --force-hints off           # 剥光 hint 的臂：模型必然出场（决策来源行可见）
npm run providers:baseline -- --providers token-plan,first-candidate --out "$TEMP/pb.json"   # 与零智能基线对高下
```

临时换档：任何命令加 `--provider NAME`（`first-candidate`/`none`/`jevk5`/`bailian`…，名字见 doctor 列表）；
离线消融臂用 `--ablate stub`（不花在线调用量）。token-plan 的 A/B 开关：`TOKEN_PLAN_STATE_CONTEXT=0`
回到"只带 goal 的问法"（带页面上下文的实测数据见 [docs/DECISION_PROVIDER_TOKENPLAN.md](docs/DECISION_PROVIDER_TOKENPLAN.md) §1b）。
读数提醒：旅程每步都有 hint 时模型出场为 0 是**设计**（"能规则化就别猜"）；要量模型就用剥 hint 的对照台。

## 统一入口：`amber`

`package.json` 的 `bin` 提供 `amber`，但 **`npm ci` 只链接依赖的 bin，不会把根包的 `amber` 放进 PATH**。
所以裸敲 `amber …` 之前要先 link 一次（全局装过则不必）：

```bash
npm link          # 只需一次：让 `amber` 进 PATH
amber --version   # 验证；之后本文所有 `amber …` 都能直接敲
```

不想改全局环境时，下面两种写法等价、随时可用（把 `amber` 换成它们即可）：

```bash
npx amber run --demo            # checkout 内直接跑（npx 会认本包的 bin，不会去下载同名包）
npm run amber -- run --demo     # 等价；`npm run cli -- …` 是同一个入口的旧名字
```

上面四条命令的对应写法（**已 `npm link`**）：

```bash
amber run --demo                                                     # 在仓库自带页面上跑一份真实计划（计划默认存 ./.amberflow/plan.json）
amber doctor                                                         # 环境体检；--fix 只在缺件时建目录 / 装 Chromium
amber run ctrip-case --provider coin-flip                            # 换决策模型跑（与 npm run apps 同一扇门）
amber dev providers baseline --providers token-plan,first-candidate --out "$TEMP/pb.json"   # 与零智能基线对高下
```

敲 `amber` 时如果报 `CommandNotFoundException` / `command not found`，就是还没 link ——
`amber doctor` 会把这件事作为「CLI 入口」一项直接点名，并给出当前可用的写法。

`amber` 无参数是**首页**：Node / Chromium / 决策源 / 应用清单 / 下一步——不需要记住任何子命令就能开始。
任何命令加 `--json` 后 stdout 只有一个信封对象（人类进度与诊断走 stderr）；`amber help --all` 列出
全部命令与高级旗标；`amber completion bash|zsh|fish|powershell` 给补全脚本。

### 退出码（写脚本 / Agent 只需要认这张表）

| 码 | 含义 | 你会看到 |
|---|---|---|
| 0 | 成功 | `data` 里是结果 |
| 1 | 未完成 | 计划 / 应用没跑完；`data.steps` 里有每一步的状态 |
| 2 | 用法 / 配置错误 | **一行**点名哪个旗标或哪一层配置不对（不是堆栈） |
| 3 | 被策略挡住 | 例如不带 `--force` 删内置应用、非交互缺 `--yes` |
| 4 | 质量门禁（仅 `amber dev`） | 套件没过门槛，绿色不替它背书 |
| 130 | 中断 | Ctrl-C；不假装成功 |

`--json` 时错误也是同一个形状：`{"ok":false,"exit_code":2,"error":{"code":"USAGE","message":"…","hint":"…","next":["…"]}}`
——`hint` 回答"那我该写什么"，`next` 是可以直接抄的下一条命令。

### 非交互（CI / Agent）不用猜

- `amber record` 非 TTY 必须给 `--url` 或 `--cdp`；
- `amber run --plan <文件>` 非 TTY 默认 `--confirm deny`；要放行显式给 `--yes`
  （`--yes` **不**隐含 `--allow-dangerous`）；
- `amber apps remove <id>` 非 TTY 必须给 `--yes`；
- 需要人来回答的场景一律报错并给出可抄的写法，**不替你选、不静默继续**。

### 新旧对照

| 新写法 | 旧写法 | 说明 |
|---|---|---|
| `amber`（无参数） | — | 首页：状态 + 应用列表 + 下一步 |
| `amber run <应用>` / `--demo` / `--goal "<目标>" --url <页面>` | `npm run apps -- --app <id>` / `npm start` / `npm start -- --goal …` | 语义同一扇门；计划默认 `./.amberflow/plan.json`（旧 `start --plan` 语义不变） |
| `amber record --url <页面>` | `npm run learn -- --url …` | **默认有头**；要旧 headless 加 `--headless` |
| `amber plan new "<目标>"` | `npm run plan-cli -- new "<目标>"` | 计划默认 `./.amberflow/plan.json`；步骤 1-based，且有 `描述slug-短哈希` 稳定 id |
| `amber apps list / show / check / path / remove` | `npm run apps -- --list / --app <id>` | `amber apps` 无子命令即 list（旧 `npm run apps` 无参数仍报错） |
| `amber config get / set / unset / show / path / init / edit` | 编辑 `configs/amberflowrc.json` | 分层生效：旧 rc < 用户 < 项目 < 环境；`amber doctor` 点出每个值的来源 |
| `amber model status / path` | — | 三件产物（图 / 外置权重 / tokenizer）缺哪件点名哪件 |
| `amber model fetch --from <url 或本地路径>` | `npm run model:fetch -- --from …` | SHA256 先验后换、坏件不覆盖。同一约束 |
| `amber dev suite / matrix / bench / parity / verify` | `npm run apps:suite / apps:matrix / bench / verify` | 维护者命令都收在 `amber dev` |
| `amber completion <shell>` | — | 补全脚本：`bash` / `zsh` / `fish` / `powershell` |
| `amber legacy <旧命令>` | `npm run <旧命令>` | 兼容转发器：按**旧行为**执行旧入口并提示新写法 |

旧 npm script 全部保留并照旧行为执行；迁移是**旧命令不删、新命令并行**——`amber legacy`（不带参数）
打印完整的旧 → 新对照表，任何一条旧命令都能查到它的新写法。配置分层
**旧 rc < 用户配置 < 项目配置 < 环境变量**（`amber config show` 点名每个值的来源），
新命令不写旧 rc。

## DSH 插件安装

装进 profile 即得四个工具——`amberflow_apps`（列应用）/ `amberflow_run`（跑一个，含 `dry` / `ablate` /
`slots` / `provider` / `headful`；**默认跑真模型**）/ `amberflow_learn`（录制归纳）/ `amberflow_plan`（一句话+种子页→模板+档案），
并且插件行自带**配置页**（只设置线上决策模型 URL / Token Key / ModelName；两个安装门都提供）：

```bash
dsh plugin --profile <名称> add github:Johnly1986/AmberFlow          # 仓库直装（见 README 附注：私有库需凭证）
dsh plugin --profile <名称> add /绝对路径/AmberFlow                  # 开发态 link：仓库根 bundle，插件与引擎同源
dsh plugin --profile <名称> add /绝对路径/AmberFlow/integrations/dsh-bridge   # 只装适配器包（需先 npm run build；引擎由 repoPath 指）
```
配置页在**设置 → 插件 → AmberFlow 桥接 → 组件行 → 配置**（编辑仅限 loopback 页面：经外网打开时页面会
显示说明，请用 Host 本机地址或 SSH 隧道如 `ssh -L 8080:127.0.0.1:3080 <host>`）：三项分别是 `TOKEN_PLAN_ENDPOINT` /
`TOKEN_PLAN_API_KEY` / `TOKEN_PLAN_MODEL`（URL 填兼容模式基址，桥自动补 `/systemone`），URL+Token 齐全时
`amberflow_run` 默认以 `token-plan` 作为决策 provider；留空则继续用本地 ONNX。详见
[integrations/dsh-bridge/README.md](integrations/dsh-bridge/README.md)。
或在插件页面直接添加项目地址。开发态 link 之后**重启一次 DSH 进程**：换安装形态时，运行中的进程
不会自己换掉已加载的桥模块（引擎 CLI 是子进程，倒是立刻用新的）；判据与解释见
[integrations/dsh-bridge/DEVELOPING.md](integrations/dsh-bridge/DEVELOPING.md)。


## 三条硬约束

- **不重规划**——任务开始时冻结成一份计划（有序子目标 + 每步完成信号 + 数据袋），执行器只按计划推进。
- **不发明取值**——要填的值只来自计划的数据袋（`slots`），模型无权产生值。
- **不信模型说"完成"**——子目标完成与否由该步自己的 DOM/URL 信号判定，模型判断仅作记录。

分工原则：**规则先于模型**——计划 `target_hint` 点名目标即零成本解决，规则拿不准才问本地模型，模型也不过confidence闸门才考虑升级（默认不接外部 LLM）。

## 为什么本地还养一个模型

**分工先说清楚**（本轮独立审查的结论，不是口号）：**流程能被规则与声明解决，就不该让模型猜。**
承重的是声明 + 规则 + 编译器/录制器——已验收语料里 **浏览器步 171/171 全由声明解决**
（其中 169 = 98.8% 用 `target_hint` 点名，其余 2 步走 `commands` 闭集；`apps:suite` 页脚每天报这两行数），
真模型跑完整批语料时 **201 步里只被咨询 5 次、独立决定 0 步**
（`npm run apps:suite -- --real-model` 的 `模型边际` 列；桩臂这一列打"未测"）。
模型的位置是**兜底 + 诊断**，而兜底现在有了数字：边际为 0 时套件**退出码 4**，绿色不再替它背书。

那"保险"到底值不值，四组数字，每组都有当场可跑的复现命令：

| 数字 | 它证明什么 | 怎么复现 |
|---|---|---|
| 60 个诱饵元素挡在前面：规则落空 + 目标不在池内 = 必 blocked；模型加宽重看（`laya:reobserve`）把它捞回来 | 池子外的目标谁也选不到——模型负责"不轻言放弃"。**但注意口径**：这是夹具里的能力，已验收语料上 `reobserve` 救回 **0** 步（页脚 `梯级账单` 会把它标成 dead rung） | `npx vitest run tests/reobserve.test.ts` |
| `transfer-slowjet`：冷加载时模型**被问了 5 次、一次都没过闸门**（真模型臂与桩臂同形：`咨询 5 / 过关 0`）；把它救回来的是 `retries`——去掉 `retries` 实测 0/7 | **反面教材（本轮修正）**：以前这里写"没有模型这个应用会红"，实测不成立；红的是没有重试 | `npm run apps:suite -- --only transfer-slowjet`（看页脚 `梯级账单` 与 `模型边际`） |
| 同一份计划二跑：**12 forwards → 0，9.2s → 1.3s**（Windows+GPU 实测；离线口径由套件页脚 `决策缓存` 给同一形状的两个数） | 确定性模型不该被问第二次：本地、免费、可审计 | `npm run cache:measure`（要 ONNX 产物）；离线看套件页脚 |
| 诚实边界：中文页面上模型 0.03–0.09（argmax 常仍正确）；checkpoint 路由按**文字系统**切、绝不按置信度切（ECE 0.855 的教训写进了故事） | 我们比谁都清楚它不行在哪——这是可信度，不是减分 | `npm run apps -- --app ctrip-case --no-sources` |

装不装得模型，跑之前就知道：`npm run doctor` 点名缺哪件（图 / 外置权重 / tokenizer）并给出一条补齐命令
`npm run model:fetch -- --from <url 或本地路径>`（SHA256 先验后换，坏件绝不覆盖现有产物）。
跑完之后，每次运行的结果里都有两行：`model: on|off(missing)` 与"决策来源"一行
（`rule 19 · laya 1 (conf 0.31) · laya:reobserve 1 · cache 命中 6/12 forwards`）——
CLI 报告、`apps:suite` 表格与 DSH 插件 `amberflow_run` 的 summary 念的是**同一份账**。

## 把你的流程固化成应用

一个应用 = 一个目录 `apps/<id>/app.mjs`（**声明式数据脚本**：数据腿 + 旅程（浏览器步 / 命令行工具步）+ 结束状态不变量）。先读 **[应用脚本作者指南](docs/APP_SCRIPT_AUTHORING.md)**（两种形态怎么选、ctx API、错误码、trace/replay、扩展配方）。它只是把数据写成了 JS（`export const meta` + `export const app`），不含控制流；要循环/条件就把 `app` 换成 `export async function flow(ctx)`（见 [apps/README.md](apps/README.md) §九）。**加一个应用不需要改共享层一行代码。**

```bash
npm run apps -- --list                                  # 有哪些应用
amber apps new my-app                                    # 生成可跑骨架（默认 flow；--kind data 声明式）
npm run apps -- --app demo-app                          # 离线整跑一条完整链路
npm run apps -- --app demo-app --dry                    # 只展开计划，不开浏览器
npm run apps -- --app demo-app --headful                # 有头运行：浏览器窗口显形（见「看着浏览器跑」）
npm run apps:suite                                      # 全部离线应用跑完，一行一个给结论
```

### 看着浏览器跑（有头 / 挂载）

| 想要的效果 | 怎么做 |
|---|---|
| 本机弹一个真窗口 | `npm run apps -- --app <id> --headful`；`npm run semantic -- --app <模板> --site <key> --headful`；`npm run plan:flow -- … --headful`；`npm run learn -- --headful` |
| 在**你自己**的浏览器里实时看 | Chrome 带 `--remote-debugging-port=9222` 启动，然后 `npm run learn -- --cdp ws://…`（录制结束只断连，不关你的浏览器）；DSH 里就是 `amberflow_learn` 的 `cdp` 参数 |
| 无显示器的服务器 | 窗口只出现在**跑引擎的那台机器**上：`xvfb-run -a -s "-screen 0 1440x900x24" npm run apps -- --app <id> --headful`，人眼看再配 x11vnc / noVNC；只要证据图就 `ffmpeg -f x11grab -video_size 1440x900 -i $DISPLAY -frames:v 1 win.png` |
| 从 DSH 插件发起 | `amberflow_run` / `amberflow_plan` 传 `headful: true`（窗口同样开在服务器显示上，不在浏览器页面里） |

有头需要**完整 chromium**：只有 headless shell 的机器会直接点名让你 `npx playwright install chromium`。
不传旗标就是原来的 headless 面，行为与产物逐字节不变（实测：有头起 `chromium-*/chrome` 且命令行没有
`--headless`，默认起 `chrome-headless-shell --headless`）。

三类入口，同一个引擎，同一道门槛——**规则模式零模型重放通过，才落盘**：

| 你手上有 | 入口 |
|---|---|
| 一个浏览器 + 会点鼠标 | `npm run learn`——连上你正开着的浏览器（`--cdp`）或给 `--url`，做一遍，信号与不变量自动归纳，你只回 y/n |
| 一份 spec / Excel / 代码里的计划 | `npm run apps:gen -- --spec <key>`（`--check` 可进 CI：改 spec 忘重新生成就会红） |
| 只想手写 | 复制下面的最小 `app.mjs` 起个新目录 |

最小可跑的 `app.mjs`（声明式数据；选择器用仓库自带页面，复制即跑）：

```js
// apps/hello/app.mjs —— 声明式应用：数据 + 旅程 + 结束状态不变量（没有控制流）
export const meta = () => ({
  id: "hello",
  label: "最小离线应用",
  goal: "在门户页进入枪机/筒机录入",
  hosts: [],
  invariants: [
    { id: "on-camera-a", desc: "结束时停在 camera_a 录入页",
      signal: { url_contains: "camera_a.html" } },
  ],
});

export const app = () => ({
  exec: [{
    desc: "点击「枪机 / 筒机 录入」",
    start_url: "testpages/portal.html",
    target_hint: "[data-test=entry-fixed]",
    signal: { url_contains: "camera_a.html" },
  }],
});
```

```bash
npm run apps -- --app hello --out /tmp/hello   # 期望 exit 0 + "结果：**通过**"
```

两条省时间的规则：**浏览器步必须点名得到目标**（`target_hint`，或规则能在元素池里命中）；**`--slot k=v` 的键必须在包里声明过**（打错名字是用法错误，不是静默忽略）。

## 在代码里用

```ts
import { BrowserMiddleware, TaskPlan, runPlan } from "./src/index.ts";

const plan = new TaskPlan("把无线鼠标加入购物车并打开购物车页", [
  { desc: "加入购物车",
    signal: { css_text_equals: ["[data-test=cart-count]", "1"] },   // 完成只认这个信号
    start_url: "https://example.com/product.html",                  // 换成你的页面；pack 层支持仓库相对路径
    target_hint: "[data-test=add-to-cart]" },                       // 点名目标 → 零模型调用
], ".task_plan.json", { /* slots：取值只来自这里 */ });

const rep = await runPlan(new BrowserMiddleware(), plan);
console.log(rep.completed, rep.traces.length);
```

## 命令速查

| 命令 | 一句话 |
|---|---|
| `npm start -- --goal "…" --url <页面>` | 打开页面演示一次 → 归纳信号 → 执行（`--dry-run` 只看计划，`--headful` 显形浏览器） |
| `npm run plan-cli -- --help` | 手工编排：new / add / edit / check / run（支持 `when` 条件跳过、`retries` 整步重试） |
| `npm run verify` | 一键门禁：typecheck + 全部测试 + 六层跨实现对拍 |
| `npm run apps:matrix` | 每个应用的声明成本 / 来源（生成还是手写）/ 站点知识泄漏门禁 |
| `npm run apps -- --app <id> --headful` | 有头运行：看得见浏览器窗口（服务器需 Xvfb/VNC，见「看着浏览器跑」） |
| `npm run bench -- --cases bench/cases-live.json --mode-tag live` | 8 个真实站点跑分（要真网络；跳过不等于通过） |
| `npm run apps -- --help` / `npm run bench -- --help` | 两个入口的完整用法（各自专属旗标只在 `--help` 里列全） |

### apps 与 bench：同一个名字同一件事

两个入口共用一张旗标表（`src/support/cli-args.ts` 的 `SHARED_RUN_OPTIONS`），同一个名字在两个入口是
同一个意思；各自的专属旗标只有"挑什么来跑"那一项——apps 挑**应用包**（`--app`），bench 挑**语料**
（`--cases`）。

| 共用旗标 | 含义 |
|---|---|
| `--model ID` | 换 laya checkpoint（换决策源用 `--provider`；旧名 `--force-model`） |
| `--provider NAME` | 换决策源：`laya-onnx` / `stub` / `none` / 基线 / `jevk5` / `bailian` / `token-plan` |
| `--ablate stub\|rules-only` | 消融臂：`stub` = 脚本桩，`rules-only` = 规则档（旧名 `--no-model`） |
| `--conf-floor N` | 置信度闸门刻度（0<N≤1；旧名 `--force-conf-floor`） |
| `--force-hints off` | 剥掉计划点名的 hint，逼模型出场（消融旗标，只有这一档） |
| `--learn-hints` / `--hint-memory FILE` | R2 学习环：默认 sidecar / 显式落点（旧名 `--hint-memory-file`） |
| `--headful` / `--quiet` / `--out DIR` | 浏览器显形 / 只留机器读的 summary / 产物落点 |

旧名在升级窗口里**仍认**（旧桥、旧脚本抄来的命令不会炸），只是不再列进用法；给错了会得到
**一行点名 + usage + exit 2**，不是 `parseArgs` 的堆栈。

`npm run apps -- --app demo-app` 里那个 `--` 是 npm/shell 的参数分隔符，由每个入口统一吃掉——
Windows 的 shell 会把它原样留给子进程，而留着它的后果是后面所有旗标被当成位置参数（"传了却像没传"）。

## 环境变量（都有兜底，全部可不配）

这些变量也可以写进 **`configs/amberflowrc.json`**（本机文件，已被 `.gitignore` 排除；模板见
[`configs/amberflowrc.example.json`](configs/amberflowrc.example.json) 复制一份、删掉不用的键即可）。
`npm start` 与 `npm run bench` 与 apps/suite 走**同一扇门**选决策源：本地产物就绪→本地；配了
provider（如 `AMBERFLOW_DEFAULT_DECISION_PROVIDER=token-plan`）→在线；都没配→规则档并如实点名缺的是谁
——日常不需要为"这台机器有没有模型"多敲任何旗标。优先级
**CLI 旗标 > 环境变量 > 文件 > 内建缺省**——文件只补没人设过的键。白名单之外的键（比如
`LAYA_TODAY`：展开日期是仓库常量，不该变成机器配置）会在**任何腿出场之前**以用法错误
(exit 2)点名拒绝。`npm run doctor` 会把生效配置连同**每个值的来源**（文件/环境）一起列出，
凭据类（`*_API_KEY` 等）只回显掩码后的长度。实现只有一个模块：`src/support/rcfile.ts`。

| 变量 | 作用 |
|---|---|
| `LAYA_ONNX_MODEL` / `LAYA_TOKENIZER_DIR` | 本地决策模型产物位置（缺了走规则模式） |
| `AMBERFLOW_DECISION_PROVIDER` | 选决策提供者：`laya-onnx`（默认）/ `scripted-stub` / `none` / 基线 / `jevk5` / `bailian` / `token-plan` |
| `TOKEN_PLAN_ENDPOINT` | token-plan MaaS 网关的 SystemOne 端点（完整 URL，要带 `/compatible-mode/v1/systemone`）；**端点只从环境读**（共享层不写死外部主机） |
| `TOKEN_PLAN_API_KEY` | token-plan 的 token（回退 `DASHSCOPE_API_KEY`）；只从环境读，绝不进代码/产物/提交。见 [docs/DECISION_PROVIDER_TOKENPLAN.md](docs/DECISION_PROVIDER_TOKENPLAN.md) |
| `TOKEN_PLAN_MODEL` | 覆盖 token-plan 的决策模型名（默认 `decision-model-preview`） |
| `PLANNER_TIMEOUT` | `plan:flow --planner llm` 的规划调用超时（秒，默认 120；30s 对推理模型+整页快照太紧） |
| `JEVK5_ENDPOINT` | JevK5 的 `/v1/systemone` 地址（`--provider jevk5` 时用；起法见 docs/DECISION_PROVIDER_JEVK5.md） |
| `DASHSCOPE_API_KEY`（别名 `BAILIAN_API_KEY`） | 百炼决策模型的 API token（`--provider bailian` 时用）——**只进环境变量，绝不写进代码/产物/提交** |
| `BAILIAN_ENDPOINT` 或 `BAILIAN_WORKSPACE_ID`(+`BAILIAN_REGION`) | 百炼 systemone 端点（workspace 作用域）；起法见 docs/DECISION_PROVIDER_BAILIAN.md |
| `OPENAI_BASE_URL` + `OPENAI_API_KEY` | 启用 LLM 规划与审计（不配则用内置替身，流程照常） |
| `AMBERFLOW_REPO` | DSH 桥指向的 checkout（旧名 `LAYAWEBUSE_REPO` 仍兼容） |

## 延伸阅读

[ARCHITECTURE.md](ARCHITECTURE.md)（模块结构与实测规则）· [docs/CLI_REDESIGN.md](docs/CLI_REDESIGN.md)（`amber` 入口的分组、旗标归一与退出码契约）· [DECISION_PROVIDER_TOKENPLAN.md](docs/DECISION_PROVIDER_TOKENPLAN.md)（在线决策模型接入与实测账） · [ONLINE_MODEL_TEST_REVIEW.md](docs/ONLINE_MODEL_TEST_REVIEW.md)（用线上模型审查测试：S0 提名 + LLM 真链路） · [NOMINATION_QUESTION_SET_ANALYSIS.md](docs/NOMINATION_QUESTION_SET_ANALYSIS.md)（提名考卷为什么不可解：标签/语料/合同三层偏倚）· [CLAUDE.md](CLAUDE.md)（工程规约）· [apps/INVENTORY.md](apps/INVENTORY.md)（应用清单与"完成"的定义）· [PORTING.md](PORTING.md) / [BACKUP.md](BACKUP.md)（Python 参考实现的迁移与存档）

## License

Apache-2.0
