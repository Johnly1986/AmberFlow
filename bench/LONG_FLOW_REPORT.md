# 长流程线上用例报告（`bench/cases-live-long.json`）

> **一句话**：把「一次完整的线上工作」做成可复现的用例——不是 8 个单点点击，而是 **3 条 9–15 个子目标、
> 跨页面、带会话状态**的完整旅程；每条完成信号都在真浏览器里手工核验过（动作前为假、动作后为真）。
>
> **实测（真模型，本机 CPU-only）**：`3/3` 用例、**`34/34` 子目标、43 步全部 `rule:match`（零模型选择）**、
> 102.6 s；独立核验脚本 `34/34 failures=0`；既有线上包回归 `8/8`、`11/11`。
> 本轮同时暴露并修掉 **4 个真实缺陷**（全部由长流程首次触达，全部钉了测试）。

复现：

```bash
node --experimental-strip-types src/bench.ts --cases bench/cases-live-long.json --mode-tag live-long
```

---

## 一、为什么需要「长流程」包

`bench/cases-live.json`（第 8 轮）是 **8 个 case / 11 个子目标**，每个 case 只有 1–2 个子目标：它证明的是
「单点动作在真实页面上能被规则/计划点名解决」。长流程要测的是短用例**在结构上测不到**的东西：

| 长流程才有的形状 | 短用例为什么测不到 |
|---|---|
| 跨子目标的**服务端会话状态**（购物车两件商品、登录态） | 每步重新 `goto`，只有真正服务端状态才能存活 |
| 一个子目标需要**多个动作**（填 3 个字段再提交；开菜单再点退出） | 短用例一个子目标 = 一次点击 |
| **只存在于 JS 里的状态**（排序顺序）且必须在同一个子目标内用完 | 排序不写进 URL，跨子目标必然丢 |
| **SPA 路由竞态**（点击返回后页面才重渲染） | 单点用例点完就结束，看不出「早看一眼」的代价 |
| **登录/登出 + 登录态下的后续页面** | 需要一条有序链路 |
| 失败后的**重试/兜底路径**（`retries`、`hintLookup` 兜底回捞） | 单点用例几乎不会走到 |
| 一条旅程的**收尾不变量**（下单后购物车清空；19 条结果的分类页没有分页器） | 没有「前因」可断言 |

## 二、三个用例

| case | 站点 | 子目标 | 形状覆盖 | 状态依赖 |
|---|---|---|---|---|
| `live-long-saucedemo-checkout` | www.saucedemo.com（公开演示电商） | **15** | 登录表单 / 列表 / 详情 / 购物车 / 结算两步 / 完成页 / 汉堡菜单登出 | 强（服务端购物车 + 登录态跨全部子目标） |
| `live-long-books` | books.toscrape.com | **10** | 首页侧栏 / 分类列表 / 分页列表 / 商品详情 / 面包屑 | 无（全站无 cookie），但每步 URL 可寻址 |
| `live-long-quotes` | quotes.toscrape.com | **9** | 首页标签云 / 标签页 / 分页 / 作者页 / 登录表单 / JS 渲染页 / 登出 | 中（session 登录态） |

设计原则（沿用仓库既有结论，不新发明）：

- **值只来自 `slots`**（用户名、密码、收货信息、排序键）；`desc`/`goal` 里不夹带要被执行器"猜"的值。
- **能写进 URL 的状态写进 URL**：books 的每一步（分类/分页/详情）都是可寻址的，所以「一个子目标 = 一次点击 = 一个确定状态」。
- **不能写进 URL 的状态就近用完**：saucedemo 的排序只在 JS 里，于是「排序 + 加最便宜的那件」是**一个**子目标，
  用 `target_hints` 走两次动作（实测 `select[data-test=product-sort-container]` → `button[data-test=add-to-cart-sauce-labs-onesie]`）。
- **信号写在效果上**：登录不读输入框 value（`fill` 只能证明"填了"），而读登录后才会出现的 `[data-test=inventory-item]` /
  `a[href='/logout']`；quotes 的结算前登录同理。
