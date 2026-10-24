# L2 实施计划（P0 → L1 → L2；S2 随后；L3 另立）

**日期**：2026-10-24 ｜ **状态**：计划稿，未实施，无代码改动
**依据**：[FLOW_AUTHORING_ALTERNATIVES.md](FLOW_AUTHORING_ALTERNATIVES.md)（§10 L1/L2/L3 与保证账本）、
[L2_CTX_API_DRAFT.md](L2_CTX_API_DRAFT.md)（Q1–Q6 已定稿）
**读者**：实施者（人）+ 执行 Agent。每个任务都有**退出条件**与**回退方式**，没有"做完再说"。

---

## 0. 决策记录（已定稿，实施不得偏离）

| # | 决策 | 影响 |
|---|---|---|
| Q1 | **`act` 必填**；纯导航步用显式 `ctx.arrive(url,{done})` | 「什么都没声明」从运行期 `step_names_no_target` 变成**加载期错误**；需要给 2 个 bilibili-hot 步补 `arrive` |
| Q2 | 模型侧数字/归属（`conf`/`method`/`score_kind`）**只在 trace**；脚本只看 `stopCode` | `StepResult.evidence` 只留 `{url,attempts,elements,elapsedMs}`；低置信行为用闭集 `onLowConfidence` |
| Q3 | `meta.site` 取代 profile JSON 放 **L3**；迁移期读旧档案 | L1/L2 不动 `sites/*.profile.json` |
| Q4 | `probe` 不进脚本（留 JSON/独立测量面） | 测量型应用不参与 L1/L2 |
| Q5 | v1 不给 `ctx.rows({row,fields})`，只给 `ctx.extract(name)` | 抽取语法零新增 |
| Q6 | `ctx.done()` 必需 | 缺调用 = 结构化停因 `flow_returned_without_done` |

**范围**：本计划只做 **P0 + L1 + L2**（+ 可选 S2）。**L3（删 JSON）单独立项**，前置条件见 §7。

---

## 1. 目标与非目标

**目标**
1. 作者面变成**隔离脚本**（用户作用域、零构建、不进 tsconfig/vitest/CI）。
2. 运行期支持**控制流**（循环/条件/重试），同时保住三条红线与既有证据层。
3. 概念净减：`when`/`retries`/`next`/`max_step_visits`/`max_subgoals`/`roles`/`journey`/`source_slots`/`{dataset}` 不再存在。

**非目标（本计划不做）**
- 不删 `pack.json` / `flow.json` / `transfer/specs`（L3 才删）。
- 不改判分口径（`src/data/ctrip-oracle.ts` 保持独立第二实现）、不 fork 执行循环、不配置化危险语义。
- 不把 `sources/*.json`、`probe`、`configs/amberflowrc*` 脚本化。
- 不动仓库 `apps/` 的 21 个包（L1/L2 期间一个字节不改）。

---

## 2. 不可破的约束（每阶段都要重跑）

| 约束 | 证据 |
|---|---|
| 冻结语料逐字节不变（L3 除外） | `npm run test:parity`（六层）、`apps:gen -- --check`、`tests/transfer.test.ts` |
| 执行循环单实现 | `ctx.step` 必须调 `BrowserMiddleware.run`（`src/engine/executor.ts:1530`），不得复制循环 |
| 值不来自模型 | `ctx` 不返回模型文本/分数；`trace` 只留 `method`/`conf` |
| 完成只认证据面 | `ctx.step({done})` / `ctx.arrive({done})` 由引擎裁决 |
| 危险动作默认拒绝 | `ctx.dangerous` → dry-run + `confirmToolStep`（`src/app/app-runner.ts:87`） |
| 学习环落盘门禁 | `tools/learn.ts:621-668`：规则模式 **0 前向**回放通过才写 |

**基线（本计划开始时的绿色定义）**
- **2026-10-24 本机实测**：`apps:gen --check` **8/8**、`probes:baseline --check` **3/3**、工作树干净（仅 `docs/` 下新增设计稿，源码零改动）。
- **门禁定义（每阶段必须跑）**：`npm run verify`（typecheck + 测试 + 六层对拍；测试数约 1317，口径见
  `docs/arch-metrics.json` 的 `tests`）｜`bash bench/smoke.sh`｜`npm run apps:suite`。
