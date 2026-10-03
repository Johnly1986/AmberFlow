# 线上平台复测报告（2026-10-03）

本轮先清技术债（探针集搬进应用包，`apps:matrix` 的债 3 → 0，提交 `76596a3`），
再用**同一套代码**把线上平台重跑一遍。目的有两个：确认清理没有改变行为，拿到当次的可比数字。

- 运行窗口：2026-10-03 15:49:58Z → 15:58:58Z（UTC），`node v22.23.2`，本机直连外网（无代理）。
- 决策模型：本地 ONNX（`/tmp/laya_dec.onnx`），两个 checkpoint 都装上了
  （`checkpoints loaded: ["english","multilingual"]`）；真实站点用例全部**规则命中**，
  模型一次都没被问到（见下表 `rule` 列）——这与历史记录一致。
- **冻结语料没有被覆盖**：所有会写文件的命令都带 `--out /tmp/live-retest/...`；
  `live-capture` 为此新增了 `--out`（提交里有测试钉住）。
- 原始数字：`bench/live-retest/2026-10-03/summary.json`（本次运行结果的机器可读摘要）。

## 一、短流程线上包 `bench/cases-live.json`（8 个真实站点）

```bash
node --experimental-strip-types src/bench.ts --cases bench/cases-live.json \
     --mode-tag live --out /tmp/live-retest/short
```

| 用例 | 站点 | checkpoint | 子目标 | 步数 | 用时 |
|---|---|---|---|---|---|
| live-wiki-en-search | en.wikipedia.org | english | 2/2 | 2 | 15.9 s |
| live-wiki-zh-search | zh.wikipedia.org | multilingual | 2/2 | 5 | 199.1 s |
| live-hn-newest | news.ycombinator.com | english | 1/1 | 1 | 26.9 s |
| live-python-org-search | python.org | english | 2/2 | 2 | 6.2 s |
| live-bbc-news | bbc.com | english | 1/1 | 1 | 8.5 s |
| live-books-next-page | books.toscrape.com | english | 1/1 | 1 | 4.4 s |
| live-quotes-next-page | quotes.toscrape.com | english | 1/1 | 1 | 2.8 s |
| live-polymer-shadow | shop.polymer-project.org（shadow DOM） | english | 1/1 | 1 | 3.0 s |

**合计 8/8 用例、11/11 子目标、14 步、266.8 s；14/14 步 `rule:match`，0 步模型选。
2 个子目标用到了 `retries`**（zh 维基百科的两个子目标各 2 次尝试：冷启动 + SPA 水合）。

历史记录（本仓库 README / CLAUDE.md）：**8/8、11/11，全部 `rule:match`** —— 与本次逐项一致。

## 二、长流程线上包 `bench/cases-live-long.json`（3 条完整旅程 / 34 个子目标）

```bash
node --experimental-strip-types src/bench.ts --cases bench/cases-live-long.json \
     --mode-tag live-long --out /tmp/live-retest/long
```

| 用例 | 站点 | 子目标 | 步数 | 用时 | 重试 |
|---|---|---|---|---|---|
| live-long-saucedemo-checkout | www.saucedemo.com | 15/15 | 22 | 54.3 s | 0 |
| live-long-books | books.toscrape.com | 10/10 | 10 | 21.0 s | 0 |
| live-long-quotes | quotes.toscrape.com | 9/9 | 11 | 23.5 s | 0 |

**合计 3/3 用例、34/34 子目标、43 步、98.8 s；43/43 步 `rule:match`，0 步模型选，0 次重试。**

历史记录：**34/34 子目标、43 步全部 `rule:match`，102.6 s / 91.1 s** —— 本次 98.8 s，落在同一区间；
saucedemo 那条 15 子目标的完整旅程（登录 → 排序 → 加购 → 详情 → 返回 → 购物车 → 移除 → 继续 → 加回 →
结算 → 提交 → 断言购物车清空 → 登出）一次跑通，没有触发 `retries`，也不需要模型兜底。

> 这两条线上包的关注意义不在"又绿了一次"，而在**前面四项实测修复仍然有效**：
> `target_hints` 同步重解析、`action-timeout` 长重试、done-signal 的 settle 窗口、非零盒可见性。
> 任一回归都会在这 34 个子目标里以 BLOCKED/`max_steps` 的形式暴露出来（历史上有过 7/15 的抖动）。

## 三、可达性探针（四个驱动，全部数据驱动）

```bash
node --experimental-strip-types src/live-probe.ts   --out /tmp/live-retest/live_probe.json
node --experimental-strip-types src/live-capture.ts --out /tmp/live-retest/capture
node --experimental-strip-types src/ota-probe.ts    --out /tmp/live-retest/ota_probe.json
node --experimental-strip-types src/qunar-probe.ts
```

