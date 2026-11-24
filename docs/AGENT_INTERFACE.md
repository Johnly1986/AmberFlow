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
- `inspect` 只读：标题、URL、有界元素、候选 hint；`--json` 另带只读的可访问性树证据块 `ax`（浏览器 AX role/name/focusable/disabled + `not_in_pool` 近似口径，不进池/匹配/模型/运行路径）；不点击、不输入、不调模型。**inspect 是独立一次性会话**（新开浏览器、不 attach 运行会话）——会话内实时看当前页用应用内 `ctx.observe()`。元素行带 `frame_origin`/`frame_path`（帧链）；`hint_candidates` 在多 frame 同名场景会给 `<label> frame:<origin>` 或 ≤4 段完整链候选，同文案重复组会给 `<label> in-row:<token>` 行锚候选（F82），内容不可分网格会给 `<label> row-index:N` 顺序行锚候选（F83）；`structure_path`（若出现）只是诊断证据（`structure_unstable:true`，动态页面可能失效）——**不是 hint，不可照抄**。
- 走查（写应用前把流程走通）：四种走查面见 `docs/APP_SCRIPT_AUTHORING.md` §0.5——探针链 /
  plan 面草稿 / `amber run --walk` / `amber session` 的 drive 系列 op（模型驾驶 + Agent 兜底；
  协议与交接块见 §3.3；桥面走查入口已收敛到 `amberflow_session`）。pilot 产物带 `pilot:true`，
  **走查通过 ≠ 应用通过**；走通后用 `amber session export`（会话 `--record` 轨迹）出 app.mjs 骨架，再补 done/slot 走正式
  `amber run`。
- **learn 录制 hint vs inspect 候选**：learn 的 `hint` 是六形状闭集（可带 `within:#id` / `frame:<origin>` / `in-row:<token>` / `row-index:N` 尾缀，同一 `parseHint`）、属性白名单只认 `test`（→data-test）/`type`/`aria-label`；inspect 的 `hint_candidates` 是引擎经同一个 `hintMatch` 自证过的可照抄结果（输出的就是六形状之一；跨帧同名时可能是 `<label> frame:<origin>` / ≤4 段链，同名组可能是 `<label> within:#id`，同文案重复组可能是 `<label> in-row:<token>`，内容不可分网格可能是 `<label> row-index:N`）。inspect 候选可直接抄进 act/learn；自己挑的属性先过白名单。
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
| `amberflow_session` | `amber session` | 跨工具调用保持页面状态的交互式试错会话（`open/goto/observe/act/read/extract/signal/wait_for/snapshot/tab/drive/drive_command/drive_status/drive_close/close/list`）；不判完成、不写 run 结果；`act` 缺省歧义零动作；`drive` 系列在**同一 page** 上跑 pilot 驾驶（`pilot:true`/`attached:true`，见下） |
| `amberflow_app_create` | `amber apps new … --json` | 生成 flow 骨架 |
| `amberflow_run` | `app-runner`（与 `amber run` 同一运行器） | 运行；**桥用部署配置**决策三件套；`max_steps` 是执行预算，`timeout_sec` 是本次墙钟上限；决策通道故障时结果带恢复指引 |
| `amberflow_learn` | `learn --json` | 一次录制 → 归纳信号 → 生成 `app.mjs` flow（回放门通过才落盘） |
| `amberflow_test` | `amber test … --json` | 真实站点回归；`max_steps` / `timeout_sec` 与 CLI 对齐 |

**不再提供** `amberflow_plan`、`amberflow_app_set_step`、`amberflow_app_set_invariant`、
`amberflow_app_remove_step`。Agent 用文件系统读取/编辑 `app.mjs`；桥不写任意代码。

工具描述约定（82 条 description 的产品口径，由 `npm run prompt-hit` 的 bridge_desc 组观测）：目标先行——首句 ≤120 字符说明「何时用 + 做什么」；总长目标 ≤600 字符（硬上限 800）；`*_<name>` 参数前缀约定只在 `amberflow_app_check` 描述里声明一次，其它工具不重复；`amber <cmd>` 必须存在于 registry；不写站点/业务专名。

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
（候选 ≤5；label/class/near ≤40、ref/tag ≤16、`suggested_hint` ≤200（B 批：可容 4 段
`frame:` 链）、候选另有 `frame_origin`（≤60，引擎给才有）；另有 `would_act_ref`/
`candidates_total`/`truncated`；`source:"dom_fallback"` 时不给 near/suggested_hint）。判据与
`amber run` 命令步的 `target_ambiguous` **同一份**（`hintCandidates` 非空 && `decided === null` &&
`refs.length > 1`），**run 面不受影响**。`act` = 恢复旧行为（直接执行可行动优先的第一个候选），
仅在复现旧流程/候选确知等价时用。歧义**只停不选**：用 `observe` 的 `hint_candidates` 收窄 `target`
（多 frame 同名时优先用 `<label> frame:<origin>` / 完整链候选），或显式 `on_ambiguous:"act"`
重放——都是人的决定；桥不据此猜测，也不自动重试。

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
- F72（重水合补偿）：落空响应 additive 两面——①步首 settle 未静默（timedOut）时 `diagnostics`
  多 `settle_timed_out`/`settle_waited_ms` 两键、`reason` 尾缀一行渲染提示（"可能仍在水合/渲染，
  建议 wait_for 锚定后重试"）；②显式 opt-in `rehydrate_rescan:true`（桥参数 / 单行请求字段
  `rehydrateRescan`）在 hint 真落空且页面未静默时等 2s 重抽池重解析同一 hint（至多 1 次）：
  命中 = 成功响应带 `resolved_via:"rehydrate-rescan"`；仍未命中 = 原停因不变 + `diagnostics.rescan`
  （`{waited_ms,pool_size}`）。缺省关 = 键集与 reason 逐字节不变。
