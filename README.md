# LayaWebUse

冻结计划的浏览器自动化中间件（TypeScript 实现，运行在 Node ≥ 22.6 上）：**LLM 只规划一次**，
执行阶段由本地小模型（laya）逐步决策，**完成只认 DOM 信号**。

## 项目目标

浏览器自动化最常见的事故不是"点错了"，而是**模型在执行过程中自由发挥**：临时改计划、
凭空编造要填的值、自称"已完成"。本项目把这三种风险从执行路径里移除：

- **绝不重规划**：整个任务在开始时冻结成一份计划（有序子目标 + 每步的完成信号 + 数据袋），
  执行器只按计划逐步推进，不会中途发明新步骤。
- **绝不发明取值**：需要填写的值只来自计划的数据袋（`slots`），模型无权产生值。
- **绝不信模型说"完成"**：子目标是否完成由该步自己的 DOM/URL 信号判定；模型的判断只作参考记录。

在此基础上，把"猜"的成本压到最低：**先规则、后模型**——计划可以直接点名目标（`target_hint`），
确定性的映射（href / label / data-test）由规则层零成本解决；只有规则无法确定时才问本地模型，
并且过置信度闸门、风险闸门与可操作性探测。

## 现有功能

### 1. 冻结计划执行引擎

- **单执行循环**：抽取交互元素 → 规则/计划点名的 hint → 否则问 laya → 置信度地板 → 风险闸门
  （不可逆动作先问人）→ 可操作性探测 → 执行 → 惰性检测（页面无变化即判无效并禁用该元素）→
  DOM 完成信号判定。整个项目只有这一个执行器循环。
- **hint 语法与分级匹配**：`#id`、`tag[attr=value]`、`tag[attr~子串]`、`tag[near~容器特征]`、裸 token；
  同层多命中且彼此不同则交回模型，不做赌博式选择。
- **信号语言**（五种算子）：`url_contains` / `css_exists` / `css_text_equals` /
  `css_text_contains` / `css_value_equals`，同时用于"这步是否完成"与"这步是否适用"。
- **计划模型**：`PlanningRules` 校验（子目标数、必须有信号/起始 URL、禁用词等）+ `TaskPlan`
  JSON 落盘与续跑；支持 `when`（条件步骤：不满足则跳过而非失败）、`retries`（瞬时失败整步重试）、
  `target_hints`（一步内按顺序命中多个目标）、`slots`（本步自己的数据袋）。
- **元素视图**：一次 JS 扫描覆盖主框架与同源子框架，穿透 open shadow root，处理 iframe 命名空间；
  被元素预算挤出的计划点名目标会用 JS 二次回捞（hint 回捞）。
- **审计**：每步轨迹可由 Mock 审计器或 LLM 审计器复核（`OPENAI_*` 配置后自动启用 LLM）。

### 2. 三条动作路径

| 路径 | 用途 |
|---|---|
| 生产执行器 `BrowserMiddleware` | 冻结计划逐步执行（上面全部机制） |
| Path A `path-a.ts` | 固定动作集拾取器：对当前页面状态给出一个动作，三道闸门（注入 / 不可逆 / 低置信）；`--confirm-safe` 模拟用户确认 |
| Path B `picker-server.ts` + `extension/` | 本地模型服务（`node:http`，零第三方依赖）+ MV3 扩展：`Ctrl+Shift+K` 或 `laya-trigger` 事件触发，面板展示候选动作 |

### 3. 模型运行时

- **ONNX 运行时**：在 Node 内直接跑 laya 的 encoder + 决策头（`onnxruntime-node` +
  `tokenizer.json`），**不需要 Python、PyTorch 或 CUDA**；支持英文与多语言 checkpoint、路由、
  温度分桶、shortlist（标签数超过 k 时先筛后判）。
- **脚本模型替身**：`installLayaRuntime(scriptedRuntime(...))` 让全部离线测试无需 1.7GB 权重即可运行；
  真模型缺失时相关测试自动跳过而不是失败。

### 4. 取数与站点配置

- **通用取数引擎** `datasource.ts`：传输层（curl / httpx）、两种抽取器（`json_in_script` /
  `html_regex`）、极小的路径语言与操作符、配置驱动的计数/筛选/审计/报告；**引擎本身不含任何站点知识**，
  站点全部写在 `<site>/sources/*.json`（URL 模板、日期表达式、字段路径、时间窗、选择规则、报告列）。
- **网络探针**：`live-probe.ts`（多客户端 × 设备 × 区域可达性矩阵）、`live-capture.ts`
  （四判决：captured / blocked / login_required / unreachable）、`ota-probe.ts`（多家 OTA 对比）、
  `h5-flights.ts`（curl-only 取真实票价）、`profiles.ts`（站点配置清单）。

### 5. 用例与场景（都可直接跑）

