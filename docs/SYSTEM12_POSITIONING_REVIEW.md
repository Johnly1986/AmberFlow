# 系统定位与架构评审：以「SystemTwo 规划 / SystemOne 执行与弹性泛化」为透镜

**日期**：2026-10-15 ｜ **性质**：外部视角的定位与架构改进意见（读完文档面 + 抽查实现后写就）
**与既有文档的关系**：不重复已落地的裁定与计划，只引用——
[DECISION_MODEL_PURPOSE_REVIEW.md](DECISION_MODEL_PURPOSE_REVIEW.md) / [MODEL_PURPOSE_ARCH_REVIEW_2.md](MODEL_PURPOSE_ARCH_REVIEW_2.md)（模型边际实测，R1–R6）、
[ARCHITECTURE_IMPROVEMENTS.md](ARCHITECTURE_IMPROVEMENTS.md)（缝的结构改进，§1–§9）、
[DECISION_LAYER_SYSTEMONE.md](DECISION_LAYER_SYSTEMONE.md)（决策层收敛 Stage 1–4，Stage 1 已落）。
本文新增的是：**用「SystemTwo/SystemOne」这把尺重新审一遍定位表述**，加上四个抽查实现后确认的
新结构问题（B1a/B1b/B2/B6），与一份定位句重写建议。

> 本文每个数要么来自上列文档的冻结实测、要么本轮从代码里核对（标注文件:行）。
> 复算入口见 §六。

## 0. 一句话结论

「SystemTwo 规划、SystemOne 执行与弹性泛化」这个定位**方向正确、但主语记错了账**：本仓自己的
实测已经证明，执行与弹性的承重件是**声明 + 规则 + 验证运行时**（信号裁决、重放门、梯级卫生），
SystemOne（决策服务）的贡献集中在两处——**闭集内提名**（learned-hint 闭环，−17% forwards）与
**可逆步上的试错**（A2′ 裁决，漂移族 0/3 → 3/3）。所以定位应该从「两个大脑分工」改写成
「**编译器 + 验证运行时 + 学习环**」三位一体：SystemTwo 的产物是可验证的声明，SystemOne 的
产物是被信号裁决过的提名，系统真正的资产是**把成功提名沉淀回声明的闭环**。架构上最值钱的
下一步不是加能力，而是把这条闭环做成**单一纪律**（现在有两套学习库、两种资格论）并把
SystemOne/SystemTwo 都收敛成 thin client。

## 一、定位评审（表述层的问题，不改代码也要改）

### A1. 「SystemOne」一词现在有两个含义，先分家

- 认知意义：ARCHITECTURE.md §一 的「System 2 编排 + System 1 执行」——快/慢思维分工的比喻。
- 协议意义：[DECISION_LAYER_SYSTEMONE.md](DECISION_LAYER_SYSTEMONE.md) 的「System One 线协议」
  （`{state, questions} → {answers}`，一次前向、不生成文本）——一个具体的决策服务接口。

两个含义在文档里并存且都活着。危险在于：「SystemOne 做执行」这句话会把**执行器**（规则、
信号、闸门、梯级卫生——全部非模型机制）的承重功劳记到**决策服务**头上，而本仓对这一点恰恰
有最硬的反例：稳态语料 `规则/hint 决定 201 ｜ laya 0 ｜ reobserve 0 ｜ escalate 0`（梯级账单，
dead rung 自报）。

**改**：定一个三词术语表，全仓统一——
**编排期（SystemTwo）**＝LLM 服务消费方（planner / plan:flow / escalate 老师 / auditor）；
**决策服务（SystemOne）**＝线协议与 provider（laya / JevK5 / 百炼 / 基线）；
**验证运行时（runtime）**＝执行器 + 信号 + 闸门 + 学习环——它不属于任何一个"系统"，
它是让前两者都变得可审计的那一层。README 的第一段与 ARCHITECTURE.md §一 各改一句话即可。

### A2. 「SystemOne 做执行和弹性泛化」要按实测收窄成三句可承诺的话

