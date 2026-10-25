# 应用脚本作者指南（flow / 声明式 · 校验 · 轨迹 · 扩展）

> 面向"要接入/修改一条业务流程"的人（也面向替你写脚本的 Agent）。
> 设计动机与实施状态见 [L2_CTX_API_DRAFT.md](L2_CTX_API_DRAFT.md)、[L2_IMPLEMENTATION_PLAN.md](L2_IMPLEMENTATION_PLAN.md)；
> 审计发现见 [SCRIPT_AUTHORING_AUDIT.md](SCRIPT_AUTHORING_AUDIT.md)。

## 1. 两种形态，先选一个

| | **flow 脚本**（默认） | **声明式数据脚本** |
|---|---|---|
| 导出 | `export const meta` + `export async function flow(ctx)` | `export const meta` + `export const app` |
| 能写什么 | 普通 JS：循环、条件、重试、组合调用 | 纯数据：`journey` 步骤列表 + `invariants` |
| 适合 | 有分支/循环/重试/需要看中间结果的流程 | 线性流程、由生成器产出、要能被工具同步比对 |
| 工具链 | 异步读取（`apps show/check/expect/run/explain`） | 同步读取（矩阵/生成器/迁移工具也能读） |
| 生成 | `amber apps new <id>`（默认） | `amber apps new <id> --kind data` |

一条命令生成可跑骨架（用仓库自带的 `testpages/portal.html`，生成即可 check/dry-run）：

```bash
amber apps new my-app                        # 默认 flow，落到 $AMBERFLOW_HOME/apps/my-app/app.mjs
amber apps new my-data --kind data --print   # 只打印声明式数据脚本源码
```

## 2. 只读的验证回路（每一步都不开浏览器）

```bash
amber apps check   my-app     # 结构 + 信号/命令/工具声明校验（flow 会 dry 跑一遍调用序列）
amber apps explain my-app     # 人话：每一步做什么、完成条件、结束态不变量
amber run my-app --dry-run    # 预演：flow 打印调用序列；声明式打印展开后的计划
```

- `check` 的 problems 带路径，可直接照着改；**dry 通过 ≠ 页面状态会成立**（它证明的是调用序列合法）。
- flow 的配置错误一次报一个（迭代式）；语法错误只有 Node 的一句话（行号不在 problems 里）。

## 3. flow 脚本：形状与运行期面

```js
export const meta = (kit) => ({
  id: "my-app",                    // = 目录名 = amber run 的参数
  label: "我的应用",
  goal: "一句话说清这条流程要达成什么",
  hosts: ["shop.example.com"],     // 线上应用：导航信封 + 防泄漏门禁的输入（离线夹具写 []）
  slots: { coupon: "SAVE10" },     // 数据槽：值只能来自声明 / 观测
  policy: { conf_floor: 0.4 },     // 可选：运行策略（见 §7）
  invariants: [                    // 结束态断言；在 ctx.done() 时验收
    { id: "on-thanks", desc: "结束时在感谢页", signal: kit.judge.url("thanks.html") },
  ],
});

export async function flow(ctx) {
  await ctx.open("https://shop.example.com/");
  const r = await ctx.step("把商品加入购物车", {
    act: ctx.hint("[data-test=add-to-cart]"),        // 目标（顺序：ctx.hints(...) / 命令闭集）
    done: ctx.judge.text("[data-test=cart-count]", "1"),  // 完成只认证据面
  });
  if (!r.ok) throw new Error(`失败：${r.stopCode} ${r.reason ?? ""}`);
  await ctx.done();                                   // 不变量在这里验收（失败抛 invariant_failed）
}
```

**ctx 运行期面**（`src/app/ctx.ts`；dry/replay 实现同形）：

