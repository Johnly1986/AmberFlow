# 交互式试错会话（`amber session`）

> 定位：**authoring（规划/调试）面**。一次持续会话里「操作一步 → 立即回读 → 再决定下一步」，
> 元素解析 / 动作执行 / 信号判定与正式 `run` **同源**（调用同一批函数，不是照抄语义）。
> 正式执行仍然是「冻结计划 + 运行时消歧」：session 不产生 `done`、不写 `result.json`、
> 不替代 `run` 的通过/失败结论。实施记录见 `CHANGELOG.md` 的会话面条目。
>
> 划界（pilot 是并列新面）：pilot 驾驶协议（PILOTED_WALKTHROUGH_PLAN）是**模型驾驶走查面**（CLI 入口已移除，agent 面经 `amberflow_session` 的 drive 系列 op）——
> 决策模型逐步投票驾驶、Agent 只在停因交接时兜底；session 的 `act/observe/read` 请求保持
> 「一步都不问模型」的 authoring 纪律。**共享现场**：host 是 `amber session` 子进程，`drive`
> 请求在同一 page 上跑 pilot（`pilot:true`/`attached:true`）——驾驶停在交接处后可用
> act/observe 人工补一步再 resume，这就是「切换互证」。两面的证据与可复现口径各自独立
> （session 的请求记录 vs pilot 的驾驶轨迹 + trace），互不借道、互不冒充。

## 什么时候用

- 写 `app.mjs` 之前，想先弄清真实页面上「点这个会不会跳、跳完长什么样、信号写什么能成立」；
- 应用里某一步在 `run` 里失败，要单点复现那一步的解析/动作/回读，而不是整条重跑；
- 需要跨多步保留页面状态（展开的菜单、滚动位置、输入值）做连续试探；
- 走查时想在同一现场切换「模型驾驶」与「人工试错」互证 → `drive` 系列请求（见下）。

不需要它的时候：只想看页面元素 → `amber inspect`；只想核对已声明的 hint 能否命中 →
`amber apps rehearsal` / `amber plan check --probe`；已经能跑 → `amber run`。

## 用法