- F6（歧义/落空的宽扫回传）：`target_not_found` / `target_ambiguous` 停因时响应 additive 带
  `wide_scan`（其它停因不出键）——引擎**一次**有界宽扫（≤128）的全量候选
  `{ref, tag, label, hint?}`；`hint` 经引擎同一 `hintMatch` 自证"恰好唯一命中"才给出（引擎不自造
  词面，生成不出自证候选的行如实缺键）。**零动作**：宽扫不点击、不滚动、不重试——看完再决定
  是人的决定。桥对它做有界透传：candidates ≤40 行、带 hint 的行优先、tag ≤16/label ≤40/
  hint ≤200，完整口径由 `pool_size` 如实表达；模型可见的失败行追加一行
  `wide-scan: <n> candidate(s) (<m> with hints, showing <k>)`。

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
- **`save:true` 的内部续页同样受 `offset` 上限约束**：桥用 `offset+本页行数` 发下一张
  `extract` 请求，引擎上限 `offset ≤ 10000` 不因 save 放宽、桥也不 clamp——请求起点 > 8000
  且数据未到末页时，续页会越过 10000 并以 `config_error` 收尾（2000 行硬顶本身触不到该上限）。
  需要更高起点时从更低 `offset` 分段落盘，或收窄 `rows` 选择器。
- **`observe` 没有 offset**：元素序随水合/动画变化，无稳定锚——收窄用 `selector`、放宽用
  `max`（≤200），全量元素用 `snapshot`（`pool-<n>.json`）。模型可见渲染只在溢出时多两行
  （observe：`… +N more (M total, K omitted)` + selector/max/snapshot 指引；extract：
  `… +N more` + `total=T · offset=… 续页 · save:true → extract-<n>.json`），无溢出时输出不变。

`amberflow_session` 的 `extract` 懒渲染稳定读（F89）：

- **双指标稳定门缺省开**：行数 AND 空行数（一次 evaluate 同时拿两个数）连续 2 轮相等才算
  稳定，与滚动稳定判定共用同一个轮询循环（600ms × 至多 5 轮窗口）——懒渲染页的行数可以先
  稳定（骨架已挂载）而内容还在灌，只看行数会提前放行。响应 `settled` **恒出现**（缺省路径）：
  稳定 = true；窗口内仍在变 = false（抽取照常发生——读到的就是此刻事实，不无界等）。
  `blank_rows` 恒带（本页全空字段的行数；settled:false 时以全帧 rowStats 为准）。
- **`wait_settled` 请求级口径**：缺省不传 = 缺省门运行；`true` = 冗余兼容；`false` =
  **opt-out**（跳过双门，回到旧的行数单指标判定）——opt-out 与 `settle:"off"` 时 `settled`
  **缺席**（无门无证据，绝不谎报稳定）。桥对三个键做有界透传（引擎有才有）。
- 模型可见渲染：`settled:false` 或 `blank_rows>0` 时追加一行
  `lazy-render: blank_rows=<n>, settled=<b> — rows may still be hydrating; re-extract or read settled`。
- 离线锚：`fixtures/engine/hydrate-delay.html`（`?delay=ms` 参数化）三路径——缺省（水合在
  稳定窗口内）行内有值 + settled:true；opt-out（窗口外）空值 + blank_rows>0 + settled 缺席；
  静态页 settled:true（双门首轮即稳 ≈ 零额外等待）。

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

`amberflow_session` 的读侧帧限定（E4）：

- `read` 的 `selector` 与 `extract` 的 `rows` 可尾缀 `` ` frame:<origin链>` ``（与 hint 尾缀同一
  校验：`>` 分隔外→内、≤4 段、http(s) 规范 origin）；**值不合法 ⇒ 整串按原 CSS 处理**（显式
  落空，绝不半剥；E7 起另带引号/括号平衡守卫与空值拒因——纯 CSS 的该形态此前必然非法，
  `text=` 等非 CSS 引擎的作者需显式引用，含未闭合引号/括号的串会被守卫拒绝）。声明帧不在
  hosts 信封/不存在 → `read` 返回 `value:null`、`extract` 返回 `rows:[]`（**不抛** frame_not_allowed；
  引擎 trace 事件附 `frame_evidence`={declared,excluded,scanned} 证据）。带尾缀的 rows 与信封同
  口径（被排除帧不读）；`fields` 字段选择器是行内相对寻址、不支持尾缀。会话合同零变化：响应
  形状与无尾缀时一致（只回 null/miss）。
