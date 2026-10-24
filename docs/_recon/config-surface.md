# AmberFlow 配置面现状清单（只读侦察，事实记录）

侦察基线：commit `0eba98a`（2026-10-23T17:15:44+08:00）。侦察开始时工作树干净（`git status --porcelain` 0 行）；本次只新增本文件所在的未跟踪目录（`git status --porcelain` → `?? docs/_recon/`）。本文只记事实，不含建议。

复跑命令（仓库根执行；括号内为本次结果）：

```bash
find apps -name pack.json | wc -l                                        # 21
find . -path ./node_modules -prune -o -name flow.json -print             # 3
find . -path ./node_modules -prune -o -path '*/sources/*.json' -print | wc -l   # 8
find apps bench -name '*.profile.json' | wc -l                           # 5（authored 面）
find sites -name '*.profile.json' | wc -l                                # 5（运行期写入面）
ls transfer/specs/*.json | wc -l                                         # 7
ls bench/cases*.json | wc -l                                             # 3
ls configs/*.json                                                        # 1（只有 example）
find apps -type d -name bin                                              # 1
jq -r '[has("generated_from"),has("recorded_from")]|@csv' apps/*/pack.json   # 血统键
```

## 一、配置面清单

### 1. `apps/<id>/pack.json`（21 个）

| 项 | 事实（`path:line`） |
|---|---|
| 允许键 | 顶层 `PACK_KEYS` `src/app/app-pack.ts:53-58`；`policy` 子键 `POLICY_KEYS` `src/app/app-pack.ts:111-113`；`device` 子键 `DEVICE_KEYS` `src/app/app-pack.ts:141-143`；journey 步键 `STEP_KEYS` `src/app/app-pack.ts:149` = `SHARED_STEP_KEYS` `src/app/app-adapters.ts:31-33` + `WEB_STEP_KEYS` `src/app/app-adapters.ts:36-38` + `CLI_STEP_KEYS` `src/app/app-adapters.ts:41-43` + `adjudicate`；实际校验用动态并集 `appStepKeys()` `src/app/app-pack.ts:157-163` |
| 加载期校验 | `validatePack` `src/app/app-pack.ts:541`：未知键 `:545-548`、`spec_version` `:550`、占位符指向未声明槽位 `:837-840`、`source_slots` 取值点必须在数据源 `selects/counts` 里 `:576-636`、`{dataset:NAME}` 产/消对账 `:796-832`、`next` 落点存在 `:752-783`、`generated_from` `:866-901`、`recorded_from` `:902-914`、`device` `:849-865`；`probe` → `validateProbeBlock` `src/app/probe-set.ts:141` |
| 校验调用点 | `src/app/app-runner.ts:612`（在**任何网络动作之前**，`:608-613`）、`src/cli/commands/apps.ts:237`、`tools/learn.ts:615` |
| 运行期消费 | `loadPack` `src/app/app-pack.ts:341` → `expandPack` `src/app/app-pack.ts:444`（角色合并 `expandStep` `:423-441`、`:431`）→ 旅程逐步走 `src/app/app-runner.ts:833`（`let i = 0` 起）；CLI `src/cli/commands/run.ts:200-212` |
| 手写/生成 | 8 个 `generated_from`（`apps/{ctrip-case,ip-config,transfer-farehaven,transfer-flyquest,transfer-skybook,transfer-slowjet,transfer-trekly,transfer-voyagio}`），门禁 `npm run apps:gen -- --check` `bench/smoke.sh:40`；1 个 `recorded_from`（`apps/learned-cart`，写入点 `tools/learn.ts:311`）；其余 12 个无血统键。`policy` 被 0 个包使用 |

### 2. `apps/<id>/flow.json`（3 个：2 个在 `apps/`，另有 `bench/llm-planned/flow.json`）

