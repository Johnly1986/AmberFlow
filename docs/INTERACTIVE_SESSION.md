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
| `act` | `op`(`click/check/fill/select/hover/scroll`), `target`(hint), `value?`(fill/select 必填), `to?/by?`(scroll), `observeAfter?` | `op,target,executed,ref,how,changed,url,after?`；歧义时另有 `ambiguous`/`matched_others?`/`hint_kind?`/`hint_tier?`/`hint_suspicious?` | `target_not_found` / `stale_ref` / `needs_value` / `action_unsupported` / `action_failed` / `not_scrollable` / `config_error` |
| `read` | `what`(`text/value/count/attr`), `selector`, `attr?` | `what,selector,value`（读不到 = `null`） | `config_error` |
| `extract` | `rows`, `fields`（`"."` = 行文本；`"@attr"` = 行属性；或子 CSS）, `maxItems?` | `rows,count,capped` | `config_error` |
| `waitFor` | `signal`, `timeoutMs?`(缺省 15000), `pollMs?`(200) | `held,timeout_ms,elapsed_ms` | `config_error`（坏信号形状） |
| `signal` | `signal` | `held,elapsed_ms` | `config_error` |
| `snapshot` | `screenshot?`(缺省 true), `poolMax?`(120) | `snapshot_file,pool_file,screenshot_file?,counts` | `io_error` |
| `mark` | `note` | `note`（只进 `--record` 轨迹，不动页面） | `config_error` |
| `close` | — | `closed,requests,actions,snapshots,duration_ms,urls,evidence_dir` | — |

会话级异常会补发一行 `{"type":"session_end","unsolicited":true,"ok":false,"code":…}`（`idle_timeout` /
`browser_dead` / `interrupted`），它不是任何请求的响应。

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

## 同源复用点（实现层，改一处两面一起变）

- hint 语法：`src/engine/hint.ts` 的 `parseHint`（唯一解析器）；
- 解析/执行单动作：`BrowserMiddleware.actOnce` → 内部 `_extractPoolSettled`（与 run 同一抽池 + settle 门）
  → `resolveCommandRef`（`hintMatch`）→ `_domFallbackResolve`（池外回退）→ `_executeElement`（同一动作执行器）；
- 动作后是否变化：`mw.snapshot` 前后比对（与 run 的 inert 判定同口径）；
- 滚动合成目标：`mw.scrollDocument` + `ctx.ts` 的 `SCROLL_SYNTHETIC_TARGETS`；
- 只读观察：`observePage`；读 DOM：`ctx.read.*`；结构化抽取：`ctx.extract`（inline → `readRows`）；
- 信号：`checkSignal`、`validateSignalSpec`（与加载期同一个校验器）、等待：`ctx.waitFor`；
- 池快照：`extractElements`（正式池）；正文：`mw.snapshot`；
- 会话构造/关闭：`browserSession` + `BrowserMiddleware` + `createCtx`，模板与 `runScriptApp` 相同。

所以同一 hint 在同一页面/同一池构成下，`session.act` 解析到的元素与 `run` 的 `executed_action.ref`
是同一个（验收时按池内 `dsh_ref` 对照）。

## 安全性 / 纪律

- `act` 的 `value` 只来自请求本身（作者给的决定），缺值 = `needs_value`，绝不猜；`fill/select` 的值
  在 `--record` 轨迹里只落 `value_hash`（不落明文，轨迹可能被复制进仓库/`app.mjs`）。
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
- `scroll` 导出为同一族滚动原语 `ctx.scrollList(<target|document>, { to })`（各计 1 flow step）。
- 生成物必须能过 `amber apps check`（dry）：这是 export 的自检门，也是"骨架不是死代码"的底线。
- 会话 trace（`<record>.trace.json`）是**会话日志**，不是 run trace：`app:"session:<runId>"`、
  `done:false`，`--replay` 会因 app/版本不匹配拒收。

