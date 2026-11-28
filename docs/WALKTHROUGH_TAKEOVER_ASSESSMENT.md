# 走查全流程画像与「决策模型主驾 / Agent 副驾」可行性研判

> 状态：**研判稿**（2026-11-27）。来源：项目方命题——把走查分解成「用户提示词 + 指令闭集 + 参数闭集」的流程图，
> 据此研判决策模型完全接管走查的可能性，并由产品经理与架构师双视角推演。
>
> 证据基线：本仓 `src/app/pilot-*`（驾驶面）、`src/engine/decision-*`（决策内核）、
> `integrations/dsh-bridge/src/session-contract.generated.ts`（桥面闭集）、
> `$AMBERFLOW_HOME/pilot/*/pilot-trace.jsonl`（**64 份有轨迹的驾驶运行，其中 54 份产生了实际动作，
> 合计 150 次驾驶动作**）。
> 文中所有数量均为代码常量实测值或轨迹统计值，不是估计。
>
> **修订注记（同日）**：本研判定稿后，同会话又落地两项（详见 `CHANGELOG.md`）——模型显式弃权
> 出口（`decision.choice` v2：answer none → 交接 `model_abstain`）与闸门缺省 0.25→**0.5**
>（本文涉及缺省值处已同步更正）。两项均不改变本文结论与 §7 优先级表。

---

## 0. 结论速览

| 问题 | 判定 |
|---|---|
| 决策模型能否接管走查的**单步控制流** | **已经接管**。每轮一次闭集 pick，规则未解时才发生。 |
| 决策模型能否接管**多步计划** | **目前不能**——不是模型能力不够，是**契约缺失**：pilot 只有 `final_signal`（终局信号），没有步级 `done`（局部完成判据）。 |
| 「完全接管」的真实含义 | **模型拥有计划，引擎拥有证明**。计划权可交，裁决权（done / 停因 / 安全 / 预算）不可交。 |
| 距离「主驾 + 副驾」还差什么 | 三处架构缺口 + 一处实现缺陷（按修复优先级倒序见 §5.2）。 |

一句话：**当前架构已经完成了单步接管，卡点是「没有步级反馈回路」和「失败作用域过大」这两件事，
而不是模型不够聪明。**

---

## 1. 走查全景流程图

### 1.1 三层视图

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L0 人/Agent 输入层：用户提示词                                            │
│   goal（一句话总目标）+ final_signal（完成判据）+ hosts（导航信封）        │
│   + expect_url（任务页约束）+ max_steps（预算）+ slots（预声明值）         │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │  一次 drive 请求
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ L1 驾驶循环层（PilotRuntime.drive，每轮 = 一个驾驶步）                    │
│                                                                          │
│   ┌─ 轮首守卫 ──────────────────────────────────────────────────┐        │
│   │  信封守卫 host_not_allowed → 任务页守卫 off_task_page        │        │
│   │  最终信号 checkSignal(final_signal) → final_signal_held      │        │
│   └──────────────────────┬───────────────────────────────────────┘        │
│                          ▼                                               │
│   ┌─ 单步决策（详见 1.2）───────────────────────────────────────┐        │
│   │  抽池 → resume 点名 → 规则先行 → 模型投票 → 闸门 → 恢复阶梯  │        │
│   └──────────────────────┬───────────────────────────────────────┘        │
│                          ▼                                               │
│   ┌─ 执行 + 判定 ────────────────────────────────────────────────┐        │
│   │  affordance 族决定动作类型 → 执行 → changed/inert 记账        │        │
│   │  步尾再判信封 → anti-repeat 计数                             │        │
│   └──────────────────────┬───────────────────────────────────────┘        │
│                          ▼                                               │
│         ┌────────── 无停因 ──────────┐    ┌──── 停因（12 码闭集）────┐   │
│         │ 回到轮首（消耗 1 步预算）   │    │ 投影交接块 → 等副驾指令   │   │
│         └────────────────────────────┘    └───────────┬────────────┘   │
└───────────────────────────────────────────────────────┼────────────────┘
                                                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ L2 副驾回路层：交接块 + 4 指令闭集                                        │
│   handoff { stop_code, step_id, goal_digest, why_stuck{summary,evidence}, │
│             what_would_unblock[≤3], evidence_refs{四件套}, url,           │
│             weak_picks?, final_signal }                                  │
│                          │                                               │
│        ┌─────────┬───────┴────┬──────────┬─────────┐                     │
│        ▼         ▼            ▼          ▼         ▼                     │
│     resume    redirect     finish      abort    （无人应答 → idle 超时）  │
│   hint/value  goal/url   signal 验证    落轨迹                            │
│   /target/skip                                                        │
│                          │                                               │
│        回到 L1 下一轮（注意：resume 不重置预算，redirect 清步史不清预算）  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.2 单步决策的内部流程（模型真正被咨询的那一次）

