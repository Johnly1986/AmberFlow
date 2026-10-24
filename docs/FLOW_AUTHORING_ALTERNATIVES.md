# 流程描述方式评估：JSON 配置的边界，与「隔离脚本 + 统一 IR」的替代方案

**日期**：2026-10-24 ｜ **状态**：讨论稿（未实施，无代码改动）
**问题**（项目方）：用 JSON 配置文件描述流程，不但不灵活，还引入了新的对齐成本——有没有更简单直观的替代？

**一句话结论**（**2026-10-24 按项目方口径修订**）：有，但不是换配置格式——**作者面换成「隔离的应用脚本」**：
`$AMBERFLOW_HOME/apps/<id>/app.mjs` 里用 `build(kit)` 写出三段骨架（**数据槽 / 决策判断 / 决策执行**），
引擎在运行期 `import()` 它、在内存里降成今天这份 IR，再走**同一套**加载期校验。
脚本**零 import、零构建、不进 tsconfig/vitest/CI**，与项目主体隔离；运行时仍然只认数据。
原稿的「`flows/*.ts` 编译成 `pack.json`」方案**作废**（与「与项目编译无关」直接冲突，见 §5 A′）。

---

## 0. 结论先行（TL;DR）

1. **「不灵活」和「对齐成本」是两个不同根因**，换格式（YAML / TOML / Excel）一条都不解决——
   见 §2.4 与 §5 的反清单。
2. **不灵活 = JSON 被当编程语言用。** 今天 `pack.json` 有 21 个包级键（`src/app/app-pack.ts:53`）、
   约 21 个步级键（`src/app/app-adapters.ts:31-43` + `src/app/app-pack.ts:149`），
   `flow.json` 还有独立的一套 16 个步键（`src/flow/semantic-flow.ts:188`）。
   每来一种新需求就加一个键 = 同时改 5 处（加载器 / 校验器 / 运行时 / 文档 / 测试）。
3. **但 schema 的复杂度只为一成左右的步服务。** 入库快照里 187 条旅程中 `when` 7 条、`retries` 12 条、`next` 1 条
   （`docs/arch-metrics.json`；该文件 note 要求**写明分母**：187 条旅程 / 175 个浏览器步）。
   三个数相加 20，即使完全不重叠也只占 **10.7%**（当前重算为 190/7/15/1，比例 12.1%，同一量级）——
   **约 88–89% 的步只是「desc + hint + signal + url」**。
   为一个声明式格式不断加键，是在把 JSON 养成一门**没有类型、没有函数、没有 IDE 的编程语言**。
4. **对齐成本要分五类算**（§3）：C1 重复表示 / C2 语法双写 / C3 跨引用对账 / C4 冻结语料↔当前行为 /
   C5 schema↔运行时↔文档。**C1 已经被 `apps:gen` 消掉大半**（7 个包、1197 行手抄、复核 0 diff，
   `bench/AUTHORING_ASSESSMENT.md:52-63`）。现在真正出血的是 **C2 / C3 / C5**。
5. **门禁不是成本，门禁是「对齐已经变成构造性质」的证明**（`bench/smoke.sh` 里 5 个 `--check` 调用、
   4 个工具）。成本在于**同一个能力有两份实现**（hint 匹配器、signal 语法）和**同一个事实有多处手写**（跨文件引用）。
   实测量表：28 条事实平均要写 **2.2 处**、**21 个**检查器保它们、其中 **52%** 真的红过（`docs/_recon/alignment-cost.md`）。
6. 三条不能动：**冻结语料逐字节**、**执行循环单实现**、**判分是独立的第二实现**
   （`ARCHITECTURE.md:431-433`）。今天「app 目录里 0 行代码」这条也一直是卖点——**脚本放用户作用域，
   仓库 `apps/` 仍是数据，这条在仓库侧继续成立**；需要重新定义的是「作者代码在哪」（§7 #6）。
7. **推荐路线（修订）**：P0 只做 2/3/4 刀（实现收敛，不动任何入库字节 → **不需要重冻**）→
   S1 **隔离脚本作者面**（`$AMBERFLOW_HOME/apps/<id>/app.mjs`，运行期 `import()`、内存成 IR、零构建）→
   S2 录制直接产脚本。**不**把判分、危险语义、执行循环配置化；**不**把脚本放进 `src/` 或任何编译面。
8. **若目标是「JSON 完全废弃」（2026-10-24 追加）**：路径是 **L1（脚本=作者面）→ L2（脚本接管控制流 + trace
   取代冻结计划）→ L3（删 JSON）**，见 §10。关键判断：**L1+L2 已能拿到"不手写 JSON + 运行期灵活"，
   而 L3 要付 39/18/33 个文件的迁移 + 一次重冻 + 21 包迁移**——所以"用户看不见 JSON"和"仓库里没有 JSON"
   是两件不同的事，前者便宜、后者昂贵。

---

## 1. 现状：不是「一份配置」，是一个 schema 家族

`apps/README.md:5-11` 把应用包写成「一个目录 + 两种 JSON」，实际清点（只读遍历，命令可复跑）：

| # | 配置面 | 文件数 | 加载器 / 校验器 | 允许键（单一出处） | 生成物? |
|---|---|---|---|---|---|
| 1 | `apps/<id>/pack.json` | 21 | `src/app/app-pack.ts:341` / `:541` | `PACK_KEYS` `src/app/app-pack.ts:53` | 8 个生成、1 个录制、12 个手写 |
| 2 | `flow.json`（`apps/` 2 + `bench/llm-planned/` 1） | 3 | `src/flow/semantic-flow.ts` | `TEMPLATE_KEYS:184` / `STEP_KEYS:188` | 无血统键（`plan:flow` 会写它，`src/flow/plan-flow.ts:855-857`） |
| 3 | `apps/*/sources/*.json` + `ctrip/sources/*.json` | 8 | `src/data/datasource.ts:1190` / `:1282` | 顶层**无**白名单；嵌套 `CLI_KEYS:359` 等 | 手写 |
| 4 | `sites/<site>.profile.json`（两套 schema，靠目录区分） | 10（5 authored + 5 learned） | `src/flow/semantic-flow.ts:265` / `:479`；learned 面 `src/flow/semantic.ts:188` | authored `PROFILE_KEYS:193`；learned `LearnedSiteFile` | 5 个是**运行期写入**（`replays_ok` 计数） |
| 5 | `transfer/specs/*.json` | 7 | `tools/spec-to-pack.ts` + `src/flow/transfer-flow.ts` | `src/flow/flow.ts:47-60` | **手写源**：7 个包由 spec 生成；第 8 个（`ip-config`）由 TS builder 生成 |
| 6 | `bench/cases*.json` | 3 | `src/cli/bench.ts:247` | 只有编译期接口 `BenchCase:32-43`，**无运行期校验** | 手写 |
| 7 | `configs/amberflowrc*.json` | 1（example；真文件不入库） | `src/support/rcfile.ts:55` | `RC_GROUPS:30-45` | 手写 |

合计 **53 个 JSON 描述文件、8 套不同 schema**。有机器可验血统的 9 个（8 `generated_from` + 1 `recorded_from`），
运行期写入的 5 个（learned profile），**其余 39 个没有血统标记，作者不可判定**。
**入库快照**（`docs/arch-metrics.json`，`generated_at 2026-10-18`）：3880 行声明（pack 3467 / flow 238 / profile 175）、
187 条旅程、170/175 步有 hint（97.1%）。**现在重算**（`node --experimental-strip-types tools/arch-metrics.ts --out /tmp/x.json`）：
**3958 行 / 190 条旅程 / 171-178 步有 hint（96.1%）/ when 7 / retries 15 / next 1**——
**计量文件本身也是快照，会过期**（见 §3 C5 的同型问题）。

四个结构性事实：

- **同一个概念有多个表示。** 「一步」至少有三种写法：`pack.journey`（hint + 具体 selector 语法）、
  `flow.json` 的语义步（page 角色 + 语义目标，运行期再解析）、`transfer/specs` 的阶段步（展开成计划）。
  三者各有自己的键白名单与校验器；**连「站点档案」都有两套互斥 schema**（authored vs 运行期学到）。
- **校验深度不一致。** `pack` 有 20+ 项加载期对账（`src/app/app-pack.ts:541`），但**应用路径不跑完整的
  `validateSource`**——生产调用点只有 datasource 自身 CLI（`src/data/datasource.ts:1583`）与对拍
  `tools/datasource-parity.ts:114`（测试里另有 19 处直调）；app 侧只做存在性加载 + `selects/counts` 的
  key 对账（`src/app/app-pack.ts:609-633`），**不做 schema 校验**。更糟的是 `src/app/app-runner.ts:590-592`
  的注释声称 `loadSource` 会跑 validate——与实现（`src/data/datasource.ts:1190-1216`）不符：**注释在骗人**。
  `bench/cases*.json` 同样没有运行期校验。**配了却没人验**，就是这里的原样。
