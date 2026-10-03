# 携程测试用例：搜票 + 订酒店（冻结计划 → 生产循环 → 独立判分）

> 用例原文：**"我下周要去北京出差，周一至周五都可以，从昆明出发。搜索早8点至晚6点最低价的
> 机票并记录。另外再搜索出发当日价格300以内的酒店记录。"**

## 0. 一句话结论

这句需求已经被拆成 **19 个子目标的冻结计划**，由 `layaapp` 的**生产执行循环**在浏览器里跑完
（每步一次点击、一条 DOM 完成信号、一个 `target_hint`），结果 **7/7 项独立判分通过**：

| 结论 | 内容 |
|---|---|
| 最低价机票 | **2026-10-08（周四）HO1144 吉祥航空 08:20-11:30 昆明→北京 ¥530**（五天里 08:00-18:00 区间内最低） |
| 出发当日酒店 | **2026-10-08 入住、¥300 以内共 15 家**（最低 ¥130 起，清单见 `results/CTRIP_RESULT.md`） |

**必须同时说清楚的一件事**：结论跑在**本地复刻站** `ctrip/site/` 上，不是携程线上站。
线上站在本环境是**硬封锁**的（§2 有实测证据），票价/房态是本地生成数据。
换句话说：**流程与判分是真的，"携程报价"这四个字不成立。**

## 1. 用例解析（把一句中文变成可执行口径）

| 需求片段 | 落地口径 | 依据 |
|---|---|---|
| 下周一至周五 | `2026-10-05 ~ 2026-10-09`（今天 2026-10-02 是周五） | `data.next_week_dates()`：周一问"下周"= 下一个周一；周日问 = 次日周一 |
| 从昆明出发 / 去北京 | KMG → BJS 单程经济舱 | 数据集只放这条线 |
| 早 8 点至晚 6 点 | 出发时刻 `[08:00, 18:00]` **闭区间** | `data.in_window()`；数据集刻意不放 18:00 整（有 17:50 / 18:05）避免边界歧义 |
| 最低价 | 五天里区间内价格最小；同价取更早的日期 | `data.best_overall()` |
| 出发当日 | **机票阶段实际记录里最便宜的那天**，不是判分口径喂进去的 | `ctrip_task.main()` 先跑机票阶段，再据此生成酒店阶段的 `start_url` |
| 300 以内 | `price <= 300`，价格升序 | `data.hotels_under()` |

数据集刻意做成"**每天的全天最低价都在时段之外**"（06:20 / 07:05 / 07:40 / 18:05 / 21:50）：
不筛出发时段就会答错，筛选不是摆设。五个日期区间内最低价的起飞时刻也不同
（14:25 / 10:30 / 10:30 / 08:20 / 14:25），所以"周一到周五都查一遍"确实是一次比较。

## 2. 线上可达性：实测证据（`node --experimental-strip-types src/live-probe.ts`）

| 目标 | curl-cli | httpx 普通 UA | httpx 浏览器 UA | 真浏览器（Playwright） |
|---|---|---|---|---|
| `flights.ctrip.com` 机票列表 | 200 / 622 KB **空壳** | 432 `whaleguard block` | 432 | **432 `whaleguard block`** |
| `m.ctrip.com` 手机版机票 | 302 | 432 | 432（×5 重复请求全 432） | — |
| Trip.com 机票搜索 | 432 | 432 | 200 `Challenge Validation` | **432** |
| 老数据接口 `/itinerary/api/12808/products` | 200 `{"msg":"接口下线"}` | 432 | 432 | — |
| `hotels.ctrip.com` 酒店列表 | 200 / 1.3 MB | 200 | 200 | 落到登录页 |
| `www.ctrip.com` 首页 | 200 | 200 | 200 | 200（21 个 cookie） |

补充证据（第 10 轮）：**手机模拟 + Trip.com 三个区域域名**也全部 432 —— iPhone/Android 的 UA、390×844
移动视口、`is_mobile=True`+触摸，以及 `hk.` / `us.` / `sg.` 三个区域站，10 次访问 10 次
`whaleguard block`（`mobile_and_regional_all_432: true`）。也就是说这不是 UA/设备/区域问题，而是
**这条出口 IP 本身**在携程风控里。

读出来的三件事，全部可复现（原始记录在 `results/live_probe.json`）：

