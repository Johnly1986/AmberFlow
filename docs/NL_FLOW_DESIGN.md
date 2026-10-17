# 自然语言清单运行时（NL Flow）设计：指令晚绑定 + 具名数据集

**日期**：2026-10-15 ｜ **状态**：**分阶段实施完成（五阶段全部落地或显式裁定）**——
**S0** 实验台 + 全语料冻结数字（`npm run nominate:measure`；model 臂 4.8% ≤ 基线 51.5%，但 ⑤ 枚举序
100% 收回 ⇒ 设计文档的停止条件**不触发**，"②①⑤ 承重、③ 可选"的缺省姿势由数字背书）；
**S1** 数据集 + 第四绑定来源 `{from:"dataset"}` + 执行器 `RunOptions.dataset`；
**S2** 指令注册表 + 提名梯级 + 指令学习存储 + 语义流 `nominate`/`instr` 步（**三臂 e2e：学 → 摊销 →
drift 撤下 → 再学**；②档案档在①规则之前——证据序）；
**S3** `next` 贯通（spec_version 3 + P4 同一 `createPathWalk`；**裁定：组合指令 DAG 暂缓**——`list_pick`
是唯一组合指令，单实例不加 schema，`compose` 已在 §2.2 备好）；
**S4** 提名账单进结果与报告行（dead-rung 自报）。
**测试复核处置轮（同日）**：复核抓到的 2 真缺陷与 4 缺口已全修；未修 5 条全部落地或判定维持——
组合指令 DAG + 数据集生产写入/重跑失效（§2.3 规则 3 自此有生产触发者）、元素动作**证据面强制**（`instruction_not_honored`）、model 臂权重指纹、公共测试夹具面。
报告：[TEST_REVIEW_NLFLOW.md](TEST_REVIEW_NLFLOW.md) §6。
**最终验收（2026-10-15）**：`npm run verify` 退出码 0（**1221/1221 测试 + 六层对拍逐字节一致**）、
`bash bench/smoke.sh` **PASS**（含 `apps:gen --check`）、工作树干净（提交 `8ad9ed6`/`354d0ef`/`bd4ffc5`/
`b501088`/`c1fadd2`）。未做项均为显式裁定或可选（③窄问 runner 接线、④老师档、S0 换问法 A/B、组合 DAG），
逐条记在 §10，不挂空 schema。文中其余"预期"仍是外推，落地一条改一条。
**来源**：项目方设想，与 [SYSTEM12_POSITIONING_REVIEW.md](SYSTEM12_POSITIONING_REVIEW.md) 的定位评审同一条讨论线。
**与既有系统的关系**：本设计**不推翻** SemanticFlow / 应用包 / 执行器任何已落地机制——
信号语言、绑定、梯级卫生、学习门全部复用；差异只有一处：**指令的选择从"写清单时声明"
推迟到"运行期提名"**（晚绑定），并为此补一个**具名数据集**承担跨步参数传递。

> 阅读前提：三条红线不变——①计划结构冻结（运行期只允许闭集内提名与过门回填）；
> ②值只来自声明/观察/派生，**模型产值权限为零**；③完成只认该面证据（DOM 信号/进程观察）。

## 0. 一句话

清单只写**自然语言步骤**；指令集是**闭集**、每条指令自带参数契约与输出契约；运行时每步由
梯级（规则匹配 → 档案映射 → 模型窄问 → 老师点名 → 枚举裁决）**提名**一条指令、按声明式绑定
取参、执行后由完成信号裁决并把产出**具名写入数据集**；「NL 步 → 指令」映射过零模型重放门后
回填，**二跑全规则、零模型**。

## 1. 需求原文与解读

> 设想（项目方）：每一步决策模型都可以参与判断，清单是一个自然语言构成的步骤序列 + 指令集 +
> 数据集。比如一个步骤是"选择最低价商品"：先从指令集中判断哪个指令最适合这步操作，然后执行，
> 返回的数据填充进数据集做出选择，依次递归。

拆成四个可设计的命题：

