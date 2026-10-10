> **状态（2026-10）**：本仓库现在是 **TypeScript 单一技术栈**。
> 下文描述的 Python 实现已整体移出并备份（见 [BACKUP.md](BACKUP.md)）；
> 文中的 `python xxx.py` / `pytest` 命令指向备份中的参考实现，对应的 TS 入口见 [README.md](README.md)。
> 设计规范、实测结论与用例记录照旧有效——TS 代码的注释大量引用它们。

# AmberFlow 总体架构

> 本文描述当前代码的设计意图与边界。历史迭代（每轮的失败模式、实测数字、修复依据）见
> `bench/OPTIMIZATION_REPORT.md`；给 agent 的硬约束清单见 `CLAUDE.md`。

## 一、定位与核心契约

把浏览器自动化拆成 **System 2 编排 + System 1 执行** 两半：

- **大模型负责编排，并把它固化成"冻结流程"**：有序子目标，每个子目标自带**可验证的完成信号**，
  能点名目标时再给一行 `target_hint`。
- **laya（pip 依赖，421M 非自回归、单次前向出决策）负责按流程逐步精确执行**：每步只回答
  "现在点哪个元素 / 这步危险吗"。

执行器的三条"永不"（整个设计的地基）：

1. **永不重新规划** —— 计划是输入，不是建议；
2. **永不编造值** —— 填入表单的值只来自计划的 `slots` 数据袋（缺值就 `needs_value` 停下，如实报错）；
3. **永不把模型的判断当完成** —— 只有 DOM 信号算完成（`is_done` 的 noul 仅作参考，且有信号时干脆不调用）。

## 二、分层（单向依赖）

```
                     ┌── LLMPlanner        (System 2：一次性编排 / 失败后重规划)
用户目标 / Excel 行 ─┤
                     └── PlanningRules     (同一套规则：既渲染进 LLM prompt，又校验人工编辑)
                                  │
                                  ▼
task_planner.py    PlanningRules(一套规则: 进 prompt + 校验计划) · snapshot_text(给 planner 看的
                   页面渲染, 复用 criteria_view) · TaskPlan(JSON checkpoint/resume + slots 数据袋 +
                   target_hint) · LLMPlanner(build_messages/make_plan/replan) · run_plan(整计划共享
                   ONE browser_session + 真 replan 接线)
                                  │
                                  ▼
browser_agent.py   BrowserMiddleware.run —— 唯一执行器
                   每步: extract_elements(无站点专属选择器)
                         → 规则层 _nav_rule / _affordance_rule / target_hint(零模型调用)
                         → 否则 laya predict_shortlist(k=8, 语义选择)
                         → 置信度 floor → 风险闸门 is_risky → 可点性探针 → 执行
                         → inert 快照比对 → DOM done-signal
                                  │
                                  ▼
auditor.py         事后审计(Mock / LLM)：读整条 trace 判 APPROVE / REJECT
                                  │
                                  ▼
laya (pip)         Agent.predict / predict_shortlist  ·  Router.route/predict(选 checkpoint)
```

`bench/run_bench.py` 的 `BenchMiddleware` **继承**（不复制）这个执行循环，只做两件事：
选 checkpoint、拨消融开关（rules on/off、anti-repeat、conf floor）。单测钉死
`BenchMiddleware.run is BrowserMiddleware.run`。

### 2.1 包结构：`layaapp/` 就是应用层

扁平模块已收进一个显式分层的包，驱动脚本只依赖应用层入口：

```
layaapp/__init__.py   应用层公共 API（驱动只 import 这一个）
        ├── planner.py      规划：PlanningRules / TaskPlan(+slots) / LLMPlanner / run_plan
        ├── executor.py     编排：BrowserMiddleware（唯一执行循环）/ browser_session / 路由
        ├── extraction.py   看：一次 JS pass（frames+shadow）/ criteria_view / hint 回捞 / esig
        ├── rules.py        决：字面映射（nav / affordance / hint_match）+ 词表
        ├── audit.py        审：trace 审计（Mock / LLM）
        └── picker.py       动作：固定动作集拾取器 + 三闸门（Path A/B）
```

