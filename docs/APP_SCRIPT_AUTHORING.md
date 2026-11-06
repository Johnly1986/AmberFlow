# 应用脚本作者指南（flow · meta · ctx · 校验 · 轨迹）

> 面向“要接入/修改一条业务流程”的人，也面向替你写脚本的 Agent。
> Agent 与 DSH 桥的稳定契约见 [AGENT_INTERFACE.md](AGENT_INTERFACE.md)；本篇讲作者面。

## 0. 30 秒快速路径（引擎引导，唯一出处 `src/engine/planning-playbook.ts`）

> 本节两段文字由引擎模块生成，`npm run prompt-hit` 第 6 层逐字校验——改文案先改模块再跑工具，勿手抄改写。
> 同一份六步法（v2.1）也写在 `apps new` 骨架注释头部与桥 `_app_create` 工具描述里（同一出处，多面分发）。

```text
高效规划六步法 v2.1（走查先行——先用引擎把流程按真实步序走通，再写正式应用）：
① inspect 先看：amber inspect --url <页> --json 拿验证过的 hint_candidates——有候选照抄，别自创选择器；同时核对目标 op 在能力面内（amber schema ctx --topic commands）与词面真的在池里（probe/DOM 命中 ≠ hint 可命中）；
② 全流程走查：按真实步序用引擎走通一遍，五样产出物全带出来——能力墙清单（哪步走不通、卡在什么停因）/ 产品事实清单（真实文案、控件、URL 规律——done 与 hint 只能从这里来）/ 提槽清单（哪些值随任务变化、进 meta.slots）/ done 素材（每步动作前后页面各长什么样）/ 绕行决策（走不通的步骤就地找等价路径：换入口页、换来源、换控件族；反爬风控不绕，早停）；
   走查工具三选一：探针链（每步一个 1 步微型应用：arrive+read 验证页面可达 / 登录与验证可处理 / 无风控拦截 / 数据在 DOM——探针 30 秒判死刑，好过全流程应用跑 5 轮）或 plan 面草稿（plan new → plan add --signal … → plan check --probe 只读预检 → plan run 真执行）或 walk 模式（amber run <id> --walk 一个临时应用单会话按真实步序 act→read 串完整流程：步声明的 url 与当前页同页就不重导航、SPA 状态跨步保持，跨页显式 url 仍导航——适合复现「只在演进状态出现」的问题）；
③ 规划应用：提槽 + done 双向清单——done 四形态：正向锚（url_* / css_*）、否定配 exists（裸 not 在空池/重渲染瞬间空洞成立）、多动作后判（两连击的第一击是中间态，不算完成）、状态前进自检（信号跟着页面真前进，不是恒真）；
   值只认 slot：fill/select/drag 的值来自任务输入或数据源（缺值如实 needs_value，不猜）；采样与分块：虚拟列表按视口采样（池里只有已渲染的行，滚动/翻页分块取全）、长流程分块成多个短应用、多源双腿（meta.sources 数据腿 + 浏览器腿互核）；
   候选窗口有界：每步只取 40（宽扫 120）个候选并按当前视口分桶（chrome/viewport 优先，内容优先级见 amber schema ctx），窗口外不等于页面上没有——要穷举列表用 ctx.scrollList/ctx.expand 分块取证（各计 1 flow step，expand 内部点击不占预算；范围控件用 ctx.setRange），引擎不自动滚动；hint 用完整 label（≤200）匹配、aria-label 是 label 别名；要回退 A2 前的主内容优先排序在 meta.policy 写 candidate_priority: "main-first"（缺省 bucketed）；扫描面（B2）含 div[role=menuitem/menuitemradio/menuitemcheckbox/option/tab]（click 族）——弹层菜单项/下拉选项/页签可直接 act；这是全局行为变更：候选构成与排序可能变化、同名候选增多可能引入新歧义（如 tab 与按钮同 label），hint 按 label 匹配不受影响；
④ 落地应用：单段/单城 + slots，1 步 flow；早停守卫（凭据/验证不可得，或命中反爬风控 → ctx.fail("blocked:…")）+ meta.policy 声明 done_timeout_ms，不盲等；amber apps check <id> --slot k=v（不启浏览器）验证各分支调用序列——stderr 的两条信号 lint（裸 not / any 含 not(exists)）当场改掉再进 ⑤；
⑤ 真跑留证：amber run <id> --trace；失败先看 trace 的 stopCode/reason——reason 自带池快照判别（「目标不在页面」还是「候选在而闸门拒/闭集约束」）与决策源降级原因；动作步再看 executed/changed 与 skipped_actions/done_preheld——done=true 但零执行时先看跳过原因，别把「信号本来就成立」当成动作推进；被杀有 run-killed.json 部分证据；
⑥ 失败取证判别：最小取证探针先区分引擎缺陷 / 产品事实 / 任务口径再动手——A/B（单变量重跑）、对照（--provider 换决策源或 rules-only 消融）、双腿取数（数据腿核产品事实）；判别不了就上报，别靠反复重跑收敛。
```

> S2/S3 补充（不在上面的六步法正文内）：动态加载的长列表可用 `ctx.collect` 自动「滚动→抽行→去重」
> （整体计 1 flow step，`stopReason` 诚实：stable/maxRows/budget/not_scrollable）；`meta.policy.settle`
> 缺省开启稳定门（抽池前只在页面有 DOM 突变时等静默，等待进 `state.settleMs`）。

```text
失败特征速查（只判不绕反爬风控：命中反爬风控即 ctx.fail("blocked:…") 早停；验证环节可代过）：
- body 极短（<200 字符）+「登录/注册」浮层 = 登录墙：换可匿名读价的来源，或用凭据 + 验证步骤处理；无凭据/无授权时如实标 blocked，别重试表单；
- 卡片价格处全是「登录看低价」= 服务端价格闸：匿名会话拿不到价格，不是渲染问题，早停；
- 价格列全是「查价」+ 页尾「服务器异常」= 站点限流：等待与重试无效，早停；
- 「依次点击图标验证 / 滑动拼图」= 验证码：属验证环节，可在用户授权下由人工步/注入处理器代过；若站点同时以风控/限流拦截（反爬），不绕，立即早停。
```

## 0.5 走查先行（六步法 ②）：先走通，再写应用

12 轮真站实测的结论：最贵的返工集中在「静态看页面 → 直接写正式应用」的缺口——页面看得懂
不等于流程走得通。写正式应用之前，先用引擎命令行**按真实步序把流程走通一遍**，五样产出物
全带出来（每一样都直接落成正式应用里的一段声明）：

