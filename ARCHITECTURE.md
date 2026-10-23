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

> **规范关系**：六层总览 = **现状**（只画已落地的东西）；目标架构 = **现状 + 裁定 + 下一步**。
> 未落地的改进意见**不进图**（清单留在 `docs/ARCHITECTURE_IMPROVEMENTS.md`），否则图会变成文档的第二份抄本。
>
> **三张图都是生成的**——改模块就改生成器的源；布局不过关（文字出框 / 盒子重叠 / 越出画布）
> 就**非零退出且一个文件都不写**，三个生成器都支持 `--check`（仓库里那份与生成结果不一致即红，
> `tests/arch-diagram.test.ts` 钉住）：
>
> - **系统总览**（七层：入口 / 声明 / 编译与录制 / 计划 / 执行 / 决策 / 验收 + 右栏**外部边界**
>   + 四条红线；数字全部从 `docs/arch-metrics.json` 插值）：
>   [docs/architecture-system.png](docs/architecture-system.png)（矢量版 [docs/architecture-system.svg](docs/architecture-system.svg)）
>   —— `node tools/arch-diagram-system.mjs [--png]`。第一眼看这张。
> - **六层数据流总览**（入口 / 应用数据 / 计划 / 执行 / 模型运行时 / 证据 + 四条红线）：
>   [docs/architecture.png](docs/architecture.png)（矢量版 [docs/architecture.svg](docs/architecture.svg)）
>   —— `node tools/arch-diagram.mjs [--png]`。
> - **重审后的目标架构**（④ 三段化 = 命令层 / 决策层 / 数据槽层；三档裁定；⑧ 已落地的迁移；
>   ⑨ 模型角色的修正）：[docs/architecture-target.png](docs/architecture-target.png)
>   （矢量版 [docs/architecture-target.svg](docs/architecture-target.svg)）—— `node tools/arch-diagram-v2.mjs [--png]`。
>   推理与裁定见 [docs/ARCHITECTURE_REVIEW.md](docs/ARCHITECTURE_REVIEW.md)。
>
> **决策模型的存在理由**另有一份独立审查
> [docs/DECISION_MODEL_PURPOSE_REVIEW.md](docs/DECISION_MODEL_PURPOSE_REVIEW.md)：以"模型是为了简化配置、
> 增加弹性与容错"为唯一准绳，用真 ONNX 模型实测（169/180 步手写了目标；模型 top-1 25%、闸门内
> precision 15%；删掉 hint 后同一批旅程完成率 4/4 → 0/4），结论是**分工写反了**：承重件是
> 声明 + 规则 + 编译/录制，模型是兜底与诊断。修正方案 [docs/MODEL_ROLE_PLAN.md](docs/MODEL_ROLE_PLAN.md)、
> 实施计划 [docs/MODEL_ROLE_IMPL_PLAN.md](docs/MODEL_ROLE_IMPL_PLAN.md)（目标图 ⑨）。
>
> **决策模型可换**：`--provider laya-onnx|scripted-stub|none|first-candidate|coin-flip|always-abstain|jevk5|bailian|token-plan`
>
> **闸门刻度随 provider 校准**（2026-10-15 在线接入审查的实测缺陷）：执行器比的是 provider 的 `score`，
> 而 `score_kind` 两支不可比——0.25 是 laya 的刻度。现在刻度四级可声明 **CLI `--conf-floor` >
> `pack.policy.conf_floor` > `ProviderInfo.floor`（provider 自报）> 0.25**，生效值与来源进
> `effective_policy.conf_floor`；实测 token-plan 自报 0.20（camera-entry 的 0.20 一枪曾被 0.25 误伤），
> 见 [docs/DECISION_PROVIDER_TOKENPLAN.md](docs/DECISION_PROVIDER_TOKENPLAN.md) §4
>
> **③ 提名窄问的运行期接线（opt-in，2026-10-18）**：`semantic-flow --nominate-provider NAME`——
> 仅对 `nominate: true` 且无 `instr` 锁的步、②学习映射与①规则都弃权时，带**页面状态 + 页面条件化候选**
> 问一次决策 provider；模型提名若为元素动作族则作为**软先验**（`RunOptions.expectedFamily`：族内优先排序、不丢其他族
> 元素与上下文；解析族不符时一次**有界修复**，仍不成立 = `nominated_family_empty`/`nominated_family_mismatch`
> 结构化停因；hint 仍权威——硬过滤被否，结构族 ≠ 语义动作）；纯运行期不回填、无上下文不问、抛错/池外落⑤；
> 账单加模型档。缺省不接 = 行为逐字节不变。设计/实测：[docs/NOMINATION_QUESTION_SET_ANALYSIS.md](docs/NOMINATION_QUESTION_SET_ANALYSIS.md) §6–§7
> （`AMBERFLOW_DECISION_PROVIDER`；缝与契约见 [docs/DECISION_INTERFACE_SURVEY.md](docs/DECISION_INTERFACE_SURVEY.md) §7，
> 外部模型接入示例 [docs/DECISION_PROVIDER_JEVK5.md](docs/DECISION_PROVIDER_JEVK5.md)；
> 基线对照 `npm run providers:baseline`）。
>
> **架构本身的改进意见**（计量单一出处 `npm run metrics` → `docs/arch-metrics.json` /
> 决策接口按问法版本化 / 可声明运行策略 / 可逆性模型 / 梯级卫生 / 声明面归并）见
> [docs/ARCHITECTURE_IMPROVEMENTS.md](docs/ARCHITECTURE_IMPROVEMENTS.md)。
>
> **落地状态：P0（形状硬化，不改任何运行结果）、P1（hint 单实现 +
> tier 候选集，门控 `tieredHint` 默认关）、P2（命令层 `src/engine/actions.ts`）、P3（数据槽层
> `src/engine/bindings.ts`）、P4（声明式后继 `next`，应用旅程层）、D3/R-4（`inert` 不再是唯一终止依据：
> `maxEffectiveRepeats` + 结构化 `no_progress`）均已实施并带负例测试**
> （`tests/executor-p0.test.ts` 21 / `tests/rules-tiered.test.ts` 24 / `tests/actions.test.ts` 15 /
> `tests/bindings.test.ts` 20 / `tests/path-next.test.ts` 17 / `tests/no-progress.test.ts` 5）；
> 每个门控都按"不声明即逐字节等价"落地，验收台是两个新应用包（`apps/checkin-binding`、
> `apps/cold-search-next`）与一份死目标夹具（`testpages/dead-target.html`）。线上包 A/B 的
> 真机数字仍未做（要网络与权重），`runPlan` 的队列语义与 `next` 边的关系见 §七.3。

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