| 命题 | 解读 | 本设计的答案 |
|---|---|---|
| 清单 = NL 步骤序列 | 步骤描述是语义，不是选择器/指令 | §2.1 NL 步骤（desc + 数据契约 + 完成契约） |
| 每步模型参与判断 | 模型判断的是**用哪条指令**（闭集内），不是值、不是控制流 | §4 提名梯级（五级，模型只是其中两级） |
| 返回数据填充数据集 | 指令产出**具名**入数据集，后续步骤按名引用 | §2.3 / §5 具名数据集 + 第四种绑定来源 |
| 依次递归 | 步间推进 + 组合指令内部递归，**有界** | §6 递归语义（自由分解被红线①禁止） |

## 2. 三件套数据模型

### 2.1 清单：NL 步骤序列（`flow.json`，spec_version 3）

```jsonc
{
  "goal": "订一张5月18日昆明到北京最低价机票",
  "slots": { "from": "昆明", "to": "北京", "date_label": "5月18日", "date_code": "2026-05-18" },
  "steps": [
    {
      "id": "open-flights",
      "desc": "进入机票频道",                        // NL：提名梯级的题面（只喂当前步）
      "needs":  [],                                 // 数据契约：这步要读哪些名（空 = 无）
      "gives":  [],                                 // 输出契约：这步承诺写哪些名
      "signal": { "page": "flights", "query": "" }, // 完成契约：页面角色（编译期按站点档案解析）
      "when": null, "retries": 1, "effect": { "irreversible": false }
    },
    {
      "id": "pick-cheapest",
      "desc": "选择最低价的一个航班",
      "needs":  ["fare_rows"],                      // 引用前序步骤抽出的行集（或档案 list_extract）
      "gives":  ["chosen_fare"],
      "params": { "order": "min", "by": "price" },  // 选择是数据规则，声明在这里
      "signal": { "page": "purchase" },
      "effect": { "irreversible": false }
    },
    {
      "id": "purchase",
      "desc": "购买选中的航班",
      "needs": ["chosen_fare"],
      "signal": { "page": "done" },
      "effect": { "irreversible": true }            // 不可逆：dry-run + 人确认，永不 adjudicate
    }
  ]
}
```

与 SemanticFlow v2 模板的差异：**不再写 `semantic_target`**（元素级语义目标也交给运行期
提名/学习），新增 `needs/gives` 数据契约。`instr` 字段保留为**渐进迁移口**：写了 = 锁定该步
指令（等价于今天的 `commands`），不写 = 运行期提名——存量清单可以逐步"松绑"。

### 2.2 指令集：闭集 + 双契约（引擎能力面是代码，组合指令是配置）

每条指令必须声明**参数契约**（消费哪些名、从哪种来源绑定）与**输出契约**（产出哪些名、什么类型）：

```jsonc
// 原语层（代码注册，闭集）
{ "name": "click",   "params": { "target": {"from": "nominate"} },          // 元素由提名梯级选
  "outputs": {}, "reversible": true }
{ "name": "fill",    "params": { "target": {"from": "nominate"},
                                 "value":  {"from": "slot|dataset", "key": "…"} },
  "outputs": {}, "reversible": true }
{ "name": "extract_rows",
  "params": { "rows": {"from": "profile|dataset", "key": "fare_rows"} },    // 档案 list_extract 或前序产出
  "outputs": { "rows": "list<row>" }, "reversible": true }

// 组合层（声明式组合，配置；DAG，不是自由分解）
{ "name": "list_pick",
  "compose": [ "extract_rows", { "select": { "order": "min", "by": "price" } }, "act_on_row" ],
  "params":  { "rows": {"from": "profile|dataset"} },
  "outputs": { "chosen": "row" }, "reversible": true }
```

- `select` 的 `min/max` 走 `datasource.selectIndex`——与数据侧同一实现（既有纪律，M2 已对拍）。
- **提名期契约相容检查**：被提名的指令，其参数契约里的每个名必须 ⊆ 该步 `needs` ∪ 槽位 ∪
  页面可观察；输出契约 ⊆ 该步 `gives`。不相容 = 提名无效（换下一条），不是硬执行。
- 加载期校验：未知指令名、组合层引用不存在的原语、契约缺声明 ⇒ 红（`PlanningRules.problems`
  同一走查器，不开第三套语法）。

### 2.3 数据集：具名、带溯源、可失效（run 作用域）

```jsonc
{
  "fare_rows":   { "type": "list<row>", "value": [ … ],
                   "written_by": "extract-flights#1", "generation": 1 },
  "chosen_fare": { "type": "row", "value": { "fno": "F3", "price": 980 },
                   "written_by": "pick-cheapest#2", "generation": 1 }
}
```

