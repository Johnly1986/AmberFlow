# 方案提案：执行期 Agent 接管 · 元素层级语义

> **状态**：proposal（待项目方确认排期）
> **日期**：2026-11-11 ｜ **来源**：项目方提出两个问题——run 执行期遇问题时 Agent 能否接管继续走查；
> 会话中查询的页面元素为平铺结构、丢失 HTML 层级语义导致同标签控件误判。
> 阅读前提：`docs/AGENT_INTERFACE.md`（桥契约）、`docs/INTERACTIVE_SESSION.md`（session 面）、
> `AGENTS.md`（硬规则）。锚点一律用符号名（IMPROVEMENT_PLAN 行号漂移教训）。

## 0. 结论概览

| # | 问题 | 一句话诊断 | 方案 |
|---|---|---|---|
| 1 | 执行期遇问题，Agent 能否接管现场继续走查 | run 是一次性进程，失败现场随 `finally` 里的 `liveSession.close()` 即焚；走查工具（`inspect`/`session`）都新开浏览器，无法 attach 现场 | 三层递进：**T1** 失败现场证据落盘 → **T2** CLI 进程内接管（`--attach-on-failure`）→ **T3** 桥面跨进程接管（待 T1/T2 验证价值后立项） |
| 2 | 平铺元素丢层级语义，同标签按钮误判 | `Elem` 是无祖先信息的平铺投影，`near` 只是单个近邻词面；hint 6 形状闭集没有容器限定形状 | 两步走：**D1** 层级上下文进观察/证据面（零匹配语义变更）→ **D2** hint 容器限定形状（匹配面变更，挂 BACKLOG #2 契约定型之后） |

---

## 1. 问题一：执行期 Agent 接管（run 失败现场继续走查）

### 1.1 现状诊断

**规划期走查可用、执行期现场即焚，缺口在「交接」不在「走查能力」**：

- 走查基础设施已齐且与 run 同源：`amber session`（`SessionRuntime`）的
  observe/act/read/extract/signal/wait_for/snapshot 与 run 共用同一批实现
  （`BrowserMiddleware.actOnce` → `hintMatch` / `checkSignal`；INTERACTIVE_SESSION.md「同源复用点」），
  桥面 `amberflow_session` 已是「跨工具调用保持页面状态」的持久会话。
- 但 run 是**一次性进程**：`runScriptApp` 结束（含失败/blocked/needs_human）在
  `finally` 分支 `liveSession.close()` 关闭浏览器，现场不保。
- 失败证据残缺：result.json / trace（`elements_sample` 仅前 5 行判分样例）/ steps[] /
  failure 有结构化停因，但 **app run 面没有失败截图/DOM/池快照**——只有线上套件有
  （`src/online/report.ts` 落 `-failure.png` / `-failure.html`）。
- 走查工具都是独立新会话：`inspect` 一次性、`session` 新开浏览器，均不 attach 运行会话
  （AGENT_INTERFACE.md §1 明文）。
- Agent 既有回路是「离线诊断 → 改 `app.mjs` → 整条重跑」：多步长流程的复现成本高，
  且改错了只能再整条重跑验证。
- 架构先例：A6 `--walk`（`ScriptRunOptions.walk`）已证明「run 面单会话、不重导航的调试通路」
  被接受（产物带 `walk:true` 不冒充正式 run）——attach-on-failure 是同一接受域内的自然延伸。

### 1.2 方案（三层递进，价值验证驱动）

#### T1：失败现场证据补齐（P1，建议最先做）

run 以 `failed` / `blocked` / `needs_human` 停止时，在 outDir 落失败现场四件套：

