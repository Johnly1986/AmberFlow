# 方案提案：模型驾驶走查（决策模型主控 · Agent 兜底）

> **状态**：partial（PW1+PW2 主体落地——2026-11-20 修正批收口 finish 信号验证、低置信
> reobserve、四件套证据、redirect 清段、终态可读性与 CLI 边界；PW3 仅 `pilot export` 落地，
> 桥面工具 / `--driver` 消融 / §3.2-§3.3 验收矩阵属后续批次。见 §7 落地索引与 CHANGELOG）
> **日期**：2026-11-19 ｜ **来源**：项目方提出——走查阶段由决策模型控制接管走查流程，Agent 做兜底。
> 阅读前提：`docs/APP_SCRIPT_AUTHORING.md` §0.5（走查先行与三工具）、`docs/INTERACTIVE_SESSION.md`
> （session 面与「零模型」纪律）、`docs/RUN_TAKEOVER_AND_DOM_CONTEXT_PLAN.md`（接管先例与四件套）、
> `AGENTS.md`（硬规则）。锚点一律用符号名，不用行号。

## 0. 结论概览

| # | 问题 | 一句话诊断 | 方案 |
|---|---|---|---|
| 1 | 走查阶段能不能让决策模型控制流程 | 走查三工具（探针链 / plan 草稿 / walk 模式）全部由 Agent/人**逐行驾驶**；决策模型只在 run 面投票，走查面零参与 | 新增第四种走查工具 `amber pilot`：决策模型**逐步驾驶**（每轮一次闭集 pick → 引擎执行 → 信号推进），复用 run 面已验证的「模型选元素、引擎执行」闭环 |
| 2 | Agent 兜底怎么落 | 兜底不是新能力：停因结构化、现场证据、stdin JSONL 协议、idle 超时四个零件全部已有先例 | 驾驶停止条件 = **确定性停因闭集**（低置信/歧义/缺值/连续 inert/预算），停止即交接 Agent；Agent 经**兜底指令闭集**（resume/redirect/finish/abort + 观察类指令）接管现场 |
| 3 | 模型权力边界在哪 | 「模型只投票、不生成动作；完成只认信号」是既有红线，走查面不得例外 | 驾驶问句是池内闭集 pick（与 run 面 `ChoiceRequest` 同一契约）；动作类型走 affordance 规则；最终信号由发起方声明、引擎 `checkSignal` 验证；模型 doneVote 不进 pilot 面 |

**成本主张**（实测数据引自 `docs/SESSION_TAX_REDUCTION_PLAN.md` 的盲测复盘）：Agent 驾驶一次侦察
135 次操作、64 次 observe、17 分钟自收敛；驾驶者的多轮 observe→判断→act 回返是税的主体。
模型驾驶把「多轮观察推理」压缩成「一次前向 pick + 一次 act」，预期操作数显著下降——
**估算以消融实测为准，本文不预设倍数**。

---

## 1. 现状诊断

### 1.1 走查工具全是 Agent/人驾驶

- 探针链：每步一个微型应用，Agent 逐枚编写、逐枚运行；
- plan 面草稿：`plan add` 逐步点名，仍是 Agent 写目标；
- walk 模式（A6）：`amber run --walk` 单会话串流程，但步序来自**已写好的 flow 脚本**——
  走查时流程已经写完，模型驾驶无从谈起；
- `amber session`：Agent 经桥逐行喂请求，是最典型的「Agent 驾驶」面。

### 1.2 决策模型的既有权力面已经足够

run 面的**决策语句步**（`ctx.step(goal, { done })`，无 `act`）早已闭环证明：

> 抽池 → 规则先行 → 模型 `pick`（`ChoiceRequest`，闭集 ref）→ 置信闸门（floor + reobserve
> 一次更宽）→ affordance 定动作类型 → 执行 → inert 检查 → 信号验证。

装配链齐全：`resolveProviderSpec` / `applySpecToRuntime`（app-runner 同款三件套解析）→
`buildMiddleware`（`middleware-factory.ts` 唯一构造点）→ `assembleDecisionRuntime`
（`decision-seam.ts` 三档：显式 provider / laya / rules-only 如实降级）。

