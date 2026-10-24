# L2 `ctx` API 草案（讨论稿）

**日期**：2026-10-24 ｜ **状态**：草案，未实现，无代码改动
**上游**：[FLOW_AUTHORING_ALTERNATIVES.md](FLOW_AUTHORING_ALTERNATIVES.md) §10（L2 = 脚本接管控制流、JSON 可完全废弃）
**这份草案要回答三件事**：
1. **够用**：今天 21 个应用包的能力，能不能用这套 API 表达？
2. **不多**：概念数能不能真的减少（而不是把 21 个 JSON 键换成 40 个函数）？
3. **能落地**：每个函数是不是都能指向**今天已存在**的引擎缝，而不是发明新语义？

> 读法：每个 API 都给出「引擎落点」。落点里没有的东西，就是本草案**发明**的——那部分要么删，要么明确列为待建。

---

## 1. 形态：两个导出

```js
// $AMBERFLOW_HOME/apps/checkin/app.mjs（或 .ts，运行期 strip-types；不进 tsconfig）
export const meta = (ctx) => ({          // 声明面：纯函数，load 期执行（无浏览器、无网络）
  id: "checkin", goal: "把预订时间填进 <select> 并提交",
  hosts: ["example.com"],
  slots: { room: "大床房" },
  invariants: [ctx.judge.url("thanks.html")],
});

export default async function flow(ctx) { /* 执行面：运行期，可循环/条件/重试 */ }
```

**为什么是两个**：`meta` 必须在**任何网络动作之前**可运行、可校验（`hosts` 信封、`slots` 校验、`invariants` 形状，
对应今天的 `validatePack` 在任何网络之前跑，`src/app/app-runner.ts:609-616` 的纪律）；`flow` 只有运行期才成立。

---

## 2. 类型草案（TS，供讨论）

```ts
type DomSignal =
  | { url_contains: string } | { css_exists: string }
  | { css_text_equals: [string, string] } | { css_text_contains: [string, string] }
  | { css_value_equals: [string, string] } | { manual: string }
  | { all_of: DomSignal[] } | { any_of: DomSignal[] } | { not: DomSignal };

type ProcessSignal =
  | { exit_ok: true } | { exit_code_equals: number }
  | { stdout_contains: string } | { stdout_matches: string } | { stderr_contains: string }
  | { json_path_equals: [string, string] }
  | { file_exists: string } | { file_absent: string }
  | { all_of: ProcessSignal[] } | { any_of: ProcessSignal[] } | { not: ProcessSignal };

type Target = { hint: string } | { hints: string[] };          // 单目标 / 有序多目标
type Value  = { literal: string }
            | { from: "slot"; key: string }
            | { from: "option"; key: string; match: "value" | "label" | "contains" }
            | { from: "list"; by: string; order: "min" | "max" };
type Command = { op: "click" | "check" | "fill" | "select" | "skip";
                 target?: string; value?: Value; id?: string };

interface StepRequest {
  done: DomSignal;                       // 必需：完成只由引擎按信号裁决
  act: Target | Command[];               // **必填**（2026-10-24 拍板）：每步必须点名目标；hint 未命中仍按既有纪律回落 laya
  adjudicate?: boolean;                  // ⑤ 信号裁决（NL Flow 既有开关）
  timeoutMs?: number;
  meta?: Record<string, string>;         // 进 trace 的注解（不影响语义）
}
interface StepResult {
  ok: boolean;
  stopCode?: StopCode;                   // executor.ts:162 的 20 个之一
  evidence: { url: string; attempts: number; elements: number; elapsedMs: number };  // method/conf 只在 trace
}
```