```bash
# 起会话：打开入口页，从文件逐行读请求（Windows/CI 推荐 --input）
amber session --url https://books.toscrape.com/ --input requests.jsonl --record session-actions.jsonl

# 交互终端：stdin 每行一条 JSON 请求
amber session --url https://books.toscrape.com/ --headful

# 有头窗口尺寸：maximized（最大化，保留浏览器 chrome）/ fullscreen（全屏，F11 语义）
amber session --url https://books.toscrape.com/ --headful --window maximized

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
- **有头窗口尺寸 `--window maximized|fullscreen`**：需要可见窗口（`--headful` 或配置层
  `AMBERFLOW_HEADFUL=1`）；缺省不传 = Playwright 默认窗口。无头会话下给 `--window` 是用法错误
  （exit 2）而不是静默忽略。实现：`--start-maximized` / `--start-fullscreen` + 上下文
  `viewport:null`（页面铺满真实窗口，而不是被缺省 1280×720 视口约束）。

## 请求 / 响应

每条请求是一个 JSON 对象，`type` 从闭集里选；每条请求恰好一个响应，恒有 `{id, type, ok}`
（`id` 原样回显，缺省 `null`）。失败响应还带 `code` + `reason`，**不终止会话**。

| type | 请求（额外字段） | 成功响应（额外字段） | 失败 code |
|---|---|---|---|
| `open` | `url`, `timeoutMs?` | `url, title?, hosts`；落地路径形状被站点改写时另有 `requested_url`/`landed_url`/`landed_path_shape_changed:true` + `reason`（`ok` 语义不变） | `host_not_allowed` / `unreachable` / `config_error`（含浏览器启动期环境错误：headed 但没有可用的 XServer/DISPLAY — 会话**不终结**，可改 headless 重试） |
| `observe` | `max?`, `selector?`, `includeHidden?`, `includeFrames?`, `includeStructure?`（B 批，缺省 false；结构证据仅诊断，不可照抄） | `ObserveResult`（`url,title?,frames?,counts,elements`；**候选为空时**另有 `readiness`——见「observe 的 readiness：空页 vs 还没加载完」节；元素行的字段全集见 [AGENT_INTERFACE §3.2](AGENT_INTERFACE.md) 的唯一权威表——本文只记信封：`frame` 下标、多 frame 时的 `frame_counts`） | `bad_selector` |
| `act` | `op`(`click/check/fill/select/hover/scroll/set_range`), `target`(hint), `value?`(fill/select 必填), `to?/by?`(scroll；给 = 容器滚动，不给 = 滚入视口), `onAmbiguous?`(`fail`\|`act`，缺省 `fail`), `screenshot?`(缺省 `false`；失败时落 `act-<n>-failure.png`), `observeAfter?`, `rehydrateRescan?`(F72 opt-in，只接受 `true`；落空且步首 settle 未静默时等 2s 重抽池重解析同一 hint，至多 1 次) | `op,target,executed,ref,how,changed,url,after?`；`target` 支持 `within:#<id>` 容器作用域（`<id>` 取自 observe 行的 `anchor_ids`，同 label 不同容器时唯一区分手段）；命中池外的 declared-DOM 目标时 `ref` 形如 `drf:0`（**不是**池 ref）；scroll 另有实测 `moved`/`delta?`/`scroll?`（`changed === moved`）；`ambiguous` **只在歧义停时出现**（恒等式 `ambiguous === (code === "target_ambiguous")`，`ok:true` 不可能带它），`matched_others?`/`hint_kind?`/`hint_tier?`/`hint_suspicious?` 是弱档旁路 advisory（成功也回显）；scroll 成功另可带 `strategy:"programmatic"`（非标准滚动器回退）与 `at_bottom:true`（已到底）；set_range 多柄另带 `handles`/`handle_index`/`peers`/`row_index`；非 timeout 异常且 URL 已变时另有 `probe_navigated:true`；**歧义停**时 `ok:false, code:"target_ambiguous", executed:false, ambiguity`；**动作失败**时 `ok:false, code, reason` 并（被遮挡/超时时）带 `actionability`、`screenshot_file?`、落空（`target_not_found`）时带 `diagnostics`/`shape_problem`；`action-timeout` 且 URL 未变时**另带** `execution_state:"unknown"`（派发与否都可能，**不得据此重试破坏性动作**） | `target_ambiguous` / `target_not_found` / `stale_ref` / `needs_value` / `action_unsupported` / `action_failed` / `not_scrollable` / `not-actionable-or-covered` / `action-timeout` / `config_error` |
| `read` | `what`(`text/value/count/attr`), `selector`, `attr?` | `what,selector,value`（读不到 = `null`） | `config_error` |
| `extract` | `rows`, `fields`（`"."` = 行文本；`"@attr"` = 行属性（**闭集**，见「extract 的 fields 闭集与 `@self`」节）；`"@self"` = 行元素可见文本（等价 `"."`）；或子 CSS）, `maxItems?`, `offset?`（续页起点，0-based 整数 0..10000） | `rows,count,capped`；**`capped` 或 `offset>0` 时**另有 `offset,total,has_more`——`count` 是**本页返回行数**不是总数，`total` 才是匹配总数，`has_more = offset+count < total` | `config_error` |
| `waitFor` | `signal`, `timeoutMs?`(缺省 15000), `pollMs?`(200) | `held,timeout_ms,elapsed_ms`；**超时且信号是单个 `css_*` 算子时**另有 `timeout_diagnostics`——见「waitFor 超时诊断：css 与 hint 不是一回事」节 | `config_error`（坏信号形状） |
| `signal` | `signal` | `held,elapsed_ms` | `config_error` |
| `snapshot` | `screenshot?`(缺省 true), `poolMax?`(120) | `snapshot_file,pool_file,screenshot_file?,counts` | `io_error` |
| `mark` | `note` | `note`（只进 `--record` 轨迹，不动页面） | `config_error` |
| `tab` | `action?`(`list` 缺省 \| `switch`), `match?`(`{index}` \| `{urlContains}` \| `{titleContains}`，多键 AND) | `list`：`action:"list",tabs:[{index,url,title,active}],active`（免费只读，**不写轨迹、不记动作**）；`switch`：`action:"switch",switched:{index,url,title}`（写一条 JSONL record） | `config_error`（缺/空/未知 match 键、0 个或多于 1 个匹配）/ `host_not_allowed` |
| `drive` | `goal`(必填), `max_steps?`(1..200), `final_signal?`(对象), `conf_floor?`(0..1), `expect_url?`, `driver?`(`model`\|`agent`), `slots?`(`{k:v}` 字符串) | `status,stop_code?,url?,steps?,model_asks?,out_dir?,attached?,handoff?{…},events?≤20`（有界投影；不回池/候选/槽值） | 引擎停因（`low_confidence`/`needs_value`/`target_*`/`off_task_page`/`budget_exceeded`…，交接结构化返回）/ `config_error` |
| `driveCommand` | `cmd`(`resume/redirect/finish/abort`), `hint?`, `value?`, `skip?`, `goal?`, `url?`, `note?` | 同 `drive`（继续一轮驾驶后的结果） | 同上（单行失败 = 结构化回执，会话继续） |
| `driveStatus` | — | `status,url?,steps?,model_asks?,out_dir?,handoff?` | — |
| `driveClose` | — | 同 `driveStatus`（驾驶面已收尾；浏览器仍归 session） | — |
| `close` | — | `closed,requests,actions,snapshots,duration_ms,urls,evidence_dir` | — |

会话级异常会补发一行 `{"type":"session_end","unsolicited":true,"ok":false,"code":…}`（`idle_timeout` /
`browser_dead` / `interrupted`），它不是任何请求的响应。

### tab：枚举与切换标签页（F76/F77）

- `{"type":"tab","action":"list"}`（`action` 缺省 `list`）：枚举当前 browser context 里**未关闭**的
  标签页，返回 `tabs:[{index,url,title,active}]`（`context.pages()` 枚举序 = index、`active` =
  会话当前页；`isClosed` 过滤）。**免费只读**：不写 `--record` 轨迹、不记动作；列表可以包含
  `hosts` 信封外的页面（与 `ctx.tabs()` 同一判定）。