| 文件 | 内容 | 实现来源 |
|---|---|---|
| `failure.png` | 失败时整页截图 | 复用 `SessionRuntime.failureScreenshot` / online 套件先例 |
| `failure.html` | 失败时 DOM | 同上 |
| `failure-pool.json` | 失败步的准入池全量（含 hint_candidates） | 复用 `SessionRuntime.doSnapshot` 的 pool 落盘 |
| `failure-observe.json` | 失败页 `observePage` 只读观察明细 | 复用 `observe.ts`（免费原语，不计预算） |

- 结果 JSON 的 `artifacts` 增引用（有界）；成功路径产物**逐字节不变**。
- Agent 拿现场证据离线走查，需要活页交互时用 `amber session --url <失败时 URL>` 复现
  （同源保证：同一 hint 在同一池构成下解析到同一元素）。
- 成本最低、对两个问题都有支撑（failure-observe.json 顺带承载 D1 的层级上下文）。

#### T2：`--attach-on-failure` 进程内接管（P2）

`amber run <id> --attach-on-failure [--attach-input requests.jsonl]`：

1. 失败分支判断该旗标：**不 close**，把 `liveSession`（同一 `browserSession` + `BrowserMiddleware`
   构成）交接给一个嵌入的 `SessionRuntime`。
2. **工程量主体**：给 `SessionRuntime` 增加「外部注入已有会话」的构造入口
   （现状 `ensureSession`/`mw`/`ctx` 每次按需自建新会话）；协议不变（stdin 每行一条 JSON 请求）。
3. 无人接管兜底：复用 session 既有 idle 超时（退出码语义不变），超时即关浏览器收进程。
4. `--record` 轨迹照旧可用：Agent 接管走查确认「正确动作」后，轨迹可直接
   `session export` 生成修复素材（observe_hints 注释可照抄进 `app.mjs`）。
5. 产物纪律：result.json/report 在进入 attach **之前**已写盘且不再改写；
   接管动作只进 session 轨迹；结果带 `attached:true` 标记（仿 walk 先例）。
6. CLI 适配：非 TTY + 无 `--attach-input` 时该旗标无效并告警（不假装有人接管，
   对齐「非 TTY 不假装有人」硬规则）。

桥面（`amberflow_run`）本期只加 `attach_on_failure` 参数透传 + 失败结果里附
attach 指引（evidence_dir + 接管方法）；桥内长连接接管归 T3。

#### T3：桥面跨进程接管（P3，待验证）

失败现场不随 run 进程死：SessionRuntime 挂本地 socket/port，新命令
`amber session attach --port N` 接管，桥侧 `amberflow_session` 走同一通道。
进程边界与安全面复杂度高，仅在 T1+T2 落地后确认真实需求再立项。

### 1.3 验收标准

1. **T1**：构造第 N 步失败的临时应用，run 后 outDir 含四件套且内容与失败页一致；
   成功 run 的产物清单与文件内容逐字节不变。
2. **T2**：失败 run + attach + 喂 observe/act 请求行，可在同一现场走查
   （URL/DOM/输入值与失败时一致）；不喂请求时 idle 超时后浏览器关闭、退出码不变；
   result.json 在 attach 前后逐字节一致；`--record` 轨迹可通过 `session export` 且过 `apps check`。
3. **红线验收**：接管会话内不存在任何能把 failed 结果改写成 passed 的路径
   （结果文件已定 + session 不判完成，双层保证）。

### 1.4 涉及文件

`src/app/app-runner.ts`（失败分支、liveSession 交接）、`src/app/session-runtime.ts`
（注入构造入口）、`src/cli/commands/run.ts`（旗标）、`src/cli/registry.ts`（帮助表）、
`integrations/dsh-bridge`（参数透传 + 指引）、`docs/AGENT_INTERFACE.md`（契约同步）。

### 1.5 红线（不可破）

- **接管不改变 run 结论**：完成只认信号；修好后的「通过」只能来自重新 `amber run`。
  attach 是调试面（authoring），不是第二条执行面——对齐「session 不判完成」既有边界。
