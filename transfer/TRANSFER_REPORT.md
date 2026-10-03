# 迁移报告：同一套流程，换一个布局相似的旅游网

## 0. 先回答那个问题：流程可以**不**固化在 Python 里（连形状也不固化）

可以，而且已经改了。现在一条用例的流程是 `transfer/specs/<site>.json`，
**形状**是一条阶段列表（顺序即执行顺序）：

```jsonc
// 一个"两页向导"的机票搜索：per_date 上开两个阶段
{ "phase": "wizard_date",    "stage": "flight", "repeat": "per_date", "steps": [ … ] },
{ "phase": "wizard_options", "stage": "flight", "repeat": "per_date", "steps": [ … ] },
{ "phase": "results",        "stage": "flight", "repeat": "per_date", "steps": [ … ] },
{ "phase": "hotel",          "stage": "hotel",  "repeat": "per_checkin", "steps": [ … ] },
```

`repeat` 只有三种（`once` / `per_date` / `per_checkin`），`stage` 决定它属于"先跑的那段"还是
"依赖出发当日的那段"。**在 `per_date` 上多开一个阶段就是向导** —— 加载器里没有任何一行知道"向导"。

每个阶段的每一步仍然是：

```jsonc
// transfer/specs/skybook.json（截取）
"params": { "from": "昆明", "to": "北京", "city": "北京", "cap_label": "¥300" },
"slots":  { "window": "0800-1800", "sort": "price_asc" },     // 下拉框要填的值
"ledger_js": "() => window.__SKYBOOK_LEDGER || {}",            // 站点自己的账本
"phases": {
  "per_date": [                                   // 每个候选日期重复的三元组
    { "role": "filter_window", "desc": "打开 {date}（{wd}）{from}到{to}的航班列表，并把出发时段筛选为 {window_label}",
      "path": "flights.html", "query": {"from": "KMG", "to": "BJS", "date": "{date}"},
      "hint": "#window", "signal": {"css_text_contains": ["#window-state", "08:00-18:00"]} },
    ...
  ],
  "collect": [ ... ]                              // 站点专有的收集序列（勾选/记录/翻页）
}
```

`transfer/flow.py`（约 80 行的加载器）负责：占位符替换、**复用 `layaapp` 的 `SIGNAL_OPS` 校验信号**
（算子写错、参数个数不对、缺 hint、`site_dir` 不存在、占位符写了不存在的名字 → 加载/展开时立刻报错，
而不是跑到第 9 步才发现）、把 `path` + `query` 拼成 `file://` URL（中文自动转义）。

**边界（有意不配置的部分）**：

| 东西 | 为什么留在代码里 |
|---|---|
| 判分口径（`verify` + 数据模块） | 它必须是**独立的第二实现**。写进流程配置就变成自我核对，失去意义 |
| 站点库存生成器（`ctrip/data.py`、`transfer/data2.py`） | 那是站点内容，不是流程；换站点就是要换它 |
| 执行循环 `BrowserMiddleware` | 站点的控件形状千变万化，把它配置化只会得到一份无法测试的字符串程序 |
| 站点自身的 JS/HTML | 同上（复刻站就是"站点"） |

**证明"配置真的能表达这条流程"，而不是嘴上说**：`transfer/specs/ctrip.json` 展开出来的 19 个子目标，
与 `ctrip/ctrip_task.py` 里手写的那份**逐字段一致**（`desc` / `signal` / `start_url` / `target_hint` 全等），
由单测钉住；`--emit-plan <site>` 还能把配置展开成 `TaskPlan` 的磁盘格式，交给 `plan_cli run`。

## 1. 迁移到哪：先测真实站点，不行才用复刻站

`python3 transfer/ota_probe.py` → `results/ota_probe.json`（8 家 × 两种 HTTP 客户端 + 真浏览器渲染）：
携程 432、Trip.com 432/挑战页、去哪儿网页版机票（页面公告 **2026-10-10 起停止提供**）、同程/途牛空壳、
Booking 202/0 B、Agoda 挑战、Expedia 429 `Bot or Not?`、Kayak 人机校验 —— **没有一家对匿名 + 机房 IP
的访客抛出价格列表**。所以迁移用"结构不同、同类任务"的复刻站 #2（SkyBook）来证明：

