# 执行层三分（决策 / 命令 / 数据槽）——设计讨论稿

> 状态：**讨论稿，未实现任何代码**。本文只做三件事：核对现状、给出裁定、把验收口径钉到测试。
> 本轮没有改动 `src/`、`apps/`、`ARCHITECTURE.md`，也没有重跑门禁。
> 结论可以被推翻——推翻它需要实测数字，不是措辞。

## 0. 提案原文（被讨论的对象）

把执行层细分成三层：

1. **决策层**：判断使用什么命令、命令中填充什么数据、根据命令选择下一步命令走向；
2. **命令层**：在规划期填充每一步命令的候选列表；
3. **数据槽层**：对应命令参数的候选列表，同时也接受用户参数。

## 1. 架构图读出来的东西

架构图是**生成的**（`tools/arch-diagram.mjs`，`ARCHITECTURE.md:30-31`），所以它不会悄悄过时；
④ 执行层在图里是一串 **10 个定宽盒子**（`tools/arch-diagram.mjs:96-107`）：

```
元素抽取 → 规则/hint → laya 选 → 加宽重看 → 升级老师 → 风险闸门
        → 可点性探针 → 执行动作 → inert 检测 → 完成 = DOM 信号
```

按"这一步在干什么"重新归类这 10 个盒子：

| 计数 | 类别 | 盒子 |
|---|---|---|
| **4** | 选目标 | 规则/hint、laya 选、加宽重看、升级老师 |
| 2 | 证据 | inert 检测、完成 = DOM 信号 |
| 1 | 观察 | 元素抽取 |
| 1 | 闸门 | 风险闸门（+ 可点性探针算预检） |
| **1** | 做动作 | 执行动作 |
| **0** | **定参数** | —— 参数只是"执行动作"盒子里的第三行小字：`range / 填值=slots` |

**这是本文最直接的一条观察：执行层 10 个盒子里有 4 个在"选目标"，只有 1 个在"做动作"，
一个盒子都没在"定参数"。** 提案的直觉（执行层内部比例失衡、需要再切）与图上的事实一致。

## 2. 现状核对：三层的对应物与缺口

| 提案 | 今天在代码里的对应物 | 缺口（核对到行） |
|---|---|---|
| 决策层 | 存在，且是 4 个盒子：`rules.ts` 的 nav/affordance/hint 命中 → `pickElement`（`executor.ts:709-764`）→ reobserve（`1380-1400`）→ escalate（`1425-1443`） | 它选的是**元素**，不是**命令**；动词由元素类型**推导**（`_isTyping`/`_isCheckable`/`_isSubmit`，`executor.ts:990-1007`）。"下一步走向"**不存在**：顺序 = journey 数组序（`app-pack.ts:287`）/ `template.steps` 序（`semantic-flow.ts:586`），`Subgoal` 里没有 `next`/`goto`/`branch` |
| 命令层 | **不存在**。pack 步没有 verb/action/op 字段（`app-pack.ts:69-76`）；`Subgoal` 也没有（`plan.ts:15-28`）。唯一"动词式枚举"是 `list_step.op: min\|max`（`semantic-flow.ts:70-74`）。最接近的东西是 `target_hints`——一个**有序目标表**，不是命令候选表 | 规划期不枚举命令，运行期现场推导；"候选"只以**元素池**的形态存在（`MAX_ELEMENTS=40`，`extraction.ts:171`；加宽 `WIDER_ELEMENTS=120`，`executor.ts:355`） |
| 数据槽层 | 只有**值的袋子**：`plan.slots`（`plan.ts:184`）+ 步级 `slots`，优先级"目标文本 < plan.slots < 本步 slots"（`planner.ts:252`）；用户参数 `--slot k=v`（`app-runner.ts:582-595`，键未声明即 exit 2）；`extract_slots` 只解析 ASCII `key=value`（`extraction.ts:64-75`） | **没有"候选列表"这个概念**。绑定靠 `_slotValue` 的启发式：精确键 → 双向子串，任意大小写（`executor.ts:970-983`）。真正的候选机制只有两处，且都是硬编码的特例：`<select>` 的 label→value 两候选回退（`executor.ts:1052-1057`）、`list_extract`→`selectIndex`（`datasource.ts:962-984`，`order: min\|max`） |

### 2.1 一个已经半建成的"候选列表"被丢掉了