| 产出物 | 内容 | 落进正式应用的哪里 |
| --- | --- | --- |
| 能力墙清单 | 哪几步走不通、卡在什么停因（目标不可分辨 / 需登录 / 风控 / 数据不在 DOM） | 早停守卫 `ctx.fail("blocked:…")` 与长流程分块切分点 |
| 产品事实清单 | 真实文案、控件族、URL 规律、数据形状 | `done` 信号与 `act` 锚点（只认这里，不许猜） |
| 提槽清单 | 哪些值随任务输入 / 数据源变化 | `meta.slots`（fill/select/drag 只认 slot） |
| done 素材 | 每步「动作前不成立、动作后成立」的具体信号 | 各步 `done`（拿不准先 `amber inspect --probe "<selector>"` 实证） |
| 绕行决策 | 走不通的步骤选哪条等价路径 | 换入口页（`meta.site.pages` + `openPage`）/ 换来源（多源双腿）/ 换控件族；**反爬风控不绕，早停** |

走查工具（按流程形态选用，也可混用；第三种 walk 模式见下）：

- **探针链**：每步一个 1 步微型 flow 应用——`apps new <id>-probe<N>` → `arrive + read` 或单个
  `ctx.step` → `amber run <id>-probe<N> --trace`。适合交互步为主、必须真实动作才能看到下一态的
  流程；一枚探针 30 秒判死刑，好过全流程应用跑 5 轮。
- **plan 面草稿**：`plan new → plan add --signal … → plan check --probe → plan run`。适合线性流程
  快速串步：`plan check --probe` 是只读预检（实况核对 hint 解析与验证步信号，不执行动作），
  `plan run` 才真执行。

**walk 模式（A6，调试旗标，默认关）**：`amber run <id> --walk --trace` 让一个临时 flow 应用在
**一次 run 内**按真实步序 act→read→act→read 串完整流程，用于本节的走查与失败取证。与默认模式的
差异只有一处：**`ctx.step` 的「起点 URL=当前页」重锚不再重载页面**——步声明的 `url` 与当前页同页
（origin+path 相同；query/hash 忽略，正是"每步显式给当前 URL"惯例的形状）就不导航，SPA 客户端
状态跨步保留；指向**另一页**的显式 `url` 仍然导航（显式意图优先），`ctx.open`/`ctx.openPage`/
`ctx.arrive` 照常。done 判定、停因、after 签名与决策统计全部复用既有机制；结果 JSON 带
`walk: true`。注意：walk 是**调试面**，正式跑不用 walk——每步重导航（起点 URL 确定性）才是正式
run 的 done 判定确定性来源；`--walk` 与 `--dry-run`/`dry` 互斥（dry 无浏览器，walk 无意义）。
适合复现「只在会话内演进状态出现」的问题（R2/R12 实证：同一扩样操作在重导航后的页面与演进页面
上，一轮成功一轮不增长）。

learn 的落盘门（生成脚本的零前向回放）也走这条 walk 语义——回放验证的是「录制的流程在**单会话**
里能否走通」；落盘成功的输出在录制出现**相邻步同 URL**（弹层/SPA 型流程）时会提示「formal 运行会
重导航，SPA 状态流程请加 `--walk`」。LEFTOVER：formal 每步重导航对同 URL 状态流的限制**依然存在**
——walk 是运行期旗标，不进生成的应用、不是默认运行语义；learn 回放 walk 化不改变 formal。

最小走查示例（3 步流程「开列表 → 进详情 → 读标题」；URL / 信号均为示意占位，落笔前对目标页实证）：

```bash
npx amber plan new "读列表第一条的详情标题" --url https://example.org/list --save-plan ./.amberflow/plan.json
npx amber plan add "点进第一条详情" --signal url_contains=detail --target "a~detail"
npx amber plan add "读到标题" --signal css_text_equals=h1|Example
npx amber plan check --probe        # 只读预检：hint 解析与验证步信号实况核对
npx amber plan run                  # 真执行；卡住的那步就是能力墙清单要记的那步
```

同一流程的探针链形态（第 1 枚探针示意）：

```js
// $AMBERFLOW_HOME/apps/list-probe1/app.mjs —— 走查探针：只验证第一步
export const meta = (kit) => ({
  id: "list-probe1", label: "走查探针①", goal: "列表页可达，第一条详情可进",
  hosts: ["example.org"], site: { pages: { home: "https://example.org/list" } },
});
export async function flow(ctx) {
  await ctx.openPage("home");
  const r = await ctx.step("点进第一条详情", { done: ctx.judge.url("detail") });
  if (!r.ok) ctx.fail(r.stopCode ?? "step_failed", r.reason);   // 走不通 → 记能力墙，就地找等价路径
}
```

走查走通后按六步法 ③④⑤⑥ 规划、落地、验证；写 `done` 之前回看 §0 的失败特征速查与 §6
的信号语言，别凭走查时的印象凭空写信号。

## 1. 只有一种格式

**应用只有一种编写方式：JS 形式的 `app.mjs`（`meta` + `flow(ctx)`）。没有、也不接受
JSON 描述的应用格式**；`amber` 命令行是逐步调试工具（inspect → apps check/explain →
run --max-steps 调试回路），不是另一种编写面。

应用是**用户作用域的一段 JS 流程**：

```text
$AMBERFLOW_HOME/apps/<id>/app.mjs
  export const meta = (kit) => ({ id, label, goal, hosts, slots, invariants, ... })
  export async function flow(ctx) { ... }
```

