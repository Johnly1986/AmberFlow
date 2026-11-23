# 决策平面统一与决策上文优化（ADR-001）

> 状态：**已裁决（2026-11-23）；P0 实施中**。决策依据：代码走读（`decision-ask.ts` /
> `decision-pick-phase.ts` / `pilot-ask-adapter.ts` / `system-one-client.ts` /
> `decision-ask-contract.ts`）+ 本地 mock SystemOne 抓包（12 条真实请求体，证据在仓库外）。
> 本文件是「决策入口统一 + 上下文分层」的裁决与实施台账；DC 契约条款本身见
> `docs/DECISION_CONTEXT_CONTRACT.md`。

## 1 问题（实测）

1. **两套编排**：pilot 经 `DecisionAsk`（窄问→floor→宽扫→弃权）；run 经 `runDecisionPick`
   （8 分支：规则→窄问→宽扫→窗口升级→升级票→裁决→R2b→族修复）。底层 `provider.pick` 同一份，
   编排/账本/上下文各自为政。
2. **wire 上下文只有 L0+L1**：抓包 body 656–1522B；L2 结构化/L3/L4/溯源裁剪均未上线。
3. **L2 被适配器丢弃**：`system-one-client.buildChoiceBody` 原来只在 `notes` 含 `site_facts`
   键时挂 `state.notes`，普通「已试 N 次 · outcome」负面证据不上 wire。
4. **run 面比 pilot 面饥饿**：pilot 的 goal 带 `当前页`+`已执行`；run 的 goal 是裸 instruction。
5. **L1 取文范围**：`firstOf("main, body")` 在 DOM 顺序上先命中 `body`（body 是 main 的祖先），
   主文档 body 已含侧栏/主区文本，但 **iframe 子帧内容不在父 body innerText**；Google Maps 详情实测
   main_text 100 字、候选 15 个全 chrome，详情侧栏/评论入口不可见（面板可能在子帧/未加载）。

## 2 方案与取舍

| 方案 | 内容 | 判定 |
|---|---|---|
| **A（采纳）** | 分层渐进统一：先修上下文请求层，再把 run 阶梯按契约迁入 `DecisionAsk`，期间保留 phase 对照臂 | ✅ |
| B | 一次性把 `runDecisionPick` 整体重写进 `DecisionAsk` | ❌ 8 分支语义有 golden/characterization 钉住，回归面不可控 |
| C | 只修上下文、维持双入口 | ❌ 与契约「阶梯必须是单次询问内部实现」长期背离 |
| D | pilot 反向调用 `runDecisionPick` | ❌ 把 executor host/PickAcc/窗口链耦合进驾驶面 |

## 3 裁决

- **R1（方向）**：`DecisionAsk` 为引擎侧唯一决策询问入口（pick 先统一，risk/done 后续并入）；
  `decision-pick-phase` 在 P2 完成前保留为对照臂，不得提前删。
- **R2（上下文优先级）**：先修「已算未传/取错范围」——notes 通用上 wire；L1 取文范围（`wide`
  子帧 opt-in）；`state_digest` 统一开关（默认仍 off）；再接 L4 site-facts；L3 随 run 侧 RunScope 接入。
- **R3（L0 统一）**：共享请求构造；run 面补齐「当前页/已执行」在 P1。
- **R4（节奏）**：P2 迁宽扫/窗口升级/升级票；P3 迁裁决/R2b/族修复；phase 对照臂等价后标
  deprecated 一版再删。
- **R5（规则边界）**：步前规则/导航/affordance 留在面；询问内部只保留「规则命中不花模型」的
  rules prelude。契约 v6 登记。
- **R6（risk/done）**：P3 纳入同一入口的 question kind；此前 `isRisky`/`doneVote` 直调属过渡态。
- **R7（门禁）**：契约 v6（形状变更=seam 变更，先改 MAINLINE）；新增非门禁
  `verify:decision-context`（mock 抓包镜像：同 fixture 同步两面请求体逐层对照）；P2 起逐 rung
  A/B（characterization/golden）；`npm run check` / `verify:pilot` / `verify:parity` /
  `verify:runtime:offline` 全绿。
