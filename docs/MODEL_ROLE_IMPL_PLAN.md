# 实施计划：模型角色修正（谁在什么时候做什么，拿什么验收，什么时候停）

> 上游两份文档：**审查** [docs/DECISION_MODEL_PURPOSE_REVIEW.md](DECISION_MODEL_PURPOSE_REVIEW.md)（现状与数字）、
> **方案** [docs/MODEL_ROLE_PLAN.md](MODEL_ROLE_PLAN.md)（改什么、为什么、验收判据、代价）。
> 本文只回答**执行**问题：阶段划分、任务卡（写入范围 / 依赖 / 规模）、每阶段的门禁与证据落点、
> 全局停止条件、风险登记、以及需要项目方先裁定的三件事。
>
> 架构层面的改进意见（计量单一出处 / 决策接口 / 可声明策略 / 可逆性 / 梯级卫生）另见
> [docs/ARCHITECTURE_IMPROVEMENTS.md](ARCHITECTURE_IMPROVEMENTS.md)——本计划的 W2 是它的 §1 的子集。
>
> 三个前提，写在最前面，避免计划漂移：
> 1. **默认档逐字节不变**是每一阶段的硬约束（`gate`/声明面都是加法式：不写就等于今天）。
> 2. **冻结语料不许改**：`apps/*` 里那 8 个生成包、`bench/` 与 `tools/*-corpus.json` 的期望值、
>    六层对拍的语料，只允许读。任何"为了让新机制变绿"而改语料的做法一律不认。
> 3. **没有数字的改动不立项**：每张任务卡都带验收命令与期望数字；测不出来就退回方案层。

## 0. 已完成（本轮，作为阶段 0 的交付）

| 项 | 产物 | 复算 |
|---|---|---|
| 六层总览图更新（④ 补命令闭集 / 具名绑定 / 重复上界；⑤ 写实测口径；③ 写 `next` 与拒绝） | [docs/architecture.svg](architecture.svg) / [.png](architecture.png) | `node tools/arch-diagram.mjs --png` |
| 目标架构图更新（⑧ 改为"已全部落地 + 验收台"；新增 ⑨ 模型角色的修正） | [docs/architecture-target.svg](architecture-target.svg) / [.png](architecture-target.png) | `node tools/arch-diagram-v2.mjs --png` |
| **图的漂移门**（本轮之前没有任何门禁盯着它） | `--check` + [tests/arch-diagram.test.ts](../tests/arch-diagram.test.ts) 2 条 | `npx vitest run tests/arch-diagram.test.ts` |
| 生成器纪律统一：先检查后写（v1 原来是先写后 exit 1） | `tools/arch-diagram.mjs` / `-v2.mjs` | 坏图时**一个文件都不写** |
| 模型实测工具落库 | [tools/model-contribution.ts](../tools/model-contribution.ts)（摘要分两支报）、[tools/ask-shapes.ts](../tools/ask-shapes.ts) | `npm run model:contribution` |

## 1. 角色与门禁（照 `apps/INVENTORY.md` §三 的分工）

| 角色 | 职责 | 写什么 |
|---|---|---|
| **作者** | 按任务卡实现 + 自带一条会因回归而失败的测试 | 只碰任务卡里写明的范围 |
| **独立复核** | 只读 + 最小复现；试**证伪**任务卡的每条声明；缺陷带最小复现，报而不装绿 | 不写仓库（临时文件在 /tmp） |
| **Lead** | 维护本计划与图/文档、跑最终门禁、提交 | `ARCHITECTURE.md` / `docs/*` / 图 |

**每阶段结束必跑**：`npm run verify`（typecheck + 全部测试 + 六层对拍）→ `bash bench/smoke.sh`（CI 的绿色定义）。
**涉及应用/包时再加**：`npm run apps:suite`（分层退出码）、`npm run apps:matrix`、`npm run apps:gen -- --check`（8/8 不漂）。
**改了图或文档**：`node tools/arch-diagram.mjs --png` / `node tools/arch-diagram-v2.mjs --png` + 两个 `--check`。

### 命名说明（独立复核指出的一处真混乱）