- **跨文件引用靠手写对账。** `{slot}` 只替换已声明槽位、`source_slots` 的 `select/count` 必须在数据源里存在、
  `{dataset:NAME}` 必须有产者、`returns` 产者唯一、probe 的 URL 主机必须在 `hosts` 里……
  这些检查分散在 4 个校验函数里，任何一处漏了就是「配了却像没配」。
- **生成器承认自己表达不全（但只限步级）。** `tools/spec-to-pack.ts:391-415` 的 `inexpressibleKeys`：
  `--write` 前专门检查「这些键生成器表达不了，写回等于删掉它们」并拒绝（`:538-544`）。
  它照搬 `invariants`/`notes`/`device`/`probe`（`:344-356`），拒的是 `next`/`commands`/`max_step_visits`/`adjudicate`
  这类**步级**表达——这正好界定了「生成器能覆盖到哪」。

若采用 §6 S1，还会多一种**非 JSON** 的作者面：`$AMBERFLOW_HOME/apps/<id>/app.mjs`（用户作用域、零构建、不入库、
不在上表 53 个里）。这是关键的区分：**配置在「数据」这一侧，脚本在「构建期代码」这一侧；运行时仍然只读 IR。**

---

## 2. 「不灵活」的解剖：加键即扩展

### 2.1 账本：每加一种表达需求，要动 5 处

| 需求 | 引入的键 | 用例 / 证据 |
|---|---|---|
| 某步可能不适用 | `when` | `apps/transfer-farehaven`（4 次 skip） |
| 冷启动重试 | `retries` | `apps/transfer-slowjet`（5 次重试） |
| 步与步之间有走向 | `next` / `max_step_visits` | `apps/cold-search-next` |
| 一步多个动作 | `commands`（闭集 + 绑定） | `src/engine/actions.ts:36` |
| 进程类动作腿 | `adapter` / `source` / `args` / `dry_run_args` / `idempotent` / `dangerous` | `apps/cli-report` |
| 步间传值 | `returns` + `{dataset:NAME}` | `apps/mixed-demo` |
| 站点只有手机版 | `device`（7 个子键） | `apps/qunar-live` |
| 本次怎么跑 | `policy`（5 个子键） | `src/app/app-pack.ts:111`；**实测 0 个包在用** |
| 数据腿回写槽位 | `source_slots` | `apps/bilibili-hot` |

每一个键的落点都是 5 处：加载（loadXxx）→ 校验（validateXxx）→ 运行时消费 → 文档 → 测试。
这不是谁写得不干净，而是**「schema 就是 API」的必然结果**：JSON 没有复用机制，新需求只能变成新键。
`policy` 这个 5 键子对象**至今 0 个包使用**——加键的成本是实付的，收益却不一定发生。

### 2.2 用率证明这个方向错了

`docs/arch-metrics.json` 的 `declarations`（入库快照）：187 条旅程里 `when` **7**、`retries` **12**、`next` **1**
（分母口径：187 条旅程 / 175 个浏览器步；note 要求引用时写明；当前重算 = 190/7/15/1）。
20 个声明点即使零重叠也只占 **10.7%**，也就是说 **约 89% 的步是「线性的一步」**，而 schema 的复杂度是为剩下这一成长的。

真正缺的表达力只有三样（都有 file:line，不是印象）：

| 缺口 | 证据 | 后果 |
|---|---|---|
| **步内分支**（一步之内还是直线） | `ARCHITECTURE.md:394`；`commands` 是有序闭集、不是按条件选支（`src/engine/actions.ts:36`，`src/engine/executor.ts:1560-1568`） | 「A 成立点这个、否则点那个」写不出来，只能拆成两步 + `when` |
| **值/类型/表达式** | 占位符只认 `[A-Za-z_][A-Za-z0-9_]*`（`src/app/app-pack.ts:359`）：`{rows[0].price}`、`{n+1}` **能写进 JSON，但静默不替换、不报错**（实测 `validatePack` 返回 `problems: []`）；slot 替换一律 `String()`（`:374`）；`{dataset:}` 非字符串走 `JSON.stringify`（`src/app/app-adapters.ts:161`） | plan 层没有算术、没有下标、没有数字类型（数据源的路径语言 `[0]`/`len`/`date±Nday` 是**另一个面**，帮不到这里） |
| **条件谓词只能问 DOM** | signal 只有 5 个 DOM 算子（`src/engine/signals.ts:179-191`），没有数值比较、没有数据/退出码引用 | `when`/`next` 写不出「价格 < 300 就走另一支」这类数据条件 |

**注意**：旧文档说「不能分支」已经不完全准确——**步间**的分支与有界回边其实已经能表达
（`journey[].next` + 每候选自己的 `when` + `max_step_visits`，`src/app/app-runner.ts:881-898`、
`src/app/app-pack.ts:222-225`，只有 `apps/cold-search-next` 在用）。所以缺口比旧说法窄，
但正是这三样**最长尾的需求**没有任何声明位置——按「加键」的路线，它们要变成 6-8 个新键。
**继续加键既救不了这一成，也压不住以后的新需求。**

### 2.3 两套步语法（最直接的「不灵活」证据）

| | `pack.json` 的步 | `flow.json` 的步 |
|---|---|---|
| 键 | `role/desc/signal/slots/retries/id/next/adapter/returns` + `start_url/target_hint(s)/when/commands/effect` + `source/args/...`（`src/app/app-adapters.ts:31-43`） | `id/desc/page/page_query/semantic_target(s)/fills/signal/when/retries/dangerous/list_step/nominate/instr/next/gives`（`src/flow/semantic-flow.ts:188`） |
| 目标怎么表示 | hint 字符串（`#id` / `tag[attr=v]` / 裸词） | 语义角色 + 文本（运行期用站点档案解析） |
| 完成信号 | DOM 五算子 / 进程观察面 | `{page, query}` 页面角色 |

同一个「一步」有两套词汇，意味着：**任何跨层能力（比如 `next`）都要在两个白名单里各实现一遍**。
`flow.json` 的 `next` 是 spec_version 3 才加的（`src/flow/semantic-flow.ts:316-318`），
而 `ARCHITECTURE.md:397` 至今还写着「`next` 不在 flow 白名单里」——**文档也跟着漂了**（见 §3 C5）。

### 2.4 结论

**JSON 作为「受限声明语言」本身是优点**（可校验、可审计、可冻结、AI 好生成）。
问题是我们**不断地要求它长大**。长大的终局是一门没有类型、没有函数、没有重构工具的编程语言——
比直接写代码更差。**表达力的正确去处不是加键，是换语言**：
把「算」放在构建期的脚本里，把「判」和「记」留在 IR/运行时（§6 S1 / §6.5）。

---

## 3. 「对齐成本」的解剖：五类，分开算

### C1 重复表示（**已经被消掉大半**，不是当前痛点）

- 实测：15 个有旅程的包里 **61%（1797 / 2965 行）是「某个已存在数据展开一下就能得到」的机械内容**
  （注：这是 **15 包时代的旧基线**，`tools/arch-metrics.ts:7` 自认；当前 21 包口径下 journey+roles 占 61.7%）；
  其中 7 个包的旅程与 `emitPlan(spec)` **逐字段 0 diff**（`bench/AUTHORING_ASSESSMENT.md:52-63`）。
- 代价原样记录：7 轮「作者抄 + 复核逐字段验」，产出是 7 个对齐测试 + 7 个 sha256 pin + 2 轮复核
  （`bench/AUTHORING_ASSESSMENT.md:97-107`）。
- 现状：`npm run apps:gen -- --check`（`bench/smoke.sh:40`）把对齐从人工核对变成**构造性质**。
- **但生成器只搬得动「spec 有对应物」的那部分**：它原样搬运 `invariants`/`notes`/`device`/`probe`/`hosts`/`sources`
  （`tools/spec-to-pack.ts:344-356`，`skipTop` 含 `probe` `:393`），只拒绝**步级**里 spec 表达不了的键
  （`next`/`commands`/`max_step_visits`/`adjudicate`）与未知顶层键（`:391-415`），并在写回该包前 `return 1`
  （`:538-544`）。所以准确说法是：**步内判断只要写进包，这个包就出不了「生成 → 手改 → 再生成」的循环**——
  而且多目标 `--write` **不是原子的**（后面的包被拒时，前面的包已经写下了，`:532-544`）。