依赖方向严格单向：`__init__ → executor → {extraction, rules, audit}`、`planner → {executor, extraction}`。
顶层同名模块（`browser_agent.py` 等）只剩**兼容 shim**，保证旧 import 与 `python browser_agent.py` 不炸。

## 三、三条并行入口，共用一套核心

| 入口 | 决策方式 | 适用 |
|---|---|---|
| **自由元素发现栈** `browser_agent` / `bench` / `plan_cli` / `long_task` | 每步现场扫描 DOM（≤40 元素），规则/hint → laya | 任意页面、长任务 |
| **固定动作栈** `browser_picker` + `browser_picker_playwright`(Path A) / `picker_server`+`extension`(Path B) | 9 个硬编码动作 + 三闸门（注入 noul / 不可逆 noul / 置信度） | 已知动作集、浏览器扩展场景 |
| **数据驱动批处理** `camera_entry` | **按类型列命中 `TYPE_TO_FORM` 即定页**（零模型调用），类型空白/未知回落模型；填值 verbatim | Excel → 多页表单录入 |
| **表格→设备配置** `ip_config` | 每行一份冻结计划（`TaskPlan.slots` 即数据袋），门户按序列号 hint 进设备页，点击前预填 ip/掩码/网关，保存走风险闸门，完成只看页面回显 | IP 规划表 → 摄像头网络设置页 |
| **场景用例** `ctrip` | 一句中文需求 → 19 个子目标的冻结计划（每步一次点击 + 一条 DOM 信号 + 一个 hint），筛选/排序状态走 URL，站点自己的账本只由点击写入，再用**独立口径**判分 | 携程式「搜票 + 搜酒店 + 记录」用例（线上被封锁，跑本地复刻站） |
| **流程即配置** `transfer` | 流程写进 `transfer/specs/<site>.json`：**阶段列表（stage/repeat/steps）本身就是骨架** + 每步的 hint(s)/signal/`when`/`retries`/URL 模板 + 数据袋；加载器只做校验/展开，`--emit-plan` 出 `TaskPlan` JSON | 迁移到布局不同的同类站点：#2 英文/下拉+单选/网格/分页，#3 表格/滑块，#4 表单搜索，#5 **两页向导**，#6 **条件子目标**，#7 **重试（冷启动）** |

## 四、关键设计决策（每条都有实测依据，不是风格偏好）

### 1. 分工边界：字面映射交给规则，语义交给 laya
- `_nav_rule`：href 匹配，**必须出现导航动词**（否则 "add to the shopping cart" 会命中 cart.html）；
- `_affordance_rule`：`data-test` 前缀匹配 / label 全词匹配 / CJK 词边界；
- `target_hint`：计划点名的目标，**规则直接命中，零模型调用**，且命中"不可区分"的多个候选时取扫描序第一个；
- 实测根据：zero-shot 元素选择在歧义页面不可用（quotes 登录页正确目标 0.04 vs logo 0.59；关掉规则 3/15 且超时）。

### 2. 完成判定：DOM 信号是唯一真相
信号语言五种：`url_contains` / `css_exists` / `css_text_equals` / `css_text_contains` / `css_value_equals`。
真站点优先 `css_text_contains`（zh.wikipedia 的 `<h1>` 是"艾伦·图灵编辑"）。

### 3. 安全：分层风险 + 独立审计
风险 = **确定性关键词规则 OR 模型投票 ≥0.6**（基座风险头随措辞翻转），命中**只要求确认不阻断**；
审计是独立的 System 2 作业（`MockAuditor` 离线 / `LLMAuditor` 走 OpenAI 兼容端点）。