```ts
interface Meta {
  id: string; label?: string; goal: string;
  model?: "english" | "multilingual" | "router";
  hosts?: string[];
  device?: DeviceSpec;                       // 与 qunar-live 同形
  slots?: Record<string, string>; requiredSlots?: string[];
  sources?: string[];
  site?: { pages?: Record<string, string>;
           fillKeys?: Record<string, string[]>;
           listExtract?: Record<string, { rows: string; fields: Record<string, string> }> };
  invariants?: DomSignal[];
  notes?: string[];
  limits?: { maxSteps?: number; maxMs?: number };
  recordedFrom?: { url: string; steps: number; sha256: string };
}
type AppModule = { meta(ctx: Ctx): Meta; default(ctx: Ctx): Promise<void> };  // 加载器的契约

interface Ctx {
  // 只读元信息
  readonly app: Readonly<{ id: string; label?: string; goal: string; dir: string }>;
  readonly slots: Readonly<Record<string, string>>;
  readonly runtime: Readonly<{ outDir: string; runId: string; today: string }>;
  readonly budget: Readonly<{ maxSteps: number; stepsUsed: number; deadline: number }>;
  log(msg: string, data?: unknown): void;

  // 导航（受 hosts 信封约束）
  open(url: string, opts?: { timeoutMs?: number }): Promise<void>;
  openPage(role: string): Promise<void>;
  /** 纯导航步：只到达 + 断言信号，不做任何动作（`act` 必填的显式例外形态）。 */
  arrive(url: string, req: { done: DomSignal; timeoutMs?: number }): Promise<StepResult>;

  // 唯一的执行器
  step(desc: string, req: StepRequest): Promise<StepResult>;

  // 只读观察（不动作、不越权）
  url(): string;
  readonly read: { text(sel: string): Promise<string | null>;
                  attr(sel: string, name: string): Promise<string | null>;
                  value(sel: string): Promise<string | null>;
                  count(sel: string): Promise<number> };
  rows(spec: { row: string; fields: Record<string, string> }): Promise<Row[]>;   // v1 先不开放（Q5）
  extract(name: string): Promise<Row[]>;                                        // 走 meta.site.listExtract
  holds(sig: DomSignal | ProcessSignal): Promise<boolean>;

  // 构造器（纯函数，可在 meta 里用）
  readonly judge: { url(s: string): DomSignal; text(sel: string, want: string): DomSignal;
                    exists(sel: string): DomSignal; value(sel: string, want: string): DomSignal;
                    all(...s: DomSignal[]): DomSignal; any(...s: DomSignal[]): DomSignal;
                    not(s: DomSignal): DomSignal; manual(question: string): DomSignal };
  readonly tool:  { exitOk(): ProcessSignal; exitCode(n: number): ProcessSignal;
                    stdoutContains(s: string): ProcessSignal; stdoutMatches(re: string): ProcessSignal;
                    stderrContains(s: string): ProcessSignal; jsonPath(path: string, want: string): ProcessSignal;
                    fileExists(p: string): ProcessSignal; fileAbsent(p: string): ProcessSignal };
  hint(hint: string): Target;
  hints(...hint: string[]): Target;
  row(r: Row): Target;
  command(op: Command["op"], target?: string, value?: Value): Command;
  readonly value: { literal(v: string): Value; slot(key: string): Value;
                    option(key: string, match: "value" | "label" | "contains"): Value;
                    list(by: string, order: "min" | "max"): Value };

  // 数据腿 / 纯算子 / 进程步
  source(name: string): Promise<{ counts: Record<string, number>;
                                  selects: Record<string, Record<string, string> | null>;
                                  rows: Row[]; version?: string }>;
  readonly data: { min<T>(rows: T[], by: string): T | null; max<T>(rows: T[], by: string): T | null };
  run(source: string, args: string[], req: ProcessStepRequest): Promise<ProcessResult>;
  dangerous(req: DangerousRequest): Promise<ProcessResult>;

  done(): Promise<void>;
}
```

---

## 3. API 逐条（含引擎落点）

### 3.1 只读元信息

| API | 语义 | 引擎落点 | 备注 |
|---|---|---|---|
| `ctx.app.{id,label,goal,dir}` | 应用标识 | `AppPack`（`src/app/app-pack.ts:212`） | 只读 |
| `ctx.slots` | 本次运行的数据袋（CLI/计划覆盖后的值） | `extractSlots` + `run_plan` 合并（`src/engine/extraction.ts`；`src/engine/planner.ts`） | 只读；**脚本不能改**（否则「值只来自声明」被破） |
| `ctx.runtime.{outDir,runId,today}` | 运行期右侧值 | `RUNTIME_PLACEHOLDERS`（`src/app/app-pack.ts:41-50`）；`FROZEN_TODAY`（`tools/frozen-today.ts`） | `today` 服从钉钟；**不是** `Date.now()` |
| `ctx.budget.{maxSteps,stepsUsed,deadline}` | 步数/时间预算 | 今天 `max_subgoals` + `max_steps`（`src/engine/executor.ts:163` 的 `max_steps`） | 超出抛 `BudgetExceeded` |
| `ctx.log(msg, data?)` | 写 trace + 报告 | 现有 verbose/trace 面（`executor.ts` trace） | **不写 stdout**（`--json` 契约） |