- **判读**：C1 的正解是生成器，已经做了；剩下的不是「手抄」，不要把它再当主要成本。
  但生成器的输入本身仍是一套 schema——**这正是 A 方案要把它换掉的地方**。

### C2 语法双写（**真成本**）

| 能力 | 实现 A | 实现 B | 后果 |
|---|---|---|---|
| hint 语法 | `src/engine/rules.ts:300`（`hintMatch`）/ `:310`（`hintCandidates`），池侧 | `src/engine/extraction.ts:785`（`hintLookup`），DOM 侧回捞被预算挤出的元素 | 必须**成对改**；历史漂移两次：`#id` 只加一侧、`=` 分支漏大小写折叠（`ARCHITECTURE.md:401-405`） |
| 完成信号语法 | `src/engine/signals.ts:179`（DOM 五算子 + 组合） | `src/browser/tool-signals.ts:29`（进程观察面，同一套 `all_of/any_of/not`「同构长出来」） | 组合算子与递归校验各写一遍 |
| 步语法 | `pack.journey` 键表 | `flow.json` 键表（§2.3） | 跨层能力要改两个白名单 |

**这一类的修法是「一个判别联合 + 按面做 adapter」，不是「加一条对拍」。** 对拍只能证明今天一致，
证明不了明天不会漂。补充两条**实测**（`docs/_recon/alignment-cost.md` §2/§3）：
- 「两表等价」的跨面差分测试**不存在**（`tests/tool-signals.test.ts:22` 只钉组合算子都在）；
- hint 的「第三次漂移」假设被实测**证伪**（`extraction.ts:792` 在调用边界已小写化，6 个形状两侧全同）——
  但大小写折叠只挂在调用方**一个点**上，是薄冰，不是安全。

### C3 跨引用对账（**真成本，且只会在扩张时变多**）

`validatePack`（`src/app/app-pack.ts:541`）里至少对账这些：
`{slot}` 只替换已声明槽位；`source_slots.select/count` 必须在数据源里存在；
`{dataset:NAME}` 必须真有产者且 `returns` 产者唯一；`target_hint` 形状；`hosts ⊆ probe URL 主机`；
`required_slots`；`max_subgoals`；`policy` 键与类型；`device` 键与类型。
**引用是字符串，不是符号**——所以必须靠加载期字符串对账，漏一条就静默失效。
更麻烦的是**校验深度不一致**：有的面查得很细（pack 20+ 项），有的面根本不查
（应用路径不校验 sources schema，`bench/cases*.json` 无运行期校验，见 §1）。
实测还用探针证明：datasource 内部**五类引用加载期全放行**——`selects.sort_by`、`audits.field`、
`counts.key`、`report` 列、`filters.time_field` 写成不存在的字段都不报错；而 `auditRows`
（`src/data/datasource.ts:990`）取不到字段时按空串比较，**字段名打错会表现为一份看起来正常的 `0/N` 测量**
（`docs/_recon/alignment-cost.md` §6，探针 `/tmp/align-probe/src-crossref.mts`）。
反过来说，这类检查是真有用的：`--slot foo=1`（包里没声明过 foo）曾经 **exit 0 + 「通过 5/5」**
（值谁也没用上），现在是 exit 2 并列出已声明槽位（`30ecc9a`，`src/app/app-pack.ts:836-841`）。
**结论：这类对账不是「多余的防护」，而是把「配了却像没配」变成加载期一句话。**

### C4 冻结语料 ↔ 当前行为（**故意的成本，但被表示分散放大了**）

- 六层对拍 + 冻结语料要求**逐字节**一致；`apps:gen --check` 比 `plan_sha256`。
- 日期一旦参与展开就会被时钟咬：`FROZEN_TODAY` 存在之前，**同一个提交周日绿、周一红**（`a784e75`），
  同时打红**五处**：`apps:gen --check`（7 包漂移）、`tests/transfer.test.ts`（15 条）、
  `tests/ctrip.test.ts`（3 条）、`tools/transfer-parity.ts`（41 项）、`bench/smoke.sh` 的 3b/3c（各 0/7）。
- 更讽刺的是：**连「单一出处」自己都有第二份副本**——`bench/smoke.sh:75,79` 仍写死
  `LAYA_TODAY="${LAYA_TODAY:-2026-10-02}"`，没有引用 `tools/frozen-today.ts`。改常量不改它，
  「周日绿周一红」会从另一条路径复活。
- **判读**：这不是「JSON 的错」，是「证据要逐字节」的必然。但**同一能力有几份语料要重冻**才是成本；
  表示收敛后，重冻面也收敛。

### C5 schema ↔ 运行时 ↔ 文档（**真成本，最隐蔽**）

- `Proof`：`when` 曾经通过加载期校验、运行期才炸——因为「校验走查器」和「信号求值器」是两处，
  `when` 只喂了后者（修法见 `src/engine/plan.ts:252-256` 的注释；**由作者在第 3 轮发现**，不是复核抓的：
  `CLAUDE.md:311-312` 写明 "found by the AUTHOR this time"）。
- `Proof`：`flow.json` 的 `next` 已经是 spec_version 3 的合法键（`src/flow/semantic-flow.ts:316-318`），
  但 `ARCHITECTURE.md:397` 仍写「不在里面」。**加一个键的第五处（文档）已经漂了。**
- **判读**：这是「同一语义有两处实现（校验器 / 求值器）」的必然。TS 作者面不能消灭它，
  但类型系统能把它从「运行时才发现」提前到「编译期」。
- 同型的**第三例**（这次不是文档，是注释）：`src/app/app-runner.ts:590-592` 的注释声称
  `loadSource` 会跑 `validate_source`，实现（`src/data/datasource.ts:1190-1216`）并不跑——
  **注释说谎比文档过期更贵**，因为读代码的人会相信它。

### 3.x 量表（28 条事实的实测，出处 `docs/_recon/alignment-cost.md` §计数）

| 指标 | 实测 | 读法 |
|---|---|---|
| 平均「一个事实要写几处」 | **61 / 28 ≈ 2.2 处**；剔除生成物副本后 58 / 28 ≈ **2.1** | 几乎不变 ⇒ 成本主体**不是生成物**，而是「同一事实在两套手写实现里」（spec 声明 vs oracle 代码、池侧 hint vs DOM 侧 hint、两套算子表、六个路径口径） |
| 为对齐存在的门禁/检查器 | **21 个** | 其中 **9 条事实没有加载期门禁**（datasource 5 类、bench 用例↔夹具、档案文件缺失等；表里标「无」的 9 行） |
| 门禁真咬过人的比例 | **11 / 21 ≈ 52%** | 一半是「防复发」，一半是真红过（`a784e75` 五处同红、`30ecc9a` 假绿、`6b5d413` 漏校验…） |

**这张表就是「对齐成本」的定量回答：一个事实平均要在 2.2 个地方各写一遍，还要 21 个检查器保它。**
换配置格式不会改变这三个数中的任何一个。

### 3.y 故意**不**算对齐成本的

`ARCHITECTURE.md:431-433`：判分口径（必须是独立的第二实现）、站点库存生成器、执行循环。
把它们「配置化」只会得到一份无法测试的字符串程序。**这条结论不变。**

---

## 4. 谁在写流程？（决定修法优先级）

- 证据：`bench/AUTHORING_ASSESSMENT.md:97-107` 里，7 个包是**子代理**逐字段抄的、另**子代理**逐字段验的。
  也就是说，当前写流程的「人」很大程度是 AI；主要成本是**转录 + 核对**，而不是「想不出 schema」。
- 另一个证据：53 个 JSON 里 **39 个没有血统标记**，而 `plan:flow` 会写 `flow.json` / `profile.json`
  却不留标记（`src/flow/plan-flow.ts:855-857`、`:897-906`；`TEMPLATE_KEYS`/`PROFILE_KEYS` 无血统键）。
  **同一份文件有两个写入者、却查不到出处**——这本身就是一种对齐成本。
- 三类作者，三种最优面：

| 作者 | 最优面 | 理由 |
|---|---|---|
| 人（开发者） | **脚本**（读改）+ `explain`（核验） | 三段骨架可读；判断是命名谓词，不必读懂整段 JS |
| 人（非开发者） | **演示录制**（S2） | 不用理解任何 schema，也不用写代码 |
| 外层 Agent | **脚本**（写）+ **IR**（读/审） | 两边都要：写时要任意表达力，审时要是纯数据（可校验、可冻结） |