这条链在 2026-10 重审后按"这一步在干什么"分成三段（[docs/architecture-target.svg](docs/architecture-target.svg)）：
**命令层**（声明半 = 应用配置 / 实例化半 = 运行期把声明 × 当次观察收成候选集）、
**决策层**（只读，唯一问模型的地方，只在闭集内选）、**数据槽层**（声明式绑定 + 该面原语执行）。
已落地的 P0/P1 不改这十个盒子的顺序，改的是它们的**形状纪律**：禁元素单出口、停因是数据
（`stop_code`）、敏感值掩码、hosts 导航信封、配置错误不重试、hint 档内歧义成为可交给决策层的
**候选集**（`tieredHint`，默认关）。"选目标 4 个盒子 / 定参数 0 个盒子"的比例失衡就此有了承接面——
把它彻底改成"命令 × 参数"闭集是 P2/P3 的事，门槛是 P1 的 A/B 数字（见 §四.11）。

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

### 2.2 应用支持器（AppAdapter）：一种应用类型 = 一个适配器

TS 应用层（`apps/<id>/pack.json` + `src/app/app-adapters.ts` + `src/app/app-runner.ts`）把"应用"从
"浏览器任务的配置"升级成**多类型应用的声明**：

- **应用 = 目录**：`apps/<id>/pack.json` 声明角色/旅程/结束态不变量/数据袋/数据腿/设备面/策略；
  发现制（没有中央清单），加载期校验（未知键、坏信号、跨类型键、占位符全都红）。
- **类型抽象**：`src/app/app-adapters.ts` 的注册表里，一种类型 = 一个 `AppAdapter`——声明面
  （`stepKeys`/`validateStep`/`expand`）、信号面（web=DOM；进程族=`tool-signals`）、执行（`run`）、
  能力探测（`ready()`）。内建四种：`web`（浏览器，唯一执行器）、`cli`（本地命令行）、
  `ssh`（真实 ssh 子进程）、`stdio`（交互式进程/游戏：提示-应答-信号-超时）。
  步用 `adapter` 键指名类型（缺省按 source 推断，既有包逐字节不变）。
