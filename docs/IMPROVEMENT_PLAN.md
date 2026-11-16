# 可维护性与可扩展性治理方案 v2.1（架构评审修订版）

> **状态**：**实施中 — P0 已完成**（2026-11-17；9/9 批落地，出口验收通过，记录见 §6.1）；P1 待启动（依赖本版 0.8 证据 lane，已就绪）
> **基线**：`main @ 91bf379`；`npm run check` 全绿（本轮实测：预检/类型/配置/schema/prompt/泄露/示例/行锚/用例校验 9 项通过）
> **评审**：3 个独立只读评审（目标架构 / 迁移治理 / 红队）+ Lead 裁决，记录见 [IMPROVEMENT_PLAN_REVIEW.md](IMPROVEMENT_PLAN_REVIEW.md)。本版已按裁决修订：砍 `sdk.ts`/伪端口/单一编排，新增 0.8 等价证据 lane 与 0.9 seam 冻结，门禁降档，P2 条件化。
> **取代**：本文 v2（2026-11-17 初稿）与 v1（2026-11-10「配置收敛 · 分层治理 · 臃肿文件拆解」）。v1 已完成项保留，未实施项并入本文（§10）；v1 原文见 `git show 91bf379:docs/IMPROVEMENT_PLAN.md`。
> **方法**：5 份只读审计（结构/注释/提示词/常量配置/主线，口径见附录 B）+ 3 份架构评审 + Lead 抽验。文中 `file:line` 为 HEAD 91bf379 实测值；落地时一律以**符号名**定位（行号锚点已实测漂移，见 §2.2）。
> **纪律**：只做行为等价治理；不改硬规则（唯一执行器 / 完成只认信号 / 值不来自猜测 / 凭据与危险步纪律 / 不绕过反爬）；每批独立提交、可单独回滚。
> **实施进度（2026-11-17）**：P0 全部 9 批完成（出口证据见 §6.1）；P1 进行中：1.1 tuning / 1.2 env typed getter + constants 门禁 / 1.3 CHANGELOG Decisions + comments 更新协议 / 1.4 app-pack+datasource 稳定纯区拆分 已落地（§6.2）；1.5 `buildMiddleware` 工厂 + W1-a 剩余、1.6 Agent prompt/证据 spec 待做。

**如何读**：决策看 §0、§3.4、§6；实施看 §4、§5；复核看 §2、§7、附录 A；评审裁决看 [评审记录](IMPROVEMENT_PLAN_REVIEW.md)。

---

## 0. 一页结论

| # | 用户痛点 | 量化基线（HEAD 91bf379） | 病根（一句话） | 治理线 |
|---|---|---|---|---|
| 1 | 大文件难读 | 134 个 `.ts` / 51,548 行；**9 个文件 >1000 行**，top20 占 53.7%；**58 个函数 ≥100 行、9 个 ≥300 行**（`run` 2685、`createCtx` 1704、`runScriptApp` 821、`runApp` 709、`validatePack` 690） | 同一语义面有 2–3 份实现；第一波只搬走外围可机械分离区，运行期主体没动 | W1 |
| 2 | 注释一大堆历史记录 | 注释占用 11,479 行 = **22.2%**；其中历史/方案台账沉淀 **829 行（8.6%）**，真正可删 **85 行（0.9%）**；23 处幽灵引用、3 处行号锚点全部漂移；日期戳 46 行 | 把注释当成了 CHANGELOG、测试套件和行号手册；没有注释规约与门禁 | W2 |
| 3 | 常量配置写死、出处不统一 | 配置键已单源 **33 键/8 组**，但仍有 **33 处直读 `process.env`（19 个变量、10 个文件）**、14 个常量概念中 7 个多写/4 个半单源、**9 例出处漂移（4 例已实测不一致）**、1762 个魔法数、站点/业务知识硬编码 3 类 6 处 | 「键」单源了，「读取点、调参数、人读文档」都没单源；文档靠人工同步，已漂移 | W3 |
| 4 | 可读性差、提示词太长且散落 | 模型决策 prompt **25 处 / 10 文件 / 5,542 字符**，去重仅 11 条（2,601 字符）→ **重复 53%**；无版本/无预算/无输出契约；`prompt-hit` 对 `src/model` 覆盖为 0；单请求证据 `criteriaView` 40 候选 3,290 字符、120 候选 9,991 字符 | Agent 可见提示词已有三层治理，但模型 prompt、证据渲染、桥手写描述都在门外 | W4 |
| 5 | 实现主线不清晰 | **19 个可执行入口**、4 套编排、**6 处真实 `new BrowserMiddleware`**（另有 1 行注释）、8 组重复路径；`src/index.ts` 25 条导出、仓内 0 消费者、且不在包 `exports`；6 处文档与代码不一致 | 「一个执行器」成立，但「一条主线」不成立；编排层四套并存，入口按三类混在一起 | W5 |

**三条设计原则**（v2.1 与 v1/v2 的差别）：

1. **证据先于拆分**：没有可重复的等价证据（0.8 lane）之前，运行期大文件拆分不启动；先冻结 seam（0.9），再动手。
2. **先收语义面，再拆文件**：同一语义只留一个出处，拆分只是收口后的结果；先拆会得到「更小的重复文件」。
3. **最小充分架构 + 机械门禁**：只保留真实替换边界（DecisionProvider / SessionFactory / DataLeg）；不建伪端口、不造新公共面；人读视图一律生成或校验；门禁分 fail/warn 两档，存量 ratchet 只减不增。

**评审后主要修订**（详见评审记录 §4）：

- 砍掉：`sdk.ts`、BrowserPort/AppPort/TargetResolutionPort、单一 `runJourney` 编排、handler 进程内化。
- 新增：0.8 等价证据 lane、0.9 seam/符号归属冻结表、T1/T2/T3 停手触发器、P2 条件启动、MVG fallback。
- 降级：6 组 fail-fast 门禁 → 2 fail + 2 warn；新建 ADR 文件 → CHANGELOG `## Decisions`；B3/B4 全量迁移 → 选择性；W4-5/B7 移出；P2 目标从行数/函数数改为「语义份数 + 证据可重复」。

**批次概览**：

| 批次 | 目标 | 周期（粗估） | 行为变更 |
|---|---|---|---|
| P0 冻结与真值 | 0.1a 门禁骨架（size/docs）+ 0.2 配置文档真值 + 0.3 注释低风险清理 + 0.4 模型 prompt 去重（逐字节不变）+ 0.5 文档纠真 + 0.6 MAINLINE/静态断言 + 0.7 已确认 bugfix + **0.8 等价证据 lane** + **0.9 seam 冻结** | 2–3 周 / 10–14 人日 | 仅 0.7 两个 bugfix，其余零行为变更 |
| P1 收口 | 1.1 tuning（仅 11 概念）+ 1.2 env getter + 1.3 注释选择性迁移 + 1.4 W1-b 稳定纯区拆分（依赖 0.8/0.9）+ 1.5 W1-a 剩余同构 + `buildMiddleware` 工厂 + 1.6 Agent prompt 收口/证据 spec（条件） | 3–5 周 / 12–18 人日 | 零行为变更（等价证据先行） |
| P2 主线（条件启动） | 2.0 RunCtx + evidence collector（BACKLOG #4 前置）→ 2.1 `run()` 九阶段（freeze window）→ 2.2 `runExecution` 内核 + 源适配器 + ctx 行为矩阵/conformance → 2.3 公共面清理 + 站点知识出引擎 + 扩展演练 | 3–5 周 / 12–20 人日 | 零行为变更；删除未发布/内部面 |
| 持续 | 门禁 ratchet 只减不增；文档生成物；季度度量；T1/T2/T3 监控 | 每批附带 | — |

**P2 启动条件**（缺一不启动）：① 2.0 发布/特性冻结决策已定；② 0.8 等价 lane 在 CI/本地可重复；③ INTERVENTION 步 4/5 与默认切换完成；④ BACKLOG #2/#3/#4 的顺序决策已定；⑤ 声明 freeze window。

---

## 1. 诊断：四个共性根因

五个痛点不是五个独立问题，背后是同一组结构性原因：

| # | 根因 | 证据（详见 §2） | 后果 |
|---|---|---|---|
| R1 | **一个语义面 2–3 份实现** | 真跑/dry/replay 三份 ctx 实现；`runApp`↔`runScriptApp` 双运行器；FW8/DRF/F64/A3 四条目标恢复；6 处真实 mw 装配；同一 choice/risk/done prompt 6/7/7 份 | 大文件、重复逻辑、主线分叉、提示词散落的**共同源头** |
| R2 | **历史没有唯一归宿** | `CHANGELOG.md` 已有 1,582 行与 F 台账，但 src 注释又抄一份（方案编号 597 行）；schema-gen 的 statement/truth 是第三副本 | 注释考古、行号漂移、幽灵引用 |
| R3 | **人读视图未生成化** | `.env.example` 29 键 vs schema 33 键；`CONFIG_REFERENCE` 缺 4 键且有 2 处语义写反；README 说 4 个示例实为 5 个；ARCHITECTURE 分层图缺 5 个模块 | 出处不统一、新读者被误导 |
| R4 | **缺防回潮门禁（且已有腐烂前科）** | 现有 9 项 check 强在 schema/提示词/示例，但没有规模、注释、常量、模型 prompt、主线、import 方向门禁；`.github/workflows/bridge.yml` 记录 vitest job 永久红被整体删除、`checks.yml` 记录 schema snapshot 门禁长期红；近 3 周 151 次提交、executor/app-runner/ctx 分别 61/49/35 次 | 修完会反弹；门禁本身也会腐烂 |

**不要推倒重来**——仓库已有五项可复用资产：

- `src/support/config-schema.ts`：配置键/默认值/掩码唯一声明，`configs/amberflowrc.example.json` 已由它生成并校验（33 键完全一致）。
- `tools/prompt-hit.ts` + `docs/PROMPT_SYSTEM.md`：**Agent 可见**提示词的三层单源 + 8 组离线断言，是本次模型 prompt 治理的直接模板。
- **facade re-export 拆分先例**：`executor-types` / `executor-pure` / `pool-js` / `ctx-types` / `ctx-tool` / `app-report-view` / `data/report-view` / `app-runner-cli` 等 14 个模块已成功外搬，`src/index.ts` 零改动，证明"原文件变 barrel、实现搬新模块"可行。
- **合成断言先例**：`tools/row-anchor-check.ts`（183 行、25 条内存断言）已进 `npm run check`，证明「合成输入 + 内存断言」在无单测仓库可行——用它替代伪端口做语义收口验证。
- **等价验收纪律**：`apps check/explain` dry、`inspect --json`、trace 对比是既有思路；但 CI 可重复性不足，本方案用 0.8 lane 补齐（§7）。

