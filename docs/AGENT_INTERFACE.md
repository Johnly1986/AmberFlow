# Agent 接口（脚本化应用）

状态：现行接口。应用流程只有一种作者模型——`apps/<id>/app.mjs` 里的 `flow(ctx)`。
范围：DSH 桥工具、`amber` CLI、应用运行结果的 Agent 视图。
不在范围：执行器内部算法、决策模型协议、线上测试用例格式。

---

## 0. 单一模型

应用是**用户作用域的一段 JS 流程**，不是 JSON 声明：

```text
$AMBERFLOW_HOME/apps/<id>/app.mjs
  export const meta = (kit) => ({ id, label, goal, hosts, slots, invariants, ... })
  export async function flow(ctx) { ... }
```

- 流程默认由**决策语句**组成：一次 `ctx.step(goal, { done, ... })` 只写“要达到什么”和“怎么算完成”；
  点哪里由引擎的规则/决策层决定。`act`（`ctx.hint`/命令闭集）是可选锚点，不是默认写法。
- 控制流仍是脚本：分支是 `if`，循环是 `for`，重试是 `while`，子流程是函数；只用于真实业务分支，不用来手写引擎已能决策的选元素逻辑。
- 引擎只负责“一步之内”：元素池、目标解析、闸门、动作、完成信号、证据。
- 完成只认 `ctx.step(..., { done })` / `ctx.arrive(..., { done })` / `ctx.done()` 的信号；
  人工步用 `ctx.manual(desc, { done, instructions?, id? })`，`{manual:true}` 是人自证，
  DOM 信号会在人确认后再验一遍。
- `meta` 只描述应用级事实：允许的主机、槽位、站点角色、策略、节奏、结束态不变量、血统。
- 应用目录里不再有 `pack.json`，不再有 `@amberflow:declarative-data`，不再有 `flow.json` 语义模板。

**不存在**“按步骤序号定位/编辑流程”的接口。脚本没有静态步骤表，步骤是运行期事实；
调试靠 `ctx.step` 的 `id`、dry-run 调用序列、trace 和执行预算。

---

## 1. 作者与调试回路

```text
apps list → app_show（路径 + 当前源码）→ 编辑 app.mjs
          → app_check（加载 + dry 调用序列校验）
          → inspect（看真实页面，给 hint 候选）
          → explain（dry 调用序列）
          → run --max-steps 1 --trace（执行预算，拿结构化反馈）
          → run（完整运行）
          → test（回归）
```

- `app_check` 不打开浏览器：它证明的是“脚本能加载、调用序列合法、信号/命令/槽位可校验”，
  不证明页面状态会成立。**dry 会真实执行 flow 脚本体**：浏览器调用被合成、不访问网络，
  但脚本自身的文件/进程副作用会真的发生（check 输出带一行提示；JSON 面 `data.dry_semantics`）。
  脚本两面判据用 `ctx.runtime.dry`（dry/replay `true`、真跑 `false`）；`epoch === 0` 不作 dry 判据。
  `app_create` 的骨架含「卡点→能力」cookbook 速查段；会话内实时观察用 `ctx.observe()`。
- `inspect` 只读：标题、URL、有界元素、候选 hint；`--json` 另带只读的可访问性树证据块 `ax`（浏览器 AX role/name/focusable/disabled + `not_in_pool` 近似口径，不进池/匹配/模型/运行路径）；不点击、不输入、不调模型。**inspect 是独立一次性会话**（新开浏览器、不 attach 运行会话）——会话内实时看当前页用应用内 `ctx.observe()`。
- **learn 录制 hint vs inspect 候选**：learn 的 `hint` 是六形状闭集、属性白名单只认 `test`（→data-test）/`type`/`aria-label`；inspect 的 `hint_candidates` 是引擎经同一个 `hintMatch` 自证过的可照抄结果（输出的就是六形状之一）。inspect 候选可直接抄进 act/learn；自己挑的属性先过白名单。
- `run --max-steps N` 是**执行预算**，不是“从第 N 步开始”：脚本按自己的控制流执行，
  用满预算时以 `budget_exceeded` 停下，结果带已执行步骤与 trace。
