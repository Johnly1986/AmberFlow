# 架构重审：健壮性 / 易用性 / 可扩展性（含执行层三段化提案）

> 本文**不预设原有设计正确**。每条既有决策都被重新裁定成三档之一：**保留**（原则）/ **收窄**（原则对、措辞过宽）/
> **推翻**（实现细节被写成了架构原则）。每条都带可复算的证据。
>
> 本轮未改任何 `src/` 代码。可复算入口见 §9。本文取代并扩展 [EXECUTION_LAYER_SPLIT_PLAN.md](EXECUTION_LAYER_SPLIT_PLAN.md)
> （那份只回答了"三层能不能拆"，这份回答"原来的架构哪里不对、该怎么改"）。

## 0. 一句话结论

**执行层的真正问题不是"少了一层命令层"，而是一个约 550 行的函数（`run()`，在 1689 行的 `executor.ts` 里）
把"实例化动作空间 / 选择 / 应用动作"三件事揉在同一个可变状态机里**；用户提的"命令层 / 数据槽层 / 决策层"恰好就是这三件事的正确切法。

> **勘误（本轮）**：初稿把命令层整体标成"编译期（纯函数，不碰页面）"，但它的输入里有**元素池**——
> 池只有运行期才有，所以那个签名与那个标签自相矛盾。命令层必须拆成**声明半（加载期）**与
> **实例化半（运行期）**两半，候选列表产生在后者。详见 §6.1。
切完之后"多动作一步""分支""更小的提问"是**副产品**，不是要另外发明的能力。

## 0.1 三条前提修正（本轮，来自项目方）

这三条**改变了本文若干结论**。逐条列出被推翻的部分——不假装它们只是补充说明。

### 前提 A｜应用没有分享价值，也不应进项目仓库

- **现状证据**：`tools/learn.ts:626` 默认把用户录的包写进 `<repo>/apps`；`src/app-pack.ts:28` 的 `APPS_DIR` 也指向仓库内；
  全项目**没有用户作用域目录**的概念（`homedir()` 只用于 playwright 浏览器与 HF 缓存的查找）。
- **后果**：应用配置是**用户本地产物**，仓库里的 `apps/` 只是开发夹具。落盘默认必须移出 checkout
  （例如 `$AMBERFLOW_HOME/apps`），并新增为 P0 的一项。
- **被推翻的结论**：§8 风险 4 里"新字段不许让 8 个生成包漂"降为**夹具级**约束——它保护的是回归语料，不是用户的包。
  真正的问题变成 **schema 版本与兼容**：引擎会演进，用户的配置不会，所以 `spec_version` + 显式迁移（迁移不了就**响亮拒绝**）
  是引擎的责任，而 CI 盖不到用户的包。