- `{"type":"tab","action":"switch","match":{…}}`：切到**恰好一个**匹配的标签页。`match` 是
  `{index}` | `{urlContains}` | `{titleContains}`（0-based 序；子串大小写不敏感；多键 AND）。
  `match` 缺失/空对象/未知键 ⇒ `config_error`（文案同 `ctx-validate.ts` 纯函数）；0 个或 >1 个
  匹配 ⇒ `config_error`（reason 带 `describeTabs` 现场，**不回退随便选一个**）；目标 URL 在 `open`
  时声明的 hosts 信封外 ⇒ `host_not_allowed` 且**不切换**。命中后会话当前页切换（后续
  `read`/`act`/`observe` 全跟）+ 有界 `bringToFront`（≤2s）/`domcontentloaded`（≤5s）+ settle，
  写一条 JSONL 动作记录（与 `act` 同一条流）。
- 语义边界：**不迁移不重复 F2 newTab**——`ctx.step newTab`（动作前去重采用/动作开新标签自动
  跟随）留在 flow 面；会话 `tab` 只做显式枚举/显式切换（动作打开的新标签页不会自动跟随，先
  `action:"list"` 确认再 switch）。
- record→export（F81）：`amber session export` 识别 `op:"tab"` switch 行 → 生成
  `await ctx.switchTab({ urlContains: 落点URL | index })` 原语（URL 子串优先、URL 缺失退 index、
  两者都缺 = 注释块不发明；`ctx.switchTab` 自身计 1 个 flow step）；`list`/未知 tab 行与
  `ok:false` 行 = 注释块保留、不发明动作。

### drive：在会话现场驾驶（与 pilot 共用同一 page）

- `{"type":"drive","goal":"…","max_steps?":8,"final_signal?":{…},"conf_floor?":0.25,"expect_url?":
  "/maps","driver?":"model","slots?":{…}}`：在**当前会话页**上开始一轮 pilot 驾驶（附着式
  `PilotRuntime`：`ownsSession:false`、`skipStartNavigation:true`，不新开浏览器、不重新导航）。
  驾驶到下一个停因交接处返回；`driver:"agent"` = 每步等 `resume` 点名（零模型票，便于验收）。
- `{"type":"driveCommand","cmd":"resume","hint":"Open the detail page"}`：交接后继续；`cmd` 闭集
  `resume/redirect/finish/abort`，字段 `hint?/value?/skip?/goal?/url?/note?` 与引擎 pilot 驾驶协议的
  stdin 指令同一套语义。`resume`/`redirect` 成功会继续驾驶并返回下一步结果。
- `{"type":"driveStatus"}` / `{"type":"driveClose"}`：只读回显 / 收尾驾驶面（结束 pilot、保留
  证据；**不关闭宿主浏览器**，session 仍可 `act/observe/close`）。
- 语义：pilot 在**同一 page** 上驾驶，产物 `pilot:true`/`attached:true`（证据目录独立）；session
  的 `act/observe` 仍零模型。两者不共享 middleware/账本/预算；交接停在 handoff 后，agent 可以
  先 `act` 人工补一步，再 `driveCommand{cmd:"resume"}` 交给模型继续——**切换互证**的入口。
- 红线与边界：`drive` 走 pilot face（危险动作 `default-deny`）；`drive` 是独立请求类型，不改变
  session `act` 的零模型口径；不新增工具/命令（桥面 `amberflow_session` 的 `drive` 系列 op 同源）。

### 分页：extract 有 offset，observe 没有

- `extract` 的 `count` 是**本页返回行数**，不是匹配总数；`maxItems` 是每页上限（1..500，缺省 500）。
  分页用 `offset`：从 0 开始，每次把 `offset` 加上本页 `count` 续页；`has_more` 为 false 即到底。
  `offset` 只认**顶层字段**（写进 inline spec 不是分页起点），必须是 0..10000 的整数——负数、小数、
  字符串、越界都是 `config_error`（引擎不 clamp，悄悄改起点会让"续页不重不漏"变成假话）。
- `offset=0` 且本页没被 cap 挡住时，响应与分页之前逐字节一致（不多出 `offset/total/has_more`）。
- `total` 是**当前 DOM 匹配行总数**（这一刻的事实）；懒加载/无限滚动页面在滚动后 `total` 会变，
  续页之间页面若发生插入/删除，offset 分页可能重/漏——需要"翻到底"的穷举请用 `ctx.collect`
  （应用脚本面）或接受逐页快照的语义。抽行前要"等列表稳定"用 `waitSettled:true`（见
  「extract 的稳定读与空行事实」节）；滚动到列表底用 `act scroll rows`（见 S1 节）。
- `observe` **不提供 offset**：元素序随水合/动画变化，没有稳定锚（用 offset 续页会悄悄错位）。
  行数太多时用 `selector` 收窄、`max` 放宽（硬上限 200），要全量元素快照就用 `snapshot`
  （`pool-<n>.json`）。

- **元素行的字段口径不在本文重复**：`observe` 每元素的字段、cap 与「哪一面有」见
  [`docs/AGENT_INTERFACE.md` §3.2](AGENT_INTERFACE.md) 的**唯一权威字段表**。会话面只需记住两条：
  **地址只来自 `hint_candidates`**（`ref` 是展示锚，`structure_path` 是诊断证据，都不能当 target），
  以及 `admitted === false` 时 `why_not_admitted` 会点名"为什么没有可解析地址"。

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
| `ambiguous?: true` | **只在歧义停时出现**，且与结果码是同一个事实：`ambiguous === (code === "target_ambiguous")`。已执行的动作（`ok:true`）**不可能**带它 |
| `matched_others?: [{ref,tag,class,label}]` | 除实际选中者外的撞词候选（≤3；label ≤40 字符）。它是"池里还有相似候选"的 **advisory**，与歧义判决无关——`ok:true` 时也照旧回显 |
| `hint_kind?: "bare" \| "attrSubstr"` / `hint_tier?: number` / `hint_suspicious?: true` | 只在**弱档**胜出（词前缀/词包含、loose 子串）时出现——这形状最容易命中容器/同缀元素 |