- **组合信号是加分辨力，不是放宽**：`all_of` 用来同时钉住 URL 与页面事实（价格/库存/结果数），
  `not` 用来表达"消失"（下单后购物车徽标不存在、19 条结果的 Poetry 分类没有分页器）。
- **`when` 只用于真条件**：books 的三个"从详情页走面包屑回去"步骤带 `when: {css_exists: "#product_description"}`，
  不是详情页就跳过而不是失败。

## 三、逐子目标证据（Lead 独立核验，非子任务自述）

核验脚本一次跑完三条链路（同一个 browser context、同一个 page），对每个子目标：

1. `goto(start_url)` → 断言信号 **为假**（这是"有区分度"的定义）；
2. 用**仓库自己的** `hintMatch` / `hintLookup` 解析 hint（与执行器同一条链路：主池 → 兜底回捞 → 再匹配）；
3. 用解析出的元素执行该步动作（输入框 `fill`，其余 `click`）；
4. 断言信号 **为真**。

| case | # | 结论 | 信号 | 动作（按解析出的 hint） |
|---|---|---|---|---|
| saucedemo | 0 | OK | before=false / after=true | fill(#user-name) → fill(#password) → click(#login-button) |
| saucedemo | 1 | OK | before=false / after=true | fill(select[data-test=product-sort-container]) → click(button[data-test=add-to-cart-sauce-labs-onesie]) |
| saucedemo | 2 | OK | before=false / after=true | click(button[data-test=add-to-cart-sauce-labs-bike-light]) |
| saucedemo | 3 | OK | before=false / after=true | click(a[data-test=item-2-title-link]) |
| saucedemo | 4 | OK | before=false / after=true | click(button[data-test=back-to-products]) |
| saucedemo | 5 | OK | before=false / after=true | click(a[data-test=shopping-cart-link]) |
| saucedemo | 6 | OK | before=false / after=true | click(button[data-test=remove-sauce-labs-bike-light]) |
| saucedemo | 7 | OK | before=false / after=true | click(button[data-test=continue-shopping]) |
| saucedemo | 8 | OK | before=false / after=true | click(button[data-test=add-to-cart-sauce-labs-bike-light]) |
| saucedemo | 9 | OK | before=false / after=true | click(a[data-test=shopping-cart-link]) |
| saucedemo | 10 | OK | before=false / after=true | click(button[data-test=checkout]) |
| saucedemo | 11 | OK | before=false / after=true | fill(#first-name) → fill(#last-name) → fill(#postal-code) → click(input[data-test=continue]) |
| saucedemo | 12 | OK | before=false / after=true | click(button[data-test=finish]) |
| saucedemo | 13 | OK | before=false / after=true | click(button[data-test=back-to-products]) |
| saucedemo | 14 | OK | before=false / after=true | click(#react-burger-menu-btn) → click([data-test=logout-sidebar-link]) |
| books | 0 | OK | before=false / after=true | click(a[href~travel_2]) ※兜底 |
| books | 1 | OK | before=false / after=true | click(It's Only the Himalayas) |
| books | 2 | OK | before=false / after=true | click(a[href~travel_2]) |
| books | 3 | OK | before=false / after=true | click(a[href~books_1]) |
| books | 4 | OK | before=false / after=true | click(a[href~page-2]) ※兜底 |
| books | 5 | OK | before=false / after=true | click(In a Dark, Dark Wood) |
| books | 6 | OK | before=false / after=true | click(a[href~books_1]) |
| books | 7 | OK | before=false / after=true | click(a[href~poetry_23]) ※兜底 |
| books | 8 | OK | before=false / after=true | click(A Light in the Attic) |
| books | 9 | OK | before=false / after=true | click(a[href~poetry_23]) |
| quotes | 0 | OK | before=false / after=true | click(a[href~tag/love]) ※兜底 |
| quotes | 1 | OK | before=false / after=true | click(Next) ※兜底 |
| quotes | 2 | OK | before=false / after=true | click(a[href~author/C-S-Lewis]) |
| quotes | 3 | OK | before=false / after=true | click(a[href~login]) |
| quotes | 4 | OK | before=false / after=true | fill(#username) → fill(#password) → click(input[type=submit]) |
| quotes | 5 | OK | before=false / after=true | click(a[href~tag/inspirational]) ※兜底 |
| quotes | 6 | OK | before=false / after=true | click(Next) ※兜底 |
| quotes | 7 | OK | before=false / after=true | click(Next) |
| quotes | 8 | OK | before=false / after=true | click(Logout) |

`※兜底` = 该目标被 40 元素预算挤出主池，靠 `hintLookup()` 在 DOM 里重新盖章回捞（**7/34**）。这正是
「计划点名的目标不能被预算吃掉」那条规则的线上实证；也说明**只拿主池校验 hint 会得出"无效"的错误结论**。

## 四、长流程暴露的四个真实缺陷（全部已修 + 已钉测试）

| # | 现象（线上实测） | 修法 | 测试 |
|---|---|---|---|
| 1 | **元素池看不见「标题链接」**：saucedemo 六个商品标题是 `<a data-test=item-2-title-link><div>标题</div></a>`（inline anchor 包 block）。`hasBox` 只看 `getClientRects()[0]`，而 inline anchor 的第一个 rect 是 0×0、真正的 block box 在后面 → **6 个标题链接全被丢掉（池 25/31）**，人点的那一个模型看不见 | 任意一个非零 rect 即算可见（全 0 rect 仍然丢弃，zh.wikipedia 折叠侧栏 349 个链接的规则不变） | `tests/extraction.test.ts`「keeps an inline anchor that WRAPS A BLOCK」 |
| 2 | **有序 `target_hints` 前进但不重新解析**：汉堡菜单点击是纯 CSS 变化 → 被判定 `inert` → 该 hint 元素进 forbidden；代码前进了 `_hintI` 却仍用旧 `curHint`，于是**下一个动作直接丢给模型**，规则模式下整步子目标阻塞 | 前进后**在同一步内重新解析**下一个 hint（含兜底回捞与 forbidden 剪枝） | `tests/executor.test.ts` ⑤b |
| 3 | **慢但没被遮挡的元素被"永久拉黑"**：侧栏需要约 0.5–1.5 s 才能被 Playwright 提交点击，0.8 s 的可操作性探针超时 → 返回 `action-timeout` → **该元素在本子目标内被禁用**（注释写的是"让下一步重试"，代码却在拉黑） | `occludedReason` 在"命中测试干净"的分支上再给一次更长预算（2.5 s）才报 `action-timeout` | `tests/executor.test.ts` ⑩b |
| 4 | **SPA 路由竞态**：客户端路由**先改 URL、后重渲染**，动作后的单次信号检查会看到旧页面。实测 `Back to products` 的信号在点击后 **30–230 ms** 才为真，约 **1/4** 的检查看早了 → 下一步的目标已被上一步删掉 → 丢给模型/阻塞 | 动作执行后给信号一个有界结算窗口（4 × 0.12 s，最多 0.48 s）；**不**以 `inert` 为条件（异步生效的点击当时看也是 inert） | `tests/executor.test.ts` ⑤c |

抖动量化（saucedemo 单用例、脚本模型、同一台机器）：

| 阶段 | 次数 | 结果 |
|---|---|---|
| 四个修复前 | 15 | **7 次失败**（同一个子目标模式：`返回商品列表…购物车里的两件仍在` / `退出登录`） |
| 四个修复后 | 8 | **8/8 全绿**（15/15、22 步、~9 s） |

四个缺陷都不是"用例写错了"：它们只在**多动作子目标 + 客户端渲染 + 真实动效**的组合下出现，
前 8 个单点线上用例在结构上碰不到。

## 五、实测数字

**真模型（本机 CPU-only，ONNX `english` checkpoint）**

| 用例 | 子目标 | 步数 | 重试 | 耗时 | 决策来源 |
|---|---|---|---|---|---|
| live-long-saucedemo-checkout | 15/15 | 22 | 0 | 55.5 s | 22/22 `rule:match` |
| live-long-books | 10/10 | 10 | 0 | 23.1 s | 10/10 `rule:match` |
| live-long-quotes | 9/9 | 11 | 0 | 24.0 s | 11/11 `rule:match` |
| **合计** | **34/34** | **43** | **0** | **102.6 s** | **43/43 `rule:match`，零模型选择** |

一次 RISKY 记录（quotes 的 `inspirational` 标签链接，风险头 0.79）——风险门只询问不阻断，与既有结论一致。

**消融：去掉模型（脚本化 abstain 模型，只答 `noul`）**：同样 `34/34`、59.7 s → 说明这 34 个子目标
**完全由计划/hint/规则决定**，模型只被问「危不危险」。

**回归：既有线上包**（`bench/cases-live.json`，真模型）：`8/8` 用例、`11/11` 子目标、97.6 s，
每一步仍然 `rule:match` → 本轮 4 个执行器/提取改动**没有破坏第 8 轮的线上结论**。

## 六、诚实边界

1. **这个包测的是"计划 + 执行器"，不是 laya 的零样本能力**：34 个子目标的 hint 全部命中（含 7 个走兜底回捞），
   模型只在风险判定上被调用。要压模型，配 `--force-hints off` 剥掉手写 hint 再跑（既有结论：线上包 8/8 → 3/8）。
2. **值输入只覆盖了一半**：saucedemo（登录 + 收货信息 4 字段）与 quotes（登录 2 字段）覆盖 `fill`/`select`；
   books.toscrape 全站 0 个 `input/select/textarea`（唯一的 "Add to basket" 按钮点了既不导航也不改 DOM），
   所以那条链路是纯导航，**测不到 fill-then-submit 类**。
3. **信号含站点字面量**：价格（`£45.17`）、结果数（`1000 results`）、评分 class（`star-rating.Three`）、
   商品 id（`_963`）都来自站点当前版本。站点改版必须重新核验——这正是"信号是冻结产物"的代价。
4. **三个站点都是公开演示站**，不是生产业务系统：无用例凭据、无支付（结算页是假结算）。
5. **不进 CI**：外部站点慢且会波动（第 8 轮定下的规则），所以 `bench/smoke.sh` 与
   `.github/workflows/checks.yml` 保持不变；本包是手动/夜跑用例。
6. **`retries: 2` 是防御性配置**：本轮真模型 0 次重试；它的价值在于首屏冷加载/站点抖动时不让整条旅程崩掉。
7. **`PlanningRules` 默认 8 个子目标**：bench 不校验，所以 15 子目标的 case 能跑；走 `plan-cli check` /
   `npm start` 的入口需要显式放宽上限。

## 七、复现

```bash
# 长流程包（真模型；外部站点，约 100 s）
node --experimental-strip-types src/bench.ts --cases bench/cases-live-long.json --mode-tag live-long

# 单用例
node --experimental-strip-types src/bench.ts --cases bench/cases-live-long.json --only live-long-books --mode-tag live-books

# 只看规则/hint 层（脚本化 abstain 模型，不加载 1.7GB checkpoint）
#   结果落在 bench/results/<mode-tag>-<stamp>.json，detail[].results[].steps[].method 就是每步的决策来源

# 消融：剥掉手写 hint（模型被迫出手）
node --experimental-strip-types src/bench.ts --cases bench/cases-live-long.json --mode-tag live-long-nohints --force-hints off

# 回归：既有线上包
node --experimental-strip-types src/bench.ts --cases bench/cases-live.json --mode-tag live
```

结果文件里每个子目标都有 `steps[]`（`step/how/method/conf/inert/url/executed`），
`attempts` 记录重试次数——报告里的每个数字都能从 `bench/results/live-long-*.json` 复算。
