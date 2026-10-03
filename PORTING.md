# 移植与等价性记录（PORTING）

本仓库的前身是 Python 实现，现已收敛为 TypeScript 单一技术栈；Python 版整体移出、经审查后删除（历史归档见
[BACKUP.md](BACKUP.md)）。这份文档保留移植期的工程记录：模块对照、等价性对拍、保真细节、
已知偏差，以及真实站点实测与由此产生的修正。**面向使用者的目标/功能/用法在
[README.md](README.md)。**

## 模块现状（Python 参考 → TS）

| 模块 | Python | TS | 验证 |
|---|---|---|---|
| `extraction.ts`（元素模型/esig/firstIfSame/extractSlots/frame 钩子） | `layaapp/extraction.py` 纯逻辑 | ✅ | 单测 + 对拍 |
| `extraction.ts`（浏览器层：一次 JS pass / shadow / frames / CDP 探测 / hint 回捞 / criteria 视图 / state_text） | `extraction.py` 其余 | ✅ | **6/6 夹具逐元素对拍** + 10 集成测试 |
| `signals.ts`（5 算子信号语言） | `layaapp/signals.py` | ✅ | 8 单测 |
| `rules.ts`（nav / affordance / hint 语法 + 词表） | `layaapp/rules.py` | ✅ | **57/57 对拍** + 17 单测 |
| `plan.ts`（`PlanningRules` + `TaskPlan` 往返） | `layaapp/planner.py` | ✅（含 M2 修正） | 11 单测 |
| `audit.ts`（Mock/LLM 审计） | `layaapp/audit.py` | ✅ | 7 单测 |
| `picker.ts`（固定动作拾取器 + 三闸门） | `layaapp/picker.py` | ✅ | 8 单测 |
| `model.ts`（模型运行时接缝） | pip `laya` 调用面 | ✅ | 脚本化替身 |
| `laya-format.ts`（序列布局/温度分桶/置信度/ECE） | `laya/common.py` 推理侧 | ✅ | **9 序列逐 id 对拍** + 校准对拍（14 单测） |
| `executor.ts`（执行循环全量） | `layaapp/executor.py`（825 行） | ✅（1117 行） | **4/4 场景对拍** + 16 真浏览器集成测试 |
| `browser-env.ts`（跨平台 chromium 解析 + 持久化上下文） | `browser_env.py` | ✅ | 集成测试走真实 chromium |
| `planner.ts`（`runPlan` / `runSubgoalWithRetries` / `LLMPlanner` / `ScriptedPlanner`） | `planner.py` 其余 | ✅（含 H1 修正） | 18 单测 |
| `flow.ts`（spec 加载/校验/展开 + 迁移度量） | `transfer/flow.py` | ✅（含重复键修正） | 27 单测 |
| `plan-cli.ts`（计划 CRUD + 运行） | `plan_cli.py` | ✅（含 M3 修正） | 11 单测 + `npm run plan-cli` |
| `laya-onnx.ts`（ONNX + tokenizer.json 推理） | pip `laya` | ✅ | 12 单测（含与 Python 4 位小数对拍、单候选短路） |
| `datasource.ts`（取数引擎） | `datasource.py` | ✅ | 单测 + 163 项对拍 |
| `bench.ts`（回归矩阵运行器 + 消融开关 + 线上包） | `bench/run_bench.py` | ✅ | 8 单测（含 `BenchMiddleware.run === BrowserMiddleware.run` 不变量） |
| `ip-config.ts`（IP 规划表 → 网络设置页批量配置） | `ip_config.py` | ✅ | 6 单测（含 4 行端到端：3 OK + 1 被设备页校验拒绝） |
| `ctrip-data.ts` / `ctrip-task.ts`（确定性复刻站数据 + 独立判分 + 任务） | `ctrip/` | ✅ | 10 项对拍（dumpJs 与报告逐字节相等） |
| `camera-entry.ts`（Excel 类型列路由 → 两套表单） | `camera_entry.py` | ✅ | 10 单测（含 4 行端到端） |
| `transfer-data2..7.ts` + `transfer-task.ts`（六个复刻站库存 + 迁移运行器 + 度量） | `transfer/` 其余 | ✅ | 45 单测 + **67 项对拍（6 站 dumpJs 逐字节相等）** |
| `path-a.ts` / `long-task.ts` / `tune-guard.ts` | `browser_picker_playwright.py` / `long_task.py` / `tune_guard.py` | ✅ | 7 单测 |
| `picker-server.ts`（Path B：本地模型服务，`node:http` 零依赖） | `picker_server.py` | ✅ | 30 测试；与 MV3 扩展字段逐条对齐 |
| `h5-flights.ts` / `live-probe.ts` / `live-capture.ts` / `ota-probe.ts` / `profiles.ts` | ctrip·transfer 的网络与探针工具 | ✅ | 26 离线测试 |
| `tests/extension.test.ts`（MV3 端到端） | `test_extension_load.py` | ✅ | 3 测试实跑 + 跳过路径实测 |
| `tests/laya-internals.test.ts`（`test_laya.py` 推理侧：ECE / `_to_internal` / render_options / 温度桶 / qtype 反查） | `test_laya.py`（推理侧） | ✅ | 16 测试 |
| `qunar-probe.ts` / `qunar-task.ts` | `qunar/probe.py` / `qunar/qunar_task.py` | ✅ | 13 离线测试（实测边界见 `qunar/results/QUNAR_RESULT.md`） |

