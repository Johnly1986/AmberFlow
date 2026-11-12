# 介入 / 救援中断模块设计方案（Intervention / Rescue）

- 状态：设计定稿 **v2**（2026-11-12，第二轮产品 + 架构双视角研判后修订），**待实施**（五步，见 §8）。
- 评审输入：产品视角（用户习惯 / 介入时机与形态 / 提示词体验 / 采用门槛）；架构视角（边界与依赖方向 / 系统稳定性 / 可扩张性 / 迁移顺序）。
- 一句话：**目标不可达不是异常，而是结构化求援；求援是独立模块的一条确定性出口，提示词与它同源。**
- v2 修订要点（按双视角评审结论）：验收双轨化（§7/§9）、影子模式三决定（§8 步 2）、去重键改 `(run_id, kind, step_id)`（§5.5）、示例文案三处修正 + 语言矩阵（§6）、`normalizeEvidence` 落点改 adapter 分发表（§3）、`rescue-request.json` 只在 suspend 前落盘（§7）、golden 扩为六条（§8 步 2）、阈值单源方向修正（§4）、v1 收益正面表态（§8 不做什么之后）。

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

理由（架构研判采纳）：仓库目标是 L0–L6 分层（`docs/IMPROVEMENT_PLAN.md` 方案 B 层表），新顶层目录必须**登记为 L1.5**（`ARCHITECTURE.md` §2/§5 层表 + IMPROVEMENT_PLAN，按小节名锚定不用行号），否则是未治理的第八层。合同与文本必须零依赖，才能被 `src/cli/schema-gen.ts`、`tools/prompt-hit.ts` 与桥生成物共同消费；runtime 只依赖叶子。

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
- `who_can_fix` 决定「谁能修」，也决定通道/文案选择——这是「按谁能修触发、不按置信度、不按次数触发」的落点。类型上 v1 就定义为 `string`（非字面量联合）：二期 credential / external-task 的应答者是**系统**（保险箱 / 外部编排器）而非人，届时新增非人 `who_can_fix` 值（`vault` / `external`）必须同步扩展通道选路规则，合同类型不得被迫破坏性变更。
- **证据归一化的落点（v2 修正）**：`RESCUE_KINDS` 保持**纯数据**（`stop_code` / `who_can_fix` / `text` 三件，不挂函数——叶子文件挂 app 函数必然造成双注册表与隐藏可变状态）；`normalizeEvidence` 是 **adapter 内部的 `Record<RescueKind, (e: unknown) => unknown>` 分发表**，键集一致性由编译期断言钉死（`const _check: Record<RescueKind, ...> = NORMALIZERS`，缺键即 typecheck 红）。模块侧只在 `RescueRequest` 入口做 JSON-safe / 大小校验——这是「证据不透明」红线的落地方式。
- **二期 kind 依赖声明**：credential kind 依赖凭据保险箱（见 `MANUAL_STEPS_AND_PACE.md` §2「本版本尚未内置凭据保险箱」）——保险箱未建前该 kind **不注册、不生成文案**，避免「求援成功但值无处安全安放」的产品断层；credential ≠ 保险箱代建。

**默认 `stop`，`suspend` 必须显式**（架构研判）：默认走调用栈内等待会改现有控制流与桥的 900s 墙钟语义；`stop` 模式**不产生 Outcome**，只把 request 序列化进结果（`result.rescue`），绝不把「没人答」伪装成 `fulfilled`。

**Outcome → 停因映射归 adapter**（模块零停因知识）：

| Outcome | app 层行为 |
|---|---|
| `fulfilled` | 继续执行 + 复核 `done_criteria`（现状 `ctx.ts:1322-1333` 路径）；复核失败 → `manual_signal_not_held` 类结构停 |
| `declined` | `manual_declined`（文案「已放弃，流程停止」，不叫失败） |
| `timeout` / `cancelled` / `unavailable` | `needs_human`（reason 带 `request_id`，便于对账） |

