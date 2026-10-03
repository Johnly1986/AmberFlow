# LayaWebUse 优化报告：LLM 编排固化流程 × Laya 精确执行

> 目标：**大模型负责编排、固化流程；Laya 负责按固化流程准确执行。**
> 方法：在多个平台（4 个本地 fixture 站点 + 1 个真实线上站）上建立自动化回归基准，反复测试 → 定位失败 → 修改执行器/契约 → 回测，直到达标。
> 环境：Linux / CPU-only（无 GPU），laya 0.3.5 english checkpoint，Playwright chromium-1234。
> 日期：2026-09-30。全部原始结果在 `bench/results/*.json`（34 次运行）。

## 一、最终成绩

| 配置 | cases | subgoals | 用时 |
|---|---|---|---|
| baseline-en（移植后首次跑分） | **0/5** | 1/15 | 302 s |
| best-en（english ckpt + 规则 + hints） | **5/5** | **15/15** | 52 s |
| best-ml（--force-model multilingual） | 4/5 | 14/15 | 34 s |
| best-en-norules（--force-rules off，纯 laya zero-shot） | 0/5 | 3/15 | 860 s 超时 |

原仓库三个 demo（browser_agent / long_task / camera_entry）在全部改动后回归通过，行为与作者 GPU 环境一致。

迭代曲线（subgoals_passed）：1 → 4 → 7 → 13 → 14 → **15**。

## 二、测试台设计（bench/）

- **cases.json** = 固化流程本身：`goal + ordered subgoals{desc, signal, start_url, target_hint} + slots 数据袋`。执行器永不重新规划、永不生成值——这正是被测契约。
- **run_bench.py** = 冻结计划重放器：一个浏览器一个页面跑完整个 case（会话/JS 状态跨子目标保留），逐子目标断言 DOM done-signal。
- **消融开关**：`--force-model english|multilingual`、`--force-rules on|off`（关掉规则前置 = 纯 laya zero-shot 执行）。
- 平台谱系：英文商店（fixture）、中文设备登记（fixture，CJK label）、中文论坛发帖（fixture，label 包裹式表单）、英文社交登录+发布（fixture，两步会话链）、**quotes.toscrape.com（真实线上站，含 CSRF 隐藏域、type=submit input、品牌链接干扰项）**。

## 三、失败模式清单与修复（按发现顺序，全部有 trace 证据）

### A. 执行器层（代码 bug）

1. **空 label 表单字段**：`extract_elements` 不读 `<label>` 包裹文本 → CJK 表单字段 label 为空 → slot 匹配全失败、laya 看到 `input ""`。→ 加 wrapper-label 提取（并剔除字段自身 value，防 "Username Password" 污染）。
2. **needs_value 烧步**：`_execute_element` 对 select 直接放弃、对无值 input 返回 needs_value 但不 forbid → 循环空转。→ select 支持填充；needs_value/stale_ref 立即 forbid 且不消耗模型调用。
3. **置信度来源错误**：`predict_shortlist` passthrough（labels ≤ k）时 `probabilities` 是子集归一化值，不是校准置信度——实测把 0.13 的错选放大成 0.76 骗过 floor。→ passthrough 用 `answers.confidence`，真 shortlist 用 top-p。
4. **inert 死循环**：点 Sign in 但密码未填 → HTML5 校验静默拒绝 → 页面无变化 → 规则再点同一元素 ×8。→ 动作前后快照（url+text+全部 input values）判 inert，inert 即 forbid。
5. **submit-type input 被当填充目标**：`<input type=submit value=Login>` 走 fill 分支返回 needs_value，永远点不到。→ `_is_submit` 识别 + `_click_only`。
6. **prefill guard 覆盖不全**：guard 只在非输入元素点击前触发，hint 命中 submit input 时跳过 → 空表单提交"成功跳转"到 goodreads（假阴性完成信号差点放行）。→ guard 条件扩为「任何 click 之前」；且 composer 类非 required 空字段也纳入（Publish 空 textarea 教训）。
7. **TaskPlan 丢字段**：构造函数白名单过滤掉 `target_hint`，hints 在磁盘往返后蒸发 → bench 里 hint 全线失效而单测正常（排查代价最大的一条）。→ 契约字段显式保留。

### B. 规则层（literal mapping）

8. **角色词歧义**："click the Login button" 同时命中 nav link 和 submit input（label 都是 Login）→ 规则弃权交给 laya → laya 选了 logo。→ ROLE_TOKENS/FILLER_TOKENS 剥离 + 「指令点名 widget 角色时按 tag 收窄」（button/link 歧义消解）。
9. **CJK 无 token 边界**：英文 `[a-z0-9]` 正则对中文整句只出一个 token。→ CJK 走「label 作为指令中独立词」匹配（"填写 标题 输入框" ↔ label "标题"）。
10. **label 前缀匹配过宽**："submit" 前缀命中按钮 label "提交登记"。→ data-test 保持前缀匹配（字面 id），label 改为全词相等匹配。

### C. 契约层（本轮最重要的架构结论）

11. **zero-shot laya 无法在歧义页面上稳定选对元素**。quotes.toscrape.com 实测：正确目标（submit input）概率 0.04，品牌 logo 0.59 ——措辞怎么改都不动（CLAUDE.md 早有同型记录，本仓库再次复现）。**这不是靠调阈值能修的，能力缺口在基座。**
12. **解法 = 把消歧信息放进固化流程**：给每个子目标加 `target_hint`（一行 CSS/token：`input[type=submit]`、`button[data-test=add-to-cart]`）。这是 LLM 编排层的天然产物——它看得见 DOM 快照、负责写可验证计划；laya 继续负责没有 hint 的一切语义选择。加了 2 个 hint 后 15/15。
13. **done-signal 必须写在线索最稳的标记上**：`.flash-success` 只在重定向瞬间存在，登录后持久标记是 header 里的 logout 链接。signal 写错 = 执行对了也判 FAIL（fix15–17 三轮才定位到是用例问题而非代码问题——测试台的评分器同样需要审计）。

## 四、消融矩阵结论

| 维度 | 结论 |
|---|---|
| rules off（纯 laya） | 3/15 且超时：**当前基座的 zero-shot 元素选择不具备生产可用性**，规则/hint 前置是必需品不是优化项 |
| english vs multilingual | 总体 english 5/5 > ml 4/5；但 **CJK 页面反向**：ml 在中文登记页 hint-free 全对（conf 0.36–0.65），english 只有 0.02–0.22。语言路由（laya.Router）应接管 checkpoint 选择 |
| 速度 | 规则/hint 命中路径零模型调用：best-en 52 s < baseline 302 s（CPU 上每次 laya 前向 ~1 s，省一次是一次） |

