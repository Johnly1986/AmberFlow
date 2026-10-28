# 应用脚本作者指南（flow · meta · ctx · 校验 · 轨迹）

> 面向“要接入/修改一条业务流程”的人，也面向替你写脚本的 Agent。
> Agent 与 DSH 桥的稳定契约见 [AGENT_INTERFACE.md](AGENT_INTERFACE.md)；本篇讲作者面。

## 1. 只有一种格式

应用是**用户作用域的一段 JS 流程**：

```text
$AMBERFLOW_HOME/apps/<id>/app.mjs
  export const meta = (kit) => ({ id, label, goal, hosts, slots, invariants, ... })
  export async function flow(ctx) { ... }
```

- 文件按目录名发现：`apps/<id>/app.mjs`（也接受 `app.js` / `app.ts`）。
- `meta` 只声明应用级事实；流程本身在 `flow(ctx)` 里。没有静态步骤表，步骤是运行期事实。
- **流程默认由决策语句组成**：一句决策 = 一次 `ctx.step(goal, { done, ... })`，只写“要达到什么”和“怎么算完成”；点哪里由引擎的规则/决策层决定。`act` 是可选锚点，不是默认写法。
- 控制流是 JavaScript，但只留给真实的分支/循环/重试/子流程；不要用 `if`/`for` 手写引擎已经能决策的选元素逻辑。
- 引擎只负责“一步之内”：元素池、目标解析、闸门、动作、完成信号、证据。步骤是运行期事实。
- 脚本不被项目 `tsconfig.json` include，也不 import 仓库模块；`kit` 由引擎在加载时注入。

生成一个可跑骨架（默认落到 `$AMBERFLOW_HOME/apps/<id>/app.mjs`）：

```bash
npx amber apps new my-app --goal "把商品加入购物车" --url https://shop.example.com/p/1
npx amber apps new my-app --print          # 只打印源码，不落盘
npx amber apps new my-app --force          # 覆盖已有 app.mjs
```

`--host` 可重复；缺省从 `--url` 推断。骨架用 `https://example.com/` 和 `my-app` 作占位，生成后替换成真实入口页、目标与完成条件。

## 2. Agent 调试回路

```text
apps list → app show --code → 编辑 app.mjs
          → app check → inspect → app explain
          → run --dry-run → run --max-steps N --trace → run（完整）
          → online（回归）
```

```bash
npx amber apps list
npx amber apps show my-app --code          # 路径 + meta + 当前源码 + 两个版本 sha
npx amber inspect --url https://shop.example.com/ --json   # 只读：元素与候选 hint
npx amber apps check my-app                # 加载 + dry 调用序列校验（exit 2 = 有问题）
npx amber apps explain my-app              # dry 跑一遍，展示调用序列
npx amber run my-app --dry-run             # 不打开浏览器
npx amber run my-app --max-steps 3 --trace # 执行预算 + 每步证据（加 --json 拿结构化结果）
npx amber run my-app --trace               # 完整运行
```

- `apps check` 不打开浏览器：它证明“脚本能加载、调用序列合法、信号/命令/槽位可校验”，**不证明页面状态会成立**。
- `inspect` 只读：标题、URL、有界元素、候选 hint；不点击、不输入、不调模型。
- `run --max-steps N` 是 `ctx.step` / `ctx.arrive` 的**执行预算**，不是“从第 N 步开始”。用满预算时 `status=partial`、exit 0、`verified=false`，已执行步骤与 trace 保留。
- 失败先看 `steps[]` 的第一条失败、`failure`、trace 里第一次 `ok:false` 的 `stop_code/reason`，再改 `app.mjs`。没有“只改第 7 步”的旁路——脚本版本就是唯一的流程版本。

脚本里给调试留两个稳定锚点：

```js
const r = await ctx.step("提交订单", {
  id: "submit-order",                       // 稳定标识：进 trace / step_traces / steps[] / failure
  done: ctx.judge.url("thanks"),            // 目标/动作由引擎决策
  // act: ctx.hint("button[type=submit]"),  // 可选锚点：只有必须钉住目标时才写
});
if (!r.ok) ctx.fail(r.stopCode ?? "step_failed", r.reason);
```