- `ambiguous` 是**零动作判决**的字段，不是诊断：`ok:false + code:"target_ambiguous"` 才带它。
  `ok` 与 `ambiguous` 同时为真在协议上不可出现（调用方可以据此二选一，不必再交叉核对）。
- 成功响应仍可带 `matched_others`（"强档唯一命中，但池里还有撞词候选"）——这时动作已经发生，
  该字段是提醒而不是歧义：想确认点对了就 `observe` 或读回 URL/done 信号。
- 精确形状（`#id`/`tag[attr=value]`/角色词/`tag~token`）不产生这些字段（没有旁路诊断 = 无需回显）。
- 池外回退（0×0 手柄这类）时 `ref` 可能是合成 ref（`pN`），`matched_others[].ref` 同源，如实不映射。
- 例（歧义停）：三个 `Edit` 链接的页面上 `act click "Edit"` →
  `{"ok":false,"code":"target_ambiguous","executed":false,"ambiguous":true,"ambiguity":{…}}`；
  想精确点第二个就先 `observe` 抄 `a[href=#b1]`。
- 例（已执行 + 另有相似候选）：`{"ok":true,"ref":"e1","how":"clicked","matched_others":[{"ref":"e0",…}]}`
  ——没有 `ambiguous` 键，动作确实发生了。

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
| `candidates[]` | ≤5 行：`ref≤16, tag≤16, role?≤16, label≤40, class?≤40, near?≤40, frame, frame_origin?（B 批：候选所在帧 origin，引擎 ≤120；桥投影 clip ≤60，引擎给才有）, same_label, suggested_hint?≤200` |

- `same_label` = 该归一 label（`full_label` 优先、折叠空白/大小写）在**本次池内**出现 >1 次 ⇒ label
  本身不足以区分（收窄要换 `#id` / `[data-test=…]` / 属性或 `near`）。
- `near` 只**复制**池里既有 `elem.near`（不重算）；`suggested_hint` 来自既有 `suggestHints`（内部同一个
  `hintMatch` 自证「恰好唯一命中」，为空就省略该键）——可直接照抄进下一条 `target`；B 批后也可能是
  `<label> frame:<origin>` / ≤4 段 origin 链形态（跨帧同名时），候选的 `frame_origin` 可先用来判断是哪一帧。
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
| `action-timeout` | 探针超时、中心点**无覆盖者**，且 5s 重试仍不成功（不是"只是慢"）。**URL 已变时不算失败**——按已点击返回；URL 未变 = `execution_state:"unknown"` | 同一份 `actionability`（证明无覆盖者、重查时节点仍在/已脱离） |
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
| `shape_problem` | **形状可疑**时的独立判别（只在可疑形态出现）：`{kind:"tag-plus-text"\|"role-word-plus-text"\|"selector-syntax", reason, suggestion}`——`button 搜索`（角色词后接文本）、`div 价格评分时间所有过滤条件`（标签后接文本）、`#outer input`（id 里带组合符）这类写法在闭集里是**合法裸词**，零命中时把它点出来并给可抄的改法；判定 `hint.ts` 的 `hintShapeProblem`，**只陈述不改写、不新增停因** |

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
- **形状判别只在落空后判**：闭集里的裸词收一切字符串，解析期拒绝会把真 label（例如可见标签恰为
  `button settings` 的控件）误杀；只有"这串在页面一个都没命中"时，可疑形态才有判别力。响应为
  additive 顶层键 `shape_problem`（与 `diagnostics.shape_problem` 同值），reason 的 `判别:`
  一段在可疑形态下先说形状。
- **落空 reason 带闭集提示**（与命令步 `cmdDiscrimination` 同一份 `HINT_CLOSED_SET_TEXT`，单一出处）：
  会话 act 的 `target_not_found` 不再只说 `matched nothing in a pool of N`，尾段点名"容器/后代 CSS
  会被当成永不命中的形状"。只动这一停因的 reason 尾段，成功路径与其它停因逐字节不变。

### act 的超时对账（`execution_state`：说"不知道"而不是"没执行"）

`action-timeout` 是**探针/重试超时**，不是"没有派发"。点击可能已在途中生效（异步导航、慢提交），
把这种情形一律报成失败会让上层重放同一动作——破坏性动作尤其危险。因此：

- 收尾时**零额外往返**地比对动作前 URL：**已变** = 点击已生效 → 按 `ok:true`（`how:"clicked"`，
  带 `probe_navigated:true` / trace 行 `navigated_after_timeout:true`），**不补点**；
- **未变** = 派发与未派发都可能 → `ok:false, code:"action-timeout"` **另带** `execution_state:"unknown"`；
  调用方必须按未知处置（先 observe 复核，不重试破坏性动作），键缺省 = 该路径没有这份事实；