| 项 | 事实 |
|---|---|
| 允许键 | `TEMPLATE_KEYS` `src/flow/semantic-flow.ts:184-187`；步键 `src/flow/semantic-flow.ts:188-192`；`spec_version` 2 或 3 `src/flow/semantic-flow.ts:74-75`，校验 `:307-310`；`next` 只在 v3 合法 `:316-320` |
| 加载期校验 | `validateTemplate` `src/flow/semantic-flow.ts:299`（调用 `:1270`、`:1934`）；站点档案 `validateProfile` `:479`（调用 `:1273`、`:1937`）。**不查文件存在性**：`sites.*.start_url` 只查非空串 `:330-332`，`pages.*` 只查非空串 `:339-341`（`fs.existsSync` 仅用于目录发现 `:221-268`） |
| 运行期消费 | `runFlow`（`LearnedStore` 落点 `src/flow/semantic-flow.ts:1276`）；入口 `npm run semantic` `package.json:54`；`loadTemplate` `src/flow/semantic-flow.ts:253` |
| 手写/生成 | `TEMPLATE_KEYS` 无血统键 → 从文件**不可判定**作者；`plan:flow` 也会写 `flow.json`（`src/flow/plan-flow.ts:855`、`:897-906`）且不留标记 |

### 3. `apps/<id>/sources/*.json` 与仓库根 `*/sources/*.json`（8 个）

| 项 | 事实 |
|---|---|
| 允许键 | **顶层无白名单**：`validateSource` `src/data/datasource.ts:1282` 只逐项查值，未遍历未知键；实际键集见 `Source` 接口 `src/data/datasource.ts:59-74`。嵌套白名单：`transport.cli` → `CLI_KEYS` `src/data/datasource.ts:359`（校验 `:1297-1340`）；`extract.kind` → `EXTRACT_KINDS` `:560`（`:1363`）；算子 `OPS` `:561`（`:1397`）；日期表达式 `DATE_EXPRS` `:562` + `dateExpr` `:785-799`；传输 `TRANSPORTS` `:559` |
| 加载期校验 | `validateSource`，调用点**只有两处**：datasource 自身 CLI `src/data/datasource.ts:1583`、对拍 `tools/datasource-parity.ts:114`。应用路径**不校验 schema**：`src/app/app-pack.ts:842-847` 与 `src/app/app-runner.ts:607-628` 只 `loadSource`（存在性），而 `loadSource` `:1190-1216` 不做校验 |
| 运行期消费 | `runSource` `src/data/datasource.ts`；数据腿 `src/app/app-runner.ts:626-640`（`:630` 调用，结果经 `source_slots` 回写槽位）；源发现制 `sourceDirs` `src/data/datasource.ts:281-301` |
| 手写/生成 | 8 个全无血统键（`jq` 已确认） |

### 4. `apps/<id>/sites/<site>.profile.json` 与仓库根 `sites/<site>.profile.json`（10 个，**两套同名不同物 schema**）

| 项 | authored（`apps/<id>/sites/` 4 个 + `bench/llm-planned/` 1 个） | learned（仓库根 `sites/` 5 个） |
|---|---|---|
| 允许键 | `PROFILE_KEYS` `src/flow/semantic-flow.ts:193-196` | `LearnedSiteFile {host, steps, instructions?}` `src/flow/semantic.ts:188-193`；步条目 `:198-240` |
| 加载期校验 | `validateProfile` `src/flow/semantic-flow.ts:479`；跨文件对账：`site`↔`template.sites` `:487`、`pages`↔`template.pages` `:501`、`page_query`↔步 id `:509-515`、`fill_keys`↔`steps[].fills` `:518-533` | `validateLearned` `src/flow/semantic.ts:198`（`instruction`/`replays_ok`/`method`/`failures`） |
| 加载 | `loadSiteProfile` `src/flow/semantic-flow.ts:265-275`（多根、用户赢） | `LearnedStore.load/save` `src/flow/semantic.ts:259-286` |
| 运行期消费 | `SiteProfileMemory` `src/flow/semantic.ts:297` 三级解析；`frozen_signals`/`list_extract` 覆盖模板 | 同左（学到的 hint 回退取回 + `replays_ok` 重放计数） |
| 手写/生成 | 5 个 `steps` 全为 `{}`（`jq -c .steps`），与"plan 不种 hint"一致 `src/flow/plan-flow.ts:864`；档案由 `plan:flow` 写（`:856-857`、`:897-906`），重放门禁不过则一个文件都不落 `:888-890`；但 `PROFILE_KEYS` 无血统键 → **不可判定**作者 | 运行期写入（`replays_ok` 计数、`drift` 撤下）；默认目录 `path.join(REPO,"sites")` `src/flow/semantic-flow.ts:1276` |
| 边界 | 两 schema 键互斥（`host` 不在 `PROFILE_KEYS`，`pages/fill_keys` 不在 `LearnedSiteFile`），靠目录区分 | 同左 |