```
抽池（settle 门 → 候选窗口 64 → 分桶配额）
  │
  ├─ resume.hint 在队？──是──→ hintMatch 唯一命中 → 确定性执行（零模型调用）
  │                            ├ 多命中且互不包含 → target_ambiguous（只停不选）
  │                            └ 零命中 → 记 resume_hint.missed，继续往下
  │
  ├─ 规则先行（navRule → affordanceRule）
  │    └── 命中 → 执行（零模型调用）★ 规则档是主路径的一部分，不是兜底
  │
  └─ 模型投票 pickInner
       ├ ready() → rulesOnly? → 停 no_model_runtime（侧合规，不装会抛的 runtime）
       ├ 候选数 > MAX_CHOICES(200) → 停 decision_service_choice_limit
       ├ [S5 缺省关闭] 池指纹+goal+notes 相同 → 复用上次答复（asks_saved）
       └ provider.pick({goal, page, elems, forbidden, notes, k:8})
            └ 回 { choice: "eN", confidence, probabilities }
                 │
                 ▼
            置信闸门 floor = max(0.10, confFloor − 0.05 × 已禁选数)   // confFloor 缺省 0.5
                 │
       ┌──── 过闸 ────┐                    ┌──────── 不过闸（恢复阶梯四档）────────┐
       ▼              │                    ▼                                       │
   执行并验证          │        ① 宽扫重问（64→128，池必须真变大才问）              │
                      │        ② 硬顶重问（128→256，同样要求增长）                │
                      │        ③ 升级票（更强推理者，只能点名已展示过的候选）      │
                      │        ④ 裁决票（低置信也执行，让本步 DOM 信号事后裁决）   │
                      │                 └── 四档全失败 → 停 low_confidence        │
                      │
       旁路：R2b 词面守卫（提名与指令零词面重叠 = 自信地错 → 强制宽扫重问）
             族修复（提名的动作族与期望族不符 → 只在该族内重解析）
```

### 1.3 「完全接管」在流程图上的位置

模型目前掌握的是**菱形判断**（选哪个分支分支），不掌握**方形的边界**：

```
        ┌─────────────── 模型可接管（计划权）───────────────┐
        │  选哪个元素 / 要不要换个思路 / 这步算不算完成      │   ← 第 3 项现在缺失
        └────────────────────────┬──────────────────────────┘
                                 │
        ┌────────────────────────▼──────────────────────────┐
        │  引擎不可交出（证明权）：                          │
        │    · done / final_signal 的判定（完成只认信号）     │
        │    · 12 码停因的判定（确定性闭集，模型不自请兜底）  │
        │    · 危险动作的 default-deny 与人类确认             │
        │    · 预算与导航信封                                 │
        └───────────────────────────────────────────────────┘
```

**这张图就是判定的全部依据**：计划权可以给模型，证明权不能给。中间缺的那一项
「这步算不算完成」正是当前 pilot 面没有的东西——它只有终局 `final_signal`，
所以模型无法在一段子流程内部做增量纠偏，只能一路走到停因。

---

## 2. 闭集清单（唯一出处，可逐条核对）

> 纪律：以下每个数字都从代码常量读取，新增条目必须先改真源再改文档（`prompt-hit` 同源校验）。

### 2.1 指令闭集

| 层 | 闭集 | 数量 | 真源 |
|---|---|---|---|
| 会话请求类型 | `open / goto / observe / act / read / extract / waitFor / signal / snapshot / mark / tab / drive / driveCommand / driveStatus / driveClose / close` | **16** | `session-runtime-contract.SESSION_REQUEST_TYPES` |
| 桥面会话 op | 同上（`waitFor`→`wait_for`，另加 `list`，无 `mark`） | **16** | `BRIDGE_SESSION_OPS` |
| 会话 act op | `click / check / fill / select / hover / scroll / set_range` | **7** | `SESSION_ACT_OPS` |
| 兜底指令 | `resume / redirect / finish / abort` | **4** | `PILOT_AGENT_COMMANDS` |
| 驾驶者档 | `model / agent` | **2** | `BRIDGE_DRIVE_DRIVERS` |
| 应用命令 op | `click / check / fill / select / scroll / drag / hover / skip / upload / clickAt` | **10** | `COMMAND_OPS` |
| 跳页动作 | `list / switch` | **2** | `BRIDGE_TAB_ACTIONS` |
| 滚动目标 | `bottom / top / page` | **3** | `BRIDGE_SCROLL_TARGETS` |
| 歧义策略 | `fail / act` | **2** | `BRIDGE_AMBIGUITY_MODES` |