- 命令步同一判据（`_clickOnly` 与 actionability 探针共用一个实现），run 产物只多一个 additive 键。

### act 的重水合补偿（F72，opt-in）

`rehydrateRescan:true`（只接受 `true`；缺省不出现 = 引擎缺省关、行为逐字节不变）是重水合
SPA 的失败路径补偿：声明 hint 真落空（`hintMatch` 零命中）**且**步首 settle 报告页面未静默
（`timedOut`——抽到 SSR 中间态池）时，等 2s → 重抽池 → 用**同一 hint** 重解析（确定性
`rule:match`，不重走决策面；至多 1 次，受整步挂钟帽钳制）。命中 = 成功响应带
`resolved_via:"rehydrate-rescan"`；重扫池上歧义照旧走同一谓词；仍未命中 = 原停因不变 +
`diagnostics.rescan`。`settle:"off"` 时门控信号不存在，重扫永不触发。首选仍是 act 前用
`ctx.waitForTarget` / `wait_for` 正锚。

### act set_range 的身份、档位与轨迹

范围控件（滑杆）有两个"把值当身份"的坑，现在都在引擎侧处理：

| 事实 | 处理 |
|---|---|
| 滑块 label 曾是**活值**（`value` 属性） | 提取期对 `input[type=range]` **不读 value**（`LABEL_HELPERS_JS` 的 `isRangeLike`，四处标签口径同步：池/observe/回捞/A3）；身份只来自 `#id`/`name`/`data-test`/aria-label/label 包裹——同一 hint 连续 `11 → 8 → 11` 都能命中 |
| 值域是**格点**（`step=N`），请求值可能不存在 | 先吸附到最近格点再动：`applied:true` + `accurate:false` + `snapped_to:<落地值>`（不再"三策略全试 + 满 10s 白等 + slider_not_settable"） |
| **多柄**耦合控件（双滑块价格区间等） | `readState` 数出同容器内的手柄个数（只数"只装滑块"的最近一层容器）并把**各柄自己的** `min/max/value/valuetext` 一并读出（≤8，同一次 evaluate，零额外往返）：`handles>1` 时 `percent` **结构化拒绝**（`config_error`，零动作，指名用 `{value}` 打具体手柄），其它失败也附 `handles` |
| **指错了柄**被说成"值不合法" | 越界拒绝的 `reason` 补**候选事实**：`命中 N 个同形 range 元素`、各柄 `min/max`、本次作用于第几柄；结构化字段另给 `handle_index`（耦合组内 1-based 位次）与 `peers`（各柄值域）。单柄控件 `reason` 逐字节不变、无这两个键 |
| 手柄序 ≠ 行锚序 | `handle_index` 是**耦合组内**位次；`row_index` 是"同 tag+label dup 组内"位次（滑杆 label 常为空串，会与页面其它空 label 输入同组）。两条序不能互相推导，两个事实都回显；寻址仍由作者选形状（`row-index:N` 或 `#id`） |
| 页面提供档位人读文本 | `aria-valuetext` 原样回显为 `valuetext`（只在页面给才有） |
| `--record` 缺这一行 | 执行体自己记轨迹（成功/失败都记，含 `applied/accurate/achieved/requested/target_value/strategy/snapped_to/handles/valuetext`），`session export` 还原成 `await ctx.setRange(<hint>, { value: <requested> })` |

### act 的滚动语义（B2，`changed` 只认实测）

`act scroll` 有**两种**语义，由请求带不带 `to`/`by` 决定（没有第三种）：

| 请求 | 语义 | 执行面 | 证据 |
|---|---|---|---|
| `target` + `to`（或 `by`） | **容器滚动**：目标元素自身或**最近可滚动祖先**滚到方向/像素（`by` 优先于 `to`，settle 150ms；纯 `scrollTop`，不模拟滚轮） | `_scrollContainerForElement` → `_scrollWithLoc`（与 `ctx.scrollList`、run 的 `scroll` 命令**同一条实现**） | `moved`、`delta`、`scroll:{scrollTop,scrollHeight,clientHeight}` |
| `target`，无 `to`/`by` | **滚入视口**：把元素滚到视口中央（旧语义，`scrollIntoViewIfNeeded`） | `mw.scrollIntoView` → 同一次 evaluate 里量 scrollTop 前后差 | `moved`、`delta`、`scroll`（同上） |
| 合成目标（`document/body/html/window`、**会话面另加 `page`**，或省略 target） | **文档滚动**：滚主滚动器 | `mw.scrollDocument` | `moved`、`delta`、`scroll` |

- **`changed === moved`（实测）**：B2 之前元素目标的 `changed` 硬编码 `true`——`scrollIntoView`
  在元素已在视口时不移动任何像素，响应仍说"变了"。现在 `moved` 是滚动容器 `scrollTop` 的
  前后差非零，没有 `moved` 证据就是 `false`，不假装滚过。
- **程序化滚动面板（overflow:hidden + JS 驱动 scrollTop）**：标准滚动器（`overflow:auto/scroll/overlay`
  + 内容溢出）找不到、但祖先是"内容溢出且 `overflow` 非 `clip`"时，引擎**回退**到对那个祖先写
  `scrollTop`（那正是这类面板自己的滚动机制），成功响应标 `strategy:"programmatic"`——标准滚动器
  路径**不带这个键**。`moved`/`delta`/`scroll` 仍是 before/after 实测，不假成功。
