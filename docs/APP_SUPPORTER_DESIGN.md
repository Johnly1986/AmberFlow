# 应用支持器（AppAdapter）：多类型应用、同一流程、返回值传递

**日期**：2026-10-18 ｜ **状态**：设计 + **Slice 1/2/3 已落地**（提交见 git log）｜ **目标**（项目方）：
改进应用层，支持多类型应用（网页、ssh、游戏等），抽象"应用支持器"，**同一流程不应限定应用类型**，
**返回信号应可以传递**；每次实现都用**真实场景**验证。

## 0. 现状（为什么需要这层）

应用层今天有两种步型，靠"有没有 `source` 键"隐式判定（`app-pack.stepKind`）：

| 步型 | 动作腿 | 完成真值（信号面） | 声明键 |
|---|---|---|---|
| 浏览器步 | 唯一执行器 `BrowserMiddleware`（Playwright） | DOM 信号（`signals.ts` 五算子 + 组合） | `start_url` / `target_hint(s)` / `when` / `commands` / `effect` |
| 工具步 | `runToolStep`（datasource 的 `cli` transport：argv 数组 + 白名单 env） | 进程观察：`exit_ok` / stdout / stderr / json_path / file_*（`tool-signals.ts`） | `source` / `args` / `dry_run_args` / `idempotent` / `dangerous` |

三条硬限制：

1. **步型是闭集**：`ExpandedStep.kind: "browser" | "tool"`；`BROWSER_ONLY` / `TOOL_ONLY` 在加载期互斥校验。
   想加 ssh / 游戏 / 其它应用类型，必须改 `app-pack` + `app-runner` 两处核心（违反"加一个应用=加数据"的纪律）。
2. **同一流程事实上被类型限定**：`when` 只有浏览器步能声明；不变量恒为 DOM 不变量且**要求至少一个浏览器步**；
   浏览器会话由 runner 懒创建、`getShell` 闭包持有——非浏览器类型没有对等的"会话"位置。
3. **返回值不能传递**：跨步传值今天只有 semantic-flow 的 `dataset`（`gives` → `dataset.write` → 浏览器命令绑定
   `{from:"dataset"}`）；**应用层没有接这条管道**——工具步的 stdout 无法喂给下一步，ssh 命令的结果无法当参数用。

真实场景可行性（本机实测，2026-10-18）：`sshd` 在 22 端口监听、`ssh localhost` key 认证已通（`SSH_OK`）；
python 可用（可做真实交互式 stdio 游戏）；chromium 与 git/jq 已由既有套件覆盖。

## 1. 目标与边界

**目标**

- 应用层引入 **应用支持器（AppAdapter）** 抽象：一种应用类型 = 一个适配器（声明面 + 执行面 + 信号面 + 返回值面）。
- 包里的 journey 是**适配器无关的步骤序列**；每一步用 `adapter` 指名支持器（缺省推断，向后兼容）。
- 同一流程可以混用多种类型：web → cli → ssh → game → web，走向（`next`）/重试/危险门/不变量同一套语义。
- **返回值传递**：任一步可按声明抽取观察里的值（`returns`），在**该步信号成立后**写入运行级数据集；
  后续步骤以 `{dataset:NAME}` 占位符（进程类参数）或浏览器命令绑定 `{from:"dataset", key}` 消费。
  纪律沿用 `src/dataset.ts`：只走具名数据集、带溯源、重跑失效、**绝不经过模型转述**。
- 每次实现落地都要有**真实场景**验收（真 chromium / 真 git/jq / 真 localhost ssh / 真交互进程）。

**边界（本轮明确不做）**

- 不改 semantic-flow 的 nominin 面；不把应用层改成"任意任意协议"的通用 RPC。
- 不保证 CI 能跑 ssh/game 场景（本地服务依赖）——CI 仍只跑离线/浏览器/CLI 场景；新类型走
  "可用则跑、不可用则如实 SKIP"（跳过 ≠ 通过）。
- 不改变已有应用包的行为与产物字节（Slice 1 的验收标准之一）。

## 2. 应用支持器契约（`src/app-adapters.ts`）