**硬约束（v2 新增，golden 的前提）**：adapter 映射**不得改写既有 reason 字符串原文**（`declined` / `manual_signal_not_held` / `manual_handler_error: …` 等冻结）——新文案只进 `rescue` 新键；report / agent-view 消费既有 reason 原文，改写即破坏逐字节验收。

**通道抛错闭环（v2 补）**：`RescueChannel.resolve` 实现抛异常（如 TTY stdin EPIPE——现状靠 `ctx.ts:1305-1316` 的 try/catch 转 `manual_handler_error`）时，**模块兜底 catch 转成 `unavailable` + reason 截获**，不信任通道实现、不允许异常冒泡绕过 Outcome 映射；与五态枚举闭环。

## 4. 触发策略（什么时候介入）

**MVP 唯一默认可调通道的触发 = 声明点**：`ctx.manual` / journey 声明式人工步（数据行人工步骤）。运行期突发阻断（`blocked` / `unreachable` / 风控）仍走既有结构化停交 Agent 上报，**不让引擎在未声明时刻突然问人**——人此时没有上下文，也越出授权边界。「声明点才停」在产品上足够：声明式人工步 + 缺值覆盖多数真实中断，兜底是人写进流程的声明，不是引擎的猜。

**分类器而非触发器**（架构研判采纳，产品「确认不是求援」一致）：

- `needs_value`：是**返回值**（脚本拿 `ok:false` 后自行 `ctx.fail`），不是挂起点。v1 只把已有事实映射成 `RescueRequest` 供提示词/结果/next 使用，**不调通道、不改控制流**。
- 危险动作拒绝：`confirmFn` 默认拒绝是 fail-closed 安全语义（`app-runner.ts:1410`），**确认不是求援**。v1 只做 kind 分类，不改「默认拒绝」。
- 低置信：永不触发（§1 红线）。

**升级计数（同停因 ×2）**：采纳架构的「实例化状态」形态、否决产品的「MVP 触发」用法——`createRescueState(run_id)` 持有计数（**禁止模块级变量**，同进程多 run 会串扰）。**阈值单源方向（v2 修正）**：阈值常量与 `STOP_ESCALATION_TEXT` **留在 `planning-playbook.ts`（引擎层）不动**；`createRescueState` 只持原始计数并暴露 `countFor(stopCode)`，文案由引擎层渲染——模块不持有阈值、不渲染文案（让 L1.5 叶子生成引擎层文本是依赖倒挂）。计数**只用于 Agent 面升级文案**，不调通道、不重问人；二期再评估是否对外可见。

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
2. **提前问 > 中途问**。业务输入进 preflight 一次收齐（请求可带 `preflight` 标记）。**交付形态分两种（v2 修正）**：TTY / GUI 形态可在 preflight 阶段直接问人；Agent / 批处理形态下 preflight 表现为**启动即检、失败即停**——缺值在运行开始前就产生 `needs_value` 结构化停，而不是跑到第 7 步才停。两者都消灭中途中断，但只有同步通道真的「问」。批处理 / 无 TTY 场景 preflight 缺值**不升级求援**，直接按既有 `needs_value` 路径返回（与 §4「needs_value 不调通道」一致）。
3. **四种在场形态默认按「有没有可应答通道」定**：TTY 就地等（Enter/n，不自动杀）；Agent 结构化停、引擎不等待、Agent 只向用户问一次；GUI 只确认/给值，**不得承诺「GUI 能救远端窗口里的人操作」**；批处理立即 `unavailable` 退出，绝不等待。
4. **拒绝 / 超时 / 失败不惩罚人**：`declined` 文案是「已放弃，流程停止」不是「失败」；不自动重问（只有显式重跑才再问）；`timeout`、`cancelled`、`unavailable` 三者分开——**三态差异化人话（v2 新增，差异同时落到 agent_hint 停手条件）**：timeout「等了你 N 分钟没等到，流程停了」；cancelled「你取消了，流程停止」；unavailable「当前环境没有能等你的通道（批处理/无 TTY），流程已停，换交互终端重跑」；`fulfilled` 但信号不成立写「你确认了，但页面证据没成立」，不甩锅、不算绿。
5. **一次一问一通道**：不向 TTY+GUI+Agent 广播；**去重键 = `(run_id, kind, step_id)`（v2 修正）**——去重防的是**同一声明点**的重复弹问（handler 重试、幂等重放），**不吞脚本作者显式声明的第二个同类步**（登录步 + 支付步两个 `ctx.manual` 各自独立应答）；显式重跑不受去重影响。跨 run 无记忆是刻意设计：每次 run 都是独立授权边界，收敛靠 `--slot` 持久化或用户改脚本，引擎不做跨 run 去重。`human_question` 只问一件事、选项 ≤3、可拒绝；`what_would_unblock` >3 条时生产方必须拆成多次求援或收敛为一条主问，模块校验超限即拒收（config_error），不静默截断。
6. **反模式清单**：低置信弹窗；每步危险动作都确认；`needs_value` 做成人工步；无头机拉有头窗口让人找；拒绝后循环重问；文案暴露 stopCode/英文栈；长流程逐个问却无「本次全部拒绝」；CI 默认等 30s/900s。
7. **破坏性变更控制**：`status` / `stopCode` / exit code 不变；旧路径产物零字节变化（新字段仅真实求援出现）；TTY 文案一期不改（二期统一为 Enter/n 方言，规划脸 y/N 列入废弃清单）；桥 `manualHandler` 一期不接线；回滚点 = 删消费接线即回今天（模块纯新增；**历史 run 的 `rescue-request.json` 与 `result.rescue` 为无害残留，读取端须容忍未知字段**）。**v1 不加默认开配置开关**，行为由「有无可应答通道」决定；逃生舱（`AMBERFLOW_INTERVENTION=off`）二期再议。

