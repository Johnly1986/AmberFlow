# 介入 / 救援中断模块设计方案（Intervention / Rescue）

- 状态：设计定稿（2026-11-12），产品 + 架构双视角研判后合成，**待实施**（五步，见 §8）。
- 评审输入：产品视角（用户习惯 / 介入时机与形态 / 提示词体验 / 采用门槛）；架构视角（边界与依赖方向 / 系统稳定性 / 可扩张性 / 迁移顺序）。
- 一句话：**目标不可达不是异常，而是结构化求援；求援是独立模块的一条确定性出口，提示词与它同源。**

---

## 0. 背景：四个投影，一个本质

系统里已有四种「人必须接一手」的机制，散在不同层、各说各话：

| 现有投影 | 位置 | 现状问题 |
|---|---|---|
| `ctx.manual`（flow 人工步） | `src/app/ctx.ts:1257-1349` | 话术「完成后按 Enter」；非 TTY 直接 `needs_human`；handler 注入缝已存在 |
| 声明式 journey 人工步 | `src/app/app-runner.ts:1456-1503` | 话术「[manual] …」；非 TTY 无 handler 落 `manual_handler_error`（与 flow 面不一致） |
| 规划脸人工确认 | `src/cli/start.ts:341` 附近 | 话术「这一步完成了么？(y/N)」——**第三套方言** |
| 危险动作默认拒绝 | `app-runner.ts:1410`（`confirmFn`） | 已默认 fail-closed；无结构化求援形状 |
| 桥侧停因转述 | `integrations/dsh-bridge/src/index.ts` | `needs_human` 只给结构化停 + 文本建议；`manualHandler` 未接线 |

**本质是同一件事**：Agent 在声明点/确定性条件上判定「目标不可达 → 需要外界（人/系统）救援 → 中断」。当前它被实现成四种投影，因此话术多套方言、停因与提示词各自手抄、无法扩展新的救援者（凭据保险箱、外部任务系统、GUI 确认）。

本方案把这件事抽成**独立小模块**：应用层只做适配，模块不认识浏览器、`meta`、`flow`、DSH，也不认识决策模型。

## 1. 设计原则（红线）

**四条模块红线**（草案保留）：

1. `done_criteria` 属于**请求**，不属于通道——通道无权削弱验证；
2. 证据（evidence）对模块**不透明**——模块不解析 kind 语义；
3. 通道只能应答，**不能改计划、不能写 result**；
4. 模块**不感知**浏览器 / `meta` / `flow` / DSH。

**两条研判补充**：

5. **dry / replay 不产生真实求援**——`amber apps check` 等离线闸门必须零阻塞（`ctx-dry` 的 manual 桩返回 `ok:true` + `dry:true`，模块沿用，不弹通道）；
6. **fulfilled ≠ 完成**——应答通过后仍按 `done_criteria` 复核；复核不过 = 结构化停（`manual_signal_not_held` 类），绝不静默算绿。

**沿用既有不变量**：完成只认信号；值不猜、不造默认值；不假装有人（非 TTY 不模拟确认、不拉无人可见的浏览器）。

**触发权归属（产品 + 架构一致）**：介入由**确定性声明**触发，不由模型裁量；模型只能归类与措辞，**永不发起中断**——「模型今天没把握就弹人」不可接受。低置信一律走既有回流（tiered hint / `low_confidence` → next），升为红线。

## 2. 模块边界与依赖（分层）

| 文件 | 职责 | 允许依赖 | 禁止依赖 |
|---|---|---|---|
| `src/support/intervention-contract.ts` | 合同**类型**（零 import 叶子） | 无 | 一切 |
| `src/support/intervention-texts.ts` | 求援提示词**数据**（零 import 叶子） | 无 | 一切 |
| `src/intervention/index.ts` | 编排：状态、顺序链、幂等 | `node:*` + 上述两个 support 文件 | app/engine/model/cli/browser/data/integrations |
| `src/intervention/channels.ts` | 内建通道（TTY / StructuredStop / FailFast / Handler 桥接） | 同上 | 同上 |
| `src/app/intervention-adapter.ts` | **唯一** app ↔ 模块适配（ctx.manual / manual_steps / trace / result 映射；`StopError` 映射） | app 层正常依赖 | 模块不反向依赖它 |