## 五、沉淀到主库的可复用改动

以下已进入 `browser_agent.py` / `task_planner.py`（原 demo 回归全绿）：
- label 提取增强（wrapper label + value 去污 + name/id/input_type 字段）
- `_locator_for`（data-test→id→name→type→positional 的稳定元素句柄链）
- `_slot_value`（exact→substring 双向匹配，大小写无关）
- `_is_submit` / `_click_only`（submit-input 语义）
- `snapshot()`（url+text+values 的动作效果观测）
- pick_element 置信度修正（passthrough 陷阱）
- 规则层：ROLE/FILLER tokens、tag 收窄、CJK 词匹配、label 全词匹配
- TaskPlan 保留 `target_hint`

## 六、aria criteria view 落地记录（第 2 轮，调研项①）

按调研报告建议实施"criteria 改由 aria 裁剪行构建"，实测数据推翻了调研时的预期，最终形态是**混合视图**而非替换：

- **双轨制已落地**：`aria_interactive_lines()` + `criteria_view()`（browser_agent.py），ref↔aria-line 索引对齐（5 个 fixture + 2 个实站页 1:1 计数吻合），漂移时逐元素回退旧渲染。执行句柄表（data-test/id/type）不动。
- **纯 aria 视图被证伪**：testpages/product.html "add to cart" 三向 A/B——旧渲染正确按钮 0.49/logo 0.20；**纯 aria role+name：logo 0.59 反超正确 0.07（选错）**；混合（aria role + 我们的 label + attrs 后缀）：正确 0.59。`[test=…] -> href` 后缀是承重信号，不能从模型视野里删。
- **token 收益为负**（+6%）：aria 角色名比 tag 长（textbox vs input）。真正的收益在别处：select 获得字段身份名（`select "分辨率" [now=请选择]`）、number input 变 spinbutton、空 label 由 wrapper 补全、突破 MAX_ELEMENTS=30 截断（quotes 首页 ours=30触顶 / aria=55 行，k=8 shortlist 的候选池变大且排序更准）。
- **回归**：bench 5/5、15/15（42.6s，历史最快）；long_task/browser_agent/camera_entry 三个原 demo 全绿；37 单测通过。shop coupon 子目标暴露 laya 对 "Cart" 链接的系统性偏好后，按契约补了第 3 个 target_hint（`input[data-test=coupon]`）。

## 七、CDP 事件监听器探测落地记录（第 3 轮，调研项②）

- **动机实证**：合成 SPA 页 `<div id=save-div>Save</div>` + addEventListener —— INTERACTIVE 选择器 0 命中，CDP `DOMDebugger.getEventListeners` 找到 `['click']`。端到端打通后 laya 以 conf=1.0 选中该 div 并真实触发 handler（title→SAVED）。
- **设计要点**（browser_agent.py `js_interactive_widgets()`）：
  - 候选过滤：非原生 tag + 无 onclick/role/data-test/href 才查监听器；每节点 resolve+query ≈4ms，quotes 首页全树 walk 0.28s（61 候选），实测增量成本可忽略（live 首页 probe 0.31s vs 原生 scan 1.66s）。
  - **walk 中直接盖 `data-js-ref` 章**，盖章元素经 `INTERACTIVE_ALL` 汇入正常 extract_elements 扫描——ref/索引/aria 对齐保持单一来源，无二次匹配脆弱性；执行器 `_locator_for` 加 js_ref 首选分支。
  - 空文本盒子丢弃（防噪音）；per-URL 缓存；任何 CDP 异常静默降级为原行为。
- **aria 对齐的已知代价**：JS-only widget 在 a11y 树里是 `text:` 行（无 role），交互行数与 ours 不再相等 → criteria_view 按既有设计逐元素回退旧渲染（不猜不错位）。
- **回归**：bench 5/5、15/15 @43.5s（与上轮持平，零退化）；37 单测、browser_agent/long_task/camera_entry 三 demo 全绿。

## 八、遮挡探测与 stale-ref 修复（第 3 轮，调研项③）

- **actionability 探针**（`BrowserMiddleware.occluded_reason`）：点击前先让 Playwright 真点一次（800ms 短超时）——自由元素 0.1s 内完成点击并返回 `__clicked__`（探针即执行，零浪费）；被覆盖的 0.8s 报 `not-actionable-or-covered:<覆盖物>`，替代旧路径 5s 超时 + inert 步 + snapshot 对的三重浪费。探针失败一律放行，post-action inert 检查仍是兜底。
- **新 fixture `spa_overlay.html`**（cookie 横幅盖住支付按钮 + JS-only Accept）一次暴露了**架构级缺陷**：ref 是位置索引，每次 extract 重编号；DOM 一变（Accept 随横幅消失），forbidden 里的 "e0" 指向了全新元素——**毒化健康元素导致 action space 误判耗尽**。
  - 修复：forbidden 改为 `{ref: esig(tag,label,data_test)}`，每步开头剪掉签名不再匹配的条目；遮挡 skip 的 ref 在"本子目标后续有成功动作"后一次性重新准入（`blocked_retry`/`re_admitted`）。
  - 同步上提到生产路径 `BrowserMiddleware.run`（调研遗留项④"修复上提"就此完成第一批）。
- **回归**：bench 扩至 6 cases 后 **6/6、17/17 @51.4s**；browser_agent/long_task/camera_entry 三 demo 全绿；37 单测通过。overlay case 全链路：step1 规则命中 Pay-now → 探针报被 `div#cookie` 覆盖 → laya 恢复性点 Accept（conf=1.0）→ e1 重新准入 → 规则命中 → ORDERED。

## 九、重复标签消歧 + 第 7 平台（第 4 轮，调研项④铺垫）

- **零信息候选实证**：商品网格类页面（saucedemo/books 沙盒）有 6+ 个 label 完全相同的 "Add to cart" 按钮——laya 对六个同名候选实测就是掷硬币（top1 0.26 vs top2 0.25，conf 0.046）。区分信息在**容器身份行**（商品名），此前从未进入模型视野。
- **near-context 机制**（`add_near_context`）：仅当 (tag,label) 碰撞时一次批量 JS 走查，取"最近小容器（≤2 按钮）的首条字母文本行"。三个实测坑：价格行噪音须过滤；name-link 会把 button 文本当身份（要排除**整组碰撞 label**，不是仅 own 文本）；saucedemo 网格实测 18/18 dup 元素全部取到正确商品名。
- **三处消费**：criteria 碰撞串追加 `[near=…]`；affordance 规则对歧义 hits 做 near-唯一 token 收窄；固化流程新增 hint 语法 `button[near~onesie]`（planner 显式消歧，零模型调用）。
- **诚实边界**：saucedemo 的 data-test 本身已含商品名（`add-to-cart-sauce-labs-onesie`），attr 通道独立可解——near 的不可替代场景是 data-test 缺失/重复的网格（books 型）；而 books 类目页暴露了 **MAX_ELEMENTS=30 预算被侧栏链接吃光**、按钮根本没进候选的问题，留给下轮（cap 之后接 shortlist 全池或分层预算）。
- **第 7 平台 live:saucedemo.com（React SPA，网络慢需 networkidle）**：固化流程 4 子目标（用户名→登录→加购 Onesie→开购物车断言商品名）**一次全绿**。两条设计教训：纯验证子目标没有可执行动作，必须折叠进前一子目标的 signal；购物车链接的 aria 名 "Cart, 1 items" 随状态变化，不能用作 start 依据。
- **回归**：bench **7/7、21/21 @62.2s**；Path A 3/3；browser_agent/long_task/camera_entry + 37 单测全绿。

