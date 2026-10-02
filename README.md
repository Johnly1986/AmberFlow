# LayaWebUse

冻结计划的浏览器自动化中间件（TypeScript / Node ≥ 22.6）：**LLM 只规划一次**，
执行阶段由本地小模型（laya）逐步决策，**完成只认 DOM 信号**。

## 项目目标

执行期间不允许模型自由发挥，三条硬约束：

- **不重规划**：任务开始时冻结成一份计划（有序子目标 + 每步完成信号 + 数据袋），执行器只按计划推进。
- **不发明取值**：要填的值只来自计划的数据袋（`slots`），模型无权产生值。
- **不信模型说"完成"**：子目标是否完成由该步自己的 DOM/URL 信号判定，模型判断只作参考记录。

并让"猜"尽量不发生：**规则先于模型**——计划可直接点名目标（`target_hint`），确定映射零成本解决；
只有规则无法确定时才问模型，且要过置信度、风险、可操作性三道闸门。

## 现有功能

- **执行引擎**：抽取元素 → 规则/hint → 模型 → 置信度地板 → 风险确认 → 可操作性探测 → 惰性检测 →
  DOM 完成信号；全项目只有这一个执行循环。
- **计划模型**：`when`（不适用则跳过）、`retries`（瞬时失败整步重试）、`target_hints`（一步多目标）、
  `slots`（本步数据袋）、JSON checkpoint 续跑；`PlanningRules` 校验计划合法性。
- **两种语言**：hint（`#id`、`[attr=值]`、`[attr~子串]`、`[near~容器特征]`、裸 token，分级匹配）；
  信号五算子（`url_contains`、`css_exists`、`css_text_equals`、`css_text_contains`、`css_value_equals`）。
- **三条动作路径**：生产执行器；Path A 固定动作拾取器（注入/不可逆/低置信三闸门）；
  Path B 本地模型服务 + MV3 扩展（`Ctrl+Shift+K`）。
- **模型运行时**：Node 内直接跑 ONNX，不需要 Python / PyTorch / CUDA；没有权重时用脚本模型替身，
  离线测试照常全绿。
- **信号可归纳、也可由人作证**：`tools/induce_signal.ts` 让你把一步**演示一次**，它从"前态/后态"编译出
  可判定的完成信号（前态为假 + 后态为真 + 稳定句柄 + 多轮复现才判定为可自动采纳）；归纳不出信号时，
  该步声明 `{"signal": {"manual": true}}`，由人确认，并把"人所看到的状态"写进轨迹。信号语言支持组合
  （`all_of` / `any_of` / `not`），叶子仍是 DOM 事实，因此组合不会放松证据。
- **决策记忆**：laya 是确定性的，同状态同问题重复前向纯属浪费——`withDecisionCache` 按（状态指纹 + 问题指纹）
  精确缓存并可选写 JSONL 决策日志（重试/重规划/续跑/消融都会命中；页面一变即 miss）。实测同一份计划跑两遍：
  第二遍 **0 次前向、9.2s → 1.3s**。
- **犹豫时才找人/找更强的脑子**：本地模型低于置信度地板、且加宽观察也没救回来时，才会调用可选的
  `escalateFn`（内置 `llmEscalator()`）——升级者只能从执行器**已经展示过的候选**里点名一个，发明候选/答不出/端点报错
  一律弃权，流程回到原来的阻塞行为。每步最多一次，只在失败路径付费。
- **看不够就再看一次**：元素池是模型的全部世界，低置信时执行器会**加宽观察一次**（40 → 120 元素）再决策，
  而不是直接判阻塞；命中则在轨迹里记为 `laya:reobserve`（失败路径才付费）。
- **自信度是要被测量的，不是被信任的**：`npm run calibration` 用模型作者自己的 ECE 口径，把历史轨迹变成
  逐切片的可靠性表（动作级 / 任务级两个标签）。实测（关规则、夹具+线上共 80 个模型步）：英文切片平均自信 0.498、
  任务级完成仅 0.314（ECE 0.200），分桶还倒挂（低自信段 95.0% 有效 > 高自信段 88.9%）——把置信度地板从
  0.25 降到 0.10 也**不改变任何结果**（4/8 / 6/11 完全一致），所以这里不设"校准门"。
- **记结果，不只是记决策**：`OutcomeMemory` 记住"哪个元素在这张页面 + 这个子目标上点击无效（惰性）"，
  重试/续跑时不再走进它。键是**精确 url + 子目标**、身份是元素**签名**、一旦有效立即清除、绝不会清空候选池，
  可限界、可落盘。实测（线上关规则 A/B）：机制生效（4 个键 / 8 条签名 / 85 步中 8 步剔除候选、跳过 39 次），
  但成败不变（4/8、6/11 两腿一致），因此**默认关**，用 `--outcome-memory on` 显式开启。
- **站点即配置**：取数引擎不含站点知识，站点写在 `<site>/sources/*.json`；另有可达性/抓取/OTA 探针。
- **开箱用例**：ctrip（19 子目标 + 独立判分 7/7）、transfer（spec 驱动的 6 个复刻站 + 迁移度量 + 消融）、
  qunar（真实站点如实记录边界）、bench（6 个离线夹具 + 8 个真实站点）、Excel 批量（设备录入 / IP 规划表）。
