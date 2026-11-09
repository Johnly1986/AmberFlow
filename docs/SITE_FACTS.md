# SITE_FACTS — 真实站点已知事实库（Google 域）

> 站点知识放数据/文档，不写进引擎（共享层不认识具体站点）。
> **结构化数据的唯一出处 = `site-facts/*.json`（task-15/D2：引擎按 meta.hosts 后缀匹配，
> apps check / run 起跑注入提示与 result.site_facts[]）——本文是叙述版；新增/修订事实请
> 两处同步（数据先行）。**
> 本文来源：2026-11-03 ~ 11-04 四轮真实运行实验（每轮由全新 agent 独立取证），
> 每条事实都经过 ≥2 轮独立互证或带落盘证据。维护者新增事实时请附证据出处。
> 注：当前这些事实尚未接入 Agent 可见面（工具描述 / schema ctx）——是否接入、
> 以何种粒度接入（按站点过滤）属于 B 批决策，见 `~/.amberflow/reports/gmap-hotels-8cities/`。

## Google 域通用

| 事实 | 证据轮次 | 出处 |
|---|---|---|
| 未登录 + SG 出口：UI 英文/中文随 hl 参数，自然结果显示 `$`、广告行显示 `SGD`，跨币种不折算 | r1/r2 | round1-20261104 §1；round2 报告 §b |
| 首页（www.google.com）网页搜索提交可能触发 `/sorry` 人机验证墙；站内 Maps 交互（40+ 次加载）零触发 | r2 | round2 报告 §c1（final_url 证据） |
| 高频搜索触发 **IP 级限速**：arrive 结果面板 >60s~150s 不渲染（`arrive_signal_not_held`）；冷却 7 分钟 + 分批（4 run×2 城）可解，未做任何绕过 | r4 | round4 报告 §c9（outputs JSON + timeline） |

## Google 应用九宫格（apps grid）

| 事实 | 证据轮次 | 出处 |
|---|---|---|
| 抽屉是 **ogs.google.com 跨源 iframe**（偶发主 frame 渲染，状态依赖）——点击其中瓦片需要把 `ogs.google.com` 加进 meta.hosts，否则 `frame_not_allowed` | r3×2 / r4×1 | round3 报告 §c1/c2；round4 §c3 |
| Google gapi/feedback 被动代理 iframe（`feedback-pa.clients6.google.com`、`apis.google.com`、`accounts.google.com`、`www.gstatic.com`）按需进 hosts | r3 | round3 报告 §c2 |
| 九宫格弹层元素无稳定句柄（无 data-test/id），learn 面归纳判「无变化」；引擎面可用 aria-label 池别名命中（如 `a[aria-label~地图]`） | r1 | round1 报告 §c③（源码级证实） |

## Google Maps（桌面 Web）

| 事实 | 证据轮次 | 出处 |
|---|---|---|
| **酒店面板排序菜单只有 Relevance/Rating（相关性/评分），无价格排序**——5 轮独立互证（en/zh UI 各半） | r14-legacy/r1/r2/r3/r4 | 各轮报告；r4 MENU_SEL 全文取证 |
| 桌面 Web **无「酒店」图层瓦片**（移动 App 特性未上 Web）——**r8 已直接取证**：图层面板全量 label 落盘（Transit/Traffic/Biking/Terrain/Street View/Wildfires/Air Quality/Travel time/Measure/Default/Satellite/Globe view/Labels），hotelHit=false（r1 仅推断，r8 实证）；「酒店地图」等价路径 = 酒店搜索结果页 `/maps/search/hotels…`（即价格图层视图）。注：图层面板能否打开呈状态依赖（r1 两探针 8 次点击未开、r8 一次成功），引擎无 hover 原语时个别会话需重试 | r1/r8 | round1 报告 §c④（修正版）；round8 报告 §3（layer-probe.json） |
| 酒店结果 feed 是**虚拟列表**：池/extract 只见已渲染行，需 scrollList 分块；feed 结果上限 ~120-122 卡（未登录 limited view），且**会话间结果组成有波动** | r1/r3/r4 | round4 报告 §1 跨轮对照 |
| "Next page" 翻页在未登录 limited view 下 0 新增行（r2 expand grew=false；r3/r4 翻页探测一致） | r2/r3/r4 | summary-8cities.json list_end_evidence |
| 打开筛选面板会**替换主内容树**（feed 从 DOM 摘除）→ 面板态验收要用面板内锚，回列表态再验 feed | r4 | round4 报告 §c8 |
| 排序菜单/图层面板内的条目：排序 2 项 + 图层 9 项共用一个 `[role=menu]`——done 锚要写具体文案不要写 role 容器 | r4 | round4 报告 timeline 第 6 条 |
| 广告卡（Sponsored）价格 ≠ 有机价（如北京 Hilton 广告 $134 vs 有机 $127）——「最低价」口径须排除广告卡并如实声明 | r1/r3/r4 | 各轮报告口径说明 |

## 实验纪律备注

- 以上事实随时间会漂移（Google A/B、区域、登录态都会变）；复用前先 inspect 快速复核。
- 不绕过反爬：/sorry 与 IP 限速只允许冷却/降频/分批，禁止伪造指纹或轮换代理。

| **feed 行数会话间波动大**：同一深链同一会话形态，未登录 limited view 的可滚动行数在 33-51（R2 四臂实测）与 20-122（跨轮次）间波动——「最低价」结果跨会话不可直接比，口径须随会话声明覆盖行数 | R2/R1/r3/r4 | reval/R2 报告；FINAL-8rounds |