---

## 2. 五项病证详证

### 2.1 大文件难读：规模高度集中，且拆分停在半程

**文件规模**（`wc -l`，src 全部 134 个 `.ts`）：

| 文件 | 行数 | 文件 | 行数 |
|---|---|---|---|
| `engine/executor.ts` | 6,140 | `app/session-runtime.ts` | 1,460 |
| `app/app-runner.ts` | 2,864 | `data/datasource.ts` | 1,417 |
| `engine/extraction.ts` | 1,966 | `engine/pool-js.ts`（纯 JS 模板） | 1,102 |
| `app/ctx.ts` | 1,799 | `engine/executor-types.ts`（纯类型） | 1,005 |
| `app/app-pack.ts` | 1,512 | `app/app-adapters.ts` | 988 |

- `top20 = 27,700 行 = 53.7%`；`src/engine` 18,436 行（35.8%）、`src/app` 15,276 行（29.6%）、`src/cli` 7,941 行（15.4%），三者占 80.8%。不是全仓普遍肥大，而是**少数运行期底座**。

**函数规模**（TS AST 实测）：58 个 ≥100 行、9 个 ≥300 行。9 个巨型函数：

| 行数 | 位置 | 函数 |
|---|---|---|
| 2,685 | `engine/executor.ts:3255-5939` | `BrowserMiddleware.run`（占文件 43.7%，199 处 `this.` + 5 个记账闭包） |
| 1,704 | `app/ctx.ts:88-1791` | `createCtx`（占文件 94.7%） |
| 821 | `app/app-runner.ts:2015-2835` | `runScriptApp` |
| 709 | `app/app-runner.ts:1245-1953` | `runApp` |
| 690 | `app/app-pack.ts:823-1512` | `validatePack` |
| 542 | `app/ctx-dry.ts:73-614` | `createDryCtx` |
| 365 | `cli/commands/inspect.ts:153-517` | `runInspect` |
| 322 | `app/app-runner-cli.ts:32-353` | `main` |
| 319 | `app/ctx-replay.ts:36-354` | `createReplayCtx` |

**同构重复 7 组**：`sleep` 旁路 9 处、掩码契约双写（`app/redaction.ts:20` ↔ `engine/executor-pure.ts:84`，且 `executor.ts:2104` 再实现）、决策面判空 6 处（**已实际漂移**：`app-runner.ts:1463` 用 `!== ""` 无 trim，`cli/commands/run.ts:71` 有 trim）、`pickRow` 三写、双运行器同构、帧门禁谓词 9 处手写、ctx 三面同构。

**扩展摩擦**（实测提交）：跨层加一个能力（如 `false_done` 停因 + `ctx.judge` 预设 + result 字段）改 **12 个文件/10 个 src**；加桥 ElementView 字段 + 行锚产物 + policy 键改 **16 个文件/11 个 src + 桥**；加一个信号算子改 5 个文件/3 个 src。根因同 R1。

**结论**：第一波拆分只搬走了「外围可机械分离区」，执行器仍 6,140、ctx 仍 1,799。下一刀必须切运行期方法区与重复装配，而不是继续按行数搬文件；但**运行期拆分必须以 0.8 证据 lane + 0.9 seam 冻结 + freeze window 为前置**（评审 B1/B5）。

### 2.2 注释历史沉积：痛点属实，但只有约 9%，不能一刀切

口径：注释占用行（含 `/**`/`*/`/空 `*` 行）11,479 行 = 22.2%；有文字注释行 9,688 行 = 18.7%（JSDoc 6,574 / 行注释 2,863 / 块注释 251 / 行尾内联 281）。

| 分级 | 行数 | 占比 | 内容 | 处置 |
|---|---|---|---|---|
| A 契约/why | 8,774 | 90.6% | 不变量、完成语义、安全红线、单一出处指针、非显然 why | **保留**，这是可维护性本体 |
| B 历史/台账 | 829 | 8.6% | 日期戳 46、事故/旧实现/教训措辞 236、方案批次编号 597（F 编号 259、`§` 139、`task-N` 136、`批N` 40；其中 205 行是纯台账起头） | 迁 `CHANGELOG ## Decisions` 或删 token 留契约 |
| C 可删 | 85 | 0.9% | 变更叙事 63、失效引用 23、行号锚点 3 | 删/改写 |

**失效与危险注释（抽样逐条核实）**：

- 3 处行号锚点**全部漂移**：`executor.ts:3441` 引用 `L4247 getDeclared`，实际在 3949；`schema-gen.ts:94/101` 的 `executor.ts:2316-2322` → 现在 2463，`ctx.ts:311/:421/:1759` → 318/430/1776（schema-gen 两处一天内就漂移）。
- 12 行/10 文件写「历史回归钉住」，但仓库**不存在该回归套件**（无单测/夹具，git log 无删除记录）。
- 4 个不存在的文档（`PORTING.md` / `ROOT-CAUSE.md` / `DEVELOPING.md` / `DECISION_PROVIDER_JEVK5.md`）、错误路径 `src/app/amberflow-home.ts`（实为 `src/support/`）。
- VITEST 豁免是死路径（`package.json` 无 vitest）。
- F 编号台账不唯一：`schema-gen.ts` 是另一份 F 陈述表，`CHANGELOG`+`docs` 对 5 个编号（F10/F22/F25/F49/F52）查无定义。
- 真开发用 `TODO/FIXME` = **0**；现存 7 处全是用户可见骨架占位符（`session-export.ts`、`apps.ts`），保留。

**结论**：清理 **B 类 829 行 + C 类 85 行**，不是 11,479 行。A 类 JSDoc 契约（`executor-types.ts` 59.8%、`ctx-types.ts` 51.3% 注释占比）必须保留。历史归宿统一为 `CHANGELOG.md` 的 `## Decisions` 节（≤40 条，只收「约束未来代码」的被禁设计/事故/why；不新建第四本账，评审 C4）。

### 2.3 常量配置写死、出处不统一：键单源了，读取点/调参数/文档没单源

**已单源的部分**：`config-schema.ts` 33 键/8 组（16 静态默认、17 动态空、4 legacy 别名、3 secret）；`RC_GROUPS`/`CONFIG_KEYS`/`DECISION_SERVICE_KEYS`/`RUN_DEFAULT_KEYS` 均由它派生；配置示例 JSON 由 `tools/config-example.ts` 生成 + `--check`；`DEFAULT_CONF_FLOOR=0.25`、`DEFAULT_DECISION_TIMEOUT_MS=30_000` 已分别被 3/4 个消费点共用；`applyEnvNoOverwrite` 统一层叠语义。

**出处漂移 9 例，其中 4 例已实测不一致**：

| # | 不一致 | 现状 |
|---|---|---|
| 1 | 配置键总数 | `.env.example` 仅 29 键（缺 4 个决策开关），头部自己写死「29 键」；schema 已 33 键 |
| 2 | 浏览器通道 | `CONFIG_REFERENCE.md:69-70` 称 `AMBERFLOW_BROWSER_CHANNEL`「走 rc 的 `browser_channel` 键」，但 rc 白名单=CONFIG_KEYS，schema 无此键，写入会被当未知键拒绝 |
| 3 | 产物目录 | `CONFIG_REFERENCE.md:44` 写 `$HOME/apps-out`，代码是 `os.tmpdir()/amberflow-apps`（`support/amberflow-home.ts:69`） |
| 4 | 安全语义 | `CONFIG_REFERENCE.md:60` 写 `CONFIRM_SAFE=1`「安全动作免确认」，schema 写「危险动作仍逐次确认」——**语义相反** |
| 5-9 | 其余 | state_context 语义、池帽 40 三处可不同步、决策超时两 provider 裸 `30_000`、done 轮询 120 双源、帮助未列决策开关 |

**重复字面量账本 14 个概念**（3 已单源 / 4 半单源 / 7 仍多写）：导航 goto 超时 30,000 写 11+ 处无常量；done 轮询 120 双源（`executor.ts:3289` vs `app-runner.ts:1121`）；池帽 40 双写（`extraction.ts:832` vs `executor.ts:627`）；文本预算 400 在 6 处同值不同义；决策超时虽已单源但 `decision-openai.ts:151` / `system-one-client.ts:175` 仍裸写；会话 idle 300,000 在帮助文案手写；等等。

**硬编码与站点知识**：`data/datasource.ts:1300` 直接访问 `flight_no/dep/price`；`data/report-view.ts:177/198` 默认比较键写死 `price`；`engine/picker.ts:14-24` 把电商站点 selector 当 choice criteria；`decision-tokenplan.ts:51` 写死单站点实测 floor 0.2。`datasource.ts:7` 声称有「引擎无站点知识」回归测试，但该测试在仓库不存在。

**门禁缺口**：配置相关离线门禁只有 `configs/amberflowrc.example.json` 一处（schema→JSON）；`.env.example`、`CONFIG_REFERENCE.md`、README 无生成、无漂移校验。

### 2.4 提示词太长且散落：Agent 面已治理，模型面在门外

**规模**：模型决策 prompt **25 处 / 10 文件 / 5,542 字符**；去重后 **11 条 / 2,601 字符** → **重复 2,941 字符（53%）**。

| 用途 | 处数 | 典型位置 | 重复量 |
|---|---|---|---|
| 选目标 choice | 6 | `decision-service.ts:204`、`decision-bailian.ts:83`、`decision-jevk5.ts:51`、`decision-tokenplan.ts:97`、`decision-provider.ts:541`、`decision-openai.ts:195` | 164 字符 ×6 |
| 风险票 risk | 7 | `decision-service.ts:218` 等 4 处 246；`executor.ts:1374` = `decision-provider.ts:588` 332；jevk5 321 | 246×4 + 332×2 + 321 |
| 完成票 done | 7 | `decision-service.ts:221` 等 4 处 203；`executor.ts:1409` = `decision-provider.ts:602` = jevk5 221 | 203×4 + 221×3 |
| 升级/审计/legacy picker | 5 | `provider-escalator.ts:28`（401，唯一单源好样板）、`engine/audit.ts:72`（397）、`engine/picker.ts:35/41/47` | — |