- **推论**：既然作者主要是 Agent（2026-10-24 已确认），排序就是 **P0（实现收敛）→ S1（脚本作者面）**：
  Agent 最容易犯的是对齐错误（7 轮抄写 0 diff 的复核成本就是证据），而脚本把「源→产物」的对齐
  变成了「运行期一次构建」，同时 P0 让它的校验面只剩一套。人开发者不会被落下：`explain` 给中文计划、
  `.d.ts` 给编辑器补全、`check` 给路径级错误。

---

## 5. 候选方案

**先说一个容易被忽略的事实：代码曾经尝试住进 JSON 里，而且失败了。**
7 个 `transfer/specs/*.json` 都带 `ledger_js` 字段——**一段 JS 字符串**（`src/flow/flow.ts:56`）。
但 TS 侧**没有消费代码**（全仓 grep 只有接口字段 + `src/flow/transfer-flow.ts:21-24` 的迁移注释），
是个死字段。也就是说：「用纯数据描述流程」这条线**早就被撑破过一次**，当时的选择是「把代码塞进字符串」；
那次尝试既没有类型、没有检查、也没有高亮，最后被放弃。**A 方案做的事，是把这个需求接回来，
但用一等公民的方式（脚本 + 加载期校验 + `check`/`explain`），而不是字符串。**

| # | 方案 | 一句话 | 解决 | 代价 / 边界 | 今天已有的先例 |
|---|---|---|---|---|---|
| **A** | **隔离脚本作者面 → IR（推荐，2026-10-24 修订）** | `$AMBERFLOW_HOME/apps/<id>/app.mjs`：`export default build(kit)` 返回三段骨架（数据槽/决策判断/决策执行）；运行期 `import()`、内存降成 IR 后走同一套校验；**零 import、零构建、不进编译面** | ①不灵活 ②单一出处 ③可验证 ⑥新增需求的改动面 | 脚本=任意代码（信任边界，见 §8）；用户脚本不进 CI（靠 `check`/`explain` 补）；无类型检查（用 kit `.d.ts` + `check` 补） | `src/app/amberflow-home.ts:1-30`（用户作用域教条）、`tools/spec-to-pack.ts:100`（运行期 import 先例）、`src/cli/ip-config.ts:139`（builder 先例） |
| **A′** | ~~编译型 TS 作者面~~（**作废**） | `flows/<id>.ts` 类型化定义 → tsc/生成器产出 `pack.json` | — | **与「脚本与项目编译无关」直接冲突**；且 `flows/` 位于仓库根、不在防泄漏扫描面（`tools/apps_matrix.ts:31`） | 初稿 §6 P1 |
| **B** | 演示即配置（录制优先） | 人做一遍 → 归纳信号/不变量 → 落盘；人只回答 y/n | ④非开发者 ③可验证 | 需要活页面 + 人；只能录点击/填值；`when/retries/dangerous/slots` 演示不出来；页面变了会 drift | `npm run learn`、`apps:induce`、`plan:flow`（`apps/README.md:467-504`） |
| **C** | NL 清单（作者只写自然语言） | 步骤写 prose，运行期提名指令 | ①作者面最简 | 契约（needs/gives/signal）仍在；S0 实测提名准确率低于「傻基线」，现在不是第一步 | `docs/NL_FLOW_DESIGN.md`（分阶段：S1/S3 已落地，**S2/S4 标 ◐**） |
| **D** | 收敛数据面（不新增语言） | 三刀：flow 步语法收编、signal 单语法、hint 单实现；再加一个 cross-ref lint + JSON Schema | ②③⑤（部分①） | 会动 flow/pack 表示，可能需要一次显式重冻；①表达力天花板仍在 | 已有 hint 语法单实现的先例（`rules.hintMatchImpl`） |
| **E** | 只加工具 | JSON Schema + `amber apps check` + 编辑器补全 | ③（部分） | 不解决①②，只是让错误早到 | 现有 `validatePack` 已经是一半 |

### 5.4 「冻结语料」与「重冻」到底指什么（回答 2026-10-24 的提问）

**冻结语料** = 入库的黄金文件，测试按**逐字节**比它们。今天至少有五类：
六层对拍语料 `tools/*-corpus.json`（`npm run test:parity`）｜`tests/transfer.test.ts` 的 `dumpJs()` 逐字节｜
`apps/*/pack.json` 里的 `generated_from.plan_sha256`｜`bench/cases*.json` 的期望结果｜
`docs/arch-metrics.json` 的数字（`--check` 门禁）。它们是「行为没变」的唯一证据，所以不许漂。

**重冻（re-freeze）** = 用工具把这批黄金文件**整体重新生成一次**，连同哈希/pin 的更新，作为**一次单独的提交**入库；
提交说明写清「哪些变、为什么变、除预期项外 0 diff」。它不是「跑红了就 `--write` 一下」，
而是**一次有审计的事件**：一次、显式、单独提交——三个词各管一件事：
- **一次性**：整个迁移只做一次（不是每次跑测试都刷新）；
- **显式**：由一条命令触发、有人签字、diff 可审（不是 CI 自己变绿）；
- **单独提交**：和功能改动分开，bisect 时能一眼看出"这一提交只换了证据形态"。

**什么时候需要它**：只碰**序列化形态**、不碰运行时行为时才需要。例：把 `flow.json` 的步语法收编进
`pack.json`，行为等价但字节必变 → 黄金文件只能跟着换形，此时二选一：**拒绝这个改动**，或**显式重冻一次**。

**为什么现在不需要回答它**：按 §6 修订后的路线（脚本只做作者面、IR 不动、P0 第 1 刀降级为可选），
**没有任何已入库字节要变**——重冻问题从关键路径上消失。它只在将来真要合并两套步语法时才回来。

> **分层修正（2026-10-24 追加）**：上面的"不需要"只在 **L1**（脚本作者面、JSON 留作内存 IR）成立。
> 若目标定成「**原有 JSON 完全废弃**」（§10 L3），ctrip/transfer 两层的对拍基线对象会从"spec 展开"变成
> "脚本展开"，**必然需要一次重冻**——那时 §5.4 的四个字就派上用场了。

**不该叫重冻的三种情况**（都会让证据层失效）：
① 为了让测试变绿而改期望值；② 每次运行都重新生成（等于没有黄金文件）；
③ 接受混进非预期变化的 diff（日期、随机序、环境差异）——见到就停，别「先合了再说」。
`FROZEN_TODAY` 那次「周日绿周一红」就是 ③ 的现成教训：**不钉住的"冻结"会自己变。**

### 反清单（考虑过但不建议）

| 选项 | 为什么不选 |
|---|---|
| 换 YAML / TOML / Excel | **换皮**：C1-C5 一条不变，还多一个解析器 |
| 在 JSON 里造表达式语言（`if`/`for`/算术） | 走上「用数据格式实现编程语言」的老路，比直接写 TS 更差：无类型、无调试器、无重构 |
| 引入通用工作流引擎（Temporal/Argo 之类） | 丢的正是本仓的卖点：冻结语料逐字节、执行循环单实现、六层对拍、防泄漏门禁 |
| 把判分/执行循环/危险语义配置化 | `ARCHITECTURE.md:431-433` 已裁定：只会得到无法测试的字符串程序 |
| 大爆炸删除 JSON | 21 个应用、187 条旅程、六层对拍全要迁移；违反本仓「缺省等价、存量零迁移」的纪律 |
| 把作者面放进 `src/` 或需要 tsc 才能跑 | 违反「与项目编译无关」；`src/` 还会被泄漏/债门禁当成共享层（站点知识混进去就报债） |

---

## 6. 推荐路线（分阶段，每阶段带门禁）

### P0（不新增语言，只做 2/3/4 刀；第 1 刀降级为可选——**因此不涉及重冻**）

| 刀 | 做什么 | 证据/收益 | 门禁 |
|---|---|---|---|
| ~~1~~ | ~~flow 步语法收编~~ → **可选，本路线不做** | 两套步语法消失 | 它**会改字节** → 需要 §5.4 的重冻；而 S1 脚本可以分别发射两种形式，所以先不动 |
| 2 | **signal 单一语法 + 两个 adapter**：`signals.ts` 提供判别联合，`tool-signals.ts` 只做「进程面 adapter」，不复制组合逻辑 | §3 C2；脚本的 `judge.*` 谓词只落一种语法 | 现有 signal 测试 + 六层对拍全绿 |
| 3 | **hint 语法解析单一实现**：把 6 种形状的**解析**抽成纯函数（输入 = 元素属性视图），池侧与页面侧共用；**页面侧保留「同 pass 遍历 + 匹配 + stamp」** | §3 C2（脚本的 `target` 复用同一解析器）。`CLAUDE.md:224` 的实测纪律：匹配必须与 stamp 同一 pass | `tests/rules-tiered.test.ts` 20 条差分不变 |
| 4 | 一个 **cross-ref lint**（把 validatePack / validateProfile / returns 对账收进一处），并**把 `validateSource` 接进应用路径、给 `bench/cases*.json` 加校验** | §3 C3；脚本出错要在加载期一句话说清。**实测现有 8 个 sources 全部通过** | 新增测试：每个引用造一个坏例，全部在加载期红 |