- 文件按目录名发现：`apps/<id>/app.mjs`（也接受 `app.js` / `app.ts`）。
- `meta` 只声明应用级事实；流程本身在 `flow(ctx)` 里。没有静态步骤表，步骤是运行期事实。
- 与 plan JSON（`task_plan.json`）的关系：那是 `amber plan` 逐步调试/续跑用的**轻载体**，
  不是应用格式——命令空间（含零动作验证步 `commands:[{op:"skip"}]`）与结束态不变量只在
  app 面有一等支持；正式流程一律写 app.mjs。
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
| `hosts` | 允许的主机列表；导航信封在 dry 与真实运行都执行。**要预判重定向落点**：链接 href 的主机变体（apex ↔ `www.`）与 301 后的真实落点都要进信封——实测 href 指 `iana.org`、实际落 `www.iana.org`，只声明 href 侧会在落地撞 `host_not_allowed`（2026-11-01） |
| `slots` / `requiredSlots` | 数据槽与必填槽；缺值返回 `needs_value`，不猜 |
| `secretSlots` | 敏感槽位名单（如 `password`、`otp`）：result/report/stdout/dry 输出时掩码为 `***`；值仍建议走 env/本机配置，别写进 app.mjs |
| `sources` | 数据腿名（`ctx.source(name)` 按名字按需加载） |
| `device` | 浏览器设备面（只有手机版页面的站点需要声明） |
| `site` | 站点面：页面角色 `pages`、命名行抽取 `listExtract`（见 §5） |
| `model` / `maxSubgoals` | 决策模型 checkpoint / 子目标上界（高级，缺省即可） |
| `notes` | 给人看的备注（字符串列表），不参与运行 |
| `policy` | 运行策略：`conf_floor` / `tiered_hint` / `reobserve` / `max_effective_repeats` / `risk_ask` / `done_timeout_ms` / `done_poll_ms` / `pool_ready_timeout_ms` / `pool_ready_poll_ms` / `done_preheld` / `effect_readback` / `settle` / `decision_state` |
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
| 元信息 | `ctx.app` / `ctx.slots` / `ctx.runtime` / `ctx.budget` / `ctx.log(msg, data?)` | `slots` 只读；`runtime = {outDir, runId, today, epoch}`（`epoch` = 执行器状态游标只读投影，每次抽池/观察 +1，每个 `step` 重置；dry 恒 0）；`today` = CLI `--today YYYY-MM-DD` 钉住的"今天"，没钉 = 系统日期 |
| 导航 | `ctx.open(url)` / `ctx.openPage(role)` / `ctx.arrive(url, {done, desc?, id?, timeoutMs?})` | `arrive` = 纯导航 + 等信号，不做元素选择、不花模型；`hosts` 信封在起点与落地都强制 |
| 决策语句 | `ctx.step(goal, { id?, act?, done, url?, slots?, values?, when?, timeoutMs?, force?, staleRetry? })` | `done` 必填；`act` 省略 = 引擎决定目标，给了 `ctx.hint()`/命令闭集才收窄候选；返回 `{ok, id?, stopCode?, reason?, evidence}`；`values` 是决策步的显式值袋，见 §4.5 |
| 人工步 | `ctx.manual(desc, { done, instructions?, id? })` | 见 §7；非 TTY 返回 `needs_human`，不假装有人 |
| 观察 | `ctx.url()` / `ctx.read.{text,value,count,attr}(sel[, attr])` / `ctx.holds(signal)` / `ctx.waitFor(signal, {timeoutMs?, pollMs?})` | 只读；读不到返回 `null` / `0`；`waitFor` 轮询到 bounded deadline，返回 boolean；`url()` 首次导航前是 `"about:blank"`，别拿它当入口页判断 |
| 站点面 | `ctx.openPage(role)` / `ctx.extract(nameOrSpec)` / `ctx.rows(...)`（v1 关闭） | 具名抽取声明在 `meta.site.listExtract`；inline 抽取用 `{ rows, fields, maxItems? }`（例：`ctx.extract({ rows: "li.item", fields: { title: ".title" } })`，无需 meta 声明）；`rows` 调用给结构化错误 |
| 数据 | `ctx.source(name, {dates?})` / `ctx.data.{min,max}(rows, by)` | 数据腿按需拉取；`--skip-data` 时 `source` 报结构化错误。`dates` 显式给本次范围（单日 / `A..B` / `next_week`）；缺省按 source JSON 的 `default_dates`（支持 `"{slot}"` 占位符，从包默认 + `--slot` 解析；不许引用 `source_slots` 产物）。观察视图 `byDate` 按日期保留完整 counts/selects/rows |
| 进程 | `ctx.run(...)` / `ctx.dangerous({...dryRunArgs})` | 见 §6；危险步默认拒绝 |
| 构造器 | `ctx.judge.*` / `ctx.tool.*` / `ctx.hint()` / `ctx.hints()` / `ctx.command()` / `ctx.value.*` | 与 `kit` 同一份实现；命令 op 见下 |
| 收尾 | `ctx.done()` | 结束态不变量验收；之后不允许再有动作 |
| 终止 | `ctx.fail(code, reason?)` | 抛结构化 `StopError`，退出码/状态走引擎既有分类，不抛裸栈 |

- `when` 是适用性守卫：动作前判定，不成立时该步不执行（返回 `ok:false`、`stopCode:"precondition_skipped"`），脚本可以据此分支。跳过步**同样消耗一次执行预算**，trace 里状态记为 `skipped`（不是 `failed`）；不要把 `if (!r.ok) ctx.fail(...)` 的失败模板直接套在守卫步上，先判 `r.stopCode`。
- `act` 缺省就是“决策语句”：只给目标语义和完成证据，让规则/模型选元素；硬编码 `ctx.hint(...)` 只作为稳定锚点或候选收窄，不应成为每条流程的默认。
- 导航同样优先用 `meta.site.pages` + `ctx.openPage(role)`，而不是在流程里重复硬编码 URL；业务值优先用 `meta.slots` / `ctx.source`，不要写死在 `flow` 里。**运行期才知道的 URL**（如命中链接的相对 href）可在 flow 里 `new URL(href, ctx.url())` 绝对化——URL 全局构造器在脚本进程可用（06 轮实证），这是"角色覆盖不到的动态地址"的正规通道，不是硬编码豁免。
- 命令闭集的 op 是引擎能力面：`click` / `check` / `fill` / `select` / `scroll` / `drag` / `hover` / `skip`。
  `scroll` 把目标滚入视口；`drag` 的 value 是落点 selector（可来自槽位），只在 `[draggable=true]` 或 slider 族元素上声明能力；
  `hover`（S4）只把指针移到目标上（`locator.hover()`），用于 `:hover` 展开的菜单/图层面板——不点击、不导航；完成仍只由 done 信号裁决。
  `skip` = 按定义解决的零动作命令：全部命令解决后引擎会**评估一次 done 信号**再判成败——"导航由 arrive 完成、本步只验证到达"的守卫步合法可用（04-A 修复；此前 skip 步的 done 从未被评估，必报 `done_not_held`）。守卫步写法：`act: [ctx.command("skip")]`（完整可跑示例见 `examples/apps/01-basic-step` 步骤②）。
  不在能力面内的 op 会得到 `action_unsupported`，目标歧义是 `target_ambiguous`，目标不存在是 `target_not_found`。
- **act hint 是六形状语法闭集**（唯一解析器 `src/engine/hint.ts`，语法**描述**的唯一出处 `src/engine/grammar-prompt.ts`，`npm run prompt-hit` 校验示例可命中、报错/提示词/桥描述不漂移）：`#id` ｜ `tag[attr~substr]` ｜ `tag~token` ｜ `tag[attr=value]`（值去引号、全小写折叠）｜ 角色词 `button|link|input|textarea|select` ｜ 裸词（按 label 匹配）。属性名按池字段匹配：test→data-test、type→input_type、aria-label→label、href、name、id、role、near；aria-label 是 label 的别名（提取期已并进 label），class、title 等不在池字段模型里，永不命中（本句由 grammar-prompt 的 ATTR_MATCH_MODEL_TEXT 生成，prompt-hit 逐字校验，勿手改）。**容器/后代 CSS（如 `#outer input`）不是语法错误——会被解析成一个永不命中的形状**；命令空间的 `target_not_found` reason 附闭集提示，而 act hint 落空会**静默回退模型决策**、报 `low_confidence` 不附提示——写 hint 前先 `inspect` 拿验证过的 `hint_candidates`。

#### 候选窗口与分桶（A2：窗口是**有界快照**，不是"页面没有"）