**单请求真正的大头是证据，不是指令**：`criteriaView` 40 候选 **3,290 字符**、120 候选 **9,991 字符**、200 硬帽约 **16.6k**；`stateText` ≤320 字符；`state_digest` ≤200B；`site_facts` ≤3×200；本地 laya 用 `maxLen=512` token **静默截断**（不报错、不记账）。

**治理缺口 8 条**：25 处模型 prompt；11 条重复文本；证据渲染器无 golden/预算；`plan.ts:184` 的 1,433 字符 wrapper；`audit.ts:72`；`picker.ts`；桥 82 个手写 description（74 个静态可解析，13,231 字符）在门禁外；`CANDIDATE_WINDOW_TEXT` 明示不进 doc 组。`docs/PROMPT_SYSTEM.md:7` 明确把「决策模型协议」排除在范围外；`tools/prompt-hit.ts` 全文 0 处 import `src/model`——假设成立。

**Agent 侧现状（可直接复用）**：三层系统 + prompt-hit 8 组已把 grammar/playbook/overview/停因/介入文案管住；本轮只需把同一套「单源 + 生成物 + 离线断言 + 长度预算」模式复制到模型 prompt、证据渲染和桥描述。

### 2.5 实现主线不清晰：一个执行器，四条编排

**入口**：19 个可执行入口，需按三类登记（评审 A9）：① 引擎入口（`bin/amber.mjs` → `src/cli/main.ts` + 11 个命令 + 3 个内置命令）；② 宿主集成入口（DSH 桥、`amber session` 长驻子进程——进程边界是契约）；③ 开发/创作脚本（`npm start`/`apps`/`learn`/`test`/`plan-cli`、MV3 extension、`datasource` 隐藏入口）。其中 **6 个命令 handler 通过 `ctx.runEntry` 以子进程转交旧入口（12 个调用点）**：`amber run <app>` spawn `app-runner.ts`、`run --plan` spawn `plan_cli.ts`、`run --goal` spawn `start.ts`、`plan run` spawn `plan_cli.ts`、`record` spawn `learn.ts`、`model fetch` spawn `model-fetch.ts`。

**编排 4 套 + 6 处中间件装配**：

| 编排 | 位置 | 问题 |
|---|---|---|
| `runPlan` / `runSubgoalWithRetries` / `runOnce` | `engine/planner.ts:200/118/73` | 计划路径；`runOnce` 与 `ctx.runOneStep` 各自组装 `RunOptions`，能力面不对称（F72/F75 的 authoring→run 缺口即此结构） |
| `runOneStep` | `app/ctx.ts:258` | flow 路径；与 `runOnce` 是双实现 |
| `runScriptApp` / `runApp` | `app/app-runner.ts:2015/1245` | 双运行器同构：会话创建两处、决策探测三处、每个 run 级新能力双改 |
| online suite / start / plan-cli 各自建 mw | `online/runner.ts:104`、`start.ts:419`、`plan-cli.ts:339`、`app-runner.ts:1405/2144`、`session-runtime.ts:346` | 6 处真实装配；新增 `MiddlewareOptions` 要逐处接线；各面 confirm 策略不同（app-runner 默认拒绝、start/online 自动放行），不能简单统一 |

**重复路径 8 组**：`runApp` vs `runScriptApp`；`runOnce` vs `runOneStep`；ctx live/dry/replay（session-runtime 复用 createCtx，不是第 5 实现）；`app-pack`/`app-adapters`/`app-meta`/`session-export` 四份「步骤形状」知识；FW8/DRF/F64/A3 四条目标恢复；「跑/校验一个 app」5 个门；6 处 mw 装配；配置/节奏前奏 4 份。

**公共面与文档**：`src/index.ts` 25 条导出/20 模块，**仓内 0 个 importer**，且 `package.json` 的 `exports["."]` 指向 DSH 桥（插件安装门，不能改）——`index.ts:1` 的 "Public surface" 与事实矛盾；CHANGELOG 已记录 M0 决策「首次发布不承诺引擎 import API，消费面以 CLI 为准」。死导出抽样 7 条（`outcome-memory` 无消费者且接口在 `executor-types.ts:547` 重定义、`pickerServer` 0 消费者、`flow.ts` 只 re-export 一个 `REPO` 常量、`export * from executor.ts` 公开 71 个方法含下划线内部件等）。

**文档断点 6 处**（逐条已核实）：

1. `ARCHITECTURE.md:11` 的「唯一执行循环」不覆盖编排层——循环唯一但编排 4 套，`ctx.run` 是工具/进程腿，根本不进执行器。
2. `ARCHITECTURE.md` 分层图缺 5 个关键模块：`declared.ts`、`session-runtime.ts`、`session-export.ts`、`cli/start.ts`、`cli/plan-cli.ts`；DRF/F64/A3 三条恢复路径不在图里。
3. `src/app/kit.ts:8` 仍教 `export const app = (kit) => ({ data, exec })`，而 `app-script.ts:155` 对 `mod.app` 硬报错「declarative-data was removed」。
4. `README.md:52` 说「离线跑通 4 个示例」，`examples/apps/` 实有 5 个。
5. `README.md` 文档清单不含 `ARCHITECTURE.md`（也不含 PROMPT_SYSTEM/BACKLOG）。
6. `package.json` 的 `exports["."]` 与 README/ARCHITECTURE 从不说明的「库导入面」矛盾；`src/index.ts` 只存在于源码注释。

**命名负担**：`executor/runner/orchestrator` 三义、`session` 三义、`runtime` 四义、`app` 五层、`runApp` 4 义、`runPlan` 2 义、`journey` 是恒为空的死概念却在 90 处存活（只冻结、不改名，评审 B17）。

**确定性资产与教训**：`fixtures/engine/` 有 4 个静态页 + README，但全仓 0 引用（死资产，与 AGENTS「无离线夹具」表述矛盾）；`tools/row-anchor-check.ts`（25 条内存断言）已进 check，证明合成断言模式可行；门禁腐烂已有两次前科（bridge.yml / checks.yml）。

---

## 3. 目标状态

### 3.1 两层视图：依赖分层 L0–L6(+L1.5) 与执行阶段 S0–S5

> **评审修订**：v2 的 L0–L5 是「执行阶段」，不能顶替 v1 的依赖分层表；本版恢复 v1 的 L0–L6 编号并补全模块，执行阶段单列为 S0–S5。两者都进 `docs/MAINLINE.md`。

**(a) 依赖分层（唯一分层表；只允许向下/同层 import，例外须登记）**

| 层 | 模块 | 说明 |
|---|---|---|
| L0 support | `support/*`（paths/config-schema/config-store/rcfile/apply-config-env/merge-env/amberflow-home/pace/sleep/cli-args/intervention-contract/intervention-texts/decision-provider-contract 等） | 只依赖 node 内建；新增 `decision-provider-contract.ts`（provider 接口类型） |
| L1 共享语言/叶子 | `signals`+`signal-ops`、`hint`、`click-at`、`surface`、`plan`（类型）、`pystr`、路径解析、host-envelope、**新增 `src/prompts/`（模型 prompt 单源）** | 纯语言/数据；engine 与 model 都可 import |
| L1.5 intervention | `src/intervention/`（合同/文本零依赖 + runtime 只依赖 L0 两叶子；`src/app/intervention-adapter.ts` 是唯一适配） | 见 `docs/INTERVENTION_RESCUE_MODULE.md` §2；登记不破坏 |
| L2 机制 | `browser-env`、`tool-signals`、`extraction`（pool-js/identity/frame-scope）、`actions`、`rules`、`settle`、`dataset`、`datasource`（传输/来源） | 页面扫描/动作/稳定门等机制 |
| L3 决策 | `model/*`（provider 协议/缓存/ONNX/prompt views/审计） | 实现 L0 的 provider 契约；现有 model→engine 7 条反向边登记为待收缩例外 |
| L4 执行 | `executor`、`planner`、`bindings`、`observe`、`pool-view`、`picker`、`audit` | 唯一执行循环；只消费 L0–L2 与 provider 契约 |
| L5 应用 | `app/*`（ctx/runner/adapters/trace/report/session-runtime/session-export/intervention-adapter） | flow 运行期面；session-runtime 是调试面（复用 createCtx） |
| L6 入口 | `cli`、`online`、`flow`（归纳）、`tools`、`integrations/dsh-bridge` | 入口层；bridge 是宿主集成（called, not embedded） |

现有例外（登记、只减不增）：engine→model 9 条（`executor.ts:114/120/146`、`executor-pure.ts:23`、`executor-types.ts:16-17`、`picker.ts:13` 等，靠 provider 契约下沉逐步收缩）；model→engine 7 条（`decision-provider.ts:28`、`hint-memory.ts:22-23`、`decision-openai.ts:17`、`decision-service.ts:29`、`decision-tokenplan.ts:24`、`page-context.ts:12`、`provider-escalator.ts:19`）。**不把 grep=0 当目标**，只要求不新增并逐步减少。

**(b) 执行阶段（主线 S0–S5）**

```
S0 入口三类  引擎入口（bin → cli/main → registry） ｜ 宿主集成（bridge/session 进程边界=契约） ｜ 开发/创作脚本
S1 执行内核  runExecution(source, deps)
             共享：SessionLease(惰性创建/finally 关闭) · RunScope{run_id,outDir,budget,deadline,trace,result,warnings}
                   StopClassifier(停因→退出码) · mask/scrub · artifacts 落盘 · attempt 记账
             不共享：重试（归源）、sleep（归 pace 应用点）、业务判定（归 ctx/checkSignal）
S2 源适配器  flow    : loadScriptApp → flow(ctx)；重试/分支 = 脚本控制流；完成 = ctx.done 不变量
             plan    : TaskPlan 子目标循环 + retries/replan + NEVER_RETRY_CODES 查询；结果 = RunPlanResult
             suite   : 用例 preflight/case 执行/oracle/证据；case 结果 = CaseOutcome
S3 套件聚合器  tier 选择、exit code 0/1/2/3、--require-all、证据目录（源之上薄层，不是第 5 套编排）
S4 引擎步装配  execStep(ports, EngineStepSpec)  仅引擎步；工具步由 Ctx 契约的 toolRunner 单列，不进执行器
S5 唯一循环   BrowserMiddleware.run（不变，不重写）+ buildMiddleware(config) 组合根（run-scoped 注入）
创作/调试面（非主线，不进内核）：session-runtime(attach/调试，复用 createCtx) · record/learn · 一次性 goal
```

