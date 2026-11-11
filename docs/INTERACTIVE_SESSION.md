# 交互式试错会话（`amber session`）

> 定位：**authoring（规划/调试）面**。一次持续会话里「操作一步 → 立即回读 → 再决定下一步」，
> 元素解析 / 动作执行 / 信号判定与正式 `run` **同源**（调用同一批函数，不是照抄语义）。
> 正式执行仍然是「冻结计划 + 运行时消歧」：session 不产生 `done`、不写 `result.json`、
> 不替代 `run` 的通过/失败结论。设计稿见 `iterations/interactive-session/design.md`。

## 什么时候用

- 写 `app.mjs` 之前，想先弄清真实页面上「点这个会不会跳、跳完长什么样、信号写什么能成立」；
- 应用里某一步在 `run` 里失败，要单点复现那一步的解析/动作/回读，而不是整条重跑；
- 需要跨多步保留页面状态（展开的菜单、滚动位置、输入值）做连续试探。

不需要它的时候：只想看页面元素 → `amber inspect`；只想核对已声明的 hint 能否命中 →
`amber apps rehearsal` / `amber plan check --probe`；已经能跑 → `amber run`。

## 用法

```bash
# 起会话：打开入口页，从文件逐行读请求（Windows/CI 推荐 --input）
amber session --url https://books.toscrape.com/ --input requests.jsonl --record session-actions.jsonl

# 交互终端：stdin 每行一条 JSON 请求
amber session --url https://books.toscrape.com/ --headful

# 需要轨迹里保留 fill/select 的明文值（默认只记 hash；会进仓库/导出物，慎用）
amber session --url https://books.toscrape.com/ --input requests.jsonl \
  --record session-actions.jsonl --record-values

# 歧义目标恢复旧行为（直接执行可行动优先的第一个候选；缺省 fail = 零动作 + 候选证据）
amber session --url https://books.toscrape.com/ --on-ambiguous act
```

- **stdout 只有 JSONL 协议行**（一行一个响应对象）；人话日志走 stderr（`[session] …`）。
- 退出码：`0` 干净关闭（`close` 或 stdin EOF）；`2` 用法/启动错误；`3` idle 超时（被挡住，不是失败）；
  `1` 不可恢复（浏览器进程死亡等）。
- 证据目录：`--out`，缺省 `$AMBERFLOW_HOME/session/<runId>`（用户作用域，不写仓库工作区）。

## 请求 / 响应

每条请求是一个 JSON 对象，`type` 从闭集里选；每条请求恰好一个响应，恒有 `{id, type, ok}`
（`id` 原样回显，缺省 `null`）。失败响应还带 `code` + `reason`，**不终止会话**。

| type | 请求（额外字段） | 成功响应（额外字段） | 失败 code |
|---|---|---|---|
| `open` | `url`, `timeoutMs?` | `url, title?, hosts` | `host_not_allowed` / `unreachable` / `config_error` |
| `observe` | `max?`, `selector?`, `includeHidden?`, `includeFrames?` | `ObserveResult`（`url,title?,frames?,counts,elements`；每元素带 `frame` 下标与 `hint_candidates`；多 frame 时另有 `frame_counts`） | `bad_selector` |
| `act` | `op`(`click/check/fill/select/hover/scroll`), `target`(hint), `value?`(fill/select 必填), `to?/by?`(scroll；给 = 容器滚动，不给 = 滚入视口), `onAmbiguous?`(`fail`\|`act`，缺省 `fail`), `screenshot?`(缺省 `false`；失败时落 `act-<n>-failure.png`), `observeAfter?` | `op,target,executed,ref,how,changed,url,after?`；scroll 另有实测 `moved`/`delta?`/`scroll?`（`changed === moved`）；歧义时另有 `ambiguous`/`matched_others?`/`hint_kind?`/`hint_tier?`/`hint_suspicious?`；非 timeout 异常且 URL 已变时另有 `probe_navigated:true`；**歧义停**时 `ok:false, code:"target_ambiguous", executed:false, ambiguity`；**动作失败**时 `ok:false, code, reason` 并（被遮挡/超时时）带 `actionability`、`screenshot_file?`、落空（`target_not_found`）时带 `diagnostics` | `target_ambiguous` / `target_not_found` / `stale_ref` / `needs_value` / `action_unsupported` / `action_failed` / `not_scrollable` / `not-actionable-or-covered` / `action-timeout` / `config_error` |
| `read` | `what`(`text/value/count/attr`), `selector`, `attr?` | `what,selector,value`（读不到 = `null`） | `config_error` |
| `extract` | `rows`, `fields`（`"."` = 行文本；`"@attr"` = 行属性；或子 CSS）, `maxItems?`, `offset?`（续页起点，0-based 整数 0..10000） | `rows,count,capped`；**`capped` 或 `offset>0` 时**另有 `offset,total,has_more`——`count` 是**本页返回行数**不是总数，`total` 才是匹配总数，`has_more = offset+count < total` | `config_error` |
| `waitFor` | `signal`, `timeoutMs?`(缺省 15000), `pollMs?`(200) | `held,timeout_ms,elapsed_ms` | `config_error`（坏信号形状） |
| `signal` | `signal` | `held,elapsed_ms` | `config_error` |
| `snapshot` | `screenshot?`(缺省 true), `poolMax?`(120) | `snapshot_file,pool_file,screenshot_file?,counts` | `io_error` |
| `mark` | `note` | `note`（只进 `--record` 轨迹，不动页面） | `config_error` |
| `close` | — | `closed,requests,actions,snapshots,duration_ms,urls,evidence_dir` | — |