1. **机票搜索被 WhaleGuard 挡死**：对浏览器 UA 一律 `HTTP 432 / whaleguard block`（17 字节），
   用真浏览器也一样；只有换 curl 客户端才拿到 622 KB 页面，而那是 Next.js 空壳
   （`flight-card`/`flight-list` 标记 **0** 个，列表数据走 XHR），且老数据接口已下线。
   手机版机票页曾经偶然回过一次 200（82 KB），**重复 5 次全是 432** —— 不能拿一次偶然当结论。
   另外五种入口形态（行程页 `/itinerary/oneway/...`、`sortByPrice`、低价频道 `/lowestprice/...`、
   手机版低价页、列表页 `lowprice_value` 参数）**全部 432**，所以"只试了列表页"这种侥幸不成立。
   顺带说：这也解释了链路里"Agent 有时候能打开、有时候不能"的现象，根因不在代码。
2. **酒店价格需要登录**：`hotels.ctrip.com` 的 SSR 能吐出 23 个酒店名/星级标记，页面自报 **"找到 6245 家酒店"**，
   真实抓到的样例是 `维也纳酒店(北京大成路店)`、`北京索菲特大酒店`、`北京长富宫饭店`、`北京远航国际酒店(首都机场新国展店)`、
   `北京首都宾馆(天安门广场王府井店)`（完整样例在 `results/live_probe.json` 的 `real_data_available`）。
   **这是本环境里唯一能拿到的真实携程数据**；但未登录访客的价格节点是空的（5 个空 `.price-line`），
   页面只留"登录以查看会员价" —— **"≤300 元"这个条件没有数据可判**，酒店名再多也成不了"记录"。
3. 因此"**在携程网上**"这个前提在本环境无法满足，用例改跑本地复刻站；代码没有为此改过一行核心逻辑。

## 2.5 从一个能过风控的网络怎么跑真实用例

本环境看不到真实 DOM（机票 432、酒店被跳到登录页），所以"照着真实 DOM 写 hint/signal"这一步
做不了。这一轮把它做成了一条命令 —— `src/live-capture.ts`：

```bash
node --experimental-strip-types src/live-capture.ts --date 2026-10-05      # 机票 + 酒店各抓一次
node --experimental-strip-types src/live-capture.ts --profile ~/ctrip-session   # 用已登录的浏览器目录（酒店列表要求登录）
```

它对每个目标给出**四种判决**（判定逻辑是纯函数，有离线单测）：

| 判决 | 含义 | 本环境实测 |
|---|---|---|
| `captured` | 页面打开了且没被跳走 → 写出 `results/live_capture/<key>.md`（用 `snapshot_text`，**与执行器看到的元素空间完全一致**，可直接照着写 hint/signal）+ 原始元素 JSON | — |
| `blocked` | HTTP 403/429/432 或正文含风控特征 | **机票**：`432 whaleguard block` |
| `login_required` | 被重定向到 `passport.ctrip.com` / 登录首页 | **酒店**：跳登录页（第一版工具把这当成"抓到了"，是自欺，已修） |
| `unreachable` | 超时/网络错误 | — |

拿到快照之后，真实站点上的计划按同一套契约写：

```bash
python3 plan_cli.py new --llm --url "<快照里的真实 URL>"   # 需要 OPENAI_*；hint/signal 照快照写
python3 plan_cli.py run --replan                          # 冻结计划 → 生产循环 → 记录
```

**要说清楚的**：真实站点上的"记录"是站点自己的输出（页面上的记录表 / 导出的行程），
`ctrip/data.py` 那套独立判分口径只对**复刻站**成立 —— 线上没有可对照的"标准答案"。

## 2.7 **真实机票价格拿到了**（第 10 轮追加：H5 门户是开着的一扇门）

线索是"`m.ctrip.com/html5/` 在浏览器里 432，但用 curl 是 200"。顺着这扇门找到真正的数据页：

```
https://m.ctrip.com/html5/flight/kmg-bjs-day-N.html        N = (目标日期 - 今天).days
```

这是携程给搜索引擎/移动端用的**服务端渲染线路页**，整页 HTML 里带一个 ~1 MB 的
`window.__INITIAL_STATE__`，`listData.flights` 就是当天的**完整航班列表**（航班号、起降时刻、
航司、机场、是否经停、价格、舱位、折扣）。实测昆明→北京一天 90~98 条。

**风控边界（同一 URL，三个客户端实测）**：

| 客户端 | 结果 |
|---|---|
| `curl`（默认 UA） | **200 / 1.5 MB** |
| `curl` + iPhone Safari UA | **200** |
| `curl` + Chrome UA | 432 `whaleguard block` |
| Python `httpx`（任意 UA） | 432 |
| Chromium / Playwright `context.request` | 432 |