**取消的错误表述**：原 v2 的「第 5 个类 ctx」（session-runtime 复用 createCtx）、「重试上移 kernel」（违反 flow 控制流）、「handler 零 spawn」（bridge/session 的进程边界是契约；内进程化延后）。

### 3.2 单一出处

| 面 | 唯一出处 | 生成物 / 门禁 |
|---|---|---|
| CLI 命令 | `src/cli/registry.ts` | `amber --help` / `help --json`（现状已有） |
| 配置键与默认值 | `src/support/config-schema.ts` + `src/support/env.ts` typed getter | 示例 JSON（已生成）、`.env.example`、`CONFIG_REFERENCE` 键表（新增生成 + 三向校验） |
| 引擎调参 | `src/support/tuning.ts`（只收 11 个已证多写概念） | 常量带单位命名；不建通用 literal gate |
| 模型提示词 | `src/prompts/`（L1 叶子，PromptSpec 最小形态） | 快照 hash / 预算 / 去重门禁（prompt-hit model 组） |
| Agent 提示词 | 现有 `grammar-prompt` / `planning-playbook` / `help-map` / `schema-gen` | `tools/prompt-hit.ts` 8 组（已存在，扩展 model 组） |
| DecisionProvider 接口 | `src/support/decision-provider-contract.ts`（L0 叶子） | engine 只 import 契约；model 实现；组合根注入 |
| 历史记录 | `CHANGELOG.md` 的 `## Decisions` 节（≤40 条） | 代码注释禁日期/方案台账；门禁 ratchet |
| 主线与分层 | `docs/MAINLINE.md` + `ARCHITECTURE.md` | mainline 组静态断言（层表 + 阶段图 + 目录→层映射） |
| 应用声明 | `meta`（`app-meta.ts` 唯一投影） | 未知字段加载期拒绝（现状已有） |
| 包公共面 | `package.json` `exports` 表（`.` = DSH 插件） | exports 表锁定 + 死导出检查；**不建 sdk** |

### 3.3 扩展点地图（可扩展性目标）

| 要扩展什么 | 今天要改 | 目标 | 机制 |
|---|---|---|---|
| 新应用/流程 | 用户目录一个 `app.mjs` | 不变 | 已是数据/脚本 |
| 新站点/用例 | `online/` JSON | 不变 | 已是数据 |
| 新 CLI 命令 | 3 处（registry/handler/help-map） | 3 处 | 保持 |
| 新配置键 | 最多 4 处（schema/消费点/`.env.example`/CONFIG_REFERENCE） | **2 处**（schema + 消费点） | 文档由 schema 生成 |
| 新调参常量 | 散落 1–N 处 | **1 处** | `tuning.ts`（仅已证跨模块概念） |
| 新信号算子 | 5 文件/3 src | **≤3** | signals + signal-ops + grammar-prompt，prompt-hit 自证 |
| 新停因 | 3+ 文件 | **≤3** | planning-playbook + schema-gen + 消费点，prompt-hit coverage 自证 |
| 新决策 provider | 复制 3 条 prompt + 协议适配 + 注册（6+ 处） | **≤2**（adapter + registry 引用） | alias 现有 `DecisionProvider` 契约 + PromptSpec |
| 新 ctx 原语 | ≥7 处（types/live/dry/replay/kit/scan/schema） | **≤4** | 单一 Ctx 契约 + 行为矩阵 + conformance |
| 新桥字段/策略键 | 16 文件（引擎 + 桥各写一份契约） | **≤3** | 共享契约模块 + 生成物；调用方保持 called-not-embedded |
| 新中间件选项 | 6 处装配逐处接 | **1 处** | `buildMiddleware(config)` 工厂 + per-face policy |

### 3.4 量化目标（主指标：同一语义实现份数 = 1）

> **评审修订**：行数/函数规模/注释占比/touch-count 均降为 report 或 warn，不作为硬 KPI（防 Goodhart，评审 C6）。硬指标只保留可机械判定、且不诱导错误行为的项。

| 维度 | 指标 | 基线 | P1 | P2 | 性质 |
|---|---|---|---|---|---|
| 语义 | **同一语义实现份数**（§2 的 7 组同构 + 8 组重复路径） | 仍多份 | 主要同构收口（0.7 + W1-a） | ≤3（其余为契约实现/适配器） | **主指标** |
| 注释 | 硬失败：幽灵引用/行号锚点/裸 TODO | 23/3/0 | 0/0/0（P0 comments 组已启用） | 0 | fail |
| 注释 | ratchet：日期戳/方案台账 token/历史措辞 | 46/597/236 | 只减不增（B4/P1 迁移后转 0） | 0 | warn→fail（P1） |
| 注释 | 注释占比 | 22.2% | report（只减不增） | report | report |
| 配置 | 出处漂移 | 9 | 0 | 0 | fail |
| 配置 | 白名单外裸读 env | 33 处/10 文件（须先列全例外） | 0 | 0 | fail |
| 配置 | 多写/半单源概念 | 11（14 中） | 0 | 0 | fail |
| 提示词 | 重复字符 | 2,941（53%） | 0 | 0 | fail |
| 提示词 | 有快照/预算的 spec | 0 | 11/11 | 11/11 + 证据 spec（条件） | fail |
| 规模 | 新文件行数 | — | ≤800 | ≤800 | fail（新代码） |
| 规模 | 新函数行数 | — | ≤150（计划内阶段函数 ≤400 例外） | 同左 | warn |
| 规模 | 最大文件/≥300 行函数 | 6140 / 9 | report；运行期拆分需 0.8/0.9/freeze | report；条件目标 ≤3000 / ≤6 | report |
| 主线 | 真实 mw 构造 | 6 | 1 工厂 + 调试面 2 | 1 工厂 + 调试面 2 | warn→fail |
| 主线 | 源适配器 | 4 套编排 | 文档登记 3 类 | kernel + 3 适配器 + 套件聚合器 | fail（P2） |
| 主线 | 入口分类/进程边界 | 混在一起 | MAINLINE 三类登记 | 同左 | fail（docs） |
| 主线 | 公共导出 | 25/20 模块，0 消费者 | 删 Public surface 宣称、锁 exports | 死导出=0 | fail |
| 主线 | 文档断点 | 6 | 0 | 0 | fail |
| 验证 | 等价 lane 覆盖拆分类 | 0 | 0.8 绿（canonical golden + split hash + inspect 子集） | 运行时 lane/fixtures 二选一已决 | fail（P2 前置） |

### 3.5 扩展 KPI 的口径（防 Goodhart）

touch-count 只作**方向性参考**：真实判据是「同一语义实现份数 = 1」+ 扩展演练的定性评审（每项新能力能否只改一个语义模块）。不以「少改文件」奖励把逻辑塞进已有大文件；新文件硬上限与模块职责图约束聚合。扩展演练每 P2 批次做一次（新 provider / 新配置键 / 新调参 / 新桥字段 / 新 ctx 原语），记录实际改动面与遇到的隐式耦合。

---

## 4. 五条治理线

### 4.1 W1 大文件与职责捆绑

**策略：先证据、再冻结、后拆分；只拆边界稳定区，运行期拆分条件化。**

| 阶段 | 内容 | 改法/前置 | 验收 |
|---|---|---|---|
| W1-a 同构收口（P0 部分 + P1） | 0.7 关闭决策面判空（6→1，trim 统一）与掩码契约（3→1）；W1-a 只留 pickRow 三写、帧门禁 9 处、会话创建 2 处、决策探测 3 处、provider 谓词 | 各留一个单源函数/常量，其余调用；合成输入 + 内存断言（row-anchor-check 模式） | `npm run check` + 两入口同应用 canonical diff + 25–40 条内存断言 |
| W1-b 机械外搬（P1，机会主义） | **只搬边界稳定区**：`app-pack`（policy→`pack-policy.ts`、expand→`pack-expand.ts`、`validatePack`→`validate-pack/*` 保顺序/文案）、`datasource`（transport/extract-ops/source-validate）、`extraction` 纯区（rows/heuristic/hint-identity/frame-evidence）、`app-runner` 外围（类型区/tool-step/report） | **前置 0.8/0.9**；`src/index.ts` 的 `export *` 文件保 barrel；`app-runner.ts` 被桥按路径 spawn（`bridge.ts:445`）且 checkout 探测依赖该文件，入口 guard 不搬；不新增第 4 个 `RunOptions` | typecheck + examples canonical golden diff + split hash 工具；不运行期盲拆 |
| W1-c 运行期切分（P2 条件，BACKLOG #4 可执行版） | 先 2.0：RunCtx + evidence collector（BACKLOG #4 前置）；再 2.1：`run()` 九阶段（setup/frameGate/poolGate/declaredTargets/commandSpace/modelPick/actionPhase/postAction/reportTail），记账闭包升 run context 对象；`createCtx` 装配体瘦身、`validatePack` 子校验 | 前置：2.0 决策（发布/特性冻结）+ 0.8/0.9 绿 + INTERVENTION 步 4/5 完成 + freeze window；**携带 StateCursor、钩子顺序不变**；阶段函数 ≤400 行显式例外；类名/`run()` 签名逐字节不变 | 每阶段 1 PR + 运行时 lane 证据（0.8）；`amber apps check/explain` dry + 一个 core case trace 对比；T1 触发即停 |
| W1-d 函数/装配瘦身 | 不单独排期；作为 W1-b/W1-c 的验收副作用 | 不设行数硬 KPI；`run` ≤800 为条件 P2 目标而非承诺 | report |

**禁区**：不另写执行器；不改 `stopCode`/evidence 形状；不为了行数搬移改变语义；不追「≥300 行函数 0」。

### 4.2 W2 注释规约与历史迁移

**规约**（写入 AGENTS.md「硬规则」下一节，P0 落地）：