- 信号（`signal`/`wait_for`）的 css_* selector 同样支持尾缀（E4/F71）；done/when 的升级语义
  （声明帧指向被排除帧 → `frame_not_allowed`）只在 run 面生效，会话信号仍只回布尔。

`amberflow_session` 的信号校验报错（C3）：

- 引擎 `amber session` 的形状失败仍是 `{ok:false, code:"config_error", problems:[…]}`，但 `reason`
  现在带**合法形态**提示（叶 `{op:[arg…]}` 按位置放数组；组合 `all_of`/`any_of`/`not`；对象形
  `{selector,text}` 非法），与 CLI/加载期同一出处（`src/engine/signals.ts` 的 `SIGNAL_SHAPE_HINT`）。
  `problems` 数组原样保留，调用方不用再拼提示；桥的失败投影给 `code` + `reason`（含同一份提示），
  `problems` 留在引擎会话响应里。

`amberflow_session` 的 `tab` op（F76/F77，P3）：

- `{"op":"tab","tab_action":"list"}`（`tab_action` 缺省 `list`）：枚举当前 browser context 里
  **未关闭**的标签页，返回 `tabs:[{index,url,title,active}]`（TabInfo 形状；枚举序 =
  `context.pages()` 序，0-based）+ 顶层 `active`（active 行的下标）。**免费只读**：不切页、不写
  轨迹、不记动作；列表可以包含 hosts 信封外的页面（与 `ctx.tabs()` 同一判定）。
- `{"op":"tab","tab_action":"switch","match":{…}}`：切到**恰好一个**匹配的标签页。`match` 是
  `{index}` | `{urlContains}` | `{titleContains}`（0-based 序；子串大小写不敏感；多键 AND 收窄）。
  `match` 缺失/空对象/未知键 ⇒ `config_error`（文案同 `ctx-validate.ts`）；0 个或 >1 个匹配 ⇒
  `config_error`（reason 带 `describeTabs` 现场，**不回退随便选一个**）；目标 URL 在 open 时声明
  的 hosts 信封外 ⇒ `host_not_allowed` 且**不切换**（与 `ctx.switchTab` 同一判定）。命中后引擎
  当前页指向目标页（bringToFront 有界 2s + domcontentloaded 有界 5s，均失败不致命——切页事实已
  发生）+ settle；成功返回 `{ok:true, switched:{index,url,title}}`，并写一条 JSONL 动作记录
  （与 `act` 的 record 同一条流；`list` 不写）。`switch` 刷新桥侧 idle TTL（与其它 op 同一记活
  语义），`list` 免费。
- 语义边界：**不迁移不重复 F2 newTab**——`ctx.step newTab`（动作前去重采用/动作开新标签自动
  跟随）语义留在 flow 面；会话 `tab` 只做显式枚举/显式切换（动作打开的新标签页不会自动跟随，
  先 `tab_action:"list"` 确认再 switch）。两个 op 共用同一份 TabInfo 序与信封判定——匹配/校验/
  现场描述复用 `ctx-validate.ts` 纯函数（`switchTabMatches`/`validateSwitchTabMatch`/
  `describeTabs`），不发明第二套匹配语义。桥只做形状校验（isObj + 字段类型 + 键闭集），结果
  透传引擎响应。

- record→export（F81）：`amber session export` 识别 `op:"tab"` switch 行——生成
  `await ctx.switchTab({ urlContains: 落点URL | index })` 原语（URL 子串优先、URL 缺失退
  index、两者都缺=注释块不发明；轨迹只存 from/to 事实，作者按现场核对匹配口径；
  `ctx.switchTab` 自身计 1 个 flow step）。

`amberflow_session` 的 `idle_timeout_ms`（F80，open 专属）：

- `open` 时可传 `idle_timeout_ms`（整数）：**本会话**的桥侧 idle TTL。缺省不传 = 部署管理器缺省
  （`Config.sessionIdleMs`，缺省 300s）——行为逐字节不变；`0` = **不限**（仅显式，reaper 跳过该
  会话）；非整数或 1..999 ⇒ `config_error`（`idle_timeout_ms must be 0 or an integer >= 1000`）。
  **不受部署 `sessionIdleMs` 的 1h 配置帽约束**——那约束的是管理器缺省值的配置面，不是单会话
  显式值。其他 op 传入 ⇒ `config_error`（不静默忽略）。
