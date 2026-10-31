# 应用脚本作者指南（flow · meta · ctx · 校验 · 轨迹）

> 面向“要接入/修改一条业务流程”的人，也面向替你写脚本的 Agent。
> Agent 与 DSH 桥的稳定契约见 [AGENT_INTERFACE.md](AGENT_INTERFACE.md)；本篇讲作者面。

## 0. 30 秒快速路径（引擎引导，唯一出处 `src/engine/planning-playbook.ts`）

> 本节两段文字由引擎模块生成，`npm run prompt-hit` 第 6 层逐字校验——改文案先改模块再跑工具，勿手抄改写。
> 同一份五步法也写在 `apps new` 骨架注释头部与桥 `_app_create` 工具描述里（同一出处，多面分发）。

```text
高效规划五步法（Planning Playbook）：
① 先看再写：amber inspect --url <页> --json 拿验证过的 hint_candidates——有候选照抄，别自创选择器；
② 单步探针先行：先写 1 步探针应用（arrive + read）验证四件事：页面可达 / 登录与验证可处理 / 无风控拦截 / 目标数据在 DOM。探针 30 秒判死刑，好过全流程应用跑 5 轮；
③ 正式应用参数化：单段/单城 + slots，1 步 flow；早停守卫（凭据/验证不可得，或命中反爬风控 → ctx.fail("blocked:…")）+ meta.policy 声明 done_timeout_ms，不盲等；
④ 离线分支校验：amber apps check <id> --slot k=v（不启浏览器）验证各分支调用序列；
⑤ 真跑留证：amber run <id> --trace；失败先看 trace 的 stopCode/reason——reason 自带修正指引。
```

```text
失败特征速查（只判不绕反爬风控：命中反爬风控即 ctx.fail("blocked:…") 早停；验证环节可代过）：
- body 极短（<200 字符）+「登录/注册」浮层 = 登录墙：换可匿名读价的来源，或用凭据 + 验证步骤处理；无凭据/无授权时如实标 blocked，别重试表单；
- 卡片价格处全是「登录看低价」= 服务端价格闸：匿名会话拿不到价格，不是渲染问题，早停；
- 价格列全是「查价」+ 页尾「服务器异常」= 站点限流：等待与重试无效，早停；
- 「依次点击图标验证 / 滑动拼图」= 验证码：属验证环节，可在用户授权下由人工步/注入处理器代过；若站点同时以风控/限流拦截（反爬），不绕，立即早停。
```

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

- 敏感槽位：值建议走环境变量/本机配置；CLI 用 `--slot-file FILE`（JSON 对象）而不是 `--slot`，并在 `meta.secretSlots` 声明槽位名——result/report/stdout/dry 会掩码为 `***`。
- `apps check` 不打开浏览器：它证明“脚本能加载、调用序列合法、信号/命令/槽位可校验”，**不证明页面状态会成立**。
- `inspect` 只读：标题、URL、有界元素、候选 hint；不点击、不输入、不调模型。元素池视图**只含可行动元素**——写 `exists` / `text` 类完成信号前先 `inspect --probe "<selector>"`（可重复，最多 10 个；只读返回存在数与前 5 条文本，`--json` 落 `probes[]`），别用 raw HTTP 之外的口子。**任何选择器——包括本文档与上游示例给的——落笔前都要对目标页实证一次**（02 轮 C6 的教训）。
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
  secretSlots: ["password"],       // 敏感槽位：产物掩码；值走 env/本机配置或 --slot-file
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
| `secretSlots` | 敏感槽位名单（如 `password`、`otp`）：result/report/stdout/dry 输出时掩码为 `***`；值仍建议走 env/本机配置，别写进 app.mjs |
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
| 元信息 | `ctx.app` / `ctx.slots` / `ctx.runtime` / `ctx.budget` / `ctx.log(msg, data?)` | `slots` 只读；`runtime = {outDir, runId, today}`；`today` = CLI `--today YYYY-MM-DD` 钉住的"今天"，没钉 = 系统日期 |
| 导航 | `ctx.open(url)` / `ctx.openPage(role)` / `ctx.arrive(url, {done, desc?, id?, timeoutMs?})` | `arrive` = 纯导航 + 等信号，不做元素选择、不花模型；`hosts` 信封在起点与落地都强制 |
| 决策语句 | `ctx.step(goal, { id?, act?, done, url?, slots?, when?, timeoutMs? })` | `done` 必填；`act` 省略 = 引擎决定目标，给了 `ctx.hint()`/命令闭集才收窄候选；返回 `{ok, id?, stopCode?, reason?, evidence}` |
| 人工步 | `ctx.manual(desc, { done, instructions?, id? })` | 见 §7；非 TTY 返回 `needs_human`，不假装有人 |
| 观察 | `ctx.url()` / `ctx.read.{text,value,count,attr}(sel[, attr])` / `ctx.holds(signal)` / `ctx.waitFor(signal, {timeoutMs?, pollMs?})` | 只读；读不到返回 `null` / `0`；`waitFor` 轮询到 bounded deadline，返回 boolean |
| 站点面 | `ctx.openPage(role)` / `ctx.extract(nameOrSpec)` / `ctx.rows(...)`（v1 关闭） | 具名抽取声明在 `meta.site.listExtract`；inline 抽取用 `{ rows, fields, maxItems? }`；`rows` 调用给结构化错误 |
| 数据 | `ctx.source(name, {dates?})` / `ctx.data.{min,max}(rows, by)` | 数据腿按需拉取；`--skip-data` 时 `source` 报结构化错误。`dates` 显式给本次范围（单日 / `A..B` / `next_week`）；缺省按 source JSON 的 `default_dates`（支持 `"{slot}"` 占位符，从包默认 + `--slot` 解析；不许引用 `source_slots` 产物）。观察视图 `byDate` 按日期保留完整 counts/selects/rows |
| 进程 | `ctx.run(...)` / `ctx.dangerous({...dryRunArgs})` | 见 §6；危险步默认拒绝 |
| 构造器 | `ctx.judge.*` / `ctx.tool.*` / `ctx.hint()` / `ctx.hints()` / `ctx.command()` / `ctx.value.*` | 与 `kit` 同一份实现；命令 op 见下 |
| 收尾 | `ctx.done()` | 结束态不变量验收；之后不允许再有动作 |
| 终止 | `ctx.fail(code, reason?)` | 抛结构化 `StopError`，退出码/状态走引擎既有分类，不抛裸栈 |