| 定位原句拆开 | 实测（既有冻结数据） | 可承诺的表述 |
|---|---|---|
| SystemOne 做执行 | 已验收语料浏览器步 **171/171 由声明解决**（169 hint + 2 commands）；真模型 201 步被咨询 5 次、**独立决定 0 步**（`apps:suite` 模型边际列，边际 0 ⇒ 退出码 4） | 「SystemOne 在声明拿不准的步上**提名**；提名一律过置信/风险/可点性闸，完成与否由 DOM 信号裁决」 |
| SystemOne 做弹性 | 漂移族真模型臂 **0/3**（`tools/drift-real-arm.ts`）；A2′ 裁决后 **3/3**（`tests/executor-adjudicate.test.ts`） | 「弹性的一半来自声明三件套（`when` 7 / `retries` 11 / `next` 1）与梯级卫生；模型贡献的弹性目前**只在可逆步 + 事后裁决**这一档有数字（3/3），且爆炸半径由 `effect.irreversible:false` 声明限定」 |
| SystemOne 做泛化 | learned-hint 闭环：同一矩阵二跑 forwards **53→44（−17%）**、两腿通过数相同；语义流二跑 `rule 4 · laya 0 · escalate 0` | 「泛化的机制是**学到即规则**：首次迁移贵（现场选/老师点名），之后每跑一次都在摊销——同计划二跑 12 forwards → 0、9.2 s → 1.3 s」 |

**为什么是定位问题**：对外（README / DSH 插件描述）一句「执行由决策模型完成」会引导用户用
「模型准不准」评价这个系统；而这个系统的差异化恰恰是**模型可换、声明不换**（provider 注册表 +
`apps:matrix` 泄漏门 + 零模型回放门）。卖点说反了，验收也就跟着问错了。

### A3. 把「越跑越便宜」从实验现象升格为产品主张

摊销曲线是这个系统最独特的可测性质，现在散在三处数据里（决策缓存 12→0 forwards；语义流二跑
零模型；hint:measure −17%）。建议把它升格为一级指标：每个应用包在 `apps:matrix` 里报
**「稳态成本」**＝最近一次运行的 forwards / 在线请求数（现在只有套件页脚的梯级账单，
包级看不见）。这同时给了「学习环是否有用」一个不依赖临时 A/B 的常设读数（R2 落地后
matrix 已有「学到/复用」列， forwards/请求列是它的自然补全）。

### A4. 「不是只服务浏览器」要变成一等定位，而不是前提脚注

前提 C（[ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md) §0.1）已裁定：浏览器只是第一个面，
每个面提供（原语、观察形状、证据语言）。但名字与文档没跟上：执行器仍叫 `BrowserMiddleware`
（前提 C 自己点名的债）、`tool-signals.ts` 是"第二个面的证据语言"却写在浏览器叙事之下、
红色三条里「DOM 信号」的措辞在 CLI 面应为「进程观察」。定位句建议：
**「面向多表面的验证驱动自动化运行时；规划期消费 SystemTwo 服务，执行期消费 SystemOne 服务，
两者都是可替换的外部依赖；核心资产是声明（应用包 + 站点档案）与学习环。」**

### A5. README 的定位句已经落后于决策层收敛的方向

README 第一段仍是「执行由**本地**规则与决策模型逐步完成」、`为什么本地还养一个模型` 一节
以本地 ONNX 为中心；而 DECISION_LAYER_SYSTEMONE 的准绳是「决策模型加载/启动隔离到服务侧，
本项目只做 SystemOne 适配」，Stage 1 已落（`src/system-one-client.ts` + bailian/jevk5 profile）、
在线 provider 掉线优雅降级也已落（cad3d2c）。**两套叙事并存会让新读者装错心智模型**
（以为要下 1.7 GB 权重才能用）。建议 Stage 2/3 落地时同步改写（Stage 4 原计划就含 README
收口，这里提前指出措辞方向：见 §五）。

## 二、架构评审（抽查实现后确认/新增的结构问题）

### B1. 完成 SystemOne 服务化，但 Stage 3 的删除清单要改两处（B1a/B1b 是本文新增）

现状：Stage 1 已落（`systemOneClient` + profile；显式点名未配置报错、环境默认未配置落
rules-only——64ab8fb）；但两缝并存（`installLayaRuntime` 57 处引用 vs
`installDecisionProvider`），执行器里仍有 `router/agentFor/embedFn/routeModels` 本地机器
（executor.ts:815/934 一带）。**Stage 2/3 按原计划走**，以下两处是对原计划的修正：

**B1a. 决策缓存不该跟着 laya 一起删——它应该升到客户端层。**
`withDecisionCache` 现在包的是 `LayaRuntime`（decision-cache.ts:60，app-runner.ts:1006 接线），
DECISION_LAYER_SYSTEMONE §2 把它列入删除清单（"laya 形状专属"）。但服务化之后缓存的**价值
变大了**：本地前向 ≈35 ms（GPU）/0.5–1 s（CPU），在线一次往返是网络延迟 + 配额 + 数据出域；
确定性模型不该被问第二次的论证（12 forwards → 0）对在线服务**更强**成立。
**改**：把缓存做成 `systemOneClient` 的装饰器（fingerprint = provider name + version +
state+questions 的规范化 JSON，命中写 JSONL 的既有形状照搬）。**验收**：同一计划二跑，
在线 provider 请求数 = 0；`--provider none`（rules-only）路径字节不变。