## 十、候选池分层 + hint 回捞 + 第 8 平台（第 5 轮）

- **暴露 bug（books.toscrape 旅行分类页）**：87 个交互元素里 DOM 序靠前的 header+侧栏吃光 `MAX_ELEMENTS=30`，**11 个 "Add to basket" 按钮 0 个入池**——laya 面对的不是选错，是根本没得选。任何静态 fixture 都测不出这种预算偏置，只有真长页面线上站能暴露。
- **修复 1 · 主内容优先分层**：单次批量 JS 元数据 pass（`_candidate_meta`：visibility + 是否位于 `main/article` 且不在 `nav/aside/footer/header`）→ 提取顺序 = 主内容 → 其余 chrome，预算 30→40。books 旅行页 11/11 按钮入池，near 走查按"碰撞 label 计数"停在卡片容器，全部拿到正确书名（第 4 轮的 `>2 buttons` 截断规则被 books 的 1-button-6-links 卡片骗过，已改）。
- **修复 2 · href 保留两段**：`travel_2/index.html` 此前只存 basename，导航规则/hint 的 token 全站失效——改为保留末两段。
- **修复 3 · hint 回捞（`hint_lookup`）**：固化流程点名的元素（target_hint）若被预算挤出，按 hint 语法反查 DOM 拉回池内（ref `x{i}`，与正常提取共用 scan 索引，forbidden/inert/_locator_for 全链路无感）。原则：**预算是模型视野的优化，永远不能吃掉计划已声明的目标**。
- **尝试后回滚**：dup-label 配额（QUOTA=3）——首页 40 预算实际被 20 行商品的 unique 标题链吃光，配额不解决问题反伤 near 消歧，撤销；hint 回捞才是对的机制。
- **第 8 平台 live:books.toscrape.com**：2 子目标（开分类页 → 网格内加购指定书），hint 分别用 `a[href~travel_2]` 与 `button[near~railway]`，全绿。
- **回归**：bench **8/8、23/23 @76.9s**；Path A 3/3；三原 demo + 37 单测全绿。

## 十一、下一步（第 6 轮起）

1. 接入 `laya.Router(max_loaded=2, preload=True)` 做语言路由，替换 camera_entry 的表格列回落。
2. 用真 LLM planner（OPENAI_* env）自动生成带 hint 的计划，验证"编排→固化→执行"全自动闭环；MockAuditor 换 LLMAuditor 审 trace。
3. 扩充平台谱系：多标签页/iframe/分页长列表；引入 RLCD 微调（_laya_finetune_ref.ipynb 配方）攻 hint-free 的语义选择上限。
4. 把 inert/prefill/hint 逻辑从 BenchMiddleware 上提回 BrowserMiddleware，让生产路径享受同批修复。

---

## 十二、第 6 轮：健壮性回灌生产路径 + laya.Router 落地（本次）

> 触发：项目探索发现**生产路径与 bench 路径已经分叉** —— 第 3–5 轮的执行器加固（inert 检测、submit 语义、遮挡探针、点击前预填、遮挡重准入、hint 回捞）只活在 `BenchMiddleware` 里，生产 `BrowserMiddleware.run()` 从不调用（`snapshot`/`_is_submit`/`occluded_reason` 在 browser_agent.py 里是死代码）。

### A. 单一执行器（回灌）

- `BenchMiddleware` 的 `run()` / `_affordance_rule` / `_hint_match` / `_missing_required` 全部上提到 `BrowserMiddleware`；bench 侧只剩「选 checkpoint + 拨开关」（454 → 160 行），并有单测钉住「`BenchMiddleware.run is BrowserMiddleware.run`」。
- `run()` 新签名：`run(instruction, start_url, goal_signal_fn, page, slots, target_hint, pw, verbose)`。`pw` 允许复用调用方的 playwright 实例（bench 一个 case 一个浏览器）；`target_hint` 让生产路径享受固化流程消歧。
- `task_planner.run_plan` 把 `sg["target_hint"]` 传进 `run()`；`plan_cli add/edit --hint` 可编写、`show` 会显示 hint（`TaskPlan.insert/update` 同步保留字段）。
- laya 的 done-noul 现在**只在没有 DOM 信号时**才调用（有信号时它的裁决本来就被忽略，白付一次前向）。

### B. 回灌过程中发现的真实 bug（bench 结构上测不到）

| bug | 根因 | 修复 |
|---|---|---|
| **生产路径每个子目标都 BLOCKED**：`'PlaywrightContextManager' object has no attribute 'stop'` | 上提的收尾代码 `cm.stop()` 抄自 bench，而 bench **永远注入 `pw`**（`cm` 恒为 None，该行从未执行） | 用 `ExitStack` 管理自有连接：`stack.enter_context(sync_playwright())` / `stack.close()`；注入 `pw` 时栈为空、绝不动调用方的连接。回归测试用「没有 `stop()` 的假 CM」复现并证明旧代码会失败 |
| `PlanningRules` 拒绝 bench 的标量 signal（`url_contains: "x"` → `needs 1 argument(s)`），**校验比执行器更严** | 校验直接 `len(args)`，而 `check_signal/_arg` 接受标量或单元素列表（`bench/cases.json` 全是标量，`plan_cli` 产生列表） | 新增 `signal_args()` 归一化：校验与执行器同构，且不再对非序列值 `len()`（`{"css_value_equals": ["#qty", 3]}` 此前会 TypeError） |
| `plan_cli show` 不显示 `target_hint`，人工审计看不见计划点名的目标 | —— | show 增加 `target_hint=` 字段 |

### C. 新增中间件离线测试（此前的空白）

