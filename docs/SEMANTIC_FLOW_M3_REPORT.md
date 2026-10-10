# SemanticFlow M3 实测报告 —— plan 端到端与双站迁移

**日期**：2026-10-10 ｜ **状态**：已实现并验证（M1+M2+M3 全链路）
**前置**：[M1 报告](SEMANTIC_FLOW_M1_REPORT.md)（三级解析 + 回填环）｜ **方案**：[SEMANTIC_FLOW_TRANSFER_PLAN.md](SEMANTIC_FLOW_TRANSFER_PLAN.md) §4 剧本
**一句话**：`plan` 把"一句话 + 种子页"变成**站点无关的 v2 模板 + 该站的观察档案**——规划器每轮看
当前页的 criteria view 提议一步，真执行、真观察，判据从**两次独立演示的 before/after 对**归纳
（判别 + 稳定句柄 + 可复现三关）；页面角色文件名、查询参数名、值绑定、行抽取、frozen 信号全部
观察进档案；**重放门控（runFlow 整跑）不过 = 一个文件都不写**。hint 仍然不由 plan 写——那是
运行期回填环的职责（红线 2）。

## 0. M3 剧本 → 交付

```bash
# ① 一句话 → 模板 + 首站档案（规划 + 门控落盘）
npm run plan:flow -- --goal "在携程上订一张5月18日昆明到北京价格最低的机票" \
  --seed semantic/site-a/index.html --app flight-cheapest-planned --site site-a --yes

# ② 首迁（运行期回填环自己收第一站）→ 二跑零模型
npm run semantic -- --app flight-cheapest-planned --site site-a --laya scripted --allow-dangerous \
  --profile-dir sites/planned-demo --out bench/semantic-flow
# （重复上一条命令 = 二跑）

# ③ 迁移（M3 的新能力：同模板，plan 只为第二站产档案）
npm run plan:flow -- --goal "同上" --seed semantic/site-b/home.html \
  --app flight-cheapest-planned --site site-b --yes

# ④ 第二站首跑 → 第二次全绿零模型（M3 验收指标）
npm run semantic -- --app flight-cheapest-planned --site site-b ...（同 ②）
```

## 1. 实测（命令 → 原始观测）

**① plan site-a**（逐步观察的判据行，全部 `induced`）：

| 步 | 观察到的落点 | 归纳判据（存进本站档案） |
|---|---|---|
| open-flights | search.html | `url_contains "/search.html"` |
| submit-search | results.html | `url_contains "/results.html"` |
| pick-date | results.html（同页！） | `css_text_equals ["#list-state","列表已更新 {date_code}"]` |
| pick-cheapest | purchase.html | `url_contains "/purchase.html"`；行抽取自动发现 `tr.flight-item`/`.price`/`.fno`/`button.btn-pick`，values `[1280,1150,980,1330,1060]` → **min = F3 ¥980** |
| purchase | done.html | `url_contains "/done.html"`，dangerous 自动标注 |

门控：`rule 1 · laya 3 · escalate 0 (written back 3) · list 1 · blocked 0` → 落盘。

**②④ 双站首迁/二迁**（planned 模板，profile-dir 独立）：

| 运行 | 解析级 |
|---|---|
| site-a 首跑 | `rule 1 · laya 3 · escalate 0 (written back 3) · list 1 · blocked 0` |
| site-a 二跑 | **`rule 4 · laya 0 · escalate 0 · list 1 · blocked 0`** |
| site-b 首跑 | `rule 1 · laya 5 · escalate 0 (written back 3) · list 1 · blocked 0` |
| site-b 二跑 | **`rule 4 · laya 0 · escalate 0 · list 1 · blocked 0`** |
| site-b 三跑（`--laya unsure`：模型永不过闸） | **`rule 4 · laya 0 · escalate 0`**（hint 已把 ②③ 都短路） |

证据：`sites/planned-demo/site-{a,b}.profile.json`（`replays_ok` 随重放次数累计到 2）、
`bench/semantic-flow/flight-cheapest-planned-*.md|json`。

**③ 迁移 plan 的观察差异**（同模板、不同站，档案各写各的）：

| 站点知识 | site-a（plan 观察） | site-b（plan 观察） |
|---|---|---|
| pages | index/search/results/purchase/done | home/fare-query/fare-list/fare-buy/fare-done（写进 profile.pages 覆盖） |
| fill_keys | {"出发城市": from, "到达城市": to} | {"Departure city": from, "Arrival city": to} |
| list_extract | tr.flight-item / .price / .fno / button.btn-pick | div.fare-row / .fare-price / .fno / button.select-fare |
| pick-date 判据 | `css_text_equals #list-state 列表已更新 {date_code}` | `css_text_equals [data-test=query-line] {from} -> {to} · {date_code}` |
| 学到的 hint | `[id=nav-flight]` `[data-test=chip-may18]` `[id=buy-btn]` | `[data-test=tab-flights]` `[data-test=do-search]` `[data-test=purchase-submit]` |

## 2. 机制与纪律（plan 侧新增）