**B1b. 在线 SystemOne 看到的页面比本地薄得多——对照实验现在不公平。**
`buildChoiceBody` 发出的 choice 请求 `state: { goal }`、`criteria: {ref: label}`
（system-one-client.ts:91-98）——**不含 url/title/页面文本**；而本地 layaProvider 自己调
`criteriaView/stateText` 渲染富视图（decision-provider.ts:28 的 import 链）。`req.page` 在
`ChoiceRequest` 里传进来了却没人用。这意味着"在线模型输给本地"的任何结论都混杂着
"在线模型没看到页面"这个混杂变量。
**改**：profile 增加默认 state 渲染器（url + title + 有界文本摘要，本地/在线共用同一份
渲染实现），profile 可覆盖。**验收**：jevk5/bailian 与 laya-onnx 的 A/B 在同一 state 渲染
下重跑 `providers:baseline`；渲染器输出进 trace（可审计）。

### B2. 两套学习库、两种资格论——统一成单一 LearningStore（本文新增，优先级高）

抽查确认的结构性分叉：

| | `HintMemory`（R2 sidecar，app-runner 主链路） | `SiteProfileMemory`（semantic-flow） |
|---|---|---|
| 键 | `(exact url, 子目标指令哈希)`（hint-memory.ts:86-91） | `(站点, 语义步 id)`——人可读、跨页复用 |
| 落盘资格 | 模型选择推进了子目标即 `record` **立即落盘**（executor.ts:2192-2198） | staged → 同运行零模型整跑重放 → `commitVerified` 才落盘（semantic.ts:268-372） |
| 撤下机制 | **无**（坏条目靠"hint 匹配不到就回落模型"兜底） | `failures` 连续 N 次 → `drift` 撤下、重放清零（semantic.ts:388-392） |
| 计数 | 无 | `replays_ok` 只增、改 hint 归零 |

问题有三层：①**认识论不一致**——同一种知识（学到的 hint）在主链路是"赚到就存"、在语义流是
"验证过才存"，而红线④已经裁定"不可复现即拒存"应是**任何运行期新知识的通用门槛**
（ARCHITECTURE_REVIEW 裁定 #4）；②**主链路的条目会僵死**——URL query 一变整条失效（键是
exact url），更糟的是**匹配得到但页面已改版**的死 hint 没有撤下路径，每跑一次都在同一处
 blocked（drift 机制在另一套库里已经写好了）；③**两套库的学习互相不可见**——app-runner
学到的条目不能喂给语义流迁移，反之亦然。
**改**：把 `SiteProfileMemory` 的纪律（staged → verify → commit → drift）下沉为通用
`LearningStore`，`HintMemory` 变成它的 exact-url 键控 adapter；至少先给主链路补 drift 撤下
（连续 N 次用了没让信号成立 → 删条目并报 `drift`，语义流同款）。**验收**：`--learn-hints`
的条目带 `replays_ok` 语义；`testpages/drift/` 里改 `data-test` 那类夹具二跑不再拿死 hint
反复空转；语义流 42 条测试不改一字全绿。

### B3. 「步」的四种载体归一成 StepSpec IR（老债 U2，语义流白名单又添了一笔）

ARCHITECTURE_REVIEW §1 数过 4 个互不相同的"一步"载体（app-pack.ts / plan.ts /
semantic-flow.ts / flow.ts）；此后 P2/P3/P4 又各加了一面（`commands`/`bindings`/`next`），
`next` 在 `runPlan` 被响亮拒绝、`flow.json` 步骤白名单不收（ARCHITECTURE.md §七.3②）——
**同一个走向语义现在有三处解释器、两处明确不支持**。发散度已可计量
（`corpus.surfaces`：`target_hints` 22 步 + `commands` 4 条并存）。
**改**：定义单一 `StepSpec`（pack 步 / Subgoal / flow 步的公共超集，含
commands/bindings/next/effect/adjudicate/policy），三个 runner 都是它的解释器、差异只在校验
档位；`spec_version` 兼容纪律照旧（不认识就响亮拒绝）。**验收**：新增一个声明面只改一处；
`flow.json` 可用 `next`；六层对拍 + `apps:gen --check` 逐字节不动。
**代价/风险**：L；只对新写/用户录的包生效，冻结语料一个字节不改（P2 落地时的同一条纪律）。

### B4. hint 语法的第二实现收编成单一 Handle AST（裁定 #9 定了方向，未做）

