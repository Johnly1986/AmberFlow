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
   值只认 slot：fill/select/drag/upload/clickAt 的值来自任务输入或数据源（缺值如实 needs_value，不猜）；采样与分块：虚拟列表按视口采样（池里只有已渲染的行，滚动/翻页分块取全）、长流程分块成多个短应用、多源双腿（meta.sources 数据腿 + 浏览器腿互核）；
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
| 提槽清单 | 哪些值随任务输入 / 数据源变化 | `meta.slots`（fill/select/drag/upload/clickAt 只认声明绑定） |
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

### 0.6 卡点 → 能力速查（eval3 曝光面；骨架同款 cookbook）

每行一个反复踩的卡点和它的既有能力——停因 reason 也会当场点名（见 §10）：

| 卡点 | 能力 |
|---|---|
| 自绘 div 筛选/按钮不在池 | `meta.policy.target_resolution:"declared"`（DRF：attr/文本精确匹配+唯一可见+hit-test，§4.11） |
| 看不到当前页元素/池 | `ctx.observe()`（免费只读；admitted/why_not_admitted/hint_candidates；dry 下 `elements=[]` 只验形状） |
| `target=_blank` 会开新标签 | step opts `newTab:{urlContains}`（自动采用+去重，别重复点击；§4.9） |
| 慢 SPA/步内挂死 | step `timeoutMs`（=整步挂钟帽，超时 stop `step_timeout`） |
| 首屏外内容/滚到页底 | `ctx.scrollList("document"|"body",{to:"bottom"})`（合成滚动目标） |
| 弱否定 done/误入登录 | `weak_done` lint + `false_done` guard；正向锚配 `ctx.judge.loginWall()`（§6） |
| act hint 未命中不想让模型乱选 | `meta.policy.act_hint:"strict"`（§10） |
| 需要回入口页 | entry-only 放行 `meta.site.pages` 声明页（URL 归一全等；§4.10） |
| React 受控输入 `judge.value` 不成立 | 改用 text/exists/JS 可见事实（value readback 对受控输入不可靠，§6） |

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
- **dry 真执行语义（消歧义）**：`apps check` / `run --dry-run` 会**真实执行 flow 脚本体**——浏览器调用被合成、不访问网络（step/arrive 恒 ok、done 不评估），但脚本自身的**文件/进程副作用会真的发生**（写文件、Node IO 都是真的）。`apps check` 输出一行提示（JSON 面 `data.dry_semantics`）。两面判据用 **`ctx.runtime.dry`**（dry/replay 恒 `true`、真跑恒 `false`）；**`epoch === 0` 不再是 dry 判据**——真跑首个观察前 epoch 同样是 0。
- **inspect vs ctx.observe（消歧义）**：`inspect` 是**独立一次性会话**（新开浏览器、不 attach 运行会话），适合入口页/任意 URL 的离线侦察；**会话内实时看当前页**用应用内的 `ctx.observe()`（免费只读、不改页面；dry 下 `elements=[]` 只有 counts——形状校验用）。
- **learn 录制 hint vs inspect 候选（口径差异）**：learn 接受的 `hint` 是六形状闭集且**属性白名单只认 `test`（→data-test）、`type`、`aria-label`（label 别名）**参与匹配（完整池面白名单另含 href/name/id/role/near，见 `amber schema ctx` 的 hints 节）；class/title/placeholder 永不命中。`inspect` 展示的 `hint_candidates` 是引擎经**同一个** `hintMatch` 在当页自证过的结果——它输出的就是六形状之一，可直接照抄进 `act: ctx.hint(...)` 或 learn 的 `hint`；自己从页面 HTML 里挑的属性则必须先过白名单再落笔。
- `inspect` 只读：标题、URL、有界元素、候选 hint；不点击、不输入、不调模型。元素池视图**只含可行动元素**——写 `exists` / `text` 类完成信号前先 `inspect --probe "<selector>"`（可重复，最多 10 个；只读返回存在数与前 5 条文本，`--json` 落 `probes[]`），别用 raw HTTP 之外的口子。**任何选择器——包括本文档与上游示例给的——落笔前都要对目标页实证一次**（02 轮 C6 的教训）。快览用 `--summary`（人话紧凑：元素仅前 12 条、hints 前 2 条、href ≤40 字符、总行数有界；`--json` 面不变）。
- **P0-A inspect 观察面修复**：`--json` 的 `elements[].label` 现在是**完整**标签（不再截断成 40 字前缀；超过 200 字符时 `label_truncated:true` 只表示引擎**匹配口径** `full_label` 只取前 200，输出本身是完整的），并新增 `class_names`（有界：≤8 个、每项 ≤40 字符）与顶层 `saw_at`/`wait_ms`。`--wait-ms <n>`（默认 0，上限 5000）在 `load` 完成 + 3s 交互计数稳定轮询**之后**再等 n 毫秒，给 `setTimeout`/异步接口补渲染的元素；`saw_at` 是真正读取 DOM 的时刻（人类输出同样打印「观察时刻 …」）。既有字段语义不变，只增字段。
- **AX 证据源（只读参照面，不进决策）**：`inspect --json` 新增 `ax` 块——浏览器自己算的可访问性树。`nodes[]` 每条 `{role,name,focusable,disabled}`（展示前 50；内部上限 200，按“可交互→有名→其余”+ 文档树序），另有 `interactive_count`、`counts_by_role`（全树 role 计数）、`interactive_counts_by_role`、`total_nodes` 与 `pool_size`/`not_in_pool`。**可交互口径**：原生可聚焦/可激活的 AX role（button/link/textbox/checkbox/radio/combobox/listbox/menuitem/tab/slider/switch/searchbox/spinbutton/summary 等；Chromium 对 `<summary>` 报 `DisclosureTriangle`）；**`option` 有意不计入（即使浏览器报 focusable=true）**——select 内部的 option 由引擎 `select` 动作承载（不是池里的独立动作目标），计入只会让 `not_in_pool` 被每个 select 的 N 个 option 灌成噪声；原始 role 仍在 `nodes`/`counts_by_role` 可见，或浏览器报告 `focusable=true`（例如 `div[tabindex=0]` 的 generic）；文档根（RootWebArea）即使 focusable 也不算，`generic/none/group` 只有 focusable 才算；静态文本叶子不进证据。`not_in_pool` 是**近似**口径：AX 可交互且有名字的节点中，name 与池元素 label 归一化后全等/互相包含算已进池，否则计未进池（空名节点不参与，看 `interactive_count`）。**边界**：AX 是“浏览器认为页面有什么语义”，不是“引擎能指向/可点击”的断言——池仍是选择器闭集，AX 不进池构成、hint 匹配、模型视图或任何动作/运行路径；取树只发生在 `inspect`（每页一次，超时 ≤3s），失败降级为 `ax.available=false`（人类输出不打印该行），其余 inspect 输出照常。
- `run --max-steps N` 是 `ctx.step` / `ctx.arrive` 的**执行预算**，不是“从第 N 步开始”。用满预算时 `status=partial`、exit 0、`verified=false`，已执行步骤与 trace 保留。
- 失败先看 `steps[]` 的第一条失败、`failure`、trace 里第一次 `ok:false` 的 `stop_code/reason`，再改 `app.mjs`。没有“只改第 7 步”的旁路——脚本版本就是唯一的流程版本。
- **运行产物编码（Windows PowerShell 5.1 注记）**：`report.md`（`<outDir>/<id>-report.md`；online 套件报告 `online-runs/<run-id>/report.md` 同口径）为 UTF-8 **带 BOM**——PS 5.1 的 `Get-Content` 对无 BOM 文件按 ANSI 读（中文全花屏；2026-11-09 取证：同一文件无 BOM 读出「杩愯鎶ュ憡」、带 BOM 正确），带 BOM 即默认读取正确。**JSON 产物（`<id>-result.json` 等）保持 UTF-8 无 BOM**——Node 的 `JSON.parse` 不容 BOM，读取必须**显式 UTF-8**（Node 默认即 UTF-8；PS 5.1 用 `Get-Content -Encoding UTF8`）。控制台捕获面：Node 的 TTY 输出走 `WriteConsoleW`（直跑显示不乱码）；PS 5.1 **管道捕获**按其会话的 `[Console]::OutputEncoding`（随控制台代码页，默认 936）解码 UTF-8 字节 → 乱码。引擎**不在 bin 层改控制台代码页**——实验结论（2026-11-09）：PS 在 spawn amber 之前就按当前控制台 CP 缓存解码编码，运行中改 CP 修不了本次调用的捕获，只对后续新开的 shell 生效，且持久修改控制台 CP 是侵入性副作用；PS 5.1 用户自修：会话开头执行 `[Console]::OutputEncoding=[Text.UTF8Encoding]::new()`，或先 `chcp 65001` 再开 shell。

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
| `hosts` | 允许的主机列表；导航信封在 dry 与真实运行都执行。**要预判重定向落点**：链接 href 的主机变体（apex ↔ `www.`）与 301 后的真实落点都要进信封——实测 href 指 `iana.org`、实际落 `www.iana.org`，只声明 href 侧会在落地撞 `host_not_allowed`（2026-11-01）。**子 frame 不是导航信封**：信封外的第三方 iframe 默认只排除出解析面（`frames_excluded` warning），不因广告/统计 iframe 废掉正常步骤；只有声明 target / done 只存在于该 frame 时才 `frame_not_allowed`（见 §4.9 末「frame 门禁」） |
| `slots` / `requiredSlots` | 数据槽与必填槽；缺值返回 `needs_value`，不猜 |
| `secretSlots` | 敏感槽位名单（如 `password`、`otp`）：result/report/stdout/dry 输出时掩码为 `***`；值仍建议走 env/本机配置，别写进 app.mjs |
| `sources` | 数据腿名（`ctx.source(name)` 按名字按需加载） |
| `device` | 浏览器设备面（只有手机版页面的站点需要声明） |
| `site` | 站点面：页面角色 `pages`、命名行抽取 `listExtract`（见 §5） |
| `model` / `maxSubgoals` | 决策模型 checkpoint / 子目标上界（高级，缺省即可） |
| `notes` | 给人看的备注（字符串列表），不参与运行 |
| `policy` | 运行策略：`conf_floor` / `tiered_hint` / `reobserve` / `max_effective_repeats` / `risk_ask` / `done_timeout_ms` / `done_poll_ms` / `pool_ready_timeout_ms` / `pool_ready_poll_ms` / `candidate_priority` / `done_preheld` / `effect_readback` / `settle` / `pool_gate` / `surface` / `decision_state` / `navigation` / `act_hint` |
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
| 元信息 | `ctx.app` / `ctx.slots` / `ctx.runtime` / `ctx.budget` / `ctx.log(msg, data?)` | `slots` 只读；`runtime = {outDir, runId, today, epoch, dry}`（`epoch` = 执行器状态游标只读投影，每次抽池/观察 +1，每个 `step` 重置；dry 恒 0；`dry` = 两面判据——dry/replay `true`、真跑 `false`，见 §2 消歧义）；`today` = CLI `--today YYYY-MM-DD` 钉住的"今天"，没钉 = 系统日期 |
| 导航 | `ctx.open(url)` / `ctx.openPage(role)` / `ctx.arrive(url, {done, desc?, id?, timeoutMs?})` | `arrive` = 纯导航 + 等信号，不做元素选择、不花模型；`hosts` 信封在起点与落地都强制 |
| 标签页 | `ctx.tabs()` / `ctx.switchTab({index?, urlContains?, titleContains?})` | `tabs()` 免费只读列出未关闭页（`{index,url,title,active}`）；`switchTab` 显式切到**恰好一个**匹配页（计 1 个 flow step），0/多匹配 = `config_error`、信封外 = `host_not_allowed`。新标签页**不会自动跟随**，见 §4.9 |
| 决策语句 | `ctx.step(goal, { id?, act?, done, url?, slots?, values?, when?, timeoutMs?, force?, forceAct?, staleRetry?, newTab? })` | `done` 必填；`act` 省略 = 引擎决定目标，给了 `ctx.hint()`/命令闭集才收窄候选；返回 `{ok, id?, stopCode?, reason?, evidence}`；`values` 是决策步的显式值袋，见 §4.5；`newTab` 把 `target=_blank` 的新标签升为一等完成面（见 §4.9）；`timeoutMs` 是动作后信号窗口 + 整步挂钟帽（见下）。**步级 `slots` 的键仍须在 `meta.slots` 声明**（dry 校验按 `meta.slots` 口径查键，步级提供的是**值**不是新键——键没声明时 check 直接红 `value.key … is not a declared slot`） |
| 人工步 | `ctx.manual(desc, { done, instructions?, id? })` | 见 §7；非 TTY 返回 `needs_human`，不假装有人 |
| 观察 | `ctx.url()` / `ctx.read.{text,value,count,attr}(sel[, attr])` / `ctx.holds(signal)` / `ctx.waitFor(signal, {timeoutMs?, pollMs?})` | 只读；读不到返回 `null` / `0`；`waitFor` 轮询到 bounded deadline，返回 boolean；`url()` 首次导航前是 `"about:blank"`，别拿它当入口页判断 |
| 只读侦察 | `ctx.observe({ max?, selector?, includeHidden?, includeFrames? })` | **免费只读**：返回当前页 DOM 侧真实存在的元素清单（`ref o0/o1…`；字段 `tag/label/role/id/name/data-test/type/href/class_names/visible/bbox/frame` + `admitted`/`why_not_admitted`/`hint_candidates`）。不计 flow step/预算、不写 outDir、**不进模型请求面**、不改页面状态（无点击/滚动/导航）。默认走当前准入面（ADMIT_SEL 投影 + `[data-js-ref]` 后缀，不新增类目）；`selector` 可用任意只读 CSS 看池外目标。`hint_candidates` 用同一个 `hintMatch` 在本次观察到的准入面元素集合上**自证**（唯一命中才给），可直接照抄进 `ctx.hint(...)`/命令 `target`——但自证范围就是本次观察集合：默认观察（未截断）时等于整个准入面；`selector` 或 `truncated:true` 时只在所选子集/前 max 行内自证，照抄前应再做一次默认观察复核；`admitted` = 匹配准入面 + 可见 + 至少一条自证 hint（**不等于**"一定在本次 120 窗口内"，窗口见 `inspect --json` 的 `window`）。最多 200 行、≤6 帧；`max` 超出/未知选项 = `config_error`；非法 CSS 返回 `{ok:false, error:"bad_selector", reason}`（不抛栈、不中断 flow）。dry = `{ok:true, dry:true, counts 全 0, elements:[]}`；replay = `{ok:true, replay:true, …}`（只还原 counts/truncated，元素明细未进 trace），trace 只记 `{call:"observe", url, counts, truncated}` |
| 站点面 | `ctx.openPage(role)` / `ctx.extract(nameOrSpec)` / `ctx.rows(...)`（v1 关闭） | 具名抽取声明在 `meta.site.listExtract`；inline 抽取用 `{ rows, fields, maxItems? }`（例：`ctx.extract({ rows: "li.item", fields: { title: ".title" } })`，无需 meta 声明）；`rows` 调用给结构化错误 |
| 数据 | `ctx.source(name, {dates?})` / `ctx.data.{min,max}(rows, by)` | 数据腿按需拉取；`--skip-data` 时 `source` 报结构化错误。`dates` 显式给本次范围（单日 / `A..B` / `next_week`）；缺省按 source JSON 的 `default_dates`（支持 `"{slot}"` 占位符，从包默认 + `--slot` 解析；不许引用 `source_slots` 产物）。观察视图 `byDate` 按日期保留完整 counts/selects/rows |
| 进程 | `ctx.run(...)` / `ctx.dangerous({...dryRunArgs})` | 见 §4.8（`returns` → 数据集、工件、失败诊断）；危险步默认拒绝 |
| 构造器 | `ctx.judge.*` / `ctx.tool.*` / `ctx.hint()` / `ctx.hints()` / `ctx.command()` / `ctx.value.*` | 与 `kit` 同一份实现；命令 op 见下。**`ctx.hints(...)` 是目标声明构造器（一次声明多个有序 hint），不是元素池查询器**——要看当前页元素/池外原因请用 `ctx.observe()` |
| 收尾 | `ctx.done()` | 结束态不变量验收；之后不允许再有动作 |
| 终止 | `ctx.fail(code, reason?)` | 抛结构化 `StopError`，退出码/状态走引擎既有分类，不抛裸栈 |