会话级异常会补发一行 `{"type":"session_end","unsolicited":true,"ok":false,"code":…}`（`idle_timeout` /
`browser_dead` / `interrupted`），它不是任何请求的响应。

### 分页：extract 有 offset，observe 没有

- `extract` 的 `count` 是**本页返回行数**，不是匹配总数；`maxItems` 是每页上限（1..500，缺省 500）。
  分页用 `offset`：从 0 开始，每次把 `offset` 加上本页 `count` 续页；`has_more` 为 false 即到底。
  `offset` 只认**顶层字段**（写进 inline spec 不是分页起点），必须是 0..10000 的整数——负数、小数、
  字符串、越界都是 `config_error`（引擎不 clamp，悄悄改起点会让"续页不重不漏"变成假话）。
- `offset=0` 且本页没被 cap 挡住时，响应与分页之前逐字节一致（不多出 `offset/total/has_more`）。
- `total` 是**当前 DOM 匹配行总数**（这一刻的事实）；懒加载/无限滚动页面在滚动后 `total` 会变，
  续页之间页面若发生插入/删除，offset 分页可能重/漏——需要"翻到底"的穷举请用 `ctx.collect`
  （应用脚本面）或接受逐页快照的语义。
- `observe` **不提供 offset**：元素序随水合/动画变化，没有稳定锚（用 offset 续页会悄悄错位）。
  行数太多时用 `selector` 收窄、`max` 放宽（硬上限 200），要全量元素快照就用 `snapshot`
  （`pool-<n>.json`）。

### 示例（books.toscrape.com 全链）

```jsonl
{"id":1,"type":"open","url":"https://books.toscrape.com/"}
{"id":2,"type":"observe","max":60}
{"id":3,"type":"act","op":"click","target":"Travel"}
{"id":4,"type":"read","what":"text","selector":"h1"}
{"id":5,"type":"extract","rows":".product_pod","fields":{"title":"h3 a","price":".price_color"},"maxItems":5}
{"id":6,"type":"signal","signal":{"css_text_contains":["h1","Travel"]}}
{"id":7,"type":"snapshot","screenshot":true}
{"id":8,"type":"close"}
```

`target` 用的是**同一套 hint 语法**（`#id`、`tag[attr=value]`、`tag[attr~substr]`、`tag~token`、
角色词、裸词——6 形状闭集）。第一次观察最容易照抄的写法：取 `observe` 返回元素的
`hint_candidates`，而不是自己发明 CSS（容器/后代 CSS 解析得出但永不命中）。

### act 的歧义回显（task-34）

试错时最常问的是"为什么点错/是不是有多个候选"。`act` 响应在**解析发生在裸词/属性子串**这两类
弱档形状上时，额外回显（与 `run` 的 `matched_others` 警告**同一份**旁路收集，只读诊断、
不改解析结果与选择语义）：