候选窗口是**有界快照**：每步只取 40（宽扫 120）个候选，按桶配额来自当前视口——chrome 8 / viewport 16 / contentNear 8 / mainOffscreen 6 / other 2，不足时按 viewport→contentNear→mainOffscreen→other 顺延；窗口外不等于页面上没有（`inspect --json` 的 `window` 会给出窗口外可见交互），引擎不自动滚动。真正需要读完整列表时用滚动/展开原语分块取证。hint 匹配用**完整标签**（≤200，`full_label`）而不是模型视图的 40 字前缀：裸词按大小写不敏感的词边界/前缀匹配，`[aria-label~x]` 是 label 的别名。要回退 A2 之前的主内容优先排序，在 `meta.policy` 写 `candidate_priority: "main-first"`（缺省 `bucketed`；dry/plan 面同一字段）。

- 桶的闭集：`chrome`（nav/aside/footer/header，不受视口限制）、`viewport`（当前视口 ±15%）、`contentNear`（视口外 ±150%）、`mainOffscreen`（更远且在该页 main/article 里）、`other`。`prio` 只是诊断序，不参与选目标。
- 查窗口事实：`amber inspect --url <页> --json` 的 `window.visible_interactive / shown / out_of_window[]`；`--wide` 把窗口放到 120，`--pool` 展示 `bucket/prio/full_label` 调试字段。
- 失败判别：命令 `target_not_found` 的 reason 里出现 `viewport_underloaded` = 页面上有"内容远高于可视区"的滚动容器（虚拟列表/懒渲染），目标可能只是没渲染——不要反复重跑，按六步法② 取证。
- 行为变更（A2）：缺省排序从"main 内容优先 + DOM 序截断"改为"分桶配额 + 视口感知"；`meta.policy.candidate_priority: "main-first"` 是逐应用回退。
- 行为变更（B2 扫描面）：INTERACTIVE 扫描面追加 `[role='menuitem']` / `[role='menuitemradio']` / `[role='menuitemcheckbox']` / `[role='option']` / `[role='tab']` 五个 ARIA 角色（全部 click 族，选中语义也是 click 驱动）——弹层菜单项、下拉选项、页签这类 div 自绘控件从此进池，弹层路径不再依赖原生 `<button>` 兜底。对所有应用是**全局行为变更**：决策层看到的候选构成与排序可能变化；同名候选增多可能引入新歧义（例如 tab 与按钮同 label——按 hint 收窄或换 data-test 锚点消歧）。对 hint 命中无影响（仍按 label 匹配，六形状闭集不变）；窗口大小（40/120）与分桶配额不变，新 role 走既有分桶。
- **hint 与 done 信号是两个观察面**：`ctx.judge.*` 的 selector 走 DOM 查询面（任意 CSS 可用）；act hint 走上述语法闭集 + 元素池投影。`inspect --probe` 数的是 DOM——probe 命中数 ≠ hint 可命中，别互相推断（03-D2/D3；闭集提示只出现在命令空间 `target_not_found` 的 reason 里）。
- 停因 reason 里的 "on step N" 是**子目标内动作步号**，与 CLI/`step_traces` 的流步号不是一个口径（04-B）。
- `ctx.step` 的 `timeoutMs` 约束的是**本步动作后等待 done 信号成立的窗口**（映射该步的 `done_timeout_ms`），不约束整步挂钟时长——模型咨询、导航渲染不在其内（04-F）。
- 导航：`ctx.open/openPage` 只做 goto（domcontentloaded），**不等 done/信号/settle**；要"导航 + 等落地证据"用 `ctx.arrive(url, { done })`（04-C 实测：open 后半路即返，arrive 带轮询等待）。
- **预算是三层结构**（07-A/08-A6 实测成文，别按"一层"规划）：
  **① flow 调用预算**——`ctx.budget.maxSteps` / `stepsUsed`（缺省 100，CLI `--max-steps` 覆盖）；`ctx.step`、`ctx.arrive`、`ctx.run`、四个列表原语（`scrollList/expand/setRange/collect`）与批准执行的人工步一律计 1——`when` 跳过的步也计（02-C2），`read/extract/holds/waitFor/log/url` 免费；一次 `ctx.run` 恒 ≤1，其内部 attempts（重试）与 timeout 不放大本层。用满抛 `budget_exceeded`（CLI 给 `--max-steps` 时结果 `partial`、exit 0）。
  **② 子目标动作预算**——执行器每次调用的动作循环上限，**缺省 8、当前不可配置**（`executor.ts:884`），只活在停因文案里（`max_steps=8`；reason 的 "on step N" 是本层动作号，与流步号两口径——04-B）。
  **③ 信号等待窗口**——浏览器腿 done 轮询 per-click 语义（`done_timeout_ms` 缺省 2000，步级 `timeoutMs` 覆盖，04-F/07-E："7 击各享窗口，非整步挂钟"）；进程腿 `stdio.timeout_ms` 是步内挂钟帽（缺省 20s）。
  **同为 `config_error`，抛出层决定计费**（08 实测）：cli 形式声明校验在①扣费**前** throw（免费）；适配器 toolRunner 内拒绝（如 stdio+retries）在扣费**后**返回（贵一步）。按"动作数"估①必翻车——守卫跳过、被拒声明都计费。
- 脚本拿不到 `page` / locator、模型文本或分数，只能看 `{ok, stopCode, reason?, evidence}`。
- 退出码与 Agent 视图（`amber run --json`）：`status` = `passed | partial | failed | blocked | needs_human | dry | invalid | infra_error`；`verified` 只在完整运行且所有不变量成立时为 true。

### 4.5 决策步的显式值袋（U1：`ctx.step(..., { values })`）

决策语句步（`act` 省略或 `act: ctx.hint(...)`）的 fill/select 此前**没有值通道**——值请求只走
slots 袋与控件身份字段（name/id/data-test/label）的词面匹配，词面无关就 `needs_value`
（R12 dropdown-C 实测缺口）。`values` 补上这条通道：

```js
await ctx.step("在 dropdown 里选 Option 2", {
  values: { dropdown: "Option 2" },   // 作者自定义关联键 → 显式值
  done: ctx.judge.value("#dropdown", "2"),
});
```

- **解析顺序**（决策层选中 fill/select 目标后）：① `values` 袋（控件 name/id/data-test/label
  与 key 的精确/互含匹配，两档与 slots 同一套）→ ② `slots` 袋（同两档）→ 都落空 = 结构化
  `needs_value`。**作者显式值 > 隐式 slot 匹配**；两袋都无值时引擎绝不发明值（红线②不变）。
- 命令步（`act: [ctx.command("fill"/"select", ...)]`）不受影响：其值面仍是 `{from:"slot", key}`
  具名绑定，`values` 不参与。
- 点击前的 required 空字段预填（引擎的确定性预填通道）同样读 `values`——与当步 fill/select
  同一个解析顺序，两个通道不会错位。
- W8 同口径：`values` 键命中 `meta.secretSlots` 名单的条目，其值同样进 effect 读回掩码。
- meta 层不需要新键（步级声明即可）；缺省不写 `values` = 行为逐字节不变。

### 4.6 列表展开、穷举与范围控件（A3 三原语 + S3 `ctx.collect`）

真实列表页与筛选面板需要三种"窗口外操作"，引擎把它们收敛成三个**结构化、可计费、失败不假装成功**的原语（内部 click/滚动不占 flow 预算；每个原语整体计 1 步，受 `--max-steps` 约束）；S3 再加一个**自动穷举**原语 `ctx.collect`（同样整体计 1 步）：