- `when` 是适用性守卫：动作前判定，不成立时该步不执行（返回 `ok:false`、`stopCode:"precondition_skipped"`），脚本可以据此分支。跳过步**同样消耗一次执行预算**，trace 里状态记为 `skipped`（不是 `failed`）；不要把 `if (!r.ok) ctx.fail(...)` 的失败模板直接套在守卫步上，先判 `r.stopCode`。
- `act` 缺省就是“决策语句”：只给目标语义和完成证据，让规则/模型选元素；硬编码 `ctx.hint(...)` 只作为稳定锚点或候选收窄，不应成为每条流程的默认。
- `ctx.observe()` 是**当次侦察**，不是页面契约：别把它的输出（label/class/bbox）写成应用常量——可固化的是它给出的 `hint_candidates`（已用同一个 `hintMatch` 自证）或从中提炼的稳定句柄，且仍要经一次真实运行验证。dry 期 `elements:[]`、replay 期 `elements:[]`（只有 counts/truncated，元素明细不进 trace），依赖元素明细的分支只在真实运行成立；观察本身永远不推进页面，也不会替代 `done` 信号。
- 导航同样优先用 `meta.site.pages` + `ctx.openPage(role)`，而不是在流程里重复硬编码 URL；业务值优先用 `meta.slots` / `ctx.source`，不要写死在 `flow` 里。**运行期才知道的 URL**（如命中链接的相对 href）可在 flow 里 `new URL(href, ctx.url())` 绝对化——URL 全局构造器在脚本进程可用（06 轮实证），这是"角色覆盖不到的动态地址"的正规通道，不是硬编码豁免。
- 命令闭集的 op 是引擎能力面（10 个）：`click` / `check` / `fill` / `select` / `scroll` / `drag` / `hover` / `skip` / `upload` / `clickAt`。
  `scroll` 把目标滚入视口；`drag` 的 value 是落点 selector（可来自槽位），只在 `[draggable=true]` 或 slider 族元素上声明能力；
  `hover`（S4）只把指针移到目标上（`locator.hover()`），用于 `:hover` 展开的菜单/图层面板——不点击、不导航；完成仍只由 done 信号裁决。
  `upload`（U6）只对 `<input type="file">` 成立：值走既有声明绑定（`ctx.value.slot(...)` / `{from:"slot"}`；`dataset` 亦可，`option` 不适用），string = 单文件、string[] = 多文件；缺值 = `needs_value`，空串/空数组/非字符串 = `config_error`，路径执行前 `fs.existsSync` 校验、缺失 = 结构化 `config_error`（reason 点名 basename）。**不做**环境变量/通配/目录遍历解析，不猜路径。证据只记 basename（`executed_actions` 的 `{op:"upload", how:"setInputFiles", files:[…]}`），`changed` 按调用后 `input.files.length ≥ 期望数` 如实记；非 file 目标 = `action_unsupported`。dry/`apps check` 只校声明形状，不读本机文件；上传不新增 risky 语义。隐藏 file input 在池的可见性过滤下仍不可见（后续项），本原语只要求可见 file input。
  `clickAt`（U7）在**元素相对**坐标上点击：`ctx.command("clickAt", "#cv", ctx.value.slot("coords"))`，值的规范形是声明绑定的字符串 `"x,y"`（非负整数或有限小数，允许空白；原点 = 元素 padding box 左上角，Playwright `locator.click({position})` 语义）——用于 canvas 这类"进了池但只能点中心"的自绘控件。严格解析，坏格式（`center` / 百分比 / 负偏移 / `x;y` / 多余段等）= 结构化 `config_error` 并点名合法格式，不猜；只对 click 族元素成立（非 click 族 = `action_unsupported`）；执行前用元素 bbox 校验 `0 <= x < width`、`0 <= y < height`，越界 = 结构化 `config_error`（reason 带实测 width/height）。证据 `executed_actions` 记 `{op:"clickAt", position:{x,y}, changed}`（`how:"clicked"`），`changed`/inert 沿用 click 的快照 diff 口径；`force` 语义同 click，风险面沿用 click 的关键词/模型风险票。dry/`apps check` 只校声明形状，不解析坐标。
  `skip` = 按定义解决的零动作命令：全部命令解决后引擎会**评估一次 done 信号**再判成败——"导航由 arrive 完成、本步只验证到达"的守卫步合法可用（04-A 修复；此前 skip 步的 done 从未被评估，必报 `done_not_held`）。守卫步写法：`act: [ctx.command("skip")]`（完整可跑示例见 `examples/apps/01-basic-step` 步骤②）。
  不在能力面内的 op 会得到 `action_unsupported`，目标歧义是 `target_ambiguous`，目标不存在是 `target_not_found`。