**缺的不是能力，是「驾驶循环 + 兜底交接协议」这一层编排。**

### 1.3 兜底机制的既有形状

- **确定性触发纪律**（`docs/INTERVENTION_RESCUE_MODULE.md` §1）：介入由确定性声明触发，
  模型永不发起中断——pilot 兜底完全继承这条（见 §5 红线）。
- **交接协议先例**：`SessionRuntime.handleLine` 的 stdin 每行一条 JSON 请求 + idle 超时
  （`SESSION_IDLE_TIMEOUT_MS`）+ 非结构化即单行失败——pilot 的兜底回路直接照这套协议形态。
- **现场证据先例**：RUN_TAKEOVER T1 的失败现场四件套（截图/DOM/池快照/observe 明细）——
  pilot 的停因交接现场是同一份零件。
- **驾驶步的信号归纳素材**：`src/flow/signal-induction.ts` 从演示 before/after 归纳候选信号
  （learn 路径）；pilot 驾驶步天然采集每步 before/after，export 时可复用同一归纳器。

---

## 2. 方案（PW1–PW3 分层递进，价值验证驱动）

### PW1：驾驶交接契约与现场证据（零行为变更，可与 RUN_TAKEOVER T1 合批）

1. **停因交接面定型**（纯类型 + 文案，无行为）：pilot 停止时向 Agent 投影的结构化交接块
   `{ stop_code, step_id?, goal_digest, why_stuck: { summary ≤400 字, evidence ≤2KB },
   what_would_unblock: ≤3 条 }`——**借 intervention 合同的证据形状，不接 rescue 通道**
   （pilot 兜底是驾驶控制协议，不是求人救援；`RescueChannel` 的五态 Outcome 对控制指令无意义）。
2. **现场四件套**：截图 / DOM / 池快照（含 hint_candidates）/ observe 明细——与
   RUN_TAKEOVER T1 同一份实现，共享落盘代码，不重复造。
3. 桥面只读透传（有界投影），本期不接驾驶指令。

验收：交接块字段冻结；四件套内容与停驶页一致；缺省路径产物逐字节不变。

### PW2：pilot 最小驾驶循环（MVP；CLI 入口已移除）

> 2026-11-23 起 `amber pilot` CLI 已移除。等价入口：`amber session` 的
> `drive`/`driveCommand`/`driveStatus`/`driveClose` 请求（同一 session 子进程/同一 page；
> 详见 `docs/AGENT_INTERFACE.md` §3.3）。下列装配/驾驶循环描述保留为协议设计记录。

**装配**（全走既有缝，不新写决策面）：

- `buildMiddleware({ face: "pilot", confirmPolicy: { kind: "default-deny" }, … })`——
  新 face 登记 `middleware-factory.ts` 的 `FACE_POLICY`（与 session 同档：破坏性动作默认拒绝）
  + `docs/MAINLINE.md` 装配表与 seam 冻结表各加一行；
- provider 解析复用 `resolveProviderSpec` / `applySpecToRuntime`（桥跑与 CLI 直跑同
  RUN_TAKEOVER §3.1 的双通道口径）；无决策源时**如实 rules-only**（`decision-seam.ts`
  既有三档），驾驶步需要选点即停 `no_model_runtime`，不装一个每步都抛的 runtime。

**驾驶循环**（每轮，全部组合既有原语——照 `session-runtime.ts` 复用 `actOnce` 的先例，
不另写执行器）：

1. settle + 抽池（与 run 同一抽池面）；
2. 规则先行（导航/affordance），规则档命中就不花模型（与 run 同序）；
3. 未命中 → `decision.pick`：`ChoiceRequest` 的 `goal` = 总目标 + **有界步史摘要**
   （L2 运行史，≤N 步、逐层有界——即 `docs/DECISION_CONTEXT_CONTRACT.md` Phase 1 执行期
   L2 直通的第三个消费者，溯源标签 `kind:"trace"` 直接可用）；
4. 置信闸门：floor（`--conf-floor` / provider 自报 / 0.25 既有优先级）+ reobserve
   一次更宽（`RunOptions.reobserve` 同纪律）；