- **R8（不做）**：不改 provider wire 协议（只加不改）；不新开 CLI 命令；不重写 L1 布局层；
  P0 不改任何默认行为；site-facts 不写进引擎（只经端口）。

## 4 实施台账

### P0（进行中）

| 项 | 文件 | 状态 |
|---|---|---|
| 决策请求构造单点（`buildChoiceRequest` / `mergeSiteFactsNotes` / `hasSiteFactsNotes`） | `src/engine/decision-request.ts` | 已落地 |
| executor 改用单点构造（行为逐字节不变） | `src/engine/executor.ts` | 已落地 |
| notes 通用上 wire（空 notes 形状不变） | `src/model/system-one-client.ts` | 已落地 |
| `DecisionAsk` 消费 `ports.siteFacts` + L4 回执按 site_facts 记账 | `src/engine/decision-ask.ts` | 已落地 |
| pilot 面组合根注入 L4 端口（按 hosts 匹配，无命中 = null） | `src/app/pilot-ask-adapter.ts` | 已落地 |
| L1 取文范围 `AMBERFLOW_STATE_TEXT_SCOPE=wide`（默认逐字节不变；wide = 追加未 detach **子帧** body 文本；`stateText`/`pageText` 搬移到独立模块） | `src/engine/state-text.ts` / `src/engine/extraction.ts` | 已落地 |
| 决策上下文镜像 lane（A notes 上 wire / B 无 notes 形状 / C siteFacts→L4 / D L1 两面一致 / E wide 子帧取文） | `tools/verify-decision-context.ts` + `verify:decision-context` | 已落地（70 项断言全绿） |

**P0 不变式**：`notes` 为空 → 请求体与既有逐字节一致；`state_digest` 默认仍 off；L1 默认取文不变；
非 attach 路径的行为/输出不变（由既有 lanes 钉住）。

### P1（已落地）

| 项 | 文件 | 状态 |
|---|---|---|
| L0 渲染单源（`drivingGoalText` 迁引擎，pilot re-export） | `src/engine/decision-goal-text.ts`（新）、`src/app/pilot-contract.ts` | 已落地 |
| run 面模型询问 L0 = instruction + 当前页 + 已执行（history 由 trace 已执行行折成；规则/词面判据仍用原 instruction） | `src/engine/decision-pick-phase.ts` | 已落地 |
| run 面 attempt 账本（`createRunDecisionAccounting`）+ 禁选经 `forbiddenRefs` 单源消费 | `src/engine/decision-accounting.ts`、`src/engine/executor.ts`、`decision-pick-host.ts` | 已落地（notes 仍走执行器 rank 注记，P2 统一） |
| `context.layers` 回执单点 `contextLayerReceipts`；run 面逐层回执挂 trace `context_layers` | `src/engine/decision-ask.ts`、`src/engine/decision-context-evidence.ts`（新） | 已落地 |
| 镜像 lane：D 组改为「两面 L0 文本同源」；新增 F 组（直接 mw.run：五层闭集、L0/L1 sent） | `tools/verify-decision-context.ts` | 已落地（76 项断言全绿） |

**P1 不变式**：规则匹配/词面判据/升级建议仍用原 `instruction`（渲染不混入语义面）；
无模型询问/无动作的步不产生回执行；请求体仅 L0 文本变化（L1 池/正文、L2 注记口径不变）。

### P2（已落地）