裁定 #9 说"hint 权威必须留、载体要换：从两处实现的字符串语法换成一处解析的结构化句柄"
——现状仍是 `rules.hintMatchImpl`（池侧）+ `extraction.hintLookup`（DOM 侧回捞）成对修改、
历史上漂过 2 次（`#id` 单侧、`=` 漏大小写折叠）。B2 的 LearningStore 落地后**学到的句柄
会变多**（这正是它的产出物），第二匹配器的漂移成本随之上升。
**改**：单一 parser 产出结构化 `Handle` AST，`hintMatch/hintCandidates/hintLookup` 都消费
AST；字符串语法保留为兼容输入（parse 一次、处处用树）。**验收**：`tests/rules-tiered.test.ts`
的 20 例差分从"钉两个实现等价"退化为"钉 parser 兼容"；DOM 侧回捞不再需要成对修改的注释
警示。

### B5. 梯级 × 智能的正式化（R3 记录未动；A2′ 之后有了新依据，建议先拿数）

一个 provider 现在服务五档（规则兜底/窄问/加宽/升级/裁决）。实测各档需要的智能不同：
恢复档零智能遍历最优（first-candidate 3/4 > laya 0/4）、裁决档要"低置信但常对"（A2′ 3/3）、
作者档要语言理解（laya 做不了，LLM 老师）。`pack.policy` 已有四键先例。
**改**（观察档）：policy 增加 per-rung provider 声明（如 `adjudicate: laya` /
`escalate: <systemtwo profile>`），先在漂移族 + 真模型臂上拿数，数字不支撑就不进缺省。
**验收**：声明的包在 drift 族恢复率 ≥ 现状且 forwards/请求数下降；不声明 = 逐字节不变。

### B6. SystemTwo 也收敛成 thin client——顺带解掉 R4 与「真 LLM 闭环未实跑」的一半

现状：`LLMPlanner`（planner.ts:154-156）与 `llmEscalator`（planner.ts:88-100）各自手搓
OpenAI 兼容 fetch；`LLMAuditor` 又是一份；replan 没把阻塞时刻的页面快照传回 planner
（ARCHITECTURE.md §七.6，2 行改动欠着）；escalate 的 dead-rung 报告不区分「未配置」与
「在场 0 挽回」（R4）。SystemOne 侧刚刚完成同构收敛（一个 client + profile 表）——
**SystemTwo 侧缺一个对称的 `systemTwoClient`**：chat/completions + JSON 契约 +
fail-closed 解析（贪心 JSON 抽取那个坑——M3 报告 §3.5——只修在了一处）。
**改**：抽 `systemTwoClient(profile)`，planner/escalator/auditor/plan:flow 四处共用；
doctor 分两栏体检（SystemOne：provider 探活；SystemTwo：端点 + 模型名）；套件页脚把
escalate 打成部署态。**验收**：四处调用点契约测试不改一字全绿（Stage 1 的同款门）；
`OPENAI_*` 配好后 `plan:flow --planner llm` 全链路可跑（当前只有离线单测）。
**代价/风险**：S–M；纯重构 + 一行部署态。

### B7. 学习面的扩展顺序：hint → 信号 → 绑定（弹性泛化的实质推进）

运行期学习现在只学"点什么"（hint）。站点档案里 `frozen_signals` 是 authored、信号归纳
（`induceSignals` 三关：判别 + 稳定句柄 + 跨演示复现）只在 plan 期跑；M1 报告 §5.2 自己
把「运行期学习 DOM 信号」列为下一轮。失败计数那一半已经在库里（`SiteProfileMemory.recordFailure`），
缺的只是候选归纳 + staged 验证接到运行期。
**改**：按既有纪律（红线④）顺序开放——①信号学习（hint 用了但信号不成立 → 归纳候选 →
同运行重放验证 → 过门才写进 `frozen_signals`）；②`fill_keys`/`list_extract` 的运行期观察回填
（plan:flow 已能观察，运行环还没有）。**验收**：文案改写类漂移（drift 族④）后第三次运行
自动重学信号并完成，`drift` 与 `relearned` 在报告可见；不可复现候选一个字节不落盘。

### B8. executor.ts 的持续拆分（卫生项，随手做）

P0–P4 把 `actions/bindings` 拆出去了，但主文件从重审时的 1689 行涨到 **2329 行**
（本轮 `wc -l`）——adjudicate/policy/hosts/no_progress 都进了同一个文件。按三段化
蓝图继续抽：`ladder.ts`（决策梯级：hint→窄问→加宽→升级→裁决）、`hygiene.ts`
（forbid/inert/no-progress/重准入）。**验收**：六层对拍 + 冻结语料逐字节等价
（与 P0 同款门）；`BenchMiddleware.run is BrowserMiddleware.run` 单测不破。