- 上两项**本机未在本次会话复跑**（耗时较长），实施第一件事是跑一遍确认基线绿——见 §13 第一条命令。

---

## 3. 阶段总览

| 阶段 | 交付 | 依赖 | 估算（人日） | 退出条件 |
|---|---|---|---|---|
| **P0** | 实现收敛：signal 单语法、hint 解析单实现、cross-ref lint | 无 | **3–5** | 字节不变 + 全绿 |
| **L1** | 脚本作者面（`meta(kit)` + `app(kit)` → 内存 IR） | P0 | **8–12** | 2 个应用 **0 diff** + `--no-scripts` 等价 |
| **L2** | `flow(ctx)` + real/dry/replay + trace | L1 | **12–18** | 3 个试点应用 + trace 重放一致 |
| **S2**（可选） | 录制产脚本 | L1 | **5–7** | 0 前向回放门禁通过才落盘 |
| **L3**（另立） | 删 JSON | L2 稳定 | **15–25** | 一次显式重冻 + 全量迁移 |

> 估算假设：1 名熟悉本仓库的工程师；±50%；不含 L3。

---

## 4. P0：实现收敛（3–5 人日，零行为变化）

**总门禁**：每个子任务完成时 `npm run verify` + `bash bench/smoke.sh` 全绿；`git diff` 里**没有任何 `apps/`、`transfer/specs`、`tools/*-corpus.json` 的字节变化**。

### P0-A 信号语法单实现（1–1.5 人日）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/engine/signals.ts` | EDIT | 导出 `validateSignalSpec(spec): string[]`（把 `src/engine/plan.ts:257-284` 的递归 walker 迁入，逻辑不改） |
| `src/browser/tool-signals.ts` | EDIT | `validateToolSignal` 改为委托同一 walker + 进程面叶子表；`checkToolSignal` 保留（观察面不同） |
| `src/engine/plan.ts` | EDIT | `checkSignalSpec` 调用统一实现（`:252-256` 的注释作废，改指向新出处） |
| `tests/signal-grammar.test.ts` | NEW | **跨面差分 ≥12 例**：同一坏输入（未知算子/arity 错/空 all_of/坏 not）在 signal 与 tool-signal 两面产出**同一条 problem 文本** |

**退出**：`tests/signals.test.ts` + `tests/tool-signals.test.ts` + `tests/plan.test.ts` + 新差分全绿；对拍不变。
**回退**：纯函数抽取，`git revert` 即可；无数据/接口变更。

### P0-B hint 解析单实现（1–1.5 人日）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/engine/rules.ts` | EDIT | 从 `hintMatchImpl`（`:184`）拆出 `parseHint(hint): ParsedHint`（纯函数，输入 = 属性视图） |
| `src/engine/extraction.ts` | EDIT | `hintLookup`（`:785`）的 `HINT_HEAD` 改为调用 `parseHint`；**保留"同 pass 遍历 + 匹配 + stamp `data-hintref`"**（`CLAUDE.md:224` 的实测纪律） |
| `tests/hint-grammar.test.ts` | NEW | 池侧/DOM 侧共用同一解析器的差分：6 形状 × 边界（大小写、多词、near、裸词） |

**退出**：`tests/rules-tiered.test.ts` 20 条差分 + `tests/extraction.test.ts` 全绿；stamp 仍在同 pass（断言在 extraction 测试里）。
**回退**：同上。

### P0-C cross-ref lint + 接 validateSource + cases 校验（1.5–2 人日）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/app/cross-ref.ts` | NEW | `lintPackCrossRefs(pack, {sources, profiles}): string[]`——**把现有检查迁入**（`{slot}`、`source_slots`、`{dataset}`、`returns`、`next` 落点、probe host），不新增规则 |
| `src/app/app-pack.ts` | EDIT | `validatePack`（`:541`）调 lint；应用路径加载 sources 时跑 `validateSource`（`src/data/datasource.ts:1282`） |
| `src/cli/bench.ts` | EDIT | 新增 `validateCase`（`start_url` 是仓库内文件、signal 形状、slots 形状） |
| `tests/cross-ref.test.ts` | NEW | 每类引用一个坏例，全部加载期红 |