```ts
export interface AppAdapter {
  /** 唯一 id：`web` / `cli` / `ssh` / `stdio`（游戏等交互进程） / 未来的其它。 */
  readonly kind: string;
  /** 该类型**特有**的步声明键（加载期白名单；共享键另算）。 */
  readonly stepKeys: readonly string[];
  /** 显式声明时必需的关键键（如 cli/ssh 需要 `source` 或 `ssh` 块）。 */
  readonly requiredKeys?: readonly string[];

  /** 加载期：把展开后的一步变成该类型的声明值；语义问题 push 进 problems（响亮、不静默）。 */
  expand(merged: Record<string, unknown>, where: string, problems: string[]): unknown;

  /** 加载期：校验该步的信号语言（web=DOM 信号、process 族=进程观察信号）。 */
  validateSignal(signal: unknown, where: string, problems: string[]): void;

  /** 运行期：执行一步。ctx 提供会话、输出目录、数据集、槽位与 runner 的服务回调。 */
  run(decl: unknown, step: ExpandedStep, ctx: AdapterRunContext): Promise<AdapterOutcome>;

  /** 运行期：从这次观察里抽取声明好的返回值（只在该步信号成立后调用）。 */
  extractReturns?(decl: unknown, outcome: AdapterOutcome): Record<string, unknown>;

  /** 运行期：结束态不变量（可选；缺省 = 不支持该类型的不变量）。 */
  observeForInvariant?(signal: unknown, ctx: AdapterRunContext): Promise<boolean>;
}
```

- **注册表**：`registerAppAdapter()` / `getAppAdapter()` / `listAppAdapters()`；未知适配器在**加载期**就红并列出已知项
  （与 provider 注册表同一条纪律：拼错名字不许静默退回）。
- **迁移桥（Slice 1）**：`web` 与 `cli` 两个内建适配器把执行委托给 runner 提供的服务回调
  （`ctx.runWebStep` / `ctx.runCliStep`）——执行循环本身**不搬到适配器里**（执行器是仓库最承重的函数，
  搬动风险大于收益）；适配器负责"声明 + 分派 + 信号 + 返回值"。后续 ssh/stdio 适配器**原生实现** `run`。
  设计文档把这条桥写成**显式的迁移路径**，不假装已经纯化。

## 3. 步骤声明与类型推断

- `STEP_KEYS` 增加 **`adapter`**（显式类型名）。
- 推断规则（向后兼容）：显式 `adapter` 优先；否则 `source` 存在 ⇒ `cli`；否则 ⇒ `web`。
  已有 20+ 应用包**一个字节都不用改**。
- 每步允许的键 = **共享键**（`role/desc/signal/slots/retries/id/next`）+ 该适配器 `stepKeys`。
  写了他类型的键 ⇒ 加载期红，报错点名"这是 X 类型的键、当前步是 Y"。
- `when` 的归属：Slice 1 仍只属于 web（对进程类步骤"此刻适不适用"没有页面可问；语义待设计）。
  目标态的 `when` 由**该步自己的适配器**在运行期对"当前可观测状态"求值（web=DOM、process=上一次观察），
  不变量同理（`invariants[i].adapter`，缺省 web）。

## 4. 信号面：两套观察面，一个形状

仓库已经有两套**同构**签名语言的先例（DOM 五算子+组合 / 进程观察面 `tool-signals.ts` 的组合算子与叶子）。
适配器只需声明自己属于哪一面：

| 适配器 | 观察面 | 信号语言 | 校验入口 |
|---|---|---|---|
| `web` | 页面 DOM | `SignalSpec`（`signals.ts`） | `PlanningRules.problems` 已复用 |
| `cli` / `ssh` / `stdio` | 进程观察（exit/stdout/stderr/文件） | `ToolSignal`（`tool-signals.ts`） | `validateToolSignal` |

**为什么 ssh/game 复用进程观察面**：ssh 命令、交互式游戏的每一步，可验证事实都是"退出码/输出/副作用文件"。
同一份观察面语言在三种传输（本地 argv / ssh 远程命令 / stdio 会话）上成立，不需要第三套信号语言。

## 5. 返回值传递（"返回信号应可以传递"）

### 5.1 声明

```jsonc
{ "id": "read-token", "adapter": "ssh", "desc": "在远端读出令牌",
  "ssh": { "host": "localhost", "argv": ["cat", "/tmp/af-token"] },
  "signal": { "exit_ok": true, "stdout_matches": "^[a-z0-9]{8}$" },
  "returns": { "token": { "from": "stdout_regex", "pattern": "^([a-z0-9]{8})$" } } }
```

