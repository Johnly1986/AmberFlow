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
- **站点即配置**：取数引擎不含站点知识，站点写在 `<site>/sources/*.json`；另附真实站点可达性 / 抓取探针。
- **Excel 批量入口**：设备录入（按"类型"列路由两套表单）、IP 规划表写入设备网络页。
- **开箱用例**：ctrip（19 子目标 + 独立判分）、transfer（spec 驱动的多站点迁移与消融）、qunar（真实站点
  边界如实记录）、离线夹具 + 8 个真实站点跑分。

## 使用方法

### 1. 装上，然后一条命令开始

```bash
npm ci
npx playwright install chromium
npm start                      # 开箱任务：在仓库自带页面上跑一份真实计划（离线，零配置）
```

`npm start` 会打印每一步是怎么被判定的、结果如何。想先看环境齐不齐：`npm run doctor`
（Node / chromium / 决策模型 / LLM 四项一眼看清，缺什么就给出该跑的命令）。

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

### 4. 常用配置

| 变量 | 作用 |
|---|---|
| `LAYA_ONNX_MODEL` / `LAYA_TOKENIZER_DIR` | 真模型产物与 tokenizer 位置 |
| `OPENAI_BASE_URL` + `OPENAI_API_KEY` | 启用 LLM 规划与审计（不配则用内置替身，全流程照常） |
| `SMOKE_REQUIRE_MODEL=1` | 缺模型产物时让门禁失败，而不是跳过 |
| `CAMERA_ROUTE=type` 或 `model` | 设备录入按"类型"列路由表单，或交给模型判断 |

工程细节（实测规则集、模块结构、移植与等价性对拍）见 [CLAUDE.md](CLAUDE.md)、
[ARCHITECTURE.md](ARCHITECTURE.md)、[PORTING.md](PORTING.md)；Python 参考实现的备份见 [BACKUP.md](BACKUP.md)。