`id` 缺省时 trace 仍按执行序号记录，但跨版本对比不稳定；建议每一步都给 `id`。

## 3. `meta`：唯一的声明面

```js
export const meta = (kit) => ({
  id: "my-app",                    // 必填；= 目录名 = `amber run` 的参数
  label: "我的应用",
  goal: "一句话说清这条流程要达成什么",   // 必填
  hosts: ["shop.example.com"],     // 允许访问的主机（导航信封 + 防泄漏门禁）
  site: { pages: { home: "https://shop.example.com/" } },  // 页面角色：流程里不重复硬编码 URL
  slots: { coupon: "SAVE10" },     // 数据槽：值只能来自声明 / 观察
  policy: { conf_floor: 0.4 },     // 可选：运行策略（见 §8）
  pace: { between_steps_ms: 200 }, // 可选：运行节奏（见 MANUAL_STEPS_AND_PACE.md）
  invariants: [                    // 结束态断言；在 ctx.done() 时验收
    { id: "on-thanks", desc: "结束时在感谢页", signal: kit.judge.url("thanks") },
  ],
});
```

字段表（`src/app/app-meta.ts` 的 `META_FIELD_MAP` 是唯一清单）：

| 字段 | 说明 |
|---|---|
| `id` / `label` / `goal` | 应用标识与一句话目标；`id`、`goal` 必填，`label` 缺省 = `id` |
| `hosts` | 允许的主机列表；导航信封在 dry 与真实运行都执行 |
| `slots` / `requiredSlots` | 数据槽与必填槽；缺值返回 `needs_value`，不猜 |
| `sources` | 数据腿名（`ctx.source(name)` 按名字按需加载） |
| `device` | 浏览器设备面（只有手机版页面的站点需要声明） |
| `site` | 站点面：页面角色 `pages`、命名行抽取 `listExtract`（见 §5） |
| `model` / `maxSubgoals` | 决策模型 checkpoint / 子目标上界（高级，缺省即可） |
| `notes` | 给人看的备注（字符串列表），不参与运行 |
| `policy` | 运行策略：`conf_floor` / `tiered_hint` / `reobserve` / `max_effective_repeats` / `risk_ask` / `done_timeout_ms` / `done_poll_ms` / `pool_ready_timeout_ms` / `pool_ready_poll_ms` |
| `pace` | 运行节奏：`between_steps_ms` / `between_actions_ms` |
| `invariants` | 结束态断言：`{ id, desc?, signal }` |
| `recordedFrom` / `generatedFrom` | 血统：这段脚本从哪次演示/哪份生成物来 |

- **未知字段加载期直接报错**（`_` 开头视为注释键，忽略）：拼错 `invaraints` 不会被静默忽略。
- `meta` 在加载期调用一次，必须**无副作用**：不要在这里开浏览器、发网络请求或读运行期状态。
- `meta` 是唯一声明面；没有任何“按步骤序号声明/编辑流程”的接口。

## 4. `flow(ctx)`：运行期面

```js
export async function flow(ctx) {
  await ctx.openPage("home");

  // 一条决策语句：只写目标 + 完成证据，点哪里由引擎决定。
  const r = await ctx.step("加入购物车", {
    id: "add-to-cart",
    done: ctx.judge.text("[data-test=cart-count]", "1"),
    // act: ctx.hint("[data-test=add-to-cart]"),  // 只有必须钉住目标时才写
  });
  if (!r.ok) ctx.fail(r.stopCode ?? "step_failed", r.reason);

  await ctx.done();   // 结束态不变量在这里验收；失败抛 invariant_failed
}
```

