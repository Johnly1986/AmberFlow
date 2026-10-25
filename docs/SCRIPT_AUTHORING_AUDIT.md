# 应用脚本书写 / 引擎健壮性 / 可拓展性 —— 双视角审计（2026-10-25）

> 方法：以**新用户**身份从零写脚本并只用 README/`--help` 找路；再以**产品维护者**身份读实现、
> 跑失败路径、对比声明式与脚本两条执行入口。所有"发现"都附可复现的命令/观测；
> 修掉的条目注明提交，未修的单独立项（不假装已解决）。
>
> 相关实现：`src/app/{declarative,app-script,ctx,ctx-dry,ctx-replay,trace,app-adapters}.ts`、
> `src/cli/commands/{apps,run}.ts`。审计后新增的开发者指南：[APP_SCRIPT_AUTHORING.md](APP_SCRIPT_AUTHORING.md)。

## 一、用户角度

### 1.1 编写难度

| # | 严重度 | 发现（证据） | 状态 |
|---|---|---|---|
| U1 | 高 | 没有脚手架：新用户只能照 README 抄一个 `app.mjs`。且 README 示例是 `export const meta/app`（手写声明式），而 L3 的同步工具链只认**带标记的固定形状**（`const META/DATA/JOURNEY`），照抄的脚本 `apps list` 不显示、按 id 找不到——文档与工具链对不上。 | ✅ `amber apps new <id>`（默认 flow 可跑骨架；`--kind data` 生成固定形状；`--print/--dir/--force`） |
| U2 | 高 | 用户作用域的手写 `app.mjs` **完全不可按 id 使用**：`amber run hello` / `apps check hello` / `show` / `path` / `remove` 都报 "app pack not found"。两处原因：① 发现制只认带标记的数据脚本；② 按 id 找脚本拼成 `dir/<id>/app.mjs`（差一）。 | ✅ 发现制接受任意 `app.mjs`；按 id 与按路径等价（`tests/script-cli-ux.test.ts`） |
| U3 | 中 | 坏作者错误的可迭代性：`apps check` 对 flow 只报**第一个**配置错误；语法错误只有 "Unexpected identifier 'is'"（无行号）。 | ✅ 行号已补（dry 运行期错误带 `at app.mjs:行:列`；语法错误在 import 失败时用 `node --check` 回填 `app.mjs:行`）。**聚合仍为首错**：运行期配置错误停在不安全点，语义上不该继续执行后续调用 |
| U4 | 中 | `apps explain` 里每一步都显示 `→ about:blank`（step 未给 URL = 当前页），读起来像 bug。 | ✅ 显示"（当前页）" |

### 1.2 健壮性（用户会踩的坑）

| # | 严重度 | 发现（证据） | 状态 |
|---|---|---|---|
| U5 | 高 | `amber run <flow 脚本> --dry-run` 直接报 `journey must be a non-empty list`——dry 分支只理解静态旅程，脚本应用的"只看不跑"根本不可用。 | ✅ flow dry 走 `dryRunFlow`，打印调用序列（`--json` 也有） |
| U6 | 高 | `amber apps list` 对**每个**应用显示 `✗ pack.json 不是合法 JSON`（`readPackAt` 只认 JSON；L3 之后全员中招）。 | ✅ 声明式同步读、手写脚本只列路径不报假错 |
| U7 | 高 | `apps emit <flow 脚本>` 报"展开结果不合法（不应发生）"，且默认落点是应用目录里的 `pack.json`（L3 之后重新制造 JSON）。 | ✅ flow 干净拒绝（下一步提示）；默认落点 `./.amberflow/emit/<id>.json` |
| U8 | 中 | L2 的审计能力（`--emit-trace` / `--replay`）只有 `npm run apps` 有，`amber run` 不能传。 | ✅ 两个旗标接进 `amber run` 并转发 |
| U9 | 高 | 脚本应用**静默忽略** `pack.policy` 与 `--tiered-hint/--learn-hints/--hint-memory/--conf-floor`：同一个包声明，数据脚本生效、flow 脚本不生效。 | ✅ 抽出 `resolveRunPolicy` 两条入口共用；产物写 `effective_policy`/`model_status` |
| U10 | 高 | `ctx.run` 硬编码 `adapter:"cli"`：声明式应用能写的 ssh/stdio 进程步在 flow 脚本里不可表达（能力回退）。 | ✅ `ctx.run` 声明形式 + 适配器注册表；与声明式 journey 同一份实现 |
| U11 | 中 | `StepResult` 只有 `{ok, stopCode}`，引擎的 `stop_reason` 被丢弃——作者排障只能开 `--verbose`。 | ✅ `StepResult.reason`（拒绝/blocked 的人话原因，进 trace） |
| U12 | 中 | `--force-hints off` 对 flow 脚本无声明层可剥，但旗标被接受且无效果（假账）；`--skip-data` 对 `ctx.source()` 无约束。 | ✅ 前者 exit 2 明确拒绝；后者 `ctx.source` 结构化报错 |