- `returns`: 名字 → 抽取器（适配器自己的抽取语言；process 族共享同一套：
  `stdout_regex` / `stdout` / `stderr_regex` / `json_path` / `exit_code` / `file_text`）。
- 只有该步 `signal` 成立（done）后才抽取并写入；**信号不成立 = 不写**（与 `gives` 的既有纪律一致）。

### 5.2 传递

- **进程类参数**（cli/ssh/stdio 的 args/输入）：运行期占位符 **`{dataset:NAME}`**，
  在执行该步时从数据集现读最新世代；键缺失/陈旧 ⇒ 结构化停 `needs_value`（与红线②同一条：没有值就停，绝不猜）。
- **浏览器步**：命令绑定已有 `{from:"dataset", key}`（`executor` P3），app-runner 需把 `DatasetStore` 传进
  `RunOptions.dataset`（Slice 2/3 接线）。
- 溯源：`writtenBy = stepId#attempt`；重跑（retries/`next` 回边）时**先失效再重写**（`invalidateStep` 既有语义），
  绑定在解析那一刻现读最新 generation——陈旧世代不可读，错误停在当步，不静默级联。

## 6. 会话生命周期

- `web`：runner 懒创建共享浏览器会话，旅程结束、**不变量求值之后**关闭（现有行为不动）。
- `ssh`：每步按声明建立一次 ssh 连接（`ssh -o BatchMode=yes ...`，单命令），或（Slice 3）会话复用；
  失败 = 该步 `refused`/`blocked`（结构化），不抛栈、不影响其它类型步骤。
- `stdio`（游戏等交互进程）：适配器持有子进程 + 行缓冲，`run` = 发送输入直到信号成立或超时；
  `close` 幂等，超时/进程退出都记结构化结果。
- 适配器的会话失败**不得**让整条旅程炸掉：与工具步"unavailable/refused"同一口径（错误是结果，不是异常）。

## 7. 不变量与走向（目标态）

- `invariants[i]`: `{id, adapter?, signal}`；缺省 `adapter:"web"`（既有包逐字节不变）。
  process 族的不变量在该类型的**最后观察**或声明的只读 `probe` 上求值（Slice 4）。
- `next`/`when`：`next` 与类型无关（Slice 1 已如此：walk 对工具步直接适用）；
  `when` 由目标步自己的适配器求值（目标态）；Slice 1 先维持"仅 web 有 `when`"并在加载期如实说明。

## 8. 验收：每次实现都用真实场景

| 类型 | 真实场景 | 会验什么 | 何时 |
|---|---|---|---|
| `web` | 既有 chromium 夹具（`demo-app` / `transfer-*` / `semantic/site-a`） | 真浏览器、DOM 信号、不变量 | Slice 1（既有套件回归） |
| `cli` | 真 `git` / `jq`（`apps/repo-report`） | argv 数组、退出码/输出信号、危险步干跑 | Slice 1（既有套件回归） |
| `ssh` | **本机 sshd**：`ssh localhost` key 认证（已实测 `SSH_OK`） | 远程命令、`exit_ok`/stdout 信号、`returns` 取值 | Slice 2 |
| `stdio`（游戏） | **真实交互式进程**：python 猜数游戏（stdin/stdout 会话） | 行交互、超时、信号、`returns` | Slice 3 |
| 混合流程 | 一个包内 web → cli → ssh → game → web，含 `{dataset:NAME}` 传值 | 同一流程跨类型、走向/重试/危险门、不变量 | Slice 3/4 |

**CI 纪律**：ssh/game 场景依赖本机服务；套件里"不可用 ⇒ 如实 SKIP（跳过 ≠ 通过）"，
CI 的绿色定义仍只有 `bench/smoke.sh`（离线 + 既有夹具）。新增类型的真实场景验收在本地跑并记录到文档/产物。

## 9. 迁移切片（每片独立可验收）

- **Slice 1（本轮）**：`src/app-adapters.ts` 注册表 + `web`/`cli` 支持器（迁移桥）+ 显式 `adapter` 键 +
  每适配器键校验 + runner 分派走注册表；**既有全量应用/套件产物逐字节不变**（verify + `apps:suite` 真实跑）。