- **act hint 是六形状语法闭集**（唯一解析器 `src/engine/hint.ts`，语法**描述**的唯一出处 `src/engine/grammar-prompt.ts`，`npm run prompt-hit` 校验示例可命中、报错/提示词/桥描述不漂移）：`#id` ｜ `tag[attr~substr]` ｜ `tag~token` ｜ `tag[attr=value]`（值去引号、全小写折叠）｜ 角色词 `button|link|input|textarea|select` ｜ 裸词（按 label 匹配）。属性名按池字段匹配：test→data-test、type→input_type、aria-label→label、href、name、id、role、near；aria-label 是 label 的别名（提取期已并进 label），class、title 等不在池字段模型里，永不命中（本句由 grammar-prompt 的 ATTR_MATCH_MODEL_TEXT 生成，prompt-hit 逐字校验，勿手改）。**容器/后代 CSS（如 `#outer input`）不是语法错误——会被解析成一个永不命中的形状**；命令空间的 `target_not_found` reason 附闭集提示，而 act hint 落空会**静默回退模型决策**、报 `low_confidence` 不附提示——写 hint 前先 `inspect` 拿验证过的 `hint_candidates`。

#### 候选窗口与分桶（A2：窗口是**有界快照**，不是"页面没有"）

候选窗口是**有界快照**：每步只取 40（宽扫 120）个候选，按桶配额来自当前视口——chrome 8 / viewport 16 / contentNear 8 / mainOffscreen 6 / other 2，不足时按 viewport→contentNear→mainOffscreen→other 顺延；窗口外不等于页面上没有（`inspect --json` 的 `window` 会给出窗口外可见交互），引擎不自动滚动。真正需要读完整列表时用滚动/展开原语分块取证。hint 匹配用**完整标签**（≤200，`full_label`）而不是模型视图的 40 字前缀：裸词按大小写不敏感的词边界/前缀匹配，`[aria-label~x]` 是 label 的别名。要回退 A2 之前的主内容优先排序，在 `meta.policy` 写 `candidate_priority: "main-first"`（缺省 `bucketed`；dry/plan 面同一字段）。

- **rules-only 的窗口恢复（W10）**：无模型面（规划脸/online 套件）里，声明的 `target_hint` 若被 40 窗口挤出，规则解析失败后会做**一次** 120 元素、main-first 的宽扫重解析（`hintMatch` 确定性，命中即用；常规窗口内命中零多付，不放大 attempts）。这覆盖"hint 在池投影里可匹配、但被配额挤出"的形状；宽扫与常规窗口用**同一匹配底座**（T9 起 `href` 是 `href_full` + `href` 双字段），匹配底座层面就匹配不上的 hint 它也救不了。
- **href 的匹配底座（T9）**：池字段 `href` 仍是**有损展示投影**（去 origin、去 query，只保留路径结尾 ≤2 段；模型视图/criteriaView 用的就是它，逐字节不变）；`[href~…]` / `[href=…]` 匹配时引擎**同时**看原始属性值（`getAttribute('href')` 原样，query/fragment/origin 都在），任一字段命中即算——`a[href~page=2]` 这类 query 型 hint 从此可命中，旧路径型 `a[href=many.html]`（依赖投影）照旧命中。`inspect --json` 的 `hint_candidates` 给的是**原始值**（已用同一个 `hintMatch` 自证可命中），元素的 `href_full` 同样可在 `inspect` 看到。分页/筛选链接仍优先用 label 裸词（如 `next`）、`[data-test=…]` 或 `#id` 这类稳定锚点。
- **声明驱动的身份回捞（FW8，identity recovery）**：反应型框架（React/Vue）把 click 监听挂在根容器，叶子自绘控件自身没有可枚举属性——它既不在选择器闭集（池）里，也不在 ADMIT 准入面里，`act: ctx.hint("#leaf")` / 命令 target `#leaf` 这类**稳定身份声明**曾经永远解析不到。现在：**当且仅当**这一步作者声明的目标（命令 `target` / act hint / plan `target_hint`，同一执行器路径）在池 + hint 回捞后仍解析不到，且声明是**身份形状**时，引擎按身份到 DOM 里找**恰好一个可见元素**并执行。五条约束（实现/审查口径一致）：
  1. **只服务声明面**：决策步（无 act）与模型选出的元素**永不**回捞，回捞元素也不进 `ChoiceRequest.elems`、不参与 done 判定——它只是这一步声明目标的解析结果。
  2. **形状白名单**：只认 `#id`、`tag[attr=value]`、`[attr=value]` 且 attr ∈ {test→data-test, name, id}（精确值，大小写折叠与池侧一致）；`tag[attr~substr]` / `tag~token` / 角色词 / 裸词 / `near` 都不是身份声明，行为与以前逐字节一致（不触发回捞）。
  3. **恰好一个可见匹配**：跨 frame（与 hint 回捞同口径）查询全部匹配；0 个 → 保持原来的失败路径（命令走后续候选/`target_not_found`，act hint 走模型回退）；**>1 个可见** → 结构化 `target_ambiguous`，reason 逐个列出候选的 tag/label/id/frame/是否可见，绝不随便选；匹配但**全不可见**（checkVisibility CSS + 非零盒）→ 视为 0，绝不操作隐藏元素，诊断带 hidden 匹配计数。
  4. **动作能力守门**：合成元素与池同构，用既有 `elemFamily`/`actionCapabilities` 判定——对普通 `div` 声明 `fill` 得到 `action_unsupported`；`click` 族对没有显式语义的 `div` 是允许的（身份声明就是作者的证据，完成仍只由 done 信号裁决）。
  5. **证据与不污染**：trace 行记 `resolved_by: "dom_identity"` + `identity:{target,shape,attr,value,matches,total_matches,hidden_matches,frame}`；`executed_actions` 的 ref 是合成标识（`dom:0` / `dom:f<n>:0`，不伪装成池 ref `eN`）并带 `resolved_by`；临时 `data-hintref` 章在动作尝试结束后清理（成功/失败同纪律）。普通页面池构成、`inspect` 输出与模型候选**逐字节不变**。

- 桶的闭集：`chrome`（nav/aside/footer/header，不受视口限制）、`viewport`（当前视口 ±15%）、`contentNear`（视口外 ±150%）、`mainOffscreen`（更远且在该页 main/article 里）、`other`。`prio` 只是诊断序，不参与选目标。
- 查窗口事实：`amber inspect --url <页> --json` 的 `window.visible_interactive / shown / out_of_window[]`；`--wide` 把窗口放到 120，`--pool` 展示 `bucket/prio/full_label` 调试字段。
- 失败判别：命令 `target_not_found` 的 reason 里出现 `viewport_underloaded` = 页面上有"内容远高于可视区"的滚动容器（虚拟列表/懒渲染），目标可能只是没渲染——不要反复重跑，按六步法② 取证。
- 行为变更（A2）：缺省排序从"main 内容优先 + DOM 序截断"改为"分桶配额 + 视口感知"；`meta.policy.candidate_priority: "main-first"` 是逐应用回退。
- 行为变更（B2 扫描面）：INTERACTIVE 扫描面追加 `[role='menuitem']` / `[role='menuitemradio']` / `[role='menuitemcheckbox']` / `[role='option']` / `[role='tab']` 五个 ARIA 角色（全部 click 族，选中语义也是 click 驱动）——弹层菜单项、下拉选项、页签这类 div 自绘控件从此进池，弹层路径不再依赖原生 `<button>` 兜底。对所有应用是**全局行为变更**：决策层看到的候选构成与排序可能变化；同名候选增多可能引入新歧义（例如 tab 与按钮同 label——按 hint 收窄或换 data-test 锚点消歧）。对 hint 命中无影响（仍按 label 匹配，六形状闭集不变）；窗口大小（40/120）与分桶配额不变，新 role 走既有分桶。
- **hint 与 done 信号是两个观察面**：`ctx.judge.*` 的 selector 走 DOM 查询面（任意 CSS 可用）；act hint 走上述语法闭集 + 元素池投影。`inspect --probe` 数的是 DOM——probe 命中数 ≠ hint 可命中，别互相推断（03-D2/D3；闭集提示只出现在命令空间 `target_not_found` 的 reason 里）。
- 停因 reason 里的 "on step N" 是**子目标内动作步号**，与 CLI/`step_traces` 的流步号不是一个口径（04-B）。
- `ctx.step` 的 `timeoutMs` 约束的是**本步动作后等待 done 信号成立的窗口**（映射该步的 `done_timeout_ms`）——模型咨询、导航渲染不在其内（04-F）。**F3**：显式声明 `timeoutMs` 时它**同时是该步的整步挂钟帽**——reobserve/升级循环（宽扫重看 + 模型改点）的每轮与总时长受它约束：循环头逐轮检查，过期不再起新的宽扫/升级（已在途的决策调用不可抢占，超额 ≤ 一次在途调用），超时 = 结构化停因 `step_timeout`。R06 实测：done 永不成立的循环在"宽扫+模型改点"上单步内耗 3–4 分钟且不受任何约束——**脆弱步（信号可能永不成立的页）显式声明 `timeoutMs`**；未声明 `timeoutMs` 的步骤没有这个帽（行为不变）。
- 导航：`ctx.open/openPage` 只做 goto（domcontentloaded），**不等 done/信号/settle**；要"导航 + 等落地证据"用 `ctx.arrive(url, { done })`（04-C 实测：open 后半路即返，arrive 带轮询等待）。
- **预算是三层结构**（07-A/08-A6 实测成文，别按"一层"规划）：
  **① flow 调用预算**——`ctx.budget.maxSteps` / `stepsUsed`（缺省 100，CLI `--max-steps` 覆盖）；`ctx.step`、`ctx.arrive`、`ctx.run`、四个列表原语（`scrollList/expand/setRange/collect`）、`ctx.switchTab` 与批准执行的人工步一律计 1——`when` 跳过的步也计（02-C2），`read/extract/holds/waitFor/log/url/tabs` 免费；一次 `ctx.run` 恒 ≤1，其内部 attempts（重试）与 timeout 不放大本层。用满抛 `budget_exceeded`（CLI 给 `--max-steps` 时结果 `partial`、exit 0）。
  **② 子目标动作预算**——执行器每次调用的动作循环上限，**缺省 8、当前不可配置**（`executor.ts:884`），只活在停因文案里（`max_steps=8`；reason 的 "on step N" 是本层动作号，与流步号两口径——04-B）。
  **③ 信号等待窗口**——浏览器腿 done 轮询 per-click 语义（`done_timeout_ms` 缺省 2000，步级 `timeoutMs` 覆盖，04-F/07-E："7 击各享窗口，非整步挂钟"）；F3：步级 `timeoutMs` 显式声明时同时是整步挂钟帽（reobserve/升级循环的每轮与总时长受它约束，超时 = `step_timeout`；未声明 = 无帽）；进程腿 `stdio.timeout_ms` 是步内挂钟帽（缺省 20s）。
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
- 命令步（`act: [ctx.command("fill"/"select"/"upload"/"clickAt", ...)]`）不受影响：其值面仍是声明绑定 `{from:"slot", key}`
  具名绑定，`values` 不参与。