| 字段 | 含义 |
|---|---|
| `ambiguous: boolean` | 这一条 hint 命中**多个**候选（`true` = 选择是在多个里挑的，动手前建议再 observe 一下） |
| `matched_others?: [{ref,tag,class,label}]` | 除实际选中者外的撞词候选（≤3；label ≤40 字符） |
| `hint_kind?: "bare" \| "attrSubstr"` / `hint_tier?: number` / `hint_suspicious?: true` | 只在**弱档**胜出（词前缀/词包含、loose 子串）时出现——这形状最容易命中容器/同缀元素 |

- 成功与失败（`target_not_found`）都回显：失败但 `ambiguous:true` 说明"目标存在多个、引擎不猜"。
- 精确形状（`#id`/`tag[attr=value]`/角色词/`tag~token`）不产生这些字段（没有旁路诊断 = 无需回显）。
- 池外回退（0×0 手柄这类）时 `ref` 可能是合成 ref（`pN`），`matched_others[].ref` 同源，如实不映射。
- 例：三个 `Edit` 链接的页面上 `act click "Edit"` → `{"ok":true,"ref":"e0","ambiguous":true,
  "matched_others":[{"ref":"e1",…},{"ref":"e2",…}]}`；想精确点第二个就先 `observe` 抄 `a[href=#b1]`。
- A2 起：**真正的多候选歧义默认先停**（见下节）；本节字段是与 `run` 同一份的弱档旁路 advisory，
  只在动作实际发生或非歧义失败时有意义，**不作判定**。

### act 的歧义停因（A2，缺省零动作）

task-34 的回显是弱档旁路诊断（照旧执行 `refs[0]`）；A2 起，同一个形状默认**不再动手**。判据与
`amber run` 命令步的 `target_ambiguous` **逐条同源**（`rules.hintCandidates` 非空 &&
`decided === null` && `refs.length > 1`）——事故现场（`div "搜索关闭"` | `button "关闭"` 上点
"关闭" 命中搜索框清除按钮）从此是结构化失败，而不是一次误点：

```json
{"ok":false,"code":"target_ambiguous","executed":false,"reason":"target \"关闭\" matches several candidates in a pool of 42 element(s) (2 distinct candidate(s)) — …","ambiguity":{…}}
```

| `ambiguity` 字段 | 含义 |
|---|---|
| `target` | 原 hint（≤120 字符） |
| `source` | `pool`（可见准入池）/ `dom_fallback`（A3 池外回退的合成候选集） |
| `tier` | `hintCandidates` 胜出档（与命令步同一判据） |
| `would_act_ref` | 旧行为会执行的那个 ref（可行动优先排序后的 `refs[0]`）——事实，不是建议 |
| `candidates_total` / `truncated` | 歧义档总候选数 / 是否超过列出的 5 行 |
| `candidates[]` | ≤5 行：`ref≤16, tag≤16, role?≤16, label≤40, class?≤40, near?≤40, frame, same_label, suggested_hint?≤80` |

- `same_label` = 该归一 label（`full_label` 优先、折叠空白/大小写）在**本次池内**出现 >1 次 ⇒ label
  本身不足以区分（收窄要换 `#id` / `[data-test=…]` / 属性或 `near`）。
- `near` 只**复制**池里既有 `elem.near`（不重算）；`suggested_hint` 来自既有 `suggestHints`（内部同一个
  `hintMatch` 自证「恰好唯一命中」，为空就省略该键）——可直接照抄进下一条 `target`。
- `source:"dom_fallback"` 只给合成候选身份（`pN`）：合成池自证 ≠ 真池，所以**不提供** `near` /
  `suggested_hint`。
- **不是猜测**：证据只陈述"有几个候选、各自是谁、旧行为会点谁"；选哪个由人/上游决定。收窄 hint 或显式
  用 `act` 重放，都是显式选择，桥不据此自动挑。
- 恢复旧行为：会话级 `--on-ambiguous act`，或单行请求 `{"type":"act","op":"click","target":"关闭","onAmbiguous":"act"}`
  （桥工具参数 `on_ambiguous`）；`fail`/缺省 = 本节的停因。
