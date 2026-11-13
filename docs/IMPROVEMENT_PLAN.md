# 改进方案：配置收敛 · 分层治理 · 臃肿文件拆解

> **状态**：partially implemented（2026-11-11 批量审查实施后更新；未实施条目仍待项目方确认排期）
> **日期**：2026-11-10 提出 ｜ 2026-11-11 更新 ｜ **基线**：`main @ eec0b72`
> **来源**：架构师子代理与开发子代理两份只读分析报告的综合（src 下 100 个 .ts 全量扫描 + 函数级清单 + import 矩阵 DFS 找环）；
>
> **实施进度（2026-11-11，行为等价重构批次，基线 tag `review/baseline-pre-refactor`）**：
> - ✅ 第 0 批 ①②③④ 全部完成（L1 归位、C1 隐藏键堵漏、F1 ctx 校验面、F2 executor 外围、死代码 `deniedFrameUrl` 已删）
> - ✅ F6 extraction 拆分完成（pool-js.ts 707 行 / identity.ts 255 行搬出，extraction 2215→1289）
> - ✅ F7 datasource 拆分完成（report-view.ts / pystr 收敛，datasource 1703→1318）
> - ✅ F7 app-runner 拆分完成（app-report-view.ts / app-runner-cli.ts，app-runner 3356→2702）
> - ✅ C5 配置总表落地为 [CONFIG_REFERENCE.md](CONFIG_REFERENCE.md) + `.env.example`
> - ⬜ F3 run() 提函数 / F4 decision-setup 消重 / F5 validatePack 拆段 / C4 typed getter：未实施
> - ⬜ BACKLOG #2/#3：open
> - 本文的**行号锚点已随重构漂移失效**，实施时以符号名（函数/常量名）定位为准。
> 关键重复性论断已由 Lead 独立抽验（`pickRow` 逐字重复、决策面判断三处同构均属实）。
> **行号警示**：文中所有 `file:line` 以 eec0b72 快照为准，会随实施漂移（先例：BACKLOG #2 现状锚点 `browserSession:737` 实际已漂移到 executor.ts:1616）。实施时以 grep 重定位为准。
> **总纪律**：每步一个独立提交、`npm run check` 必过、行为等价以「dry/inspect 输出逐字节一致」为准（BACKLOG #2 硬门先例）。

---

## 0. 结论概览

| 问题 | 病根（一句话） | 对应方案 |
|---|---|---|
| 1 配置复杂不统一 | **不是没有 schema**——[config-schema.ts](../src/support/config-schema.ts) 已单源 28 键；病根是**读取点多源**（消费点各自直读 `process.env`，环境变量实际 ~40 个）、**2 个隐藏键**在 schema 外、**同一默认值 3–4 处硬编码**、**「env 不覆盖已设键」合并语义 4 处实现**、配置实为 **6 条通道**且优先级表只在文案里 | §2（C1–C5） |
| 2 文件臃肿可读性差 | **不是垃圾代码**（executor 约 31% 是设计注释），病灶是 **5 个巨型函数**（run 2496 / createCtx 1558 / runScriptApp 786 / runApp 660 / validatePack 644）+「类型区+JS 探针区+纯工具区+类体」四合一摆放 + **8 组跨文件重复** | §4（F1–F7） |
| 3 分层设计不合理 | **三个目录级环**（support↔cli、support↔engine、engine↔model）+ 一批**放错层的模块**（schema-gen、config-store、amberflow-home、prompt-views、pyJsonDumps）；但 **src 内 0 个文件级运行时环**（全量 DFS 实测）——收敛全是「搬文件」而非「改加载」，风险可控 | §3（L1–L3） |

两份分析报告的分歧与裁决（综合时已定）：