- **同一流程不限类型**：一条 journey 可以混用几种类型；`next` 走向、重试、危险门、不变量同一套语义。
  示范应用 `apps/mixed-demo`：web → cli → ssh → cli → web → stdio → cli，7/7 步通过。
- **返回信号可传递**：任一步在**信号成立后**按 `returns` 抽取观察里的值（进程族：stdout/regex/exit_code），
  写进运行级数据集（带 `stepId#attempt` 溯源、重跑先失效）；后续步骤以 `{dataset:NAME}`（进程族 argv/输入）
  或浏览器命令绑定 `{from:"dataset"}` 消费；缺失/陈旧 = 结构化 `needs_value`，绝不猜。
  加载期对账产者唯一、消费者必须有产者。
- **类型无关的不变量**：`invariants[i].adapter` 缺省 = web（浏览器结束态）；其它类型 = 旅程结束后的
  **只读观察探针**（如 ssh `test -s` 验远端产物、cli 验错误路径），拒绝 retries/dangerous/when。
- **能力闸与语料纪律**：依赖本机服务的类型（ssh 需要 sshd）在套件里由 `ready()` 探测，不可用**如实跳过**
  （跳过 ≠ 通过）；机器无关的冻结语料（网页提名集）按同一条规则排除能力探测型应用。
- `when` **有意保持 web-only**：它问的是"这一步在这个页面上适不适用"；进程类步骤没有可问的页面，
  分支用 `next` 边 + 各自信号表达（不是遗漏，是语义边界）。

设计、验收表与逐片记录：[docs/APP_SUPPORTER_DESIGN.md](docs/APP_SUPPORTER_DESIGN.md)；
应用写法：[apps/README.md](apps/README.md)。

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

### 10. 模型价值可见性：保险要报数（2026-10，`docs/LAYA_VALUE_PLAN.md` P0–P2）

诊断：**离线应用 100% `rule:match`，模型出场散在 step 日志里没人汇总**——"没权重也能跑"于是被读成"模型没用"。
对策不是让模型多干活，而是把已有价值变成可核对的数（红线：`learn` 的零模型重放门控与 DOM 信号唯一真值**不动**）：

- **装得上（P0）**：`npm run model:fetch -- --from <url|file://|本地路径>`——图 + 外置权重 +（可选）tokenizer，
  `.part` 先落、SHA256 **先验后换**（坏件绝不覆盖现有产物）；`doctor` 从"缺"升级成**点名缺哪件 + 一条补齐命令**；
  三件探测的单一出处是 `src/model/model-artifacts.ts`（doctor / fetch / 运行器 / 桥共用，防第二套判据漂移）。
- **看得见（P1）**：每次运行汇总 `rule N · laya N (conf) · laya:reobserve N · escalate N · 咨询 N · cache 命中 N/M`，
  进 CLI 报告、`apps:suite` 表格、`apps:matrix` 两列与 DSH 桥 `amberflow_run` 的 summary（外加 `model: on|off(missing)` 层级行）。
  口径有两个出处且各有道理：**过关数在 trace 里数**（执行器只把过关的决定写进 trace），
  **咨询数在运行时缝上数**（`countingRuntime`）——低置信 break 的那次咨询不在 trace 里留 `method`，
  只按 trace 数会把"保险被碰过"（`transfer-slowjet` 的冷加载）漏报成零出场。
- **讲得清（P2）**：README 的"为什么本地还养一个模型"给四组带复现命令的数字，含诚实边界
  （CJK 页面上模型 0.03–0.09，所以路由按文字系统切、不按置信度切）。

### 11. 执行层三段化：先形状，后能力（2026-10 重审，`docs/ARCHITECTURE_REVIEW.md` P0/P1 已落地）

重审的结论不是"执行层少了一层"，而是 `run()` 把**实例化动作空间 / 选择 / 应用动作**揉在一个
约 550 行的可变状态机里（7 处禁元素出口、12 处散文 stop_reason、7 种 trace 形状）。
迁移顺序按"性价比 + 现成验收台"排：P0 只改形状、不改任何运行结果，把 P1–P4 要踩的地基先立住。

**P0（已落地，`tests/executor-p0.test.ts` 21 条负例钉死）**