5. `actOnce` 执行；inert 记账（`maxEffectiveRepeats` 同参数可用）；
6. `checkSignal(finalSignal)`——成立即停 `final_signal_held`；缺最终信号声明时以
   「预算内持续推进、连续 inert 即停」收尾（诚实，不发明完成）。

**停因闭集**（9 码）：`low_confidence` / `target_ambiguous` / `needs_value` / 连续 inert
（复用 anti-repeat 证据）/ `no_model_runtime` / `off_task_page`（`--expect-url` 的页面漂移
确定性守卫——当前 URL 不含声明子串即停，不在漂移页上继续抽池/问模型）/ `budget_exceeded`
（`--max-steps` 与 run 同名同义）/ `final_signal_held` / `browser_dead`。

终态语义（session 托管面，单源 `src/app/session-driver.ts`）：driver 到达
`final_signal_held` / `budget_exceeded` / `aborted` / `browser_dead` 后**不可续驾驶**——
终态后的 `drive` 回 `drive_terminal`（已 `drive_close` 则 `drive_closed`）；终态后的
`drive_command{cmd:"resume"|"redirect"}` 回 `drive_terminal`（预算终态保留
`budget_exhausted` 专属码），均带顶层 `reason` + `stop_code`；`next` = 起新 session
（预算终态同时增大 `max_steps`）。`finish`/`abort` 在终态保持幂等收尾；单行拒绝
（如 `signal_not_held`）同样把 `reason` 提升到顶层。参数形状错 = `config_error`（带
`reason`，不消费会话）。**交接不是终态**：停在 `handoff_open` 时 session 的 `act/observe` 仍可用；
再次 `drive` 不得静默续驾驶（那会重放同一交接、把新 goal 悄悄丢掉）——回执为显式
`code:"handoff_open"` + `handoff_open` 回显 + `goal_ignored?` + `next`（继续用
`driveCommand`，换目标起新 session）。

**结束态责任边界（evidence-only，不改引擎裁决）**：单步 `ok/changed` 只说明这一步执行成功，
**不等于任务成功**——"把 Rating 4.5+ 改成 4.0"、"Open now 之外又点 Open 24 hours"这类回退，
页面事实本身合法，引擎在没有声明时无从知道期望态，因此**不做每步 after-state 守卫/自动回滚**
（会越出"模型只投票"面，且把合法页面变化误报成错误）。责任边界：
- 调用方要"结束态可验证"，就在 `drive` 声明 `final_signal`（`checkSignal` 每轮判 + finish 再验）；
  声明了信号却没成立 = 确定性停因/交接，不会被当成"做完了"。
- 没有声明信号时，handoff 带 `final_signal:null`（结束态**未被验证**的显式 fact）+ 顶层
  `weak_picks`（只收 model 票且 `conf < 0.25` 的票面事实，≤6）与 `pilot_end.conf_floor`
  （本次有效闸门刻度）——让"为什么回退"可解释，但**不**阻断、不改正、不新增停因。
- 长任务用 `expect_url` / 分段 `final_signal` 做检查点；任务成功与否仍由调用方裁决。

**Agent 兜底指令闭集**（stdin JSONL，新请求类型；观察类指令复用 session 请求面）：

| 指令 | 形状 | 语义 |
|---|---|---|
| `resume` | `{ hint?, value?, target?, skip? }` | 修正后从当前现场继续驾驶；hint 进本轮解析链（`hintMatch` 唯一命中即确定性执行，不花模型），落空 = 下次交接 evidence 带 `resume_hint.missed`；值进本轮袋（值来自 Agent = 显式给定，红线②不破）——对象 = 多槽 k:v；字符串 = 单值，键序 `target` → 交接 `needs_value.key` → `resumed`，带 hint 时值跟命中目标走。`needs_value` 交接的 `why_stuck.evidence` 带 `needs_value:{target,key,ref}`（只带键/目标/ref，**不带值**）与可照抄的 `resume 带 value：{"<key>":"<值>"}` 解锁建议 |
| `redirect` | `{ goal, url? }` | 改道：换目标/换入口；步史清段重新累计 |
| `finish` | `{ signal }` | 声明最终信号；引擎 `checkSignal` 验证，成立才记 held——**产物仍标 `pilot:true`，不冒充 run 结论**（仿 `walk:true` 先例） |
| `abort` | `{}` | 终止，落已走轨迹 |