`hintMatch` 内部**已经有分层**：

- `attr~v`：精确属性 → 末段路径 → 子串三段（`rules.ts:188-192`）；
- 裸词：整标签相等 → 词相等 → 词前缀 → 词包含四段（`rules.ts:233-256`）。

但**出口把歧义塌缩成 `null`**（"档内歧义仍返回 null"），于是整个问题从"这几个候选里选一个"
退化成"40 个元素里选一个"。实测代价（`CLAUDE.md`，同一处引用的两次线上观测）：

- en.wikipedia：`a[href~Alan_Turing]` 命中 **17** 条 → 歧义放弃 → 落 laya **0.23 < 0.25 → BLOCKED**；
- zh.wikipedia：正解标签与 ~100 条语言侧栏同 token → 变成一个 **0.29** 的硬币。

分层把线上包从 **6/8 → 8/8**；**剩下没被分层解决的那部分歧义，正是候选列表要接的地方。**

## 3. 裁定

**可以拆，但"层"的切法要改一个字：把"选择"与"生成"分开。**

- 命令层 = 计划期编译出的**闭集**（不是运行期生成命令）；
- 决策层 = 只能在闭集内**选下标**（不是一个 planner）；
- 数据槽层 = 参数候选也是闭集 + **声明式选择规则**（模型不产值）。

这不是新机制，项目里已经把这套纪律用过三遍，每次的措辞都一样：

| 已有的同款纪律 | 出处 |
|---|---|
| `escalateFn`"是**选择器**，不是规划器——只能点名其中一个 ref……一律弃权（fail closed）" | `docs/decision-model-survey.md:41-43` |
| laya 的 choice head：只能在给它的 `criteria` 里选 | `executor.ts:733-740` |
| `predictShortlist`：只能在保留子集里选（且 §2 的塌缩陷阱已被记录） | `executor.ts:747-754` |
| "升级者只能点池中 ref，失败即弃权" | `tools/arch-diagram.mjs:101` |

**所以三层拆分不是"给执行层加能力"，而是把这三条既有纪律从"元素"提升到"命令"。**
不进位的项目红线（`ARCHITECTURE.md:22-24`）因此都不必动：

- 红线①（不重规划）：决策层只在**已编译的闭集**里选，选不出就 `blocked`——与今天 hint 未命中落 laya、
  laya 低于 floor 就 block 是同一条路径；
- 红线②（不发明取值）：参数候选的**选择规则必须声明**（`by: value|label|contains|min|max`），
  模型不能选值——这正是 `list_step` 已经证明的模式（"选择是数据规则、不是模型判断"，
  `docs/SEMANTIC_FLOW_M1_REPORT.md:104`；"浏览器侧与数据侧共用 `selectIndex`，
  **不是**独立的一套"，`docs/SEMANTIC_FLOW_TRANSFER_PLAN.md:82`）；
- 红线③（完成只认信号）：命令的完成信号**复用** `signals.ts` / `tool-signals.ts`，不新增算子；
- 红线④（不可复现即拒存）：候选编译是**纯函数**（计划 + 元素池 → 候选集），
  所以决策层的问题空间是确定性的，`decision-cache.ts` 的精确指纹能覆盖它。

## 4. 收益（按证据强度排序，每条都要能测）

| # | 收益 | 今天的证据 | 验收口径 |
|---|---|---|---|
| 1 | **把"歧义塌缩"变成一次更小的提问**：档内 >1 候选时不再返回 `null`，而是把该档当候选集交给决策层 | 17 候选 → 0.23 阻塞；0.29 硬币（§2.1） | 同批歧义页面（冻结语料 + 线上包）A/B：候选集 ≤ `k=8` 时进入 **passthrough** 区间——注意 `executor.ts:747-754` 今天有**两把尺子**（passthrough 用模型自带 `confidence`，shortlist 激活用 `max(子集概率)`），所以这条必须**实测**，不能假设它一定变好 |
| 2 | **参数绑定从子串猜测变成声明式绑定** | `_slotValue` 的双向子串匹配（`executor.ts:970-983`）会把值交给一个 radio：`<input type=radio id="cap-300">` + `slots={"cap":…}`，今天靠 `_isCheckable` 特例挡住（`executor.ts:990-992`，有单测钉住） | 换成声明绑定后那批单测**仍然全绿**；新增一条负例："未声明绑定 ⇒ `needs_value`，不是猜" |
| 3 | **给"一个子目标只有一次点击"这个已知边界开口**：把"勾选"和"提交"变成同一步的两个**命令候选**，由页面证据决定走哪个 | `ARCHITECTURE.md:218-223`：SkyBook"先勾选、再提交"跨两个子目标时记录步什么都没勾；"仍未解决的是把勾选+提交放进一个子目标" | 复刻站 #6 该用例从**不可表达**变成可表达；同时 `transfer-farehaven` 的 `when` 负例（删守卫即 exit 1、恰好那 4 个 blocked）必须仍然成立 |
| 4 | **候选从"页面现场产物"变成可离线单测的纯函数** | 今天 `criteriaView` 的候选只能在端到端里测；六层对拍是"冻结语料"方法论 | 候选编译进 `tools/*-parity.ts` 同款冻结语料对拍 |