`test_middleware.py`：24 个用例，不加载模型/浏览器，逐条 pin 住实测规则 —— target_hint 语法（精确属性 / 属性子串 / near 消歧 / 角色收窄）、label 全词匹配 vs data-test 前缀匹配、CJK 词边界、`_nav_rule` 的导航动词闸门、`esig` 位置无关身份、submit 语义、slot 匹配、plan 往返保留 hint、`PlanningRules` 信号形状，以及 **playwright 生命周期（自有连接必须关闭 / 注入的连接不得触碰）**。测试总数 37 → 61。

### D. camera_entry 接入 laya.Router（删掉表格回落）

- 删除 `SHEET_TYPE_TO_FORM`、`ROUTE_CONF_FLOOR` 及整个 fallback 分支；`device_type` 只剩日志输出。
- `router = laya.Router(max_loaded=1)`（**不 preload**：本机 ~2 GB 可用内存，两个 checkpoint 常驻会 OOM），`router.predict(state, ROUTE_QUESTIONS)` 返回 `routing`（model + reason）并打进每行日志。
- **路由状态用整行原始记录**，实测对比（4 行，correct = a,b,b,a）：

| 变体 | r0 | r1 | r2 | r3 | 正确 |
|---|---|---|---|---|---|
| **A 整行（采用）** | en `form_a` .090 | **ml** `form_b` .916 | en `form_b` .030 | en `form_a` .081 | **4/4** |
| B 仅自然语言字段（丢掉 serial/model/ip…） | ml `form_b` .046 ✗ | ml `form_b` .081 | ml `form_b` .009 | ml `form_b` .129 ✗ | 2/4 |
| B2 = B + device_type 标签 | ml `form_a` .975 | ml `form_a` .030 ✗ | ml `form_b` .005 | ml `form_a` .991 | 3/4 |
| 全行强制 multilingual（oracle 反证） | ml `form_b` .000 ✗ | ml `form_b` .830 | ml `form_b` .630 | ml `form_b` .000 ✗ | 2/4 |

  结论：把 CAM/PTZ 序列号前缀当「代码」丢掉，会同时丢掉题目 criteria 自己点名的判别信号；整行路由是唯一 4/4 的变体。**行 0/2/3 的置信度仍然很低（0.03–0.09）**，因为 ASCII 编码字符占多数（non_latin 0.33–0.40），但 argmax 全对 —— 这是「脚本检测驱动路由」的诚实代价，不是调阈值能修的。
- 额外加固：`Router.load` 先建新 Agent 再驱逐 LRU，切语言时会短暂双驻留（本机唯一的 OOM 窗口）→ 预测前先用 `router.route()` 预判，命中不同 checkpoint 就先 `router.unload()`（`route()` 无前向、微秒级，重复调用免费，且保留 predict 自己产出的 reason）。

### E. 回归证据（本次全部实跑，Linux/CPU-only）

| 项 | 结果 |
|---|---|
| `pytest test_laya.py test_middleware.py` | **61 passed** |
| `long_task.py` | **3/3 子目标、3 步、APPROVE** |
| `browser_agent.py` | A：1 步完成 + APPROVE；B：风险 p=1.00 被确认闸门拦下（laya 谎报 done 0.63 被 DOM 信号规则否决）→ REJECT |
| `bench/run_bench.py`（全量，**现走生产循环**） | **8/8 cases、23/23 subgoals、76.0 s**（改造前 76.9 s，无退化） |
| 消融 `--force-rules off` | 0/2，停在 `low confidence 0.11 / 0.19 < floor 0.25` —— 与既有结论一致（纯 laya zero-shot 不可生产用），开关本身工作正常 |
| Path A `browser_picker_playwright.py --confirm-safe` | **3/3 PASS** |
| `camera_entry.py` | **3/4 OK + 1 被表单校验拒绝**（符合既定期望）；行 1 → multilingual conf 0.92，行 2（device_type 空白）纯靠模型路由正确 |

### F. 下一步

1. `Router` 的 `max_loaded` 可按可用内存自适应；`tune_guard.py` 的 0.95 阈值离良性页实测 0.91–0.94 太近，建议按页面类型分层。
2. bench 的 8 个 case 现在同时是**生产循环**的回归网：把 `pytest + bench`（fixture 部分）接进 CI，线上 3 个 case 标 nightly。
3. 仍未做：`run_plan` 跨子目标复用同一浏览器（现在每个子目标自建、每次重新 `goto`）；`is_done` 在有无 DOM 信号两条路径上的措辞统一。

---

## 十三、第 7 轮：工程收尾（计划级会话复用 / 单一回归门 / 依赖与 CI）

第 6 轮把执行器统一之后，这一轮补的是「让它可被持续验证」的基础设施。

### A. 计划级会话复用（`browser_session`）

- 新增 `browser_agent.browser_session()` 上下文管理器（一个 playwright + 一个 page），`task_planner.run_plan` 用它包住**整个计划**：子目标之间共享 page 与 playwright 实例，cookie / 会话 / JS 状态跨子目标存活（bench 从第 4 轮起就是"一个 case 一个浏览器"，生产路径此前每个子目标都要冷启动一次浏览器）。`run()` 仍然各自 `goto(start_url)`，子目标隔离性不变。
- resume 语义同时收紧：**全部子目标已 done/blocked 的计划根本不启动浏览器**（此前无论如何都会为第一个子目标建一次浏览器）。
- 新增 3 个离线用例：同一 page/pw 传给每个子目标、hint 随会话一起传递、完成的计划不开浏览器。`long_task.py` 回归 **3/3、3 步、APPROVE**。

### B. 单一回归门 `bench/smoke.sh`

- 一条命令 = 单元测试 + 5 个 file:// fixture case（**走生产执行循环**），退出码即结论；结果写到 `${TMPDIR:-/tmp}`，不污染仓库。
- `run_bench.py` 新增 `--fixtures-only`（跳过 `live:` 平台）；并对空选择显式报错退出（不再静默 0 个 case）。
- 实测：**5/5 cases、14/14 subgoals、38.2 s**。失败路径也验证过：`PY=false bash bench/smoke.sh` → `SMOKE: FAIL` / exit 1；`--fixtures-only --only <live case>` → exit 1。

### C. 依赖清单与 CI

- 新增 `requirements.txt`：11 个直接依赖 + 已验证版本注释（`transformers`/`huggingface-hub` 由 laya 带入；checkpoint 不属于 pip 依赖，首次运行从 HF 拉取）。用 `packaging.requirements` 对照本机实测环境逐条校验，**11/11 通过**。
- 新增 `.github/workflows/checks.yml`：push/PR 跑 `bench/smoke.sh`；nightly / 手动 dispatch 跑全量 8 case（含 3 个真实站点，外部平台波动大，因此不 gate 每次 push）。先装 CPU-only torch（避开 ~2.5 GB CUDA wheel），并缓存 `~/.cache/huggingface`。
- 诚实边界：Actions 本身无法在本机执行，只做了 YAML 解析校验；其调用的两条命令（`smoke.sh`、`run_bench.py`）均已本地实跑。