执行层的 `P0–P4`（形状硬化 / hint 单实现 / 命令层 / 数据槽层 / 声明式后继）是**已落地**的迁移编号，
见 `ARCHITECTURE.md` §四.11 与目标图 ⑧。本计划的阶段改用 **W1–W5**，避免"同一个 P3 指两件事"
（`ARCHITECTURE.md` 的 P3 = `src/bindings.ts`，已落地；本计划的 W3 = 漂移夹具，未开始）。

## 2. 阶段总览

| 阶段 | 内容 | 规模 | 依赖 | 门禁外的证据 |
|---|---|---|---|---|
| **W1** | A3 风险头策略 + 决策缓存覆盖 | S（半天） | 无 | 语料墙上时间 <300 s（真模型基线 597 s、脚本桩基线 160.7 s）；危险步负例全绿 |
| **W2** | C1 两个数进套件/矩阵 + C3 写进文档 | S | 无 | `apps:suite` 输出多两列；README/ARCHITECTURE 有分工段 |
| **W3** | C2 漂移夹具（页面改名/改层级） | M | W2（要报告能读数） | 夹具在 CI 里红/绿可复现 |
| ~~**W4**~~ | ~~A1 闸门档位 + A2 页面裁决~~ | — | — | **W0 已触发停止条件**：A1（换/分档信号）被数据否掉 |
| **W4′** | 改问法（窄问）+ 限爆炸半径（非破坏性步放开、事后看信号） | M | W3（验收台）✅ | 红格转绿 · 窄问正确率 vs 全池 · 错误动作被采纳 = 0 · 默认档不变 |
| ~~**W5**~~ | B2 LLM 端点 → B1 作者期提议档 | L | 端点 | **未实现（2026-10-13 裁定）**：无端点，移出路线图 |
| **备选降级** | 明确降级为"风险头 + 诊断" | S | 裁定 | 语料回到 ~161 s（脚本桩实测基线）；文档写明放弃运行期弹性主张 |

## 3. 任务卡

### W1 · A3 风险头策略 + 决策缓存（纯赚）——**已落地**

> ✅ 做法是**声明着省**（`pack.policy.risk_ask: rules-only`），不是"进缓存"——
> 缓存早就包住了 `agent.predict`，慢是因为每步 state 不同 ⇒ 永不命中（初稿的判断错了，已改）。
> ✅ 实测 demo-app 12.8→2.3 s、ctrip-case 46.2→6.0 s，两臂结果与梯级账单逐字段相同；
> 关键词命中仍拦（`tests/executor.test.ts` 两条行为测试钉住）。默认 `always` = 今天，逐字节不变。

- **目标**：把"要不要问人"从每步一次模型前向，改成规则优先 + 同问不重答。
- **写入范围**：`src/executor.ts`（`isRisky` 的调用路径）、`src/decision-cache.ts`（缓存键覆盖风险问句）、
  `src/planner.ts`（若走 `countingRuntime` 的口径需要同步）、`tests/decision-cache.test.ts` + 一条新负例。
- **步骤**：① 规则命中 `DESTRUCTIVE_PATTERNS` ⇒ 直接判 risky，不再问模型；② 规则未命中且动作**不可逆**（submit/购买类）
  ⇒ 问模型；其余不问；③ 风险问句进 `withDecisionCache` 的指纹。
- **验收**：`npm run apps:suite` 的墙上时间（真模型在位）从 **597 s → <300 s**；
  `tests/apps.test.ts` 的危险步负例（dry-run / 确认 / 拒绝 / 不落盘）全绿；`cli-report --allow-dangerous` 行为不变。
- **证据落点**：`docs/DECISION_MODEL_PURPOSE_REVIEW.md` §2.6 补一行实测；`apps:matrix` 的"模型咨询"列。
- **风险**：规则收得太紧会漏掉新型危险动作 ⇒ 缓解：负例里加一条"规则未命中、模型票 ≥0.6 仍然拦下"的用例。
- **回滚**：一个开关（`riskModelAsk: "always" | "on-ambiguity"`）默认 `on-ambiguity`，出问题切回 `always`。

### W2 · C1 计量进套件 + C3 写进文档（零风险）——**部分落地（本轮）**