`src/model/hint-memory.ts` **不是**这一面的实现：它是另一份记忆（`{hints:[[k,v]]}` `src/model/hint-memory.ts:124-126`），路径由 `--hint-memory <file>` 指定（`src/app/app-runner.ts:1316`、`src/cli/bench.ts:317`）。

### 5. `transfer/specs/*.json`（7 个）

| 项 | 事实 |
|---|---|
| 允许键 | `FlowSpec` `src/flow/flow.ts:47-60`（含 `[k:string]: unknown` 兜底，故顶层无未知键拒绝）；phase `:41-46`（`REPEATS` `:26`、`STAGES` `:27`）；step `:29-40` |
| 加载期校验 | `validateSpec` `src/flow/flow.ts:80-134`（未知 signal op / 参数个数 `:122-130`）；`loadSpec` 校验失败即抛 `:136-151`；`site_dir` 存在性 `:92` |
| 运行期消费 | `emitPlan`/`deriveFlightSubgoals`（`src/flow/flow.ts`）+ `src/flow/transfer-flow.ts`；常量入口 `src/data/profiles.ts:16-19` |
| 手写/生成 | 7 个无血统键；与 8 个生成包的对齐由 `tools/spec-to-pack.ts` 的 `checkAgainstFlow` `:418-466` + `plan_sha256` 保证；`inexpressibleKeys` `:391-415` 显式点名"生成器表达不了的键"。`ledger_js`（`:56`）是 JS 字符串，只被解析出 `window.__XXX` 名字 `src/flow/transfer-flow.ts:21-24` |

### 6. `bench/cases*.json`（3 个：cases 9 / live 8 / live-long 3 例）

| 项 | 事实 |
|---|---|
| 允许键 | 只有类型接口 `BenchCase` `src/cli/bench.ts:32-43`（编译期）；**无运行期校验**：唯一读取点是 `JSON.parse` `src/cli/bench.ts:247`（无未知键、无类型检查） |
| 运行期消费 | `runCase` `src/cli/bench.ts:114-160`（case 级 `slots` → `TaskPlan` `:127`，`retries` 走 `runSubgoalWithRetries` `src/engine/planner.ts:305`，调用 `src/cli/bench.ts:150`） |
| 手写/生成 | 3 个无血统键。另有 4 个冻结测量产物 `bench/{drift-real-arm,provider-baselines,w0-gate-signals,w0-model-contribution}.json`，由 `--check` 门禁校验（`bench/smoke.sh:83-84`、`:46-47`） |

### 7. `configs/amberflowrc.json` / `configs/amberflowrc.example.json`（1 个文件）

| 项 | 事实 |
|---|---|
| 现状 | `configs/amberflowrc.json` **不存在**（`ls configs/*.json` 只有 example，`loadRc` 缺席即合法空配置 `src/support/rcfile.ts:57`）；`.gitignore:9` 忽略它 |
| 允许键 | `RC_GROUPS` `src/support/rcfile.ts:30-45`（`KNOWN_KEYS` `:46`） |
| 加载期校验 | `loadRc` `src/support/rcfile.ts:55-83`（未知键 `:71-75`、非字符串值 `:76-79`）；应用 `applyRcToEnv` `:97-114`（env 已设的键不覆盖）；消费点 `src/cli/{start,bench,plan-cli,camera-entry,ip-config,picker-server}.ts` 与 `src/flow/{semantic-flow,plan-flow}.ts` 各自调用 |
| 新增分层 | `CONFIG_KEYS` 复用同一白名单 `src/cli/config-store.ts:8`；层叠 环境 > 项目 `.amberflow/config.json` `:38-40` > 用户 `$AMBERFLOW_HOME/config.json` `:34-36` > 旧 rc `:43-45`；`resolveConfig` `:83` |
| 手写/生成 | example 1 个手写模板；真 rc 不进 checkout |