- 无人兜底：idle 超时收进程（session 既有语义）；非 TTY 无 `--input` 时停驶即退出
  （对齐「非 TTY 不假装有人」）。
- 危险动作：default-deny；**Agent 在 pilot 会话里同样不能确认危险动作**（对齐
  RUN_TAKEOVER §1.5 红线）。
- 产物：驾驶轨迹 JSONL（驾驶步 + 每次交接 + 每条兜底指令 + PW1 现场引用）+ 结束摘要
  （步数 / 模型咨询数 / 缓存命中 / 兜底次数 / 最终信号 held 与否）。

### PW3：闭环——轨迹导出 + 桥面 + 消融对比

1. `amber session export`：会话 `--record` 轨迹 → `app.mjs` flow 骨架（衔接 `session-export.ts` 先例：
   只出骨架；驾驶步的 before/after 可喂 `signal-induction.ts` 归纳候选 done——归纳结果
   是**候选**，落盘前照 learn 纪律复现验证，没把握返回 manual 而不是猜）。
2. ~~桥面 `amberflow_pilot`~~（已被替代）：agent 侧驾驶经 `amberflow_session` 的
   `drive/drive_command/drive_status/drive_close` op（同一 session 子进程/同一 page）；原
   one-shot 工具因独立会话无登录态已移除。
3. 消融对比：`--driver agent|model` 同一走查任务双臂（消融臂 `--ablate` 先例），产出
   操作数 / 模型咨询数 / 墙钟 / 到达率实测报告——**作为 PW2→PW3 的价值验证门**。

---

## 3. 验收标准

1. **PW1**：停因交接块字段冻结；四件套与停驶页一致；缺省路径产物逐字节不变。
2. **PW2**：fixtures 静态页 + 真站 core 一条——① model 驾驶在声明预算内到达最终信号
   （每轮一次模型咨询，规则档命中不计）；② 每类停因（含 `off_task_page`）各触发一次兜底并
   `resume`/`redirect` 成功；③ 危险动作被 default-deny 拒绝且 Agent 指令无法越过；④ 非 TTY
   无 `--input` 时停驶即结构化退出，idle 超时退出码与 session 语义一致；⑤ rules-only 环境
   如实停 `no_model_runtime`，不假装驾驶；⑥ 驾驶问句的步史只记"已执行 + outcome"并带
   `当前页`/`期望页`；⑦ 被 hosts 信封排除的跨源 frame 进 handoff 证据（`frames_excluded`）
   且解锁建议点名"把 origin 加入 hosts"。
3. **PW3**：`pilot export` 骨架过 `amber apps check`；消融报告落 docs（实测数据）；
   桥结果与 CLI 同任务同 slot 逐字节一致（新增键除外）。
4. **红线验收**：驾驶请求体不存在自由文本动作生成面（pick 只收闭集 ref）；pilot 产物
   无任何路径冒充 run 结论；模型无法发起兜底（停因全部确定性判定）。

## 4. 涉及文件

- PW1：`src/app/pilot-runtime.ts`（新，交接块类型与现场投影）、RUN_TAKEOVER T1 共享落盘件、
  `docs/AGENT_INTERFACE.md`（交接块契约）。
- PW2：`src/app/pilot-runtime.ts`（驾驶循环）、`src/app/pilot-contract.ts`（请求/停因/指令闭集）、
  `src/app/middleware-factory.ts`（`FACE_POLICY` 加 `pilot`）、`src/cli/commands/pilot.ts`、
  `src/cli/registry.ts`、`docs/MAINLINE.md`（装配表 + seam 冻结表）、
  `docs/INTERACTIVE_SESSION.md`（划界注记：pilot 是并列面，session 零模型纪律不变）。
