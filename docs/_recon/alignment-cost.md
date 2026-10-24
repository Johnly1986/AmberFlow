# 对齐成本取证：同一事实要写几处、谁在保它、真咬过谁

只读取证（未改任何源码/配置；唯一写入本文件）。**文档只作线索，代码与 git 提交是证据**；
所有命令在仓库根可复跑，行号对 HEAD `0eba98a`。凡没有 file:line 或命令输出支撑的一律写「未证实」。

口径：**N（写几处）**＝该事实的**独立写入点**数，由构造派生的副本（re-export、生成物、指纹）各计 1 点并标
`[生成]`，文档复述**不计**（否则 doc 就成了第 N+1 份）；**门禁**＝为"两处不许各说各话"存在的脚本/加载期校验/测试；
**咬人**＝有提交号、实测数字或测试名证明它真红过或差点红（`(a)` 门禁自己抓红，`(b)` 事后补的门禁由复核抓出）。

---

## 1) spec → pack → 冻结计划 ↔ 独立 oracle（四方对齐）——**确认**

- 事实：同一份 19 步 ctrip 计划，既写在**声明**里也写在**代码**里：`transfer/specs/ctrip.json`（JSON 阶段表）
  ↔ `src/data/ctrip-oracle.ts:121`(`flightSubgoals`) `:157`(`hotelSubgoals`)，且后者同时是**判分机器**（独立口径）。
- N 处：`transfer/specs/ctrip.json` ｜ `src/data/ctrip-oracle.ts:121,157` ｜ `apps/ctrip-case/pack.json`
  `[生成]`（`generated_from.plan_sha256`，由 `tools/spec-to-pack.ts:351-353` 写）｜
  六个 transfer 站同理：`transfer/specs/{voyagio,skybook,…}.json` ↔ `src/data/transfer-data{2..7}.ts`
  ↔ `transfer/site{N}/data{N}.js` `[生成]` ↔ `tools/transfer-corpus.json` `[生成]`。
- 门禁：`tools/spec-to-pack.ts:418 checkAgainstFlow`（`npm run apps:gen -- --check`，smoke 第 2b 步
  `bench/smoke.sh:40`；三种漂移各有回归：手改 journey / 手改角色模板 / 改 spec 没重生成，
  `tests/spec-to-pack.test.ts`）｜`tests/app-packs-authored.test.ts:60-77`（逐字段比 oracle）｜
  `tools/transfer-parity.ts:18`（钉时钟对拍冻结语料）｜`tests/transfer.test.ts:2-6`（`dumpJs()` 逐字节）。
- 咬人 `(a)`：`a784e75`——**同一个提交周日绿、周一红**：`apps:gen --check` 7 个包漂移、
  `tests/transfer.test.ts` 15 条、`tests/ctrip.test.ts` 3 条、`tools/transfer-parity.ts` 41 项、
  smoke 3b/3c 各 0/7。`29773be`——此前 7 个应用共 **1197 行是逐字段手抄**，独立复核结论 0 diff
  = 那轮流程只证明了"抄得对"（`bench/AUTHORING_ASSESSMENT.md:13-16`：2965 行声明里 61% 机械可导出）。
- 复跑：`npm run apps:gen -- --check`（本地实测 **8/8 一致**，exit 0）｜`git show --no-patch a784e75`｜`git show --no-patch 29773be`。
- 边界（文档自身漂移，实测）：①`a784e75` 正文列了**五处**红（多 `tests/ctrip.test.ts` 3 条），CLAUDE.md 写「四处」；
  ②"单一出处 `tools/frozen-today.ts`"仍有第二份**字面量**：`bench/smoke.sh:75,79` 的
  `LAYA_TODAY="${LAYA_TODAY:-2026-10-02}"`——改常量不改它，周日绿周一红会以另一条路径复活。

## 2) 信号语法两个观察面（DOM / 进程）——**确认（同构是设计，不是漂移）**；`when` 缺口——**确认**