**退出**：`apps:gen --check` 8/8、`probes:baseline --check` 3/3、`apps:suite` 全过；**实测 8 个 sources 全部通过**
（已用探针验证过：无存量误报）。
**回退**：lint 是新增调用点；关掉调用即回退。

---

## 5. L1：脚本作者面（8–12 人日）

**形态**（与 L2 的区别：L1 不执行控制流，只**构建**）

```js
// $AMBERFLOW_HOME/apps/checkin/app.mjs（或 .ts；运行期 strip-types，不进 tsconfig）
export const meta = (kit) => ({ id, label, goal, hosts, slots, sources, site, invariants, notes, limits });
export const app  = (kit) => ({ data: {...}, judge: { invariants }, exec: [ /* 声明式步骤 */ ] });
```

### L1-1 kit + 加载器 + 降级（4–6 人日）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/app/kit.ts` | NEW | `createKit()`：`judge.*`/`tool.*`/`hint`/`hints`/`row`/`command`/`value.*`/`data.min,max`——**纯构造器**，不接触运行时 |
| `src/app/app-script.ts` | NEW | `loadAppScript(path)`：`import()`（先例 `tools/spec-to-pack.ts:100`）→ 调 `meta(kit)`/`app(kit)` → `lower(draft)` → `AppPack`；错误带 `flow#exec[3]` 路径 |
| `src/app/app-script.ts` | NEW | `lower(draft, meta)`：三段 → `journey`/`invariants`/`slots`/`source_slots`/`hosts`/`device`（唯一翻译点） |
| `src/app/app-pack.ts` | EDIT | `loadApp(idOrPath)`：`app.mjs`/`app.ts` 优先，`--no-scripts`/`AMBERFLOW_NO_SCRIPTS=1` 回退 `pack.json` |
| `src/app/app-runner.ts` | EDIT | 走 `loadApp`（其余逻辑一行不改） |
| `types/amberflow-kit.d.ts` | NEW | 编辑器类型（**不进** `tsconfig.json` 的 include） |
| `tests/app-script.test.ts` | NEW | 契约错误（无默认导出/返回不可序列化/抛异常）、`--no-scripts` 逐字节等价、`act` 缺失=加载期红、确定性（`app(kit)` 连跑两次同 `plan_sha256`） |
| `tests/app-script-equivalence.test.ts` | NEW | **`apps/camera-entry`（web 4 步 + 3 不变量）+ `apps/cli-report`（5 个工具步：`retries`+`idempotent`+`dangerous`+`dry_run_args`）**脚本化后 `lower()` 与既有 `pack.json` 展开**逐字段 0 diff**——两条腿都覆盖，才证明降级没漏 |

**退出**：
1. 两个等价测试 **0 diff**（web + 工具步各一）；
2. `--no-scripts` 下 `apps:suite` 全绿且输出逐字节不变；
3. `git diff apps/*/pack.json tsconfig.json` 为空；
4. 故意在 `apps/` 放坏 TS，`npm run typecheck` 仍绿（证明不在编译面）。

### L1-2 命令面 + 文档（2–3 人日）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/cli/commands/apps.ts` | EDIT | `check <script>`（构建+校验，problems 带路径）、`explain <script>`（三块渲染成人话）、`emit <script> --out`（快照 IR + `generated_from {script_sha256, plan_sha256}`） |
| `src/cli/registry.ts` / `main.ts` | EDIT | 命令表与分发（单一出处，不手写第二份 usage） |
| `apps/README.md`、`README.md` | EDIT | 作者指南：三块骨架 + 三条命令 + 「不进编译面」的实测依据 |
| `tools/apps_matrix.ts` | EDIT | 「来源」列加 `script`；仓库内夹具脚本纳入泄漏/债扫描（用户目录不扫，理由：它不在仓库） |
| `tests/app-script-cli.test.ts` | NEW | check/explain/emit 的 JSON 输出与退出码 |