## 5. 代价与硬约束（不能假装的部分）

1. **红线①的边界必须写成可执行的拒绝**：决策层返回闭集外的 id ⇒ **拒绝**（不是回退到"随便选一个"），
   与 `llmEscalator`"不是展示过的 ref 就返回 null"是同一条测试模式（`planner.ts:126-128`）。
   加边（`next`）后必须有**路径上界/访问计数**：`maxSteps=8` 是"每步"的，不是"每路径"的。
2. **§七.10 明确写了"执行循环刻意不配置化"**："判分口径、站点库存生成器、执行循环……
   把它们配置化只会得到一份无法测试的字符串程序"（`ARCHITECTURE.md:224-226`）。
   所以新增面必须是**数据 + 既有语法**：复用 `signals.ts`/`tool-signals.ts`，并由**同一个**
   `PlanningRules.problems` 走查器校验（`plan.ts:87-166`）。项目为"两套语法漂移"付过两次学费：
   hint 语法两侧漂移（`#id` 只加了一侧）、`=` 分支漏了大小写折叠。
3. **指纹与语料漂移是硬成本**：8 个应用包是生成的，`generated_from.plan_sha256` 是**展开内容的指纹**；
   `apps:gen --check`、`tests/transfer.test.ts`、`tools/transfer-parity.ts`、`bench/smoke.sh` 的
   3b/3c oracle 共用同一个展开结果（`CLAUDE.md` 记过"周日绿、周一红"一次打红四处）。
   ⇒ 新字段必须是**加法式、缺省逐字节等价**：不声明新字段时展开结果与指纹**不变**。
   这是硬约束，不是风格偏好。
4. **图与文档要同步**：`tools/arch-diagram.mjs:96-107` 的 `chain` 是 10 个定宽盒子横排，
   拆成 3 组必须重排（生成器有出框/重叠/越界检查，"量不过关不产出"）；
   同时改 `ARCHITECTURE.md` §二 的分层图与 §七 第 3 条。
   顺带一处笔误：`CLAUDE.md:448` 引的 "ARCHITECTURE.md §7.3" 在目标文件里 **grep 零命中**，
   指的是 §七 第 3 条（`ARCHITECTURE.md:199-205`），建议改成"§七 第 3 条"。
5. **成本要先量再谈**：本机（CPU）一次前向 0.5–1 s；两段式决策 = 每步最多 2 次前向。
   但路由模式实测 **410.9 s vs 58.1 s** 说明大头是 checkpoint 重载、不是前向（`ARCHITECTURE.md:150-151`），
   而 `decision-cache.ts` 已实测"第二遍 0 次前向、1.3 s"。
   ⇒ 必须让缓存指纹**同时覆盖"命令选择"与"参数选择"两个问题**，并给出前后对比数字。

## 6. 建议的落法（最小可验证的一步，M0）

**不要一次拆三层。先做"把 hint 的档内歧义变成候选集"这一件事**，理由：

- 它是**纯函数改造**：`hintMatch` 出口从 `string | null` 变成 `{ refs: string[]; tier: number }`
  （`rules.ts:160-258`），不碰 schema、不碰计划指纹、不动 8 个应用包；
- 它**直接打在实测过的失败模式**上（17 候选 → 0.23 阻塞）；
- 它给出"命令候选"这套机制的**第一个真实测量**，再决定要不要往命令层/数据槽层推。

之后：

