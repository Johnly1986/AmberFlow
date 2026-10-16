# NL Flow 测试用例独立复核（2026-10-15）

> **审判对象**：本会话为 `docs/NL_FLOW_DESIGN.md`（S0–S4）写的 5 个测试文件、共 **57 条**用例：
> `tests/dataset.test.ts`(11) · `tests/nominate.test.ts`(12) · `tests/semantic-instructions.test.ts`(13) ·
> `tests/semantic-nominate.test.ts`(15) · `tests/semantic-next.test.ts`(8)。
> **审判方式**：不看作者意图，只看**测试实际能证伪什么**——对每条验收主张问"删掉/改坏实现，哪条用例会红"，
> 并用一次**静态探针**与一次**产物篡改**去证伪可疑的绿。
> **结论一句话**：整体是行为级、有负例、缺省等价有语料钉——**但复核抓到 2 处真缺陷（1 处是"绿得可疑"、
> 1 处是"证据没有门禁"）+ 4 处覆盖缺口**，本轮全部已修（新增/加强 7 条用例 + 1 个门禁 + 1 个仓库级守卫），
> 另有 5 条如实记为未修（含一条结构性缺口，是当前最该补的东西）。

## 0. 复核结论表

| # | 发现 | 严重度 | 状态 |
|---|---|---|---|
| 1 | **锁到不可执行的指令 = 静默降级 + 谎报提名**（校验放行、候选序坍缩、runner 走浏览器支线仍报 `via=locked`） | **高** | ✅ 已修（加载期单出口红 + 2 条测试） |
| 2 | **S0 冻结产物没有门禁**：文档里"model 4.8% / 基线 51.5%"的唯一出处无 `--check`、不在 smoke/verify | **中高** | ✅ 已修（`--check [--no-model]`，实测有牙；smoke 2d 无条件 + 3e 模型侧 opt-in） |
| 3 | 单一出处守卫只扫一个工具文件，仓库别处出现第二份梯级正则不会红 | 中 | ✅ 已修（仓库级扫描 `src/ tools/ integrations/`） |
| 4 | runner 的 `instr` 锁定路径与 `verifyBackfill:false` 消融口**零 e2e** | 中 | ✅ 已修（2 条 e2e） |
| 5 | S4 账单只断言了 `committed`，`via/drift` 没有断言（账单可能与报告行各说各话） | 中 | ✅ 已修（三臂各断言 `via`，drift 臂断言 `drift:1`） |
| 6 | S3 覆盖缺口：模板级 `max_step_visits` 未测；"被跨过 skipped"与"后来经边进入给真实结果"未在同一次运行里区分 | 低 | ✅ 已修（2 条 e2e） |
| 7 | **数据集只有消费面、没有生产写入者/失效调用者**（`write`/`invalidateStep` 在 `src/` 零调用） | **高（结构）** | ⬜ 未修（已在设计文档 S1 行补注；需指令输出契约落地后才接） |
| 8 | 元素动作提名**不约束执行器动作分类**——报告语义易被读成"指令已强制" | 中 | ◐ 已加钉子测试把边界钉死；真正的强制留到 S3 |
| 9 | model 臂数字绑定本机权重：无产物机器上 `--check` 永远"未比" | 低（设计上不可消除） | ⬜ 如实标注（跳过 ≠ 通过） |
| 10 | 两个 e2e 夹具各复制一份 `PAGE/mkdtemp` 样板 | 低 | ⬜ 记录（第三个夹具出现再抽 `tests/fixtures.ts`） |
| 11 | `executableInstructionOrder` 直测偏内部 | 观察 | ⬜ 可接受（导出 API 且被 runner 消费） |

## 1. 已修：抓到的一处"绿得可疑"（发现 1）

**症状**：`validateTemplate` 对下面这份模板返回 `[]`（无问题）：

```jsonc
{ "id": "pick", "nominate": true, "instr": "list_pick", "signal": {...} }   // 没有 list_step
```

