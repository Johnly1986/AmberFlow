# 节奏（Pace）统一落点实施方案

- 版本：v2（2026-11-05 **已实施**，B1 波次）；v1 草案（2026-11-05）
- 触发：实测规划脸不遵守步间距（`amber plan run` A/B：env 3000ms 时 6243ms vs 6368ms，零差值）；8 轮实验中 r4 的 IP 限速缓解旋钮对 TaskPlan 路径无效
- 原则：**节奏（pace）与正确性等待（settle/轮询/退避）分离**——前者可配置、面向限速礼貌；后者是正确性等待，不并入 pace。落点收敛 = 「一个来源模块 + 各脸循环边界各一处调用」，不做单点大改。
- **语义（v2 拍板）：三脸统一为「最小步间距」**——步间距 = 相邻两次引擎单元**开始时刻**的最小间隔（start-to-start ≥ gap），不再是「无条件 sleep」；上一步耗时长则本步不补等。

---

## 1. 现状盘点（全仓等待点分类）

### 1.1 节奏类（pace，本方案对象）

| 脸 | 应用点 | 来源 | 现状 |
|---|---|---|---|
| flow 应用（`ctx.*`） | `ctx.paceBeforeStep()`（ctx.ts:718-724，skip-first：`stepsUsed===0` 不等） | `deps.stepDelayMs` ← app-runner:2220（`pace.between_steps_ms`） | ✓ 生效（实测 A/B 10.83s vs 4.15s） |
| flow 应用动作间 | executor:4429（`executed && actionDelayMs>0`） | app-runner:2123（`pace.between_actions_ms`） | ✓ 生效 |
| 声明式应用（runApp 旅程） | app-runner:1487（每步 outcome 后 sleep） | `resolvePace`（:1084） | ✓ 生效 |
| 声明式应用动作间 | app-runner:1242（mw 构造 `actionDelayMs`） | 同上 | ✓ 生效 |
| **规划脸（TaskPlan）** | **无**——`planner.runPlan`/`runSubgoalWithRetries` 零 pace 代码 | **拿不到**（`resolvePace` 被 app-runner 独占；plan 无 pack/meta） | ✗ 缺口（实测不遵守） |
| **online 套件** | **无**——`src/online/runner.ts` 直接调 `runSubgoalWithRetries`（不经 runApp） | 同上 | ✗ 缺口（同根） |

来源优先级（现状）：CLI 显式（`opts.pace`）> `meta.pace` > env（`AMBERFLOW_STEP_DELAY_MS` / `AMBERFLOW_ACTION_DELAY_MS`，0..60000 整数、坏值响亮报错）> 0。插件 `stepGapMs` 走 env 层（bridge buildEnv 注入）。

### 1.2 正确性等待（**不并入 pace**，仅登记避免误统一）

| 等待点 | 位置 | 用途 |
|---|---|---|
| settle 静默门 | settle.ts（S2） | SPA 渲染稳定；`state.settleMs` 可观测 |
| done 轮询 | executor:4126（120ms）/ ctx.ts:1522 | 完成信号窗口 |
| pool_ready 轮询 | executor:3241 | SPA 首池就绪 |
| 重试退避 | executor:2871（300ms） | 子目标重试间隔 |
| collect 轮间 | ctx.ts:1299（300ms） | 懒加载窗口 |
| range 微等待 | range.ts（10-20ms） | 滑杆读数稳定 |
| learn 回退 | learn.ts:284（300ms） | 录制捕获重试 |

### 1.3 S1-S5 各波次引入的等待点扫描结论

- S1：无新增等待（只有状态记录）。
- S2：settle（正确性类；已带 `settleMs` 可观测 + policy 可配 + off 逃生口）——**设计正确，不动**。
- S3：collect 轮间 300ms（正确性）；check 无等待。
- S4：stale 重试无 sleep（立即可重试，语义正确——重解析即换新节点）；learn 的 settle 复用 + 300ms 回退（正确性）。
- S5：gate 内 settle（正确性，复用 S2）；无 pace。
- **结论：S1-S5 没有把"节奏"误植进正确性等待；唯一缺口是规划脸/online 无节奏来源。**

---

## 2. 统一落点设计

### 2.1 为什么不是「执行器里加 sleep」

`BrowserMiddleware.run` 被三种脸共用：flow 的每个 `ctx.step`、声明式的每个 journey 步、规划脸的每个子目标各调一次。在执行器入口/出口加间距会：
1. 与 flow 的 `paceBeforeStep`、声明式的循环 sleep **叠加成双倍间距**；
2. 破坏三处已统一的「**首个单元之前不等**」语义（skip-first）；
3. 把「单元」语义搅混（flow 的单元=ctx 调用、声明式=journey 步、规划=子目标）。

**结论：间距的应用点必须留在各脸自己的循环边界（现状已如此），要统一的只是「来源解析」。**

### 2.2 统一落点：新建 `src/support/pace.ts`（中性模块，无依赖方向问题）