| 类别 | 成员 | 说明 |
|---|---|---|
| 元信息 | `ctx.app` / `ctx.slots` / `ctx.runtime` / `ctx.budget` / `ctx.log(msg, data?)` | `slots` 只读；`runtime = {outDir, runId, today}` |
| 导航 | `ctx.open(url)` / `ctx.openPage(role)` / `ctx.arrive(url, {done, desc?, id?, timeoutMs?})` | `arrive` = 纯导航 + 等信号，不做元素选择、不花模型；`hosts` 信封在起点与落地都强制 |
| 决策语句 | `ctx.step(goal, { id?, act?, done, url?, slots?, when?, timeoutMs? })` | `done` 必填；`act` 省略 = 引擎决定目标，给了 `ctx.hint()`/命令闭集才收窄候选；返回 `{ok, id?, stopCode?, reason?, evidence}` |
| 人工步 | `ctx.manual(desc, { done, instructions?, id? })` | 见 §7；非 TTY 返回 `needs_human`，不假装有人 |
| 观察 | `ctx.url()` / `ctx.read.{text,value,count,attr}(sel[, attr])` / `ctx.holds(signal)` / `ctx.waitFor(signal, {timeoutMs?, pollMs?})` | 只读；读不到返回 `null` / `0`；`waitFor` 轮询到 bounded deadline，返回 boolean |
| 站点面 | `ctx.openPage(role)` / `ctx.extract(nameOrSpec)` / `ctx.rows(...)`（v1 关闭） | 具名抽取声明在 `meta.site.listExtract`；inline 抽取用 `{ rows, fields, maxItems? }`；`rows` 调用给结构化错误 |
| 数据 | `ctx.source(name)` / `ctx.data.{min,max}(rows, by)` | 数据腿按需拉取；`--skip-data` 时 `source` 报结构化错误 |
| 进程 | `ctx.run(...)` / `ctx.dangerous({...dryRunArgs})` | 见 §6；危险步默认拒绝 |
| 构造器 | `ctx.judge.*` / `ctx.tool.*` / `ctx.hint()` / `ctx.hints()` / `ctx.command()` / `ctx.value.*` | 与 `kit` 同一份实现；命令 op 见下 |
| 收尾 | `ctx.done()` | 结束态不变量验收；之后不允许再有动作 |
| 终止 | `ctx.fail(code, reason?)` | 抛结构化 `StopError`，退出码/状态走引擎既有分类，不抛裸栈 |

- `when` 是适用性守卫：动作前判定，不成立时该步不执行（返回 `ok:false, stopCode:"precondition_skipped"`），脚本可以据此分支。
- `act` 缺省就是“决策语句”：只给目标语义和完成证据，让规则/模型选元素；硬编码 `ctx.hint(...)` 只作为稳定锚点或候选收窄，不应成为每条流程的默认。
- 导航同样优先用 `meta.site.pages` + `ctx.openPage(role)`，而不是在流程里重复硬编码 URL；业务值优先用 `meta.slots` / `ctx.source`，不要写死在 `flow` 里。
- 命令闭集的 op 是引擎能力面：`click` / `check` / `fill` / `select` / `scroll` / `drag` / `skip`。
  `scroll` 把目标滚入视口；`drag` 的 value 是落点 selector（可来自槽位），只在 `[draggable=true]` 或 slider 族元素上声明能力。
  不在能力面内的 op 会得到 `action_unsupported`，目标歧义是 `target_ambiguous`，目标不存在是 `target_not_found`。
- 预算：`ctx.budget.maxSteps` / `stepsUsed`；`ctx.step`、`ctx.arrive`、`ctx.run` 与批准执行的人工步都消耗预算，用满抛 `budget_exceeded`（CLI 给 `--max-steps` 时结果 `partial`）。
- 脚本拿不到 `page` / locator、模型文本或分数，只能看 `{ok, stopCode, reason?, evidence}`。
- 退出码与 Agent 视图（`amber run --json`）：`status` = `passed | partial | failed | blocked | needs_human | dry | invalid | infra_error`；`verified` 只在完整运行且所有不变量成立时为 true。

## 5. 站点面：`meta.site`

站点相关的数据声明在应用自己的 `meta` 里（与 hint 同一条纪律：不进共享代码）：