### 3.2 导航

| API | 语义 | 引擎落点 |
|---|---|---|
| `await ctx.open(url, {timeoutMs?})` | 导航，等 `domcontentloaded` | `disallowedHost`（`src/engine/executor.ts:586`）→ `page.goto(..., {waitUntil:"domcontentloaded"})`（`:1673`） |
| `await ctx.openPage(role)` | 按 `meta.site.pages[role]` 解析后导航 | 页面角色（`semantic-flow.ts` `pages`） |

失败语义：host 不在信封 → **抛** `{code:"host_not_allowed"}`（配置级错误，与今天同码）；超时 → `{code:"config_error"}`。

### 3.3 一步：唯一的执行器

| API | 语义 | 引擎落点 |
|---|---|---|
| `await ctx.arrive(url, {done})` | **纯导航步**：`goto` + 断言，不动作（今天 2 个 bilibili-hot 步就是这种形态） | `mw.run` 的"信号先成立即完成"路径（`src/engine/executor.ts:1530`），`targetHint: null` |
| `await ctx.step(desc, req)` | 一步 = 扫描元素池 → 规则/hint/模型选 → 置信度闸门 → 风险闸门 → 可操作性探针 → 执行 → inert 检查 → 完成信号 | `BrowserMiddleware.run` 的单步全部（`src/engine/executor.ts:733`）；元素池 `extractElements`（`src/engine/extraction.ts:491`；预算 40 = `MAX_ELEMENTS:237`，reobserve 加宽 120 = `src/engine/executor.ts:533`）；hint `rules.hintMatchImpl`（`src/engine/rules.ts:184`）；命令闭集 `validateCommands`/`instantiateSpace`（`src/engine/actions.ts:83,144`）；信号 `checkSignal`（`src/engine/signals.ts:30`） |

**关键约定**
0. **`act` 必填**（2026-10-24 拍板）：每步必须声明目标（`hint`/`hints`/`row`）或命令闭集；**缺失 = 配置级错误**（加载期），`step_names_no_target` 不再是运行期停因。hint 未命中仍按既有纪律回落 laya——模型是兜底，不是默认路径。**纯导航步**（只到页面 + 断言，如 `apps/bilibili-hot` 的第 1/3 步）用显式 `ctx.arrive(url,{done})`，不靠省略 act。
1. **`done` 必需**：脚本不能自报完成——没有信号就不是一步（红线③的 L2 形态）。
2. **业务失败不抛异常**：`{ok:false, stopCode}` 返回，脚本用 `if` 决定重试/换路/放弃；**只有配置级错误才抛**
   （`host_not_allowed` / `config_error` / `unknown_command_op`）。理由：抛异常会把控制流藏进错误处理。
3. **一次一步，不可重入**：同一 ctx 上并发调用 `step` 直接抛（单 page）。
4. `stopCode` 就是 [`StopCode`](src/engine/executor.ts:162) 的 20 个值；新增两个：`budget_exceeded`、`flow_returned_without_done`。

### 3.4 只读观察（不动作）

| API | 语义 | 引擎落点 |
|---|---|---|
| `ctx.url()` | 当前 URL | `page.url()` |
| `await ctx.read.text(sel)` / `.attr(sel,name)` / `.value(sel)` / `.count(sel)` | 只读单值/计数（**跨 frame**） | `locatorAnyFrame`（`src/engine/extraction.ts:212`）、`BrowserMiddleware.snapshot`（`src/engine/executor.ts:1213`） |
| `await ctx.rows({row, fields})` | 表格抽取：行选择器 + 字段→选择器 | `extract`（`src/data/datasource.ts`）的 html 抽取口径 |
| `await ctx.extract(name)` | 用 `meta.site.listExtract[name]` 抽行 | 站点档案 `list_extract`（`semantic-flow.ts`） |
| `await ctx.holds(sig)` | 只判不动作（`when` 的替代） | `checkSignal`（`src/engine/signals.ts:30`）/ `checkToolSignal`（`src/browser/tool-signals.ts:96`） |

**为什么允许读 DOM**：观察值属于「观察」来源（`docs/NL_FLOW_DESIGN.md` §5 五来源），是红线允许的；
不允许的是**动作**绕过 `step` 和**值**绕过声明/观察/派生。