理由（架构研判采纳）：仓库目标是 L0–L6 分层（`docs/IMPROVEMENT_PLAN.md:123-136`），新顶层目录必须**登记为 L1.5**（`ARCHITECTURE.md` §2/§5 层表 + IMPROVEMENT_PLAN），否则是未治理的第八层。合同与文本必须零依赖，才能被 `src/cli/schema-gen.ts`、`tools/prompt-hit.ts` 与桥生成物共同消费；runtime 只依赖叶子。

**已知边界坑**：`StopError` 在 `src/app/ctx-types.ts:19`（应用层）——模块**不得**抛它；outcome 一律由 adapter 映射成 app 层停因。

## 3. 合同（`intervention-contract.ts`）

```ts
type RescueMode = "suspend" | "stop";
type RescueKind = keyof typeof RESCUE_KINDS;           // 注册表 union，编译期穷尽

interface RescueRequest {
  request_id: string;          // = `${run_id}:${seq}`（幂等键）
  run_id: string;
  seq: number;
  kind: RescueKind;
  mode: RescueMode;            // stop = 序列化进结果；suspend = 调用栈内等待
  why_stuck: {
    summary: string;           // ≤400 字，通道唯一可展示的人话事实
    stop_code?: string;        // 既有停因（不新增）
    step_id?: string;
    evidence: unknown;         // JSON-safe ≤2KB；生产方声明已脱敏，模块只校验大小/可序列化
  };
  what_would_unblock: readonly string[];  // 需要外界做什么（≤3 条，一次一问）
  done_criteria?: unknown;     // 由 app 层解释；模块只透传
}

interface RescueOutcome {      // 五态：拒绝/超时/取消/无人 必须可区分
  status: "fulfilled" | "declined" | "timeout" | "cancelled" | "unavailable";
  by?: string;                 // 通道 id / 应答者标识（不回传敏感信息）
  reason?: string;
  at: number;
}

interface RescueChannel {
  id: string;
  synchronous: boolean;        // 只有 true 的通道允许 suspend
  resolve(req: RescueRequest, signal?: AbortSignal): Promise<RescueOutcome>;
}
```

**kind 注册表**（每个 kind 必须绑定三件事，产品研判要求）：

```ts
const RESCUE_KINDS = {
  action:      { stop_code: "needs_human", who_can_fix: "human-action",        text: "action",      },
  value:       { stop_code: "needs_value", who_can_fix: "human-value",         text: "value",       },
  authorization:{ stop_code: "needs_human", who_can_fix: "human-authorization", text: "authorization" },
  // 二期：credential / external-task / captcha —— 注册表加一条 + texts 加一条，编排零改
} as const;
```

- `stop_code` 只引用**既有**停因（`manual_declined` / `needs_human` / `manual_signal_not_held` 等），**零新 stop code**，旧产物形状不变。
- `who_can_fix` 决定「谁能修」，也决定通道/文案选择——这是「按谁能修触发、不按置信度、不按次数触发」的落点。
- `normalizeEvidence` 由**生产方**（app 层）提供并挂在注册项上；模块只做 JSON-safe / 大小校验——这是「证据不透明」红线的落地方式（模块若按 kind 解析证据，就等于认识 kind 语义）。

**默认 `stop`，`suspend` 必须显式**（架构研判）：默认走调用栈内等待会改现有控制流与桥的 900s 墙钟语义；`stop` 模式**不产生 Outcome**，只把 request 序列化进结果（`result.rescue`），绝不把「没人答」伪装成 `fulfilled`。

**Outcome → 停因映射归 adapter**（模块零停因知识）：