- `run --trace` 把每个 `ctx.step` / `ctx.arrive` 的 `id`、`desc`、URL、结果带进 JSON。
- 失败看 `steps[]` 的第一条失败、`failure`、trace 里第一次 `ok:false` 的 `stop_code/reason`；
  再改 `app.mjs`。没有“只改第 7 步”的旁路——脚本版本就是唯一的流程版本。

脚本里给调试提供两个稳定锚点：

```js
const r = await ctx.step("提交订单", {
  id: "submit-order",                 // 稳定标识，进 trace / steps[] / failure
  done: ctx.judge.url("thanks"),      // 目标/动作由引擎决策
  // act: ctx.hint("button[type=submit]"),  // 可选锚点：只有需要收窄候选时才写
});
if (!r.ok) ctx.fail(r.stopCode ?? "step_failed", r.reason);
```

- `id` 缺省时 trace 仍按执行序号记录，但跨版本对比不稳定；作者接口建议每步给 `id`。
- `ctx.fail(code, reason)` 抛结构化 `StopError`，退出码/状态走引擎既有分类，不抛裸栈。
- 人工步：`const m = await ctx.manual("登录并完成 2FA", { done: { manual: true }, instructions: "..." });`
  非 TTY 且没有注入人工处理器时返回 `stopCode="needs_human"`，不拉有头浏览器；
  TTY 下提示人完成后继续。`meta.pace` 的步/动作间隔由运行器应用。

---

## 2. CLI 契约

CLI 的 `--json` 输出仍是统一 envelope（`schema_version / command / ok / code / data / next / error`）。
以下是 `data` 的关键字段。

### `amber apps list --json`

```json
{
  "apps": [
    {
      "id": "my-app",
      "label": "我的应用",
      "goal": "一句话目标",
      "path": "/root/.amberflow/apps/my-app/app.mjs",
      "source": "user",
      "kind": "flow",
      "invariants": 2,
      "hosts": ["shop.example.com"],
      "error": null
    }
  ],
  "counts": { "total": 1, "user": 1, "builtin": 0 }
}
```

加载一个脚本会 import 它（用户作用域代码，这是既定信任边界）；列表不启动浏览器、不调模型。

### `amber apps show <id|app.mjs> --json [--code]`

```json
{
  "app": "my-app",
  "label": "我的应用",
  "goal": "一句话目标",
  "path": "/root/.amberflow/apps/my-app/app.mjs",
  "source": "user",
  "script_sha256": "…",
  "plan_sha256": "…",
  "hosts": ["shop.example.com"],
  "slots": { "coupon": "SAVE10" },
  "required_slots": ["coupon"],
  "sources": [],
  "invariants": [{ "id": "on-thanks", "desc": "结束时在感谢页", "signal": { "url_contains": "thanks" } }],
  "policy": {},                           // 可选：只在 meta 声明时出现
  "pace": { "between_steps_ms": 200 },    // 可选：只在 meta 声明时出现
  "code": "export const meta = …",
  "code_truncated": false
}
```

`path` 是唯一可写位置；`code` 只有 `--code` 时返回（桥总是要，便于 Agent 直接看见当前版本）。
`script_sha256` / `plan_sha256` 是“这次改的是哪一版”的版本锚点。

### `amber apps check [<id|app.mjs>] --json`

```json
{
  "checked": 1,
  "ok": false,
  "results": [
    { "app": "my-app", "path": "…/app.mjs", "problems": ["ctx.step: done signal is required"] }
  ]
}
```

退出码 2 = 有问题；0 = 全部通过。`problems` 带脚本路径/行号（能取到时）。