- **`at_bottom: true`**：`moved:false` 有两种含义（"这次没动"与"已经到底了"），容器几何可读且
  `scrollTop + clientHeight >= scrollHeight - 2` 时补这个键（容差 2px 吸收亚像素/滚动条取整）。
- **找不到可滚动容器 = 结构化失败**：带 `to/by` 但元素自身与祖先都没有可滚动容器（也不存在
  上面那种程序化面板）→ `{ok:false, code:"not_scrollable"}`；`reason` 里的建议是**在调用面可执行**
  的（会话面 `act scroll target=document`，flow 面 `ctx.scrollList("document")`）。**无 `to/by`
  不适用**——元素本来就在视口里是 `moved:false` 的成功事实，不是错误。
- **`target=page` 只在会话面是合成目标**：authoring 会话里"滚整页"最常用，`page` 因此按
  `document` 处理（不进池、不做 hint 匹配）。flow 面的 `ctx.scrollList` 合成名集合**不变**
  （`document/body/html/window`）——代价是会话面无法再用裸词 `page` 点名 label 恰为 "page"
  的元素，那类元素用 `#id`/`[data-test=…]`/完整 label 寻址。
- **错误码沿用既有闭集**：`config_error`（`to` 非法值）/ `target_not_found` / `not_scrollable` /
  `stale_ref` / `action_failed`；A2 歧义仍先停（`target_ambiguous` + `ambiguity`），**不新增 stopCode**。
- **`--record` 只记事实**：滚动没走通不记 `to`/`by`；没请求 `to/by` 的元素滚动不再伪记
  `to:"bottom"`；另记 `scroll_mode`（`container`|`into_view`）、`moved`、`delta`、`scrollTop`
  ——`session export` 按 `scroll_mode` 还原成 `ctx.scrollList(target,{to|by})`（容器）或
  `ctx.command("scroll", target)`（滚入视口），两种都能过 `apps check`。
- **边界**：run 面/命令步（`ctx.command("scroll", sel, {to})`）/`ctx.scrollList`/`scrollDocument`
  的既有语义与产物**逐字节不变**——本项只改会话单动作面（`actOnce` 的 scroll 分支与会话层）。

### act scroll 的行容器寻址（S1，`rows` 字段）

B2 的容器滚动需要**先命中一个元素 hint**（`target` + `to/by`）；懒加载列表没有稳定单元素锚
（行内容会整体替换）时，第三种 target 形态直接给**行选择器**：

```json
{"type":"act","op":"scroll","rows":".search-result","to":"bottom"}
```

| 请求 | 语义 |
|---|---|
| `rows` + `to`（或 `by`） | 滚动**匹配行的最近可滚动祖先**（无则主滚动器）到方向/像素——与 `ctx.collect` 内部滚动**同一份容器判定**（最近可滚动祖先、帧序、信封、` frame:` 尾缀剥离），不是第二套语义 |

- `rows` 与 `target` **互斥**（同给 = `config_error`）；`rows` 需要 `to`/`by` 至少其一。
- `to:"bottom"` 是**有界循环步进**（每轮 ~0.9 屏 + 150ms settle，≤50 轮，滚到 `atBottom` 即停）：
  懒加载页滚到中途会加载新行，单次直写到底会跳过中途内容；无限流 50 轮上限防挂死。
  `top`/`page`/`by` 是单步直写。
- 行零命中 = `target_not_found`（reason 点名 rows 选择器）；行在但容器不可滚 = `not_scrollable`
  ——两个都是**既有停因码**，不新增。
- 响应证据与 B2 同口径：`moved`、`delta`、`scroll:{scrollTop,scrollHeight,clientHeight}`；
  `--record` 记 `scroll_mode:"rows_container"`（`session export` 还原成 `ctx.scrollList(rows, {to|by})`）。
- 缺省（不给 `rows`）= 三种既有语义逐字节不变。

### extract 的稳定读与空行事实（S2）

懒渲染页的两个高频事故：直接抽到"还在灌"的半截列表；把骨架空行当真值。`extract` 增 additive
面（缺省不给 = 响应除 `blank_rows` 外逐字节不变）：

- `waitSettled:true`（只接受 `true`）：抽行前做**双指标稳定门**——行数与空行数（一次 evaluate
  同时拿两个数）连续 2 轮相等才算稳定（600ms 间隔，至多 5 轮，与 E5 滚动稳定窗同款）。空行数
  单独盯：行数可以先稳定（骨架节点已挂载）而内容还在灌。超窗 = 抽取照常发生 + 如实回
  `settled:false`——**不是失败**，读到的就是此刻事实；不等价于 waitFor，也不判 done。
- `blank_rows`（恒带）：本页返回行里**所有字段都是空串**的行数（判读权在调用方）；`waitSettled`
  未稳定时会用行选择器再统计一次全 DOM 空行数兜底。骨架行/懒加载未灌满的第一判别信号。
- `settle_reason`（可选第三键，additive）：稳定门**判不了**时出现——一次读指标拿到 `null`
  （读失败），此时 `settled:false` + `settle_reason:"read_failed"`（失败即 false，绝不拿没读到的
  内容谎报稳定）。正常路径（稳定，或窗口到点仍在变）**不带**该键；值闭集目前只有 `read_failed`。