> ✅ `模型边际` 列 + `--real-model` 臂 + "边际为 0 ⇒ 退出码 4"（判据比初稿更硬的那版）；
> ✅ 梯级账单与 dead rung（§5）；✅ 计量单一出处 `npm run metrics` → `docs/arch-metrics.json`，
> 两张图从它插值 ⇒ `--check` 成了真值门（§1/§8）。
> ✅ 本轮补齐：`hint覆盖` 列（实现单一出处 `src/app-pack.ts:packHintCoverage`，套件/计量/图共用）
> + 页脚"hint 覆盖 169/171 = 98.8% …这就是承重墙"；README《为什么本地还养一个模型》改写成
> **分工 + 可核对的保险**（并修掉一处被实测证伪的旧话：slowjet 救回来的是 `retries`，不是模型）。

- **目标**：让"声明覆盖率"和**"模型的边际贡献"**变成套件输出里的一等数字。
  红队复核给的判据比初稿更硬：**边际为 0 时不许显示为通过**。
  - `模型边际` = 同一包跑**两臂**（真模型在位 / ``）后，**规则臂 blocked、模型臂 done** 的步数
    （`method ∈ {laya, laya:reobserve, escalate}` 且该步信号成立）；没跑过的臂打印 `未测`，**不许**打印 0 当绿。
  - 17 个离线旅程应用若 `模型边际` 合计为 **0**，汇总行必须打印
    `模型边际=0：本语料上"运行期弹性"主张不成立（见 docs/MODEL_ROLE_PLAN.md 备选降级）`，
    并让**该次运行的退出码非 0**（今天 0 次过关却拿绿色，是这条要杀掉的唯一行为）。
  - CI 不受影响：`bench/smoke.sh` 仍跑脚本桩（不把 1.7 GB 权重塞进 CI），但**"CI 绿"必须同时写明"≠ 模型有用"**；
    真模型那一臂由 `apps:suite --real-model` 显式开启。
- **写入范围**：`tools/apps_suite.ts`（两列 + 汇总判据 + `--real-model`）、`tools/apps_matrix.ts`（列）、
  `README.md`、`ARCHITECTURE.md`（"CI 绿 ≠ 模型有用"）。
- **步骤**：① `apps:suite` 每应用加 `hint 覆盖` 列（该应用浏览器步里点名目标的比例）+ 汇总行；
  ② `apps:matrix` 同列；③ 汇总里读 `model:contribution` 的产物（若存在）打印"闸门内 precision / AUC"，
  **没有产物时如实打印"未测"**（不许编数）；④ 文档写"声明是主路径、模型是兜底 + 诊断 + 作者期助手"。
- **验收**：`apps:suite` 输出含 `hint覆盖` 与 `模型边际` 两列；覆盖率 <100% 的行**明确标注**依赖模型兜底；
  `模型边际=0` ⇒ 退出码非 0 + 打印结论行；真模型臂要能点名"哪几个应用的哪几步"（回 `<app>-result.json` 可核）；
  既有退出码分层（1/2/3）语义不变，只新增"边际为 0"这一种非 0 情形。
- **风险**：改动套件输出可能碰坏读它的脚本 ⇒ 只在行尾追加列，不改既有列的位置与措辞。

### W3 · C2 漂移夹具（给弹性一个会红的验收台）——**已落地（扩成 §7 的漂移族）**

- **目标**：把"页面变了、hint 失效"变成一份**固定**夹具，而不是一次临时 A/B。
- **写入范围**：`testpages/drift/`（同一页面两份：原样 / 改掉 id 与层级）、`apps/<id>/`（一个只跑夹具的包）、
  `tests/drift.test.ts`。
- **步骤**：① 造夹具对；② 断言**现状下"改过的那份"红**（这是今天的真实行为：hint 未命中 → 全池提问 → 低置信或点错）；
  ③ 断言"原样那份绿"（否则夹具本身不可比）；④ 结果写进报告（哪一步、什么停因）。
- **验收**：`npx vitest run tests/drift.test.ts` 两条断言；夹具包进 `apps:matrix` 且 0 代码行。
- **风险**：夹具太像"人造"，结论不可外推 ⇒ 改法要贴近真实漂移（改 id、加一层 wrapper、把 button 换成 a），
  并在 notes 里写明"这一对夹具代表的是哪一类漂移"。