```js
// 滚动列表：目标自身或最近可滚动祖先；纯 DOM scrollTop，不做滚轮模拟、不自动滚其它区域。
// 目标可以是列表里的交互元素（最近可滚动祖先即容器），也可以直接是容器本身（如 div[role="feed"]）。
const s = await ctx.scrollList("Feed list", { to: "bottom" });          // 或 { to:"top"|"page" } / { by: 800 }
// s = { ok, scrollTop, scrollHeight, clientHeight, moved, stopCode?, reason? }
// 找不到可滚动容器 = ok:false + stopCode:"not_scrollable"；目标解析不到 = "target_not_found"

// 列表展开：反复点"加载更多/展开"，直到行数连续 stableRounds 轮不增长
const e = await ctx.expand("Load more", {
  count: { rows: "#list li", fields: { text: "." } },   // 或 { selector: "#list li" }
  maxClicks: 20, stableRounds: 2, settleMs: 800, timeoutMs: 60000,
});
// e = { ok, clicks, before, after, grew, stable, coverage:{rows}, stopCode?, reason? }
// ok = 已到稳定 plateau（行数连续 stableRounds 轮不增长），此时 grew/clicks 如实暴露；
// 到顶未稳定 = ok:false + "expand_not_stable"（仍带完整指标）。
// 点击失败不会直接判死：真站"展开到顶"后按钮常仍在但不可点（Maps See more 实测）——
// 失败后等一拍重读行数，长出来的算异步到达，连续 stableRounds 轮不长才算稳定。

// 范围控件：fill（原生 range）→ keyboard（ARIA 手柄 Home/ArrowRight）→ pointer（自绘手柄，0×0 用最近有尺寸祖先）
const r = await ctx.setRange("Volume", { value: 42 });                  // 或 { percent: 25 }
// r = { ok, achieved?, strategy:"fill"|"keyboard"|"pointer", stopCode?, reason? }
// 三道都设不了 = ok:false + "slider_not_settable"（reason 附已试策略/bbox/当前值）
// 面板 re-render 会把 slider 节点换掉（探针属性随旧节点消失）：解析面瞬态重试一次（300ms），
// 第二次仍读不到才按 slider_not_settable 报——瞬态不是"设不了"。

// S3 穷举：反复（滚动行容器 → 抽行 → 去重）直到连续 stableRounds 轮无新增 / 达 maxRows。
// 整体计 1 个 flow step；内部滚动与轮间等待不占预算。stopReason 诚实，不假装穷尽。
const feed = await ctx.collect({
  row: "#feed li.item",                                    // 行选择器（CSS；主 frame 或可达子 frame，同源/跨源均可）
  fields: { title: ".title", price: ".price" },            // 与 extract inline 同语法；缺省 { text: "." }
  until: { stableRounds: 2 },                              // 或 { maxRows: 200 }
  dedupe: true, maxRounds: 30,
});
// feed = { rows, coverage:{rounds,rowsSeen,addedLastRound},
//          stopReason:"stable"|"maxRows"|"budget"|"not_scrollable" }
```

- **计费**：四个原语各计 1 个 flow step；`expand` 内部的点击、`collect`/`scrollList` 的滚动与 `collect` 的轮间等待都**不**占预算，由 `maxClicks`/`timeoutMs`/`maxRounds` 兜底（`ctx.budget.stepsUsed` 每调用 +1）。
- **参数校验在 dry 期就红**：`count` 必须恰好一个 `rows|selector`、`maxClicks/stableRounds` 必须正整数、`to` 必须 `bottom|top|page`、`value` 必须恰好一个 `value|percent`、`collect` 的 `row` 必须非空、`until` 只能二选一（`stableRounds` 1..20 / `maxRows` 1..5000）——写错在 `amber apps check` 就报 `config_error`，不会留到真跑。`count.fields` 只做**形状校验**：expand 只用 `rows/selector` 数行数（内部 DOM `querySelectorAll` 计数，不写独立 trace 事件、不产生 read/extract 事件，因此 replay 无需额外消费），字段投影不参与稳定判定。
- **吞错也会被 check 抓住**：dry 的 `validateXxxRequest` 抛错前先落一条 `validation_error` trace 事件；脚本 `try/catch` 吞掉 `config_error` 时 `apps check` 仍判 FAIL 并输出「脚本吞掉了配置错误：<call> <message>」。源码里的 `ctx.expand(`/`ctx.scrollList(`/`ctx.setRange(`/`ctx.collect(` 调用点还会与 dry trace 事件数对账，未覆盖的分支只打**警告**（不改退出码，`check VALID` 不代表分支都被走过）。
- **`collect` 的滚动位置**：取行元素的**最近可滚动祖先**（逐 frame 探测；找不到就退到页面滚动元素）；容器不可滚动（或行元素不存在）时停 `not_scrollable`，结果只覆盖当前可见部分。`stopReason` 口径：`stable` = **滚到底/滚不动之后**连续 stableRounds 轮无新增（没到底的轮次不算 plateau）；`maxRows` = 达上限（不是全集）；`budget` = 内部 `maxRounds` 用完仍不稳定；`not_scrollable` = 没法继续滚。轮间固定等 300ms 给懒加载/无限滚动。
- **命令面扩展**：`ctx.command("scroll", sel, { to: "bottom" })` 把"滚容器到方向"作为命令闭集的一项（旧 `ctx.command("scroll", sel)` 仍是"把目标滚入视口"，逐字节不变）；`setRange` 不新增 command op。
- **trace/replay**：四个原语的调用参数记入 trace `args`；重放按录制值回放结果，参数不一致直接 `trace_mismatch`（不重新决策）；`collect` 的行数据也来自 trace（不重新抽页面）。dry 期是确定性桩（`expand` 返回全零指标、`scrollList/setRange` 返回 `{ok:true}`、`collect` 返回 `{rows:[], coverage 全 0, stopReason:"dry"}`）。
- **`expand` 的 plateau 与点击失败**：`ok:true` 只代表"行数已连续 `stableRounds` 轮不增长"，`grew/clicks` 说明长没长、点了几次；到顶后控件不可点不算失败（`reason` 会记 click 失败次数）。只有"点了 `maxClicks` 次/超时仍未稳定"才是 `expand_not_stable`。
- **失败语义**：全部是**返回结构化结果**而不是抛裸栈；脚本可以据此分支或 `ctx.fail(...)`。真站上"展开了但行数不动/滑到了但值不变"这类现象必须按 `ok/stopCode` 处理，不要假设动作一定成功。

### 4.7 动作执行证据（A1：executed / skipped_actions / done_preheld）

`done=true` 只说明**完成信号成立**，不说明"这一步真的动过页面"。A1 把"动作是否执行、为什么没执行、
done 是不是动作前就已成立"变成结构化证据（全部**可选字段**：不适用就不出现，旧产物形状不变）：

