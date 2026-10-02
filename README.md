# LayaWebUse · TypeScript 移植

目标：把 Python 参考实现逐语义迁移到 TypeScript，并用**机械对拍**（不是"手抄断言"）
证明等价。Python 版本保持为参考实现与验收基准；两套测试共存、都绿。

## 现状

| 模块 | Python | TS | 验证 |
|---|---|---|---|
| `extraction.ts`（元素模型/esig/firstIfSame/extractSlots/frame 钩子） | `layaapp/extraction.py` 纯逻辑 | ✅ | 单测 + 对拍 |
| `extraction.ts`（浏览器层：一次 JS pass / shadow / frames / CDP 探测 / hint 回捞 / criteria 视图 / state_text） | `extraction.py` 其余 | ✅ | **6/6 夹具逐元素对拍** + 10 集成测试 |
| `signals.ts`（5 算子信号语言） | `layaapp/signals.py` | ✅ | 8 单测 |
| `rules.ts`（nav / affordance / hint 语法 + 词表） | `layaapp/rules.py` | ✅ | **51/51 对拍** + 15 单测 |
| `plan.ts`（`PlanningRules` + `TaskPlan` 往返） | `layaapp/planner.py` | ✅（含 M2 修正） | 11 单测 |
| `audit.ts`（Mock/LLM 审计） | `layaapp/audit.py` | ✅ | 7 单测 |
| `picker.ts`（固定动作拾取器 + 三闸门） | `layaapp/picker.py` | ✅ | 8 单测 |
| `model.ts`（模型运行时接缝） | pip `laya` 调用面 | ✅ | 脚本化替身 |
| `laya-format.ts`（序列布局/温度分桶/置信度） | `laya/common.py` 推理侧 | ✅ | **9 序列逐 id 对拍** + 校准对拍（14 单测） |
| `executor.ts`（执行循环全量） | `layaapp/executor.py`（825 行） | ✅（1109 行） | **4/4 场景对拍** + 14 真浏览器集成测试 |
| `browser-env.ts`（跨平台 chromium 解析） | `browser_env.py` | ✅ | 集成测试走真实 chromium |
| `planner.ts`（`run_plan` / `runSubgoalWithRetries` / `LLMPlanner` / `ScriptedPlanner` / `snapshotText`） | `planner.py` 其余 | ✅（含 H1 修正） | 18 单测 |
| `flow.ts`（spec 加载/校验/展开 + 迁移度量） | `transfer/flow.py` | ✅（含重复键修正） | 27 单测（19/23/24/24/19 子目标等文档数字） |
| `plan-cli.ts`（计划 CRUD + 运行） | `plan_cli.py` | ✅（含 M3 修正） | 11 单测 + `npm run plan-cli` |
| `laya-onnx.ts`（ONNX + tokenizer.json 推理） | pip `laya` | ✅ | 10 单测（含与 Python 4 位小数对拍） |
| `datasource.ts`（取数引擎） | `datasource.py` | ✅ | 单测 + 跨实现对拍 |
| `bench.ts`（回归矩阵运行器 + 消融开关） | `bench/run_bench.py` | ✅ | 8 单测（含真浏览器 case 与 `BenchMiddleware.run === BrowserMiddleware.run` 不变量） |
| `ip-config.ts`（IP 规划表 → 网络设置页批量配置） | `ip_config.py` | ✅ | 6 单测（含 4 行端到端：3 OK + 1 被设备页校验拒绝） |
| `ctrip-data.ts` / `ctrip-task.ts`（确定性复刻站数据 + 独立判分 + 任务） | `ctrip/` | ✅ | 见 ctrip 测试文件 |
| `camera-entry.ts`（Excel 类型列路由 → 两套表单） | `camera_entry.py` | ✅ | 10 单测（含 4 行端到端：3 录入 + 1 被表单拒绝） |
| `transfer-data2..7.ts` + `transfer-task.ts`（六个复刻站库存 + 迁移运行器 + 度量） | `transfer/` 其余 | ✅ | 45 单测 + **67 项对拍（6 站 dumpJs 逐字节相等）** |
| `path-a.ts`（Path A：Playwright + 固定动作拾取器，导出 `PAGES`/`extractState`）/ `long-task.ts`（旗舰 demo）/ `tune-guard.ts`（注入闸门分离度实测） | `browser_picker_playwright.py` / `long_task.py` / `tune_guard.py` | ✅ | 7 单测（三场景校验 + 3/3 全链路 + 双措辞打分） |
| `picker-server.ts`（Path B：本地模型服务，`node:http` 零依赖）+ 30 测试 | `picker_server.py` | ✅ | 与 MV3 扩展字段逐条对齐 |
| `h5-flights.ts` / `live-probe.ts` / `live-capture.ts` / `ota-probe.ts` / `profiles.ts` | ctrip·transfer 的网络与探针工具 | ✅ | 26 离线测试（判决离线重算与已提交 JSON 全等） |
| `tools/shortlist_demo.ts`（`test.py` 的 shortlist 手工 demo，真 ONNX 跑通） | `test.py` | ✅ | `npm run shortlist` |
| `tests/extension.test.ts`（MV3 扩展端到端：静态服务 + picker-server + 持久化上下文 + `laya-trigger`） | `test_extension_load.py` | ✅ | 3 测试**实跑**（非跳过）+ 跳过路径实测 |
| `tools/shortlist_demo.ts` 之外：`tests/laya-internals.test.ts`（从 `test_laya.py` 移植的推理侧断言：ECE / `_to_internal` / render_options / 温度桶 / qtype 反查 / score 期望值） | `test_laya.py`（推理侧） | ✅ | 16 测试 |
| `qunar-probe.ts` / `qunar-task.ts`（ctrip 骨架在真实站点的迁移测试 + 边界判分） | `qunar/probe.py` / `qunar/qunar_task.py` | ✅ | 13 离线测试（实测边界见 `qunar/results/QUNAR_RESULT.md`） |
| **`tests/migration-completeness.test.ts`**：逐个 Python 源文件 → TS 孪生的**可检查覆盖表** | — | ✅ | 121 条断言：未迁移/失配/桩文件都会失败 |