### `amber apps explain <id|app.mjs> --json`

```json
{
  "app": "my-app",
  "goal": "…",
  "path": "…/app.mjs",
  "script_sha256": "…",
  "plan_sha256": "…",
  "problems": [],
  "events": [
    { "i": 1, "call": "open", "desc": null, "url": "https://shop.example.com/", "ok": null },
    { "i": 2, "call": "step", "id": "add-to-cart", "desc": "加入购物车", "url": "…", "ok": true }
  ],
  "invariants": [{ "id": "on-thanks", "desc": "…", "signal": {}, "done": "…" }]
}
```

`explain` 是 dry 跑一遍脚本，不开浏览器、不调模型；它展示的是**这一版脚本的调用序列**。

### `amber run <id|app.mjs> --json [--dry-run] [--trace] [--max-steps N]`

`data` 包含 `toAgentRunView` 的稳定字段：

```json
{
  "schema_version": 1,
  "ok": true,
  "status": "passed",
  "verified": true,
  "partial": false,
  "completed": "3 step(s) via flow(ctx)",
  "steps": [{ "index": 1, "id": "open-home", "desc": "打开首页", "status": "done" }],
  "truncated": false,
  "failure": null,
  "invariants": { "held": 2, "total": 2, "failed": [] },
  "artifacts": { "out_dir": "…", "result_json": "…", "report_md": "…" },
  "next": ["amber test --tier smoke", "amber apps show my-app"]
}
```

`status`: `passed | partial | failed | blocked | needs_human | dry`（当前运行视图实际会产生这几种；`invalid`/`infra_error` 只用于将来预留，不应作为当前契约使用）。
`verified` 只在完整运行且所有不变量成立时为 true。
`--max-steps N` 用满预算时 `status=partial`、`verified=false`，`steps` 保留已执行事实。
`--dry-run` 不打开浏览器，返回 `status=dry` 和 dry 调用序列。
决策源退化（`data.provider_degraded` 非空）或某步以 `no_model_runtime` 停下时，`stderr` 与
`next[]` 会追加同一条「两条通道」恢复指引（桥 vs CLI 配置面，见 §3.1）。

### 应用创建/删除

```bash
amber apps new <id> --goal "…" --host shop.example.com [--url https://shop.example.com/] [--dir <目录>] [--print] [--force]
amber apps path <id> [--json]
amber apps remove <id> [--yes] [--force]
```

`apps new` 只生成 `app.mjs` 的 flow 骨架；没有 `--kind` / `--format` / step JSON。

### 已移除的 CLI 面

- `amber apps emit`：flow 没有静态 IR 可展开。
- `amber apps set-step` / `remove-step` / `set-invariant`：JSON/序号编辑随声明式流程一起移除。
- `amber run --only-step` / `--from-step`：脚本没有可按序号跳转的静态段。
- `--format pack` / `--kind data` / `--force-hints off` / `AMBERFLOW_NO_SCRIPTS`：
  没有第二种应用格式，也没有声明层可剥。

---

## 3. DSH 桥工具

桥只做三件事：拼 CLI 参数、解析 JSON envelope、投影有界摘要。业务语义仍在 CLI。