- `when` 是适用性守卫：动作前判定，不成立时该步不执行（返回 `ok:false`、`stopCode:"precondition_skipped"`），脚本可以据此分支。跳过步**同样消耗一次执行预算**，trace 里状态记为 `skipped`（不是 `failed`）；不要把 `if (!r.ok) ctx.fail(...)` 的失败模板直接套在守卫步上，先判 `r.stopCode`。
- `act` 缺省就是“决策语句”：只给目标语义和完成证据，让规则/模型选元素；硬编码 `ctx.hint(...)` 只作为稳定锚点或候选收窄，不应成为每条流程的默认。
- 导航同样优先用 `meta.site.pages` + `ctx.openPage(role)`，而不是在流程里重复硬编码 URL；业务值优先用 `meta.slots` / `ctx.source`，不要写死在 `flow` 里。**运行期才知道的 URL**（如命中链接的相对 href）可在 flow 里 `new URL(href, ctx.url())` 绝对化——URL 全局构造器在脚本进程可用（06 轮实证），这是"角色覆盖不到的动态地址"的正规通道，不是硬编码豁免。
- 命令闭集的 op 是引擎能力面：`click` / `check` / `fill` / `select` / `scroll` / `drag` / `skip`。
  `scroll` 把目标滚入视口；`drag` 的 value 是落点 selector（可来自槽位），只在 `[draggable=true]` 或 slider 族元素上声明能力。
  `skip` = 按定义解决的零动作命令：全部命令解决后引擎会**评估一次 done 信号**再判成败——"导航由 arrive 完成、本步只验证到达"的守卫步合法可用（04-A 修复；此前 skip 步的 done 从未被评估，必报 `done_not_held`）。
  不在能力面内的 op 会得到 `action_unsupported`，目标歧义是 `target_ambiguous`，目标不存在是 `target_not_found`。