| 维度 | 携程复刻站 | SkyBook（迁移目标） |
|---|---|---|
| 界面语言 | 中文 | **英文** |
| 属性约定 | 全是 `data-test` | **id / name / class**（真实站点常态） |
| 出发时段 / 排序 | 链接 | **`<select>` 下拉**（值来自计划数据袋） |
| 价格上限 | 链接 | **radio 单选组** |
| 结果形态 | 竖排列表 | **网格卡片**，价格在 `<em class="amount">` |
| 记录方式 | 一个按钮 | **先勾选、再提交**（复选 + select-all） |
| 分页 | 无 | **两页**（≤300 的 15 家：8 + 7） |

两套库存也不同（不同航司/价格/酒店名），所以"答案"本身就不同。

## 2. 结果：七个站点都是 7/7，每一步都由规则命中

| 站点 | 配置 | 布局特点 | 子目标 | 步数（`rule:match`） | 判分 | 出发当日 | 最低价 | 酒店 |
|---|---|---|---|---|---|---|---|---|
| 携程复刻站 | `specs/ctrip.json` | 中文、`data-test`、链接筛选、竖列表 | 19 | 19（19/19） | **7/7** | 2026-10-08 | HO1144 ¥530 | 15 家 |
| SkyBook | `specs/skybook.json` | 英文、id/name、下拉+单选、网格、**两页** | 23 | 23（23/23） | **7/7** | 2026-10-07 | PB446 ¥630 | 15 家 |
| Trekly | `specs/trekly.json` | 英文、**表格**结果、**滑块**价格上限、一次记全 | 19 | 19（19/19） | **7/7** | 2026-10-09 | VM474 ¥480 | 12 家 |
| FlyQuest | `specs/flyquest.json` | 英文、**搜索是表单**（结果页只能靠提交到达） | 19 | **30**（30/30） | **7/7** | 2026-10-05 | CT603 ¥530 | 14 家 |
| Voyagio | `specs/voyagio.json` | 英文、**两页向导**（第 1 页选日期 → 第 2 页选时段并搜索） | **24** | 24（24/24） | **7/7** | 2026-10-06 | VG705 ¥550 | 13 家 |
| FareHaven | `specs/farehaven.json` | 英文、**促销遮罩只出现在部分日期**（条件子目标） | **24** | 20（20/20，**4 个跳过**） | **7/7** | 2026-10-08 | MT733 ¥450 | 11 家 |
| SlowJet | `specs/slowjet.json` | 英文、**摘要页首次访问是冷的**（重试策略） | 19 | 19（19/19，**5 个重试**） | **7/7** | 2026-10-07 | QK764 ¥510 | 10 家 |

前五个站点的出发当日正好铺满周一到周五（10-05 ~ 10-09）；FareHaven 与携程同一天、
SlowJet 与 SkyBook 同一天，但航班各不相同。七个站点的答案七个不同 —— 库存确实是各自的。

七家都由**独立口径**判分（五天逐日最低价 + "出发当日"的选择 + 酒店集合/数量/价格升序），
`blocked=None`，审计 `APPROVE`；三个站点的库存不同，所以**答案是三个不同的航班**。
明细：`results/TRANSFER_RESULT_{ctrip,skybook,trekly,flyquest,voyagio,farehaven,slowjet}.md`。

**第三个站点是"只加配置"加出来的**：新增 `transfer/specs/trekly.json` + `transfer/data3.py`
（它自己的库存）+ `transfer/site3/`（它自己的页面），`flow.py`、`transfer_task.py`、
执行器 **一行未改**。这正是"流程是配置"要证明的东西。

## 3. 迁移指标（"迁移"到底改了什么）

基准 = `ctrip/ctrip_task.py` 里手写的 19 步计划；对比 = 两个 spec 展开的计划。