| Outcome | app 层行为 |
|---|---|
| `fulfilled` | 继续执行 + 复核 `done_criteria`（现状 `ctx.ts:1322-1333` 路径）；复核失败 → `manual_signal_not_held` 类结构停 |
| `declined` | `manual_declined`（文案「已放弃，流程停止」，不叫失败） |
| `timeout` / `cancelled` / `unavailable` | `needs_human`（reason 带 `request_id`，便于对账） |

## 4. 触发策略（什么时候介入）

**MVP 唯一默认可调通道的触发 = 声明点**：`ctx.manual` / journey 声明式人工步（数据行人工步骤）。运行期突发阻断（`blocked` / `unreachable` / 风控）仍走既有结构化停交 Agent 上报，**不让引擎在未声明时刻突然问人**——人此时没有上下文，也越出授权边界。「声明点才停」在产品上足够：声明式人工步 + 缺值覆盖多数真实中断，兜底是人写进流程的声明，不是引擎的猜。

**分类器而非触发器**（架构研判采纳，产品「确认不是求援」一致）：

- `needs_value`：是**返回值**（脚本拿 `ok:false` 后自行 `ctx.fail`），不是挂起点。v1 只把已有事实映射成 `RescueRequest` 供提示词/结果/next 使用，**不调通道、不改控制流**。
- 危险动作拒绝：`confirmFn` 默认拒绝是 fail-closed 安全语义（`app-runner.ts:1410`），**确认不是求援**。v1 只做 kind 分类，不改「默认拒绝」。
- 低置信：永不触发（§1 红线）。

**升级计数（同停因 ×2）**：采纳架构的「实例化状态」形态、否决产品的「MVP 触发」用法——`createRescueState(run_id)` 持有计数（**禁止模块级变量**，同进程多 run 会串扰）；阈值单源，`planning-playbook.ts:124` 的 `STOP_ESCALATION_TEXT` 由该单源生成/校验，防两处纪律漂移。计数**只用于 Agent 面升级文案**，不调通道、不重问人；二期再评估是否对外可见。

**dry / replay 红线**：模块在任何真实求援前检查 dry 标志；`ctx-dry` 的人工步桩照旧 `ok:true, dry:true`，`apps check` 离线全绿不阻塞。

**通道顺序链**（架构收窄接口后的统一形态）：

```
显式注入 handler（synchronous，可 suspend）
  > TTY（synchronous，等真人；保留 Enter/n 习惯，久无输入只提醒不杀）
    > FailFast / StructuredStop（异步，stop：序列化请求 + 结构化停）
      > none（unavailable：批处理/无应答者，立即停，绝不 sleep 等人）
```

桥侧**禁止 suspend**（900s 墙钟 + `stdio:['ignore','pipe','pipe']` 会杀进程产生半救援状态）：桥只允许 stop + 转述，`manualHandler` 继续不接线。

## 5. 用户习惯与产品决策

1. **按「谁有本事谁上」触发**。可接受：本人凭据/2FA、不可逆授权、外部处置（登录墙/风控）；不可接受：引擎自己能修的（`target_not_found`、声明错、瞬态）升级成人。
2. **提前问 > 中途问**。业务输入进 preflight 一次收齐（请求可带 `preflight` 标记）；跑到第 7 步才问日期是最贵的中断。
3. **四种在场形态默认按「有没有可应答通道」定**：TTY 就地等（Enter/n，不自动杀）；Agent 结构化停、引擎不等待、Agent 只向用户问一次；GUI 只确认/给值，**不得承诺「GUI 能救远端窗口里的人操作」**；批处理立即 `unavailable` 退出，绝不等待。
4. **拒绝 / 超时 / 失败不惩罚人**：`declined` 文案是「已放弃，流程停止」不是「失败」；不自动重问（只有显式重跑才再问）；`timeout`、`cancelled`、`unavailable` 三者分开；`fulfilled` 但信号不成立写「你确认了，但页面证据没成立」，不甩锅、不算绿。
5. **一次一问一通道**：不向 TTY+GUI+Agent 广播；同 run 同 kind 去重；`human_question` 只问一件事、选项 ≤3、可拒绝。
6. **反模式清单**：低置信弹窗；每步危险动作都确认；`needs_value` 做成人工步；无头机拉有头窗口让人找；拒绝后循环重问；文案暴露 stopCode/英文栈；长流程逐个问却无「本次全部拒绝」；CI 默认等 30s/900s。
7. **破坏性变更控制**：`status` / `stopCode` / exit code 不变；旧路径产物零字节变化（新字段仅真实求援出现）；TTY 文案一期不改；桥 `manualHandler` 一期不接线；GUI 上线前文档不得承诺 GUI 可救；回滚点 = 删消费接线即回今天（模块纯新增）。**v1 不加默认开配置开关**，行为由「有无可应答通道」决定；逃生舱（`AMBERFLOW_INTERVENTION=off`）二期再议。