| 工具 | CLI | 用途 |
|---|---|---|
| `amberflow_status` | `amber doctor --json` | 环境、浏览器、模型层级、配置来源；缺省含 ask 探针（`data.provider.ask_probe`，一次最小真实 ask，只诊断）；密钥掩码 |
| `amberflow_apps` | `amber apps list --json` | 列出可运行应用 |
| `amberflow_app_show` | `amber apps show --json --code` | 路径、元数据、当前源码、版本锚点 |
| `amberflow_app_check` | `amber apps check --json` | 加载 + dry 调用序列校验 |
| `amberflow_inspect` | `amber inspect --json` | 只读页面观察（含 `ax` 可访问性证据块）与候选 hint |
| `amberflow_session` | `amber session` | 跨工具调用保持页面状态的交互式试错会话（`open/observe/act/read/extract/signal/wait_for/snapshot/close/list`）；不判完成、不写 run 结果；`act` 缺省歧义零动作（见下） |
| `amberflow_app_create` | `amber apps new … --json` | 生成 flow 骨架 |
| `amberflow_run` | `app-runner`（与 `amber run` 同一运行器） | 运行；**桥用部署配置**决策三件套；`max_steps` 是执行预算，`timeout_sec` 是本次墙钟上限；决策通道故障时结果带恢复指引 |
| `amberflow_learn` | `learn --json` | 一次录制 → 归纳信号 → 生成 `app.mjs` flow（回放门通过才落盘） |
| `amberflow_test` | `amber test … --json` | 真实站点回归；`max_steps` / `timeout_sec` 与 CLI 对齐 |

**不再提供** `amberflow_plan`、`amberflow_app_set_step`、`amberflow_app_set_invariant`、
`amberflow_app_remove_step`。Agent 用文件系统读取/编辑 `app.mjs`；桥不写任意代码。

`amberflow_run` 参数：

```json
{
  "app": "my-app",
  "dry": false,
  "trace": true,
  "max_steps": 3,
  "timeout_sec": 1800,
  "no_sources": false,
  "headful": false,
  "allow_dangerous": false,
  "confirm_safe": true,
  "tiered_hint": false,
  "ablate": null,
  "provider": null,
  "slots": { "coupon": "SAVE10" }
}
```

移除 `site`（没有语义模板门）、`only_step`、`from_step`。

`amberflow_run` 的墙钟上限由桥自己执行（不是引擎 CLI 旗标）：缺省 900 秒（部署配置
`timeoutMs`，15 分钟——真实站点流程本来就慢）；`timeout_sec`（整数，1–7200）只对本次调用
覆盖。超时或被杀的运行通常没有 result/report 工件，桥会在本次 outDir 落盘
`run-killed.json`（app、timedOut、exit_code、killed_at、timeout_ms、stdout/stderr 尾部与
note），并让错误消息引用该路径——已完成步骤的证据至少在目录被 prune 之前可查一次（该文件
与 outDir 一起被 `keepRuns` 清理，prune 策略不因此改变）。长流程（deep 层级、多页）应调大
`timeout_sec` 或拆成小应用，而不是默认在 15 分钟被杀。

`amberflow_test` 参数：

```json
{
  "action": "run",
  "tier": "deep",
  "case": "saucedemo-checkout",
  "site": "saucedemo",
  "headful": false,
  "require_all": false,
  "max_steps": 8,
  "timeout_sec": 60
}
```

`--headful` / `--headless`、`--out`、`--provider`、`--max-steps`、`--timeout` 与
`amber run` 同名同义；`--validate` / `--list` / `--dry-run` / `--tier` / `--case` /
`--site` / `--require-all` 是测试套件专属。

`amberflow_session` 的 `act` 参数（A2 歧义策略）：

```json
{ "op": "act", "session_id": "s-…", "act_op": "click", "target": "关闭",
  "on_ambiguous": "fail" }
```

`on_ambiguous`（`fail` | `act`，缺省 `fail`）：目标 hint 命中多个**不同**候选时——`fail` = **零动作**，
返回 `{ok:false, code:"target_ambiguous", executed:false, ambiguity}`；`ambiguity` 是有界证据
（候选 ≤5；label/class/near ≤40、ref/tag ≤16、`suggested_hint` ≤80；另有 `would_act_ref`/
`candidates_total`/`truncated`；`source:"dom_fallback"` 时不给 near/suggested_hint）。判据与
`amber run` 命令步的 `target_ambiguous` **同一份**（`hintCandidates` 非空 && `decided === null` &&
`refs.length > 1`），**run 面不受影响**。`act` = 恢复旧行为（直接执行可行动优先的第一个候选），
仅在复现旧流程/候选确知等价时用。歧义**只停不选**：用 `observe` 的 `hint_candidates` 收窄 `target`，
或显式 `on_ambiguous:"act"` 重放——都是人的决定；桥不据此猜测，也不自动重试。