> 命名上用 **`ctx.read.*` 而不是 `ctx.text()`**：否则会与 `ctx.value`（值绑定构造器）撞名——
> 一个 API 面里两个 `value` 是最典型的"便宜的歧义"，趁早掐掉。

### 3.5 判断构造器 + 目标/值/命令构造器（纯函数，不执行）

| API | 语义 | 引擎落点 |
|---|---|---|
| `ctx.judge.{url,text,exists,value,all,any,not,manual}` | 构造 `DomSignal` | `SIGNAL_OPS`（`src/engine/signals.ts:179`）——**同一套算子，不新开语法** |
| `ctx.tool.{exitOk,exitCode,stdoutContains,stdoutMatches,stderrContains,jsonPath,fileExists,fileAbsent}` | 构造 `ProcessSignal` | `TOOL_SIGNAL_OPS`（`src/browser/tool-signals.ts:29`） |
| `ctx.hint(h)` / `ctx.hints(...h)` | 单目标 / 有序多目标 | 计划 `target_hint`/`target_hints`；语法 `rules.hintMatchImpl`（`src/engine/rules.ts:184`） |
| `ctx.row(r)` | 行 → 目标（引擎把行映射到元素） | `list_pick`/`act_on_row`（`semantic-flow.ts`） |
| `ctx.command(op, target?, value?)` | 命令闭集一项 | `COMMAND_OPS`（`src/engine/actions.ts:36`） |
| `ctx.value.{literal,slot,option,list}` | 值绑定四来源 | `ValueBinding`（`src/engine/bindings.ts:69`）；`resolveBinding`（`:203`）、`validateBinding`（`:118`） |
| `ctx.data.{min,max,sort}` | 纯数据算子 | `datasource.selectIndex`（`src/data/datasource.ts:959`）——**与数据侧同一实现** |

> **构造器不做校验检查的时机**：`meta(ctx)` 里用它们时，`meta` 返回后立刻整包校验（同一 `PlanningRules`）；
> `flow` 里用它们时，`ctx.step` 调用的**那一刻**校验（失败 = 配置级错误，带 `flow#step[3]` 路径）。
> ——校验器不搬家，只是从"校验整文档"变成"校验每次调用"。

### 3.6 数据腿

| API | 语义 | 引擎落点 |
|---|---|---|
| `await ctx.source(name)` | 跑一次数据源，返回 `{counts, selects, rows, version}` | `runSource`（`src/data/datasource.ts:1453`）；`loadSource`（`:1190`）；日期 `defaultDates`（`:826`）；版本 `checkVersion`（`:506`） |

取代今天的 `source_slots`：脚本直接拿返回值，**不再回写槽位字符串**（少一层对账）。

### 3.7 进程步 / 危险步

| API | 语义 | 引擎落点 |
|---|---|---|
| `await ctx.run(source, args, {done, idempotent?, timeoutMs?})` | 进程步，完成真值 = 进程观察 | `runToolStep`（`src/app/app-runner.ts:440`）；`checkToolSignal`（`src/browser/tool-signals.ts:96`）；`idempotent` 纪律（`src/app/app-adapters.ts:377-382`） |
| `await ctx.dangerous({source, args, dryRunArgs, desc, done})` | 不可逆步：干跑 → 确认 → 执行 | `runToolStep` 的 dry-run/`confirmToolStep`（`src/app/app-runner.ts:87` / `:523`）；`REFUSAL_LABELS` |

`dangerous` 的拒绝仍是**显式结果**（`refused: "dangerous"|"declined"|"dry-run-failed"`），不是静默跳过。

### 3.8 收尾

| API | 语义 | 引擎落点 |
|---|---|---|
| `await ctx.done()` | 标记成功 + 在**会话结束状态**上求 `meta.invariants` + 关会话 | `invariants` 求值（`src/app/app-runner.ts:914-915`，结束态、同一会话）；`browserSession.close()` |

不调用 `done()` 直接返回 → `flow_returned_without_done`（结构化停因，不算绿）。

---

## 4. 脚本**拿不到**什么（红线在 L2 的落法）