- 事实：DOM 面的完成真值是 `checkSignal`（`src/engine/signals.ts:30`）；命令行工具当动作腿时没有 DOM，
  于是同一形状长在第二个观察面上：`checkToolSignal`（`src/browser/tool-signals.ts:96`），
  并且**算子表与校验器各有一份**。
- N 处（同构点，逐对给出）：算子表 `signals.ts:179 SIGNAL_OPS` ↔ `tool-signals.ts:29 TOOL_SIGNAL_OPS`；
  组合算子语义 `signals.ts:55-67` ↔ `tool-signals.ts:101-109`；校验器 `src/engine/plan.ts:256-284`
  （`checkSignalSpec`，`signal` 与 `when` 同一 walker）↔ `tool-signals.ts:57 validateToolSignal`。
- 门禁：`tests/tool-signals.test.ts:22`（只钉"组合算子都在"，**不钉两表等价**）；`tests/signals.test.ts`；
  `tests/plan.test.ts:153-164`、`tests/apps.test.ts:405-412`（signal/when 同语言）。**跨面同一坏输入 → 同一报错的对拍不存在**。
- 咬人 `(b)`：`6b5d413`（第 3 轮，G-M）——`PlanningRules.problems` 递归校验 `signal` 却从不校验 `when`，坏守卫要到
  运行期才炸成 `stop_reason: "error: … unknown signal spec"` + BLOCKED（"响亮，但晚了一轮"）；修复即
  `plan.ts:287-292` 走同一 walker，回归在 `tests/plan.test.ts:163`、`tests/apps.test.ts:412`。
- 复跑：`git show --no-patch 6b5d413 | sed -n '/when/,+4p'`｜`npx vitest run tests/tool-signals.test.ts tests/plan.test.ts`。

## 3) hint 语法两份实现（池侧 / DOM 侧）——**确认已漂移 2 次；第三处漂移假设被证伪**

- 事实：`target_hint` 的 6 种形状写在两处：池侧 `src/engine/rules.ts:184 hintMatchImpl`
  （`hintMatch` = 收窄眼，`hintCandidates` = 档位候选眼，已单实现）↔ DOM 侧回捞器
  `src/engine/extraction.ts:404-461 HINT_HEAD`（`hintLookup`，同一次扫描内盖 `data-hintref` 章，
  `executor.ts:1176` 用 `[data-hintref='%s']` 定位）。两处必须**成对改**。
- N 处：2（`rules.ts:184` ｜ `extraction.ts:404-461`，另有调用边界的小写化 `extraction.ts:792`）。
- 门禁：**没有跨面差分测试**；池侧内部差分有 `tests/rules-tiered.test.ts`（20 例，钉
  `hintMatch ≡ firstIfSame(hintCandidates)`，见 `rules.ts:160-173`）。文档纪律处：`docs/ARCHITECTURE_REVIEW.md:65`
  （「2 处（已漂移 2 次）」）、`ARCHITECTURE.md:368`、`extraction.ts:13`、`src/engine/actions.ts:142`。
- 咬人 `(b)`：`bench/OPTIMIZATION_REPORT.md:254`——`#id` 只加到了 Python 侧 `_hint_match`，JS 侧 `hint_lookup` 不认
  → 被预算挤出的计划目标**无法回捞**（`live-python-org-search` **0/2, 380 s → 2/2, 16.2 s**，`:269`）；
  `:390`——`=` 分支拿"已小写化的 hint"比原始属性，大写设备 ID（`data-test="net-CAM-1001"`）静默失配 →
  **4 行全部 BLOCKED**；修复注释与单测在 `src/engine/rules.ts:239-244` + `tests/rules.test.ts:67-73`。
- 证伪（本地实测，`/tmp/align-probe/hint-dom-vs-pool.mts`）：我怀疑 `#id` 分支至今仍是单边大小写——读代码像是
  （`HINT_HEAD:416` 只小写元素 id，不小写 `h.slice(1)`），但**实测两侧一致**：调用方 `extraction.ts:792` 已
  `hint.trim().toLowerCase()`，6 个形状（`#SearchInput`、`#searchinput`、`a[data-test=net-CAM-1001]`、
  `a[data-test=NET-cam-1001]`、`go`、`network`）池侧与 DOM 侧结论全同。**不是当前缺陷；但折叠只挂在调用方一个点上，
  是薄冰**（把原始 hint 直接喂 `PASS_HINT` 就会复发）。