`amberflow_session` 的 `act` 失败现场（B1）：

- `click`/`check` 的被遮挡证据由动作本身给出（探针即点击，无双点）：被覆盖约 0.8s 返回
  `{ok:false, code:"not-actionable-or-covered", actionability:{reason,bbox,blocker,requery}}`；
  探针超时且中心点无覆盖者、5s 重试仍失败 → `code:"action-timeout"` + 同一份 `actionability`。
  非 timeout 异常**不补点**：URL 已变则按已点击返回 `how:"clicked", probe_navigated:true`，否则
  `action_failed`。两个 code 都是既有 skip_reason 词面，不新增 stopCode。
- `screenshot:true`（缺省 `false`）：只在失败时写 `<evidence_dir>/act-<n>-failure.png`，结果只回
  `screenshot_file`。桥对 `actionability` 做有界透传（reason≤200、blocker/requery≤60、bbox 数值），
  模型可见的失败行在 `actionability` 存在时追加 `blocked by <blocker> (requery=…)`。

`amberflow_session` 的 `act` 落空判别（A4）：

- `target_not_found` 现在带 `diagnostics`（有界事实，不猜）：`target`/`pool_size`/`hint_shape`/
  `hint_len` + `candidates[]`（池内同档候选，≤5）/ `near[]`（池内词面近似，≤5，带 `why`）/
  `rejected[]`（池外回退扫描到但不可见，≤3，`why:"not visible"`）；`reason` 末尾另有一行
  `判别: …`（主 reason 前缀与停因码不变）。桥只做有界透传（candidates ≤3、near ≤3、
  rejected ≤2、label ≤40），模型可见的失败行追加一行
  `no match: hint <shape>/<len> pool <n> — near: tag "label" …`。
- `candidates` 用 `hintCandidates` 的 quiet 读法（`diag:false`）——**不污染** `ambiguous`/
  `matched_others` 回显；`near` 是纯内存前缀/包含（token 来自同一个 `parseHint`，不扩语法）；
  `rejected` 只对既有池外回退扫描的 ≤5 行做一次可见性判定。成功路径与非落空失败键集不变，
  run 面/命令步不传该开关，行为与产物逐字节不变。

`amberflow_session` 的 `act_op:"scroll"` 语义（B2）：

- 带 `to`（`bottom`|`top`|`page`）或 `by`（像素） = **容器滚动**：目标元素自身或**最近可滚动祖先**
  滚到方向/像素（`by` 优先于 `to`；与 `ctx.scrollList`、run 的 `scroll` 命令**同一条实现**）。元素与
  祖先都没有可滚动容器 → `{ok:false, code:"not_scrollable"}`（不是静默无操作）。
- 不带 `to`/`by` = **滚入视口**（旧语义，`scrollIntoViewIfNeeded`）。
- 两种都带引擎**实测**的 `moved`（滚动容器 `scrollTop` 前后差非零）、`delta`、`scroll`
  （`{scrollTop,scrollHeight,clientHeight}`，三个都在才出现），且 `changed === moved`——
  桥只透传、不重算。`--record` 轨迹只记实际发生的事实（滚动没走通不记 `to`/`by`；另记
  `scroll_mode`/`moved`/`delta`/`scrollTop`，`session export` 按 `scroll_mode` 还原）。
- **run 面不受影响**：命令步 `ctx.command("scroll", sel, {to})`、`ctx.scrollList`、`scrollDocument`
  的语义与产物逐字节不变。

`amberflow_session` 的 `extract` 分页与落盘（C1）：