- `--record` 轨迹对这条失败记 `code` + `candidate_refs`（≤5）+ `candidates_total`（只记事实）。
- `run` 面**不变**：命令步在**没有可执行候选**时才用 `target_ambiguous` 停因（候选进 `skipped_actions`），
  本次行为与产物逐字节不变；dry/replay 不调 `actOnce`，没有新影响；`ctx.scrollList` 内部点击与 run
  原语不传该策略，行为不变。

### act 的失败现场与失败截图（B1）

会话 `act` 的 `click`/`check` 不再"先探针再点击"：run 面同一个 `occludedReason` 的探针**就是那次
点击**（快路径 800ms；未遮挡的慢元素再给一次 5s 重试，预算 `(800, 5000)`），所以不存在"预检通过
后又点一次"的双点窗口：

| 失败 code | 何时 | 证据 |
|---|---|---|
| `not-actionable-or-covered` | 中心点被别的元素盖住（cookie 横幅/modal 背板/透明 overlay），约 0.8s 即返回 | `actionability:{reason,bbox,blocker,requery}`；`reason` 原文形如 `not-actionable-or-covered:<tag#id.class>` |
| `action-timeout` | 探针超时、中心点**无覆盖者**，且 5s 重试仍不成功（不是"只是慢"） | 同一份 `actionability`（证明无覆盖者、重查时节点仍在/已脱离） |
| `action_failed` | 探针抛非 timeout 异常（click 可能已派发） | 无 `actionability`；`reason` 是 Playwright 首行 |

- `actionability` 原样复用引擎的 `ActionabilityDetail`：`reason`、`bbox`（目标当时的盒子，读不到 =
  `null`）、`blocker`（中心点命中的最顶层元素摘要，如 `div#cookie-banner`；无覆盖者 = `null`）、
  `requery`（重查时节点 `present`/`detached`/`unknown`）。会话层只回显，不重算。
- 非 timeout 异常**不补点**：若 `urlOf(page)` 已与动作前不同，说明点击已触发导航 → 响应
  `how:"clicked"` 并记 `probe_navigated:true`；否则结构化 `action_failed`，不二次点击。
- `screenshot:true`（缺省 `false`）：**只在失败时**写 `<evidence_dir>/act-<n>-failure.png`
  （n = 本会话动作序号，从 1 起），响应只回 `screenshot_file` 路径，不内联图片、成功不写。
- 成功响应键集不变（唯一新增是上述异常路径的 `probe_navigated:true`）。
- `not-actionable-or-covered` / `action-timeout` 是**既有 skip_reason 词面**，不是新 stopCode；
  run 面（探针后仍走 `_clickOnly`）、命令步、`ctx.expand`/`ctx.scrollList` 内部点击不传探针参数，
  行为与产物逐字节不变。

### act 找不到目标时的判别证据（A4）

`target_not_found` 过去只有一句 `target "…" matched nothing in a pool of N element(s)`，分不清
「目标不在页面」和「用词/形状不对、或元素不可见」。现在这类失败多带两块**只读事实**（成功路径
与非落空失败**键集逐字节不变**，不新增 stopCode）：

- `reason` 末尾追加一行 `判别: …`（仿 run 命令步的 `cmdDiscrimination`：纯内存判别，主 reason
  前缀与停因码不变）。
- `diagnostics`（有界；只陈述池/扫描面已有的行）：

| 字段 | 含义 |
|---|---|
| `target` / `pool_size` | 原 hint / 本次准入池元素数 |
| `hint_shape` / `hint_len` | `parseHint` 的形状（`id`/`attrSubstr`/`nearToken`/`attrEq`/`tag`/`bare`）/ hint 字符数 |
| `candidates[]` | 池内**同档**候选（`hintCandidates` 的 quiet 读法，≤5；`ref,tag,label≤40`） |
| `near[]` | 池内**词面近似**候选（token 对 `label`/`full_label`/`data_test`/`id`/`name`/`href` 做前缀/包含，≤5；另有 `why` 如 `label 前缀`） |
| `rejected[]` | 池外回退扫描到、但被可见性过滤的近似行（≤3；`why:"not visible"`，措辞与 `observe` 的 `why_not_admitted` 同源） |