## 6. 提示词单源（`intervention-texts.ts`）

**只覆盖求援 kind，不接管既有 31+ 停因文案**（产品裁决：`STOP_NEXT` 的工程动作仍归 `planning-playbook.ts`）。每个 kind 四层分离：

| 层 | 字段 | 消费面 |
|---|---|---|
| 事实层 | `summary`（一句人话：卡在哪/为什么/影响/已完成什么） | 人话报告、TTY 提示 |
| 问题层 | `human_question`（一个问题 + 选项 ≤3 + 默认 + 可拒绝） | TTY / GUI 通道 |
| 动作层 | `next_actions[]`（由通道渲染：TTY 命令、GUI 按钮、Agent 结构化 next） | 各通道 |
| 机器层 | `agent_hint`（**独立结构化字段**，不是人话翻译：事实 + 唯一推荐动作 + 停手条件） | Agent / 桥 |

- **语言矩阵（v2 裁决）**：事实层 / 问题层面向最终用户 → **永远 zh**；`agent_hint` 面向模型 → 跟随桥合同语言（现状为 en）。**Agent 向终端用户转述时，以 `summary`（zh）为转述基准、`agent_hint`（en）为动作基准**——`agent_hint` 内不得混入面向人的祈使句。zh 权威、en 只供桥工具描述；texts 存语义字段 + zh/en 渲染器；桥不另抄文案（请求文案随引擎结果走）。
- **示例文案必须逐条对应 v1 注册表中的 kind**（v2 新规则）——不为本期不存在的通道（GUI）生成文案。
- **断言进 prompt-hit**（v2 给出具体清单，实施照抄）：① texts 每条 zh 非空；② en 可空但渲染器不得拼 zh；③ `summary` ≤400 字；④ `human_question` ≤120 字；⑤ 人话层（summary / human_question）禁 stopCode 键名 / JSON / 英文栈；⑥ `agent_hint` 不含面向人的祈使句。
- **生成管线（复用既有，不新建生成器）**：`texts` → `tools/prompt-hit.ts` 的 `bridgeGenerated()`（`tools/prompt-hit.ts:129-166`）→ `integrations/dsh-bridge/src/grammar.generated.ts` 增导出；`src/cli/schema-gen.ts` 增 `intervention` 节 + F 条目（编号续、不重排）；`dist/schema/ctx.json` 同提交重生成；文档逐字块进 prompt-hit 的 `doc` 组。桥纪律 "called, not embedded" 不变。
- **示例文案**（v2 修订）：
  1. 人工步（action）：「需要你本人完成一步：短信验证码只能你收（引擎不代收）。浏览器窗口已打开，完成后回这里按 Enter；输入 n 放弃——放弃不会自动重试，已完成的步骤和截图都保留在结果里。」
  2. 缺值（value）：「还缺一个值：优惠码。用 `--slot coupon=…` 重跑最快（只用于本次运行，不进日志）。没有值就先别跑，引擎不会替你编。」
  3. 人工步复核失败（action，signal_not_held 场景——五态里用户最困惑的时刻，防话术漂移的压力测试文案）：「你按了 Enter，但页面还没出现声明的完成信号（订单列表页）。确认操作已完成就检查信号定义是否过期；没完成就回浏览器继续操作后重新确认。」
  4. Agent 面（agent_hint 结构化字段，en，拆成三层而非叙事段落）：`{ fact: "STOP needs_human: 2FA required; engine won't fake a human", recommended_action: "ask the user ONCE to run `amber run <id> --headful`", stop_condition: "retry the same run at most once, then report and stop" }`

  （v2 删除原 GUI 危险确认示例：GUI 通道明确不进本期，示例不得携带本期不存在的通道超时值——「2 分钟不选视为拒绝」与 §7「默认无超时」红线冲突。）