## 4) `apps/*/flow.json` ↔ 站点档案 ↔ 运行期学到的 hint ——**确认（三道键对齐），发现一处静默缺口**

- 事实：同一个 step id 被三处引用：`apps/flight-cheapest/flow.json`（steps/pages/sites）↔ 手写档案
  `apps/flight-cheapest/sites/site-a.profile.json`（`fill_keys`/`list_extract`/`frozen_signals` 都按 stepId 键控，
  `steps: {}` 故意留空）↔ 运行期学到的档案 `sites/site-a.profile.json`（`steps[stepId].hint` + `replays_ok`/`method`，
  与手写档案**同名不同文件**，靠 `<site>` 键对齐）。
- N 处：3（`flow.json` ｜ `apps/<id>/sites/<site>.profile.json` ｜ `sites/<site>.profile.json`）；
  页面角色名另有一对：`flow.json pages` ↔ 档案 `pages` 覆盖。
- 门禁：`src/flow/semantic-flow.ts:479-560 validateProfile`（未知 profile 键 / 未知 step id / 未知 page role /
  `fill_keys` 的槽位必须在该步 `fills` 里且**双向完备**）；学习侧红线：`staged` → 同运行零模型重放 →
  `replays_ok` 起算 → 连续 N 次（默认 2）不成立报 `drift` 撤下（`semantic-flow.ts:1059-1105,1344-1352`）。
- 咬人：**未证实**（该门禁自 `6863190` 起就在；没找到它红过的提交）。
- 缺口（本地实测，`/tmp/align-probe/profile-gap.mts`）：档案**文件缺失**时 `loadSiteProfile`
  （`semantic-flow.ts:265-274`）静默合成 `{site: siteKey}`，`validateProfile` 返回 `[]` ——"声明过的 site 没有档案"
  不报错，只把整站知识降级成模型现场选；step id 打错会被抓（实测报 `fill_keys.no-such-step: unknown step id …`），
  site 名打错也会被抓。
- 复跑：`node --experimental-strip-types /tmp/align-probe/profile-gap.mts`｜`npx vitest run tests/semantic.test.ts`。

## 5) 探针声明 ↔ 已入库冻结探测记录 ——**确认，门禁有牙；咬人未证实**

- 事实：包里声明的是**输入**（`probe.date/results_dir/targets`），基线记的是**测出来的判决**
  （`probe.baseline.verdicts`）；两者必须与已入库记录一致，且"叙述"（`*_reason`）不得混进基线。
- N 处：2（`apps/{ctrip,ota,qunar}-live/pack.json` 的 `probe.baseline` ｜ 已入库探测记录）。
- 门禁：`tools/probe-baseline.ts:93 diffPack`（`missing`/`changed`/`extra` 三类）+ `:101 renderDiff`；
  `npm run probes:baseline -- --check`（smoke 第 2c 步 `bench/smoke.sh:42`）；`--write` 刷新。
- 咬人：**未证实**（设计是"站点变了或有人手改包 CI 直接红"，`a2cc2ad` 建立时无红记录；
  `tests/probe-baseline.test.ts:47-63` 用**构造的** changed/extra 用例证明有牙，不是真实事故）。复跑：见 §复跑。
- 关联门禁（同一份声明）：探针 URL 的 host 必须在 `pack.hosts` 里，`src/app/probe-set.ts:104-128`
  （`hosts: []` 曾是一道后门，复核在 `bench/APP_VERIFY_REPORT.md:307` 抓到）。

## 6) datasource 配置的内部交叉引用 ——**证伪：加载期不查这些引用**

- 事实（本该 ≥2 处一致）：`audits[].field` / `selects[].sort_by` / `counts[].key` / `report` 的列
  指向同一份 `extract.fields` 的字段名；日期表达式与 `version_pin` 指向引擎的白名单与真实工具版本。