| 拿不到 | 为什么 | 实现方式 |
|---|---|---|
| **模型自由文本 / 选中的 ref** | 否则模型可以间接产值/产控制流 | `StepResult.evidence.method` 只有枚举；不存在返回 ref 的 API |
| **模型置信度分数 / 决策档归属（`method`）** | 按分数或档位分支 = 模型间接产控制流 | 只进 trace（`method`+`conf`+`score_kind`），不进脚本；脚本只看到 `stopCode` |
| `page` / `locator` / Playwright 对象 | 否则动作绕过 `step`，卫生机制（inert/forbid/风险闸门）全失效 | ctx 不暴露；`ctx.text/attr` 是只读封装 |
| 任意 `click`/`fill` | 同上 | 只有 `ctx.step({act})` / `ctx.command` |
| 自报完成 | 完成只认证据面 | `done` 只能是 `DomSignal`/`ProcessSignal`，由引擎裁决 |
| 越过 `hosts` 的导航 | 导航信封 | `ctx.open` 内部 `disallowedHost` |
| 不经确认的不可逆动作 | 危险动作纪律 | 只能走 `ctx.dangerous` |
| 改 trace / 改结果 / 改 slots | 审计不可被脚本污染 | 只读对象 + 引擎落盘 |
| 时钟/随机/网络/文件系统 | 「值只来自声明/观察/派生」 | kit 不提供（**约定**，不是强制：JS 仍能 `import`，见 FLOW §10.2 边界） |

---

## 5. 删除清单：概念净减（这才是「门槛降低」的证据）

| 今天的概念 | L2 里被什么替代 |
|---|---|
| `when` | `if (await ctx.holds(sig))` |
| `retries` | `for` 循环 + `if (!r.ok) continue` |
| `next` / `max_step_visits` | 脚本控制流（`continue`/`break`/函数调用/循环） |
| `max_subgoals` | `ctx.budget` |
| `roles` / `journey` | `flow(ctx)` 函数体（复用 = 普通 JS 函数/模块常量） |
| `source_slots`（字符串回写） | `const v = (await ctx.source("x")).selects.y`（**变量**，无需对账） |
| `{dataset:NAME}`（字符串引用） | JS 变量（**无需对账**，C3 整类消失） |
| `policy`（0 个包在用） | CLI/引擎选项 |
| `target_hint`/`target_hints`/`commands` | `ctx.hint/hints` / `ctx.command`（同一套语法） |

**净效果**：`PACK_KEYS` 21 → `meta` 约 12 项；`STEP_KEYS` 21 → `StepRequest` 5 项；
**9 个概念消失**（其中 4 个是控制流、2 个是字符串对账）。

---

## 6. 一个 ctx，三种实现（explain / check / resume 的落法）

| 实现 | 用在哪 | 行为 |
|---|---|---|
| **real** | `run` | 真实浏览器 + 真实模型 + 真实数据腿；必须调 `done` |
| **dry** | `explain` / `check` | 不动作、不开浏览器：`step` 立即返回 `{ok:true, dry:true}`，记录**声明意图**；构造器/校验器全跑；`open` 只做 host 校验。`explain` 把记录渲染成中文计划，`check` 输出路径级 problems，`meta` 可直接运行（纯函数） |
| **replay** | resume / 回归 | 从 trace 重放：按记录的每步结果返回，**不重新决策**；脚本版本/输入 hash 不一致就拒跑 |

**好处**：`explain`/`check`/`resume` 不发明第二套语义——它们就是**同一个 ctx 的另外两个实现**。
`dry` 模式也顺便解决了「Agent 写错只有运行时才知道」：`check` 跑 dry 就能拿到路径级错误。

---

## 7. 完整示例（真的跑得起来的那种写法）