### `within:` 与 `--target-resolution`：class-only 控件怎么点得到（P1-C3）

同 label、不同容器的一类控件（典型：Google 地图评价页有 3 个「查看更多」，评论正文的展开器
只是其中之一）永远 `target_ambiguous`。区分手段是 **容器作用域**，而容器的来源是观察面的
`anchor_ids`：

```
$ amber session --url <页> --target-resolution declared     # 缺省即 declared
> {"type":"observe","max":80}
  → tag=button label="查看更多" text="展开" anchor_ids=["ucc-14"]        ← 评论正文那个
  → tag=button label="查看更多" text="展开" anchor_ids=["503__uuxhif0"]  ← 侧栏那个
> {"type":"act","op":"click","target":"查看更多 within:#ucc-14"}
  → ok:true, ref:"drf:0", changed:true
```

- `anchor_ids` = 祖先 `id` 链（内→外、小写、≤8 条 × ≤40 字符）。**它是地址素材不是地址**：
  单独照抄不构成 hint；写进 target 必须配 `within:#<id>`。
- `--target-resolution off|declared`（缺省 `declared`）：`declared` = 池内落空后仍按**同一份
  hint 形状**在 DOM 里结构化解析（含 `within:` 作用域），这是 class-only 控件可寻址的原因；
  `off` = 关闭该兜底（池外目标一律 `target_not_found`）。非法值 exit 2，不静默回落。
- **绝不猜**：DOM 里可见匹配 >1 → `target_ambiguous` 零动作；全部隐藏 → 视为未命中。
- 池内命中优先，`stopCode` 闭集不变；判定与池面是**同一份 `hintMatch`**，所以 `within:<id>`
  在池面与声明面语义一致。
- 走 declared 解析命中的 `ref` 形如 `drf:0`（**不是**池 `eN`）；这也是"这次是不是走了 DOM 兜底"
  的可观察信号。

### waitFor 超时诊断：css 与 hint 不是一回事（P1-B3）

`css_*` 信号走**原始 DOM**（Playwright locator），而 `act` 的 `target` 走 **hint**（池字段匹配，
`aria-label` 在提取期已并进 `label`）。同一个串在两种语义下可以一个命中、一个永不命中——最常见的
翻车是**把 act 用的 hint 串当 CSS 信号等**，白等到超时还不知道为什么。

`waitFor` 只在**超时**（`held:false`）且信号是**单个 `css_*` 算子**时，补一个诊断块，
用 `ctx.waitForTarget`（observe + `hintMatch`，与 act 同一口径）判"这串能不能当 hint 用"：

```json
{"id":4,"type":"waitFor","ok":true,"held":false,"timeout_ms":6000,"poll_ms":200,"elapsed_ms":6020,
 "timeout_diagnostics":{"css_selector":"button[aria-label=\"价格\"]","hint_matchable":true,
 "hint_match_count":1,"note":"该串作为 hint 可命中 1 个候选，但作为 CSS 不存在：…别把 hint 串当 CSS 信号等。"}}
```

- `hint_matchable:true` ⇒ 这串能当 act 的 `target` 用，只是不能当 CSS；`hint_match_count>1` 时
  note 会提示"多候选时 act 默认报 `target_ambiguous`"。
- `hint_matchable:false` ⇒ 两种语义都不成立，换更短的独词或先 `observe` 抄 `hint_candidates`。
- **判定不可得时不冒充**：`dry` 面、或 `waitForTarget` 抛错时，只给 `css_selector`，
  **不写** `hint_matchable`（还没真评过，"不是 hint"同样是假话）。
- 复合信号（`all_of`/`any_of`/`not`）、`manual`、`url_contains`、多算子 spec 一律**跳过**；
  `held:true` 时**不带这个键**（响应形状与改动前逐字节一致）。

判据用的是 `ctx.waitForTarget`——**与 act 同一份 `hintMatch`**，不是"候选数组成员判定"。
这点很关键：`hint_candidates` 只装"已自证唯一命中、可直接照抄"的串，像 `tag[attr=value]`
这种**能命中但永不入候选**的写法不在里面；用成员判定会把能用的 hint 判成"不是 hint"。

### observe 的 readiness：空页 vs 还没加载完（P1-B2）

`observe` 在**候选为空**时会补一个 `readiness` 块，用来区分两种完全不同的处境——
"页面确实没有可用元素"与"页面还没加载完"。没有它时两者都是 `ok:true + elements:[]`，
自动化流程会据此后判定"没有可用元素"并停手。

```json
{"id":2,"type":"observe","ok":true,"counts":{"elements":0,"admitted":0,"omitted":0},
 "elements":[],"readiness":{"document_state":"loading","elements":0,"verdict":"loading",
 "hint":"页面仍在加载（document.readyState=loading）：重试 observe，或用 waitFor 等到目标出现"}}
```

- **只在 `ok:true` 且候选为空时出现**；元素非空时**不带这个键**（连一次页面读取都不付，
  响应形状与改动前逐字节一致）。
- `document_state` ∈ `loading | interactive | complete | unknown`（`unknown` = 读不到，
  例如替身页面没有 `evaluate`、或读取超时——**不抛**，按 `loading` 处理）。
- `verdict` 只有两档：`complete` ⇒ `empty`（已就绪、确实没有候选）；其余 ⇒ `loading`。
- **它是事实不是门**：`readiness` 不影响 `ok`、不阻断、不判完成；`loading` 时该重试就重试。