### 3.1 携程（`apps/ctrip-live`）

| 目标 | curl（普通 UA） | fetch 普通 UA | fetch 浏览器 UA |
|---|---|---|---|
| PC 机票列表 | 200（Next.js 空壳） | 432 `whaleguard` | 432 `whaleguard` |
| 手机版机票 | 302 | 432 `whaleguard` | 432 `whaleguard` |
| Trip.com 机票 | 432 `whaleguard` | 432 `whaleguard` | 200（人机校验页） |
| 老数据接口 | 200（`{"msg":"接口下线"}`） | 432 `whaleguard` | 432 `whaleguard` |
| PC 酒店列表 | 200 | 200 | 200 |
| 携程首页 | 200 | 200 | 200 |

- **机票 `BLOCKED`**：真浏览器同样 432 `whaleguard block`；curl 拿到的 621 901 B 是 Next.js 空壳
  （`flight-card`/`flight-list` 标记 0 个，列表数据走 XHR），老接口页面自报"接口下线"。
- 五种其它入口形态（行程页 / 低价频道 / 手机版低价页 / 带 lowprice 参数）**5/5 全 432**；
  手机模拟 + 区域域名（iPhone / Android × 携程手机版 / Trip.com 香港·美国·新加坡）**8/8 全 432**；
  手机版机票页重复请求 **5 次全 432**（不是边缘缓存漏网）。
- **酒店 `LOGIN_REQUIRED`**：列表页 SSR 出 23 个酒店名/星级标记、页面自报 **6241 家**北京酒店，
  但未登录访客的价格节点为空（5 个空 `.price-line`），正文含「登录以查看会员价」——
  「¥300 以内」这个筛选条件依然拿不到数据。
- `live-capture`（DOM 抓取）：**captured 0/2** —— 机票 `blocked`（432）、酒店 `login_required`
  （200 但跳到登录墙）。这正是当初第一版工具判错的地方（把登录表单当"抓到了"）。

### 3.2 其它 OTA（`apps/ota-live`）

| 站点 | curl | fetch 浏览器 UA | 真浏览器渲染 |
|---|---|---|---|
| 去哪儿机票 | 200 | 200 | 200，无价格 |
| 去哪儿酒店 | 301 | 200 | — |
| 同程酒店 | 301 | 200 | 200，无价格 |
| 途牛 | 202 | 202 | 202，无价格 |
| Booking | 202 | 202 | — |
| Agoda | 200 | 200 | — |
| Expedia | 429（人机校验） | 429（人机校验） | — |
| Kayak | 302 | 200（人机校验） | — |

`anonymous_price_list_reachable = false`，`usable_targets = []`：**本环境下没有任何一家匿名可访问的
OTA 会抛出价格列表**（与已提交的 `transfer/results/ota_probe.json` 结论一致）。

### 3.3 对照站点（`apps/qunar-live`）

| 客户端 | 结果 |
|---|---|
| curl（默认 UA） | captured，200，669 519 B |
| curl（iPhone UA） | captured，200，669 523 B |
| httpx | captured，200，669 532 B |
| 真 chromium | captured，200，786 232 B，title「去哪儿网机票服务」，找到搜索入口 |

页面本身三种客户端都抓得到 —— 与携程的 432 形成对照；被拒的是它的**列表 API 对自动化浏览器**
（边界记录在 `src/qunar-task.ts` 的独立判分里）。

## 四、这次复测证明了什么、没证明什么

**证明了**：
1. 债清理是**行为保持**的：探针判决与历史结论逐项一致，连判决文本（由包里的 `short` 显示名拼出来）
   都与已提交语料同形——说明"搬到数据里"没有偷偷改变测量口径；
2. 应用层（`pack.json` + 共享运行器 + 探针集）能跑真实线上流程：短包 8/8、长包 34/34，全部规则命中；
3. 线上包的四个实测修复仍然有效（34 个子目标零阻塞、零模型兜底）。

**没证明 / 需要注意**：
- 线上站点本身会波动（zh 维基百科历史上有过服务端错误壳、saucedemo 有过 7/15 的抖动）；
  本次只跑**一轮**，8/8 与 34/34 是这一轮的事实，不是稳定性保证。要谈稳定性得照
  `bench/LONG_FLOW_REPORT.md` 的做法做多次重复。
- 携程/酒店的结论是"**本环境、本出口 IP**"的结论：换一个能过风控的出口 IP 或带登录态，
  同一套驱动可以直接复用（`--profile` 指向已登录的浏览器配置目录即可）。
- 应用层的两个离线包（`demo-app` 的夹具旅程、`cli-report` / `repo-report` 的工具步）**不在**这次线上复测范围内：
  它们按设计就是离线、可进 CI 的（`bash bench/smoke.sh` 已经把它们跑绿）。