- 点击前的 required 空字段预填（引擎的确定性预填通道）同样读 `values`——与当步 fill/select
  同一个解析顺序，两个通道不会错位。
- W8 同口径：`values` 键命中 `meta.secretSlots` 名单的条目，其值同样进 effect 读回掩码。
- meta 层不需要新键（步级声明即可）；缺省不写 `values` = 行为逐字节不变。

### 4.6 列表展开、穷举与范围控件（A3 三原语 + S3 `ctx.collect`）

> 原语路径的池外回退（A3）是 grandfathered 面：按身份寻址（`ADMIT_SEL` + 盖章），仅主 frame、无可见性过滤（见 §4.7「U3 就绪判档与扫描面」）。

真实列表页与筛选面板需要三种"窗口外操作"，引擎把它们收敛成三个**结构化、可计费、失败不假装成功**的原语（内部 click/滚动不占 flow 预算；每个原语整体计 1 步，受 `--max-steps` 约束）；S3 再加一个**自动穷举**原语 `ctx.collect`（同样整体计 1 步）：

```js
// 滚动列表：目标自身或最近可滚动祖先；纯 DOM scrollTop，不做滚轮模拟、不自动滚其它区域。
// 目标可以是列表里的交互元素（最近可滚动祖先即容器），也可以直接是容器本身（如 div[role="feed"]）。
const s = await ctx.scrollList("Feed list", { to: "bottom" });          // 或 { to:"top"|"page" } / { by: 800 }
// s = { ok, scrollTop, scrollHeight, clientHeight, moved, stopCode?, reason? }
// 找不到可滚动容器 = ok:false + stopCode:"not_scrollable"；目标解析不到 = "target_not_found"
//
// F1 合成滚动目标：target 还接受 "document" | "body" | "html" | "window"（大小写不敏感）——
// 不进元素池、不占池位、不做 hint 匹配，统一解析主滚动器 document.scrollingElement
// （兜底 body → documentElement）。主内容滚动条常挂在 scrollingElement 上（R11 实测：
// scrollList("body") 曾 target_not_found），主页面滚动写这个：
const s2 = await ctx.scrollList("document", { to: "bottom" });          // "body"/"html"/"window" 同义
// 不可滚（短页 scrollHeight <= clientHeight）= { ok:false, moved:false, stopCode:"not_scrollable" }
// ——如实返回，绝不假装成功；容器目标（其他 hint）走既有解析路径，行为不变。

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
| `executed_actions?: Array<{op,target,ref,how,desc,changed,files?,position?}>` | 每个已执行动作的身份与结果；`changed` = pre/post 快照是否变化（upload 例外：按调用后 `input.files.length ≥ 期望数`）；upload 的 `how` = `setInputFiles`、`files` = 实际写入文件的 basename；clickAt 的 `position` = `{x,y}` 元素相对坐标（how = `clicked`） |
| `skipped_actions?: Array<{command_id?,ref?,target?,reason,detail?}>` | 每条"为什么没动作"的结构化原因（`target_ambiguous` / `target_not_found` / `forbidden` / `not-actionable-or-covered` / `stale_ref` / `needs_value` / `action_unsupported` / `attempt_limit` …） |
| `done_preheld?: boolean` | 命令步在**动作前**对 done 的预评估结果（只命令步出现；不改变执行顺序） |
| `warnings?: string[]` | 运行期诚实话，如 `suspected_async`（值只在产生时出现） |
| `state?: StepStateRecord` | S1 状态记录：`before/after` 指纹（`epoch`/`navEpoch`/`url`/`readyState`/`struct`/`content`）、`actions{attempted,executed,changed}`、`flags`（`done_preheld`/`no_state_progress`/`pool_empty`）、`settleMs`（S2 稳定门等待毫秒；策略关闭时省略）、`effect`（fill 读回 `{kind,before,after,applied}`；敏感槽位来源的 before/after 恒 `***`、applied 保留——见「effect 读回的掩码」）；`step_traces[i].state` 与 `result.warnings[]` 是同一份证据 |

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
- `hover` 命令：见 §4 命令闭集——它只移动指针（`:hover` 菜单/图层面板），不点击、不导航、不触发预填；
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
- `ctx.runtime.epoch`：执行器状态游标只读投影（每次抽池/观察 +1，每个 `step` 重置；dry=0）。**两面判据是 `ctx.runtime.dry`**（dry/replay `true`、真跑 `false`）：`epoch===0` 不再作 dry 判据（真跑首个观察前同样是 0）。
- **警告一等公民（eval3）**：result 顶层 `warnings_count: n`（= `warnings` 数组长度，**仅 n>0 时出现**——与 `steps_failed` 同口径：clean run 键集不变）；report.md 摘要行同步带「**警告 n**」（仅 n>0）。警告（`false_done` guard / `frames_excluded` / `pool_empty` / `suspected_async`…）是执行期诚实性证据，**不是完成判死**——有警告时先读 `warnings[]` 里的修法再决定要不要改脚本。
- `result.warnings[]` 汇总跨步 flags（`done_preheld`/`no_state_progress`/`pool_empty`）与既有
  `suspected_async`；这些是**证据**，不改 done 语言、不影响完成真值。（W1 验收移除了一个
  控制流上不可达的串扰 flag——r8 跨城串扰签名由 `done_preheld` + `no_state_progress` 覆盖。）
- **失败步计账（P0-E）**：result JSON 的 `steps_failed` = `step_traces` 里 `status:"failed"` 的步数
  （仅 **>0 时出现**；`skipped`/`recovered` 不算失败），report.md 摘要行同加「失败步 n」。
  `ok`/`verified` 语义**不变**——脚本容忍的步失败是数据不是判死：**受阻交付**（run 绿但交付数据
  null）必须用交付 JSON + notes 表达，并用 `steps_failed`/报告摘要核对「这轮有步失败」这件事。

**U3 就绪判档与扫描面（`pool_gate` / `surface`，2026-11）**

池空不再等于 `page_not_ready`。执行器把**已有的** settle 结论（`settled`/`timedOut`）接回池空闸门，并加一次只读 sniff（`readyState` / 准入面可见计数 / `[tabindex]` / ARIA / 正文长度）判四档：
`ready`（池非空）→ 正常；`not_ready`（预算耗尽且 settle 未静默或 `readyState≠complete`）→ 保留 run 级 `page_not_ready`，reason 点名 `budget_ms`/`waited_ms`/`settled`/`settle_timed_out`/`readyState`；`ready_empty`（预算耗尽但已静默且 `readyState=complete` 而池为 0）→ 该步 `state.flags` 记 `pool_empty` + 一条 run 级 warning（点名 sniff 计数）后**继续**，由后续命令/信号给出真正的失败证据；`navigating` 仅保留在类型里。

- `meta.policy.pool_gate`：`"fact"`（缺省）走上面的 `ready_empty`；`"strict"` 把 `ready_empty` 改判 `not_ready`（U3 之前的快败行为，逃生口）。**闸门只在 flow 脚本面**：只有 `ctx.step` 打开 `poolReady`；声明式 journey 与 plan 面 `poolReady=false`，本键不产生作用（也不产生 `page_not_ready`）。
- 闸门预算是**真上限**：每轮 settle 的 timeout 都被钳到剩余预算，总等待 ≤ `pool_ready_timeout_ms` + 一次抽池；`budget_ms` 与实测 `waited_ms` 同时进 reason 与 `diagnostics.readiness.evidence`。`diagnostics.readiness={verdict,evidence}` 在 verdict≠`ready` 时出现（`ready_empty` 也出现），`evidence` 含 `ready_state`/`settled`/`settle_timed_out`/`pool_size`/`waited_ms`/`budget_ms`/`sniff{admitted,focusable,aria,frames,body_text}`。
- `meta.policy.surface.native_activation`：`"window"`（缺省）把 `<summary>` 收进元素池并按类目 cap=6 截断（30 条 FAQ 的 summary 不会挤掉页头按钮；被裁元素进 `inspect --json` 的 `window.out_of_window_total`）；`"off"` = 池构成回到 U3 之前（A/B 对照）；`"resolve"` = 进**准入面**但不入窗口（决策步看不到 summary，命令/声明 hint 仍可按身份回捞命中并执行）。`settle:"off"` 时没有 settle 证据 ⇒ 判档落 `not_ready`（`pool_gate:"fact"` 在 settle 关闭时不产生 `ready_empty`）。**全局行为变更**：所有 flow/声明式应用的候选池都可能多出 `summary`（以及 `contenteditable="plaintext-only"`）——同名候选增多可能引入新歧义，`inspect --json` 的 `window.surface_counts` 给出按类目可见计数。未知子键/非法值在 `apps check` 就红。
- A3 池外回退（`ctx.expand`/`scrollList`/`setRange` 的原语路径）是 **grandfathered** 面：它按身份（hint 语义 + `data-af-probe` 盖章）寻址，用准入面 `ADMIT_SEL`，刻意保持**仅主 frame、无可见性过滤**的既有语义（0×0 自绘滑块手柄只能靠它点到）；step/命令面仍只认池 + hint 回捞，两条面不要互相推断。
- 回捞去重按**节点身份**（已带 `data-dshref` 即跳过），不再比较 `scan` 序号——池面与准入面的序号空间本就不可比。

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

### 4.8 进程步 `ctx.run`：`returns` → 数据集、工件与失败诊断（FW3）

进程步（`cli` / `ssh` / `stdio`，声明形式 `adapter` 缺省 `cli`）的完成真值仍是进程观察
（exit/stdout/stderr/产物）。FW3 起，**flow 脚本路径与声明式旅程共用同一份运行级数据集**，
所以 `ctx.run` 的 `returns` 真的能被后续命令步消费：

```js
// ① 产出：声明式抽取（stdout / exit_code / stdout_regex / stderr_regex），只在信号成立后执行。
const produced = await ctx.run({
  id: "produce-name",                     // 可选：稳定步标识；缺省用 desc
  desc: "produce NAME",
  stdio: {
    argv: ["/bin/sh", "-c", "printf 'NAME=from-tool\\n'"],
    script: [{ when: "NAME=", send: "" }],
  },
  done: { exit_ok: true },                // flow 面的完成信号键是 done（journey 面叫 signal）
  returns: { NAME: { from: "stdout_regex", pattern: "NAME=(\\S+)" } },
});
if (!produced.ok) ctx.fail(produced.stopCode ?? "tool_failed", produced.reason);
// produced.output = { code, stdout, stderr, truncated? }（stdout/stderr 各截断到 8KB）
// produced.artifact = "tool-steps/01-produce-NAME.json"（相对 <outDir>；已按 secretSlots 掩码）