| 指标 | ctrip（自证） | skybook | trekly | flyquest | voyagio | farehaven | slowjet |
|---|---|---|---|---|---|---|---|
| 共享角色数 | 18 | 18 | 18 | 18 | 18 | 18 | 18 |
| 描述归一化后相同¹ | 18/18 | **18/18** | **18/18** | **18/18** | **18/18** | **18/18** | **18/18** |
| hint 改写 | **0/18** | **18/18** | **18/18** | **18/18** | **18/18** | **18/18** | **18/18** |
| `signal` 改写 | 0/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| `start_url` 改写 | 0/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| 共享角色需要的**动作次数** | 18 | 18 | 18 | **29** | **23** | 18 | 18 |
| **骨架多出来的角色** | — | — | — | — | **`filter_window_apply` ×5** | **`dismiss_promo` ×5** | — |
| 收集阶段步数 | 1 | **5**（勾选/记录/翻页）| 1 | 1 | 1 | 1 | 1 |
| 总子目标 / 实际步数 / 跳过 / 重试 | 19/19/0/0 | 23/23/0/0 | 19/19/0/0 | 19/**30**/0/0 | **24**/24/0/0 | **24**/**20**/**4**/0 | 19/19/0/**5** |

四个站点共用同一份骨架形状；第五个（Voyagio）**改了形状**（`per_date` 上开了两个阶段），
指标就如实报出一个基准里没有的角色 ×5，而不是假装计划能一一对齐 —— 度量现在是**按角色对齐**的，
所以形状差异不会把后面的比较全部错位。

¹ 归一化掉的只有三类**槽位/名词**：日期与星期、站点自己的名字、上限的说法（"¥300以下" vs "¥300"）。
归一化后 18/18 相同，意思是**流程本身一字未改**：改的全是"点哪个元素、看哪个信号、地址怎么写"。

> 写这份报告时这个指标先给了我一个教训：我一开始把 FlyQuest 的描述也顺手改写了（"航班列表"→"航班结果"），
> 复用率立刻掉到 7/18。**描述写的是"这一步要达到什么"，怎么做到由 hints 说** —— 把措辞改回去之后，
> 四个站点 18 个共享角色的描述逐字复用，而"动作次数 18 → 29"这个真实差异由新增的 `actions` 指标如实报出来。

结论一句话：**流程（角色序列 + 描述模板）100% 复用；站点专有的三件套 100% 需要重写；
新站点的交互形状（先勾选再提交、分页）会额外长出子目标** —— 这就是"迁移"的真实成本结构。

## 4. 迁移测试抓到的问题（最有价值的部分）

### 4.-1 第四种布局：搜索是一个 `<form>`，一个 hint 表达不了

FlyQuest 的结果页**只能通过提交搜索表单到达**（填出发日期 → 选出发时段 → 点 Search）。
执行器原来的契约是"一个子目标一个 `target_hint`，且它在整个子目标内权威"，于是：
填完日期之后 hint 仍指向日期框 → 第二次点同一个元素是 inert → 元素被 forbid →
后续交给 laya 乱选 → 子目标必然卡住。这不是站点的问题，是**表达力**的问题。

修法（两处，都在执行器/计划层，站点侧只是配置）：
- `target_hints`：**有序** hint 序列，每个 hint 负责一次动作，动作执行成功（且非 inert）或该元素被
  forbid 之后自动推进到下一个；单个 `target_hint` 保留"整段子目标权威"的旧语义（既有计划全部依赖它）。
- 子目标级 `slots`：随子目标变化的值（要填进表单的日期）放进**子目标自己的数据袋**，
  按 `plan.slots < 子目标 slots` 合并 —— 值仍然只来自计划，不来自模型，也不靠描述文本夹带。

配置侧对应 `"hints": ["#date", "#window", "#search-btn"]` + `"slots": {"date": "{date}"}`。
实测：FlyQuest 19 个子目标跑了 **30 步**（其余站点 18 个共享角色只需 18 次动作），
全部 `rule:match`，判分 7/7 —— 多出来的 12 步就是 5 个日期的表单三连击与上限表单的两次动作。

`target_hints` 的反面证据也在测试里：`test_a_single_hint_still_owns_the_whole_subgoal` 钉住了旧语义
（同一个元素被连点两次），这正是表单站点跑不通的原因。

### 4.0 骨架形状也能配置了：第五个站点是"两页向导"

上一轮我在报告里承认：**"每步的内容是配置，骨架形状还不是"** —— 阶段顺序写死在加载器的展开函数里。
这一轮把它也搬进配置：spec 的 `phases` 从"固定四段的对象"变成**一条阶段列表**，
每段声明 `stage`（flight / hotel）、`repeat`（once / per_date / per_checkin）与 `steps`。

于是 Voyagio（复刻站 #5）的机票搜索是**两页向导**（第 1 页填日期 → 第 2 页选时段并搜索）：
只要在 `per_date` 上开两个阶段，加载器一行不改就展开了 21 个机票子目标。
指标如实报出代价：**多出一个基准里没有的角色 `filter_window_apply` ×5**，
共享角色需要的动作数 18 → 23，总子目标 19 → 24。

四个已有站点的 spec 迁到新写法后，展开出来的计划与迁移前**逐字段一致**
（`test_config_derived_plan_equals_the_handwritten_ctrip_plan_field_for_field` 仍然通过）。

### 4.1 重试：瞬时失败不该让整条计划停在那里

现实里最常见的失败不是"这一步做错了"，而是"这一次没成"：首次访问是冷的、页面还在水合、
网络抖了一下。原来的语义只有"成功"和"BLOCKED"，于是**一次坏运气就终止整条计划**。

现在子目标可以声明 `retries`：

```jsonc
{ "role": "record_lowest",
  "path": "summary.html",                       // 出票摘要页：标签页里首次访问是冷的
  "hint": "#record-fare",
  "retries": 1,                                 // 失败后整步重来一次
  "signal": {"css_text_contains": ["#log", "Recorded"]} }
```

重试是**整步重来**：重新导航、重新判定 `when`、重新扫描元素 —— 不是"在失败的那一步原地再点一次"。
所以它天然覆盖冷启动、水合竞态、以及"上一次动作把页面留在半路"的情况。次数由计划给定（有界），
耗尽之后才轮到 replan（如果接了 planner）。

复刻站 #7（SlowJet）把这件事做成确定性的：出票摘要页在标签页里**按日期**记住"预热过"，
所以每个日期的第一次访问都没有记录按钮（只显示 `Preparing fares…`），第二次才完整。

| 跑法 | 结果 |
|---|---|
| 默认（`retries: 1`） | **7/7**；五个日期的记录步骤各重试一次（日志里 5 条 `retry 1/1`），实际步数仍是 19 |
| 消融 `--no-retries` | **0/7**，卡在**第一个**冷摘要页：`low confidence 0.16 < floor 0.25 on step 1` |

原始日志：`results/ablation-noretries-slowjet/`。
注意 `retries` **不改变计划形状**（SlowJet 的指标与基准完全一致：18 个共享角色、无多出角色、
动作数 18），它是运行时策略 —— 度量报的是计划，跑分报的是过程。

### 4.2 条件子目标：遮罩只在部分页面出现（这一步要能"不执行"）

上一轮剩下的另一条边界是"子目标是直线，没有分支"。现实里最常撞上的分支不是逻辑判断，
而是**同一类元素时有时无**：同意/促销遮罩、公告条、"首单立减"弹窗。计划里写一个
无条件的"关掉遮罩"步骤，在没有遮罩的页面上就会**永远满足不了自己的信号**。

所以这一轮给子目标加了前置条件（spec 里的 `when`，计划里的 `when`）：

```jsonc
{ "role": "dismiss_promo",
  "desc": "如果 {date}（{wd}）的机票页弹出了促销遮罩，就先关掉它",
  "hint": "#promo-dismiss",
  "when":   {"css_exists": ["#promo-modal"]},                      // 前置条件
  "signal": {"css_text_contains": ["#promo-state", "dismissed"]} } // 完成信号
```

判定发生在**导航之后、动作之前**（只有那一刻才知道遮罩在不在）；不成立就整步子目标跳过：
不动作、不问模型、`status=skipped`（跳过=已完成，resume 不会重试）。

复刻站 #6（FareHaven）把它做成两个方向都必须对的样子：促销日期会弹出盖住整页的遮罩，
而且**同一标签页里处理过一次就不再出现** —— 于是三种状态文案互不可达：

| 页面状态 | `#promo-state` | 有 `when` | 没有 `when`（消融） |
|---|---|---|---|
| 促销日、本标签页没处理过 | `Promotion: active — dismiss to continue` | 执行：关掉遮罩 ✓ | 执行 ✓ |
| 促销日、已处理过 | `Promotion: already handled` | **跳过** ✓ | ✗ 信号永远不可能成立 |
| 非促销日 | `Promotion: none today` | **跳过** ✓ | ✗ 同上 |

实测（`--both` 六站点）：FareHaven **24 个子目标里 4 个被跳过**（06/07/08/09），
只跑了 20 步、全部 `rule:match`、判分 **7/7**。
消融 `--no-when`（把 `when` 去掉）**卡在第 6 个子目标**（第一个"没有遮罩的日期"）：
hint 落空 → 交给 laya → 它去点了导航里的 "Flights"（conf 0.53）→ 信号永不成立 →
`low confidence 0.11 < floor 0.20` → 判分 **1/7**。原始日志在
`results/ablation-nowhen-farehaven/`。

顺带一个实测细节：复刻站在 `file://` 下**用不了 cookie**（`document.cookie` 直接抛
SecurityError），所以"本标签页已处理"的标记挂在 `window.name` 上（实测跨导航存活）——
计划对此一无所知，它只关心 `when` 与 `signal`。

### 4.3 先关掉一个悬着的问题：滑块能用"填值"驱动

上一轮留了个尾巴：`<input type=range>` 没测过。实测（`locator.fill("300")`）**会设置 value 并触发
`input` 事件**，Trekly 的价格上限就是滑块，执行器走原来的填值路径一次命中（`#cap-state` 变成
`Max price: ¥300`、URL 带上 `cap=300`、结果从 32 家收到 12 家）。
**结论：不需要给执行器加"拖动"这种动作**，站点把迁移写进 `oninput` 即可；已加测试钉住。

迁移不是"跑通就完事"，它把执行器在**没见过的控件形状**上的缺陷逼出来了三个：

### 4.4 radio / checkbox 根本不在动作模型里（执行器缺陷）

执行器原本按标签分类动作："input / textarea / select 就填值，其它就点击"。于是
`<input type=radio id="cap-300">` 走填值分支 → `needs_value` → 元素被 forbid → 整个子目标报废。
**填值也不是修法**：Playwright 直接拒绝 `fill()` 一个 radio。

- 修法：`_is_checkable` / `_is_typing` 两个谓词统一分类三种动作（填值 / 点击 / 勾选点击），
  在预填守卫、动作探针、执行分支、prior-hit 描述四处统一使用；
- 单测钉住最阴的形态：`<input type=radio id="cap-300">` 配 `slots={"cap": "300"}` ——
  `_slot_value` 的子串匹配本来会把 "300" 交给一个 radio（那是个 Playwright 异常，连 needs_value 都不是）；
- 站点侧证据：SkyBook 的价格上限就是 radio，修好后该子目标一次点击命中（`conf=1.00`）。

### 4.5 `<select>` 的标签探测白吃 30 秒（性能缺陷）

`select_option(label=…)` 失败后回落到 `select_option(value=…)`，但 Playwright 默认 30 s 超时 ——
数据袋里装的是机器值（`0800-1800`），所以标签探测**注定失败**，每次都白等 30 s。
SkyBook 有 10 次下拉填充，实测约 **300 s** 纯超时；给探测加 `timeout=1500` 后约 **0 s**。
（携程复刻站的筛选是链接，从没触发过这条路径 —— 这也是为什么只有迁移测试能发现它。）

### 4.6 "先勾选、再提交"跨子目标会丢状态（流程/契约缺陷）

第一次跑 SkyBook 时，第 4 个子目标（记录已勾选酒店）**失败**，签名是：

```
step 1: click button "Record selected" (clicked, rule:match)
step 2: click button "Record selected" (clicked, rule:match, inert)   ← 同一按钮被再点一次
step 3: click a "Hotels" (clicked, laya, conf=0.55)                   ← 落到 laya 后开始乱走
...
-> BLOCKED: max_steps          — 判分 6/7
```

根因：`勾选` 与 `记录` 是两个子目标，而**每个子目标开头都会重新 `goto`** —— 勾选状态只在页面内存里，
新页面里没有任何勾选，记录按钮的处理器走 "No hotels selected" 分支，DOM 信号永远不触发。

这其实就是本仓库既有的那条规律（"筛选/排序状态必须写进 URL"）**推广到任意跨子目标的状态**：
一个子目标的 `start_url` 必须完整决定它需要的前置状态。修法仍然在**配置层**（执行器不动）：
勾选后跳一次 `…&selected=all`，记录子目标的 `start_url` 带上它；
测试里专门有一条 `test_selection_survives_a_reload_only_through_the_url` 复现这个坑。

> 顺带一条**没解决**的限制：如果"勾选 + 提交"能放进**一个**子目标会更自然，
> 但执行器"一个子目标只有一个 `target_hint`、且 hint 在子目标内是权威的"意味着同一个元素会被反复点，
> 第二次点击是 inert。这个限制在 ARCHITECTURE.md §7.3 里已有记录，本轮只是又撞了一次。

## 5. 边界与不足（诚实清单）

1. **迁移的是"同类列表页流程"**：入口 → 逐候选（筛选/排序/记录）→ 第二域（设上限/排序/收集）。
   换成多步向导、富文本编辑器、文件上传、验证码/登录墙，这份骨架不成立。
2. **判分仍要求站点有独立数据源**。复刻站满足；真实 OTA 那一侧仍被风控挡着（§1），
   所以"迁移到真实旅游网"目前只能证明到"驱动就绪"，不能证明"跑出真实报价"。
3. **选择/分页状态靠 URL 序列化**是这类站点的可行解；如果站点把状态锁在内存里（很多 SPA 如此），
   当前流程表达不了 —— 那时要么改站点、要么给执行器加"同一子目标多步动作"的表达力。
4. `<select>` 现在靠数据袋给机器值；若某站点的 `<option value>` 与计划已知的值不一致，需要换成标签
   （标签探测仍在，只是缩短了超时）。
5. 复刻站 #2 / #3 / #4 是英文界面，但计划描述仍是中文（描述只进审计与 laya，不进页面），
   页面语言与计划语言是解耦的 —— 这一点没有被"迁移"专门测过（CJK 之外的 checkpoint 方向由 bench 覆盖）。
6. **控件覆盖到"链接 / 按钮 / input / textarea / select / radio / checkbox / range"为止**：文件上传、富文本、
   原生 `<dialog>`、跨域 iframe 内的控件都还没在这条流程上验过。
7. **一个子目标里的动作是"直线"**：有序 hint 解决了"填表 → 提交"这类连续动作，但**没有分支/循环**——
   "如果出现弹窗就关掉，否则继续"这种条件动作仍然要拆成独立子目标（或由 replan 接手）。
   同理，`phases` 的顺序（入口 → 逐日期 → 酒店 → 收集）仍写在加载器的展开函数里：
   **每步的内容是配置，流程的骨架形状还不是**。多步向导、回退、并发搜索都还需要动加载器。

## 6. 复现

```bash
python3 transfer/transfer_task.py --both              # 五个站点端到端 + 迁移指标（约 12 分钟，CPU）
python3 transfer/transfer_task.py --metrics-only      # 只看指标，不开浏览器
python3 transfer/transfer_task.py --emit-plan skybook # 配置 → 冻结计划 JSON
python3 transfer/ota_probe.py                         # 候选真实站点的可达性实测
node --experimental-strip-types tools/transfer-parity.ts      # TS 侧逐例对拍（原 Python 套件见 BACKUP.md）         # 17 个离线测试
bash bench/smoke.sh                                   # 回归门（含本目录）
```