### 2.2 判定闭集

| 层 | 闭集 | 数量 | 真源 |
|---|---|---|---|
| 驾驶停因 | `final_signal_held / budget_exceeded / off_task_page / host_not_allowed / unreachable / config_error / low_confidence / target_ambiguous / needs_value / stuck_inert / no_model_runtime / browser_dead` | **12** | `PILOT_STOP_CODES` |
| 完成信号算子 | `url_contains / css_exists / css_exists_text / css_visible_exists / css_text_equals / css_text_contains / css_value_equals / css_count_equals / css_count_min / all_of / any_of / not / manual` | **13** | `SIGNAL_OPS`（`grammar-prompt` 双向自证） |
| 元素定位形状 | `#id / tag[attr~substr] / tag~token / tag[attr=value] / 角色词 / 裸词` | **6** | `HINT_SHAPES` |
| read 面 | `text / value / count / attr` | **4** | `BRIDGE_READ_WHATS` |
| 上文层 | `L0 / L1 / L2 / L3 / L4` | **5** | `decision-ask-contract.DecisionLayer` |
| 询问种类 | `pick / risk / done` | **3** | `DecisionQuestionKind` |

### 2.3 参数闭集（数值边界）

| 参数 | 取值 | 缺省 | 出处 |
|---|---|---|---|
| `max_steps` | 1–200 | **12** | `PILOT_DEFAULT_MAX_STEPS` / `BRIDGE_DRIVE_LIMITS` |
| `conf_floor` | 0–1 | **0.5** | `DEFAULT_CONF_FLOOR` |
| 候选窗口 | 64 / 128 / 256 | 64 | `POOL_CAP_ELEMENTS` / `WIDE_SCAN_POOL_ELEMENTS` / `_MAX` |
| 决策服务选项上限 | 200（服务侧 255） | — | `MAX_CHOICES` |
| 连续 inert 阈值 | 3 | 3 | `PILOT_INERT_LIMIT` |
| 死目标重复阈值 | 3 | 3 | `PILOT_REPEAT_LIMIT` |
| 步史摘要 | ≤6 步 / 每步 ≤40 字 / URL ≤120 字 | — | `DECISION_HISTORY_STEPS` |
| 交接摘要 | `summary` ≤400 字、`evidence` ≤2KB、`what_would_unblock` ≤3 条 | — | `PilotHandoff` |
| 稳定门 | quiet 400ms / timeout 5000ms | 开 | `SETTLE_QUIET_MS` / `SETTLE_TIMEOUT_MS` |
| 会话 idle TTL | 1000–86400000ms | 300000 | `BRIDGE_SESSION_IDLE` |
| 桥单 op 读超时 | 1000ms 起 | **60000** | `BRIDGE_SESSION_TIMEOUTS.opDefaultMs` |
| 并发会话 | 1–8 | 2 | `BRIDGE_SESSION_CONCURRENCY` |

### 2.4 用户提示词的形状

走查的「用户提示词」不是自由文本，它是**参数化的五元组**：

```jsonc
{
  "goal":         "一句话总目标（进入 L0，每轮带当前页与已执行步史渲染）",
  "final_signal": { /* 13 算子之一，或组合 */ },   // 缺省 = 无信号收尾（预算内推进 + 连续 inert 即停）
  "hosts":        ["..."],                        // 缺省 null = 不设防；声明即信封
  "expect_url":   "/maps",                        // 缺省 null = 不判；只写稳定路径片段
  "max_steps":    12,
  "conf_floor":   0.5,
  "slots":        { "k": "v" }                    // 值只从这里或 resume.value 来
}
```

**模型看到的 L0 文本**由 `drivingGoalText` 单源渲染：

```
<goal> | 当前页: <url≤120> | 已执行: 1.<target>40字[changed]; 2.<target>[no_change]; …
```

步史带 `changed / no_change / failed` 三种 outcome 是刚需——模型必须能看出「点了但页面没变」，
否则空点击会被当成进展继续复读（Google apps / Settings 连点实测）。

---

## 3. 主驾/副驾的职责边界（依流程图判定）