- **禁元素只有一个出口**：`forbid(ref, el, why)` / `unforbid` / `pruneForbids`（D1/D2——同一件事
  曾有 7 处写入、3 处独立 re-prune；源码结构守卫测试把它钉成 1 处）。
- **停因是数据**：`RunReport.stop_code`（`StopCode` 枚举）+ `stop_step`；人读串 `stop_reason`
  逐字节照旧（冻结 parity 语料钉的是人读串——加形状，不改措辞）。
- **敏感字段遮蔽**：`password/file/hidden` 的值在 inert 快照、trace、报告、归纳 witness 里
  一律替换为**按长度的掩码**（`***(N)`）——明文不落盘，而"输入改变了页面"仍可判（否则填密码
  会被误判 inert）；`css_value_equals` 走真实 DOM 读取，判完成不受影响。
- **hosts 是导航信封**（运行期强制，不再是纯文档）：goto 前拒绝未声明主机（0 步 0 副作用），
  动作后落到未声明主机即结构化停止；`file:/about:/data:` 不拦、**空声明不启用**（离线夹具包
  逐字节不变）。子域按后缀放行。
- **配置类错误不是瞬时失败**：`preflightConfig` 在任何腿**之前**拦下"显式指向不存在的产物"
  （实测旧行为：坏 `LAYA_ONNX_MODEL` 把数据腿和第一个工具步都跑掉了，同一错误重试 2 次）；
  `NEVER_RETRY_CODES = {config_error, host_not_allowed}` 让重试环只跑一次。顺带钉死
  `LAYA_ONNX_MODEL` 与 `LAYAA_*` 旧名的优先级单一口径（doctor 与 runtime 曾判得不一致）。
- **应用落盘移出 checkout**（前提 A）：`src/app/amberflow-home.ts` 定义 `$AMBERFLOW_HOME/apps`
  （缺省 `~/.amberflow/apps`）；`learn`/`plan:flow` 的新产物默认写用户作用域，
  发现制扫 `[用户目录, 仓库夹具]`、同 id 用户优先——仓库 `apps/` 降为开发夹具，
  `spec_version` 不认识就响亮拒绝（CI 盖不到用户的包，猜 = 静默错）。

**P1（已落地，门控默认关；`tests/rules-tiered.test.ts` 24 条）**

- 6 种 hint 语法收敛为**单一**走查器 `hintMatchImpl`：`hintMatch` 是它"塌缩后"的那只眼睛，
  `hintCandidates` 是"不塌缩"的那只（最强非空档的 refs + tier + submit-decided）；
  `hintMatch ≡ firstIfSame(hintCandidates)` 由 20 例差分测试逐形状钉死。
- 档内歧义不再退化成"40 里选 1"：`tieredHint`（默认 OFF）打开后，歧义档变成对模型的
  **更小提问**（候选 3 条只问 3 条；实测同一页 OFF 问 15 / ON 问 3），窄问弃权即回退整池，
  阶梯顺序与四个 `method` 取值一字未动——报告、对拍语料、`apps:suite` 结论不受影响。
  出口打通到 CLI（`--tiered-hint`）与 DSH 桥（`tiered_hint`）。

**P2 已落地（命令层，`src/engine/actions.ts`，门控 = 字段本身：不声明逐字节不变；`tests/actions.test.ts` 15 条）**：
- **声明半（加载期）**：`COMMAND_OPS = click|check|fill|select|skip` 是引擎能力面（代码），
  应用/计划里的 `commands` 引用它——未知 op、重复 id、`fill` 缺绑定、`skip` 带 target、
  参数来源非 `slot` ⇒ 全部**加载期红**（`validateCommands`，由同一个 `PlanningRules.problems`
  走查，不新开第三套语法——§8.3）；pack 步与 `Subgoal` 都能带，TaskPlan 磁盘往返保留。
- **实例化半（运行期，纯函数）**：`instantiateSpace(decl, pool, forbidden)` = 声明 × 当次观察；
  解析不到的候选出局（带 hint 同款的预算回捞），**全空 ⇒ 结构化 `space_empty`，绝不退回全池、
  绝不问模型**（闭集不可逃逸）。`fill`/`select` 的值只按名从计划槽位绑（`resolveCommandValue`），
  缺绑 ⇒ `needs_value` 结构化停 + 进 `NEVER_RETRY_CODES`（同一个袋重跑还是同一句话）。