```js
// $AMBERFLOW_HOME/apps/flight-cheapest/app.mjs
export const meta = (ctx) => ({
  id: "flight-cheapest",
  goal: `订${ctx.slots.date_label}${ctx.slots.from}到${ctx.slots.to}价格最低的机票`,  // 构建期直接算
  hosts: ["flights.example.com"],
  slots: { from: "昆明", to: "北京", cap: "1200" },
  requiredSlots: ["from", "to"],
  sources: ["flight-search"],
  site: {
    listExtract: { fares: { rows: "[data-test=fare-row]", fields: { price: "[data-test=price]", fno: "[data-test=flight-no]" } } },
  },
  invariants: [ctx.judge.url("done.html")],
  notes: ["判断最低价 = ctx.data.min（与数据侧同一实现）"],
});

export default async function flow(ctx) {
  await ctx.openPage("home");
  for (const date of ["2026-05-18", "2026-05-19"]) {          // 运行期循环
    if (!(await ctx.holds(ctx.judge.exists(`[data-test=date=${date}]`)))) continue;

    const r = await ctx.step("选出发日期并搜索", {
      done: ctx.judge.url(`search?date=${date}`),
      act: [ctx.command("fill", "#depart", ctx.value.slot("from")),
            ctx.command("fill", "#arrive", ctx.value.slot("to")),
            ctx.command("click", "[data-test=search]")],
    });
    if (!r.ok) { ctx.log("搜索失败，换日期", { stop: r.stopCode }); continue; }

    const rows = await ctx.extract("fares");
    const cheapest = ctx.data.min(rows, "price");
    if (!cheapest || Number(cheapest.price) > Number(ctx.slots.cap)) continue;

    await ctx.step("选中最低价航班", {
      done: ctx.judge.url("purchase"),
      act: ctx.hint(`[data-test=fare-row][data-price="${cheapest.price}"] [data-test=select]`),
    });
    await ctx.dangerous({                                   // 不可逆：干跑 + 确认
      desc: "提交订单", source: "flight-search",
      args: ["--book=" + ctx.runtime.runId], dryRunArgs: ["--book=" + ctx.runtime.runId, "--dry-run"],
      done: ctx.tool.stdoutContains("order confirmed"),
    });
    return ctx.done();
  }
  throw new Error("no date under cap");                      // 业务失败由脚本自己决定怎么结束
}
```

---

## 8. 与今天 IR 的等价映射（证明「够用」）

**包级**（`PACK_KEYS` 21 → `meta`）：

| 今天 | L2 |
|---|---|
| `spec_version` | 无（脚本版本 = `script_sha256`） |
| `id`/`label`/`goal` | `meta` |
| `model` | `meta.model` |
| `max_subgoals` | `meta.limits.maxSteps` / `ctx.budget` |
| `hosts` | `meta.hosts` |
| `slots`/`required_slots` | `meta.slots` / `meta.requiredSlots` + `ctx.slots` |
| `sources`/`source_slots` | `meta.sources` + `ctx.source()`（变量取值） |
| `roles`/`journey` | `flow(ctx)` |
| `invariants` | `meta.invariants`（结束态求值） |
| `notes` | `meta.notes` |
| `probe` | **待定**（建议留在脚本之外，见 §10 Q4） |
| `device` | `meta.device` |
| `max_step_visits` | 无（控制流） |
| `generated_from`/`recorded_from` | 引擎写入 `meta.recordedFrom` + 运行结果 `script_sha256` |
| `policy` | CLI/引擎选项 |

**步级**（`STEP_KEYS` 21 → `StepRequest` 5 项）：`role/desc/signal/slots/retries/id/next/adapter/returns/
start_url/target_hint(s)/when/commands/effect/source/args/dry_run_args/idempotent/dangerous/adjudicate`
→ `desc` + `{done, act, adjudicate, timeoutMs, meta}` + `ctx.run/dangerous/open`。

---

## 9. 迁移：`fromLegacy` 过渡层（不必一次重写 21 个包）

```js
// 过渡期：把既有 pack.json 包起来跑在新运行期上；逐包「去 wrap」
export { meta, flow } from "../../legacy/from-pack.mjs";   // 内部：loadPack → 逐步 ctx.step
```

`fromLegacy` 只做两件事：把 `journey` 逐步翻译成 `ctx.step`，把 `invariants`/`slots`/`hosts` 搬进 `meta`。
它的存在让 L1→L2 的切换**逐包可回退**：新运行期先证明 `fromLegacy` 与老执行器逐字段等价，再逐包重写。

---

## 10. 决策记录（Q1–Q6，2026-10-24 定稿）