- **危险闸门不放宽**：attach 会话继承 run 的 hosts 信封；破坏性动作默认拒绝方向不变；
  Agent 不能自己确认危险动作（AGENT_INTERFACE.md §4）。
- **人工步语义不变**：needs_human 现场 attach 后可走查，但完成仍按人工步原语义。
- **不另写执行器**：SessionRuntime 只是把同一会话的请求分发循环挂上去，
  不复制 `BrowserMiddleware.run` 循环。

---

## 2. 问题二：元素层级语义（平铺结构 → 同标签误判）

### 2.1 现状诊断

- **平铺投影**：`Elem`（extraction.ts）只有 tag/label/id/name/data_test/href/near/rect/bucket
  等字段，无 DOM 祖先/容器信息；`near` 是 NEAR_JS 采集的**单个近邻词面**，不构成结构区分。
- **已有防护已覆盖「误判不发生」但没覆盖「人如何区分」**：A2 歧义停因
  （`target_ambiguous` 零动作 + `ambiguity` 证据块）、`same_label` 标记、`suggested_hint`
  （`hintMatch` 唯一命中自证）、弱档回显（`hint_kind`/`hint_tier`/`hint_suspicious`）、
  A4 落空判别（candidates/near/rejected）。误点已被结构性挡住；缺的是证据里的**结构语义**。
- **缺口一（观察面）**：observe/inspect/歧义证据的候选行没有祖先链与语义地标——
  Agent 看平铺行无法判断「两个『提交』分别在不同容器里」还是「同容器真同名控件」。
- **缺口二（匹配面）**：hint 6 形状闭集（hint.ts `parseHint`）没有容器限定形状；
  flow 内无法表达「购物车区的提交按钮」。页面无 id/data-test 时只剩词面，必歧义。
  observe 的 `selector` 收窄（任意 CSS 含后代组合器）只是观察面过滤，不能写成 flow 锚点。
- **动 hint 语法的既有纪律**：`parseHint` 是唯一解析器，池侧（rules）与 DOM 侧（extraction
  回捞）两个匹配底座靠同一份形状解析，历史上漂移过两次——扩形状必须四面成对改
  （parseHint → rules.hintMatch → extraction DOM 回捞 → suggestHints 自证），仓库对此极谨慎。

### 2.2 方案（两步走，先证据后语法）

#### D1：层级上下文进观察/证据面（P1，零匹配语义变更）

1. **采集**：`observeElements` 的 JS 探针顺带采集有界祖先链——
   `dom_path`（深度 ≤6；每段优先 `tag#id`/`tag[data-test=x]`，退化为 `tag`；
   同级多元素加 `:nth-of-type`；总长 ≤120）与 `landmark`（最近语义祖先：
   heading 文本 / `[aria-label]` / nav|main|section|fieldset|form 的角色或标签，≤40）。
   一次 DOM 读内完成，无额外往返（`near` 采集同款方式）。
2. **透出三处**：
   - observe 元素行（`ObserveElement` 加可选字段 `dom_path?` / `landmark?`；
     缺省采集、键缺省不出现者按逐字节纪律评审，倾向 opt-in：`observe({includePath:true})`）；
   - inspect `--json` 的有界元素块（同字段）；
   - **歧义证据**（`ambiguity.candidates[]`）每行加 `dom_path` / `landmark` /
     `container` 分组标记：`same_container`（候选同容器 = 真同名控件，必须换
     id/data-test/name 锚点）vs 不同容器（结构可分，抄容器内唯一锚点或 observe
     selector 收窄）。歧义/落空是失败路径，新增证据字段不破坏成功路径契约
     （先例：A4 `diagnostics`、B1 `actionability`）。
3. **Agent 走查回路就此闭环**：observe 看 dom_path/landmark → 目测结构差异 →
   a) 池内有唯一锚点 → 直接抄 `hint_candidates`；b) 结构可分且无锚点 →
   `observe({selector:"容器 css"})` 收窄后抄子集内唯一命中；c) 仍不可分 → D2。
   操作指引可同步进 `docs/APP_SCRIPT_AUTHORING.md` 与 `app_create` 骨架的 cookbook 段。