- **验收用例兑现**：SkyBook"勾选 + 提交"放进**一个子目标**（§七.9 的未解边界 → 可表达）——
  真 site2 夹具上 2 条 executed 命令、`command: [check, record]`、零模型选择提问、信号落账；
  同时"删即是红"：同一步去掉 `commands` 回到两跳深链的旧世界（旧冻结包一字未动，
  `apps:gen --check` 8/8 仍逐字节）。

**P3 已落地（数据槽层，`src/engine/bindings.ts`，门控 = 绑定形状本身：不声明逐字节不变；`tests/bindings.test.ts` 20 条）**：
- **三条来源，都必须声明点名**（红线②：模型永不参与选值）：`{from:"slot",key}`（计划数据袋，
  今天的前身是 `--slot k=v` / `plan.slots`）、`{from:"option",key,match}`（**当次观察**到的页面候选
  + `match: value|label|contains`，今天的前身是 `<select>` 标签→值两候选回退）、
  `{from:"list",by,order}`（行集 + `order: min|max`，今天的前身是 `list_step` → `selectIndex`）。
- **规则必须声明**：`option` 不给 `match` 就是"看着像就填"，加载期直接红；`list` 的
  `min|max` 合法面只在 `bindings.LIST_ORDERS` 一处（`semantic-flow` 不再复制词表）。
- **分档匹配、档内歧义即弃权**（把 P1 的 tier 纪律用到"值"上）：`value` 精确 → 折叠大小写 →
  `label` → 子串，逐档找**唯一**命中；一档里 >1 个候选返回失败而不是掷硬币。
- **解析走一份实现**：`resolveBinding` 是纯函数；`list` 直接调 `datasource.selectIndex`
  （`selects` / `list_step` / 命令绑定同一个它）；`<select>` 的候选在**绑定那一刻**现读
  （`_optionCandidates`）——"此刻有什么"是观察，不是记忆。
- **验收用例兑现**：`apps/checkin-binding` 在真夹具上一条命令完成"选日期 + 确认"
  （机器值 `2026-10-13` ≠ 人读标签 `10月13日 周二`），全程 `rule:match`、零模型选择提问；
  规则命不中 ⇒ 结构化 `needs_value` 且**页面一个字没改**（负例钉在 `tests/bindings.test.ts`）。

**P4 已落地（声明式后继 `next`，应用旅程层；`tests/path-next.test.ts` 17 条）**：
- **边是编译期就有的**：应用包的步本来就有 `id`（此前是死字段），`next: ["step-id", …]` 是有序候选；
  加载期校验"步 id 唯一 + 落点必须存在"（一条指向空气的边 = 一步都不走的静默分支，加载期红）。
- **运行期只选走哪条**：按声明顺序取第一个"此刻适用"的候选，适用性问的就是该步**自己的 `when`**
  ——与"这一步适不适用"是同一个问题、同一套信号语言、零模型参与（红线①）。`when` 因此会被问
  **两次**（选边时在来源页、进入时在它自己的 `start_url`），所以跨页分支的守卫要写成"页面角色级"
  的事实（两页都成立），否则边会被选中、步却会在进入时被跳过。
- **被边跨过的步记成 `skipped`**（`path_crossed` 单列"是谁跨的"）：那条边就是作者对"这条路径上
  它不适用"的声明；否则任何前向分支都会因为"跨过的步留在 pending"而永远红。
- **路径上界是硬约束**（X4：`maxSteps` 是每步的，不是每路径的）：`plan.createPathWalk` 给每个
  步步 id 计数，缺省 3（包可声明 `max_step_visits`）；到顶就是结构化 `path_stop.code = "next_cycle"`，
  点名哪一步、进了几次——不挂死、不栈溢出。走过的次数进报告（`path_visits`），回边不是隐形的。
- **验收用例兑现**：`apps/cold-search-next` 的冷启动回边把 search 走了两遍然后走下去（`path_visits`
  可查）；**删 `next` 即红**（record 的 `when` 不成立 → skipped → 不变量不成立）；无条件自环跑出
  `next_cycle`。计划级 runner（`runPlan`，resume 队列语义）对 `next` **响亮拒绝**而不是静默忽略。