- 引擎子进程**原样跟随**（F80 评审修正）：显式 `0` ⇒ 子进程 `--idle-timeout-ms 0`（真·不限，
  仅靠 stdin EOF 退出兜底）；显式 `>0` ⇒ `min(24h, max(600s, 2×ttl))`（仅孤儿兜底，且不越
  CLI 的 24h 帽）；缺省不传 ⇒ 子进程 600s（spawn argv 逐字节不变，回归不变量）。
- 回显：`op:"list"` 每行 additive 回显生效值 `idle_timeout_ms`（显式 0 回显 0）；`open` 响应的
  `idle_ttl_ms` 同口径回显本会话生效值（缺省不传 = 管理器缺省，不变）。

`amberflow_session` 的 `goto` op（受控导航）：

- `{"op":"goto","session_id":"s-…","url":"…","timeout_ms?":…}`：受控导航——**与 open 同一条实现**
  （引擎 `CtxRuntime.navigate` 单一判定：hosts 信封前置检查 → goto(domcontentloaded) →
  `unreachable`/`config_error` 结构化分类 → 落地检查（302 跨主机 = `host_not_allowed`））；
  导航纪律缺省沿用会话 hosts（会话无 meta，entry-only 闸门对会话面恒放行，与 open 同口径）。
  **不带 referer 参数**：同源导航浏览器按自身策略自动带 referer；跨源 goto 携带旧页 referer
  无收益——桥/引擎都不发明 referer 语义，保持裸 goto 形态。
- 成功返回 `{ok:true, op:"goto", session_id, url, title?, hosts}`（与 open 同形；桥同步
  state.url/title，tab list/会话清单显示新页）；task-38 flap 监听与有界自愈对 goto 同样生效——
  判定 flap 时响应带 `code:"navigation_flapping"` + `navigations/window_ms/urls_sample/healed/
  heal_url?` 诊断组（自愈失败 = `ok:false` 结构化透传）。`timeout_ms` 为整数 1..120000
  （缺省引擎 30s 帽；越界 = `config_error`，不静默钳制）。
- 轨迹与导出：goto 记 `type:"goto"` 行（`amber session export` 只认 open/mark/act 行，goto 行被
  如实跳过——导出的骨架不含导航步，作者按现场手写 `ctx.open`/`ctx.arrive`）。换日期/换列表页
  从此不用关开会话改 URL（高频开关撞站点风控的动因由此消除）。

`amberflow_session` 的 `drive` 系列 op（pilot 在会话现场驾驶；不新增工具）：

- 定位：`amber session` 子进程是**唯一 host**（一个 browser/page）；`drive` 在该 page 上跑 pilot
  驾驶（`pilot:true`/`attached:true`），与 `act/observe` 共用同一现场——**切换互证**：`drive` 停在
  交接处返回 → Agent 用 `act/observe` 人工补一步 → `drive_command{cmd:"resume",hint?/value?/target?/skip?}`
  继续。不新开浏览器、不重新导航；跨工具调用由 session 子进程保状态。这是 **agent 侧唯一走查入口**；原 `amberflow_pilot` one-shot 工具已移除（独立会话无登录态，易撞登录墙）。
- `{"op":"drive","session_id":"s-…","goal":"…","max_steps?":1..200,"final_signal?":{…},
  "conf_floor?":0..1,"expect_url?":"…","driver?":"model"|"agent","slots?":{"k":"v"}}`：首次调用
  构造附着式 pilot（`ownsSession:false`、`skipStartNavigation:true`、hosts=会话信封、独立 pilot 证据
  目录）并跑一轮驾驶；停在停因交接处返回。`driver:"agent"` = 每步等
  `drive_command{cmd:"resume",hint}` 点名（零模型票），便于本地零模型验收。
- `{"op":"drive_command","cmd":"resume"|"redirect"|"finish"|"abort","hint?","value?","target?","skip?","goal?","url?","note?"}`：
  兜底指令闭集（与引擎 pilot 驾驶协议的兜底指令同一套语义）；`resume`/`redirect` 会继续驾驶并返回
  下一步结果；单行失败 = 结构化回执（顶层带 `reason`）、会话与驾驶面继续。
  `note?` = 指令备注（非空字符串、≤300 字符）：只随该指令记入 pilot 自身 trace/record
  （`out_dir/pilot-trace.jsonl` 的 `command` 行 `args.note`），**不回显**在响应/run 结果里；
  空串或超长 = `config_error`。
  `resume.value` 是字符串时：值的键序 = 显式 `target` → 交接 evidence `needs_value.key`（引擎记录的
  未决目标键）→ 历史兜底 `resumed`；同时带 `hint` 时值跟着 **hint 命中目标** 走（值绑定到该目标的
  键）。对象值（`{"<key>":"<值>"}`）= 多槽并入值袋，语义不变。`needs_value` 交接的
  `what_would_unblock[0]` 给出可直接照抄的 `resume 带 value：{"<key>":"<值>"}` 形状。