## 7. 稳定性决定（架构研判）

| 维度 | 决定 |
|---|---|
| 挂起资源 | suspend 只在调用栈内；进模块前不得建浏览器会话（保持 `ctx.ts:1262-1291` 零会话行为）；stop 路径不耗执行预算、不触发 pace |
| 超时 | 默认无超时（TTY 现状没有，加了就是行为变更）；`suspendMaxMs` 缺省 0，显式策略才启用；超时 → `timeout` → `needs_human` + reason 带 `request_id` |
| 取消 | 模块不装 SIGINT 处理器（生命周期归 runner）；宿主传 `AbortSignal` → `cancelled`；进程退出 = 挂起丢失，**绝不 fulfilled** |
| 幂等 | `request_id = (run_id, seq)`；first-answer-wins，迟到的应答丢弃但记一条 trace；`fulfilled` 后 `done_criteria` 只验一次；不重复计预算 |
| 并发 | 状态全部实例化；`maxSessions=2` 只管 `amber session`，run 每次独立子进程；将来 GUI 通道必须 agent-scoped（DSH approval 是 scoped waterfall），否则并发会话答案错人 |
| 崩溃 | **落盘时机（v2 修正，「同 run-killed.json 先例」类比不成立——那是桥侧在 SIGKILL 前写的，引擎被杀时来不及落盘）**：stop 模式——request 唯一载体是 `result.rescue`，**不另写文件**（双写无意义）；suspend 模式——调通道**前**同步写 `outDir/rescue-request.json`（崩溃取证），outcome 落定后不删除；桥侧不改（桥禁止 suspend，kill 场景由桥的 run-killed.json 先例覆盖）。文件不含敏感值；v1 **不承诺** mid-flow resume（现 replay 是脚本调用重放而非浏览器状态恢复）；恢复 = 重跑；崩溃取证 = `{run_id, script_sha256, inputs_sha256, stop_code, step_id, final_url, request}` |
| 字节兼容 | 冻结三条人工路径：`ctx.manual` / journey runManualStep / executor `manualConfirmFn` null→`manual_needs_human`；通道接口不得收 `index`（journey 是声明步号、flow 恒 0），只能由 adapter 映射；**golden 规范化规则（v2 新增）**：「逐字节」比对前必须剔除/归零每次必变字段——显式列表：`elapsedMs` / `started` / 各类 `*_at` / `at` / `epoch` / `run_id` / 绝对路径中的临时目录段；golden 工具在步 2 第一个提交先落地并被**旧代码**跑通（基线先冻结，再动实现）；**双轨验收**：A 组（四条冻结人工路径 + 非 TTY 无 handler）逐字节；B 组（真实求援场景）逐字段断言——仅允许新增 `request_id` / `at` / `rescue` 节 / `rescue-request.json` |