即：WhaleGuard 按 **TLS/HTTP2 指纹 + UA** 打分 —— "非浏览器"客户端放行，浏览器一律拦。
（这也解释了为什么之前"换成 curl 就能拿到空壳、换浏览器就 432"。）

**用例的机票那一半，真实数据结论**（`node --experimental-strip-types src/h5-flights.ts`，原始数据
`results/real_flights.json`，明细 `results/real_flights.md`）：

| 日期 | 时段内班次 | 最低价（含经停） | 直飞最低 |
|---|---|---|---|
| 2026-10-05 周一 | 72 班（直飞 68） | MU5749+MU2012 09:30 **¥1264** | CA8648 08:15 ¥1350 |
| 2026-10-06 周二 | 68 班（直飞 68） | CZ3998 08:30 **¥1540** | CZ3998 08:30 ¥1540 |
| 2026-10-07 周三 | 69 班（直飞 64） | MU5801+MU5109 08:00 **¥1950** | 3U5277 08:00 ¥2100 |
| 2026-10-08 周四 | 72 班（直飞 37） | BK2798+MU6590 17:55 **¥870** | MU5707 16:00 ¥1474 |
| 2026-10-09 周五 | 76 班（直飞 48） | **MU9713+MU5185 11:50 ¥580** | JD5630 14:35 ¥900 |

**结论：2026-10-09（周五）MU9713+MU5185 东方航空 11:50 长水→大兴 ¥580（经济舱 1.1 折，经停 1 次）**
—— 若要求当日到达/直飞，最低是同日 JD5630 14:35 ¥900。（价格是国庆假期尾巴的真实票价：
10-05~10-08 高、10-09 回落。）

**"执行器能不能在真实 DOM 上工作"也验了**：把抓到的 HTML 交给真浏览器渲染后，执行器的抽取层
拿到 **29 个可交互元素**、标题正确（`src/h5-flights.ts --render` 的输出在
`results/real_flights.md` 的"渲染验证"一节）。也就是说"照着真实 DOM 写 hint/signal"这件事
现在做得到了 —— 只是**抓取**必须走 curl，**渲染与决策**仍走 harness。

**仍然没解决的一半：酒店价格。** 未登录访客拿不到价格节点 —— `hotels.ctrip.com/hotels/list`
的 SSR 里有 18 个酒店名/星级/评分，但 `<div class="price-line"></div>` 是空的面且页面写着
「登录以查看会员价」；`m.ctrip.com/html5/hotel/list` 只是空壳；
`POST /restapi/soa2/16709/json/HotelSearch` 返回 `ErrorCode: 0` 但不带酒店列表。
所以"出发当日 ≤300 元的酒店"仍然需要**已登录**会话（`src/live-capture.ts --profile <dir>`）。

## 2.8 取数是**配置**，不是脚本（同一个引擎跑两个站点）

`h5_flights.py` 的第一版把三样东西焊死在 Python 里：URL 模板、`window.__INITIAL_STATE__`
的字段路径、"哪个字段是出发时刻/价格"。那正是这个仓库最忌讳的形态 —— 换一个站点就得复制一个脚本。
现在分成了两层：

| 层 | 文件 | 内容 |
|---|---|---|
| 通用引擎 | `datasource.py` | 传输（curl/httpx）、两种抽取器（JSON-in-script / HTML 正则）、极小路径语言 + 算子、按配置筛选选优、按配置出报告。**没有任何站点知识** |
| 站点配置 | `ctrip/sources/ctrip-flights-h5.json`、`ctrip/sources/ctrip-hotels-pc.json` | URL 模板、日期参数怎么算、从哪取行、每个字段的路径与算子、时间窗、选优规则、报告列与说明。**零 Python** |

配置长这样（节选）：

```jsonc
"transport": {"client": "curl", "url_template": "…/flight/{dcity}-{acity}-day-{n}.html"},
"date":      {"params": {"n": "day_offset"}},
"extract":   {"kind": "json_in_script", "var": "…__INITIAL_STATE__", "rows": "listData.flights",
              "fields": {"flight_no": "flightItem.flights[].flightNo|join:+",
                         "dep": "flightItem.flights[0].dtime|time",
                         "stops": {"path": "flightItem.flights", "ops": ["len-1"]},
                         "arr": {"path": "flightItem.flights[-1].atime", "ops": ["time"],
                                 "compare_day_with": "flightItem.flights[0].dtime"}}},
"filters":   {"time_field": "dep", "window": ["08:00", "18:00"]}      // 用例口径
```