| 写 | 不写 | 历史去哪 |
|---|---|---|
| 契约/不变量、安全红线、非显然 why、单一出处指针 | 日期戳（`2026-10-29 实测…`） | `CHANGELOG.md` 的 `## Decisions` 节（已有 1,582 行台账；不新建文件） |
| 工具链硬约束（如 strip-types 限制） | 批次/方案编号叙事（`F75：…`、`批 2 遗留…`） | 同上；仅「约束未来代码」的条目，≤40 条 |
| 符号名指针（`见 rules.anchorChainMatch`） | 行号锚点（`L4247`、`executor.ts:2316`） | 行号不可维护，一律改符号名；门禁断言 |
| — | 「以前如何/现在改成」的 diff 叙事、失效测试设施、幽灵引用 | `git log`/`git blame`；测试恢复后由测试承载 |

**清理批次**（按评审减量）：

| 批 | 范围 | 量 | 批次/风险 |
|---|---|---|---|
| B1 失效引用 | `历史回归`×12、缺失 md×3、错误路径×2、测试替身×4 | ≈23 行 / 10 文件 | P0 0.3，极低 |
| B2 行号锚点 | executor.ts:3441、schema-gen.ts:94/101（改生成源或删行号） | 3 处 | P0 0.3，低 |
| B5 变更叙事 | 63 行旧实现对比 → 删或改写为正述 | 63 行 | P0 0.3，低 |
| B4 历史叙事（选择性） | 只迁「约束未来代码」的条目到 CHANGELOG `## Decisions`（≤40 条）；其余随 git 历史 | 约 30–60 行入档 | P1，中（不追求 270 行全迁） |
| B3 F 台账（机会主义） | 改到的文件顺手删 token 留契约；不做 61 文件运动；5 个悬空 F 编号先补档或删引用 | 按触及文件 | P1，中低 |
| B6 VITEST 死路径 | rcfile/merge-env/apply-config-env 代码+注释 | 3 文件 | **单独立项**（产品决策：删豁免或恢复测试），不混入本方案 |
| B7 schema-gen 副本 | 巨型 statement/truth 串与 CHANGELOG 镜像 | 数据文件 | **移出**（不做 CHANGELOG→schema-gen 迁移）；只保留 STOP_NEXT ≤120 / F 编号可解析门禁 |

**保留清单**（不得删）：`plan.ts:161-163` strip-types 约束、`merge-env.ts:8-13` 层叠纪律、`executor.ts:990-995` provider 三档优先级、`plan.ts:22-27` `verify_after` 被禁的防回退约束、`frame-scope.ts:11` 单源教训（可迁 CHANGELOG Decisions 但代码留一句+链接）。

### 4.3 W3 常量配置收敛

**三层模型**：

| 层 | 归属 | 内容 | 规则 |
|---|---|---|---|
| L0 公共配置 | `config-schema.ts` + 新增 `src/support/env.ts` typed getter | 33 键、默认值、掩码、legacy 别名 | 禁止消费点裸读 `process.env`；读取经 `readString/readInt/readBool/readEnum(key)`，默认值只来自 schema |
| L1 引擎调参 | 新增 `src/support/tuning.ts`（只收 11 个已证多写概念） | 池帽 40/宽扫 120、导航超时、决策超时、done 轮询 120、settle 400/5000、文本预算（按语义分别命名 `*_CHARS`）、会话 idle、命令默认值 | 同一数字 ≥2 处且语义相同 → 必须 L1 单源；命名带单位；**不建通用 literal gate** |
| L2 局部字面量 | 各模块 | HTTP 400/500、`86400000`、算法常数 | 保留；**同值不同义严禁按值合并**（HTTP 400 ≠ 字符预算 400） |

**批次**：

| 批 | 内容 | 验收 |
|---|---|---|
| W3-1（P0 0.2） | 修 4 处已实测不一致；`.env.example` 与 CONFIG_REFERENCE 键表由 schema 生成（含键数自动计算）；`config:docs:check` 三向键集校验 | `npm run check` + 新门禁 |
| W3-2（P1 1.1） | 建 `tuning.ts`，收拢 11 个概念；不建通用字面量 gate；仅对这 11 个 token 做「tuning 外出现即 warn」 | `typecheck` + 11 概念单源断言 |
| W3-3（P1 1.2） | typed getter + **全量白名单**：先列 33 处/19 变量/10 文件的例外（平台变量 PATH/NO_COLOR/LOCALAPPDATA/VITEST/GITHUB_SHA、`{{env:}}` 占位符、legacy LAYA_\*/OPENAI_* 审计点、bridge 进程环境、`process.env[...]` 动态读取）；收编 `AMBERFLOW_RESCUE_SHADOW`、`AMBERFLOW_BROWSER_CHANNEL` 或登记例外；bridge `DECISION_ENV` 镜像改共享 contract | `env-literal-gate`=0（白名单外） |
| W3-4（P1–P2） | 站点/业务知识出引擎：`datasource.ts` 航班字段、`report-view.ts` 默认 `price` 改配置/字段映射；恢复「引擎无站点知识」扫词门禁（用现有 datasource.ts:7 声明的口径，必要时修正该注释） | 扫词 gate=0 |
| W3-5（降级/不做） | 帮助文案从 schema 渲染、`ACT_POOL_CAP` 默认补齐等小项并入 1.1；无独立批次 | 快照/示例一致 |

### 4.4 W4 提示词单源与预算

**PromptSpec 最小形态**（新增 `src/prompts/` L1 叶子，**不放 `src/model/`**，避免 engine→model 依赖）：

```ts
interface PromptSpec {
  id: "decision.choice" | "decision.risk" | "decision.done" | "decision.escalate"
    | "audit.trace" | "picker.action" | "plan.rules";   // 闭集
  version: number;                 // 措辞/输出契约变更 +1
  role: "model" | "agent";
  lang: "en" | "zh" | "bilingual";
  build(ctx: PromptCtx): string;   // 同一 id 只允许一个 build
  budget: { maxChars: number; maxEvidenceChars?: number };
  consumers: readonly string[];
}
```

**协议能力矩阵**（评审 A3/A6 要求显式化，不强行统一证据面）：

| 能力 | systemone 4 provider | openai-decisions | laya-onnx |
|---|---|---|---|
| choice 问句 | 共享 `decision.choice` | 共享 | 共享 |
| 候选证据 | 只给 label（`system-one-client.ts:142`） | Goal/URL/Title/Page 四段 | `criteriaView`（role/label/[test]/→href） |
| 风险/完成票 | 共享 `decision.risk/done` | 共享 | 共享 + executor legacy 兜底（P2 收编） |

**迁移批次**：

| 批 | 内容 | 预期 |
|---|---|---|
| W4-1（P0 0.4） | 11 条去重文本收进 `src/prompts/`；6 个 provider + `executor.ts:1374/1409` 兜底 + picker 改为引用 id；文本**逐字节不变**（hash 对照）；prompt-hit 加 `model` 组（去重/预算/快照/无站点名/契约句） | −2,941 字符（53%）；25 处→11 处；零行为变化 |
| W4-2（P1 条件 1.6） | 证据渲染 spec 化（`criteriaView`/`stateText`/`state_digest`/`site_facts`/`notes`）+ 预算 + 合成池 golden snapshot；laya 截断改为「先裁剪再编码」并记 `evidence_truncated`；仅在真实失败案例驱动下推进 | 40 候选 ≤6k、120 ≤12k、200 帽 ≤20k；超限告警 |
| W4-3（P1） | Agent wrapper 收口：`plan.ts:184` 1,433 字符 → `plan.rules` spec；`CANDIDATE_WINDOW_TEXT` 的数字由 `extraction.ts` 常量渲染；`PLAN_PLAYBOOK_*` short/full 两档 | 数字阈值单源 |
| W4-4（P2，降级） | 桥 82 个手写 description：只加「长度预算 + 命令死链 + 无站点名」warn，不做模板化 | 桥描述纳入 coverage |
| W4-5 | **砍**（schema-gen 长 statement 拆分移出）；只保留 `STOP_NEXT` 每键 ≤120 字符的小约束 | — |

**预算分级**（进 gate）：模型单条指令 ≤400 字符；单请求证据 40 候选 ≤6k / 120 ≤12k / 200 帽 ≤20k；Agent 概述 ≤400（已有）、playbook short ≤500 / full ≤2,200、`STOP_NEXT` 每键 ≤120。**压缩策略**：结构化优先（`state_digest` JSON 替代散文、候选行保持 `role "label" [test] [href]`）、短/长两档取代 246/321/332 多变体、证据按预算优先级裁剪并记账。

**注意**：W4-1 是逐字节等价的纯搬移；W4-2 之后任何改动都必须 version+1 + 快照 hash 变更 + 一条真站 A/B 证据进 PR 描述，不能静默改措辞。

### 4.5 W5 主线收敛

| 阶段 | 内容 | 验收 |
|---|---|---|
| W5-0（P0 0.6） | 新增 `docs/MAINLINE.md`：**依赖分层 L0–L6(+L1.5) + 执行阶段 S0–S5 + 目录→层映射 + 三类入口表 + 命名表 + 并行设计/文件预留**；mainline 静态断言：入口分类、`new BrowserMiddleware(` 计数（基线 6+1 注释）、`ctx.runEntry` 计数（12）、`src/index.ts` importer=0、目录→层映射、未登记目录报红 | `npm run check`；负向自测（合成违规必红） |
| W5-1（P1 1.5） | 单一 `buildMiddleware(config)` 工厂替换 6 处装配；**confirm/掩码/pace 为 per-face 必填策略**（app-runner 默认拒绝、start/online 的自动放行不改，单独立项复核）；provider 装配 run-scoped 注入，禁全局 install；handler 进程内化**延后**（bridge/session 进程边界是契约） | 同应用走 `amber run` 与 `npm run apps` 产物 canonical diff（除时间戳）；退出码矩阵不变；confirm 解析来源离线断言 |
| W5-2（P2 条件） | `runExecution(source, deps)` 内核 + 三类源适配器（flow/plan/suite-case）+ 套件聚合器；Ctx 行为矩阵（预算/导航/工具步/人工步/错误形状/trace/pace）+ `tools/ctx-conformance.ts`（fake PageLike 离线 diff）；`journey` 只冻结不改名 | `apps check/explain` dry 不变；flow/plan/suite 三源 canonical JSON 对比；ctx conformance 绿 |
| W5-3（P2 条件，降级） | `DecisionProvider` 接口契约下沉 `src/support/decision-provider-contract.ts`；engine 只 import 契约，model 实现，组合根注入；现有 engine↔model 例外登记并逐步收缩；**不做 BrowserPort/TargetResolutionPort**；TargetResolution 改为执行器内部 `resolveTarget` 阶段 + 单恢复策略表，候选契约跟 BACKLOG #2 | `grep 'model/decision-provider' src/engine/` 不新增且按批减少；rules-only 消融 trace 一致；与 BACKLOG #2/#3 排他 |
| W5-4（P1/P2） | 公共面：删 `src/index.ts` 的 "Public surface" 宣称（改 internal）；**不改 `exports["."]`（DSH 插件安装门）**；**不建 sdk**；extension 立删；picker-server 先 deprecated；死导出清理；包身份 ADR 先于任何 exports 变更 | exports 表锁定 + 死导出=0 + README/ARCHITECTURE 补「无引擎库导入面」说明 |