## 6. 提示词单源（`intervention-texts.ts`）

**只覆盖求援 kind，不接管既有 31+ 停因文案**（产品裁决：`STOP_NEXT` 的工程动作仍归 `planning-playbook.ts`）。每个 kind 三层分离：

| 层 | 字段 | 消费面 |
|---|---|---|
| 事实层 | `summary`（一句人话：卡在哪/为什么/影响/已完成什么） | 人话报告、TTY 提示 |
| 问题层 | `human_question`（一个问题 + 选项 ≤3 + 默认 + 可拒绝） | TTY / GUI 通道 |
| 动作层 | `next_actions[]`（由通道渲染：TTY 命令、GUI 按钮、Agent 结构化 next） | 各通道 |
| 机器层 | `agent_hint`（**独立结构化字段**，不是人话翻译：事实 + 唯一推荐动作 + 停手条件） | Agent / 桥 |

- **双语**：zh 权威、en 只供桥工具描述；texts 存语义字段 + zh/en 渲染器；桥不另抄文案（请求文案随引擎结果走）。
- **断言进 prompt-hit**：zh 必填、en 不缺；人话不出现 stopCode 键名/JSON/英文栈；`human_question` ≤120 字（沿用 overview 长度预算先例）。
- **生成管线（复用既有，不新建生成器）**：`texts` → `tools/prompt-hit.ts` 的 `bridgeGenerated()`（`tools/prompt-hit.ts:129-166`）→ `integrations/dsh-bridge/src/grammar.generated.ts` 增导出；`src/cli/schema-gen.ts` 增 `intervention` 节 + F 条目（编号续、不重排）；`dist/schema/ctx.json` 同提交重生成；文档逐字块进 prompt-hit 的 `doc` 组。桥纪律 "called, not embedded" 不变。
- **示例文案**（产品评审采纳）：
  1. 人工步：「需要你本人完成一步：短信验证码只能你收（引擎不代收）。浏览器窗口已打开，完成后回这里按 Enter；输入 n 放弃——放弃不会自动重试，已完成的步骤和截图都保留在结果里。」
  2. 缺值：「还缺一个值：优惠码。把码发我最快（只用于本次运行，不进日志）；也可 `--slot coupon=…` 重跑。没有值就先别跑，引擎不会替你编。」
  3. 危险确认（GUI）：「这一步会提交订单并付款 ¥128，付款后不可撤销。确认执行 / 只试运行 / 拒绝；默认拒绝，2 分钟不选视为拒绝。」
  4. Agent 面：「STOP needs_human: 2FA required; engine won't fake a human. Ask the user ONCE to run `amber run <id> --headful`; retry the same run at most once, then report and stop.」

## 7. 稳定性决定（架构研判）