## 8. 落地方案（五步，每步可独立验证）

| 步 | 内容 | 验收 | 回滚 |
|---|---|---|---|
| **0** | 合同 + 文本 + 层表登记（`ARCHITECTURE.md` §5、`IMPROVEMENT_PLAN.md` 方案 B 层表登记 L1.5——**按小节名锚定，不用行号**；层表行内写明 `src/intervention/` 依赖白名单 `node:* + support 两叶子`） | `typecheck` + import 白名单 review；无行为变化 | 删文件 |
| **1** | runtime + channels 纯新增（无调用点） | `npm run check` 全绿；**可扩张性机械断言（v2 新增）**：注册一个 `kind: "test"` 且不改编排代码，dry 路径全绿——把「一条注册+一条 texts+编排零改」变成可测试命题 | 删目录 |
| **2** | flow `ctx.manual` 通道解析接入（**最高风险**）：先**影子模式**再切默认；**先建 golden（v2 扩为六条人工路径话术基线：`start.ts:341` / `app-runner.ts:1203` / `ctx-dry.ts:429` / `app-runner.ts:1493` / `ctx-replay.ts:256` replay 桩 / report+agent-view 消费面）**。**影子模式三决定（v2 新增）**：① 影子期旧路径权威，新路径仅构造 `RescueRequest` 并记录「本会产出什么 outcome」的**计算值**，**不调任何交互通道**（杜绝 TTY 问两次人）；② 影子差异只写 sidecar 文件（`outDir/rescue-shadow.json`，挂独立开关 `AMBERFLOW_RESCUE_SHADOW=1`，默认产物零字节不变，不进 result）；③ 切默认门槛 = 影子期零分歧 + 五组 golden 逐字节（A 组），写死为可判定条件；不一致时以旧路径为准，影子只记录 | 影子期：默认产物逐字节 + shadow sidecar 仅开关开启时出现；切默认后：failfast / 非 TTY / handler / declined / signal_not_held 五组 `--json` 结果 + report 逐字节（A 组规则）；TTY 手工冒烟 | 单提交回滚 `ctx.ts` + adapter |
| **3** | journey / executor 接入（只换确认提供者，不改判定） | `manual_steps` / trace / report 逐字节 + plan 冒烟；步 3 验收含 `apps check`（dry 红线） | 同上 |
| **4** | texts 生成接线：`prompt-hit --fix`、schema 快照重生成、docs（**含 `MANUAL_STEPS_AND_PACE.md` / `AGENT_INTERFACE.md` rescue 章节 + CHANGELOG 条目**——首批用户需要「什么变了/什么没变」，v2 新增交付物） | `npm run check` 全绿 + `schema ctx --topic intervention` | 还原生成物 |
| **5** | 桥 stop 转述 + CLI flag：`--rescue/--no-rescue` 三处接线（`registry.ts` / `run.ts` / `app-runner-cli.ts`）；若做 env 必须进 `config-schema.ts` + 示例生成；**桥输出 schema 同步扩 `rescue` 键（桥 run 工具输出 schema 是 `additionalProperties:false`，不扩则透传不出去，v2 补）** | 同 app 同 slot 桥结果默认逐字节；开 flag 仅多 `rescue` 键 | 默认关 |