**旧路径处置**：

| 路径 | 处置 | 理由 |
|---|---|---|
| `runApp` 声明式分支 + 恒空 `journey` | **冻结**（不删不扩、不改名），主线只留 flow → `runExecution` | learn 回放仍依赖；改名为非零行为（90 处引用） |
| `runPlan` / `runSubgoalWithRetries` | 保留为 plan 源适配器（P2 后薄封装） | 计划文件/一次性目标仍是文档化用法 |
| `ctx-dry` | 保留（门禁快路径） | `apps check`/`examples-check` 依赖，已是单实现 |
| `ctx-replay` / `session-runtime` / `session-export` | 保留但降级为「调试器/录制器」，文档与目录标注 non-mainline；session-runtime 复用 createCtx | 有真实使用（`--replay`/`amber session`） |
| `cli/start.ts` / `cli/plan-cli.ts` + `tools/plan_cli.ts` / `app-runner-cli.ts` | 冻结：保留 CLI 兼容，内部改调主线；不再加新旗标（新增只进 registry） | 三个旧入口是双实现温床 |
| `picker-server` + `extension/` | extension 立删；picker-server deprecated 一版后评估删除 | extension 指向已删 Python 服务且未进 files；picker 0 消费者 |
| `model/outcome-memory.ts` | 接线或删除（二选一） | 现状导出无消费者，接口在 `executor-types.ts:547` 重复定义 |
| `fixtures/engine/` | **已定**：接入非门禁 `verify:offline` lane；不进 check；修正 AGENTS 表述 | 4 静态页可供离线等价验证，不提交运行产物 |

---

## 5. 防回潮机制（分层、可腐烂防护）

### 5.1 工具与基线

**不再做「6 组一工具」**（评审 B3）。拆为：

| 工具 | 组 | 初始档位 |
|---|---|---|
| `tools/maintain/`（dispatcher ≤300 行 + 模块） | size / docs / comments / mainline | size（新文件 ≤800）与 docs fail；comments/mainline 先 warn，随清理转 fail |
| `tools/prompt-hit.ts` | 已有 8 组 + 新增 **model** 组（去重/预算/快照/无站点名/契约句） | fail（0.4 后） |
| `tools/config-example.ts` | 示例 JSON + 新增 docs 三向（schema ↔ `.env.example` ↔ CONFIG_REFERENCE 键集） | fail（0.2 后） |

**基线协议**（评审 B2）：

- **上限式 baseline**：记录允许的存量超标项（文件/函数/注释计数/入口/装配点），新代码只受「新文件 ≤800、新函数 ≤150（计划阶段函数 ≤400 例外）」约束；不要求存量每 PR 递减。
- **ratchet 计数**：存量超标**项数**与**阈值**只减不增；`--update` 只许调低；CI 用 `git merge-base` 对比基线防手改上调。
- **allowlist 条目**必须带理由 + 90 天过期（过期未续自动 fail）；活跃文件只在声明的 **freeze window** 内 no-growth。
- **启用顺序绑定前置**：0.1a 只开 size/docs；mainline 随 0.6、comments 随 0.3 清理完成转 fail、prompts 随 0.4、constants 随 1.1；未就绪的组不得提前 fail。
- **负向自测进 check**：每组至少 1 条合成违规必须红（`--self-test`），防止门禁假绿。

### 5.2 流程与责任（对齐单作者 trunk 现实）

- **不做空转仪式**：不设 owner 路由/评审委员；`docs/MAINLINE.md` 只维护「模块→负责人」一列（当前=项目所有者），新增跨层能力时由该列决定是否升级为 ADR。
- **PR 三问**（合并前自检）：① 是否新增同一语义的第二份实现？② 是否新增文件/函数超限或新增注释历史/行号锚点？③ 是否改主线入口/装配点且未更新 MAINLINE？
- **新能力 DoD**：满足 §3.3 touch-count 方向性目标；新增 prompt 必进 `src/prompts/`；新增配置键只改 schema；`npm run check` 绿。
- **基线维护**：每批合并时同步下调可下调的基线；季度用 `maintain --report` 输出趋势（不新增独立看板）。

### 5.3 停手/简化触发器（写进方案硬约束）

- **T1 冲突触发器**：任一批次与同期功能提交冲突 ≥3 次/周，或 PR 存活 >5 个工作日 → 停该批，改「机会主义拆分」；P0 后 4 周仍无 ≥2 批按计划落地 → 收缩为 MVG fallback（§6）。
- **T2 门禁反噬**：新门禁上线 2 周内误报/需修 ≥3 次，或单次新增能力需改门禁 >1 次 → 该组降 warn 或删除；`npm run check` 本地时长增长 >50% 同样触发。
- **T3 行为漂移**：任一 prompt 快照变更/拆分批次后 smoke/core 失败或 trace diff 不可归因，或出现 1 次未在 PR 声明的行为差异 → 回滚该批并冻结后续 batch，直到补上离线 golden。

---

## 6. 路线图（每批 = 独立可回滚 PR）

### P0 冻结与真值（2–3 周，10–14 人日）

| 批次 | 内容 | 关键文件 | 验收 |
|---|---|---|---|
| 0.1a | `tools/maintain/` 骨架 + size/docs 基线 + 负向自测进 check | `tools/`、`package.json` | `npm run check` 绿 + 合成违规必红 |
| 0.2 | 配置文档真值：修 4 处漂移；`.env.example`/CONFIG_REFERENCE 键表由 schema 生成 + 三向 gate | `tools/config-example.ts`、`docs/CONFIG_REFERENCE.md`、`.env.example` | `config:docs:check` 绿 |
| 0.3 | 注释 B1+B2+B5（≈89 行）+ `AGENTS.md` 注释规约 + 5 个悬空 F 编号补档/删引用 | 10 文件、`AGENTS.md` | check 绿；禁止类=0 |
| 0.4 | 模型 prompt 去重进 `src/prompts/`（逐字节不变）+ 快照 hash + prompt-hit model 组 | `src/prompts/`、6 provider、`executor.ts`、`picker.ts`、`tools/prompt-hit.ts` | 文本 hash 前后一致；25→11 处 |
| 0.5 | 文档纠真：README 示例数/文档清单、ARCHITECTURE 分层图与主线图、`kit.ts` 注释、`journey` 标注 legacy（不改名） | README/ARCHITECTURE/kit.ts/app-meta.ts | docs 组 gate 绿；无代码行为变化 |
| 0.6 | `docs/MAINLINE.md` + mainline 断言（入口三类/层表/阶段图/目录映射/mw·runEntry 计数） | `docs/MAINLINE.md`、工具 | 门禁绿 + 负向自测 |
| 0.7 | 已确认 bugfix：决策面判空 trim 单源（6→1）、掩码契约单源（3→1） | `support/`、app-runner、executor-pure、redaction | 两入口同应用 canonical diff；行为变更在 PR 说明 |
| **0.8（新增）** | 等价证据 lane：examples-check canonical golden（normalize 临时路径/时间戳）+ `tools/split-check.ts`（搬迁符号源码 hash）+ inspect 归一化子集 + `verify:offline` fixtures lane 骨架（非门禁） | `tools/`、`fixtures/` | 0.8 lane 可在 CI 跑；纯搬移 hash 一致；fixtures 二选一已决 |
| **0.9（新增）** | seam/符号归属冻结表：`buildMiddleware` 签名、`execStep` 落点、DecisionProvider 契约位置、Ctx 行为矩阵归属、`RunOutcome` 包络、文件预留（INTERVENTION） | `docs/MAINLINE.md` | 表评审通过；W1-b 只能搬表内稳定区 |

**P0 出口**：§3.4 的 fail 项（注释硬失败类、配置漂移、prompt 重复、新文件上限、doc breakpoints）达标；0.8/0.9 产物存在且被 W1-b 引用；T1/T2 无触发；总投入 ≤14 人日。未达标 → 启动 MVG fallback。

### 6.1 P0 落地记录（2026-11-17）

| 批 | 交付 | 提交 | 出口证据 |
|---|---|---|---|
| 方案/评审/决策 | v2.1 + 评审记录 + 4 项决策 | `2dc7a50` | 评审记录 §5 决策表 |
| 0.2 + 0.5 | 配置文档真值（33 键三向生成/校验）+ 6 处文档断点纠真 | `cdeb63e` | `config:example:check` 三份一致；docs 组断点=0 |
| 0.4 | 模型 prompt 25→11 单源 + prompt-hit model 组 | `688ef2e` | 改前/改后 sha256 差异 0；prompt-hit 九组 |
| 0.1a + 0.6 + 0.9 | maintain size/docs/mainline 门禁 + MAINLINE + seam 冻结 | `606754d` | `maintain:check` 绿；19 条负向自测 |
| 0.7 | 决策面判空 trim 单源 + 掩码契约单源（声明 bugfix） | `2116514` | `npm run check` 绿；两入口判空口径一致 |
| 0.3 | 注释 B1/B2/B5 清理 + 注释规约 + comments 门禁 | `303b801` + `04d65c3` | 幽灵引用/行号锚点/裸 TODO=0；ratchet 基线入库 |
| 0.8 | examples canonical golden + split-check + verify-offline | `b72ed74` | `npm run check` 含 golden/split；`verify:offline` 4 夹具绿（无外部请求） |

**P0 出口判据核对**：