三条硬规则：

1. **只进数据集，不进模型上下文**：跨步传递靠名字，不靠模型"记得"——模型转述等于模型可以
   改值，传话链不可审计（红线②的推论）。
2. **溯源**（`written_by`）：每个值能回答"哪个步写的"，审计与 drift 定位依赖它。
3. **失效**：一步 `retries`/重跑 ⇒ 它写过的条目 `generation + 1`；绑定在**解析那一刻现读最新
   generation**——防第 5 步用到第 3 步的陈旧值静默级联。

## 3. 运行时主循环（每步算法）

```
for step in steps:                                  # 序列推进；next 声明边可改走向（有界）
  if not when(step): continue as skipped            # 条件步：跳过，零成本
  for attempt in retries(step):
    instr = nominate(step)                          # §4 五级梯级，产出 0..1 条候选指令
    if instr is null: break as blocked              # 梯级空手 = 如实阻塞，不猜
    params = bind(instr.params, dataset, slots, page)   # §5；命不中 ⇒ needs_value 停（零副作用）
    out = execute(instr, params)                    # 动作失败是结果不是异常（既有执行器语义）
    if signal(step) 成立:
      dataset.write(step.gives, out, provenance=step)   # 具名写入
      learn.record(step, instr, staged=true)            # 候选映射，只进内存
      break
    else:
      forbid/换候选/换指令                            # 既有梯级卫生（inert/no_progress/枚举下一档）
```

与现有执行循环的关系：**卫生机制全套复用**（forbid 按签名、inert、`no_progress`、`when`、
`retries`、`next` 上界、hosts 信封、敏感值掩码）。新增的只有 `nominate` 与 `dataset` 两个环节。

## 4. 指令提名梯级（"模型参与判断"的正确姿势）

| 档 | 谁 | 何时命中 | 成本 |
|---|---|---|---|
| ② 档案映射 | 已学映射（`replays_ok`，站点级、过重放门） | 稳态（二跑起） | 零 |
| ① 规则匹配 | 确定性关键词/同义词表 → 指令 | desc 含明确动词（"点击/进入/抽取"） | 零 |
| ③ 模型窄问 | SystemOne choice 题：选项 = 指令闭集（5–10 个），题面 = 当前步 desc | ①② 落空 | 一次前向/请求 |
| ④ 老师点名 | SystemTwo escalate（LLM 看 criteria view 点名指令） | ③ 不过闸 / CJK 首迁 | 一次调用 |
| ⑤ 枚举裁决 | 按声明优先级逐条试，信号裁决，每条一次机会 | ③④ 都不在场（兜底） | 有界白跑 |

> **②在①前（证据序，2026-10-15 实现时裁定）**：②③④⑤ 都是零/有界成本，排序按**证据强度**——
> 站点级、过重放门的已验证映射强于全局关键词启发式。这也让 drift 臂收敛：坏映射撤下后
> ① 才接管，而不是 ① 抢先命中把撤下的映射永远遮成死档（dead-rung 的教训：先分清
> "接了没用"与"被遮住没用"）。

设计要点：

- **题变小了**：挑指令是 5–10 选 1、语义彼此截然不同——比挑元素（40 选 1）容易得多，落在
  choice 协议的舒适区（shortlist 只在 >8 选项时启动）。
- **提名 ≠ 决定**：无论哪级提名，完成一律由该步信号裁决；错提名的代价是"一步白跑 +
  换下一条"，不是污染数据集（写入门在信号之后）。
- **对弱模型鲁棒**：⑤ 是零智能兜底——本仓实测"零智能遍历 + 验证"赢过模型选择
  （first-candidate 3/4 > laya 0/4），所以这个梯级即使 ③④ 全废也能走完可逆步。
- **不可逆步特殊**：`effect.irreversible: true` 的步**只允许 ①②④**（确定性或老师），
  禁止 ③⑤——模型低置信提名不可逆动作没有收回通道。

## 5. 参数传递：五来源、四种绑定、零模型

**值的来源穷举**（谁在何时决定）：