| 场景 | 内容 |
|---|---|
| **ctrip 用例** | 复刻站 + 19 个冻结子目标 + **独立判分**（判分只看记录，不看页面）→ 7/7 |
| **transfer 迁移用例** | 同一套流程用 JSON spec 驱动，跑在 6 个刻意不同的复刻站上，输出迁移度量（哪些字段必须改写、多出哪些角色、形状是否改变）；含 `--no-when` / `--no-retries` 消融 |
| **qunar 真实站点** | ctrip 骨架迁到真实站点：可自动化的部分全部自动，数据腿被客户端指纹拦住的部分**如实记为边界** |
| **bench 冻结计划矩阵** | 6 个离线夹具用例（走生产执行器循环 + 真 ONNX）+ 8 个真实站点用例（Wikipedia 英/中、Hacker News、python.org、BBC、books/quotes.toscrape、Polymer shadow DOM 商店） |
| **Excel 批量** | `camera-entry.ts`（按表格"类型"列路由到两套设备录入表单）、`ip-config.ts`（IP 规划表逐台写进设备网络页，被设备页校验拒绝的行如实报 REJECTED） |
| **演示与小工具** | `long-task.ts`（规划 → 执行 → 审计全链路）、`plan-cli.ts`（计划 CRUD + 运行 + 重规划）、`tune-guard.ts`（注入闸门措辞分离度实测）、`shortlist_demo.ts`（真模型 shortlist） |

### 6. 测试与门禁

- **474 个测试**：仓库不变量、提取、规则、信号、计划、执行器（真浏览器）、模型运行时、取数引擎、
  三个用例、扩展端到端（真 chromium + MV3 + 本地服务）。
- **六层跨实现对拍**：规则 57 例、提取 6 夹具逐元素、执行器 4 场景、datasource 163 项、
  ctrip 10 项（含逐字节）、transfer 67 项（含 6 站 dumpJs 逐字节）——期望值由独立参考实现生成并入库。
- **两条命令**：`npm run verify`（类型检查 + 全部测试 + 六层对拍）、
  `bash bench/smoke.sh`（CI 的唯一定义：再加真模型的夹具矩阵与两个用例端到端）。

## 使用方法

### 环境要求

- **Node ≥ 22.6**（工具脚本运行在 `node --experimental-strip-types` 下，无需编译步骤）
- **Chromium**：优先用 Playwright 管理的版本（`npx playwright install chromium`），
  或把已安装的 chromium 目录交给 `PLAYWRIGHT_BROWSERS_PATH`
- **真模型**（可选）：ONNX 产物 + tokenizer
  - ONNX：默认找 `/tmp/laya_dec.onnx`（需带同名 `.data`），或设 `LAYA_ONNX_MODEL=/abs/path`
  - tokenizer：默认在 HF 缓存里找 `convaiinnovations/laya` 快照，或设 `LAYA_TOKENIZER_DIR=/abs/dir`（须含 `tokenizer.json`）
  - 导出 ONNX 的步骤见 `node-port-poc/README.md`；**没有产物时**离线测试仍全绿（用脚本模型替身），
    只有 bench / 用例端到端会打印 SKIP

### 安装

```bash
npm ci
npx playwright install chromium      # 可选：让 Playwright 自己准备浏览器
```

### 验证是否可用

```bash
npm run verify          # 类型检查 + 474 测试 + 六层对拍（不需要模型权重）
bash bench/smoke.sh     # CI 的"绿色"定义；缺 ONNX 产物时模型侧三步打印 SKIP
```

### 跑用例与工具

```bash
# 冻结计划跑分矩阵
npm run bench:fixtures                                        # 6 个离线夹具用例（真 ONNX，走生产循环）
node --experimental-strip-types src/bench.ts --cases bench/cases-live.json --mode-tag live   # 8 个真实站点
npm run bench -- --force-model router                         # 按页面自动选择 checkpoint

# 三个用例
node --experimental-strip-types src/ctrip-task.ts             # 复刻站：19 子目标 + 独立判分
node --experimental-strip-types src/transfer-task.ts --site skybook          # spec 驱动的迁移用例
node --experimental-strip-types src/transfer-task.ts --metrics-only          # 迁移度量（不开浏览器）
node --experimental-strip-types src/qunar-task.ts             # 真实站点：可自动化部分 + 边界判分

# 取数（配置驱动；站点知识在 <site>/sources/*.json）
node --experimental-strip-types src/datasource.ts --list
node --experimental-strip-types src/datasource.ts --source ctrip-flights-h5
node --experimental-strip-types src/live-probe.ts             # 可达性矩阵
node --experimental-strip-types src/live-capture.ts           # 抓取真实 DOM 供写计划用

# Excel 批量与其它入口
node --experimental-strip-types src/camera-entry.ts           # 设备录入（类型列路由）
node --experimental-strip-types src/ip-config.ts              # IP 规划表 → 设备网络页
node --experimental-strip-types src/long-task.ts              # 规划 → 执行 → 审计演示
node --experimental-strip-types src/path-a.ts --confirm-safe  # Path A 拾取器三场景
node --experimental-strip-types src/picker-server.ts          # Path B 本地模型服务（默认 127.0.0.1:8765）
npm run plan-cli -- --help                                    # 计划 CLI：new/add/edit/check/run
npm run shortlist                                             # 真模型 shortlist 演示
```