### W0 · 插桩测量 —— **已完成（2026-10-13）**

> **结果：三个候选信号全部不合格，W4 的 A1 半边被数据否掉。**
> 同一份 162 步、同 coverage（采纳 75 步）下的 precision：
> `confidence 14.7%` ｜ `margin 12%` ｜ `pTop1 8%` —— **现状已经是三者里最好的**。
> 分桶（laya 自己的 2/3-5/6-10/11+ 粒度）后 `confidence` 的 AUC 是 **0.48 / 0.533**，
> 所以"闸门系统性反向"（聚合 0.233）是**混合假象**；去掉假象之后剩下的结论是
> **"没有哪个分数能区分对错"**。margin 的否证与仓库早年的 C3-R 测量对上（全部 < 0.5）。
> 证据：`bench/w0-model-contribution.json`（冻结逐题产物）+ `bench/w0-gate-signals.json`
> + `tools/gate-signals.ts`（`npm run gate:signals`）+ `tests/gate-signals.test.ts`（4 条回归）。
>
> **对 W4 的影响**：按本计划 §5 的停止条件——"找不到 precision ≥ 现状且 coverage 更高的阈值 ⇒ **停**"。
> 这个条件**已被触发**。W4 因此重划为 W4′。

### W4′ · 改问法 + 限爆炸半径（原 W4 去掉"换闸门信号"那一半）

- **为什么这样重划**：W0 说明"信不信模型"**不是统计问题**。能替代它的只有两件事——
  ① **让问题变小**（窄问实测 14/14 vs 全池 3/14，改的是正确率本身）；
  ② **让错误的代价有界**（`effect.irreversible` 已落地：只在非破坏性步放开，事后由该步信号裁决）。
- **采纳规则**从"分数过阈值"改成：**候选集 ≤ N 且 该步 `irreversible !== true` ⇒ 接受，看信号；否则 block/问人**。
- **验收判据（改掉，不再用 AUC）**：
  1. 漂移族夹具（`tests/drift-family.test.ts`）里今天红的那几格，在**窄问 + 非破坏性放开**下转绿；
  2. 两个维基页 + 一个 hold-out 页：窄问的**选择正确率**显著高于全池（基线 14/14 vs 3/14）；
  3. **错误动作被采纳 = 0**（由不可逆声明保证，不依赖任何分数）；
  4. 默认档逐字节不变。
- **仍然无解、不许声称的部分**：池子大的问题（40 选 1）模型 25% 且无法自报把握 ⇒ 只能 block 或 `escalate`（要端点）。
  **"运行期弹性"在 W4′ 落地前仍然是一个没有被数字支持的主张。**

### （已停）W0 前置的原始提案 · 插桩测量

> 目的：`pickProposal` 现在会落 `shape/pTop1/pTop2/margin`，但**语料产物还是插桩前跑的**（172 行里 0 行有 margin）。
> 重跑 `npm run model:contribution` 后，在同一份 162 步上比较 `confidence / pTop1 / margin` 各自的
> AUC 与分档 precision——**这一步的产出决定 W4 的闸门读什么信号**，也直接回答
> [DECISION_INTERFACE_SURVEY.md](DECISION_INTERFACE_SURVEY.md) §3 那条未调和的反证据
> （本仓库早年测过 margin 并否掉：坏选中位 0.348 > 好选 0.263）。
> 停止条件：若 margin 与 pTop1 在两支上都不优于现状的 `confidence` ⇒ W4 只剩"分档 + 弃权一等化"，收益重估。

### W4 · A1 闸门档位 + A2 页面裁决（核心，唯一有行为风险）

- **目标**：让兜底层在"问题小 + 页面能裁决"的地方真的能兜住；默认档一位字节都不动。
- **写入范围**：
  - `src/executor.ts`：`pickElement` 的闸门档位（`RunOptions.gate`）、把 `by_question_shape` 的两支分开标定；
  - `src/plan.ts` / `src/app-pack.ts` / `src/actions.ts`：步的声明面（A2 的开关）与加载期校验（不可逆步写了 ⇒ 红）；
  - `src/app-runner.ts`：把开关从包传到执行器；
  - `tools/`：一个标定脚本（读 `model:contribution` 的产物 → 每支的阈值表）；
  - `tests/`：档位等价（默认档逐字节）、不可逆步负例、页面裁决正例。