| 维度 | 决定 |
|---|---|
| 挂起资源 | suspend 只在调用栈内；进模块前不得建浏览器会话（保持 `ctx.ts:1262-1291` 零会话行为）；stop 路径不耗执行预算、不触发 pace |
| 超时 | 默认无超时（TTY 现状没有，加了就是行为变更）；`suspendMaxMs` 缺省 0，显式策略才启用；超时 → `timeout` → `needs_human` + reason 带 `request_id` |
| 取消 | 模块不装 SIGINT 处理器（生命周期归 runner）；宿主传 `AbortSignal` → `cancelled`；进程退出 = 挂起丢失，**绝不 fulfilled** |
| 幂等 | `request_id = (run_id, seq)`；first-answer-wins，迟到的应答丢弃但记一条 trace；`fulfilled` 后 `done_criteria` 只验一次；不重复计预算 |
| 并发 | 状态全部实例化；`maxSessions=2` 只管 `amber session`，run 每次独立子进程；将来 GUI 通道必须 agent-scoped（DSH approval 是 scoped waterfall），否则并发会话答案错人 |
| 崩溃 | 救援发生时落 `outDir/rescue-request.json`（同 `run-killed.json` 先例，不含敏感值）；v1 **不承诺** mid-flow resume（现 replay 是脚本调用重放而非浏览器状态恢复）；恢复 = 重跑；崩溃取证 = `{run_id, script_sha256, inputs_sha256, stop_code, step_id, final_url, request}` |
| 字节兼容 | 冻结三条人工路径：`ctx.manual` / journey runManualStep / executor `manualConfirmFn` null→`manual_needs_human`；通道接口不得收 `index`（journey 是声明步号、flow 恒 0），只能由 adapter 映射；验收 = 同输入 result/report 逐字节（除时间戳/run_id） |

## 8. 落地方案（五步，每步可独立验证）

| 步 | 内容 | 验收 | 回滚 |
|---|---|---|---|
| **0** | 合同 + 文本 + 层表登记（`ARCHITECTURE.md` §5、`IMPROVEMENT_PLAN.md:123-136` 登记 L1.5） | `typecheck` + import 白名单 review；无行为变化 | 删文件 |
| **1** | runtime + channels 纯新增（无调用点） | `npm run check` 全绿 | 删目录 |
| **2** | flow `ctx.manual` 通道解析接入（**最高风险**）：先**影子模式**并行记两路 outcome，再切默认；**先建 golden**（四条人工路径话术本就不同：`start.ts:341` / `app-runner.ts:1203` / `ctx-dry.ts:429` / `app-runner.ts:1493`） | failfast / 非 TTY / handler / declined / signal_not_held 五组 `--json` 结果 + report 逐字节；TTY 手工冒烟 | 单提交回滚 `ctx.ts` + adapter |
| **3** | journey / executor 接入（只换确认提供者，不改判定） | `manual_steps` / trace / report 逐字节 + plan 冒烟 | 同上 |
| **4** | texts 生成接线：`prompt-hit --fix`、schema 快照重生成、docs | `npm run check` 全绿 + `schema ctx --topic intervention` | 还原生成物 |
| **5** | 桥 stop 转述 + CLI flag（**默认关**）：`--rescue/--no-rescue` 三处接线（`registry.ts` / `run.ts` / `app-runner-cli.ts`）；若做 env 必须进 `config-schema.ts` + 示例生成 | 同 app 同 slot 桥结果默认逐字节；开 flag 仅多 `rescue` 键 | 默认关 |

**明确不进本期**：GUI 确认通道（需要 `run` 双向 JSONL 控制协议——照 `amber session` 先例但涉及新常驻协议与 Windows 孤儿治理，成本高、单独立项）；×2 自动升级对外可见；全量停因文案接管。

## 9. 总验收