- **变强的结论**：[AUTHORING_ASSESSMENT.md](bench/AUTHORING_ASSESSMENT.md#L13-L16) 那条"61% 该是生成物"更硬了——
  **最终用户不会手写 200 行 JSON**。录制（`learn`）与生成（`plan:flow` / `apps:gen`）是主路径，手写 pack 只是开发期的手艺。

### 前提 B｜命令集应包含在应用配置中

- **这直接推翻本文初稿的一句话**：初稿在图上写"动词表是代码，不是配置"。正确结构是：引擎提供**能力面**
  （原语 + 观察形状 + 证据语言），**应用配置声明自己的命令集**（引用已注册的原语 + 参数槽 + 完成信号 + 顺序/分支），
  引擎只做**加载期校验**（未知 surface / 原语 / 参数键 / 算子 ⇒ 报错）。
- **为什么这样仍然可测**：这正是本项目**已经验证过**的模式——`sources/*.json` 就是"配置引用已注册的 4 个抽取器
  + 6 个 transport 键"，未知键在加载期失败。§七.10 反对的"无法测试的字符串程序"指的是**循环的健壮性规则**，
  不是**能力清单**。分界线因此改写为：**循环与能力面是代码；命令集在应用配置里。**
- **连带**：CLAUDE.md 那条「引擎不认识站点」的单测口径要从"站点名"扩展到**任何面的标识符**
  （hosts / 二进制名 / 路径）——应用出仓库之后，它是跨面唯一的防泄漏防线，而且更重要了。

### 前提 C｜这不是只服务浏览器的项目，浏览器只是起点

- **现状证据**：执行循环叫 `BrowserMiddleware`、④ 层的"候选"= 元素池、完成信号 = 5 个 DOM 算子。
  但**两个面已经存在**：浏览器面 + 命令行面，后者自带 [src/tool-signals.ts](src/tool-signals.ts)——
  这个文件的存在本身就是"**证据语言按面不同**"的既成事实。
- **后果**：把 `tool-signals.ts` 与 `datasource.ts` 的 transport 注册表当成**同一个抽象的第二个实例**，而不是特例。
  执行循环、命令层、数据槽层、决策层**都与面无关**；每个面提供 (原语, 观察形状, 证据语言)。
- **连带**：④ 层的"候选列表"应改称**候选集**（来自该面的观察）；红线③ 从"DOM / 工具信号"改成
  **"该面的证据"**；`BrowserMiddleware` 这个名字本身是待偿还的债。

## 1. 体检数据（全部可复算）

| 指标 | 数值 | 复算 |
|---|---|---|
| `src/executor.ts` 单文件行数 | **1689**（`run()` 本身约 549 行 = 1140–1688，其中步循环约 467 行 = 1208–1675） | `wc -l src/executor.ts` |
| 一个 ref 被"禁止"的落点 | **7 处** | `grep -c "forbidden\[.*\] = esig" src/executor.ts` → 1234/1497/1509/1531/1554/1661/1673 |
| `stopReason` 赋值点 | **12 处**（自由文本） | `grep -c "stopReason = " src/executor.ts` |
| `continue` / `break` | **20 处** | `grep -c "^\s*continue;\|^\s*break;" src/executor.ts` |
| `trace.push` 形状 | **7 种**（各自拼字段） | `grep -c "trace.push" src/executor.ts` |
| "一步"的载体 | **4 个**，字段集互不相同 | `app-pack.ts:69-76` / `plan.ts:15-28` / `semantic-flow.ts:76-93` / `flow.ts:29-39` |
| hint 语法的实现 | **2 处**（已漂移 2 次） | `rules.ts:160-258` + `extraction.ts#hintLookup` |
| 互不相连的预算数字 | **3 个**：40 / 120 / k=8 | `extraction.ts:171` / `executor.ts:355` / `executor.ts:739` |
| 敏感字段遮蔽 | **0 处** | `grep -c "password\|secret" src/extraction.ts src/executor.ts` → **0** |
| `hosts` 的运行期强制 | **0 处** | `hosts` 只出现在 `app-pack.ts:114,359-363`（加载校验）与泄漏门禁；`executor.ts`/`app-runner.ts` 零命中 |
| 声明行中"机器本该生成"的比例 | **61%**（1797/2965 行） | [AUTHORING_ASSESSMENT.md](bench/AUTHORING_ASSESSMENT.md#L13-L16) |

## 2. 健壮性缺陷（D）

**D1｜没有单一出口的状态机。** 一个 ref 可以在 **7 个不同地方**被禁止（缺值、遮挡、执行失败、风险被拒、
inert、anti-repeat……），每处的 `trace.push` 形状都不一样；终止有 **12 个**自由文本 `stopReason`。
⇒ 加第 8 种失败模式必须同时改 7 处禁止点、12 处措辞、7 种 trace 形状。已付过的学费：
"`occludedReason` 注释写的是'让下一步重试'，代码却在拉黑"（[LONG_FLOW_REPORT.md:109](bench/LONG_FLOW_REPORT.md#L109)）——
注释与代码漂移，因为同一件事没有一个出处。

**D2｜位置性 ref 与跨扫描不变量被重复实现。** `forbidden` 是 `ref → 元素签名` 字典，ref 每次扫描重新编号，
所以每处重扫都要重新修剪一次：循环头（`executor.ts:1265-1272`）、加宽重看（`1390-1397`）、遮挡重入（`1299-1305`）
——**三处独立实现同一条不变量**。少写一处就是"禁止了另一个元素"。

**D3｜inert 同时承担"证据"和"终止责任"。** inert 是整页快照比对（url+text+**所有输入值**，`executor.ts:322-325`、`1563`）。
噪声大时**双向失灵**：页面上有个时钟/轮播 → 永远"不 inert" → anti-repeat 不触发 → 烧到 `max_steps`；
只改了 class 或异步生效的点击 → 误判 inert → 禁掉一个有效元素（实测：live saucedemo 的汉堡菜单点击
**确实是 inert**，`executor.ts:1596-1608` 的注释自己记着）。**一个噪声信号不该是循环唯一的终止依据。**

**D4｜`stop_reason` 是散文，不是数据。** 12 处自由串；下游（`apps:suite` 退出码、DSH 桥、报告、危险步拒绝）
只能靠字符串匹配，于是不得不再造一个 `REFUSAL_LABELS` 来统一说法。backlog 的 **R-4**（"no-progress stop 必须与
`max_steps` 分开"）撞的是同一堵墙。

**D5｜安全与边界的两个真空。** ①**敏感字段零遮蔽**：`grep password` = 0，而 `VALS_JS` 读走**每个** input 的
`.value`，且 trace 把填进去的值写成 `value:` 字段（`executor.ts:1565`）→ 报告与 `-result.json` 里会有明文；
② **`hosts` 运行期不强制**：包可以导航到任何主机，`hosts` 只是加载期类型校验 + 泄漏门禁的输入
（backlog **R-5** 记着，尚未做）。

**D6｜配置类错误被当瞬时错误。** backlog **I-1**：产物路径错 → 数据腿与第一个工具步**已经执行**、
同一配置错误**被重试 2 次**。健壮性原则"动作失败是结果不是异常"用对了，但**"配置错误不是失败"**这一条没落地。

## 3. 易用性缺陷（U）

**U1｜作者拿不到反馈。** 要写 `target_hint`，必须先让执行器**渲染一次页面**（`snapshotText` 复用
`criteriaView`，`planner.ts:31-34`）；写错了只有跑到那一步才知道。hint 语法 6 种形态、2 处实现（D6 同源）。
这是"作者写 → 复核方逐字段验"流程成本的一半来源。

**U2｜新增能力要改 4 个载体。** `when`/`retries` 在 pack 步和 `Subgoal` 有；`dangerous` 只在工具步和
`CompiledStep` 有，`Subgoal` 没有（浏览器步写 `dangerous` 加载期报错）；pack 步的 `id` 是**死字段**（无人读、
`TaskPlan` 不保留）；`Subgoal` 没有超时/步数/模型字段。⇒ 任何新字段都要问"4 个载体各改哪几个 + 哪个校验器"。

**U3｜真判断只剩 31 条，但手写面还很大。** [AUTHORING_ASSESSMENT.md](bench/AUTHORING_ASSESSMENT.md#L13-L16) 实测：
2965 行声明里 61% 是机械展开，**真正必须人写的只有约 31 条**（29 条不变量 + 1 个设备 + 1 个危险动作）。
生成器已消掉 8 个应用的手抄。**任何"再给作者加一个手写面"的提案都必须先解释这 61%。**

**U4｜说明书本身超预算。** backlog **C-4**：`CLAUDE.md` 被工作区指令预算截断（~71 KB → 65 KB），
读者只看到截断后的部分。**本轮实测复现**：本次会话的指令就是 `78182 → 65143` 字节截断。

## 4. 可扩展性缺陷（X）

**X1｜"一步 = 一个指针"。** 一步只能点名一个目标（`target_hint`）或一张有序表（`target_hints`），
于是"多动作"只能靠 `target_hints` 的顺序+推进（`executor.ts:1257-1282`），而**同一元素第二次点就是 inert**。
代价有账：状态必须写进 URL、筛选/排序拆成三步、**"勾选+提交放进一个子目标"至今不可表达**
（[ARCHITECTURE.md:218-223](ARCHITECTURE.md#L218-L223)）。

**X2｜流程控制的三个特例，其实是一个概念的碎片。** `when`（不适用→跳过）、`retries`（失败→整步重来）、
`target_hints`（动作序列）三条各自实现，都是"这一步的动作空间 + 之后往哪走"的特例。
[docs/architecture.svg](docs/architecture.svg) ④ 层 10 个盒子里 **4 个在选目标、1 个做动作、0 个定参数**，是同一件事的图形化。

**X3｜"候选"没有名字，所以三处各造了一个。** 元素池（40）、加宽池（120）、shortlist（k=8）三个数字互不相连；
规则层内部**已经有**分层（`rules.ts:188-192`、`233-256`）却在出口**塌缩成 `null`**；backlog 的 **R-2**
（视图优先级/delta 渲染）与 **R-3**（可行性标注 + 禁用项永不作候选）是同一件事的两次独立提案。

**X4｜`max_steps` 是每步的，不是每路径的。** 一旦允许"一步多动作/分支"，`maxSteps=8` 就不再是上界；
`confFloor` 随 `forbidden.length` 线性衰减（`executor.ts:1355`）也是无出处的经验常数。

## 5. 三档裁定（这一节是本文的重点）

| # | 原有决策 | 裁定 | 理由（带证据） |
|---|---|---|---|
| 1 | **永不重新规划**（红线①，[ARCHITECTURE.md:22](ARCHITECTURE.md#L22)） | **收窄** | 真正的红线是**验证**，不是**冻结**。项目已经在运行期获取知识两次：hint 回填环（staged → 整跑零模型重放 → 才落盘，`semantic.ts:257-372`）、`learn` 的"演示→归纳→规则模式回放不过不落盘"。它们做了同一件正确的事：**新知识必须先被确定性复现证明**。所以红线①应改写为：**计划结构在任务开始冻结；运行期只允许「闭集内选择」与「过门的回填」**。这条改写**打开**了用户提案的门，而一个字都没放松可复现性。 |
| 2 | **永不编造值**（红线②） | **保留 + 加强** | 这条是唯一挡住"模型选值"的机制。加强方向：数据槽层的页面候选**必须由声明式规则命中**（`by: value\|label\|contains\|min\|max`），模型**永远不参与选值**。这正是 `list_step`→`selectIndex` 已证明的模式，且浏览器侧与数据侧共用同一实现。 |
| 3 | **不信模型说完成**（红线③） | **保留，砍掉浪费** | DOM 信号唯一真相不动。但"没有信号时才问 noul"（`executor.ts:1650-1657`）那次前向的唯一产出是一句散文（`laya claims done but no DOM signal to verify`）——在 CPU 上 0.5–1 s 买一句话。降级为诊断开关。 |
| 4 | **不可复现即拒存**（红线④） | **保留 + 扩展** | 从"落盘门槛"扩展为**任何运行期新知识（学到的 hint / 候选集 / 分支选择）的通用门槛**。这条是①能收窄的前提。 |
| 5 | **执行循环刻意不配置化**（§七.10） | **收窄** | 原文理由（"配置化只会得到一份无法测试的字符串程序"）对**健壮性规则**成立（探针顺序、inert、禁止、信号求值必须留代码）；但对**动作空间**不成立——`device`、`when`、`retries`、`target_hints` 都是"声明 + 代码校验"且全都成功。分界线（按前提 B 修正）：**循环与能力面是代码；命令集在应用配置里**。项目自己的 `sources/*.json` 就是"配置引用已注册原语 + 加载期校验"的既有证明。 |
| 6 | **一个子目标只有一次点击 / 状态写进 URL**（§七.9） | **推翻** | 这不是原则，是"一步一个权威 hint + 每步重新 `goto`"的**实现后果**被写成了架构原则。它已经产出 3 处 workaround（拆步、状态入 URL、`selected=all` 跳转）+ 2 处未解边界（勾选+提交、内存态站点）。命令层直接消除成因，**不需要动 `goto` 语义**。 |
| 7 | 元素池 40 / 加宽 120 / k=8 | **合并** | 三个数字是**浏览器面**的观测值，不是原则。保留其中唯一的原则：**计划点名的目标永不被预算吃掉**（`hintLookup` 回捞，已有单测）。其余合并为按面成立的一个概念：**该面的「观察 → 候选集」规模**，由动作空间决定，不由元素池决定。 |
| 8 | 动作失败是结果不是异常 | **保留** | 这条是 D6 之外全部健壮性的地基，实测救过整个计划（Playwright 超时曾杀掉 zh.wikipedia 整个用例）。 |
| 9 | 冻结计划必须点名目标（hint 权威） | **保留，但换载体** | "hint 权威"这条**必须**留（删掉它换回过 22 步 `max_steps` 的实测事故）。要换的是**载体**：从"两处实现的字符串语法"换成"一处解析的结构化句柄"，并保留字符串语法的兼容读取。 |

## 6. 提案：把"一步"从**指针**改成**动作空间**（= 用户的三层）

### 6.1 结构性切法（这是本文的主提案）

把 `run()` 里的隐式流水线显式切开。**命令层必须写成两半**——这一点是本轮被指出来的错误修正：

```
// 命令层 · 声明半 —— 加载期/编译期：纯数据 + 代码，可审计、可 diff、进 plan_sha256
decl     = declareSpace(step)                    // 动词表(代码) + 这一步允许的 op/参数槽/候选来源规则
                                                 //   未知动词/键/来源 ⇒ 加载期报错

// 命令层 · 实例化半 —— 运行期：「此刻有什么」只能是观察，候选列表在这里产生
space    = instantiateSpace(decl, pool, slots, state)   // 声明 × 当次元素池 ⇒ space.live
                                                 //   解析不到的候选出局；不符 ⇒ space-empty，不退回全池

decision = decide(space, state, runtime)         // 运行期：只读，唯一会问模型的地方
outcome  = apply(page, decision, guards)         // 运行期：只做动作，不做决策
```

> **为什么不能"纯运行时"**：候选完全由运行期枚举 = 没有声明 = "这一步允许什么"由代码里的启发式决定，
> 作者无法声明、加载期无法报错 —— 那正是今天的样子（④ 层 4 个盒子在选目标、0 个在定动作空间）。
> **为什么不能"纯编译期"**：候选依赖当次元素池，池只有运行期才有 —— 纯编译期只能得到写死的站点选择器。
> 两半的分界线不是"阶段偏好"，而是**「允许什么」是数据，「此刻有什么」是观察**。

| 用户提法 | 本文切法 | 阶段 | 权威 | 失败行为 |
|---|---|---|---|---|
| **命令层 · 声明半** | `declareSpace` | 加载期（**应用配置**） | **应用配置**声明"这一步允许哪些命令、哪些参数槽、候选从哪来"；引擎对着能力面校验 | 加载期报错（今天 `PlanningRules.problems` 的位置）；版本不认识 ⇒ 响亮拒绝 |
| **命令层 · 实例化半** | `instantiateSpace` | **运行期** | 声明 × 元素池 × 数据袋 → `space.live`（**候选列表在这里产生**） | 声明与页面不符 → 结构化 `space-empty`，**不退回全池** |
| **数据槽层** | 绑定（`space` 里的参数 + 运行期取值） | 绑定期（运行期） | 值的来源与**声明式选择规则** | 缺值 → `needs_value`（今天已有的正确行为） |
| **决策层** | `decide` | 运行期 | 只能在 `space.live` 内**选下标** | 选不出 → `blocked` + **结构化**原因（顺带修 D4） |

**关键：这三段不是"新能力"，是既有逻辑的重新装箱。** 阶梯顺序一个字不改：
`hint → rule → laya → reobserve → escalate`（`method` 的四个取值原样保留，报告与对拍语料不受影响）；
变的只是它们**在什么之上选择**：从"40 个元素"变成"若干命令 × 若干参数候选"。

### 6.2 与用户提案的三处修正（都有实测依据，不是偏好）

1. **候选列表不由人手写，由编译器枚举。** 作者评估实测：61% 的声明行是机械展开、真判断只有 31 条
   （[AUTHORING_ASSESSMENT.md](bench/AUTHORING_ASSESSMENT.md#L13-L16)）。所以命令/参数候选必须**从已有的意图声明
   编译出来**（spec 的 role/hint、pack 的 journey、flow.json 的语义目标），人只声明**语义意图**。
   否则就是在已经被证明该缩小的手写面上再加一层——**这条是本轮对提案最重要的修正**。
2. **参数候选里，模型不许选值。** 只有声明式规则（`by`）能在页面候选里挑；用户参数与计划槽位是**绑定**，
   不是候选。这是红线②在数据槽层的落地形式，也是唯一能防"模型编值"的机制。
3. **"下一步走向"最后做，且必须是声明式后继。** `next` 是编译期就存在的边（运行期只选走哪条），
   不是运行期生成命令。理由：红线① + 今天 `Subgoal` 无 `next` 字段（4 个载体都要改）+ `max_steps` 不是路径上界（X4）。

### 6.3 示意形状（**全部可选；不写时展开结果逐字节等价**——8 个生成包 + `plan_sha256` 是硬约束）

```jsonc
// 今天：一步 = 一个指针
{"desc": "填写查询词", "signal": {"css_value_equals": ["#q", "asyncio"]}, "target_hint": "#q"}

// 提案：一步 = 一个动作空间（编译物，不是手写物）
{"desc": "填写查询词",
 "signal": {"css_value_equals": ["#q", "asyncio"]},
 "space": [
   {"id": "fill-q", "op": "fill",  "target": {"by": "id", "v": "q"}, "value": {"from": "slot", "key": "query"}},
   {"id": "submit", "op": "click", "target": {"by": "attr", "k": "type", "v": "submit"}},
   {"id": "skip",   "op": "skip"}
 ],
 "select": {"by": "rule", "order": ["fill-q", "submit"]},   // 或 {"by":"model"}（闭集内选）
 "next":   ["step-3", "step-5"]}                            // 可选；声明式后继（分支）
```

参数三种来源（模型都不选值）：

| 来源 | 形状 | 今天的前身 |
|---|---|---|
| 用户参数 / 计划槽（**绑定**） | `{"from": "slot", "key": "query"}` | `--slot k=v`（`app-runner.ts:582-595`，键未声明即 exit 2）、`plan.slots` |
| 页面候选 + **声明规则** | `{"from": "option", "match": "value", "key": "checkin"}` | `<select>` 的 label→value 两候选（`executor.ts:1052-1057`） |
| 列表行 + 数据规则 | `{"from": "list", "order": "min", "by": "price"}` | `list_extract` → `selectIndex`（`datasource.ts:962-984`） |

## 7. 迁移顺序（按"性价比 + 现成验收台"，不按理论优雅）

| 阶段 | 内容 | 修哪个缺陷 | 验收台（已有） |
|---|---|---|---|
| **P0** | **不改行为，只改形状**：① 禁元素收敛为**一个出口** `_forbid(ref, reason)`；② `stop_reason` 变 `{code, step, detail}` 枚举（人读串照旧）；③ 敏感字段遮蔽（`password/file/hidden` 值置空 + 报告打码）；④ `hosts` 运行期强制；⑤ 配置类错误预检且**永不重试**；⑥ **应用落盘移出 checkout**（用户作用域 + `spec_version` 兼容/迁移） | D1 D4 D5 D6 + 前提 A | `npm run verify` + `apps:suite` + `apps:matrix`；③④⑤ 各加一条负例（含 password 夹具页、`evil.example` 步骤、坏产物路径**零副作用**） |
| **P1** | **target 结构化 + hint 单实现**：`rules.ts` 的 6 种语法保留读入，解析成一处结构；**出口携带 tier 候选集**而不是塌缩成 `null` | D6 X3 U1 | 六层对拍（冻结语料）+ 线上包 A/B；现状数字：歧义步 0.23 阻塞 / 0.29 硬币 |
| **P2** | **`src/actions.ts`（命令层）**：动词表（代码）+ 从声明编译 `space`；先只支持**一个用例**：一步多动作（SkyBook"勾选+提交"，今天不可表达） | X1 X2 X3 | `transfer-skybook` 用例从不可表达 → 可表达；`transfer-farehaven` 的 `when` 负例（删守卫即红）必须仍成立 |
| **P3** | **`src/bindings.ts`（数据槽层）**：先接 `<select>` 与 `list_extract` 两处**已有前身** | U3 X3 | 未声明规则 ⇒ `needs_value`（不是猜）；radio 反例单测仍绿 |
| **P4** | **`next` 声明式后继（分支）** | X4 | **只有 P2/P3 有数字后才决定做不做**；人工构造的环必须跑出显式 `stop_reason`（不是挂死） |

**P0 优先的理由**：它**不改变任何运行结果**，却把后面三步的地基（单一出口、结构化原因、闭集不可逃逸）先立起来——
反过来先做 P2 会把新的失败模式灌进一个 7 出口的状态机。这与 backlog 的排序不冲突：**R-2/R-3/R-4 与 P1/P2 是同一件事的两种写法**，
建议合并立项，避免两套并行。

## 8. 风险与红线（扩展后）

1. **新增决策点 = 新增不可复现来源**。⇒ 每一层的新决策都必须被 `decision-cache.ts` 的精确指纹覆盖，
   且必须通过"零模型重放门"才算可用（红线④扩展版）。
2. **闭集不可逃逸**：决策层返回集合外的 id ⇒ **拒绝并如实记录**（与 `llmEscalator`"不是展示过的 ref 就弃权"
   同一条测试模式，`planner.ts:126-128`）。这是红线①收窄后唯一的补偿性约束。
3. **两套语法不许出现第三套**：`space`/`bindings` 的校验必须复用 `signals.ts` / `tool-signals.ts` 与
   **同一个** `PlanningRules.problems` 走查器。项目为语法漂移付过两次学费。
4. **兼容优先于"不漂"**（按前提 A 修正）：应用配置在仓库外、随用户走，而引擎会演进——
   新字段必须**缺省等价**（老配置在新引擎上行为不变），版本不认识就**响亮拒绝**而不是猜着跑。
   仓库内夹具（`apps/` + `apps:gen --check` + `transfer` 对拍 + smoke 3b/3c）的"逐字节不漂"降为**夹具级**约束。
5. **`inert` 降级要先实测**（D3）：把终止责任从 inert 移交给"信号 / 闭集耗尽 / 步数上界"之前，
   必须先有"死元素当目标"的夹具证明新上界能早停且理由不同（backlog R-4 的验收方式）。
   —— **本轮已兑现**：`maxEffectiveRepeats`（缺省 3）+ 结构化 `no_progress`，A/B 实测见 §11
   （8 步 /`max_steps`/4.5 s → 4 步 /`no_progress`/2.3 s，同一份夹具）。

## 9. 复算入口

```bash
wc -l src/executor.ts
grep -c "forbidden\[.*\] = esig" src/executor.ts      # 7
grep -c "stopReason = " src/executor.ts               # 12
grep -c "^\s*continue;\|^\s*break;" src/executor.ts   # 20
grep -c "trace.push" src/executor.ts                  # 7
grep -c "password\|secret" src/extraction.ts src/executor.ts   # 0
grep -rn "hosts" src/executor.ts src/app-runner.ts    # 0（运行期不强制）
grep -rn "STEP_KEYS\|TOOL_ONLY" src/app-pack.ts       # 4 个载体各自的字段集
npm run verify && bash bench/smoke.sh                 # 改动的守门
npm run apps:suite && npm run apps:matrix             # 行为与成本账单
```

## 10. 本轮不做 / 需要裁定

- 未改任何代码，未重跑门禁，未声称任何收益已被实测；
- 未给 P0–P4 排期（门槛是 P0 的形状改动落地 + P1 的 A/B 数字）；
- **需要裁定**：① 红线①改写为"计划结构冻结 + 闭集内选择 + 过门回填"是否接受？
  ② §七.9"一个子目标一次点击"是否同意推翻？③ P0 直接开工，还是先把 P1 的 A/B 台搭起来？
  ④ `space`/`bindings` 放 `src/` 共享层（新模块）还是先作为 `app-pack.ts` 内部编译产物试一轮？

## 11. 实施状态补记（同日，按本文 §7 顺序落地 P0 + P1 + P2）

**P0 已实施**（"不改行为只改形状"逐条兑现，`npm run verify` 全绿 + `apps:gen --check` 8/8 不漂）：
① 禁元素收敛为单出口 `forbid/unforbid/pruneForbids`（7 写入 / 3 re-prune → 各 1 处，源码结构守卫测试钉死）；
② `RunReport.stop_code`（`StopCode` 枚举）+ `stop_step`，人读串照旧（parity 语料逐字节）；
③ 敏感字段掩码（快照/trace/报告/归纳 witness；按长度掩码保住 inert 判定，信号读真实 DOM 不受影响）；
④ `hosts` 运行期强制（`disallowedHost`：goto 前拒绝 = 0 步 0 副作用、动作后越界即结构化停止、空声明不启用）；
⑤ 配置类错误启动期预检（`preflightConfig` 在任何腿之前）+ `NEVER_RETRY_CODES`（实测旧行为：坏产物路径
跑掉数据腿与首个工具步、同一错误重试 2 次）+ `LAYA_ONNX_MODEL` 优先级与 `model-artifacts` 单一口径并轨；
⑥ 应用落盘移出 checkout（`src/amberflow-home.ts`，`$AMBERFLOW_HOME/apps` 缺省；learn/plan:flow 默认用户作用域，
发现制 `[用户目录, 仓库夹具]` 同 id 用户赢；`spec_version` 响亮拒绝照旧）。
负例：`tests/executor-p0.test.ts` 21 条（含 D1/D2 结构守卫、掩码负例、`evil.example` 干净拒绝、坏产物路径零副作用）。

**P1 已实施**（门控 `tieredHint` 默认 OFF = 行为逐字节；`tests/rules-tiered.test.ts` 24 条）：
6 种语法收敛为单一走查器 `hintMatchImpl`，`hintMatch ≡ firstIfSame(hintCandidates)` 由 20 例差分逐形状钉死；
档内歧义出口携带候选集不再塌缩成 `null`；打开门控后模型收到**更小提问**——实测同一歧义页
OFF 问 15 条候选、ON 只问 3 条，窄问弃权即回退整池；阶梯四个 `method` 取值与 `apps:suite` 结论一字未动。
出口打通：CLI `--tiered-hint`、DSH 桥 `tiered_hint`（新守卫：不传新开关时默认 argv 逐字节不变）。

**P2 已实施**（命令层 `src/actions.ts`；门控 = `commands` 字段本身，不声明逐字节不变；`tests/actions.test.ts` 15 条）：
声明半 = `COMMAND_OPS`（引擎能力面，代码）+ `validateCommands` 由同一个 `PlanningRules.problems` 走查
（未知 op / 重复 id / fill 缺绑 / 参数来源非 slot ⇒ 加载期红，§8.3 无第三套语法）；
实例化半 = `instantiateSpace` 纯函数（声明 × 当次池；解析不到出局，全空 ⇒ 结构化 `space_empty`，
**绝不退回全池、绝不问模型**）。红线② 在命令层的落地：`fill/select` 的值只按名绑计划槽位
（`resolveCommandValue`），缺绑 ⇒ `needs_value` 结构化停并进 `NEVER_RETRY_CODES`。
**§7-P2 的验收台兑现**：SkyBook"勾选+提交"放进**一个子目标**——真 site2 夹具上 2 条 executed 命令
（`command: [check, record]`、方法全 `rule:match`、选择提问 0 次、`#hotel-recorded` 落账）；
旧 8 个生成包一字未动（`apps:gen --check` 8/8、六层对拍全绿），§七.9 的"仍未解决"就地改写为"已开口子"。

**§9 复算口径的变化**：`grep -c "forbidden\[.*\] = esig" src/executor.ts` → **1**（助手内部那一行）；
`stopReason = ` 的直接赋值只剩初始化 + `stop()` 内部两处；其余数字（trace.push 7 种等）未变——P0 没碰 trace 形状。

**P3 已实施**（数据槽层 `src/bindings.ts`；门控 = 绑定形状本身，不声明逐字节不变；`tests/bindings.test.ts` 17 条）：

- **三条来源，都必须声明点名**（红线②的落地形式）：`slot`（计划数据袋）、`option`
  （当次观察到的页面候选 + `match: value|label|contains`）、`list`（行集 + `order: min|max`）。
  `option` 不给 `match` ⇒ 加载期红（"看着像就填"就是猜）；`list` 挂在命令上 ⇒ 加载期红
  （没有 op 消费"行"，它属于数据腿）。
- **分档匹配、档内歧义即弃权**：把 P1 的 tier 纪律从"元素"挪到"值"——唯一命中才采纳，
  一档里 >1 个候选返回失败。**§7-P3 的两处前身接线完成**：`<select>` 的 label→value 两候选回退
  变成 `{from:"option", match:"value"|"label"}`（候选在绑定那一刻**现读**页面）；`list_step`
  的选择改由 `resolveBinding({from:"list",…})` 表达，内部仍是 `datasource.selectIndex`
  （一份实现，`selects`/`list_step`/命令绑定共用），`semantic-flow` 里的 `min|max` 词表已删。
- **验收台**：`apps/checkin-binding`（真夹具：机器值 `2026-10-13` ≠ 人读标签 `10月13日 周二`）
  一条 `select` 命令 + 一条确认命令、零模型选择提问；负例是"规则命不中 ⇒ `needs_value` 且
  页面一个字没改"。顺带补了一处**静默假红**：`{slot}` 占位符以前只在 journey 替换，
  `invariants` 里写 `{checkin}` 会拿字面量去比对——现在与 journey 同一套规则（未知占位符加载期红）。

**P4 已实施**（声明式后继 `next`，应用旅程层；默认缺省逐字节等价；`tests/path-next.test.ts` 14 条）：

- **边在编译期**：应用步的 `id` 从死字段变活（`next` 的落点）；加载期校验 id 唯一 + 落点存在。
- **运行期只选走哪条**：按声明顺序取第一个"此刻适用"的候选，适用性 = 该步自己的 `when`
  （与"这一步适不适用"同一个问题、同一套信号语言、零模型参与）。`when` 被问两次（选边时在来源页、
  进入时在目标页），所以跨页分支的守卫必须是"页面角色级"的事实；被边跨过的步记成 `skipped`
  并单列 `path_crossed`，否则任何前向分支都会因为"跨过的步留在 pending"而永远红。
- **§5.1 的硬约束兑现**：`plan.createPathWalk` 是走向的唯一实现，带 per-step 访问计数与
  **路径上界**（缺省 3，包可声明 `max_step_visits`）；到顶 = 结构化
  `path_stop.code = "next_cycle"`（§7.2 负例 4：不是挂死、不是栈溢出）。走过的次数进报告
  （`path_visits`），回边不是隐形的。
- **验收台**：`apps/cold-search-next` —— 冷启动搜索的**回边**（`search` 走两遍后走向 `record`）；
  **删 `next` 即红**（§7.2 负例 5 的手法：record 的 `when` 不成立 → skipped → 不变量不成立）；
  无条件自环跑出 `next_cycle`。**边界**：`runPlan` 用的是 resume 队列语义，对 `next`
  **响亮拒绝**（静默忽略一条边 = 作者以为写了分支而实际什么都没发生）；语义流模板的步骤键白名单
  里没有 `next`，因此 `flow.json` 侧也不存在"写了不生效"。

**D3 + R-4 已实施**（`inert` 不再是循环唯一的终止依据；`tests/no-progress.test.ts` 5 条）：

- **缺陷**：`inert` 是整页快照比对，页面上有倒计时/轮播/埋点回执时它**永远不成立**——"这个元素
  没用了"的证据链断掉，anti-repeat 不触发，同一个死按钮被反复点，最后报告把病因写成 `max_steps`。
  一个噪声信号不该是唯一的终止依据（本文 §2-D3），backlog R-4 要的正是"卡住"与"预算用完"分开说。
- **做法**：`MiddlewareOptions.maxEffectiveRepeats`（缺省 3，**0 = 显式消融**回到今天的行为）——
  在一个子目标内，同一个**元素签名**（不是位置性 ref：ref 每次重扫都重新编号）被执行的次数超过
  上界而完成信号始终不成立 ⇒ 结构化 `stop_code: "no_progress"`，正文点名元素、次数与"不是步数预算"。
  计数发生在信号（含 SPA settle 窗口）与人工/noul 检查之后，所以它数的正是"驱动了但没进展"。
- **§8.5 的验收方式兑现**（同一份夹具 A/B，数字进断言）：夹具 `testpages/dead-target.html`
  同时让两件事成立——目标按钮是**死的**（handler 存在但什么都不改），且页面是**吵的**
  （50 ms 倒计时 + 页面级点击计数，后者是"时钟让 inert 失灵"的**确定性**版本，不靠采样运气）。
  关掉上界：**8 步全花在同一个死按钮上、`max_steps`、4.5 s**；缺省上界：**第 4 步 `no_progress`、2.3 s**。
  —— 更早，且理由不同。
- **不误杀合法重复**：点到第 3 次才成立的信号仍然 `dom_goal_signal`（上界数的是"信号没成立"的那几次）；
  `maxEffectiveRepeats: 0` 逐字节回到旧行为；六层对拍与全部应用套件一字未动。
- **仍然欠着的**：`retries` 的每一次尝试会重置计数（那是 `retries` 的合同：整个子目标重来），
  所以"死目标 + retries: 5"会跑 5 轮才判 BLOCKED——有界、如实，但不在本轮改成
  `NEVER_RETRY_CODES`（冷页面确实可能第一轮拿不到池子，那是 `retries` 存在的理由）。

**仍未做**（按本文自己的纪律，不在本轮越权）：
线上包 A/B 的**真机数字**（本文 §4#1 明说不能假设一定变好，需要 `--tiered-hint` 在 live pack 上跑对照——
离线机制已证，线上一跑需网络与权重）；`BrowserMiddleware` 更名（前提 C 的命名债）；
`runPlan` 与 `next` 的语义统一（要么给计划级 runner 加按步 id 的走向，要么让计划携带
"由应用运行器驱动"的标记）。
**需要裁定**的四个问题里，③已按"P0 直接开工"执行，
①（红线①改写）已由 P1/P2 的实现事实接受——运行期只有"闭集内选择"与"过门回填"两条路；②（§七.9 推翻）
已由 P2 落地为"可表达的新面"而非改写旧包；④（space/bindings 放共享层新模块还是内部编译产物）
按 P2/P3 的实测定为**共享层新模块**（`src/actions.ts`、`src/bindings.ts`：纯函数、可离线单测、
被 pack 与计划两面共用）。
