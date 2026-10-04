# LayaWebUse

冻结计划的浏览器自动化中间件（TypeScript / Node ≥ 22.6）：**LLM 只规划一次**，执行阶段由本地决策模型
逐步决策，**完成只认 DOM 信号**。

```bash
npm ci && npx playwright install chromium
npm start        # 一条命令跑起一项真实工作（仓库自带页面，离线，零配置）
```

没有模型权重也能跑：计划点名了目标的步骤由规则解决，需要模型兜底的步骤会明确告诉你。

## 项目目标

执行期间不允许模型自由发挥，三条硬约束：

- **不重规划**：任务开始时冻结成一份计划（有序子目标 + 每步完成信号 + 数据袋），执行器只按计划推进。
- **不发明取值**：要填的值只来自计划的数据袋（`slots`），模型无权产生值。
- **不信模型说"完成"**：子目标是否完成由该步自己的 DOM/URL 信号判定，模型判断只作参考记录。

并让"猜"尽量不发生：**规则先于模型**——计划可直接点名目标，确定映射零成本解决；只有规则无法确定时才问模型，
且要过置信度、风险、可操作性三道闸门。

## 现有功能

- **一条命令开始**：`npm start` 在仓库自带页面上跑一份真实计划（离线、零配置）；`npm run doctor` 体检
  Node / chromium / 决策模型 / LLM；换成自己的页面也是一条命令——打开页面**演示一次**，自动归纳完成信号、
  点名目标、写入计划并执行，不需要手写计划 JSON。
- **没有模型权重也能跑（规则模式）**：计划点名了目标的步骤由规则解决、不碰模型；确实需要模型兜底的步骤会
  明确说明原因，而不是抛异常或瞎猜。
- **冻结计划执行**：有序子目标 + 每步完成信号 + 数据袋；JSON 断点续跑；`when` 条件跳过；
  `retries` 整步重试；`target_hints` 一步多目标；`slots` 每步取值。
- **点名目标与规则优先**：计划里的 `target_hint` 命中即按规则解决（零模型调用）；hint 分级匹配
  （精确属性 → 路径末段 → 子串），歧义或匹配不到才回落到模型。
- **完成信号只认 DOM**：五个算子（`url_contains`、`css_exists`、`css_text_equals`、`css_text_contains`、
  `css_value_equals`）+ 组合（`all_of` / `any_of` / `not`）；也可以让一步**演示一次**自动归纳出信号；
  归纳不出来时声明 `{"signal": {"manual": true}}`，由人确认并把人所见状态写进轨迹。
- **决策模型本地跑**：Node 内直接推理，不需要 Python / PyTorch / CUDA；模型不确定时先**加宽一次观察**
  （把更多候选展示给它）再决策，而不是直接判失败；确需兜底时可接一个更强的 LLM（默认不接）。
- **三条使用路径**：代码内的生产执行器；Path A 固定动作拾取器（命令行）；Path B 本地模型服务 +
  MV3 扩展（页面内 `Ctrl+Shift+K`）。
- **应用层：一个应用是一个目录**：`apps/<id>/pack.json` 声明数据腿 + 混合旅程（浏览器步/工具步）+ 结束状态
  不变量，一条命令跑完；加一个应用**不需要改共享层一行代码**。清单与"完成一个应用"的五条定义见
  [apps/INVENTORY.md](apps/INVENTORY.md)，怎么加见 [apps/README.md](apps/README.md)。
- **站点即配置**：取数引擎不含站点知识，站点写在 `<site>/sources/*.json`；另附真实站点可达性 / 抓取探针。
- **Excel 批量入口**：设备录入（按"类型"列路由两套表单）、IP 规划表写入设备网络页。
- **开箱用例**：ctrip（19 子目标 + 独立判分）、transfer（spec 驱动的多站点迁移与消融）、qunar（真实站点
  边界如实记录）、离线夹具 + 8 个真实站点跑分。

## 使用方法

### 1. 装上，然后一条命令开始

```bash
npm ci
npx playwright install chromium
npm start                      # 开箱任务：在仓库自带页面上跑一份真实计划（离线，不需要再配置什么）
```

`npm start` 会打印每一步是怎么被判定的、结果如何。想先看环境齐不齐：`npm run doctor`
（Node / chromium / 决策模型 / LLM 四项一眼看清，缺什么就给出该跑的命令）。

