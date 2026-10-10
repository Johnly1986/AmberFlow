# AmberFlow

> **冻结计划的浏览器自动化中间件**（TypeScript / Node ≥ 22.6）：LLM 只规划一次，执行由本地规则与决策模型逐步完成，**成功与否只认 DOM 信号**——把网页流程凝成琥珀，演示一次，重放永远。（曾用名 LayaWebUse；"Laya" 保留为本地决策模型的姓。）

## 30 秒跑起来

```bash
npm ci && npx playwright install chromium
npm start          # 在仓库自带页面上跑一份真实计划：离线、零配置
npm run doctor     # 环境体检：Node / chromium / 决策模型 / LLM，缺什么给什么命令
```

成功的样子（`npm start` 会逐步打印判定依据，最后一行是结论）：

```
step 1: click a "Add to cart" (clicked, rule:match, conf=1.00)
结果：2/2   步骤 2   跳过 0   重试 0
```

> `npm start` 会把计划检查点写进仓库根 `.task_plan.json`（跑完 `git status` 会看到它）；不想动工作区就加 `--plan /tmp/my-plan.json`。

没有模型权重也能跑：计划点名了目标的步骤由**规则**解决；确实需要模型兜底的步骤会明确说明缺什么，而不是瞎猜或抛异常。

## 三条硬约束（为什么可信）

- **不重规划**——任务开始时冻结成一份计划（有序子目标 + 每步完成信号 + 数据袋），执行器只按计划推进。
- **不发明取值**——要填的值只来自计划的数据袋（`slots`），模型无权产生值。
- **不信模型说"完成"**——子目标完成与否由该步自己的 DOM/URL 信号判定，模型判断仅作记录。

分工原则：**规则先于模型**——计划 `target_hint` 点名目标即零成本解决，规则拿不准才问本地模型，模型也不过confidence闸门才考虑升级（默认不接外部 LLM）。

## 把你的流程固化成应用

一个应用 = 一个目录 `apps/<id>/pack.json`（纯数据）：数据腿 + 旅程（浏览器步 / 命令行工具步）+ 结束状态不变量。**加一个应用不需要改共享层一行代码。**

```bash
npm run apps -- --list                                  # 有哪些应用
npm run apps -- --app demo-app --no-model               # 离线整跑一条完整链路
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
npm run apps -- --app hello --no-model --out /tmp/hello   # 期望 exit 0 + "结果：**通过**"
```

两条省时间的规则：**浏览器步必须点名得到目标**（`target_hint`，或规则能在元素池里命中）；**`--slot k=v` 的键必须在包里声明过**（打错名字是用法错误，不是静默忽略）。

## 在 DSH 会话里用（插件）

装进 profile 即得三个工具——`amberflow_apps`（列应用）/ `amberflow_run`（跑一个，含 `dry` / `no_model` / `slots`）/ `amberflow_learn`（录制归纳）：

```bash
dsh plugin --profile <名称> add github:Johnly1986/AmberFlow          # 仓库直装（见 README 附注：私有库需凭证）
dsh plugin --profile <名称> add /绝对路径/AmberFlow/integrations/dsh-bridge   # 开发态 link
```

桥不做任何浏览器逻辑——它调用本仓库的 CLI 并如实汇总产物。详见 [integrations/dsh-bridge/README.md](integrations/dsh-bridge/README.md)。

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
| `OPENAI_BASE_URL` + `OPENAI_API_KEY` | 启用 LLM 规划与审计（不配则用内置替身，流程照常） |
| `AMBERFLOW_REPO` | DSH 桥指向的 checkout（旧名 `LAYAWEBUSE_REPO` 仍兼容） |

## 延伸阅读

[ARCHITECTURE.md](ARCHITECTURE.md)（模块结构与实测规则）· [CLAUDE.md](CLAUDE.md)（工程规约）· [apps/INVENTORY.md](apps/INVENTORY.md)（应用清单与"完成"的定义）· [PORTING.md](PORTING.md) / [BACKUP.md](BACKUP.md)（Python 参考实现的迁移与存档）

## License

Apache-2.0