### D. Router 内存自适应

`camera_entry.max_loaded()` 用 `os.sysconf("SC_AVPHYS_PAGES")` 探测可用内存：≥4 GB → 2（避免切语言时的冷重载，实测 4 行要 1m40s 主要花在重载上），否则 1；无法探测（Windows 无 `os.sysconf`）也回落 1。本机探测 1.5–3 GB → 仍为 1，行为与第 6 轮验证一致（`camera_entry.py` 实测输出不变）。

### E. 回归证据

| 项 | 结果 |
|---|---|
| `pytest test_laya.py test_middleware.py` | **64 passed**（middleware 27 个） |
| `bash bench/smoke.sh` | **SMOKE: PASS**（5/5 cases、14/14 subgoals、38.2 s；失败路径 exit 1 已验证） |
| `requirements.txt` specifier 校验 | **11/11 OK** |
| `.github/workflows/checks.yml` | YAML 解析通过（Actions 未在本机执行） |
| `long_task.py`（计划级会话复用） | **3/3、3 步、APPROVE** |
| `bench/run_bench.py`（全量，生产循环） | **8/8 cases、23/23 subgoals、76.0 s** |
| `camera_entry.py`（自适应 max_loaded） | **3/4 OK + 1 REJECTED**，路由行为不变（行 1 → multilingual 0.92） |

### F. 下一步

1. `is_done` 在「有 DOM 信号 / 无 DOM 信号」两条路径上的措辞与调用时机仍未统一；`replan=True` 参数仍是空壳（只有 ScriptedPlanner 的注释钩子）。
2. 真 LLM 闭环仍未跑过：`LLMPlanner` 自动产出带 `target_hint` 的计划 + `LLMAuditor` 审 trace（需要 `OPENAI_*`），这是"编排→固化→执行"全自动的最后一段。
3. 注入闸门 0.95 与良性页实测 0.91–0.94 之间只差 0.01，建议按页面类型分层或改为"页内相对异常"判据。


---

## 十四、第 8 轮：真实线上站点测试与优化（bench/cases-live.json）

> 前七轮的线上平台只有 3 个沙盒站。本轮新增 **8 个 live case / 10 个子目标**，覆盖 5 个真实生产站点
> （en/zh.wikipedia、news.ycombinator、python.org、bbc.com）+ 2 个 toscrape 分页 + **1 个 shadow DOM 商店**
> （shop.polymer-project.org）。运行：`python3 bench/run_bench.py --cases bench/cases-live.json --mode-tag live`。
> 刻意不进 `smoke.sh`：外部站点慢且会波动。

### A. 探测结论（真站点暴露的形状）

| 形状 | 实测 |
|---|---|
| 元素规模 | Wikipedia 首页 **688** 交互元素、搜索结果页 1300+，预算只有 40 → 计划点名的目标必被挤出 |
| shadow DOM | polymer shop：`document.querySelectorAll` **0**，Playwright locator **20**（Pierce open shadow），29 个 shadow root |
| frames | the-internet/nested_frames：顶层交互元素 **0**（内容全在 frame 里）——目前不支持 frame 遍历 |
| 同意横幅 | cookiebot.com 确有横幅（27 个 banner 节点），但 `#CybotCookiebotDialogBodyButtonAccept` 已不存在、"Allow all" 点击后不消失 → 未找到可靠 dismiss 信号，本轮不做用例 |
| 重复链接 | bbc.com 有 **两个完全相同的 `/news`** 链接（导航 + 正文）|
| 无 data-test | 真站点普遍没有 data-test；`#id` 反而是最稳的句柄 |

### B. 五个真实 bug（全部由线上测试暴露，全部已修）

1. **`page.goto()` 用 Playwright 默认 `wait_until="load"`** → zh.wikipedia 直接 `Page.goto: Timeout 30000ms`；Wikipedia 子目标光加载就花 296 s。→ 改 `domcontentloaded` + 可配 `goto_timeout`（执行器只需要 DOM）。
2. **hint 语法两套实现漂移**：`#id` 只加到了 Python 侧 `_hint_match`，JS 侧 `hint_lookup` 不认 → 被预算挤出的计划目标**无法回捞**（Wikipedia `#searchInput` 在 header 里，40 个名额全被主内容占满）。→ `hint_lookup` 补 `#id` 分支，并在两处互相标注「必须同步」。
3. **raw string 里 `\s` 被过度转义**（2 处）→ 多词 label 永不匹配：python.org 的 `Next »` 找不回来。→ 修正为 `\s`。
4. **`hint_lookup` 用 JS 扫描下标去 Playwright `.all()` 里二次解析** → 真站点 DOM 在两秒之间变动（python.org 新闻条），下标指向**另一个元素**：`Next »` 回捞成了 release 链接，hint 静默失效。→ 改为**同一次扫描内盖章** `data-hintref` 并直接返回元数据，`_locator_for` 首选该章——与 `data-js-ref` 同一套「盖章定位」思路，彻底去掉跨查询的下标假设。
5. **不可区分的多命中直接弃权**：bbc.com 两个相同 `/news` 链接 → hint 返回 None → 退化成模型掷硬币。→ `_first_if_same()`：多命中若在 (tag,label,href,data-test) 上完全一致，取扫描序第一个；真正不同的候选仍交 laya。

### C. 其他优化

- **信号语言加 `css_text_contains`**：zh.wikipedia 的条目标题 `<h1>` 实际是「艾伦·图灵编辑」（编辑链接在标题内），`css_text_equals` 永远不可能命中。
- `_missing_required` 复用调用方已有的扫描（此前每次点击前重复整页抽取，Wikipedia 上 ~5 s/次）。
- `_candidate_meta` 用 `checkVisibility()` 取代对每个匹配调 `getComputedStyle()`；`extract_elements` 的 `inner_text()` 改为惰性调用。

### D. 结果（实跑，Linux/CPU-only）

| 用例 | 修复前 | 修复后 |
|---|---|---|
| live-python-org-search | **0/2, 380 s**（#id 回捞失败 + hint 取到错元素） | **2/2, 16.2 s**，两步均 `rule:match conf=1.00` |
| live-wiki-zh-search | 超时（goto load） | **2/2, 256 s**（CJK 条目，hint 回捞 + multilingual ckpt） |
| live-hn-newest / bbc-news / books-next / quotes-next / polymer-shadow | — | **全部 1/1**（polymer 走 shadow DOM，3 步） |
| live-wiki-en-search | 0/2 | **0/2（已知红）**：Codex 搜索框不保留程序化 fill（zh 保留），任何读字段值的 signal 都点不亮 |
| 回归 | — | 68 单测、`smoke.sh` 5/5、全量 bench **8/8 23/23 @70.8 s** |