```
src/support/pace.ts
  export const STEP_DELAY_ENV  = "AMBERFLOW_STEP_DELAY_MS";
  export const ACTION_DELAY_ENV = "AMBERFLOW_ACTION_DELAY_MS";
  export interface PaceValues { between_steps_ms: number; between_actions_ms: number }
  export interface PaceSources { between_steps_ms: PaceSource; between_actions_ms: PaceSource }
  export type PaceSource = "explicit" | "meta" | "env" | "default";

  /** env 层（规划脸/online 唯一可用的来源；坏值响亮报错，口径与现 resolvePace 一致） */
  export function envPace(env: NodeJS.ProcessEnv): Partial<PaceValues>   // 只返回 env 提供的键
  /** 完整解析（app 脸用）：explicit > meta > env > 0——实现整体从 app-runner 迁入 */
  export function resolvePace(pack, opts, env): { values: PaceValues, sources: PaceSources }
  /** 单元间等待 helper（三脸共用；skip-first 由调用方负责——各脸循环语义不同） */
  export async function paceSleep(ms: number): Promise<void>
```

- `app-runner.resolvePace` 改为**转口**（re-export + 兼容签名），现有调用点与导出面不变（`npm run check` 与既有消费方零感知）。
- `planner.ts` / `online/runner.ts` 只 import `envPace`——**engine → support 方向**，无环。

### 2.3 各脸接入（每脸 3-6 行）

| 脸 | 接入点 | 语义 |
|---|---|---|
| **planner.runPlan** | 子目标 while 循环：非首个子目标前 `paceSleep(gap)`；`runSubgoalWithRetries` 的**重试之间**同样 `paceSleep(gap)`（重试是最容易再撞限速的时刻） | 单元 = 子目标（含其全部动作尝试） |
| **online/runner.ts** | 调 `runSubgoalWithRetries` 的循环处同样接入（用例间/重试间） | 单元 = 用例子目标 |
| flow / 声明式 | **不改**（已是统一来源的消费者；只换 import） | 单元 = ctx 调用 / journey 步 |

- 来源：仅 env 层（规划脸无 pack/meta；`meta.pace` 仍是应用脸专属）。文档写明「规划脸节奏 = env-only」。
- **mw 构造补 `actionDelayMs`**（动作间间距）：`plan-cli.ts`、`commands/plan.ts`、`start.ts`、`online/runner.ts` 四处构造 `BrowserMiddleware` 时传 `envPace().between_actions_ms`——否则规划脸只有子目标间距没有动作间距。
- 报告可见性：`plan run` 输出加一行 `pace: between_steps=3000(env) between_actions=0(default)`（非零才打；来源标注纪律与 `effective_policy` 一致）。

---

## 3. 修改清单（预计 ~80-120 行，含测试）

| # | 文件 | 改动 | 风险 |
|---|---|---|---|
| 1 | `src/support/pace.ts`（新） | envPace/resolvePace/paceSleep 迁入 | 低 |
| 2 | `src/app/app-runner.ts` | resolvePace 改转口（签名不变）；删本地实现 | 低 |
| 3 | `src/engine/planner.ts` | runPlan 循环 + 重试间 paceSleep；import envPace | 低 |
| 4 | `src/online/runner.ts` | 同 3（用例循环） | 低 |
| 5 | `src/cli/plan-cli.ts`、`src/cli/commands/plan.ts`、`src/cli/start.ts`、`src/online/runner.ts` | mw 构造传 `actionDelayMs` | 低 |
| 6 | `plan run` 输出 | pace 生效行（非零才打，含来源） | 低 |
| 7 | `src/support/schema-gen.ts` | **F26**：节奏 scope 契约（三脸应用点、env-only 规划脸、与正确性等待的边界） | 低 |
| 8 | `docs/APP_SCRIPT_AUTHORING.md` / `docs/STATE_LAYER_PLAN.md` | pace scope 说明；STATE_LAYER_PLAN 登记本方案 | 低 |
| 9 | 快照 | schema 改后重生成 + `schema ctx --check` | 流程 |

**不做**：不改执行器；不动 settle/poll/退避等正确性等待；不给 TaskPlan 发明 pace 字段（未来如需，走 `plan.slots` 或格式版本化，单独评估）。

---

## 4. 验收标准（A/B 实测，沿用 8 轮方法）

1. **规划脸遵守**：3 子目标 TaskPlan，`AMBERFLOW_STEP_DELAY_MS=3000` vs 无 env——预期 +6s（2 个间距）；重试注入夹具（首 attempt 必败）验证重试间也有间距。
2. **app 脸零回归**：flow 应用（`pace-check-a/b` 复跑） secs 与 W2 验收基线一致（±1s）；声明式应用（examples 01-05 的 dry + 真跑抽查）不变。
3. **默认档等价**：无 env 时 `plan run` / app run 产物与改动前逐字节对比（去时间戳）。
4. **来源标注**：`plan run` 输出的 pace 行带 `(env)`/`(default)` 来源。
5. **门禁**：`npm run check` 全绿 + 快照漂移检查。
6. **线上套件**：`npm run test -- --tier smoke`（真实站点；验证 online 路径无回归）。

## 5. 开放问题（✅ 已拍板，2026-11-05 用户决策）

1. **重试间距默认值**：✅ **与子目标间距同值**（同一 env 来源 `AMBERFLOW_STEP_DELAY_MS`，不新增 `AMBERFLOW_RETRY_DELAY_MS`；重试本来就该更保守）。已实施于 `runSubgoalWithRetries`（paceClock）。
2. **online 套件是否默认吃 env**：✅ **跟随 env + 标注**（不显式关闭）：照常读 envPace，套件结果里输出 `pace: {between_steps_ms, source, total_waited_ms}`（全 0 省略 = 默认档产物不变）。
3. **`plan run` 是否也要 `--pace` CLI 旗子**：✅ **不加**（env 已够；YAGNI，留接口）。

> 实施落点见 `src/support/pace.ts`（唯一来源模块）与 F26（schema 契约）。