- **步骤**：
  1. 先只加档位与标定，**不改默认**；用 `model:contribution` 的 162 步算出两支各自的 precision/coverage 曲线，
     选出满足"precision ≥ 现状且 coverage 更高"的阈值（**没有这样的阈值就停在这里**，见 §5 停止条件）。
  2. 接 A2：只在声明了"页面裁决"的步上，允许用新档位采纳模型的选择；执行后**看该步的信号是否成立**
     （信号不成立就按"未执行/白跑"处理并记 `adjudicated_rejected`）。
     注意验收口径（复核修正）：安全性来自**动作非破坏性**，不是"页面会拒绝"——`select` 选错页面照收，
     只是信号不成立。语料分布：`select` 40.1% + `input` 9.9% = **50% 非破坏性**，真正被页面校验的只有 `input` 那 9.9%。
  3. 用 W3 的漂移夹具 + 两个维基页 + 一个 hold-out 页做验收。
- **验收（缺一不可）**：
  - `model:contribution` 两支的 **AUC ≥ 0.5**，且 floor 处 precision 高于现状（passthrough 5% / shortlist 44%）；
  - P3 漂移夹具在开启 A2 的步上**转绿**（今天红）；
  - "错误动作被采纳"计数 **= 0**，且新增"页面拒绝次数"作为安全指标；
  - **默认档**：六层对拍 + `apps:suite` 逐字节不变（`gate: "confidence"` 仍是缺省）。
- **风险**：闸门变松会把错误动作放进去 ⇒ 缓解：A2 的开关面只对"页面能拒绝"的步开放 + 不可逆步加载期红 + 负例测试。
- **回滚**：两个开关都默认关（`gate`、步声明面），删掉声明面即回到今天。

### ~~W5 · B2 端点 → B1 作者期提议档~~ —— **未实现（2026-10-13 裁定）**

> 前置的 LLM 端点在本机不存在（`npm run doctor`：LLM 规划/审计 — 未配置），且 laya 不产文本。
> 按项目方裁定，这一条**从路线图移到"未实现"**：不留半成品机制、不拿 scripted 替身冒充质量数字。
> 若将来接了端点，重新立项时请带上原设计里的三条判据（提议接受率 / 手写行数下降 / 零模型重放门仍绿）。

- **前置**：`OPENAI_BASE_URL` + `OPENAI_API_KEY`（`LLMPlanner`/`LLMAuditor` 已有代码，只缺环境）。
  **不接端点 ⇒ 本阶段记为"未实现"**，不进路线图。
- **写入范围**：`src/plan-flow.ts` / `tools/learn.ts`（提议档）、`src/planner.ts`（`LLMPlanner` 到端点）、
  `tests/plan-flow.test.ts`（scripted 桩上的机制）。
- **步骤**：① 端点到位后先量 `LLMPlanner` 在既有 spec 上的表现（与 `apps:gen` 的机械展开比）；
  ② 加"提议档"：模型给候选 (hint, signal)，裁决仍走确定性三关；③ 人只回答"是不是这个"。
- **验收**：提议接受率入报告；同一批应用的**手写行数下降**；`learn` 的零模型重放门仍全绿
  （**未过门就不落盘**，这条不许放松）。
- **风险**：模型提议的 hint 不稳定 ⇒ 缓解：提议只是候选，裁决与落盘仍由确定性三关与重放门把关。

### 备选降级 · 明确降级（如果 W4 的停止条件被触发）

删掉 `escalate` 的死接线（语料出场 0 次）、模型只留风险头与诊断；文档写明"放弃运行期弹性主张"。
验收：语料回到 ~161 s（脚本桩实测基线）；`apps:suite` 全绿；删掉 1.7 GB 产物依赖后离线全套仍绿。

## 4. 全局"完成"的定义