**探针实证**（`/tmp/probe-lock.ts`，静态、无浏览器）：

```
validateTemplate problems: []
compiled: { kind: 'browser', instr: 'list_pick', list_candidate: undefined }
executableInstructionOrder: ["list_pick"]
=> 锁到 list_pick 但无候选：runner 会走浏览器支线并把 via 记成 locked（谎报）
```

**为什么原来的测试没抓到**：`instr` 的两条用例只验了"闭集内"与"必须伴随 nominate"，
**没验"锁的这条指令此刻可不可执行"**；候选序的单测又只用带 `list_candidate` 的步做正例。
两个绿各自成立，合起来漏掉了交集。

**修法（单出口）**：加载期红，措辞点名补救办法——
`steps[i].instr "list_pick" needs a list_step candidate（候选参数是声明的；锁到不可执行的指令 = 静默降级 + 谎报提名）`；
并在同一条用例里给"带 list_step 的对照"必须无问题（防止修成"一律拒绝"）。

## 2. 已修：一份没有门禁的"冻结证据"（发现 2）

**症状**：`bench/instruction-nomination/{nomination.json,REPORT.md}` 是设计文档与本次复核里
"model 4.8% ｜ 基线 51.5% ｜ 枚举 100%"的**唯一出处**，但 `grep` 证实：没有任何 `--check`、
smoke、verify 引用它 —— 改词表、改夹具、手改报告都不红。对照仓库既有标准
（`drift-real-arm.json` 有 `--check` 且进 smoke 3d），这是**同类证据两套待遇**。

**修法**：工具加 `--check [--no-model]`：复算**语料计数 + 规则/基线/枚举三臂 + 闭集与枚举序**
与产物逐项比对；model 臂只在**产物与本机都 `on`** 时比，否则打印"未比（跳过 ≠ 通过）"。
smoke 接两道：`2d`（`--no-model`，无条件）与 `3e`（模型侧，`NOMINATE_CHECK_MODEL=1` 显式打开，
不设就打印 SKIP 与代价说明）。

**实测**：

| 场景 | 命令 | 结果 |
|---|---|---|
| 原产物 | `nominate:measure -- --check --no-model` | `exit 0`：`语料 14 包 / 165 步 + 离线三臂 + 闭集/序与产物一致` |
| 原产物（含模型） | `… --check` | `exit 0`：`model 臂 已比（8/165）`——**头条数字逐数复现** |
| 篡改一位（`first-candidate.correct` 85→86） | `… --check --no-model --out /tmp/nom-check-teeth` | **`exit 1`**：`scores.first-candidate.correct: 产物 86 ≠ 复算 85` |

**边界**：`--check` 不做字节比对（产物含 `generated_at`，且 model 行依赖权重），比的是**可复算的标量**；
model 臂在无产物机器上永远"未比"——这一点被打印出来，不静默当绿。

## 3. 已修的覆盖缺口（发现 3–6）

- **发现 3｜守卫太窄**：原守卫只读 `tools/instruction_nomination.ts`。改成遍历
  `src/ tools/ integrations/` 所有 `.ts`（排除 `src/nominate.ts` 定义处），命中的是**梯级正则的
  特征片段**（`最低价|最低`），不是散文里的"最低价"。当前全仓命中 0 处（守卫是绿的，且有牙：
  往任何 `.ts` 贴一份词表它就会红）。
- **发现 4｜runner 两条分支零 e2e**：
  ① `instr: "list_pick"` 锁 → `via=locked`、仍过**指令回填门**落盘、`method` 如实记 `"locked"`
  （这条同时证明了 `INSTRUCTION_METHODS` 扩 `locked/learned` 是必要的）；
  ② `verifyBackfill:false` → 按现状落盘但 `replays_ok` 停在 0（"没验过"如实可见）。
- **发现 5｜账单缺断言**：drift 臂现在断言 `nominate_bill {via:{learned:1}, drift:1}`、
  锁臂 `{via:{locked:1}, committed:1}`、消融臂 `{via:{rule:1}}`——账单与报告行是同一份账。