- **不污染歧义回显**：`candidates` 用 `hintCandidates(..., { diag:false })` 的 quiet 读法——那次
  查询**不写** B1 弱档旁路模块态，task-34 的 `ambiguous`/`matched_others` 回显仍是本条 target
  真实解析的结果。
- **`near` 不猜**：token 仍由唯一解析器 `parseHint` 给出（不扩 hint 语法、不做模糊编辑距离、
  不按相似度排序，池序即序；单字符词面直接不给）；纯内存，零页面往返。
- **`rejected` 只来自既有回退扫描**：A3 池外回退本来就扫含隐藏元素的准入面；这里只对词面近似的
  ≤5 行做**一次**可见性判定（`display:none` / `visibility:hidden` / 零尺寸盒子）→ 不可见者进
  `rejected`（≤3）。不扫面外元素、不新造 `why_not_admitted` 分支。
- `run` 面/命令步/`ctx.expand`/`ctx.scrollList` 内部点击**不传** `diagnostics` 开关，返回值与
  reason 逐字节不变；只有会话 `act` 失败带这两块证据。

### act 的滚动语义（B2，`changed` 只认实测）

`act scroll` 有**两种**语义，由请求带不带 `to`/`by` 决定（没有第三种）：

| 请求 | 语义 | 执行面 | 证据 |
|---|---|---|---|
| `target` + `to`（或 `by`） | **容器滚动**：目标元素自身或**最近可滚动祖先**滚到方向/像素（`by` 优先于 `to`，settle 150ms；纯 `scrollTop`，不模拟滚轮） | `_scrollContainerForElement` → `_scrollWithLoc`（与 `ctx.scrollList`、run 的 `scroll` 命令**同一条实现**） | `moved`、`delta`、`scroll:{scrollTop,scrollHeight,clientHeight}` |
| `target`，无 `to`/`by` | **滚入视口**：把元素滚到视口中央（旧语义，`scrollIntoViewIfNeeded`） | `mw.scrollIntoView` → 同一次 evaluate 里量 scrollTop 前后差 | `moved`、`delta`、`scroll`（同上） |
| 合成目标（`document/body/html/window`，或省略 target） | **文档滚动**：滚主滚动器 | `mw.scrollDocument` | `moved`、`delta`、`scroll` |

- **`changed === moved`（实测）**：B2 之前元素目标的 `changed` 硬编码 `true`——`scrollIntoView`
  在元素已在视口时不移动任何像素，响应仍说"变了"。现在 `moved` 是滚动容器 `scrollTop` 的
  前后差非零，没有 `moved` 证据就是 `false`，不假装滚过。
- **找不到可滚动容器 = 结构化失败**：带 `to/by` 但元素自身与祖先都没有可滚动容器 →
  `{ok:false, code:"not_scrollable"}`（旧行为是静默无操作还报成功）。**无 `to/by` 不适用**——
  元素本来就在视口里是 `moved:false` 的成功事实，不是错误。
- **错误码沿用既有闭集**：`config_error`（`to` 非法值）/ `target_not_found` / `not_scrollable` /
  `stale_ref` / `action_failed`；A2 歧义仍先停（`target_ambiguous` + `ambiguity`），**不新增 stopCode**。
- **`--record` 只记事实**：滚动没走通不记 `to`/`by`；没请求 `to/by` 的元素滚动不再伪记
  `to:"bottom"`；另记 `scroll_mode`（`container`|`into_view`）、`moved`、`delta`、`scrollTop`
  ——`session export` 按 `scroll_mode` 还原成 `ctx.scrollList(target,{to|by})`（容器）或
  `ctx.command("scroll", target)`（滚入视口），两种都能过 `apps check`。
- **边界**：run 面/命令步（`ctx.command("scroll", sel, {to})`）/`ctx.scrollList`/`scrollDocument`
  的既有语义与产物**逐字节不变**——本项只改会话单动作面（`actOnce` 的 scroll 分支与会话层）。

### observe 与 iframe（task-34 口径）

- `elements[]` **默认就包含可达子 frame 的行**（主 frame + ≤5 子 frame；跨源可达帧由 Playwright
  locator 解析），每行带 `frame` 下标，`frames[]` 是它的 URL 表。`includeFrames:false` 只看主 frame。