- PW3：`src/app/pilot-export.ts`（衔接 `session-export.ts` / `signal-induction.ts`）、
  `integrations/dsh-bridge`（工具 + schema 生成）、`docs/AGENT_INTERFACE.md`。

## 5. 红线（不可破）

- **模型只投票，不生成**：驾驶问句是池内闭集 pick（`ChoiceRequest` 同契约）；动作类型由
  affordance 规则定；模型不产出动作文本、脚本或自由计划。
- **兜底触发确定性**：停因闭集触发交接，模型不能自请兜底（对齐 intervention
  「模型永不发起中断」）；低置信回流（reobserve）与 run 同序，不提前弹人。
- **完成只认信号**：最终信号由发起方声明、引擎 `checkSignal` 验证；驾驶推进 ≠ 完成；
  pilot 产物带 `pilot:true`，走查通过 ≠ 应用通过——正式结论只能来自生成的 `app.mjs`
  走 `amber run`。
- **不复活 LLM 规划面**（BACKLOG #1 的移除决定不受影响）：模型不生成计划文本；总目标、
  最终信号、改道意图全部来自发起方（Agent/人）；pilot 只是「既定目标下的逐步投票」。
- **不另写执行器**：驾驶循环只组合既有原语（抽池/pick/actOnce/checkSignal/settle），
  照 session-runtime 复用先例；新增 face 必须走 `buildMiddleware`。
- **危险闸门不放宽**：default-deny；hosts 信封继承；不绕反爬。
- **值不猜**：`needs_value` 停 → Agent 兜底显式给值或预声明 `--slots`；两袋解析与 run
  同一套（`values` → `slots`），绝不模型编值。
- **session 纪律不变**：`amber session` 保持「一步都不问模型」；pilot 是并列新面，
  可复现性要求由 pilot 自身的轨迹 + trace 承担。

## 6. 与既有方案的关系

- **RUN_TAKEOVER**：T1 四件套共享实现；T2 的 stdin 交接是「失败后接管」，pilot 是
  「常驻兜底回路」——同一协议家族，PW1 交接面是两者的公共件；实施排期上 PW1 可与 T1 合批。
- **INTERVENTION_RESCUE_MODULE**：触发纪律同源（确定性 > 模型裁量）；pilot 兜底指令
  **不接 rescue 通道**（控制协议 ≠ 求人救援），但交接块借 `why_stuck` / 
  `what_would_unblock` 的证据形状与有界纪律。
- **DECISION_CONTEXT_CONTRACT**：pilot 驾驶请求的步史 = L2 运行史，是 Phase 1 执行期
  L2 直通的自然消费者；分层预算与裁剪序（DC1.3）直接适用，不发明第六层。
- **SESSION_TAX_REDUCTION_PLAN**：S 组砍的是 Agent 驾驶的重复轮询税，pilot 是换驾驶者
  ——两者正交且互补（S 组落地后 Agent 兜底也更便宜）。
- **BACKLOG**：#1 不受影响（见红线）；pilot 的候选窗口消费与 #3（窗口指数递增）同底座，
  排期时避免同改一个匹配面。
- 不触碰禁区：完成只认信号、不另写执行器、hint 语法闭集不动、危险/人工/凭据纪律全部维持。

## 7. 落地索引（2026-11-19 实施记录）

PW1–PW3 已落地；**CLI 入口 `amber pilot`/`amber pilot export` 已于 2026-11-23 移除**
（agent 面经 `amberflow_session` 的 drive 系列 op；驾驶协议保留在引擎库面），文件与方案的对应：