```js
export const meta = (kit) => ({
  id: "price-watch", label: "盯价", goal: "读列表页最低价", hosts: [], slots: {},
  site: {
    pages: { home: "https://example.com" },                   // 角色 → URL（openPage 用）
    listExtract: {                                            // 命名行抽取（extract 用）
      entries: { rows: "nav.menu a", fields: { label: "." } }, // "." = 行自身文本
    },
  },
});

export async function flow(ctx) {
  await ctx.openPage("home");                                  // 找不到角色 = config_error（点名已知角色）
  const rows = await ctx.extract("entries");                   // Array<{ field: string }>
  const href = await ctx.read.attr("[data-test=entry]", "href"); // 不存在 → null
  const n = await ctx.read.count("nav.menu a");
  await ctx.done();
}
```

- `ctx.extract(name)` 的字段选择器是**行内相对选择器**；`rows` 最多取 500 行（超出在 trace 里标 `truncated`）。
- `ctx.rows({row, fields})` 是 v1 明确**不开放**的新语法：调用给结构化 `config_error` 指向 `extract(name)`。
- dry 模式下 `extract` 返回 `[]`、`read.attr` 返回 `null`、`waitFor` 立即返回 `true`（没有页面）——脚本在 dry 期不要依赖观察值；需要严格断言数据时，先判 `ctx.runtime.runId === "(dry)"`。
- 观察类调用（text/value/count/attr/extract）都进 trace，所以带读取的脚本可以 `--replay`。

## 6. 完成信号与结束态不变量

完成只认证据面，构造器都来自 `kit` / `ctx`：

- DOM：`ctx.judge.url(...)`、`exists`、`text`、`equals`、`value`、`all(...)`、`any(...)`、`not(...)`；
- 进程：`ctx.tool.exitOk()`、`exitCode(n)`、`stdoutContains`、`stdoutMatches`、`stderrContains`、`jsonPath`、`fileExists`、`fileAbsent`；
- 组合器可嵌套。**不要用“看起来完成了”代替证据**：`ctx.step` 返回的 `ok` 就是 done 信号是否成立。

结束态不变量写在 `meta.invariants`，由 `ctx.done()` 在**同一页面**上验收：

- 声明了不变量却从未调用 `ctx.done()` → 运行判 `missing_done`（验收没发生，不能报绿）；
- `ctx.done()` 时不变量不成立 → `invariant_failed`；
- 中间要求写进每一步的 `done`；不变量看不到中间状态；
- 纯工具应用不要写 web 不变量（没有浏览器结束态可验）。

## 7. 人工步骤 `ctx.manual`

登录、短信/验证码、二次确认、需要人判断的页面操作，用人工步显式表达：

```js
const m = await ctx.manual("登录并完成短信验证", {
  id: "login",                                    // 稳定标识：进 trace / step_traces / steps[]
  instructions: "在打开的浏览器里用你自己的账号登录；完成后回终端按 Enter",
  done: { manual: true },                         // 人自证（attested）；或写 DOM 信号由引擎复核
});
if (!m.ok) ctx.fail(m.stopCode ?? "needs_human", m.reason);
```

规则：

- `done` 必须声明。`{manual:true}` = **人自证**（结果/报告显式记 `attested`，不冒充 DOM 验证）；写 `url_contains` / `css_*` 等 DOM 信号时，人确认后引擎还会验一次，验不过 = 未完成（`manual_signal_not_held`），不会静默算绿。
- **未完成的人工步不能变绿**：只要某个 `manual` 事件 `ok!==true`，整次运行就是未完成（`status=needs_human`、`verified=false`、exit 1），即使脚本吞掉了返回值、后续步骤与不变量都成立。
- **非 TTY**（批处理 / Agent 调用）不会假装有人在，也不会为它拉一个没人能看见的有头浏览器：返回 `ok:false, stopCode:"needs_human"`。
- **`--manual-fail-fast`**：在调用任何人工处理器之前直接返回 `needs_human`，注入的处理器也覆盖不了。
- **TTY** 下给终端提示（`Enter` 继续 / `n` 放弃）；人放弃 = `manual_declined`。浏览器默认仍是 headless——要让人在页面上操作请加 `--headful`，没有显示器用 `xvfb-run` + VNC。
- 人工步不自动过、不保存账号密码、不识别验证码/2FA；引擎只验证最终信号。详见 [MANUAL_STEPS_AND_PACE.md](MANUAL_STEPS_AND_PACE.md)。

## 8. 运行策略、节奏与学习环