// ② 消费：命令步的值绑定直接读数据集（唯一来源仍是声明面，模型不参与选值）。
const filled = await ctx.step("用数据集的值填 input", {
  act: [ctx.command("fill", "#name", { from: "dataset", key: "NAME" })],
  done: ctx.judge.value("#name", "from-tool"),
});
```

- **声明形式的顶层键是闭集**（T7）：`adapter`/`source`/`args`/`dryRunArgs`/`desc`/`id`/
  `idempotent`/`retries`/`returns`/`done`/`stdio`/`ssh`（`signal` 只为给出 journey 词改法；
  `dangerous` 由 ssh/stdio 适配器校验）。未知键 = 结构化 `config_error`，reason 同时列
  unknown 与 known，dry/`apps check` 与运行期同一份文案（`declaredRunProblems`）——写了没用
  的键不再静默忽略。没有 `cli: {...}` 块：cli 形式就是 `source`+`args`+`dryRunArgs`。
- **`returns` 只认既有 `ReturnExtractor`**（`stdout` / `exit_code` / `stdout_regex` /
  `stderr_regex`）；坏声明 = 结构化 `config_error`，抽取不到 = 该名字**不写入**（如实缺席，
  下游得到 `needs_value`，不猜）。
- **`writtenBy = <id|desc>#<attempts>`**（如 `produce-name#1`），与声明式路径同一形状；
  只在 `ok === true` 时写。`result.dataset_view` 是审计视图（key/value/writtenBy/generation/stale）。
- **工件**：每个工具步在 `<outDir>/tool-steps/<序号>-<safe-desc>.json` 落一份
  `{desc, source, adapter?, args/argv, code, ok, stop_code?, attempts, elapsed_ms, stdout, stderr, truncated?}`；
  文件名 slug 只允许 `[A-Za-z0-9._-]`（desc 是自由文本，防路径注入），写盘前用与
  result/trace/report 同一个 `scrubSecrets` 掩码（`meta.secretSlots` 的值 → `***`）。
  写盘失败不改变工具步结论（只是 `artifact` 键缺席）。
- **result 投影**：`tool_steps`（脚本路径也非空）至少含 `desc/source/ok/code/attempts/
  elapsed_ms/artifact`，失败时带 `stderr_tail`；`sources` 记录本次 `ctx.source()` 的名字与行数
  （`counts`/`selects`）；没有工具步/数据腿时这两个键的形状与旧产物一致（`[]`；`dataset_view` 缺席）。
- **失败诊断**：`StepResult.reason` 是 `<stop_code>: exit <code> — <stderr 尾行>`（无退出码时省略
  exit 段），trace 事件的 `result` 带 `code / stderr_tail / artifact`——不再是空壳。脚本仍可用
  `r.ok` 分支处理失败；直接结束就用 `ctx.fail(r.stopCode ?? "tool_failed", r.reason)`。

### 4.9 新标签页：先 `ctx.tabs()` 再 `ctx.switchTab(...)`（A5）

`window.open()` / `target="_blank"` 打开的**新标签页不会自动跟随**：动作完成后引擎仍停在原页
（`ctx.url()` 还是旧页），后续 `ctx.step` 也还在旧页上。要操作新页，必须用两个显式原语：

```js
const r = await ctx.step("打开帮助中心", { done: ctx.judge.exists("#opened") });   // window.open 类动作
const tabs = await ctx.tabs();            // 免费只读：枚举 context 里未关闭的页面（含当前页）
// tabs = [{ index, url, title, active }, ...]（index 0-based 枚举序；active = 引擎当前页）
const sw = await ctx.switchTab({ urlContains: "help" });  // 恰好一个匹配；计 1 个 flow step
// sw = { ok: true, index, url, title } —— 之后 ctx.step / ctx.done 都落在新页上
```

- **`ctx.tabs()` 免费**（与 read/extract 同属只读观察，不计 flow step、不触发 pace）。只读枚举
  `page.context().pages()` 里 `isClosed() !== true` 的页面；列表**可以包含 `meta.hosts` 信封外的
  页面**（只读观察不受限），但切过去会被拒绝。
- **`ctx.switchTab(match)`**：`index`（0-based 整数）/ `urlContains` / `titleContains`（大小写不
  敏感子串），多个条件同时给按 AND 收窄。**必须恰好匹配 1 个**：0 个或 >1 个都是结构化
  `config_error`，reason 列出当前所有 tabs（index/url/title/active）——引擎**绝不**回退“随便挑
  一个”；先 `ctx.tabs()` 收窄条件再切。目标 URL 不在 `meta.hosts` 信封内 = 结构化
  `host_not_allowed`，**不会切换**（与 open/openPage 同一个 host 判定）。
- **switchTab 切换的是「读面 + 动作面」两个面（2026-11-08 夹具实证，双标签 A/B）**：切过去之后
  `ctx.url()` 返回新页 URL、`ctx.read/judge` 读新页 DOM，**下一步 `ctx.step` 的动作也在新页上执行**
  （此前 R10 记录的「动作面仍在原页」不复现，判误诊——其 done/URL 判据可能锚在原页）。因此：
  步骤 done 若用 `judge.url(...)` 注意它判的是**当前页**；跨标签流程建议用 `newTab` opts（见下，
  F2：引擎自动跟随 + 去重），或 `switchTab` 后用**当前页锚点**（`ctx.judge.exists(...)` 等）写 done。
- 成功后 `session.page` 改为目标页、`ctx.url()` 更新；`bringToFront()` 失败不致命，
  `waitForLoadState("domcontentloaded")` 有界等待（≤5s，超时/失败忽略）。切换**计 1 个 flow
  step** 且走 `paceBeforeStep`（与 step/arrive 同单元语义）；预算用满是 `budget_exceeded`。
- 证据：`tabs` 与 `switchTab` 各落一条 `call:"tab"` 的 trace 事件——
  `{action:"list", pages:[{index,url,title,active}…]}` 与
  `{action:"switch", from:{url}, to:{index,url,title}, pages:n}`；`--trace` 与 `step_traces`
  （switch 行计 1 步）可对账。
- **dry / `apps check`**：dry 面只有一个**合成标签页** `{index:0,url:"(dry)",title:"(dry)",active:true}`
  且不访问浏览器；按 dry 纪律**只验声明形状**（未知键 / 空 match / 非法值仍结构化 `config_error`），
  `switchTab` 对合法声明**恒返回合成成功**（`{ok:true,index:0,url:"(dry)",title:"(dry)"}`）——match 是否
  命中真实标签是观察事实，dry 不据此判红（与 `step` 恒 ok、done 信号不评估同一条纪律），因此**不需要**
  `if (ctx.runtime.dry)` 守卫（dry/replay 恒 true；旧写法 `runId !== "(dry)"` 仍可用，但那只是 CLI 惯例值不是契约）；只有依赖真实标签列表的**数据驱动断言/分支**才需要 dry 守卫
  （与数据驱动断言同一纪律）。
- **F2 `newTab` opts：`_blank` 新标签的一等完成面**（取代"故意失败 → ctx.tabs → switchTab"绕法）。
  `target="_blank"` 链接点击后**主页 URL 不变**，URL 型 done 永不成立 → 引擎在原页重试，实测连点
  开 2–4 个重复标签（R05–R08/R11）。给这一步声明 `newTab: { urlContains: "p2" }` 后引擎接管：

  ```js
  // 新标签上的 done 在本步内直接判定；读面+动作面自动跟到新标签（后续 step 落在新页）。
  const r = await ctx.step("打开详情", {
    act: ctx.hint("#opener"),                      // 建议显式 act hint：单条 hint 收敛为恰好一次点击
    done: ctx.judge.existsText("#p2out", "clicked"),
    newTab: { urlContains: "p2" },
  });
  // r.newTab = { index, url, title, adopted: "opened" | "existing" }
  ```

  语义：① **去重**——动作前已存在 URL 含 `urlContains`（大小写不敏感）的标签（此前尝试开的）→
  直接采用它、**不再点击**（`adopted:"existing"`；done 在该标签上判定，不再开新标签）；② 动作后
  出现**新标签** → 自动切 `session.page`（读面+动作面）到它（优先 URL 命中者；`adopted:"opened"`），
  done 在新标签上判定；③ 单条 `act: ctx.hint(...)` 收敛为**恰好一次点击**（单命令闭集：点完即判
  done，不重试连点）；④ 未声明 `newTab` 的步骤逐字节不变；声明了但**没有新标签出现** → 正常 done
  判定（如实失败）。新标签在 `meta.hosts` 信封外仍按既有 popup 门禁拒绝（`popup_not_allowed`）。
  dry/`apps check` 只验声明形状（对象/`urlContains` 非空串）并记 `new_tab: true`——**dry 无浏览器，
  标签行为（新标签出现/采用/去重）只能在真实运行验证**。