- `{"op":"drive_status"}`：只读回显（`status,url,steps,model_asks,out_dir,handoff?`）。
- `{"op":"drive_close"}`：收尾驾驶面（结束 pilot、保留证据；**不关闭宿主浏览器**，session 仍可
  `act/observe/close`）。
- 响应（有界投影）：`{ok, op, session_id, status, stop_code?, url?, steps?, model_asks?, out_dir?,
  attached?, handoff?{step_id,stop_code,goal_digest?,summary,url,what_would_unblock≤3,evidence_refs,
  final_signal?,weak_picks?≤6}, events?≤20}`；**不回**池/候选/槽值/完整 DOM。`session_id` 是三面
  join key；pilot 证据目录经 `out_dir` 给出。
- 结束态可见性（**evidence-only**；不改驾驶行为、不新增停因、不阻断）：
  - `handoff.weak_picks`（可选，≤6；无则键不出现）：`[{step,target,conf,picked_by}]`，只收
    **model 票且 `conf < 0.25`**（文档默认刻度；本次实际闸门刻度见 `conf_floor`）。它只解释
    "这一票低于默认刻度却过了闸"，**不判错**；页面合法变化不产生它（只来自票面，与 DOM 无关）。
  - `handoff.final_signal`：`null` = 本 run **没有声明完成信号**，结束态**未被验证**
    （`budget_exceeded`/`needs_value` **不是**"做完了"）；有声明时为有界摘要。结束态真值仍只认
    `stop_code:"final_signal_held"`（引擎 `checkSignal`）或调用方自己的信号声明。
  - `drive_close.summary.conf_floor`：本次驾驶的**有效闸门刻度**（CLI > provider 自报 > 0.25），
    用来解释 `weak_picks` 的阈值事实。
- **交接不是终态**（`handoff_open`）：停在交接处返回后，再次 `op:"drive"` **不会静默续驾驶**——
  回执是显式拒绝 `{ok:false, code:"handoff_open", reused:true, goal_ignored?, status:"handoff",
  stop_code, handoff_open{step_id,stop_code,goal_digest,…}, next}`，且**不执行任何动作**
  （`steps` 不变、页面不动）。继续这个 run 必须用 `drive_command resume|redirect|finish|abort`；
  换目标 = 起新 session。`reused:true` 只表示"同一 driver 被复用"，**不表示**新 `goal` 被采纳
  （被忽略时 `goal_ignored:true` 显式可见）。
- 终态与拒绝码（`code` 是自由字符串，additive；全部带顶层 `reason`，桥/渲染直接可读）：
  - `drive_terminal` —— driver 已终态（`final_signal_held`/`aborted`/`browser_dead`）：终态后
    `drive` 以及 `drive_command{cmd:"resume"|"redirect"}` 都返回它（`outcome:"stay"` + `stop_code`）。
    `next` = **起新 session** 重新驾驶（同一 driver 不可续）。
  - `budget_exhausted` —— 预算终态（`stop_code:"budget_exceeded"`）后的续驾驶拒绝；保留该专属码
    以便调用方区分「预算用尽」与「其它终态」。`next` = 起新 session 并增大 `max_steps`（或缩小目标）。
  - `drive_closed` —— 已 `drive_close` 终结的驾驶面：`drive`/`drive_command` 均拒绝（`drive_status`
    仍可只读回显、`drive_close` 幂等收尾）；session 本身仍可 `act/observe`，`next` = 起新
    session（或继续用 session 手工步）。
  - `handoff_open` —— 交接未决（`handoff_open` 存在）时再次 `op:"drive"` 的显式拒绝：**不静默
    续驾驶**（旧行为会重放同一交接且不显眼），回执带 `reused:true`、`handoff_open` 回显、
    `goal_ignored?`（请求 goal 未被采纳）与 `next`；继续本 run 用
    `drive_command{cmd:"resume"|"redirect"|"finish"|"abort"}`，换目标起新 session。
  - `config_error` —— 参数形状错（未知 cmd、`hint`/`target`/`url`/`goal`/`note` 空串、`note`
    超 300 字符、`max_steps`/`conf_floor` 越界等）；不消费会话、session 仍可用，`next` = 按
    `reason` 改参数重发。
  - `finish`/`abort` 在终态保持幂等收尾；`finish` 信号不成立 = `signal_not_held` 单行拒绝（顶层
    `reason`），交接保持打开。
- 红线：`drive` 走 pilot face（`default-deny` 危险闸门），session 的 `act/observe` 仍零模型；两者
  共用 page 但不共享 middleware/账本；`drive` 产物恒 `pilot:true`/`attached:true`，不冒充 run 结论。