- **`count` 是本页返回行数，不是总数**（旧语义不变）；分页用 `offset`（0-based 整数 0..10000，
  非法 = `config_error`）。引擎在 `capped` 或 `offset>0` 时给 `offset`/`total`/`has_more`
  （`has_more = offset+count < total`）——把 `offset` 加上本页 `count` 续页，`has_more:false` 即到底。
  `offset=0` 且未 cap 时响应键集与之前逐字节一致。
- **`save:true`** = 桥内翻页取全并落盘：每页 ≤500 行、硬顶 **2000 行 / 4MB**，文件
  `<evidence_dir>/extract-<n>.json`（n = 本会话落盘序号），结果带 `file`/`saved`/`bytes`；
  被硬顶截断时如实给 `truncated:true` + `save_limit`（`max_rows`|`max_bytes`）。`rows` 仍只给
  首页 ≤20 行。
- **`observe` 没有 offset**：元素序随水合/动画变化，无稳定锚——收窄用 `selector`、放宽用
  `max`（≤200），全量元素用 `snapshot`（`pool-<n>.json`）。模型可见渲染只在溢出时多两行
  （observe：`… +N more (M total, K omitted)` + selector/max/snapshot 指引；extract：
  `… +N more` + `total=T · offset=… 续页 · save:true → extract-<n>.json`），无溢出时输出不变。

`amberflow_session` 的 `extract` 选择器错误（C2）：

- 非法行/字段选择器不再被静默吞成 `[]`/`""`：引擎 `amber session` 的 extract 响应为
  `{ok:false, code:"config_error", error:"bad_selector", reason, diagnostics:{bad_selector:{selector, field?}}}`
  （与 `observe` 的 `error:"bad_selector"` 同一口径；停因码仍是 `config_error`，**不新增**）。
  桥按既有失败投影透出 `code` + `reason`（≤1000，点名行选择器还是哪个字段）+ `error:"bad_selector"`
  （引擎给才有）；`diagnostics.bad_selector` 留在 CLI 会话协议与 run 结果里。**合法但零命中仍是
  `rows:[]` / 字段 `""`**。
- 引擎在 `readRows`（`extract` 与 `collect` 的唯一实现）入口做一次 Playwright
  `locator(sel).count()` 预检（行 + 每个字段，除 `.`/`:scope`/`@attr`），真跑/会话多
  ≤1+字段数 次往返；只有**解析错误**才报（掉帧/超时维持旧行为）。dry 与 replay 不访问浏览器、
  不预检（`apps check` 不受影响）。
- 同一入口替换掉 `ctx.collect` 旧的 `document.querySelectorAll` 预检——Playwright 伪类
  （`:has-text(...)` 等）不再被误拒。

`amberflow_session` 的信号校验报错（C3）：

- 引擎 `amber session` 的形状失败仍是 `{ok:false, code:"config_error", problems:[…]}`，但 `reason`
  现在带**合法形态**提示（叶 `{op:[arg…]}` 按位置放数组；组合 `all_of`/`any_of`/`not`；对象形
  `{selector,text}` 非法），与 CLI/加载期同一出处（`src/engine/signals.ts` 的 `SIGNAL_SHAPE_HINT`）。
  `problems` 数组原样保留，调用方不用再拼提示；桥的失败投影给 `code` + `reason`（含同一份提示），
  `problems` 留在引擎会话响应里。

### 3.1 决策通道：桥 vs CLI（A5）

同一份决策三件套有两个注入面：**桥通道**（DSH 插件配置页 → 桥注入子进程环境变量，部署配置，
最高优先）与 **CLI 直跑**（本机用户配置层叠）。两条面喂进同一个装配路径，所以"桥能跑、CLI 直跑
401/403"不是引擎分叉，而是凭据不同。完整矩阵与 403 判读见
[docs/DECISION_SERVICE_CONFIG.md](DECISION_SERVICE_CONFIG.md) §7。