### L1-3 试点迁移（2–3 人日）

| 文件 | 动作 | 内容 |
|---|---|---|
| `tests/fixtures/scripts/camera-entry.mjs` | NEW | 手写 L1 脚本（web 4 步 + 3 不变量 + 行内证据路由） |
| `tests/fixtures/scripts/cli-report.mjs` | NEW | 手写 L1 脚本（工具步：重试+幂等、危险步 dry-run） |
| `apps/bilibili-hot/pack.json` | **不动** | 但记录：Q1 后它的 2 个纯导航步应在下一轮脚本化时写成 `ctx.arrive` |

> 试点放 `tests/fixtures/` 而不是 `apps/`：**不破坏 `apps:gen --check`**，也不改任何入库包。

---

## 6. L2：`flow(ctx)` + trace（12–18 人日）

### L2-1 ctx 契约与三种实现（6–9 人日）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/app/ctx.ts` | NEW | real ctx：`step` → `mw.run(desc, url, {goalSignalFn, targetHint(s)/commands, precondition, slots, page})`（`:1530`）；`arrive` → 同路径 `targetHint:null`；`open` → `disallowedHost`（`:586`）+ `goto`；`read.*` → `locatorAnyFrame`（`src/engine/extraction.ts:212`）/`snapshot`（`src/engine/executor.ts:1213`）；`holds` → `checkSignal`（`src/engine/signals.ts:30`）；`source` → `runSource`（`src/data/datasource.ts:1453`）；`run`/`dangerous` → `runToolStep`（`src/app/app-runner.ts:440`）；`done` → invariants（`src/app/app-runner.ts:914-915`）+ 关会话 |
| `src/app/ctx-dry.ts` | NEW | 同一接口不动作：记录意图、跑全部校验、`straight` 返回 `{ok:true,dry:true}` |
| `src/app/ctx-replay.ts` | NEW | 按 trace 返回、不重新决策；版本/输入 hash 不一致拒跑 |
| `src/app/trace.ts` | NEW | `AppTrace`：`app_sha256`+`inputs_sha256`+`script_version`+`steps`（复用 `TraceStep`）+`stop_code`；写/读/校验 |
| `src/app/app-runner.ts` | EDIT | 脚本应用驱动：`meta` → 校验 → 懒建会话 → `flow(ctx)` → 预算/超时 → 收尾 |
| `src/cli/commands/run.ts`、`apps.ts` | EDIT | `--watch`（逐步记版本）、`--replay <trace>`、`--emit-trace`；脚本应用遇 `--resume` **显式拒绝**（不静默） |
| `src/engine/plan.ts`（`TaskPlan` 断点）+ `src/engine/planner.ts`（`runPlan` 队列） | EDIT | resume 语义：脚本应用只支持 trace replay；遇 `--resume` **显式报错点名**（`TaskPlan` 断点不适用），不静默降级 |
| `tests/ctx.test.ts` | NEW | real ctx 对 `file://` 夹具：step/arrive/read/source/run/done；`act` 必填；不可重入；budget |
| `tests/ctx-dry.test.ts` | NEW | dry 与 real 的**意图序列**逐条对应（3 个试点） |
| `tests/trace.test.ts` | NEW | schema 往返、版本/输入不一致拒跑、重放确定性 |
| `tests/ctx-wiring.test.ts` | NEW | 危险步默认拒绝（`refused`）、`hosts` 外导航被拦、`stopCode` 透出、`low_confidence` 可被 `onLowConfidence` 重试 |

### L2-2 试点（3 个应用，4–6 人日）

放 `tests/fixtures/scripts/`（不碰 `apps/`）：

| 试点 | 覆盖 |
|---|---|
| `checkin-binding` | 线性 + `<select>` 绑定 + `invariants` |
| `ip-config` | 批量循环 + 条件 + 行内证据（对照 `src/data/...` 生成的既有包） |
| `transfer-trekly` | 命令闭集 + `<input type=range>` + 数据腿（对照 spec 生成的包） |