顶层 `auditor.py` / `browser_agent.py` / `browser_picker.py` / `task_planner.py` 在 Python 里是 2 行兼容 shim，
实现分别落在 `audit.ts` / `executor.ts` / `picker.ts` / `planner.ts`。

`tests/repo-integrity.test.ts` 把上面这张表变成**可检查的断言**：仓库里不得存在 `.py`，
六个对拍工具必须读入已入库的冻结语料、不得在运行时调用 Python，测试读取的实测记录必须在库里。

## 等价性怎么证明

对拍语料由 **Python 参考实现**生成并入库（`tools/*-corpus.json`、`*-python.json`），TS 侧重放逐项比对；
生成器随参考实现一并移除——用被测实现自己生成期望就不是独立参考。

| 层 | 规模 | 结果 |
|---|---|---|
| 规则（hint 语法/nav/affordance/slots） | 57 例 | **逐例一致** |
| 提取（`extract_elements` vs `extractElements`） | 6 夹具 | **逐元素一致**（ref/tag/label/data_test/href/frame） |
| 执行器（`BrowserMiddleware.run`） | 4 场景 | **一致**（done / stop_reason 文案 / 步数 / 逐步 how+method） |
| laya 序列与校准 | 9 序列 + 校准 | **逐 token id 一致** |
| datasource 引擎 | 163 项 | **逐项一致**（含 report_markdown 全文） |
| ctrip 用例 | 10 项 | **一致**（dumpJs 与报告逐字节相等） |
| transfer 迁移层 | 67 项 | **一致**（6 站 dumpJs 逐字节相等） |

```bash
npm run verify            # typecheck + 全部测试 + 六层对拍
npm run test:parity       # 只跑六层对拍
```

### 重新生成语料

语料已冻结、不能再生成（生成器随参考实现移除，见 [BACKUP.md](BACKUP.md)）；改动对拍覆盖范围需要自行重建期望值。

## 移植中刻意保留的语义细节

- **CJK 词边界**：`affordanceRule` 要求 label 的 CJK 串是指令的"独立 token"。
- **`extractSlots` 的 Unicode 续字符**：用 `[\p{L}\p{N}_-]` 复刻 Python 的 Unicode `\w`。
- **属性值大小写折叠**（`net-CAM-1001` 事故）；`firstIfSame` 的扫描序裁决。
- **`serializeState` / `renderCriterion` 必须复刻 Python `json.dumps` 的 `", "`/`": "`**：分隔符直接改变 token 数。
- **温度 clamp 的 `float()` 语义**：`null`/对象/空串回落到 1.0（JS `Number(null)=0` 会掉到下限）。
- `checkSignal`、`audit()`、构造函数在 TS 侧是 **async**（Node 的浏览器/HTTP I/O）。

## Node 与 Python Playwright 的 API 差异（踩过并解决）

1. `page.url` / `frame.url`：Node 是**方法** → `urlOf()`；
2. `locator.first`：Node 是**方法**；`.all()`/`count()` 异步 → `firstOf()` / await；
3. `page.evaluate("(arg) => {...}")`：Node 只把**孤立函数表达式**字符串当函数调用；带前置语句的字符串会被
   当表达式求值并返回 `undefined`（静默 0 元素）；最简单的箭头字符串同样不可靠（camera-entry 里它把
   `<select>` 送进了 `fill()`）→ 一律用宿主侧 `new Function` 编译成真函数；
4. `setContent` 不改变文档 URL，而监听器缓存按 URL 建 key → 合成页测试需先 `goto about:blank`；
5. `select_option(label=, timeout=)` → `selectOption({label}, {timeout})`；
6. `--experimental-strip-types` 不支持构造参数属性 → `tests/project.test.ts` 有护栏测试。

## 已知语义偏差（诚实清单）

- **`n > k` 的 shortlist 排序信号不同**：Python 用 `laya.embed_fn_from_agent`（encoder 均值池化 + 余弦）选
  top-k；TS 的 `embedFnFromAgent` 返回 `null`，于是按模型自身概率选 top-k 并对 kept 子集重跑一次前向。
  `n ≤ k` 的 passthrough 路径与 Python 完全一致。要完全复刻需在导出时加上 encoder hidden states 输出。