- **仍未做**：`runPlan` 的队列语义与声明边是两套（见 §七.3）；`BrowserMiddleware` 更名（前提 C）
  仍欠着；线上包 A/B 的真机数字还没有（要网络与权重）。

**D3 + R-4 已落地（`inert` 不再是循环唯一的终止依据；`tests/no-progress.test.ts` 5 条）**：
- **病灶**：`inert` 是整页快照比对——页面有倒计时/轮播/埋点回执时它**永远不成立**，
  "这个元素没用了"的证据链断掉，anti-repeat 不触发，同一个死按钮被反复点，最后报告把病因
  写成 `max_steps`。噪声信号不该是唯一的终止依据（重审 §2-D3），R-4 要的正是"卡住 ≠ 预算用完"。
- **做法**：`MiddlewareOptions.maxEffectiveRepeats`（缺省 3；**0 = 显式消融**回到旧行为）——
  一个子目标内同一个**元素签名**被执行的次数超过上界而完成信号始终不成立 ⇒ 结构化
  `stop_code: "no_progress"`，正文点名元素、次数与"不是步数预算"。计数发生在信号（含 SPA settle
  窗口）与人工/noul 检查之后，数的正是"驱动了但没进展"；签名而非 ref（ref 每次重扫重新编号）。
- **§8.5 的验收兑现**（夹具 A/B，数字进断言）：`testpages/dead-target.html` 同时是"死目标"
  （handler 存在但什么都不改）与"吵页面"（50 ms 倒计时 + 页面级点击计数——后者的确定性让
  这条夹具不靠采样运气）。关掉上界：**8 步全花在同一个死按钮上、`max_steps`、4.5 s**；
  缺省上界：**第 4 步 `no_progress`、2.3 s**——更早，且理由不同。
- **不误杀合法重复**：点到第 3 次才成立的信号依旧 `dom_goal_signal`；`retries` 的每次尝试重置
  计数（那是"整个子目标重来"的合同，有界且如实）。六层对拍与全部应用套件一字未动。

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
3. **一个子目标里的动作是"直线"；走向（`next`）已在应用旅程层开口（P4）**：`target_hints`（有序 hint 列表）
   解决了"填表 → 选择 → 提交"这类连续动作，子目标也能带自己的 `slots`；`when` 让它在不适用时被**跳过**
   （复刻站 #6），`retries` 让它在这一次失败时**整步重来**（复刻站 #7）。P2 的 `commands` 把这条直线
   升级为**声明的命令闭集**（带 op、带具名参数绑定、解析不到的候选出局；§七.9）；P4 的 `next`
   让**步与步之间**的走向成为声明（有序候选 + 该步自己的 `when` 作适用性判据，带路径上界与
   `next_cycle` 结构化停因）——"回退到第 N 步"现在是可表达的（`apps/cold-search-next` 把冷启动
   搜索走了两遍），**子目标内部**的分支/循环仍然不可表达（一步之内还是直线）。
   **两处仍然不覆盖**：① `runPlan`（计划级 runner 的 resume 队列）**响亮拒绝** `next`，
   声明边只在应用旅程层生效——同一份计划被两个 runner 用两种走向语义驱动是不可接受的；
   ② 语义流模板（`flow.json`）的步骤键是白名单，`next` 不在里面（要加需先改那个白名单与它的
   `repeat` 语义）。骨架形状现在是配置（阶段列表 + `stage`/`repeat`，见 `transfer/specs/voyagio.json`
   的两页向导），但 `repeat` 只有 once/per_date/per_checkin 三种，**没有"回退/条件跳转/并发搜索"**——
   那些要么加新的 repeat 语义，要么由 replan 接手。
4. **hint 语法：池侧已单实现，DOM 侧仍是第二匹配器**。P1 把 6 种语法收敛进 `rules.hintMatchImpl`
   （`hintMatch`/`hintCandidates` 同走一遍，差分测试逐形状钉死等价）；`extraction.hintLookup`
   为回捞被预算挤出的元素仍在 DOM 里再解析一次（它必须查活页面），历史上它漂移过两次
   （`#id` 只加一侧、`=` 分支漏大小写折叠），所以它的形状仍要和新走查器**成对修改**，
   且依赖向页面 DOM 写入 `data-hintref` 章。