| 类别 | 成员 | 说明 |
|---|---|---|
| 元信息 | `ctx.app` / `ctx.slots` / `ctx.runtime` / `ctx.budget` / `ctx.log(msg, data?)` | `slots` 只读；`runtime = {outDir, runId, today}` |
| 导航 | `ctx.open(url)` / `ctx.arrive(url, {done, desc?})` | `arrive` = 无目标的导航步；`hosts` 信封在起点强制 |
| 执行 | `ctx.step(desc, {act, done, url?, slots?, when?, timeoutMs?})` | `act` 必填；`done` 必填；返回 `{ok, stopCode?, reason?, evidence}` |
| 观察 | `ctx.url()` / `ctx.read.{text,value,count,attr}(sel[, attr])` / `ctx.holds(signal)` | 只读；读不到返回 null/0 |
| 站点面 | `ctx.openPage(role)` / `ctx.extract(name)` / `ctx.rows(...)`（v1 关闭） | 声明在 `meta.site`（见 §3.1）；`rows` 调用给结构化错误 |
| 构造器 | `ctx.judge.*` / `ctx.tool.*` / `ctx.hint()` / `ctx.hints()` / `ctx.command()` / `ctx.value.*` | 与声明式 kit **同一份实现** |
| 数据 | `ctx.source(name)` / `ctx.data.{min,max}(rows, by)` | 数据腿按需拉取；`--skip-data` 时 `source` 报结构化错误 |
| 进程 | `ctx.run(...)` / `ctx.dangerous({...dryRunArgs})` | 见 §6；危险步默认拒绝 |
| 收尾 | `ctx.done()` | 结束态不变量验收 |

**控制流是你的**：重试就是 `for`，分支就是 `if`，子流程就是函数。引擎只管"一步之内"
（元素池 / 选元素 / 闸门 / 动作 / 证据 / 绑定）——脚本拿不到模型文本或分数，只能看结构化结果。

### 3.1 站点面：`meta.site`（页面角色 / 命名行抽取）

站点相关的数据**声明在应用自己的 meta 里**（与 hint / 探针同一条纪律：不进共享代码）：

```js
export const meta = (kit) => ({
  id: "price-watch", label: "盯价", goal: "读列表页最低价", hosts: [], slots: {},
  site: {
    pages: { home: "testpages/portal.html" },                 // 角色 → URL（openPage 用）
    listExtract: {                                            // 命名行抽取（extract 用）
      entries: { rows: "nav.menu a", fields: { label: "." } }, // "." = 行自身文本
    },
  },
});

export async function flow(ctx) {
  await ctx.openPage("home");                                  // 找不到角色 = config_error（点名已知角色）
  const rows = await ctx.extract("entries");                   // Array<{ field: string }>
  const href = await ctx.read.attr("[data-test=entry-fixed]", "href");   // 不存在 → null
  const n = await ctx.read.count("nav.menu a");
  await ctx.done();
}
```

- `ctx.extract(name)` 的字段选择器是**行内相对选择器**；`rows` 最多取 500 行（超出在 trace 里标 `truncated`）。
- `ctx.rows({row, fields})` 是 Q5 明确**不开放**的新语法：调用会给结构化 `config_error` 指向 `extract(name)`。
- dry 模式下 `extract` 返回 `[]`、`read.attr` 返回 `null`（没有页面）——脚本在 dry 期不要依赖观察值。
- 观察类调用（text/value/count/attr/extract）都会进 trace，所以带读取的脚本可以 `--replay`。

## 4. 声明式数据脚本：固定形状 + 标记

```js
// @amberflow:declarative-data —— 这一行是标记：它声明"本文件是数据，不是逻辑"
const META = { id: "my-data", label: "…", goal: "…", hosts: [], slots: {}, invariants: [ … ] };
const DATA = {};                       // 数据槽；`{ kind: "source", source: "demo-tool", select: … }` 是数据腿绑定
const JOURNEY = [                      // 只是数据：desc / start_url / target_hint(s) / signal / slots / when / retries
  { desc: "打开页面", start_url: "testpages/portal.html", target_hint: "[data-test=entry-fixed]",
    signal: { url_contains: "camera_a.html" } },
];
export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });
```

- 手写时保持 `const META/DATA/JOURNEY = …` 这三个名字与标记不动（同步工具按固定形状解析，不执行代码）。
- 想要循环/条件 → 用默认的 flow 形态；不要给声明式脚本塞函数（它会被当成普通值或校验失败）。
- 由 `apps:gen` 生成的应用就是这种形态：**改来源（spec）再重新生成，不要手改**。