| 环节 | 现在归谁 | 应该归谁 | 差距 |
|---|---|---|---|
| 选下一个元素 | 规则优先，模型补位 | 同 | ✅ 已达成 |
| 判定这一步完成 | **无人**（只有终局信号） | 模型提名 + 引擎校验 | ❌ **核心缺口** |
| 判定整体完成 | 引擎（`checkSignal`） | 引擎 | ✅ 不可让 |
| 判定停因 | 引擎（确定性闭集） | 引擎 | ✅ 不可让 |
| 决定是否兜底 | 引擎（停因触发） | 引擎 | ✅ 模型不自请 |
| 兜底时给什么 | Agent（hint/value/redirect） | Agent | ✅ 已达成 |
| 兜底后回主驾 | 引擎（resume 即回） | 引擎 | ⚠️ 见 §5.2 缺陷 A |

**结论**：5 项已达成、1 项不可让、1 项缺失（步级 done）。「完全接管」的唯一实质缺口是第 3 行。

---

## 4. 产品经理研判

### 4.1 承诺成立的条件（三缺一不可）

用实测数据划出的窄带：**决策服务可用 + 观察面暴露任务所需状态 + 单步反馈在数秒内**。

- 第 1 部分（首页九宫格 → Maps）：2 次提问、3.9 秒，正落在窄带内 ✅
- 三类反例：
  1. 403 出现一次后「主驾」被整体换下，之后 4 轮接管、约 20 次提问只换来 1/3 个筛选——
     **「模型不可用」被当成「模型无用」**；
  2. 三个弹层互斥、评分按钮时有时无，池子看不见这个状态，13 次操作换 1 个筛选（7.7%）；
  3. 15 次点击占 460s（94%），读面板文本拿到过期快照，反过来制造 `low_confidence`。

后两条与模型无关，却都被记成「模型不行」。**Maps 已经是最好走的站点，走查仍只过一半，
所以「主驾」只能是带前置检查的条件默认**：条件缺一，产品必须明说已降级。

### 4.2 用户价值排序

**跑通且可直接落地 > 可解释 > 可复现 > 快 > 省人力**

- 走查的产出物是 `app.mjs`。跑通却不产出脚本 = 演示，所以前两项合并置顶。
- 可解释排第二：本次失败同时混着引擎缺陷（30.6s）、产品事实（弹层互斥）、权限（403），
  分不清就无从修。
- 快是门槛（94% 已破门槛），省人力是结果——放太前会让产品去优化「少打扰」，
  最终做出一个静默失败的机器。

> 取舍：**宁要一次大声失败并说清原因，也不要安静地「通过」。**

### 4.3 副驾介入策略

原则：**介入状态，不介入步序**；介入预算由调用方预先声明。

| 项 | 设计 |
|---|---|
| 触发条件 ① | 只接**决策歧义类**停因（`low_confidence` / `needs_value` / `target_ambiguous`）——人只提供值或更准的定位 |
| 触发条件 ② | **环境类**停因（403 / `no_model_runtime` / `browser_dead`）**不进副驾**，直接终止并给修复动作。「20 次提问」的根源就是把 403 交给了人 |
| 触发条件 ③ | 同一目标连续 2 次同一停因才升级 |
| 频率 | 按**子目标**计，不按步计。1 目标 2 次提问是健康形态；4 次接管 / 20 次提问 = O(步数)，病态 |
| 回主驾 | 介入必须由**页面信号确认已生效**；人给的提示落成锚点，同一提示第二次生效即提升进脚本——一次输入变成可复用资产 |

**判据**：副驾介入量应当是 **O(站点歧义)**，不是 **O(步数)**。如果每次都要人点名，
它就不是副驾，是一个要人不停下指令的遥控器——此时产品应显式标注「已降级为辅助模式」。

### 4.4 必须砍掉或降级的

1. **403 后一次性降级为规则兜底**——它让运行「看起来还在跑」，实际已退化成人肉操作，
   最终仍只做出 1/3 个筛选。改成硬停 + 修复指引。
2. **作者侧只留三样**：目标、完成信号、停因 + 一句修复建议。16 个会话 op / 12 个停因 /
   6 种定位形状 / 13 个算子收进高级面板；停因按**补救动作**归并（缺值 / 元素不明 /
   页面无反应 / 环境故障——`low_confidence` 与 `target_ambiguous` 对用户是同一个动作）。
3. **完成信号收成 3 个预设**，其余进高级。
4. **单步加 ≤3 秒硬预算**，砍掉 460s 的尾巴。
5. **使命收窄**：只在声明过的 `hosts` 清单内；不做通用网页 Agent。