`meta.policy` 的字段（生效优先级：**CLI 本次显式 > `meta.policy` > provider 自报 > 缺省**）：

| 字段 | 缺省 | 说明 |
|---|---|---|
| `conf_floor` | 0.25（或 provider 自报） | 置信度闸门；换 provider 时缺省刻度不可比，用它可以声明 |
| `tiered_hint` | `false` | hint 档内歧义时问模型更小的问题（P1 实验） |
| `reobserve` | `true` | 动作后重新观察 |
| `max_effective_repeats` | `3` | 同一子目标里同一动作的最大有效重复 |
| `risk_ask` | `always` | `rules-only` = 风险只走规则，不花每步前向 |

产物里的 `effective_policy` 只在非缺省时出现，并写明来源（`cli` / `config` / `app` / `provider` / `default`）。

`meta.pace` 声明运行节奏（毫秒，`0..60000`，加载期校验）：`between_steps_ms` 是两次执行步（`ctx.step` / `ctx.arrive` / `ctx.manual` / `ctx.run`）之间的最小等待，`between_actions_ms` 是同一浏览器子目标内两次动作之间的等待。优先级：**本次显式（嵌入方 opts） > `meta.pace` > 环境变量 > 0**；环境默认是 `AMBERFLOW_STEP_DELAY_MS` / `AMBERFLOW_ACTION_DELAY_MS`。缺省全 0。详见 [MANUAL_STEPS_AND_PACE.md](MANUAL_STEPS_AND_PACE.md)。

学习环：`amber run <app> --remember` 开启 sidecar（默认 `$AMBERFLOW_HOME/hint-memory/<app>.json`），`--memory FILE` 指定落点。学到的 hint 只进 sidecar，**永不写回被审计的 `app.mjs`**；脚本里 authored hint 恒优先。`amber help --all` 里还有 `--ablate stub|rules-only`、`--tiered-hint`、`--min-confidence` 等实验/消融旗标，日常不需要。

## 9. 执行轨迹与重放

```bash
amber run my-app --emit-trace /tmp/run.trace.json   # script/inputs 两个 sha + 逐次 ctx 调用
amber run my-app --replay /tmp/run.trace.json       # 不重新决策；脚本版本或输入槽位不一致直接拒跑
```

- trace 的 `events[]` 记录每次 ctx 调用（`call` / `desc` / `id` / `url` / `ok` / `stop_code` / 只读结果摘要），`done` + `stop_code` 是审计事实。
- `script_sha256` = 脚本源字节指纹；`plan_sha256` = 由 `meta` 投影出的 IR 指纹。`inputs_sha256` 只含槽位与 hosts（**不含** outDir/runId），所以重放可跨机器。
- 重放要求 app / `script_sha256` / `inputs_sha256` 三者一致；不一致直接拒跑（`trace_mismatch` 或加载期拒绝），不“尽量重放”。
- 真实运行两次的**结构**应一致：调用序列 + 结果（`result` 里除耗时外的字段）；耗时证据不参与比较。

## 10. 错误码与排查

`stopCode` 是脚本看到的**唯一**失败分类（`reason` 给人读）：