- 注释硬失败类（幽灵引用/行号锚点/裸 TODO）= 0；日期戳/批次 token/历史措辞进入 ratchet（B4/P1 迁移后转 0）。
- 配置漂移 = 0；`.env.example`/CONFIG_REFERENCE/示例 JSON 由 schema 生成并三向校验（33 键）。
- 模型 prompt 重复 = 0（25 消费点 → 11 唯一文本，快照 hash 钉住）。
- 新文件 ≤800 行、新函数 ≤150 行硬上限生效；mainline 断言（目录映射/index importer=0/mw≤6/runEntry≤12）绿。
- 文档断点 = 0（README 5 示例/文档清单/kit 注释/journey legacy/ARCHITECTURE 模块/AGENTS 夹具表述）。
- 0.8/0.9 产物存在且被引用：0.9 的 seam 表在 MAINLINE §4；0.8 的 split-check 已进 check、golden 已进 examples-check、verify-offline 非门禁可用。
- T1/T2/T3 未触发。P0 未逐日计时，但范围未扩张、未引入 fallback。

### 6.2 P1 落地记录（进行中，2026-11-17）

| 批 | 交付 | 提交 | 证据 |
|---|---|---|---|
| 1.1 + 1.2 | `tuning.ts` 11 常量（26 处同值替换）+ `env.ts` typed getter（裸读 21 行/18 变量 → 8 处/4 平台变量）+ maintain `constants` 组 | `3e5da4f` + `70e698d` | `maintain --self-test` 23 条；constants 0 fail/0 warn；examples golden 一致 |
| 1.4 | app-pack 1512→296 facade（3 新模块）；datasource 1417→74 facade（4 新模块） | `18e16cd` | split manifest 40+83 符号 hash 全一致；examples golden/verify:offline/check 绿 |
| 1.3 | `CHANGELOG.md` `## Decisions` 索引（D1–D12）+ comments `--update` ratchet 协议 | `1fbb9c1` | comments 组 + 2 条更新协议负向自测绿 |
| 1.5 | `buildMiddleware` 工厂 + W1-a 剩余同构（会话创建/决策探测/pickRow/帧谓词） | 待做 | — |
| 1.6 | Agent prompt wrapper 收口 + 证据 spec（条件） | 待做 | — |

> P1 出口指标（§3.4）尚未全部达标：>1000 行文件从 9 降到 7（ctx/app-runner/executor/extraction 等仍在），≥300 行函数仍 8 个；属 1.5/后续 W1-b 批次范围。

### P1 收口（3–5 周，12–18 人日；低 churn 优先）

1.1 `tuning.ts`（只收 11 概念）+ 单源断言；1.2 typed getter + 全量白名单 + env gate；1.3 注释 B4 选择性迁移 → CHANGELOG `## Decisions`、B3 机会主义；1.4 W1-b 稳定纯区拆分（app-pack/datasource/extraction 纯区/app-runner 外围，依赖 0.8/0.9）；1.5 W1-a 剩余 + `buildMiddleware` 工厂（per-face policy，CLI 进程边界不动）；1.6 Agent prompt 收口 + 证据 spec（条件，真实失败案例驱动）。

**P1 出口**：§3.4 P1 列 fail 项达标；真实 mw 构造收敛到 1 工厂 + 2 调试面；W1-b 每批有 canonical golden/hash 证据；注释禁止类=0、B 类仅存 CHANGELOG Decisions；裸 env 白名单外=0；模型 prompt 重复=0。

### P2 主线（条件启动；3–5 周，12–20 人日）

**启动条件**见 §0。批次：2.0 RunCtx + evidence collector（BACKLOG #4 前置）→ 2.1 `run()` 九阶段（freeze window；StateCursor 携带、钩子顺序不变）→ 2.2 `runExecution` 内核 + 源适配器 + `ctx-conformance` → 2.3 公共面清理（index internal、extension 删、picker deprecate、exports 锁定、无 sdk）+ 站点知识出引擎 + 扩展演练。

**P2 出口**：§3.4 P2 列；用户五项痛点逐条闭环（§9）；扩展演练 5 项 touch-count 与定性评审通过。

### MVG fallback（12–15 人日，若 P0 未达标）

只做三件：**M1 人读视图真值化**（0.2 + 0.5 + 注释 C/B1/B2 + 规约）；**M2 语义单源首批**（0.7 + W1-a 前 3 组 + 0.4 prompt 去重）；**M3 冻结与只减不增**（MAINLINE 一页 + 2 条断言 + 新文件 ≤800）。大文件行数、编排合并、公共面、ADR 全部推迟，明确承认缺口。

---

## 7. 验证矩阵（三栏化：CI 可重复 / 本地人工 / 不可验证则拆小）

| 变更类型 | CI 可重复（进 check） | 本地人工（一次性，PR 附证据） | 不可验证时 |
|---|---|---|---|
| 一切提交 | `npm run check`（现有 9 项 + maintain 的 fail 组 + prompt-hit model + config docs） | — | — |
| 文档/注释/基线 | maintain 的 docs/comments 组 + 负向自测 | 抽查 A 类注释保护清单 | 拆成纯文本小 PR |
| 配置/常量 | `config:example:check` + `config:docs:check` + `doctor` | 入口抽查（`amber run` vs `npm run apps`） | — |
| 提示词去重（P0） | 快照 hash 逐字节一致 | 真实站点 smoke（有网络时） | 不合并 |
| 提示词压缩（P1+） | 快照 hash 变更 + version+1 | 一条真站 A/B 证据进 PR | 推迟 |
| 纯搬移拆文件 | `tools/split-check.ts`（搬迁符号源码 hash）+ examples canonical golden | `apps check/explain` dry 对比 | 不搬 |
| 运行期拆分（P2） | 0.8 运行时 lane（fixtures 或静态页 + rules-only 消融 + normalize 后 trace/result） | 一个 core case trace 对比；smoke | 不启动 |
| 主线/公共面 | mainline 断言 + exports 表锁定 + 死导出检查 | `node -e 'import("amberflow")'` 名字集合（构建后） | 不改 exports |
| 门禁自身 | `--self-test` 合成违规必红 | — | 不上线 |

**0.8 lane 的具体实现**（评审 B1/B10/B11）：

1. `examples-check` 扩展为 canonical JSON golden（normalize 临时目录/时间戳/run_id 后逐字节），进 `npm run check`——现成的 subprocess 离线 harness。
2. `tools/split-check.ts`：对 PR 声明搬迁的符号取源码文本 hash，与 `tools/golden/splits/*.json` 比对；纯搬移必须一致（typescript 已是 devDependency，离线可跑）。这是「逐字节等价」最便宜的可门禁化实现。
3. inspect：normalize `saw_at`/`wait_ms`/绝对路径（复用 `tools/golden-manual.ts` 的 `normalizeForGolden` 先例），只比 `elements/hint_candidates/count` 子集，每批点名 URL。
4. 运行时 lane（**已定，非门禁**）：`npm run verify:offline` 用 `fixtures/engine/*.html` 静态服务 + rules-only 消融 + normalize 后 trace/result 对比；不进 `npm run check`；P2 运行期拆分仍以 0.8 的 CI lane（1-3 项）为主、此项为补充。
5. prompt：registry 快照 hash 入库 + model 组负向自测，不再依赖一次性「前后 hash 对照」。

**明确不新增**：不引入单测框架、不复刻真实站点、不造第二执行器；等价证据以离线 golden/split hash/conformance 为主，真实站点 smoke 仅作补充。

---

## 8. 风险、边界与禁区

**风险与缓解**：

| 风险 | 缓解 |
|---|---|
| 运行期拆分在 CI 不可验证（最高风险） | 0.8 lane 先行；W1-c 条件化 + freeze window + T3；未过 0.8/0.9 不启动 |
| 大文件拆分与活跃开发互踩（executor 61/17 天） | 机会主义拆分 + 小 PR + 文件预留 + T1 停手触发器 |
| 门禁腐烂（已有两次前科） | 2 fail + 2 warn；拆小工具；baseline 理由 + 90 天过期；负向自测进 check；T2 触发即降级 |
| 提示词改动影响模型行为 | P0 逐字节 hash；后续 version+1 + 快照 + 真站 A/B 证据 |
| 配置语义变化（trim bugfix） | 单独立项 0.7、显式声明行为变更；其余批次零语义变化 |
| 注释清理误删「为什么」 | A 类保护清单 + 人工抽样；历史只进 CHANGELOG Decisions（≤40 条） |
| 公共面误删/包身份不清 | 不改 `exports["."]`、不建 sdk；包身份 ADR；任何公共面变更前 `npm view` 核实发布状态 |
| 并行设计冲突（INTERVENTION/STATE_LAYER/RUN_TAKEOVER/BACKLOG） | §10 登记表 + 文件预留 + P2 前置条件 |
| 范围蔓延/过度设计 | 砍项清单 + MVG fallback + T1/T2/T3；本方案不含新功能 |
| Goodhart（行数/函数/注释占比） | 主指标是「语义实现份数=1」；规模指标 report/warn；扩展演练定性评审 |

**禁区（不改）**：

1. 不另写执行器：`BrowserMiddleware.run` 是唯一执行循环；拆分只做同门面机械拆分，类名与 `run()` 签名逐字节不变。
2. 完成只认信号：`checkSignal` 是完成与 `when` 的唯一裁决；提示词/报告/配置不得参与判定。
3. 值只来自计划/观察：缺值 `needs_value`，不猜。
4. 不引入 ajv/zod；不拆两份路径解析器（`resolve`/`selectIndex` 数据腿与工具信号同源）。
5. 不动 `meta` 唯一声明面与 `flow` 唯一作者模型；`journey` 只冻结，不改名、不扩。
6. 不改 `package.json` `exports["."]`（DSH 插件安装门）；不建 sdk。
7. 不新增第 4 个 `RunOptions`；工具步不进引擎步装配。
8. 配置纪律：新键只进 schema；`--provider` 不进配置面；凭据纪律与掩码唯一入口保持。
9. 危险步确认、人工步、反爬、凭据四条安全语义不动；start/online 的 confirm 自动放行不在本次收编。
10. 不做一次性大格式重排/全仓改名；不把「日期」写进代码注释（只在 CHANGELOG `## Decisions` 允许）。

---

## 9. 验收标准（问题闭环定义）

当且仅当以下五条 + 两条回访条件成立，本方案视为完成：

