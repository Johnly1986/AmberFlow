# LayaWebUse

冻结计划的浏览器自动化中间件（TypeScript / Node ≥ 22.6）：**LLM 只规划一次**，执行阶段由本地决策模型
逐步决策，**完成只认 DOM 信号**。装上依赖就能跑，不装模型权重也能跑离线部分。

## 项目目标

执行期间不允许模型自由发挥，三条硬约束：

- **不重规划**：任务开始时冻结成一份计划（有序子目标 + 每步完成信号 + 数据袋），执行器只按计划推进。
- **不发明取值**：要填的值只来自计划的数据袋（`slots`），模型无权产生值。
- **不信模型说"完成"**：子目标是否完成由该步自己的 DOM/URL 信号判定，模型判断只作参考记录。

并让"猜"尽量不发生：**规则先于模型**——计划可直接点名目标，确定映射零成本解决；只有规则无法确定时才问模型，
且要过置信度、风险、可操作性三道闸门。

## 现有功能

- **冻结计划执行**：有序子目标 + 每步完成信号 + 数据袋；JSON 断点续跑；`when` 条件跳过；
  `retries` 整步重试；`target_hints` 一步多目标；`slots` 每步取值。
- **点名目标与规则优先**：计划里的 `target_hint` 命中即按规则解决（零模型调用）；hint 分级匹配
  （精确属性 → 路径末段 → 子串），歧义或匹配不到才回落到模型。
- **完成信号只认 DOM**：五个算子（`url_contains`、`css_exists`、`css_text_equals`、`css_text_contains`、
  `css_value_equals`）+ 组合（`all_of` / `any_of` / `not`）；也可以让一步**演示一次**自动归纳出信号；
  归纳不出来时声明 `{"signal": {"manual": true}}`，由人确认并把人所见状态写进轨迹。
- **决策模型本地跑**：Node 内直接推理，不需要 Python / PyTorch / CUDA；模型不确定时先**加宽一次观察**
  （把更多候选展示给它）再决策，而不是直接判失败；也可以选配一个更强的 LLM 兜底，默认不需要。
- **三条使用路径**：代码内的生产执行器；Path A 固定动作拾取器（命令行）；Path B 本地模型服务 +
  MV3 扩展（页面内 `Ctrl+Shift+K`）。
- **站点即配置**：取数引擎不含站点知识，站点写在 `<site>/sources/*.json`；另附真实站点可达性 / 抓取探针。
- **Excel 批量入口**：设备录入（按"类型"列路由两套表单）、IP 规划表写入设备网络页。
- **开箱用例**：ctrip（19 子目标 + 独立判分）、transfer（spec 驱动的多站点迁移与消融）、qunar（真实站点
  边界如实记录）、离线夹具 + 8 个真实站点跑分。

## 使用方法

### 1. 准备

```bash
npm ci
npx playwright install chromium          # 或者用 PLAYWRIGHT_BROWSERS_PATH 指向已装好的 chromium
```

真模型是可选的：设置 `LAYA_ONNX_MODEL` 与 `LAYA_TOKENIZER_DIR`（默认读 `/tmp/laya_dec.onnx` 与 HuggingFace
缓存；导出方式见 [node-port-poc/README.md](node-port-poc/README.md)）。**没有模型产物也能用**——离线测试照常全绿，
只有需要真模型的步骤会打印 SKIP。

### 2. 跑起来

```bash
node --experimental-strip-types src/long-task.ts      # 最小全链路：规划 → 执行 → 审计
node --experimental-strip-types src/ctrip-task.ts     # 开箱用例：19 个子目标 + 独立判分
npm run plan-cli -- --help                            # 计划管理：new / add / edit / check / run
node --experimental-strip-types src/bench.ts --cases bench/cases-live.json   # 8 个真实站点跑分

npm run verify                                        # 类型检查 + 全部测试
```

本地的 `testpages/` 是随仓库提供的练习页，可以直接拿来做计划与信号实验。

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