**`ctx.step` 选项 `forceAct?: boolean`（声明面）**
- 命令步即使 done 信号在**动作前**已成立，也先把命令闭集执行完，再评估 done（"这一步必须真的动一下"）。
- 引擎当前没有"done 已成立就跳过动作"的短路，缺省行为本来就先动作；`forceAct` 是给未来短路的出口，
  也是作者意图的显式声明；dry/replay 只记录/回放声明，不重新决策。

**`StepResult`（以及 `trace` / `RunReport` / report.md 的「动作执行证据」小节）**
| 字段 | 含义 |
|---|---|
| `executed?: boolean` | 本步是否有动作**真的执行**（命令步/发生过动作尝试时出现；false 必须配 `skipped_actions`） |
| `executed_actions?: Array<{op,target,ref,how,desc,changed}>` | 每个已执行动作的身份与结果；`changed` = pre/post 快照是否变化 |
| `skipped_actions?: Array<{command_id?,ref?,target?,reason,detail?}>` | 每条"为什么没动作"的结构化原因（`target_ambiguous` / `target_not_found` / `forbidden` / `not-actionable-or-covered` / `stale_ref` / `needs_value` / `action_unsupported` / `attempt_limit` …） |
| `done_preheld?: boolean` | 命令步在**动作前**对 done 的预评估结果（只命令步出现；不改变执行顺序） |
| `warnings?: string[]` | 运行期诚实话，如 `suspected_async`（值只在产生时出现） |
| `state?: StepStateRecord` | S1 状态记录：`before/after` 指纹（`epoch`/`navEpoch`/`url`/`readyState`/`struct`/`content`）、`actions{attempted,executed,changed}`、`flags`（`done_preheld`/`no_state_progress`）、`settleMs`（S2 稳定门等待毫秒；策略关闭时省略）、`effect`（fill 读回 `{kind,before,after,applied}`；敏感槽位来源的 before/after 恒 `***`、applied 保留——见「effect 读回的掩码」）；`step_traces[i].state` 与 `result.warnings[]` 是同一份证据 |

**判读规则（写脚本/审查时按这个读）**
- `done_preheld=true`：done 在动作**之前**已成立 ⇒ 这一步的 `done` 来自信号本身，不是这次动作推进的；
  不要把它当作"动作成功"的证据（`forceAct` 下仍会执行命令闭集）。
- **零执行步骤**：`executed=false` + `skipped_actions`（例：命令目标歧义/被覆盖/候选全败）——完成裁决
  仍可能为真（信号本来就成立），此时 `stop_reason` 会追加 `executed 0 action(s); skipped: …`，
  这是"诚实完成"，不是静默 done。零动作验证步用 `act: [ctx.command("skip")]` 显式收窄动作面。
- `suspected_async`：click 执行了、但 pre/post 快照没变、随后 done 却成立 ⇒ 效果异步到达（如点击后
  1s 才长出新行）。引擎记 warning，**不** forbid 该元素、**不**写 outcome memory inert——它不是死元素。
- `changed=false` 且 done 不成立仍按既有 inert/anti-repeat 逻辑处理（死循环拦截不变）。
- trace 行上还有 `changed`（仅执行步）、`skipped/skip_reason`（仅未执行步）、`done_preheld`/`force_act`
  声明；S4 起还有 `forced`（步级 force 实际生效）与 `stale_retry:[{attempt,reason,ref}]`（每次 stale 重解析重试一条）；
  `after` 仅在"动作后有下一次观察"时补（done 立即成立的收尾动作没有下一跳，故不补）。

**S4 执行韧性（步级 opt-in，缺省不出现 = 行为逐字节不变）**

- `force?: boolean`：动作走 Playwright 的 **force 语义**（`click({force:true})` / `fill(v,{force:true})` /
  `selectOption(...,{force:true})` / `hover({force:true})`）——跳过 actionability 检查（可见/稳定/可接收
  事件/启用），**仍要求元素可定位**。风险：鼠标坐标上的顶层元素可能不是目标本身（可能点到被遮挡目标），
  只用于作者已确认的瞬态弹层/动画控件；**风险确认（risky/confirmFn）闸门不受影响**。trace 行记 `forced:true`，
  dry 面只记声明（`forced:true`），不改变模拟。
- `staleRetry?: boolean`：动作失败且**疑似 stale** 时，重抽池 → 用**同一声明目标**（命令 target / act hint）
  重新解析 → 重试动作，同一步内最多 2 次（不额外计入子目标动作预算）。触发判据只有三类：
  `stale_ref`（盖章句柄与属性回退全落空）/ `action_failed`（Playwright 动作抛错）/
  `not-actionable-or-covered` 且 actionability 现场 `requery==="detached"`（节点在探针后被卸载）。
  `action-timeout`、有覆盖者且 `requery==="present"` 都**不**重试（那不是 stale）；纯模型挑元素的决策步
  没有可复现的声明目标，也不重试。每次重试进 trace 行的 `stale_retry` 数组（注意：trace 行事件字段
  是单数 `stale_retry`，`step` 结果/RunReport 侧的汇总数组字段是复数 `stale_retries`——两个名字并存，
  勿混写）；最终失败仍按既有 stopCode
  （`stale_ref` / `action_failed` / `not-actionable-or-covered` …）诚实报告。
- `hover` 命令：见 §4.5 命令闭集——它只移动指针（`:hover` 菜单/图层面板），不点击、不导航、不触发预填；
  快照没变不判 inert（与 scroll/drag 同口径），完成仍只认 done 信号。

**S1 状态层与 pre-held 策略**
- `meta.policy.done_preheld`：`"warn"`（缺省，只记 flag + `warnings[]`，不拦动作）/ `"fail"`（动作前结构化停止，
  `stop_code=done_preheld`；步级 `forceAct:true` 优先）/ `"allow"`（显式接受，只留 flag）。
  **覆盖范围**：只有命令步（声明了 act 命令闭集）会在动作前预评估 done；决策步不付这次评估成本，不会标记。
- `meta.policy.effect_readback`：`{fill?, set_range?}`（缺省都开）。fill 后读回组件值比对，结果进
  `state.effect.applied`；`ctx.setRange` 结果附 `applied`/`accurate`/`target`。不可读组件自动降级跳过（不假装）。
- **effect 读回的掩码**（W8，安全级）：fill 的值来自敏感槽位（`meta.secretSlots` 声明；值绑定
  `from:slot` 且 key ∈ 名单）或读回内容命中敏感值时，`state.effect.before/after` 恒掩 `***`
  （与顶层 slots 掩码同值、不保留长度）；`applied` 布尔保留——它是「真的填进去了」的核心证据，
  不泄漏值本身。password/file/hidden 输入形态维持 `***(N)` 口径；非敏感槽位/字面值的
  before/after 维持明文（读回证据行为不变）。掩码在执行器构造 effect 时做（源头一次，
  `step_traces[i].result.state.effect` 与 `step_traces[i].state.effect` 两条投影同源同掩）。