MV3 扩展（Path B）：先起 `picker-server`，再在 Chrome 里加载 `extension/` 目录（未打包扩展）；
页面上按 `Ctrl+Shift+K` 出候选面板。端到端测试见 `tests/extension.test.ts`（环境不具备时跳过）。

### 在代码里用（最小示例）

```ts
import { BrowserMiddleware, TaskPlan, runPlan } from "./src/index.ts";
import { installLayaRuntime } from "./src/model.ts";
import { createLayaOnnxRuntime } from "./src/laya-onnx.ts";

installLayaRuntime(createLayaOnnxRuntime());   // 真模型；离线跑用 installLayaRuntime(scriptedRuntime(...))

const plan = new TaskPlan(
  "在示例商店把无线鼠标加入购物车并打开购物车页",
  [
    {
      desc: "把 Wireless Mouse X200 加入购物车",
      signal: { css_text_equals: ["[data-test=cart-count]", "1"] },   // 完成只认这个 DOM 信号
      start_url: "https://example.com/product.html",
      target_hint: "[data-test=add-to-cart]",                          // 计划点名目标 → 规则解决，零模型调用
    },
    {
      desc: "打开购物车页",
      signal: { url_contains: "cart.html" },
      start_url: "https://example.com/product.html",
      target_hint: "[data-test=cart-link]",
    },
  ],
  ".task_state.json",                                                // JSON checkpoint（可续跑）
  {},                                                                // 数据袋：只有这里能提供要填的值
);

// 一个浏览器会话跑完整份计划：hint / slots / when / retries 都由 runPlan 按子目标带上
const mw = new BrowserMiddleware({ confirmFn: (desc) => true });      // 不可逆动作先问人，这里全放行
const rep = await runPlan(mw, plan, { startUrl: plan.subgoals[0]!.start_url! });
console.log(rep.completed, rep.plan.summary(), rep.traces.length);
```

只想跑单个子目标时用 `runSubgoalWithRetries(mw, sg, plan, url, page, pw)`（同样自动带 hint/重试），
或直接 `mw.run(desc, url, { goalSignalFn, slots, targetHint })`——**注意 `mw.run` 不会自动读计划里的
`target_hint`，单步调用时要自己传**。

一个子目标对象的全部字段：`desc`、`signal`、`start_url`，可选 `target_hint` / `target_hints`（点名目标）、
`when`（条件不满足则跳过）、`retries`（整步重试）、`slots`（本步数据袋）。

### 配置项

| 环境变量 | 作用 |
|---|---|
| `LAYA_ONNX_MODEL` | ONNX 图路径（默认 `/tmp/laya_dec.onnx`） |
| `LAYA_TOKENIZER_DIR` | 含 `tokenizer.json` 的目录（默认从 HF 缓存找） |
| `PLAYWRIGHT_BROWSERS_PATH` | chromium 安装目录（Playwright 默认目录不可用时） |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | 配置后启用 LLM 规划器与 LLM 审计器 |
| `PLANNER_MODEL` / `AUDIT_MODEL` | 上面两个模型的名字 |
| `SMOKE_REQUIRE_MODEL=1` | 让 `bench/smoke.sh` 在缺 ONNX 产物时**失败**而不是跳过 |
| `SMOKE_OUT` | `bench/smoke.sh` 的产物目录（默认 `/tmp/layawebuse-smoke`） |
| `CAMERA_ROUTE=type\|model` | `camera-entry` 的页面选择以表格类型列优先（默认）还是以模型为准 |

### 目录结构

```
src/         执行器、提取、规则、信号、计划、模型运行时（ONNX）、取数引擎、各驱动与用例
tests/       474 个测试（含仓库不变量与跨实现对拍护栏）
tools/       六层对拍工具 + 入库的冻结语料 + 计划 CLI / demo
bench/       cases.json（离线夹具矩阵）、cases-live.json（8 个真实站点）、fixtures/、smoke.sh、ablate.sh
testpages/   Mock 页面（扩展与 Path A/B 用）
ctrip/ transfer/ qunar/   三个用例：复刻站与站点数据、spec、实测记录
extension/   Path B 的 MV3 扩展
```

移植过程、等价性对拍的完整结果与实测记录见 [PORTING.md](PORTING.md)、
[CLAUDE.md](CLAUDE.md)（实测规则集）与 [ARCHITECTURE.md](ARCHITECTURE.md)；
Python 参考实现的备份见 [BACKUP.md](BACKUP.md)。