- **未做**：无 `newTab` 声明时的自动跟随（auto-follow）不在本版范围内（有 `newTab` 声明的步按上
  述语义自动跟随）；popup 闸门语义不变（外域新页仍按 `popup_not_allowed` 拦截）。

**frame 门禁（P0-D，精确化）**。声明 `meta.hosts` 之外的子 frame（广告像素 / 统计 / 第三方
widget）**默认只排除出解析面**，不再是整步 REJECT：池抽取、`hintLookup`、FW8 身份回捞、DRF、
`locatorAnyFrame`、done/when 求值都只在**允许帧**（frame origin 在 `hosts` 内；主 frame 恒允许）
上进行；被排除 frame 记一条 step warning `frames_excluded: [origin…]`（含"已排除、不影响页面
其余操作"）。被排除帧里的元素不进池、不会被动作，但池中其余元素的真实 `frame` 下标与 `f<fi>:`
ref 不变（只排除解析面，不重编号）。**只有声明面命中被排除 frame 才拒绝**：①声明 target
（`ctx.hint(...)` / 命令 `target`）在池 → ADMIT → FW8 → DRF 全落空后，引擎**只读探测**（不盖章、
不动作）该目标是否只存在于被排除 frame——是则结构化 `frame_not_allowed`，reason 点名 frame
origin + 目标 + 只读匹配证据 + 修法：第三方非交互 frame 默认排除，**不需要**为此加 hosts；
**仅当声明目标确需该 frame 时才评估把它的 origin 加进 `meta.hosts`**；②声明 done/when 在允许帧
上不成立、只读地在被排除帧上再判一次——只在那里成立 = `frame_not_allowed`（done 依赖被排除
frame），允许帧已成立 = 正常成功。其余情况步骤照常，只在 warnings 里留记；无被排除帧时零新
字段/零新行为（逐字节）。导航信封（goto 起点/落地）与 popup 门禁不变。

### 4.10 导航纪律：`meta.policy.navigation`（entry-only）

背景（评估实测）：agent 会用"直接构造 URL 跳转/拼参数直达结果页"绕过页面操作——这类行为
**适得其反**（触发携程 whaleguard 风控、拿到拦截页）。默认经声明纪律约束即可；需要引擎
**强制**时声明：

```js
export const meta = (kit) => ({
  // ...
  policy: { navigation: "entry-only" },
});
```

语义（**只在 flow 脚本面生效**；plan/journey 面的 subgoal `start_url` 不受此 policy 约束）：

- **放行**：本次运行的**第一次**直接导航（= 入口；仍走 hosts 信封检查）；之后的直接导航
  目标与当前页 **origin+path+query 全等**（忽略 hash）——同 URL 重试语义保留。
- **声明页放行（P0-B）**：再次直接导航到 `meta.site.pages` 里**声明过**的页面 URL 也放行——
  例如 `ctx.openPage("home")` 回到入口页（多阶段任务「机票 → 回首页 → 酒店」因此可执行）。
  比较口径：两边 URL 各经 `new URL(...).href` 归一后**全等**（含 query；不做尾斜杠/case/
  协议升级等特判）。**未声明**的 URL 仍 `navigation_forbidden`；同 URL 重试照旧放行。
  dry/`apps check` 与真实面同一口径。
- **拒绝**：其余（既非同 URL 重试、也非声明页）引擎发起的直接导航（`ctx.open` / `ctx.openPage` / `ctx.arrive` / step 级
  `url` 重锚）→ 结构化停因 **`navigation_forbidden`**，reason 同时给当前 URL 与试图跳转的
  URL 与指引；`result.diagnostics.navigation = {policy:"entry-only", attempted, current}`
  留证据，trace 也落一条 `ok:false` 事件。
- **永不拦截**：页面驱动的导航——点击链接/按钮导致的跳转、锚点 hash 变化、新标签页/tab
  切换都是浏览器行为，不是引擎直接导航。`ctx.command`/`read`/`extract`/`done` 不受影响。
- 缺省/`"free"` = 现行为逐字节不变；未知值在加载期 `config_error`（`apps check` 即红）；
  dry/`apps check` 与真实面同一闸门。声明了才进 `effective_policy.navigation`。

### 4.11 声明目标解析链：`meta.policy.target_resolution`（DRF）

自绘控件（无 role/onclick/id，甚至不在准入选择器 ADMIT_SEL 里）让**作者声明的目标**解析不到：
池 hintMatch → ADMIT 回捞 → FW8 身份回捞全落空，命令步 `target_not_found`、act hint 在
`widen` 档回退模型自由选。声明式逃生口（**opt-in，缺省逐字节不变**）：

```js
export const meta = (kit) => ({
  // ...
  policy: { target_resolution: "declared" },
});
```

只服务**声明目标**（命令 `target` / act hint = `ctx.hint(...)`），决策步与模型选出的元素
永不走这条链。解析顺序（前者命中即停）：

1. 池 `hintMatch`
2. ADMIT 回捞（`hintLookup`）
3. FW8 身份回捞（`#id` / `[data-test]` / `[name]`）
4. **DRF**：两种模式，同一「恰好一个可见匹配」纪律
   - **attr 模式**（`#id` / `tag[attr=value]` / `tag[attr~substr]` / `tag~token` / 角色词）：
     在 ADMIT_SEL 投影上做 DOM 收集（不扩 surface 类目、不改投影），再套同一套
     `hintMatch` 语义；
   - **text 模式**（裸词）：收集归一化（大小写不敏感、折叠空白）后 `innerText` **全等于**
     token 的元素，优先最深的匹配元素；到父容器这一档仍以动作前 hit-test 兜底。
5. 仍落空：命令步 `target_not_found`；act hint 按 `act_hint` 档位（`widen` 回退模型 /
   `strict` 直接 `target_not_found`）。

纪律与证据：

- **恰好一个可见匹配**：跨 frame（≤6）统计；**>1 可见 → `target_ambiguous`**（reason /
  `skipped_actions` 列出候选 tag/文本/frame/visible，绝不点）；**全部隐藏 → 视为未命中**
  （只留 hidden 计数警告，绝不操作隐藏元素）。
- **click 前 hit-test**：click 族动作前 `elementFromPoint(中心点)`，命中元素必须是目标自身
  或其后代。否则**不点击**：`skipped_actions` 记 `hit_test:covered` / `hit_test:ancestor`，
  result 的 `declared_resolve.hit_test` 带现场（blocker），done 不成立。
- **首版能力面**：只允许 `click` / `scroll` / `hover`；对 DRF 目标声明 `fill`/`select`/
  `drag`/`upload`/`clickAt` → 结构化 `action_unsupported`（reason 明说首版限制）。
- **证据**：trace 行 `resolved_by:"declared_dom"` + `declared_resolve:{mode:"attr"|"text",
  target, matches, hidden_matches, total_matches, frame, hit_test?}`；`executed_actions` 的
  `ref` 用合成标识 `drf:N`（不伪装池 ref）并带 `resolved_by`/`declared_resolve`；命中行临时
  盖 `data-hintref`，动作尝试一结束即清理（与 FW8/A3 同纪律）。
- **模型面零污染**：DRF 命中直接给出 ref，不构造 `ChoiceRequest`；回捞元素即使留在局部池，
  进 provider 前也剥离 `declared` 旁路标记。
- **dry / replay**：只校验 policy 值；DOM 事实无法离线验证，**不新增绿**（语义上
  `resolution:"unverified(dry)"`，结果里不造字段）。未知值加载期 `config_error`。

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
- dry 模式下 `extract` 返回 `[]`、`read.attr` 返回 `null`、`waitFor` 立即返回 `true`（没有页面）——脚本在 dry 期不要依赖观察值；**一切基于观察值的 `ctx.fail`/分支/断言都必须用 `ctx.runtime.dry` 守卫**（dry/replay 恒 `true`、真跑恒 `false`；`epoch===0` 不作判据——见 §2 消歧义）：`apps check` 与 `--dry-run` 会真跑 flow，没有守卫的数据驱动停会把合法脚本判成 problems（03-D1 配方；需要严格断言数据时，只在真实运行里停）。**dry 模拟面全表**（06-B，`createDryCtx` 实证）：`step`/`arrive`/`run`/`manual` 恒返回 `ok:true` 且 **`when` 不评估**（stopCode 恒空 ⇒ `precondition_skipped`/末页 exhausted 这类分支在 dry 结构性不可预演）；`read.*` 返 null/0；`collect` 返 `{rows:[], coverage:{rounds:0,rowsSeen:0,addedLastRound:0}, stopReason:"dry"}`；`url()` 是最近声明值；步预算照常计数。**吞错有留痕**（S3）：dry 的 `validateXxxRequest`（scrollList/expand/setRange/collect）抛错前先落 `validation_error` 事件——脚本 `try/catch` 吞掉 `config_error`，`apps check` 仍判 FAIL 并输出「脚本吞掉了配置错误：<call> <message>」；源码调用点与 dry 事件数的差额只打警告。结论：**dry 验调用序列与声明形状，不验分支覆盖**——check VALID ≠ 脚本每条分支都被走过，守卫分支的正确性只有真实运行能证明。**循环特别警告**（09-B，r09-retry-demo 实录）：`step` 模拟恒 `ok:true` ⇒ 以"步骤成功"为 break 条件的 `while/for` 会在 dry **假成功早退**，随后未守卫的终局 `ctx.fail` 把 dry 判红（报错自曝 `ok:true` yet exhausted 的矛盾即此坑）——dry 预演只到声明面为止，循环语义一律真实运行验；各分支的**声明校验**可用 `run --dry --slot <k>=<v>` 逐分支触达（08 实证，不占真实额度）。
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
  live 直接判；learn 归纳面捕获了每个节点的 `visible`（`checkVisibility` CSS + 非零盒，与 extraction 同口径）
  后可按首匹配离线判定——**缺该字段的旧视图一律不可判定（null，不采纳），绝不当作成立**。
  旧写法 `exists(sel)` 语义不变（`css_exists`）。