- N 处：2（`<site>/sources/*.json` 内两处引用；日期表达式/KNOWN 白名单算引擎一份）。
- 门禁（实测**只有一部分**）：`src/data/datasource.ts:1271-1420 validateSource` 查 extractor/op/捕获组数、
  `date.params` 表达式（`:1350-1359`）、`version_pin` 只对 cli 生效（`:1344-1346`）、`order`∈{min,max}、
  `audits` 必须有 key+field、`selects` 必须有 key。
- 证伪（本地实测，`/tmp/align-probe/src-crossref.mts`）：`selects.sort_by` 写成不存在的字段、
  `audits.field` 写成不存在的字段、`counts.key` 重复、`report` 引用不存在的列、`filters.time_field`
  不存在 —— **五类全部加载期放行**。而 `auditRows`（`datasource.ts:990`）取不到字段时按 `""` 比较，
  于是"字段名打错"表现为一份**看起来正常的 `0/N` 测量**（静默假数），不是报错。
- 咬人：**未证实**（没找到这五类真出事的提交）；被真抓过的是引擎行为：`tools/datasource-parity.ts`
  与 `tests/datasource.test.ts:465` 拿冻结语料对拍 counts/audits/selects/report，改配置会红，
  但那是"配置↔冻结输出"，不是"配置内部自洽"。
- 复跑：`node --experimental-strip-types /tmp/align-probe/src-crossref.mts`｜
  `npx vitest run tests/datasource.test.ts`。

## 7) pack 内部交叉引用 ——**确认（加载期对账四类）、咬人 1/4**

- 事实与 N：①`{slot}` 只替换已声明槽位（journey/roles/invariants ↔ `slots`/`required_slots`，N=2）；
  ②`source_slots.{select|count}` 必须在该 source 的 `selects`/`counts` 里（N=2）；
  ③`{dataset:NAME}` 消费者必须有产者、`returns.NAME` 产者全旅程唯一（N=2）；④`target_hints` 的有序表
  与角色模板合并（N=1 声明面，由 `PlanningRules` 校验 arity/算子）。
- 门禁：`src/app/app-pack.ts:836-841`（`substitute` 收 `unknown slot placeholder {k}`）｜
  `:576-632`（`source_slots` → 载入 source 比 key 集合）｜`:795-831`（returns 唯一 + dataset 无产者报错）｜
  算子/arity 由 `plan.ts` 的同一 walker。
- 咬人 `(b)`：`30ecc9a`——`--slot foo=1`（包里没声明过 foo）以前 **exit 0 + "通过 5/5"**（值谁也没用上），
  现在 exit 2 并列出已声明槽位；同名给两次不再静默 last-wins（同类静默尾巴由 `apps:matrix` 变红带出）。
- 未证实：②③ 两类对账**没找到真红过的记录**；`app-pack.ts:502` 的注释自认这个家族付过账
  （"hint 语法、`{dataset:NAME}` 替换都是两份实现"）——注释是线索，代码里没找到第二次实现。
- 复跑：`npx vitest run tests/apps.test.ts tests/app-source-slots.test.ts tests/app-returns.test.ts`。

## 8) bench 用例 ↔ fixtures / oracle / 冻结语料 ——**确认「没有加载期门禁」**

- 事实：`bench/cases.json` 的每个 `start_url` 是仓库相对路径（`src/cli/bench.ts:59` 解析成 `file://`），
  每个 `signal` 的选择器必须真的命中该 fixture；`cases-live*.json` 的期望值另由冻结产物钉住。
- N 处：2（`bench/cases*.json` ｜ `bench/fixtures/*.html` 的标记）；oracle 一路见第 1 条（ctrip-case ↔
  `ctrip-oracle.verify()`，期望值在 `bench/smoke.sh:73-79` 的 3b/3c）。
