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
| `observe` | `max?`, `selector?`, `includeHidden?`, `includeFrames?` | `ObserveResult`（`url,title?,frames?,counts,elements`；每元素带 `hint_candidates`） | `bad_selector` |
| `act` | `op`(`click/check/fill/select/hover/scroll`), `target`(hint), `value?`(fill/select 必填), `to?/by?`(scroll), `observeAfter?` | `op,target,executed,ref,how,changed,url,after?` | `target_not_found` / `stale_ref` / `needs_value` / `action_unsupported` / `action_failed` / `not_scrollable` / `config_error` |
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

`session --record` 只记**已发生的事实**（动作、目标、结果、URL、值 hash），不做信号归纳。
把轨迹变成冻结计划是后续 `session export`（Phase 2）的事：它只出 `flow(ctx)` 的步骤骨架 +
每步观察到的 hint 候选，`done` 信号仍要人写，然后照旧走 `apps check → run`。
归纳信号、可直接落盘 app 的通道仍是 `amber record`（learn 路径），两者不互相冒充。
