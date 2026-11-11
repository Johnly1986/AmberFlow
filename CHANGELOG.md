# Changelog

AmberFlow（冻结计划的浏览器自动化中间件）的显著变更。本文件格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

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