| stopCode | 含义 / 下一步 |
|---|---|
| `config_error` | 脚本声明/运行配置错（缺 done、未知 op、未知适配器、`ctx.open` 打不开…）——改声明，不要重试 |
| `host_not_allowed` | 目标主机不在 `meta.hosts` 信封内——要么加 hosts，要么别导航过去 |
| `budget_exceeded` | 步预算/截止时间用完——检查死循环，或调大预算 |
| `invariant_failed` | `ctx.done()` 时结束态不变量不成立——看是流程没走完还是页面变了 |
| `missing_done` | 声明了结束态不变量却从未调用 `ctx.done()`——验收没发生，不能报绿 |
| `arrive_signal_not_held` | `ctx.arrive` 导航完成但 done 信号在超时内未成立 |
| `precondition_skipped` | `when` 不成立，这一步没有执行 |
| `page_not_ready` | 元素池为空，页面还没稳定；等页面 ready，或修 done 信号 |
| `target_not_found` | 目标声明在页面上不存在；改 hint 或换目标 |
| `target_ambiguous` | 目标命中多个不同候选；收窄 hint |
| `action_unsupported` | 目标存在但声明的动作 op 不在元素能力面内；换动作或换目标 |
| `done_not_held` | 命令闭集已走完，但 done 信号仍未成立；检查完成信号或页面状态 |
| `frame_not_allowed` | frame origin 不在 `meta.hosts` 内；声明 frame host 或避免跨 frame 动作 |
| `popup_not_allowed` | action 打开的新 tab / popup 不在 `meta.hosts` 内；声明 popup host 或避免打开外域 |
| `manual_signal_not_held` / `manual_declined` / `needs_human` | 人工步：DOM 信号没验过 / 人放弃 / 非 TTY 需要人 |
| `dangerous` / `declined` / `dry-run-failed` / `tool-unavailable` / `needs_value` | 工具步的显式拒绝类别（`REFUSAL_LABELS` 有一句话解释 + 怎么补救） |
| `trace_mismatch` | 重放时脚本与轨迹的调用序列/版本/输入不一致——重新跑，不要重放 |
| 其它（如 `low_confidence`、`max_steps`、`blocked`） | 执行器结构化停因，原样透出 |

排查顺序：`apps check`（声明）→ `inspect`（页面）→ `apps explain`（序列）→ `run --dry-run`（预演）→
`run --max-steps N --trace`（有预算的真跑）→ 看 trace 里第一次 `ok:false` 的 `stop_code/reason`。

## 11. 边界（当前版本明确不做）

- **脚本是进程内任意代码**：信任边界 = “用户作用域 + 不放仓库”；结果里带 `script_sha256`。沙箱未做。
- `ctx` 是**运行期面**：不要指望 `ctx.page` / locator / 模型分数——那是执行器内部。
- flow 应用没有静态 IR 可展开/导出；审计能力用 `--emit-trace` 的轨迹。
- `ctx.rows({row, fields})` 在 v1 关闭；行抽取走 `meta.site.listExtract` + `ctx.extract(name)`，或 inline `ctx.extract({ rows, fields, maxItems? })`。

## 12. 扩展配方（改引擎的人看）

| 想加什么 | 触点（按顺序） | 验证台 |
|---|---|---|
| **ctx 新成员** | `Ctx` 接口 → 三个实现（`ctx.ts` / `ctx-dry.ts` / `ctx-replay.ts`） | 同一脚本 dry 与真实运行的结构一致性 |
| **meta 新字段** | `app-meta.ts` 的 `META_FIELD_MAP`（**唯一清单**，meta→IR 与 codegen 共用）→（若需运行期支持）`ctx` / 执行器 | `amber apps check` + 手工加载/运行一个已声明该字段的应用 |
| **新信号算子** | DOM 面：`signals.ts` 的语法表 + `checkSignal`；进程面：`browser/tool-signals.ts` + `checkToolSignal`（校验走同一 walker） | `amber apps check` + 手工执行 |
| **新应用支持器** | `app-adapters.ts` 实现 `AppAdapter` 并注册；`ctx.run` 声明形式自动可用 | 手工执行一个使用该 adapter 的应用 |
| **新 CLI 旗标** | `src/support/cli-args.ts` 选项 → `src/cli/registry.ts` help → 命令实现 → 转发到 app-runner（若适用） | `amber <cmd> --help` + 手工执行 |

## 13. 命令速查

```bash
amber apps list / show <id|路径> [--code] / path <id> / remove <id> [--yes]
amber apps new <id> [--goal G] [--host H] [--url U] [--dir D] [--print] [--force]
amber apps check [<id|路径>] / explain <id|路径>
amber run <id|路径> [--dry-run] [--max-steps N] [--trace] [--headful]
                    [--slot k=v] [--out DIR] [--allow-dangerous]
                    [--emit-trace F] [--replay F] [--json]
amber record <页面> [--name ID] [--goal G] [--apps-dir DIR] [--yes]
amber inspect --url <URL> [--json]
npm run test           # 真实站点测试（smoke + core）
npm run check           # typecheck + 配置示例一致性 + 线上用例离线校验
```