| 件 | 文件 | 说明 |
|---|---|---|
| 契约 | `src/app/pilot-contract.ts` | 停因闭集（8 码）/ 兜底指令闭集（4 指令）/ `PilotHandoff` 交接块 / 轨迹行类型 / 选项面与解锁建议查表 |
| 驾驶运行时 | `src/app/pilot-runtime.ts` | `PilotRuntime`：抽池 → resume-hint 确定性执行 → 规则档先行 → `pickProposal` 闭集投票 → 闸门 → `actOnce` 执行 → inert/信号判定；决策源装配与 run 同序列（`resolveProviderSpec` → `applySpecToRuntime`） |
| 入口编排 | ~~`src/app/pilot-entry.ts`~~ | **2026-11-23 移除**（agent 面经 `amberflow_session` 的 drive 系列 op；引擎库面由 `PilotRuntime` 直接驱动） |
| CLI | ~~`src/cli/commands/pilot.ts`~~ | **2026-11-23 移除**；等价入口是 `amber session` 的 `drive/driveCommand/driveStatus/driveClose` 请求 |
| 工厂 | `src/app/middleware-factory.ts` | `MiddlewareFace` 加 `"pilot"`；`FACE_POLICY.pilot = "default-deny"`（与 session 同档） |
| 导出 | ~~`src/app/pilot-export.ts`~~ | **2026-11-23 移除**；轨迹→骨架改用 `amber session export`（同 `session-export.ts` 产出形状） |

端到端冒烟（books.toscrape.com 实测）：起飞 → 模型低置信如实交接（截图 + observe 落盘）→
Agent `resume` 带 hint 点名 → 规则档确定性点击（零模型）→ `final_signal_held` → exit 0；
`pilot export` 骨架生成成功。

**2026-11-20 修正批**（实施审查 → 修复，实施记录见 CHANGELOG 同日条目）：

- `finish` 指令改必须 `checkSignal` 验证（`signal_not_held` 单行拒绝）——收口红线
  「完成只认信号」（审查实测：无任何信号声明也可 exit 0 / ok:true 的旁路已堵）；
- 低置信先付一次宽扫重问（WIDER_ELEMENTS/WIDE_QUOTAS + esig 平移禁选，与 run 的 4d
  阶段同序）；`--conf-floor` 接 provider 自报链（CLI > `ProviderInfo.floor` > 0.25）；
- 交接四件套补齐：DOM 快照（>2MB 截断）与独立池快照文件（此前 pool_snapshot 复用
  observe 文件、无 DOM）；
- `redirect` 步史与禁选清段重新累计（预算不清零）；`resume` 支持 `value:{k:v}` 多槽与
  `skip`（禁选最近一票）；兜底指令记录的 `value` 只留省略标记（值不落明文轨迹）；
- `pilot_end` 终态只发一条且 `stop_code` 不再丢失；摘要补 model_asks / rule_picks /
  model_picks / handoffs / fallbacks（laya 档含 cache 命中）；坏 JSON / 被拒指令单行
  失败继续等待（session 同纪律），不再杀会话；
- CLI：`--max-steps 1` 边界与 `pilot export --json` 修复；主命令位吞掉全局 `--json`。

**2026-11-20 消融实测（PW3 价值验证门，books.toscrape 真站）**：同一任务（打开第一本书的
详情页；信号 `css_exists:".product_main"`；预算 6-8），`--driver agent|model` 双臂 +
「模型主控 + Agent 兜底」混合臂：

| 臂 | 决策源 / goal | 到达 | 步数 | 模型咨询 | Agent 指令 | 停因 |
|---|---|---|---|---|---|---|
| model 纯自主 ×4 | laya english(zh) ／ laya multilingual(zh) ／ laya multilingual(en) ／ 在线 decision-model-preview(en) | **0/4** | 1-6 | 0-3（+1 failed） | 0 | budget ／ target_ambiguous ／ low_confidence（在线源失败如实降级） |
| hybrid 模型主控+兜底 | laya multilingual(zh) | ✓ | 4 | 3 | 1 | final_signal_held（exit 0） |
| agent 纯人工驾驶（`--driver agent`） | 无模型（en） | ✓ | 2 | 0 | 1 | final_signal_held（exit 0） |

墙钟：model 34.9-75.8s（含 ONNX 冷加载 ~32s）；hybrid 40.6s；agent 端到端 28.8s
（含外层 Agent 工具调用间隔；引擎内动作仅 0.77s）。