- `npm run check` 全绿（typecheck / config 示例 / schema check / prompt-hit / secret-scan / examples-check / test:validate）。
- 五组 golden（步 2）逐字节 + report 一致。
- 三个端到端场景：① 登录人工步 TTY 通过 + 拒绝；② 缺值 `needs_value` 结构化停后补值重跑；③ 非 TTY 无 handler 时 `needs_human` 且零字节兼容。
- 新版 `result.rescue` 只在真实求援出现；桥 `summarizeRun`（`bridge.ts:982-987` 现只看 `manual_steps`/`script.stop_code`）有界透传，Agent 能看到「为什么需要人」。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 概念过宽（危险确认/人工步/缺值都叫 rescue），稀释 fail-closed 安全语义 | kind 只做分类；确认不是求援；危险拒绝 v1 不挂起 |
| 一话两用（同一文案服务人与 Agent） | 三层分离 + `agent_hint` 独立字段；zh/en 分离 |
| 迁移漏面（`executor.manualConfirmFn` 与声明式非 TTY 的 `manual_handler_error` 不在清单 → 两套方言） | golden 先行；步 2/3 分别验收；冻结三条路径 |
| 超时/等待不当 → CI 挂住、TTY 被催 | 默认无超时；批处理立即 unavailable；桥禁止 suspend |
| `fulfilled` 被当绿 | done_criteria 复核是合同义务，复核失败结构化停 |
| dry/check 真弹窗 | dry 红线 + `ctx-dry` 桩；步 3 验收含 `apps check` |
| `needs_value`/危险拒绝升级为求援 → 控制流与安全语义被改（最高风险） | 二者只分类不挂起；步 5 前不改任何触发 |
| 升级阈值与 `STOP_ESCALATION_TEXT` 双源漂移 | 单源生成 + prompt-hit 断言；实例化计数 |
| 模块级计数器跨 run 串 | 禁止模块级变量；`createRescueState(run_id)` |
| 桥生成物/工具描述变长改变模型行为 | 生成物 diff 逐条审查；flag 默认关 |
| 新 flag/env 漏同步 schema/示例/registry → check 红或静默无效 | 步 5 明确三处接线 + 示例生成 |
| GUI 通道缺 agent 作用域 → 答案错人 | 延迟到独立立项；文档不承诺 |
| 无消费面的模块 = 零收益 | 至少接 `agent-view` next / 桥结果 / `result.rescue` 三处（步 2/3/5 已排） |

## 11. 不做什么（边界）

- 不做远程桌面 / 远程代操作；GUI 通道最多确认与给值。
- 不新增 stop code；不改 `status`/`exit code`/既有停因语义。
- 不改危险动作默认拒绝；不让引擎在未声明时刻突然问人。
- 不接管既有 `STOP_NEXT` 全量文案；不新建提示词生成器（复用 prompt-hit）。
- 不承诺 mid-flow 断点续跑（v1 恢复 = 重跑）。
- 不用模块级全局状态；不装进程信号处理器。

## 12. 锚点索引（实现时查）

- 人工步现状：`src/app/ctx.ts:1257-1349`、`src/app/app-runner.ts:1192-1208,1456-1503,1602-1625,2286-2326`、`src/engine/executor.ts:4946-4964`、`src/cli/start.ts:341`、`src/app/ctx-dry.ts:429`
- 危险拒绝：`src/app/app-runner.ts:1408-1412`、`src/app/ctx-types.ts` 的 confirm 类型
- 停因/提示词：`src/engine/planning-playbook.ts:72-129`（`STOP_NEXT`/`EXEMPT_NEXT`/`STOP_ESCALATION_TEXT`）、`src/support/help-map.ts`
- 生成管线：`tools/prompt-hit.ts:14-40,129-166`、`integrations/dsh-bridge/src/grammar.generated.ts`、`src/cli/schema-gen.ts`（F 条目/`STOPCODE_MEANING`）
- 分层治理：`ARCHITECTURE.md` §2/§5、`docs/IMPROVEMENT_PLAN.md:123-136`
- 产物形状：`src/app/agent-view.ts:125-208`、`src/app/app-report-view.ts`、`integrations/dsh-bridge/src/bridge.ts:982-987`（`summarizeRun`）
- 桥稳定性：`integrations/dsh-bridge/src/bridge.ts:583-647`（`stdio` + 900s SIGKILL）、`run-killed.json` 先例、`integrations/dsh-bridge/src/session.ts:30`（`maxSessions`）
- 既有合同：`docs/MANUAL_STEPS_AND_PACE.md`、`docs/PROMPT_SYSTEM.md`、`docs/AGENT_INTERFACE.md`
- 会话常驻协议先例（GUI 通道若立项）：`amber session` 的 JSONL 协议（`docs/INTERACTIVE_SESSION.md`）