### 4.5 验收指标

| 指标 | 定义 | 目标 |
|---|---|---|
| **落地率** | 产出且能被**零介入重放**通过的 `app.mjs` 占比（同时度量跑通与可落地） | ≥70% |
| **介入税** | 副驾介入次数 / 成功子目标；同流程二次走查应为 0；介入/操作 | ≤0.5、<0.3 |
| **时序** | 单步 p95；非有效动作耗时占比（现状 94%） | ≤3s、<20% |

---

## 5. 架构师研判

### 5.1 判定：单步已归模型，缺的是步级契约

- **控制流：单步已归模型，尚未归模型的是多步计划、子目标分解、停案权。**
  这里缺的是**契约**不是能力：pilot 只有 `final_signal`，没有步级 `done`，
  所以模型给不出「这段子流程做完了吗」的判断，出错后也无从增量纠偏。

> 边界一句话：**模型拥有计划，引擎拥有证明。**

### 5.2 瓶颈排序

| # | 项 | 性质 | 说明 |
|---|---|---|---|
| 1 | **降级作用域** | 架构瓶颈 | 失败域是「一次 ask」，后果域却是「整个 run」，且不可恢复。一次 403 让驾驶永久退化成要人点名。这是作用域设计错误，不是 bug |
| 2 | **缺步级判定** | 架构瓶颈 | 四档阶梯只在「换大池」「换强问者」上加码，没有「重述问题」这条轴；裁决票只能裁 target，裁不了 step |
| 3 | **观测层无法归因** | 架构瓶颈 | `low_confidence` 混装三种情况：模型不确定 / 页面确实没有 / 池根本没抽到；抽池与读面异常被静默吞掉，「没看到」与「不存在」无法区分。纯文本 criteria 也让模型无法表达「先展开再选」 |
| 4 | **30s 空 catch** | 实现缺陷 | 460/490s 与 60s `bridge_timeout` 同源；因为吞掉错误，「点击成功」与「读文本失败」无法区分。**但修复顺序应排第一**——其余三项的度量都建在它上面 |
| 5 | 闸门/窗口参数、S5 缺省关闭 | 调参/保守默认 | 不是瓶颈 |
| 6 | 产品事实（互斥弹层） | 不可改，应吸收 | 互斥弹层就是前置条件，时有时无就是 availability，都不该用置信度表达 |

### 5.3 三处改动

**① 熔断单位从 run 改为 ask，按失败域分级 + 半开探测**

- 认证类（401/403）立刻带类型停因 + 一行修法；瞬时类（超时/DNS/5xx）才降级，且只作用于该步。
- 熔断打开后冷却结束先单次探测；`rulesOnly` 从全局布尔改为 pick / escalate / judge **各自带时效**的状态。
- 代价：失败面变大、探测会抖动、403 反复敲须退避。
- 验证：打桩三类失败，断言 403 在 N 步内带类型停且不翻转整个 run、超时后 K 步恢复、
  健康态下两套账本的 ask 次数零漂移。

**② pilot 增加步级 `done`，阶梯增加第 5 档「重述题面」**

- 每个 leg 用一个闭集 `done`（模型提名、引擎校验）；裁决票从裁 target 扩到裁 step。
- 在终局以前允许模型回答 `no_valid_target + blocking_precondition`，
  以「显式否定禁选集 + 拆子目标」重写再问一次。
- 代价：信号面必须保持闭集、弃权会掩盖真卡死、每 leg 的 ask 次数需要硬顶。
- 验证：第 2 部分的 4×`low_confidence` 应转成**有名字的前置条件**；第 1 部分 2 ask / 3.9s 不得退；
  走 `verify:pilot` 停因矩阵。

**③ 候选池改为结构化，置信与 affordance 解耦**

- criteria 从 `link "Maps" -> /maps` 升为结构字段（family / visible / disabled /
  aria-expanded / in-popover / attempted），由池侧预先算出互斥弹层的激活态。
- 并把 `low_confidence` 拆出 `precondition_unsatisfied`。
- 代价：请求体变大、池抽取更贵（**须先修 ④，否则新字段都按 30s 计费**）。
- 验证：ask / endpoint parity 白名单；第 2 部分 A/B 看 ask 与 `low_confidence` 增量；
  `verify:rule-vocab` 防站点词泄漏。

### 5.4 反模式警告

