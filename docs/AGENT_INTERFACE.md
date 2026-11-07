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
  不证明页面状态会成立。
- `inspect` 只读：标题、URL、有界元素、候选 hint；`--json` 另带只读的可访问性树证据块 `ax`（浏览器 AX role/name/focusable/disabled + `not_in_pool` 近似口径，不进池/匹配/模型/运行路径）；不点击、不输入、不调模型。
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

---

## 5. 验证

- 作者回路用用户作用域临时应用验证：`new → check → explain → run --dry-run → run --max-steps`。
- 完整运行用真实站点（`online/` 或临时应用），证据写仓库外。
- 桥验证：重建 `integrations/dsh-bridge`，由子代理只通过 `amberflow_*` 工具完成
  “inspect → app_create → 编辑 app.mjs → app_check → run” 的端到端流程。