### B9. 学习环的产物永不进被审计的包（纪律重申，R2 已立）

学到的 hint/信号只进 sidecar（`$AMBERFLOW_HOME` 作用域）与站点档案，**永不写回
`apps/<id>/pack.json`**——否则「包 = 声明」与「包 = 声明 + 历史巧合」两种东西就无法区分，
`apps:gen --check` 的逐字节门也会被学习环打红。B2 的 LearningStore 落地时把这条写进
模块头注释（hint-memory.ts 的头部纪律照搬）。

## 三、建议顺序（性价比；1–3 是「正确补全已立项的方向」，4–7 是新增结构项）

| # | 条目 | 规模 | 依据 |
|---|---|---|---|
| 1 | B1a 缓存升到 systemOneClient 层 | S | 服务化后缓存的边际价值上升；删除清单的一处修正 |
| 2 | B1b 在线 provider 的 state 渲染对齐 | S–M | 混杂变量不除，provider 对照台结论不可用 |
| 3 | B6 SystemTwo thin client + R4 部署态 | S–M | 与 Stage 1 同构；解两个挂账 |
| 4 | B2 学习库纪律统一（含 drift 撤下） | M | 认识论分叉 + 主链路死 hint 无撤下路径 |
| 5 | B7 信号学习接运行期 | M–L | 弹性泛化从"句柄"扩展到"判据"的实质一步 |
| 6 | B3 StepSpec IR 四载体归一 | L | 每加一个声明面，这条债都在涨 |
| 7 | B4 Handle AST 单实现 | M | B2 落地后收益放大 |
| 8 | B5 per-rung provider / B8 executor 拆分 | 观察/随手 | B5 等 drift 臂数字；B8 随 PR 做 |

## 四、反清单（延续 §9 的文化：不做什么同样重要）

- **不要**把「模型弹性」写进对外承诺，除非漂移真模型臂在更多夹具上翻绿（现在只有 A2′ 3/3，
  边界是三个小夹具页）。
- **不要**为服务化删掉 rules-only 开箱路径与 scripted-stub——CI 确定性与零模型回放门的根基
  （DECISION_LAYER_SYSTEMONE §5 已写明，重申）。
- **不要**在归一 StepSpec / Handle AST 时顺手改任何冻结语料的字节——回归语料是资产。
- **不要**让学习环为「提覆盖率」而放宽落盘门（`--no-verify-backfill` 是消融口，不是推荐档）。
- **不要**在没有「稳态成本」读数前宣称摊销成立——A3 的那列就是给这句话上秤的。

## 五、定位句重写建议（具体文案，供 Stage 4 收口时用）

> **AmberFlow 是面向多表面的验证驱动自动化运行时。** 规划期（SystemTwo）把一句话目标编译成
> 可验证的声明——有序子目标、完成信号、数据袋；执行期只做闭集内选择：声明点名的步零成本
> 由规则解决，声明拿不准的步问决策服务（SystemOne，可换 provider），提名一律过闸、完成一律
> 由该面的证据语言（DOM 信号 / 进程观察）裁决。成功的提名经零模型重放验证后沉淀为站点档案
> 里的规则——**首次迁移贵，之后每跑一次都在摊销；模型是耗材，声明是资产。**
> 三条红线不变：计划结构冻结（知识过门才回填）、值只来自声明绑定、完成只认证据。

## 六、复算入口（本文引用的数各在哪）

```bash
npm run apps:suite                       # 梯级账单 / 模型边际（--real-model 出边际账，exit 4 = 边际 0）
npm run apps:matrix                      # 声明解决 / hint 覆盖 / 学到·复用列
npx vitest run tests/drift-family.test.ts # 漂移族桩臂期望表（3/5 与 4/5）
node --experimental-strip-types tools/drift-real-arm.ts   # 漂移族真模型臂（冻结 0/3；A2′ 后 3/3）
npm run providers:baseline               # 零智能基线（first-candidate 是新模型要赢的线）
npm run semantic -- --app flight-cheapest --site site-a … # 二跑 rule 4 · laya 0
npm run cache:measure                    # 12 forwards → 0（要 ONNX 产物）
npm run metrics                          # corpus.surfaces / 单一出处数字
wc -l src/executor.ts                    # 2329（本轮）
```

> 边界（本文自己的）：未跑任何真网络/真权重实验，全部数字引自仓库冻结实测或代码核对；
> 「在线 provider state 过薄」是从代码形状推出的混杂变量判断，A/B 数字要等 B1b 落地后才有。