- 单驾驶员：同一 session 同一时刻只有一个驾驶面；`drive` 停在 handoff 后 `act/observe` 可用
  （人工切换），`drive` 进行中 session 请求天然串行。

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
- **端点原值透传**：配置页的「决策模型 URL」只去掉首尾空白（空 = 不注入
  `AMBERFLOW_DECISION_BASE_URL`），其余**原样**交给引擎；协议推断与端点后缀（`…/v1/systemone`
  / `…/v1/decisions`）只在引擎（`normalizeSystemOneEndpoint` / `normalizeOpenAIDecisionsEndpoint`）
  这一处发生。所以页面填值与 CLI 侧 `AMBERFLOW_DECISION_BASE_URL` 含义一致（见
  [docs/DECISION_SERVICE_CONFIG.md](DECISION_SERVICE_CONFIG.md) §2）；部署面若曾经依赖桥补
  `/systemone`，升级时按该文档 §7.1 显式填完整端点，并**重启已加载的 DSH 宿主**。
  `verify:decision-endpoint-parity` 是这条的 tripwire（同一值两面有效端点必须相同）。

### 3.2 观察面元素投影合同（ElementView）与证据上限

`amberflow_inspect` 与 `amberflow_session op:"observe"` 的元素行共用
`integrations/dsh-bridge/src/element-view.ts` 的**同一份投影合同**（单一出处，schema F54）：同形同义，
只有信封不同——inspect 是一次性无状态面（`url` 入参、顶层 `element_count`/`ax`/`advisories`/`window`），
observe 是会话内状态保持面（`session_id`、`counts={elements,admitted,omitted}`，多帧另有 `frame_counts`，
顶层另有 `ax` 证据块，见下）。

| 字段 | 上限 / 口径 | 说明 |
|---|---|---|
| `ref` | — | 展示/对账锚：inspect=`eN`（池 ref），observe=`oN`（观察序号）。**不是动作地址**；act/read 只认 hint 字符串 / CSS。 |
| `hint_candidates` | ≤6 条 × ≤200 字符 | 每条经同一个 `hintMatch` 自证「恰好唯一命中」，可照抄；跨帧同名时可能是 `<label> frame:<origin>` 或 ≤4 段链候选，同名组可能是 `<label> within:#id`（单层/链），**同文案重复组可能是 `<label> in-row:<token>`（F82 行锚，token 来自该元素 `row_texts` 行词元，仅小写折叠）或 `<label> row-index:N`（F83 顺序行锚——仅内容不可分网格产出：行内容词元全被生成期护栏拒绝时，序号即语义的候选出口）**。 |
| `row_texts`（F82） | ≤6 行 × 每行 ≤40 字符 | 行上下文文本（in-row 匹配底座 + 词元来源）——**仅同文案重复组元素携带**（引擎 observe/inspect 面 dup 门控采集；与 `near` 同触发）。**不进模型面**。F84 批 3：桥 ElementView 投影已收编（`element-view.ts` 白名单两键 + ≤6×≤40 上限）；观察面 dup 判定只对"观察集合内可见同文案计数"执行（max 截断边界）。 |
| `row_index`（F83） | 1-based 正整数 | dup 组内 DOM 先序位次（row-index 匹配底座 + 第 6 档候选序号来源）——**仅同文案重复组元素携带**（帧内同组；无 dup 页不出字段）。**不进模型面**；序号即语义的序漂移责任在作者（组合守卫 `row-index:N in-row:<token>` = fail-safe 主推）。F84 批 3：桥 ElementView 投影已收编（number 透传）。**跨面可移植的前提 = 同名组成员在两个收集面都在场**（池面 `POOL_SEL`+heuristic / 回捞·observe 面 `ADMIT_SEL` 两个元素宇宙不同；照抄 inspect 候选前用 `ctx.observe`/run 复核）。 |
| `label` / `label_truncated` | ≤200（匹配口径 `full_label`） | `href`/`href_full` ≤160；`class_names` ≤8×40；`why_not_admitted` ≤400（词边界截断）；role/id 等短标识 ≤60。 |
| `frame` | 0 = 主 frame | 对应 `frames[]` 下标；observe 多帧另有 `frame_counts:[{index,url,elements}]`（单帧不出现）。 |
| `frame_origin` / `frame_path` | origin 桥 ≤60（引擎歧义证据 ≤120）；path ≤4 段×64 | 帧链底座：`frame_path` 省略 = 主帧；两字段都缺 = 未知 origin 帧（about:blank/srcdoc，不可被 `frame:` 命中）。 |
| `structure_path` / `structure_unstable` | ≤160 | **仅诊断**：inspect 面默认输出（本来就是诊断面）；`ctx.observe({includeStructure:true})` / 桥 `include_structure:true` 时出现。动态页面会失效，**不是 hint、不可照抄**，不进模型面/歧义证据。 |
| `admitted` / `why_not_admitted` | ≤400（词边界截断） | observe 面的准入诊断；截断点落在空白/标点处，`#id` / `[data-test=…]` / `[name=…]` / `role=…` 寻址 token 不从中间切断（token 自身越限时保 token 完整、截其余叙述——唯一可超 400 的情形，仍 ≤ 引擎原文长度）；inspect 面不出现（元素本来就来自池）。 |