### 4. 上下文工程（把页面塞进 512–1024 token）
- **只喂当前子目标**，绝不喂整条长目标（实测置信度 0.42 → 0.16）；
- `state_text` 关键词重叠压缩（budget 320），不用 embedding；
- `aria_snapshot` 提供 role 归一化，但**保留自家 label 与 `[test=..] -> href` 后缀**（纯 aria 视图实测会把 logo 顶到第一）；
- `MAX_ELEMENTS=40`：**主内容优先**分层（`main/article` 且不在 `nav/aside/footer/header`），并且
  **预算永远不能吃掉计划已点名的目标** —— `hint_lookup()` 按 hint 语法回捞。
- **抽取是"一次 JS pass"**：tag/label(含 `<label>` 包装)/属性/可见性/主内容标记/顺序在一次 `page.evaluate`
  里全部返回，并在**同一次**里给入选元素盖 `data-dshref` 章（句柄、顺序、索引单一来源）。
  实测 en.wikipedia（677 匹配）**4.5–5.2 s/步 → 0.02 s/步**。逐元素路径保留为 JS 失败时的降级。
- **所有 JS 侧遍历共用一个 shadow-aware 采集器**（`_COLLECT_JS`）：Playwright 的 CSS 引擎会穿透 shadow DOM，
  而 `document.querySelectorAll` 不会——两边不一致正是 shadow 应用上"扫描看到 20 个元素、元数据看到 0 个"的原因。
- **frames 是一等公民**：提取遍历主 frame + 同源子 frame（上限 6），子 frame 元素带 `frame` 索引、ref 加 `f{n}:` 前缀；
  `_locator_for` 与所有信号求值（`locator_any_frame`）都**限定在该元素所属 frame**（`page.locator` 只搜主 frame）；
  `snapshot()` 纳入子 frame 的文本/输入值，使 iframe 内的动作也能被 inert 检测看见。离线由 `frames-entry-zh` 覆盖。

### 5. 元素身份：位置索引只在一瞬间有效
ref 是扫描下标、每步重编号，所以一切**跨步持久引用都用签名**（`esig = tag+label+data-test`）：
forbidden / 遮挡重准入 / inert 全部签名化。执行句柄链：
`data-hintref`(hint 回捞盖章) → `data-js-ref`(CDP 探测盖章) → `data-test` → `id` → `name` → `input_type` → 位置兜底。

### 6. 执行健壮性（全部在生产循环里）
点击前**可点性探针**（被覆盖元素 0.8 s 报因，而不是烧 5 s 超时 + inert 步）、遮挡 ref **页面变化后重准入**、
**inert 检测**（url+文本+输入值全等 → forbid）、**submit-type input 只点不填**、点击前**确定性预填**、
**anti-repeat**（laya 命中未推进 / 填了没推进 → forbid）。

### 7. 成本与算力现实
- 规则/hint 命中路径**零模型调用**（这是 CPU-only 下跑得动的原因）；
- 页面规模是硬约束：抽取成本随 DOM 增长（Wikipedia 677 元素 ≈4.5 s/步，是当前最大瓶颈）；
- 环境自适应：`goto` 用 `domcontentloaded`（真站点 `load` 会超时）、`Router(max_loaded=…)` 按可用内存探测、
  切换 checkpoint 前先 `unload`（`Router.load` 是"先建后逐"，小内存机会短暂双驻留）。

### 8. checkpoint 路由：按脚本，不按置信度
英文基座在非英文上**崩塌式退化但仍报高置信**（印地语 0.100 vs 随机 0.050，ECE 0.855），
所以 `laya.Router` 用脚本/语言检测路由；但**混合 ASCII 编码 + 中文散文的行会被判成 Latin**，
所以 camera_entry 的路由状态用整行原始记录（实测唯一 4/4 的变体）。

### 9. 执行器侧的语言路由（opt-in）