| 反模式 | 连锁后果 |
|---|---|
| **降低闸门换通过率** | 把「不确定」换成「执行错元素」；完成只认信号，错误会被推迟到更贵的停因才暴露；错 pick 填满禁选，阶梯永远走不到 1–4 档；最贵的是**标定信号被销毁**，之后分不清是「模型不行」还是「闸门挡了」 |
| **对 403 重试 / 换 provider / 用 S5 缓存冒充恢复** | 撞风控；旧池 ref 打进已变的 DOM 引发 `target_not_found` 雪崩；看起来跑成功，但证据不再追溯活决策。诚实停在 `no_model_runtime` 是特性 |
| **让模型产出 hint / 动作** | 破坏 6 形状闭集，引入提示注入面，危险动作失去干跑锚点，证据不可重放。变体：调大 `max_steps` 遮停因（只得到 `partial + verified=false`）、在 30s 黑洞里加预算（只是把黑洞乘大） |

### 5.5 最脆弱的单点

**不是模型也不是浏览器，是观测层。** 规则和模型都只在「本轮池子」上决策，
池子漏抽就意味着**永远不可能对**，而观测失败被静默等价成「不存在」。
第 2 部分的 4 次 `low_confidence` 里，模型不确定 / 页面没有 / 池没抽到这三种情况无法区分。

> **只加一个护栏**：停因前置观测体检。任何停因都必须携带 `pool_size`、
> `truncated`、抽取异常计数、visibility 摘要；**观测异常时禁止判 `low_confidence`**，
> 先重抽或扩池，并把体检结果写进交接 `evidence`。

---

## 6. 推演

### 6.1 三条演进路线

| 路线 | 内容 | 判定 |
|---|---|---|
| **A 只修缺陷**（保守） | 修 30s 空 catch + 403 硬停。模型能力不变 | 走查能跑完第 2 部分吗？——**不能**。弹层互斥时模型仍会 `low_confidence`，但至少 460s 的浪费消失、403 不再静默降级 |
| **B 补步级 done + 熔断分级**（推荐） | A + §5.3 ①② | 模型获得增量纠偏能力，`low_confidence` 可转成有名字的前置条件；副驾介入从 O(步数) 降到 O(歧义) |
| **C 结构化池 + 全面接管** | B + §5.3 ③，并把 criteria 变成结构化事实 | 收益最大但成本最高，且**必须以 B 为前提**——池抽取本身只要 30s，结构化字段越多越贵 |

### 6.2 反事实推演：如果这次走查按 B 路线重跑

| 环节 | 现状（实测） | B 路线预期 |
|---|---|---|
| 第 1 部分 | 2 ask / 3.9s ✅ | 不变（不得退化，是回归基线） |
| 慢动作 | 本任务的 4 次接管共 **371s 动作时间，其中 12 次慢动作占 367s**（99%） | 慢动作降到 1.5s 后 ≈**22s**，动作时间降 **94%** |
| 403 | `/maps` 后全程降级，4 轮 20 ask | 第 1 步就带类型停因 + 修法，**0 轮浪费** |
| 三个筛选 | 只成功 1 个，全部 `low_confidence` | 弹层互斥转为 `precondition_unsatisfied`（有名字），模型可先 `expand` 再选；若仍不通，**停因可读** |
| 副驾介入 | 每步都要我点名（O(步数)） | 只在歧义处介入（O(歧义)），且 hint 落成锚点 |

**关键判断**：B 路线不能让第 2 部分「一定成功」——互斥弹层是**产品事实**。
但它能把「说不清的失败」变成「说得清的失败」，这是产品价值排序里第二位的「可解释」。

### 6.3 与既有实测的一致性校验

- **第 1 部分 3.9s / 2 ask**：来自运行 `mwxjo9x7-146487`——`Google apps` 485ms、
  `Maps, row 1 of 6 …` 3400ms，两次都是 model pick（`conf` 0.68 / 0.82），合计 3.885s。
  说明**冷启动正常时，单步人工可接受**：动作本身几百毫秒到 3 秒，模型往返不构成瓶颈。
- **模型往返的真实成本**：`mwxjov54` 12 次驾驶墙钟 229s、动作 155s，非动作部分 74s
  ≈ **6.2s/次**（模型咨询 + 桥往返 + 抽池 settle）。它是第二位的成本，
  远小于 12 次慢动作的 367s——**先修黑洞再谈降延迟**。
- **规则档确实分担了一部分**：`mwxjov54` 12 次驾驶里 model pick 10 次、rule pick 2 次；
  `mwxk6kel` 5 次全部 model pick。规则档是主路径的一部分但不是多数路径，
  「规则先行零模型」这个卖点只在命中时兑现。