> **它会写一个文件**：`npm start` 默认把计划检查点写进仓库根目录的 `.task_plan.json`（所以跑完
> `git status` 会看到这一处改动，最后一行会明确打印这个路径）。不想动工作区就加 `--plan /tmp/your-plan.json`。
> 仓库里还有 `.task_state.json`，那只是 §3 代码示例里显式传的文件名；`plan-cli` 与 `npm start` 用的是
> `.task_plan.json`。

**模型权重是可选的**：没有权重时进入"规则模式"——计划点名了目标的步骤照样执行
（`npm start` 的开箱任务全部如此），只有确实需要模型兜底的步骤会明确告诉你需要什么，而不是抛异常。

### 2. 做你自己的事：也是一条命令

```bash
npm start -- --goal "把商品加入购物车" --url https://shop.example.com/p/1
```

它会：打开页面 → **演示一次**（在你点名的目标上执行一次动作）→ 从"前态/后态"**编译出完成信号**
（不让你去猜页面做完之后长什么样）→ 把目标的稳定句柄写进计划 → 保存计划 → 直接执行。

常用开关：`--target '[data-test=add-to-cart]'`（显式点名目标，适合页面非中文或语义不直观时）、
`--dry-run`（只生成计划不执行）、`--headful`（显示浏览器窗口）、`--plan <文件>`（计划保存位置）。

做多步任务、或者想手工编排计划：

```bash
npm run plan-cli -- --help                         # new / add / edit / check / run
npm run plan-cli -- add 1 "打开购物车页" --signal 'url_contains=cart.html' --url <页面>
npm run plan-cli -- run --replan                   # 跑（阻塞时可让 LLM 重新规划）
node --experimental-strip-types tools/induce_signal.ts --url <页面> --click '[data-test=add-to-cart]' --replays 2
```

### 3. 在代码里用

```ts
import { BrowserMiddleware, TaskPlan, runPlan } from "./src/index.ts";
import { installLayaRuntime } from "./src/model.ts";
import { createLayaOnnxRuntime } from "./src/laya-onnx.ts";

installLayaRuntime(createLayaOnnxRuntime());            // 真模型；离线可换成 scriptedRuntime(...)

const plan = new TaskPlan(
  "在示例商店把无线鼠标加入购物车并打开购物车页",
  [
    { desc: "把 Wireless Mouse X200 加入购物车",
      signal: { css_text_equals: ["[data-test=cart-count]", "1"] },   // 完成只认这个 DOM 信号
      start_url: "https://example.com/product.html",
      target_hint: "[data-test=add-to-cart]" },                       // 点名目标 → 零模型调用
    { desc: "打开购物车页",
      signal: { url_contains: "cart.html" },
      start_url: "https://example.com/product.html",
      target_hint: "[data-test=cart-link]" },
  ],
  ".task_state.json",                                   // JSON 断点，可续跑
  {},                                                   // 数据袋：只有这里能提供要填的值
);

const mw = new BrowserMiddleware({ confirmFn: () => true });  // 不可逆动作先问人；这里全放行
const rep = await runPlan(mw, plan, { startUrl: plan.subgoals[0]!.start_url! });
console.log(rep.completed, rep.plan.summary(), rep.traces.length);
```

只跑单个子目标用 `runSubgoalWithRetries(mw, sg, plan, url, page, pw)`（自动带上计划里的 hint 与重试）；
直接 `mw.run(desc, url, { goalSignalFn, slots, targetHint })` 也可以，但**单步调用不会自动读计划里的
`target_hint`，需要自己传**。

### 4. 应用层：把一件事写成一个目录

一个应用 = `apps/<id>/pack.json`（纯数据）：数据腿 + 混合旅程（浏览器步 / 工具步）+ 结束状态不变量。
加一个应用**不需要改共享层代码**。

```bash
npm run apps -- --list                                  # 有哪些应用
npm run apps -- --app demo-app --dry                    # 只展开计划（不开浏览器、不装模型）
npm run apps -- --app demo-app --no-model               # 离线整跑（数据腿 → 旅程 → 不变量）
npm run apps -- --app repo-report --no-model            # 真实工具：git + jq
npm run apps -- --app cli-report --no-model             # 危险步：默认**未执行**（exit 1）
npm run apps -- --app cli-report --no-model --allow-dangerous   # 放行后真跑

npm run apps:suite                                      # 一条命令跑完所有离线旅程应用并给结论表
npm run apps:matrix                                     # 声明成本 / 代码行数 / 泄漏门禁 / 这个包是生成的还是手写的
npm run apps:gen -- --check                             # 生成的包与 spec 展开是否一致（改 spec 没重新生成就红）
```