| 来源 | 例子 | 决定者/时机 |
|---|---|---|
| 用户意图 → `slots` | 日期、城市 | 编译期解析，一次性 |
| 声明常量 | `order: min, by: price` | 作者，写清单时 |
| 页面观察 | 下拉候选、行集 | 绑定那一刻现读（观察不是记忆） |
| 前序产出 | `chosen_fare` | 上一步指令输出契约，具名入数据集 |
| 派生计算 | `next_week`/`int`/`min`/`max` | 确定性算子，纯函数 |

**绑定语法**（P3 现有三种 + 本设计新增第四种）：

```jsonc
{ "from": "slot",    "key": "date_code" }                    // 数据袋
{ "from": "option",  "key": "cabin", "match": "value" }      // 页面候选：分档匹配，档内歧义即弃权
{ "from": "list",    "by": "price", "order": "min" }         // 行集选择（= datasource.selectIndex）
{ "from": "dataset", "key": "chosen_fare" }                  // ★ 新增：前序产出，现读最新 generation
```

纪律（全部继承既有实测）：不给 `match` 的 option 绑定加载期红；命不中 ⇒ `needs_value`
结构化停、页面零改动、进 `NEVER_RETRY_CODES`；`{slot}` 只替换已声明槽位。**注入面因此封死**：
值不流经模型，页面内容教不会系统"填什么"。

## 6. 递归语义：有界，且控制流不归模型

| 层 | 允许的递归 | 载体 |
|---|---|---|
| 步间 | 序列推进 + 声明边 | `next: ["step-id", …]`（适用性 = 该步 `when`；路径上界 `max_step_visits`，到顶 `next_cycle` 结构化停） |
| 步内 | 组合指令内部 | `compose: [extract_rows, select, act_on_row]`（声明式 DAG） |
| 运行时 | ❌ 模型生成新子目标 | = 重规划，红线①禁止：不可复现、不可审计 |

深度的硬上界进加载期校验（组合 DAG 无环 + `next` 访问计数），与 P4 的 `createPathWalk` 同一
实现思路。

## 7. 学习环：摊销的发动机

- **学什么**：主件 = 「(清单 id, NL desc 指纹) → 指令名」映射；次件（谨慎）= 提名时用过的
  参数绑定路径。**不学值、不学信号**（信号归 plan 期归纳三关，值永不学）。
- **门**：候选映射 staged 进内存 → **同一次运行内零模型整跑重放**（learn 既有纪律）→
  逐条 `commitVerified` 落盘、`replays_ok` 从 1 起算；不可复现按原值撤回，报告记 `unverified`。
- **撤下**：已学映射连续 N 次（默认 2）没让信号成立 ⇒ 报 `drift`、删条目、下次重新提名。
- **归属**：学到的映射进站点/清单档案（`$AMBERFLOW_HOME` 作用域），**永不进被审计的清单**
  （R2 纪律：清单 = 声明，不是声明 + 历史巧合）。
- **预期曲线**（对照 SemanticFlow 实测外推，未验证）：首跑 ③④ 参与（`nominate: laya 3 ·
  teacher 1`），二跑 ② 全命中（`rule 4 · laya 0 · teacher 0`）。

## 8. 安全与可逆性（继承不谈判）

- `effect.irreversible` 声明优先于关键词与模型票；不可逆步：先 dry-run 取证（只读探针，
  不点不填）→ 人/`--allow-dangerous` 确认；禁止 adjudicate、禁止模型提名档。
- 可逆步可开 `adjudicate`（⑤ 的信号裁决依据），爆炸半径 = 一个元素/一条指令白跑一次即禁。
- hosts 导航信封、敏感字段掩码、危险步三处同一套说法（`REFUSAL_LABELS`）——全部照旧。

## 9. 与现有代码的映射：复用什么、新建什么

| 模块 | 复用 | 新建 |
|---|---|---|
| 执行循环 `executor.ts` | 卫生全套（forbid/inert/no_progress/when/retries/hosts/掩码） | `nominate` 挂点（与 `currentHint` 同位的指令级钩子） |
| 命令层 `actions.ts` | COMMAND_OPS 原语、加载期校验走查器 | 指令注册表 + 双契约 + 组合 DAG 校验 |
| 绑定 `bindings.ts` | slot/option/list 三来源、分档匹配、弃权 | `{from:"dataset"}` 第四来源 + generation 现读 |
| 数据集 | — | `dataset store`（具名/溯源/失效，run 作用域） |
| 信号 `signals.ts`/页面角色 | 全套 + M3 页面角色契约 | 无 |
| 学习 `semantic.ts`/`hint-memory.ts` | staged/commitVerified/replays_ok/drift | 映射条目类型（与 hint 同库同纪律——见定位评审 B2：先统一 LearningStore） |
| 决策服务 `system-one-client.ts` | choice 窄问、provider 注册表 | 无（③ 就是现有 choice 题换个选项集） |
| SystemTwo | escalate 老师、plan:flow 归纳三关 | 无 |