- 多 frame（`frames.length > 1`）时响应额外带 `frame_counts:[{index,url,elements}]`（每帧元素计数）；
  单 frame 页面**不出现**该字段（缺省产物逐字节不变）。
- frame 内元素的 `hint_candidates` 仍由同一个 `hintMatch` 自证；`act` 解析后池 ref 形如 `f1:e0`。
- 不可达帧（detached/无执行上下文）被跳过，不在 `frames` 里虚报。

### 执行证据词与值的记录（task-34）

- `select` 的 `how` 在**会话响应**里回显为 `"selected"`（`fill` 仍是 `"filled"`）。引擎共享产物
  （`run` 的 `executed_actions`/trace）里该动作词仍是 `"filled"`——不改 run 产物是硬红线，
  所以这层语义精确化只在会话面做。
- `--record-values`（缺省关）：开启后 `--record` 轨迹里 `fill/select` 除 `value_hash` 外**再记明文
  `value`**。安全取舍：轨迹可能被复制进仓库/`app.mjs`，明文只由作者显式 opt-in；`session export`
  会把明文作注释里的"slot 默认值候选"，仍不写死进 flow。
- `--input` 文件允许 UTF-8 BOM（Windows PowerShell 的 `Set-Content -Encoding UTF8` 会带 BOM）：
  首行行首的 BOM 会被剥掉，不当作坏 JSON。

### 导航 flap：诊断与有界自愈（task-38）

**现象**：个别站点（已知：zh.wikipedia 文章页，chrome-headless-shell 下）在 open 之后陷入
客户端 URL 翻页循环——主 frame 每 ~200ms 在同一页面的两种 URL 形态间反复导航（如 ASCII 标题
路径 ↔ 百分比编码路径），期间 DOM 操作持续撞 "Execution context was destroyed"：`read` 全
null、`signal` 恒 false，而 observe/截图看起来正常。根因与浏览器 headless 实现相关，详见
`iterations/interactive-session/task38/ROOT-CAUSE.md`。

**检测**：每次 `open`（启动自动 open 与显式 open 同一路径）都挂主 frame `framenavigated`
监听，在 open 返回后的 1.5s 窗口内观察。触发签名**严格**：≥4 次主 frame 导航 **且** URL 在
同一 origin、同一 path 前缀下的 ≥2 种形态间反复交替。正常重定向 1-2 次、单向跳转链、刷新
同一 URL 都不触发。窗口内零导航的稳定页在 600ms 静默早退后放行响应（`FLAP_QUIET_EXIT_MS`，
正常页因此比改动前多等 ~600ms；这是检测窗口的固有代价，常数可调）。

**判定后的一次有界自愈**：导航到观察到的「编码形态」URL（判不出编码形态就用最后一次
framenavigated 的 URL），等 DCL + 0.5s，再观察 1.5s 复察窗口。仍 flap → `healed:false`
如实报（`ok:false`），**不再重试**；自愈后稳定 → `healed:true`（`ok:true`）。自愈只在
open 判定 flap 时发生；read/signal/observe 语义**零改动**（flap 期间读不到仍是 null/false），
不新增 stopCode。

**open 响应仅在判定 flap 时增字段**（正常页响应逐字节不变）：

| 字段 | 含义 |
|---|---|
| `code: "navigation_flapping"` | 恒带；`healed:true` 时 `ok` 仍为 true |
| `navigations` / `window_ms` | 窗口内主 frame 导航次数 / 观察窗口时长 |
| `urls_sample` | 去重后的 URL 形态样例（≤5） |
| `healed` | 一次有界自愈是否成功 |
| `heal_url?` | 自愈导航的目标 URL |
| `reason` / `suggestion` | 人话诊断；建议改用编码标题 URL 直开或稍后重试 |

**已知边界**：flap 若在静默早退（600ms）之后才起跳，本次 open 检测不到——建议改用编码
URL 直开（实测编码形态直开稳定）。`amber run` 路径**未**做此检测，遇同类页面可能静默空读；
headless 实现选择面（换完整 Chrome new headless）另见 task-39 的受控评估，默认行为不在
本项内变更。

## 与 `run` 的差异（明确划界）