| # | 用户痛点 | 闭环判据（可验证） |
|---|---|---|
| 1 | 大文件难读 | 同一语义实现份数显著收敛（主判据）；新文件 ≤800；运行期拆分按 0.8/0.9/P2 条件交付（未交付则明确报告，不以行数为绿）；`run` 签名/执行器唯一性未变 |
| 2 | 注释历史 | src 禁止类（日期/行号锚点/幽灵引用/方案台账 token）=0；历史只存在于 CHANGELOG `## Decisions`；A 类契约注释占比不降；注释占比只作 report |
| 3 | 常量配置 | 9 例漂移=0；白名单外裸读 env=0；14 概念中 11 个多写/半单源清零；配置文档 3/3 生成/校验；站点知识代码面=0 |
| 4 | 提示词 | 25→11 spec；重复字符=0；11/11 有快照/预算/消费方；prompt-hit model 组绿；模型+证据+Agent+桥四面都在门禁内 |
| 5 | 主线 | MAINLINE 含依赖分层 + 执行阶段 + 三类入口 + 目录映射；真实 mw 构造 = 1 工厂 + 2 调试面；kernel + 3 源适配器登记（P2 条件）；`index.ts` Public surface 宣称删除、exports 锁定；6 处文档断点=0 |
| 回访 1 | 不回潮 | 完成后 30 天：fail 组仍绿、基线无上调、无 allowlist 过期未续；T1/T2/T3 未触发 |
| 回访 2 | 可扩展 | 用 §3.3 的 5 个代表性扩展各演练一次，记录实际改动面与隐式耦合；定性评审通过（不只看文件数） |

---

## 10. 与 v1 / BACKLOG / 并行设计的关系

**v1 已完成项（保留，不重做）**：L1 错位模块归位、C1 隐藏键堵漏、C2 默认值与合并语义单源、C5 `CONFIG_REFERENCE` 初版、F1 ctx 校验面外移、F2 executor 外围四区、F6 extraction 拆分、F7 datasource/app-runner 拆分、facade re-export 先例。

**v1 未实施项 → v2.1 落点**：

| v1 项 | v2.1 落点 |
|---|---|
| F3 `run()` 提九阶段 | W1-c（P2 条件，BACKLOG #4 可执行版） |
| F4 `decision-setup` 消重 + app-runner 拆分 | W1-a/W1-b（P1）+ W5-1 |
| F5 `validatePack` 拆段 | W1-b（P1，保顺序/文案） |
| C4 typed getter | W3-3（P1，全量白名单） |
| C3 合并语义单源剩余 | W3-2/W3-3 |
| F7 datasource 剩余（航班字面量） | W3-4（P1–P2） |
| L2/L3 分层收敛 | W5-3（降级：契约下沉 + 例外收缩） |
| BACKLOG #2（候选契约）/ #3（窗口递增） | 先决策，W5-3 只消费候选契约；不另造 TargetResolutionPort |
| BACKLOG #4（RunCtx/evidence collector/九阶段） | W1-c 的唯一实施依据（2.0 前置） |
| `deniedFrameUrl` 死代码 | W5-4 死导出清理时一并处理 |
| `docs/PROMPT_SYSTEM.md` 三层提示词 | W4 扩展为「模型 + Agent」双面治理 |

**并行设计登记表**（评审 A11/B7）：

| 计划/设计 | 状态 | 与本方案的约束 | 前置/排他 |
|---|---|---|---|
| `docs/STATE_LAYER_PLAN.md` | 部分已实施（settle/StateFingerprint/epoch/policy 键） | W1-c 九阶段必须携带 StateCursor、钩子顺序不变；ctx 行为矩阵收录 epoch/settle 语义 | W1-c 的验收项 |
| `docs/PACE_UNIFICATION_PLAN.md` | 已实施（support/pace.ts） | `runExecution` 只共享 `resolvePace/envPace/PaceClock`；**kernel 内不加 sleep**；unit 边界留源适配器 | W5-2 的约束 |
| `docs/INTERVENTION_RESCUE_MODULE.md` | 实施中（步 0-3 + 步 5 桥半边已实施） | L1.5 登记回层表；W1-b 运行期区（ctx/executor/app-runner）以步 4/5 + 默认切换为前置；app/adapter 解耦走 golden 六条人工路径 | P2 启动条件；文件预留 |
| `docs/RUN_TAKEOVER_AND_DOM_CONTEXT_PLAN.md` | proposal（未实施） | T1 失败现场四件套并入 `RunOutcome.artifacts`；T2 attach 归 session-runtime（调试面），**不进 runExecution**；D2 hint 第 7 形状与 W5-3 排他 | 不进 P0/P1 |
| `docs/BACKLOG.md` #2/#3/#4 | open / 部分裁定 | #2 候选契约优先于任何 resolve 面改造；#3 窗口递增依赖 #2；#4 是 W1-c 的前置与唯一依据 | P2 条件 |
| 行锚/FRAME_SCOPE/WITHIN_PARITY 计划 | 已实施/进行中 | W1-c 拆分不得改变 hint/resolve 语义；并行登记表登记文件面 | 文件预留 |

**文档变更**：

- 本文件修订为 v2.1（唯一治理方案）；新增 [IMPROVEMENT_PLAN_REVIEW.md](IMPROVEMENT_PLAN_REVIEW.md)（架构评审记录）；`AGENTS.md`「文档」节同步更新。
- 新增 `docs/MAINLINE.md`（依赖分层 + 执行阶段 + 三类入口 + 目录映射 + 命名表 + 并行设计/文件预留）。
- **不新建** `docs/DECISIONS.md`：历史归宿 = `CHANGELOG.md` 的 `## Decisions` 节。
- P0 更新 `ARCHITECTURE.md`（补层图、阶段图、缺失模块）、`README.md`（示例数、文档清单、无引擎库导入面）。

**已确认决策（2026-11-17 项目方拍板）**：

| # | 决策 | 落地动作 |
|---|---|---|
| 1 | **包身份 = CLI + DSH 插件，不承诺引擎库 API** | 删 `src/index.ts` 的 Public surface 宣称（internal）；`package.json` `exports["."]` 保持 DSH 插件入口不变；**不建 sdk**；README/ARCHITECTURE 补「无引擎库导入面」说明 |
| 2 | **plan 文件保留为可选适配器** | `runPlan`/`runSubgoalWithRetries` 保留，P2 后薄封装；不在本方案删除 plan 用法 |
| 3 | **批准修订后范围与 P2 条件** | P0 10–14 / P1 12–18 / P2 12–20（条件），MVG fallback 条款生效；P2 启动条件见 §0 |
| 4 | **fixtures/engine 接入非门禁验证** | 0.8 落地 `verify:offline` lane 骨架（静态服务 + rules-only 消融 + normalize 对比），不进 `npm run check`；同步修正 AGENTS「无离线夹具」表述 |

---

## 附录 A：关键数字复现命令

```bash
cd /root/coding/AmberFlow

# 文件/函数规模
find src -name '*.ts' | xargs wc -l | tail -1
node /tmp/amberflow-audit/fnsize2.cjs   # AST 函数/文件行数（需 typescript 依赖）

# 注释口径（区分字符串，避免 grep 把 prompt 模板算成注释）
node /tmp/amberflow-audit/lines.mjs

# 配置面 / 漂移
node --experimental-strip-types -e 'const m=await import("./src/support/config-schema.ts");console.log(m.CONFIG_GROUPS.length,m.CONFIG_KEYS.length)'
grep -cE '^[A-Z][A-Z0-9_]*=' .env.example            # 29 vs schema 33
grep -n 'apps-out\|CONFIRM_SAFE\|STATE_CONTEXT' docs/CONFIG_REFERENCE.md
grep -rn 'process\.env\.' --include='*.ts' src | wc -l   # 33 处 / 19 变量 / 10 文件（另 2 处下标）

# 提示词重复
grep -rn 'Which single element should be interacted' src --include='*.ts' | wc -l  # 6
grep -rn 'Judge ONLY the action itself' src --include='*.ts' | wc -l              # 7
grep -rn 'CONFIRM the goal is complete' src --include='*.ts' | wc -l              # 7
grep -c 'src/model' tools/prompt-hit.ts                                            # 0

# 主线
grep -rn 'new BrowserMiddleware(' --include='*.ts' src | grep -v 'executor.ts:45' | wc -l  # 6
grep -rn 'ctx.runEntry(' --include='*.ts' src/cli | wc -l                          # 12
grep -rn 'from "\.\./index.js"\|from "\./index.js"' --include='*.ts' src tools     # 0

# 发布物/死资产
node -e 'const p=require("./package.json");console.log(p.exports["."])'            # DSH 桥
grep -n "首次发布不承诺" CHANGELOG.md                                              # 1568-1569
grep -rn 'fixtures/' --include='*.ts' src tools online | wc -l                      # 0（fixtures 死资产）

# 既有门禁基线（离线，本轮全绿）
npm run check
```

## 附录 B：审计与评审方法与口径

- **只读审计/评审**：5 个审计任务（结构/注释/提示词/常量配置/主线）+ 3 个架构评审（目标架构/迁移治理/红队），全程未联网、未跑浏览器/模型、未修改仓库；所有断言用 grep/read/TS AST 核实，file:line 以 HEAD 91bf379 为准。
- **结构**：`wc -l` 文件行数 + `ts.createSourceFile` 函数区间（口径校正：基线 `fnsize.json` 用 `split('\n').length` 会 +1，本文统一 `wc -l`）。
- **注释**：字符级状态机区分 code/字符串/注释，M1=注释占用行，M2=有文字注释行；B/C 分级用规则法 + 40 段人工抽验交叉（A 81%/B 16%/C 2.5%，与规则法同量级）。
- **提示词**：静态字符数（不含运行时插值）；「重复」=去重后条目数差；证据渲染用合成元素池离线测量。
- **配置**：schema 导入 + 去注释/import 后的数字字面量统计 + 人工抽样 20 条判定；漂移项逐条与文档/代码对账；env 计数以「代码面出现次数」为准（注释/字符串另标）。
- **主线**：入口/调用链 grep 树 + `new BrowserMiddleware`/`ctx.runEntry`/import 计数 + 公共面消费者全仓检索。
- **架构评审**：3 份独立报告（目标架构 14 条 / 迁移治理 18 条 / 红队 9 条）+ Lead 逐条裁决；评审报告为过程产物不入库，关键证据见附录 A 与 [评审记录](IMPROVEMENT_PLAN_REVIEW.md) §6。
- **行号警示**：本仓库行号锚点全部实测漂移（schema-gen 两处一天内漂移）。实施时一律用符号名定位，PR 评审不接收行号锚点新增。