`BrowserMiddleware(route_models=True)` 时，每一步用页面 state 问 `laya.Router` 该用哪个 checkpoint（脚本/语言检测为主信号），
所以计划不必手写 `model` 字段。两个承重细节：`__init__` 里已建好的默认 checkpoint 用 `Router.attach` **复用**（不是再建一份）；
换 checkpoint 时必须**先丢掉执行器自己的引用**再 `Router.load`——否则旧 Agent（0.7–1.7 GB）会在新模型构建期间继续存活，
3 GB 机器就是在这个共驻窗口 OOM 的。路由失败一律降级到当前驻留模型（路由是优化，不是依赖）。

代价实测：router 模式 **9/9（25/25 子目标）** 通过，CJK 用例确实路由到 multilingual，但用时 **410.9 s vs 固定 english 的 58.1 s**
——语言切换要冷载 checkpoint。**路由买的是语言覆盖，不是速度**；≥4 GB 机器放开 `max_loaded=2` 才能避免抖动。

## 五、冻结流程的契约（数据格式）

```json
{"goal": "...", "slots": {"coupon": "ACME10"},
 "subgoals": [{"desc": "…", "signal": {"css_value_equals": ["#q", "asyncio"]},
               "start_url": "https://…", "target_hint": "#id-search-field"}]}
```

- `signal`：唯一完成判据；**必须写在线索最稳的标记上**（写错 = 执行对了也判 FAIL）；
- `target_hint` 语法：`#id` / `tag[attr=value]` / `tag[attr~substr]` / `tag[near~token]` / `tag` / 裸词；
  两处实现（Python `_hint_match` 与 JS `hint_lookup`）**必须同步**；
- `slots`：值的数据袋（CJK 键只能从这里给，`extract_slots` 只解析 ASCII `key=value`）。

## 六、验证体系（分层证据）

| 层 | 命令 | 覆盖 |
|---|---|---|
| 单元 | `pytest test_laya.py test_middleware.py ctrip/test_ctrip.py transfer/test_transfer.py`（144） | laya 包内部 37 + 中间件规则/hint/信号/计划/生命周期 52 + 携程用例 22 + 迁移层 33（spec 校验/等价性/按角色对齐的度量/七站点行为/有序 hint/子目标数据袋/阶段列表骨架/条件子目标/重试策略/线上判决函数）|
| 离线回归门 | `bash bench/smoke.sh`（4 步） | 上面 + 6 个 file:// fixture case（**走生产循环**，含 iframe 表单）+ `ctrip/ctrip_task.py` 端到端（19 子目标 → 7 项判分）+ `transfer/transfer_task.py --site skybook`（**同一流程、另一个站点**：23 子目标 → 7 项判分）|
| 冻结流程基准 | `bench/run_bench.py`（9 cases / 25 subgoals） | fixture（含 iframe）+ 3 个真实沙盒站；消融 `ablate.sh` |
| 线上包 | `bench/run_bench.py --cases bench/cases-live.json` | 5 个真实生产站点 + shadow DOM 商店 |
| CI | `.github/workflows/checks.yml` | push/PR 跑 smoke；nightly 跑全量（含真站点）|

方法论：每个结论都留可复现的实测数字（置信度/耗时/A-B），轮次记录在 `bench/OPTIMIZATION_REPORT.md`。

## 七、已知边界与债（诚实清单）

1. **shadow DOM 的顺序语义**：三个 JS pass 已改为 shadow-aware，但采集顺序是"light DOM 全部 → 各 shadow root"，
   与 Playwright 的深度优先交错顺序不同；`scan`/near 内部一致，跨实现比较时需注意。
2. **跨域 iframe 不可达**：只做同源 frame（`frame.evaluate` 抛异常即跳过），跨域 iframe 仍等于不存在。
3. **一个子目标里的动作是"直线"，条件与重试都只在子目标级别**：`target_hints`（有序 hint 列表）解决了
   "填表 → 选择 → 提交"这类连续动作，子目标也能带自己的 `slots`；`when` 让它在不适用时被**跳过**
   （复刻站 #6），`retries` 让它在这一次失败时**整步重来**（复刻站 #7）。仍然做不到的是
   子目标**内部**的分支/循环、**回退到第 N 步**、以及多分支选择。
   骨架形状现在是配置（阶段列表 + `stage`/`repeat`，见 `transfer/specs/voyagio.json` 的两页向导），
   但 `repeat` 只有 once/per_date/per_checkin 三种，**没有"回退/条件跳转/并发搜索"**——
   那些要么加新的 repeat 语义，要么由 replan 接手。