| # | 问题 | 建议 |
|---|---|---|
| Q1 | `act` 省略（只给 desc，让模型选元素）要不要保留？ | **不保留**（2026-10-24 拍板）：`act` 必填，每步必须点名目标或命令闭集；「什么都没声明」从运行期停因 `step_names_no_target` 变成**加载期错误**。纯导航步用 `ctx.arrive(url,{done})` 显式表达（`apps/bilibili-hot` 2 步）。hint 未命中仍按既有纪律回落 laya（模型是兜底，不是默认路径） |
| Q2 | 脚本能不能看到 `confidence`（模型分）？ | **不能**（2026-10-24 拍板，且收紧到 `method` 也不给）：`StepResult.evidence` 只留 `{url,attempts,elements,elapsedMs}`；`method`/`conf`/`score_kind` 只在 trace。要「低置信时做点什么」用闭集选项 `onLowConfidence: "retry"|"escalate"|"fail"`，由引擎实现 |
| Q3 | `meta.site` 取代 `sites/*.profile.json`，还是迁移期先读旧档案？ | 按建议（未反对）：迁移期**读旧档案**，L3 时再收进脚本 |
| Q4 | `probe`（线上测量声明）放哪？ | 按建议（未反对）：留在 JSON/独立测量面——它是「测出来的事实」，不是流程 |
| Q5 | `ctx.rows({row, fields})` 要不要（新抽取小语法）？ | 按建议（未反对）：**先不要**，v1 只给 `ctx.extract(name)`（走 `meta.site.listExtract`），零新语法 |
| Q6 | `ctx.done()` 必需，还是允许 `return`？ | 按建议（未反对）：**必需**，否则"没跑完"与"跑完"分不清；缺调用 = 结构化停因 |

---

## 11. 怎么证明这份草案"够用且不多"（验收，草案级）

1. **够用**：用 3 个真实应用写 L2 版，`check` + `explain` 通过，且 `dry` 展开的步骤序列与今天
   `pack.json` 的 `journey` **逐条对应**（不要求逐字节，要求"步数/顺序/完成条件"一致）：
   `checkin-binding`（线性 + `<select>` 绑定）、`ip-config`（批量 + 条件 + 行内证据）、
   `transfer-trekly`（滑块 + 命令闭集 + 数据腿）。
2. **不多**：`meta` ≤ 12 项、`StepRequest` ≤ 5 项；9 个概念删除；`ctx` 成员 = **26**（22 个函数/属性 + 4 个构造器命名空间 `judge`/`tool`/`read`/`value`）。
3. **能落地**：§3 的每一行「引擎落点」都能 `grep` 到；**出现新函数 = 本草案要改**。
4. **不倒退**：危险步仍被拒（`refused` 显式）、`hosts` 外导航仍被拦、`inert`/`no_progress` 仍在 trace 里。

---

**下一步（等拍板）**：先在仓库外写一个**纯原型**（不接真执行器，只把 `ctx` 接口 + dry 实现跑通），
用上面 3 个应用的 dry 输出做对照；再决定是否接 `BrowserMiddleware`。
---

## 12. 实现状态（2026-10-24，commit `ebe2c0a`）

**已实现**（`src/app/{ctx,ctx-dry,ctx-replay,trace}.ts`，测试 `tests/{ctx,trace}.test.ts`）：

| 类 | 成员 | 实现方式 |
|---|---|---|
| 元信息 | `app` / `slots` / `runtime` / `budget` / `log` | 只读对象；`log` 只进 trace（不污染 stdout） |
| 导航 | `open` / `arrive` | `hosts` 信封在 `open`/`step` 起点强制；`arrive` = 无目标的 `mw.run` |
| 执行 | `step` | `mw.run`（唯一执行循环）；`act` 必填；完成由 `checkSignal` 裁决 |
| 观察 | `url` / `read.{text,value,count}` / `holds` | `locatorAnyFrame` / `checkSignal` |
| 构造器 | `judge.*` / `tool.*` / `hint` / `hints` / `command` / `value.*` | 与 L1 `kit` **同一份实现**（复用，不复制） |
| 数据 | `source` / `data.{min,max}` | `runSource` / 同一份 min-max 语义 |
| 收尾 | `done` | 结束态不变量（`checkSignal`）；失败 = `invariant_failed` |

**已接线**：`ctx.run` / `ctx.dangerous`（工具步）——经 `CtxDeps.toolRunner` 接到既有 `runToolStep`
（干跑/确认/幂等重试的唯一实现），驱动里把 `ToolRunRequest` 装成 `ExpandedStep`；危险步默认 `refused: dangerous`。

**本版未接线（调用会抛明确 `config_error`，不静默）**：
`ctx.openPage`（`meta.site.pages` 映射）、`ctx.read.attr`、`ctx.rows` / `ctx.extract`（Q5 的 v1 只给 extract，但需要 `meta.site.listExtract` 先入 schema）。
**实现备注**：`StepResult.evidence` 实际只有 `{url, attempts, elapsedMs}`（草案里的 `elements` 暂无公开缝）；
审计口径不变：脚本仍只看 `stopCode`，`method`/`conf` 只在 trace。