## 5. 完成信号与结束态不变量

完成只认证据面，三种构造器都来自 `kit`/`ctx`：

- DOM：`ctx.judge.url(...)`、`exists`、`text`、`value`、`all(...)`、`any(...)`、`not(...)`；
- 进程：`ctx.tool.exitOk()`、`exitCode(n)`、`stdoutContains`、`stderrContains`、`jsonPath`、`fileExists`…；
- 组合器可嵌套。**不要用"看起来完成了"代替证据**：`ctx.step` 返回的 `ok` 就是 done 信号是否成立。

结束态不变量写在 `meta.invariants`，由 `ctx.done()` 在**同一页面**上验收（失败 = `invariant_failed`）。
不变量看不到中间状态——中间要求写进每一步的 `done`。至少需要一个浏览器步（纯工具应用不要写 web 不变量）。

## 6. 进程步与适配器（cli / ssh / stdio）

两种写法等价（共用同一份校验/展开/执行实现）：

```js
// ① 命令行形式
const a = await ctx.run("demo-tool", ["--flag"], { done: ctx.tool.exitOk(0) });
// ② 声明形式（任意支持器；形状 = 声明式 journey 的一步）
const b = await ctx.run({
  desc: "在远端跑一条只读命令",
  adapter: "ssh",                       // 省略时：有 source→cli；有 ssh→ssh；有 stdio→stdio
  ssh: { host: "127.0.0.1", argv: ["test", "-f", "/tmp/x"] },
  idempotent: true, retries: 2,
  done: ctx.tool.all(ctx.tool.exitOk(0), ctx.tool.stdoutContains("ok")),
});
```

三条纪律由引擎执行，脚本只声明：`retries>0` 必须有 `idempotent:true`；`dangerous` 必须有
`dryRunArgs` 且干跑失败绝不 apply；危险步**默认拒绝**（`--allow-dangerous` 才执行），拒绝会带
`stopCode="dangerous"` 与人话 `reason`，脚本可以据此分支（例如记录"本次未放行"后继续）。
可用适配器：`cli` / `ssh` / `stdio`（`web` 步走 `ctx.step`）。

## 7. 策略、消融与学习环

- `pack.policy`：`conf_floor` / `tiered_hint` / `reobserve` / `max_effective_repeats` / `risk_ask`。
  生效优先级：**CLI 本次显式 > pack.policy > provider 自报 > 缺省**；产物里的 `effective_policy`
  只在非缺省时出现，并写明来源（`cli` / `pack` / `provider` / `default`）。
- CLI：`--conf-floor N`、`--tiered-hint`、`--learn-hints` / `--hint-memory FILE`、`--ablate stub|rules-only`。
- `--force-hints off` **只适用于声明式应用**：flow 的 hint 是脚本调用参数，没有声明层可剥——
  CLI 会明确拒绝（exit 2），而不是静默无效。

## 8. 执行轨迹与重放（审计/交接）

```bash
amber run my-app --emit-trace /tmp/run.trace.json   # app/script/inputs 三个 sha + 逐次 ctx 调用
amber run my-app --replay /tmp/run.trace.json       # 不重新决策；脚本版本或输入槽位不一致直接拒跑
```

- `trace.done` + `stop_code` + 每次调用的 `{ok, stop_code}` 是审计事实；`result` 里另带 `reason`/`adapter`/耗时。
- `inputs_sha256` 只含槽位与 hosts（**不含** outDir/runId）：重放因此可跨机器。
- 真实运行两次的**结构**（调用序列 + 结果）应一致；耗时字段不参与比较（`sameEventStructure`）。

## 9. 错误码与排查

`stopCode` 是脚本看到的**唯一**失败分类（`reason` 给人读）：