#### D2：hint 第 7 形状「容器限定」（P2，匹配面变更，挂 BACKLOG #2 之后）

1. **形状提案**（具体形式评审定，倾向最小化）：容器段 + 组合器 + 元素段，两段各自
   复用既有 6 形状之一的解析（如 `[aria-label=购物车] > 提交`）。只加一个组合器，
   不引入通用 CSS（容器/后代选择器照抄进 hint 的老问题：解析得出但永不命中，
   INTERACTIVE_SESSION.md 已点名）。
2. **四面成对改**：`parseHint`（新 kind）→ `rules.hintMatch` 池侧（匹配时按祖先链/
   近邻图判定包含）→ extraction DOM 回捞（活页面按容器定位后代）→ `suggestHints`
   （仅在普通 hint 歧义的元素上提议组合形状，且经同一 `hintMatch` 自证唯一命中）。
3. **排期衔接**：BACKLOG #2（候选生产上移应用层）落地时候选元数据契约本就要重定义——
   把层级上下文（祖先链/landmark）纳入契约，executor 消费纯数据时结构信息天然可用；
   #3 的重要性分输入同样可吃 landmark 信号。**D2 排在 #2 契约定型之后**，
   避免两次改同一个匹配面。

### 2.3 验收标准

1. **D1**：两个同 label 按钮分属不同容器的页面上——observe 行带 dom_path/landmark 且值正确；
   act 歧义停因的 `ambiguity.candidates[]` 能看出容器差异与 `container` 分组；
   成功路径响应键集逐字节不变（或按 opt-in 评审结论）。
2. **D2**：该页面上容器限定 hint 唯一命中目标按钮；全部既有 6 形状在既有页面的解析结果
   逐字节不变（hint 回归对照）；`suggestHints` 只对「普通形状歧义」的元素提议组合形状。

### 2.4 涉及文件

D1：`src/engine/extraction.ts` / `pool-js.ts`（探针采集）、`src/engine/observe.ts`
（`ObserveElement` 字段）、`src/engine/ambiguity.ts`（candidates 增强）、
`src/cli/commands/inspect.ts`（透出）、`docs/APP_SCRIPT_AUTHORING.md`（指引）。
D2：`src/engine/hint.ts`、`src/engine/rules.ts`、`src/engine/extraction.ts`（DOM 回捞）、
`docs/AGENT_INTERFACE.md` / `docs/INTERACTIVE_SESSION.md`（形状闭集文档同步）。

---

## 3. 实施顺序建议

```
第 1 步（可并行，均为证据面/零行为变更）
  T1 失败现场四件套          验收：失败 run 产物清单 + 成功路径逐字节
  D1 层级上下文进观察/证据面  验收：同 label 双按钮页 observe/ambiguity 证据
第 2 步
  T2 --attach-on-failure（CLI 进程内接管）   验收：见 §1.3
第 3 步（与既有排期协调）
  D2 hint 容器限定形状 —— 挂 BACKLOG #2 契约定型之后
  T3 桥面跨进程接管 —— T1/T2 验证真实需求后立项
```

## 4. 与既有 BACKLOG / IMPROVEMENT_PLAN 的关系

- T2 复用的 `SessionRuntime` 是独立模块，不与 IMPROVEMENT_PLAN 的拆分批次
  （F 系列改动 app-runner/executor）冲突；实施时避开同文件并行即可。
- D2 显式衔接 BACKLOG #2/#3：契约重定义时一并纳入层级元数据，不单独两次改匹配面。
- 本方案不触碰禁区：不另写执行器、完成只认信号、hint 语法变更走四面成对改 +
  逐字节回归、危险闸门/人工步/凭据纪律全部维持。