**结论（实测为准，不预设倍数）**：本任务上价值门**未过**——模型腿没有把多轮观察压缩成
净收益：纯 model 4 种配置 0 到达（票面偏 chrome/导航元素：next／logo／类目／Add to basket）；
hybrid 到达但比纯 agent 更贵（3 次咨询 + 3 个浪费步 + 1 条兜底 vs 1 条指令到达）。方案的成本
主张在本地 laya 档上不成立，需更强的决策源或目标更明确的任务复测。实测同时暴露三面可行动
能力墙：①规则档对自主 goal 的词面误配（"book"→类目 "Books"）与 URL 变化型乒乓——URL 每步
都变 ⇒ `ok+changed` 永不进禁选、anti-repeat 捕获不到，预算无声烧尽（登记 BACKLOG §16）；
②budget_exceeded 后 resume 被消费却无效、立即再次 budget（登记 BACKLOG §17，redirect 的预算
语义待产品拍板）；③在线决策源失败如实降级 + `failed_asks` 记账（修正批观测面立功）。修正批
新增的 `via`／四件套／终态 stop_code／摘要指标让失败臂全程结构化可审计。

**2026-11-20 桥面 `amberflow_pilot` v1 落地（PW3 第②项）**：one-shot 驾驶调用——拼 CLI
（`pilotArgs`；schema 走 run-args-contract 生成链的 `PILOT_ARG_FIELDS` 单源，run 段生成物
字节不变）、收引擎 JSONL 协议流、投影有界摘要（终态字段 + 事件白名单 ≤60 + 交接细节 ≤4；
`commands` 兜底剧本物化 ≤200 行走 `--input`；`timeout_sec` 桥侧墙钟，超时写
`pilot-killed.json`）。桥层回归 `npm run bridge:test` 10/10（fake-engine 场景 + 真实
`pilotArgs` 断言 + 剧本透传核对），真引擎端到端冒烟 exit 0。交互式常驻驾驶（跨调用保持
现场、逐交接喂指令）**已由「session 子进程托管 pilot」落地**：`amberflow_session` 的
`drive/drive_command/drive_status/drive_close` op（同一 page、pilot:true/attached:true，
详见 AGENT_INTERFACE §3.3）。

**2026-11-20 部署面补齐 + 真实线上端到端**：桥包 `tsc -b` 构建通过（`lib` 产物含
`pilot.js` 与 `amberflow_pilot` 注册——部署按 lib 加载，此前 lib 缺 pilot 即工具不可见
的真因；构建另修正 4 类 strip-types 下不可见的类型问题）。用构建产物 `lib/types/pilot.js`
对 books.toscrape.com 跑通真实线上走查：模型 3 步 → `target_ambiguous` 交接 → Agent 1 条
`resume` 点名 → 到达详情页，`status=held` / `exit 0`（33.1 s 含 ONNX 冷加载），四件套
落盘，`pilot export` 骨架过 `apps check`。

**2026-11-20 §3.2 验收矩阵落地（PW3 收尾）**：`npm run verify:pilot`（`tools/verify-pilot.ts`
+ `fixtures/engine/pilot/`；本地静态服务 + 决策源不可达档，零模型加载、规则面确定性、
不依赖本机 laya 工件）7 场景全绿——①rules 零模型到达；②每类停因 + resume 成功
（needs_value 值+点名 / stuck_inert 换目标 / target_ambiguous 收窄 / budget）；③危险
default-deny 且兜底闭集无 confirm 可越过；④终态摘要保停因；⑤决策源不可达降级两步
如实（low_confidence → no_model_runtime）。矩阵抓出两枚真缺陷并同步修复：**驾驶面危险
闸门此前不生效**（run 的风险闸门在动作相位，actOnce 旁路；default-deny face 不装
confirmFn）——改为 `DESTRUCTIVE_PATTERNS` 关键词闭集前置判定（单源 rules.ts），拒绝 =
`risk_declined` 结构化失败 + 禁选；**resume-hint 撞歧义静默回落**——改为裁决视图
（hintMatch）为 null 且候选 >1 时 `target_ambiguous` 只停不选（与 run/session 同一谓词）。

尚未落地（后续批次）：BACKLOG §16/§17 两枚能力墙（访问循环守卫；budget 后兜底死局的
redirect 预算语义拍板）。`--driver` 双臂、
消融实测、桥面 one-shot 与 §3.2 验收矩阵均已落地（见上）。