- 行数 cap：缺省 60、硬上限 200（inspect 参数 `max_elements`，observe 参数 `max`）；observe 元素硬上限
  200、帧上限 ≤6。缺键 = 该面引擎未提供，桥**透传不补算**。
- `ambiguity`（会话 `act` 歧义停，A2/F55）：`target ≤120`、`source`、`tier`、`would_act_ref`、
  `candidates_total`/`truncated`，候选 ≤5 行（`ref`/`tag`/`role` ≤16、`label`/`class`/`near` ≤40、
  `frame`、`frame_origin`（引擎 ≤120，桥 clip ≤60）、`same_label`、`suggested_hint` ≤200——B 批后
  可容 4 段 `frame:` 链，F82 起可容 `in-row:<token>` 行锚候选，F83 起可容 `row-index:N`
  顺序行锚候选）。`source:"dom_fallback"` 不给
  `near`/`suggested_hint`。判据与 run 命令步
  同一份 `hintCandidates` 谓词，**run 面不受影响**。
- `row_evidence`（run 面动作 trace 行，F83）：声明 `row-index:`/`in-row:` 的目标解析成功后
  additive `{row_index?, row_texts?}`（所选 Elem 实值，字段存在才出现；缺省路径零新字段）——
  事后可审计"点的是哪一行"（row_index 回答第几个成员、row_texts 回答那一行长什么样）；
  事后归因用途见 APP_SCRIPT_AUTHORING §4.13 的 done 断言纪律。
- `ax`（observe 顶层证据块，引擎缺省随观察附带）：与 `inspect --json` 的 `ax` 同一取树实现
  （`src/engine/ax.ts`）同一口径——`{available:true, source:"playwright"|"cdp", interactive_count,
  counts_by_role, interactive_counts_by_role, nodes(≤50), nodes_truncated, total_nodes, pool_size,
  not_in_pool, not_in_pool_basis}`；与 inspect 的唯一差异是 `pool_size`/`not_in_pool` 的对照底座：
  inspect 对照运行池投影 label，observe 对照**本次观察的准入元素**（admitted）label（`not_in_pool_basis`
  随块给出口径原文）。近似口径只用于指出"浏览器认为可交互而观察集合没指向"的信息差，不作
  可点击/存在性断言。取树失败/无 CDP 会话/超时 ≤3s = `{available:false, reason}`，不抛栈、
  不阻断其余观察面；只读证据：不进模型面、不参与 admitted 判定；dry/replay 不访问浏览器 =
  无此键（缺键 = 引擎没给，桥透传不补算）。

### 3.3 pilot 驾驶协议（引擎库面；CLI 入口已移除，agent 面经 `amberflow_session` 的 drive 系列 op）

stdout 纯 JSONL：`started` / `drive` / `handoff` / `command_result` / `pilot_end` 每行一个
JSON 对象（`drive` 行在值键漂移回放步另带 `value_target_drift:{from,to}`——只两个键名，
不含值；无回放则键不出现）；`pilot_end` 只发一条（idle/中断/异常的 `code`/`reason` 并进汇总行），摘要恒含
`steps`/`stop_code`/`conf_floor`/`model_asks`/`rule_picks`/`model_picks`/`handoffs`/`fallbacks`
（laya 档另带 `cache:{hits,misses}`），恒带 `pilot:true`。`conf_floor` 是本次驾驶的**有效闸门
刻度**（CLI > provider 自报 > 0.25），与 `weak_picks`（固定按 0.25 静态阈值筛票面）分工不同：
前者说"闸门实际在哪"，后者说"哪些票低于文档默认刻度"。退出码：0 = `final_signal_held`；
1 = `browser_dead`；3 = 被停因挡住（含 abort / idle 超时）。

驾驶问句 = 总目标 + `当前页: <url>` +（声明了 `--expect-url` 时）`期望页: <子串>` +
`已执行: 1.<label>[changed|no_change|failed]; …`（最近 ≤6 步、每步 ≤40 字）。步史只记
**已执行 + outcome**，不写"已完成"——no-op 点击若被当成进展，模型会复读烧预算。

`--expect-url <子串>`（可选）：每轮驾驶前检查当前 URL 是否包含它；不包含 = 确定性停
`off_task_page`，不继续在漂移页上抽池/问模型。`started` 事件与 handoff 证据都回显
`expect_url`；`started`/`handoff` 证据还回显 `frames_excluded:[{origin,index}]`（被 hosts
信封排除的跨源子 frame）——桥面把它们投影给 Agent，`what_would_unblock` 第一条给出
"把 origin 加入 hosts 后重试"的确定性建议。

stdin 兜底指令闭集（每行一个 JSON 对象；单行失败纪律与 session 同源——坏 JSON/未知/被拒
指令只回执一条错误、继续等下一条，不杀会话）：