- **录制/归纳（learn）观测面（U2a）**：每个动作前后各抓一份 StateView，witness 节点带 `visible` 与可选
  `disabled`；隐藏节点照抓（它两态都存在、只翻转 `display` 的面板/弹层正是“出现/收起”的证据）。候选按
  证据强度排序：`url_contains > css_value_equals > css_visible_exists / not(css_visible_exists) >
  css_text_equals > all_of > css_text_contains > css_exists > not(css_exists)`。`type`/`fill` 之后
  **输入值优先**——`#name` 的值才是动作写下的证据，label 往往只是字段名（aria-label/初始文本在动作前后
  不变）；值必须非空、非波动量，password/file/hidden 在捕获期已按长度掩码（掩码值不会生成值信号）。
  **存在性变化**仍走 `css_exists`/`gone`；只有“两态都存在、可见性翻转”才走 `css_visible_exists` /
  `not(...)`。录下来的字面值回放进生成应用见 §6.1（U2b 值管道）。
- 组合器是**变参**不是数组：`ctx.judge.all(ctx.judge.url("a"), ctx.judge.text("h1","x"))` ✔；
  `all([a, b])` 加载期 INVALID（2026-11-01 实测：初次使用者首个就在这里被 apps check 拦下，
  报错定位准确、一次修正）。
- 进程：`ctx.tool.exitOk()`、`exitCode(n)`、`stdoutContains`、`stdoutMatches`、`stderrContains`、`jsonPath`、`fileExists`、`fileAbsent`；
- `jsonPath` 支持 **RFC 9535 子集**：点路径 + 方括号下标，`$` 前缀可选（`$.a.b` ≡ `a.b`、`$[0]` ≡ `[0]`、`$` = 根）。不新增表达式语法（无递归下降/过滤/通配）；旧的无 `$` 路径行为逐字节不变。载荷在 dry/`apps check` 期校验：path/want 必须是非空字符串，`exitCode` 必须是整数、`stdoutMatches` 必须是可编译正则、`fileExists/fileAbsent` 必须是非空路径——坏载荷 = 结构化 `config_error`，不留到运行期静默 false。
- 工具信号不成立时，工具步的 `reason`/trace/报告带**结构化诊断**：`json_path_equals` 给出 path（含归一结果）、实际类型（object/array/string/number/boolean/null/undefined）与 ≤120 字符值摘要；退出码/stdout/stderr 类叶子给期望与实测。大对象只截摘要，敏感值沿用产物面既有 `scrubSecrets` 掩码。
- 组合器可嵌套。**不要用“看起来完成了”代替证据**：`ctx.step` 返回的 `ok` 就是 done 信号是否成立。
- **弱 done（P0-E）**：`done`/`when` 顶层是否定式（`not(...)`）且否定之外**没有正向锚**（`exists`/`url`/`text` 等事实型谓词；`not(...)` 内部的事实不算锚）→ `apps check`/dry 打一行 `weak_done` warning（仍 VALID、exit 0）。否定式 done 会被**无关导航蹭成立**（R11 实录：`not(existsText(body,"8240家昆明酒店"))` 误入 passport 登录页照样成立）。修法：`all_of(judge.not(...), 正向锚)`，或配 `ctx.judge.loginWall()` 做检测底座。
- **`ctx.judge.value(sel, v)` 的 React 警示（消歧义）**：`css_value_equals` 读的是 `inputValue()`——**React 受控输入**上它的 readback 不可靠（组件状态由 React 管理，DOM value 不回写/回写时机不定，done 可能永不成立）。受控输入的完成事实改用 `judge.text` / `judge.exists(..., {visible:true})` / JS 可见事实（如面板出现、列表更新）；`value` 只用于**原生不受控**的 input（§6.1 的录制值回放是原生 input 场景）。
- **`ctx.judge.loginWall()` 预设（P0-E）**：登录墙事实信号（`any_of`：URL 登录特征 `/login`|`/signin`|`/passport`|`/sso/`|`/auth`|`/verify`… 词边界不误报 `author`/`verified`，或 title/h1/h2 登录文案）。**诚实检测用**：给否定式 done 配正向锚、做步级 guard 的事实底座——不是绕过登录的工具。签名 `loginWall(): DomSignal`（无参）；与否定式 done 组合的可直接抄写法：
  ```js
  done: ctx.judge.all(not(ctx.judge.loginWall()), ctx.judge.exists("#orders", { visible: true }))
  // all/any 是变参不收数组；not 单参；<正向锚> 必须是动作后才成立的事实
  ```
  步级 `false_done` guard（`meta.policy.done_guard`，缺省 `"warn"`）的 warning 会原样给这个构造器（eval3 曝光面）。
- **可用的 done = 「动作前不成立、动作后成立」**（判据，05/06 轮案例实证）：动作前已成立的信号（如任何页都真的 `exists("h1")`）在验证面**零贡献**——这一步的绿完全外包给 goal 语义与模型恰好点对，落点再意外也判绿（r06 `wide-done-sample` 实录）。守卫/到达/翻页步尤其警惕；用位置类选择器（`nth-child`/`nth-of-type`）前先实证**动作前命中数为 0**——站点数据可能自带"第 11 条"（r05 实证 `div.quote:nth-of-type(11)` 未滚动已真）。翻页类 done 优先用 URL 参数片段或**下一页独有内容锚**，别用两页共有的 h1/容器。


结束态不变量写在 `meta.invariants`，由 `ctx.done()` 在**同一页面**上验收：

- 声明了不变量却从未调用 `ctx.done()` → 运行判 `missing_done`（验收没发生，不能报绿）；
- `ctx.done()` 时不变量不成立 → `invariant_failed`；
- 中间要求写进每一步的 `done`；不变量看不到中间状态；
- 纯工具应用不要写 web 不变量（没有浏览器结束态可验）。

### 6.1 录制值管道：演示值 → `meta.slots` + 值绑定（U2b）

`record` / `learn` 录到 `type` 动作时，值不再"录完就丢"，而是写成**声明绑定**：

- 槽位键取自控件身份（`name` > `id` > `data-test` > `label`，ASCII 归一化）；
  同名重复且值不同才加 `_2` 后缀。
- 非敏感值：journey 步带 `value_binding: {from:"slot", key}`，`meta.slots[key]` 的默认值就是演示值；
  生成的 `flow` 用 `ctx.command("fill", hint, ctx.value.slot("key"))`（不是硬编码字面值）。
  `value_binding` **只认 slot**：option/list/dataset 请直接写 `commands`，`literal` 显式拒绝
  （命令/计划面的绑定来源没有 literal；不新增该语义）。
- 信号里的演示值被参数化成 `{key}`（pack 展开期替换），生成 `flow` 时写成运行期表达式
  `ctx.slots["key"]`——例如 `css_text_equals ["#result","hello:Alice"]` 生成
  `ctx.judge.equals("#result", "hello:" + ctx.slots["name"])`；`type` 的值信号生成
  `ctx.judge.value("#name", ctx.slots["name"])` 的等价构造。所以 `--slot name=Bob` 回放时
  动作与完成判据一起按 Bob 判定，不是拿演示值蒙混。
- `meta.invariants` **不做槽位替换**（`ctx.done` 直接拿声明值判）：依赖演示值的结束态断言
  生成时**省略**并在 `notes` 点名（每步的动态 done 仍是判据）；不要手写 `{name}` 指望它生效。

**`--slot` / `--slot-file`（record/learn 与 run 同格式）**：

```bash
amber record http://127.0.0.1:8104/form.html --script actions.json --name form --slot name=Bob --yes
amber record https://site/login --script login.json --name login --slot-file ./slots.json --yes
```

- 命中某个 `type` 动作的键 ⇒ 用它回放演示，并成为生成应用的 `meta.slots` 默认值；
- 未命中任何 `type` 动作的键 ⇒ 用法错误（写了没用，不静默忽略）；
- 敏感字段（`password` / `file` / `hidden`，或录制器标记）**值绝不复用 `--script` 明文**：
  只认 `--slot`/`--slot-file`；没有值 = 录制回放门如实失败并提示 `--slot-file`；
- learn 自己的 pack 回放与生成脚本回放都按同一个槽位袋运行。

**敏感纪律（安全级）**：`meta.secretSlots` 声明的槽位在生成物里**恒空串占位**（codegen 强制），
值不进入 `app.mjs` / `notes` / `recordedFrom` / 信号 / 诊断文本（信号里只以 `{key}` 出现，
人读文本 `***`）。空串对 `fill` 是合法的"清空"，所以生成的 `flow` 带显式守卫：

```js
if (!ctx.slots["pw"]) {
  ctx.fail("needs_value", 'secret slot "pw" has no value — pass --slot-file <json> (or --slot pw=…)');
}
```

运行时有值（`--slot-file slots.json`）才执行；没有 = 结构化 `needs_value`，绝不拿空串填进去。
`apps check` 是 dry 执行 flow、会走到这条守卫，所以检查 secret 应用时给一个占位值即可
（`apps check <id> --slot pw=dummy`）。注意：**值派生的页面输出**（如显示 `pw-len:9`）不会被
参数化——换一个长度不同的秘密值时，那条 done/不变量会如实不成立；这不是值管道能猜的，
需要手写该步判据。