| 阶段 | 内容 | 通过判据 |
|---|---|---|
| M0 | rules 出口携带 tier 候选集；只在"最强非空档 > 1 候选"时启用；其余路径行为不变 | 冻结语料对拍 + 线上包 A/B 数字；不声明时不改变任何既有输出 |
| M1 | pack/flow.json 增**可选** `commands`（命令候选闭集）+ 决策层只能选 id | 拿一个真实站点把 `target_hints` 改写成 `commands`，运行结果逐字段对比（步骤数/`method`/置信度） |
| M2 | `params` 参数候选层，先只接 `<select>` 与 `list_extract` 两处（今天都有硬编码前身） | 未声明规则 ⇒ `needs_value`；radio 反例单测仍绿 |
| M3 | `next` 声明式后继（= 分支） | **只有 M1/M2 拿到数字后再决定做不做**；环必须跑出显式 `stop_reason` 而不是挂死 |

### 6.1 示意形状（全部可选，缺省等价）

```jsonc
// 今天：一步 = 一条线索
{"desc": "填写查询词", "signal": {"css_value_equals": ["#q", "asyncio"]}, "target_hint": "#q"}

// 提案：一步 = 一个命令闭集 + 一条选路规则 + 参数候选（不写就等价于今天）
{"desc": "填写查询词",
 "signal": {"css_value_equals": ["#q", "asyncio"]},
 "commands": [
   {"id": "fill-q", "op": "fill",  "target": "#q", "value": {"from": "slot", "key": "query"}},
   {"id": "submit", "op": "click", "target": "input[type=submit]"},
   {"id": "skip",   "op": "skip"}
 ],
 "select": {"by": "rule", "order": ["fill-q", "submit"]},   // 或 {"by": "model"} / {"by": "hint"}
 "next":   ["step-3", "step-5"]}                            // 可选；声明式后继
```

参数候选的三种来源，**模型都不参与选值**：

| 来源 | 形状 | 今天的前身 |
|---|---|---|
| ① 用户参数 / 计划槽 | `{"from": "slot", "key": "query"}` | `--slot k=v`（`app-runner.ts:582-595`）、`plan.slots` |
| ② 页面观察到的候选 + **声明式规则** | `{"from": "option", "match": "value", "key": "checkin"}` | `<select>` 的 label→value 两候选（`executor.ts:1052-1057`） |
| ③ 列表行 + 数据规则 | `{"from": "list", "order": "min", "by": "price"}` | `list_extract` → `selectIndex`（`datasource.ts:962-984`） |

### 6.2 要钉的负例（与 `when`/`retries` 同款手法）

1. **缺省等价**：不写 `commands` 的包，展开结果与 `plan_sha256` 逐字节不变，8 个应用逐字段全等。
2. **闭集越权**：决策层返回闭集外的 id ⇒ 拒绝并如实记 `stop_reason`。
3. **参数越权**：模型产出的值一律不采纳；未声明规则的页面候选 ⇒ `needs_value`。
4. **上界**：人工构造一个 `next` 环，必须跑出显式 `stop_reason`（不是挂死、不是栈溢出）。
5. **删即是红**：把某个复刻站的歧义步的 `commands` 删掉，该站必须变红（对应 `farehaven` 删 `when` 即红）。

## 7. 需要裁定的开放问题

1. 三层的**硬边界**画在"计划期 / 运行期"（本文主张），还是画在"选 / 做 / 值"？
2. 候选列表的**规模谁定**？今天有 40 / 120 / k=8 三个互不相连的数字。
3. `next` 边（= 分支）要不要做？还是继续用 `when` + `retries` + `target_hints` 三件套够用？
   `ARCHITECTURE.md:204-205` 给的答案是"要么加新的 repeat 语义，要么由 replan 接手"，
   而 replan 的阻塞现场快照回传**至今没做**（`ARCHITECTURE.md:208`）。
4. 数据槽层要不要允许"页面观察到的候选"？这是唯一可能触碰红线②的设计，
   必须配"选择规则必须声明"，否则退化成"模型选值"。
5. 先做哪一步？本文建议 M0。

## 8. 本轮不做

- 不改 `src/`、`apps/`、`ARCHITECTURE.md`，不重跑门禁，不声称任何收益已被实测；
- 不给 M1/M2/M3 排期——它们的门槛是 M0 的数字，不是本文的说服力。