5. 注入闸门 0.95 与良性页实测 0.91–0.94 只差 0.01，需要按页面类型分层。
6. **真 LLM 闭环仍未实跑**：本机没有 `OPENAI_*`，`LLMPlanner`/`LLMAuditor` 只有离线单测覆盖（prompt 携带页面快照、hint 保留、replan 成功/无进展/次数上限）——缺的是端点，不是代码。replan 尚未把**阻塞那一刻**的页面快照传回 planner（`page` 就在作用域内，2 行改动）；`LLMAuditor` 也还没替掉 `MockAuditor`。
7. `_listener_cache` 按 URL 无上限增长；`run_bench.py` 只在全部跑完后落盘（一次 35 min 的跑分险些因超时全丢）。
8. **携程线上站在本环境不可达（外部约束，不是代码问题；第 10 轮又补了手机模拟与区域域名）**：`flights.ctrip.com` / `m.ctrip.com` 机票页对浏览器 UA 一律 HTTP 432
   `whaleguard block`（真浏览器同样 432），换 curl 客户端才拿到 Next.js 空壳而列表走 XHR，老接口 `/itinerary/api/12808/products` 已下线；
   `hotels.ctrip.com` 列表页 SSR 能出酒店名/星级，但未登录访客的价格节点为空（"登录以查看会员价"），「≤300 元」无法判定。
   补充：iPhone/Android UA + 移动视口 + 触摸、`hk./us./sg.trip.com` 三个区域域名 —— 10 次访问 10 次 432，
   说明挡的是**出口 IP**而非 UA/设备/区域；酒店列表在浏览器里会被**重定向到登录页**（`passport.ctrip.com`）。
   实测与复现用的探针驱动已随 2026-10-21 驱动退役从 `src/sites/` 删除，原始观测归档在 `ctrip/results/{live_probe.json,live_capture/}`（原 Python 版命令与输出归档在历史 bundle，见 [BACKUP.md](BACKUP.md)）。
   因此 `ctrip/` 用例跑在**本地复刻站**上，
   票价/房态是本地生成数据（结论只对复刻站成立，不代表真实携程报价）。
9. **一个子目标只有一次点击——已被 `commands` 开口（P2）**：筛选/排序若停留在页面 JS 状态里，`run()` 每步重新 `goto` 会丢状态、且同一个 hint 会被反复点。
   复刻站的做法是把状态写进 URL（真实列表页亦然），于是"筛时段/排序/记录"拆成三个各一次点击的子目标；换到状态只在内存里的站点需要另想办法。
   迁移测试又撞了一次同一堵墙，这次是**选择状态**：SkyBook 的"先勾选、再提交"跨两个子目标时，
   记录那一步在新页面里什么都没勾选，信号永不触发（执行器在 `max_steps` 里打转、然后被 laya 带去点别的按钮）。
   修法仍在配置层：勾选后跳一次 `…&selected=all`，让 `start_url` 完整决定这一步的状态。
   **"勾选+提交放进一个子目标"现在是可表达的**（2026-10 P2）：步可声明 `commands` 闭集（`src/engine/actions.ts`），
   声明 × 当次观察实例化成候选，按声明顺序走、每步一个动作、同一子目标内推进
   （`tests/actions.test.ts` 用真 site2 夹具跑通：2 条 executed 命令、1 个子目标、零模型提问、`#hotel-recorded` 落账）。
   **这一步的参数也不需要猜**（2026-10 P3）：`value` 是**声明式绑定**（`src/engine/bindings.ts`）——
   计划槽位、页面候选（`match: value|label|contains`，档内歧义即弃权）、行集（`order: min|max`），
   三种来源都必须点名；命不中 ⇒ 结构化 `needs_value`，页面一个字不改
   （`apps/checkin-binding`：机器值与人读标签不同的真 `<select>`，全程 `rule:match`、零模型提问）。
   **不因此改变的是**：冻结复刻站照旧用 URL 深链——那 8 个生成包的展开与 `plan_sha256` 是逐字节钉住的回归语料，
   命令闭集与绑定是给**新写/用户录**的包的表达面，不是把已验收的包改写一遍。
10. **流程是配置，但有三样东西刻意不配置**：判分口径（必须是独立第二实现）、站点库存生成器、执行循环。
   把它们配置化只会得到一份无法测试的字符串程序；`transfer/specs/ctrip.json` 与手写计划逐字段一致这条单测，
   才是"配置能表达流程"的证明。