### 8. `apps/<id>/bin/*`（1 个文件：`apps/demo-tool/bin/stub-tool.mjs`）

| 项 | 事实 |
|---|---|
| schema | 无独立 schema；由 `sources/*.json` 的 `transport.cli` 引用（`apps/demo-tool/sources/demo-tool.json:11` argv、`:23` `version_pin`、`:25` argv），键 `CLI_KEYS` `src/data/datasource.ts:359`，校验 `:1297-1340`；argv 数组、`shell:false` |
| 运行期消费 | 数据腿（`transport.client:"cli"`）；工具步（`apps/cli-report/pack.json:20` 以 `stdout_contains: "stub-tool"` 判完成）；工具信号 `validateToolSignal` `src/browser/tool-signals.ts:57` |
| 手写/生成 | 手写桩（自述用途 `apps/demo-tool/bin/stub-tool.mjs:1-20`），无血统键 |

## 二、计数

| 指标 | 数 | 复跑命令 |
|---|---|---|
| 配置面 JSON 文件总数 | **53** | 上框 8 条 `find/ls` 的并集去重 |
| 不同 schema | **8** | pack / flow / authored-profile / learned-profile / source / spec / cases / rc |
| 有机器可验血统 | **9**（8 `generated_from` + 1 `recorded_from`） | `jq -r 'select(has("generated_from") or has("recorded_from"))|input_filename' apps/*/pack.json` |
| 运行期写入的记录 | **5**（learned profile，带 `replays_ok`） | `find sites -name '*.profile.json'` |
| 无血统标记的 JSON | **39** = 53 − 9 − 5 | — |
| `--check` 门禁 | `apps:gen`（8 包）、`probes:baseline`、`nominate:measure`、`drift-real-arm` | `bench/smoke.sh:40,42,46-47,83-84` |

## 三、表达力缺口（每条给证据；"能"也照实写）