**明确不进本期**：GUI 确认通道（需要 `run` 双向 JSONL 控制协议——照 `amber session` 先例但涉及新常驻协议与 Windows 孤儿治理，成本高、单独立项；GUI 通道能力正向定义（v2）：**确认 / 给值 / 放弃三选一**，等价 TTY 的 Enter/n + 输入行；凡需在浏览器里动手的，GUI 只能显示指引，不能代操作）；×2 自动升级对外可见；全量停因文案接管。

**v1 收益正面表态（v2 新增，不再藏进风险表末行）**：v1 对终端用户可感知变化 ≈ 0 是**刻意决策**——五步是纯基建（统一四种方言投影、合同与文案单源、影子验证的安全切换），收益兑现在二期：GUI 确认通道、credential 保险箱 kind、断点续跑评估都以此为地基。v1 唯一新增的用户可见面 = 真实求援时的 `result.rescue` 键与升级文案（经桥透传给 Agent）。若评审追问「这期给用户带来什么」：答案是**消除四套方言的技术债 + 为下一个通道铺路**，不是即时体验提升。

## 9. 总验收

- `npm run check` 全绿（typecheck / config 示例 / schema check / prompt-hit / secret-scan / examples-check / test:validate）。
- **双轨 golden（v2 修正原「逐字节（除时间戳/run_id）」的自相矛盾）**：A 组（六条冻结路径 + 非 TTY 无 handler）按 §7 规范化规则逐字节；B 组（真实求援场景）逐字段断言——仅允许新增 `request_id` / `at` / `rescue` 节 / `rescue-request.json`。
- 三个端到端场景：① 登录人工步 TTY 通过 + 拒绝；② 缺值 `needs_value` 结构化停后补值重跑；③ 非 TTY 无 handler 时 `needs_human` 且 A 组零字节兼容。
- 新版 `result.rescue` 只在真实求援出现；桥 `summarizeRun`（`bridge.ts:982-987` 现只看 `manual_steps`/`script.stop_code`）有界透传，Agent 能看到「为什么需要人」。
- **读取端容忍性（v2 新增）**：下游读取端（report / agent-view / 桥）须容忍历史产物中的 `rescue` 节与孤儿字段——回滚后历史 run 的残留字段无害。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 概念过宽（危险确认/人工步/缺值都叫 rescue），稀释 fail-closed 安全语义 | kind 只做分类；确认不是求援；危险拒绝 v1 不挂起 |
| 一话两用（同一文案服务人与 Agent） | 四层分离 + `agent_hint` 独立结构化字段；语言矩阵（人话层永远 zh / agent_hint 跟桥合同）；Agent 转述以 `summary` 为基准（§6） |
| 迁移漏面（`executor.manualConfirmFn` 与声明式非 TTY 的 `manual_handler_error` 不在清单 → 两套方言） | golden 先行（六条，含 `ctx-replay.ts:256` 桩与 report/agent-view 消费面）；步 2/3 分别验收；冻结三条路径；adapter 不改写既有 reason 原文 |
| 超时/等待不当 → CI 挂住、TTY 被催 | 默认无超时；批处理立即 unavailable；桥禁止 suspend |
| `fulfilled` 被当绿 | done_criteria 复核是合同义务，复核失败结构化停 |
| dry/check 真弹窗 | dry 红线 + `ctx-dry` 桩；步 3 验收含 `apps check` |
| `needs_value`/危险拒绝升级为求援 → 控制流与安全语义被改（最高风险） | 二者只分类不挂起；步 5 前不改任何触发 |
| 升级阈值与 `STOP_ESCALATION_TEXT` 双源漂移 | 阈值与文案留在 `planning-playbook.ts` 单源（引擎层），模块只持原始计数；prompt-hit 断言 |
| 模块级计数器跨 run 串扰 | 禁止模块级变量；`createRescueState(run_id)` |
| 影子模式 TTY 二次问人 / 影子数据破坏逐字节 | 影子三决定（§8 步 2）：影子不调交互通道、sidecar 挂独立开关默认关、旧路径权威 |
| 桥生成物/工具描述变长改变模型行为 | 生成物 diff 逐条审查；flag 默认关 |
| 新 flag/env 漏同步 schema/示例/registry → check 红或静默无效 | 步 5 明确三处接线 + 示例生成 + 桥输出 schema 同步扩 `rescue` 键（桥 schema `additionalProperties:false`） |
| GUI 通道缺 agent 作用域 → 答案错人 | 延迟到独立立项；文档不承诺；GUI 能力正向定义（确认/给值/放弃三选一） |
| 无消费面的模块 = 零收益 | 至少接 `agent-view` next / 桥结果 / `result.rescue` 三处（步 2/3/5 已排）；v1 收益正面表态见 §8 末段 |
| credential kind 上线而保险箱未建 → 求援成功但值无处安放 | 依赖声明：保险箱未建前该 kind 不注册、不生成文案（§3） |
| 通道实现抛错冒泡绕过 Outcome 映射 | 模块兜底 catch → `unavailable` + reason 截获（§3） |