| 指令 | 形状 | 语义 |
|---|---|---|
| `resume` | `{hint?, value?, target?, skip?}` | `value` 对象 = 多槽 k:v 并入值袋；字符串 = 单值，键序 `target` → 交接 `needs_value.key`（引擎记录的未决目标键）→ `resumed`（历史兜底；真实标签永不命中它），带 `hint` 时值跟 hint 命中目标走；**值键跨轮漂移**（同控件的抽池 label 形状变了，如首轮 `label="Search Google Maps"`、次轮只剩 `name=q`）不必照最新交接键重发：引擎按 name/id 稳定身份把已给过的值回放到本轮键（池内该身份唯一才回放；身份变了/无法证明则不粘，如实再要值）；`hint` 唯一命中即确定性执行（零模型），撞歧义（多候选签名互异）= `target_ambiguous` 只停不选，落空 = 下次交接 evidence 带 `resume_hint.missed`；`skip:true` 把最近一次驾驶选中的目标加入禁选后继续 |
| `redirect` | `{url? \| goal?}` | 换入口或换目标；步史与禁选清段重新累计，**预算不清零**（预算重置请起新 pilot） |
| `finish` | `{signal}` | 声明最终信号（或复用预声明的 `--final-signal`）；引擎 `checkSignal` 验证成立才记 `final_signal_held`；不成立 = `code:"signal_not_held"` 单行拒绝，交接保持打开 |
| `abort` | `{}` | 终止，落已走轨迹（exit 3） |

`--driver agent`（消融对照臂）：每步投影 `step_request`（有界候选：`ref`/`tag`/`label`/
`hint_candidates`，≤40 行——hint_candidates 经引擎 `hintMatch` 自证唯一命中，照抄进
`resume.hint` 即确定性执行）后等待点名，零模型票；`resume` 无需 open handoff；
`pilot_end` 摘要带 `driver:"agent"`。

危险闸门：每个待执行动作过 `DESTRUCTIVE_PATTERNS` 关键词闭集（单源 rules.ts，与桥
denyDestructive 同源）——命中 = `risk_declined` 结构化失败 + 禁选，绝不静默执行；连续
拒绝达 inert 阈值 = `stuck_inert`；兜底指令闭集里没有 confirm，Agent 无法越过。

桥面入口：**agent 侧走查统一经 `amberflow_session` 的 `drive/drive_command/drive_status/
drive_close` op**（同一 session 子进程/同一 page，跨调用保状态；带登录态后再驾驶）。原
`amberflow_pilot` one-shot 工具已移除——它每次起独立浏览器、无 cookie/登录态，真实站点极易撞
登录墙，且与 session drive 重复。引擎 `amber pilot` CLI **已移除**；驾驶协议保留在引擎库面（`PilotRuntime`，`verify:pilot`
lane 直接驱动）。交互式常驻驾驶（跨调用同现场、逐交接喂指令）**已落地**：host 是 `amber session` 子进程，经 `amberflow_session` 的 `drive/drive_command/drive_status/drive_close` op 实现（同一 page、`pilot:true`/`attached:true`；见本文件「`amberflow_session` 的 `drive` 系列 op」段）。

`PilotHandoff` 交接块（停因投影；字段冻结，单源 `src/app/pilot-contract.ts`）：

| 字段 | 口径 | 说明 |
|---|---|---|
| `stop_code` | 闭集 9 码 | `final_signal_held` / `budget_exceeded` / `off_task_page` / `low_confidence` / `target_ambiguous` / `needs_value` / `stuck_inert` / `no_model_runtime` / `browser_dead` |
| `step_id` | 0-based 驾驶步号 | `budget_exceeded` 时 = `max_steps` |
| `goal_digest` | ≤200 字符 | 总目标有界投影 |
| `why_stuck` | `{summary, evidence}` | 一句话摘要 + 有界证据（`inert_run` / `forbidden` ≤40；`frames_excluded` ≤6；声明时 `expect_url`；`needs_value:{target,key,ref}` = 哪个目标/键要值（仅 `needs_value` 且已知）；`resume_hint:{hint,missed:true}` = 上次 resume hint 落空（仅落空后第一次交接，不含值）） |
| `what_would_unblock` | ≤3 条 | 按停因查表确定性生成，不是模型建议 |
| `evidence_refs` | 四件套落盘路径 | 截图 `.png` / DOM `.dom.html`（>2MB 截断）/ 池快照 `.pool.json` / observe `.observe.json`；各自独立失败、独立缺字段 |
| `url` | — | 停驶页现场锚点 |
| `weak_picks` | 可选，≤6 | 低置信模型票票面事实 `[{step,target,conf,picked_by}]`：只收 **model** 票且 `conf < 0.25`（静态默认刻度）；无则键不出现。**evidence-only**：不判错、不阻断、不新增停因；桥只投影顶层字段（`why_stuck.evidence` 被整体丢弃），故它必须是交接顶层字段 |
| `final_signal` | 可选 | `null` = 无完成信号声明（本 run 的结束态**未被验证**）；有声明 = 有界摘要。结束态真值仍只认 `stop_code:"final_signal_held"`（引擎 `checkSignal`）或调用方信号声明 |

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