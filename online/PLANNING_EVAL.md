# 线上规划评估任务（planning-eval）

**可重复、可比较**的线上任务，量两项能力：**任务规划效率**（达成目标要花多少步/决策/重试/时间）
与**引擎健壮性**（动态/巨大 DOM、跨页导航、风控降级、失败是否结构化）。

## 0. 典型案例 T（2026-11-09 更新，主任务）：Google Maps 餐厅筛选与评论采集

> 这是当前**默认的典型线上规划任务**，按"给 agent 的任务简报"执行与评估（不是 `npm run test` 的
> pass/fail case——地图结果/评论动态变化且有风控，`online/cases/probe/google-maps-restaurants.json`
> 只记录环境可用性事实）。评估实体：agent（子代理/人工）按本简报完成并交付结构化结果 + 证据。
> **P0-E 完成语义诚实**：受阻交付（run 状态可能 PASSED/ok=true）必须用交付 JSON + notes 表达，
> 并核对 result 的 `steps_failed`（>0 才出现）与报告「失败步」摘要；否定式弱 done 会被
> `apps check` 的 `weak_done` lint 与步级 `false_done` guard 警告（`done_guard:"fail"` 档会结构化停）。

**入口**：<https://www.google.com/>（站点声明 `online/sites/google-maps.json`）

### 阶段一 · 应用菜单进入地图

1. 从 www.google.com 首页经**页面提供的应用菜单**（"Google 应用"九宫格）进入**地图**应用。
2. 记录：入口路径（菜单项文案）、落点 URL。

### 阶段二 · 餐厅筛选

1. 在地图内切换到**餐厅/餐馆**结果（搜索或类别入口，按页面提供者）。
2. 应用筛选：**价格 200 以内**（Google 价格为档位 ¥/¥¥/¥¥¥/¥¥¥¥——档位映射口径在 notes 如实说明）、
   **评分 4.6 以上**（若筛选档位不含 4.6，选最接近档位并**逐家核对评分**，不足 4.6 的跳过并记录）、
   **营业中**。
3. 记录：每个筛选控件的实际操作方式与落选口径。

### 阶段三 · 前五家与第一条评论

1. 按筛选后的列表顺序**依次选择前五家**餐厅，逐家打开详情页。
2. 每家记录**第一条评论**：作者、星级、日期（按页面显示口径）、文本；详情无评论/需登录/懒加载未出 → 如实记录。
3. 记录：餐厅名、评分、价格档位、地址、来源 URL。

### 交付物（agent 输出）

```jsonc
{
  "filters": { "category": "restaurant", "priceMaxCny": 200, "ratingMin": 4.6, "openNow": true,
               "appliedPriceLevels": ["¥", "¥¥"], "ratingFilterChoice": "4.5+（逐家核对 ≥4.6）" },
  "restaurants": [
    { "rank": 1, "name": "...", "rating": 4.7, "priceLevel": "¥¥", "address": "...",
      "firstReview": { "author": "...", "rating": 5, "date": "3 周前", "text": "..." }, "url": "..." }
  ],
  "fetchedAt": "2026-11-09T12:00:00+08:00",
  "notes": "筛选档位口径/评论懒加载与登录观察/人工授权等"
}
```
另附证据：关键页面 URL、截图或 DOM 观测、时间戳（可复核；不含明文凭据）。取不到的字段写 null 并在 notes 说明。

### 操作纪律（人类式操作）

- 只通过**页面提供的入口、链接、按钮、表单控件**进行导航与操作（点击、填写、选择、翻页）；
- **禁止**非页面途径的跳转/取数：不直接构造/修改 URL 跳转、不拼接查询参数直达列表/结果页、不调用页面外接口——这类行为适得其反（触发风控、拿拦截页）；
- 浏览器只允许直接打开任务入口页；此后一切跳转必须经由页面元素；`web_search`/`web_fetch`/`curl` 等站外手段不得用于访问或探测目标站点；
- 页面上没有的路径就走不到：如实记录"页面未提供该入口/控件"，**不得发明 URL 或参数**。
- **引擎可强制**：应用在 `meta.policy` 声明 `navigation:"entry-only"` 后，入口之外的直接
  URL 跳转会被引擎以 `navigation_forbidden` 拒绝（评估要求 agent 这样声明，把纪律交给引擎
  执行，而不只靠自觉）；缺省不声明时行为不变。

### 成功判据

- 五家餐厅按筛选后列表顺序、`rank` 连续；每家 `firstReview` 字段按页面可得性齐全（缺项在 notes 说明）；
- 筛选口径如实（价格档位映射、评分档位选择与逐家核对在 `filters`/notes 记录）；
- 证据可复核（URL/截图/观测），且**环境事实如实**：遇 unusual traffic/recaptcha/验证码 → 记 `blocked`，
  需登录 → 记 `login_required`，**不得绕过**；用户授权下可人工代过验证，需在 notes 记录授权与步骤。

### 评估维度