新代码集中在**三处**：指令注册表、提名梯级、数据集。其余是接线。

## 10. 分阶段落地（每阶段带门禁；冻结语料逐字节不动）

| 阶段 | 内容 | 门禁/验收 |
|---|---|---|
| **S0 实验台**（先测后立）**——✅ 工具已落地（`npm run nominate:measure`）；全语料数字见 `bench/instruction-nomination/REPORT.md`** | 冻结语料的 NL 步，测提名正确率：③ 真模型臂 vs `first-candidate` 基线 vs ⑤ 枚举（真值 = 已验收语料的**实际执行**） | 冻结产物 + 报告。**停止条件**：③ 正确率 ≤ 基线且 ⑤ 收回失败 ⇒ 设想降级为现状（声明指令 + 模型只挑元素），本文归档 |
| **S1 数据集**——**✅ 已落地并过全量验收**（**复核处置**：数据集曾只有消费面（裁定「随 S3 组合层一并接」）——现生产面已随 S3 落地：`gives` 声明 → 信号成立后 `dataset.write`、指令重放门前 `invalidateStep`（§2.3 规则 3 自此有生产触发者）、`dataset_view` 审计面。勘误：原「demo-app 改写一例」不精确——pack 面无产出指令，端到端例由 `flight-nominate` 试点夹具承担（见 TEST_REVIEW_NLFLOW.md §6））（`verify` 1179/1179 + 六层对拍绿） | `dataset store`（`src/dataset.ts`：具名/溯源/generation 失效）+ `{from:"dataset"}` 绑定（第四来源）+ `RunOptions.dataset`（缺省 null 逐字节不变） | `tests/dataset.test.ts` 11 条：needs_value / 重跑失效（陈旧世代不可读）/ 溯源 / 坏档案报错 / 真执行器端到端 |
| **S2 提名梯级**——**◐ 已落地并过三臂 e2e**（核心：`src/instructions.ts` + `src/nominate.ts`，**②档案档在①规则前——证据序**，站点级已验证映射优先于全局启发式；数据面：`src/semantic-instructions.ts` 学习存储（档案 `instructions` 段 + staged 回填门 + drift 撤下 + 读-合并-写修 lost-update）；**试点接线：`semantic-flow` 的 `nominate`/`instr` 步**——`list_step` 降格为 list_pick 候选参数（值与规则仍是声明，红线②），runner 梯级裁决用不用它，list_pick 走确定性数据腿、过**指令回填门**（同运行重放）落盘，元素动作提名只进报告不落盘（其摊销证据属 hint 环）；list 分支补按本步 URL 的守卫导航。测试：`tests/nominate.test.ts` 11 + `tests/semantic-instructions.test.ts` 13 + `tests/semantic-nominate.test.ts` 11（含三臂 e2e：**学→摊销→drift 撤下→再学**））。**未做**：③模型窄问的 runner 接线（S0 实测 desc-only 下是死档，缺省姿势 ②①⑤）、S3 组合层 | ①②③⑤ 接 semantic-flow 试点（一个应用）；④ 挂既有 escalate | 首跑/二跑/漂移三臂；二跑零模型；删 `instr` 锁定即回到现状行为 |
| **S3 组合与边**——**✅ 已落地**（`next` 贯通 + 组合指令 DAG + 数据集生产面）（语义流 spec_version 3：`next`/`max_step_visits` 白名单 + 加载期校验（v2 写 next 红并指路升版、目标必须已声明）+ runner 走向 = P4 同一 `createPathWalk`（声明边 + 候选步 `when` 作适用性、跨过的步记 skipped、环上界 `next_cycle` 结构化停因、无边模板行为逐字节不变且结果 JSON 不加 path_* 字段）。组合指令 DAG 曾按「单实例不加 schema」暂缓；测试复核（发现 7/8）给出确定挂载点后落地：`list_pick` 在注册表**声明** `compose = [extract_rows, select, act_on_row]` + `outputs {chosen: row}`（`validateInstructionRegistry()` 加载期自校验），`runListStep` 改为读声明的小解释器（行为逐字由既有测试钉住）；`gives` → 信号成立后 `dataset.write(name, chosen, stepId)`，指令重放门**先失效再重写**（generation 单调有 e2e 断言），`dataset_view` 审计面；元素动作提名改为**证据面强制**（`firstExecFamily` 族核对，不一致 = 结构化 `instruction_not_honored`；`check ≡ click` 声明等价）。勘误：demo-app 端到端例不精确，实由 `flight-nominate` 试点夹具承担。测试：`tests/semantic-next.test.ts` 8 条（校验 + 跨步 e2e + 环上界 e2e + max_step_visits 声明 + skipped/真实结果区分 + 缺省等价） | `next_cycle` 上界；六层对拍 + `apps:gen --check` 逐字节 |
| **S4 收口**——**◐ 提名账单已落地**（`FlowRunResult.nominate_bill`：各档 via 出场数 + 指令回填门落盘/撤回 + drift 数；报告行 `· 提名 rule N · learned N …（指令落盘 N/撤回 N）`——dead-rung 自报，梯级账单同款）。doctor/矩阵/套件三处的接线**不适用**：提名面目前只在语义流 runner（pack 矩阵不覆盖 flow 应用）——等第二个提名面出现再上聚合计数 | doctor/矩阵/套件三处加"提名账单"（各级出场/过关/救回，dead rung 自报） | 梯级账单同款；矩阵加"稳态成本"列 |