**退出（L2 定义完成）**
1. 3 个试点 real 跑通，且 `dry` 展开的步骤序列与既有包 `journey` **步数/顺序/完成条件一致**；
2. trace 重放同一份跑两次结果一致；换脚本版本重放 → **拒跑**；
3. 危险步默认 `refused`；`hosts` 外导航 `host_not_allowed`；预算超限 `budget_exceeded`；
4. `npm run verify` + `smoke` + `apps:gen --check` + `apps:suite` 全绿；
5. `git diff apps/` 为空（试点只在 fixtures）。

### L2-3 定位文档（1–2 人日）

| 文件 | 动作 | 内容 |
|---|---|---|
| `README.md`、`ARCHITECTURE.md`、`CLAUDE.md` | EDIT | 身份从「冻结计划的中间件」改为「脚本即计划 + trace 审计」；写明三条红线的 L2 形态；`docs/` 增补一节"L2 运行模型" |

---

## 7. S2 与 L3（各自独立立项）

**S2 录制产脚本（5–7 人日）**：`tools/learn.ts` 改为产出 L1 脚本（三段 + `recorded_from`），
**必须过 `:621-668` 的 0 前向回放门禁**；`src/cli/commands/record.ts` 同步；写文件前不通过就一个文件都不落。

**L3 删 JSON（15–25 人日，前置 ①L2 稳定 ≥2 周 ②trace 契约冻结 ③21 包迁移方案评审）**
- 迁移面（已核）：39 个文件引用 `pack.json`（tests 18）、18 处 `loadPack(`、9 个引用 `flow.json`、
  18 个引用 `specs`/`emitPlan`、33 个碰 `TaskPlan`；6 层对拍里 ctrip/transfer **基线对象要换**。
- 必须先做 `ctx.fromLegacy("…/pack.json")` 过渡层，逐包"去 wrap"。
- **一次显式重冻**（§5.4 的三个词：一次性 / 显式 / 单独提交），diff 只允许预期项，见到时钟/随机就走停。

---

## 8. 测试与门禁矩阵

| 层 | 命令 | P0 | L1 | L2 |
|---|---|---|---|---|
| 类型 | `npm run typecheck` | ✅ | ✅（且不扫 apps/scripts） | ✅ |
| 单测 | `npm test` | ✅ + 3 新测试 | ✅ + 4 新测试 | ✅ + 4 新测试 |
| 六层对拍 | `npm run test:parity` | ✅ 逐字节 | ✅ 逐字节 | ✅ 逐字节 |
| 一键门禁 | `npm run verify` | ✅ | ✅ | ✅ |
| 冒烟 | `bash bench/smoke.sh` | ✅ | ✅ | ✅ |
| 包一致 | `apps:gen --check` | ✅ 8/8 | ✅ 8/8 | ✅ 8/8 |
| 探针 | `probes:baseline --check` | ✅ 3/3 | ✅ 3/3 | ✅ 3/3 |
| 套件 | `apps:suite` | ✅ | ✅ + `--no-scripts` 等价 | ✅ |
| 新增 | 差分/确定性/重放/拒绝 | signal+hint 差分 | 2 应用 0 diff | trace 重放 + 危险拒绝 |

---

## 9. 风险登记