| | `amber run` / `run --walk` | `amber session` |
|---|---|---|
| 控制流 | 冻结计划（`flow(ctx)` 脚本） | 外部逐行请求（人/上游 Agent） |
| 完成判定 | `done` 信号是唯一真相 | **不判完成**；`signal` 只回答"此刻是否成立" |
| 模型 | 只做选择/风险/完成票（可选） | **一步都不问**（不 import 决策 provider，auditor 为 Mock） |
| 预算 | `--max-steps` 执行预算、停因、升级链 | 无 flow 预算；只有 idle 超时 |
| 导航纪律 | `meta.policy.navigation`（含 `entry-only`） | 恒 free（**不接** `entry-only`），只保留 `hosts` 信封 |
| 产物 | `result.json` + trace（`--emit-trace`），可 replay | 动作轨迹 JSONL（`--record`）+ snapshot；trace 只是会话日志，**不是** run trace（app id 不同，`--replay` 会拒） |
| 页面状态 | 每步按声明 URL/重锚语义导航 | 同一页面实例贯穿会话，**不重导航**（命令本身不 goto；跳转只由页面动作引起） |
| 歧义目标 | 命令步在无可执行候选时 `target_ambiguous`（候选进 `skipped_actions`）；run 面本次不变 | `act` 缺省在动手前用**同一个谓词**判定：歧义即零动作 + `ambiguity` 证据；`--on-ambiguous act` 恢复旧的"直接执行第一个可行动候选" |
| 滚动语义 | 命令闭集 `scroll`：无 `to` = 滚入视口、带 `to` = 容器滚动（对 `{to}` 的产物逐字节不变） | `act scroll`：`to/by` = 容器滚动（同 `ctx.scrollList`），无 `to/by` = 滚入视口；两种都实测 `moved/delta`，`changed === moved` |

## 同源复用点（实现层，改一处两面一起变）

- hint 语法：`src/engine/hint.ts` 的 `parseHint`（唯一解析器）；
- 解析/执行单动作：`BrowserMiddleware.actOnce` → 内部 `_extractPoolSettled`（与 run 同一抽池 + settle 门）
  → `resolveCommandRef`（`hintMatch`）→ `_domFallbackResolve`（池外回退）→ `_executeElement`（同一动作执行器）；
- 歧义判据：`src/engine/ambiguity.ts` 的 `describeAmbiguity` → `rules.hintCandidates`（与 run 命令步
  `target_ambiguous` 同一个谓词；证据只读、零页面 I/O）；
- 动作后是否变化：`mw.snapshot` 前后比对（与 run 的 inert 判定同口径）。**scroll 例外（B2）**：
  `changed` 只认引擎实测的 `moved`（容器 `scrollTop` 前后差），不做快照 diff；
- 滚动容器目标：`mw.scrollDocument`（合成目标）+ `ctx.ts` 的 `SCROLL_SYNTHETIC_TARGETS`；
  元素/容器目标：`mw.scrollContainer` → `_scrollWithLoc`（`act` 带 `to/by` 时同一实现）；
  滚入视口：`mw.scrollIntoView` → `_scrollIntoViewWithEvidence`（同一个 `scrollIntoViewIfNeeded`
  调用 + 前后 scrollTop 实测）；
- 只读观察：`observePage`；读 DOM：`ctx.read.*`；结构化抽取：`ctx.extract`（inline → `readRows`）；
- 信号：`checkSignal`、`validateSignalSpec`（与加载期同一个校验器）、等待：`ctx.waitFor`；
- 池快照：`extractElements`（正式池）；正文：`mw.snapshot`；
- 会话构造/关闭：`browserSession` + `BrowserMiddleware` + `createCtx`，模板与 `runScriptApp` 相同。

所以同一 hint 在同一页面/同一池构成下，`session.act` 解析到的元素与 `run` 的 `executed_action.ref`
是同一个（验收时按池内 `dsh_ref` 对照）。

## 安全性 / 纪律

- `act` 的 `value` 只来自请求本身（作者给的决定），缺值 = `needs_value`，绝不猜；`fill/select` 的值
  在 `--record` 轨迹里只落 `value_hash`（不落明文，轨迹可能被复制进仓库/`app.mjs`）。