- **4×`low_confidence` 的 conf 值 0.21 / 0.22 / 0.26 / 0.27**：**闸门拒得对**，
  因为模型当时选的是 `MenuSearchDirections` 这类跑偏目标（同批运行里它能连续两次选它）。
  这与架构师判定的「不许降闸门换通过率」完全一致。
- **`no_model_runtime` 出现在第 12 步**（`mwxjov54`）：前 10 次驾驶全部是 model pick
  （conf 0.21–0.79 正常产出），第 11、12 次转为 rule pick，随后一步停 `no_model_runtime`。
  **注意证据强度**：该 run 的 trace 只有 `drive / handoff / command` 三类行，**没有降级原因字段**
  （`pilot` 面不落 `provider_degraded`，`pilot_end` 行也未写入）。所以「403 导致退化」是
  「doctor 探针 403 + 行为形态（model pick 突然改用规则档）」的**合取推断**，不是单条硬证据。
  但这恰恰是 §5.2 第 1 条瓶颈的另一面：**降级连痕迹都留不全**——P1 建议里的
  「停因前置观测体检」应当同时覆盖决策面降级事实。

---

## 7. 建议动作（按证据强度排序）

| 优先级 | 动作 | 依据 | 验收 | 状态 |
|---|---|---|---|---|
| **P0** | 修 `_panelText` 的 `locator.evaluate` 缺 timeout（连带 `hitRelation` / `_readActionabilityDetail` / `_lockStampIsLive`） | 94% 动作时间；见 §7.1 最小复现 | 元素卸载时快照 ≤2s 返回；新增 lane 锁定该不变量 | **✅ 已实施**（见 §7.2） |
| **P0** | 403 硬停 + 带类型停因，不再一次性翻转 `rulesOnly` | 4 轮 20 ask 全废 | 打桩 403：N 步内停且整个 run 不翻转 | 未开始 |
| **P1** | 停因前置观测体检（§5.5 唯一护栏） | `low_confidence` 三义混装 | 停因必带 `pool_size/truncated/异常计数` | 未开始 |
| **P1** | pilot 步级 `done` + 阶梯第 5 档「重述题面」 | 缺步级反馈回路 | 第 2 部分 `low_confidence` → 有名字的前置条件 | 未开始 |
| **P2** | 熔断改 ask 级 + 半开探测 | 降级作用域 | 三类失败打桩 + ask 次数零漂移 | 未开始 |
| **P2** | 结构化候选池（family / visible / in-popover） | 弹层互斥不可表达 | A/B 看 ask 与 `low_confidence` 增量 | 未开始 |

### 7.2 P0-① 实施记录（已落地并自证）

**改动面**（4 文件 + 1 lane）：

| 文件 | 改动 |
|---|---|
| `src/support/tuning.ts` | 新增 `ELEMENT_EVAL_TIMEOUT_MS = 1500`（进 `TUNING_VALUES` 门禁表） |
| `src/engine/executor-types.ts` | `AnyLoc.evaluate` 增加可选第三参 `opts?: { timeout?: number }` + JSDoc 说明默认 30s 的坑 |
| `src/engine/executor.ts` | `_panelText` / `_readActionabilityDetail` 显式传 `{ timeout: ELEMENT_EVAL_TIMEOUT_MS }` |
| `src/engine/executor-actionability.ts` | `hitRelation` 同上 |
| `src/engine/executor-resolve-b.ts` | `_lockStampIsLive` 同上 |
| `tools/verify-element-eval-timeout.ts`（新）| lane：5 组断言（快路径毫秒级 / 卸载后限时返回 / scope 如实退回 / 动作语义不变 / 稳定目标对照） |

**lane 正向结果**：

```
PASS ① 正常元素面板取证是毫秒级 — 13ms
PASS ② 元素已卸载时 snapshot 在窗口内返回 — 1511ms（窗口 4000ms）
PASS ③ 卸载后 snapshot_scope 如实退回 document — document
PASS ④ 点完即卸载自己的按钮点击仍成功 — ok=true changed=true
PASS ④ 整步耗时落在窗口内（含动作后取证）— 2268ms
PASS ⑤ 稳定目标点击正常且明显快于窗口 — 288ms
verify-element-eval-timeout: OK
```

**反向验证（关键）**：把 `_panelText` 的 timeout 临时改回不传，同一 lane 立刻变红：

```
FAIL ② 元素已卸载时 snapshot 在窗口内返回 - 30010ms（窗口 4000ms）
FAIL ④ 整步耗时落在窗口内 - 30764ms
verify-element-eval-timeout: 2 FAILED
```