**P0 的硬门禁：冻结语料 0 字节变化。** 2/3/4 刀都是**实现收敛**（同一个行为、同一个序列化），
所以这条守得住；第 1 刀因为会改形式，被移到"将来再说"（那时才需要 §5.4 的重冻）。

### S1（1-2 周）作者面：**隔离的应用脚本**

与原稿的差别，就是项目方 2026-10-24 的两条约束：**脚本不进项目编译**、**脚本与项目主体隔离**。

| 决定 | 做法 | 依据 |
|---|---|---|
| 脚本形态 | **`.mjs` 或 `.ts`**：都用运行期解释，**零构建**——不 tsc、不 bundler、不进 `tsconfig`/`vitest`（`.ts` 靠 Node 22.6+ 的 type stripping 解释；CLI 启动垫片已是这个模式 `bin/amber.mjs:13`） | `tsconfig.json` 的 `include` 只有 `src/**`、`tests/**`、`tools/**`（`apps/**` 与用户目录本就不在） |
| 依赖方向 | 脚本**不 import 仓库任何模块**；引擎注入冻结的 `kit` | 隔离 + 版本无关（升级引擎不用重写脚本） |
| 落盘 | 默认**不写** `pack.json`（内存 IR）；要审计快照时显式 `--emit` | 没有快照就没有"源↔产物"对齐；要快照就带 `generated_from` 血统 |

- 加载：`await import(pathToFileURL(file))` → `build(kit)` → draft → **`lower()`**（唯一翻译点，项目代码）
  → `validatePack()`（同一套 20+ 项对账，不新开第二套校验）。
- 位置：`$AMBERFLOW_HOME/apps/<id>/app.mjs`（或 `.ts`）。**这不是新机制**：`src/app/amberflow-home.ts:1-30` 已经写下
  「**应用是用户本地的流程配置，不是仓库的分享品**」，`appsSearchPath()` `:56-62` 已是 `[用户, 仓库]`、同 id 用户优先；
  仓库 `apps/` 从"归属地"降为**开发夹具**。
- **存量零迁移**：21 个 `pack.json` 一个字节不动；脚本只是新增加载路径（`--no-scripts` 强制走旧路径，行为逐字节不变）。
- 明确不做：不把脚本放进 `src/`（会进编译面，还会被泄漏/债门禁当成共享层）。

**硬门禁（四道，缺一不可）**：
1. 用脚本重写 **2 个既有应用**（建议 `checkin-binding` + `mixed-demo`），`lower(build(kit))` 与既有 `pack.json`
   **逐字段 0 diff**；
2. **确定性**：同一脚本连跑两次 `plan_sha256` 相同（时钟/随机当场现形）；
3. 加载期错误仍由**现有 validator** 报出（同一份问题清单，不是第二套语法）；
4. `--no-scripts` 回退后，既有 21 个包与今天**逐字节相同**。

### S2（1 周）录制产脚本

`npm run learn` / `amber record` 今天产出 JSON。改成产出 **S1 形态的 `app.mjs`**（三段式 + `recorded_from` 血统）：
人做一遍 → 机器写脚本 → 人只改数据槽与判断 → 运行。这样「简单直观」的入口和「可表达」的入口是**同一个源文件**。

**必须继承现行落盘门禁**：`tools/learn.ts:621-668` 的规矩是「规则模式 **0 次前向**回放通过才写文件」
（`:643` `verified = replay.ok && replay.forwards === 0`，不通过一个文件都不落）。写出脚本也算落盘，同样要过这道门。

### 6.5 脚本契约（草案）

**形状：三段骨架、一个函数、零 import。**

```js
// $AMBERFLOW_HOME/apps/checkin/app.mjs —— 无 import：kit 由引擎注入
export default function build(kit) {
  const { data, judge, exec } = kit;                       // 三段骨架的构造器
  return {
    id: "checkin-binding",
    goal: "把预订时间填进 <select> 并提交",

    // ① 数据槽：唯一值来源（常量 / 数据腿 / 运行期占位 / 前序产出）
    data: {
      room: "大床房",                                                    // 常量
      today: data.fromSource("calendar", { select: "today", field: "iso" }), // 数据腿回写
      out: data.runtime("out_dir") + "/report.txt",                      // 运行期占位（符号化）
      token: data.dataset("token"),                                      // 前序步骤产出
    },

    // ② 决策判断：何时适用 / 何时算完成 / 结束态断言（全部是命名谓词）
    judge: { invariants: [judge.url("thanks.html")] },

    // ③ 决策执行：线性步骤；每步自带判断（不靠 id 互相引用）
    exec: [
      exec.go("/search.html", { done: judge.url("results") }),
      exec.step("选择房型并提交", {
        when: judge.url("/search"),
        done: judge.all(judge.text("#cart", "1"), judge.url("thanks")),
        run: [
          exec.click("#open"),
          exec.select("#room", { from: "slot", key: "room" }),
          exec.click("#go"),
        ],
      }),
    ],
  };
}
```

**三段与 IR 的对应（这一个映射就是全部语义，没有隐藏含义）：**

| 脚本三段 | 落到 IR 的哪 | 运行期谁消费 |
|---|---|---|
| ① 数据槽 `data` | `slots` / `source_slots` / 步级 `slots` / `{dataset:NAME}` | 数据腿 + 绑定器 |
| ② 决策判断 `judge` | 步级 `signal`（done）/ `when` / `invariants`；步内声明的 `target_hints`、`commands` 约束 | 执行器判完成；**元素选择仍归运行期规则/模型**，脚本只能声明约束 |
| ③ 决策执行 `exec` | `journey`（`desc`/`adapter`/`source`/`args`/`retries`/`next`/`commands`） | `BrowserMiddleware.run`（唯一执行循环） |

**kit 的红线（决定了脚本能干什么）：**
- **没有模型**：kit 里不存在"问模型 / 选元素"的函数——运行期判断仍归引擎（红线②：值不来自模型）。
- **没有时钟/随机/网络/文件系统**：要「今天」用 `kit.today()`，它服从引擎的 `FROZEN_TODAY`/`--today` 钉法
  （否则「周日绿周一红」会从脚本这个口子复活）。
- **运行期值保持符号**：`data.runtime()` / `data.dataset()` / `{from:"slot"}` 只产出占位符；
  脚本里**做不了**"对运行期值算数"——那是运行期表达式，不在本方案承诺内（诚实边界）。
- **纯函数 + 普通数据**：`build` 不得有副作用，返回值必须可 `JSON.stringify`（函数/类/闭包一律拒绝）。
- **确定性可测**：引擎连跑两次比 `plan_sha256`，不一致就拒跑（`check` 里也跑）。

**它解决的是「构建期」的灵活，不是「运行期」的分支（边界要说清）**：循环、函数、组合、常量计算都在
`build()` 里完成，展开后 IR 是死的；**运行期**的分支仍只能用它今天能表达的那套（`when` / `next` / `commands`）。
脚本不会让"一步之内的条件分支"变成可能——那是执行循环的语义，不在作者面。

**给 Agent 写、给人读的三条命令：**

| 命令 | 给谁 | 输出 |
|---|---|---|
| `amber apps check <app.mjs>` | Agent（自纠） | 构建 + 校验，problems 是机器可读的**路径级**错误（`exec[1].run[2]: unknown op`） |
| `amber apps explain <app.mjs>` | 人（核验） | 展开后的中文计划：每步做什么、完成条件是什么、哪些值来自哪里 |
| `amber apps emit <app.mjs> --out x.json` | 审计 | 快照 IR + `generated_from {script_sha256, plan_sha256}` |

**信任边界（必须说清）**：脚本 = 任意代码，和配置文件不是一个信任级别。四条防线：
① 默认只从**用户作用域**加载（仓库脚本要显式放行，仅作夹具）；
② `--no-scripts` 全局开关；
③ 运行记录写 `app_sha256` + `plan_sha256`（出事能定位到字节）；
④ 真正的沙箱（子进程 + Node permission model）列为**可选后续项**——默认不做：kit 注入进子进程要序列化，成本高。

### 明确不做

判分口径、执行循环、危险/幂等语义、站点库存生成器（`ARCHITECTURE.md:431-433` 的裁定照旧）。