## 11. 不做什么（边界）

- 不做远程桌面 / 远程代操作；GUI 通道正向能力 = **确认 / 给值 / 放弃三选一**（等价 TTY 的 Enter/n + 输入行），凡需在浏览器里动手的只能显示指引。
- 不新增 stop code；不改 `status`/`exit code`/既有停因语义；**不改写既有 reason 字符串原文**（新文案只进 `rescue` 新键）。
- 不改危险动作默认拒绝；不让引擎在未声明时刻突然问人。
- 不接管既有 `STOP_NEXT` 全量文案；不新建提示词生成器（复用 prompt-hit）。
- 不承诺 mid-flow 断点续跑（v1 恢复 = 重跑）。
- 不用模块级全局状态；不装进程信号处理器。
- credential ≠ 保险箱代建（保险箱未建前 credential kind 不注册）。

## 12. 锚点索引（实现时查）

- 人工步现状：`src/app/ctx.ts:1257-1349`、`src/app/app-runner.ts:1192-1208,1456-1503,1602-1625,2286-2326`、`src/engine/executor.ts:4946-4964`、`src/cli/start.ts:341`、`src/app/ctx-dry.ts:429`、**`src/app/ctx-replay.ts:256`（v2 补：第五个 manual 桩，replay 路径）**
- 危险拒绝：`src/app/app-runner.ts:1408-1412`、`src/app/ctx-types.ts` 的 confirm 类型
- 停因/提示词：`src/engine/planning-playbook.ts:72-129`（`STOP_NEXT`/`EXEMPT_NEXT`/`STOP_ESCALATION_TEXT`）、`src/support/help-map.ts`
- 生成管线：`tools/prompt-hit.ts:14-40,129-166`、`integrations/dsh-bridge/src/grammar.generated.ts`、`src/cli/schema-gen.ts`（F 条目/`STOPCODE_MEANING`）
- 分层治理：`ARCHITECTURE.md` §2/§5、`docs/IMPROVEMENT_PLAN.md` 方案 B 层表（小节名锚定）
- 产物形状：`src/app/agent-view.ts:125-208`、`src/app/app-report-view.ts:202-208,285-287`（人工步文案消费面）、`integrations/dsh-bridge/src/bridge.ts:982-987`（`summarizeRun`）
- 桥稳定性：`integrations/dsh-bridge/src/bridge.ts:583-647,832-855`（`stdio` + 900s SIGKILL + `writeRunKilledEvidence` 桥侧先例）、`integrations/dsh-bridge/src/session.ts:30`（`maxSessions`）
- 既有合同：`docs/MANUAL_STEPS_AND_PACE.md`（§2 凭据保险箱「待建产品能力」）、`docs/PROMPT_SYSTEM.md`、`docs/AGENT_INTERFACE.md`
- 会话常驻协议先例（GUI 通道若立项）：`amber session` 的 JSONL 协议（`docs/INTERACTIVE_SESSION.md`）
