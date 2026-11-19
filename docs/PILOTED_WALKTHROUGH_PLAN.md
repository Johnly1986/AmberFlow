# 方案提案：模型驾驶走查（决策模型主控 · Agent 兜底）

> **状态**：implemented（PW1+PW2+PW3 已落地并通过端到端冒烟；见 §6 落地索引）
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

### PW2：`amber pilot` 最小驾驶循环（MVP）

```bash
amber pilot --url https://example.org/list --goal "找到第一条详情的标题" \
  [--final-signal SPEC] [--max-steps N] [--slots k=v …] \
  [--input requests.jsonl]        # 非 TTY 兜底剧本（对齐 session 先例）
```

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

**停因闭集**（全部既有码，零新 stopCode）：`low_confidence` / `target_ambiguous` /
`needs_value` / 连续 inert（复用 anti-repeat 证据）/ `no_model_runtime` /
`budget_exceeded`（`--max-steps` 与 run 同名同义）/ `final_signal_held` / `browser_dead`。

**Agent 兜底指令闭集**（stdin JSONL，新请求类型；观察类指令复用 session 请求面）：

| 指令 | 形状 | 语义 |
|---|---|---|
| `resume` | `{ hint?, value?{k:v}, skip? }` | 修正后从当前现场继续驾驶；hint 进本轮解析链（`hintMatch` 唯一命中即确定性执行，不花模型）；值进本轮袋（值来自 Agent = 显式给定，红线②不破） |
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

1. `amber pilot export`：驾驶轨迹 → `app.mjs` flow 骨架（衔接 `session-export.ts` 先例：
   只出骨架；驾驶步的 before/after 可喂 `signal-induction.ts` 归纳候选 done——归纳结果
   是**候选**，落盘前照 learn 纪律复现验证，没把握返回 manual 而不是猜）。
2. 桥面 `amberflow_pilot`：驾驶启动 + 兜底指令透传（桥契约「拼 CLI、解析 envelope、
   有界摘要」三件事不变；schema 走 `run-args-contract` 生成链）。
3. 消融对比：`--driver agent|model` 同一走查任务双臂（消融臂 `--ablate` 先例），产出
   操作数 / 模型咨询数 / 墙钟 / 到达率实测报告——**作为 PW2→PW3 的价值验证门**。

---

## 3. 验收标准

1. **PW1**：停因交接块字段冻结；四件套与停驶页一致；缺省路径产物逐字节不变。
2. **PW2**：fixtures 静态页 + 真站 core 一条——① model 驾驶在声明预算内到达最终信号
   （每轮一次模型咨询，规则档命中不计）；② 每类停因各触发一次兜底并 `resume` 成功；
   ③ 危险动作被 default-deny 拒绝且 Agent 指令无法越过；④ 非 TTY 无 `--input` 时停驶即
   结构化退出，idle 超时退出码与 session 语义一致；⑤ rules-only 环境如实停
   `no_model_runtime`，不假装驾驶。
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

PW1+PW2+PW3 已落地（`amber pilot` / `amber pilot export` 可用），文件与方案的对应：

| 件 | 文件 | 说明 |
|---|---|---|
| 契约 | `src/app/pilot-contract.ts` | 停因闭集（8 码）/ 兜底指令闭集（4 指令）/ `PilotHandoff` 交接块 / 轨迹行类型 / 选项面与解锁建议查表 |
| 驾驶运行时 | `src/app/pilot-runtime.ts` | `PilotRuntime`：抽池 → resume-hint 确定性执行 → 规则档先行 → `pickProposal` 闭集投票 → 闸门 → `actOnce` 执行 → inert/信号判定；决策源装配与 run 同序列（`resolveProviderSpec` → `applySpecToRuntime`） |
| 入口编排 | `src/app/pilot-entry.ts` | `runPilot`：起飞 → 驾驶轮 ↔ 兜底等待（stdin 每轮 / `--input` 文件整段只开一次）→ 收尾退出码 |
| CLI | `src/cli/commands/pilot.ts` | flags 解析 + `export` 子动词；`src/cli/main.ts` 分派、`registry.ts` 帮助、`help-map.ts` 何时用 |
| 工厂 | `src/app/middleware-factory.ts` | `MiddlewareFace` 加 `"pilot"`；`FACE_POLICY.pilot = "default-deny"`（与 session 同档） |
| 导出 | `src/app/pilot-export.ts` | 驾驶轨迹 → app.mjs 骨架（`picked_by` 来源标记 + handoff 注释保留；done 占位符同 session export） |

端到端冒烟（books.toscrape.com 实测）：起飞 → 模型低置信如实交接（截图 + observe 落盘）→
Agent `resume` 带 hint 点名 → 规则档确定性点击（零模型）→ `final_signal_held` → exit 0；
`pilot export` 骨架生成成功。尚未落地：桥面 `amberflow_pilot` 工具、`--driver agent|model`
消融双臂、走查验收的 fixtures 全套（§3.2/§3.3 的完整矩阵）——按原计划属后续批次。