- 门禁：**无加载期校验**——`src/cli/bench.ts:250-262` 只做 `--only`/`--fixtures-only`/`--force-*` 过滤，
  `tests/bench.test.ts` 用的是自造用例；`tests/repo-integrity.test.ts:82-83` 只保证**文件还在**
  （`bench/cases.json`、`bench/fixtures/shop_home.html` 在清单里），不保证"用例↔夹具"逐条成立。
  真正验证它的是**跑**：`npm run bench:fixtures`（需 ONNX 产物，smoke 3a 有产物才跑）或线上包。
- 咬人 `(a)`：`ace9b4e`——线上包自己抓到 harness 的两处静默：用例级 `retries` **是 inert 的**，
  且 `slots` 在接上重试路径时被丢掉（"the live pack caught that regression"）。
- 复跑：`git show --no-patch ace9b4e | tail -12`｜`npx vitest run tests/bench.test.ts`；
  冻结产物侧另有 `tools/drift-real-arm.ts --check`（smoke 第 3d 步，某格翻绿即红）。

---

## 计数（算法 + 结果）

样本 = 上面 8 条里、我能用 file:line 指认的 **28 条"必须一致的事实"**（每条 = 一句话能说清、
出现在 ≥2 处的一个命名/值/结构）。算法与原始数列如下（`[生成]`＝由构造派生的副本）：

| # | 事实 | N | 门禁 |
|---|---|---|---|
| 1 | 展开用的"今天"（冻结周） | 2 | FROZEN_TODAY 钉时钟 |
| 2 | ctrip 19 步计划 | 3（含 `[生成]`×1） | apps:gen --check + 逐字段 oracle 测试 |
| 3 | 六站站点数据 | 4（含 `[生成]`×2） | dumpJs 逐字节 + transfer-parity |
| 4 | `file://`/盘符/反斜杠路径口径 | 6 | 无（见 `3054ce8`） |
| 5 | DOM 信号算子表 | 2 | 无跨面等价测试 |
| 6 | 组合算子语义 | 2 | 无跨面对拍 |
| 7 | 信号校验器 | 2 | 各自单测 |
| 8 | `signal` 与 `when` 同一语言 | 1（历史 2） | PlanningRules walker |
| 9 | hint 语法（池侧/DOM 侧） | 2 | 无跨面差分（仅文档纪律） |
| 10 | hint 大小写折叠位置 | 2 | 仅池侧单测 |
| 11 | hint 档位语义 | 1 | rules-tiered 20 例差分 |
| 12 | flow.json 的 step id | 3 | validateProfile |
| 13 | 页面角色名 | 2 | validateProfile |
| 14 | 档案文件 ↔ site key | 2 | 文件名约定（缺失静默，见 §4） |
| 15 | 探针判决 | 2 | probes:baseline --check |
| 16 | 探针 URL 的 host | 2 | probe-set host 检查 |
| 17 | `selects.sort_by` → 字段名 | 2 | **无** |
| 18 | `audits.field` → 字段名 | 2 | **无** |
| 19 | `report` 列 / `counts.key` → 字段名 | 2 | **无** |
| 20 | 日期表达式 | 2 | validateSource |
| 21 | `version_pin` ↔ 真实工具版本 | 2 | validateSource + 运行期 checkVersion |
| 22 | `source_slots` ↔ source 声明 | 2 | app-pack 加载期对账 |
| 23 | `{slot}` ↔ 槽位声明 | 2 | app-pack substitute |
| 24 | `{dataset:NAME}` 产者/消费者 | 2 | app-pack 加载期对账 |
| 25 | `returns` 产者唯一 | 1 | app-pack 加载期对账 |
| 26 | bench 用例 `start_url` ↔ 夹具 | 2 | **无**（只在真跑时验证） |
| 27 | bench 用例 signal ↔ 夹具标记 | 2 | **无** |
| 28 | smoke oracle 期望 | 2 | smoke 3b/3c |

**① 平均一个事实要写几处 = Σ N / 28 = 62 / 28 ≈ 2.2 处**（把 `[生成]` 副本剔除、只数手写点：
60 / 28 ≈ 2.1，几乎不变——说明对齐成本的主体**不是生成物**，而是"同一事实在两套手写实现里"：
spec 声明 vs oracle 代码、池侧 hint vs DOM 侧 hint、两套 DSL 算子表、六个路径口径）。
剔重点：`[生成]`×3（`apps/ctrip-case/pack.json`、`transfer/site{N}/data{N}.js`、`transfer-corpus.json`）。

