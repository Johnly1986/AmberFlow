# Changelog

AmberFlow（冻结计划的浏览器自动化中间件）的显著变更。本文件格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] — 真实站点走查批（act 歧义口径 / 双柄 range 事实 / CSS 属性形状 / 启动失败分类 / 落地丢段 / 程序化滚动）

> 用引擎 session 面走查一个真实站点任务时暴露的六条卡点。全部是通用能力缺口
> （无站点知识），逐条都有本地可复现的 fixture 与反证。

- **`act` 的 `ambiguous` 与 `ok` 不再可能同时为真**（**对外响应形状变化**）：此前强档唯一命中、
  动作已执行时仍可能带 `ambiguous:true`（弱档旁路另有候选），调用方按"没动作"理解却已产生
  副作用。现在 `ambiguous` 由结果码派生，恒等式 `ambiguous === (code === "target_ambiguous")`。
  `matched_others` 仍是 advisory（`ok:true` 时照旧回显"池里还有撞词候选"）。
  桥的人读摘要同步把 advisory 的渲染开关从 `ambiguous` 改成"有没有 `matched_others`"，
  否则这条提示会从摘要里彻底消失。
- **耦合双柄滑杆的越界拒绝补事实**：`set_range {value}` 命中多个同形 range 时，reason 现在
  带 `handles` / `handle_index` 与**各手柄自己的 min/max**（此前只用被命中那一个的 min/max
  判越界，把"指错了柄"报成"值不合法"）。`readState` 在同一 evaluate 内顺手读兄弟手柄，
  无额外页面往返。**单柄控件 reason 逐字节不变**。
- **CSS 属性操作符不再是静默落空**：`[attr*=v]` / `^=` / `$=` / `|=` 的词法把操作符并进
  属性名（`href*`），永不命中且没有形态诊断。`hintShapeProblem` 新增 `css-attr-operator`
  类别，reason 说明闭集只有等值与子串两种属性形状，suggestion 给可照抄的改写
  （`href*=x` → `href~x`）。**`~=` 是闭集合法操作符，不误报**；同时补上 `a[href~="v"]`
  这种带引号子串形状的去引号（此前值带 `="` 前缀，同样永不命中）。
- **headful 启动失败归 `config_error` 而不是 `browser_dead`**：无 `DISPLAY` 时 Playwright 抛
  `browserType.launch: Target page, context or browser has been closed`，此前命中
  `isDeadPageError` 的正则 → 会话被判定死亡并终结。现在启动期失败（XServer 缺失 / 可执行
  文件缺失）结构化归 `config_error` + 可行动建议（换 headless 或 `xvfb-run -a`），
  **会话保持存活**，后续请求仍可换档；运行期浏览器死亡仍是 `browser_dead`。
- **`goto` 的落地路径形状变化有事实**：站点重定向可能把目标实体丢掉（请求
  `.../place/X/data=...` → 落地 `.../place//@...`）而 `goto` 仍返回 ok。现在只在**路径形状
  真的变了**时 additive 回传 `requested_url` / `landed_url` / `landed_path_shape_changed:true`
  并追加一行复核提示。判据零站点知识：①请求某位非空、落地同位置变空；②请求非空段数多于
  落地。查询参数变化、尾斜杠、同段数换实体都**不报**（不把合法重定向判成失败）。
- **程序化滚动容器可滚了**：`overflow:hidden` + `scrollHeight > clientHeight` 的自定义滚动
  面板此前被判 `not_scrollable`（错误里已标 `programmatically scrollable` 却不给路径）。
  现在回退到 `scrollTop += delta` 并标 `strategy:"programmatic"`（标准路径不出现该键）。
- **`scroll` 的 `at_bottom` 事实**：`moved=false` 此前既表"这次没动"也表"到底了"；现在
  满足 `scrollTop + clientHeight >= scrollHeight - 2` 时 additive 带 `at_bottom:true`。
- **会话面 `act scroll` 的合成目标加 `page`**：`page` 不是元素池里的名字，此前当 hint 解析会
  撞出某个 `.page` 容器并报 `not_scrollable`。会话面闭集扩一个 `page`（flow 面
  `ctx.scrollList("page")` 语义不动）；`not_scrollable` 的建议也改成会话面可执行的
  `act scroll target=document`（此前推荐 `ctx.scrollList`，会话面没有 ctx）。

- **`headful:true` 在桥下可用了**：桥起引擎子进程时 env 走白名单（`ENV_BASE`），
  `DISPLAY`/`XAUTHORITY`/`WAYLAND_DISPLAY` 不在其中 → 有头请求永远报
  `no usable XServer/DISPLAY`，且用户在外层 `export DISPLAY` 也无效（那是桥自己的环境，
  传不进已启动的子进程）。三个显示变量加入白名单（最小必要面）。
  这也是「headless 下某些站点降级渲染（评论区不下发）时无法改用 headful」的根因。

- **死页不再被吞成空结果**：会话页被关闭后，`observe` 曾返回 `ok:true` + `counts` 全 0、
  `snapshot` 写出全空文件、`read` 返回 `value:null`——调用方无法区分「页面真的没内容」与
  「上下文已经没了」（只有 `goto`/`act` 才会抛 `Target page... closed`）。现在 `dispatch` 前置
  守卫：除 `close` 外一律按既有 `browser_dead` 收口并发 `session_end`，与运行期死亡的收口路径
  完全一致（不新增码、不新增分支）。

- **桥面 `shape_problem.kind` 闭集改由契约表生成**：桥此前硬编码三个类别，本批新增的
  `css-attr-operator` 会被静默过滤掉（引擎说写法可疑、Agent 看不到原因）。闭集移到
  `SESSION_EVIDENCE_CAP_TABLE.miss.shapeProblemKinds` 并生成
  `BRIDGE_EVIDENCE_MISS_SHAPEPROBLEMKINDS`；`session-contract:check` 新增与
  `HintShapeProblemKind` union 的**双向**一致性断言（新增类别忘登记即红）。

测试：新增 lane `verify:walk-r1`（七项断言 + 各自的回退反证），已进 `verify:lanes` 聚合与
`AGENTS.md` / `docs/MAINLINE.md` 的 lane 清单。文档同批同步：`docs/INTERACTIVE_SESSION.md`
的歧义回显表（`ambiguous` 只在歧义停时出现、`ok:true` 时 `matched_others` 是 advisory）、
`act scroll` 的程序化回退/`at_bottom`/会话面 `page` 合成目标、`set_range` 的
`handle_index`/`peers`/`row_index` 多柄事实。

## [Unreleased] — 帧门禁同主域免检（iframe 解析面）

> `hosts` 此前在帧解析面是"逐条声明制"：子帧 origin 必须被 `meta.hosts` 的子域包含
> 语义盖住才进池。实测痛点：声明 `www.google.com` 时同站的 `ogs.google.com` iframe
> 被排除出池/hint/done/when——`ogs.google.com` 不以 `.www.google.com` 结尾，两侧谁也
> 不是谁的子域。本批把子帧解析面改为**注册域口径**：与任一声明条目同注册域即免检。

- **`frameGateExcludes`（`src/engine/frame-scope.ts`，唯一出处）**：子帧（`fi > 0`）与
  任一声明条目「同注册域」即免检——不引入 PSL，双向取**最后两段**近似
  （`ogs.google.com` / `www.google.com` 的注册域近似都是 `google.com` ⇒ 互放）；
  **IPv4（4 段全数字）/ IPv6（含冒号）只认精确相等**——两段近似对 IP 是误放源
  （声明 `172.16.1.1` + 帧 `10.16.1.1` 的最后两段碰巧都是 `16.1`）；单标签退化为精确
  相等；大小写折叠，协议/端口不参与。**已知近似**（PSL 缺失的代价，注释里写明）：
  同用域组合会误互放（`blog.co.uk` 声明 + `news.co.uk` 帧两侧最后两段都是 `co.uk`）；
  宽域声明 = 信任其全部子域（声明 `evil.io` + 帧 `google.com.evil.io` 免检——它确实是
  声明注册域的下挂）。导航信封（goto/落地/popup 的 URL 判定）**不变**：本批只对子帧的
  解析面免检；`frameGateOf` 帧分类同谓词（免检帧进 allowed，不再进 excluded）。
  消费点（池抽取/hintLookup/FW8/DRF/locatorAnyFrame/done/when，11 处）不改——谓词放行
  后自然同口径；跨注册域子帧仍排除，`frame_not_allowed` / `frames_excluded` 语义不变。
  新证据 lane：`verify:frame-exempt`（14 条纯函数边界 + 2 条本地 fixture 集成 +
  反证：禁用免检后「声明 `www.google.com` + 帧 `ogs.google.com`」边界必须红），
  `verify:lanes` 升至 19 条。
- **契约/文档同步**：F45 statement/truth 补免检口径（`src/cli/schema-gen.ts`）；
  `NAVIGATION.hosts_envelope` 句同步；`docs/APP_SCRIPT_AUTHORING.md` §frame 门禁与
  `meta.hosts` 表行、`docs/AGENT_INTERFACE.md` 的 `hosts` 信封节改免检表述。

## [Unreleased] — 2026-11-25 元素字段合同单源（引擎 ObserveElement ↔ 桥 ElementView）

> 元素行是 Agent 看页面的唯一入口，但它的结构化描述此前只有桥面 `ElementView` 一处；
> 引擎侧 `ObserveElement` 与 `inspect` 元素行没有可断言的对照物，三面各自加减字段时
> "桥给了引擎没给""引擎给了桥不给""某字段被当成地址用"都只能靠读代码发现。

- **新表 `SESSION_ELEMENT_VIEW_FIELDS`**（`src/support/session-contract.ts`）：30 行 × 七维
  （桥面字段名 / 引擎 observe 键 / 引擎 inspect 键 / 桥键 / 出现面 / cap / 可否作动作地址 /
  语义与差异说明），与既有的 `SESSION_ELEMENT_VIEW_LIMITS`（只答"多少"）互补。
  两张表同属一份合同，改其一必须同步另一。
- **生成器新增 `checkElementViewFields()`**（`tools/session-contract-gen.ts`）：表 ↔ 三面源码
  **双向**交叉校验——登记的键必须在源码里（接口声明 / inspect 行字面量 + `PoolElemView.extras` /
  桥投影赋值点），三面源码里的每个键也必须在表里有行；另断言出现面自洽、`engineOnly` 登记与桥
  实际读取一致、cap 键无死引用。**核心不变量机制化**：全表 `address:true` 有且只有
  `hint_candidates`（把 `label` 改成 `address:true` 即 `session-contract:check` 红）。
- **桥侧生成物**新增 `ELEMENT_VIEW_FACES` / `ELEMENT_VIEW_FIELDS`（字段名 + 出现面 + 可否作地址 + cap 键），
  桥包仍不 import 仓库 `src`。
- **文档整合**：`docs/AGENT_INTERFACE.md` §3.2 升级为**元素字段唯一权威表**（引擎↔桥两列 +
  出现面 + 可否作地址 + cap），其余文档改指针不重复字段清单——
  `APP_SCRIPT_AUTHORING.md`（observe 行只留 3-4 个作者相关字段的用法）、
  `INTERACTIVE_SESSION.md`（observe 行只留信封字段）、`ROW_ANCHOR_HINT_PLAN.md` /
  `ROW_INDEX_HINT_PLAN.md`（历史方案文档只加头部指针，不逐处改写）、`docs/MAINLINE.md`（cap 单源表述补字段合同）。
- **如实记录的引擎↔桥差异**（不改运行时输出）：`input_type` 在引擎 observe 面叫 `type`、inspect 面叫
  `input_type`，桥投影只读 `input_type` 所以 observe 面桥结果不带该键；`row_texts`/`row_index` 引擎两面都
  采集但只有 observe 元素行投影；`href_full`/`action_family`/`action_capabilities`/`near`/`surface`/
  `heuristic` 是 inspect 独有；`bbox`/`visible`/`admitted`/`why_not_admitted`/`frame` 是 observe 独有。

## [Unreleased] — 2026-11-25 桥元素投影补 `input_type`（引擎两面键名归一）

> 字段合同登记的最后一项「引擎有桥不给」缺口。`ObserveElement` 用 `type`、inspect 元素行用
> `input_type` 表达同一事实，而桥投影只读 `input_type`——于是**同一页在 inspect 面有这个键、
> observe 面经桥看过去没有**，调用方无法区分「元素没有 type」与「桥没投影」。

- 桥 `projectElementView` 两个键名都读（先 `input_type`，回退 `type`），输出**恒为 `input_type`**：
  值域与 cap 不变（`identityMaxChars`），键名差异不外泄。
- 字段合同 `SESSION_ELEMENT_VIEW_FIELDS` 的 `input_type` 行去掉 `engineOnly: ["observe"]`、
  `faces` 由 `inspect` 改 `both`；生成器的 ⑤ 组断言因此要求桥**同时**读两个键
  （漏读任一侧即红），生成物已重出。
- 新增回归断言（`verify:element-views`）：四个臂——inspect 键名、observe 键名（回退路径）、
  两键都缺（不出键）、非 input 元素（不出键），外加「两键同时给时以 `input_type` 为准」。
  反证：去掉回退 → `bridge projection input_type: observe 面键名 type（回退路径）` 判红。

## [Unreleased] — 2026-11-25 元素视图批（模型面正确性 + 敏感值不进标签）

> 从"元素接口缺少结构化文档"的调研里查出的三个**模型面**缺陷（`criteriaView` 的输出直接喂给
> 决策模型选点，选错不会产生任何信号）。三条都不是本次提案引入，而是既有实现里的洞。

- **`criteriaView` 的对齐判据从「数量相等」改为「逐项身份」**：原判据
  `ariaLines.length === 池大小` 只证明两边数量巧合相等——页面一有 `aria-hidden` 子树、嵌套控件、
  被窗口挤出的元素，位置就会错配，模型看到的是**另一个元素的 role/name**。
  新判据（`src/engine/aria-view.ts` 的 `ariaLinesAligned`）是 **role 硬 + name 软**：
  能映射出 role 的行必须同 role；name 只在两种情况下判错配（role 映射不出、或该 aria name
  恰好是**另一个**池行的 label）。无法逐项确认时**刻意降级**到 `tag "label"`——宁可少给 role
  语义，也不给错的身份。实测：30 个夹具页与 14 个真实站点样本上**零退化**（原本对齐的仍对齐）。
- **ARIA 行解析不再丢行**：名字含 `": "` 时 Playwright 会把 YAML 键用单引号包起来
  （`- 'button "Save: draft"': S1`），原正则整行丢弃（4 行只解析出 1 行）。新解析器
  `parseAriaInteractiveLine`（同模块）还原 YAML 单引号标量与 `''` 双写、用 `JSON.parse` 逆运算
  拆 name，转义还原失败时退化为**空 name** 而不是截断的错误值（截断的名字会拼进模型提示词）。
  `ARIA_INTERACTIVE_ROLES` 闭集一个字没加。
- **敏感输入的活值不再当标签**：`input[type=password|file|hidden]` 的 `value` 会经 label 兜底链
  进池行 → 模型面 / observe 行 / 池快照 / trace。现在与既有的 range 排除同形态（`isSecretInput`），
  只读稳定面（aria-label / label 包裹 / placeholder）。**六面同口径**：池（`LABEL_HELPERS_JS`）、
  DOM 回捞（`pool-js.ts` 的 `labelOf`）、dup 分组键（`ROW_CLIMB_JS`）、候选扫描兜底
  （`candidate-scan.ts`）、FW8 候选摘要（`identity.ts`）、A3 池外回退合成行（`executor.ts`）。
  **未覆盖**（如实）：`type=text` 里的明文凭据（按 type 不可区分，做形态启发会误伤真 label，
  需要作者用 `meta.secretSlots` 或页面自身的 label/placeholder 表达语义）。
- **新增 lane `verify:element-views`**（`tools/verify-element-views.ts`，零浏览器/零网络/零模型）：
  parse 14+6 行表驱动 + align 12 组判据 + label 13×2 + 6 镜像组。**已进 `npm run check`**。
- 夹具与 golden：新增 `fixtures/engine/secret-input.html` 与对应 `tools/golden/offline/secret-input.json`
  （golden 内零明文，已验证 `hunter2`/`hidden-fixture-value`/`upload.txt` 命中数为 0）。

## [Unreleased] — 2026-11-25 导航失败 vs 信封 / 改道语境 / 交接证据保现场

> 走查复盘三项：改道后旧 `resume{hint}` 在新页执行（P0）、落在 Chrome 错误页被谎报成越界
> （P0，pilot 与 run 两面各一处）、交接 evidence 超限截断把越界落地页切掉（P1）。

- **P0 改道即换语境（补全）**：`PilotRuntime.redirectReset()` 此前清步史/禁选/账本/值需求/
  落空 hint/键漂移现场，**唯独没清未消费的 `resumeHint`**。序列「越界停 → Agent 发
  `resume{hint}`（轮首守卫在 hint 消费之前命中，hint 留在队列）→ `redirect` 到新页」会让旧语境
  的点名在**新页面**上被确定性执行。修法：`redirectReset()` 一并清 `resumeHint`（与「新页面的
  目标不是同一目标」同一纪律）。
- **P0 导航失败不是越界（pilot 面与 run 面）**：Chrome 把导航失败落成内部错误页
  `chrome-error://chromewebdata/`，其 URL host 是 `chromewebdata`——直接拿去判 hosts 信封，
  「网络不通」就变成安全类停因（pilot `host_not_allowed`、run popup 扫描
  `popup_not_allowed`），兜底方会去改 hosts 而不是验证可达性。
  - 新增 `src/engine/nav-error.ts`（单一出处）：`isChromeErrorPage` / `NAV_ERROR_PATTERN`
    （`ctx-runtime` 的 navigate 改为 import 同一条，不再内联手抄）/ `classifyNavError` /
    `NAV_CONFIG_ERROR_PATTERN`（`ERR_UNSAFE_PORT` = 端口被浏览器拒绝，归 config 侧）/
    `pageNavError`（`reload()` 有界 3s 还原浏览器原文——错误页 `body.innerText` 为空、
    `content()` 是空壳，事后读不到原文）/ `contextNavError`（同 context 扫描，popup 面）。
  - **pilot 面**：`envelopeEscapeNow` → `envelopeStopNow/Of`，错误页先归还原文再归类；
    `PILOT_STOP_CODES` **10 → 12 码**（`unreachable` = 连接/DNS/超时类，解锁建议验证可达/放宽
    超时；`config_error` = 端口/URL/原文不可得，解锁建议改声明）。三处判定（轮首/步尾/finish）
    同一实现；交接证据新增 `nav_error`（仅这两个码且原文可得）。
  - **run 面**：`runPostAction` 的 post-action 信封判定、done 轮询后的 popup 复扫、`runSetup`
    的起跑 popup 扫描，三处都在信封判定**之前**判错误页，命中停 `config_error` + 原文
    （run 面 `StopCode` 不新增 `unreachable`——不在联合里、且被纯搬移 manifest 钉住）。
    **两面建议不打架**：分类结果照常算（`navFailure.code`），run 面经 `navErrorStopReason`
    把对应处置建议（「站点此刻不可达：先验证可达再重试」/「改声明，重试同一地址无效」）写进
    reason——码不动、口径与 pilot 面一致（同一张 `NAV_ERROR_DIRECTIVE` 表）。
  - **正常语义不变**：真正跨 host 的跳转仍停 `host_not_allowed`（`host-envelope.ts` 零改动）。
  - 证据：新增 `verify:nav-error` lane（5 场景：纯函数分类表 / pilot 面 / run 面 / run 起跑面 /
    context 扫描），
    `verify:pilot` 27 → 30 场景（新增「改道丢弃旧 resume 点名」「导航失败≠越界
    （unreachable/config_error 带原文）」「交接 evidence 超限保现场」）。
- **P1 交接 evidence 超限保现场**：`projectHandoff` 的 900 字符退化清单原为
  `Object.keys(evidence).slice(0, 8)`——`off_envelope` 恰是第 9 个键，真实停驶现场（40 条
  forbidden + 6 个 excluded frame，914–961 字符）的「是哪一步走出信封」事实被切掉。改为
  **定位键优先**（`off_envelope` / `expect_url` / `needs_value` / `resume_hint` 存在就留），
  其余按原插入序补足到 8 条；`truncated:true` 语义不变，**未超限的投影逐字节不变**。
  断言两处且都可失败：`session-contract:check` 的 `checkEvidenceKeyPriority`（换回
  `slice(0, 8)` 立即红两条）与 `verify:pilot` 的纯函数场景（同一实现下红一条）。

## [Unreleased] — 2026-11-25 驾驶面信封（hosts 中途生效）

> 真实站点走查（Google→Maps 三阶段任务）发现：pilot 的 `hosts` 信封只在起步校验，
> 驾驶中途走出信封（点登录入口、第三方重定向）继续烧模型票。与 run 面 `hostGate`、
> session 的 `open`/`goto`/`tab` 判定不一致。

- **`host_not_allowed` 进 pilot 停因闭集**：`PILOT_STOP_CODES` 新增一码（与 run/session 同词），
  `unblockHintsFor` 给两条确定性解锁建议（redirect 回信封内 / 确需就把目标加进 hosts）。
- **三处判定**（共用 `pilot-evidence.envelopeEscape`，与 `disallowedHost` 单一出处）：
  - 轮首：先判信封再判最终信号——不拿漂走后的候选问模型，**越界页上的信号成立也不算完成**
    （原序是「信号 → 信封」，越界页恰好满足 `final-signal` 会直接 `final_signal_held / ok:true`）；
  - 步尾：动作把页面带出信封时立即停——这样交接证据里能写清"是哪一步走出的"
    （`why_stuck.evidence.off_envelope` = 落地 URL）；
  - `finish`：在越界页同样判，回 `command_result{ok:false, code:"host_not_allowed"}` 单行拒绝，
    **交接保持打开**（先 `redirect` 回信封内再收尾）；终态与 `stop_code` 不变。
- **信封只来自声明（行为变更，两条口径分开读）**：
  - **引擎库面**：`PilotRuntime` 不再按入口 URL 推断信封。`hosts` 未声明 / `null` / `[]` /
    全空串条目 = `null` = **不设防**（与 `envelopeEscape` 的 `null → 放行` 一致）。空串条目在
    构造期归一并剔除——此前 `new URL("about:blank").hostname === ""` 会造出 `[""]`，而该信封把
    **一切** http(s) 页判成越界（attach 形态下不可恢复死锁）。
  - **CLI/桥面默认路径不变、且信封照常中途生效**：`amber session --url` 不带 `--host` 时由 CLI
    `inferHosts(--url)` 推断入口 host 并**显式**传给 pilot（`SessionPilotDriver` → `PilotOptions.hosts`），
    桥面 `session open` 不传 hosts 走同一条 CLI 推断。所以「不传 hosts」在 CLI/桥面**不是**零变化——
    驾驶中途走出入口 host 现在停 `host_not_allowed`（HEAD 是继续驾驶），这正是本批要修的行为。
- 证据：`verify:pilot` 27/27（新增四条：信封只来自声明（含 null/[]/空串归一到不设防）、
  导航信封：走出 hosts→host_not_allowed、信封优先于完成裁决（越界页信号成立≠完成 + finish 被拒）、
  attach：about:blank 起步不造空串信封），用 127.0.0.1 / 127.0.0.2 造同机不同 host
  （信封按 hostname 判）；`frame 排除` 场景改为显式声明 hosts（此前靠入口 host 隐式推断）。
- **站点事实入库**：`site-facts/google-maps.json` + `docs/SITE_FACTS.md` 增一条
  `reviews-hidden-when-headless`——地点详情页评论列表在 headless（HeadlessChrome UA）下不下发，
  同路径换 headful 即正常（A/B 各 2 轮：0/0 vs 35/35）。**不是登录墙**，采集评论面必须 headful。

## [Unreleased] — 2026-11-24 会话诚实性批（P0/P1：超时对账 / 滑块身份 / 轨迹 / 形状判别 / observe 收窄）

> 用户「按顺序实施，完成后逐项测试」：按会话实录复盘的四条 P0 + 四条 P1 逐项落地并各自验收。
> 纪律不变：不新增 stopCode、成功路径产物不动、run 面语义只增 additive 证据。

- **P0-2 超时对账（`execution_state`）**：`action-timeout` 不再一律报"没执行"。
  `timeoutDispatchNavigated`（单源）比对动作前 URL：已变 = 点击已在途中生效 → 按 `how:"clicked"`
  返回（`probe_navigated:true` / trace 行 `navigated_after_timeout:true`，**不补点**）；未变 =
  `execution_state:"unknown"`（会话响应、桥透传 + 一行 `dispatch: unknown … do NOT retry a
  destructive action`）。`_clickOnly` 与 `occlusionProbe` 共用同一判据（探针结果分类收进
  `classifyProbeOutcome`，`actOnce` 主流程因此回落到 167 行）。
- **P0-4 滑块身份与值域模型**：`input[type=range]` 的 label 不再读 `value`（活值不是身份；
  `LABEL_HELPERS_JS.isRangeLike` + 池/observe/回捞/A3 四处同口径）——同一 hint 连续设值不再
  因值变化失配。`applyRange` 增**格点吸附**（先钉到最近格点再动：`applied:true` +
  `accurate:false` + `snapped_to`，不再三策略全试 + 满超时白等）、**多柄事实**（`handles>1` 时
  `percent` 结构化 `config_error` 零动作，其它失败也带 `handles`；容器判定排除 body/html 且
  混有其它表单控件即按单柄）与 `aria-valuetext` 回显。
- **P0-3 set_range 进统一 act 事务**：`doActSetRange` 自持 `recordAction`（成功/失败都进
  `actions.jsonl`），`RecordedAction` 增 range 事实字段，`session export` 还原
  `await ctx.setRange(<hint>, { value: <requested> })`；`verify:session-range` 扩到七条路径
  （含轨迹行数与 export 产物断言）。
- **P0-1 hint 形状判别**：新增 `hintShapeProblem`（落空后才判——闭集里裸词收一切，解析期拒绝会
  误杀真 label）：`tag-plus-text` / `role-word-plus-text` / `selector-syntax`（含 `#id` 里带
  组合符）三类，进 `diagnostics.shape_problem` + 会话顶层 `shape_problem` + 桥一行
  `hint shape: … / fix: …`，reason 的 `判别:` 在可疑形态下先说形状。语法描述纠正：
  `HINT_SHAPES[4].en` 由 `tag (button|link|…)` 改为 `one role word (button OR link OR …)`
  （原写法被读成"标签 + 角色枚举词"，正是 `button 搜索` 的来源），`plan.rules` 冻结 hash 同步重审。
- **P1 观察面与传感器**：桥 session 工具补 `selector` 参数描述（observe 用它**替换**观察集合，
  要区域内的控件要写 `#region button, #region a`）；`CHECKS_JS` 快照增 `aria-expanded`/
  `aria-pressed`（只翻属性的菜单/抽屉不再被 `changed:false` 误报，实测属性翻转页从 false → true）。
- **P1 错误面与观察面收口**：会话 act 的 `target_not_found` reason 追加**命令步同一份**
  `HINT_CLOSED_SET_TEXT` 尾段（「容器/后代 CSS 会被当成永不命中的形状」，单一出处不手抄）；
  桥 session 工具有 `selector` 描述扩为 read/observe/extract 三面语义（observe 是**替换**观察集合，
  区域内的控件要写 `#region button, #region a`）；观察行渲染改 `✓/✗ + "label" + addr:` 两列
  （✓/✗ = 可寻址性，不是好坏；从此不会把人读摘要当地址），失败面另提一行
  `hint shape: … / fix: …` 与 `dispatch: unknown …`。
- 测试：`verify:session-range` 扩到**八条路径**（新增形状判别端到端 + 真 label 反例），桥
  `passthrough` 加 4 条（shape_problem 透传/未知 kind 丢弃/execution_state 透传与缺键形状不变）。
- 文档：`docs/INTERACTIVE_SESSION.md`（超时对账 / set_range 身份与档位与轨迹 / shape_problem 字段 /
  闭集尾段 / stopCode 表 / changed 传感器）、`docs/APP_SCRIPT_AUTHORING.md`（角色词"单独一个词"、
  形状判别、setRange 吸附与多柄）、桥 schema 描述与 `prompt-hit` 基线（94 条不变）。

## [Unreleased] — 2026-11-24 剩余项批（键漂移加固 + 会话契约阶段 2 + 规则词面归一）

> 用户「推送后继续完成剩余项」：三批并行落地（task-31 / task-45 / task-30 第 1 项）。
> 硬约束不变（不改外部行为与公开契约、不引入新依赖、原测试全过）。**未提交 git。**

- **task-31 needs_value 键漂移加固**：新增稳定身份 `valueTargetIdOf`（tag+name，无 name 退 tag+id，
  两者皆空 fail-closed 不回放）、`countValueTargetId`（池内唯一才回放）、`valueAliasKeyOf`（name/id
  与值袋键**精确相等**才命中，避免子串误绑）、唯一裁决点 `bindValueFor`（①键命中/别名 → ready；
  ②漂移回放：上一轮 needs_value 的 targetId 与本轮控件相同 + 池内唯一 + 值袋确有记录值 → 回放并记
  `value_target_drift:{from,to}`；③落空 needs_value，`stale` 只在身份明确不同时给出）。
  `pilot-runtime` 用 `lastValueNeed`（导航换页即清）支撑「值已落地后下一轮换键」回放；
  `valueSigOf`（含 label、跨轮不稳）降级为停驶现场证据签名，不再承担回放。
  **verify:pilot 21→23 场景**（含 label 丢失后裸字符串值仍落地 + 纯函数断言）；
  真站 Maps 复核：label 丢失（受控复现）后 `resume{hint}` 不带值仍回放落地，只执行 1 次 fill。
- **task-45 会话契约阶段 2（cap 单源化，值=现值）**：`session-contract.ts` 增三张表
  （handoff 三层 `SESSION_HANDOFF_CAP_TABLE`、五块证据 `SESSION_EVIDENCE_CAP_TABLE`、
  ElementView 15 项 `SESSION_ELEMENT_VIEW_LIMITS`）；生成器 `--check` 覆盖两份生成物并做三组交叉校验
  （含用 `projectHandoff` 实测超限行为反算引擎列）；桥 `element-view.ts`/`session.ts`/`index.ts`
  数值字面量改读生成常量。**逐字节等价证据**：10 工具 schema（45,282B）、session 请求线（24,553B）、
  rich 超限压测（119,320B）pre/post sha 全等；负向注入 4/4 判红。
  注：`ambiguity.frame_origin` 引擎 120 / 桥 60 保持现状（两列钉死，对齐需单批声明）；
  `HINTS_PER_ELEMENT=6` 保留为兼容 cap（引擎实际最多 4）。
- **task-30(1) 规则词面归一（机制修复，非词表）**：新增 `src/engine/rule-vocab.ts` 为切词唯一出处
  （`ASCII2/ASCII4/CJK1/CJK2/words` 从 rules 抽到一处），`affordanceRule` 增「逐词点名」补集判定
  `namedPhraseOverrides`：多词 label 每个词都被 goal 原词表点名、且都被通用词集剔除 ⇒ 字面点名成立，
  推翻「部分命中」的撞词候选。**不加任何新词、不改 STOP/ROLE/FILLER 三表、引擎层零站点/业务词**
  （grep 与 lane 口径断言双重守护）；四道 fail-closed 边界（无撞词不介入/完全点名不重排/纯 CJK 不认/
  多命中 decline）。新 lane `verify:rule-vocab`（20 行断言 + 3 组口径断言：正向 4、明确内容词反例 3、
  无关场景反例 2、纯通用按钮反例 4、无新词面 3、契约 4），`verify:lanes` 17→18。
  金标 A/B：characterization 12/12、parity、run-parity 16/16 **均无重录**。
  **未做**：actOnce `state_delta`/`control_changes`（保留为后续独立批）。

## [Unreleased] — 2026-11-24 批次 P1：桥决策端点原值透传（行为变更）

> 承接同日 EP parity lane 登记的 18 条差异白名单（2 族）；本批把桥侧的第二份归一化删掉，
> 白名单清零。**未提交 git。**

- **行为变更**：DSH 桥不再把配置页的「决策模型 URL」当基址补 `/systemone`——
  `integrations/dsh-bridge/src/bridge.ts` 的 `decisionEnv` 改为**只 trim、空=不注入、其余原值透传**
  （`normalizeDecisionEndpoint` → `decisionEndpointFromPage`）；协议推断与端点后缀全部交给引擎
  `normalizeSystemOneEndpoint` / `normalizeOpenAIDecisionsEndpoint`（引擎是唯一协议决策点）。
- **修掉的两个缺陷**：① 页面填裸 host / 端口 / 自定义反代前缀时，DSH 部署面实际 POST
  `…/systemone`，CLI 直跑 POST `…/v1/systemone`（同一份值两条面打到不同路径，文档推荐的
  `http://localhost:8008` 正处此列）；② 部署进程显式 `AMBERFLOW_DECISION_PROTOCOL=openai-decisions`
  或值含 `/decisions` 时，桥补的 `/systemone` 与 OpenAI 归一化器再补的 `/v1/decisions` 叠加成
  双后缀 ⇒ DSH 部署面此前**无法使用 OpenAI Decisions**。两处都随原值透传消失。
- **迁移（部署面必读）**：今天**依赖桥补 `/systemone`** 的自建反代部署需要改——在配置页显式填
  完整端点（如 `https://host/v1/systemone`；若反代只认 `/systemone`，把反代路径改成
  `/v1/systemone` 更干净）；`…/compatible-mode/v1` 与已带 `/systemone`／`/decisions` 的值
  **行为不变**；`http://localhost:8008` 这类标准 System One 端点升级后补成 `/v1/systemone`（旧桥
  缺陷修复；服务本就只认该路径，一般无需改）。完整对照表、判断口径与**宿主重启要求**（改的是桥
  进程内逻辑，已加载的 DSH 宿主需重启或重新加载 bundle）见
  [docs/DECISION_SERVICE_CONFIG.md](docs/DECISION_SERVICE_CONFIG.md) §7.1；接口层一句话说明见
  [docs/AGENT_INTERFACE.md](docs/AGENT_INTERFACE.md) §3.1。
- **EP lane 收窄为机制**：`tools/verify-decision-endpoint-parity.ts` 白名单 18 → **0 条**（族定义
  保留为回归语义说明）；负向自测改为「只改一面」的突变器（桥注入值污染 / 桥回退补 `/systemone`
  含 OpenAI 双后缀面 / 桥注入面引擎解析改道）——两面共用同一个引擎归一化器后，改引擎本身不再
  造成分歧，灵敏度靠一面改道钉住。`--self-test` 9/9 绿；`npm run check`、`verify:lanes` 17/17
  全绿，`bridge:test` 18/18。
- **配置页文案同步（纯文案、零行为）**：`integrations/dsh-bridge/client.js` 的
  `modelBaseUrlHint`（en/zh）与页首 `hint` 改为「端点原值透传、引擎决定协议与后缀、应填完整端点」，
  `client-root.js` 经 `scripts/client-root-sync.mjs` 重新生成（生成物同步）；桥 `README.md` /
  `README.zh.md` 的「Decision model URL」行同步。`locale/{en,zh}.json` 未动（meta 描述与端点语义无关）。
- **不变**：CLI 直跑与其它配置层叠面（本来就走引擎归一化）；空的 URL（仍=本地模型）；
  桥三件套的键名与 `decisionProvider` 自动选择规则。

## [Unreleased] — 2026-11-24 RV defect 收口：agent 视图工具步重复行/索引空间修复（行为变更）

> 承接同日 `verify:run-view-parity` lane 登记的 6 条 defect（工具步在 agent 视图重复登记、
> 两处 index 空间不一致）。本批改投影行为 + 收窄白名单，并清掉一条阻塞未用声明清理的 TS6133。
> **未提交 git。**

- **行为变更（CLI `amber run --json` 的 `steps[]` / `failure.step`）**：`src/app/agent-view.ts` 的
  `agentStepViews` 对 **flow 产物**不再把 `toolSteps(result)` 叠加到 `traceSteps(result)` 之上——
  `step_traces` 本来就是 flow 的唯一步表（`app-runner` 的 step 事件过滤含 `run`/`dangerous`，
  `ctx.run` 每调一次即一行），`tool_steps` 是同一批工具步按**工具序号**编号的第二份投影。
  修复前同一个工具步在视图里出现两行（`index` 都是 1、status 一个 `refused` 一个 `failed`），
  步数 3（桥 2）、失败步号 1（桥 2）。修复后：
  - `steps[].length` 与桥 `summarizeRun` 的 `steps[]` 同表同源（同一次调用同一个 **1-based
    step_traces 调用序**），含工具步的 flow 运行步数**少 1 行/每个工具步**；
  - `failure.step` 与桥一致（本仓库场景里 1 → **2**）——消费方若按旧值定位步表请按 `desc`/`stop_code`
    复核，或读 `artifacts.result_json` 的 `step_traces`（0 基调用序，未变）；
  - 工具步的 refused/failed **分类不丢**：拒绝原因从 trace 行的事件 `result.refused` 取，该行
    `status="refused"` 且 `stop_code`/`obstacle` 都是拒绝类别（旧口径由被删的重复行提供）。
- **不变**：声明式（journey/plan 源）产物仍是 `subgoals` + `tool_steps` 两张表合并（两张表互不含对方）；
  `agentRunStatus` 的 blocked/refused/failed 判定（仍读 `tool_steps`）与 `ok`/`verified` 语义不变；
  `step_traces`/`tool_steps`/结果 JSON 与报告产物逐字节不变（只改**模型可见视图的投影**）。
  flow 产物的 `tool_steps` 恒由同一批 trace 事件投影而来（`app-runner` 无条件写 `step_traces`），
  所以不做"两张表叠加"的兜底分支；声明式产物才合并两张互不含对方的表。
- **RV lane 收窄为纯 tripwire**：`tools/verify-run-view-parity.ts` 已知差异 **10 → 4 条**（defect
  **6 → 0**，只剩 4 条 audience：refused/failed 工具步折叠进 `blocked` vs `failed`、agent 侧
  `failure.obstacle` 带拒绝类别、dry 无调用序列）；新增**逐行步号断言** `steps.indices`（行数一致时
  两侧 `steps[].index` 必须逐行同源：重号/跳号/两套 index 空间即红）与 2 条负向自测（工具步重复行
  回归、行数不变但步号错位），负向自测 **5 → 7 条**。修复后白名单过期判红仍生效（差异消失即
  要求再收窄），灵敏度由新断言兜住。
- **顺手清阻塞项**：`tools/verify-run-view-parity.ts` 删掉未用局部 `firstFailure`（TS6133）——
  它是 `tsconfig` 开 `noUnusedLocals`/`noUnusedParameters` 时该文件唯一的一条诊断；删除后
  `npx tsc --noEmit --noUnusedLocals --noUnusedParameters -p .` 对该文件 0 诊断（全仓库未用清理另批）。
- **回归**：`node --experimental-strip-types tools/verify-run-view-parity.ts` 绿（13 场景，已知差异
  4 全按登记值命中，白名单过期 0，新差异 0，负向自测 7/7）；`npm run typecheck` / `npm run maintain:check`
  / `npm run golden-manual` / `npm run check` exit 0；`npm run verify:lanes` **17/17**；
  `verify:pilot` **21/21**；`verify:runtime:offline` **8/8**。
- **未做（登记）**：agent/桥两面的 `status` 分支口径（refused/failed 工具步 ⇒ blocked vs failed）
  仍是 4 条 audience 差异，把两个面的分支判定统一（`blocked[]`/`refused[]`/`failedTools[]` 三分类
  进 agent 视图）需要改 `AgentRunStatus` 的消费面语义，另批。

## [Unreleased] — 2026-11-24 结构/证据批（QW+SC+EP+RV，讨论项续做）

> 用户「全部开始」后并行落地四批；硬约束同前（不改外部行为/公开契约、不引入依赖、原测试全过）。
> **未提交 git。**

- **QW 快速赢**：新增 `bridge:typecheck`（本地/部署，不入 check）；`prompt-hit` 增文档断言
  （APP_SCRIPT_AUTHORING 停因表码 ⊆ STOPCODE_MEANING、已删 API 名零出现，先红后绿）；
  4 处 JSON.parse 包 try（失败点名 path）、2 处冗余 `as any`、getAuditor 半配置降级加 stderr 证据、
  桥 `save:true` offset 上限文档；**2.0.x 弃用窗口**登记（picker-server/src/index.ts 保留至 2.1.0）。
- **SC 会话闭集单源**：新增 L0 `src/support/session-contract.ts`（引擎 op 全集含 internal `mark`、
  桥 op 含 bridgeOnly `list`、act/driver/cmd/tab/窗口/idle 界等）+ `tools/session-contract-gen.ts`
  （`--write`/`--check`，与引擎契约逐值交叉校验）+ 桥 `session-contract.generated.ts`；
  桥 `session.ts`/`index.ts` 闭集与数值界改由生成常量派生。**逐字节等价证据**：工具 schema
  （10 工具/45,282 bytes）与 session 请求线（34 JSONL + 4 argv，24,553 bytes）pre/post sha256 全等；
  负向注入一字节漂移被判红。`session-contract:check` 已入 `npm run check`（生成物一致性）。
- **EP 决策端点 parity lane**：新增 `verify:decision-endpoint-parity`（33 样本×协议开关=40 case），
  登记桥注入面 vs 引擎唯一协议点的 **18 条差异白名单**（2 族：`missing-v1` 14 条——桥注入裸 host
  时实际 POST `…/systemone` 而引擎直跑补 `/v1/systemone`，含文档推荐的 `http://localhost:8008`；
  `bridge-forces-systemone` 4 条——桥无条件补 `/systemone` 导致 DSH 部署面无法使用 OpenAI Decisions）。
  lane 作 tripwire：新差异/白名单过期均 exit 1；建议后续批桥改原值透传（本批不改行为）。
- **RV run 视图 parity lane**：新增 `verify:run-view-parity`（13 场景，0.4s），登记 10 条已知差异；
  **新发现 defect**：`agent-view.ts#agentStepViews` 把 `traceSteps` 与 `toolSteps` 叠加，同一工具步
  出现两行且 index 空间不一致（agent 3 行 vs 桥 2 行）；audience 差异 4 条（refused→blocked vs failed 等）
  属呈现口径，建议后续统一并单独立项修重复行。
- **回归**：`npm run check` exit 0（含 session-contract:check、bridge:test 18/18、run-parity 16/16）；
  `verify:lanes` **17/17**；新增三 lane 全绿；`verify:pilot` 21/21、`verify:runtime:offline` 8/8、
  parity/session-close/decision-context/characterization/golden-manual/run-execution/offline 全绿。

## [Unreleased] — 2026-11-24 批次 QW：文档断言 + P3 失败路径 + 2.0.x 弃用窗口

> 硬约束：零外部行为变更（仅失败路径文案/证据、文档与注释）；门禁全绿后同批落地。

- **2.0.x 弃用窗口（用户确认）**：`picker-server`（`src/cli/picker-server.ts` + `npm run picker-server`）
  与 `src/index.ts` 的公开导出面在 **2.0.x 保留、2.1.0 移除**；窗口期内**不新增消费者**（新集成一律走
  `amber` CLI / DSH 桥），也不扩展两处接口形状。本批只落 CHANGELOG / 头注释 / BACKLOG / AGENTS 口径，
  **不删代码、导出或 script**。窗口期纪律与 2.1.0 删除清单见 `docs/BACKLOG.md` §21。
- **文档断言（先红后绿）**：`tools/prompt-hit.ts` 增两条 fail 断言——①`docs/APP_SCRIPT_AUTHORING.md`
  §10 停因表声明码 ⊆ `STOPCODE_MEANING`（工具步拒绝类别行 ⊆ `REFUSAL_LABELS`；表格末行「其它（如 …）」
  是不完全枚举，不参与）；②已删 API 名（`drive_step`）在 docs/桥工具描述中零出现——修
  `docs/AGENT_INTERFACE.md` 的 `drive_closed` 段（驾驶面 op 闭集只有
  `drive`/`drive_command`/`drive_status`/`drive_close`）。现有逐字句/overview 断言不受影响。
  负向自测：临时在 §10 加一条假停因码 → prompt-hit exit 1 并点名该码；删 `drive_step` 后转绿。
- **桥 typecheck**：`package.json` 增 `bridge:typecheck`（桥自有 `tsc -p integrations/dsh-bridge/tsconfig.json
  --noEmit`，本机 RC=0）；**不入 `check` 链**——CI 缺桥依赖（`integrations/dsh-bridge/node_modules`），
  只作本地/部署自检；`docs/BACKLOG.md` 桥 typecheck 条目按前提过期更新。
- **P3 失败路径/证据（零成功路径变更）**：4 处 `JSON.parse` 包 try，坏输入的失败文案点名 path——
  `TaskPlan.load`（plan 文件）、`readTrace`（trace 文件）、`src/online/case.ts` `readJson`（用例/站点文件）、
  `src/data/extract-ops.ts` 页内嵌 JSON（无文件可点名，点名变量 + 解析错误）。去掉
  `src/data/source-validate.ts` / `src/data/extract-ops.ts` 两处冗余 `as any`（可选链 + `||` 语义保持）。
  `src/engine/audit.ts` `getAuditor` 半配置（有 key 缺 base URL 等）降级 Mock 时打 stderr 证据，
  判定不变。`docs/AGENT_INTERFACE.md` 补 `save:true` 内部续页的 `offset ≤ 10000` 上限说明（桥不 clamp，
  起点 > 8000 且未到末页会以 `config_error` 收尾）。`tools/golden/splits/datasource-pure.json` 按
  manifest 纪律把有意改动的 `dateParams`/`jsonInScript` 两符号移出纯搬移清单（note 记原因，未重录 hash）。
- **验证**：`npm run bridge:typecheck` RC=0；`npm run check` exit 0；`npm run verify:lanes` 15/15；
  `npm run maintain:check` / `split:check` 绿。**未提交 git。**

## [Unreleased] — 2026-11-24 审查驱动优化批（A+B+C+D，用户确认后落地）

> 流程：四路只读审计（/tmp/{dead-code,dup-interfaces,comments-docs,tech-debt}-audit.md）→
> 分级清单+计划经用户确认 → 分 A/B/C/D 四批落地。硬约束：不改外部行为与公开契约、
> 不引入新依赖、原测试全过（含此前 3 条存量红 lane 归零）。**未提交 git。**

- **B1（P1 bug）**：`--record` 轨迹 WriteStream 挂 `error` 监听并永久降级（磁盘满/只读不再裸栈崩溃，
  `/dev/full` 复现：修前 exit 1 + Unhandled 'error'，修后 exit 0 + `record write failed` 日志 + 正常收尾）；
  `ctx.extract` 内联 `maxItems` 校验（非整数/超 [1,500] → `config_error`，与 offset 纪律一致，合法输入逐字节不变）。
- **B2（P1 契约漂移）**：桥 session signal 描述补全 13 算子（`css_count_equals`/`css_count_min`）
  并在 `prompt-hit` 增加「桥描述必须列全 SIGNAL_OPS」断言（先红后绿）；`drive_command.note` 落地——
  引擎校验（非空 ≤300）+ 单一 `driveCommandLine` 透传 + 进 pilot 自身 trace/record、不进响应/run 结果。
- **B3（P1 证据）**：strict-miss 路径 `rehydrate_rescan` additive 落盘（`run()` 作用域事实 →
  `RunReportTailCtx` → 报告尾；trace 优先、无 trace 行时退化字段；键仅在发生时出现；strict reason 尾缀）；
  新 lane `verify:rehydrate-rescan`（29 断言，A/B 负向对照）；BACKLOG #3 done。
- **C1（死代码）**：删 4 个零 importer 文件（299 行）+ 12 类死导出/死局部（≈560 行含级联孤儿）；
  split manifest 仅移除死符号条目+note，未重录 hash。
- **C2（注释/文档）**：修 3 条失效引用、清 52 行不可解析 `task-N`、27 行日期戳（保留格式示例）、
  5 行纯叙事；文档状态漂移 14 文件/54 处（ARCHITECTURE/MAINLINE/DCC/DPU/WITHIN/STATE_LAYER/
  IMPROVEMENT_PLAN/PILOTED/BACKLOG/README/AGENTS/SECURITY/INTERACTIVE）；split 钉住符号体内 11 处
  注释 deferred（重录 hash 需评审换基）。
- **D（小步收敛）**：`clipText` 单源（10 处，桥 2 份跨包保留；14,129 例等价）；`canonicalJson/sha256`
  单源（6,603 例逐字节一致，trace 保持 re-export）；`RangeValue`/`SetRangeOptions` type-only 单源；
  两个实验 env 开关登记 typed getter。
- **回归**：`npm run check` exit 0；`verify:lanes` 15/15；`verify:pilot` 21/21；
  `verify:runtime:offline` 8/8；`verify:parity`、`verify:session:close`、`verify:decision-context`、
  `verify:decision-characterization`、`verify:decision-run-parity`（check 内 16/16）全绿；
  maintain/comments 基线按只降原则更新（dateStamps 34→7、planTokens 403→341、history 64→60）。
- **明确未做（登记）**：桥闭集/session 表生成器与 handoff/ElementView 常量生成（大收敛，另批）；
  `src/index.ts` barrel 与 `picker-server` 公开面删除（需产品决定）；`model/page-context` 截断语义不同未迁；
  split 钉住符号体注释 11 处 deferred。

## [Unreleased] — 2026-11-24 证据面归零：三条存量红处置 + orphan lane script 标准化

> 依据：「`npm run check` + 全部零网络 lane 全绿」可宣称；**零 src 行为改动**——只动 lane 工具 /
> golden 基线 / npm script / lane 清单文档。

- **`verify:run-execution` 基线重录（存量红 1/3）**：干净 HEAD 跑 `--record`（每源连跑两次一致）后
  `--check` 双跑绿。三份 golden 换基、`suite` 不变，差异均为**基线落伍**而非新行为：
  ① 页面状态指纹元素数 `40`→`46`（8 处 `struct`，存量池面/状态面变化后基线未更新）；
  ② `plan` 轨迹里已不存在的 `identity` 解析证据对象（10 行，dead 字段）。
  lane 头注释补纪律：**池构成/排序/容量（窗口、帽）变更后须重录基线**。
- **`golden-manual` 锚点搬家修复（存量红 2/3）**：A1 拆分后路径 2/4 锚点已离开
  `src/app/app-runner.ts`。按符号定位改到 `promptManualOnTty`（`src/app/app-runner-policy.ts`）与
  `runManualStep` 的 `manual_handler_error: …` 原文模板（`src/app/app-runner-declared.ts`）；
  `--fix` 刷新 `tools/golden/manual-baseline.json`，话术原文逐字节不变、只换文件键。
  该 lane 是静态源码扫描（毫秒级，无浏览器），不是运行期证据。
- **`verify:offline` 比对口径归一化（存量红 3/3）**：`ref`（`e0…`）是抽池时按枚举顺序分配的
  位置性句柄——同一代码状态内分配确定（连跑两次 `--record` 逐字节一致），但抽池实现/枚举顺序
  一变就整体重排（实测：filter-bar 基线记录后的池面演进让 `e20`/`e21`/`e22` 三行只换编号、
  元素集合不变），不是页面/引擎行为契约。比对改为**元素身份视图**：`pool.rows` 去 ref、
  `hints.*.refs` 比顺序无关多重集、`match`/`decided` 解析 ref→身份、**保留 `ref_count`**；
  golden 仍存原始观测、两侧都在身份视图上比——**旧基线原样即绿，未重录任何 golden**。
  负向自测：改 `ref_count` / 换 `match` 身份 / 删池行 / 删候选身份均红；正例：refs 乱序、
  整池 ref 一致重编号均绿；另在隔离副本把 `POOL_CAP_ELEMENTS` 64→20（池帽变更）→ 2 个夹具红，
  证明检出没有因归一化退化。`--record` 仍存原始 ref（重录不会因编号漂移变红）。
- **orphan lane script 标准化**：9 条此前没有 npm script 的非门禁 lane 补 `verify:<lane>`
  （`act-lock` / `session-range` / `session-drive` / `poolless-actions` / `dedup-controls` /
  `frame-budget` / `app-stop-context` / `decision-accounting` / `decision-ask-parity`），逐条实跑
  exit 0；新增聚合 `npm run verify:lanes` 顺序跑本批证据面 15 条（三条修复 lane + 9 条新 script + 后续批次 3 条失败路径/校验 lane，
  不含较重的 `verify:runtime:offline`），任一红即停（本机实测 1m42s）。
  `tools/intervention-extensibility.ts` 是一次性脚本（死代码清理已登记删除），**不加 script**。
- **登记**：`AGENTS.md`「测试」节新增非门禁 lane 清单 + 命令块 `verify:lanes` 行；`README.md`
  「开发与贡献」与 `docs/MAINLINE.md` lane 表下各补清单/指针（脚本清单唯一出处仍是 `package.json`）。
- **验证**：`npm run check` 全绿（本机 2m20s，含 chromium 的 run-parity lane）；`verify:run-execution` /
  `golden-manual` / `verify:offline` 各连跑两次绿；9 条新 script 逐条 exit 0；`verify:lanes` 15/15 绿
  （本机 1m3s）。**未提交 git。**

## [Unreleased] — 2026-11-23 门禁：decision run-parity lane 纳入 npm run check（chromium 前置登记）

> 依据：决策上下文审计「第 1 项：证据/登记」的门禁化要求；只动门禁链/注释/文档，**零行为代码改动**。

- **新增 script**：`package.json` 增 `verify:decision-run-parity`（`node --experimental-strip-types
  tools/verify-decision-run-parity.ts --check`），并把该 lane 追加到 `check` 链末尾（`check:ci`
  自然继承）；16 场景 `ModelPickPhase` + 桩请求投影 + `windowChainFacts` + 停因逐字段对 golden。
- **口径变化（代价）**：`npm run check` 不再是纯离线——该 lane 需要本机 chromium
  （`npx playwright install chromium`）。本机实测：lane 单跑 ≈11.9s；`npm run check` 71.3s → 80.0s
  （同机连跑，增量 ≈8.7s，浏览器启动/机器负载波动同量级）。
- **chromium 缺失不假绿**：lane 入口把浏览器启动失败（`no chromium binary found` /
  `Executable doesn't exist`）归为环境错误，打印修复提示并 exit 2，**不 self-skip**；原有
  `--record` 拒绝与 `--rebase-reviewed` 评审换基纪律不变。
- **登记**：`AGENTS.md` 的 `npm run check` 行补「含 decision run-parity（chromium 必需）」；
  `docs/DECISION_PLANE_UNIFICATION.md` §4、`docs/P2_READINESS.md` §0/§5 同步代价与豁免。
- **验证**：`npm run verify:decision-run-parity` 16/16 绿；`npm run check` 全绿（80.0s）；
  `npm run typecheck`、`npm run maintain:check` 绿；**未提交 git**。
- **CI 前置同步**：`.github/workflows/checks.yml` 的 check job 原本只 `npm ci`（playwright 包无
  postinstall，npm ci 不下载浏览器）；本批在 `npm ci` 之后、`npm run check` 之前补
  `npx playwright install --with-deps chromium`，与同文件 offline/online job 的既有写法一致；
  只动 check job，其它 job 未改。

## [Unreleased] — 2026-11-23 决策平面证据补强（run-parity 评审换基 + characterization goals 投影）

> 依据：决策上下文审计「第 1 项：证据/登记」；只动 lane/金标/文档，**零行为代码改动**。

- **run-parity golden 评审换基**：`tools/verify-decision-run-parity.ts` 新增 `--rebase-reviewed`——
  逐场景算差异路径，仅当全部落在允许闭集 `$.asks[<i>].goal`（P1 的 run 面 L0 尾部「当前页」段，
  ADR-001 R3）才写新 golden，顶层加 `_rebase` provenance（原因 / 允许路径闭集 / 换基场景，不写
  日期戳）；任一非 goal 差异（含缺失/新增场景）拒绝并打印，golden 逐字节不变；`--record` 仍按
  设计拒绝（防自证保留）。换基 11 场景后 `--check` **16/16 绿**。负向自测：临时副本改
  `adjudicate.phase.conf` → 拒绝（exit 1，sha256 不变）；`--self-test` 覆盖「正例写入 / 非 goal
  拒绝 / 缺场景拒绝 / 拒绝零改写」四路。
- **characterization 钉住 L0/历史**：8 条 run/pilot 场景投影新增 `goals`（桩侧请求 goal 序列，
  按询问顺序，键序稳定）；新增 `run-two-step-history` 场景（同一次 run 两步）钉住
  `已执行: 1.click button "确认"[no_change]` 历史折叠。金标 11→12 场景；`--record` 两次逐字节
  一致（sha256 `2993590a…`）、`--check` 两次一致且绿。
- **登记/披露**：`docs/DECISION_PLANE_UNIFICATION.md` 增「证据覆盖与金标换基」小节（失绿原因 /
  换基机制 / 防自证保留 / 剩余未钉住维度）；`docs/P2_READINESS.md` 增 freeze 超口径豁免登记
  （seam v6、默认路径切换、session `set_range`、关键 bugfix、证据 lane 逐项书面豁免）；
  `docs/DECISION_CONTEXT_CONTRACT.md` 只补状态/证据备注（契约条款语义未改）。
- **验证**：`npm run typecheck`、`npm run maintain:check`、两 lane `--check` ×2、`npm run check` 全绿。
  **未提交 git。**

## [Unreleased] — 2026-11-24 drive 结束态可见性 / 交接回显批（架构审查 §3.3/§2.2）

> 依据：drive 对照走查的三条修复项经架构审查（/tmp/drive-fix-review.md）；本批为 evidence-only
> 可见性与交接语义回显，不触 freeze D1-A 名单。

- **结束态可见性（evidence-only，不判错/不阻断/不新增停因）**
  - `PilotHandoff.weak_picks?`（≤6）：只收 `picked_by==="model"` 且 `conf < DEFAULT_CONF_FLOOR(0.25)`
    的票面事实 `{step,target,conf,picked_by}`；阈值单源 config-schema，取最近 6 条；无票键不出现。
  - `PilotHandoff.final_signal?: null | 摘要`：`null` = 本 run 无完成信号声明（结束态未验证；
    needs_value/budget_exceeded ≠ 做完）；有声明给 ≤200 字有界摘要。
  - `pilot_end.conf_floor`：有效置信刻度（provider 自报 floor 时如实透出），区分"文档默认 0.25"与
    "本次实际过闸线"。
  - 投影链：引擎 handoff 顶层 → `session-driver.projectHandoff` → 桥 `driveHandoff` 白名单
    （step/target≤120/conf/picked_by，不泄露 pool）→ Agent；`PILOT_END_KEYS`/`driveSummary`
    加 `conf_floor`。纯函数 `weakPicksFrom`/`finalSignalFact` 在 `pilot-evidence.ts` 单源。
- **handoff 再 drive 不再静默复用**：`SessionPilotDriver.drive()` 在 `handoffOpen!==null` 时
  **不再 step**（避免同一交接重放/新 goal 被忽略却 ok:true），回执 `ok:false, code:"handoff_open"`
  + `reused:true`/`goal_ignored` + `handoff_open{step_id,stop_code,goal_digest,summary,url,
  what_would_unblock,evidence_refs}` + `next`（继续=drive_command / 换目标=新 session）；
  非 handoff 复用（agent await_pick 等）保留原行为，仅新增 `goal_ignored`。
- **验证**：verify:pilot 20→**21/21**、bridge:test 15→**18/18**、verify-session-drive 4/4、
  check（含 run-parity 门禁）exit 0；行数 pilot-runtime **788≤800**（`validatePilotOptions` 搬
  pilot-contract 抵消）。**未提交 git。**
- **语义变更**：drive-while-handoff 由 `ok:true`（静默再驾驶）变显式 `handoff_open` 失败，已文档化+
  测试钉死；桥 `session.ts`/`index.ts` 已 tsc 构建，**宿主重启后生效**。
- **未做**：真站 S3 复跑（本环境无外部决策服务）；规则词面过宽（Hours→Open 24 hours）与
  actOnce state_delta 按审查另立 P3 任务；needs_value 键漂移加固（name/id 稳定键/M2）待评估。

## [Unreleased] — 2026-11-24 drive 值绑定与终态诊断修复批（真站走查对照驱动）

> 依据：决策模型 drive 对照走查（报告 /tmp/drive-walkthrough-report.md）后经架构审查
> （/tmp/drive-fix-review.md §1/§2）判定的引擎/契约缺陷；均落 src/app 的 pilot/session 面，
> 不触 freeze D1-A 名单。

- **drive resume 值绑定（P0）**：裸字符串 `resume{value}` 不再写永远不可达的 `slots["resumed"]`，
  改为写入 needs_value 目标键（无 hint/target 时由 `valueKeyOf` 按 label→name→id→tag 推导），
  hint+value 时值跟随 hint 目标；空键不再参与 includes 匹配（修空 label 误绑）。
  `drive_command.target` 全链透传（session-driver → 契约校验 → 桥），文档承诺的"键取 target"可达。
  handoff evidence 增 `needs_value:{target,key,ref}`、`resume_hint:{hint,missed:true}`（仅对应停因，不含值）；
  needs_value 首条 unblock 给出可照抄的 `{"<key>":"<值>"}` 形状。
  验证：verify:pilot 16→20/20；真站 Google Maps 搜索框裸字符串 resume → 值真实落地（`read input[name=q]`）。
- **drive 终态诊断（P1）**：`SessionPilotDriver.command()` 对终态 resume/redirect 复用终端分类——
  `drive_terminal`（done/final_signal_held 等）或 `budget_exhausted`（预算用尽），带顶层 reason/stop_code/outcome；
  stay 分支把嵌套 reason 提升到顶层；桥在顶层 reason 为空时回落 command.reason；文档补 code 语义与 next。
  修复前：`config_error` 且 reason 空。验证：verify-session-drive 3→4 场景 + bridge:test 13→15。
- **回归**：typecheck/maintain/split/verify:pilot 20/20/verify-session-drive 4/4/bridge:test 15/15/
  parity/check 全绿。**未提交 git。**
- **已知边界**：桥面 target/reason/schema 改动需 DSH host 重启才生效（引擎侧经 CLI 子进程即时生效）；
  同一控件两次抽池 label/name 形状可能漂移（"Search Google Maps"→"q"），裸字符串值需按最新 handoff 重发
  （稳定键/签名回放留待后续小批）。

## [Unreleased] — 2026-11-23 走查卡点修复批（架构审查 B1-b/B1-c/B3-c + 证据 lane）

> 依据：Google Maps 走查四类卡点架构审查（/tmp/architect-review.md，含 Lead 复核修正 §8）。
> 冻结口径：fill→click 属关键 bugfix；去重豁免/池外投影为恢复链既有面的补全（MAINLINE §4 备注）；
> frame-budget 为零行为证据 lane。

- **池外回退按 op 分派**（修 fill/select/hover 被静默变 click）：`actOnce` 的 `el===null` 分支改走
  新模块 `src/engine/executor-poolless-ops.ts`（fill/select/hover 真实执行；drag/clickAt/upload 等
  结构化 `action_unsupported`；click/check 行为逐字节不变）；A3 回退面补 `name`/`href`/`href_full`
  投影（`DOM_FALLBACK_COLLECT_JS` + 合成池映射 `a3AttrProjection`，`[name=q]` 类池外 attr 目标可命中）。
  验证：`tools/verify-poolless-actions.ts` 19 断言（修前 11 FAIL → 修后 19/19）。
- **F86 去重空名可编辑控件豁免**：`__DEDUP_EDITABLE_TAGS = {input,select,textarea}`——空 label 不再
  按装饰剔除（`label-dup`/`listener-child` 规则不变；空名 a/button 不豁免并注明理由）。
  验证：`tools/verify-dedup-controls.ts` 48 断言（三件控件进池 + 空名图标仍被剔 + 证据形状）。
- **session act 新增 `set_range` op**（复用 `range.ts` 三策略）：`SESSION_ACT_OPS` + 校验（`{value}`/`{percent}`
  二选一、缺/非法 = config_error）；执行体 `src/app/session-act-range.ts`；桥 schema `act_op` enum +
  value oneOf（passthrough 13/13；**需 DSH host 重启生效**）。越界结构化 `value_out_of_range` 不钳制
  不伪造。验证：`tools/verify-session-range.ts`（值/percent/越界/形状错误四路径）。
- **帧预算证据 lane**：`tools/verify-frame-budget.ts` + `fixtures/engine/frames/`——量化 act 池帽 64
  （主帧优先 ⇒ 子帧 0 行）与 snapshot 帽 120（子帧可见 `f1:e0 Cancel`）差异，与真站
  `s-cHKnOQq8Ab`（actions i=38 target_not_found + pool-27 有 Cancel）互证；`docs/BACKLOG.md` #6
  更新测量结论与修复方向（fail-path 有界子帧重扫优先）。
- **回归**：typecheck/maintain/split/check 全绿；pilot 16/16、parity、runtime:offline 8/8、
  characterization 双臂 11/11、decision-context 76 项、bridge:test。已知无关漂移：`verify:offline`
  filter-bar golden（e20 vs e22）在 pristine HEAD 同样复现，属存量基线问题，待单独 triage。
  **未提交 git。**

## [Unreleased] — 2026-11-23 决策平面统一 P3b（收口）

- **契约 v6**：`DECISION_ASK_CONTRACT_VERSION` 6；新增 question kind 闭集
  `DecisionQuestionKind = "pick" | "risk" | "done"`；`docs/MAINLINE.md` seam 表登记 run 选择段
  默认统一编排（`decision-pick-unified.ts`）与 phase A/B 对照臂。
- **risk/done 访问面收口**：新增 `src/engine/decision-questions.ts`（`askRiskProvider`/
  `askDoneProvider`），executor 的 risk/done provider 直调改经该单点；capability 判断与降级/
  advisory 语义不变（风险头挂退回关键词规则、完成票缺失按 0 读）。
- **验证**：`npm run check` + 全部决策平面 lanes 绿；`online/` smoke **7/7 passed**（6.8s），
  core 10 passed / 1 failed（`wiki-en-search` 因本机决策源 403 AccessDenied.Unpurchased 退规则面，
  属环境权益问题，非代码回归）。**未提交 git。**

## [Unreleased] — 2026-11-23 决策平面统一 P3（选择段）

- **统一编排入口**：新增 `src/engine/decision-pick-unified.ts`——规则/窄问/闸门（恢复阶梯）/
  裁决/R2b/族修复/组装单源；`decision-pick-phase.ts` 缩为旧编排对照臂（152 行），
  `AMBERFLOW_DECISION_LADDER=phase` 切换；新增执行臂 `decision-pick-arm.ts`，`executor.run`
  默认走统一入口（只调 `runPickPhase`）。
- **A/B 等价**：`verify:decision-characterization` 默认臂与对照臂**双跑均 11/11 金标一致**；
  `verify:pilot` 16/16、`verify:parity`、`verify:runtime:offline` 8/8、`verify:decision-context`
  76 项、`npm run check` 全绿；maintain 五组通过。
- **未纳入**：risk/done question-kind 统一 + `DecisionAsk` 契约 v6/MAINLINE seam 登记（下一批
  P3b），随后跑 `online/` 用例测试。**未提交 git。**

## [Unreleased] — 2026-11-23 决策平面统一 P2（ADR-001）

- **低置信恢复阶梯迁入 DecisionAsk**：`runWideReobserve`（宽扫 + 窗口递增）/`runEscalatedPick`
  （升级票）/`askPick`/`askGoalOf`/`forbiddenOf` 从 `decision-pick-phase.ts` 逐字搬入
  `src/engine/decision-ask.ts`，新增 `runRecoveryLadder` 作为唯一编排点；phase 的 `floorGate`
  只调该入口，规则/闸门前置/停因/裁决/R2b/族修复编排仍留在 phase（P3 迁）。
- **等价证据**：`verify:decision-characterization` 11 金标（含 `run-wide-reobserve`/
  `run-escalate`）在搬移后逐项一致；`verify:pilot` 16/16、`verify:parity`、
  `verify:runtime:offline` 8/8、`verify:decision-context` 76 项全绿；`decision-pick-phase.ts`
  584→476 行（净减 108）且 maintain 五组通过。**未提交 git。**

## [Unreleased] — 2026-11-23 决策平面统一 P1（ADR-001）

- **L0 同源**：`drivingGoalText` 从 pilot 层迁到引擎 `src/engine/decision-goal-text.ts`（pilot 侧
  re-export，导出面不变）；run 面 `decision-pick-phase` 的**模型询问** goal 改为
  「instruction + 当前页 + 已执行」（步史由 trace 的已执行行折成，沿用 changed/no_change/failed
  口径）；规则匹配/词面判据/升级建议仍用原 instruction。
- **run 面接 DecisionAccounting**：executor 每次 `run()` 创建 attempt 账本
  （`createRunDecisionAccounting`），phase 的禁选经 `forbiddenRefs` 单源消费（与 `run.forbidden`
  等价）；记忆注记仍走执行器 rank 注记（P2 统一）。
- **context.layers 回执**：`decision-ask.contextLayerReceipts` 对外单点；run 面每次模型询问记录
  L0–L4 逐层回执，经 `attachDecisionContext` 挂到该步 trace 行 `context_layers`（无动作的停因不写）。
- **lane**：`verify:decision-context` 的 D 组改为「两面 L0 文本同源」（当前页/已执行同渲染），
  新增 F 组（直接 `mw.run` 断言 trace 回执五层闭集、L0/L1 = sent）；76 项断言全绿。**未提交 git。**

## [Unreleased] — 2026-11-23 决策平面统一 P0（ADR-001）

- **裁决**：新增 `docs/DECISION_PLANE_UNIFICATION.md`（ADR-001）——`DecisionAsk` 为唯一决策
  询问入口，P0–P3 分层落地；`decision-pick-phase` 在 P2 前保留为对照臂。
- **P0 已落地**：新增 `src/engine/decision-request.ts`（`buildChoiceRequest` /
  `mergeSiteFactsNotes` 单点，executor 改用，行为逐字节不变）；`system-one-client` 的 notes
  通用上 wire（此前只在含 `site_facts` 时挂载，普通负面注记被静默丢弃；空 notes 形状不变）；
  `DecisionAsk` 消费 `ports.siteFacts` 并计入 L4 回执；pilot 面注入 L4 端口（按 hosts 匹配
  site-facts，无命中不出现键）；`stateText`/`pageText` 搬移到 `src/engine/state-text.ts` 并新增
  `AMBERFLOW_STATE_TEXT_SCOPE=wide` opt-in（默认取文逐字节不变；wide = 追加未 detach 子帧 body 文本；extraction 行数回落）。
- **验收**：本地 mock 抓包自证（notes 首问无/次问有、siteFacts→L4 sent、wide 取文）；新增
  `npm run verify:decision-context` 镜像 lane（70 项断言全绿，含 E 组 wide 子帧取文）；既有 lanes 与 `npm run check` 见批次收口。
  **未提交 git。**

## [Unreleased] — 2026-11-23 移除桥面 `amberflow_pilot`（agent 走查收敛到 session drive）

- **删除**桥面 `amberflow_pilot` 工具及其服务 `integrations/dsh-bridge/src/pilot.ts`：one-shot
  调用每次起**独立浏览器**、无登录态/cookie，真实站点极易撞登录墙，且与 `amberflow_session` 的
  drive 系列 op 重复。agent 侧走查统一走 `amberflow_session` 的
  `drive/drive_command/drive_status/drive_close`（同一 session 子进程/同一 page，跨调用保状态，
  可先带登录态再驾驶）。
- **连带清理**：`PILOT_TOOL_*` / `PILOT_ARGV_FIELDS` / `BridgePilotArgs` 从生成契约
  （`src/support/run-args-contract.ts` + `tools/run-args-gen.ts` + `run-contract.generated.ts`）
  移除（`run-args:gen` 重新生成、`run-args:check` 绿）；桥面 `pilotArgs`、pilot 单测与 fake-engine
  pilot 分支删除；桥面工具总数 −1。引擎 `amber pilot` CLI 保留为开发/验收入口（`verify:pilot`
  仍走引擎面），不再是 agent 面入口。
- **文档**：`AGENT_INTERFACE.md`（桥表删行、§3.3 改为「agent 面经 session drive」）、
  `APP_SCRIPT_AUTHORING.md`、`PILOTED_WALKTHROUGH_PLAN.md` PW3 第②项标注已替代。
- **验收**：`npm run check` 全绿（含 run-args:check / bridge:test / prompt-hit）；`verify:pilot`
  16/16、`verify:parity`、`verify-session-drive` 不回归。**未提交 git。**

## [Unreleased] — 2026-11-23 共享会话：session 子进程托管 pilot 驾驶（pilot/session 同页互证）

- **形态（按项目决定）**：host 复用现有 `amber session` 子进程；**不新增 daemon、不新增 CLI 命令、
  不新增桥工具**。
- **引擎**：`PilotRuntime` 增 attach seam（`sessionFactory` / `ownsSession:false` /
  `skipStartNavigation`；attach 起步不 goto、校验 hosts 信封、`started.attached:true`，
  `closeBrowser` 不关宿主）；新增 `src/app/session-driver.ts`（`SessionPilotDriver`：附着式 pilot
  + 捕获 sink + `session_id` join key + 有界 events/handoff + `drive_terminal`/`drive_closed`）；
  `SESSION_REQUEST_TYPES` 增 `drive/driveCommand/driveStatus/driveClose`（goal/max_steps/driver/
  cmd/conf_floor/final_signal/slots 校验；final_signal 复用 `validateSignalSpec` 同一口径）；
  session 子进程内驾驶与 `act/observe` 共用同一 page（停驶在交接处，人工补步后 resume——
  **切换互证**）。
- **桥面**：`amberflow_session` 扩 4 个 op（op 名沿用既有 snake_case：`drive/drive_command/
  drive_status/drive_close`，映射引擎 camelCase 请求类型），参数校验 + 有界白名单投影（不回
  池/候选/槽值/DOM）+ 既有 engineFailure 同源失败面；工具数保持 4 个；`amberflow_pilot` one-shot
  不变。
- **行数/平台**：`session-runtime.ts` 的 `tab` 处理 99 行纯搬移到 `src/app/session-ops-extra.ts`
  （1018→929，driver 接线后 948 ≤ 基线）；`tools/verify-session-close.ts` 进程枚举跨平台化
  （win32 `tasklist` 逐字保留，POSIX `ps`）。
- **验收**：`npm run check` exit 0；`npm run verify:pilot` **16/16**；新 `tools/verify-session-drive.ts`
  零模型三场景全过；`npm run bridge:test` **14/14**（新增 4 条 drive 用例）；新增
  `tools/verify-parity.ts`（`npm run verify:parity`）：同 fixture 三腿 run/session/pilot 步级对照
  （ref/how/changed/落地 URL/池计数/规则档/零模型）全绿；真站同一 session 内
  model 驾驶 Google→Maps 2 步 `final_signal_held`（`model_asks=2`），停驶后 session `observe`
  同页可用；桥级 E2E（真实 `SessionManager` + 真实 `amber session` 子进程）
  `drive→await_pick→observe→resume→done→session read/act→drive_status→drive_close→session 仍可用
  →close` 全绿。文档同步 `AGENT_INTERFACE.md`/`INTERACTIVE_SESSION.md`。**未提交 git。**

## [Unreleased] — 2026-11-23 pilot 驾驶上文与执行身份（1/2/3 三项）

- **驾驶上文（任务3）**：`drivingGoalText` 的步史从"已完成: 1.<label>"改为
  "已执行: 1.<label>[changed|no_change|failed]"（只记已执行 + outcome，no-op 点击不再伪装进展），
  并把 `当前页: <url>` 与（声明时）`期望页: <expectUrl>` 并入驾驶问句（每步 ≤40 字/≤6 步/URL ≤120）。
  新增 `--expect-url <子串>`（桥 tool `expect_url`，契约走 `src/support/run-args-contract.ts` +
  `run-args:gen`）：每轮驾驶前当前 URL 不含它 → 确定性停 `off_task_page`（退出码 3），
  handoff 证据带 `expect_url`，解锁建议给 redirect 回任务页；`started`/`pilot_end` 回显
  `expect_url`。`PILOT_STOP_CODES` 8→9。
- **frame 准入显式信号（任务1）**：pilot 每轮抽池后投影 `frames_excluded:[{origin,index}]`
  （≤6）进 handoff 证据；`unblockHintsFor(stop, {framesExcluded})` 把"把 origin 加入 hosts
  后重试"放第一条（仍 ≤3 条）。桥面 `amberflow_pilot` 的 started/handoff 投影同步透传
  `frames_excluded` 与 `expect_url`（其余字段/键集不变）。走查实测：Google 九宫格是
  `ogs.google.com` 跨源 iframe，默认 hosts 只含 `www.google.com` 时元素不进动作池 → 旧路径
  只报 `target_not_found`/`low_confidence`，现在根因显式可解。
- **决策 ref 执行锁（任务2）**：`actOnce` 增 `opts.lock?: ActLock = {pool, ref, sig}`——决策面
  已按池 ref 选中元素时，执行面按同一轮抽池的身份定位（`sigEq(esig)` + `data-dshref` 活章
  复核 + `_locatorFor`），四证全过才执行（`resolved_via:"ref-lock"`，additive）；任一不成立
  回退既有 `_resolveOne` 全链、零新 stopCode。修复同名重复候选（两个 `"4.5"`）把高置信
  ref 票打成 `target_ambiguous` 的浪费；pilot `executePicked` 已接线并把 `resolved_via` 写进
  drive 记录/事件。`actOnce` 行数 183 ≤ movedFunctions 基线 184（无增长）。
- **验收**：`verify:pilot` **15/15**（旧 12 + 驾驶上文/`off_task_page`/frame 排除三场景）；
  新增 `tools/verify-act-lock.ts`（4 PASS + 1 INFO，零模型/零外部请求）；`typecheck`、
  `maintain:check`、`run-args:check`、`verify-runtime-offline --check` 8/8、
  `verify-offline` 11/11 绿。文档同步：`docs/AGENT_INTERFACE.md` §3.3（9 码/expect_url/
  frames_excluded）、`docs/APP_SCRIPT_AUTHORING.md` §0.5、`docs/PILOTED_WALKTHROUGH_PLAN.md`
  §PW2/§3。**未提交 git。**

## [Unreleased] — 2026-11-22 S3 完整 + S2-Stage-3（旧实现退役）

- **S3 完整**：`ProviderCapabilities.context?: "none"|"minimal"|"full"`（只声明不改协议）；本地 laya=minimal、
  decision-service/OpenAI Decisions=full、baselines/scripted-stub=none；`decision-ask` 逐层回执按声明档裁剪
  （`none/minimal`→L3/L4 `unsupported`；`full` 未接端口→`absent`；段校验不过→`rejected` 但不 abort）；
  `buildMiddleware({options.decisionAskPorts})` 组合根注入；`amber doctor` 增只读
  `decision context: provider/context/state_digest`；新 lane `tools/verify-decision-context.ts` **47 断言**全绿。
- **S2-Stage-3（旧实现退役）**：先 `--record` 旧臂 16 场景 → `tools/golden/decision-run-parity/cases.json`（两遍一致）；
  再删旧 `runModelPick`（`executor-phases-b.ts` 607→196；`src/` grep 为空）；`--check` 新臂单腿对 golden
  **16/16 零差异**；退役后 `--record` 拒绝（防被检实现自证）；`executor.ts` 直连 `runDecisionPick`（`run()` 883 持平）。
- **baseline 维护（未做，登记）**：`--update` 接受合法下调 + 专门提交删除死 `phaseFunctions` 条目 + 复跑 maintain。

## [Unreleased] — 2026-11-22 S2：run 选择段搬移拆分 + 调用点切换（阶段对照 16/16）

- **S2-Stage-1（搬移+拆分）**：新增 `src/engine/decision-pick-phase.ts`（536 行、13 helper、最大 54 行），
  把 `runModelPick` 的 8 个分支（规则/窄问/停因/闸门/宽扫+窗口链/升级/裁决/R2b/族修复）等价搬移并拆分；
  `executor-phases-b.ts` 仅 +1 行 re-export，旧实现原样保留为对照臂。
- **阶段对照 lane**：`tools/verify-decision-run-parity.ts` —— 16 场景 × 旧/新两臂逐字段对照
  （`ModelPickPhase` 全字段 + 桩请求投影 + `windowChainFacts` + `rejectedAskConfs` + `warnings` + 停因
  code/reason）**16/16 零差异**；内置 `--self-test` 负向自测（phase.conf / 候选数 / windowChainFacts /
  停因 reason 四类扰动均被抓住，证明对照非空）。
- **S2-Stage-2（调用点切换）**：新增 `src/engine/decision-pick-host.ts`（126 行、纯 `import type`、engine 不
  import app）把 executor run 上下文折成 `RunPickHost`/`RunPickCtx`；`executor.ts` 仅 5 insertions/4 deletions，
  `run()` **持平 883 基线**、文件 2785→2786；旧 `runModelPick` 标 `@deprecated`。切换前后 `verify:pilot`
  12/12、`verify:decision-characterization` 11/11、`verify:runtime:offline` 8/8、parity 16/16 **逐字一致**；
  `npm run check` exit 0。
- **S2-Stage-3（未做，登记）**：parity 旧臂快照 golden → 删旧实现/re-export → `maintain --update` 移除
  `phaseFunctions` 例外 → 清理注释符号引用 → 复跑四条 lane。

## [Unreleased] — 2026-11-22 S0a 补齐 pilot-leg + S3 前半模型面白名单断言

- **S0a 补齐 `pilot-leg-lifecycle`（11/11）**：用 `PilotRuntime` 实测 leg 生命周期——leg 派生值 =
  **redirect 事件计数**（引擎无 leg 字段），golden 钉住 `legs:[0,1,1]`（初始 0 / redirect 后 +1 /
  resume 不变）与 3 次结构化停因（stub 弃权 → `low_confidence`）。`verify-decision-characterization`
  **11/11**（`--record` 两次一致）。
- **S3 前半：模型面字段白名单断言（`verify:model-face`，非门禁）**：用携带**全部 13 个采集期事实字段**
  的合成池断言 `modelProjectionOf` 的泄漏/过剥双检——13 字段全剥离、9 个核心字段全保留、输入池未被
  改写（纯函数）、干净行走快路径、`esig` 不受剥离影响；模型面键集合必须等于白名单（过剥也暴露）。

## [Unreleased] — 2026-11-22 S1 一期：引擎 ask seam 落地 + pilot 切面（双臂零差异）

- **引擎 `ask` seam（DC7 S1 一期）**：新增 `src/engine/decision-ask.ts` —— 把 pilot 当前 `modelVote` 语义
  搬进引擎：窄问（`host.extract` 自取池 + `filter` 剔无角色聚合容器）→ 账本 `forbiddenRefs`/`notesFor`
  （作用域策略由 `DecisionAccounting` 工厂绑定）→ floor 闸门（`gateOf`/`passesFloor` 单源上收）→
  低置信宽扫重问（宽池真变大才重问，`accounting.prune` 按 esig 平移）→ 弃权/命中；回执
  `executionPool` + `target{ref, sig}` + `signal{proposal, scoreKind}` + 逐层 `context.layers`
  （L0–L4，未注入的 L3/L4 如实 `absent`）。
- **pilot 切面**：新增 `src/app/pilot-ask-adapter.ts`（mw+PilotLedger → `DecisionAskHost`；pilot-leg
  作用域 + `noteRedirect()` 换 leg）；`modelVote` 改为委托 adapter（`modelVoteLegacy` 保留为对照臂，
  缺省注入时退回 legacy 防静默换语义）；`pilot-runtime` 净 +1 行（**800/800**）。
- **双臂对照 lane（非门禁）**：`tools/verify-decision-ask-parity.ts` —— 5 场景 × 3 臂（legacy / ask /
  新路径）确定性 stub 对照（请求投影/返回投影/ref/conf/shape/via/asked/执行池 ref 序/命中 sig），
  **零差异**；首现差异逐条打印并 exit 1。
- **已知差异（记录在案）**：ask 内部重新抽一次池（S1.1 用 executionPool 复用消除）；宽扫重问的
  notes 按宽池重算（legacy 复用窄池 notes，属改善）。
- **S1.2 留口**：escalate/adjudicate/R2b/族修复/窗口升级、`tieredHint` 窄问、`rules_first`、`limit`、
  `stepTimeoutMs` 硬约束、L3/L4 段与 ports、跨作用域 memory。
- 验收：`verify:pilot` 12/12、`verify:decision-characterization` 10/10、`verify:runtime:offline` 8/8、
  `verify-decision-ask-parity` 5/5 零差异、typecheck/maintain/`npm run check` 绿。

## [Unreleased] — 2026-11-22 决策 characterization 扩面 + verify:offline 基线结案

- **S0a 二期 characterization 场景（4 条新增，共 10 条）**：`run-escalate`（`decision_kind=escalate`/`method=escalate`/不产生第二次 provider 询问）、`run-family-repair`（族不符 → `nominated_family_empty` 或 `nominated_family_repair`）、`run-r2b`（`conf∈[floor,0.9)` + 提名与指令词面零重叠 → 第二次宽扫，池 64→100，**按 conf/重叠判定进入条件**而非 method）、`run-retry-memory`（同一 `OutcomeMemory` 两次 attempt：记忆键跨 attempt 稳定 + rank 档第二次带 `[tried before, page did not change]` 注记）。`verify-decision-characterization`：10/10（`--record` 连跑两次逐字节一致）；pilot-leg 生命周期场景列为后续（需 pilot runtime harness，避免与 verify-pilot 耦合）。
- **§19 verify:offline filter-bar 基线结案**：证据链 = 金标记录以来池序/抽取源码零变更 + 两次运行失败行逐字节一致 + 净树 HEAD 亦失败 ⇒ 基线记录时即与环境不符（非当前行为变更）。处置 = 只重录 filter-bar 基线（其余 10 份还原），`verify-offline --check` **11/11 全绿**；长期建议（未做）= 该 lane 改为按 `(tag,label)` 多重集比较以消除位置性 ref 序敏感。
## [Unreleased] — 2026-11-22 驾驶面准确率批 + 决策询问契约 v5（提案）+ 账本工厂

- **动作前快速拒绝（`pickRejection`）+ 族推导修复**：驾驶面在动作前只付一次 evaluate——被第三方覆盖/零尺寸/离屏的选中**不执行、不耗步**，账本记 `unhittable:*` 后下一轮换候选（此前每次 1 步 + ~5.8s 遮挡探针；真站 Maps 列表「Open 24 hours」连续 3 次 = 3 步全废）。**能力面判定改 fail-open**：op 统一由 `elemFamily` 单点推导（textarea/contenteditable/role=textbox|combobox|listbox 归 fill/select），能力不符交回 `actOnce` 裁决——修复"fill 族被闸门判 unsupported 后永久禁选"的回归（`firstExecFamily` 注释引用同步修正）。lane 新增「准确率：被覆盖选中不耗步」「族推导：fill 族不被永久拒」→ `verify:pilot` **12/12**；真站 Hours 腿 3→**1** 步、`low_confidence` 诚实停。
- **`budget_exhausted` 终态（预算用尽即退出，不再重试）**：`pilot-entry` 驾驶循环在预算用尽后**直接收尾**（不再读兜底指令）；`pilot-runtime.handleLine` 对所有续驾驶指令回 `code:"budget_exhausted"` 结构化拒绝；`unblockHintsFor` 文案改为「起新 pilot 并增大 --max-steps（本 run 不再接受 resume/redirect）」。CLI 实测：`exit 3`、单条 `pilot_end`、stdin 的 resume 行**未被消费**；lane 预算场景补「resume 被拒 + drive 仍终态」断言。
- **模型候选窗剔除无角色聚合容器**：`pilot-vote` 对 `contains_candidate && 非 native && 无 role && 无监听章` 的聚合容器不做候选、也不给规则档选（点它零变化、label 却是多个选项词的拼接；真站 Maps 筛选面板实测被低置信反复选中）。真站 Hours 腿 steps 3→**1**、asks 8→7。
- **决策询问契约 v5（提案，**未冻结、未提交**）+ S0b 账本工厂**：新增 `src/engine/decision-ask-contract.ts`（`ask(page, scope, accounting, intent, profile)`；outcome 判别联合——`origin` 判别、`signal` 可空、`executionPool`、`phase` 七字段元数据；账本三语义按 lifetime 工厂绑定；reason 复用执行期 `StopCode`；`ts` 对齐 DC3）；新增 `src/engine/decision-accounting.ts` 工厂（`RunAccounting`+`OutcomeMemory`+pilot 守卫账本组合，engine 不 import app、prune 单源委托、memory sig 唯一 helper）+ `verify-decision-accounting` **12/12（96 断言）**。四轮架构复核记录与 S0a→S0b→S1→S2→S3→S4 批序见 `docs/DECISION_CONTEXT_CONTRACT.md` DC7.5；MAINLINE seam 表登记。
- **提取面单元折叠 F88 登记**：`unit-sibling` 行为入 schema 决策表（F88）+ F86 的 why 闭集同步放宽（此前该行为无 F 号，契约面与实现不一致）。
- **计数修正**：`pilot-runtime.ts` 799 行（≤800 硬上限，留 1 行余量）；§3.2 lane 12/12。

## [Unreleased] — 2026-11-20 pilot 修正批：finish 信号验证 + 低置信 reobserve + 终态可读性（PILOTED_WALKTHROUGH 实施审查收口）

- **红线收口（完成只认信号）**：`amber pilot` 的 `finish` 指令不再无条件记 `final_signal_held`——必须携带 `signal`（或复用预声明的 `--final-signal`）并经引擎 `checkSignal` 验证，成立才 exit 0；不成立 = `code:"signal_not_held"` 单行拒绝、交接保持打开；两者皆缺 = `config_error`。审查实测此前无任何信号声明也可 exit 0 / ok:true，旁路已堵。
- **低置信 reobserve（PW2 驾驶循环第④步补齐）**：驾驶票被 floor 闸门拒绝时先付一次宽扫重问（`WIDER_ELEMENTS`/`WIDE_QUOTAS`，宽池真变大才重问；禁选按 `esig` 元素签名平移到宽视图——与执行器 `pruneForbids` 同认识论），仍不过闸才 `low_confidence` 交接；弃权（choiceRef=null）与 run 的 abstain 判定同源直接停。`--conf-floor` 优先级接 run 同链：CLI > provider 自报（`ProviderInfo.floor`）> 0.25。驾驶记录的模型票带 `via:"ask"|"reobserve"` 来源标记。
- **交接四件套补齐（PW1）**：handoff 证据 = 截图 / DOM（>2MB 截断注明总长）/ 池快照（最近一轮 ElemPool 原样落盘）/ observe 明细，各自独立文件、独立失败独立缺字段（此前 pool_snapshot 与 observe 同文件、无 DOM）。
- **兜底指令契约对齐方案**：`redirect` 步史与禁选清段重新累计（预算不清零）；`resume.value` 支持对象多槽 k:v（字符串单值保留）+ `skip:true` 禁选最近一票；兜底指令记录行的 `value` 只留省略标记（值不落明文轨迹，与 export 同纪律）。
- **终态可读性**：`pilot_end` 只发一条（idle/中断/异常的 `code`/`reason` 以 note 并进汇总，不再双终态行）；通用停因钉进 `stop_code`（EOF/idle 收尾不再丢停因）；摘要恒含 `model_asks`（provider 计数同 run 口径，laya 档另带 `cache:{hits,misses}` 与 `failed_asks`）/ `rule_picks` / `model_picks` / `handoffs` / `fallbacks`。坏 JSON / 未知 / 被拒指令 = 单行失败继续等下一条（session 同纪律），不再杀整个会话。
- **CLI 边界**：`--max-steps 1` 不再被误拒（`num()` 下界判定修复，有效范围回到声明的 1..200）；`pilot export --json` 命令位可用；主命令位声明并吞掉全局 `--json`（stdout 本就是 JSONL 协议流，不再报 Unknown option）。
- **`--driver agent|model` 消融双臂（PW3 第③项）**：agent 档每步投影 `step_request`（observe 契约候选 ≤120 行，含经 hintMatch 自证的 hint_candidates）后等 `resume{hint}` 点名——零模型票、无需 open handoff；model 档即既有驾驶循环，`pilot_end` 摘要带 `driver:"agent"`。消融实测（books.toscrape 首本书详情页，信号 `.product_main`，预算 6-8）：纯 model 4 配置（laya english/multilingual × zh/en + 在线 decision-model-preview）**0/4 到达**（票面偏 chrome/导航元素；在线源失败如实降级 + `failed_asks` 记账）；hybrid（模型主控 + 1 条兜底）与 agent（1 条指令）均到达——**价值门未过**：本地 laya 档上模型腿未压缩成本，反而多付 3 咨询 + 3 浪费步。数据、墙钟与三面能力墙登记见方案 §7 消融小节与 BACKLOG §16/§17。
- **消融暴露的两处驾驶面缺陷同步修复**：①规则档只吃发起方原始 goal——步史摘要进规则匹配面会把已执行过的标签词面灌回目标、一次误选被规则无限复读；②本地 checkpoint 名走配置链 `resolveLocalCheckpoint`（`AMBERFLOW_DECISION_MODEL` > 缺省 english），不再硬编码。
- **大文件拆分（maintain size 800 行硬上限）**：`pilot-runtime.ts` 854→739 行，投票阶梯拆出 `pilot-vote.ts`（闭集投票 + floor 闸门 + 低置信宽扫重问 + esig 禁选平移，显式依赖注入无实例耦合）、现场证据/步间候选投影拆出 `pilot-evidence.ts`（四件套 + step_request 候选，观察闭包注入）；MAINLINE L5 模块表同步登记。
- **桥面 `amberflow_pilot` v1（PW3 第②项，one-shot 驾驶调用）**：`run-args-contract` 生成链新增 `PILOT_ARG_FIELDS` 段（`run-args:gen/--check` 双段校验，run 段生成物字节不变）；桥侧 `pilotArgs`（契约驱动 argv，无 provider kind——决策源走部署配置）+ `src/pilot.ts`（JSONL 协议流白名单投影：终态字段/事件 ≤60/交接细节 ≤4/剧本物化 ≤200 行走 `--input`/`pilot-killed.json` 墙钟证据）+ `amberflow_pilot` 工具注册（`commands` 兜底剧本与 `timeout_sec` 桥侧策略手写声明——两者都不是引擎旗标）；`bridge:test` 新增 pilot 三断言（真实 argv 组装 + held/stopped 两面投影 + 剧本透传核对），10/10 绿；真引擎端到端冒烟 exit 0（声明信号路径）。AGENT_INTERFACE 桥表与 §3.3 同步登记。
- **桥包构建面补齐 + 真实线上网站端到端（部署加载面就绪）**：`integrations/dsh-bridge` 严格 tsconfig `tsc -b` 通过——`lib/types` 产物含 `pilot.js` 与 `amberflow_pilot` 注册（部署按 `lib` 加载，此前 lib 缺 pilot 即「工具不可见」的真因；`lib` 已 gitignore，重建不改工作树）。构建暴露并修正 4 类 strip-types 下不可见的类型问题：工具 `output` 块缺失导致返回类型被推成 `never`、`timed_out` 字段名笔误、`ProcessOutcome.stdoutFull` 可选性、引擎 JSONL 未知值到 `JsonValue` 的白名单投影（新增 `scalar()` 收口）。随后用**构建产物** `lib/types/pilot.js` 对真实线上站点 books.toscrape.com 跑通完整走查：模型 3 步（next→logo→Add to basket 歧义交接）→ Agent 1 条 `resume` 点名 → 第 4 步到达详情页 → **`status=held` / `exit 0`**（33.1 s 含 ONNX 冷加载；model_asks 3 / rule_picks 1 / handoffs 1 / fallbacks 1），停驶四件套（截图/DOM/池快照/observe）落盘，`amber pilot export` 骨架过 `apps check`。
- **P1 决策上文注记：账本 → L2 通道（产品研判落地第二批，零契约变更）**：`PilotLedger.notesFor` 把账本条目生成为 `ref → "已试 N 次 · <last_outcome>"`（≤24 字/条、≤8 条）移交模型票；`pilot-vote.modelVote` 增加可选 `notes` 并透传给 `mw.pickProposal(goal, page, pool, forbidden, notes)`——复用既有 `ChoiceRequest.notes` 通道（`criteriaView`/`layaProvider.pick` 已消费），`minimal` 能力档天然可用，题面无注记时逐字节不变。验收：`verify:pilot` 10/10；真站 Hours 腿仍 3 步诚实停（`ledger:[{tries:3, failed:not-actionable-or-covered}]`、禁选按当前 ref `e42` 生效）；`npm run check` 绿。
- **提取面「同卡兄弟」单元折叠（架构研判 S2 落地，公理 0 扩形态）**：`pool-js-dedup.ts` 的 `__dedupPoolRows` 增加 `__dedupUnitSiblings` 片段——同 label 候选若**互不包含**但共享**交互祖先**（role article/menuitem 族/option/button/link/tab、jsaction click/auxclick、onclick 或 cursor:pointer，且非 body/html/main 泛容器），且组内**恰一个 native 控件**、其中心点真接收点击、组内其余成员无 `#id`/`[data-test]` 身份——该 native 即单元执行者，其余同 label 兄弟出池（`data-dshdrop=unit-sibling`，DOM 原样保留、同 label hint 仍命中执行者；why 闭集加 `unit-sibling`）。真歧义（跨卡/同容器多 native/无交互祖先）一律不动。**安全分离改用「开关全量对照」替代 S1 打标**：折叠开/关两跑既有 10 份离线金标**逐字节一致**（漂移项在 HEAD 净树上即存在，与本批无关）；新增夹具 `fixtures/engine/pool-dedup/unit-sibling.html` + 金标 `pool-dedup-unit-sibling.json`（池内 1 行 a + 被剔账 why=unit-sibling）；`verify:runtime:offline` 8/8 不变、`verify:pilot` 10/10、真站 Maps 结果卡 `Good Bites` 现为**单候选直点**（此前需谓词层折叠探测）；`npm run check` 绿。
- **P0 驾驶守卫：单源 esig 账本（产品研判落地第一批）**：新增 `src/app/pilot-ledger.ts`（esig 键记账 + 禁选平移 + 死目标守停 + 交接证据，与 run 面 `RunAccounting`/`outcome-memory` 同一认识论；`pilot-runtime` 拆薄委托回到 800 行内）。三处失明一次修掉：①禁选从裸 ref 改为**每轮按 esig 重算的 ref 视图**（修 e15→e18 位置性漂移）；②规则档 exclude——`affordanceRule` 无 exclude 参数，命中「已改变状态却未推进」的 esig（toggle/乒乓形态）即让位模型档，无变化/失败/拒绝的复读仍走 inert/deny 计数（保住 `stuck_inert` 诚实口径）；③**死目标守停**（`PILOT_REPEAT_LIMIT=3`，run 面 `maxEffectiveRepeats` 同口径）：同一 esig 达上限即动作前停 `stuck_inert`，交接摘要写明 `dead target: "<desc>" driven N time(s)`、证据带 `ledger[{desc,tries,last_outcome}]` 与 `loop_stop`；`redirectReset` 时账本随步史清段。验收：`verify:pilot` 新增死目标场景（降级档 1 步即停、账本证据齐全）**10/10**；真站 Hours 腿（此前 8 步 `budget_exceeded`）→ **3 步 `stuck_inert`**、交接证据 `tries:3 / failed:not-actionable-or-covered`；`verify:runtime:offline` 8/8 不变（run 面零影响）；`npm run check` 绿。P1（L2 上文注记 via 既有 notes 通道）与 S1（提取面事实打标）为后续批次。
- **歧义判定的同单元折叠（真实站点发现 + 批复落地）**：同 label 命中档里的候选若属**同一可动作单元**，取执行者直接执行、不判 `target_ambiguous`——两级判据：① DOM 包含（容器 vs 它自己的链接/控件，容器文案继承自子节点）；② **最低公共祖先 + 组内唯一 native 控件**（Maps 结果卡形态：覆盖链接按 aria-label 与可见标题 div 同 label、互不包含但共享 `role=article` 卡片；LCA 须为交互单元且非 body/html/main 泛容器，中间样式层（如 cursor:pointer 的标题容器）不再成为「最近交互祖先」歧义源）。跨行/跨卡的同 label（两行同名 Add to basket）与一卡双 native 控件仍零动作真歧义。接入面：`_resolveOne`（session/pilot 动作，`resolved_via:"nested-fold"` additive）与 pilot ①′ resume 点名路径；`verify:pilot` 新增两场景（嵌套包含 + 同卡兄弟，**9/9**）。真站验证：Maps 结果卡 `Good Bites`（此前必须 `on_ambiguous:act`）直接点击并导航到 place 页；根因登记 BACKLOG §18（提取面 hit-receiver 单元归一——根治 proposal）。
- **动作可及性修复：中心点被祖先接住时的重定向（真实站点走查发现）**：`action-timeout` 根因三处——①`FN_HIT` 把「祖先前台命中」并入"无覆盖"，与 Playwright「命中必须是目标自身或后代」的判据不一致，导致白等 5s 慢重试并报无信息量 `action-timeout`；②引擎不会把点击重定向到真正可点的祖先（Google Maps 评分筛选行：`div[role=menuitemradio]` 行容器 + 内部 label span 不可命中）；③`describeActionError` 只取 Playwright 报错首行，call log 里的拦截者被丢弃。修复：新增 `src/engine/executor-actionability.ts`（遮挡探针 / 命中关系单源 `FN_HIT_RELATION`（self/descendant/ancestor/covered/zero-size/offscreen）/ 可动作祖先重定向 / DRF hit-test / 池外回退点击），执行器类改薄委托（存量文件只减不增）；祖先命中 → 重定向到最近可动作祖先，成功记 `resolved_via:"actionable-ancestor"`（池外回退路径同款）；第三方覆盖/零尺寸/离屏 → `not-actionable-or-covered:<blocker>` 带 bbox/blocker/requery 证据；错误文案带上 `… intercepts pointer events` 拦截者。验证：真实 Google Maps 评分筛选行 4.5（此前 `action-timeout`）→ 点击成功且筛选生效（chip `4.5+`、结果全 ≥4.5）；`verify-runtime-offline` 新增 `actionable-ancestor-retarget` 场景（点击不可命中的内层标签 → 行 handler 记账、done 成立，golden 已入库）；覆盖回归（真遮罩）仍拒绝且不重定向；`verify:pilot` 7/7、`npm run check` 绿。
- **驾驶面跨 frame 动作解析修复（真实站点走查发现）**：`executePicked` 此前用 40 字模型视图前缀 `label` 当动作目标回传 `actOnce`，而 hint 匹配口径读的是 `full_label`（≤200）——长标签元素（典型：`ogs.google.com` iframe 里 Google apps 菜单的 `Maps, row 1 of 6 and column 3 of 3 in the first section`）因此精确匹配落空、结构化 `target_not_found`，即使元素已在池、模型已选中。修复：动作解析改用 `full_label`（`MAX_HINT=200`，与匹配口径同源），证据/摘要仍用 40 字前缀；危险闸门词面同用完整目标。验证：真实 Google 首页 → 应用菜单 → Maps 纯模型驾驶 2 步到达（`PILOT HELD`，hosts 声明 frame origin）；`verify:pilot` 7/7 无回归。
- **工具面 `commands` 注入修复（真实工具首测发现）**：`amberflow_pilot` 的兜底剧本参数此前只在工具面手写声明、未进 `PILOT_TOOL_FIELDS`，工具层映射时被静默丢弃（表现为 `fallbacks:0`、剧本不生效）；改为**收编进共享契约** `PILOT_ARG_FIELDS`（tool-only 字段，同 `timeout_sec` 先例）——参数面由生成契约驱动、映射自动覆盖，根除手写漂移。验证两条：①桩 ctx 加载部署产物 `lib/types/index.js` 调工具 execute → `status=held` / `fallbacks=1`；②宿主重启后真实工具调用 → `PILOT HELD (final_signal_held)` / steps 2 / asks 1 / handoffs 1 / fallbacks 1，到达详情页。
- **§3.2 验收矩阵落地（`npm run verify:pilot`，非门禁 lane，需 chromium）**：`tools/verify-pilot.ts` + `fixtures/engine/pilot/`（本地静态服务；决策源统一指向不可达档——零模型加载、规则面确定性、不依赖本机 laya 工件）7 场景全绿：rules 零模型到达、needs_value→resume 值+点名、stuck_inert→resume 换目标、target_ambiguous→resume 收窄、budget 终态保停因、危险 default-deny 不可越过（兜底闭集无 confirm）、决策源不可达 low_confidence→resume→no_model_runtime（降级两步如实）。
- **验收矩阵抓出两枚真缺陷并同步修复**：①**驾驶面危险闸门此前不生效**——run 的 isRisky→confirmFn 闸门在动作相位，`actOnce` 不经过它，default-deny face 又不装 confirmFn（执行器缺省拒绝只在风险闸门处拒一切），驾驶面对「删除」类链接直接放行导航；修复 = `executePicked` 对每个待执行动作做确定性关键词判定（`DESTRUCTIVE_PATTERNS` 单源 rules.ts，与桥 denyDestructive 同一闭集），拒绝 = `risk_declined` 结构化失败 + 禁选 + inert 记账，绝不静默执行。②**resume-hint 撞歧义静默回落**——裁决视图（`hintMatch`/firstIfSame）为 null 且候选证据 >1（`hintCandidates` 签名互异不合并）时不再回落模型路径，改 `target_ambiguous` 只停不选（与 run/session 同一谓词）。
- **账本**：门禁 `npm run check` exit 0；冒烟复核：声明信号路径 exit 0、无信号 `finish` 被拒、非 TTY EOF 结构化收尾带停因、`--max-steps 1` 可用、export→`apps check` 闭环仍过。
- **文档**：AGENT_INTERFACE §3.3 冻结 pilot 驾驶协议（指令形状 + `PilotHandoff` 字段表 + 退出码）；INTERACTIVE_SESSION 加 pilot 划界注记（session 零模型纪律不变）；方案文档头部状态 implemented→partial（PW3 仅 export 落地）+ §7 补修正批记录；`pilot-contract` 注释措辞过 maintain ratchet（历史措辞回到基线）。
- **账本**：门禁 `npm run check` exit 0；冒烟复核：声明信号路径 exit 0、无信号 `finish` 被拒、非 TTY EOF 结构化收尾带停因、`--max-steps 1` 可用、export→`apps check` 闭环仍过。
## [Unreleased] — 2026-11-20 F89：懒渲染双指标稳定读缺省化（会话 extract 面）+ 桥透传

- **双指标门缺省开（单循环双读）**：`rowsSettledDual` 改为返回 `{settled, scroll_settled}`——行数 AND 空行数（rowStatsAnyFrame 一次 evaluate 同时拿两个数）与 E5 滚动稳定判定合并成**同一个轮询循环**（600ms × 至多 5 轮；不另起第二个循环，默认化真实成本 ≈ 0：静态页首轮即稳）。`doExtract` 的 `waitSettled` 语义默认化：缺省 / `true`（冗余兼容）= 双门运行、`settled` 恒出现；新增 `false` = 请求级 opt-out（跳过双门回旧 E5 单指标循环，`settled` 缺席——无门无证据绝不谎报稳定）；`settle:"off"` 双门与 E5 同跳。`settled:false` 时 `blank_rows` 以全帧 rowStats 为准。**app 面 ctx.extract 不动**。
- **桥面透传（F6 教训直接适用）**：extract 响应补 `settled`/`scroll_settled`/`blank_rows`（此前 blank_rows 被桥投影丢弃）+ `wait_settled` 请求参数（缺省不传 = 缺省门；false = opt-out；true = 冗余兼容；非 boolean = config_error）；文本渲染在 `settled:false` 或 `blank_rows>0` 时追加 ≤1 行 `lazy-render:` 提示；AGENT_INTERFACE.md extract 键表同步。
- **离线锚**：`fixtures/engine/hydrate-delay.html`（`?delay=ms` 参数化——水合在稳定窗口内/窗口外/静态三路径）接入 verify-offline 三个 case（行值 + settled/blank_rows/键存在性；耗时口径不进 golden——静态页 settled:true 即"双门首轮即稳 ≈ 零额外等待"的确定性体现）；bridge:test 增 extract settled 断言两条（缺省透传 + opt-out 缺键 + 非法值 config_error）。
- **契约与账本**：F89 登记（statement 五条 + truth 全落点）；APP_SCRIPT_AUTHORING 卡点表补懒渲染稳定读条目；baseline session-runtime 1018→1026。门禁：`npm run check` exit 0（15 步含 bridge:test 9/9）；verify:offline 13 夹具两次一致入库；verify:runtime:offline 7 场景 OK。app 面 ctx.extract 零改动；F5 零改动。

## [Unreleased] — 2026-11-19 BACKLOG §14/§15 收口：会话 close 自收口 + 桥层回归 harness

- **§14（close 收口）**：泄漏形态清单核查先行——① CLI 行循环形态（close/EOF 两路）本就经入口 finally 走 `finish`（真浏览器探针实证 exit 0、chromium 零残留，无泄漏）；② bridge 常驻宿主的 `taskkill /T /F` 兜底保证子进程树必死（强制收口，边界如实记录不改）；③ 真正泄漏形态 = 无入口循环的直调 dispatch 驱动（一次性 embedder）。修法：`doClose` 在摘要算好后于本调用内 `await finish("closed")`——close 语义自包含，三种驱动都自然收口；`finish` 幂等，两条真实路径行为不变。进程级验收 lane `npm run verify:session:close`（非门禁，需 chromium）：C1×N 连续 open/close 循环 + C2(eof) + C3(embedder) 全部 exit 0 且 chromium 进程数回基线。
- **§15（桥层回归 harness）**：`integrations/dsh-bridge/test/`（`node --test` + fake-engine.cjs JSONL 缝经 `SessionManager.spawnArgv` 注入——真跑桥面投影代码，纯进程内、零浏览器、离线）——五组断言：act 失败 `wide_scan` 有界透传（hint 行优先/≤40 行/clip/pool_size 如实/缺键形状不变）、`ambiguity` 失败面 + 成功面、snapshot `window` 审计块透传与缺键形状、open/goto 往返 + engineFailure 投影。门禁接入选主仓 check 新步 `bridge:test`（14→15 步；依据：断言为确定性进程内事实，白名单投影丢字段正是 PR 门禁该拦的回归类；桥目录无 package.json 不单建）。断言面配套：引擎 `doSnapshot` additive 带 `window`（windowAudit 有界证据）+ 桥 `windowAuditEvidence` 有界透传（out_of_window ≤10 / dedup_dropped ≤40 / tag16 / label40 / why32 / surface_counts 有限数；缺键 = 旧响应形状不变）。BACKLOG §14/§15 条目标注完成提交号。
- **账本**：baseline session-runtime 1008→1018；check 链 14→15 步。门禁：`npm run check` exit 0（含 bridge:test 7/7）；verify:offline 10 夹具 OK；verify:runtime:offline 7 场景 OK；smoke 随外部网络波动（0 failed）。
## [Unreleased] — 2026-11-19 模型驾驶走查（amber pilot / PW1+PW2+PW3）

### 模型驾驶走查落地（docs/PILOTED_WALKTHROUGH_PLAN.md 全量实施）

- **新增 `amber pilot` 命令（第 12 命令）**：走查阶段的**模型主控面**——决策模型逐步投票驾驶（规则档先行零模型 → 池内闭集 `pickProposal` 投票 → 置信闸门 → `actOnce` 执行），停因时投影结构化交接块（`PilotHandoff`：截图 + observe 落盘 + 确定性解锁建议），Agent 只在交接时兜底（stdin JSONL 闭集：`resume`（hint 点名确定性执行/value 显式给值）| `redirect`（换 url 或 goal）| `finish` | `abort`）。完成只认信号（`checkSignal` 验证 `--final-signal`）；产物恒带 `pilot:true` 不冒充 run 结论；退出码 0=信号收尾 / 1=browser_dead / 3=待兜底。
- **停因闭集 8 码全部确定性判定**：`final_signal_held`/`budget_exceeded`/`low_confidence`/`target_ambiguous`/`needs_value`/`stuck_inert`（连续 inert≥3）/`no_model_runtime`（rules-only 如实停）/`browser_dead`——零新 stopCode 语义，全部来自引擎既有停因码或 pilot 收尾正因。
- **红线落地**：模型只投票不生成（动作类型由 affordance 族判定；驾驶问句走闭集 ref）；值不猜（fill/select 缺值 = `needs_value` 停，只接受 slots 预声明或 resume 显式给值）；`resume` 带 hint 走 `hintMatch` 确定性执行（零模型票）。
- **新增 `amber pilot export`**：驾驶轨迹（`--record` JSONL：drive/handoff/command 三类行）→ app.mjs 骨架——`picked_by` 来源标记（决策票/规则档）忠实保留、handoff 兜底上下文注释化、失败步不生成假动作、done 占位符待作者补（与 session export 同一「只出骨架不归纳」纪律）。
- **装配面**：`middleware-factory` 加 `pilot` face（`FACE_POLICY.pilot="default-deny"` 与 session 同档——兜底指令闭集里不存在 confirm 类指令）；决策源装配与 run 同序列（`resolveProviderSpec` → `applySpecToRuntime`）；执行链完全复用（`_extractPoolSettled`/`pickProposal`/`actOnce`/`checkSignal`/`hintMatch`/`navRule`/`affordanceRule` 单源消费）。
- **端到端冒烟**（books.toscrape.com 实测）：起飞 → 模型低置信如实交接（截图+observe 落盘）→ Agent resume hint 点名 → 规则档确定性点击进商品页 → `final_signal_held` exit 0；`--input` 文件剧本整段只开一次（修复跨轮重复消费）。
- 文件：`src/app/pilot-contract.ts`（契约单源）、`src/app/pilot-runtime.ts`（驾驶运行时）、`src/app/pilot-entry.ts`（入口编排）、`src/app/pilot-export.ts`（导出）、`src/cli/commands/pilot.ts`（CLI）；`registry.ts`/`help-map.ts`/`main.ts` 登记；`MAINLINE.md`（命令数 11→12、L5 模块表、预留表）同步。方案文档状态 proposal→implemented + §7 落地索引。

## [Unreleased] — 2026-11-19 候选池改造批 2+：桶内排序/组保底/会话宽扫/hit-test 核实（F5 不做）

- **桶内类目维排序 + 醒目度（两分支同比较器）**：`pool-js-dedup` 增 `__poolRowOrder`——桶内 atomic 先、container 后（container 只降权不除名：点卡片与点按钮是两种操作）→ `prominence` 降序（viewport=可见交集面积、其余桶=原始 rect 面积；平局 scan 升序，确定性）；EXTRACT_JS 的 quota 与 legacy 分支同改（main-first 回退分支保持逐字节旧序=显式回滚面）。复算矩阵保持：pool-1（scrollTop=0）64 帽订票 7/7 含首行 s103（排序后反列首选）、pool-2 订票 13/13。
- **组级保底**：`__dupGroupMinsOf` + `__GROUP_PIN_CAP=8`——去重后仍存在的同 (tag,label) 行组每组保 scan-min 组锚（救回在顺延填充前、fill 跳过已入池行；键口径与 addNearContext 一致防跨面组号错位）；排序/配额不再让同文案行组整组消失（row-index/in-row 与"点第 N 行"任务的组锚前提）。
- **会话 act 宽扫回传（additive）**：新增 `src/app/session-wide-scan.ts`；`doAct` 失败路径在 `target_not_found`/`target_ambiguous` 停因回传 `wide_scan{window,pool_size,candidates[{ref,tag,label,hint?}]}`——一次有界宽扫（≤128）、零动作；hint 经 `suggestHints` 的 push→hintMatch 自证恰好唯一命中才给出。页内探针：落空回传结账按钮 `#checkout-btn`、歧义回传 8 个订票行各带 `订票 row-index:1..8` 自证 hint；旧响应键集逐字节不变。**桥面有界透传（评审必改）**：`session.wideScanEvidence` 挂进 `engineFailure`（引擎有才有、不重算；candidates ≤40 行、带 hint 行优先、tag/label/hint 有界，完整口径由 pool_size 表达），渲染面失败行追加一行 `wide-scan: N candidate(s) (M with hints, showing K)`；AGENT_INTERFACE.md F6 条目登记。
- **hit-test 语义核实（现状已正确，零行为变更）**：`eval-snippets` 的 HIT_JS/HIT_DETAIL_JS 与 `executor._declaredHitTest` 对"中心命中后代/祖先"放行（后代命中=正常操作成立，事件冒泡回容器 handler），仅第三方元素判 covered——三处补公理 0 注释并声明判据不得漂移；新增离线锚 `fixtures/engine/pool-dedup/hit-descendant.html` + verify-offline `center_hit` 断言（中心命中=自己的子元素）。
- **契约/账本**：schema-gen 登记 F87（桶内排序/组保底/宽扫回传/hit-test 核实四条 truth 面齐全）；F86 statement 随 rework 登记（容量+一区域一候选+settle 过滤纪律）；APP_SCRIPT_AUTHORING 候选窗口段补"桶内原子控件先于容器、按醒目度排序"（prompt 477→约 495 字符 ≤500）与排序/保底/宽扫卡点；fixtures README 补 hit-descendant 行。门禁：`npm run check` exit 0；verify:offline 10 夹具两次一致入库；verify:runtime:offline 7 场景零漂移；smoke 7 passed / 0 failed；复算矩阵 7/13。

## [Unreleased] — 2026-11-19 候选池改造批 1：容量 64/128/256 + 一区域一候选（父优先）

- **容量与配额表**：`POOL_CAP_ELEMENTS` 40→**64** / `WIDE_SCAN_POOL_ELEMENTS` 120→**128** / `WIDE_SCAN_POOL_ELEMENTS_MAX` 240→**256**（宽扫链经 `executor-pure.WIDER_ELEMENTS*` 自动跟随）；`elem-model` 四张配额表重配——`POOL_QUOTAS` 8/24/16/12/4=64、`WIDE_QUOTAS` 16/52/34/17/9=128、`QUOTA_MODE_*` 按基础表比例放大并保留超额订阅语义（表合计 74/150 > 池帽，靠 BUCKET_FILL_ORDER 填序截断，只改"谁被逐出"）。档位依据（公理 0）：真人浏览一屏扫 60+ 控件，40 帽在长列表页把主目标挤出窗口（flights.ctrip.com scrollTop=0 实测 40 帽仅 2 个订票候选）。`schema-gen` F65 换档表数字跟新。
- **一区域一候选（父优先）**：新增 `src/engine/pool-js-dedup.ts`（页内去重片段，公理 0 单一出处）——`EXTRACT_JS` 采集期祖先打标（`contains_candidate` ≤32 层）并在配额/填序前裁决：父子 DOM 包含且（等 label 或子空名）只留一份，默认**留父、子让位**（父承载命中面积与 label、事件冒泡到父 handler）；唯一例外 = 监听探针章（`data-js-ref`）证明 handler 在子而父无章且非原生 → 留子；label 不同且子非空名都不剔（卡内独立按钮守卫）。被剔元素盖 `data-dshdrop` 章（每趟开头与 `data-dshref` 同批清旧章，清章块前移与 EXTRACT_JS docblock 对齐）；被剔节点 DOM 原样保留，作者显式点名仍可 DRF/ADMIT 回捞（能力不丢）。不引入自动滚动；完成只认信号。
- **证据面（additive，旧键不变）**：池行新增 `prominence`（viewport 桶=可见交集面积、视口外桶=原始 rect 面积，平局 scan）、`contains_candidate`、`kind`（container=含候选后代且（自身无文案或与内层同 label）；键只在 container 出现）——`modelProjectionOf` guard+解构两处剥离（模型面/esig/firstIfSame 不变）；`WINDOW_AUDIT_JS` 读被剔章 → `windowAudit` 增 `dedup_dropped[{tag,label,why}]`（why ∈ label-dup/empty-child/listener-child，有界 40，无被剔不出键）。
- **离线夹具**：`fixtures/engine/pool-dedup/` 五页（父子同 label 含例外形态/装饰子/空名子/卡内独立按钮/61 控件网格）接入 verify-offline，golden 钉住留父剔子、留子剔父、都留不误杀、64 帽 item-50 可达与被剔账 why。docs/APP_SCRIPT_AUTHORING.md 候选窗口段落、W10 宽扫数字与 `--wide` 面同步；CANDIDATE_WINDOW_TEXT 补"一区域一候选/父优先"一句（405→约 450 字符 ≤500 预算）。
- **验收与账本**：复算脚本对 s-JjYKfwbkxD 重放新规则——pool-1（scrollTop=0）64 帽订票 7/7 含首行 s103（无去重仅 5）；pool-2（滚动 400px）订票 13/13。split manifest 按先例（24bb60b/7fede7a）删除有意改值符号条目（四张配额表/EXTRACT_JS/WINDOW_AUDIT_JS/windowAudit）；baseline 定向上调 pool-js 852→883 / extraction 1101→1113 / executor-pure 934→938（新逻辑主体在新模块）。**评审 rework**：settle 传感器 `IGNORED` 名单补 `data-dshdrop`——被剔章的盖/清是引擎插桩不是页面突变，漏过滤会让静态页每步 settle 白等 quietMs 并污染 timedOut 判据（rehydrate 重扫与 pool_ready not_ready 被噪声驱动）；F86 契约登记（容量档+四张配额表/一区域一候选含例外与空父有名子不合并/dedup_dropped 证据面/data-dshdrop 章与 settle 过滤纪律）。门禁：`npm run check` exit 0；verify:offline 9 夹具 golden 一致；verify:runtime:offline 7 场景零漂移；smoke 套件通过。

## [Unreleased] — 2026-11-17 介入/救援 v1 默认切换（P2 最后一项前置）

### 携程 class-only 可用性批（P0-2 / P0-4；架构师实施 + Lead 验收）

- **P0-2（F54 口径修订）**：桥 `why_not_admitted` 诊断上限 120→**400**，且截断改**词边界**——断点落空白/收束标点，寻址 token（`#id` / `[data-test=…]` / `[name=…]` / `role=…`，含 `within:#a>#b` 链）不从中间切断；token 自身越过上限时保 token 完整、截其余叙述（唯一可超 400 的情形，字段仍 ≤ 引擎原文长度）。`element-view.ts` 新增 `clipWhyNotAdmitted`/`protectedTokenSpans` 单点，inspect/observe 两面同合同；`docs/AGENT_INTERFACE.md` 两行同步。修复携程实测 `#filter_item_trans_coupon` 被切中导致诊断不可判读。行为断言 17/17（含 len=400 原样 / 401 兜底硬切 / 空串非串缺键不出键）。
- **P0-4（F72 行为变更，仅 miss 路径）**：rehydrate 重扫从步级 opt-in 改为**缺省自动**——act 目标在 池→ADMIT→FW8（→宽扫）全链真落空且步首 settle 未静默（timedOut）时，引擎自动等 2s 重抽池重解析同一 hint（至多 1 次、同一谓词、不重走决策面）；`rehydrateRescan:true` 声明（ctx.step / 会话请求字段 / 桥参数）兼容保留、不再有额外效果。成功路径逐字节不变；`policy.settle:"off"` 或 settle 传感器失败时门控信号不存在，永不触发；`_resolveOne` 服务的 scroll/setRange miss 面同受益。证据键集/顺序不变（trace `rehydrate_rescan`、`resolved_via:"rehydrate-rescan"`、`ActMissDiagnostics.settle_*`/`rescan`）。相关 JSDoc/cookbook/账本措辞同步收口。
- **P1-6（F35 口径修订；additive）**：`observe` 面（`ctx.observe` / `amberflow_session op:"observe"`）新增顶层 `ax` 证据块——与 inspect 同一份取树实现（`snapshotAx` 单点，Playwright accessibility.snapshot → CDP Accessibility.getFullAXTree 降级，3s 超时、失败即 `{available:false, reason}`），nodes ≤50 + `nodes_truncated` 如实；`not_in_pool` 对照底座 = 本次观察的准入元素 label（inspect = 运行池投影；判定函数 `countAxNotInPool` 共用，口径说明 `OBSERVE_AX_NOT_IN_POOL_BASIS` 单独成文）。**缺省随观察附带**（非 opt-in——作者"不知道也不开"正是要消除的诊断盲区）；waitFor/waitForTarget 轮询不走本原语，唯一重复付费点是会话 observeAfter（每 act 至多一次有界取树）。dry/replay 无此键；bridge `session.ts` 透传（缺键即省，桥不发明）；`ax.ts` 文件头纪律同步为"observe 与 inspect 两个只读观察面"。CLI session 真跑 example.com：`ax.available=true`、`interactive_count=1`、`not_in_pool=0`（Learn more 链接已被指向）。
- **P1-1（F44/F49/F73 口径修订；本方案唯一批准的默认行为变更）**：`meta.policy.target_resolution` 缺省 **off→declared**——class-only 站点的裸词/attr 声明目标在池/ADMIT/FW8 全落空时由 DRF 兜底恢复（text 模式=文本全等+最深优先+hit-test），作者不需要知道这个开关；显式 `"off"` = opt-out。**能力面纪律全部收口到解析资格侧**：`declared-targets.ts` 新增 `DECLARED_TARGET_OPS`（click/scroll/hover）单点 op 门（判定在 dedup 之前——面外 op 不占额度）；命令路径删除变死的 `DECLARED_OPS`/`action_unsupported` 分支；act-hint 的 `isTyping(el)` 命中改为**不参与救援**（清章+清账，落回 widen/strict，零新硬停）——能力面外目标（fill/select/drag/upload/clickAt 与 typing 形 act-hint）行为与关闭 DRF 逐字节一致。journey 面 `app-runner-declared.ts` 补 `targetResolution` 消费一行（账实一致）；`app-runner-policy.ts` 的 `target_resolution` 恒在账（value=声明 ?? "declared"，source=app|default）但缺省值不参与 anyDeclared（无声明包产物逐字节不变）。plan/suite 源不传 targetResolution → 线上套件行为不变。提示面随翻转：drfHintSuffix 只在显式 "off" 时出现。split manifest 按文档纪律清理漂移符号（PackPolicy/POLICY_KEYS/EffectivePolicy/resolveRunPolicy）。
- **P2-9（additive）**：会话新增 `op:"goto"`（`amberflow_session` / `amber session`）——受控导航原语，与 open **同一条实现**（`openInner` → `ctx.open` → `CtxRuntime.navigate` 单一判定：hosts 信封前置检查、goto(domcontentloaded)、unreachable/config_error 结构化分类、落地 302 跨主机 host_not_allowed、PageState settled）；task-38 flap 监听+有界自愈对 goto 按构造生效；**不带 referer 参数**（同源浏览器自动带，跨源无收益）。桥 SESSION_OPS/gotoOp/renderSessionResult 全链 + `AGENT_INTERFACE.md` 专节；`timeout_ms` 整数 1..120000 越界 config_error（不静默钳制）。换日期/换列表页从此不用关开会话改 URL（高频开关撞站点风控的动因由此消除）。端到端：同域换页 ok → observe 反映新页 → 越信封 `host_not_allowed` 结构化。
- **P0-3（additive，仅失败路径）**：`target_not_found` 落定前做**只读 DOM 等价探测**（单一出处 = `extraction.probeHintInDom`；session act 诊断面与 run strict 面共用）——`#id`→getElementById；`tag[attr=value]`/`tag[attr~substr]`→querySelectorAll（`~`=CSS `*=`，值大小写敏感与池侧一致；aria-label=label 别名同口径）；裸词→文本全等（TreeWalker SHOW_TEXT ≤20000 文本节点、直接父元素去重）+ aria-label 全等；`tag`/`tag~token` 与带 within/in-row/frame 声明的 hint 不探测（fail-closed，命中会误导）。命中 → `ActMissDiagnostics` 增 `in_dom_but_not_admitted` 块（total/matches≤5/note）+ reason 改写"在 DOM 但未进池"级文案 + note 按全量句柄事实双措辞（无 id/data-test=class-only；有句柄=池帽/准入面/帧排除）；未命中/异常 → reason 逐字节不变。stopCode 不变。修复携程"class-only 控件在 DOM 却报目标不在本页面"的诊断误导。三档验证 8/8（in_dom 四例/近似三例/不存在一例）。
- **P1-8（BACKLOG #3 引擎最小落地；additive，仅 miss/低置信路径）**：候选窗口递增链 40→120→**240**（硬顶 `WIDE_SCAN_POOL_ELEMENTS_MAX` 单源进 tuning.ts，TUNING_VALUES 12→13 概念）——既有 U5（rules-only）宽扫点与低置信恢复/R2b 词面守卫段扩为递增链：120 档未命中且窗口确有增长才升 240 档（增长判据对 120 窗口——不增长零动作不付抽取），**命中即停**；240 全档命中时清掉 120 档的 stale weakRejected（它是对旧窗口的判词）。证据：trace 行 `window_escalation:[{window,miss,resolved,ref?}]`（本步 fresh 数组防跨步误带）+ 停因尾缀 `windowChainMissSuffix`（链没跑/命中过=空串，逐字节不变）。`runModelPick` 拆段：两处同构"240 档重问"单源到新文件 `src/engine/window-escalation.ts`（68 行，deps 显式注入、判别联合 `WindowRungOutcome`），runModelPick 411→391 行 ≤400 上限。--wide/tiered 语义不回归；widgets:true 每档透传。verify:runtime:offline 7 场景 golden 一致。
- **P1-7（解析链第五档；additive，仅失败路径）**：act 解析链末端补 **AX 执行链回退**（`resolved_via:"ax-fallback"`）——`ax.ts` 新增 `snapshotAxForResolve`（CDP `Accessibility.getFullAXTree` 保留 `backendDOMNodeId`，只走 CDP；Playwright accessibility API 无节点→DOM 链接，不可用即整体跳过）+ `matchAxNames`（裸词归一化全等优先、词前缀/词包含标弱档；attr 形状=AX name 全等；`#id`/`tag`/`tag~token` 与带 within/in-row/frame 声明的 hint 不参与）+ `stampAxProbe`（`DOM.resolveNode` → `Runtime.callFunctionOn` 盖 `data-af-probe`）。**修复实施期关键 bug**：`DOM.resolveNode` 的 CDP 参数名是 `backendNodeId`（不是 AX 节点字段名 `backendDOMNodeId`）——错名会被协议拒绝且被 catch 吞成 null；已按先例修正。编排单点 `_resolveAxFallback`（run 决策步 strict 停因前 / 会话 act 全链落空后，每解析至多 1 次）；>1 候选走同一 describeAmbiguity 谓词零动作（先清理章再返回）；命中 = 合成行 `ax<N>`（`declared:true` 旁路标记，不进 ChoiceRequest）+ `_locatorFor` 同动作面 + 用完 cleanup（FW8/A3 同纪律）；**强档门单点**：`act_hint_tier:"strong"` 下弱档命中不采纳（`rejected_weak` → session 诊断 `ax_weak_rejected` / run 面 `ax_fallback_weak_tier` 警告 + strict 落因）。六路端到端验证（命中/歧义零动作/弱档/强档拒绝且零残章/强档不误伤/清理幂等）全过。
- **P2-10（最后手段；危险门控，缺省拒绝）**：新增**文本 bbox 中心坐标点击**兜底（run 决策步第六档，排在 AX 回退之后）——文本全等且**唯一可见**的元素（无任何可寻址句柄）→ `extraction.probeTextBbox` 取 bbox 中心 → `_resolveClickxyFallback` 合成行（`Elem.clickxy`）→ 执行单点 `_clickOnly` 的 clickxy 分支（`page.mouse.click`，不经 locator）→ 证据 `resolved_by:"clickxy_fallback"` + `clickxy:{x,y}`，动作描述带坐标。**危险门控**：clickxy 行强制 risky → 既有 `confirmFn` 闸门（dry-run 先出证据、无确认函数/非交互恒拒绝、`--confirm-unsafe` 才放行；拒绝 = `risk-declined` 零动作）；文本 >1 可见 = `clickxy_ambiguous` 零动作（绝不猜坐标）；仅裸词参与、主帧只读、异常 = null。四路验证（唯一命中中心计算正确且真实点击触发/歧义拒绝/非裸词不参与/零命中 null）全过。`jsInteractiveWidgets` 升级为**双盖章通道**——自身监听（CUSTOM_WIDGET_TAGS 判据逐字未动）+ **容器委托**（JS_PROBE_CONTAINER_TAGS 结构容器挂 CLICKY 监听 → 给有可见文本的最内层叶子盖章，≤10/容器 + maxAdd 总顶；capture 与 bubble 同权——getEventListeners 按 type 过滤天然含 capture，按阶段过滤=系统性漏检）；预算 maxAdd 10→30 / maxExamined 150→600 / budgetS 2.0→4.0（JS_PROBE_* 命名常量、never raises）；监听缓存键 URL→`listenerCacheKeyOf`（URL + DOM 四项计数指纹：总元素数 / body 顶层子元素数 / 可见原生交互数 / 已盖 data-js-ref 数——同形重建也触发重扫；有产出时按盖章后状态重算键落缓存；指纹不可用 → `|nofp` fail-open 裸 URL）。直击携程"事件委托挂容器 → class-only 控件进不了池"根因。功能证据：委托叶子进池（bubble/capture 各验）+ 经池身份 `[data-js-ref=jsN]` 点击触发委托监听 + DOM 变更后指纹重扫；verify:offline 4 夹具页池逐字节不变（无委托页非回归）。

### §6.5 D 条件项收口（runExecution / W5-3 / W4-4 / laya 截断 + 桥 TS2375）

- **W5-2 主半落地：`runExecution(deps, source)` 组合根**。新增 `src/engine/run-execution.ts`（294 行）：SessionLease（惰性创建/finally 关闭一次）、RunScope、执行器装配入口与收尾事实、env 节奏时钟、attempt 账本、停因分类（`classifyStop`/`CONFIG_CLASS_STOPS`/`budgetExhausted`）、artifact 目录交接统一收口；**不共享** retry/sleep/业务判定。四套编排全部迁移为源适配器：`runScriptApp`（flow）/ `runApp`（declared-flow）/ `runPlan`（plan）/ `runOneCase`（suite），真实 `runExecution(` 调用点 = 4；公开签名、result/trace/report/证据/退出码矩阵逐字节保持。`RunScope` 纯搬移下沉 `src/engine/run-scope.ts`（app 面 re-export；split manifest `run-scope-pure`），`app-runner-pure` 移除 `runScriptApp`（非纯搬移）。新增**非门禁四源等价 lane** `tools/verify-run-execution.ts` + `tools/golden/run-execution/**` + `fixtures/engine/run-execution/**`：基线在干净 HEAD 副本上每源 `--record` 两次一致后入库，改后 `--check` 连续两次绿（外部请求 0、零模型）。规模：executor 2734→2668、app-runner 974→872、`runScriptApp` 799→698；maintain baseline 只下调。
- **W5-3 剩余收口：决策 runtime 注入**。engine 侧新增 `DecisionRuntimeHooks`（`MiddlewareOptions.decisionRuntime?`，三函数 `providerOrNull`/`wrapLaya`/`failureFact`），装配逻辑从 `executor.ready()` 拆到 `src/engine/decision-seam.ts`（87 行）；app 组合根 `src/app/decision-runtime.ts`（38 行）从 `model/decision-provider` 装配并在 `buildMiddleware` 缺省注入（显式优先）。`grep 'model/decision-provider' src/engine/` = 0；真实 `new BrowserMiddleware(` = 1；model→engine 反向边 7→6（`provider-escalator` 改本地结构类型）。行为四路径（显式 provider / legacy LayaRuntime / rules-only / probe-degraded）由 runtime lane 7 场景 + examples + 四源 lane 覆盖。
- **W4-4 剩余收口：桥 run 字段共享契约（5→2 处穿透）+ TS2375**。新增 `src/support/run-args-contract.ts`（395 行，L0 纯数据：19 字段 × tool 参数/CLI/argv 顺序/engine 映射/校验文案）+ 生成器 `tools/run-args-gen.ts`（`--write`/`--check` + 契约自检）+ 桥侧生成物 `integrations/dsh-bridge/src/run-contract.generated.ts`（check in，`npm run run-args:check` 进 check）。`index.ts` tool schema、`AmberFlowRunArgs`、`runArgs` argv、引擎 CLI 选项表/映射全部派生；新桥字段只改契约 + 重新生成（2 处），五处消费点 byte-unchanged。**等价证据**：tool schema 10/10 deep-equal、`runArgs` argv 13/13、`runApp` 端到端 argv 10/10、校验文案 5/5+3/3 逐字节、引擎 CLI 13/13、类型双向赋值 0 错；新字段 dry patch 回滚后 7 文件 sha256 全等。**TS2375**：`RunSummary.rescue.what_would_unblock` 改可选（与空则省略的生产者一致），运行期摘要字节不变，桥包 clean `tsc -b` 0 error。`prompt-hit` 的 bridge_desc/coverage 改为同时扫生成物（82/82、0 warn）。
- **laya token 级截断行为变更：先裁剪再编码 + `evidence_truncated`**。`src/model/laya-format.ts` 新增 `fitText`/`truncateTextToChars`，三面（head/options/state）统一「未超名额原样编码（逐字节不变）→ 超名额先按字符预算裁文本再编码 → 字符预算仍超才 token 切片兜底」，`OPTION_TOKEN_BUDGET=48` 收口，新增 `LAYA_EVIDENCE_CHARS_PER_TOKEN=4`（tuning 单源，12 概念）。截断事实经 `PreparedQuestion.truncation` → `aggregateEvidenceTruncation` → `PredictResult.evidence_truncated?` → `layaProvider.pick` → L0 `ChoiceOutcome.evidence_truncated?`（可选字段）→ engine 模型步 trace 行（无裁剪不出现，默认产物逐字节不变）。复现/回归工具 `tools/laya-truncation-check.ts`（frozen 参考基线 A/B，fake tokenizer，25 断言 + `--self-test` 28 断言），已进 check；改前：长 state 1503 token 静默保留 512、长 option 109→48 静默无记账。
- **门禁与文档**：`npm run check` 12→**14** 个 npm-run 步骤（新增 `run-args:check`、`laya-truncation:check`）；全门禁复跑 exit 0（check / verify:offline / verify:runtime:offline 7 场景 / 四源 lane / examples 5×3）。文档：`docs/IMPROVEMENT_PLAN.md` §6.5 C/D、§6.7 残留、§6.8 C、§3.4/§4.5、§7、§9 与新增 **§6.10 收口记录**；`docs/MAINLINE.md` §1.1/§1.2/§2/§4/§6/§7；`docs/BACKLOG.md` P2 出口演练状态；桥 `DEVELOPING.md` 补「增删 `*_run` 字段」流程。仍延期：ctx 行为矩阵/`tools/ctx-conformance.ts`、BACKLOG #3、handler 子进程内化（见 plan §6.10 F）。
- 以上改动未 commit（工作树交付）；桥既有 TS2375 为 HEAD 既有缺陷，本批一并修复。

### 行为（仅在显式 `--rescue` 开启时新增字段）

- `--rescue` 从「CLI/桥透传类型面」补成**真实 `result.rescue` 生产路径**：真实人工停因发生时，按停因映射 kind 并序列化结构化求援（`mode:"stop"`）；默认关 = 产物逐字节不变。
- kind 分类器（集中 `src/app/intervention-result.ts` 的 `STOP_CODE_KIND`）：`needs_human` / `needs_interactive_terminal` / `manual_declined` / `manual_handler_error` / `manual_signal_not_held` → `action`；`needs_value` → `value`；危险动作拒绝（`dangerous` / `declined`）→ `authorization`；其余停因不产出（null）。**只分类，不改 stopCode/status/exit code/控制流**；`needs_value`/危险拒绝不挂起。
- request 生成后当场 `validateRescueRequest`（fail-closed 拒写）；summary 取 `RESCUE_TEXTS[kind].summary`（≤400），`what_would_unblock` ≤3，evidence 仅 desc + 去 query/hash 的 http(s) URL。
- `--no-rescue` 补齐定义（此前帮助里写了但未定义，实测 exit 2）；`amber run` 入口与 `--rescue` 同给视为用法错误，直接 `app-runner` 入口以关闭优先；两个入口均接受该旗标。
- 离线验收：manual-only app 不带 flag = 20 键、无 rescue、`stop_code=needs_human`；带 `--rescue` = 21 键、唯一差异为 `rescue` 键（kind=action / mode=stop / request_id / summary≤400 / unblock≤3 / validate 通过）。
- 文档状态：`docs/INTERVENTION_RESCUE_MODULE.md` v1 实施完成（步 0-5）；`docs/P2_READINESS.md` 五项前置全部满足；P2 按 D3 顺序启动 2.0 RunCtx + evidence collector。

### P2 2.0 RunCtx + evidence collector + 运行期等价 lane（非门禁）

- 新增 `src/engine/run-context.ts`：`run()` 内四组记账闭包（stop 停因 / forbid+forbidWhy / noteSkipped / unforbid+pruneForbids）收敛为每 run 实例化的 `RunAccounting`；无模块级可变状态、无 Playwright 具体类型；`run()` 调用顺序/返回值/证据逐字节不变（executor.ts 6139→6084，run() 2685→2629）。
- 新增 `tools/verify-runtime-offline.ts` + `tools/golden/runtime/**`：**非门禁**运行期等价 lane（本地 fixtures 静态页 + 无头 chromium + `BrowserMiddleware.run`），4 个确定性场景覆盖成功/停因/遮挡失败证据/precondition 跳过；强制 rules-only、零模型、零外部请求；同场景 `--record` 连跑两次一致才入库。基线由干净 HEAD worktree 录制，P2 运行期重构前后用 `--check` 对比。
- 新增 `src/engine/evidence.ts`（140 行）：`run()` 内散落的行锚/身份/DRF 证据形状与停因尾缀收敛为纯函数 + 类型单源（`IdentityFacts`/`DeclaredFacts` 等；键顺序/条件 spread/文案逐字节不变）；帧证据仍由 `frame-scope.frameHintFailureEvidence` 单点。executor 6084→6023（run() 2629→2562），运行期 lane 4 场景不变。
- `package.json` 增 `verify:runtime:offline`（默认 check）与 `verify:runtime:offline:record`；夜间非门禁 CI 的 offline job 追加运行该 lane；不进 `npm run check`。
- 4d-1：`run()` 提出私有阶段方法 `runFrameGate`（72 行）——frame 门禁 / `excludedView`+`readPage` / `frames_excluded` warning / `goalHeld` 双面求值（`doneInExcluded` 经 getter 跨阶段可观察）/ `frameTargetStop` / precondition 双面证据与 `frame_not_allowed`/`skipped` 早返回；导航 goto/popup 信封检查仍在 `run()`（发生在帧门禁前，最小风险）。早返回 RunReport 字段/顺序/文案逐字不变；executor 6023→6019、run() 2562→2479；运行期 lane 4 场景不变。
- 4d-2：`run()` 提出私有阶段方法 `runPoolGate`（74 行）——步首快照/抽池/settle/poolReady 轮询/非 poolReady 分支/池高峰记账/beforeFp 首次观察/pendingAfterIdx after 补签/空池 `_poolReadiness` 判档（not_ready/ready_empty/strict）/`page_not_ready` 早停/pool_empty warning；返回 12 字段 PoolGatePhase，`stopped=true` 立即 break。`page_not_ready` 文案/日志/证据/落账时机不变；executor 6019=基线、run() 2479→2395；运行期 lane 4 场景不变。
- 4d-3a：新增 `src/engine/declared-targets.ts`（216 行）——FW8 身份回捞与 DRF 声明目标解析的逐步状态/逻辑收敛为每步实例化的 `createDeclaredTargetsResolver(deps)`（identityTried/identity/cleanup/stop/hidden + declaredTried/declared/cleanup/stop/hidden/miss），命令空间 walk 与 act-hint 两面共用；noteSkipped 键序/detail、ambiguity 模板、cleanup 时机、停因优先级、hidden warning、declaredMiss 逐字不变。executor 6019→5846、run() 2395→2226；运行期 lane 4 场景不变（命令面 identityLookup 覆盖）。
- 4d-3b：`run()` 提出私有阶段方法 `runDeclaredTargets`（220 行）——命令空间 walk 整段（`pendingUnresolved`/逐命令 hintMatch→identity→DRF→skip/done/候选尝试→`cmdPick`/`rowAmbStop`/target_not_found 早停）提取，返回 `DeclaredTargetsPhase{stopped,cmdPick,rowAmbStop,cmdI}`，27 项入参全显式、不闭包偷读外层状态；命令 id 归一/候选顺序/7 个停因文案/零执行摘要/优先级逐字不变。run() 2226→1989、executor 5846→5844；运行期 lane 4 场景不变（target_not_found 路径）。
- 4d-3c：`run()` 提出私有阶段方法 `runDeclaredHint`（88 行）——act-hint 解析面（hintLookup 注入循环/FW8/DRF/pruneForbids/dead-hint 沿 targetHints 前进/identityStop+declaredStop+行锚+frameTargetStop 四类早停/identityHidden+declaredHidden warning）整体提取，26 项显式入参、`_hintI` 经回调读写；与 4d-3b 的命令 walk 合起来构成九阶段 `runDeclaredTargets` 全貌。run() 1989→1882、executor 5844→5837；运行期 lane 4 场景不变（success-filter-bar 覆盖 act-hint 面）。
- 4d-4：`run()` 提出私有阶段方法 `runModelPick`（363 行，phaseFunctions 例外 ≤400）——规则命中→模型 ask→tieredHint 窄问→floor 闸门→reobserve 宽扫→escalate→adjudicate→R2b 词面宽扫→nominated-family 有界修复整段提取；返回 `ModelPickPhase{stopped,ref,conf,method,decisionKind,layaMargin,tierAsk,nominatedRepair,escalatedPick,elems,label}`（宽扫后 elems 交回、label 与原 mm 同源），~45 项显式入参、9 处早停由 stopped 驱动 break。停因文案/记账/日志逐字不变。run() 1882→1508、executor 5837=基线；运行期 lane 4 场景不变（rule:match 分支）。
- 4d-5：`run()` 提出私有阶段方法 `runPostAction`（182 行）——循环体尾段（动作 verbose 日志 / 动作后 host+popup 信封复核 / learned-hint count+advance / done 信号评估与学习 + dom_goal_signal / SPA settle 有界轮询 / manual 三分支 / inert+anti-repeat+adjudicated-missed / rehydrate 证据）整体提取；返回 `PostActionPhase{control:"next"|"continue"|"break", done, manualDone}`，9 个 break + 2 个 continue 转 control 由调用点落位；`pendingAfterIdx` 经 setter 回写（保证同段 flagSuspectedAsync 读到新值）。循环后 run 级 epilogue（no_state_progress/_runFlags/stepState）留在 run()，下一批提 runTail。run() 1508→1316、executor 5837=基线；运行期 lane 4 场景不变（done/SPA settle 与失败后路径）。
- 4d-6：动作阶段整段提取为两阶段方法（449 行拆两段，均 ≤400，phaseFunctions 例外）——`runActionPhase`（166 行：ActionAdapter 能力面/候选替换、verb+desc、DRY-RUN 探针、needs_value、pre-fill guard、风险闸门）+ `runActionExecute`（251 行：S4 stale 判据/重解析、hit-test/occludedReason、click/fill/select/hover/scroll/drag/clickAt/upload 分派、cleanup/config_error、executed/inert/changed、动作证据与 trace.push）。返回 `ActionPhaseResult{control,ref,el,elems,desc,how,executed,inert,post,lastEffect,flagSuspectedAsync,cmdDoneId,nextCmdI,executedDelta}`；8 个 control 返回落位，内层 stale for 的 break 原样；run 级写经返回值在 postPhase 前回写、dryRan/pendingAfterIdx 经回调/getter 保持原时序。run() 1316→884、executor 5836≤基线；运行期 lane 4 场景不变（正常动作/遮挡证据）。
- 4d-7a：`run()` 循环后 run 级 epilogue（after 指纹/前进性判定/flags/`_runFlags`/stepState）提为私有方法 `runTail`，返回 stepState；`no_state_progress` warning 与 flags 判定逐字不变。executor 5836→5831、run() 继续下降；运行期 lane 4 场景不变（含收尾观察）。
- 4d-7b：`run()` 的 active setup（状态游标重置 / `await ready()` / configError 早返回 / 导航信封 host 早返回 / launch+newPage / `pg` / observeState 闭包 / goto+settle / popup 信封）提为私有方法 `runSetup`（87 行），返回 `SetupPhase{kind:"early"|"ready", ...}`；early 带 browser 保持 finally 关闭语义（注入 page 不关）。运行期 lane 在本批实拦住一次 `skipNavigation` 双重取反回归（改前 3 场景红，改后 4/4 绿）。executor 5831→5830、run() 838→743。
- **4d 九阶段完成**：runSetup/runFrameGate/runPoolGate/runDeclaredTargets/runDeclaredHint/runModelPick/runActionPhase/runActionExecute/runPostAction/runTail（+既有 reportTail）全部落地；新增 maintain mainline 断言冻结 `BrowserMiddleware` 类名与 `run()` 签名字面（负向自测 22→24 条）。累计 executor 6139→5830、run() 2685→743；examples golden / verify:offline / verify:runtime:offline 4 场景全绿。
- 2.1（BACKLOG #2 第一步）：候选生产者契约 `CandidateProducer`（`candidate-contract.ts`，纯数据/结构类型、无 Playwright 具体类型）+ 引擎消费 seam——`MiddlewareOptions` 可选 `candidateProducer`，executor 全部 6 处 `extractElements` 直调改走 `this.candidates.extract`（默认实现仍为引擎扫描，参数逐字、行为零变化）；split-check 将 `MiddlewareOptions` 移出纯搬移 manifest（有意的契约 seam 变更）。2.2 扫描/筛选实现搬 app 层待做。
- 2.2a（BACKLOG #2 第二步）：新增 app 层候选生产者 `src/app/candidate-source.ts`（`createAppCandidateProducer`，当前逐字转调引擎扫描的占位实现），`middleware-factory.buildMiddleware` 默认注入 `candidateProducer`（显式传入优先）——所有工厂入口（start/plan/online/app 两面/session）默认走 app producer，候选/ref/宽扫触发点/池构成零变化；运行期 lane 4 场景即 app producer 路径的直接等价证据。2.2b 扫描实现搬 app 层并删除引擎默认待做。
- 2.2b-0（BACKLOG #2 前置）：扫描跨层消费者解耦——`model/page-context.captureStepStateView(page, scan)` 与 `data/source-validate.renderAndSnapshot(html, scan)` 改为显式注入 scan（不再 import `extractElements`），唯一调用点 app-runner 注入 app 层 `createAppCandidateProducer().extract`；data `--render` 无注入时结构化报错 exit 2（不 import app）。split-check 将 main/renderAndSnapshot/runSource 移出 datasource-pure manifest（有意的签名/实现变更）。行为等价：runtime lane 4/4、examples golden、check 绿。2.2b 扫描实现搬 app 层待做。
- 2.2b（BACKLOG #2 完成）：候选扫描实现搬 app——新增 `src/app/candidate-scan.ts`（367 行，`extractElements` 98 行 + `extractRowsPerElement`/`extractHeuristicWidgets`/`jsInteractiveWidgets`/`addNearContext` 逐字节搬移，split hash 搬前=搬后）；`src/engine/extraction.ts` 1959→1612，删除 5 个扫描符号，engine 内扫描 import 清零；删除 engine 临时默认 producer（`candidate-contract` 66→48，仅 type import），executor 的 candidates 可空并注明 factory 必注入；`src/app/candidate-source.ts` 变真实扫描实现；消费者 import 全部改 app 层；tools/learn.ts 随引擎导出移除改路径（1 行必要越界）。等价：verify:runtime:offline 4/4（buildMiddleware→app producer→app 扫描）、examples golden、verify:offline、check 全绿；>1000 行文件仍 6。
- 2.3（P2 公共面清理）：删除 MV3 `extension/`（background/content/manifest；仅 picker-server 注释引用，已同步改动，零代码消费）；`src/index.ts` 标注 **INTERNAL barrel**（不承诺引擎库 `import` API）；`picker-server` 标记 DEPRECATED（保留一版后评估移除）；`npm run maintain` 的 mainline 组新增**包身份门禁**——`package.json exports["."]` 必须为 DSH 插件入口、`src/sdk.ts` 不得存在（负向自测 26 条）；AGENTS/ARCHITECTURE/MAINLINE 补「消费面 = CLI + DSH 插件、无引擎库导入面」说明。
- 2.2-1（P2 执行内核首批）：新增 `src/app/session-lease.ts`（51 行）——S1 共享 seam `SessionLease`（惰性 `get()` 并发共享/创建失败可重试、`close()` 幂等且不覆盖 run 结果、所有权边界由适配器显式选择）；suite 适配器 `src/online/runner.ts` 接入，替换手写「browserSession + finally close」，行为逐字节等价（online runner 320 行净 0）。flow/plan 适配器与 RunScope/StopClassifier/runExecution 组合根留后续批次。
- 2.2-2（P2 执行内核）：`SessionLease` 接入 **flow 适配器**（`src/app/app-runner.ts` 两面）——`session-lease.ts` 增 `peek()`（不触发创建）；`runApp`/`runScriptApp` 删除手写 holder/getShell/ensureSession，统一惰性 get + finally close；创建时机/factory 优先/manualInSegment headless/device/policy.browser/close 在不变量之后全部逐字不变。flow 面运行期实测：fixtures 静态服务 + 临时 flow app 的**改前×2 / 改后×2 归一化结果逐字节一致**（各 173 行）。app-runner 2853→2847（净 −6）。
- 2.2-3（P2 执行内核 · S3）：新增 `src/online/suite-aggregate.ts`（35 行）——`suiteExitCode(failed, skipped, requireAll)`（0/1/3 分类）与 `applyProbeExpectations(case, base)`（probe 观测→skipped；`expect_zero_actions` 违约原样返回，不被映射吞成 skipped）从 online runner 抽为纯函数单点；runner 删除本地 `probeOutcome` 与内联退出码表达式改复用（320→301，−19）。套件退出码/`--require-all`/probe 期望语义逐字不变。
- 2.2-4（P2 执行内核 · S1/StopClassifier）：退出码→结果包络 `error.code` 名映射收为单点——`src/cli/errors.ts` 新增 `exitCodeName(exitCode): ResultCode`（OK/INCOMPLETE/USAGE/BLOCKED/QUALITY_GATE/INTERRUPTED，直接取自 `EXIT` 表）；`run.ts`（两处包络；`needs_human` 覆写保留在调用点）、`plan-result.ts`、`model.ts`、`record.ts` 共五段内联三元链删除。可达退出码（0/1/2/130）包络逐字不变；`model`/`record` 对 exit 3 此前落 INCOMPLETE、现与 `run`/`plan` 一致为 BLOCKED（两入口子进程只返回 0/1/2/130，不可观测），exit 4 从 INCOMPLETE 收紧为 QUALITY_GATE（四个入口均不产生 4）。
- 2.2-5（P2 执行内核 · S1/plan 适配器）：SessionLease 下移 **L4** 并接上最后一个源适配器——`src/app/session-lease.ts` → `src/engine/session-lease.ts`（`BrowserSession` 是执行器类型，`planner` 为 L4 同层消费；engine 不得反向 import app，flow/app 与 suite/online 改向下引用）；`planner.runPlan` 的 `sessionFactory()` + 手写 `try/finally session.close()` 改为「惰性 `lease.get()` + finally `lease.close()`」，创建时机（todo 非空时首次 get）/注入 factory 优先/返回对象逐字不变。**plan 面运行期 A/B**：本地夹具 + rules-only + 真实 `runPlan`，done（rule:match 点击→信号）与 blocked（规则未命中 hint）两条路径归一化结果**改前/改后逐字节一致**。唯一可观察差异：close 抛错时不再以关闭异常覆盖 run 结果（S1 租约契约，正常路径不可见）。
- 2.2-6（P2 执行内核 · S1/RunScope）：新增 `src/app/run-scope.ts`（45 行）——`run_id`/`outDir`/`planPath`/`today` 的默认值链与 `ctx.runtime` 投影收敛为 `createRunScope({appId, planPath?, outDir?, runId?, today?})`；声明式 `runApp` 与 flow `runScriptApp` 两面接入（声明式面仍以 planPath 派生产物目录、flow 面保留 `outDir`/`runId` 显式注入，所有权差异留在适配器）。`app-runner` 净 0 行（2847）；**两面运行期 A/B**：夹具 + rules-only 真实 `runApp`/`runScriptApp`，归一化结果 + 落盘 plan **改前/改后逐字节一致**（仅时间戳/run_id/耗时类易变字段不同）。RunScope 的其余目标字段（budget/deadline/trace/result/warnings）仍归各源，未进入本契约。
- W5-3（P2 条件，部分落地）：DecisionProvider 接口契约下沉 L0——新增 `src/support/decision-provider-contract.ts`（159 行：ProviderCapabilities / ProviderInfo / ProviderPage / StateDigestPayload / ChoiceRequest / ChoiceOutcome / ClosedSetRequest / ClosedSetChoice / DecisionProvider / ProviderFactory + `ProviderModelState` 别名）；页面形状纯类型下沉 `src/support/page-like.ts`（54 行：InnerLoc / LocLike / FrameLike / PageLike），`extraction.ts` re-export 保持既有导入面（1612→1569）。`model/decision-provider.ts` 删除类型定义改为 re-export（628→510）；engine 三处类型导入改契约，`grep 'model/decision-provider' src/engine` 3 文件→1 文件（`executor.ts` 仅剩 3 个 runtime 函数），`executor.ts` 行数不变（基线内）。行为零变化：仅类型搬移，runtime lane 4/4、verify:offline、examples golden/check 全绿。
- P2 出口核对（2026-11-17）：`docs/IMPROVEMENT_PLAN.md` §6.5 记录 §3.4 P2 列指标、§9 五痛点闭环与扩展演练 5 项；**P2 收口**，条件项（`runExecution` 组合根/ctx conformance、W5-3 runtime 函数注入、W4-4 桥字段契约、W3-4 站点知识出引擎、BACKLOG #3、1.6 证据 spec、handler 内化）明确延期并保留触发条件。扩展演练（新 provider / 配置键 / 调参 / 桥字段 / ctx 原语）在 `/tmp` worktree 真实补丁后回滚：3 项达标、2 项暴露缺口（provider 注册清单双份、配置键 `WHERE_USED` 手写表、桥字段 5 处穿透），已登记 `docs/BACKLOG.md`「P2 出口演练发现」。
- P2-1（出口演练修复）：provider 注册清单单点——`src/model/decision-provider.ts` 新增 `registerAllProviders()`（幂等，注册 baselines/jevk5/bailian/token-plan）；`resolveProviderSpec`、`amber doctor`、`start --doctor` 三面改走同一清单，删除 doctor/start 各自维护的 3 份注册代码。**行为等价**：doctor `--json` 输出与未知 provider 错误列表改前/改后逐字节一致；check/runtime lane 绿。新增 provider 的改动面 3 处→2 处（adapter + 清单一行）。
- E1（大文件拆分 · extraction 纯区）：`src/engine/extraction.ts` 1569→858 行纯搬移——element model/`Elem` 形状/动作能力面/槽位助手 → 新 `src/engine/elem-model.ts`（434）；帧读侧（帧门禁/`frame:` 选择器尾缀/`locatorAnyFrame`/`countAnyFrame`/帧证据）→ `src/engine/frame-scope.ts`（149→438）；`firstOf`/`urlOf`/`framesOf` → 新 `src/engine/page-shapes.ts`（28）。extraction 保留 re-export，仓内 importer 零改动。**等价证据**：extraction 运行时导出面 `Object.keys` 改前=改后；split-check `extraction-pure`（87 符号，搬前同名 77 个 hash 0 mismatch）；check + 双离线 lane 绿；size 基线 extraction 1612→858。
- E2（大文件拆分 · pool-js 共享片段）：`src/engine/pool-js.ts` 1102→824 行纯搬移——COLLECT / BUCKET_HELPERS / LABEL / STRUCTURE / ANCHOR / ROW_CLIMB 六段共享 JS 与宿主 `compile` → 新 `src/engine/pool-js-core.ts`（296）；pool-js 的 pass 仍内插同一份、re-export 导出面不变。**等价证据**：pool-js 运行时导出面 + 全部字符串/编译函数 `toString` hash 改前=改后（27 符号 0 mismatch）；split-check `pool-js-pure`；check + 双 lane 绿；size 基线 pool-js 1102→824。
- E3（大文件拆分 · session-runtime）：1460→992 行——契约（`SessionOptions`/`SessionSink`/退出码/flap 判据/小工具）→ `src/app/session-runtime-contract.ts`（245）；响应证据与校验 helper（歧义/可行动性/落空诊断/截图/回读/信号形状/read/signal/waitFor）提为显式依赖纯函数 → `src/app/session-runtime-evidence.ts`（195）；`runSession`（stdio/空闲超时/退出码）→ `src/app/session-runtime-entry.ts`（79）。原文件 re-export 保持导入面。**等价证据**：fixtures 静态服务上的 in-process 会话协议 A/B（open/observe/act/read/signal/extract/mark/close 全链路）归一化响应 JSON 改前=改后；check + 双离线 lane 绿；size 基线 session-runtime 1460→992。
- A1（大文件拆分 · app-runner）：2847→**974** 行（bridge 按路径 spawn 本文件 + CLI 入口 guard 不动）——类型/纯助手 → `src/app/app-runner-types.ts`（752）；策略面（`EffectivePolicy`/`AppRunConfigError`/`resolveRunPolicy`/`preflightConfig`/`resolvePace`/策略探测）→ `src/app/app-runner-policy.ts`（357）；工具步 → `src/app/app-runner-tool-step.ts`（149）；声明式面 `runApp` → `src/app/app-runner-declared.ts`（718）；app-runner 保留 `runScriptApp` + facade re-export。**等价证据**：两面运行期 A/B（夹具 + rules-only，声明式 journey 与 flow 脚本各跑真实 `runApp`/`runScriptApp`）归一化结果 + 落盘 plan 改前=改后；app-runner 运行时导出面 24 个既有键全保留；split-check `app-runner-pure`（30 符号，24 个 hash 逐字节相同、6 个仅加 `export` 修饰）；check + 双离线 lane 绿。**门禁**：size 组新增 `movedFunctions` 纯搬移 allowlist（行数只许降不许增），登记 runApp 686 行。
- L1（运行期等价 lane 扩展）：场景 4→**7**——新增 `action-upload-file`（`setInputFiles` 分支）、`action-scroll-container`（元素目标→最近可滚动祖先，moved/delta/scroll 证据）、`action-range-fill-and-setRange`（`input[type=range]` 执行路径；run() 面 `by`/`set_range` 不可达已如实说明）。fixtures `upload.html`/`scroll.html`（CSS 锁几何）/`range.html`；每场景 --record 两次一致、外部请求 0、`--check` 7/7、原 4 份 golden 逐字节不变。
- X1（大文件拆分 · executor）：5829→**2721** 行（类名/`run()` 签名逐字节不变）——九阶段/动作/解析实现切成显式 `mw` 依赖的模块函数：`executor-phases-a/b/c.ts`、`executor-actions.ts`、`executor-resolve-a/b.ts`（均 <800 行）；类保留构造/核心循环/5 个公开方法薄包装（`actOnce`/`scrollIntoView`/`scrollContainer`/`scrollDocument`/`setRange`）。**等价证据**：7 场景运行期 lane --check 全绿 + examples golden + `npm run check`；phase 类型/helper 导出；size 门禁 movedFunctions/phaseFunctions 路径同步。
- C1（大文件拆分 · ctx）：`src/app/ctx.ts` 1799→**170** 行（`createCtx` 闭包拆为显式 deps 工厂）——`ctx-runtime`(313)/`ctx-step`(280)/`ctx-tools`(211)/`ctx-read`(480)/`ctx-nav`(231)/`ctx-scroll`(171)/`ctx-manual`(154)；ctx.ts 只做组装，ctx-types/ctx-dry/ctx-replay/app-runner 零改动。**等价证据**：导出面 53/53；dry+live_result+flow 三面 A/B 归一化后 **30,501 bytes 完全相等**（覆盖 arrive/step/hint/when/read/observe/extract/collect/scrollList/expand/setRange/errors/manual/tabs/done）；split-check 后置基线 `ctx-modules`；check + 双 lane 绿。
- 大文件拆分收口（2026-11-17）：6 个 >1000 行文件 → **1 个**（仅 `executor.ts` 2721 ≤3000；其余全部 <1000；新文件 ≤800）。累计：executor 5829→2721、app-runner 2847→974、ctx 1799→170、session-runtime 1460→992、extraction 1569→858、pool-js 1102→824。每批独立提交 + 等价证据（A/B / 7 场景运行期 lane / examples golden / split manifests）；size 门禁新增 `movedFunctions` 纯搬移 allowlist。明细见 `docs/IMPROVEMENT_PLAN.md` §6.7；W5-2 完整 ctx-conformance 工具仍为条件项。
- 提示词产品化审查与优化（用户/产品视角）：概述改三段式（308→275 字符）；六步法 short/full 目标先行、分句去嵌套（407→376 / 2061→1402）；失败速查改条件→动作 bullet（309→258）；37 条 STOP_NEXT 全部压到 ≤120（最长 200→115）；桥 **82 条工具描述重写**（21,136→11,692 字符，−44.7%；最长 3,725→584；>800 由 3→0；amber 命令死链 0、站点名 0；schema/枚举/代码逐字节不变，4 处动态常量保持单源）。新增 prompt-hit **clarity** 组（fail）：禁模糊措辞/双重否定/待定词、单句 ≤200、STOP_NEXT ≤120、概述结构、HOME_NEXT why ≤40；契约文本句长显式豁免。模型 11 条 prompt 保持冻结（78–401 字符，改动需 version+1+快照+真站 A/B）。`prompt-hit` 十三组全绿（bridge_desc 0 warn）；check + 双 lane 绿。
- W3-4（常量配置 · 站点知识出引擎）：数据/报表机制不再认识业务字段——Source JSON 新增/启用配置字段 `selects[].value_field`、`selects[].value_fields`、`selects[].detail_fields`、`report.value_fields`、`report.currency_field`、`report.detail_fallback_fields`、`filters.time_field`（`src/data/types.ts` schema 文档 + `source-validate` 加载期校验，缺配走通用回退）；`extract-ops.selectIndex` 去掉隐式 `["price"]` 排序缺省、`report-view` 主值/货币/标识列/时间列全部配置驱动、`pack-expand.resolveSourceSlots`/`app-runner` selects 回写改配置值。新增站点知识扫词门禁 `tools/site-knowledge-check.ts`（23 词闭集 / 8 条带理由白名单 / `--self-test` 9 断言 / `--json`），接入 `npm run check`，当前 src 零命中。等价：显式配置路径 A/B 逐字节一致；**未配字段映射的迁移差异**（需按迁移模板补配置）：①`sort_by` 缺省由 `["price"]` 改“不排序取首行”；②报告加粗值缺 `value_field` 不再猜 price、标识列取首个非空标量；③货币前缀仅对显式 `currency_field` 生效；④时间列旧 `dep` 缺省删除，需显式 `filters.time_field`；⑤CLI 摘要“最低”改取 `selects[].label`；⑥`resolveSourceSlots` 未传配置值回退由 price→id→name 改行内首个非空（生产路径总传配置值）。
- W4-2/3/4（提示词 · 四面门禁收口）：`prompt-hit` 由 9 组扩到 **12 组**——新增 `agent`（`src/prompts/agent-prompts.ts` 的 `plan.rules` PromptSpec：1433 字符 ≤1600；playbook short 407≤500/full 2061≤2200；候选窗口 403 字符数字由 `FULL_LABEL_MAX`/`MODEL_LABEL_MAX`/tuning 常量渲染；plan.ts 只装配）、`evidence`（`src/prompts/evidence-prompts.ts` 5 条 spec + 分级预算 40/120/200 = 1815/5551/9503 ≤6k/12k/20k + `tools/golden/prompts/evidence.json` 快照）、`bridge_desc`（warn-only：82/82 桥描述 21,136 字符，>800 三条 warn，命令死链 0，站点名 0）。模型 prompt 文本与 Agent/证据渲染文本 **hash 改前=改后**（0 差异）；`plan.rules`/候选窗口文本未变。
- P2-2（出口演练修复）：配置键「作用点」并入 schema——`ConfigKeySpec` 新增 `usedAt` 字段（配置面键必填、缺失时生成器 exit 2 并点名键），`tools/config-example.ts` 删除手写 `WHERE_USED` 表（33 键）改从 schema 读；生成的三份文档逐字节不变（`git diff` 为空）。新增配置键的改动面 3 处→2 处（schema 含作用点 + 消费点），生成物仍由 `npm run config:example` 刷新。
- gate：`baseline.size.phaseFunctions` 新增 `src/engine/executor.ts#runDeclaredTargets`（九阶段显式例外 ≤400 行）；`maintain --update` 协议修正为跳过 phaseFunctions 名单（不再误报「新增超标函数」），负向自测 + 1 条正例。


## Decisions（设计决策索引）

> 本节不是发布条目，而是**约束未来代码的设计决策索引**（为什么这样做、以后别再改回去）。
> 只收「会约束后续实现」的决策；完整变更史仍以各版本条目为准。新决策追加在末尾。

### D1 包身份 = CLI + DSH 插件，不承诺引擎库 API（2026-11-17）

消费面是 CLI（子进程 + JSON 契约）与 DSH 桥；`package.json` 的 `exports["."]` 指向 DSH 插件入口，是插件安装门，不得替换成引擎库。`src/index.ts` 不是稳定公共面（内部导出，仓内 0 消费者）。要把 AmberFlow 嵌进别的系统，走 CLI 或桥，不要 `import` 引擎内部模块。见 `README.md`「消费面与包身份」、`docs/MAINLINE.md` §3。

### D2 完成只认信号，模型票只是 advisory

`checkSignal` 是完成与 `when` 的唯一裁决；模型 done 票、报告渲染、提示词、配置都不得参与判定。任何重构不得让"看起来完成了"替代信号成立。见 `AGENTS.md` 硬规则、`src/engine/signals.ts`。

### D3 唯一执行器

`BrowserMiddleware.run` 是唯一执行循环；flow 应用、计划 CLI、线上套件都复用它，不另写执行器。拆分只允许同门面机械拆分：类名与 `run()` 签名逐字节不变。见 `AGENTS.md` 架构、`docs/MAINLINE.md` §4（seam 冻结）。

### D4 `verify_after` 被禁：动作后额外校验不是键，是新原语

TaskPlan 不再接受 `verify_after`（`signal` | `none`）——它的两个取值里一个空转、一个正是执行循环默认行为。将来若要"动作后额外校验"，那是一个新原语，不是把这个键加回来。见 `src/engine/plan.ts` 顶部注释。

### D5 配置层叠顺序固定，旧 rc 永远是最低层

优先级：CLI 旗标 > 环境变量 > 项目配置 > 用户配置 > 旧 rc > 内建缺省。旧 rc 不得压住项目配置（历史事故已复现过）；`support/merge-env.ts` 的 `applyEnvNoOverwrite` 是唯一实现，入口不得各写一份。

### D6 掩码 sentinel 单源

敏感值掩码（顶层 slots / effect 读回 / trace / report / stdout）的 sentinel 唯一出处是 `src/support/mask.ts` 的 `MASK`；任何输出面不得手写 `"***"`。明文凭据绝不进入用例/计划/报告/trace/仓库产物。见 `AGENTS.md` 硬规则、`src/app/redaction.ts`。

### D7 模型 prompt 单源，改动 = 行为变更

模型决策提示词唯一出处是 `src/prompts/`（L1 叶子）；协议差异（systemone/openai/laya 的证据能力）走能力矩阵，不在消费点回抄。任何措辞变更必须 `version+1` + 快照 hash 更新 + 一条真站 A/B 证据；`tools/prompt-hit.ts` 的 `model` 组是门禁。见 `docs/PROMPT_SYSTEM.md`、`tools/golden/prompts/snapshot.json`。

### D8 配置文档是生成物

`configs/amberflowrc.example.json`、`.env.example`、`docs/CONFIG_REFERENCE.md` 都由 `src/support/config-schema.ts` 派生（`npm run config:example`），`config:example:check` 三向逐字节校验；不要手改。新增配置键只改 schema。见 `docs/CONFIG_REFERENCE.md` 头部。

### D9 离线夹具只用于非门禁等价验证

`fixtures/engine/` 不是测试套件，只服务 `npm run verify:offline`（本地静态服务 + 无头 chromium + 确定性观测）与纯搬移等价验证；**不进 `npm run check`**。仓库仍不包含单元测试/复刻站，真实站点套件（`online/`）是唯一测试层。见 `fixtures/engine/README.md`、`AGENTS.md`。

### D10 注释规约：历史归 CHANGELOG

注释只写契约/不变量/安全语义/非显然 why/符号指针；不写日期戳、方案批次号、行号锚点、变更叙事。历史进本文件的版本条目（不新建 `docs/DECISIONS.md`）。见 `AGENTS.md`「注释规约」、`npm run maintain:check` 的 comments 组。

### D11 主线与分层唯一出处

依赖分层 L0–L6(+L1.5)、执行阶段 S0–S5、入口/进程边界、seam 与文件归属的唯一出处是 `docs/MAINLINE.md`；新增顶层目录/入口/seam 必须先改 MAINLINE 再改代码。`npm run maintain:check` 的 mainline 组做静态断言。

### D12 纯搬移必须有可重复等价证据

拆分/搬移 PR 必须用 `tools/split-check.ts` 记录搬迁符号源码 hash（纯搬移 hash 不变）；应用级行为由 `examples-check` 的 canonical golden 与 `npm run check` 兜底；运行期拆分还要过 `verify:offline`（非门禁）与 freeze window。见 `docs/IMPROVEMENT_PLAN.md` §7。

## [Unreleased] — 2026-11-16 架构评审收口（F85）：行锚 fail-closed + 恢复面/记忆面/编号口径 + F80 + lint + 在线校验 + 仓内断言

### 编号口径（一次写清，全文以此为准）

- **批 1 = F82**（`in-row:<token>`）、**批 2 = F83**（`row-index:N`）、**批 3 = F84**（记忆产物
  带行锚 + 桥 ElementView 透传 + `hint_token_allow`）。部分文档/TS 注释此前写作"F83 批 3"，
  以本条映射为准（本文件与 BACKLOG 各写一次；其他文档只引用不重述）。
- **本次评审修复批次 = F85**（schema 声明「行锚消费面 fail-closed 收口」）：行锚多候选零动作、
  恢复面四面 fail-closed、记忆面禁产单用 row-index、编号/标签口径对齐、lint 聚合等——下文
  各条均属 F85。

### 行锚 fail-closed（P0；**行为变更（有意为之）**：多候选从"取首行/交模型"改为结构化停）

- `src/engine/rules.ts` 的 `hintMatchImpl`：声明 `in-row:`/`row-index:` 且 `limit` 后候选 >1 时
  返回 null——不再用 `firstIfSame` 合并同签名候选（11 个同文案 "Add to basket" 签名相同，
  点错行 = 买错商品）。**未声明行锚时 `firstIfSame` 语义逐字节不变**。
- 执行器在**命令步**与**决策步 act hint**（widen/strict 之前）检测
  `hintCandidates(target).refs.length > 1` 时结构化 `target_ambiguous`、**零动作**、候选进
  `skipped_actions`——不取首候选、不交模型猜；会话 act / strict / A3 面经同一谓词自动继承。
- 文档同步：`docs/ROW_ANCHOR_HINT_PLAN.md` / `docs/ROW_INDEX_HINT_PLAN.md` /
  `docs/APP_SCRIPT_AUTHORING.md` 的"token 撞多行 = `target_ambiguous` 零动作（永不选第一行）"
  从承诺改为**已由解析面兑现**（本次 review 收口）。

### 恢复面 fail-closed（FW8 / DRF / F64 / A3 统一）

- `identityHintInfo`（FW8）、`declaredLookup`（DRF）、F64 `#id` live-DOM 直查在目标声明了行锚
  时**不参与恢复**（返回 ineligible / 不尝试）：声明行锚落空 = `target_not_found` + 行锚证据，
  绝不会按 base 身份/文本绕过行约束动作。A3/回捞行已支持行锚底座（F82 批 1）。
- 修复路径定性：恢复面按 base 找到唯一元素直接动作、静默丢掉作者写的行约束，比显式落空更危险
  ——四面统一为 fail-closed（证据单点仍为 `extraction.frameHintFailureEvidence`）。

### 记忆面（learned hint 不固化序号）

- `induceHint` 不再产出"单用 `row-index`"的 learned hint——位置性 hint 的序漂移责任只属于作者
  显式声明（learned hint 是后续同 url+subgoal 的权威，命中错行不回退模型）；只接受含
  ` in-row:` 的内容候选，内容不可分时宁可回退 base。
- `meta.policy.hint_token_allow` 下传到记忆生成面（`induceHint(..., {tokenAllow})`）——面覆盖
  补齐：**run 歧义证据 + `ctx.observe` + record/`induceHint`**。

### 编号/标签口径对齐（四采集面同一出处）

- 池 `addNearContext` / `OBSERVE_JS` / `HINT_HEAD` / A3 四 pass 的 dup 键统一为共享
  `__rowLabelOf`（与池 label 同口径：aria-label→title→**首子节点文本**→innerText→placeholder→
  value；input/select 追加 label 包裹文本；PUA 剥除 + 空白折叠 + 40 字符）；池/observe/
  `HINT_HEAD`/A3 的编号只计**可见**成员（与池/observe 对齐）。
- **残余边界（如实写）**：池面元素宇宙 = `POOL_SEL`+heuristic 候选集、回捞/observe 面 =
  `ADMIT_SEL` 集合；池帽只截尾、编号是页面前缀不压缩——两集合对同组成员不一致时 N 仍可能
  不可移植。口径 = **跨面可移植的前提 = 同名组成员在两个收集面都在场；照抄 inspect 候选前用
  `ctx.observe`/run 复核**（后续项见 BACKLOG「编号基统一到页级全量收集」）。

### schema / grammar 单源

- `schema-gen.ts` 的 `HINT_GRAMMAR` 增加 `row_suffix`/`row_index_suffix`（含 row-index 生成
  纪律与 fail-closed 语义），cheat sheet 同步；TS 侧注释约 20 处"F83 批 3"统一为"F84 批 3"
  （仅注释，无运行时行为）。

### 门禁 / 工具链

- `tools/schema-ensure.ts`（precheck）改为**无条件重生成**快照：`npm run check` 本机可绿；
  `schema:check` 退化为"渲染一致性"检查（快照是 gitignored 构建产物），漂移门由发布/CI 的
  `npm run check:ci` 承担。
- `hint-lint`：合法行锚声明（`dupOnly`）不再逐条刷 stderr，聚合为一行汇总（`rejected` 仍
  逐条）；"用行锚的 app 永远不 clean"问题解除。
- `npm run check` 现在以 `npm run precheck`（无条件重生成快照）开头，并在 `test:validate` 前接
  `npm run row-anchor:check`（`tools/row-anchor-check.ts`，合成 ElemPool 24 条断言）：行锚解析/
  匹配 fail-closed（多候选 = null）、恢复面四面不参与、记忆面禁单用 row-index、四采集面编号/
  dup 键同口径。`npm run check` 本机可绿；真站证据仍在仓库外。

### 在线声明面

- `validateBundle` 构造 TaskPlan 后跑 `PlanningRules.problems`（commands/target_hint/slots 等
  在加载期拦截）；probe 用例新增零动作断言能力（**可断言零动作/零错点**，字段名以在线层实现
  为准）——probe 的 fail-closed 正向证明不再只靠"诚实落空"的文字观察。

### 辅助收口（F85）

- `meta.policy.hint_token_allow` 含 `>` 的项加载期 `config_error`（该词元按 hint 词法永不生效，
  静默放行 = 假配置）；record 面 tokenAllow 与歧义证据面同口径。
- 命令空间自动 id（`cmd<序>`）不再与显式 id 撞车——重复 id 会经 `cmdDone.has` 被静默跳过
  （第二条命令零证据消失），按显式集合去重后追加 `_`。

### F80 修复（桥 open 的 idle_timeout_ms 原样下传）

- 见下方「架构师裁决补丁批次二」F80 小节（本次修正 `0` / `>0` 的子进程下传语义）。

## [Unreleased] — 行锚批 3 首项：记忆产物带行锚 + 桥 ElementView 透传 + 词元护栏放行表（F84）

### 背景

行锚 `in-row:`（F82）/`row-index:`（F83）落地后，三条消费链尚未收口：learn/record 的记忆
产物落在同文案重复组时仍是普通形状（回放歧义 → 退模型，记忆价值打折）；桥 ElementView
白名单未列 `row_texts`/`row_index`（Agent 桥面看不到行锚底座事实）；第 5 档词元护栏把
"恰似数字"的 SKU 词元连同价格/时段一并拒绝（误杀无调优出口）。本批一次收口。

### 记忆产物带行锚（induceHint 双参形态）

- `induceHint(elem, elems?)`：`elems` 在手时，普通形状（identity / near~label）
  **不自证唯一**（`hintMatch(base, elems) === elem.ref` 不成立——歧义或落空）且元素是
  **同文案重复组成员**（row_texts/row_index 在场）⇒ 复用 `suggestHints` 第 5/6 档纪律取
  行锚候选（内容候选优先、row-index 仅内容不可分——同一 push 自证唯一，**不发明第二套
  生成逻辑**；与批 2 遗留收编的歧义面同判例）+ E5 先例帧尾缀。
- **非 dup / 已自证唯一 / 单参调用产物逐字节不变**（全部既有调用点——findByHint 对照面、
  amber start 演示面——保持单参调用）；record 面（executor 的 hintMemory.record）改传
  `(el, elems)`。回放消费链 `currentHint → hintMatch → parseHint` 的尾缀 parse 由
  splitTailSuffixes 唯一出处自动支持（核验，零新增代码）。

### 词元护栏放行表（deny-list 可配化，meta.policy.hint_token_allow）

- 第 5 档词元护栏（价格/时段 deny 模式）的**放行词元表**可由应用声明：表内词元跳过 deny
  模式直接参与 in-row 候选生成——SKU 恰似数字被误杀时的外科调优出口（deny 追加不解决
  误杀，放行才解决——按语义命名 `tokenAllow`，不按"deny-list"代号，实施记录报备）。
- **配置面 = meta.policy**（理由：词元误杀是站点内容特征，SKU 形态随站点而变 → per-app
  policy；config-schema 全局键会跨站点污染；沿 F58 attr_value_match / F59 act_hint_tier
  先例）。校验 = 字符串数组、≤16 项、每项非空无内部空白 ≤40 字符（非法 = config_error）；
  比较小写折叠；**结构约束（非空/禁 `>`/≤40）不退让**；缺省不写 = 护栏行为逐字节不变。
- **单点消费** = `rules.suggestHints.tokenOk`（新增 `HintSuggestOptions.tokenAllow` opts 链）。
  **面覆盖**：run 面歧义证据 suggested_hint（executor → describeAmbiguity 下传）+
  `ctx.observe` 自证池 hint_candidates（CtxDeps → observePage 下传）；inspect CLI /
  session / 桥面缺省——F58 attr_value_match 同款面边界，文档写明。
- 显式声明才进 `effective_policy.hint_token_allow`。

### 桥 ElementView 透传 row_texts / row_index（BACKLOG #4 收口）

- `integrations/dsh-bridge/src/element-view.ts` 白名单两键：`row_texts`（strArray ≤6 行 ×
  ≤40 字符，与引擎口径同界）、`row_index`（number 透传）——**仅同文案重复组元素携带**
  （引擎 dup 门控采集；非重复组/缺省不出键，桥不补字段）。批 1/批 2 文档的"桥白名单未列"
  边界声明关闭。

### 文档与契约

- schema **F84** 声明（dist/schema/ctx.json 是 gitignored 构建产物；`precheck` 无条件由当前源
  重生成，`schema:check` 只验渲染一致性，发布/CI 的 `check:ci` 才是漂移门）；
  `docs/APP_SCRIPT_AUTHORING.md`：meta.policy 表 + policy 键表 + §4.12 词元护栏段加
  hint_token_allow；`docs/AGENT_INTERFACE.md`：ElementView 表 `row_texts`/`row_index` 行
  改写为已收编；`docs/BACKLOG.md`：行锚立项 #4/#8 收口、#5 注记、#9 批 3 状态。

## [Unreleased] — 顺序行锚 hint `row-index:N`（F83 批 2：解析/匹配/编号底座/回捞/回退/生成纪律/observe 闭环/trace 证据）

### 背景

`in-row:<token>`（F82）解决了"行内容可分"的同名网格；但排序榜、低价列表、"排序命令后点
第 N 行"场景里**序号可以是语义本身**——内容随排序翻动，顺序才是目标定义，内容词元锚
必然漂移。`row-index:N` 与 `in-row:` 同构（同一 dup 组底座、同一 fail-closed 对称、同一
R2-5 整组回退纪律），是第四类尾缀。规格与评审记录：`docs/ROW_INDEX_HINT_PLAN.md` v1.0
（v0.9 评审稿 + lead Q1-Q6 仲裁定稿；批 2 首项，一次 PR）。

### 语法与解析（hint.ts）

- 任意形状可后缀 ` row-index:N`：值闭集 = 1-based 正整数、无前导 0、≤9 位（Q4 仲裁）；
  `0`/负数/非数字/带空白 = 整组回退（绝不半剥）。四类尾缀（within/frame/in-row/row-index）
  各至多一次、任意书写次序、可组合；**三类既有解析分支逐字节不动**，row-index 分支同结构
  追加（含属性值内伪尾缀守卫）。`ParsedHint` 六形状各加可选 `rowIndex: number`；
  `rowIndexValueProblem` 三类（empty / not-positive-integer〔文案点名"row-index 从 1 开始"〕
  / too-many-digits，B 项修正）+ `describeRowIndexSuffixRejection`（与 frame/in-row 版同构）。

### 匹配（rules.ts）

- `limit = rowIdx(inRow(inAnchor(refs)))`——rowIdx = `row_index === N` **整数全等比较**
  （序号是离散身份，无子串语义）；批 1 已把全部形状调用点收口成单一 `limit` 出口，row-index
  并入即自动覆盖六形状/档位/tag-submit/bare（无须逐点接线）；限定后本档清空 = 落空不跨档
  降级；**fail-closed 对称**：元素无 `row_index`（非重复组）⇔ row-index 恒不命中。

### 数据面（Elem.row_index：dup 组 DOM 先序编号）

- `Elem.row_index`（1-based）：dup 组内 DOM 先序位次。编号口径 = **帧内 (tag+label) 子组
  scan 升序**（跨帧同名网格各自编号；跨帧歧义由 `frame:`/firstIfSame/歧义谓词兜住，D2 既有
  口径）；**仅同文案重复组携带**（与 near/row_texts 同触发）；**不进模型面**
  （`modelProjectionOf` guard+解构两处同步剥离，B5 教训）、**不进 esig/firstIfSame 签名**。
- `addNearContext` 宿主编号（纯内存排序，零新增页面往返）；OBSERVE_JS dup 门控编号
  （rows 数组序 = DOM 先序；**无 dup 页观察 JSON 逐字节不变**）；ROW_CLIMB_JS 本体不动
  （编号不是爬升产物）。

### 回捞/回退对等（F-1 同构）

- **HINT_HEAD 门触发条件扩为 in-row 或 row-index 声明**；编号 = **一次 O(n) 全组位次表**
  （`__dupLabelsOf`/`__dupKeyOf` 单一出处；C 项修正：非逐候选计算——**单用 row-index 零爬升
  成本**，memo 只适用组合守卫的 row_texts 爬升）；收集谓词 = 单用 `row_index === N` /
  组合双条件 AND（与池侧同口径）；凑满 5 早退 + 封顶 120 超标 fail-closed 沿批 1；回捞行补
  `row_index`（additive）；PASS_HINT_PROBE 派生自动继承。
- **A3 DOM fallback**：`arg.rowIndex` 随 inRow 同点下发，每行补 `row_index`（位次表）；
  row-index-only 不触发爬升；未声明任一行锚时行形状逐字节不变。

### 生成纪律（suggestHints 第 6 档）

- **仅当 within 全落空 且 第 5 档（in-row 词元）全落空**（内容不可分网格 = 硬案例本体）才
  生成 `<label> row-index:N`（同一 push → hintMatch 自证）；**内容可分时内容候选优先**；
  **单用 only 不产组合候选**（Q3；作者手写组合走推荐纪律）；不产 unstable 标记（批 1 裁决
  理由）；`out.slice(0,4)` cap 与 R-10 顺序纪律不动。inspect/observe 的 hint_candidates 与
  歧义证据 suggested_hint 自动受益——**内容不可分网格从此可准入**（批 1 硬案例闭环）。

### 证据面与 observe 闭环

- **trace 行 additive `row_evidence: {row_index?, row_texts?}`**（声明 row-index/in-row 且
  解析成功、字段存在时出现；缺省路径零新字段；Q6 仲裁：独立键对齐 `declared_resolve` 先例）
  ——事后可审计"点的是哪一行"（done 断言纪律的归因证据）。
- `syntheticElem` 透传 row_index → observe 自证池闭环；`ObserveElement` 增可选 `row_index`
  （桥白名单边界沿批 1 row_texts 先例如实标注）；`whyNotAdmitted` 追加 row-index 可行动指引
  （行内容全同时按网格内顺序定位 + 序漂移责任声明）。

### 失败诊断四案（stopCode 不加新码）

- ① 越界（N > K）或组不存在 → reason 报**网格组大小 K**（按 tag+label 分组 ≤3 组）+ 池面
  真实行词元 ≤8；② 序号已定位但行内无 base/守卫不符 → 核对组合守卫 token 或改 base 不改
  序号；③ 组合后仍多候选（跨帧同名网格）→ `target_ambiguous` 零动作；④ 尾缀形状非法 →
  整组回退 + describe 点名（`0`/负数点名"row-index 从 1 开始"）。四案 reason 可区分。
- **诊断可达面矩阵（历史沿革 + 现状）**：本批（批 2 `a38e674`）实施时三案证据**保证面** =
  app flow 命令空间 / `act_hint:"strict"` / 会话 act；**规划面（plan/probe）不保证**——批 1
  probe 真站实测：声明行锚落空在规划链停 `low_confidence`（0.13 < floor，词面诊断），非三案
  reason。**该缺口已随后续"批 2 遗留收编"（`13cd7ca` + `a1dd95f`）收口**：规划链四个停因点
  复用同一 `frameHintFailureEvidence` 单点追加行锚证据（stopCode 不变、无行锚声明 reason
  逐字节不变），probe 用例期望口径随之从"零动作 + 诚实落空"升级为可断言 `target_not_found`
  + 案①证据与零动作/零错点（详见下方「批 2 遗留收编」）。

### 文档与契约

- `docs/APP_SCRIPT_AUTHORING.md`：§4 尾缀四并列、新 §4.13「顺序行锚：序号即语义与内容守卫」
  （语义两类/组合守卫/done 断言纪律/生成纪律/四案/边界）、§10 row-index 四案口径 + 可达面
  边界、§11 已知边界；`docs/AGENT_INTERFACE.md`：ElementView 表加 `row_index` 行 +
  `hint_candidates` row-index 候选形态 + trace `row_evidence` 说明；README 能力 bullet 增
  序数场景；`docs/RUN_TAKEOVER_AND_DOM_CONTEXT_PLAN.md` §2.2 F83 注记（序数类收口、D2 进一步
  限缩）；`docs/BACKLOG.md` #9 收编更新；批 1 probe `books-inrow-token-missing` goal 文案按
  实测口径顺带修正。
- schema **F83** 声明（dist/schema/ctx.json 是 gitignored 构建产物；`precheck` 无条件由当前源
  重生成，`schema:check` 只验渲染一致性，发布/CI 的 `check:ci` 才是漂移门）；grammar-prompt
  `HINT_ROW_INDEX_SUFFIX` 示例 + import 时 parseHint 自证断言（六形状 × row-index、四尾缀
  **24 排列全采样**、整组回退、值闭集边界）。
- online 用例声明：core `books-row-index.json`（单用 `row-index:5` + 组合守卫
  `row-index:3 in-row:america` 双子目标 + 结束态不变量）；probe `books-rowindex-out-of-range.json`
  （`row-index:99` ⇒ 零动作 + 诚实落空，期望口径按可达面矩阵）。test:validate 过即入批；
  真站执行属批后验证。

### 显式缺口（批 2 实施时留档；均已由后续批次收口）

- FW8 白名单不含 row-index 底座；findByHint / plan check --probe / apps check hint-lint /
  桥 ElementView 透传 / 规划面三案接线属后续项（BACKLOG #9）；词边界档位不做。
- **收口记录**：行锚恢复面已由 F85 统一 fail-closed（不参与恢复，落空 = `target_not_found`
  + 行锚证据）；findByHint / hint-lint / 规划面证据由 `13cd7ca`/`a1dd95f` 收编；桥透传由
  `3fcb098` 收编。

### 批 2 遗留收编（同批后续项，一次 PR）

- **findByHint 行锚适配**：`start.findByHint`（plan check --probe / amber start --target 的
  旧匹配器）支持 `in-row:`/`row-index:` 尾缀——`splitTailSuffixes` 剥离本就自动继承（N6 唯一
  出处），补行锚判定底座：in-row = `rules.rowMatch` 同口径（row_texts 任一行 includes、仅小写
  折叠）、row-index = `row_index` 整数全等；四类尾缀组合 = 独立 AND。**底座消费面核实**：两个
  消费面（plan-cli.probePlan / amber start）的池都经 `extractElements` ⇒ `addNearContext`
  已采集行文本/编号——不是硬造底座。probe 面落空证据同步传 elems（案①报组大小 K + 行词元；
  无行锚参与 = 输出逐字节不变）。
- **apps check hint-lint 行锚提醒**：`hint-lint.ts` 新增独立 stderr 通道 `rowAnchorFindings`
  （同 frame 通道纪律——不进 problems、不改 VALID/exit）：`rejected` = 值必被解析拒绝
  （describeRow/RowIndexSuffixRejection 点名）；`dupOnly` = 值合法但行锚只服务同文案重复网格
  ——声明扫描面拿不到重复组事实，提醒降级为静态文案（不假装验证）：目标元素须带
  row_texts/row_index（inspect/observe 面在场 = 重复组成员），非重复组恒落空。
- **歧义证据反向提示"改用行锚"**：`AmbiguityCandidate` 增 additive `row_index`（同文案重复组
  事实，重复组成员才出现）；`suggested_hint` 已复用 `suggestHints` 第 5/6 档纪律（内容候选
  优先、row-index 仅内容不可分时给——不发明第二套生成逻辑）；候选行 row_index 让 Agent 在
  suggested_hint 缺位（跨网格歧义自证不唯一）时仍能手写 `row-index:N in-row:<token>` 组合
  守卫。零页面 I/O（纯池读）；桥白名单边界沿批 1 先例（未列入前桥面不出现）。
- **probe expect "failed" 类型联合收编**：`types.ts` 新 `ProbeExpectMember`（blocked /
  unreachable / login_required / captured / **failed**）；`validateCase` 成员校验口径定案
  （非法观测值加载期 config_error——与 F61 信号形态纪律一致；现网两批 probe 用例成员都在
  闭集内，收紧零回归）；`runner.probeOutcome` 的 `as never` 放行简化为文档化窄断言。
- **规划面诊断三案接线（§8 遗留 #8 收口，additive GO + 流转修复）**：调查结论 = 规划链四个停因点
  （`low_confidence` / `no_model_runtime` / `hint_matched_nothing` / `action_space_exhausted`）
  **池在手（elems）+ 声明目标可达** ⇒ 干净接线成立：停因点复用 `frameHintFailureEvidence`
  单点（不另立函数）追加行锚证据——**stopCode 不变**（规划面语义不变）、无行锚声明 =
  reason 逐字节不变、零新增页面 I/O（allowedFrameOrigins 是 host 侧帧 URL 读）。**评审发回
  修复（实锤流转根因）**：probe 用例的 commands 无 `id`——`validateCommands` 的 id 必填校验
  只在计划/应用包加载面生效，在线套件路径（runOneCase → TaskPlan）不过该面，命令到执行器被
  `cmdSpace` 构造的 filter **静默丢弃** ⇒ 命令行走廊从未运行 ⇒ 退化为模型提名（违反命令空间
  契约 "NEVER a fallback to the full pool, NEVER a model pick"；批 1/批 2 两次真站实测停
  `low_confidence` 即此）。**行为变更（有意为之）**：id 缺失命令此前被 `cmdSpace` 静默丢弃 →
  退化为模型提名；现在照常参与命令走廊（回退 id `cmd<序>`），未解析即结构化
  `target_not_found` + 行锚证据（零动作、不交模型自由选）——修复命令空间契约
  "NEVER a fallback to the full pool, NEVER a model pick" 的违背。修复 = ① id 缺失命令不再丢弃
  （回退 id `cmd<序>`，照常参与走廊——
  未解析 → `target_not_found` + 行锚证据）；② 停因证据 hint 来源取**该步有效声明目标**
  （`declaredTargets()`：命令步 = cmdSpace targets、决策步 = [curHint]——镜像 trace
  row_evidence 口径）；③ probe 用例补显式 id。**真站验收重跑**：两 probe 停因 `target_not_found`
  reason 均含案①证据——`books-inrow-token-missing`：行词元 ≤8 在场；`books-rowindex-out-of-range`：
  `row-index:99 超出网格组大小——网格组大小 ≤3 组: [a "Books" K=2, button "Add to basket"
  K=11]` + 行词元 ✓；零动作、observed=failed ∈ 预期集合、probe 语义（exit 3）不变。

## [Unreleased] — 行锚 hint `in-row:<token>`（F82 批 1：解析/匹配/数据面/回捞/回退/建议/observe 闭环）

### 背景

列表/表格场景里，行的唯一可靠身份是**内容**（航班号、订单号、商品名），不是结构 id。
现有两类关系锚全部押在结构身份上（`within:`=祖先 id、`frame:`=帧 origin），内容身份没有
通路：携程机票列表 15 个"订票"按钮 class-only、无 id/data-test/aria-label、label 全同——
六形状无法唯一解析、`within:` 空转（祖先链无行级 id）、`near` 采集错行（价格行挤占 3 行
窗口且"跨池唯一"挑选让价格永远赢过身份行）、纯数字订单号行被行过滤剔除。`in-row:` 与
`within:`/`frame:` 同构（尾缀限定是已验证可行且低风险的模式）。规格与评审记录：
`docs/ROW_ANCHOR_HINT_PLAN.md`（v1.0，2026-11-16 架构/产品双子代理评审合成；本批 = §5 批 1，
一次 PR 不可拆）。

### 语法与解析（hint.ts）

- 任意形状可后缀 ` in-row:<token>`：token 非空、无空白、禁 `>`（为未来链语法保留）、≤40
  字符；解析期仅小写折叠（**NFKC 不进 parseHint**）。三类尾缀（within/frame/in-row）各至多
  一次、任意书写次序；任一类超限/值非法 ⇒ **整组后缀都不应用**（按原始串回退，绝不半剥）；
  属性值内伪尾缀（base 含未闭合 `[`）同拒。`ParsedHint` 六形状各加可选 `inRow` 字段；
  `splitTailSuffixes` 仍是唯一剥离出处。诊断面 `inRowValueProblem`（empty/too-long/has-gt）+
  `describeRowSuffixRejection`（与 frame 版同构，接 executor target_not_found reason 与会话
  act reason）。

### 匹配（rules.ts）

- `limit = inRow(inAnchor(refs))` 组合过滤覆盖 inAnchor **全部 5 处调用点**（emit / attrSubstr
  三分档 / tag-submit 偏好 / bare 五档）——漏任何一处 = 复刻"tag 绕过 within"类 bug；
  限定后本档清空 = 落空，不让行锚内更弱档越级顶上（跨档混选防线不变）。
- 匹配口径 = `row_texts` 任一行 `includes(token)` 单档（与 nearToken 同 includes parity），
  归一**仅小写折叠**——两轮架构评审仲裁否决 NFKC（两面新增归一层 = 纯漂移面，作者从
  hint_candidates 照抄真实行词元构造上必中；全角场景 fail-closed 显式落空）。
- **fail-closed 对称**：元素无 `row_texts`（非重复组）⇔ in-row 恒不命中 ≙ frame 对未知
  origin 帧不可命中——行锚只服务"同文案网格"，不制造新歧义。

### 数据面（Elem.row_texts：双累加器 + 行过滤放宽）

- `Elem.row_texts`：≤6 行 × 每行 ≤40 字符，**仅同文案重复组元素携带**（与 near 同触发）；
  **不进模型面**（`modelProjectionOf` guard+解构两处同步剥离，B5 教训）、不进
  esig/firstIfSame 签名；注释注明只服务匹配/回捞/建议。
- `ROW_CLIMB_JS` 共享片段（仿 `${ANCHOR_JS}` 内插模式，唯一 JS 实现防两面漂移）：dup 键
  函数（tag+NUL+label，与宿主 addNearContext 同口径）收进单一出处；NEAR_JS（EXTRACT 面）/
  OBSERVE_JS（observe 面）/ HINT_HEAD（回捞面）/ DOM_FALLBACK_COLLECT_JS（A3 回退面）四
  pass 内插同一份。
- **NEAR_JS 双累加器**：`out`（near）累加序/行过滤/3 行窗口**逐字符不动**；`rows`
  （row_texts）独立行过滤 = 现行过滤 **OR 连续数字 ≥5 位**（救援纯数字订单号 20240101；
  时刻 "20:20"、短价格段维持剔除）、窗口 6 行；break 取**并集** `(out.length>=3 &&
  rows.length>=6)` ⇒ 新爬升 ⊇ 旧爬升、out 前缀稳定 ⇒ `near = out.slice(0,3)` **逐字节相等**
  （结构性证明 + 固定 DOM 语料对拍断言兜底）；near pick 消费面不动。

### 回捞/回退对等（F-1 半链缺口闭合）

- **HINT_HEAD in-row 门**（惰性 + memoized + 凑满 5 早退 + 总计算封顶 120，超标 fail-closed）：
  先收集形状命中（不含 in-row 过滤），按 DOM 序逐候选算 row_texts，行词面命中才收集——只补
  字段不进门的话 `slice(0,5)` 可能全被非命中占满，回捞整体死路；回捞行补 `row_texts`
  （additive，与 anchor_ids 同形）。PASS_HINT_PROBE 经 `HINT_HEAD.replace(...)` 派生自动继承。
- **A3 DOM fallback 行同批补 row_texts**（第二评审补漏项）：`arg.inRow` 声明时每行爬升补
  字段——fallback 行并入主池后同样走二次 hintMatch 的 inRow 过滤，缺字段 = 重演 F-1 半链
  缺口；in-row 未声明时零爬升、行形状逐字节不变。

### 建议闭环（suggestHints 第 5 档）

- within 链生长全落空后，从 `row_texts` 逐行取词元生成 `<label> in-row:<token>`——同一
  push → hintMatch 自证（恰好唯一命中才保留），命中即停；`out.slice(0,4)` cap 不动（R-10
  顺序纪律不变）。**词元启发式（生成期护栏）**：优先"类标识符"词元（字母+数字混合），跳过
  纯价格/货币/百分比词元与时段词元——带 unstable 警告的候选是半成品承诺，宁可不产出交回人。
  observe/inspect 的 hint_candidates 与歧义证据 suggested_hint 自动受益。

### observe/inspect 面闭环（产品裁决：必须同批）

- `OBSERVE_JS` dup 门控采集 row_texts（共享 ROW_CLIMB_JS 内插；**dup 判定只对"观察集合内
  可见同文案计数"执行**并文档声明边界；**无 dup 页观察 JSON 逐字节不变**）；observe.ts
  `syntheticElem` 透传 → suggestHints 在 observe 自证池自动闭环；`ObserveElement` 增可选
  `row_texts`（引擎 observe 面；桥 ElementView 投影未列入该键——照抄入口是 hint_candidates
  的 in-row 候选，见 BACKLOG 立项 #4）。
- `whyNotAdmitted` 同批改写：追加指向 in-row 的可行动指引 + observe 面边界声明——旧文案
  "add id/name/data-test" 在无 id 页面是主动误导（架构硬条件）。

### 失败诊断三案（stopCode 不加新码）

- ① token 在任何行词元中无匹配 → reason 列池面真实行词元 ≤8（镜像 frame: "页面实际可用
  origin" 先例）；② 行已定位但行内无 `<base>` 命中 → 报"行已定位 + 行内词面"（作者改 base
  不改 token）；③ token 撞多行 → `target_ambiguous` 零动作（永不选第一行）；④ 尾缀形状非法
  → 整组回退显式落空 + describe 点名。三案 reason 可区分。

### 文档与契约

- `docs/APP_SCRIPT_AUTHORING.md`：§4 尾缀三并列、新 §4.12「列表/表格行：内容身份定位」
  （工作示例/词元启发式/语义边界）、§10 in-row 三案口径、§11 已知边界。
- `docs/AGENT_INTERFACE.md`：ElementView 表加 `row_texts` 行 + `hint_candidates` 形态说明
  （in-row 候选）；`docs/README.md` 能力 bullet；`docs/RUN_TAKEOVER_AND_DOM_CONTEXT_PLAN.md`
  §2.2 注记（行身份类由 in-row 收口、D2 限缩为容器结构消歧）；`docs/BACKLOG.md` 立项条目
  （批 2/3 + 桥透传 + 时延实测）。
- schema F82 声明（statement/truth 对齐 F69/F70 行内风格；dist/schema/ctx.json 是 gitignored
  构建产物——`precheck` 无条件由当前源重生成，`schema:check` 只验渲染一致性，发布/CI 的
  `check:ci` 才是漂移门）；grammar-prompt `HINT_ROW_SUFFIX` 示例 + import 时 parseHint 自证断言
  （六形状 × in-row、双 in-row/含 >/空/>40/伪尾缀整组拒绝、三尾缀组合任意次序）。
- online 用例声明：core 增「重复按钮网格 + `<label> in-row:<token>` 声明 hint + 结束态
  不变量」（books.toscrape 同文案订票按钮网格）；probe 增「token 页面缺失 ⇒ target_not_found」
  （fail-closed 正向证明）；probe/ctrip-flights 扩 in-row 用例。test:validate 过即入批；
  真站执行属批后验证。

### 显式缺口（批 1 不做，留档）

- `identity.ts`/`declared.ts` 的 FW8 声明目标恢复路径白名单只认身份形状（#id / [attr=value]），
  **不含 in-row 底座**——池外行锚恢复属 Phase 2 诉求；**2026-11-16 评审收口已改为 fail-closed**
  （声明行锚时 FW8/DRF/F64/A3 不参与恢复，见顶部 review 条目），不再按 base 身份绕过行约束；
- `findByHint` / `plan check --probe` / apps check hint-lint / 歧义反向提示属批 2；
  induceHint 记忆产物带 in-row 属批 3。

## [Unreleased] — 架构师裁决补丁批次二：会话面 tab op（F76/F77）+ 桥 idle_timeout_ms（F80）

### P3 会话面 tab op（F76 协议 + F77 桥）

- **【背景】** 携程"订票"是 window.open 弹新标签——编排面（ctx.tabs/switchTab/F2 newTab）能力
  完整但被卡点 1 堵住，会话腿能点却跟不过去：两头各缺一截。
- 会话面新增 `tab` op（additive）：`list` 免费只读枚举（context.pages() 序、active=会话当前页）；
  `switch` 复用 ctx-validate 纯函数与信封判定（0/多匹配=config_error 带 describeTabs 现场、
  信封外=host_not_allowed 不切换），命中换会话当前页（后续读/动作面全跟）+ 有界
  bringToFront/DCL + settle + JSONL record。桥三层（SESSION_OPS/参数 schema/渲染）同步透传。
- record→export 闭环（F81）：export 识别 `op:"tab"` switch 行 → `ctx.switchTab({urlContains|index})`
  原语（URL 子串优先、缺落点事实=注释块不发明；`ctx.switchTab` 自身计 1 个 flow step）。

### P4 桥 open 专属 idle_timeout_ms（F80）

- **【背景】** 桥 TTL 管理器级 300s 缺省、1h 硬帽、无 0=不限；lastActivity 只在工具调用时刷新
  ——headful 会话等人登录/扫码/支付期间零调用必被 reaper 收割，慢支付超 1h 调参也救不了。
- `open` 可传 `idle_timeout_ms`：缺省不传 = 管理器缺省（逐字节不变）；`0` = 不限（仅显式，
  reaper 跳过）；非整数/1..999 = config_error。per-session 显式值不受部署 1h 帽约束。
  `op:"list"` additive 回显生效值。会话面 rescue 透传维持 NO-GO。
- **本次评审修正（`0` / `>0` 的子进程下传语义）**：显式 `idle_timeout_ms` 现在**原样传给引擎
  子进程**（此前 `0`/大值被统一折算成 600s 或 `max(600s,2×ttl)`，子进程侧实际并不 "不限"）：
  `0` ⇒ 子进程也 0（真·不限，仅靠 stdin EOF 退出兜底）；`>0` ⇒
  `min(24h, max(600s, 2×ttl))`（仅孤儿兜底，且不再越 CLI 的 24h 帽）；缺省不传 ⇒ 子进程 600s
  **逐字节不变**。契约同步 `docs/AGENT_INTERFACE.md` / `docs/INTERACTIVE_SESSION.md`。

## [Unreleased] — 架构师裁决补丁批次一：DRF 诚实化（F73）+ run 决策步 DOM 回退跳（F74/F75）

### P1 丙：DRF 诚实化（F73）

- **【背景】** DRF（`target_resolution:"declared"`）实跑且可见零命中时，落空停因 reason 完全不提
  DRF（strict 链列举句只写到 "after hintMatch / ADMIT recovery / FW8"）——作者无法区分
  "hint 写错 / 被池帽挤出 / DRF 扫过仍看不见"（携程 v4 探针 reason 与 v1 逐字相同即此）。
- DRF 实跑且 visible=0（含 total=0 真零命中与 hidden>0 全隐藏）时，落空 reason 追加
  `declared-DOM resolution (DRF, attr|text mode) ran: total=N, hidden=M, visible=0`；四处落空面
  （命令空间停因 / strict 两分支 / 非 strict hint_matched_nothing）统一追加；strict 解析链列举句
  条件化（declared 下点名 DRF）。未声明 declared 时逐字节不变。

### P2 甲：run 决策步 DOM 回退跳（F74/F75）

- **【背景】** 会话 act 的 DOM 回退面（`_domFallbackResolve`：主帧 ADMIT_SEL、**不过滤可见性**、
  含 0×0 自绘控件）是会话面独占；run 决策步 act hint 的五跳（hintLookup/FW8/DRF/U5/F72）全部
  要求可见盒/可见匹配——"会话 act 能解的声明 hint 在 run 解不了"的 authoring→run 可移植性缺口。
- 新 policy 键 `meta.policy.act_hint_dom_fallback`（布尔，缺省 false = 逐字节不变）：声明 hint
  全链真落空后补一次 DOM 回退跳；命中 = 合成行注入本步局部池（`df:` 前缀）+ 确定性
  `rule:match`（不进模型投影），trace 记 `resolved_by:"dom_fallback"`；歧义 = 同一谓词结构化；
  落空 = 原停因 + strict reason 补"已试 DOM 回退"。章纪律随 cleanupIdentity 全部清点同步；
  `_locatorFor` additive 链首 `af_probe` 分支；`Elem.af_probe` 仅合成行携带。
- 明确不做：on_ambiguous 开关（恒 fail）；PUA 字形口径修复（丙2，触发条件见 F73）；
  shadow 扩面（等 walk 实验）。

## [Unreleased] — 重水合补偿（F72）：落空诊断诚实化 + rehydrate_rescan 有界重扫

- **【背景】** 重水合 SPA（轮播广告 + React 分阶段水合）上 act 抽池前的 settle 门是纯负信号
  （等 DOM 静默 ≥400ms），静默永不达成时超时后照常抽池——抽到 SSR 中间态池报 `target_not_found`，
  数分钟后同一 hint 直接成功。此前失败诊断不含任何渲染线索，staleRetry 只管"解析成功后"的动作
  失败，解析落空无补偿。
- **①诊断诚实化**：`_resolveOne` 保留 settle 结论（不再就地丢弃）；会话 act 落空（诊断面）在页面
  未静默时 additive `diagnostics.settle_timed_out`/`settle_waited_ms` 两键 + reason 尾缀一行渲染
  提示；页面静默正常与非诊断面（run/scroll/setRange）键与 reason 逐字节不变。
- **②rehydrate_rescan（opt-in，缺省 false）**：run 面步级 `rehydrateRescan:true` / 会话 act 单行
  `rehydrateRescan` / 桥参数 `rehydrate_rescan`——act hint 真落空（hintMatch 零命中）且步首 settle
  timedOut 时等 2s → 重抽池 → 同一 hint 重解析（affordanceRule+declaredAllow，U5 同款档位纪律，
  至多 1 次，确定性 rule:match 不重走决策面；受整步挂钟帽钳制）。命中：run 面 trace/汇总记
  `rehydrate_rescan`，会话面 `resolved_via:"rehydrate-rescan"`（桥 additive 回显）；重扫池上歧义
  照旧同一谓词；仍未命中 = 原停因不变 + `diagnostics.rescan`。`settle:"off"` 时门控信号不存在。
- 面板：`ctx.waitForTarget` 正锚配方 + `meta.policy.settle.timeout_ms` 放宽写入
  `docs/APP_SCRIPT_AUTHORING.md`「重水合 SPA 配方」；schema F72。

## [Unreleased] — frame:<origin> 帧限定 hint（解析/匹配/数据面/候选/诊断/契约）

### A 批（解析 / 匹配 / 数据面 / 回捞 / 契约）

- **【背景】** 多 iframe 页面里同名元素跨帧无法用现有 hint 表达：`within:#id` 只能同帧内
  锚定（iframe 内容的祖先链不含宿主页 iframe 元素）、池 ref `f<fi>:eN` 不是动作地址。
  `frame:` 与 E3 的 `within:` 同构（后缀限定是已验证可行且低风险的模式），本批落地
  解析/匹配核心 + 帧链数据面 + 回捞/门禁适配（A 批不可拆：单独落地任一半会让 frame: 在
  合成池/回捞面静默失效）。规格与评审记录：`docs/FRAME_SCOPE_HINT_PLAN.md`（§11/§12）。
- **【新语法】** 任意 hint 形状可后缀 ` frame:<origin链>`，命中集限定在 origin 链声明的
  frame 内：`>` 分隔外→内、≤4 段、每段 `v === new URL(v).origin` 的 http/https 规范形
  （带 path/query/显式默认端口拒绝，`https://a:443` 要写成 `https://a`）；唯一公式
  （R2-1）= 声明链是帧完整链 `[rootOrigin..ownOrigin]` 的**后缀**且末段 = 元素所在帧自身
  origin——同源父子靠链长区分（`frame:o` 命中父、`frame:o>o` 仅命中子）；与 `within:#id`
  可组合（两种顺序，取交集）。`about:blank`/srcdoc 等未知 origin 帧不可被任何 `frame:` 命中。
  无后缀 hint 走原路径逐字节不变。规格：`docs/FRAME_SCOPE_HINT_PLAN.md`（F70）。
- **【解析】** `parseHint` 改为**串尾词法预扫 + 循环剥离**：两类后缀（within/frame）各至多
  一次、只认「前置空白 + 串尾」，任一类超限 / 值非法 / 空段 ⇒ **整组后缀都不应用**
  （按原始串回退，绝不半剥）。修复旧实现全局子串计数（`h.match(/within:/g)`）对值内伪后缀
  的误伤——`host within:8080 within:#panel` 此前被整串拒绝，现在正确剥离真后缀。
- **【匹配】** `hintMatchImpl` 改为**入口过滤 entries**（B1 修订）：六形状 / 档位 /
  tag-submit / sink / 歧义诊断自动一致，**档位在帧内计算**（帧限定后本档清空 = 落空，
  不让帧外更弱档越级顶上）；tag 形状的 submit 偏好分支在偏好前先 `inAnchor`（修复 tag
  绕过 within 的旧缺陷；within/frame 未声明时恒等）；`hintCandidates`/`suggestHints`/
  歧义谓词经同一实现自动继承。
- **【数据面】** `Elem` 新增 `frame_origin` / `frame_path`（祖先 origin 链，外→内；主帧
  path 省略），帧链判定唯一出处新模块 `src/engine/frame-scope.ts`（`frameChainOf` 沿
  `parentFrame()` 上溯、`parentFrame()===null` 判根、`isDetached()` 判活——detach 后
  `parentFrame()` 返回陈旧父帧不能靠它）。打点全链覆盖：`extractElements` 帧合并、
  heuristic 宽扫（显式 `frame=0` + 主帧 origin）、`observeElements`/`ObserveRawRow`/
  `syntheticElem`（observe 自证池同构）、四处合成池（hintLookup / DRF `rowToElem` /
  A3 `_domFallbackResolve` / FW8 `identityLookup` 合成 Elem）。模型面：`pickInner` 剥离
  两字段（guard+解构收口在 `executor-pure.modelProjectionOf`，模型请求体字节不变）；
  **`esig`/`firstIfSame` 签名不含新字段**。
- **【回捞/门禁】** `hintLookup` / FW8 `identityLookup` / DRF `declaredLookup` /
  F64 `_liveDomIdFallback` 按 `parsed.frameChain` 过滤帧循环（声明链之外绝不动作）；
  `probeExcludedHint` 只对链匹配的排除帧探测/报证据；DRF text 模式改用 `parsed.token`
  （R2-7：尾缀不再被塞进文本匹配）。
- **【行为变更（有意修正）】** ① F64 `#id` live-DOM 直查此前**不查 hosts 信封**——排除帧里的
  `#id` 会被跨帧直查动作；现在与池/hintLookup/FW8 同口径（主帧恒允许、子帧不在信封内跳过），
  声明目标确需该 frame 时走既有 `frame_not_allowed` 路径。② poolView 元素行 `frame_origin`
  改用 `Elem.frame_origin` 单一出处——旧实现 `[pageUrl, ...frames()].map(origin).sort()` 的
  下标映射会重复/排序打乱 fi↔origin，跨源页 inspect 行的 frame_origin 值**会变对**；
  行上没有 frame_origin（未知 origin 帧）如实报 `"opaque"`，顶层 `frame_origins` 仍按帧枚举。
  ③ **会话面 frame 门禁补漏**：`_frameHosts` 此前只在 run 面方法里赋值，session 面从未设置——
  声明 `hosts` 的会话仍会对信封外 iframe 的池/FW8/DRF/F64 不设防（专项测试实测：
  `hosts=[127.0.0.1]` 时 `localhost` 子帧仍可被 `frame:`/`#id` 命中）。现在构造时以 middleware
  默认 hosts 兜底（run 面仍按 run 覆盖），与工具合同"same semantics as meta.hosts"一致。
- **【契约】** `HINT_GRAMMAR.frame_suffix` + F70 条目（schema-gen.ts）；grammar-prompt 新增
  `HINT_FRAME_SUFFIX`（与 HINT_WITHIN_SUFFIX 同构）+ import 时自证（单段/2 段链剥离、
  双 frame/非法 origin 整组拒绝、within+frame 两种顺序）；prompt-hit grammar 组新增两条断言。
- **【验证】** 离线断言全绿（parse 全矩阵 34 条 / 匹配层 18 条 / 数据面+回捞 14 条，
  含 fake parentFrame 帧链）；`npm run typecheck`、`npm run prompt-hit` 通过。浏览器级：
  双端口跨源 fixture（跨源单段/2 段链命中、srcdoc 未知 origin 不可寻址、无后缀跨帧唯一透明、
  跨帧同名同签名会话 act 停机、hosts 信封外子帧不动作）。

### B 批（候选生成 / 观察面 / 结构证据 / bridge 透传 / 契约文字）

- **【候选生成】** `suggestHints` 在唯一文本候选没自证成功、且元素有 `frame_origin` 时补帧限定
  候选：先 `<label> frame:<自身 origin>`；单段仍不唯一且 `frame_path` 非空时再给完整链
  `<label> frame:<祖先…>自身>`（含自身 ≤4 段，>4 段不生成）。仍在 label 之后、`within:` 之前，
  仍走同一个 `push`（`hintMatch`+`hintCandidates` 自证），总数仍 `slice(0,4)`；无 frame 字段/
  无可用 label 时输出逐字节不变。
- **【观察面字段】** `ObserveElement` 增加 `frame_origin` / `frame_path`（来自 A 批已打点的
  `ObserveRawRow`；非空才出现，与既有可选字段同口径），`ctx.observe` 的结果与 `ctx-types`
  文档同步——observe 自证池因此能给出/验证 `frame:` 候选。
- **【结构证据（仅诊断）】** `structure_path`：`extractElements({structurePath:true})`（inspect 面）
  与 `ctx.observe({includeStructure:true})` / 桥 `include_structure` opt-in 时，元素行带
  `structure_path`（祖先 tag/`#id` + 同 tag 兄弟序号 + 帧下标前缀，如 `f2>div#panel>button[2]`，
  ≤160 字符、超长从外侧截断）与 `structure_unstable:true`。**不是 hint**：动态页面可能失效、
  不可照抄；不进 hint 自证、`describeAmbiguity`（零页面 I/O 纯函数）或 `ChoiceRequest.elems`
  （`modelProjectionOf` 同步剥离 `structure_path`/`structure_unstable` 兜底）。
- **【证据上限（R2-6）】** `AMBIGUITY_HINT_MAX` 80 → **200**（`suggested_hint` 可容 4 段
  `frame:` 链）；桥 `suggested_hint` clip 80 → 200；`element-view.HINT_MAX_CHARS` 160 → 200；
  新增 `FRAME_PATH_MAX_ITEMS=4` / `FRAME_PATH_SEGMENT_MAX_CHARS=64` / `STRUCTURE_PATH_MAX_CHARS=160`
  独立上限。**合同变更记账**：歧义候选 additive `frame_origin`（引擎 `candidateView` 来自
  `Elem.frame_origin`，undefined 不出现；桥白名单与 render 摘要同步——跨帧同名时先看 origin）。
- **【bridge】** ElementView 透传 `frame_path`（≤4×64）、`structure_path`（≤160）/
  `structure_unstable`；`amberflow_session` 新增 `include_structure`（缺省 false，只透传）；
  `inspect` 元素行补 `frame_path`/`structure_path`（inspect 始终 opt-in，模型面不经过）。
  契约文字 F41（observe 字段 + `includeStructure`）、F54（ElementView 字段/上限）、F55
  （候选 `frame_origin`、`suggested_hint≤200`）、F70 truth 同步；`docs/APP_SCRIPT_AUTHORING.md`
  多 frame 速查与 `docs/AGENT_INTERFACE.md` 同步。
- **【验证】** 离线断言 98 条（候选自证/链升级/无 iframe 逐字节/证据上限 round-trip/
  `structure_path` 截断/模型面剥离/bridge 常量）；`npm run typecheck`、`npm run prompt-hit`、
  `npm run schema:check`、`npm run check` 全绿。浏览器级：inspect/observe 给出单段与 3 段链候选、
  链候选照抄 session act 命中孙帧（`f3:e0`）、srcdoc 未知 origin 报 opaque 且不给 frame 候选、
  无 iframe 页面对照无 frame 候选。

### C 批（findByHint / `amber start --target` / 链证据 / 拒绝诊断 / apps check lint）

- **【回捞/CLI 适配（R2-4/B9）】** `findByHint`（`plan check --probe` 与 `amber start --target`
  共用的旧匹配器）改为**先 `parseHint` 再按声明链过滤池**：`#id` / `[attr=v]` / `induceHint`
  既有匹配路径不变，只是池先按 `frameScopeMatches` 过滤；**身份形状（`#id` / `[data-test=|id=|name=]`）
  与 `induceHint` 产物**的帧内目标不再被 `plan check --probe` 误报未命中（该 CLI 的匹配器不是
  `hintMatch` 六形状分档语义，裸词/`attrSubstr`/`nearToken` 仍是既有边界——本次未换匹配器）。
  **无后缀路径逐字节不变**（`frameChain` 未定义时池就是原池、base 就是原串；
  与 git HEAD 旧实现 85 例差分一致）。
- **【`amber start --target` 帧限定结构化拒绝】** 该 CLI 的演示点击是**主帧** `page.click(...)`
  （`selectorForHint` 也只产出主帧 CSS），带 `frame:` 的目标会点错/超时。纯函数
  `frameTargetRejection(hint)` 在**开浏览器之前**拒绝：文案点名"不支持帧限定目标 + 主帧
  page.click + 改用 app/run 或 plan 面（`plan check --probe` 支持身份形状 + `frame:` 链核对）"；exit 沿用该 CLI
  既有失败口径（2），**不新增 exit code**。非法/多尾缀仍走旧路径（parseHint 不接受 ⇒ 显式落空）。
- **【被排除帧链证据（F45 C 批）】** `probeExcludedHint` 的 `ExcludedHintProbe` 增
  `declaredChain?`（hint 的 `frame:` 尾缀）与 `matchedChains`（命中帧完整链 `frameChainOf`，
  按链去重、≤4 条、含 origin/帧下标）；`frame_not_allowed` reason 改由纯函数
  `executor-pure.frameTargetStopReason` 拼装——声明链与命中链并排 + 只读命中证据（≤5 行）+
  两条修法（把命中 origin 加进 `meta.hosts` / 改目标或声明链到允许帧）。只探测**链匹配**的
  排除帧（A 批过滤保留），不匹配帧零 evaluate。
- **【拒绝/错链诊断（B8）】** `hint.ts` 新增纯函数 `describeFrameSuffixRejection(hint)`（零页面
  I/O、不改 `parseHint` 返回值语义）：串尾 ` frame:` 尝试未被接受时返回一行可行动原因并区分
  类别——多尾缀 / 非法 origin（缺 `://`、非 http(s)、about:blank）/ 空段 / >4 段 / 非规范 origin
  （path·query·fragment·显式默认端口）/ 空值 / 无 hint 主体 / frame 合法但同串 within 问题导致
  整组回退；合法尾缀、值内伪 `frame:`、中段 `frame:`、纯 within 问题 = null（不误报）。解析面与
  诊断面共用同一份值判定（`frameChainValueProblem`），parseHint 与 HEAD 46 例差分一致。
  接入点集中在 `extraction.frameHintFailureEvidence`（命令步 target_not_found / act_hint:"strict"
  两条 reason / 会话 act 落空 reason / `plan check --probe` 未命中行统一追加）：原因 +
  **页面实际可用 origin**（允许帧去重 ≤6、主帧也列）；无 frame: 参与时返回空串（旧 reason 逐字节
  不变）。`target_not_found` / `frame_not_allowed` 均**无新增 stopCode**。
- **【apps check 静态 lint（N10）】** `hint-lint.ts` 新增独立 stderr 提醒通道（不改三类形状判定与
  计数口径、不进 problems、不改 VALID/exit）：① `frame:` 值不是合法 origin（缺 `://`、带 path、
  多尾缀…）→ "必被解析拒绝"；② 值合法但 origin 的 hostname 不在 `meta.hosts` 信封内 →
  "若该 origin 是被排除的子 frame，运行期会 frame_not_allowed（主帧恒允许）"。`apps check`
  透传 `meta.hosts`；拿不到 hosts 时只做值形状检查（`hosts=[]` 同）。
- **【契约/文档】** F45 statement/truth 补"reason 带声明链 + 命中帧完整链"；F70 statement/truth
  补 C 批（findByHint/start 拒绝/诊断/链证据/lint，明确**无新增 stopCode**）；
  `docs/APP_SCRIPT_AUTHORING.md` 多 frame 速查补 `plan check --probe` 对 `frame:` 的身份形状
  支持边界与 `amber start --target` 结构化拒绝，stopCode 表 `frame_not_allowed` 行补链证据。
- **【验证】** 离线断言 184 条全绿（findByHint 链过滤 18 / start-target 拒绝 12 / describe 全矩阵
  + parseHint 差分 102 / probe 链证据 + reason 文案 31 / hint-lint 21），
  `npm run typecheck`、`npm run prompt-hit` 通过。浏览器级：`plan check --probe` 正确链命中 +
  错链诊断、`amber start` 拒绝、被排除帧的 `frame_not_allowed` 链证据与零动作、会话 act 错 origin
  reason 带可用 origin。

### D 批（文档与契约收尾）

- **【规格】** `docs/FRAME_SCOPE_HINT_PLAN.md` 标题/状态改为「v1.2 · 已实施」，新增 **§13 实施记录**：
  A=`bc400ca` / B=`3ce26fa` / C=`5c25ef5` / D=本批；每批实际改动面、实施中额外修复的缺陷
  （会话 `_frameHosts` 门禁补漏、F64 hosts 补漏、poolView 映射修复、`findByHint` 旧匹配器边界）、
  「未做/延后」清单与验证证据；§3.2/§4/§5/§7/§8/§9 的 v1 旧口径按 D2 与已实施状态回写。
- **【作者文档】** `docs/APP_SCRIPT_AUTHORING.md`：hint 语法主段补 `within:#id` / `frame:<origin链>`
  两种尾缀（≤4 段、每段规范 origin、未知 origin 不可寻址、串尾预扫+整组回退）；learn/inspect 候选
  口径补尾缀；多 frame 速查明确 `plan check --probe` 只覆盖 `findByHint` 旧形状集（身份形状 +
  `induceHint` 产物，非 `hintMatch` 全语义）；stopCode 表 `target_not_found` 补 frame 拒绝证据、
  `frame_not_allowed` 核对；§11 增加 `frame:` 已知边界。
- **【Agent 接口】** `docs/AGENT_INTERFACE.md` 新增 **§3.2 观察面元素投影合同**（ElementView 字段/
  上限：`hint_candidates` ≤6×≤200、`frame_origin`/`frame_path`、`structure_path` ≤160 仅诊断、
  `includeStructure`、行数 cap 60/200、`ambiguity` 候选字段与 `suggested_hint` ≤200/`frame_origin`
  ≤120（桥 ≤60））；inspect/observe 的元素行字段与差异同处对齐。
- **【会话文档】** `docs/INTERACTIVE_SESSION.md` 核对无 ≤80 旧口径；ambiguity 候选行补
  `frame_origin` 引擎 ≤120 / 桥 clip ≤60 的上限口径。
- **【CLI 帮助】** `src/cli/registry.ts` 的 `inspect`/`session` flow 与 `plan --probe` 旗标补
  `frame:<origin>` 提示（只改帮助字符串，无行为变更）。
- **【契约文字】** `schema-gen.ts` 的 `HINT_GRAMMAR.within_suffix` 补「可与 `frame:` 组合（两种顺序、
  取交集）」；F70 的 `findByHint` 表述改为如实的身份形状/`induceHint` 边界；骨架 cheat sheet 的
  hint 行补尾缀。`dist/schema/ctx.json` 重生成（gitignored），`npm run schema:check` 绿。
- **【验证】** `npm run typecheck` / `npm run prompt-hit` / `npm run schema:check`；D 批只改文档与
  契约文本，**无运行时代码行为改动**。

### 实施复审修复（2026-11-15，架构复审 CONDITIONAL APPROVE 的条件项 B-1）

- **【修复·findByHint 组合后缀假阴性】** `splitFrameSuffix` 只认**字面串尾**的 `frame:`——
  `#id frame:o within:#p` / `#id within:#p frame:o`（两种顺序的合法组合）会把尾缀留在 base
  里而假阴性，`plan check --probe` 错报"机制性必挡项 ✗"。修法：串尾剥离收口为 `hint.ts`
  导出的 **`splitTailSuffixes` 唯一出处**（parseHint 与 findByHint 共用，复审 N6 同步解决），
  两种顺序的身份形状 / induceHint 产物均正确命中；无后缀路径逐字节不变。
- **【记账】** 复审 N1（HINT_HEAD nearToken 维持整串——防无上下文误命中的既定纪律，规格
  该句过承诺已回收）、N7（`matchedChains` 截断无标记）、hintMemory/induceHint 不带 `frame:`
  等边界，已入规格 §13.3/§13.4 与 `docs/BACKLOG.md`「frame:<origin> 后续立项」。

### E1 批（within 权威对等）

- **【背景·F-1 因果链】** hintLookup 的 DOM pass **已执行 within**（HINT_HEAD
  `getElementById + contains`），回捞行 within 洁净；但回捞行并入主池后 executor 重新
  `hintMatch`，池侧 `inAnchor`（rules.ts）按**缺失的 anchor_ids** 把回捞行**二次清零** →
  落到 FW8 `identityLookup`（彼时无视 within）在任意帧动作锚外 `#x`。本批给回捞/合成行补
  anchors 并让消费面遵守 within，闭合此链。规格：`docs/WITHIN_PARITY_PLAN.md` §3 + §12
  （M1–M6 已吸收；本批只做**单层** within 语义，链化留给 E2）。
- **【单一出处】** 新增 `pool-js.ANCHOR_JS`——`anchorIdsOf`（parentElement 上溯、内→外、
  ≤8、小写、自身不入）的唯一 JS 实现，先例 LABEL_HELPERS_JS 的 `${}` 内插。收敛五处：
  EXTRACT_JS / OBSERVE_JS 两份本地副本（EXTRACT pass 串**字节不变**；OBSERVE 本地副本原用词
  `ids` 统一为 `out`——纯变量名差异，行为不变）、HINT_HEAD（回捞行补 anchor_ids）、
  heuristic 宽扫（M3 第五池）、A3 `_domFallbackResolve` / F64 `_liveDomIdFallback` 的
  inline TS arrow evaluate **转 `compile()` PASS 常量再内插**（闭包不跨——Playwright 序列化
  函数源码；identity PASS_IDENTITY 先例）。PASS_HINT_PROBE 的 `data-hintref` 字面耦合保活
  （replace 前后断言）。
- **【五池 anchors】** hintLookup 回捞行 / A3 合成主帧行 / FW8 IDENTITY_PROBE 行 /
  DRF ATTR+TEXT 收集行（`RawRow.anchors` → `rowToElem` 透传）/ heuristic 伪按钮行全部补
  `anchor_ids`（与真池行同构；无 id 祖先 = 字段省略的既有口径）。
- **【消费面遵守 within（单层）】** ① **FW8**：`identityHintInfo` 暴露 `within`；
  `identityLookup` 在候选收集处（"恰好一个可见匹配"判定之前，M5）按 `anchors.includes(within)`
  过滤——两调用点（命令步/act hint）零额外判定自动继承；② **DRF-text**：收集后按
  `row.anchors` 显式过滤；**DRF-attr 零额外代码**（F-2：rowToElem 透传后经
  `hintCandidates→hintMatch.inAnchor` 自动获得语义）；③ **F64**：一次 evaluate 返回
  anchors + TS 判定，`within` 存在时命中后校验 `anchors.includes(within)`，不在锚内 =
  该帧不命中（「找到但在锚外」vs「找不到」在 evaluate 结果里可区分），清探针章后尝试下一帧；
  ④ **A3**：合成行带 anchors 后 `resolveCommandRef → hintMatch.inAnchor` 同语义。
- **【行为变更（有意修正）】** ① 含 within 的回捞命中行为变更 = 本批本意：hintLookup 回捞行
  不再被池侧 `inAnchor` 二次清零（F-1 闭合）；FW8/DRF-text/F64/A3 不再动作（或落空于）
  within 锚外元素——`#x within:#p` 在五个回捞/合成面与主匹配面同语义。② FW8/DRF 歧义证据
  口径变化（M2）：过滤后 `total_matches` / `hidden_matches` / `candidates` 变**锚内**口径
  （此前锚外候选也计入）。
- **【模型面（M2 记账）】** 回捞/合成行 additive 增 `anchor_ids`（与真池行同构——真池行的
  `anchor_ids` 本就在模型投影面）；在线 provider 的 ChoiceRequest 请求体在**回捞行出现时**
  随之多该字段。`esig` / `firstIfSame` / `askSig` / `structDigest` / laya 缓存键（= state
  {goal,url,title,main_text}+criteria 文本指纹）**均不读 anchor_ids**——离线断言钉死。
  无 within 路径：FW8/DRF/F64 输出与改前一致（回捞行多 anchors 字段 = additive，trace/池
  快照允许清单内）；EXTRACT_JS pass 串字节不变。
- **【证据文案（N-R2a 更新）】** `frameHintFailureEvidence` 的 within 注记改为如实状态：
  同帧 within 已在回捞面生效（E1）；**跨帧 within（锚在另一文档）不受支持**——anchor_ids
  是帧内文档祖先链（§13.4 文档边界维持）；heuristic 伪按钮行现已带 anchors。declared 分支
  触发条件与结构不变。
- **【验证】** 离线断言全绿（/tmp/af-e1）：ANCHOR_JS 收敛（EXTRACT 字节不变 + OBSERVE 仅
  ids→out + PASS_HINT_PROBE 字面保活）、五池 anchors 与手算 anchorIdsOf 一致（含无 id 祖先
  字段省略）、within 回捞矩阵（FW8 锚内命中/锚外拒绝/锚内口径歧义、DRF attr 自动/text 显式、
  F64 锚内命中/锚外拒绝、hintLookup 回捞行并入主池后 hintMatch 不再清零 = F-1 闭合断言）、
  无 within 逐字节（FW8/DRF 与 56456fa 旧实现对照）、esig/firstIfSame/structDigest 不含
  anchor_ids 断言；`npm run typecheck` / `npm run prompt-hit` 通过。浏览器级（同帧 within
  回捞真页动作落点）留待专项。

### E2 批（within 语义链）

- **【语法（§4.1 + M1④）】** `within:` 尾缀值从单层 `#id` 升级为 **#id 链**：`>` 分隔、
  **外→内**、≤4 段、每段 `#id` 形态（**首段必须 `#`、后续段可选 `#`**——方案 §4.3/M6⑤ 的链写法
  `within:#a2>#a1` 每段带 `#`，词法 charset 同批加 `#`；段校验保证旧单层/值内伪尾缀行为
  不变）。**单层 `within:#p` = 长度 1 链（逐字节兼容）**；多 within / 空段（`within:#a>`）/
  超 4 段 / 非法段 ⇒ 解析期**整组回退**（绝不半剥，沿用 R2-5 循环语义）。
  `ParsedHint.within` 归一 **string[]（外→内）**，消费面全部同批迁移：splitTailSuffixes /
  parseHint / identityHintInfo / frameHintFailureEvidence / F64 / DRF-text。
- **【语义（§4.2 + M6①②③，唯一出处）】** 新增 `rules.anchorChainMatch(anchorIds, chain)`——
  **嵌套序包含**：每段都在 `anchor_ids`（presence 前置显式化：任一段 indexOf === -1 即不匹配）
  且嵌套序正确（anchor_ids 内→外存储 ⇒ `indexOf(aₙ) < … < indexOf(a₁)`）；**n=1 = membership
  逐字节不变**。写文档边界（M6）：重复 id `within:#x>#x` 池侧不匹配（id 投影无实例身份，序关系
  不成立）；DOM 侧 getElementById 文档序首个且同元素退化（a === b）不命中（N2 起链校验要求两段锚为不同元素且严格包含）；`anchor_ids` ≤8 截断下长链
  落空（显式失败）；间隙容忍（中间有无 id 祖先不影响）。两套对齐规则的文档义务（M6④）：
  `frame:` = 后缀对齐（frame_path 稠密可分同源父子）；`within:` = 嵌套序包含（anchor_ids
  稀疏 ≤8、仅带 id 祖先——后缀对齐会毁单层兼容）。
- **【消费面（M1①②③）】** ① 池侧 `inAnchor` 链化——emit 三档/attrSubstr 三档/tag-submit/
  bare 梯级全部消费点经同一个入口自动继承；② DOM 侧 HINT_HEAD 链化——逐段 `getElementById`
  + 嵌套 contains 校验（声明链 a₁ contains a₂ contains … 元素；任一段 null/不含 = 该帧 0 行，
  下一帧继续找），PASS_HINT_PROBE 的 `data-hintref` 字面耦合保活（replace 前后断言）；
  ③ FW8 `identityLookup` / F64 `_liveDomIdFallback` / DRF-text 收集后过滤改
  `anchorChainMatch`；**DRF-attr 经 hintCandidates→inAnchor 自动继承（F-2 零额外代码保持）**。
- **【候选生成（M6⑤）】** `suggestHints` within 候选链形：先单层 `label within:#a1`
  （最近祖先 = anchor_ids[0]，首候选与 E3 逐字节一致）；push 失败（不自证唯一）且
  anchor_ids ≥2 时**从最近祖先向外生长** `within:#a2>#a1` → `within:#a3>#a2>#a1`…（≤4 段、
  每步走同一 push→hintMatch 自证）；顺序仍 身份→label→frame→within、上限 4 不变
  （R-10：链候选不挤掉 frame 候选——顺序不变 + 离线断言钉死）。
- **【诊断（§4.4）】** `describeFrameSuffixRejection` 的 within 侧值校验同步链形
  （空段/超限/非法段点名——`withinChainValueProblem` 与解析共用同一判定，只在 frame 参与
  时报告的既有口径不变）；`frameHintFailureEvidence` 的 within 注记按链形渲染
  （单层 `join(">")` = 单 id，旧文案逐字节不变）。
- **【契约（M1⑤）】** `grammar-prompt.HINT_WITHIN_SUFFIX` 链形文案 + 自证改写：多 within 拒、
  单串链受（`#a>#b` 与 `#a>b` 同归一）、空段/超 4 段拒；`schema-gen` 的
  `HINT_GRAMMAR.within_suffix` / F69 如实更新（F70 truth 补 E2 文件）；
  gitignored `dist/schema/ctx.json` 重生成；`npm run prompt-hit` 八组全绿。
- **【验证】** 离线断言全绿（/tmp/af-e2）：parse 矩阵（单层等价、链两序、`within:#a>` /
  超 4 段 / 双 within / 值内伪尾缀整组回退、大写 WITHIN）、链语义矩阵（全序命中、缺段/序错/
  重复 id 不匹配、间隙容忍、>8 截断长链落空）、五消费面 fake-DOM 真跑矩阵（池/DOM 回捞/FW8/
  F64/DRF attr+text）、候选单层→链生长序列 + R-10、诊断链形矩阵、契约自证；E1 回归复跑
  （within 形状同步后）全绿；`npm run typecheck` / `npm run prompt-hit` 通过。
  浏览器级（真页链锚命中/落点、frame+within 链组合、observe 链候选照抄）留待专项。

### E3 批（findByHint within）

- **【必修点（base 口径）】** `findByHint`（`src/cli/start.ts`）旧实现
  `const base = frameChain === undefined ? hint : s.base` 在「**无 frame 后缀但有 within**」时
  base 保留整串（含 within 尾缀）→ attr 正则与 `induceHint` 精确串匹配全落空。改为
  **任一后缀存在即用 `s.base`**；无后缀（within/frameChain 都 undefined）= base 就是
  **原串 hint 逐字节**——`s.base` 是 trim 后形状，`induceHint` 精确串比较依赖原样大小写/空白
  （离线断言钉死：原样大小写 near 产物命中、带空白原串不命中）。
- **【within 作用域过滤（§5）】** 帧链过滤后（无帧链时直接）按真池行 `anchor_ids` 过滤——
  `rules.anchorChainMatch(el.anchor_ids ?? [], s.within)`（单层 membership/链嵌套序包含同一
  语义，与 E1 权威面唯一出处共用）；帧链过滤与锚过滤合并为一次 `Object.entries` 过滤
  （正确性优先）；全滤掉/空池 = 显式 null。无锚行（`anchor_ids` 缺省/空）对任何 within
  fail-closed。`frame:`+`within:` 组合成为**全语义**（两面同时生效，此前 probe 面只做帧过滤）；
  `plan check --probe` 因此可校验 within 作用域。
- **【回退口径】** 非法 within 值 = `splitTailSuffixes` 整组回退（无 within/frameChain 字段）
  ⇒ 走原串 = 尾缀留在 base 里 = 既有旧形状集显式落空（与 frame 批 C 同口径）；
  值内伪后缀仍按 R2-5（真尾缀剥离、伪尾缀留 base → 落空）。
- **【消费面不变】** `frameTargetRejection` 不变（`parseHint` 的 frameChain 判定——within 不触发
  帧限定拒绝）；`plan-cli.ts` probePlan 的未命中证据 helper 不变（within 归因文案已在 E1 更新）；
  `selectorForHint` 不变。
- **【文档/记账】** BACKLOG「后续立项」#2 收口（E2 标注的"剩余=待 E3"闭合）；
  WITHIN_PARITY_PLAN §5 标注已实施；APP_SCRIPT_AUTHORING 多 frame 速查/已知边界两处更新
  （within 作用域已校验 单层+链）；schema-gen F70 statement findByHint 表述同步全语义 +
  truth 补 start.ts（E3 项）。
- **【验证】** 离线断言全绿（/tmp/af-e3，97 断言）：必修点旧新对照（`git show ca74fc0` 旧实现
  机械转换对照——9 条 within 修复行旧=显式 null/新=命中）、无后缀逐字节回归（19 行 old==new，
  含原样大小写/空白/attr 折叠边界）、单层/链矩阵（错序/缺段/词法边界/锚自身/无锚行）、
  组合矩阵（frame+within 两序严格等价、帧决定双胞胎、未知 origin）、整组回退、E1 权威面
  parity（hintMatch 与 findByHint 同 ref）、anchorChainMatch 直证、frameTargetRejection 不变；
  E1（33）/E2（34）套件回归复跑全绿；`npm run typecheck` / `npm run prompt-hit` 通过。
  浏览器级（真页 `plan check --probe` 的 within/链 within/组合命中与未命中+诊断）留待专项。

### E4 批（读侧帧限定）

- **【新语法（读/判面）】** 读/判面的 CSS 选择器可尾缀 ` frame:<origin链>`：`ctx.read.{text,value,count,attr}`、
  `ctx.extract`/`ctx.collect` 的 **rows 行选择器**、done/when/judge 的 css_* 算子（css_exists /
  css_exists_text / css_visible_exists / css_text_contains / css_text_equals / css_value_equals /
  css_count_equals / css_count_min）。校验与 hint 尾缀同一 `frameChainValueProblem`（`>` 分隔外→内、
  ≤4 段、http(s) 规范 origin）。**为什么对 CSS 零风险**：选择器尾的 `frame:<origin>` 对纯 CSS 在 E4 前必然是非法
  （伪类语法永不成立）——尾缀**只能激活原本就保证失败的纯 CSS 串**，既有选择器零影响；无尾缀路径逐字节不变。
  **非 CSS 引擎（Playwright `text=` 等）不保证**：裸 `text=hello frame:o` 仍会被当尾缀剥离（文档注明），
  作者需把文本显式引用；E7/N4 的引号/括号平衡守卫会拒绝引号内的尾缀（`div:has-text("x frame:o")` 整串原样）。
- **【值不合法 = 原样 CSS（显式落空）】** 值非法/缺主体/双尾缀 ⇒ 整串按原 CSS 处理，绝不半剥——
  防选择器属性值以 ` frame:` 结尾的伪尾缀误伤（属性值捕获必带 CSS 收尾字符、过不了 origin 校验）。
  与 hint 的 splitTailSuffixes 同一整组回退口径；`within:` 不是读侧语法（带它按原 CSS 显式落空）。
- **【底座单一收口（M4④）】** `extraction.ts` 新增 `splitFrameSuffixFromSelector`（唯一剥离出处，
  尾预扫、值合法才剥）+ `locatorAnyFrame`/`countAnyFrame` 帧循环按 `frameScopeMatchesFrame` 过滤
  （信封同口径：主帧恒允许、子帧按 hosts；声明帧一个都没扫到 = 结构化 miss，不回捞替身）；
  **test-double fallback 在 split 之后**（替身拿到剥离后 base，无尾缀 = 原串逐字节）。
  `frameScopeEvidenceOf` 导出帧级扫描证据（与帧循环同一谓词/帧序）。
- **【signals 覆盖】** live css_* 全部经 locatorAnyFrame/countAnyFrame **自动继承**（signals.ts 零改动；
  核对无直用 page.locator 的信号路径）。out of scope：离线池近似 `evalSignalOnState`/`matchSelector`
  （StateView 无帧字段；带尾缀选择器对池 PART 正则不可表达 → 返回 null = 待 live 验证，诱导面不猜）。
- **【逐面失败语义钉死（M4②）】** `ctx.read`/`ctx.extract` **不抛** frame_not_allowed（保 op 面）：
  声明帧不在信封/不存在 → 返回 null/0/[] + trace 事件 additive 证据
  `frame_evidence`={declared,excluded,scanned}（excluded 非空=声明帧被信封排除；scanned 空=帧不存在/
  链写错；scanned 非空=帧已扫、选择器本身零命中）。done/when 走既有 F45② 升级；会话面经同一 ctx
  实现（零合同变化，只回 null/miss）。
- **【F45② done/when 探针 suffix-aware（M4③）】** done/when 的 css_* 带合法 ` frame:` 尾缀时，
  allowed 视图上声明帧（指向被排除帧的链）恒零命中 → excluded 视图只读探测（帧循环链匹配被排除帧、
  该面无 hosts 无信封跳过）→ 命中即 doneInExcluded → 收尾升级 `frame_not_allowed`——此前该写法是
  非法 CSS、双面都 false，升级永不触发、退化为纯 done_not_held。声明链指向允许帧 = 正常完成面；
  非法尾缀 = 整串原 CSS（双面 false → 普通 done_not_held，不升级）。
- **【arrive/manual 的 done 求值对齐（新发现缺口的封口）】** `ctx.arrive` / `ctx.manual` 的 done
  求值此前不传 hosts（既有无尾缀口径=信封不设防，逐字节保留）——仅当 done 信号树带**合法**帧尾缀
  时按信封求值（`signals.signalHasFrameSuffix`；声明帧不在信封 = miss）。不加这个条件，尾缀会让一个
  E4 前必然失败的串在这两个无信封面上命中被排除帧（读面越权）。`plan check --probe` 的信号探测
  （plan-cli，无 hosts 的既有探测面）维持原样——探测非完成真值，既有口径不变。
- **【尾缀被拒诊断（M4①）】** 选择器串含 ` frame:` 形状但值非法、且原样 CSS 解析失败时点名
  「尾缀被拒+原因」（B8 同款，只在失败路径附注）：读面 trace 附 `frame_suffix_rejected`；
  抽取预检（checkExtractSelectors）的 config_error reason 附注拒因（预检本体先剥合法尾缀再验
  base 形状）。成功路径/无尾缀零改动。
- **【抽取面口径】** 行选择器带合法尾缀时与 ctx.read 同信封口径（hosts 传入，被排除帧不读）；
  **无尾缀抽取维持既有信封不设防口径**（对称化只经尾缀激活，既有 op 面零行为变更——
  无尾缀 locatorAnyFrame 调用的 opts/帧序/回捞全部原样）。字段选择器是行内相对寻址、不支持尾缀
  （带 ` frame:` 形状的字段选择器按原 CSS 预检 → 非法即 config_error）；collect 的内部滚动
  （scrollRowsContainer）只滚声明帧——**E7/B1 修复**：滚动 evaluate 实参此前误传原串（带尾缀 =
  非法 CSS），每帧 catch continue ⇒ 恒 `not_scrollable` 且 scrollTop 不动；现在传剥离后 base。`checkExtractSelectors` 对合法尾缀行选择器先剥后验。
- **【契约】** schema-gen F71 条目 + css_exists/css_count_* 语义注记与 HINT_GRAMMAR note 补尾缀；
  dist/schema/ctx.json 快照已重生成（schema:check 绿）；APP_SCRIPT_AUTHORING §5「读侧帧限定」+
  多 frame 速查 + §10 stopCode 表 + §11 已知边界更新；AGENT_INTERFACE 会话读侧帧限定节新增；
  BACKLOG「后续立项」#4 收口；WITHIN_PARITY_PLAN §6 实施注记。
- **【验证】** 离线断言全绿（/tmp/af-e4，54 组）：split 矩阵（合法单段/链/大写、非法 path/默认端口/
  伪尾缀属性值/双尾缀/缺主体、无尾缀逐字节恒等）、locatorAnyFrame/countAnyFrame 帧过滤矩阵
  （声明帧命中且只扫声明帧、信封外跳过、帧不存在 miss、无尾缀跨帧 OR 原样）、signals css_*
  经底座等价性（无尾缀全帧口径不变；带尾缀新语义）、F45② suffix-aware（frameGateOf 双视图 +
  runReportTail 升级触发断言）、ctx.read 不抛口径（null/0 + trace 证据）、尾缀被拒诊断、
  test-double fallback 排序、signalHasFrameSuffix + arrive 尾缀条件信封（含无尾缀逐字节对照）；
  E1（33）/E2（34）/E3（97）套件回归复跑全绿；
  `npm run typecheck` / `npm run prompt-hit` 通过。浏览器级留待 lead 专项
  （真页 read/extract 带 ` frame:` 取子帧文本、信封外 null、done 信号 frame 尾缀升级）。

### E5 批（induceHint 帧限定）

- **【背景/规格】** `docs/WITHIN_PARITY_PLAN.md` §7（+ §12.4「E5 不依赖 E2」）。旧 `induceHint`
  只产 `[attr=v]` / `tag[near~token]`——记忆 hint 只在同一 `(url, subgoal)` 生效，但同 url 下
  同签名父子/兄弟帧回放会歧义 → 回退模型（无误动作，记忆价值打折）。
- **【产物】`src/model/hint-memory.ts`**：`induceHint` 在稳定句柄后追加帧限定尾缀——
  `frame_path` 非空（= 非主帧）且 `frame_origin` 非空时产 `<hint> frame:<own origin>`（单段；
  与 `frame:` 语法同形）；主帧（`frame_path` 省略/空数组）**逐字节不变**；未知 origin 帧
  （`frame_origin`/`frame_path` 两字段皆缺，如 about:blank/srcdoc）**不追加**——任何 `frame:`
  都命中不了那种帧，加了只会得到一条死 hint，保持既有"歧义/未命中→回模型"行为。
- **【回放链路（零新增代码，核对项）】** `currentHint`（`executor.ts`）→ `hintMatch` →
  `parseHint`：尾缀在解析层被 `splitTailSuffixes` 剥离、`frameChain` 进 `hintMatchImpl` 入口
  entries 过滤——子帧记忆精确落帧，同签名跨帧不再歧义（D2：**同 origin 父子帧仍可能歧义**，
  own origin 单段区分不了同源父子；跨帧同签名不合并仍是独立立项）。`hintMemory.record/
  lookup`、落盘 sidecar 重载同链路可用；`hint-lint` 的三类形状判定只读 `parseHint` 的 base，
  合法尾缀不产生 `rejected`/`host` 提醒（三类 finding 种类/条数与无尾缀一致）。
- **【amber start 护栏（E5 产物进入主帧点击面的必要适配）】** 该 CLI 的演示点击是主帧
  `page.click(...)`：`extractElements` 会扫子帧，`induceHint` 产出的帧限定串此前会以非法 CSS
  点击失败。现在对**生成后的 hint** 复用 `frameTargetRejection`（与 `--target` 同一条结构化拒绝，
  exit 沿用 2，指路 app/run 或 plan 面）；主帧产物 rejection = null，行为逐字节不变。
- **【文档/契约】** `docs/APP_SCRIPT_AUTHORING.md` 学习环补「记忆产物的帧限定（E5）」段
  （子帧带尾缀、主帧不变、未知 origin 不加、D2 边界）；BACKLOG「后续立项」#5 收口；
  `schema-gen` F70 statement 末尾补 E5 批（induceHint 子帧尾缀）+ truth 补
  `src/model/hint-memory.ts` / `src/cli/start.ts`；`HINT_GRAMMAR.frame_suffix` 注记同步；
  schema 快照重生成。
- **【验证】** 离线断言全绿（/tmp/af-e56，E5 组 89 条）：主帧元素新旧实现逐字节矩阵
  （旧实现 = `git show fb86b7c` 提取的 `HANDLE_ATTRS+induceHint`，data-test/id/name/near/
  无句柄/长 label/volatile/主帧两字段形状/null/undefined）；子帧产物 = 旧产物 + ` frame:<origin>`
  且 `splitTailSuffixes`/`parseHint` 自证 base/kind/frameChain；未知 origin/部分缺失/主帧空 path
  不追加；池内 `hintMatch` 自证（同签名三帧中精确命中 f1/f2/n2、候选集 1 vs 未限定 3）；
  `record→lookup→currentHint→hintMatch→parseHint` 回放与 sidecar 落盘重载；hint-lint
  三类 finding 不误报 + 合法 origin 零 frame 提醒 + 大写 origin 合法；`amber start` 子帧产物
  结构化拒绝 / 主帧放行。

### E6 批（小项收尾）

- **【matchedChains 截断标记（BACKLOG #7 / 方案编号 #12）】** `extraction.probeExcludedHint`
  此前"去重"与"截断到 ≤4"共用一个条件（`!seen && length<4`）——>4 条时证据里连总数都看不到。
  改为**全量 distinct 链计数**（`seenChains` 恒累加）+ 列表仍列前 4 条；`ExcludedHintProbe`
  additive 增 `matched_chains_total`（恒有，去重口径）与 `matched_chains_truncated?: true`
  （仅 `total > listed` 时出现，≤4 条时字段省略）。`executor-pure.frameTargetStopReason`
  仅在截断时于 `hit chain(s):` 段末补 ` (共 N 条 distinct 链，还有 M 条未列出)`；**≤4 条 /
  空链证据时 reason 逐字节不变**（离线用 `git show fb86b7c` 的旧函数对照）。
- **【整串 `frame:` 诊断（BACKLOG #8 / 方案编号 #13）】** `hint.describeFrameSuffixRejection`
  对**首词即 `frame:`、无 hint 主体**的形状（`frame:https://a.com`、前导空白后同形、大写
  `FRAME:...`、带 within 的同类串）补「尾缀前没有 hint 主体（必须写成 `<hint> frame:<origin>`）」
  诊断（复用同一条失败修饰文案，只走失败路径附注）；带**未闭合 `[` 守卫**——`[data-x=frame:o]`
  一类值内伪后缀不误报（与循环内同一条 `hasUnclosedBracket`）。`parseHint` 的解析结果不变
  （整串仍按旧形状=裸词落空）；**带主体时新旧逐字节相同**（22 条矩阵）。
- **【文档（BACKLOG #9）】** `docs/APP_SCRIPT_AUTHORING.md` 尾缀段补「大小写与整串形状」：
  hint 先整串 lowercase（`i` 语义）——`FRAME:HTTPS://A.COM` 与 `frame:https://a.com` 等价、
  被识别为合法尾缀；`findByHint`（`plan check --probe`）的属性词正则大小写敏感——
  `[DATA-TEST=x]` 不命中、`[data-test=x]` 才命中（新旧一致、既有边界；act hint 侧先折叠不受影响）；
  整串无主体的显式失败与修法。BACKLOG #5/#7/#8/#9 状态更新（#7/#8 标注方案编号 #12/#13）。
- **【契约】** `schema-gen` F70 statement 补 E6（整串 `frame:` 缺主体诊断 + `[data-x=frame:o]`
  不误报）+ truth 补 E6 文件；F45 statement/truth 补 `matched_chains_total/truncated`（列表仍
  ≤4、reason 截断带总数）；`HINT_GRAMMAR.frame_suffix` 同批注记；schema 快照重生成
  （`npm run schema:check` 绿）。
- **【验证】** 离线断言全绿（/tmp/af-e56，E6 组 61 条）：6 条 distinct 链 → total=6、列表 4、
  truncated=true、reason 除截断附注外与旧文案逐字节相同；1/3/4 链 → total 真实、无 truncated、
  reason 逐字节旧；同链两帧 distinct 去重 total=1；未知 origin（detached）opaque 键去重；
  声明链只评估匹配帧；无被排除帧 → null；空 matchedChains 的 reason 逐字节旧；整串
  `frame:` 诊断矩阵（`frame:o` / 前导空白 / 大写 / 链形 / 带 within）+ 属性值伪后缀/未闭合 `[`
  不误报；带主体 22 条新旧逐字节；`parseHint` 解析不变、大写 origin 合法、`[DATA-TEST=x]`
  既有边界、子帧 induceHint 身份产物 findByHint 命中。

### E7 批（E 批实现复审修复：2 Blocking + 非阻断项）

- **【B1（中）ctx.collect 声明帧滚动失效】** `scrollRowsContainer` 已算 `scrollSplit`，但 evaluate
  实参仍是**原始 rowSelector**——带 ` frame:` 尾缀时每帧 `querySelectorAll` 非法 CSS → catch continue
  → 恒 `not_scrollable`、scrollTop 不动。改为传 `scrollSplit.selector`（无尾缀/被拒尾缀时与原串逐字节
  相同）。浏览器复跑：`li.row frame:<主帧 origin>` 前后从 `not_scrollable/scrollTop=0/rounds=1` 变为
  `stable/scrollTop=640/rounds=6/rows=20`，无尾缀对照不变。
- **【B2（中低）findByHint 无法解析子帧 nearToken 记忆产物】** E5 起 `induceHint` 子帧产物尾带
  ` frame:<own origin>`；`findByHint` 的 `induceHint(el) === base` 精确串比较在「有尾缀产物 vs 剥离后
  base」时恒不等 → null（E5 前可用 = 行为回归）。改为比较 `splitTailSuffixes(induceHint(el) ?? "").base`
  ——无尾缀产物 split 后 base 逐字节原串。浏览器复跑：子帧 near 产物 `button[near~…] frame:o` 从
  `null` 变为命中 `f1:e0`；无 frame 字段元素命中不变。
- **【N1（中）HINT_HEAD within 锚查找大小写】** DOM 侧 `getElementById(id)` 用 parseHint 归一后的
  小写值，`<div id="Wrap">` 查 `wrap` 恒 null（池侧 anchor_ids 已小写）→ 池/DOM 判定分裂。改为
  pass 内**懒建一次**小写 id → 文档序首元素映射（memoized；口径与 `getElementById` 一致：重复 id 取
  文档序首个），每行复用。离线 fake DOM + 真页（`browser-case.mjs`：#Wrap/#Inner 大小写混写）复跑：
  DOM 回捞与池侧同时命中，`#Inner>#Wrap` 错序仍 fail-closed。
- **【N2（低）`within:#x>#x` DOM 侧非 fail-closed】** `contains(self) === true` 使同元素退化命中。
  DOM 侧链校验改为**两段锚必须是不同元素且严格包含**（`a !== b && a.contains(b)`）；契约同步
  （F69 / `HINT_GRAMMAR.within_suffix` / 文档 / E2 断言）：**池侧不匹配、DOM 侧同元素退化也不命中**。
  复跑 `within-parity-edges` / `probe-dup3`：`#target within:#a0>#a0` 与 `#bx within:#x>#x` 的 DOM/PROBE
  行从 1 → 0（`#x>#y` 这类真实嵌套仍命中）。
- **【N4（低）读侧尾缀对非 CSS 选择器误剥】** `new URL()` 接受 `)`/`'`/`"` 作为 host 字符，
  `div:has-text("x frame:https://a.com")` 的尾缀落在引号内仍被剥（base 变成 `div:has-text("x`）。
  `splitFrameSuffixFromSelector` 剥离后加**引号/括号平衡守卫**（`"`/`'`/`(`/`)`/`[`/`]` 不配对 ⇒
  整串原样 + rejected「选择器含未闭合引号/括号，尾缀未应用」；字符串内对比字符不参与、反斜杠转义
  跳过）。F71/CHANGELOG 的「E4 前必然非法 CSS」措辞改为「纯 CSS 必失败；非 CSS 引擎（text= 等）作者需
  显式引用 / 本守卫拒绝」。复跑 `browser-pseudotail`：`div:has-text("x frame:o")` 从误剥 → 整串原样 + 拒因；
  `[title="x frame:o"]` 等值内伪尾缀仍原样拒绝；纯 CSS 合法尾缀不受影响。
- **【N5（低）读侧 `frame:` 空值不诊断】** `SELECTOR_FRAME_TAIL_RE` 值部 `(\S+)` → `(\S*)`，空值
  走 rejected（selector 原样）——`selectorFrameChainProblemText` 的 `case "empty"` 变可达。复跑
  `browser-read-invalid`：`#bg4 frame:` 的读面事件从无 `frame_suffix_rejected` → 带拒因（null 不变）。
- **【N6（低）suggestHints 非法段 break 丢失外层合法祖先单层候选】** E2 生长链在首个非法段停下
  （正确：更深链必含它），但非法段**之后**的外层合法祖先单层候选被一并吞掉（E3 旧行为会跳过非法段
  继续逐个试）。补回「链候选未命中时，对其后每个合法祖先 id 单独试单层 `within:#id`」——push 仍
  自证唯一、顺序（身份→label→frame→within）与上限 4 不变，首次成功即停。复跑 `suggest-invalid`：
  `["Close within:#good"]` 与旧实现逐字节一致，正常生长序 `#a3>#a2>#a1` 不变。
- **【N7（低）E4 尾缀激活的信封面两条未封口】** `ctx.step newTab` 的采用标签 done（ctx.ts:311）与
  新开标签 done（:421）、`ctx.done` 的 invariants 求值（:1759）此前不传 hosts。现在与 arrive 同口径：
  **仅 `signalHasFrameSuffix(...)` 时传 `{hosts}`**；无尾缀逐字节不变（新 helper `signalHosts`）。
- **【N8（低）契约/文档漂移】** ① F64 statement 补 E1/E2 的 F64 within 消费（`anchorChainMatch`；
  truth 补 `executor.ts:2316-2322`）；② 本文件旧「read/extract/collect/judge 帧限定未做」边界改为已收口；
  ③ E4 的 collect 滚动描述与 B1 修复一致；④ F69 `#x>#x` 文案按 N2；⑤ F69「段首 # 可选」改
  「首段必须 #、后续段可选 #」；⑥ 会话 `rowsSettled` 的 `countAnyFrame` 不传 hosts 在 F71/文档注明为
  证据面边界（只影响 `scroll_settled` 提示，不影响抽取行）。
- **【验证】** `browser-collect`（B1）、`browser-findby-near`（B2）、`within-parity-edges`+`probe-dup3`
  （N1/N2）、`browser-pseudotail`（N4/N5）、`browser-read-invalid`（N5）、`suggest-invalid`（N6）复跑
  关键行见上；`browser-case` 真页大写 id（N1）。离线：E1 33 / E2 34（N2/N6 断言按新契约更新）/
  E3 97 / E4 54→56 组（补 2 组：collect 滚动 maxRounds≥2 含尾缀 + N4/N5 split 守卫）/ E5+E6 150→153
  （补 3 条：near 产物带尾缀 + 子帧 near 产物命中 + 无 frame 字段命中不变）全绿；`npm run typecheck` / `npm run prompt-hit` / `npm run schema:check`（快照重生成）通过。

### 已知边界 / 未做（A–D 批后的诚实清单）

- **`within` 语义链（E 批 E2）**：已收口（E2——链语法/嵌套序包含语义/池+DOM+FW8+F64+DRF
  消费面/候选生长/诊断/契约同批，见上方 E2 小节）。**单层** within 的回捞面权威对等已由
  E1 收口；**跨帧** within（锚在另一文档）维持文档边界。
- **跨帧同签名不合并**：未做（需独立立项 + 开关）。`esig`/`firstIfSame` 的签名不含 frame 字段，
  同 tag/label/href/data-test 的跨帧元素仍可能被 `firstIfSame` 合并；run 命令步 / act hint 直接
  执行一个，会话 act 因 `hintCandidates.decided` 不暴露该裁决而停。
- **同 origin 父子帧的记忆产物（E5/D2 边界）**：`induceHint` 只追加自身 origin 单段（记忆侧
  没有帧完整链）——同源父/子同签名元素的记忆回放仍可能歧义 → 回退模型（无误动作）；
  需要精确区分时用 authored `frame:<parent>><child>` 链或 `inspect`/`ctx.observe` 的候选。
- **`read`/`extract`/`collect`/`judge` 帧限定对称化**：**已收口（E4；E7 修复 B1 滚动与 N4/N5 拒因）**——
  读/判面 CSS 选择器支持 ` frame:<origin链>` 尾缀；ctx.read/extract/collect 按信封过滤（不抛，
  miss + `frame_evidence`），done/when 走 F45② 升级，collect 内部滚动只滚声明帧（evaluate 用剥离后
  base）。**证据面边界**：会话 `extract` 的 `rowsSettled` 滚动稳定计数走 `countAnyFrame` 未传 hosts
  ——带尾缀 rows 的 `scroll_settled` 可能含信封外帧（只影响该提示，抽取本体按信封过滤）。
- **>6 帧 / 每帧池配额**：未做。`framesOf ≤6`；池窗口 40/120 跨帧共享、主 frame 优先；
  `frame:` 落空时 reason 列允许帧 origin（去重 ≤6）。
- **`about:blank`/srcdoc**：本期不可寻址（未知 origin → 不可被任何 `frame:` 命中）；`frame:` 只做
  匹配，不是安全判定（门禁是 hosts）。
- **帧下标链 / nth-child / XPath / iframe 选择器锚**：不做（漂移 + 破坏 hint 封闭集）。
- **`plan check --probe` 的匹配边界**：`findByHint` 只支持 `#id` / `[data-test=|id=|name=]` /
  `induceHint` 产物；C 批只补 parseHint + 帧链过滤、E3 同面补 within 作用域（单层+链），
  **不是** `hintMatch` 六形状分档。`amber start
  --target` 对帧限定目标结构化拒绝（主帧 `page.click`）。
- **证据上限合同变更（已记账）**：`AMBIGUITY_HINT_MAX` 80→200、桥 `suggested_hint` 80→200、
  `HINT_MAX_CHARS` 160→200；新增 `FRAME_PATH_MAX_ITEMS=4` / `FRAME_PATH_SEGMENT_MAX_CHARS=64` /
  `STRUCTURE_PATH_MAX_CHARS=160`。引擎歧义 `frame_origin` ≤120，桥 clip ≤60。
- **`structure_path`**：仅诊断（inspect 恒开 / observe `includeStructure` opt-in），不进模型面、
  歧义证据或 hint 自证。
- **`within` 在回捞面**：E1 已收口**同帧** within（五池 anchors + 消费面遵守，E2 起链形
  同语义）；**跨帧** within（锚在另一文档，如宿主页的 iframe 元素）维持文档边界——anchor_ids
  是帧内文档祖先链。

## [Unreleased] — inspect --probe 跨 frame 探测（iframe 元素不再静默漏检）

- **【修复·inspect 探测面】** `inspect --probe` 此前只在**主 frame** `page.evaluate`，
  跨 iframe 元素恒 0 命中，被误读为"页面没有/不可自动化"（2026-11-14 实测：Google 应用菜单
  面板在跨源 iframe 里，探针 `a[aria-label="Maps"]` 报 0，但池内 `f1:e3` 可点）。现探测
  覆盖主 frame + 可达子 frame（`framesOf` ≤6）：主 frame 命中仍落 `count/texts`（**旧 JSON
  形状逐字节不变**），子 frame 命中落 `probes[].frames[]`（`frame` 下标 + `origin` + 命中数/文本，
  additive；仅在有子 frame 命中时出现）。
- **【advisory 增强】** `not_in_pool` / `pool_inexpressible` 的 `dom_hits` 改为全帧总命中并带
  `frame_hits` 证据；命中仅在子 frame 时明确提示「动作目标需该 frame origin 在 hosts 信封
  （app `meta.hosts` / 会话 hosts），否则解析面排除该帧（frames_excluded），池内以 `fN:`
  前缀 ref 出现」；`pool_only` 文案与全帧探测口径对齐。`frame_host` advisory 保留。
- **【文档】** `docs/APP_SCRIPT_AUTHORING.md` 增「多 frame 定位速查」：枚举帧（`frame_origins` /
  `probes[].frames` / observe `frames[]`+`frame` 下标）→ 定位元素（`f<fi>:eN`、跨帧 hint 唯一性、
  ambiguity frame 证据、F64 #id 直查）→ 跨源帧须进 hosts → 已知边界（≤6 帧、池窗口跨帧共享、
  下标漂移用 hint 不用 ref）；inspect 帮助文本同步。
- **【验证】** 双端口跨源 fixture：`a[aria-label="Maps"]` 主 frame 0 / 子 frame 1
  （http://127.0.0.1:8932）1 命中；`div[aria-label="Maps"]` 触发带 frame_hits 的 not_in_pool
  advisory；主 frame 命中与无命中路径形状不变；`npm run check` 全绿。

## [Unreleased] — not_scrollable 停因诊断增强（祖先 overflow 证据）

- **【优化·滚动停因】** `_scrollWithLoc`（run scroll 命令 / `ctx.scrollList` / 会话 act 容器滚动
  的同一条实现）在找不到标准滚动容器时，`reason` 不再只有一句泛化文案，而是带上祖先诊断：
  最近 ≤3 个非 `overflow:visible` 祖先的 `tag.class`/overflow 值/`scrollHeight/clientHeight`；
  若存在「内容溢出但 `overflow:hidden`」的程序化滚动候选，明确标注
  `(programmatically scrollable, not a standard scroller)` 并提示引擎只滚标准
  `overflow:auto/scroll/overlay` 容器（可改滚其内部目标或 `ctx.scrollList("document")`）。
  判据与 stopCode 语义**不变**（仍 `not_scrollable`、零行为变更），仅提升 Agent 自解释能力。
- **【背景】** 2026-11-14 实测：Google Maps「All filters」面板用 `overflow:hidden` +
  程序化 `scrollTop` 自定义滚动（面板内 `overflow:auto` 祖先 638/638 不溢出、全页标准
  滚动器 0 个）→ 旧文案无法区分三种成因，本条补足证据。
- **【文档/契约】** `docs/APP_SCRIPT_AUTHORING.md` 的 scrollList 注释与 schema-gen F56 同步补记。

## [Unreleased] — schema 契约文字同步：观察面 within 闭环（F41/F55/F69）

- **【schema·F41】** `ctx.observe` 的 `hint_candidates` 候选形状补记「同名组 within 候选」：
  文本候选不唯一但祖先链有 #id 时给 `<label> within:#<ancestor-id>`（同一 hintMatch 自证），
  同名元素组从「无候选 → admitted:false」变为「带 within 候选的 admitted:true」；truth 补
  `OBSERVE_JS anchorIdsOf` 采集 / `syntheticElem` 透传 / `why_not_admitted` within 指引。
- **【schema·F55】** 歧义证据的 `suggested_hint` 补记可为 `<label> within:#<ancestor-id>` 形态
  （同名组且元素有 anchor_ids 时由 suggestHints 生成，仍经同一 hintMatch 自证，可直接照抄）。
- **【schema·F69】** within 条目补记观察面闭环：OBSERVE_JS 同口径采集祖先 id 并经
  syntheticElem 透传；suggestHints 对同名组按最近祖先优先建议 within；inspect/observe 的
  hint_candidates 与歧义 evidence 的 suggested_hint 直接给出可照抄形态。
- **【验证】** `npm run check` 全绿（`dist/schema/ctx.json` 按提示重生成，gitignored）。

## [Unreleased] — 引擎观察面修复：aria-label 探测假阴性 + 同名组 within hint 候选

- **【修复·inspect 探测面】** `matchSelector` 的 `aria-label` 别名键映射到 `aria_label`
  （signals witness 池字段），而引擎元素池行（`Elem`）只有 `label`/`full_label` →
  字段恒空 → `not_in_pool` advisory 把可被 act 命中的元素误报“池内 0 命中”。
  改为别名键按池行底座回退 `aria_label ?? full_label ?? label`（显式空串不回退，
  带 `aria_label` 的 StateView 匹配逐字节不变）；其它属性键与
  class/组合器“不可表达”语义不变。
- **【修复·advisory 文案】** `inspect` 的 `not_in_pool` 文案改为准确表述（元素可能不在
  准入面或无交互角色/不可见；aria-label 是 label 别名、交互标签可命中），删除
  “aria-label/class 永不入池、act hint 永不命中”的误导；其它 advisory 分支不动。
- **【新增·同名组 within 候选闭环】** `suggestHints` 在文本候选不唯一且有 `anchor_ids`
  时按最近祖先优先追加 `<label> within:#<id>`（锚字符集与 `parseHint` 一致、仍走同一
  `hintMatch` 自证、4 条上限与身份形状顺序不变）；`why_not_admitted` 补 within 指引；
  `OBSERVE_JS` 采集祖先 id（≤8、小写、最近祖先在前；无 id 祖先时字段不出现，旧观察
  JSON 形状不变），`ObserveRawRow.anchor_ids` + `syntheticElem` 透传 →
  `ctx.observe` 的自证池可生成/验证 within 候选：同名元素组从 `admitted:false` 变为
  带 `Close within:#panel` 等可照抄候选。
- **【文档】** `docs/APP_SCRIPT_AUTHORING.md` 停因表 `host_not_allowed` 行补：页面驱动
  导航若 301/302 落到信封外 host 同样报此停因——重定向落地 host 也要声明在 `meta.hosts`。
- **【验证】** Lead 离线断言 11/11（别名回退 / StateView 不变 / within 自证 / 唯一 label
  顺序不变 / 无锚与非法锚不变）；本地 fixture 浏览器级：inspect 探测不再误报、
  `ctx.observe` 同名组 admitted 且带 within 候选、`close within:#panel` 与
  `#searchbox` 分别命中正确元素、裸词歧义仍零动作；`npm run check` 全绿。

## [Unreleased] — 介入/救援中断模块 texts 生成接线（设计 §8 步 4）

- **【新增·intervention 断言组】** `tools/prompt-hit.ts` 新增第八个断言组
  `intervention`：对 `src/support/intervention-texts.ts` 的
  `RESCUE_TEXTS`（action/value/authorization 三 kind）+ `SIGNAL_NOT_HELD_TEXT` +
  `OUTCOME_TEXTS` + `FULFILLED_NOT_HELD_TEXT` 全量执行六条清单——① 每条 zh 非空；
  ② agent_hint 为 en 面（混入中文即红，渲染器不得拼 zh）；③ summary ≤400 字；
  ④ human_question ≤120 字；⑤ 人话层禁 stopCode 键名/JSON 形状/英文栈帧；
  ⑥ agent_hint 不含面向人的祈使句。总输出行同步更新为「八组全绿」并列出
  intervention（组名引用制，插组不失准）。
- **【桥接·RESCUE_AGENT_HINTS】** `bridgeGenerated()` 把三 kind 的 agent_hint
  （`{fact, recommended_action, stop_condition}`）以 `RESCUE_AGENT_HINTS` 导出进
  `integrations/dsh-bridge/src/grammar.generated.ts`（生成物，经
  `npm run prompt-hit -- --fix` 刷新，不手编辑）；zh 人话层不进桥——渲染留在引擎侧，
  called, not embedded 纪律不变。
- **【schema·intervention 节 + F62】** `src/cli/schema-gen.ts` 的 `SCHEMA_TOPICS`
  追加 `intervention`；新节从真源 import（`RESCUE_KINDS` / `RESCUE_TEXTS`）渲染
  kind 三条（who_can_fix / stop_code / zh summary 摘要）、`result.rescue` 形状、
  agent_hint 三键形状、五态结局与影子开关说明；F 条目续编 F62（既有编号零重排）。
  `dist/schema/ctx.json` 同提交重生成；`amber schema ctx --topic intervention` 可查。
- **【文档】** `docs/MANUAL_STEPS_AND_PACE.md` 增第 6 节、`docs/AGENT_INTERFACE.md`
  增 §4.1：v1 语义、`result.rescue` 只在真实求援出现、影子开关
  `AMBERFLOW_RESCUE_SHADOW=1`（其余值视为关）。
- **【不改运行时】** `intervention-texts.ts` / `intervention-contract.ts` /
  `src/intervention/` 模块本体冻结；除 `schema-gen.ts` 外 `src` 运行时文件零改动。

## [Unreleased] — amber session 有头窗口尺寸（--window maximized|fullscreen）

- **【新增·session 窗口尺寸】** `amber session --window maximized|fullscreen`：
  `maximized` = 最大化（保留浏览器 chrome，注入 `--start-maximized`）、`fullscreen` = 全屏
  （F11 语义，注入 `--start-fullscreen`）。仅 headful 生效（`--headful` 或配置层
  `AMBERFLOW_HEADFUL=1`）；无头会话下给 `--window` = 用法错误（exit 2，**不静默忽略**）；
  闭集外的值同样 exit 2。实现 = 启动旗标 + 上下文 `viewport:null`（页面铺满真实窗口；
  否则 Playwright 缺省 1280×720 视口会把窗口约束回默认尺寸）。缺省不传 = 现状逐字节不变
  （`launchKwargs` 的窗口旗标只在显式 windowMode 且非 headless 时追加）。
- **【桥接·需重载】** `amberflow_session` open 增 `window` 参数（枚举 `maximized|fullscreen`）：
  需有头（`headful:true` 或部署 `Config.headful`），无头组合由桥先拒为结构化
  `config_error`（不靠子进程报错）；argv 透传 `--window`。桥模块重载/重启后工具参数才可见。
- **【范围】** 只接 session 面（authoring 试错最需要看真实窗口）；`run` / `inspect` 的同类
  窗口尺寸可作为后续扩展——`browserSession(headless, device, metaChannel, windowMode)` 与
  `launchKwargs` 已是单点实现，接入只需把参数从各自 CLI 透传下去。

## [Unreleased] — AMBERFLOW_HEADFUL env 层接线到 inspect/session/test（插件 HEADFUL 全链路生效）

- **【缺陷修复·env 层只覆盖 run 一条腿】** 桥配置页勾选 HEADFUL 后子进程注入
  `AMBERFLOW_HEADFUL=1`，但引擎只有 app-runner（`amber run/apps`）读 runDefaults——
  `amber inspect`（只读观察）与 `amber session`（authoring 会话）的 CLI 从不消费该 env，
  Agent 最常走的两条"打开浏览器"路径依旧无头（配置页勾选形同虚设）。修复：inspect 的
  `--headed` 与 session 的 `--headful` 都接入「CLI 旗标 > env（AMBERFLOW_HEADFUL）> 缺省
  headless」同一层叠；test 的 `--headful/--headless` 也接 env 层（配置默认值语义，旗标仍赢）。
  runDefaults 解析错误响亮报错（exit 2，与 app-runner-cli 同纪律）。plan-cli 旧面维持文档化
  的"缺省 headless"（`a.headful` 只来自新 CLI 透传）。
- **【缺陷修复·test --headless 起有头】** `amber test --headless` 此前被解析但接线算错：
  `runSuite` 的 headless 写成 `!(--headful || --headless)`，给 `--headless` 也算出 `false`
  → 套件起了**有头**浏览器，与 USAGE "--headless 显式无窗口（缺省 headless）"直接矛盾。
  修复后：`--headful` 或配置层 headful=true 才有头；`--headless` 显式无窗口；两者同给仍
  exit 2。`--headless` 从"不生效"变"生效"（有意变更面）。
- **【引擎侧同义参数排查结论】** 配置面（`config-schema.ts`）已是「一个概念一个键」纪律：
  旧别名（`LAYAA_*`、`HUGGINGFACE_HUB_CACHE`、`LAYAWEBUSE_REPO`、`TOKEN_PLAN_STATE_CONTEXT`）
  只作兼容回退留在消费点（canonical 优先读），不进配置面——写进 rc 加载期按未知键拒绝。
  疑似同义对均为**作用域分层**而非同层重复：`--conf-floor`/`AMBERFLOW_CONF_FLOOR`（run 层）
  > `meta.policy.conf_floor`（应用层）> provider 自报 floor（`AMBERFLOW_DECISION_FLOOR`，
  随 provider 走——score_kind 跨 provider 不可比，这是 provider floor 存在的理由）> 全局
  0.25；`AMBERFLOW_STEP_DELAY_MS`（步间）/`AMBERFLOW_ACTION_DELAY_MS`（动作间）粒度不同，
  共用 `src/support/pace.ts` 同一语义。CLI 的 `--headful`/`--headless` 是一维两向旗标
  （同给 exit 2；配置面只有 `AMBERFLOW_HEADFUL` 一键），与插件配置页只留 HEADFUL 同构。

## [Unreleased] — 插件配置页 HEADFUL 开关（单一有头选项）

- **【新增·桥接配置页 HEADFUL 布尔项】** `amberflow-bridge` 的 Config 新增 `headful`（volatile
  boolean，默认 false）：勾选后桥拉起的每个引擎子进程注入 `AMBERFLOW_HEADFUL=1`（显示浏览器
  窗口），压过引擎配置文件的 `runDefaults.headful=false`（env 层 > 配置文件层）；不勾选 = 不注入
  （引擎配置层叠决定，逐字节现状）。工具调用显式给的 `headful` 参数是 CLI 旗标层，仍最优先。
- **【形态说明·一个开关维度一个选项】** 浏览器窗口只有"要不要显示"一个维度，配置面只保留
  HEADFUL 一个布尔：headful 与 headless 是同一事实的两面，同置两个反义布尔 = 同一配置写两处
  （会互相覆盖、还得引入互斥校验），故不设 headless 反义项——想常驻无窗口在引擎 rc 配
  `AMBERFLOW_HEADFUL=0`（页面不勾选时不注入任何 env，rc 照常生效）。本版本线里此前实验性的
  `headless` 布尔项（未发布，本 profile 也未写入过）随之移除，无迁移面。配置页勾选时行摘要
  显示 `· HEADFUL`；`client-root.js` 由生成器重新生成，README/README.zh/DEVELOPING 同步。
- **【同义配置排查】** 桥 Config 面逐项核对后无其余同层同义项：`timeoutMs`↔工具参 `timeout_sec`、
  页面三项决策模型/步间距/HEADFUL↔引擎 rc 同名键（`AMBERFLOW_DECISION_*`/`AMBERFLOW_STEP_DELAY_MS`/
  `AMBERFLOW_HEADFUL`）均为「部署默认 ↔ 逐次覆盖」「页面 env 层 ↔ 引擎配置文件层」的分层关系
  （CLI 旗标 > env > 项目配置 > 全局配置，且"未设置 = 不注入"不遮蔽 rc），与引擎配置面
  「一个概念一个键」纪律同构；`sessionIdleMs`（桥会话 TTL）与引擎子进程 `--idle-timeout-ms`
  孤儿兜底是刻意的双层空闲（桥层权威，子进程层只是保险），非用户可见同义配置。

## [Unreleased] — C2 抽取选择器预检（非法选择器 → 结构化 config_error）

- **【缺陷修复·静默空数据】** `ctx.extract` 的行/字段选择器非法（如 `rows:"div["`、`fields:{x:"div["}`）
  此前被 `locatorAnyFrame`/字段循环的 `try/catch` 吞成 `[]`/`""`——假数据与"合法但零命中"
  无法区分（最危险的静默形态）。现在 `readRows`（extract 与 collect 的唯一实现）在**入口**做一次
  选择器解析预检：行选择器 + 每个字段选择器（除 `"."`/`":scope"`/`"@attr"` 形态）各一次
  Playwright `locator(sel).count()`（每次抽取 ≤ 1+字段数 次往返；collect 只在入口一次、循环内不重复）。
  `locator(sel)` 本身不解析选择器（解析在 driver 侧），所以必须真付一次 `count()`。
- **【结构化错误·不新增 stopCode】** 仅当异常文本是**解析错误**（Unexpected token / parsing css
  selector / Unknown engine / invalid selector）才抛 `config_error`：reason
  `ctx.extract: field "x" selector "…" is not valid: …`，`diagnostics.bad_selector={selector, field?}`。
  掉帧/超时/页面已关闭仍按旧行为（不误报成选择器错）。**合法但零命中仍是 `[]`/`""`**。
  会话 `extract` 复用 observe 口径：引擎 `amber session` 响应带 `error:"bad_selector"`
  （`code` 仍 `config_error`）；桥的失败投影在引擎给该标记时原样透出 `error`（不补键）。
- **【有意行为变更】** ①非法选择器从"静默空"变"响亮配置错"；②`ctx.collect` 旧的 DOM
  `querySelectorAll` 预检已删除、改走同一入口——Playwright 伪类（`:has-text(...)` 等）不再被误拒。
  **dry/replay 不访问浏览器、不做预检**（`apps check` 不因此红，只有真跑/会话才红）——文档写明。
  合法选择器下 extract/collect 的返回值与产物逐字节不变（夹具按"改前 readRows 复刻"对照全字段全等）。

## [Unreleased] — C3 信号报错形态统一（合法写法单点给出）

- **【缺陷修复·报错不可行动】** 对象形信号 `{css_text_contains:{selector:"div",text:"x"}}` 被
  `signalArgs` 折成长度 1 的参数列表 → 只报 `needs 2 argument(s)`，不说合法形态；会话/加载期
  各自拼提示。现在 `signals.ts` 新增 `SIGNAL_SHAPE_HINT`（叶 `{op:[arg…]}` 按位置放数组；组合
  `all_of`/`any_of` 非空数组、`not` 单个对象；对象形 `{selector,text}` 非法）+ `signalProblemText(problems,
  "json"|"cli")`，是合法形态提示的**唯一出处**。
- **【problems 自带提示】** `validateSignalSpec` 的 arity 分支在 `signalArgs(args).length !== arity` 时
  把合法形态与"收到什么形状"写进 problem（`all_of`/`any_of`/`not` 的形状错同样指路）——因此
  `apps check`/`plan check`/`test --validate` 的加载期校验自动继承。`plan-cli` 走 cli 版（`--signal`
  示例串与改动前**逐字一致**）；会话 `signal`/`waitFor` 失败 reason 走 json 版（`problems` 数组原样）。
- **【不变】** 合法信号的校验结果、`checkSignal` 运行时语义与产物逐字节不变；未新增 stopCode。

## [Unreleased] — B3 快照 changed 签名含可勾选控件状态（checks）

- **【缺陷修复·changed/inert】** `changed = pre/post 快照 JSON diff` 原有签名只有
  `{url,title,text,vals}`，而 `vals` 只序列化 input/textarea/select 的 `.value`——原生
  checkbox/radio 的 `checked`、`aria-checked`、`aria-selected`、`select[multiple]` 的选中
  index 都不在里面。于是 `check` 一个单选/复选控件可能拿到 `changed=false`，进而被记为
  inert（并写入 outcome memory 误伤该元素）、吞掉 `suspected_async` 的诚实提示。
- **【独立 `checks` 字段】** `PageSnapshot`（主 frame 与子 frame 项）新增可选
  `checks?: string`：只读 `CHECKS_JS` 记录上述确定性状态（`0/1` / 属性值 / 只记 true 的
  `aria-selected` / 多选 select 的选中 index 列表），空串则不出现该字段。**不改 `VALS_JS`**
  （P0-3 的 password/file/hidden 掩码零改动），也不把状态拼进 `vals` 串（避免分隔符碰撞）。
- **【一次 evaluate】** `vals` 与 `checks` 合并为组合脚本 `FN_STATE` 一次取回（主/子 frame
  各一次），页面往返不增加；`changed` 仍是同一份 pre/post JSON diff 机制（inert /
  anti-repeat / `suspected_async` 随之如实修正），`executed_actions.changed` 口径不变。
- **【落盘与默认产物】** session `snapshot-<n>.json` 一并写 `checks`（主 4000 / 帧 1200 字符
  有界）；无 checkbox/radio/aria 选中/多选 select 的页面**产物逐字节不变**。不新增
  stopCode / effect kind；dry 与 replay 不访问浏览器。schema 快照在 F17 truth 末尾补注
  （不新增 F id），`docs/APP_SCRIPT_AUTHORING.md` 判读规则补一句口径。

## [Unreleased] — A4 会话 act 落空判别（池内同档候选 / 词面近似 / 池外不可见行）

- **【缺陷修复·session act】** `target_not_found` 此前只有一句 `target "…" matched nothing in a
  pool of N element(s)`，分不清「目标不在页面」与「用词/形状不对，或元素不可见」。现在会话 `act`
  的落空响应多带 `diagnostics:{target, pool_size, hint_shape, hint_len, candidates[≤5],
  near[≤5], rejected[≤3]}`，`reason` 末尾追加一行 `判别: …`（仿 run 命令步的
  `cmdDiscrimination`：纯内存判别，主 reason 前缀与停因码不变）。
- **【同档候选不污染回显】** `HintMatchOptions.diag`（缺省 `true`）新增 quiet 读法：`false` 时
  `hintMatchImpl` **不写** B1 弱档旁路模块态；`candidates` 用它取候选，task-34 的
  `ambiguous`/`matched_others` 回显仍是本条 target 真实解析的结果（A2 行为不变）。
- **【词面近似】** 新纯函数 `nearCandidates(target, pool, cap=5)`（`executor-pure.ts`）：token 仍由
  唯一解析器 `parseHint` 给出，对 `label`/`full_label`/`data_test`/`id`/`name`/`href` 做**前缀/
  包含**比较，返回 ≤5 条 `{ref,tag,label≤40,why?}`——纯内存、零页面往返，**不扩 hint 语法**。
- **【池外不可见行】** `_domFallbackResolve` 把扫描行一并回传（既有解析行为不变）：只对词面近似
  的 ≤5 行做**一次**可见性判定 → `rejected`（≤3，`why:"not visible"`，措辞与 `observe` 的
  `why_not_admitted` 同源）；不扫面外元素、不新造 `why` 分支。
- **【透传】** 会话 `act` 失败分支带出 `diagnostics`（引擎已按上限构造）；桥 `engineFailure`
  有界透传（candidates ≤3 / near ≤3 / rejected ≤2 / label ≤40，不重算、不补键），`index.ts`
  失败 render 在 `diagnostics` 存在时追加一行 `no match: hint <shape>/<len> pool <n> — near: …`；
  桥参数/结果 schema 不动。
- **【不变】** 成功路径与非落空失败**键集逐字节不变**（新字段只在 `target_not_found` 时出现）；
  `ctx.expand`/`ctx.scrollList`/命令步（run 面）不传该开关，返回值与 `reason` 逐字节不变；
  不新增 stopCode、不新增 schema F 语句（会话契约不进 `CTX_FACTS`）；A1/A2/A3/B1/B2/C1 不受影响。

## [Unreleased] — B1 会话 act 的被遮挡证据（探针即点击 / 结构化失败 / opt-in 失败截图）

- **【缺陷修复·session act】** 会话 `act` 的 `click`/`check` 此前走 `_clickOnly` 的 5s 超时，被覆盖时
  只回 Playwright 首行（≤160 字），没有 bbox/覆盖者证据。现在这两类动作复用 run 的
  `occludedReason`——**探针本身就是那次点击**（返回 `__clicked__` 即已点，不再调 `_clickOnly`，
  无双点），预算 `(800, 5000)`：被遮挡约 0.8s 报，未遮挡的慢元素仍留 5s 重试。
- **【结构化失败】** 失败串 `not-actionable-or-covered:<blocker>` / `action-timeout` → `code` 取冒号前
  token、`reason` 保留原文，**不新增 stopCode**（既有 skip_reason 词面，F50 同例）；失败响应带
  `actionability:{reason,bbox,blocker,requery}`（`action-timeout` 也走同一现场读取：证明无覆盖者、
  节点仍在）。非 timeout 异常不补点：URL 已变记 `probe_navigated:true` 按已点击返回，否则
  `action_failed` + Playwright 首行。
- **【新增·失败截图 opt-in】** 会话 `act` 请求 `screenshot`（缺省 `false`）：失败时写
  `<evidence_dir>/act-<n>-failure.png`，响应只回 `screenshot_file` 路径（不内联图片）。桥透传
  `actionability`（reason≤200、blocker/requery≤60、bbox 数值）与 `screenshot_file`，`act` 参数
  `screenshot` 同义；模型可见的失败行在 `actionability` 存在时追加
  `blocked by <blocker> (requery=…)`。
- **【不变】** run 面/命令步/`ctx.expand`/`ctx.scrollList` 内部点击不传探针参数，行为与产物逐字节
  不变；session 的 A2 歧义两档、B2 滚动、A1/A3/C1 均不受影响。

## [Unreleased] — A3 弱档命中门槛（`meta.policy.act_hint_tier:"strong"`）

- **【新增 policy】** `meta.policy.act_hint_tier: "any"（缺省）| "strong"`，与 `act_hint` **正交**：
  `strong` = 裸词/属性子串的**弱档**胜出（词前缀/词包含、loose 子串）判为**未命中**，不再以
  conf=1.0 直接执行——弱档命中最容易点到容器/同缀元素。
- **【判据复用】** 门槛不另造档位表，直接用 `rules.takeHintMatchOthers()` 的既有 `suspicious`
  （bare t≥3、attrSubstr t=3）；step warning 从 `matched_others` 换成 `weak_hint_rejected`
  （含档位/候选≤3/开关）。池解析与 rules-only 宽扫重解析共用同一判定（`declaredAllow`）。
- **【后续语义】** 拒后按 `act_hint` 既有语义继续：`widen` 交模型（rules-only 落既有
  `no_model_runtime`）；`strict` 结构化 `target_not_found`（reason 写明弱档被拒 + 候选 + 两条改法：
  收窄成强形状 / 回 `act_hint_tier:"any"`）。
- **【不变】** 缺省 `any` 下行为与产物**逐字节不变**；命令 target、learned hint、决策步（无 act）
  不受影响；**不新增 stopCode**（strict 复用 target_not_found）；hint 六形状闭集不变；
  显式声明才进 `effective_policy.act_hint_tier`（声明 `"any"` 也进账）。契约注记见
  `amber schema ctx` 的 F59。

## [Unreleased] — A1 属性值匹配按完整值（aria-label：full_label + label 双底座）

- **【缺陷修复·hint 属性匹配】>40 字的 aria-label 值此前永远等不上**：`tag[aria-label=…]` /
  `tag[aria-label~…]` 的匹配底座只取池字段 `label`，而 `label` 是**模型视图的前 40 字**
  （`full_label` 才是 ≤200 的匹配口径）。现在与 T9 的 href `[href_full, href]` 同形状：
  aria-label 别名（`poolFieldFor` → `label`）的底座改为 `[full_label, label]`（非空、同值去重、
  大小写折叠），**attrEq 与 attrSubstr 共用同一函数**——`[aria-label~长值尾串]` 同修，不只修等值。
- **【行为变更·严格只增】** ≤40 的值**等值**命中集合逐字节不变（`full_label` 全等 ⇒ `label` 全等）；
  >40 的值从"必落空"变为按 `full_label` 等值/子串命中；子串面在超长 label 上可能新增命中（同一
  "按完整值匹配"语义的直接结果）。同值重复仍取 DOM 首个，不新增"假唯一"；hint 六形状闭集、
  敏感值纪律不变。
- **【新增·`meta.policy.attr_value_match`】** `"full_label"`（缺省，= 修复后）| `"display"`
  （= A1 之前只看前 40 字 label；逃生口/对照臂）。接线：`app-pack` 的
  `POLICY_KEYS`/`ATTR_VALUE_MATCH_MODES`/`PackPolicy`/`validateApp`（未知值加载期 `config_error`，
  `apps check` 即红）→ `app-runner` `resolveRunPolicy`（`effective_policy.attr_value_match`
  仅声明时出现）→ `MiddlewareOptions.attrValueMatch` → `rules` 的 `HintMatchOptions`
  （`hintMatch`/`hintCandidates`/`affordanceRule`/`hintMatchImpl`；DRF 的 `declaredLookup` 与
  `ctx.waitForTarget` 同口径）。run 面按 policy 传；**inspect/observe/session 无 policy，恒
  `full_label`**。默认产物不变（policy 缺省时只有 >40 命中这一处新行为，生效于 run 面）。
- **【不变量注释】** `label === full_label 前 40 字` 已在 extraction/declared/observe/executor 的
  各构造点用注释固化。契约注记见 `amber schema ctx` 的 F58。

## [Unreleased] — C1 行抽取分页（ctx.extract offset / 会话 offset·total·has_more / 桥 save 落盘）

- **【新增·`ctx.extract` 第二参】** `ctx.extract(nameOrSpec, { offset? })`：`offset` 只做分页起点
  （0-based 整数 0..10000，非法/写进 inline spec = 结构化 `config_error` 并指路第二参），
  `maxItems` 仍是每页上限。`readRows` 唯一实现改为 `all.slice(offset, offset+cap)`，
  `total = all.length`、`truncated = offset+rows.length < total`——**offset=0 与之前逐字节一致**。
  返回类型不变（仍是行数组，`count` 语义不变）；`total` 只经 `CtxDeps.extractStats` 观测口回写，
  **只有 session 面注入**，run/dry/replay 不注入、行为与产物不变（dry 恒 `[]`、replay 按 desc 回放）。
- **【新增·会话协议分页】** `amber session` 的 `extract` 请求新增 `offset?`（非整数/越界 = `config_error`）；
  响应在 **capped 或 offset>0** 时追加 `offset`/`total`/`has_more`（`has_more = offset+count < total`），
  `count` 恒为本页返回行数、`capped` 语义不变；无 cap 且 offset=0 时键集与之前逐字节一致。
  `observe` **不提供 offset**（元素序随水合/动画变化，无稳定锚）：收窄用 `selector`/`max`，全量用
  `snapshot`（`pool-<n>.json`）。
- **【新增·桥 `amberflow_session`】** extract 参数补 `offset`（透传）与 `save`：`save:true` 时桥内
  翻页取全（每页 ≤500，硬顶 **2000 行 / 4MB**）写 `<evidence_dir>/extract-<n>.json`，返回
  `file`/`saved`/`bytes`（被硬顶截断如实标 `truncated`+`save_limit`），`rows` 仍给首页 ≤20。
  模型可见 render 的 observe/extract 显示行数 12→20 / 5→20，且**只有溢出时**追加两行
  （observe：`… +N more (M total, K omitted)` + 收窄/max/snapshot 指引；extract：`… +N more` +
  `total=T · offset=… 续页 · save:true → extract-<n>.json`）——无溢出/无 offset/无 save 时输出不变。
- **不变量**：run 的 result/report 不变（extractStats 仅会话注入；trace 的 `offset` 仅 offset>0 出现）；
  A2/B2 的会话行为不破；桥不新增引擎语义；`element-view.ts` 合同不动。契约注记见 `amber schema ctx` 的 F57。

## [Unreleased] — B2 会话 act 滚动语义诚实化

- **【缺陷修复·会话 act scroll】元素目标的 `to`/`by` 此前被静默丢弃**：`act scroll "列表" {to:"bottom"}`
  只做 `scrollIntoViewIfNeeded`（滚入视口），`changed` 还硬编码 `true`——请求的方向没生效，响应却说
  "页面变了"。现在：**带 `to`/`by` = 容器滚动**（目标元素自身或最近可滚动祖先，走
  `_scrollContainerForElement`→`_scrollWithLoc`，与 `ctx.scrollList`、run 的 `scroll` 命令同一条实现；
  `by` 优先；找不到可滚动容器 = 结构化 `not_scrollable`，不再是静默无操作）；**不带 `to`/`by` = 滚入
  视口**（旧语义不变），但 `changed` 改为**实测** `moved`（滚动容器 `scrollTop` 前后差）。
- **【新增·滚动证据】`act scroll` 响应带 `moved`/`delta`/`scroll:{scrollTop,scrollHeight,clientHeight}`
  （有则附，没有就不附）**，`_scrollWithLoc`/`scrollDocument` 成功时也新增 `delta`（after-before）。
  桥（`amberflow_session` 的 `act_op:"scroll"`）只透传这三个键（有界、不重算），act 渲染行显示
  `moved/delta`；工具参数说明改写为"to/by = 容器滚动，无 = 滚入视口"。
- **【缺陷修复·`--record` 记录诚实性】只记实际发生的事实**：滚动没走通不再记 `to`/`by`；没请求方向
  的元素滚动不再伪记 `to:"bottom"`；另记 `scroll_mode`(`container`|`into_view`)/`moved`/`delta`/
  `scrollTop`。`session export` 按 `scroll_mode` 还原：container → `ctx.scrollList(target,{to|by})`，
  into_view → `ctx.command("scroll", target)`（无 to）；旧轨迹（无 `scroll_mode`）导出与之前逐字节一致。
- **不变量**：run 面/命令步/`ctx.scrollList`/`scrollDocument` 的既有语义与产物**逐字节不变**
  （`_executeElement` 的 scroll 分支原样保留）；dry/replay 不受影响；A2 歧义透传不破（`actOnce`
  第 5 参 `onAmbiguous` 语义不变，歧义失败面仍 `target_ambiguous`+`ambiguity`）；不新增 stopCode、
  不扩 hint 六形状闭集。契约注记见 `amber schema ctx` 的 F56。

## [Unreleased] — A2 会话 act 歧义缺省不执行

- **【行为变更·会话 act 歧义】`amber session` 的 `act` 目标命中多个**不同**候选时，缺省不再执行**：
  返回结构化 `{ok:false, code:"target_ambiguous", executed:false, ambiguity}`（与 `amber run` 命令步
  `target_ambiguous` **同一个谓词**：`hintCandidates` 非空 && `decided === null` && `refs.length > 1`）。
  `ambiguity` 有界：候选 ≤5（`candidates_total`/`truncated`）、label/class/near ≤40、ref/tag ≤16、
  `suggested_hint` ≤80、`would_act_ref`；`source:"dom_fallback"`（A3 池外回退）不给 near/suggested_hint。
  事故形状：`div "搜索关闭"` | `button "关闭"` 上点 "关闭" 会命中搜索框清除按钮，整条搜索链路退出。
  恢复旧行为：会话级 `--on-ambiguous act`，或单行请求 `onAmbiguous:"act"`（桥参数 `on_ambiguous`）；
  该失败进 `--record` 轨迹的 `code` + `candidate_refs`（≤5）+ `candidates_total`。
  **不变量**：run 面/命令步/决策步行为与产物逐字节不变（dry/replay 不调 `actOnce`）；
  `ctx.scrollList` 内部点击与 run 原语不传该策略，行为不变；不新增 stopCode、不扩 hint 六形状闭集。

## [Unreleased] — run --headless 透传修复 + 插件 headless 配置

- **【缺陷修复·run --headless 透传】`amber run --headless` 此前被解析但从不转发给
  app-runner 子进程**（spawn args 只 push `--headful`）：机器配置层配了
  `runDefaults.headful=true` 时，用户给 `--headless` 也退不出有头（浏览器窗口照样弹）。
  修复：run.ts 的 app/goal 两模式透传 `--headless`；app-runner 与 start.ts 解析该旗标并按
  「CLI 旗标 > env > 配置文件」层叠压过 runDefaults.headful；`--headful` 与 `--headless`
  同给 = 互斥用法错误（exit 2）。**行为变更面**：此前 `--headless` 静默无效 → 现在生效
  （不传任何旗标的默认路径不变）。
- **【新增·桥接配置页 headless 开关】`amberflow-bridge` 插件配置页新增 headless 布尔项
  （volatile）：勾选后桥拉起的每个引擎子进程注入 `AMBERFLOW_HEADFUL=0`（无窗口），压过
  机器 rc 的 `runDefaults.headful=true`；不勾选 = 不注入（引擎配置层叠决定，逐字节现状）。
  工具调用显式给的 `--headful` 是 CLI 旗标层，仍最优先。需要插件重载后生效。
  （该布尔项在本版本线内随后由单一的 `headful` 开关取代——headless 是同一维度的反义面，
  不再单设，见下方「插件配置页 HEADFUL 开关」。）

## [Unreleased] — feat/opt-scale（task-21/1a 行为变更）

- **【行为变更·1a 滑杆假成功修复】`ctx.setRange` 越界请求不再静默钳制后报成功**：
  `{value}` 超出滑杆 [min,max] 时返回结构化失败 `value_out_of_range`（stopCode），零动作
  （不走任何交互策略），结果带 `requested`（请求原话）/`clamped_from`（被拒的钳制值）。
  旧行为：越界目标被钳进值域后按钳制值报 `ok:true + accurate:true`（违反「完成只认证据/
  不假装成功」红线——实测：请求 200、滑杆 [1,11]、返回 achieved 11 且 accurate:true）。
- **【行为变更·1a accurate 语义收紧】`accurate` 改为精确语义（achieved === requested）**：
  容差（缺省 max(0.5, step/2)，步长感知）只用于交互过程的收敛判定，不再用于 accurate 判定；
  「容差内但非请求值」如实报 `accurate:false` 并把 achieved 带出。keyboard 策略格点感知
  （从 Home 归位值 + k*step 格点起算、最近格点 Math.round、|gap|<step 不做 ±3 微调），
  收敛失败带 `probe`（value_unreadable | home_ignored | lattice_unreachable）。
  依赖容差语义的旧脚本请改按 `achieved`/`requested` 自行判定。
- **【新增·D-1 观测面】`result.env.browser`（binary_basename/headless/persistent_profile）、
  `result.observations[]`（read/extract/observe 的行样例+计数+hint 投影，只增）、observe
  trace 事件增 `elements_sample`（前 5 元素有界样例）、run warnings 注入 `[step N:id]` 前缀
  （flow 面执行器 stepNo 恒 1 的步号修正）。
- **【新增·D-2 产出守卫】`amber apps new` 骨架内置「产出行数 ≥N 否则 ctx.fail(output_underflow)」
  模板；docs 把数据类任务的产出下限写成硬要求。

## [2.0.0] - 未发布

2.0.0 是一次结构性重构：仓库从「决策任务流引擎 + 声明式应用 + 离线夹具/复刻站」收敛为
**冻结计划的浏览器自动化中间件**——单一执行循环、单一应用作者模型（`meta` + `flow(ctx)` 脚本）、
真实站点线上套件与可验证的执行证据。本版本尚未 npm 发布、未打 git tag；下列内容即当前工作树的
未发布摘要，发布形态见文末「发布形态（待定）」。

### 新增

- **A1 动作执行证据与 done 诚实性**：命令步在动作前对 done 做一次预评估（`done_preheld`，只记录、
  不改变执行顺序）；`StepResult` / trace / `RunReport` / report.md 新增「动作执行证据」——
  `executed`、`executed_actions`（op/ref/how/changed）、`skipped_actions`（每条"为什么没动作"的
  结构化原因）、`warnings`（如 `suspected_async`）；零执行步骤以 `executed=false` + 跳过证据 + 停因
  摘要 `executed 0 action(s)` 诚实呈现（不静默 done）；click 快照未变但 done 成立 = `suspected_async`
  （async 效果，不 forbid、不写 inert 记忆）；`ctx.step` 新增 `forceAct` 声明（done 预成立也先执行
  命令闭集）；新增示例 `examples/apps/05-done-evidence` 与开发脚本 `scripts/done-evidence-check.mjs`。
- **A5 决策面通道引导**：`amber doctor` 缺省发一次最小 ask 探针（`ask_probe` 进 JSON，旧字段不变、
  失败不改退出码，可 `--no-ask-probe` 关闭）；`decision-provider` 的 ask 失败/`no_model_runtime`
  统一附恢复指引（桥 `amberflow_run` 用部署配置 vs CLI `AMBERFLOW_DECISION_*` 用户配置，403 处理
  见 `docs/DECISION_SERVICE_CONFIG.md` 两条通道矩阵）；`run` 的 stderr 与 next[] 同步；不打印密钥、
  不自动切换。
- **A3 列表展开与范围控件三原语**：`ctx.scrollList(target, {to|by})`（滚目标/最近可滚动祖先，纯 DOM
  scrollTop）、`ctx.expand(target, {count, maxClicks, stableRounds, settleMs, timeoutMs})`（点"加载更多"
  到行数稳定，内部点击不占 flow 预算）、`ctx.setRange(target, {value|percent})`（fill→keyboard→pointer
  三策略，0×0 手柄用最近有尺寸祖先 bbox）。三者各计 1 flow step，失败是结构化结果
  （`not_scrollable` / `expand_not_stable` / `slider_not_settable`），dry 有确定性桩且参数校验真做，
  trace 记 `args` 供重放逐字比对；`ctx.command("scroll", sel, {to})` 扩展为滚容器到方向（旧调用不变）。
- 应用唯一格式：`$AMBERFLOW_HOME/apps/<id>/app.mjs` 的 `meta` + `flow(ctx)` 脚本；配套
  `amber apps new/list/show/check/explain/path/remove` 命令面，`apps check` / `apps explain`
  只做加载与 dry 调用序列校验（不开浏览器、不调模型）。
- `amber inspect`：只读观察真实页面元素与候选 hint；`amber record`：演示一次并归纳完成信号，
  零模型调用回放不通过就不落盘。
- 真实站点测试声明层 `online/`（`sites/*.json` 与 `cases/{smoke,core,deep,probe}/*.json`）：
  退出码 0/1/2/3 语义、`--require-all`、证据写 `$AMBERFLOW_HOME/online-runs/` 且不入库。
- `amber schema ctx` 自描述语义契约与 `dist/schema/ctx.json` 快照（`--check` 做漂移门）。
- 统一执行循环 `BrowserMiddleware.run`：完成信号语言（9 算子 + 组合器 + `manual`）、
  元素池以 AX 可访问性树为主源、结构化停因与 trace / replay（`script_sha256`）锚点。
- 人工步（`ctx.manual`）与可配置运行节奏（`meta.pace`）；非 TTY 不假装有人。
- 决策源统一：线上三件套 `AMBERFLOW_DECISION_BASE_URL` / `_MODEL` / `_API_KEY`；无地址用本地
  `laya-onnx`（`AMBERFLOW_DECISION_MODEL=english|multilingual` 选 checkpoint）。
- DSH 桥（`integrations/dsh-bridge/`，9 个 model-facing 工具）与仓库根 bundle 安装门
  （`dsh-bundle.yml`）：`dsh plugin add github:Johnly1986/AmberFlow` 即可接入。
- `npm run check` PR 门禁：`typecheck` + 配置示例一致性 + schema 快照漂移 + 提示词/信号一致性 +
  线上用例声明校验。

### 变更

- **行为变更（A2）**：元素池缺省排序从「main 内容优先 + DOM 序截断」改为**分桶配额 + 当前视口感知**
  （chrome/viewport/contentNear/mainOffscreen/other；默认 40 / 宽扫 120，配额常量单一出处
  `extraction.ts`）；`hint` 匹配改用完整 label（`full_label` ≤200）并支持 `aria-label` 别名与裸词
  词边界/前缀；命令目标按可行动优先尝试前 4 个候选（失败记 `skipped_actions` 并换下一个，全败不静默 done）。
  逐应用回退：`meta.policy.candidate_priority: "main-first"`（缺省 `bucketed`）；窗口外元素可用
  `amber inspect --json` 的 `window` 事实查看，引擎不自动滚动。
- 线上套件 npm 入口由 `online` 更名为 `test`（`npm run test -- --tier smoke|core|deep|probe`）。
- 配置收敛为单一 schema 声明（`configs/amberflowrc.example.json` 由 schema 生成并做一致性检查）；
  移除 provider 配置键与命令行模型旗标，`--provider` 只用于本次实验/消融。
- 应用作者模型收敛为 flow 脚本：仓库不再是「决策任务流引擎」，`flow.json` / `pack.json`
  声明式应用与语义模板被 `app.mjs` 取代。
- **统一决策函数入口**（BACKLOG #1；前提：规划归 Agent）：执行侧 provider 缝成为引擎唯一
  决策入口。`plan-cli run` 接入与 start/apps/online 相同的决策源解析（三件套 / 本地 laya /
  `--provider` 本次覆盖）；低置信 escalation 梯级改走 `DecisionProvider.askChoice` 闭集窄问
  （`plan-cli run --escalate` / `amber run --plan --escalate` / `amber plan run --escalate`，
  opt-in 缺省关），provider 不支持 `askChoice` 时梯级缺席并如实打印；`askChoice` 计入
  咨询计数（`countedProvider`）。
- **规划归 Agent**：移除引擎内 LLM 规划/重规划面——`plan-cli new --llm` 与
  `plan-cli run --replan`（及 `amber plan new --llm`、`--replan` 转发）不再存在，被挡子目标
  照旧以 `blocked + obstacle` 结构化结果返回，由 Agent 决定下一步。
- `PLANNER_MODEL` 配置键移除（旧 rc 残留会在加载期以未知键拒绝，删掉该键即可）；
  `OPENAI_BASE_URL` / `OPENAI_API_KEY` 只剩事后审计（`LLMAuditor`）一个消费者，
  配置组更名为「外层 LLM（事后审计）」。

### 移除

- `pack.json`、声明式数据脚本、语义模板等旧应用格式。
- 离线夹具、复刻测试页、内置应用与真实站点冻结证据；`vitest` 单测与 parity 工具链。
- 历史报告 / 基准 / 应用清单等过时文档（当前事实以 `AGENTS.md`、`ARCHITECTURE.md`、`docs/` 为准）。
- `LLMPlanner`（System-2 计划起草）与裸读 `OPENAI_*` 的 `llmEscalator`（含 `snapshotText`）：
  规划归 Agent，escalation 由 `src/model/provider-escalator.ts` 经 provider 缝承接。

### 修复

- **A4 引用盖章唯一化**：提取前清旧章 + 批次 nonce（`data-dshref` 章值 `af<批>-e<位>`，
  `data-hintref` 用 `af<批>-h<n>`），消除"元素换位后旧 ref 章残留 → 同一选择器命中多个节点"的
  点错隐患；`_locatorFor` 对引用章加唯一性闸门（恰好 1 个才用；>1 记 `ref_collision` 诊断并回退
  id/name/scan，最终 null 交动作层 `stale_ref`）；run 收尾 best-effort 清理两类章属性；
  开发脚本 `scripts/ref-stamp-collision.mjs`。
- **纯验证步停因如实化**（2026-11-01 产品评审 P1）：无 target_hint、无命令空间的子目标在
  规则档被挡时，不再误报「no model runtime: needs a model pick」——当场评估 done 信号并
  区分两种实况：「信号已成立但本步未声明动作 → 声明 `commands:[{"op":"skip"}]` 或点名
  target_hint」/「信号不成立 → 点名、声明命令或提供决策模型」。
- **trace 方法标签跟决策源走**（2026-11-01 二轮评审④）：`method` 不再硬编码 `laya`——
  provider 自报真名（线上档 `decision-service`、消融基线真名；本地 laya 档归一化仍为
  `laya`，逐字节不变），后缀 `<name>:reobserve` / `<name>:adjudicated` 动态拼接；
  trace step 增 `decision_kind`（rule/model/escalate）粗分类字段。`decisions.line` 汇总
  `laya 1` → `model 1 (decision-service, conf …)`；ladder JSON 键 `laya` → `model`
  （2.0.0 未发布窗口一次改净；旧 trace 回退按旧串聚合，重放不受影响）。
- `plan check --probe`（P1b，opt-in 在线探针）：离线规则通过后，把每个 start_url 真实到达
  一遍（只读、不动作）——点名步核对 target_hint 能否在实况元素池解析，零动作验证步核对
  done 信号此刻是否成立；发现机制性必挡项 exit 1（`amber plan check --probe` 同语义）。
- inspect 输出随附说明（P3）：hint_candidates 可直接用作 hint（**非 CSS** 语法），href 等
  字段是元素池投影——文本输出加一行标注，`--json` 增 `hint_syntax` 字段。
- 示例 01-basic-step 信号锚点更新（P4）：h1 锚点在 example.com 实况漂移中已消失，
  改锚 `<title>` 文本并加「锚点纪律」注释（抄示例前先 inspect 核对实况）。
- 双载体定位（P2）：文档与 `plan-cli` USAGE 明确——**应用唯一编写格式是 app.mjs**（不接受
  JSON 应用描述），plan JSON 是逐步调试/续跑的轻载体；`plan new` 输出附定位提示。

### 安全

- 完成只认信号，模型 done 票仅 advisory；值只来自计划/观察，缺值返回 `needs_value`。
- 凭据只允许 `{{env:NAME|default}}` 占位符；明文凭据不得进入用例/计划/产物/仓库，本机配置
  `configs/amberflowrc.json` 已被 gitignore。
- 不绕过反爬（不伪造指纹、不轮换代理、不规避风控/速率限制，风控拦截按 `blocked` 停止）；
  验证环节（登录/2FA/验证码等）可在用户授权下代过。

### M0 基础设施（2026-10-31，未发布）

- CI `checks.yml`：check job 在 `npm run check` 之前生成 `dist/schema/ctx.json` 快照（该文件是
  构建产物、已被 gitignore 排除），干净 checkout 不再因 `SCHEMA_SNAPSHOT_MISSING` 变红。
- CI `checks.yml`：online job 改用真实入口 `npm run test -- --tier smoke --require-all`
  （原 `npm run online` 在 v2 更名后已不存在）；保留定时/手动触发与证据上传语义。
- CI `bridge.yml`：删除调用已不存在的 `tests/*.spec.ts` + `vitest` 的 job，改为干净 checkout 可
  离线复现的校验——桥 TypeScript 源解析（`node --experimental-strip-types --check`）+ 生成的仓库根
  client bundle 与 `client.js` 同步、根 `exports` 导出门禁。
- npm 可发布元数据：移除 `private:true`；补 `license: Apache-2.0`、`repository` / `homepage` /
  `bugs`、`files` 白名单（含 `bin/`、`src/`、`tools/`、`configs/`、`scripts/`、`docs/`、`online/`
  与 DSH 桥运行必需文件；排除 `models/`、构建产物与 `node_modules`）；修复 `description` 乱码为
  正确 UTF-8；保留 `engines`（Node ≥ 22.6）。未改动 `exports` 结构。
- README 定位统一为「冻结计划的浏览器自动化中间件 / 可验证的浏览器执行内核」，并补充
  `npx amber` 在 checkout 内会挂住、就地改用 `node --experimental-strip-types src/cli/main.ts` 的说明。
- 新增本 CHANGELOG；不创建 git tag（发布形态与 tag 由后续决定）。

### M0 凭据/产物安全（2026-10-31，未发布）

- `meta.secretSlots`：显式声明敏感槽位（加载期校验必须是已声明槽位）；`result`/`report`/`stdout`/dry JSON 中
  敏感槽位一律掩码为 `***`。名称启发（password/token/api_key/...）作为兜底，只对已声明槽位生效。
- 深扫兜底 `scrubSecrets`：敏感值被流程写进 `logs`/`step_traces`/trace 等其它字段时也会被抹掉；
  `--emit-trace` 写盘前同样脱敏。
- `--slot-file FILE`：从 JSON 对象读槽位，避免敏感值进 argv/进程列表；与 `--slot` 同名时 `--slot` 优先；
  文件对 group/other 可读会告警，建议 `chmod 600`。`--slot` 敏感键会告警。
- `tools/secret-scan.ts`：一次性 canary 扫 `result.json`/`report.md`/dry JSON/scrub 后的 result/trace，
  断言零命中；接入 `npm run check`（`npm run secret-scan`）。
- 本机配置写入后 chmod `0600`（Windows 无 POSIX 模式时忽略失败）；新增 `SECURITY.md` 写凭据模型、
  证据脱敏、信任边界、反爬/验证边界与已知缺口。

### 安全修复（2026-10-31，未发布）

- **修复 flow 应用浏览器腿的 confirmFn 分支反接**：M0 翻转默认时把安全分支写进了
  `runScriptApp` 的错误侧——flow 应用此前默认**放行**破坏性动作，`--confirm-unsafe`
  反而拒绝。现已与 `runApp`/文档语义一致（默认按干跑证据拒绝破坏性动作）。
  e2e 实测（受控本地页面 + `effect: { irreversible: true }` 声明）：默认
  `RISKY → risk-declined` 拒绝（exit 1）；`--confirm-unsafe` 放行且 done 成立（exit 0）。
- `amber run` 补转发 `--slot-file` / `--confirm-unsafe`（此前 help 列出但 CLI 层静默忽略）；
  `amber run --dry-run --json` 的 envelope 掩码敏感槽位（第三个明文出口封堵）。

### 提示词系统补全（2026-10-31，未发布）

- 层 3 覆盖闭环：`STOPCODE_MEANING` 补 `max_steps` / `noul_unverified` / `no_progress` /
  `space_empty` / `nominated_family_empty|mismatch`；prompt-hit 改**双向**断言
  （STOP_NEXT ⊆ schema 且 schema ⊆ STOP_NEXT ∪ EXEMPT），并新增 executor `StopCode`
  union ↔ 契约/内部码边界（`EXECUTOR_ONLY_STOPCODES`，逐条理由）闭环——覆盖率不再只是
  对手写表的自我证明。
- 豁免收紧：`needs_human`、`frame_not_allowed`、`popup_not_allowed`、`manual_signal_not_held`、
  `action_unsupported`、`target_not_found`、`target_ambiguous`、`hint_matched_no_target`、
  `step_names_no_target` 晋升为可执行 next（STOP_NEXT 28 条 / EXEMPT 3 条）；
  **停手规则改为失败即输出**（stdout/report.md/report.html），不再依赖 next 是否存在。
- 层 1 真正进桥：`OVERVIEW_TEXT` 接进 `amberflow_status` 工具描述头部（prompt-hit 断言接线）；
  概述措辞修正为「模型只做选择/风险/完成票（完成票仅 advisory）」。
- 层 2 补全：`amber help --json`（无命令名）输出结构化命令清单；registry `when` 改由
  help-map 单源投影；`run` 帮助补 `--slot-file` / `--confirm-unsafe` 并修正 `--confirm-safe`
  语义描述；首页「下一步」改由 help-map `HOME_NEXT` 单源渲染。
- `amber schema ctx --check --topic <节>` 修复：快照按同 topic 切片比较（此前切片 vs
  全量必然 drift，为既有缺陷，本版修复）。
- 停手规则进 `docs/APP_SCRIPT_AUTHORING.md` 逐字块（prompt-hit doc 组断言）。

### M0 可用性（2026-10-31，未发布）

- **默认安全**：应用批量运行的 `confirmFn` 缺省从「一律放行」翻转为按干跑证据拒绝破坏性浏览器动作；
  `--confirm-unsafe` 或 `AMBERFLOW_CONFIRM_SAFE=0` 显式恢复旧行为。配置 schema 的默认值同步改为 `1`，
  示例配置重新生成。
- **HTML 证据报告 v0**：`amber run` 在 `-result.json` / `-report.md` 之外写 `-report.html`（结论、脱敏槽位、
  步骤/不变量/证据锚点；全部值经 HTML 转义），并打印落盘路径。
- `npm run check` 增加 `secret-scan`（凭据/敏感槽位产物零命中门）。
- 离线示例：`examples/apps/` 4 个零网络/零模型样板 + `tools/examples-check.ts`；`npm run examples-check`
  接入 `npm run check`，`examples/` 随 npm 包分发。

### 执行取证与走查批次（2026-11-02，未发布）

- **done 信号多动作闭集**（A1）：一步内多命令闭集全部执行完才判 done——不在中间态误判完成；
  dry-run 增两条信号 lint（裸 `not` / `any` 含 `not(exists)`，stderr 非致命、不改退出码）；
  `step_traces.afters` 逐步记录动作后的内容签名，事后可核对每步实动了什么。
- **解析失败判别**（A2）：`target_not_found` / `low_confidence` 的 reason 附池快照答案——
  区分「目标不在页面」与「候选在而闸门拒/闭集约束」，失败看 reason 即可判别，不必再开浏览器取证。
- **决策源对齐**（A3）：ask 失败透传 HTTP 事实（machine code / cause 链 / 2xx 非 JSON 响亮
  报错）；`failed_asks` 独立计数；`no_model_runtime` 附降级原因；flow 路径 `provider_degraded`
  管道修复；`amber doctor --ask-probe` 用当前三件套真实发一次最小 ask（探针只诊断，不改退出码）。
- **DSH 桥超时**（A4）：`amberflow_run` 增 `timeout_sec`（1..7200 秒）硬墙钟上限——长流程
  调大预算而不是被默认上限杀掉；被杀落盘 `run-killed.json`，部分证据不再丢失。
- **高效规划六步法 v2.1**（A5）：五步法 → 六步法，走查先行——先用引擎把流程按真实步序走通，
  再写正式应用；planning-playbook 真源同步骨架注释、inspect next、run 失败 next 与文档逐字块。
- **`amber run --walk` 单会话走查模式**（A6，调试旗标，默认关）：`ctx.step` 同页重锚
  （origin+path 同）不重导航、保留 SPA 状态，跨页显式 url 照常导航；与 `--dry-run` 互斥；
  结果自报 `walk:true`——适合复现「只在演进状态出现」的问题；正式跑不用 walk，每步重导航
  （起点 URL 确定性）才是 done 判定确定性来源。
- **B 组修正**（B1/B3/B2/B5/B6）：`action_unsupported(fill)` 附修正指引；PARTIAL 报告的
  不变量措辞「不成立」→「未验收」（验收未发生态）；`--slot k=v` 逗号拆分行为说明；结果 JSON /
  report 增 env 环境与会话字段（run_id / 时间戳 / final_url / viewport / UA，缺省等价）；
  extract 字段投影与池文本分歧文档化（设计如此非 bug，附行号证据）。

### 发布形态（M0 决定）

- **M0 决定：首次 npm 发布采用单包 `amberflow`**——`bin/` + 引擎 `src/`；DSH 集成继续走
  git-install（`dsh plugin add github:Johnly1986/AmberFlow`），不单独发 npm 包。
- 根 `exports` 暂保持指向 DSH 桥（兼容 git-install）；**首次发布不承诺** `import 'amberflow'`
  的引擎 API（消费面以 CLI 为准）。
- 拆分（`amberflow` 引擎包 + `@deepseek-ai/dsh-amberflow-bridge` 集成包）列为 v3 M1+ 工作项；
  拆分前需解决「bin 依赖 `--experimental-strip-types` 运行 `.ts`」与「`exports` 指向 `.ts`」两处
  对普通消费者不友好的形态。
- `npm run check` 在干净 checkout 上会先由 `precheck` 生成缺失的 `dist/schema/ctx.json`（构建产物）；
  快照已存在时 `schema:check` 仍做严格漂移比较。

## [1.0.0] - 2026-10-03

首个 TypeScript 单一技术栈可用版本（当时名 LayaWebUse）：冻结计划 + 本地决策模型执行，
验证依赖离线夹具 / 复刻测试页（`testpages/`、`tests/`、`bench/`）。已被 2.0.0 取代。

[2.0.0]: https://github.com/Johnly1986/AmberFlow/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Johnly1986/AmberFlow/releases/tag/v1.0.0