- **导出的 ONNX 图里 TopK 是静态 `k=2`**：单候选的 `choice` 问题会崩（`k argument [2] > axis dim 1`），
  TS 运行时对该情形短路（唯一选项即 argmax、熵置信度 1.0），Python/torch 无此限制。

## 相对 Python 的已知修正（移植即修复，已回灌 Python 参考）

- `TaskPlan.insert()` 缺 `when`/`retries` 形参（审计 M2）；TS 版支持全部契约字段。
- `is_risky` 的风险阈值被字面量 0.6 遮蔽（审计 M4）；TS 版读 `this.riskyThreshold`。
- `picker` 的不可逆闸门是内联 0.5；TS 版是构造参数。
- `run_plan` 的重规划异常路径会以 `UnboundLocalError` 杀死整个 run（审计 H1）；两侧都已修。
- `plan_cli` 用 `startswith(len)` 判定完成，会把 when-skip 算作失败（审计 M3）；两侧都已修（`plan_finished`）。
- `migration_metrics` 里 `collect_roles` 定义了两次（死键）；TS 版只留生效值。
- `runSubgoalWithRetries` 的尝试计数：Python `for … range()` 停在最后一次尝试，C 风格 `for` 会停在
  `tries + 1`；TS 版显式计数。
- 裸 `elems[ref]`（模型给出池外 ref）会 KeyError / 崩溃；两侧都已改为干净停止。
- 规则优先级：旧顺序 `nav_rule(...) or affordance_rule(...)` 会抢在计划 hint 之前做 token 猜测；
  两侧都改为"有 hint 时只认 hint，未命中落到模型"。

回灌补丁对应的钉死测试曾在 `test_middleware.py`（随参考实现移除）里（`test_run_plan_replan_exception_does_not_kill_the_run`、
`test_plan_cli_counts_skipped_guards_as_finished`、`test_run_stops_cleanly_when_the_model_names_a_missing_ref`）；
Python 套件 158 passed。

## 有意偏差（Node 运行时所迫，均在文件头注释）

- `BrowserMiddleware` 构造懒加载 `ready()`（Node 的 `runtime.load` 是 async）；
- `browserSession()` 返回 `{pw, browser, page, close()}` 取代 `with`，`close` 幂等；
- `browser-env.ts` 补上 `launchPersistentContext`：MV3 扩展**必须**走持久化上下文——`chromium.launch()`
  会带上 Playwright 自己的 `--disable-extensions`，压过 `--load-extension`（实测）；
- 默认 `confirmFn` 改为**拒绝并告警**（Node 无同步 stdin）；
- `routerMaxLoaded()` 用 `os.totalmem()`（Python 的 `SC_AVPHYS_PAGES` 更接近 `os.freemem()`）。

## 线上平台实测与优化（2026-10）

`bench/cases-live.json` 的 8 个真实站点用例跑真 ONNX 模型 + 真网络：

| | 用例 | 子目标 | 步数中 `rule:match` | 耗时 |
|---|---|---|---|---|
| 优化前 | 6/8 | 8/9 | 混杂（两个 wiki 步靠模型侥幸 0.23 / 0.29） | 66 s |
| **优化后** | **8/8** | **11/11** | **11/11（零模型选择）** | **90.6 s** |

暴露并修掉的四类真实缺陷（都在真实 DOM 上量到，且都钉了单测）：

1. **`~` hint 分级**：`a[href~Alan_Turing]` 在英文维基搜索结果命中 17 条 → 旧歧义检查放弃 → 0.23 < 0.25
   BLOCKED。改为 **属性完全相等 → 末段路径等于 token → 旧语义**（真正不同的候选仍返回 None）。
2. **裸 token 分级**：中文维基规范条目 label 恰为 `艾伦·图灵`，语言侧栏约 100 条只是包含它 →
   改为 **整条 label → 整词 → 前缀 → 子串**，该步从 `laya 0.29` 变为 `rule:match 1.00`。
3. **可见性要求非零盒子**：中文维基主页 349 个语言侧栏链接 `checkVisibility()` 为真但 0×0 → 点击超时
   曾**炸穿 `run()`**；现在抽取要求 `width/height > 0`，且 `_clickOnly`/`_executeElement` 捕获失败返回
   `action_failed`，循环禁掉该 ref 继续。
4. **计划 hint 优先于 token 匹配**（规则顺序层面）：维基返回错误壳时 `navRule` 曾连猜 18 个无值字段；
   现在有 hint 只认 hint，未命中落到模型。

工程修正：`isDone`/`isRisky` 容忍运行时缺答；bench 运行器改走 `runSubgoalWithRetries`（用例 `retries`
此前是死数据）并记录 `attempts`；用例级 `slots` 挂到 `TaskPlan`（改成重试路径后曾丢失）。

以上 1/2/4 已同步回灌 Python 参考实现，冻结对拍语料随之重新生成（51 → 57 例），Python 侧测试同步更新。