顶层 `auditor.py` / `browser_agent.py` / `browser_picker.py` / `task_planner.py` 在 Python 里是 **2 行兼容 shim**，
其实现已分别落在 `audit.ts` / `executor.ts` / `picker.ts` / `planner.ts`（`browser_agent.py` 的 `main()` 是场景 A/B 演示）。

## 验证方式

```bash
cd ts
npm install
npm run typecheck        # tsc --noEmit
npm test                 # vitest：88 个测试（含真浏览器集成 + 对拍护栏）

npm run parity              # 规则层对拍（51 例）
npm run dump:extraction     # Python 参考：提取层 dump
npm run parity:extraction   # 提取层对拍（6 夹具）
npm run dump:executor       # Python 参考：执行器场景 dump
npm run parity:executor     # 执行器对拍（4 场景）
npm run gen:laya            # Python 参考：序列/校准语料
npm run plan-cli -- --help  # 计划 CLI（new/add/edit/check/run）
npm run shortlist           # laya shortlist demo（真 ONNX；对应 Python 的 test.py）
npm run verify              # 一键：typecheck + 全部测试 + 对拍
```

**工具脚本运行在 `node --experimental-strip-types` 下**：该模式不支持 TS 构造参数属性
（`constructor(public x: T)`）——`tests/project.test.ts` 有一条护栏测试专门守它（迁移中真被它坑过一次）。

ONNX 运行时（真模型）：
```bash
# 需要 /tmp/laya_dec.onnx(+.data) 与 HF 缓存的 tokenizer；缺失时相关测试自动跳过
node --experimental-strip-types -e "import('./src/laya-onnx.ts').then(async m => {
  const { installLayaRuntime } = await import('./src/model.ts');
  installLayaRuntime(m.createLayaOnnxRuntime()); console.log('onnx runtime installed');
})"
```

对拍语料全部由 Python 侧生成（参考实现算期望值），因此任何一侧漂移都会被点名。

### 对拍结果

| 层 | 规模 | 结果 |
|---|---|---|
| 规则（hint 语法/nav/affordance/slots） | 51 例 | **逐例一致** |
| 提取（`extract_elements` vs `extractElements`） | 6 夹具（product/long_page/shop_home/shop_cart/frames/spa） | **逐元素一致**（ref/tag/label/data_test/href/frame） |
| 执行器（`BrowserMiddleware.run`） | 4 场景（hint 命中 / 模型选择 / 风险拒绝 / 低置信停止） | **一致**（done / stop_reason 文案 / 步数 / 逐步 how+method） |
| laya 序列与校准 | 9 序列（CJK、结构化 criteria、score/noul、截断、小 max_len、选项预算收缩）+ 校准 | **逐 token id 一致** |
| datasource 引擎 | 163 项（2 个 source 配置 / 4 个日期页） | **逐项一致**（含 report_markdown 全文） |
| ctrip 用例 | 10 项（数据/计划/判分/报告） | **一致**（dumpJs 与报告逐字节相等） |
| transfer 迁移层 | 67 项（6 个复刻站 + 7 份 spec + 度量 + 报告） | **一致**（6 站 dumpJs 逐字节相等） |

## 移植中刻意保留的语义细节