**② 为对齐而存在的门禁/检查器 = 21 个**（逐个列在 §1–§8 的「门禁」行）：①FROZEN_TODAY 钉时钟 ②`apps:gen --check`
③`tests/transfer.test.ts` dumpJs 逐字节 ④`tools/transfer-parity.ts` ⑤smoke 3b/3c ⑥`tools/ctrip-parity.ts`
⑦`tests/app-packs-authored.test.ts` 逐字段 oracle ⑧`PlanningRules.problems` signal/when walker ⑨`validateToolSignal`
⑩rules-tiered 差分 ⑪`validateProfile` ⑫`probes:baseline --check` ⑬probe host 检查 ⑭`source_slots` 对账 ⑮`{slot}` 校验
⑯`{dataset}`/`returns` 对账 ⑰`validateSource` ⑱datasource 冻结语料对拍 ⑲`drift-real-arm --check` ⑳`apps:matrix` 泄漏门禁
㉑arch-metrics 数字单一出处。另有 **8 条事实当前没有加载期门禁**（表里标 `**无**`，另有 §4 档案缺失、§3 hint 跨面两处
缺口），其中 datasource 那 3 行我已用探针实测"放行"（§6）。

**③ 真咬过人的比例 = 11 / 21 ≈ 52%**：`(a)` 门禁自己抓红 6 个：②③④⑤⑥⑳（`a784e75` 五处同时红；`76596a3` 债 3→0）；
`(b)` 事后补、历史账由复核/评审抓出 5 个：①（`a784e75`）⑧（`6b5d413` G-M）⑬（`APP_VERIFY_REPORT.md:307`）
⑮（`30ecc9a` 假绿）㉑（`4eb3629` 复核抓到 7 处过期数字）。其余 10 个（⑦⑨⑩⑪⑫⑭⑯⑰⑱⑲）**未证实**咬过人——
目前价值只是"防止复发"，账上还没有红过一次。

## 未证实 / 证伪清单（避免把文档叙述当事实）

- 未证实咬人：hint 跨面第三次漂移（**已证伪**，见 §3）；`validateProfile` 红过；`probes:baseline` 红过；
  `source_slots`/`{dataset}` 对账红过；bench 用例↔夹具红过（只有 harness 侧被线上包抓到，`ace9b4e`）。
- 实测缺口（非"历史事故"）：datasource 五类内部引用加载期放行（§6）；档案文件缺失静默降级（§4）；
  bench 用例无加载期校验（§8）；`smoke.sh:75,79` 是冻结日期的第二份副本（§1）。
- 文档 ↔ 提交不一致：CLAUDE.md 的"四处红"vs `a784e75` 五处；`CLAUDE.md:124-129` 的"要换周就同时改这一处"
  漏掉了 `bench/smoke.sh` 的字面量。本报告未复跑需 ONNX/真网络的路径（`bench:fixtures`、线上包、`apps:suite` 线上分支）。

## 复跑命令（全部只用只读命令；探针脚本落在 /tmp，未写仓库）

```bash
npm run apps:gen -- --check            # 8/8（本地实测 exit 0）
node --experimental-strip-types /tmp/align-probe/src-crossref.mts   # validateSource 交叉引用：5 类放行
node --experimental-strip-types /tmp/align-probe/hint-dom-vs-pool.mts # 池侧 vs DOM 侧 6 形状一致
node --experimental-strip-types /tmp/align-probe/profile-gap.mts      # 档案缺失静默降级
npx vitest run tests/transfer.test.ts tests/rules.test.ts tests/tool-signals.test.ts tests/apps.test.ts
npm run probes:baseline -- --check     # 3/3（本地实测 exit 0）
grep -n "2026-10-02" bench/smoke.sh tools/frozen-today.ts   # 冻结日期的两份副本
```