### E. 仍开放（下一轮）

1. **每步抽取成本仍是主要瓶颈**：Wikipedia 上 `extract_elements` ~4.5 s/步，主因是 40 个元素 × 每属性一次 CDP 往返（~9 次/元素）。批量化成单次 JS pass（并把 `data-hintref` 思路推广为统一盖章）预计降到 ~0.5 s/步——这是让 wiki 类巨型页面可用的关键。
2. **en.wikipedia Codex 搜索框**：需要「fill + submit 同子目标 + 信号写在效果上」，而一个子目标只有一个 `target_hint` → 需要 hint 序列（或允许 signal 与 hint 分属不同目标）。
3. **frames 未支持**：顶层 0 元素时直接判定动作空间耗尽。
4. **同意横幅**：需要一个可验证的「横幅已消失」语义（`css_absent`），并且要找到真实可 dismiss 的站点。


---

## 十五、第 9 轮：「按类型录取到对应页面」做成业务规则（camera_entry）

第 6 轮把表格列回落删掉、改成纯模型路由后，留下一个产品问题：**"按类型录取"本身就是一条字面业务规则**
（表格里写着 `枪机` 就该进枪机页），把它交给模型是在替一条确定性规则掷硬币——实测那三行的模型置信度只有
0.03–0.09，选择正确纯属 argmax 侥幸。本轮按项目自己的原则（**字面映射交给规则、语义交给 laya**）把它做成
一等规则：

- `TYPE_TO_FORM = {"枪机": "form_a", "筒机": "form_a", "球机": "form_b", "PTZ": "form_b"}`：**类型列可识别时由它决定页面**，零模型调用、可审计；
- 类型空白/未知时回落到原路径（`laya.Router` 选 checkpoint + laya 的路由选择题）；
- 模型**仍然会跑**：两者不一致时日志里显式打印 `(model disagreed: formX@conf)`，错误类型列不会静默走错页；`mismatch` noul ≥0.5 也会标 `MISMATCH?`；
- `CAMERA_ROUTE=type`（默认）/ `model` 可切换优先级，两种模式都已实跑：
  - `type`：row0/1/3 `via=sheet:type=...`，row2（类型空白）`via=model:english` → **3/4 录入 + 1 被表单校验拒绝**
  - `model`：四行全 `via=model:*` → 同样 **3/4 + 1 拒绝**（本数据集模型与类型列 4/4 一致）
- 顺带把散在 4 个 dict（FORM_MAPS/ENTRY_LINKS/SUBMIT/ERR）里的表单表合并成一张 `FORMS`：**增加一种类型 = 改 1 张表 + 1 行 TYPE_TO_FORM**，其余代码不知道 form 的存在。

诚实边界：`main()` 的行循环仍未拆出可单测的 `resolve_form()`（优先级逻辑目前只有端到端覆盖）；类型列的值需要与
`TYPE_TO_FORM` 的键完全一致（别名要显式加）。


---

## 十六、第 10 轮：P0 性能优化（一次 JS pass + 探测预算 + shadow-aware 采集）

第 8 轮把瓶颈定位到"每步抽取"，本轮动手。三项一起改（同一段遍历，分开做会改两遍）：

1. **`extract_elements` 改成单次 JS pass**：一次 `page.evaluate` 返回 tag/label（含 `<label>` 包装文本）/data-test/name/id/type/href/可见性/主内容标记，按主内容优先排序后取前 40，并在**同一次**里盖 `data-dshref` 章 —— 元素列表、scan 索引、locator 句柄三者单一来源，`_locator_for` 首选该章（不再需要跨查询做下标运算）。逐元素路径保留为 `_extract_rows_per_element`，JS 抛异常时精确降级到旧行为。
2. **CDP 监听器探测加预算**：`max_examined=150` + `budget_s=2.0`（每候选 resolveNode+getEventListeners ≈4 ms，此前在 Wikipedia 上要 6.2 s/URL）；该探测本来就是"尽力而为、异常静默"，预算符合其契约。
3. **三个 JS 侧 pass 共用 shadow-aware 采集器** `_COLLECT_JS`（递归 shadowRoot）：元数据（已并入第 1 项）、`add_near_context`、`hint_lookup`。此前 Playwright 的 locator 能穿透 shadow DOM 而 `querySelectorAll` 不能，导致 polymer 商店"扫描 20 个元素、元数据 0 个"。

### 实测（同一台 CPU-only 机器）

| 指标 | 改造前 | 改造后 |
|---|---|---|
| `extract_elements`（en.wikipedia，677 匹配） | **4.5–5.2 s/步** | **0.02–0.03 s/步** |
| CDP 监听器探测（同上页面） | 6.20 s/URL | **1.36 s/URL** |
| 全量 bench（8 cases / 23 subgoals） | 70.8 s | **54.1 s**（−24%） |
| live-polymer-shadow（shadow DOM） | 21–31 s | **6.6 s**，且 hint 以 `rule:match conf=1.00` 命中 |
| live-python-org-search | 16.2 s | **10.7 s** |
| live-wiki-zh-search（CJK 真站点） | 256 s | **152.8 s**（−40%） |
| 回归 | — | 68 单测、smoke **5/5（14/14）**、全量 bench **8/8（23/23）** 全绿 |

副产物观测：zh.wikipedia 上第一次 fill 被 JS 控件丢弃、第二次才生效（靠既有 prior-hit 再驱动兜住），与第 8 轮 en.wikipedia 的结论同源；`#searchInput` 依然被 40 名额挤出主池（设计如此），由 hint 回捞救回。

### 仍未做（P0 剩余）

- **frames**：需要 `page.frames` 同源遍历进入抽取与信号求值（本轮未动）。
- shadow 采集顺序与 Playwright 深度优先交错顺序不同（`scan`/near 内部一致，仅跨实现比较需注意）。


---

## 十七、第 11 轮：frames 支持（P0 收口）

真站点上"顶层 0 个交互元素"只可能有一种原因：**内容在 iframe 里**。此前执行器直接判"动作空间耗尽"。

- **提取**：`extract_elements` 遍历主 frame + 同源子 frame（上限 6，防广告 iframe 吃满预算），子 frame 元素带
  `frame` 索引、ref 加 `f{n}:` 前缀；预算仍在 `MAX_ELEMENTS` 全局封顶（主 frame 优先）。