- **CJK 词边界**：`affordanceRule` 要求 label 的 CJK 串是指令的"独立 token"。
- **`extractSlots` 的 Unicode 续字符**：用 `[\p{L}\p{N}_-]` 复刻 Python 的 Unicode `\w`。
- **属性值大小写折叠**（`net-CAM-1001` 事故）；`firstIfSame` 的扫描序裁决。
- **`serializeState` / `renderCriterion` 必须复刻 Python `json.dumps` 的 `", "`/`": "`**：
  分隔符直接改变 token 数，语料里的"文本漂移即报错"就是为它设的。
- **温度 clamp 的 `float()` 语义**：`null`/对象/空串回落到 1.0（JS `Number(null)=0` 会掉到下限）。
- `checkSignal`、`audit()`、`BrowserMiddleware` 构造在 TS 侧是 **async**（Node 的浏览器/HTTP I/O）。

## Node 与 Python Playwright 的 API 差异（踩过并解决）

1. `page.url` / `frame.url`：Node 是**方法** → `urlOf()`；
2. `locator.first`：Node 是**方法**；`.all()`/`count()` 异步 → `firstOf()` / await；
3. `page.evaluate("(arg) => {...}")`：Node 只把**孤立函数表达式**字符串当函数调用——带前置语句的
   字符串会被当表达式求值并返回 `undefined`（静默 0 元素）；`"e => e.tagName"` 这种最简单的
   箭头字符串同样不可靠（camera-entry 里它把 `<select>` 送进了 `fill()`）→ 一律用宿主侧
   `new Function` 编译成真函数；
4. `setContent` 不改变文档 URL，而监听器缓存按 URL 建 key → 合成页测试需先 `goto about:blank`；
5. `select_option(label=, timeout=)` → `selectOption({label}, {timeout})`。

## 已知语义偏差（诚实清单）

- **`n > k` 的 shortlist 排序信号不同**：Python 用 `laya.embed_fn_from_agent`（encoder 均值池化 + 余弦）
  选 top-k；TS 的 `embedFnFromAgent` 返回 `null`（`stateText` 是确定性关键词压缩，不用 embedding），
  于是按模型自身概率选 top-k 并对 kept 子集重跑一次前向。`n ≤ k` 的 passthrough 路径与 Python 完全一致
  （执行器的对拍场景都在这一路）。要完全复刻需在导出时加上 encoder hidden states 输出。
- `score` 取 `Σ i·p_i`（期望等级）与 Python 包一致；argmax 等级可从 `probabilities` 取。

## 相对 Python 的已知修正（移植即修复，**已回灌 Python 参考**）

- `TaskPlan.insert()` 在 Python 没有 `when`/`retries` 形参（审计 M2：replan 合并会丢条件与重试
  策略）；TS 版 insert 支持全部契约字段，并有单测钉住。
- `is_risky` 的风险阈值在 Python 里被字面量 0.6 遮蔽（审计 M4：`risky_threshold` 是死参数）；
  TS 版读 `this.riskyThreshold`。
- `picker` 的不可逆闸门在 Python 是内联 0.5（审计）；TS 版是构造参数。
- `run_plan` 的重规划异常路径在 Python 会以 `UnboundLocalError` 杀死整个 run（审计 H1）；TS 版继续跑并打印。
- `plan_cli` 的完成判定在 Python 用 `startswith(len)`，会把 when-skip 的子目标算作失败（审计 M3）；
  TS 版把 done + skipped 都算「完成」（exit 0 + audit APPROVE），有单测钉住。
- `migration_metrics` 在 Python 的字典字面量里定义了两次 `collect_roles`（死键）；TS 版只留生效值。
- `runSubgoalWithRetries` 的尝试计数：Python `for … range()` 停在最后一次尝试，C 风格 `for` 会停在
  `tries + 1`——TS 版显式计数（否则每个子目标都会被误记为 retried）。

**迁移完整性（Round 10）**：`tests/migration-completeness.test.ts` 把"全项目迁移"变成可检查的断言——
仓库里每个 `.py` 必须要么映射到一个存在且非桩的 TS 孪生，要么是明确的兼容 shim / 空包标记 /
**参考期望生成器**（`ts/tools/gen_*.py`、`dump_*.py` 必须留 Python 才独立），要么登记在案的有意豁免
（`test_laya.py` 的训练侧断言）。新增一个 Python 模块而不迁移它会直接让测试变红。

**回灌状态（Round 9）**：H1（replan 异常崩溃）、M3（when-skip 被判失败）与裸 `elems[ref]` 三处
已打进 Python 参考实现，并各加一条钉死测试（`test_middleware.py`）：
`test_run_plan_replan_exception_does_not_kill_the_run`、
`test_plan_cli_counts_skipped_guards_as_finished`（`plan_cli.plan_finished`）、
`test_run_stops_cleanly_when_the_model_names_a_missing_ref`。Python 套件从 155 → **158 passed**，
五层对拍基线不变。