## 二、产品角度

### 2.1 健壮性

| # | 严重度 | 发现 | 状态 |
|---|---|---|---|
| P1 | 高 | 应用"发现"有两套规则（列表用 `listPacks` 的同步规则、运行用 `resolveApp` 的异步规则），用户脚本在 CLI 里**半可见**。 | ✅ 统一：发现 = 有数据文件；读取按同步/异步能力分流，错误消息可照做 |
| P2 | 中 | `apps:suite` 不覆盖 flow 脚本应用（`apps/` 里没有 flow 应用；套件走 `runApp` 的静态旅程）。脚本应用缺"一条命令验收"。 | ✅ 套件增加脚本臂（`runFlowOne`）：flow 应用被识别、真执行、决策账同口径（`apps-suite-script` 测试） |
| P3 | 中 | trace 的"确定性"只在 dry 层被断言；真实 trace 带每次不同的耗时，没有结构比较器。 | ✅ `sameEventStructure`（忽略耗时）+ 真实两次运行结构一致测试（`tests/ctx.test.ts`） |
| P4 | 低 | `apps list` 对手写脚本显示"0 步 · 未知"（同步读不了 steps）——诚实但信息少。 | ✅ 显示改为"flow 脚本（运行期步骤）"；`show/explain` 是异步完整视图 |
| P5 | 中 | 没有单一"脚本作者指南"：API、错误码、trace/replay、策略、限制散在 README/代码注释。 | ✅ `docs/APP_SCRIPT_AUTHORING.md` |

### 2.2 可拓展性

| # | 严重度 | 发现 | 状态 |
|---|---|---|---|
| E1 | 高 | meta ↔ IR 字段映射在**三处**重复（`ScriptMeta` 类型、`lowerDeclarative` 的逐字段搬运、`packToScriptSource` 的 `MIGRATE_FIELDS`）。加一个字段要改三处，漏一处就是**静默丢字段**。 | ✅ 单一 `META_FIELD_MAP` 表驱动；序列化/降级共用；表驱动 round-trip 测试；**未知 meta 字段响亮拒绝**（拼错不再静默） |
| E2 | 高 | `Ctx` 有三个实现（real/dry/replay），手工保持同步；新增成员可能只进其中一个。 | ✅ 一致性测试：同一脚本在 dry 与真实运行的调用序列（call/desc/ok）逐项相同（`tests/ctx.test.ts`） |
| E3 | 中 | 工具步支持器被硬编码 cli 挡住（见 U10）。 | ✅ 见 U10 |
| E4 | 中 | 扩展没有配方：加一个 ctx 成员 / 信号算子 / 适配器，要改哪些触点没有文档。 | ✅ 作者指南 §8「扩展配方」 |
| E5 | 低 | `apps:matrix` 只统计仓库声明面；用户作用域里的 flow 脚本会计入"逻辑行"（诚实的债，但用户不一定理解）。 | ◐ 文档说明 |

## 三、本轮迭代（提交）

| 提交 | 内容 |
|---|---|
| `5f155ba` | 用户旅程批次：发现制/按 id 解析/list/`--dry-run`/emit/emit-trace/replay/`apps new` |
| `95bb85b` | 健壮性批次：策略一致性、`ctx.run` 适配器、`StepResult.reason`、旗标诚实 |
| 同批提交 | 文档：本审计 + `docs/APP_SCRIPT_AUTHORING.md`（README/apps/README/CLAUDE.md 已链接）；代码：E1 单一字段表 + 未知 meta 字段拒绝（canonical camelCase，旧 snake 别名兼容，22 个 app.mjs 已重新生成）、E2 dry↔real 调用序列一致性测试、P3 `sameEventStructure` + 真实两次运行结构一致测试 |

## 四、明确未做（不假装）

1. 脚本信任边界：脚本是**进程内任意代码**，防御仍是"用户作用域 + `--no-scripts` + 结果里的
   `script_sha256`"；沙箱化未做。
3. `ctx.rows({row, fields})` 按 Q5 在 v1 关闭（`extract(name)` 已接线，是声明式替代）。
4. flow 运行期配置错误的**多错聚合**（当前首错即停，属安全设计，不是可迭代性缺陷）。
4. `apps:suite` 的 flow 行 `hint 覆盖` 列恒为 0/0（hint 是运行期调用参数，静态数不出来；
   看 `amber apps explain` 的 dry 序列，别拿 0 当"没用 hint"的证据）。