| 项 | 文件 | 状态 |
|---|---|---|
| 低置信恢复阶梯（宽扫 → 窗口递增 → 升级票）迁入 `DecisionAsk`：`runRecoveryLadder` 为唯一编排点，`runWideReobserve`/`runEscalatedPick`/`askPick`/`askGoalOf`/`forbiddenOf` 单源 | `src/engine/decision-ask.ts` | 已落地 |
| phase 只调 `runRecoveryLadder`（规则/闸门前置/停因/裁决/R2b/族修复编排仍在 phase，P3 迁） | `src/engine/decision-pick-phase.ts`（584→476 行） | 已落地 |
| A/B 等价：`verify:decision-characterization` 11 金标（含 `run-wide-reobserve`/`run-escalate`）在纯搬移后逐项一致；pilot/parity/runtime-offline/decision-context 全绿 | `tools/verify-decision-characterization.ts` | 已验证 |

**P2 边界**：rung 实现与顺序归 `DecisionAsk`；phase 保留「何时进入恢复」的前置判据与
`adjudicate`/R2b/族修复编排（P3 迁）。行为等价由金标 + 既有 lanes 钉住，请求体/停因/候选事实不变。

### P3（选择段已完成）

| 项 | 文件 | 状态 |
|---|---|---|
| 统一编排入口：规则/窄问/闸门（恢复阶梯）/裁决/R2b/族修复/组装 单源 | `src/engine/decision-pick-unified.ts`（新，382 行） | 已落地 |
| 对照臂：旧编排保留，`AMBERFLOW_DECISION_LADDER=phase` 切换（一版后退役） | `src/engine/decision-pick-phase.ts`（152 行） | 已落地 |
| 执行臂分派：默认统一入口，executor 只调 `runPickPhase` | `src/engine/decision-pick-arm.ts`（新，20 行）、`executor.ts` | 已落地 |
| A/B 等价：`verify:decision-characterization` **默认/对照臂双跑均 11/11 金标一致**；pilot 16/16、parity、runtime-offline 8/8、decision-context 76 项、`npm run check` 全绿 | lanes | 已验证 |

**P3 未纳入（后续批）**：`risk`/`done` 询问的 question-kind 统一、`DecisionAsk` 契约 v6 与
MAINLINE seam 表登记（拿去跟 pick 平面分开评审，避免一次改 seam 面过大）。

### P3b（已落地）

| 项 | 文件 | 状态 |
|---|---|---|
| 契约 v6：`DECISION_ASK_CONTRACT_VERSION` 5→6；question kind 闭集（pick/risk/done） | `src/engine/decision-ask-contract.ts` | 已落地 |
| risk/done provider 直调收口为访问面（capability 判断在入口、异常归调用方 catch，降级语义不变） | `src/engine/decision-questions.ts`（新）、`executor.ts` | 已落地 |
| MAINLINE seam 表登记 v6：run 默认统一编排、phase 为 A/B 对照臂、question kind 闭集 | `docs/MAINLINE.md` | 已落地 |
| 验证 | lanes + `online/` 用例测试 | 进行中 |

### P3b 验证

| 项 | 结果 |
|---|---|
| 决策平面门禁 | `npm run check` 全绿；pilot 16/16、parity、runtime-offline 8/8、characterization **默认/对照臂双跑 11/11**、decision-context 76 项 |
| 线上 smoke（7 用例） | **7 passed / 0 failed / 0 skipped**（6.8s，证据 `/tmp/af-online-smoke`） |
| 线上 core（11 用例） | 10 passed / 1 failed：`wiki-en-search` 需模型 pick，但本机决策源返回 **403 AccessDenied.Unpurchased**（环境凭据/权益，非代码回归）→ 规则面兜底停因；证据 `/tmp/af-online-core` |

> 若要让 core 11/11：修本机 `AMBERFLOW_DECISION_*` 权益（或经 DSH 桥的部署配置运行）。
> 本 ADR 不把环境性 403 视为决策平面回归。

### P3（待 P2 等价）

裁决/R2b/族修复迁入；`decision-pick-phase` 退役为对照臂；risk/done 纳入同一入口。

### 证据覆盖与金标换基（审计第 1 项）

决策上下文审计发现两处**证据缺口**；本批只补 lane/金标/登记，零行为代码改动：