| # | 方向 | 结论 | 证据 |
|---|---|---|---|
| 1 | 步级多分支 | **能（受限于 DOM 谓词）** | `journey[].next` 有序候选，逐候选问它自己的 `when` `src/app/app-runner.ts:881-898`；v3 flow 同语义 `src/flow/semantic-flow.ts:115`、`:447-463`；唯一在用的包 `apps/cold-search-next/pack.json` |
| 2 | 步内分支 | **不能**（只有有序命令闭集） | `commands` 按命令身份顺序前进，不是按条件选支 `src/engine/executor.ts:1560-1568`、`:2248-2253`；5 个动词 `COMMAND_OPS` `src/engine/actions.ts:36`；`when` 是步级键 `src/app/app-adapters.ts:36-38` |
| 3 | 循环与回退 | **只有有界回边** | `next` 回边 + 路径上界 `max_step_visits`（缺省 3）`src/app/app-pack.ts:222-225`，到顶结构化停因 `next_cycle` `src/app/app-runner.ts:836-845`；`retries` 是**整步重跑** `src/engine/planner.ts:299-305`；工具步 `retries>0` 必须先声明 `idempotent` `src/app/app-adapters.ts:377-378`，`dangerous` 不许重试 `:382`。无 while/until-on-data |
| 4 | 算术/表达式 | **无通用表达式**；仅 4 种替换 + 两处窄算子 | `{slot}` 正则 `src/app/app-pack.ts:359`、替换走 `String()` `:367-384`；运行期 `{out_dir}`/`{run_id}` `:41-50`；`{dataset:NAME}` `src/app/app-adapters.ts:148-166`；日期表达式 `date\|day_offset\|weekday_cn\|date±Nday` `src/data/datasource.ts:562`、`:785-799`；数据源路径算子 `time\|join:x\|len\|len-1\|int\|str\|strip` `:561`。占位符正则只认 `[A-Za-z_][A-Za-z0-9_]*`（`src/app/app-pack.ts:359`）⇒ 写不出 `{rows[0].price}`、写不出 `{n+1}` |
| 5 | 类型化值 | **不能** | slot 替换一律 `String()` `src/app/app-pack.ts:374`；`validatePack` 只查 `slots` 是对象 `:562-564`；对比 `{dataset:}` 非字符串走 `JSON.stringify` `src/app/app-adapters.ts:161`；信号只有相等/包含、无数值比较 `src/engine/signals.ts:179-191` |
| 6 | 跨文件引用加载期对账 | **部分** | 对账的：`source_slots`↔源 `selects/counts` `src/app/app-pack.ts:609-630`、`{dataset}` 产消 `:796-832`、占位符↔槽位 `:837-840`、`next` 落点 `:752-783`、profile↔template `src/flow/semantic-flow.ts:487/501/510/532`、spec `site_dir` `src/flow/flow.ts:92`。**不对账**：pack 引用的 sources 只查存在不查 schema（`src/app/app-pack.ts:842-847`；`validateSource` 调用点仅 `src/data/datasource.ts:1583`、`tools/datasource-parity.ts:114`）；flow 的 `start_url`/`pages` 文件名不查存在 `src/flow/semantic-flow.ts:330-332`、`:339-341` |
| 7 | 数据驱动的步表 | **不能** | 旅程在展开期定型 `src/app/app-pack.ts:444-480`、路径走表建自 `expanded.steps` `src/app/app-runner.ts:783`；运行期数据只能填**参数**（`{dataset:}` `src/app/app-adapters.ts:148-166`）；`next` 候选适用性只问 DOM `when` `src/app/app-runner.ts:886-898`，非 web 步恒适用 `:883` |
| 8 | 步骤复用/组合 | **pack 有 `roles`，flow 没有** | 模板+覆盖合并 `src/app/app-pack.ts:232`、`:423-441`（`:431`）；flow 步键无 `role` `src/flow/semantic-flow.ts:188-192`；无 include/嵌套模板——未知键一律拒 `src/app/app-pack.ts:545-548`、`src/flow/semantic-flow.ts:302-305`、`:351-354` |
| 9 | 条件信号 | **有 `when`，但只能问 DOM** | `when` 在 `WEB_STEP_KEYS` `src/app/app-adapters.ts:37`、flow 步键 `src/flow/semantic-flow.ts:190`；组合算子 `all_of/any_of/not/manual` `src/engine/signals.ts:179-191`；算子集里没有数据/退出码引用 |
| 10 | 动态生成 hint | **不能生成，只能学/回填** | hint 是字面串：`target_hint: string` / `target_hints: string[]` `src/engine/plan.ts:34-35`；语法固定 5 型 `src/engine/rules.ts:6`；语义目标只认 `role/text/near/data_test` `src/flow/semantic-flow.ts:283-294`；学到的 hint 落档案并受 `replays_ok`/`drift` 门 `src/flow/semantic.ts:297` |
| 11 | 并行/多次尝试 | **无并行**；多次尝试=整步重跑 | `PACK_KEYS`/`STEP_KEYS` 无并发键 `src/app/app-pack.ts:53-58`、`src/app/app-adapters.ts:31-43`；旅程是顺序单循环 `src/app/app-runner.ts:833`；重试语义 `src/engine/planner.ts:299-305`，且工具步受 `idempotent`/`dangerous` 约束 `src/app/app-adapters.ts:377-382` |

## 四、未证实（不推测，留给下一轮）

1. 39 个无血统键 JSON 里"人写 vs 工具写"的归属：`plan:flow` 会写 `flow.json` + `profile.json`（`src/flow/plan-flow.ts:855-857`、`:897-906`），但 `TEMPLATE_KEYS`/`PROFILE_KEYS` 都没有血统键（`src/flow/semantic-flow.ts:184-196`）⇒ **未证实**。
2. `effect.irreversible` 在**应用包路径**的运行期消费点：执行器收该字段 `src/engine/executor.ts:365-370`、`plan.ts` 编辑面含它 `src/engine/plan.ts:86`，但我未追到 app-runner 的独立消费点 ⇒ **未证实**（不断言"写了没用"）。
3. `bench/cases*.json` 是否在别处有隐藏校验：唯一读取点 `src/cli/bench.ts:247`，全仓未找到 `validateCase` ⇒ 是否有其它门禁**未证实**。
4. `apps/flight-cheapest/flow.json` 与 `apps/flight-cheapest-planned/flow.json` 各自的作者归属：同上第 1 条，**未证实**。