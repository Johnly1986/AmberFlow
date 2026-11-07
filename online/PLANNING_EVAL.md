# 典型线上规划评估任务（planning-eval）

一个**可重复、可比较**的线上任务，用来量两项能力：**任务规划效率**（达成目标要花多少步/决策/重试/时间）
与**引擎健壮性**（状态变化、动态覆盖层、降级与失败是否结构化）。任务本身是公开演示站上的
电商选货流程（无需登录真实账号、无支付），与 `online/cases/deep/saucedemo-cart-eval.json` 对应。

## 1. 任务

**目标**：在 [Swag Labs](https://www.saucedemo.com/) 完成一次状态化选货流程——
登录 → 按价格降序排序 → 把最贵的两件加入购物车 → 核对购物车徽标 → 从购物车移除较贵的一件 →
核对徽标 → 从侧边菜单登出，最终停在登录页。

| # | 子目标 | 关键动作 | 完成信号 |
|---|---|---|---|
| 1 | 演示账号登录 | fill `#user-name`/`#password` + click `#login-button` | `css_exists #inventory_container` |
| 2 | 按价格降序排序 | select `select[data-test=product-sort-container]`（值 `hilo` 来自槽位） | `css_value_equals [sort-select, "hilo"]` |
| 3 | 加入最贵一件 | click `add-to-cart-sauce-labs-fleece-jacket` | 徽标 `1` |
| 4 | 加入第二贵一件 | click `add-to-cart-sauce-labs-backpack` | 徽标 `2` |
| 5 | 打开购物车 | click `a[data-test=shopping-cart-link]` | `url_contains cart.html` |
| 6 | 移除较贵一件 | click `remove-sauce-labs-fleece-jacket` | 徽标回到 `1` |

**结束态不变量**：停在购物车页（`cart.html`）、`.cart_item` 存在、徽标=1
（独立 oracle：`.cart_item` 计数 ≥1）。登出**不进稳定基线**——它是覆盖层动画的已知脆弱点，
作为 P7 稳健性探针单独记录（pilot 已复现）。
**为什么典型**：一次会话里同时出现表单、下拉、列表选择、异步徽标（0→1→2→1）、覆盖层侧边菜单与
跨页状态保持；每一步都能用 DOM 信号判定，不需要冻结的期望值；站点结构稳定、公开、无风控。

运行：

```bash
npm run test:validate                                    # 离线校验
npm run test -- --tier deep --case saucedemo-cart-eval   # 真实站点，--provider none 可跑纯规则档
npm run test -- --tier deep --case saucedemo-cart-eval --provider none --json
```

## 2. 评估臂（arms）

| 臂 | 形态 | 目的 |
|---|---|---|
| **A · 声明基线** | 本 case（每步命令闭集 + 值来自槽位） | 确定性下界：规划/选目标的成本应为 0 模型决策；量步数、attempts、耗时、失败率 |
| **B · 规划臂** | 同一任务改成**决策语句**：登录/排序用声明命令做前置，选货/开购物车/移除/登出只给 goal 文本（无 `target_hint`），由决策层选目标 | 量规划效率（模型挑选次数、reobserve、重试、耗时）与选择质量（`executed_actions` 实际点了什么）；需要决策源（本机 CLI 用户配置或桥的部署配置） |
| **C · 降级臂** | A 加 `--provider none`（规则档）；B 在决策源不可用时 | 验证"没有模型也能跑声明部分、需要决策的步结构化 block"，不静默降级成错误动作 |

臂 B 参考实现（仅评估用，不入仓库）保存在报告目录 `impl/ONLINE-PLANNING-EVAL/eval-saucedemo-planning/app.mjs`；
用桥 `amberflow_run`（部署决策配置）或 `amberflow_run` 等跑，取结果 JSON 的 `decisions`。

## 3. 指标（全部来自运行证据，不解析人类可读表格）

`npm run test` 的证据目录（`$AMBERFLOW_HOME/online-runs/<run-id>/` 或 `--out`）：

| 指标 | 来源字段 | 规划效率含义 |
|---|---|---|
| 通过/失败/跳过 | `summary.json` 的 `passed/failed/skipped` | 任务成功率（skipped ≠ pass） |
| 总耗时 | `cases/<id>.json` 的 `duration_ms` | 规划开销的外部观测（网络抖动需重复测量） |
| 子目标 attempts | `cases/<id>.json` 的 `subgoals[].attempts` | 重试次数 = 计划/信号质量 |
| 子目标 steps | `cases/<id>.json` 的 `subgoals[].steps` | 执行器步数 = 达成该目标的动作开销 |
| 决策方式 | `subgoals[].method` / `confidence` | `rule:match` = 0 模型决策；model=规划成本 |
| 不变量/oracle | `invariants[].held` / `oracle.ok` | 完成判定独立性（不读执行器信号） |

应用面（臂 B，`amberflow_run` 结果 JSON）另有 `decisions`：
`total_steps`、`by_method`（rule/model/reobserve/escalate）、`model_asks`、`model_steps`、`reobserve`、`escalate`、
`failed_asks`；以及 `step_traces[].executed_actions`（`desc`/`how`/`changed` 可人工核对选择质量）。

**建议的效率判据（以任务基线为参照，跨版本比较）**：

- A 臂：3 次重复全部 passed；`attempts` 除首个外 ≤1；总 steps 不超过"声明命令数 + 子目标数"；
  耗时在站点稳定后波动 < 2×；`method` 全部 `rule:match`。
- B 臂：`model_steps / total_steps` 与 `reobserve / model_steps` 直接对比；**`no_progress` = 0**；
  结束态不变量持有；`executed_actions` 的最终目标与 goal 语义一致（人工抽检 1 次/版本）。

## 4. 健壮性扰动矩阵（预期是结构化结果，不是"碰运气"）

| 扰动 | 做法 | 期望 |
|---|---|---|
| P1 预算耗尽 | 臂 B 用 `--max-steps 2` 之类小预算跑 | `budget_exceeded`/`partial`（应用面 exit 0 verified=false；套件按状态如实 failed），已执行步骤与 trace 保留 |
| P2 错误锚点 | 复制 case 把某 `data-test` 改成不存在的值 | `target_not_found`（或规则档 `no_model_runtime`）且 reason 带池快照/判别提示；失败证据 `cases/<id>-failure.png/.html` 存在 |
| P3 无模型降级 | 臂 A 加 `--provider none`；臂 B 去掉决策源 | A 仍通过；B 的决策步 `no_model_runtime`（结构化），不崩、不静默点错 |
| P4 重复稳定性 | 臂 A 连跑 3 次 | 3/3 passed（诚实记录 flake） |
| P5 声明护栏 | 变体把 `start_url` 指到 site.hosts 外 | 加载期/校验期拒绝（config/usage 错误），不会偷偷访问 |
| P6 状态漂移 | 连续运行臂 A 两次（同一账号演示站） | 第二次仍通过（购物车在会话内重置；P6 pilot = 2× passed） |
| P7 覆盖层动画（已知脆弱点） | 变体把登出放回（菜单打开 → 登出，同一子目标） | **当前基线 flaky**：3 次跑 1 次过（attempts=2）2 次失败（attempts 用尽）；诚实记 failed，作为改进项复测目标，不计入稳定基线 |
| P1 pilot | `--max-steps 1` 跑 A 臂 | exit1、结构化 `subgoal action budget used up (1 action step(s) tried)`；证据目录保留 |
| P2 pilot | A 臂副本把 add 按钮 `data-test` 改不存在 | exit1、reason 带池快照判别 + `identity recovery … hidden` 证据；`cases/<id>-failure.png/.html` 存在 |
| P5 pilot | A 臂副本 `start_url` 指向 site.hosts 外 | `test:validate` 加载期拒绝（主機不在白名单），不产生运行 |

## 5. 基线（pilot，2026-11-07，供跨版本对比）

环境：本机 headless Chromium；A 臂 `--provider none`（rules-only）；B 臂桥部署决策源（decision-service）。

| 臂 | 结果 |
|---|---|
| A 臂（稳定后） | **3/3 passed**：9.0–9.6s；6/6 子目标；attempts 全 1；总 steps 8（登录 3 + 其余各 1）；method 全 `rule:match`；invariant+oracle ok |
| A 臂（稳定前，含登出） | run1 passed 12.6s（登出 attempts=2）；run2 passed 14.2s；run3 **failed**——登出 attempts 用尽：`#logout_sidebar_link` 在菜单动画完成前不可见，池里没有，identity 回捞也拒绝隐藏元素 |
| B 臂（规划） | **失败于"移除最贵商品"步**：`no_progress`；decisions = 15 steps（rule 4 / model 9 / reobserve 8 / model_asks 20 / failed_asks 0）；模型在购物车页把商品标题/价格 div 当作移除目标，重观察 8 次后放弃，不变量 0/1 |

**评估发现（非夹具问题，保留为基线）**：

1. **覆盖层动画竞态（P7）**：侧边菜单用 transform 动画展开；"点开菜单 → 点登出"在同一子目标的两条命令里，
   第二条命令的抽池发生在动画完成前，`#logout_sidebar_link` 不在池；重试整个子目标也会撞同一时序。
   归因：菜单可见性/就绪证据与命令间隔，不是选择器问题（`#logout_sidebar_link` 是稳定 id）。
   → 基线任务去掉登出以保稳定；P7 单独作为探针，跨版本复测。
2. **规划臂选择质量**：购物车页"移除最贵商品"需要模型在多个商品行里定位对应 Remove 按钮；当前决策句子面
   容易选中不可动作的商品标题 div（点击 changed=true 但无效果），再观察 8 次后 `no_progress`。
   改进方向（目标描述/候选提示/对 div 点击的动作面约束）应在后续版本用同一任务复测，而不是改任务让它变绿。
   注意 A 臂同一步是确定性命令，passed——说明这是**决策面**问题，不是引擎动作面。

## 6. 使用纪律

- 证据写仓库外（`$AMBERFLOW_HOME/online-runs/` 或 `--out`），不提交、不当下次期望值。
- 站点不稳定/blocked 如实记 `blocked`/`unreachable`，不绕过风控；skipped ≠ passed。
- 每次引擎变更后用同一命令跑 A 臂（快、确定性），B 臂按需跑（慢、含模型）；比较指标而不是只看绿。
- 新增/修改任务：改 `online/cases/deep/saucedemo-cart-eval.json` 后先 `npm run test:validate`，再 `--headful` 实跑两次确认稳定。
