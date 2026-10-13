# AmberFlow

> **冻结计划的浏览器自动化中间件**（TypeScript / Node ≥ 22.6）：LLM 只规划一次，执行由本地规则与决策模型逐步完成，演示一次后既可端侧执行，也可以手动规划。
>
> 规则保证可复现，Laya 保证不轻言放弃，信号保证不作弊。

## 安装运行

```bash
npm ci && npx playwright install chromium
npm start          # 在仓库自带页面上跑一份真实计划：离线、零配置
npm run doctor     # 环境体检：Node / chromium / 决策模型 / 可选 provider / LLM，缺什么给什么命令
npm run apps -- --app ctrip-case --provider coin-flip   # 换决策模型跑（laya-onnx|scripted-stub|none|基线|自注册）
npm run providers:baseline   # 决策提供者对照台：零智能基线 first-candidate 是任何新模型要赢的线
```

成功的样子（`npm start` 会逐步打印判定依据，最后一行是结论）：

```
step 1: click a "Add to cart" (clicked, rule:match, conf=1.00)
结果：2/2   步骤 2   跳过 0   重试 0
```

> `npm start` 会把计划检查点写进仓库根 `.task_plan.json`（跑完 `git status` 会看到它）；不想动工作区就加 `--plan /tmp/my-plan.json`。

没有模型权重也能跑：计划点名了目标的步骤由**规则**解决；确实需要模型兜底的步骤会明确说明缺什么，而不是瞎猜或抛异常。

## DSH 插件安装

装进 profile 即得三个工具——`amberflow_apps`（列应用）/ `amberflow_run`（跑一个，含 `dry` / `ablate` / `slots`；**默认跑真模型**）/ `amberflow_learn`（录制归纳）：

```bash
dsh plugin --profile <名称> add github:Johnly1986/AmberFlow          # 仓库直装（见 README 附注：私有库需凭证）
dsh plugin --profile <名称> add /绝对路径/AmberFlow                  # 开发态 link：仓库根 bundle，插件与引擎同源
dsh plugin --profile <名称> add /绝对路径/AmberFlow/integrations/dsh-bridge   # 只装适配器包（引擎由 repoPath 指）
```
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
| 诚实边界：中文页面上模型 0.03–0.09（argmax 常仍正确）；checkpoint 路由按**文字系统**切、绝不按置信度切（ECE 0.855 的教训写进了故事） | 我们比谁都清楚它不行在哪——这是可信度，不是减分 | `node --experimental-strip-types src/ctrip-task.ts --no-hints` |

装不装得模型，跑之前就知道：`npm run doctor` 点名缺哪件（图 / 外置权重 / tokenizer）并给出一条补齐命令
`npm run model:fetch -- --from <url 或本地路径>`（SHA256 先验后换，坏件绝不覆盖现有产物）。
跑完之后，每次运行的结果里都有两行：`model: on|off(missing)` 与"决策来源"一行
（`rule 19 · laya 1 (conf 0.31) · laya:reobserve 1 · cache 命中 6/12 forwards`）——
CLI 报告、`apps:suite` 表格与 DSH 插件 `amberflow_run` 的 summary 念的是**同一份账**。

## 把你的流程固化成应用

一个应用 = 一个目录 `apps/<id>/pack.json`（纯数据）：数据腿 + 旅程（浏览器步 / 命令行工具步）+ 结束状态不变量。**加一个应用不需要改共享层一行代码。**

```bash
npm run apps -- --list                                  # 有哪些应用
npm run apps -- --app demo-app               # 离线整跑一条完整链路
npm run apps -- --app demo-app --dry                    # 只展开计划，不开浏览器
npm run apps:suite                                      # 全部离线应用跑完，一行一个给结论
```

三类入口，同一个引擎，同一道门槛——**规则模式零模型重放通过，才落盘**：

| 你手上有 | 入口 |
|---|---|
| 一个浏览器 + 会点鼠标 | `npm run learn`——连上你正开着的浏览器（`--cdp`）或给 `--url`，做一遍，信号与不变量自动归纳，你只回 y/n |
| 一份 spec / Excel / 代码里的计划 | `npm run apps:gen -- --spec <key>`（`--check` 可进 CI：改 spec 忘重新生成就会红） |
| 只想手写 | 复制下面的最小 `pack.json` 起个新目录 |

最小可跑的 `pack.json`（选择器用仓库自带页面，复制即跑）：

```json
{
  "spec_version": 1,
  "id": "hello",
  "label": "最小离线应用",
  "goal": "在门户页进入枪机/筒机录入",
  "journey": [{
    "desc": "点击「枪机 / 筒机 录入」",
    "start_url": "testpages/portal.html",
    "target_hint": "[data-test=entry-fixed]",
    "signal": { "url_contains": "camera_a.html" }
  }],
  "invariants": [
    { "id": "on-camera-a", "desc": "结束时停在 camera_a 录入页",
      "signal": { "url_contains": "camera_a.html" } }
  ]
}
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
| `npm run bench -- --cases bench/cases-live.json --mode-tag live` | 8 个真实站点跑分（要真网络；跳过不等于通过） |

## 环境变量（都有兜底，全部可不配）

| 变量 | 作用 |
|---|---|
| `LAYA_ONNX_MODEL` / `LAYA_TOKENIZER_DIR` | 本地决策模型产物位置（缺了走规则模式） |
| `AMBERFLOW_DECISION_PROVIDER` | 选决策提供者：`laya-onnx`（默认）/ `scripted-stub` / `none` / 基线 / `jevk5` |
| `JEVK5_ENDPOINT` | JevK5 的 `/v1/systemone` 地址（`--provider jevk5` 时用；起法见 docs/DECISION_PROVIDER_JEVK5.md） |
| `OPENAI_BASE_URL` + `OPENAI_API_KEY` | 启用 LLM 规划与审计（不配则用内置替身，流程照常） |
| `AMBERFLOW_REPO` | DSH 桥指向的 checkout（旧名 `LAYAWEBUSE_REPO` 仍兼容） |

## 延伸阅读

[ARCHITECTURE.md](ARCHITECTURE.md)（模块结构与实测规则）· [CLAUDE.md](CLAUDE.md)（工程规约）· [apps/INVENTORY.md](apps/INVENTORY.md)（应用清单与"完成"的定义）· [PORTING.md](PORTING.md) / [BACKUP.md](BACKUP.md)（Python 参考实现的迁移与存档）

## License

Apache-2.0