- `meta.policy.settle`（S2 稳定门）：`{quiet_ms?, timeout_ms?}`（缺省 `{quiet_ms:400, timeout_ms:5000}`，**默认开启**）
  或 `"off"`。每次抽池前（决策/act 解析、宽扫、收尾观察）若页面最近有 DOM 突变就先等到静默；已静默立即
  返回（0 等待），超时不抛错、不阻断。等待毫秒数进 `state.settleMs`（策略关闭时省略；0 = 跑过但无需等待）。
  导航后第一次抽池最多付一次 `quiet_ms`（observer 安装时刻视为“刚脏”），同一页面稳态零等待。
  未知子键/越界值（`quiet_ms` 0..5000、`timeout_ms` 0..30000）在 `apps check` 就红。
- `ctx.runtime.epoch`：执行器状态游标只读投影（每次抽池/观察 +1，每个 `step` 重置；dry=0）。
- `result.warnings[]` 汇总跨步 flags（`done_preheld`/`no_state_progress`）与既有
  `suspected_async`；这些是**证据**，不改 done 语言、不影响完成真值。（W1 验收移除了一个
  控制流上不可达的串扰 flag——r8 跨城串扰签名由 `done_preheld` + `no_state_progress` 覆盖。）

**S5 决策状态接入（实验档，两项缺省都 `off` = 行为不变）**

`meta.policy.decision_state` 是 A/B 开关：它只改变「**什么时候**问模型、问的时候带什么观测事实」，不改
「模型只投票 / 完成只认信号」，也不改变 dry 面模拟。未知子键与非法档位在 `apps check` 就红。

```js
// ① 状态闸门（gate）：稳定后才问、池未变不重复问。
export const meta = (kit) => ({
  // ...
  policy: { decision_state: { gate: "stable_only" } },
});
// 真跑时：每次模型 ask 之前先按 policy.settle 等页面静默（已静默 0 等待；超时不阻塞）；
// 池指纹（本次 ask 池的结构指纹 = 可动元素计数+角色/标签分布 hash，零新增页面往返）与该池结构下
// 最近一次真 ask 相同、且规则层仍歧义时，不再重复问：
//   · 题面一字不差（同 goal + 同候选 ref/签名集合）⇒ 直接复用上一次答复；
//   · 仅结构相同 ⇒ 上一次的选择仍可行动（在池里且未 forbidden）才复用。
// 复用后的答复照常走低置信/reobserve/escalate 裁决（既有降级路径）；不能安全复用或 goal 变了 ⇒ 照常问。
// 产物：
//   decisions 顶层平铺：asks_saved / gate_waits / context_sent / context_skipped
//   decisions.line 末尾追加 `state asks_saved 3, gate_waits 1, digest 0`
```

```js
// ② 状态进上文（context）：请求带 ≤200B 结构化 state_digest。
export const meta = (kit) => ({
  // ...
  policy: { decision_state: { context: "delta" } },
});
// 决策请求里的 state_digest 形状（只给观测事实，不塞建议）：
//   { nav_epoch_delta: 0,                       // 距上一次 ask 的导航代数差（首次 = 自 run 起点）
//     last_effect: { kind: "fill", applied: true },   // 最近一次 effect 读回（不带值）
//     settled: true,                            // ask 时刻页面是否已静默
//     pool_changed: true,                       // 候选池是否与上次 ask 不同（首次 = true）
//     flags: ["done_preheld"] }                 // 本次 run 到目前为止的 S1 flags（可省略）
// provider 用 capabilities.state_digest 自报是否接受：统一决策服务（SystemOne 的 state 包）接受；
// 本地 laya-onnx / OpenAI Decisions 的输入 schema 固定 ⇒ 整段跳过（不塞进自然语言），
// 只记 decisions.context_skipped。超 200B 时按 flags → last_effect 裁字段，绝不截断 JSON。
```

两项可以同时开：闸门省掉的 ask 不会产生 digest 请求，所以 `context_skipped` 不会因此虚高。