这证明 lane 真的能拦住这个回归，而不是一个恒绿的摆设。

**回归面**（全部绿）：`npm run check` 全链、`verify:lanes`（**22 条**，新 lane 已接入）、
`verify:pilot`（30/30）、`verify:runtime:offline`（8/8）、`verify:offline`（15 夹具）、
`verify:parity`、`verify:decision-run-parity`（16/16）。新 lane 同时进了 `package.json` 的
`verify:lanes` 链与 `AGENTS.md` 的 lane 清单（条数 21→22）。

**一处按仓库纪律做的改动说明**：`AnyLoc` 原本在纯搬移 manifest
（`tools/golden/splits/executor-middleware-pure.json`）里。给它加可选参数是**有意的非纯搬移**
（契约新增能力就是本批交付物），按 `split-check.ts` 文件头写明的纪律——「hash 不一致时把该
符号从 manifest 删除并在 PR 说明」——已删除该项并在 manifest `note` 里记录原因。

**预期效果**：本任务 4 次接管的动作时间 371s → 约 22s（慢动作按 1.5s 计），降幅 94%；
同时消除 30.6s × N 累积越过桥 60s 读超时（`bridge_timeout`）的那条路径。

**真实站点现场复测**（同一 Maps 餐厅结果页，`All filters` / `Done` 交替各点三轮——
正是历史上 15 次 30.6s 里的同一批目标；两轮独立测量取后一轮，前一轮 3.7s/2.7s/3.0s/2.1s 同量级）：

| 目标 | 修复后耗时 | 结果 |
|---|---|---|
| `All filters` | 3682ms | ok / changed |
| `Done` | 2738ms | ok / changed |
| `All filters` | 2994ms | ok / changed |
| `Done` | 2052ms | ok / changed |
| `All filters` | 2048ms | ok / changed |
| `Done` | 2089ms | ok / changed |

**30.6s → 2.0–3.7s**（含 Maps 自身约 1.5s 的重渲染开销，且首轮最慢、后续稳定在 2s 附近）。
剩余耗时是页面真实代价，不再有"等 30s 默认超时"的黑洞。

---

### 7.1 P0 缺陷的最小复现（已在本机跑通）

```
click ok=true 68ms
evaluate(no timeout) after detach: 30002ms  err=locator.evaluate: Timeout 30000ms exceeded.
evaluate({timeout:1500}) on missing element: 1500ms
```

一个按钮点了自己卸载（`element.remove()`），随后对它做**无 timeout** 的 `locator.evaluate`：

- 点击本身 68ms 成功——与实测「15 次慢动作全部 `changed:true`」一致；
- `evaluate` 等了 **30002ms** 才抛 `Timeout 30000ms exceeded`，而 `_panelText` 的
  `catch { return null }` 把这个错误**静默吞掉**，于是整步只表现为「慢了 30 秒但成功了」；
- 显式传 `{ timeout: 1500 }` 时，同样的失败情形 **1500ms** 返回。

这就把「30.6s 是页面慢」彻底排除：它是 Playwright 的默认超时 `DEFAULT_PLAYWRIGHT_TIMEOUT = 3e4`
落在一条**没有传 timeout 的 `locator.evaluate`** 上。修法：给 `AnyLoc.evaluate` 加可选 options，
`_panelText` 传 `{ timeout: 1500 }`——语义不变（原本读不到就 `catch` 成 null），只把 30s 的黑洞
收成 1.5s 的诚实失败。

---

## 8. 一句话总结

**「决策模型完全接管走查」在当前架构下是可能的，但「完全」必须限定在计划权上。**

已经接管的是单步选择（规则未解时才发生，实测冷启动 2 ask / 3.9s）；
尚未接管的是**步级完成判定**——这是契约缺失，补上就是 B 路线；
不可让渡的是**证明权**（done / 停因 / 安全 / 预算），让渡即丧失可验证性。

而当前最该先做的三件事，**没有一件是让模型更聪明**：
修那个 30 秒的黑洞、让 403 大声失败、给停因加观测体检。
产品与架构在这一点上完全一致：**先把「说不清的失败」变成「说得清的失败」，
再谈接管。**

**落地进度**：三件里的第一件已实现并自证（§7.2）——元素级只读求值限时，
现场复测 30.6s → 2.0–3.7s，配一条能反向变红的 lane。剩下两件（403 硬停、观测体检）
仍按 §7 的优先级表排队，**逻辑闭环已完成，实施按 P0→P1→P2 递进**。