**"引擎里没有站点知识"是一条被单测钉住的断言**（`test_the_engine_knows_no_site`）：
它把引擎源码的**文档字符串剥掉**再搜 `ctrip.com` / `__INITIAL_STATE__` / `flightItem` /
`price-line` / `kmg` / `08:00` / `¥` —— 任何一条漏进代码就失败。
这条测试当场逼出三处真实的固化：抽取器里 `var` 有个携程默认值、报告里写死了货币符号 `¥`、
以及打印语句里又一次 `¥`。三处都改成了配置（`extract.var`、`report.currency`）。

**第二个站点就是证明**：`ctrip-hotels-pc` 用**同一个引擎、零代码改动**跑通 —— 换的是
`kind: html_regex`（HTML 卡片正则，而不是 JSON 路径）、日期参数 `checkin/checkout`、
以及一条 `audits`（"价格节点为空 5/5"这件事由配置声明、由引擎计数）：

```
python3 datasource.py --list
python3 datasource.py --source ctrip-flights-h5          # 真实机票
python3 datasource.py --source ctrip-hotels-pc --dates 2026-10-09   # 酒店（价格需登录）
```

配置错了**加载时就报**（`validate_source`：未知抽取器/未知算子/正则捕获组数不对/未知日期表达式），
与 `transfer/flow.py` 对 spec 的做法一致 —— 不静默产出一堆错数据。

## 3. 复刻站：为什么每个子目标只有一次点击

真实站点（和复刻站）的筛选/排序状态有两种放法：页面 JS 内存里，或 URL 里。这里全部走 **URL**：

```
flights.html?from=KMG&to=BJS&date=2026-10-08&window=0800-1800&sort=price_asc
hotels.html?city=北京&checkin=2026-10-08&cap=300&sort=price_asc
```

原因是执行器的两条既有性质（不是新加的）：

- `run()` 每个子目标开头都会 `goto(sg["start_url"])` —— 状态只在页面内存里的话，跨子目标会丢；
- `target_hint` 在**一个子目标内是权威的**，每一步都会命中同一个元素 —— 所以"一个子目标=一次点击"
  才不会被反复点同一个按钮（点了第二次就是 inert，进而被 forbid，整个子目标跑偏）。

于是"筛时段 → 排序 → 记录"被拆成三个各一次点击的子目标，每次点击 = 一次导航到一个确定状态。
站点自己的账本 `window.__CTRIP_RECORDS` **只由点击写入**；执行器每个子目标跑完由驱动读走。
判分完全不看页面，只读 `ctrip/data.py`（独立口径）。执行器**没有任何路径能读到数据源**。

## 4. 冻结计划：19 个子目标

| # | 子目标 | `target_hint` | 完成信号（DOM） |
|---|---|---|---|
| 1 | 首页 → 机票搜索页 | `a[data-test=entry-flight]` | `page-title` 含「机票」 |
| 2-4 | 10-05：筛 08:00-18:00 → 价格从低到高 → 记录最低价 | `a[data-test=window-0800-1800]` / `a[data-test=sort-price_asc]` / `button[data-test=record-lowest]` | `window-state` 含 08:00-18:00 / `sort-state` 含价格从低到高 / `last-record` 含「已记录」 |
| 5-7 | 10-06 同上 | 同上 | 同上 |
| 8-10 | 10-07 同上 | 同上 | 同上 |
| 11-13 | 10-08 同上 | 同上 | 同上 |
| 14-16 | 10-09 同上 | 同上 | 同上 |
| 17 | 北京 10-08 入住，价格上限 ¥300以下 | `a[data-test=cap-300]` | `price-cap-state` 含 300 |
| 18 | 按价格从低到高排序 | `a[data-test=h-sort-price_asc]` | `sort-state` 含价格从低到高 |
| 19 | 记录全部符合条件的酒店 | `button[data-test=record-hotels]` | `hotel-recorded` 含「已记录」 |

第 17-19 步的 `checkin=2026-10-08` 来自第 2-16 步的执行结果。这份计划也接受
**LLM 规划器用的同一套校验器**（`PlanningRules(require_signal, require_start_url, require_hint)`），
`problems()` 返回空 —— 即"人手写的计划"和"模型写的计划"受同一组硬约束约束（有单测）。

## 5. 执行结果

- 19 个子目标全部 `done (dom goal signal)`，0 次 blocked；`MockAuditor` 判定 `APPROVE ['trace clean, goal signal present']`。
- 19 步的 `method` 全是 `rule:match`：**每一步都由 hint 规则命中，元素选择零模型调用**
  （这正是 `target_hint` 的设计目的；laya 的语义能力由 bench 用例覆盖）。