**完整示例**：`examples/apps/05-done-evidence`（零动作命令 + `forceAct:true` + 证据判读，dry 可校验）。

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
  const rows = await ctx.extract("entries");                   // 具名：见 meta.site.listExtract
  const inline = await ctx.extract({                          // inline：无需 meta 声明
    rows: "li.entry", fields: { title: ".title", price: ".price" },
  });
  const href = await ctx.read.attr("[data-test=entry]", "href"); // 不存在 → null
  const n = await ctx.read.count("nav.menu a");
  await ctx.done();
}
```

- 两种 extract 二选一：`ctx.extract("name")` 走 `meta.site.listExtract[name]`（可复用、可校验）；`ctx.extract({ rows, fields, maxItems? })` 是 inline 形式，选择器直接写在脚本里。
- `ctx.extract(name)` 的字段选择器是**行内相对选择器**；`rows` 最多取 500 行（超出在 trace 里标 `truncated`）。
- `fields` 只做**行内文本投影**：每个字段值取单元格元素的 `innerText`（表单控件回退 `inputValue`；
  实现：`src/app/ctx.ts` 的 extract 字段循环）。**不支持属性投影**——`fields: { al: "[aria-label]" }`
  这类属性选择器能定位到单元格，但读到的仍是它的文本：图标型元素（aria-label 有值、无可见文本）
  的字段恒为空（R11 实测）。属性值单独用 `ctx.read.attr(selector, attr)` 取（不存在 → null）。
- `ctx.rows({row, fields})` 是 v1 明确**不开放**的新语法：调用给结构化 `config_error` 指向 `extract(name)`。
- dry 模式下 `extract` 返回 `[]`、`read.attr` 返回 `null`、`waitFor` 立即返回 `true`（没有页面）——脚本在 dry 期不要依赖观察值；**一切基于观察值的 `ctx.fail`/分支/断言都必须用 `ctx.runtime.runId === "(dry)"` 守卫**：`apps check` 与 `--dry-run` 会真跑 flow，没有守卫的数据驱动停会把合法脚本判成 problems（03-D1 配方；需要严格断言数据时，只在真实运行里停）。**dry 模拟面全表**（06-B，`createDryCtx` 实证）：`step`/`arrive`/`run`/`manual` 恒返回 `ok:true` 且 **`when` 不评估**（stopCode 恒空 ⇒ `precondition_skipped`/末页 exhausted 这类分支在 dry 结构性不可预演）；`read.*` 返 null/0；`collect` 返 `{rows:[], coverage:{rounds:0,rowsSeen:0,addedLastRound:0}, stopReason:"dry"}`；`url()` 是最近声明值；步预算照常计数。**吞错有留痕**（S3）：dry 的 `validateXxxRequest`（scrollList/expand/setRange/collect）抛错前先落 `validation_error` 事件——脚本 `try/catch` 吞掉 `config_error`，`apps check` 仍判 FAIL 并输出「脚本吞掉了配置错误：<call> <message>」；源码调用点与 dry 事件数的差额只打警告。结论：**dry 验调用序列与声明形状，不验分支覆盖**——check VALID ≠ 脚本每条分支都被走过，守卫分支的正确性只有真实运行能证明。**循环特别警告**（09-B，r09-retry-demo 实录）：`step` 模拟恒 `ok:true` ⇒ 以"步骤成功"为 break 条件的 `while/for` 会在 dry **假成功早退**，随后未守卫的终局 `ctx.fail` 把 dry 判红（报错自曝 `ok:true` yet exhausted 的矛盾即此坑）——dry 预演只到声明面为止，循环语义一律真实运行验；各分支的**声明校验**可用 `run --dry --slot <k>=<v>` 逐分支触达（08 实证，不占真实额度）。
- 观察类调用（text/value/count/attr/extract）都进 trace，所以带读取的脚本可以 `--replay`。进程步（`run`/`dangerous`）自 08-C 修复起同样进 `step_traces`（成功步无 stop_code、attempts/exit code 在嵌套 result 里）。

### 池文本 ≠ 页面 innerText（R11/R12 实证）

元素池给模型看的 `label` **不是页面 `innerText` 的拷贝**，是一条合成投影（`src/engine/extraction.ts`）。
两面文本对不上不是 bug——应用层脚本必须分清用哪一面：

- **来源分歧**：池 label 优先取**属性**而非正文，顺序是 `aria-label` → `title` → 首个子节点文本 →
  `innerText` → placeholder/value（`EXTRACT_JS` 的 `labelOf`）。广告卡片的 aria-label 带完整事实
  （"Ad · $175/night"），卡片可见文本却写 "Sponsored"（R12 实测——两个面都"对"，来源不同）；
  "Prices starting from …" 这类价格事实也可能只活在属性里：池里有、DOM 文本里没有（R11 实测）。
- **合成与归一**：PUA 图标字形剥离、空白折叠、40 字截断；表单控件把 label wrapper 拼成
  `label / wrapper`；select 的当前值以 `[now=…]` 呈现；重复 label 附 `[near=…]` 容器身份行
  （来自祖先容器的 innerText 行，过滤纯价格行）。低置信宽扫还会合成**启发式伪按钮**
  （可见自绘 div/span 的 innerText，标 `heuristic: true`）——这些行只在池投影里存在。
- **正确做法**：hint/词面匹配按**池文本**写（模型看到的词面就是池投影）；对 DOM 文本解析
  （`ctx.read.text` / `ctx.extract` 的 fields）按**真实 innerText** 写——把池文本上的正则直接搬到
  DOM 解析，Ad 锚与属性化价格这两类分歧都会 miss。两面疑似不一致时，先用 `amber inspect`
  对照池投影与页面文本再落笔。

## 6. 完成信号与结束态不变量

完成只认证据面，构造器都来自 `kit` / `ctx`：

- DOM：`ctx.judge.url(...)`、`exists`、`existsText`、`text`、`equals`、`value`、`all(...)`、`any(...)`、`not(...)`；
- `ctx.judge.existsText(sel, "Traffic")` = **存在任一**匹配 `sel` 且文本含 `"Traffic"` 的元素（`css_exists_text`）：
  live 用 Playwright `hasText`（跨主 frame 与可达子 frame——同源/跨源均可，大小写不敏感子串，含后代文本）；`amber apps` 的池/离线
  评估是**近似**（匹配元素的合成 label 包含 text），诱导期不据此下结论。
- `ctx.judge.exists(sel, { visible: true })` = 存在且**可见**（`css_visible_exists`，首匹配 `isVisible()`）；
  池/离线评估不可判定（返回 null，诱导期按“需真实验证”处理）。旧写法 `exists(sel)` 语义不变（`css_exists`）。
- 组合器是**变参**不是数组：`ctx.judge.all(ctx.judge.url("a"), ctx.judge.text("h1","x"))` ✔；
  `all([a, b])` 加载期 INVALID（2026-11-01 实测：初次使用者首个就在这里被 apps check 拦下，
  报错定位准确、一次修正）。
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
| `done_preheld` | `warn` | pre-held done 的处置（`warn`/`fail`/`allow`）；只覆盖命令步 |
| `effect_readback` | `{fill:true,set_range:true}` | fill/setRange 的 effect 读回 |
| `settle` | `{quiet_ms:400,timeout_ms:5000}` | 抽池前的稳定门（S2）：只在页面有 DOM 突变时等到静默；`"off"` 关闭。等待进 `state.settleMs` |
| `decision_state` | `{gate:"off",context:"off"}` | S5 决策状态接入（A/B）：`gate:"stable_only"` = ask 前 settle + 同池同题不重复问（`decisions.asks_saved/gate_waits`）；`context:"delta"` = 请求带 ≤200B 结构化 `state_digest`（provider 不支持则跳过，记 `context_skipped`） |

产物里的 `effective_policy` 只在非缺省时出现，并写明来源（`cli` / `config` / `app` / `provider` / `default`）。

`meta.pace` 声明运行节奏（毫秒，`0..60000`，加载期校验）：`between_steps_ms` 是两次执行步（`ctx.step` / `ctx.arrive` / `ctx.manual` / `ctx.run`）之间的**最小步间距（B1）**——相邻两次引擎单元**开始时刻**至少隔 gap（start-to-start ≥ gap）；上一步耗时长则本步不补等，不再是「无条件 sleep」，且首个单元之前不等。`between_actions_ms` 是同一浏览器子目标内两次动作之间的等待。优先级：**本次显式（嵌入方 opts） > `meta.pace` > 环境变量 > 0**；环境默认是 `AMBERFLOW_STEP_DELAY_MS` / `AMBERFLOW_ACTION_DELAY_MS`。缺省全 0——注意“环境变量”一层含入口引导从 `configs/amberflowrc.json` / `amber config` 吸收进来的机器配置值，机器上非零节奏多半来自这里；凡结果出现 `pace`，同处的 `pace.sources` 逐字段点名来源（`explicit` / `meta` / `env` / `default`）。规划脸（`plan run`）与 online 套件是 env-only（没有 `meta.pace` 声明面），同样遵守最小步间距语义。详见 [MANUAL_STEPS_AND_PACE.md](MANUAL_STEPS_AND_PACE.md)。

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
- **`decisions.rejected_conf`（U8）**：被置信闸门拒绝的 ask 子集的 conf 分布 `{n, min, max}`
  （n=0 或无被拒时字段缺席；dry 面无 ask 同样缺席）。口径与既有 `conf`（**过关**模型步的
  trace 分布）互补并存：这里记的是模型意见在 floor 处被**丢弃**的 ask——主闸门拒绝后
  reobserve/escalate 换意见或 `low_confidence` 停（R8 p3-broad 的 ask1 形状）；
  adjudicate/priorHit 复用的意见不算（其 conf 走 trace 进 `conf`）。被拒 ask 不留 trace 行
  （幸存者偏差，R8 J3）——校准 `conf_floor` 前先看这个分布，别只看过关票的 conf。
  `needs_value` 等动作层闸门的拒绝不是 conf 闸门事件，不进本字段（它们在
  `skipped_actions[].reason`）。

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