| stopCode | 含义 / 下一步 |
|---|---|
| `config_error` | 脚本声明/运行配置错（缺 done、未知 op、未知适配器、`ctx.open` 打不开…）——改声明，不要重试 |
| `host_not_allowed` | 目标主机不在 `meta.hosts` 信封内——要么加 hosts，要么别导航过去 |
| `budget_exceeded` | 步预算/截止时间用完——检查死循环，或调大预算 |
| `invariant_failed` | `ctx.done()` 时结束态不变量不成立——看是流程没走完还是页面变了 |
| `trace_mismatch` | 重放时脚本与轨迹的调用序列不一致——版本/输入变了，重新跑而不是重放 |
| `dangerous` / `declined` / `dry-run-failed` / `tool-unavailable` / `needs_value` | 工具步的显式拒绝类别（`REFUSAL_LABELS` 有一句话解释 + 怎么补救） |
| 其它（如 `max_steps`、`low_confidence`、`blocked`） | 执行器结构化停因，原样透出 |

排查顺序：`apps check`（声明）→ `apps explain`（序列）→ `run --dry-run`（预演）→
`run --verbose --emit-trace`（真跑 + 轨迹）→ 看 trace 里第一次 `ok:false` 的 `stop_code/reason`。

## 10. 边界（当前版本明确不做）

- **脚本是进程内任意代码**：信任边界 = "用户作用域 + 不放仓库 + `AMBERFLOW_NO_SCRIPTS=1` 可关"；
  结果里带 `script_sha256`。沙箱未做。
- `ctx.openPage` / `ctx.extract` / `ctx.read.attr` 已接线（声明在 `meta.site`，见 §3.1）；
  仅 `ctx.rows({row, fields})` 按 Q5 在 v1 关闭（结构化错误指向 `extract(name)`）。
- `ctx` 是**运行期面**：不要指望 `ctx.page` / locator / 模型分数——那是执行器内部（红线②）。
- flow 应用目前没有静态 IR 可 `emit`（`apps emit` 会拒绝）；审计能力用 `--emit-trace` 的轨迹。

## 11. 扩展配方（改引擎的人看）

| 想加什么 | 触点（按顺序） | 验证台 |
|---|---|---|
| **ctx 新成员** | `Ctx` 接口 → 三个实现（`ctx.ts` / `ctx-dry.ts` / `ctx-replay.ts`）→ `tests/ctx.test.ts` 的 dry-vs-real 调用序列断言 | 同一脚本 dry 与真实运行的结构一致性测试 |
| **meta 新字段** | `declarative.ts` 的 `META_FIELD_MAP`（**唯一清单**，序列化与降级共用）→（若需运行期支持）`ctx`/执行器 | 表驱动 round-trip + `apps:migrate --all --check` |
| **新信号算子** | DOM 面：`signals.ts` 的 `DOM_SIGNAL_GRAMMAR` + `checkSignal`；进程面：`browser/tool-signals.ts` 的 `TOOL_SIGNAL_OPS` + `checkToolSignal`（校验走同一 walker） | `tests/signal-grammar.test.ts` / `tests/cli-transport` 等 |
| **新应用支持器** | `app-adapters.ts` 实现 `AppAdapter`（kind/legacyKind/validateStep/expand/run）并注册；`ctx.run` 声明形式自动可用（它只按注册表分派） | 支持器自己的单测 + `tests/ctx-adapters.test.ts` |
| **新 CLI 旗标** | `src/support/cli-args.ts` 选项 → `src/cli/registry.ts` help → 命令实现 → 转发到 app-runner（若适用） | 命令层测试（`tests/cli-harness.ts` 可断言转发参数） |

## 12. 命令速查

```bash
amber apps list / show <id|路径> / path <id> / remove <id> [--yes]
amber apps new <id> [--kind flow|data] [--dir D] [--print] [--force]
amber apps check [<id|路径>] / explain <id|路径> / emit <声明式脚本> [--out F]
amber run <id|路径> [--dry-run] [--headful] [--slot k=v] [--out DIR]
          [--allow-dangerous] [--conf-floor N] [--tiered-hint]
          [--emit-trace F] [--replay F] [--json]
npm run apps:matrix     # 声明面度量（来源/步骤/代码行/泄漏/债）
npm run apps:suite      # 全部旅程型应用验收（声明式 + flow 脚本两条臂；真模型臂；缺 ONNX 时按消融臂说明运行）
```