- **逐步"看页面"**：每轮把当前 url/title/criteria view 交给规划器；规划器只提议**一步**
  （`{id, desc, page, lands, targets, fills, list, dangerous}`）。三种规划器同一协议：
  `goalRecipePlanner`（离线配方：从 goal 意图裁步骤）、`templatePlanner`（迁移模式：模板即配方）、
  `llmFlowPlanner`（LLM 适配器：同一 JSON 契约、同一 fail-closed——垃圾回答 = 停，不猜）。
- **判据是观察不是预测**：每步执行**两次独立演示**（各自从步起始页重新导航），
  `induceSignals` 挑判别候选，`signalReproducible` 要求跨演示成立；都不够 → `manual` → **plan 停止**。
  （这正是仓库"信号要么归纳要么人证明、绝不猜"纪律在 plan 期的复用。）
- **值只来自数据袋的泛化**：观察到的信号/查询里**等于槽位值**的字面量（含 URL 编码形态）替换成
  `{slot}`，编译期回填（`url_contains` 用编码值、`css_text_*` 用原文——site-b 实测打过这一刀）。
  `--slot from=上海` 换值后 planned 模板照样判得对。
- **plan 不写 hint**：档案的 `steps` 恒为 `{}`（E2E 断言钉住）——可复现重放门属于运行期；
  门控里 runFlow 的临时学习面落在临时目录，不污染正式档案。
- **门控失败 = 不留半个文件**：staging 目录（`apps/.plan-staging-<id>/`）编译 + 整跑不过就整目录删除。
  E2E 钉了两条**不同**的失败路径：①信号不可复现（walk 阶段就停）；②walk 两次演示全绿、但门控整跑
  发现方案本身不合格（重复步 id）——后者证明这道门不是摆设，而是"walk 绿也要重放绿"的那一道。
- **双站迁移现在是自动化的**：E2E 在同一条测试里 plan site-a → plan site-b（迁移模式）→ 两站各自
  首迁 → 两站二跑零模型，并把两站的 `locale`/`checkpoint`（首访观察）与页名覆盖一并断言。
- **危险步自动标注**：goal 含 订/购买/下单/pay/checkout → 购买步 `dangerous: true`；
  执行期默认拒绝（M1 的红线 3 不变），且拒绝前先做**干跑取证**。

## 3. 实测踩过的坑（都已修，测试钉住）

1. `5月18日昆明到北京` 的城市提取：中文无词边界，`{2,6}?到` 会吞出 "日昆明"、"上订一张昆明"
   ——**日期文本是出发城市的左边界**，去掉日期、从串首匹配才稳（两个坑都真踩了）。
2. `订一张…机票` 不含 "购买" ——buy 意图必须认 "订"。
3. 语义目标里的 `{slot}` 占位：执行面忘替换 → pick-date "action space exhausted"（模板存占位版、
   匹配用替换版）。
4. 归纳引擎的 `urlCandidates` **只看 path 不看 query**（`split(/[?#]/)` 直接剪掉查询串）——
   "点了日期、页名不变"这类步没有 DOM 判别式时会误判 manual：补了**查询参数差分**候选
   （before 没有/不同、after 有，且跨演示复现）。
5. `llmEscalator` 式的惰性 JSON 提取 `/\{[\s\S]*?\}/` 在**嵌套对象**处截断 → 规划器合法回答被判垃圾：
   改贪心匹配。
6. 信号槽位替换一律 URL 编码 → site-b 的 `css_text_equals`（DOM 原文是中文）永不成立：
   **只有 `url_contains` 编码，CSS 值用原文**。

## 4. 与方案 §6 的对照与剩余边界

- M3 指标"迁移报告表：rule/laya/escalate/backfill 四列计数；第二站第二次全绿零模型"——**达成**（§1 表）。
- 方案 §4 的 `--seed https://www.ctrip.com`（真站首访）在本环境是**未验证的外推**：
  规划循环、归纳三关、门控对复刻站全绿；真站还需过 M4 的两道门——
  LLM 规划器接真 endpoint（`--planner llm`，适配器已就位）与真站页面角色/词汇的适配
  （词汇桥 LEXICON 是离线替身，LLM 版不需要它）。
- 规划期的危险步演示会**真点一次**"购买"（复刻站无害；真站必须由人在场/沙箱页——
  `confirmStep` 逐歩 y/n 就是这道人工闸）。
- 同义词放宽（新站标签与模板语义目标都不像时，把观察标签追加进模板）：迁移模式**未实现**——
  本演示靠 plan 期就把中英两语候选写进目标（intentTexts 词表）绕开了它；真迁移的第一道缺口，记录在案。
- M4（DSH 面：`amberflow_plan` 工具 + `run` 的 `site` 参）已在 `integrations/dsh-bridge` 实现：
  清单按 `kind: semantic-template` 分类、`run` 必带 `site`、`plan` 走 `--json --yes` 且危险步演示由
  部署门控；测试在 `integrations/dsh-bridge/tests/bridge.spec.ts`（`npm run test:bridge:offline`）。
  注意：**运行中的 DSH 装的还是旧的三工具副本**，要把这一面带进会话需要重装/更新插件。

**测试**：`tests/plan-flow.test.ts` 17 条（提取/泛化/归纳三关/LLM fail-closed/E2E plan→门控→学习→零模型/
双站迁移/门控失败不留文件）；`tests/semantic.test.ts` 42 条继续全绿；全量与 `bench/smoke.sh` 见下节结果。