- **Slice 2**：`ssh` 支持器（本机 sshd 真实场景）+ `returns`（stdout_regex）→ dataset → 下一步消费；
  新 demo 应用 `apps/ssh-demo`（真 ssh 命令链），套件按可用性跑。
- **Slice 3**：`stdio`/游戏支持器（真实交互进程）+ `{dataset:NAME}` 进程参数占位 + 混合类型应用
  （web→cli→ssh→game→web），端到端真实跑。
- **Slice 4**：类型无关的 `when` / `invariants[i].adapter` + 报告面（每步类型/返回值的账）+ 架构图与文档收口。

## 10. 风险与反清单

- **表面膨胀**：新键必须进适配器声明面并带加载期校验；"写了没用"不许存在（沿用仓库的声明纪律）。
- **执行器搬动风险**：Slice 1 明确不搬 `BrowserMiddleware`；web 适配器只是分派层。
- **传值污名风险**：返回值只走数据集、只由声明抽取、只在该步信号成立后写；**绝不经过模型转述**（红线②）。
- **本地服务依赖**：ssh 用 `BatchMode=yes` + 超时；游戏进程有超时与 kill；失败都是结构化结果。
- **不假装 CI 覆盖**：ssh/game 不在 CI，文档与套件显式标记 SKIP。

## 11. Slice 1 落地记录（2026-10-18）

**实现**

- 新 `src/app-adapters.ts`：`AppAdapter` 契约 + 注册表（`register/get/list/require`）+ 内建 `web`/`cli`
  支持器；两者是**迁移桥**——声明/校验/信号/分派进适配器，执行循环（`BrowserMiddleware`、`runToolStep`）
  仍留在 runner，通过 `ctx.runWebStep` / `ctx.runCliStep` 服务回调接入（设计文档 §2 已如实标注）。
- `src/app-pack.ts`：`STEP_KEYS` 改为"共享键 + 各适配器专属键"的**动态**口径（`appStepKeys()`，
  注册新类型后它的键立刻合法）；`adapterKind()`（显式 `adapter` 优先、缺省推断 web/cli）+
  `stepKind()` 兼容视图；`ExpandedStep` 增加 `adapter` / `decl`；展开与校验改为按注册表分派；
  跨类型专属键检查保留既有文案（browser-only / tool-only）。
- `src/app-runner.ts`：执行循环从 `if kind==="tool" else browser` 改为**注册表分派**
  `adapter.run(step.decl, step, adapterCtx)`；`web` 分支执行代码原样收进 `runWebStep` 服务；
  `when`/跨步标记按 `adapter === "web"` 判定（Slice 1 边界，见 §7）。

**验收（真实场景）**