1. 每张任务卡的验收命令**都有原始输出**存档（报告/产物路径写进任务卡）；
2. `npm run verify` + `bash bench/smoke.sh` 全绿，且**默认档逐字节不变**的断言在测试里；
3. 两张架构图 `--check` 一致（改了模块就必须重跑生成器）；
4. 独立复核对每个阶段出一份"题 → 命令 → 原始观测 → 结论"，缺陷带最小复现；
5. 任何一条做不到，就在文档里写成"未做/未验"，**不许**用"跳过"当通过。

## 5. 停止条件（先写下，避免为了完工而完工）

| 触发条件 | 动作 |
|---|---|
| W4 步骤 1 里找不到"precision ≥ 现状且 coverage 更高"的阈值 | **停 A1/A2**，转备选降级，把标定结果贴进审查文档 |
| P3 夹具显示"改过的页面"在开启 A2 后仍然红 | 说明页面裁决不足以兜住 ⇒ 停 A2，只保留 A1 的度量部分 |
| P1 的语料时间没降到 300 s 以下 | 说明瓶颈不在风险头 ⇒ 撤掉该改动（不留"看起来优化过"的代码） |
| 任何阶段导致默认档行为变化 | 立即回滚该阶段，问题记进审查文档的"缺陷"节 |
| P5 端点 4 周内不到位 | 把 B1/B2 从路线图移到"未实现"，释放注意力 |

## 6. 风险登记

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 闸门放松放进错误动作 | 高（不可逆动作） | 只在页面能拒绝的步放开；不可逆步加载期红；错误动作采纳计数 = 0 作为验收 |
| R2 | 标定数据太小（162 步 / 2 页） | 中（结论不可外推） | 标定随语料增长重跑；hold-out 页不进标定集 |
| R3 | 新增声明面又变成"手写负担" | 中（与"简化配置"反向） | A2 的开关默认关；只给"值得放开"的步加；反对"每个步都写一遍" |
| R4 | 图/文档再次漂移 | 低 | 阶段 0 的 `--check` 已进测试 |
| R5 | 套件输出被下游脚本按列解析 | 低 | 只追加列，不改位置与措辞 |

## 6b. 决策日志（项目方裁定的原话与生效位置）

| 日期 | 裁定 | 生效在哪 |
|---|---|---|
| 2026-10-13 | **`verify_after: none` 不允许存在** | 该键从 `EFFECT_KEYS`/`StepEffect` **删除**；写了它加载期报错并说明理由（`tests/apps.test.ts`） |
| 2026-10-13 | **`undo` 只能引用声明过的非危险步** | 记为 §4/W4 的实现约束（三条：加载期校验目标存在且非不可逆；回退失败是结构化停因；不可逆步不得声明 undo）——`undo` 本身仍未实现 |
| 2026-10-13 | **B1/W5 移到「未实现」** | 本文 W5 与 §2 阶段表、`MODEL_ROLE_PLAN` B 组、`ARCHITECTURE_IMPROVEMENTS` §6、目标图 ⑨ |
| 待答 | 闸门按问法分档（W4/A1）是否立项 | 分析已交付：`docs/DECISION_INTERFACE_SURVEY.md`（这些信号是通用还是 laya 独有） |
| 待答 | 备选降级是否作为 W4 失败时的**正式**退路 | §5 停止条件、`MODEL_ROLE_PLAN` 备选降级 |

## 7. 需要项目方先裁定（决定本计划能否开工）

1. **接受定位**："声明承重、模型兜底 + 诊断 + 作者期助手"写进 README/ARCHITECTURE？（P2 的前提）
2. **A1 + A2 立项吗？** 它是唯一动闸门语义的一项（默认档不变，但会新增档位与步声明面）。
3. **LLM 端点接不接？** 不接则 P5 记为"未实现"。
4. （可选）**备选降级 是否允许作为 W4 失败时的正式退路**——写进文档，而不是临时决定。

> 复算入口汇总：`npm run verify` · `bash bench/smoke.sh` · `npm run apps:suite` · `npm run apps:matrix` ·
> `npm run apps:gen -- --check` · `npm run model:contribution -- --out /tmp/mc.json` ·
> `node tools/ask-shapes.ts …`（用法见审查文档 §1）· `node tools/arch-diagram.mjs --check` ·
> `node tools/arch-diagram-v2.mjs --check`。