**流程不用手写**：`npm run apps:gen -- --write --id <app> --spec <key>` 从一个 spec 生成/刷新整个应用包
（旅程逐字段等于 `emitPlan(spec)` 的展开结果，包里记着展开内容的 `plan_sha256`；改 spec 忘了重新生成、
或有人手改了 `journey`，`--check` 都会变红）。当前 7 个应用是**生成**的（6 个 transfer 复刻站 + ctrip-case），
`apps:matrix` 的"来源"列会标出来。生成器**不发明判断**：`invariants`（什么必须成立）与 `notes` 是人的部分，
它只搬运；缺 `invariants` 时会明说而不是给一个空壳。

`apps:suite` 的**退出码契约**（写进 `--help` 与 [apps/README.md](apps/README.md)）：

| 码 | 含义 |
|---|---|
| `0` | 每个离线旅程应用都**真执行**且通过 |
| `1` | 有未通过（含"加载失败"——坏包只影响它自己那一行） |
| `2` | 用法错误（例如 `--only` 没匹配到任何应用；会列出已知应用名） |
| `3` | 有**未执行**（危险步没放行：不算绿，也不算红） |

线上应用（`start_url` 是 `http(s)`）与测量型应用会被**明着跳过**并注明"要真网络"——跳过不等于通过。

**最小可跑的应用**（复制成一个新目录 `apps/hello/pack.json` 就能跑；选择器取自仓库自带的
`testpages/portal.html`）：

```json
{
  "spec_version": 1,
  "id": "hello",
  "label": "最小离线应用",
  "goal": "在门户页进入枪机/筒机录入",
  "model": "english",
  "max_subgoals": 4,
  "hosts": [],
  "slots": {},
  "required_slots": [],
  "sources": [],
  "roles": {
    "open-portal": {
      "desc": "点击「枪机 / 筒机 录入」",
      "start_url": "testpages/portal.html",
      "target_hints": ["[data-test=entry-fixed]"],
      "signal": { "url_contains": "camera_a.html" }
    }
  },
  "journey": [{ "role": "open-portal" }],
  "invariants": [
    { "id": "on-camera-a", "desc": "结束时停在 camera_a 录入页",
      "signal": { "url_contains": "camera_a.html" } }
  ]
}
```

```bash
npm run apps -- --app hello --no-model --out /tmp/hello     # 期望 exit 0 + "结果：**通过**"
```

两条**文档没说但会咬人**的规则，这里一次说清：

1. **浏览器步必须有一个能点到的目标**：给它 `target_hint` / `target_hints`（计划点名 → 零模型调用），
   或者确保规则/laya 能在元素池里命中一个元素。缺了会 `blocked`，报错会直说
   `step N names no target: no target_hint(s), no rule matched any of the K element(s)…`。
2. **`--slot k=v` 的键必须在包里声明过**（`slots` / `required_slots`）。打错名字不再是静默忽略，
   而是 exit 2 并列出已声明的槽位。

### 5. 开箱用例：每条都有可复制命令

```bash
node --experimental-strip-types src/ctrip-task.ts            # 携程用例：19 冻结子目标 + 独立判分 7/7
node --experimental-strip-types src/transfer-task.ts --site skybook
node --experimental-strip-types src/qunar-task.ts            # qunar 真实站点（边界已实测记录）
npm run test:parity                                          # 六层跨实现对拍（冻结语料）
npm run verify                                               # 一键门禁：typecheck + 全部测试 + 对拍
npm run bench -- --cases bench/cases-live.json --mode-tag live   # 8 个真实站点跑分（要真网络）
```

### 6. 常用配置

| 变量 | 作用 |
|---|---|
| `LAYA_ONNX_MODEL` / `LAYA_TOKENIZER_DIR` | 真模型产物与 tokenizer 位置 |
| `OPENAI_BASE_URL` + `OPENAI_API_KEY` | 启用 LLM 规划与审计（不配则用内置替身，全流程照常） |
| `SMOKE_REQUIRE_MODEL=1` | 缺模型产物时让门禁失败，而不是跳过 |
| `CAMERA_ROUTE=type` 或 `model` | 设备录入按"类型"列路由表单，或交给模型判断 |

工程细节（实测规则集、模块结构、移植与等价性对拍）见 [CLAUDE.md](CLAUDE.md)、
[ARCHITECTURE.md](ARCHITECTURE.md)、[PORTING.md](PORTING.md)；Python 参考实现的备份见 [BACKUP.md](BACKUP.md)。