- **发现 6｜S3 两处**：`max_step_visits: 2` 声明后第 3 次进入即 `next_cycle`（证明模板级值真被采纳，
  不是只吃缺省）；同一次运行里 `b` 被边跨过记 `skipped`、`c` 后来经另一条边进入给**真实结果**，
  且"一步一条不重复"（这是我写的 `ranIdx`/去重逻辑此前唯一的直接断言）。

## 4. 未修（如实记录，含判断）

**7（高，结构）｜数据集有"能力"没有"生产者"。** `grep` 实证：`DatasetStore.write`、
`createDataset`、`invalidateStep` 在 `src/` 内**零生产调用**；`RunOptions.dataset` 只在
`executor.ts:1786` 被消费（靠调用方注入）。也就是说 §2.3 的三条规则里，
"具名/溯源"在存储与绑定层是活的，"**步重跑 ⇒ 该步条目失效**"目前**没有生产触发者**；
设计文档 §10-S1 写的阶段内容"demo-app 改写一例"实际未做（阶段**验收列**的
needs_value/失效/溯源三项是在单元与注入层达成的——这一点不改写，但读者会误读成端到端已接）。
本轮已在设计文档 S1 行补注。**建议**：等指令输出契约（S3 组合层）落地时一并接
"指令产出 → `dataset.write` / 步重跑 → `invalidateStep`"，并在那时把 demo-app 改成端到端例。

**8（中）｜元素动作提名不约束执行。** 已加钉子用例（见上）；真正的强制要等 S3 组合层，
现在报告里的 `instruction/via` 对 click/fill/select/check 只是**提名记录**，不是执行保证。
文档与代码注释已写明，测试现在也钉住了——**不建议**在这之前把报告措辞改成"已按指令执行"。

**9（低）｜model 臂快照性质**：无产物机器上 `--check` 只能"未比"；这是冻结证据的固有边界
（文档已要求标注"何时、何命令测的"）。

**10（低）｜夹具样板**：`nominateApp` 与边界钉子各写了一份 `PAGE/mkdtemp` 样板；
第三个夹具出现时抽 `tests/fixtures.ts`，现在抽是为两个实例搭抽象。

**11（观察）｜`executableInstructionOrder` 直测**偏内部，但它是导出 API 且被 runner 消费，
断言的是"候选序含/不含 list_pick"这类**对外可观察的候选集**，可接受。

## 5. 复核方法（可复算）

```bash
# 全部新用例（57 条）
npx vitest run tests/dataset.test.ts tests/nominate.test.ts tests/semantic-instructions.test.ts \
  tests/semantic-nominate.test.ts tests/semantic-next.test.ts
# 冻结产物的门禁（离线快跑 / 含模型）+ 牙口验证
npm run --silent nominate:measure -- --check --no-model
npm run --silent nominate:measure -- --check                    # ≈10 min（165 次真前向）
cp -r bench/instruction-nomination /tmp/x && 改 /tmp/x/nomination.json 里一个数 \
  && node --experimental-strip-types tools/instruction_nomination.ts --check --no-model --out /tmp/x   # 期望 exit 1
# 结构守卫（含仓库级扫描）
npx vitest run tests/nominate.test.ts
# 探针（发现 1 的证伪脚本思路）
#   构造 {nominate:true, instr:"list_pick"}（无 list_step）→ validateTemplate==[] → compile→ browser
#   → executableInstructionOrder==["list_pick"] ⇒ runner 无法执行却会报 locked
```

> **本复核自己的边界**：只审了本会话新增的 5 个测试文件与它们声称的证据，
> 未重审仓库既有 1100+ 条用例（那需要另一轮）；"已修"的判定依据是本节复算命令的实际输出，
> 不是断言的数量。发现 7/8 是**结构与语义**层面的，改它们会动设计面，故只记录 + 补注，
> 不在这轮偷偷放宽或加戏。