无值的流程（纯导航、可见性面板）生成物与 U2b 之前**逐字节一致**——值管道只在有 `type` 演示值时启用。

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
| `done_guard` | `warn` | **P0-E**：done 成立后**只读**复核 guard（`false_done`）的处置。`warn` = 命中假绿特征只记 step warning（步骤仍 ok）；`fail` = 结构化停因 `false_done`（reason 含证据）。触发面：主 frame URL 词边界命中登录特征 / title 或 h1-h3 登录文案（短页正文剥掉链接文案后才计，页脚登录入口不误报）/ 跨出 `meta.hosts` 信封 / 「有动作但 changed=false 且 done 是否定式」。guard 是 tripwire 不是完成判定——完成仍只认 done 信号；正常登录类应用（会落在 `/passport` 这类 URL）建议保持缺省 `warn` |
| `effect_readback` | `{fill:true,set_range:true}` | fill/setRange 的 effect 读回 |
| `settle` | `{quiet_ms:400,timeout_ms:5000}` | 抽池前的稳定门（S2）：只在页面有 DOM 突变时等到静默；`"off"` 关闭。等待进 `state.settleMs` |
| `pool_gate` | `fact` | U3 池空判档（仅 flow 面）：`fact` = 已就绪且池空记 `pool_empty` 后继续；`strict` = 旧 `page_not_ready` 快败 |
| `surface` | `{native_activation:"window"}` | U3 准入面类目：`summary` 进池并受类目 cap=6；`native_activation:"off"` = 池构成回到 U3 之前（A/B） |
| `decision_state` | `{gate:"off",context:"off"}` | S5 决策状态接入（A/B）：`gate:"stable_only"` = ask 前 settle + 同池同题不重复问（`decisions.asks_saved/gate_waits`）；`context:"delta"` = 请求带 ≤200B 结构化 `state_digest`（provider 不支持则跳过，记 `context_skipped`） |
| `navigation` | `free` | 导航纪律（仅 flow 面）：`"entry-only"` = 入口之外的引擎直接 URL 导航默认被 `navigation_forbidden` 拒绝，但 **`meta.site.pages` 里声明的页面 URL 可再次直接导航**（`URL.href` 归一后全等才放行，见 §4.10）；缺省/"`free`" = 不约束，产物逐字节不变 |
| `act_hint` | `widen` | 声明目标（`act: ctx.hint(...)` / `target_hints`）解析链（池 hintMatch → ADMIT 回捞 → FW8 身份回捞）全落空时的档位：`widen` = 交给模型自由选（**缺省 = 现行为逐字节不变**）；`strict` = **禁止模型回退**，直接结构化 `target_not_found`（reason 写明 `act_hint="strict"` + 原 hint + 池快照）。命令步不受影响；FW8 的 `#id`/`[data-test]`/`[name]` 声明回捞先执行。显式声明才进 `effective_policy.act_hint` |
| `target_resolution` | `off` | **声明目标解析链（DRF，P0-C）**：`off` = 现行为逐字节不变；`declared` = 命令 `target` / act hint 在池 hintMatch → ADMIT 回捞 → FW8 身份回捞全部落空后，再由 DOM 侧兜底解析（属性型 hint 走 ADMIT_SEL + 同一套 hint 语义；裸词 hint 走可见文本精确匹配；跨 frame **恰好一个可见**才动作，>1 → `target_ambiguous`，全隐藏 = 未命中 + hidden 诊断）。click 族动作前必须 hit-test（中心被覆盖则不点击、记 `hit_test` 证据）。首版只允许 `click`/`scroll`/`hover`，对 DRF 目标声明 `fill`/`select`/`drag`/`upload`/`clickAt` → 结构化 `action_unsupported`。回捞元素只进本步局部池，**模型不参与**。显式声明才进 `effective_policy.target_resolution`；dry 只校验 policy 值（DOM 事实无法离线验证，不新增绿，见 §4.11） |

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
- report.md 执行轨迹表的 URL 列口径是**步起**（`state.before.url`，该步开始时刻的页面 URL，步内导航/动作之前的页面）；没有步起记录的行（`ctx.arrive` 不走执行器观察、或旧产物无 `state`）显示步后落地 URL（`step_traces[i].url`）并在单元格内标「（落地）」——两种口径不同格，读表别混。
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
| `target_not_found` | 目标声明在页面上不存在；改 hint 或换目标。`meta.policy.act_hint:"strict"` 下 act hint 解析链全落空也用它（reason 显式写 `act_hint="strict"`，**不再回退模型自由选**；缺省 `widen` 才回退）。声明目标（act hint/命令）在池+ADMIT+FW8 全落空且**未声明** `target_resolution` 时，reason 追加一行 DRF 提示（自绘控件可声明 `meta.policy.target_resolution:"declared"` 走 attr/文本精确匹配）；**已声明** `"declared"` 的同场景走 DRF、不再提示（避免噪音） |
| `target_ambiguous` | 目标命中多个不同候选；收窄 hint。`target_resolution:"declared"` 下 DRF 的两个可见文本/属性匹配同样报它（候选 tag/文本/frame/visible 在 reason 与 `skipped_actions`） |
| `action_unsupported` | 目标存在但声明的动作 op 不在元素能力面内；换动作或换目标。DRF 首版只允许 `click`/`scroll`/`hover`——对 DRF 目标声明 `fill`/`select`/`drag`/`upload`/`clickAt` 也报它（reason 明说首版限制） |
| `done_not_held` | 命令闭集已走完，但 done 信号仍未成立；检查完成信号或页面状态 |
| `false_done` | **P0-E**（`done_guard:"fail"` 档）：done 成立但只读复核 guard 命中假绿特征——登录墙特征（URL/标题登录文案/跨出 hosts 信封）或「有动作但 changed=false 且 done 是否定式」的零前进蹭成立（R11：误点进登录页被算成功）。给 done 配正向锚（`all_of(not(...), 正向锚)`，必要时配 `ctx.judge.loginWall()`）；确属误报把 policy 改回 `warn`。缺省 `warn` 档只记 `false_done:` step warning，不改判定 |
| `step_timeout` | **F3**：该步显式声明了 `timeoutMs`，整步挂钟（含 reobserve/升级循环的每轮与总时长）超了声明值——循环不再进入下一轮（已在途的决策调用不可抢占，超额 ≤ 一次在途调用）。放宽 `timeoutMs`、收窄该步 done/target，或拆分流程；未声明 `timeoutMs` 的步骤没有这个帽 |
| `frame_not_allowed` | **仅当声明 target 或 done/when 只存在于 `meta.hosts` 之外的 frame**：第三方非交互 frame 默认排除（`frames_excluded` warning），**不需要**为此加 hosts；只有声明目标/完成信号确需该 frame 时才评估把它的 origin 加进 `meta.hosts`，否则把目标/done 改到允许 frame 内的事实。导航信封外的 goto 仍报 `host_not_allowed` |
| `popup_not_allowed` | action 打开的新 tab / popup 不在 `meta.hosts` 内；声明 popup host 或避免打开外域 |
| `navigation_forbidden` | `meta.policy.navigation:"entry-only"` 下入口之外的引擎直接 URL 导航被闸门拒绝；导航须经由页面元素完成（确需直达就移除该 policy）。见 §4.10 |
| `manual_signal_not_held` / `manual_declined` / `needs_human` | 人工步：DOM 信号没验过 / 人放弃 / 非 TTY 需要人 |
| `dangerous` / `declined` / `dry-run-failed` / `tool-unavailable` / `needs_value` | 工具步的显式拒绝类别（`REFUSAL_LABELS` 有一句话解释 + 怎么补救） |
| `trace_mismatch` | 重放时脚本与轨迹的调用序列/版本/输入不一致——重新跑，不要重放 |
| 其它（如 `low_confidence`、`max_steps`、`blocked`） | 执行器结构化停因，原样透出 |

**停因自带能力提示（eval3 曝光面改造；仅追加一行 reason、成功路径零改动）**——对应能力已经存在，停因当场点名修法，不用再去翻文档：

- `target_not_found`（声明目标池+ADMIT+FW8 全落空且未声明 `target_resolution`）→ 提示声明 `meta.policy.target_resolution:"declared"`（DRF：attr/文本精确匹配+唯一可见+hit-test）；
- `no_progress`（本步动作没改当前页 URL 但 **context 标签数增加了**）→ 提示用 step opts `newTab:{urlContains}` 自动采用并去重（消 `_blank` 重复点击）；
- `false_done` 警告（warn/fail 两档同文案）→ 给出可直接抄的构造器 `done: ctx.judge.all(not(ctx.judge.loginWall()), <正向锚>)`；
- `step_timeout` reason → 点明 `timeoutMs` 是**整步挂钟帽**（settle/reobserve/升级/动作共享），不是逐动作超时；
- `pool_empty` 警告与 `low_confidence` 停因 → 提示用 `ctx.observe()` 在会话内看准入面与 `why_not_admitted`。

**停手规则**（层 3 出口；唯一出处 `src/engine/planning-playbook.ts`，失败即随 `next` 输出）：同一停因按 next 修正后重跑仍出现 2 次以上 → 停手：如实上报 stopCode / reason / 已试过的修正，等待人或上游决策；不要再自行迭代脚本或重试。

排查顺序：`apps check`（声明）→ `inspect`（页面）→ `apps explain`（序列）→ `run --dry-run`（预演）→
`run --max-steps N --trace`（有预算的真跑）→ 看 trace 里第一次 `ok:false` 的 `stop_code/reason`。

**限速判读（B3 `throttle_suspect`）**：步骤信号不成立且观测到**会话级骤降**时，该步 warning 通道出现
`throttle_suspect:` 一行，`step_traces[].result.diagnostics.throttle_suspect.evidence` 带判读证据
（`pool_size` vs `pool_size_session_high`、`body_text` vs `body_text_prev`、`admitted`、`ready_state`、
`session_elapsed_ms`、失败现场的 `declared_hidden`）。触发是**保守组合判据**——本会话池高峰 ≥20 且当前池
≤ 高峰/4（probe3 实测现场：单会话观察调用 202→15、8 秒跑完全程、筛选芯片 declared_hidden），或两次失败
嗅探之间正文塌缩（前值 ≥2000 且当前 ≤ 前值/4）——正常小页面（本来元素就少）不会触发。**判读与处置**：
这是"疑似站点限速/降频/风控分批"的信号，不是完成判定（不新增 stopCode）；已知处置是**冷却后重试、降频
（拉大 `meta.pace`）、分批跑**，**不绕过**反爬（不伪造指纹、不轮换代理、不规避风控/速率限制）。字段缺失
= 该失败没有骤降特征，按常规停因排查。

## 11. 边界（当前版本明确不做）

- **脚本是进程内任意代码**：信任边界 = “用户作用域 + 不放仓库”；结果里带 `script_sha256`。沙箱未做。
- `ctx` 是**运行期面**：不要指望 `ctx.page` / locator / 模型分数——那是执行器内部。
- flow 应用没有静态 IR 可展开/导出；审计能力用 `--emit-trace` 的轨迹。
- `ctx.rows({row, fields})` 在 v1 关闭；行抽取走 `meta.site.listExtract` + `ctx.extract(name)`，或 inline `ctx.extract({ rows, fields, maxItems? })`。
- **新标签页不自动跟随**（未声明 `newTab` 时）：A5 只提供显式 `ctx.tabs()` / `ctx.switchTab(...)`；
  动作打开的新 tab 不会自动成为引擎当前页。**F2 起声明 `ctx.step(..., { newTab: { urlContains } })`
  的步由引擎自动跟随 + 去重**（见 §4.9）。

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
amber record <页面> [--name ID] [--goal G] [--apps-dir DIR] [--slot k=v] [--slot-file F] [--yes]
amber inspect --url <URL> [--json]
npm run test           # 真实站点测试（smoke + core）
npm run check           # typecheck + 配置示例一致性 + 线上用例离线校验
```