- 浏览器通道（task-43 三层选择面）：优先级 **env(`AMBERFLOW_BROWSER_CHANNEL=chrome|headless-shell`)
  > `meta.policy.browser` > 缺省（headless-shell，逐字节不变）**。session 面无 meta 层
  （env > 缺省）；`run` 面 meta 声明的应用通道随 pack 生效、env 优先覆盖。
  `chrome`=系统 Chrome new headless——对 zh.wikipedia 文章页这类"客户端 URL flap"页面天然
  免疫（task-39 A/B：功能双臂等价，代价冷启动 +~13%）。无系统 Chrome 时 `channel:"chrome"`
  由 launch **如实报错，不静默回退**（要回退请删 env/meta）。生效值见 run 的
  `effective_policy.browser`（仅声明时出现）；真实二进制以 `env.browser.binary_basename` 为准。
  详见 `docs/APP_SCRIPT_AUTHORING.md` §8 policy 表与 `iterations/interactive-session/task39/DESIGN.md`。
- `snapshot` 的截图/DOM 文本落 `--out`；不做 cookie/存储注入、不多标签页（`ctx.tabs` 面留待后续）。
- 会话结束（含 SIGINT）一定关闭浏览器；`close` 之前没碰过页面就不会启动浏览器。
- 不新增 npm 依赖；不影响任何既有命令的默认行为。

## 与 record / export 的关系

`session --record` 只记**已发生的事实**（动作、目标、结果、URL、值 hash、观察到的 hint 候选），不做信号归纳。
把轨迹变成冻结计划是 `session export` 的事：它只出 `flow(ctx)` 的步骤骨架 + 每步观察到的 hint 候选，
`done` 信号仍要人写，然后照旧走 `apps check → run`。
归纳信号、可直接落盘 app 的通道仍是 `amber record`（learn 路径），两者不互相冒充。

## session export（Phase 2）

```bash
# 1) 起一次会话并留轨迹（--record 同时采 observe_hints）
amber session --url https://books.toscrape.com/ --input requests.jsonl \
  --record .amberflow/session/books.jsonl

# 2) 轨迹 → app.mjs 骨架（缺省落 $AMBERFLOW_HOME/apps/<id>/app.mjs）
amber session export --record .amberflow/session/books.jsonl --id books-skeleton \
  --goal "在 books.toscrape.com 打开 Travel 分类"

# 3) 离线自检（dry，无浏览器）→ 补 done/slot → 真跑
amber apps check books-skeleton
amber run books-skeleton
```

**生成物纪律**（与 design Q6 一致）：

- 只出 `meta` 占位 + `flow(ctx)` 的 `steps[]`；每个 step 带 `observe_hints` 注释
  （来自 `--record` 时的只读观察，已由同一个 `hintMatch` 在观察集合上自证，可直接照抄）。
- **不归纳 done**：每步 `done` 是占位符 `ctx.judge.url("TODO-REPLACE-ME")`，轨迹里观察到的落点 URL
  只作为**注释候选**（未验证）。归纳/验证信号是 `record`/`learn` 的职责。
  占位符故意在真跑里不可能成立——不补 done 就真跑，会如实在 done 等待上失败，而不是假装通过。
- **不发明值**：`fill/select` 在轨迹里只有 `value_hash`/`value_len`，导出为注释块（提示用
  `ctx.value.slot(...)` 绑定），不生成空值/假值。
- **不发明动作**：`ok:false` 的动作以注释块保留（带 `code`/`reason`），骨架不生成假动作。
- `scroll` 导出按轨迹里的 `scroll_mode` 还原（B2）：`container` → `ctx.scrollList(<target|document>, { to | by })`
  （by 优先；`by=0` 这种不可能移动的滚动不生成假动作）；`into_view`（无 `to/by` 的元素滚动）→
  命令闭集的 `ctx.command("scroll", <target>)`（与 run 命令步同一条执行路径：滚入视口）。旧轨迹
  （无 `scroll_mode`）仍按原映射导出 `ctx.scrollList(..., { to })`，与之前逐字节一致。
- 生成物必须能过 `amber apps check`（dry）：这是 export 的自检门，也是"骨架不是死代码"的底线。
- 会话 trace（`<record>.trace.json`）是**会话日志**，不是 run trace：`app:"session:<runId>"`、
  `done:false`，`--replay` 会因 app/版本不匹配拒收。