| # | 风险 | 触发信号 | 对策 |
|---|---|---|---|
| R1 | 信任边界：脚本=任意代码 | 用户脚本被仓库引用 / 自动下载 | 默认只用户作用域；`--no-scripts`；`app_sha256` 入账；沙箱列后续 |
| R2 | trace 契约没定死就开跑 | 字段反复改 / 重放不稳定 | L2-1 先冻结 `AppTrace` schema（一页纸），再写 ctx |
| R3 | `ctx.step` 复制执行循环 | `src/engine/executor.ts` 出现第二份选择/动作逻辑 | 代码评审硬规则：ctx 只允许调 `mw.run`/`runSubgoalWithRetries` |
| R4 | Q1 造成存量应用无法表达 | 2 个 nav-only 步（bilibili-hot）无 `act` | 已定 `ctx.arrive`；L1 试点里先写一个 arrive 用例 |
| R5 | 精度倒退：去掉 `when` 后等价性丢失 | 试点 dry 序列与 journey 对不上 | 试点 1 先做 `checkin-binding`（无 when），再做 `ip-config`（有 when→`holds`） |
| R6 | 定位改变影响文档与用户 | README 仍说"冻结计划" | L2-3 单独一档，不混在代码提交里 |
| R7 | 用户脚本不进 CI ⇒ 回归无人知 | 用户升级后脚本静默坏 | `check` 必须便宜；`explain` 输出计划；drift 沿用既有 `replayed_ok` |
| R8 | 生成器/冻结语料被顺手动到 | `apps:gen --check` 变红 | 每阶段退出条件第一条就是 8/8 + 对拍逐字节 |

---

## 10. 并行建议

- **P0-A / P0-B / P0-C 可三线并行**（不同文件、不同测试；共用 `npm run verify`）。
- L1 内部：`kit.ts`（纯构造器）与 `app-script.ts`（加载/降级）可并行；`equivalence` 测试等两者合流。
- L2 内部：`ctx-dry` + `trace.ts` 可先于 `ctx.ts`（dry 不依赖浏览器），`ctx-replay` 最后。
- 文档（L2-3）与代码并行，但**作为单独提交**。

---

## 11. 里程碑与验收

| 里程碑 | 内容 | 验收会签（人） |
|---|---|---|
| **M0** | P0 完成 | 复跑 `verify` + `smoke` + `apps:gen --check`；diff 里无 `apps/` 变化 |
| **M1** | L1 完成：Agent 可写脚本、check/explain 可用 | 2 个等价应用 0 diff；`--no-scripts` 逐字节等价；tsconfig 未改 |
| **M2** | L2 完成：运行期控制流 + trace | 3 个试点；重放一致/版本拒跑；危险拒绝；文档改完 |
| **M3**（可选） | S2 录制产脚本 | 0 前向回放门禁；产出脚本能跑 |
| **L3** | 删 JSON | 另立评审；一次重冻提交单独可 bisect |

---

## 12. 假设与未决（实施中如需偏离，必须回到这里改）

1. **假设**：Node ≥22.6（`bin/amber.mjs:13` 已依赖 strip-types）；`.ts` 脚本可运行期解释。
2. **假设**：用户作用域 `$AMBERFLOW_HOME/apps` 可写；仓库 `apps/` 继续作夹具。
3. **未决（实施前定）**：`AppTrace` 的**粒度**（每 ctx 调用一条 vs 每步一条）——建议每 ctx 调用一条，`step` 再挂子事件。
4. **未决**：`--watch` 的默认值（建议默认关）与 trace 版本字段名（建议 `script_sha256`）。
5. **未决**：`onLowConfidence` 三档的具体行为（`retry` 是否等价于 `reobserve` 一次）——建议 `retry` = 重跑整步一次（复用 `runSubgoalWithRetries` 语义）。

---

## 13. 一页纸总览

```
P0 (3–5d)  收敛：signal 单语法 / hint 单解析 / cross-ref lint     → 字节不变
L1 (8–12d) 脚本=作者面：meta(kit)+app(kit) → 内存 IR；check/explain/emit → 2 应用 0 diff
L2 (12–18d) 脚本=程序：flow(ctx) + real/dry/replay + trace        → 3 试点 + 重放一致
S2 (5–7d)  录制产脚本（0 前向回放门禁）
L3 (15–25d) 删 JSON：39/18/9/18/33 文件 + 一次显式重冻（另立）
```

**第一条命令**（M0 开始）：
```bash
git switch -c l2/p0-convergence
npm run verify && bash bench/smoke.sh        # 先确认基线是绿的
```
---

## 14. 实施状态（2026-10-24）