4. **两处 hint 语法实现易漂移**，且 `hint_lookup` 依赖向页面 DOM 写入 `data-hintref` 章。
5. 注入闸门 0.95 与良性页实测 0.91–0.94 只差 0.01，需要按页面类型分层。
6. **真 LLM 闭环仍未实跑**：本机没有 `OPENAI_*`，`LLMPlanner`/`LLMAuditor` 只有离线单测覆盖（prompt 携带页面快照、hint 保留、replan 成功/无进展/次数上限）——缺的是端点，不是代码。replan 尚未把**阻塞那一刻**的页面快照传回 planner（`page` 就在作用域内，2 行改动）；`LLMAuditor` 也还没替掉 `MockAuditor`。
7. `_listener_cache` 按 URL 无上限增长；`run_bench.py` 只在全部跑完后落盘（一次 35 min 的跑分险些因超时全丢）。
8. **携程线上站在本环境不可达（外部约束，不是代码问题；第 10 轮又补了手机模拟与区域域名）**：`flights.ctrip.com` / `m.ctrip.com` 机票页对浏览器 UA 一律 HTTP 432
   `whaleguard block`（真浏览器同样 432），换 curl 客户端才拿到 Next.js 空壳而列表走 XHR，老接口 `/itinerary/api/12808/products` 已下线；
   `hotels.ctrip.com` 列表页 SSR 能出酒店名/星级，但未登录访客的价格节点为空（"登录以查看会员价"），「≤300 元」无法判定。
   补充：iPhone/Android UA + 移动视口 + 触摸、`hk./us./sg.trip.com` 三个区域域名 —— 10 次访问 10 次 432，
   说明挡的是**出口 IP**而非 UA/设备/区域；酒店列表在浏览器里会被**重定向到登录页**（`passport.ctrip.com`）。
   实测与复现见 `src/live-probe.ts`、`src/live-capture.ts` → `ctrip/results/{live_probe.json,live_capture/}`（原 Python 版命令与输出归档在历史 bundle，见 [BACKUP.md](BACKUP.md)）。
   因此 `ctrip/` 用例跑在**本地复刻站**上，
   票价/房态是本地生成数据（结论只对复刻站成立，不代表真实携程报价）。
9. **一个子目标只有一次点击**：筛选/排序若停留在页面 JS 状态里，`run()` 每步重新 `goto` 会丢状态、且同一个 hint 会被反复点。
   复刻站的做法是把状态写进 URL（真实列表页亦然），于是"筛时段/排序/记录"拆成三个各一次点击的子目标；换到状态只在内存里的站点需要另想办法。
   迁移测试又撞了一次同一堵墙，这次是**选择状态**：SkyBook 的"先勾选、再提交"跨两个子目标时，
   记录那一步在新页面里什么都没勾选，信号永不触发（执行器在 `max_steps` 里打转、然后被 laya 带去点别的按钮）。
   修法仍在配置层：勾选后跳一次 `…&selected=all`，让 `start_url` 完整决定这一步的状态。
   仍未解决的是"勾选+提交放进一个子目标"（一个子目标只有一个权威 hint，第二次点同一元素是 inert）。
10. **流程是配置，但有三样东西刻意不配置**：判分口径（必须是独立第二实现）、站点库存生成器、执行循环。
   把它们配置化只会得到一份无法测试的字符串程序；`transfer/specs/ctrip.json` 与手写计划逐字段一致这条单测，
   才是"配置能表达流程"的证明。