- 新增 `tests/app-adapters.test.ts` 10 条：注册表/未知类型响亮报错/**注册新类型 = 多一种应用**
  （不改核心分支）/显式与推断/专属键白名单/展开 adapter+decl/执行分派。
- 既有应用层测试（apps / app-packs-authored / app-packs-verified / apps-induce）**158 条全绿**；
  `npm run apps:suite` 真 chromium + 真 git/jq 跑完整批语料，结果与 Slice 1 之前**逐行一致**。
- 全量门禁：`npm run verify`（含六层对拍）与 `bench/smoke.sh` 见提交记录。

**下一片（Slice 2）**：`ssh` 支持器（本机 sshd 真场景）+ `returns`（stdout_regex → 数据集）→
下一步消费；随后 Slice 3 `stdio`/游戏 + 混合类型旅程；Slice 4 类型无关的 `when`/不变量与架构收口。

## 12. Slice 2 落地记录（2026-10-18）：ssh 支持器 + 返回值传递 + 能力闸

**实现**

- `src/app-adapters.ts`：
  · **`ssh` 支持器**（`kind: "ssh"`）：结构化声明 `ssh: {host, user?, port?, key?, argv}`；执行真实的
    `ssh` 子进程（`BatchMode=yes`/`StrictHostKeyChecking=no`/`ConnectTimeout=5`，30s 超时）；信号复用
    **进程观察面**（`tool-signals`：exit/stdout/stderr/json_path）；与 cli 同口径的 `retries`+`idempotent`、
    加载期拒绝 `file_*`（ssh 没有本地文件面）与 `dangerous`（干跑语义未实现，Slice 4 再做）；连不上 =
    结构化失败（`code != 0`、`done=false`），不抛栈；`ready()` 能力探测（本机 sshd 是否可用）。
  · **返回值（returns）**：共享 `returns` 步键；进程族（cli/ssh）同一套抽取器
    `stdout` / `stdout_regex` / `stderr_regex` / `exit_code`；**只在信号成立后**抽取并交给 runner 写数据集
    （`writtenBy = stepId#attempt`）；web 步明确拒绝（DOM 抽取留给 Slice 4）。
  · **传值**：运行期占位符 `{dataset:NAME}`（与 `{out_dir}`/`{run_id}` 同族）——cli 参数在
    `runToolStep` 解析、ssh argv 在适配器内解析；**缺失/陈旧 = 结构化 `needs_value`，绝不替换成空串或猜值**。
- `src/app-pack.ts`：`returns` 进共享键；**加载期对账**——`returns.NAME` 产者在同一旅程里必须唯一、
  每个 `{dataset:NAME}` 必须有产者（否则运行期必然 needs_value 的"静默版"）；`{dataset:NAME}` 不参与
  槽位替换（保留到运行期，不误报 unknown slot）。
- `src/app-runner.ts`：运行级 `DatasetStore`（可注入）；每步执行**前**失效该步上次写过的值（`next` 回边/
  重跑不读陈旧世代），执行后按需写入；`{from:"dataset"}` 浏览器命令绑定接线（`MiddlewareOptions.dataset`）；
  `tool_steps[i].returns` 与结果级 `dataset_view`（含 generation/stale/溯源）成为审计面；报告多一行数据传递。
- `tools/apps_suite.ts`：**能力闸** `unavailableAdapters(pack)`——展开旅程，问每个用到的适配器
  `ready()`；不可用 ⇒ 该应用**如实跳过**（理由进 skipped 列表；跳过 ≠ 通过，退出码仍有"未执行"）。
  以后任何依赖本机服务的类型（游戏/桌面等）自动获得同一条纪律，不在套件里写类型分支。

**真实场景验收**

- 新增 `tests/app-ssh.test.ts`（2 条，**真实本机 sshd**；无 sshd 时打印原因跳过）：同一旅程
  **web → cli → ssh → cli**：cli 的 `stdout_regex` → 数据集 → ssh 远端命令的 `{dataset:token}`；
  ssh 的 `stdout_regex` → 数据集 → 下一 cli 步 argv；**远端副作用可查**（远端写出的文件内容 =
  传过去的值）；另一条验证"ssh 连不上 = 结构化失败"。
- 新增 `tests/app-returns.test.ts`（6 条，离线 CI 可跑）：加载期对账（无产者/重名/坏抽取器红）、
  产者信号不成立 ⇒ 不写 + 消费者 `needs_value`、抽取不到 ⇒ 如实缺席（不编造）。
- 新增 `apps/ssh-demo`（仓库级示范应用，套件输出一行；Slice 3 已升级并更名为 `apps/mixed-demo`，见 §13）：`npm run apps -- --app ssh-demo --no-sources`
  实测 **4/4 通过**：token=`widgets`（cli→数据集）、ssh:localhost 真执行并返回值
  （`remote=widgets`）、真实文件 `<out>/ssh-token` 内容为 `widgets`、浏览器不变量成立；
  `apps:suite --only ssh-demo` 行结论"通过（model not needed）"。
- `apps:suite` 全量回归：ssh-demo 加入后与应用层既有行为一致（见提交记录里的套件输出）；
  能力不可用路径由 `tests/app-adapters.test.ts` 的确定性假适配器覆盖（不可用 ⇒ 给出类型+原因；可用 ⇒ 空）。

**与冻结语料的关系（本轮实测到并修掉的一处）**

新增 `apps/ssh-demo` 后，`nomination --check` 立刻红：**机器无关的提名语料**把"能不能跑取决于本机
有没有 sshd"的应用也算进去了（14 包/165 步 → 15 包/166 步）。修法不是特判应用 id，而是把**语料口径**
写进工具：凡是用到声明了 `ready()` 能力探测的适配器（如 ssh）的应用，**不进离线网页提名语料**
（`tools/instruction_nomination.ts` 的 `discoverOfflineJourneyPacks`）——以后任何依赖本机服务的类型自动
获得同一条规则。修后 `nomination --check` 与上下文实验产物都恢复 14 包/165 步逐字节一致。

**已知边界（下一片）**

- `stdio`（游戏等交互式进程）支持器尚未实现（Slice 3）；类型无关的 `when`/`invariants[i].adapter` 仍缺（Slice 4）。
- ssh argv 是**远端 shell 字符串语义**（ssh 客户端会拼接后交给远端 shell）——与本地 cli 的
  "argv 数组永不过 shell"不同；转义责任在声明者，已写进 `apps/README.md` 与 ssh-demo 的 notes。

## 13. Slice 3 落地记录（2026-10-18）：stdio（游戏/交互式进程）+ 全类型混合旅程

**实现**

- `src/app-adapters.ts`：新增 **`stdio` 支持器**——真实子进程的**持续双向会话**：
  · 声明 `stdio: {argv, cwd?, env_allow?, script: [{when, send}], timeout_ms?}`；`argv` 数组（永不过 shell）、
    `env_allow` 白名单（PATH 恒在，其余不泄漏）、`cwd` 相对仓库根；
  · 交互协议是**有序脚本**：stdout 上等到 `when` 正则 → 写一行 `send`，真实提示-应答（不是"把输入一次性灌进去"）；
  · 完成仍只认该步自己的**进程观察信号**（红线③）；会话进行中的观察把退出码置未知（-1/false），
    所以 `exit_*` 叶子不会在进程退出前误成立，进程退出后再用真实退出码判一次；
  · **超时 = 结构化失败**（kill + `[stdio] timed out after Nms`，不挂死、不抛栈）；
  · 信号成立后给进程 1s 体面退出、否则 kill（"服务器型"进程不能因为信号成立就让 runner 永远等）；
  · `retries`/`dangerous` 加载期拒绝（重放一整局不是同一次交互；干跑语义未实现）；
  · 传值：`{out_dir}`/`{run_id}`/`{dataset:NAME}` 可进 argv 与 send；缺失 = needs_value **且不启动进程**。
- `bench/fixtures/guess-game.mjs`：确定性的真实交互式猜数字游戏（`--secret`/`--max`），
  作为 CI 无条件可跑的真实场景夹具（只依赖 node）。实现中抓到一个真实细节：**stdin 是管道、读端还开着时
  Node 默认不会自己退出**——游戏一局结束必须显式 `process.exit`，否则适配器只能靠超时收场（已写进夹具注释）。
- `apps/mixed-demo`（由 `apps/ssh-demo` 升级更名）：**一条旅程 7 步 / 四种类型**：
  web（加购）→ cli（令牌）→ ssh（远端写/读，并从同一次输出抽优惠券码）→ cli（消费远端值）→
  **web（命令绑定 `{from:"dataset"}` 填优惠券并应用）** → **stdio（玩一局猜数字）** → cli（消费游戏返回值）。
  真实运行实测 **7/7 通过、28~31s**：`dataset_view` 四条值（token/remote/coupon/tries + 溯源）、
  `<out>/ssh-token` 内容 = `widgets`、不变量 `coupon-applied` 成立、报告有"数据传递"行；
  套件行"通过（model not needed）"。**浏览器侧消费数据集值**（第二条传值通路）由这个应用端到端证明。

**真实场景验收**

- `tests/app-stdio.test.ts`（7 条，离线 CI 可跑）：声明面（缺块/未知键/坏正则/retries/dangerous 红）、
  真实交互一局（7 次猜中 + returns + 数据集溯源）、超时结构化失败、`{dataset:NAME}` 喂 send 的跨类型传递、
  缺失值 = needs_value 且**进程没启动**（没有开局提示，证明"停在任何副作用之前"）。
- `tests/app-mixed.test.ts`（1 条，**真实本机 sshd + 真实子进程**，无 sshd 则跳过）：`loadPack("mixed-demo")`
  整跑，断言四种类型同旅程、三条传值通路、真实远端文件、浏览器结束态不变量、报告行。
- 全量 `apps:suite` 与 `npm run verify`/`bench/smoke.sh` 见提交记录（能力闸：混合应用依赖 sshd，
  不可用则如实跳过）。

**已知边界（下一片）**

- 类型无关的 `when` / `invariants[i].adapter`（进程族结束态不变量）仍是 Slice 4；
  stdio 是**行文本协议**（无 pty/TUI 语义）、不支持 retries/dangerous；ssh 的 dangerous/干跑语义未实现。