| 维度 | 指标（agent 自报 + 证据核对） |
|---|---|
| **规划效率** | 总 wall time；页面/步骤数；决策/工具调用次数；重试与返工次数；从入口到首个筛选后列表的路径长度；面板/弹层交互成本 |
| **健壮性** | 自绘控件/异步渲染/弹层/面板交互；评论懒加载与滚动加载；筛选组合后的列表变化；unusual traffic/登录降级是否如实；证据完整性（URL/截图/时间戳） |

### 基线（pilot 2026-11-09）

- probe `google-maps-restaurants` 为本案例的可用性观测（observed 事实以 probe 运行为准；skipped ≠ pass）。
- 历史：本项目首轮评估（Google Maps 酒店 8 城市，报告 `gmap-hotels-8cities`）在该域 **8/8 PASSED**——
  Google Maps 的搜索/筛选/详情流程对引擎可完成；本案例把口径升级为"筛选组合 + 逐家评论采集"，
  评估重点从"可达"转向"规划效率与证据完整性"。
- 对照保留：携程 probe（`ctrip-web-travel-plan`/`ctrip-flights`）继续记录 whaleguard/登录墙环境事实，
  作为"风控分域"对照样本。
- 任务按 agent 简报评估，不纳入 pass/fail 套件；可用性观测走 probe case（skipped ≠ pass）。

---

## 辅助任务（确定性基线，进 `npm run test`）

| 任务 | 站点 | case | 定位 |
|---|---|---|---|
| **C · 复杂站点多跳研究** | 英文维基百科（真实生产站点，单页 2000+ 可交互元素） | `online/cases/deep/wiki-multihop-research.json` | 真实内容站点 + 巨大 DOM + 多跳 + 页内锚点 |
| **S · 简单状态化电商**（基线对照） | Swag Labs 演示站 | `online/cases/deep/saucedemo-cart-eval.json` | 确定性状态流，作为"引擎基线"对照 |

> 为什么不用更"花哨"的 SPA：PyPI/npmjs 搜索页实测 Cloudflare/CAPTCHA 挑战，按纪律记录 blocked、不绕过；
> crates.io 可用但站内搜索按钮在响应式布局里重复、异步水合使命令面歧义/时序不稳。维基百科是**真实生产站点**、
> 无风控、结构稳定，且单页 DOM 规模比演示站大两个数量级——更适合做"复杂站点"的可重复评估。

## C.1 复杂任务 C：维基百科多跳事实核对

**目标**：站内搜索 `Alan Turing` → 核对条目标题与信息框 → 打开 `Turing machine` 条目 →
通过侧边目录跳到 `History` 章节 → 打开 `Church–Turing thesis` 条目并核对标题与目录。

| # | 子目标 | 动作 | 完成信号 |
|---|---|---|---|
| 1 | 搜索并直达 Alan Turing 条目 | 深链 `w/index.php?search=Alan+Turing`（表单 Search 按钮在建议下拉里不唯一，命令面用深链） | `#firstHeading` 含 "Alan Turing" 且 `table.infobox` 存在 |
| 2 | 打开 Turing machine 条目 | click `a[href=https://en.wikipedia.org/wiki/Turing_machine]`（**原始绝对 href**，T9 双底座） | `#firstHeading` 含 "Turing machine" |
| 3 | 跳到 History 章节 | click `a[href=#History]`（侧边目录页内锚点） | `url_contains "#History"` |
| 4 | 打开 Church–Turing thesis | click 原始 href（含 **en dash** `–`） | `#firstHeading` 含 "Church" |

**结束态不变量**：URL 含 `Church`、`#firstHeading` 含 `Church–Turing`、`#vector-toc` 存在；
**独立 oracle**：`#vector-toc` 计数 ≥1。

## S.1 简单任务 S：状态化电商选货（基线对照）

登录（槽位值）→ 价格降序排序 → 加最贵两件 → 打开购物车 → 移除较贵一件；结束态：购物车页 + `.cart_item`
+ 徽标=1；oracle `.cart_item` 计数 ≥1。定义与扰动细节见下（指标/协议对两个任务通用）。

## 3. 评估臂

| 臂 | 形态 | 目的 |
|---|---|---|
| **A · 声明基线** | case 原样（命令闭集 + hint + 槽位值） | 确定性下界：规划/选目标应为 0 模型决策；量步数、attempts、耗时、失败率 |
| **B · 规划臂** | 同目标改成**决策语句**：只给 goal 文本（无 `target_hint`），由决策层在池里选目标 | 量规划效率（模型挑选次数、reobserve、拒绝置信、耗时）与选择质量（`executed_actions` 实际点了什么）；需要决策源 |
| **C · 降级臂** | A 加 `--provider none`；B 去掉决策源 | 验证"无模型也能跑声明部分、需要决策的步结构化 block"，不静默点错 |

臂 B 参考实现（仅评估用，不入仓库，随报告归档）：`impl/ONLINE-PLANNING-EVAL/eval-wiki-planning/app.mjs`
（维基多跳）与 `eval-saucedemo-planning/app.mjs`（电商）。桥 `amberflow_run` 用部署决策配置跑。

## 4. 指标（全部来自运行证据）

`npm run test` 证据目录（`$AMBERFLOW_HOME/online-runs/<run-id>/` 或 `--out`）：