- **句柄**：`_locator_for` 全部查找限定在该元素所属 frame（`page.locator` 只搜主 frame），并顺手修掉
  `el.get("scan", int(el["ref"][1:]))` 的**提前求值**——命名空间化 ref（`f1:e3`）会当场抛 ValueError。
- **信号**：新增 `locator_any_frame()`，`check_signal` 的 4 个 CSS 算子都改用它（完成信号经常就在 iframe 里的
  字段/横幅上）；`url_contains` 仍取主 frame URL。
- **inert 检测**：`snapshot()` 纳入子 frame 的 url/文本/输入值——iframe 内的动作只改 frame 的文档，不纳入就检测不到"没变化"。
- **周边**：`add_near_context` 与 `_missing_required` 改为**逐 frame** 执行（scan 索引是 per-document 的），
  预填返回的句柄现在带上 `frame`/`dsh_ref`，避免退化成语义匹配。

### 新增离线覆盖

`bench/fixtures/frames_parent.html` + `frames_inner.html`（iframe 内的中文表单）+ 用例 `frames-entry-zh`
（2 子目标：在 iframe 内填序列号 → 点提交 → 断言 iframe 内的 "已登记"）。**默认进入 `smoke.sh`**（fixture 用例），
所以 frames 从此有永久回归。

### 实测

| 项 | 结果 |
|---|---|
| `frames-entry-zh`（离线，iframe 表单） | **2/2 @7.8 s**，两步均 `rule:match conf=1.00`（hint 在子 frame 内命中） |
| 离线门 `smoke.sh` | **6/6 cases、16/16 subgoals** + 68 单测 |
| 全量 bench | **9/9 cases、25/25 subgoals @58.1 s** |
| live python.org（回归 sanity） | **2/2 @8.1 s** |
| live `the-internet/nested_frames` | 仍 0 个可操作元素——但原因是**该页 frame 内只有纯文本**（无链接/按钮/输入），不是能力缺失 |

诚实边界：只支持**同源** frame（`frame.evaluate` 抛异常即跳过）；跨域 iframe 仍等于不存在。

### P0 收口

#1 一次 JS pass（4.5–5.2 s/步 → 0.02 s）、#2 探测预算（6.2 s/URL → 1.36 s）、#3 frames、#4 shadow-aware 采集
全部完成。下一步回到 P1（hint 序列、语法一致性、量化指标、`css_absent`）。


---

## 十八、第 12 轮：场景测试「IP 规划表 → 摄像头网络设置页」

**场景**：一张（ip、子网掩码、网关）的规划表，需要逐台配置到对应摄像头的网络设置页。

新增仿真站点 `testpages/net_portal.html`（4 台设备的列表，**四个链接文字全是「网络设置」**）+ `testpages/net_settings.html`
（按 `?sn=` 区分设备、真实校验：IP 四段范围 / 掩码合法性 / **网关必须与 IP 同网段**、保存后回显三元组）。
新增 `ip_config.py`：每行生成一份冻结计划（`TaskPlan` 现在自带 `slots` 数据袋，与 `cases.json` 契约一致），
**整张表共用一个浏览器会话**；门户按序列号 hint 进设备页并断言回显序列号，保存前由执行器预填三个字段，
保存走风险闸门，完成只认页面回显；失败行读**设备页自己的错误文案**。

### 场景暴露并修复的真 bug

`_hint_match` 的 `=` 分支把「入口已小写化的 hint」与「原始属性」做 `==` 比较：`data-test="net-CAM-1001"`
这种**大写设备 ID**（真实摄像头/工业面板的常态）直接静默失配 → 计划点名的目标退化成 laya，置信度 0.02–0.05
→ **4 行全部 `BLOCKED`**。`~`（子串）与 `#id` 分支本来就大小写不敏感，只有 `=` 漏了——又一次"两套实现漂移"。
修复为大小写折叠比较 + 单测钉住（`test_hint_match_attr_value_is_case_insensitive`）。测试总数 68 → 69。

### 实测输出（真实运行）

```
row 0: CAM-1001  10.0.1.11 / 255.255.255.0 / 10.0.1.1
  step 1: click a "网络设置" (clicked, rule:match, conf=1.00)      ← 端口页 4 个同名链接，hint 精确命中
  step 1.pre: fill required '10.0.1.11 / IP 地址' -> filled        ← 点击前预填（值只来自表格）
  step 1.pre: fill required '255.255.255.0 / 子网掩码' -> filled
  step 1.pre: fill required '10.0.1.1 / 默认网关' -> filled
  step 1: RISKY click button "保存" (p=0.63~0.90) -> 确认后执行
  -> OK  已保存 10.0.1.11 / 255.255.255.0 / 10.0.1.1 到 CAM-1001   audit: APPROVE
...
row 3: CAM-1003  10.0.1.999 / ... -> REJECTED  IP 地址格式错误：10.0.1.999   audit: REJECT
summary: CAM-1001=OK, CAM-1002=OK, PTZ-2001=OK, CAM-1003=REJECTED
3/4 configured; 1 rejected by the device page's own validation
```

### 观察（未修，值得记录）

1. **风险头对导航链接也报警**：点「网络设置」被判 risky p=0.86–0.89（纯导航，不可能不可逆）；保存 p=0.63–0.90（合理）。
   同一次运行里 row0 的保存没触发、row1–3 触发——风险头不一致的又一处证据（与 add_to_cart 0.83 同源）。
2. **placeholder 会冒充字段身份**：输入框 label 被算成 `10.0.1.11 / IP 地址`（placeholder 就是示例值），
   真实系统里 placeholder 常写成示例 IP，容易与规划值混淆。本例 slot 匹配靠 `data-test` 精确命中才稳。
3. 驱动脚本区分 `REJECTED`（设备页有错误文案）与 `BLOCKED`（执行器没能完成），避免把"没跑完"说成"被拒绝"。

### 回归

69 单测、`smoke.sh` **6/6（16/16）**、全量 bench **9/9（25/25）@56.2 s**。


---

## 十九、第 13 轮：接通编排端（planner 看 DOM + replan 真接线 + 数据袋进计划）

此前：`LLMPlanner` 只拿到**目标文本**，所以**产不出 `target_hint`**；`replan=True` 是空壳；值只能藏在 goal 文本里。

- **planner 看得到页面**：新增 `snapshot_text(elems)`，**复用执行器自己的 `criteria_view`** 渲染；`LLMPlanner.build_messages`
  把它嵌进 user 消息，`SYSTEM` 与 `PlanningRules.prompt_text()` 都要求输出 `target_hint`（仅在快照里目标无歧义时给）。
  `plan_cli new "<目标>" --llm --url <page>` 先取页面快照再交给 planner；`PlanningRules` 增加 hint 校验与可选 `require_hint`。