- **act hint 是六形状语法闭集**（唯一解析器 `src/engine/hint.ts`，语法**描述**的唯一出处 `src/engine/grammar-prompt.ts`，`npm run prompt-hit` 校验示例可命中、报错/提示词/桥描述不漂移）：`#id` ｜ `tag[attr~substr]` ｜ `tag~token` ｜ `tag[attr=value]`（值去引号、全小写折叠）｜ 角色词 `button|link|input|textarea|select` ｜ 裸词（按 label 匹配）。属性名按池字段匹配：test→data-test、type→input_type、href、name、id、role、near；class、title 等不在池字段模型里，永不命中（本句由 grammar-prompt 的 ATTR_MATCH_MODEL_TEXT 生成，prompt-hit 逐字校验，勿手改）。**容器/后代 CSS（如 `#outer input`）不是语法错误——会被解析成一个永不命中的形状**；命令空间的 `target_not_found` reason 附闭集提示，而 act hint 落空会**静默回退模型决策**、报 `low_confidence` 不附提示——写 hint 前先 `inspect` 拿验证过的 `hint_candidates`。
- **hint 与 done 信号是两个观察面**：`ctx.judge.*` 的 selector 走 DOM 查询面（任意 CSS 可用）；act hint 走上述语法闭集 + 元素池投影。`inspect --probe` 数的是 DOM——probe 命中数 ≠ hint 可命中，别互相推断（03-D2/D3；闭集提示只出现在命令空间 `target_not_found` 的 reason 里）。
- 停因 reason 里的 "on step N" 是**子目标内动作步号**，与 CLI/`step_traces` 的流步号不是一个口径（04-B）。
- `ctx.step` 的 `timeoutMs` 约束的是**本步动作后等待 done 信号成立的窗口**（映射该步的 `done_timeout_ms`），不约束整步挂钟时长——模型咨询、导航渲染不在其内（04-F）。
- 导航：`ctx.open/openPage` 只做 goto（domcontentloaded），**不等 done/信号/settle**；要"导航 + 等落地证据"用 `ctx.arrive(url, { done })`（04-C 实测：open 后半路即返，arrive 带轮询等待）。
- **预算是三层结构**（07-A/08-A6 实测成文，别按"一层"规划）：
  **① flow 调用预算**——`ctx.budget.maxSteps` / `stepsUsed`（缺省 100，CLI `--max-steps` 覆盖）；`ctx.step`、`ctx.arrive`、`ctx.run` 与批准执行的人工步一律计 1——`when` 跳过的步也计（02-C2），`read/extract/holds/log` 免费；一次 `ctx.run` 恒 ≤1，其内部 attempts（重试）与 timeout 不放大本层。用满抛 `budget_exceeded`（CLI 给 `--max-steps` 时结果 `partial`、exit 0）。
  **② 子目标动作预算**——执行器每次调用的动作循环上限，**缺省 8、当前不可配置**（`executor.ts:884`），只活在停因文案里（`max_steps=8`；reason 的 "on step N" 是本层动作号，与流步号两口径——04-B）。
  **③ 信号等待窗口**——浏览器腿 done 轮询 per-click 语义（`done_timeout_ms` 缺省 2000，步级 `timeoutMs` 覆盖，04-F/07-E："7 击各享窗口，非整步挂钟"）；进程腿 `stdio.timeout_ms` 是步内挂钟帽（缺省 20s）。
  **同为 `config_error`，抛出层决定计费**（08 实测）：cli 形式声明校验在①扣费**前** throw（免费）；适配器 toolRunner 内拒绝（如 stdio+retries）在扣费**后**返回（贵一步）。按"动作数"估①必翻车——守卫跳过、被拒声明都计费。
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
- dry 模式下 `extract` 返回 `[]`、`read.attr` 返回 `null`、`waitFor` 立即返回 `true`（没有页面）——脚本在 dry 期不要依赖观察值；**一切基于观察值的 `ctx.fail`/分支/断言都必须用 `ctx.runtime.runId === "(dry)"` 守卫**：`apps check` 与 `--dry-run` 会真跑 flow，没有守卫的数据驱动停会把合法脚本判成 problems（03-D1 配方；需要严格断言数据时，只在真实运行里停）。**dry 模拟面全表**（06-B，`createDryCtx` 实证）：`step`/`arrive`/`run`/`manual` 恒返回 `ok:true` 且 **`when` 不评估**（stopCode 恒空 ⇒ `precondition_skipped`/末页 exhausted 这类分支在 dry 结构性不可预演）；`read.*` 返 null/0；`url()` 是最近声明值；步预算照常计数。结论：**dry 验调用序列与声明形状，不验分支覆盖**——check VALID ≠ 脚本每条分支都被走过，守卫分支的正确性只有真实运行能证明。**循环特别警告**（09-B，r09-retry-demo 实录）：`step` 模拟恒 `ok:true` ⇒ 以"步骤成功"为 break 条件的 `while/for` 会在 dry **假成功早退**，随后未守卫的终局 `ctx.fail` 把 dry 判红（报错自曝 `ok:true` yet exhausted 的矛盾即此坑）——dry 预演只到声明面为止，循环语义一律真实运行验；各分支的**声明校验**可用 `run --dry --slot <k>=<v>` 逐分支触达（08 实证，不占真实额度）。
- 观察类调用（text/value/count/attr/extract）都进 trace，所以带读取的脚本可以 `--replay`。进程步（`run`/`dangerous`）自 08-C 修复起同样进 `step_traces`（成功步无 stop_code、attempts/exit code 在嵌套 result 里）。

## 6. 完成信号与结束态不变量

完成只认证据面，构造器都来自 `kit` / `ctx`：