## 11. 验收指标（钉死，不许口径漂移）

1. **提名正确率**：真模型臂 vs first-candidate 基线（S0 产物冻结）。
2. **错提名收回率**：adjudicate on/off 两臂，收回 = 信号最终成立且无不可逆副作用。
3. **二跑零模型**：映射回填后第二跑 ③④ 出场数 = 0（学习环验收同款）。
4. **值来源可断言**：全程扫描，值来源 ∈ {声明/观察/派生}，**模型产值次数 = 0**。
5. **数据集可审计**：每个值 `written_by` 可查；重跑后旧 generation 引用 = 0。
6. **不可逆零接触**：`irreversible: true` 的步，③⑤ 出场次数 = 0。

## 12. 风险与边界（如实）

- **最大经验未知数**：模型把 NL 步映射到指令闭集的准确率**没测过**（laya 为元素选择训练，
  这是分布偏移；S0 就是为此设的）。CJK 首迁预期走 ④（既有实测：laya CJK 零样本 0.03–0.09）。
- **NL 不是控制流**：分支/循环仍靠 `when`/`next`；"用一句自然语言表达复杂分支"不在本设计
  承诺内。
- **首跑更贵**：三件套比声明式清单多了提名与验证开销——若语料 90% 的步停在 ①②，设计成立；
  若大量步天天走 ③④，说明清单该编译得更厚（这是编译器的活，不是运行时的）。
- **复杂度警戒线**：`needs/gives` 契约是新的声明面。沿用改进清单 §9 的规矩：**先问现有面
  能不能表达，能就不加**；`instr` 锁定口保证存量清单零迁移成本。

## 13. 反清单

- **不许**模型产值、产控制流、产完成判断（三条红线的运行期形态）。
- **不许**无边递归（组合 DAG 无环 + `next` 计数，加载期红）。
- **不许**学习环绕过零模型重放门落盘；学到的永不进被审计的清单。
- **不许**为凑覆盖率把 `needs_value` 改成"让模型补一个值"。
- **不许**动冻结语料一个字节；新能力缺省关，`instr` 锁定 = 现状逐字节等价。

## 14. 复算/实验入口（S0 落地时用）

```bash
npm run providers:baseline        # first-candidate 基线：任何新问法要先赢的线
npx vitest run tests/semantic.test.ts tests/plan-flow.test.ts   # 复用的学习门/归纳三关现状
npm run semantic -- --app flight-cheapest --site site-a --laya scripted   # 二跑零模型的既有对照
npm run apps:suite                # 梯级账单/模型边际口径（S4 的提名账单照此办）
node --experimental-strip-types tools/drift-real-arm.ts          # 真模型臂冻结产物先例
```