1. **run() 拆分深度**：开发侧主张提 9 个阶段函数（P0），架构侧只肯机械拆文件（run 留守）。裁决：**先拆文件（纯搬移），提函数单独成提交序列**，每阶段可部分 revert。
2. **ctx 拆分深度**：架构侧只拆类型（P1），开发侧拆 4 模块并消重（P0）。裁决：**采用开发侧方案**——校验函数群本已被 [ctx-dry.ts:21-29](../src/app/ctx-dry.ts#L21-L29) 引用，外移即消重，风险同等低、收益更高。

---

## 1. 问题诊断（证据摘要）

### 1.1 配置面

- 键白名单确实单源：[config-schema.ts:37-96](../src/support/config-schema.ts#L37-L96) `CONFIG_GROUPS` 共 28 键（6 组），`RC_GROUPS`/`CONFIG_KEYS`/`DECISION_SERVICE_KEYS`/`RUN_DEFAULT_KEYS` 均由它派生（:98-114）。
- 但环境变量面远大于 28：src 实际读取 ~40 个环境变量名。其中 22 个 `AMBERFLOW_*`（20 个在 schema 内）、5 个 `LAYA_*/LAYAA_*`、**10 个 provider 专属实验键**（BAILIAN_\*×5、TOKEN_PLAN_\*×4+DASHSCOPE_API_KEY、JEVK5_ENDPOINT）在 schema 外、**2 个隐藏键**：
  - `AMBERFLOW_SITE_FACTS_INTO_MODEL`（[app-runner.ts:2378](../src/app/app-runner.ts#L2378)）——从未进 schema；
  - `AMBERFLOW_DECISION_PROVIDER`（[app-runner.ts:1374](../src/app/app-runner.ts#L1374)、[:2356](../src/app/app-runner.ts#L2356)）——[DECISION_SERVICE_CONFIG.md](DECISION_SERVICE_CONFIG.md) 已宣布移除，但代码仍以 `=== undefined` 作守卫 → **死开关**：按旧文档设置会静默改变行为（全仓确认无 setter）。
- **6 条通道**：A CLI 旗标 ｜ B 环境变量 ｜ C 配置文件（用户 + 项目 + 旧 rc 三个文件位）｜ D 应用 meta 声明面（policy/pace/slots/sources）｜ E 桥部署注入（dsh-bridge）｜ **F（隐藏）opt-in 实验 env**（site-facts 开关 + 死开关 + provider 专属 10 键）。
- **优先级链**（实测与 config-schema.ts:134 宣称一致，但实现分散 4 处）：
  - 文件层叠 `resolveConfig`：环境变量 > 项目配置 > 用户配置 > 旧 rc（只补空键）> 内建缺省；
  - env 注入两套平行实现：CLI 入口 [main.ts:148-166](../src/cli/main.ts#L148-L166)（syncConfigEnv/restoreConfigEnv）与工具入口 [apply-config-env.ts:29-57](../src/support/apply-config-env.ts#L29-L57)；rcfile.ts:129-133 与 config-store.ts:109-115 又各手写一遍「已设键不覆盖」——**同一合并语义 4 处实现**；
  - **同一概念多层默认值**：`conf_floor` 一个概念 5 来源 4 层优先级，其中兜底 0.25 在 3 处硬编码（[app-runner.ts:1067](../src/app/app-runner.ts#L1067)、[executor.ts:2077](../src/engine/executor.ts#L2077)、[online/runner.ts:104](../src/online/runner.ts#L104)）；`AMBERFLOW_APPS_OUT` 缺省字面量 4 处；`AMBERFLOW_DECISION_TIMEOUT_MS` 缺省 "30000" 在 schema + [decision-service.ts:178](../src/model/decision-service.ts#L178)、[:240](../src/model/decision-service.ts#L240) 各写一遍。
  - 正面范本：pace 优先级（explicit > meta.pace > env > 0）在 [pace.ts:71-92](../src/support/pace.ts#L71-L92) 单源实现且逐字段标 source——配置面应对齐这一标准。
- 历史事故记录（重构必须保序的证据）：旧 rc 层叠顺序错误曾让旧 rc 压住项目配置（apply-config-env.ts:12-14 注释）；测试进程吸收本机配置导致用例漂移（rcfile.ts:120-122 / apply-config-env.ts:34-39 的 VITEST 豁免，注释记录 2026-10-20/10-28 两次事故）。

### 1.2 臃肿与可读性（函数级清单结论）

| 文件 | 行数 | 巨型函数 | 其他 |
|---|---|---|---|
| [engine/executor.ts](../src/engine/executor.ts) | 6194 | **run() 2496 行**（:3698-6193）；_executeElement 236 | 类型区 ~860 行（152-1013）+ 内嵌 JS 五段（1014-1108）+ 纯函数区 ~495 行（1109-1604）+ 会话创建（1606-1685）+ 类体；**1013 行缩进 ≥12 空格**；44 处 `if (verbose) console.log` |
| [app/app-runner.ts](../src/app/app-runner.ts) | 3317 | runScriptApp 786（:2182-2968）、runApp 660（:1171-1839）、main 313 | 四个不相关职责同居：CLI 入口 + 双 runner + 报告渲染（~270 行）+ 策略解析 |
| [app/ctx.ts](../src/app/ctx.ts) | 2655 | **createCtx 单函数 1558 行**（:1049-2610），内含 runOneStep 256 行闭包 | 校验函数群（659-1048）与 ctx-dry 共用（BACKLOG T7 确认共用有意） |
| [engine/extraction.ts](../src/engine/extraction.ts) | 2309 | 函数级最大仅 80 行 | **L618-1250 ≈630 行内嵌 JS 探针字符串**（EXTRACT_JS 单块 245 行）+ 决策 prompt 视图（ariaInteractiveLines:1821/criteriaView:1845/stateText:2279——model→engine 边的直接原因）+ host 信封（430-527） |
| [data/datasource.ts](../src/data/datasource.ts) | 1709 | validateSource 151、reportMarkdown 116 | **硬编码航班领域字段**（:1182-1202 字段表、:1592-1593 文案）违反「站点知识放配置」 |
| [app/app-pack.ts](../src/app/app-pack.ts) | 1372 | **validatePack 单函数 644 行**（:729-1372） | 其余大体合理 |

**8 组跨文件重复**（消重即收益）：

1. runApp ↔ runScriptApp 决策面准备段**逐字重复**三块：探测块（app-runner.ts:1371-1390 vs :2348-2373）、confirmFn 闭包（:1363-1366 vs :2342-2345，注释自认「语义必须与 runApp 一致」且历史上反接出过 e2e 事故）、site-facts 渲染（:1388-1390 vs :2371-2373）。
2. ctx ↔ ctx-dry ↔ ctx-replay 三实现：`pickRow` 逐字两份（ctx.ts:2640-2654 vs ctx-dry.ts:651-665）；navGate 两份；validateToolRun 同款校验逐字同文案（ctx-dry.ts:645 注释自认）；ctx.ts:1818 注释「三实现漂移，replay 必 mismatch」是已付学费。
3. 掩码契约 engine↔app 双写：executor.ts:1267-1294（redactValue/carriesSecret）vs [app/redaction.ts](../src/app/redaction.ts)；executor.ts:1281 注释自认「改掩码形状时两处同步」。
4. `sleep` 帮助函数 6 份（executor/extraction/settle/range/ctx/app-runner）。
5. 决策三键环境判断 3 份（app-runner.ts:1372-1375、2354-2357、2767-2768；Lead 已抽验）。
6. `LAYA_ONNX_MODEL ?? LAYAA_ONNX_MODEL` 兜底链 5 处两文件；[start.ts:85](../src/cli/start.ts#L85) 注释自认「同一约定」——约定靠注释不靠代码单源。
7. 「唯一可见匹配否则 target_ambiguous」契约在 run() 内两套同构实现（DRF 路径 4360-4429 vs FW8 身份回捞 4474-4530）。
8. 占位符替换 sub() 深遍历仍两处各自为政（app-runner.ts:834-852 与 ctx.ts 工具参数处理）。

**其他硬伤**：`as unknown as` 全仓 87 处（根因：PwLike/AnyPage/PageLike 鸭子类型缝无统一适配层）；`@ts-ignore` 0 处（健康）；死代码 `deniedFrameUrl`（[executor.ts:1234](../src/engine/executor.ts#L1234)，全仓零调用，BACKLOG.md:213 已挂账）；巨型类型与实现同体（RunOptions 215 行、AppRunResult 190 行、Ctx 接口 148 行）。

### 1.3 分层（import 矩阵 + 成环判定）

实测矩阵（`from "../X/"` 运行时 + 类型）：

```
app 38→engine, 8→model, 7→flow, 7→support, 6→data, 5→browser   （方向全对，体量归问题2）
cli 22→support, 29→engine, 20→model, 18→app, …                 （入口层，向下合理）
engine 6→model, 3→browser, 1→data, 1→support
model 7→engine✗, 1→flow✗, 5→support✓
support 3→engine✗, 1→cli✗          ← support 应是最底层，两条反向边
browser 2→data, 1→flow✗, 1→engine
data 1→model✗, 1→support✓
online … 1→app✗
```

**成环判定**：目录级环 3 个 + engine→browser→data→model→engine 四向链；**文件级运行时环 0 个**（全量 DFS）——全部收敛可走「纯搬文件」。

逐条定性：

- **model → engine（7 处，5 运行时 + 2 纯类型）＝真实违规**：`stateText/urlOf/criteriaView/ariaInteractiveLines` 是决策出题的 prompt 渲染器、`elemFamily` 是纯分类函数，不该住在 engine/extraction.ts；`extractElements` 进 model（[page-context.ts:12](../src/model/page-context.ts#L12)）是模型层直接跑页面扫描，是 BACKLOG #2 要拆的同一堵墙。
- **engine → model（6 处，全运行时）＝方向可接受、装配不理想**：执行循环调用决策缝是设计内；但 executor 直接 import 具体装配函数（layaProvider/getLayaRuntime/induceHint，executor.ts:104-136）而非只拿 `DecisionProvider` 端口——组合根职责漏进了唯一执行循环。
- **support → engine（schema-gen.ts:15-18）＝真实违规**：唯一消费者是 cli/commands/schema.ts:17 与 tools/prompt-hit.ts:40。
- **support ↔ cli（apply-config-env.ts:19 → config-store）＝真实环**：config-store 不依赖任何 CLI 面，下移 support 即消。
- **data → model（datasource.ts:51 pyJsonDumps ← laya-format）＝真实违规（小）**：纯序列化工具。
- **browser → flow（tool-signals.ts:23 REPO 再导出）＝多余跳一跳**：flow.ts 只是从 support/paths 转手。
- **cli→app×3 与 online→app×1 全是 `amberflow-home.ts`（纯路径助手）＝放错层**。
- **model → flow（hint-memory.ts:23 isVolatile，纯词法判定）＝可提共享**。
- **可接受（有意的构造性质，不动）**：engine→data（bindings.ts:30 selectIndex，BACKLOG T7「一份实现服务两处」）；browser→data（tool-signals.ts:22 resolve，BACKLOG T4「同一份路径解析器」）；flow→engine（方向向下）。
- **应用层内部**：app-adapters.ts:26 `import type { ToolStepResult } from "./app-runner.ts"`（adapter 向上看 runner，反向是运行时 import）+ app-pack.ts:369 再导出 `EFFECT_KEYS`——类型应下沉；另有 10 余条纯类型环（无运行时危害）。

---

## 2. 方案 A：配置面收敛（C1–C5）

| # | 批次 | 措施 | 改法 | 验证 |
|---|---|---|---|---|
| C1 | 第 0 批 | **堵漏隐藏键** | 删除 `AMBERFLOW_DECISION_PROVIDER` 死守卫（app-runner.ts:1374,2356，全仓无 setter）；`AMBERFLOW_SITE_FACTS_INTO_MODEL` 收进 config-schema 实验开关组；provider 专属 10 键加「仅文档性分组」（注明不进配置面、`amber config set` 拒绝） | `npm run check`（含配置示例一致性） |
| C2 | 第 0 批 | **默认值单源** | 导出 `DEFAULT_CONF_FLOOR=0.25` 替换 3 处硬编码；`appsOutDir` 收敛为单函数（消 4 处字面量）；`DECISION_TIMEOUT_MS` 缺省由 schema `default` 派生（decision-service.ts:178,240 合一） | 同值替换，typecheck 兜底 |
| C3 | 第 0 批 | **合并语义单源** | config-store 下移 support 后，「已设键不覆盖」的 env 注入收敛为 support 层一个函数，main.ts syncConfigEnv 与 apply-config-env 共用；**保留** VITEST 豁免与旧 rc 最低层顺序（两处事故注释是教材） | 入口抽查：`amber run` 与 `npm run apps` 对同一配置行为一致 |
| C4 | 第 1 批 | **typed getter 层** | config-schema.ts 为 28 键各出 typed getter（内含 legacy 别名处理），消费点禁裸读 `process.env`；`decisionPlaneConfigured(env)` 单源（消三处手写）；`LAYA_* ?? LAYAA_*` 兜底链单源；仓库无 lint，加 `grep process.env` 门禁脚本兜底 | doctor 输出不变；门禁脚本进 `npm run check` |
| C5 | 第 1 批 | **一张优先级总表** | 「6 通道 × 优先级」写进 docs（新 CONFIG.md 或并入 DECISION_SERVICE_CONFIG.md），以 `resolvePace` 为范本逐键对齐 | 文档评审 |

目标口径：**「28 键 × 6 通道 × 1 张优先级表 + 1 个 getter 层」**。合理例外不收编：`env_allow` 动态白名单、`{{env:NAME}}` 凭据占位符（凭据纪律设计如此）、VITEST 检测、LOCALAPPDATA/GITHUB_SHA/NO_COLOR/PATH。

## 3. 方案 B：分层收敛（L1–L3）

**目标依赖矩阵**（只向下 + 同层；禁止任何上层被下层 import）：

```
L0 support      （含下移后的 config-store、amberflow-home；只依赖 node 内建）
L1 共享语言/纯函数  signals+signal-ops、hint、click-at、surface、plan(类型)、pace、
                 pystr(原 datasource py* 与 laya-format 纯函数)、resolve/selectIndex 路径语言、
                 host-envelope
L1.5 intervention 介入/救援中断模块（src/intervention/；依赖白名单 node:* + support 两叶子
                 intervention-contract/intervention-texts——合同与文本零 import，runtime 只依赖
                 叶子；设计见 docs/INTERVENTION_RESCUE_MODULE.md）
L2 机制          browser-env、tool-signals、extraction(页面扫描/JS探针)、actions、rules、
                 settle、dataset、datasource(传输/来源)
L3 决策          model/*（provider 端口 + 协议适配 + 缓存/记忆 + prompt-views 迁入）
L4 执行          executor、planner、bindings、observe、pool-view、picker、audit
L5 应用          app/*（含 app/intervention-adapter.ts——唯一 app↔模块适配）
L6 入口          cli、online、flow(归纳)、tools、schema-gen(并入 cli 面)
```

| # | 批次 | 措施 | 消掉的边 | 风险/验收 |
|---|---|---|---|---|
| L1 | 第 0 批 | **错位模块归位（纯移动）**：support/schema-gen.ts→cli；cli/config-store.ts→support；app/amberflow-home.ts→support；pyJsonDumps→`support/pystr.ts`；tool-signals REPO 改直连 support/paths | support→engine、support↔cli 环、cli→app×3、online→app×1、data→model、browser→flow | 近零（typecheck 强制；~20 个 import 位） |
| L2 | 第 1 批 | **纯函数迁移**：`criteriaView/ariaInteractiveLines/stateText/urlOf/elemFamily`→`src/model/prompt-view.ts`（消 model→engine 5 条运行时边，剩 2 条纯类型）；`isVolatile` 提共享；`EscalatorLike` 接口（executor.ts:659）迁 model（消类型倒挂）；hosts 信封两份实现（extraction.ts:430 ↔ executor.ts:1245）合并为 `engine/host-envelope.ts` | model→engine 运行时边；同语义双实现 | 低；**信封是安全语义，必须 A/B 对照**（同 URL/hosts 输入输出一致 + dry 断言）；prompt-view 输出逐字节相同可断言 |
| L3 | 第 2 批 | **衔接既有 BACKLOG，不重复设计**：#2 候选生产上移应用层（落地后 engine→browser 与 page-context 的 extractElements 同步消失）、#3 窗口指数递增、executor 决策装配组合根化（executor 只收 `DecisionPort`，装配上移 app-runner——高风险，#2 落地后单独立项）；应用层类型下沉（ToolStepResult→run-options、EFFECT_KEYS→pack-types） | engine↔browser；adapter 向上看 runner | 高；见 §5 专项 |

## 4. 方案 C：臃肿文件拆解（F1–F7）

**总约束（迁移面）**：[index.ts](../src/index.ts) 对 executor/extraction/datasource 做 `export *`——这三个文件的一切导出是对外 API 面。拆分用 **facade re-export**（原文件变 re-export barrel，实现搬新模块），index.ts 零改动、10 个调用方零改动。其余三个胖文件只被 run.ts:12、apps-rehearsal.ts、cli/commands/apps.ts 引用，迁移面小。

| # | 批次 | 目标文件 | 拆法 | 风险/验收 |
|---|---|---|---|---|
| F1 | 第 0 批 | [ctx.ts](../src/app/ctx.ts) 2655 | `ctx-validate.ts`（L655-1048 校验函数群，**ctx-dry 改 import 即消重**）+ `ctx-tool.ts`（pickRow/toolReturns/toolFailureReason/readRows 等，消逐字重复）+ `ctx-types.ts`（Ctx/CtxDeps/StepRequest/StepResult）；`createCtx` 变 ~300 行装配体，runOneStep/navigate 升模块级（deps 显式传参） | 最低；`npm run check` + `amber apps check <id>` dry 输出 diff |
| F2 | 第 0 批 | [executor.ts](../src/engine/executor.ts) 6194 **第一波** | 外围四区纯搬移：`executor-types.ts`（L152-1012 全部类型）+ `eval-snippets.ts`（asFunction+五段内嵌 JS，1026-1099）+ `executor-pure.ts`（L1109-1604 纯函数+DEFAULT_CONFIRM；词面诊断可再聚 diagnostics）+ `session.ts`（DeviceSpec/browserSession:1616/routerMaxLoaded——**恰为 BACKLOG #2 第一搬运单元**）；顺带删死代码 `deniedFrameUrl`（BACKLOG 已授权） | 低；`npm run check` + `inspect --json` 拆分前后逐字节对比 |
| F3 | 第 1 批 | executor.ts **第二波**：run() 提函数 | 按 9 阶段切（只提私有函数不加行为）：`runSetup`(3698-3950) / `runFrameGate`(3950-4108) / `runPoolGate`(4132-4179) / `runDeclaredTargets`(4180-4430) / `runCommandSpace`(4432-4530) / `runModelPick`(4700-5350) / `runActionPhase`(5350-5750) / `runPostAction`(5750-6050) / `runReportTail`(6050-6194)；记账闭包（forbid/unforbid/stop/noteSkipped）升为 context 对象方法，零语义差；run() 内两套「唯一可见匹配」实现提共享 helper | **最高（唯一执行循环）**；每阶段独立提交、可部分 revert；`npm run check` + smoke 冒烟 + 1 个 core case trace JSON 对比；`BrowserMiddleware` 类名与 `run()` 签名逐字节不变 |
| F4 | 第 1 批 | [app-runner.ts](../src/app/app-runner.ts) 3317 | `decision-setup.ts`（**runApp↔runScriptApp 三块逐字重复**→`probeDecisionPlaneOnce`/`mountSiteFacts`/`confirmSafeFn` 三函数）+ `run-options.ts`（~500 行类型区）+ `report.ts`（appReportMarkdown/appReportHtml/summarizeDecisions/invariantsFromTrace 等）+ `tool-step.ts`（runToolStep）；`main()` 移 cli（同步改 [run.ts:407,436](../src/cli/commands/run.ts#L407) spawn 路径字符串与 tools/learn.ts:32）；`runApp`（journey 兼容脸）冻结：不删不扩 | 中低；同应用分别走 runApp 路径与 runScriptApp 路径各一次，result JSON 除时间戳外一致 |
| F5 | 第 1 批 | [app-pack.ts](../src/app/app-pack.ts) 1372 | `validatePack` 644 行拆 8 个子校验函数（按内部注释天然分段：类型/source_slots 对账/journey 图/returns 对账/占位符/device/plan 二次校验/policy）+ `pack-expand.ts`（expandStep/expandPack/resolveSourceSlots） | 低（纯加载期）；`npm run check` + `amber apps check` 全量 |
| F6 | 第 1 批 | [extraction.ts](../src/engine/extraction.ts) 2309 | `pool-js.ts`（L618-1250 全部 JS 模板+compile/PASS，630 行——**BACKLOG #2 第一搬运单元**）+ `frame-gate.ts`（host 信封族 430-527 + probeExcludedHint:1980）+ `identity-lookup.ts`（hintLookup/identityLookup 等 1938-2267） | 低；`inspect --json` 逐字节 + smoke 冒烟 |
| F7 | 第 2 批 | [datasource.ts](../src/data/datasource.ts) 1709 | 拆 `data/pylang.ts`（py\* 15 个仿真函数）+ `data/transport.ts`（curl/httpx/cli 全族）+ `data/extract-ops.ts`（resolve/applyOps/4 个提取器/日期族）+ `data/source-validate.ts`（loadSource/validateSource/runSource/main）；**航班领域字面量改配置**（`report.fields`/`report.time_field` 雏形已在 :1182），落实「站点知识放配置」 | 中；`npm run check` + 任一数据腿 case 跑一次对比 report.md |

配套小项（并入 F2/F4/H 批）：`sleep` 6 份→support 层一份；掩码契约抽 `support/mask-contract.ts`（engine 与 app 同 import）；run() 内 ≥5 处同形停因字面量提 `structuredStop(code, reason)` helper；`as unknown as` 随鸭子类型缝适配层化逐步消化（不专项突击）。

## 5. 专项：浏览器操作上移应用层（衔接 BACKLOG #2）

**结论：移，按 BACKLOG #2 移——但只移「机制」，不移「语义」；且排在 F2/F6 铺路完成之后，以 inspect --json 逐字节等价为切换开关。**

「浏览器操作」拆四类区别对待（引擎层真正摸浏览器的运行时 import 只有 executor.ts:59-61，其余触点走 `PageLike` 鸭子类型缝）：

| 类别 | 现状 | 去向 |
|---|---|---|
| ① 候选池扫描/筛选（extractElements、宽扫伪按钮、630 行 JS 探针、AX 主源、extraction.ts:1755 CDP 直连） | 引擎层，与浏览器实现绑死 | **移到应用层**（BACKLOG #2 第一项） |
| ② 会话创建（browserSession executor.ts:1616 + DeviceSpec） | 执行循环自己拉浏览器 | **移到应用层**（BACKLOG #2 点名；F2 session.ts 即第一搬运单元） |
| ③ 动作执行与闸门（locator→click/fill、inert 检查、settle、forbid 记账、风险确认、完成信号裁决） | 引擎语义本体 | **留在引擎**——绑着 stopCode/audit 语义，是「一步之内」的定义本身；移出去等于把执行循环搬空，违反「唯一执行器」硬规则 |
| ④ 完成信号语言（signals.ts，被 browser/tool-signals.ts:25 复用） | 引擎私有 | **升为共享语言层 L1**（本来就是语言不是引擎私产——engine↔browser 反向边的根源） |

移动后的契约形态（BACKLOG #2 验收 1）：引擎只消费**「已筛选、已排序的候选列表 + 每候选元数据」纯数据**，契约不含任何 Playwright 类型；executor 不再 import 浏览器扫描实现。

**为什么排第 2 批（三条硬理由）**：

1. **逐字节等价是硬门**（BACKLOG.md:92-93）：候选列表、ref 编号、宽扫触发点必须不变，验收工具是 `inspect --json` 快照对比；必须先做 F2/F6 把搬运单元干净分离，等价对比才有基准。
2. **它同时动两个最敏感面**：唯一执行循环 + 决策状态视图（criteriaView/stateText 正是 model→engine 边的直接原因）；一次做太大，回退粒度就没有了。
3. **依赖顺序**：`F2 session.ts → F6 pool-js/frame-gate/identity-lookup → L2 prompt-views → #2 本体`（定义契约 → 搬扫描驱动 → executor 改消费契约 → inspect 逐字节验收 → 再动 executor）。

**两个超出 #2 原文的增量判断**：

1. **inspect 命令是契约的第一验收方**：[cli/commands/inspect.ts](../src/cli/commands/inspect.ts) 也是 extraction 的消费者（BACKLOG 涉及文件已列）。#2 落地时先让 inspect 走新契约跑逐字节对比，绿了再动 executor——风险最大的消费方最后切换。
2. **池预算常量随扫描一起上移，顺手为 #3 铺路**：`MAX_ELEMENTS=40`（extraction.ts:568）、`WIDE_POOL_ELEMENTS=120`（:573）归应用层后，正好是 #3「窗口指数递增 + 硬顶可配」的配置化输入——**#2 与 #3 共享同一次搬运，不要分两次搬同一批代码**。

## 6. 统一实施路线图

```
第 0 批（零行为变更，每步独立提交，全部可单独 revert）
  ① L1 错位模块归位（4 件套纯移动）            验收：npm run check
  ② C1 隐藏键堵漏 + C2/C3 默认值与合并语义单源   验收：npm run check + doctor
  ③ F1 ctx 校验面外移消重                     验收：apps check dry 输出 diff
  ④ F2 executor 外围四区 + 删死代码            验收：inspect --json 逐字节
第 1 批（P1，等价验收先行）
  ⑤ L2 prompt-views 迁移 + 信封合并（A/B 对照）
  ⑥ F3 run() 提函数（每阶段一提交）             验收：smoke 冒烟 + core case trace 对比
  ⑦ F4 decision-setup 消重 + app-runner 拆分
  ⑧ F5 validatePack 拆段 + F6 extraction 拆分
  ⑨ C4 typed getter + process.env 门禁 + C5 总表文档
第 2 批（P2，衔接既有排期）
  ⑩ BACKLOG #2（候选契约先行，本方案 F2/F6/L2 已为其铺路）→ #3
  ⑪ F7 datasource 拆分 + 航班字面量配置化
  ⑫ executor 装配组合根化（#2 落地后单独立项）
  ⑬ LAYAA_* legacy 删除（兼容窗口结束后）
```

第 0 批四项相互独立，可并行分支；①②属「分层/配置」线，③④属「拆文件」线，两线互不触碰对方文件。

## 7. 验证矩阵（仓库无单元测试，重构靠这些兜底）

| 变更类型 | 验证手段 | 等价口径 |
|---|---|---|
| 一切提交 | `npm run check`（typecheck + 配置示例一致性 + test:validate，PR 门禁，不访问外网） | 必过 |
| ctx/pack 拆分 | `amber apps check <id>` / `apps explain` dry 输出 diff | dry 输出逐字节一致 |
| extraction/信封/pool 迁移 | `amber inspect --url <URL> --json` 拆分前后对比 | JSON 逐字节一致 |
| run() 提函数 | `npm run test -- --tier smoke` 冒烟；1 个 core case 的 trace JSON 对比 | trace 除时间戳外一致 |
| decision-setup 消重 | 同一应用分别走 runApp（声明式/`npm start --`）与 runScriptApp（`amber run <id>`）路径 | result JSON 除时间戳外一致 |
| 配置层叠 | doctor 输出 + `amber run` vs `npm run apps` 入口抽查 | 行为一致 |
| 数据腿 | 任一数据腿 case 对比 report.md | 除运行时间戳外一致 |
| 配置纪律 | `grep process.env` 门禁脚本（新增，进 check） | app/model 层零新增裸读 |

## 8. 禁区（与硬规则冲突，双方一致确认不动）

1. **不另写执行器**：`BrowserMiddleware.run` 是唯一执行循环（AGENTS.md 硬规则；ARCHITECTURE.md §1）。executor.ts 的一切拆分只能是**同门面文件级机械拆分**；不得为 apps/online/bridge/plan 复制第二个 run 循环。
2. **完成只认信号**：`checkSignal` 是完成与 when 的唯一裁决；拆分不得让模型票、报告渲染或配置层参与判定。
3. **不引入 ajv/zod**（BACKLOG 依赖评审 T7 结论）；**不拆两份路径解析器**：resolve()/selectIndex 数据腿与工具信号必须同一实现（T4 结论）——迁移只是搬位置。
4. **不动 meta 唯一声明面与 flow 唯一作者模型**；journey 声明式脸是 learn/录制回放的既有兼容面——不删、不再生长。
5. **配置纪律**：新键只进 config-schema.ts；示例仍由 tools/config-example.ts 生成、`npm run check` 校验漂移；`--provider` 不进配置面；OPENAI_\* 只保留 LLMAuditor 一个消费者（BACKLOG #1 落地记录）。
6. **VITEST 测试配置豁免不删**；**旧 rc 最低层顺序不可变**（apply-config-env.ts:12-14 记录的实测 bug）。
7. **危险步确认链语义不动**：confirmSafe 默认拒绝方向、DESTRUCTIVE_PATTERNS、`--confirm-unsafe` 显式放行；重构只搬位置。
8. **凭据纪律**：0600 落盘、maskValue 唯一掩码入口、`--slot-file` 建议全部保持；配置统一不得引入明文凭据新通道。
9. **逐字节等价硬门**适用于所有候选/视图/信封/配置层叠迁移——任何顺序变化都属行为变更，必须带对照证据而非「看着一样」。

## 9. 与既有 BACKLOG 的关系

- BACKLOG #1（决策入口统一）已 done——本方案不重复。
- BACKLOG #2（候选生产上移应用层）/ #3（窗口指数递增）open——本方案 F2（session.ts）、F6（pool-js/frame-gate/identity-lookup）、L2（prompt-views）是它们的**铺路工程**；§5 是衔接说明。#2 的验收标准原文有效，本方案不改其接口设计。
- BACKLOG P2 遗留清单中的「deniedFrameUrl 死代码移除」由本方案 F2 顺带完成；「deniedFrameUrl 死代码移除」外的 P2 项不受本方案影响。
- 本方案确认后，建议按条目拆入 BACKLOG.md 登记（每条含现状锚点/验收标准，遵循该文件格式），本文件退化为设计与裁决记录。

---

**预期收益**：配置面收敛到「28 键 × 6 通道 × 1 张优先级表 + 1 个 getter 层」；分层消掉 3 个目录级环与 12 条错位边，达到 7 层只向下；最大单文件 6194 → ~3500 行（第二波后 run() 主循环再减半），5 个巨型函数全部降至 <300 行，8 组重复逻辑消到单源——全程不改对外 API、不破任何硬规则。