- DOM：`ctx.judge.url(...)`、`exists`、`text`、`equals`、`value`、`all(...)`、`any(...)`、`not(...)`；
- 进程：`ctx.tool.exitOk()`、`exitCode(n)`、`stdoutContains`、`stdoutMatches`、`stderrContains`、`jsonPath`、`fileExists`、`fileAbsent`；
- 组合器可嵌套。**不要用“看起来完成了”代替证据**：`ctx.step` 返回的 `ok` 就是 done 信号是否成立。
- **可用的 done = 「动作前不成立、动作后成立」**（判据，05/06 轮案例实证）：动作前已成立的信号（如任何页都真的 `exists("h1")`）在验证面**零贡献**——这一步的绿完全外包给 goal 语义与模型恰好点对，落点再意外也判绿（r06 `wide-done-sample` 实录）。守卫/到达/翻页步尤其警惕；用位置类选择器（`nth-child`/`nth-of-type`）前先实证**动作前命中数为 0**——站点数据可能自带"第 11 条"（r05 实证 `div.quote:nth-of-type(11)` 未滚动已真）。翻页类 done 优先用 URL 参数片段或**下一页独有内容锚**，别用两页共有的 h1/容器。

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
- 人工步不自动过；验证环节（登录/2FA/验证码）可在用户授权下由人工步/注入处理器代过，不绕反爬；凭据由用户在本机配置/环境变量/受支持的凭据存储中保存、引擎按名读取且不写入产物（本版本未内置凭据保险箱）；引擎只验证最终信号。详见 [MANUAL_STEPS_AND_PACE.md](MANUAL_STEPS_AND_PACE.md)。

## 8. 运行策略、节奏与学习环

`meta.policy` 的字段（生效优先级：**CLI 本次显式 > `meta.policy` > provider 自报 > 缺省**）：

| 字段 | 缺省 | 说明 |
|---|---|---|
| `conf_floor` | 0.25（或 provider 自报） | 置信度闸门；换 provider 时缺省刻度不可比，用它可以声明。**注意它是动态下限**：子目标内每多禁用一个失败元素，有效闸门下调 0.05、下限 0.10（兜底降级：候选耗尽前"宁选次优不空转"，`executor.ts` `floor=max(0.10, confFloor−0.05×forbidden)`）；低置信停因的 reason 会露出当次有效 floor（03-D6/04-G） |
| `tiered_hint` | `false` | hint 档内歧义时问模型更小的问题（P1 实验） |
| `reobserve` | `true` | 动作后重新观察 |
| `max_effective_repeats` | `3` | 同一子目标里同一动作的最大有效重复 |
| `risk_ask` | `always` | `rules-only` = 风险只走规则，不花每步前向 |

产物里的 `effective_policy` 只在非缺省时出现，并写明来源（`cli` / `config` / `app` / `provider` / `default`）。

`meta.pace` 声明运行节奏（毫秒，`0..60000`，加载期校验）：`between_steps_ms` 是两次执行步（`ctx.step` / `ctx.arrive` / `ctx.manual` / `ctx.run`）之间的最小等待，`between_actions_ms` 是同一浏览器子目标内两次动作之间的等待。优先级：**本次显式（嵌入方 opts） > `meta.pace` > 环境变量 > 0**；环境默认是 `AMBERFLOW_STEP_DELAY_MS` / `AMBERFLOW_ACTION_DELAY_MS`。缺省全 0——注意“环境变量”一层含入口引导从 `configs/amberflowrc.json` / `amber config` 吸收进来的机器配置值，机器上非零节奏多半来自这里；凡结果出现 `pace`，同处的 `pace.sources` 逐字段点名来源（`explicit` / `meta` / `env` / `default`）。详见 [MANUAL_STEPS_AND_PACE.md](MANUAL_STEPS_AND_PACE.md)。

**三层预算与计费口径**：见 §4「预算是三层结构」（07-A 单一出处；08 修复批后由两处合并归一）。

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
- 步数有三个口径，别混用（02 轮 C4）：`completed` / `script.steps` = `ctx.step`+`ctx.arrive` 的**调用数**（含 when 跳过的步）；`decisions.total_steps` = 真正进入决策流水的步数（不含跳过、不含纯导航）；Agent 视图 `steps[]` = trace 投影视图。对照预算/效率时先认口径。

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
| `precondition_skipped` | `when` 不成立，这一步没有执行（`ok:false`，trace 状态 `skipped`；同样计一次执行预算）——脚本按 stopCode 分支继续，不是失败 |
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

**停手规则**（层 3 出口；唯一出处 `src/engine/planning-playbook.ts`，失败即随 `next` 输出）：同一停因按 next 修正后重跑仍出现 2 次以上 → 停手：如实上报 stopCode / reason / 已试过的修正，等待人或上游决策；不要再自行迭代脚本或重试。

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
                    [--slot k=v] [--today YYYY-MM-DD] [--out DIR] [--allow-dangerous]
                    [--emit-trace F] [--replay F] [--json]
amber record <页面> [--name ID] [--goal G] [--apps-dir DIR] [--yes]
amber inspect --url <URL> [--json]
npm run test           # 真实站点测试（smoke + core）
npm run check           # typecheck + 配置示例一致性 + 线上用例离线校验
```