### extract 的 fields 闭集与 `@self`（P0-B）

`fields` 的值形态不变（子 CSS / `"."` 行文本 / `"@…"` 取属性），`@` 面从"任意名字"收敛成**闭集**：

- **`"@self"`（新增伪属性）** = 该行元素自身的可见文本（`innerText`，trim），实现上归一成既有
  `"."`（抽取语义零新增）。需要"这一行的文本"就用它或 `"."`。
- `"@attr"` 只认真实 **HTML 属性**（大小写不敏感）+ `"@self"`；`data-*` 是唯一开放族，`aria-*`
  与 `on<event>` 按表枚举。**DOM 属性名不是 HTML 属性**——`@innerText` 这类入口即 `config_error`
  （`problems[]` 逐字段点名、`reason` 带闭集说明），不再静默返回空串；属性名合法但页面没有该属性
  仍是空串（与旧行为一致）。
- 清单唯一出处：`src/app/session-extract-fields.ts` 的 `EXTRACT_ATTR_WHITELIST` /
  `EXTRACT_ATTR_CLOSED_SET_TEXT`。本文不复述清单（避免两处漂移）。

### act 的同标签页导航事实（S3，`navProbeMs`）

`act`（click 为典型）触发页面内跳转时，成功响应只有动作后的 `url`——跳没跳、跳去哪，调用方
只能再发一条 read/observe 对比。opt-in 探测：

```json
{"type":"act","op":"click","target":"下一页","navProbeMs":800}
```

- 成功路径动作后以 100ms 间隔轮询同标签页 URL，最多 `navProbeMs`（整数 100..3000；缺省不给 =
  零额外等待、键集不变）。URL 变 = `same_tab_navigation:true` + `nav_from`/`nav_to`/`probe_ms`；
  未变 = `same_tab_navigation:false` + `probe_ms`。
- 与异常路径的 `probe_navigated:true` 互斥出现（那条是免费事实，不重复探测）。
- **只报事实不判完成**：`same_tab_navigation` 不是 done 信号；要确定性判定用 `waitFor`/`signal`。
- `--record` 以 `nav_probe` 事件行留导航事实（与 mark 同流，不占动作序）。

### act 落空时的最近命中提示（S4）

同一 hint 上一步还点得动、下一步 `target_not_found`——典型场景是列表行内容整体刷新（展开/
翻页/水合）。会话内存里维护最近成功解析记录（≤20 条）：落空且该 hint 在 ≤10 个动作内命中过
时，失败响应多两处**纯内存**引导（零页面往返）：

- 顶层 `recently_resolved:{steps_ago, last_op, last_how}`（独立键，不覆盖引擎 A4 的 `diagnostics`）。
- `reason` 尾行：`该 hint 曾在 N 个动作前命中（op=…, how=…）——行内容可能已变，建议重新 observe 后换锚`。

无历史（首次使用/隔太久）= 键不出现、reason 不变，响应键集与之前一致。只陈述事实，不自动重试、
不自动换锚——重新 observe 是作者的决定。


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
null、`signal` 恒 false，而 observe/截图看起来正常。根因与浏览器 headless 实现相关。

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
| 滚动语义 | 命令闭集 `scroll`：无 `to` = 滚入视口、带 `to` = 容器滚动（对 `{to}` 的产物逐字节不变） | `act scroll`：`to/by` = 容器滚动（同 `ctx.scrollList`），无 `to/by` = 滚入视口；两种都实测 `moved/delta`，`changed === moved`；`set_range`：格点吸附（`snapped_to`）/多柄 `percent` 拒绝（`handles`）/轨迹 + export（`ctx.setRange`） |

## 同源复用点（实现层，改一处两面一起变）

- hint 语法：`src/engine/hint.ts` 的 `parseHint`（唯一解析器）；
- 解析/执行单动作：`BrowserMiddleware.actOnce` → 内部 `_extractPoolSettled`（与 run 同一抽池 + settle 门）
  → `resolveCommandRef`（`hintMatch`）→ `_domFallbackResolve`（池外回退）→ `_executeElement`（同一动作执行器）；
- 歧义判据：`src/engine/ambiguity.ts` 的 `describeAmbiguity` → `rules.hintCandidates`（与 run 命令步
  `target_ambiguous` 同一个谓词；证据只读、零页面 I/O）；
- 动作后是否变化：`mw.snapshot` 前后比对（与 run 的 inert 判定同口径）。**scroll 例外（B2）**：
  `changed` 只认引擎实测的 `moved`（容器 `scrollTop` 前后差），不做快照 diff；
  non-scroll 的 `changed` 快照包含**展开/按压状态**（`aria-expanded`/`aria-pressed`）——菜单/抽屉只翻属性
  不改文本时也能如实报"变了"（纯 `innerText` diff 会漏报）；
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
  详见 `docs/APP_SCRIPT_AUTHORING.md` §8 policy 表。
- `snapshot` 的截图/DOM 文本落 `--out`；不做 cookie/存储注入；多标签页走**会话面显式 `tab` op**
  （`list`/`switch`，见上）；flow 面的 `ctx.tabs()` / `ctx.switchTab()` 见 `docs/APP_SCRIPT_AUTHORING.md`。
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