---

## 7. 验收指标（可证伪）

| # | 指标 | 今天 | 目标 | 怎么测 |
|---|---|---|---|---|
| 1 | 手写（非生成）的配置面 | **53 个配置 JSON 里 39 个无血统、作者不可判定**。行数口径必须先定：按「生成包产出的 journey+roles」计，8 个生成包 = 1372 / 3958 ≈ 35%；按「非生成文件里的行」计 ≈ 47.5%——**同一份数据两种读法差 18 个点，所以指标先钉口径再谈目标** | 定口径后，只留「判断类」：`invariants` / `notes` / `probe` / 危险语义 + 小应用 | `apps:matrix` + `node --experimental-strip-types tools/arch-metrics.ts` |
| 2 | 同一事实的手写处数 | **28 条事实抽样：平均 2.2 处**（剔生成物后 2.1） | **= 1** | `docs/_recon/alignment-cost.md` §计数 + 复跑 |
| 3 | 新增一种表达需求的改动面 | 5 处（loader/validator/runtime/doc/test） | **脚本侧 0 处**（kit 已有的能力直接可用）；**新增 kit 能力 = 1 处**（`src/app/app-script.ts`） | 用一个真实需求做对照（如「一步内 if/else 选 hint」） |
| 4 | 门禁数量 | smoke 里 5 个 `--check` 调用（4 个工具） | **不增加**（脚本不进 CI；`apps:gen --check` 与六层对拍原样） | `bench/smoke.sh` 行数 |
| 5 | 冻结语料 | 逐字节 | **逐字节不变**（本路线不需要重冻，见 §5.4） | `npm run test:parity` + `apps:gen --check` |
| 6 | 「应用是数据 / 0 行代码」 | 0（`apps:matrix` 债 0） | **重新定义**：`src/` 共享层 0 处站点知识（门禁不变）；应用脚本在**用户作用域**、**不进编译面**（`tsconfig.json` 的 include 不动）；仓库 `apps/` 仍是数据夹具 | `apps:matrix` 泄漏/债 = 0；`git diff tsconfig.json` 为空 |

---

## 8. 风险与边界（诚实）

1. **信任边界变了**：配置文件换成脚本 = 从"数据"变成"任意代码"。防线见 §6.5 四条；但要说透
   ——用户能装引擎就能写脚本，真正的隔离（子进程 + permission model）是**可选后续项**，不是第一版承诺。
2. **不进编译 ⇒ 没有类型检查**。缓解：kit 附 `.d.ts`（编辑器补全，不参与项目编译）+ `check` 的路径级错误
   + `explain` 的人话计划。**这三样才是"人可核验"的落点**，不是靠读 4000 行文档。
3. **用户脚本不进 CI ⇒ agent 写错只有运行时才知道**。所以 `check` 必须**便宜、可脚本化、错误带路径**；
   agent 工作流固定成「先 `check` 再 `run`」，并把它写进 kit 的示例与 README。
4. **三段式若做成「块状 + id 引用」**，会把 `{dataset:NAME}`/`source_slots` 那类字符串对账重新引进来
   ——这正是 §3 C3 的成本。所以草案用**步内聚**（每步自带 `when/done`，不互相引用），见 §9 新问题 1。
5. **脚本仍可能变成封闭层**：kit 必须小、声明式（谓词 + 动作 + 数据来源），`explain` 输出人话；
   若某个需求 kit 表达不了，**先问现有面能不能表达**，再考虑加 helper——不加新语法。
6. **A 方案不消灭 C4**（证据必须逐字节），也不消灭「用户脚本依赖的页面会变」——那是站点 drift，
   属于运行期问题（既有 `replayed_ok`/`drift` 机制管），不是作者面问题。

---

## 9. 已定的口径（2026-10-24 项目方答复）与剩下的 5 个小决定

**已经定了的（写进本稿）**：

| 原问题 | 答复 | 落到哪 |
|---|---|---|
| 应用目录允许出现 TS 代码吗？ | **用脚本构建应用；脚本与项目主体隔离、与项目编译无关** | §6 S1：`.mjs`/`.ts` + 用户作用域 + 运行期 `import()` + 零构建；原「编译型 `flows/*.ts`」作废 |
| 应用骨架由什么组成？ | **决策判断 / 数据槽 / 决策执行** | §6.5 三段契约 + 与 IR 的映射表 |
| 冻结语料允许重冻吗？ | （先问"重冻是什么"）→ **本路线不需要** | §5.4：P0 第 1 刀降级为可选，字节不动 |
| 未来谁写流程？ | **主要是 Agent，但人要能编辑、能核验** | §4 + §6.5：`check`（Agent 自纠）、`explain`（人核验）、`emit`（审计） |
| 先做 P0 还是 P1/S1？ | **先不决定** | 本稿只给排序理由，不催决策 |
| 脚本在运行期能干什么？ | **动态加载、更新、执行；若走通则原有 JSON 完全废弃**（目的：降门槛 + 提灵活） | §10：L1（作者面）→ L2（`flow(ctx)` 接管控制流 + trace 取代冻结计划）→ L3（删 JSON）；更新默认 run 边界冻结 |

**剩下 5 个小决定（都不阻塞方向，但会影响模板长什么样）**：

1. **三段式怎么落**：**步内聚**（推荐——每步自带 `when/done`，数据槽集中在 `data`，不靠 id 互相引用）
   vs **块状**（`judge` / `data` / `exec` 三个顶层块，靠 id 引用；会重新引入字符串对账，见 §8.4）。
2. **脚本允许放仓库吗**：默认只用户作用域；仓库 `apps/<id>/app.mjs` 只作**夹具**（可进 smoke，需要显式放行）。
3. **要不要第一版就上沙箱**：默认不沙箱（信任=装引擎的人）+ 四条防线；子进程沙箱列为后续项。
4. **`--emit` 默认开还是关**：建议**默认关**（内存 IR，没有"源↔产物"对齐），只在审计/交接时显式 `--emit`。
5. **脚本用 `.ts` 还是 `.mjs`**：`.ts` = 编辑器有类型（kit 的 `.d.ts` 生效）、运行期靠 Node 22.6+ strip-types 解释，
   **仍不进项目编译**（CLI 启动垫片本来就是这个模式，`bin/amber.mjs:13`）；`.mjs` = 零类型、零 surprise。
   Agent 写的话建议 `.ts`（类型提示能挡掉一类低级错误），但要接受"类型只在编辑器/`check` 里，不在项目 CI 里"。

**另有 3 个与 L3（JSON 全废）相关的拍板项**（废弃范围 / 热更新语义 / 是否现在就付迁移代价）：见 §10.7。

---

## 10. 目标形态：脚本即程序（JSON 可以完全废弃）

> 2026-10-24 追加：项目方要求脚本「**运行期动态加载、更新、执行**」，且若能走通**原有 JSON 完全废弃**，
> 目的是**降低流程编写门槛 + 提高灵活性**。这一节回答：三个动词各指什么、保证怎么续上、废弃的代价与阶段。
> 结论先说：**目标可以定，但必须分 L1→L2→L3 走；而且"废弃 JSON"本身不消除对齐成本——
> 消除它的是"控制流归语言 + 单一真相源 + trace 作为唯一审计物"。**

### 10.1 三个动词要拆开：加载 / 更新 / 执行

| 动词 | 含义 | 代价 |
|---|---|---|
| **动态加载** | 每次 run 时 `import()` 脚本（L1 已具备） | 无（多一次模块加载） |
| **动态更新** | 见下表三种语义 | 前两种可做，第三种不做 |
| **动态执行** | 脚本在运行期参与控制流（循环/条件/重试），不再只是 `build()` 返回数据 | **换运行时契约**：计划 → 轨迹；`when/next/retries` 从 schema 里删掉 |

**「更新」的三种语义，必须先选一个**：

| 语义 | 行为 | 影响 | 建议 |
|---|---|---|---|
| (a) run 之间更新 | 下一次 run 用新脚本 | 无（脚本 hash 随机记） | ✅ **默认** |
| (b) run 中换版本（watch） | 下一步起用新脚本 | 一次 run 不再对应一个可复现对象；trace 必须**逐步**记 `script_sha256`；resume 只能回到同版本 | ⚠️ 仅 `--watch` 显式开启 |
| (c) 运行中改已执行步骤 / 状态迁移 | 热补丁 | 不可审计、resume 无定义 | ❌ 不做 |

所以「运行期更新」的正确落法是：**默认 run 边界冻结版本（trace 记版本）；要边跑边改就显式 `--watch`，并逐步标版本。**