| 阶段 | 状态 | 提交 | 证据 |
|---|---|---|---|
| **P0** | ✅ 完成 | `c6e7486` / `5c2c37e` / `4333a2e` | 单语法差分/契约测试；`apps:gen --check` 8/8；六层对拍 67/67；`verify` exit 0 |
| **L1** | ✅ 完成 | `34a6a81` / `94bd1b5` | 两应用 0 diff；24 条新测试；`apps/`+`tsconfig.json` 零改动；`verify` exit 0 |
| **L2 核心** | ✅ 完成 | `ebe2c0a` | flow 夹具真实跑通（1.9s、不变量成立）；dry/replay/预算/版本闸门 13+9 条测试；141 条 apps/CLI 回归绿 |
| L2 试点（3 应用） | ◐ 部分 | — | 已用 `flow-demo-app` 覆盖 web 4 步 + 运行期循环；`checkin-binding` / `ip-config` / `transfer-trekly` 的 loop 版与 dry-vs-journey 对照待做 |
| S2 录制产脚本 | ⬜ 未开始 | — | 门禁口径已定（0 前向回放） |
| L3 删 JSON | ⬜ 未开始 | — | 迁移面与重冻协议见 §7 |

**L2 实现中记录的两处偏差**：
1. `validatePack` 新增 `allowEmptyJourney`：flow 脚本没有静态旅程是**合法形态**，否则每个 flow 脚本都会被"journey 必须非空"挡住；步骤级校验移到每次 `ctx.step`（同一套 walker）。
2. `ctx.run`/`ctx.dangerous`/`openPage` 未接线（见 `L2_CTX_API_DRAFT.md` §12 的"未接线"清单）——L2 的验收试点都是浏览器步，工具步接线留到 S2/L3 前。

---

## 15. L3 执行计划（删 JSON，分 5 步，每步可独立验收）

前置（L2 已完成）：`resolveApp` 脚本优先、`runScriptApp` 第二条驱动、trace 审计、dry/check/explain。

| 步 | 内容 | 退出条件 |
|---|---|---|
| **L3.1** ✅ 完成（2026-10-25，`tools/apps_migrate.ts`） | `npm run apps:migrate -- --app <id> [--write]` / `--all --check`：把 `pack.json` 转成声明式 `app.mjs`（数据内联，含 roles/probe/invariants） | **22/22 逐字段 0 diff**（`tests/apps-migrate.test.ts` 23 条） |
| **L3.2** | 21 个 `apps/<id>/app.mjs` 生成并提交；`apps:matrix` 来源列加 `script`；`apps:check` 默认校验脚本 | `apps:suite` 全绿；`pack.json` 仍在（可回退） |
| **L3.3** | 切换**默认**：`loadApp` 只找脚本（`AMBERFLOW_JSON_APPS=1` 为过渡逃生口）；`apps list` 发现脚本；`apps:gen --check` 改比"脚本展开 == 冻结计划" | 全量 `verify` 绿；旧 JSON 仍能通过逃生口跑 |
| **L3.4** | 删除 `pack.json` / `flow.json` / `transfer/specs` 与其加载路径；39 个引用文件逐个改（测试/工具/CLI）；六层对拍对象改为"脚本展开" | `npm run test:parity` 逐字节一致（**输出相同则不需要重冻**；出现差异才走 §5.4 的一次性重冻） |
| **L3.5** | 文档收口（README/ARCHITECTURE/CLAUDE.md 的身份描述）+ 全量验证 | `verify` + `smoke` + `apps:suite` + 对拍 + 工作树干净 |

**关键杠杆**：L3.1 的 0-diff 保证"脚本展开 == 今天的计划"，因此六层对拍的**语料不必重冻**；
只有 L3.4 出现非预期差异时才启用一次性重冻协议（一次性/显式/单独提交）。
**风险**：`tests/app-packs-authored.test.ts`（pack ↔ oracle 逐字段）、`tools/spec-to-pack.ts`（spec → pack）、
`tools/apps_matrix.ts`（声明行统计）都要在 L3.4 一起改；它们各自有独立验收，不能"顺手改绿"。