- `amber doctor` **缺省**对在线决策源（`AMBERFLOW_DECISION_BASE_URL` 存在时）发一次最小 ask
  探针；`--no-ask-probe` 关闭。JSON 在 `data.provider.ask_probe = {ok, provider, ref?, conf?, error?}`
  （失败不影响 doctor 的 ok/退出码）。
- 运行结果里 `provider_degraded` 非空、或有步以 `no_model_runtime` 停下时，CLI/桥的
  `stderr` 与 envelope `next[]` 追加同一条指引：

  > 本机若通过 DSH 桥运行：改用桥工具 amberflow_run（桥使用部署配置）；或 amber config set
  > AMBERFLOW_DECISION_* 更新用户配置（见 docs/DECISION_SERVICE_CONFIG.md）

- 指引**只提示、不自动切换**，也不含任何密钥。走桥的场景请优先用 `amberflow_run`：桥注入的是
  部署配置，CLI 直跑读的是另一份用户配置。

---

## 4. 职责边界

| 层 | 负责 | 不负责 |
|---|---|---|
| Agent | 目标、脚本、目标 hint、完成信号、控制流、下一步编辑 | 完成裁决、安全闸门、浏览器生命周期、证据格式 |
| 引擎 | `checkSignal` 完成真值、风险/危险闸门、动作、trace、预算、清理 | 替 Agent 猜流程、静默补步骤、自报完成 |
| 桥 | 参数适配、JSON 解析、有界摘要 | 重新实现参数语义、编辑应用源码 |

危险工具步仍然是：干跑 → 人工确认 → 执行；默认拒绝。人工步不自动过；非 TTY 返回 `needs_human`。
Agent 不能自己确认危险动作；确认必须来自部署配置或人类。`meta.pace` 只降低请求频率，
不是反爬对抗。

### 4.1 救援中断（result.rescue，v1）

- `result.rescue` **只在真实求援出现**；权威形状句（逐字来自 `schema-gen.ts` 的
  `RESCUE_RESULT_SHAPE_TEXT`，prompt-hit doc 组闸门，勿手抄改写）：

  > result.rescue 只在真实求援出现：{kind, mode:'stop'|'suspend', why_stuck:{summary(≤400字zh), stop_code?, step_id?}, what_would_unblock[≤3]}；stop = 序列化进结果，suspend = 调用栈内等待（必须显式）；其余运行产物逐字节不变

  Agent 读到它时应把 `why_stuck.summary`（zh 权威）与 `what_would_unblock` 如实转述给人，
  不要自己编下一步。
- v1 三 kind：`action` / `value` / `authorization`（谁能修分别为人操作 / 人供值 / 人授权）；
  零新增停因——只复用 `needs_human` / `needs_value` 等既有停因，schema 见
  `amber schema ctx --topic intervention`。
- 机器层 `agent_hint`（en，`{fact, recommended_action, stop_condition}`）经桥生成物
  `RESCUE_AGENT_HINTS` 分发——面向模型的事实/建议/停手条件，不是给人看的翻译。
- 影子开关权威句（逐字来自 `schema-gen.ts` 的 `RESCUE_SHADOW_SWITCH_TEXT`，prompt-hit doc 组闸门）：

  > 影子开关 AMBERFLOW_RESCUE_SHADOW=1：影子期只构造求援请求 + 计算结局写 sidecar（rescue-shadow.json），不调任何交互通道、旧路径权威、默认产物零字节不变；其余值一律视为关

  设计出处 `docs/INTERVENTION_RESCUE_MODULE.md`。

---

## 5. 验证

- 作者回路用用户作用域临时应用验证：`new → check → explain → run --dry-run → run --max-steps`。
- 完整运行用真实站点（`online/` 或临时应用），证据写仓库外。
- 桥验证：重建 `integrations/dsh-bridge`，由子代理只通过 `amberflow_*` 工具完成
  “inspect → app_create → 编辑 app.mjs → app_check → run” 的端到端流程。