- **门禁**：529 个测试 + 六层跨实现对拍；`npm run verify` 与 `bash bench/smoke.sh`。

## 使用方法

**环境**：Node ≥ 22.6；chromium（`npx playwright install chromium`，或 `PLAYWRIGHT_BROWSERS_PATH`）；
真模型需要 ONNX 产物 + tokenizer（默认 `/tmp/laya_dec.onnx` 与 HF 缓存，导出见 `node-port-poc/README.md`）——
没有产物也能用：离线测试全绿，只有 bench/用例端到端打印 SKIP。

```bash
npm ci
npm run verify          # 类型检查 + 529 测试 + 六层对拍（不需要模型权重）
bash bench/smoke.sh     # CI 的"绿色"定义；缺 ONNX 产物时模型侧三步打印 SKIP
```

| 想做什么 | 命令 |
|---|---|
| 冻结计划跑分（离线夹具 / 8 个真实站点） | `npm run bench:fixtures` · `src/bench.ts --cases bench/cases-live.json` |
| 三个用例（ctrip / transfer / qunar） | `src/ctrip-task.ts` · `src/transfer-task.ts --site skybook [--metrics-only] [--no-when]` · `src/qunar-task.ts` |
| 真实取数与探针 | `src/datasource.ts --list` · `--source ctrip-flights-h5` · `src/h5-flights.ts` · `src/live-probe.ts` · `src/live-capture.ts` · `src/ota-probe.ts` |
| 归纳完成信号（演示一次） | `node --experimental-strip-types tools/induce_signal.ts --url testpages/product.html --click "[data-test=add-to-cart]" --replays 2` |
| Excel 批量 | `src/camera-entry.ts`（类型列路由两套表单）· `src/ip-config.ts`（IP 规划表写进设备页） |
| 归纳完成信号（演示一次） | `tools/induce_signal.ts --url <page> --click <hint> --replays 2` |
| 看模型自信度准不准（切片 ECE） | `npm run calibration -- bench/results/live-*.json` |
| 量化决策缓存收益 | `npm run cache:measure -- shop-add-coupon asset-bullet-zh` |
| 计划管理 / Path A / Path B | `npm run plan-cli -- --help` · `src/path-a.ts [--confirm-safe]` · `src/picker-server.ts` + 加载 `extension/` |
| 演示 | `src/long-task.ts`（规划→执行→审计）· `npm run shortlist`（真模型） |

表中 `src/…` 一律用 `node --experimental-strip-types src/…ts` 运行；各入口都支持 `--help`，
文件头注释写明它对应哪条设计规则。

**关键配置**：`LAYA_ONNX_MODEL`、`LAYA_TOKENIZER_DIR`、`OPENAI_BASE_URL` + `OPENAI_API_KEY`（启用 LLM
规划与审计）、`SMOKE_REQUIRE_MODEL=1`（缺模型产物时让门禁失败而不是跳过）、`CAMERA_ROUTE=type|model`。

**在代码里用**（本示例由 `tests/readme-example.test.ts` 实跑）：

```ts
import { BrowserMiddleware, TaskPlan, runPlan } from "./src/index.ts";
import { installLayaRuntime } from "./src/model.ts";
import { createLayaOnnxRuntime } from "./src/laya-onnx.ts";

installLayaRuntime(createLayaOnnxRuntime());   // 真模型；离线跑用 installLayaRuntime(scriptedRuntime(...))

const plan = new TaskPlan(
  "在示例商店把无线鼠标加入购物车并打开购物车页",
  [
    { desc: "把 Wireless Mouse X200 加入购物车",
      signal: { css_text_equals: ["[data-test=cart-count]", "1"] },  // 完成只认这个 DOM 信号
      start_url: "https://example.com/product.html",
      target_hint: "[data-test=add-to-cart]" },                      // 点名目标 → 规则解决，零模型调用
    { desc: "打开购物车页",
      signal: { url_contains: "cart.html" },
      start_url: "https://example.com/product.html",
      target_hint: "[data-test=cart-link]" },
  ],
  ".task_state.json",                                                // JSON checkpoint（可续跑）
  {},                                                                // 数据袋：只有这里能提供要填的值
);

// 一个会话跑完整份计划：hint / slots / when / retries 由 runPlan 按子目标自动带上
const mw = new BrowserMiddleware({ confirmFn: () => true });          // 不可逆动作先问人，这里全放行
const rep = await runPlan(mw, plan, { startUrl: plan.subgoals[0]!.start_url! });
console.log(rep.completed, rep.plan.summary(), rep.traces.length);
```

只跑单个子目标用 `runSubgoalWithRetries(mw, sg, plan, url, page, pw)`（同样自动带 hint 与重试）；
直接 `mw.run(desc, url, { goalSignalFn, slots, targetHint })` 也可以，但**单步调用不会自动读计划里的
`target_hint`，必须自己传**。

移植过程与等价性对拍见 [PORTING.md](PORTING.md)；实测规则集见 [CLAUDE.md](CLAUDE.md)；
Python 参考实现的备份见 [BACKUP.md](BACKUP.md)。