- **replan 真接线**：`run_plan(..., planner=..., max_replans=2)` —— 阻塞子目标保留 obstacle，改后的子目标追加为 pending；
  **无进展即停**（planner 原样返回则循环结束，永不空转）；次数上限实测 2 次封顶；**replan 异常不再静默**（原先只在 verbose
  下打印 —— 被吞掉的 planner 错误和"没东西可加"长得一样，本轮正是它让我多 debug 一轮）。`plan_cli run --replan` 打开该路径。
- **数据袋进计划**：`TaskPlan.slots`（构造/保存/加载/`run_plan` 合并），与 `cases.json` 顶层 `slots` 契约统一。起因是真实易错点：
  `extract_slots("shop: coupon=SAVE10")` 会解析成 key=`shop` —— 值不该藏在目标文本里。

### 验证（本机无 LLM 端点，全部离线可复现）

| 项 | 结果 |
|---|---|
| 新增单测：快照渲染 / planner prompt 携带快照且保留 hint / hint 校验 / replan 成功 / 无进展即停 / 次数上限 | **74 passed**（68 → 74） |
| `snapshot_text` 对真实页面 | `net_settings.html` → 4 个元素，形如 `input "10.0.1.11 / IP 地址" [test=ip]` |
| `plan_cli new --llm`（无端点） | 明确报错：需要 `OPENAI_BASE_URL`+`OPENAI_API_KEY`，否则用人工骨架 |
| `plan_cli run`（计划自带 `slots`） | **3/3、APPROVE** |
| `long_task.py`（`run_plan` 改为工作队列后） | **3/3、APPROVE** |
| 回归 | 离线门 **6/6（16/16）**、全量 bench **9/9（25/25）@58.1 s** |

### 仍缺

1. **一个真实 LLM 端点**：`LLMPlanner.make_plan/replan` 与 `LLMAuditor` 只差 `OPENAI_*`；届时
   `plan_cli new "<目标>" --llm --url <页面>` → `check` → `run --replan` 即完整闭环。
2. replan 应把阻塞页面的快照传回 planner（`page` 在作用域内，2 行）。
3. `LLMAuditor` 替掉 `MockAuditor`。


---

## 二十、第 14 轮：把 laya.Router 接进执行器（按页面语言选 checkpoint）

此前只有 `camera_entry` 用 Router；执行器要么固定 english，要么靠计划里手写 `"model": "multilingual"`。

- `BrowserMiddleware(route_models=True)`：每步用页面 state 调 `Router.route`（微秒级、无前向）决定 checkpoint，不同则换驻留模型；
  所有 laya 调用（`pick_element` / `is_risky` / `is_done`）改走 `agent_for(state) -> (agent, embed_fn)`。
- bench 新增 `model="router"` / `--force-model router`，消融矩阵可直接对比。
- **两个自己写出来的 bug（都是不跑就看不出来的）**：
  1. `run_bench.main()` 用 `next(iter(agents.values())).device` 打印设备，而 router 模式的值是 `None` → **启动即崩**（我第一遍的
     grep 过滤器把 traceback 藏了，误以为是 OOM）；
  2. 换 checkpoint 时只 `Router.unload()` 清了 router 的引用，执行器 `self.agent` 仍握着旧 Agent → 新旧权重短暂共存 ≈3 GB → 3 GB 机器必 OOM。
     修法：先 `self.agent = None` + `gc.collect()` 再 load，异常则回滚。

### 实测

| 项 | 结果 |
|---|---|
| 全量 bench，`--force-model router` | **9/9 cases、25/25 subgoals** |
| 日志中的路由决策 | `asset-bullet-zh` → `multilingual (non-Latin script (han, 80% of letters))`，随后回 `english`；`forum-post-zh` → `multilingual (han 52%)` |
| `frames-entry-zh`（中文用例） | **未触发切换**（state 里 ASCII 标识符占比过半 → 判为 Latin），仍以 english 通过——与 camera_entry 行 0/2/3 同源现象 |
| 用时 | **410.9 s vs 固定 english 58.1 s** → **路由买语言覆盖，不买速度**（每次切换冷载 checkpoint，本机 `max_loaded=1`） |
| 回归 | 离线门 **76 单测 / 6/6（16/16）**；新增 2 个路由单测（卸载先于加载、失败降级、opt-in 关闭） |

### 仍缺

1. 真实 LLM 端点（第 13 轮已就绪）才能跑"编排→固化→执行"闭环。
2. 路由成本优化：按计划/站点固定一次 checkpoint，或 ≥4 GB 放开 `max_loaded=2`。
3. 第 12 轮扰动实验的三个改进（有界等待内容出现、planner 补障碍物子目标、signal 去耦合）——`hydrate900` 与 en.wikipedia Codex 仍会失败。

---

## 二十一、长流程线上用例（3 站点 / 34 子目标）

> 第 8 轮的线上包是 8 个 case / 11 个子目标，每个 case 只有 1–2 个子目标——它证明"单点动作能被规则解决"。
> 本轮补上它结构上测不到的那一半：**一条完整旅程**（登录 → 多次页面往返 → 表单 → 提交 → 登出），
> 3 个真实站点、34 个子目标、跨子目标的服务端会话状态、一个子目标多个动作、只在 JS 里的排序状态、
> 客户端路由竞态、`retries` 与 hint 兜底回捞。

- 用例包：`bench/cases-live-long.json`；命令
  `node --experimental-strip-types src/bench.ts --cases bench/cases-live-long.json --mode-tag live-long`
- **实测（真模型，CPU-only）**：`3/3` 用例、`34/34` 子目标、43 步 **全部 `rule:match`（零模型选择）**、102.6 s；
  既有线上包回归 `8/8`、`11/11` 仍然全 `rule:match`。
- **四个真实缺陷（全部由长流程首次触达，全部已修 + 已钉测试）**：
  1. 可见性判定只看 `getClientRects()[0]` → inline anchor 包 block 的六个商品标题链接全部丢出元素池（25/31）；
  2. 有序 `target_hints` 前进后没有重新解析 → 下一个动作被丢给模型（规则模式直接阻塞）；
  3. 可操作性探针把"慢但没被遮挡"的元素判成 `action-timeout` 并**拉黑**（注释说的事没做）；
  4. 动作后的信号只查一次 → SPA 路由"先改 URL 后重渲染"造成约 1/4 的误判（实测 30–230 ms），
     修法是给信号一个有界结算窗口（4 × 0.12 s）。
- 抖动：同一用例修复前 **15 次里 7 次失败**，修复后 **8/8 全绿**。
- 设计、逐子目标证据（34 行）、消融与已知边界：[bench/LONG_FLOW_REPORT.md](LONG_FLOW_REPORT.md)。