### 10.2 目标形态 L2：`flow(ctx)` + 结构化观察

```js
// $AMBERFLOW_HOME/apps/checkin/app.mjs —— 运行期就是程序本身
export default async function flow(ctx) {
  await ctx.open("https://…/search");
  for (const date of ctx.slots.dates) {                 // 运行期循环：JSON 表达不了
    const r = await ctx.step(`查 ${date} 的票`, {
      done: ctx.judge.url(`date=${date}`),              // 完成仍由引擎按 DOM 信号判
      act: ctx.hint("input[name=date]"),
    });
    if (!r.ok) continue;                                // 运行期条件：JSON 只能拆成两步 + when
    const rows = await ctx.extract(ctx.profile.list("fare_rows"));
    const cheapest = ctx.data.min(rows, "price");       // 数据规则仍在引擎（与数据侧同一实现）
    if (cheapest.price > ctx.slots.cap) continue;
    await ctx.step("选中最低价", { act: ctx.row(cheapest) });
  }
  return ctx.done({ invariant: ctx.judge.url("thanks") });
}
```

**引擎仍然独占这些（脚本拿不到，也绕不过）**：元素池扫描、规则/模型选元素、风险闸门、动作执行、
DOM 信号判定、绑定取值、数据腿、危险动作 dry-run+确认。
脚本只拿到**结构化结果** `{ok, evidence, value}`——**拿不到模型的自由文本**，所以红线②（值不来自模型）守得住。
「唯一执行循环」改称**唯一 step 执行器** `ctx.step`：脚本负责控制流，引擎负责"一步之内的一切"。

> **诚实边界：这是约定，不是强制。** 脚本在引擎进程内运行，`import` 任何东西都拦不住——
> 它可以直接 `import "playwright"` 绕过 `ctx`。Node 的 permission model 能挡 fs/子进程，**挡不住网络**，
> 所以"完全隔离"在本阶段做不到。防线只能是：用户作用域 + `--no-scripts` + `app_sha256` 入账 + review；
> 要强制隔离就得把脚本放进子进程、kit 走 IPC，那是另一项工程（列为可选后续，不在 L2 承诺内）。

**被删掉的 schema（这才是废弃 JSON 的真正收益）**：`when` / `retries` / `next` / `max_step_visits`
从"声明键"降级为语言构造（`if` / `while` / `try` / 循环）。**概念数减少，而不是换一种写法。**

**审计产物换代**：从「冻结计划 `pack.json`」→「**执行轨迹 trace**」：
`script_sha256` + 输入（slots/CLI）hash + 每步请求（desc / target 约束）+ 观察（ok / evidence）+ 判定依据。
resume 以 trace 为断点：**脚本版本或输入 hash 不一致就拒跑**（不猜）。

### 10.3 保证账本：JSON 死了，这些靠什么

| 现有保证 | 今天靠什么 | JSON 废弃后靠什么 | 有牙的钉法 |
|---|---|---|---|
| 计划可审计 | `pack.json` 静态可读 + `plan_sha256` | 脚本 hash + `explain` 展开 + trace | trace 契约测试 + `check`/`explain` |
| 值不来自模型 | IR 里没有模型输出 | 能力 API：脚本只拿 `{ok,evidence,value}` | `ctx` 不暴露模型文本（测试：API 面里没有） |
| 完成只认 DOM 信号 | `subgoal.signal` | 仍由 `ctx.step({done})` 判；脚本只能读结果 | 测试：脚本无法自报 done |
| 可复现 / resume | `TaskPlan` JSON checkpoint | trace + 版本/输入 hash | 不一致拒跑 |
| 六层对拍 / 冻结语料 | 配置 → 计划逐字节 | 脚本 → IR/轨迹逐字节 | **一次重冻**（§10.4） |
| 学习环落盘门禁 | learn 写 pack | learn 写脚本，同一门禁 | 0 前向回放才写（`tools/learn.ts:621-668`） |
| 危险动作三处同一说法 | `dangerous` / `dry_run_args` | `ctx.dangerous()` 仍走 dry-run + 确认 | 沿用 `REFUSAL_LABELS` |
| 工具步重跑纪律（`retries>0` 需 `idempotent`） | IR 里 `retries` + `idempotent` | `ctx.step({retry})` 仍校验 `idempotent`，否则拒跑 | 沿用 `src/app/app-adapters.ts:377-382` |
| 防泄漏 / 债 | `apps/` 是数据 | 脚本在用户作用域；`src/` 仍无站点知识 | 门禁范围不变（`tools/apps_matrix.ts:31`） |

### 10.4 完全废弃 JSON 的代价（量化）

| 面 | 数 | 说明 |
|---|---|---|
| 引用 `pack.json` 的文件 | **39**（其中 `tests/` 18） | 加载器 / CLI / 矩阵 / 套件 / learn / induce / 测试 |
| `loadPack(` 调用点 | **18** | 每处都要改成"脚本→IR"或直接删 |
| 引用 `flow.json` 的文件 | 9 | 语义流模板 |
| 引用 `transfer/specs` / `emitPlan` 的文件 | 18 | 生成器 + 对拍 |
| 碰 `TaskPlan` / 断点的文件 | 33 | resume 与 plan 编辑面 |
| 现有应用包 | 21（8 生成 + 1 录制 + 12 手写） | 每个都要迁移或经由过渡层 |
| 对拍语料 | 6 层 | ctrip/transfer 两层的**基线对象要从"spec 展开"换成"脚本展开"** |

**所以完全废弃不是「换加载器」，而是换运行时契约**——而且**必然触发一次重冻**（§5.4）：
`tests/transfer.test.ts` 的 `dumpJs()`、`tools/transfer-corpus.json`、`ctrip-corpus.json` 的比较对象都会变。
**修正上一轮的说法**：重冻"不需要"只在 **L1（JSON 保留为内存 IR）** 成立；走到 **L3（JSON 全删）就必然需要一次**。

### 10.5 迁移路径：L1 → L2 → L3（每步可独立验收）

| 级 | 形态 | 能拿到什么 | 代价 | 验收 |
|---|---|---|---|---|
| **L1** | 脚本 `build(kit)` → 内存 IR | 不手写 JSON；构建期灵活（循环/函数/组合） | 零保证损失 | 2 个既有应用脚本化后逐字段 **0 diff** |
| **L2** | 脚本 `flow(ctx)` + trace | **运行期**循环/条件；`when/next/retries` 从 schema 删除 | 新 trace 契约 + resume 改法 | trace 能重放一次真实 run；危险动作仍被拒 |
| **L3** | 删除 pack/flow/specs 加载路径 | 单一真相源（只有脚本） | 39/18/33 文件迁移 + **一次重冻** | 六层对拍在新基线上绿 + 21 包全部迁移 |

**过渡层（强烈建议）**：L3 前先做 `ctx.fromLegacy("<repo>/apps/x/pack.json")`——用脚本把既有包"包起来"跑在
新运行期上，21 个包**零改写**就能验；然后逐包"去 wrap"，每去掉一个就少一处对齐。
**不要一次性重写 21 个包。**

### 10.6 「降低学习门槛」要拆开说（诚实）

| 作者 | 门槛真的降了吗 | 为什么 |
|---|---|---|
| Agent | **降，明显** | 不用查 53 个 JSON / 8 套 schema 的键表；写代码是它的主场；错误有 `check` 的路径级提示 |
| 人（会 JS） | **语法门槛降，语义门槛没降** | `judge.*`/`ctx.step` 比 JSON 键更好发现；但"证据 / 绑定 / 三条红线"仍要学 |
| 人（不会 JS） | **没降** | 入口仍是录制（S2）；脚本不是给他们写的 |
| 维护者 | **核验门槛可能升** | 读任意代码比读固定 schema 难 → 必须靠 `explain` + trace 补 |

**结论：门槛下降来自「概念数减少」（删掉 4 个控制流键 + 单一真相源），不是「换成代码」本身。**
如果 L2 不真的删掉 `when/next/retries`，那只是换了写法，概念数没少，门槛没降。

> **还有一个定位问题要先想清楚**：仓库现在的身份是「**冻结计划**的浏览器自动化中间件：LLM 只规划一次」。
> L2 一旦落地，身份变成「**Agent 可编程**的浏览器自动化运行时：脚本即计划，审计靠轨迹」。
> 这不是作者面换皮，是**产品定位改变**——README、ARCHITECTURE 的立论、以及"冻结计划"这个词都要跟着改。
> 要不要付这个代价，是比技术选型更前面的问题。

### 10.7 需要拍板（新增 3 个）