| 指标 | 来源字段 | 含义 |
|---|---|---|
| 通过/失败/跳过 | `summary.json` 的 `passed/failed/skipped` | 任务成功率（skipped ≠ pass） |
| 总耗时 | `cases/<id>.json` 的 `duration_ms` | 外部观测（需重复测量滤网络抖动） |
| attempts / steps | `subgoals[].attempts / steps` | 重试 = 计划+信号质量；steps = 动作开销 |
| 决策方式 | `subgoals[].method` / `confidence` | `rule:match` = 0 模型决策；model = 规划成本 |
| 不变量/oracle | `invariants[].held` / `oracle.ok` | 完成判定的独立性 |

应用面（臂 B，`amberflow_run` 结果 JSON）的 `decisions`：`total_steps`、`by_method`、`model_asks`、
`model_steps`、`reobserve`、`escalate`、`failed_asks`、`rejected_conf`；`step_traces[].executed_actions`
的 `desc/how/changed` 用于人工核对选择质量。

**判据（跨版本比较，不作为单次门禁）**：

- A 臂：重复 3 次全 passed；`attempts` 除瞬态外 ≤1；`method` 全 `rule:match`；耗时波动 <2×。
- B 臂：完成目标；`model_steps/total_steps`、`reobserve/model_steps`、`rejected_conf` 分布直接对比；
  `no_progress`/`low_confidence` 计入失败；选择质量人工抽检（实际点击目标是否语义正确）。

## 5. 健壮性扰动矩阵（期望结构化，不是碰运气）

| 扰动 | 做法 | 期望 |
|---|---|---|
| P1 预算耗尽 | 小预算跑 A/B（套件 `--max-steps`，应用 `max_steps`） | `budget_exceeded`/结构化预算耗尽，已执行步骤与 trace 保留 |
| P2 错误锚点 | 复制 case 改一个 `data-test`/`href` 到不存在值 | `target_not_found`（规则档 `no_model_runtime`）且 reason 带池快照判别；失败 `cases/<id>-failure.png/.html` 存在 |
| P3 无模型降级 | A 加 `--provider none`；B 去掉决策源 | A 仍通过；B 决策步 `no_model_runtime`（结构化），不崩、不静默点错 |
| P4 重复稳定性 | A 连跑 3 次 | 3/3 passed（flake 如实记录） |
| P5 声明护栏 | `start_url` 指到 site.hosts 外 | 加载期拒绝，不偷偷访问 |
| P6 状态漂移 | 任务 S 连跑两次 | 仍通过（会话内购物车重置） |
| P7 覆盖层/动画 | 任务 S 变体把"开菜单→登出"放回同一子目标 | 已知 flaky（trial 1 过 2 败）；记录为改进目标，不入稳定基线 |
| P8 巨大 DOM 窗口 | 任务 C 的 B 臂（侧边目录在池窗口外） | 观察到 `low_confidence`（模型对 TOC 链接多次低置信 0.09–0.11 被拒）；记录为窗口/覆盖改进项 |

## 6. Pilot 基线（2026-11-07，供跨版本对比）

环境：本机 headless Chromium；A 臂 `--provider none`；B 臂桥部署决策源（decision-service）。

| 任务/臂 | 结果 |
|---|---|
| **C · A 臂 ×3** | **3/3 passed**，9.2–10.1s；4/4 子目标 attempts 全 1，steps `[0,1,1,1]`，method 全 `rule:match`；invariant+oracle ok |
| **C · B 臂** | **失败于第 3 步（TOC → History）**：`low_confidence`；模型先正确点中 `a "Turing machine"`（conf 0.95），随后对侧边目录目标 3 次询问中 2 次被拒（conf 0.09/0.11），无动作后停；invariants 0/1。→ 真实巨大页面的"侧边目录在池窗口外"覆盖问题，A 臂同一步确定性通过 |
| **S · A 臂（稳定版）×3** | 3/3 passed，9.0–9.6s；6/6 attempts 全 1；method 全 `rule:match`；invariant+oracle ok |
| **S · A（含登出，稳定前）** | 3 次 1 过 2 败——覆盖层动画竞态（P7），已从基线移除 |
| **S · B 臂** | 失败于"移除最贵商品"：`no_progress`；decisions 15 steps（rule 4 / model 9 / reobserve 8 / model_asks 20 / failed_asks 0）；决策面选中不可动作的商品标题 div |
| P1/P2/P5 pilot | 预算耗尽/错误锚点/主机护栏均为结构化结果（见上文举证路径） |

**评估发现不是夹具问题**，修复后用同一任务复测（A 臂必须仍 3/3）；不要改任务让它变绿。

## 7. 使用纪律

- 证据写仓库外（`$AMBERFLOW_HOME/online-runs/` 或 `--out`），不提交、不当下次期望值。
- 站点 blocked/unreachable 如实记录，不绕过风控；skipped ≠ passed。
- 每次引擎变更后：A 臂必跑（快、确定性），B 臂按需跑（慢、含模型）；比较指标而非只看绿。
- 新增/修改任务：先 `npm run test:validate`，再 `--headful` 实跑两次确认稳定。