## 有意偏差（Node 运行时所迫，均已在文件头注释）

- `BrowserMiddleware` 构造懒加载 `ready()`（Node 的 `runtime.load` 是 async）；
- `browserSession()` 返回 `{pw, browser, page, close()}` 取代 `with`，`close` 幂等；
- `browser-env.ts` 补上了 `launchPersistentContext`（`browser_env.launch_persistent_context` 的孪生）：
  MV3 扩展**必须**走持久化上下文——`chromium.launch()` 会带上 Playwright 自己的
  `--disable-extensions`，压过 `--load-extension`，service worker 永不注册（移植扩展 e2e 时实测）；
- 默认 `confirmFn` 改为**拒绝并告警**（Node 无同步 stdin；风险动作绝不默认放行）；
- `routerMaxLoaded()` 用 `os.totalmem()`（Python 的 `SC_AVPHYS_PAGES` 更接近 `os.freemem()`）。

## 线上平台实测与优化（2026-10）

`bench/cases-live.json` 的 8 个真实站点用例（Wikipedia 英/中、Hacker News、python.org、BBC、
books/quotes.toscrape、Polymer shadow DOM 商店）跑真 ONNX 模型 + 真网络：

| | 用例 | 子目标 | 步数中 rule:match 占比 | 耗时 |
|---|---|---|---|---|
| 优化前 | 6/8 | 8/9 | 混杂（wiki 两步靠模型侥幸 0.23/0.29） | 66 s |
| **优化后** | **8/8** | **11/11** | **11/11（零模型选择）** | **90.6 s** |

用 `node --experimental-strip-types src/bench.ts --cases bench/cases-live.json --mode-tag live` 复现。

线上暴露并修掉的四类真实缺陷（都在真实 DOM 上量到，且都钉了单测）：

1. **hint 的 `~` 是"子串匹配 + 全同才敢用"，在真实列表页必然歧义。**
   `a[href~Alan_Turing]` 在今天的英文维基搜索结果命中 17 条（Alan_Turing / _law / _Institute /
   Legacy_of_Alan_Turing …），歧义 → 交给模型 → 置信度 0.23 < 0.25 → **BLOCKED**。
   改为分级：**属性完全相等 → 末段路径等于 token → 才退回旧的"全子串 + 同签名"语义**
   （仍然对"真正不同"的候选返回 None，bbc 双 `/news` 链接的行为不变）。
2. **裸 token 同理**（中文维基搜索结果）：规范条目 label 恰为 `艾伦·图灵`，而语言侧栏约 100 条
   标题只是"包含"它（`艾伦·图灵 – 古吉拉特语`，token 甚至是独立词）。改为分级：
   **整条 label 相等 → 整词相等 → 词前缀 → 词子串**，只取最强非空层。该步从
   `laya conf=0.29`（侥幸过线）变成 `rule:match conf=1.00`。
3. **可见性必须要求"非零盒子"。** 中文维基主页有 **349 个语言侧栏链接**：`checkVisibility()`
   为真但 `getBoundingClientRect()` 是 0×0，Playwright 拒绝点击 → 旧版让它们进了元素池 →
   一次点击超时**炸穿 `run()`**（整个用例 0/0）。现在抽取要求 `rect.width>0 && rect.height>0`
   （与 Playwright 的可点击定义对齐），并且**动作失败被容纳**：`_clickOnly`/`_executeElement`
   捕获异常 → 返回 `action_failed` → 循环禁掉该 ref 继续，绝不让 TimeoutError 逃出执行器。
4. **计划的 hint 不该被 token 猜测抢先。** 维基那次首页返回了错误壳（`Why did this happen?`），
   计划的 `#searchInput` 不在池里；旧规则先跑 `navRule` 按指令 token 连猜 **18 个无值字段**
   （一个 step 内反复 needs_value），再让模型点到垃圾元素 → 22 步撞 `max_steps`。
   现在**有 hint 时只认 hint**：命中即规则命中，未命中直接落到模型（这正是文档写的
   "hint 权威，不拿 token 赌"），`needs_value` 空转消失。

另外三处工程修正：`isDone`/`isRisky` 容忍运行时缺答；bench 运行器改走
`runSubgoalWithRetries`（**用例里的 `retries` 之前是死数据**）并记录 `attempts`；用例级
`slots` 挂到 `TaskPlan` 上（改成重试路径后曾丢失，正是线上包抓出来的回归）。线上包的 11 个子目标
统一加 `retries: 2`——真实站点的冷加载抖动本来就是计划词表要处理的东西。

以上 1/2/4 三条**已同步回灌 Python 参考实现**（`layaapp/rules.py`、`layaapp/executor.py`），
冻结对拍语料随之重新生成（51 → 57 例，新增 6 条分级用例），Python 侧测试同步更新（158 passed）。