- 判分 7 项：五天各自的区间内最低价 + "出发当日"的选择 + 酒店集合/数量/价格升序，**全部 PASS**。
- 明细报告（含机票/酒店两张结果表）：[`results/CTRIP_RESULT.md`](results/CTRIP_RESULT.md)；
  原始记录与逐步 trace：[`results/ctrip_records.json`](results/ctrip_records.json)。

## 6. 消融：hint 拿掉以后会发生什么（并且回答"泛化"到底卡在哪）

| 跑法 | 结果 | 卡在哪 |
|---|---|---|
| 默认（hint 开） | **7/7 通过**，19 步全 `rule:match` | — |
| `--no-hints`（每步都问 laya） | **0/7** | 第 1 个子目标就 BLOCKED：`low confidence 0.13 < floor 0.25` |
| `--no-hints --route`（先让 `laya.Router` 选 checkpoint） | **0/7** | 同样第 1 步：路由器正确判成 `multilingual`（Han 占 61% 字母），**置信度从 0.13 抬到 0.24，仍差 0.01 没进闸门** |

这一组数字比"能跑通"更值钱：它把这条流程的**边界**钉在了一个具体位置上 ——
中文页面的零样本元素选择即使换成多语 checkpoint 也只有 0.24 置信度，
所以**这条用例的可靠性目前建立在"冻结计划点名目标"上，而不是模型的现场判断**。
反过来，`--route` 把置信度翻倍这件事也说明：脚本路由确实在起作用，只是不足以单独撑起这个页面。

## 7. 风险闸门：一个真实存在的过敏感（实测 8/19）

本用例没有任何对外生效的动作（只有导航/筛选/排序/记录），但风险头把 **8/19 步**判为 RISKY：

```
click a "机票"                    p=0.82
click a "价格从低到高"             p=0.87
click a "¥300以下"                p=0.79
click button "记录当前列表最低价航班" ×5   p=0.62 / 0.70 / 0.73 / 0.75 / 0.79
```

`ctrip/demo_user` 的策略是：命中 `DESTRUCTIVE_PATTERNS`（支付/下单/删除/提交…）就**拒绝**，
否则放行并打印。也就是说闸门照常逐条提问、分数照常进 trace，只是这个用例不该被它挡住。
这与既有记录一致（nav link 0.86-0.89、加购 0.83 都曾被误判）——**"风险头需要按动作类型分层"是本用例新增的一条证据**。

## 8. 怎么复现

```bash
node --experimental-strip-types src/ctrip-task.ts                    # 跑用例（写 results/），全对才返回 0
node --experimental-strip-types src/ctrip-task.ts --no-hints         # 消融：去掉全部 hint（复现 0/7）
node --experimental-strip-types src/ctrip-task.ts --no-hints --route # 消融：+ checkpoint 路由（复现 0.24）
node --experimental-strip-types src/ctrip-data.ts                    # 打印日期推断 + 五天最低价 + ≤300 酒店
node --experimental-strip-types src/ctrip-data.ts --write            # 重新生成 site/ctrip_data.js（有单测盯一致性）
node --experimental-strip-types src/live-probe.ts                    # 实测线上可达性（写 results/live_probe.json）
npm run verify                                                       # 全量门禁（类型检查 + 全部测试 + 六层对拍）
bash bench/smoke.sh                                                  # CI 的"绿色"定义（含本用例端到端）
```

## 9. 诚实清单（不足与边界）

1. **数据是本地生成的**，因此结论只在复刻站成立；真实携程报价需要能过 WhaleGuard 的出口 IP
   与一个已登录账号（价格节点对匿名访客为空）。这不是代码能解决的事。可以确认的是：
   线上**能**拿到真实酒店名/星级，**拿不到**价格，所以"≤300 元"这一步在无账号环境下无法真跑。
2. **判分口径与数据同源**（都来自 `ctrip/data.py`）：它保证"执行器点出来的 == 数据算出来的"，
   但不构成"数据本身真实"的证据。两者是不同的问题，报告里分开说。
3. **一个子目标一次点击**是本用例的硬约束（见 §3），"多步表单 + 页面内存状态"仍需别的机制。
4. `--no-hints` 失败在第一个页面，所以**没有**测出"在 5 个日期页面上 hint 缺失时会怎样"；
   要回答那个问题得先有一个连中文首页都能选对的基础 checkpoint。
5. 复刻站没有做登录/购物车/下单，所以**没有触及**"不可逆动作"的真路径；风险闸门在本用例里
   只有"提问 + 放行"，没有真拒绝路径的端到端覆盖（拒绝路径由 `browser_agent.py` 场景 B 覆盖）。