1. **废弃范围**：只废"流程"类 JSON（pack / flow / specs / profiles），还是连 `sources`（取数配置）、
   `probe`（测量记录）、`rc`（机器配置）一起？**建议保留后三者**——它们描述"外部世界怎么取数/测什么"，不是流程。
2. **热更新语义**：run 边界冻结版本（推荐）vs `--watch` 允许中途换版本（trace 逐步记版本）。
3. **是否现在就接受 L3 的代价**（39/18/33 文件 + 一次重冻 + 21 包迁移）。若暂不接受：
   **L1+L2 已经能拿到「不手写 JSON + 运行期灵活」**，JSON 只作为内部 IR 与冻结语料存在——**用户侧已经看不见 JSON**。

---

## 附录：证据索引

| 论断 | 出处 |
|---|---|
| 53 个配置 JSON、8 套 schema、9 个有血统、5 个运行期写入、39 个无血统 | 侦察台账 `docs/_recon/config-surface.md` §一/§二；复跑命令在其页首 |
| 计量快照已过期：入库 3880 行 / 187 旅程 / 170-175 hint / when 7 / retries 12；重算 3958 / 190 / 171-178 / 7-15-1 | `docs/arch-metrics.json`（`generated_at 2026-10-18`）vs `node --experimental-strip-types tools/arch-metrics.ts --out /tmp/x.json` |
| 61% 机械内容、7 包 0 diff、7 轮复核 | `bench/AUTHORING_ASSESSMENT.md:13-16`, `:52-63`, `:97-107`（注意：61%/15 包是旧基线，`tools/arch-metrics.ts:7` 自认） |
| 21 个包级键 / 21 个步级键 / flow 16 个步键 | `src/app/app-pack.ts:53`, `:149`；`src/app/app-adapters.ts:31-43`；`src/flow/semantic-flow.ts:184-196` |
| `policy` 已加但 0 个包使用 | `grep -l '"policy"' apps/*/pack.json` → 0；键定义 `src/app/app-pack.ts:111-113`；消费点 `src/app/app-runner.ts:688-744`（不是死键） |
| 占位符只认 `[A-Za-z_][A-Za-z0-9_]*`、slot 值一律 String()；越界写法**静默不替换** | `src/app/app-pack.ts:359`, `:374`；实测 `{rows[0].price}`/`{n+1}` → `validatePack` 返回 `problems: []` |
| 步内分支不可表达 / 步间分支与回边已可表达 | `ARCHITECTURE.md:394`；反例（已能）见 `src/app/app-runner.ts:881-898`、`src/app/app-pack.ts:222-225` |
| 应用路径不跑完整 `validateSource` | 生产调用点仅 `src/data/datasource.ts:1583`、`tools/datasource-parity.ts:114`（tests 另有 19 处直调）；app 侧只做 `selects/counts` key 对账 `src/app/app-pack.ts:609-633` |
| `app-runner.ts` 注释谎称会 validate | `src/app/app-runner.ts:590-592` vs 实现 `src/data/datasource.ts:1190-1216` |
| `bench/cases*.json` 无运行期校验 | 无 `validateCase`；读取点 `src/cli/bench.ts:247`、`tools/cache_measure.ts:22`、`tools/hint_measure.ts:28` |
| 站点档案两套互斥 schema；文件缺失静默降级 | authored `src/flow/semantic-flow.ts:193-196` vs learned `src/flow/semantic.ts:188-193`；缺失见 `semantic-flow.ts:265-274` |
| 生成器只拒 spec 无对应物的**步级**键 | `tools/spec-to-pack.ts:391-415`、`:538-544`；`invariants/notes/device/probe` 是原样搬运（`:344-356`） |
| `ledger_js` 是死字段（曾把 JS 塞进 JSON 的失败尝试） | 字段 `src/flow/flow.ts:56`；无消费代码，`src/flow/transfer-flow.ts:21-24` 只是迁移注释 |
| 28 条事实平均 **61/28 ≈ 2.2 处** / 21 个门禁 / 52% 咬过人 | `docs/_recon/alignment-cost.md` §计数（含算法与原始数列） |
| 同一提交打红五处（含 tests/ctrip.test.ts 3 条） | `git show --no-patch a784e75`；`bench/smoke.sh:73-79`（注：CLAUDE.md 写「四处」、`tools/frozen-today.ts:6-8` 写「三处却列四项」——**计数本身也在漂**） |
| 「单一出处」仍有第二份日期副本 | `bench/smoke.sh:75,79` 写死 `2026-10-02`，未引用 `tools/frozen-today.ts` |
| `--slot foo=1` 曾假绿（exit 0 + 5/5） | `git show --no-patch 30ecc9a`；`src/app/app-pack.ts:836-841` |
| datasource 五类内部引用加载期放行（探针实测） | `docs/_recon/alignment-cost.md` §6；`src/data/datasource.ts:990`（错字段名 → 静默 0/N） |
| 跨面（DOM/进程）同一坏输入的差分对拍不存在 | `tests/tool-signals.test.ts:22` |
| hint 两份实现、漂移两次（第三处漂移假设已被实测证伪） | `src/engine/rules.ts:300,310`；`src/engine/extraction.ts:785`；`ARCHITECTURE.md:401-405`；证伪见 `docs/_recon/alignment-cost.md` §3 |
| signal 双写（算子表 + 组合语义 + 校验器各两份） | `src/engine/signals.ts:179`；`src/browser/tool-signals.ts:29`、`:57`；`src/engine/plan.ts:257-284` |
| when 漏校验（**作者**在第 3 轮发现，不是复核） | `src/engine/plan.ts:252-256`；`CLAUDE.md:311-312` |
| flow 的 next 已支持但文档仍说没有 | `src/flow/semantic-flow.ts:316-318` vs `ARCHITECTURE.md:397`（仓库 3 个 flow.json 均为 v2，无 v3 实例） |
| FROZEN_TODAY：同一提交周日绿周一红 | `tools/frozen-today.ts`；`bench/smoke.sh:72-73`；事故提交 `a784e75` |
| 5 个 `--check` 调用（4 个工具） | `bench/smoke.sh:40,42,46-47,83-84,88-89`（3e 默认 SKIP） |
| 判分/执行循环/库存生成器不可配置 | `ARCHITECTURE.md:431-433` |
| 防泄漏/债扫描面目前只有 `src/` | `tools/apps_matrix.ts:31`（`walkTs(REPO/src)`）、`:272`（泄漏/债只遍历 SHARED） |
| 录制落盘门禁：规则模式 0 前向回放通过才写 | `tools/learn.ts:621-668`（`:643` `verified = replay.ok && replay.forwards === 0`） |
| 已经存在的 TS builder 先例 | `src/cli/ip-config.ts:139`；`bench/AUTHORING_ASSESSMENT.md:168-186`（7 spec + 1 builder = 8 生成包） |
| plan:flow 会写 flow/profile 但不留血统 | `src/flow/plan-flow.ts:855-857`, `:897-906` |
| NL 清单的现状与实测边界 | 实测 `docs/NL_FLOW_DESIGN.md:264`；设计一句话 `:33-38`；S2/S4 标 ◐ |
| 录制/归纳的既有能力 | `apps/README.md:467-504` |
| 脚本不进编译的实测依据 | `tsconfig.json` 的 `include: ["src/**/*.ts","tests/**/*.ts","tools/**/*.ts"]`（`apps/**` 与用户目录本就不在） |
| 用户作用域 / 仓库 apps 是夹具的教条 | `src/app/amberflow-home.ts:1-30`；`appsSearchPath()` `:56-62`；发现顺序 `[用户, 仓库]` `src/app/app-pack.ts:273-280` |
| 脚本可 `.ts` 且仍不算项目编译 | `bin/amber.mjs:13` 已用 `node --experimental-strip-types` 跑 TS 入口；`tsconfig.json` 不 include 应用目录 |
| 运行期 `import()` 先例 | `tools/spec-to-pack.ts:100`（`--source` 模块加载） |
| 完全废弃 JSON 的迁移面（§10.4） | `grep -rl 'pack\.json' src tools tests \| wc -l` → 39（tests 18）；`grep -rn 'loadPack(' src tools` → 18 调用点；`grep -rl 'flow\.json' src tools tests` → 9；`grep -rl 'emitPlan\|transfer/specs' src tools tests` → 18；`grep -rl 'TaskPlan\|task_plan' src tools tests` → 33 |
| 脚本可运行期 import 的依据 | `tools/spec-to-pack.ts:100`；`bin/amber.mjs:13`（strip-types 启动） |
| 本稿所有事实性论断的独立复核 | `docs/_recon/verify.md`（29 行证据索引 + 6 条最强论断证伪） |