- **run-parity golden 未随 P1 换基**：`tools/verify-decision-run-parity.ts --check` 在 P1 后
  **11/16 场景失绿**，差异全部是 `$.asks[<i>].goal`（run 面 L0 尾部追加「| 当前页: <url>」，
  R3 的预期变更）。该 lane 的 `--record` 按设计永久拒绝（golden 只由退役前对照臂录制，防被检
  实现自证），所以 golden 停留在 P1 前的事实。
- **L0 改写无 lane 钉住**：characterization 11 条金标里，3 条直调 `pickProposal` 的 `goal` 只是
  调用参数；另 8 条 run/pilot 场景投影不含 goal，因此 run 面 L0（当前页 + 已执行历史折叠）
  **没有可比事实**钉住。

处置（两类 lane 均保留原纪律）：

| 缺口 | 处置 | 证据 |
|---|---|---|
| run-parity golden | 新增 `--rebase-reviewed`：逐场景算差异路径，**仅当所有差异落在允许闭集 `$.asks[<i>].goal`** 才写新 golden；顶层写 `_rebase` provenance（原因 / 允许路径闭集 / 换基场景；不写日期戳）。任一非 goal 差异（含缺失/新增场景）→ 打印并拒绝、golden 逐字节不变；`--record` 仍拒（防自证保留） | 换基 11 场景，`--check` **16/16 绿**；负向自测：临时副本改 `adjudicate.phase.conf` → 拒绝（exit 1）且 sha256 不变；`--self-test` 覆盖「正例写入 / 非 goal 拒绝 / 缺场景拒绝 / 拒绝零改写」四路 |
| characterization 投影 | 8 条 run/pilot 场景投影新增 `goals`（桩侧请求 goal 序列，按询问顺序）；新增 `run-two-step-history`（同一次 run 两步）钉住 `已执行: 1.<desc>[no_change]` 折叠 | 金标 11→12 场景；`--record` 两次 sha256 一致、`--check` 两次一致且绿 |

**仍未被 lane 钉住的维度（如实登记，不在本批范围）**：① 请求 wire 的 L3 plan narrative / L4
site-facts 只有镜像 lane 的请求体断言，未进 characterization golden；② pilot 面的「已执行」
历史折叠（pilot 两步动作场景未纳入 characterization，当前只钉 run 面）；③ risk/done
question-kind 的 L0 形状。

**门禁升级（审计第 1 项）**：run-parity lane 已纳入 `npm run check`（`verify:decision-run-parity`，
`check:ci` 自然继承）。代价：PR 门禁不再是纯离线——跑 check 的机器必须有 chromium
（`npx playwright install chromium`；CI 的 check job 已同批补装，见 `.github/workflows/checks.yml`）；本机实测该 lane 单跑 ≈11.9s，
`npm run check` 总时长 71.3s → 80.0s（同一工作树、同机连跑；增量 ≈8.7s，浏览器启动/机器负载波动同量级）。豁免/理由：该 lane 是 P1 换基后
唯一能钉住 run 面 `ModelPickPhase` + 桩请求 + `windowChainFacts` + 停因的事实层，靠人工跑会漏；
门禁化不降低换基纪律——golden 仍只走 `--rebase-reviewed` 评审，`--record` 仍拒绝。chromium
缺失属环境错误：lane 入口打印修复提示并 exit 2，不 self-skip（门禁不假绿）。

## 5 验收

- P0：镜像 lane 断言「notes 上 wire / 无 notes 形状不变 / siteFacts 端口 → L4 sent / L1 两面一致 /
  wide 子帧取文 opt-in」；`npm run check`、`verify:pilot` 16/16、`verify:parity`、`verify:runtime:offline`、
  `verify:decision-characterization` 全绿。
- P1/P2/P3：各自阶段退出标准见裁决 R7；P2 起必须附 A/B 证据。

## 6 不做清单

见 R8；额外：不在本 ADR 内改 provider 协议字段语义、不新增面、不改 done/risk 裁决权。
