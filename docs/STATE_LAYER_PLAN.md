# 状态层（State Layer）实施方案

- 版本：v1 草案（2026-11-04），待批准后按 S1 起实施
- 依据：8 轮实验 + 本项目代码核实（锚点见 §8）
- 原则：**不动契约**（冻结计划 / 模型只投票 / 完成只认信号 / 唯一执行循环 / 危险步确认），只加基础设施。所有新增均为附加字段与可选策略，默认档不改变既有应用行为。
- 一句话：**状态 = trace 的字段、executor 的私产、三个串行钩子推进的指针。**

---

## 1. 目标与非目标

### 目标（对应 8 轮实测卡点）

| 卡点（轮次） | 本期目标 |
|---|---|
| 弹层菜单项点击必败（r2/r5/r7，r7 三段证明） | 稳定门 + stale 检测重解析 |
| pre-held 零执行 / 跨城串扰脏数据 PASSED（r4/r8） | 前进性判定 + policy 档位 |
| 弱锚假通过（r6 点 About pricing 也算过） | no_state_progress 标记 |
| fill/setRange 假成功（r6） | effect 读回内建 |
| 决策低置信 44 咨询 37 拒（r2/r3/r7） | 状态进闸门（稳定后才问） |
| judge/池视图分裂、exists-by-text 缺失（r6/r8） | 同 epoch 三面 + 语言补齐 |
| dry 校验盲区（r5/r6/r7） | check 留痕 + 静态对账 |
| 列表穷举手拼 10-24 步/城（r2/r3/r5/r8） | collect 原语 |

### 非目标
- 不改 done 语言语义（不引入 `judge.changed` 之类新谓词；前进性是引擎判定，不是用户语法）
- 不做全自动等待（settle 有界、可关、仅「脏时」等待）
- 不把站点知识写进引擎（Google/Maps 事实留在 `docs/SITE_FACTS.md`）
- 不引入并发/事件回调中断执行循环（Observer 只是传感器，钩子驱动）

---

## 2. 核心抽象与数据结构

### 2.1 数据结构（草案）

```ts
// 状态指纹：每次抽池/判定生成，engine 内部，trace 可见
interface StateFingerprint {
  epoch: number;          // 全局单调递增（每次抽池 +1）
  navEpoch: number;       // 导航代：goto/arrive/open 完成 +1
  url: string;
  readyState: "loading" | "interactive" | "complete";
  struct: string;         // 结构指纹：可动元素计数 + 角色/标签分布 hash（前进性判据）
  content?: string;       // 内容指纹（可选）：首批可动元素 label hash（诊断用）
}

// 每步状态记录：落进 step_traces[i].state（向后兼容，新增字段）
interface StepStateRecord {
  before: StateFingerprint;
  after?: StateFingerprint;
  settleMs?: number;                       // 本步等待静默耗时（0 = 无需等待）
  actions: { attempted: number; executed: number; changed: number };
  flags: Array<"done_preheld" | "no_state_progress" | "stale_satisfaction">;
  effect?: { kind: "fill" | "set_range"; before: string; after: string; applied: boolean };
}
```

### 2.2 StateCursor（唯一属主：executor）

- 位置：`BrowserMiddleware` 运行期私有对象，每个 run 开始时 reset
- 字段：`current: StateFingerprint`、`lastSettleAt`、`dirty: boolean`
- 只读投影：`ctx.runtime.epoch`（dry 桩给合成值）；其余消费者（抽池、judge、决策层、learn/induction）一律从 cursor 取当前视图，禁止自建快照来源

### 2.3 settle 原语（新模块 `src/engine/settle.ts`）

- 注入：每 page 一次 `evaluate` 装持久 MutationObserver：`window.__afQuiet = { lastMutationTs, count }`；导航后重新注入
- API：`settle(page, { quietMs=400, timeoutMs=5000 }) → { settled, waitedMs, timedOut }`
- 语义：仅当「脏」（最近一次突变 < quietMs）才等待；已静默立即返回；超时返回 timedOut=true 不抛错
- 接入点：① 抽池前（决策/act 解析）② learn capture 前 ③ done 轮询退避依据

### 2.4 前进性判定（executor 执行循环内，判定钩子）

```
progress := struct 变化 || url 变化 || navEpoch 变化
done_preheld         : 动作前 done 已成立（检测已有，落字段+策略）
no_state_progress    : attempted>0 && executed>0 && changed==0 && !progress && done 成立
stale_satisfaction   : attempted>0 && executed==0 && !progress && done 成立   // r8 串扰签名
```

处置：`meta.policy.done_preheld: "warn"(默认) | "fail" | "allow"`；`no_state_progress`/`stale_satisfaction` 进 `flags` + run summary `warnings[]`（桥摘要透出）。

### 2.5 meta.policy 新增键

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `done_preheld` | `"warn" \| "fail" \| "allow"` | `warn` | pre-held 处置 |
| `settle` | `{quiet_ms?, timeout_ms?} \| "off"` | 见下 | S2 默认 `{quiet_ms:400, timeout_ms:5000}`（仅脏时等待）；A/B 后可调 |
| `effect_readback` | `{fill?: bool, set_range?: bool}` | `{fill:true, set_range:true}` | fill/setRange 读回；不可读组件自动降级跳过 |
| `collect` | `{max_rows?: number}` | `{max_rows:500}` | collect 上限 |
| `decision_state` | `{gate: "off"\|"stable_only", context: "off"\|"delta"}` | `{gate:"off", context:"off"}` | S5 A/B 开关 |

---

## 3. 代码落点映射

| 文件 / 符号 | 改动 | 期 | 风险 |
|---|---|---|---|
| `src/engine/executor.ts` · extractElements 调用点（决策/act 解析） | settle → 指纹计算 → cursor 更新 | S1/S2 | 低（附加） |
| `src/engine/executor.ts` · `_locatorFor` 盖章（`[data-af-probe]`） | stale 检测（重查签名属性）+ 重解析重试（限 2 次） | S4 | 中（重试语义） |
| `src/engine/executor.ts` · actionability 闸门（`not-actionable-or-covered` 文案处） | 失败细节字段：bbox / 覆盖者 / 重查是否还在 | S1 | 极低 |
| `src/engine/executor.ts` · 决策 ask 路径（hintMatch/模型） | 状态进闸门（stable_only 时先 settle/reobserve） | S5a | 中（A/B） |
| `src/engine/executor.ts` · step 循环 done 判定点 | StepStateRecord 三判定 + flags | S1 | 低 |
| `src/engine/settle.ts` | 新模块（Observer 注入 + settle API） | S2 | 中（重 SPA 开销，需 A/B 定参） |
| `src/flow/signal-induction.ts` · `captureStateView` / StateView | 加 fingerprint 字段；capture 前 settle | S1/S2 | 低 |
| `src/flow/signal-induction.ts` · `WITNESS_SEL` | 增 `[aria-label]` 可见面（learn 归纳） | S4 | 低 |
| `src/app/ctx.ts` · runtime 投影 | `ctx.runtime.epoch` 只读 | S1 | 低 |
| `src/app/ctx.ts` · 新原语 | `ctx.collect({row, fields, until, dedupe})` | S3 | 中（新原语，需 dry 桩） |
| `src/app/ctx-dry.ts` | 对应桩：settle 不等待、collect 合成、**校验错误留痕** | S1/S3 | 低 |
| `src/app/app-script.ts` | 静态调用点计数（三原语）+ validation_error 扫描 | S3 | 低 |
| `src/app/app-meta.ts` + 策略面 | 新 policy 键映射与默认值 | S1 | 低 |
| `src/app/app-runner.ts` | `warnings[]` 汇总；step_traces 落 state 字段 | S1 | 低 |
| `src/app/kit.ts` · judge | `existsText(sel,text)`、`exists(sel,{visible})` 构造器 | S3 | 低 |
| `src/engine/signals.ts` · checkSignal/evalSignalOnState | `css_exists_text` 算子（locator({hasText})；池近似） | S3 | 低 |
| `src/engine/signal-ops.ts` | SIGNAL_OPS 增项（arity 表） | S3 | 低 |
| `src/engine/actions.ts` / executor op 集 | hover 原语（CDP Input，S4）；op 兼容表 | S4 | 中 |
| `src/engine/range.ts` | setRange 返回 `applied` + `accurate` | S1 | 低 |
| `src/support/schema-gen.ts` | F17（状态/epoch/settle）、F18（effect/前进性）新增；SIGNAL_SEMANTICS/预算节更新；**重生成 dist/schema/ctx.json + schema:check** | 随各期 | 低（快照流程） |
| `src/cli/commands/apps.ts` · 骨架 | policy 注释、collect 示例、settle 说明 | 随各期 | 低 |
| `tools/learn.ts` | settle + 导航 waitForLoadState + hint 池投影 | S4 | 中 |
| `integrations/dsh-bridge/src/index.ts`（first failure 摘要） | `status==="passed"` 时不输出/改述 "recovered failure" | S0 | 极低 |
| `online/cases/probe/gmaps-*.json` | 回归探针（弹层点击 / 串扰 / 滑杆） | S1/S2 | 低（probe 非门禁） |

---

## 4. 分期实施

### S0 文档/显示批（零引擎行为，随 S1 一起上）
- 内容：expand 报错首句点破类型（`count must be an object {rows|selector}, not a number`）、`ctx.url()` 首航 about:blank 说明、extract 双形式（具名 vs inline 对象）、预算模型一图流、step 级 slots 示例、桥 first-failure 显示修复
- 验收：`npm run check` 绿；骨架生成物 `apps check` VALID
- 回滚：纯文档，单 commit 可回

### S1 状态地基（约 300-400 行）
- 内容：StateFingerprint/StateCursor、step_traces.state 落盘、done_preheld policy、fill/setRange effect 读回、actionability 失败细节、run summary warnings、ctx.runtime.epoch
- 验收：`npm run check` 绿 + schema 快照漂移检查通过；online smoke/core 全绿；**回归探针 ①（r8 串扰）产出 `stale_satisfaction` 且 policy=fail 时中止**；②（r6 滑杆）返回 applied 与 accurate
- 风险：低（附加字段 + 默认 warn）；回滚：字段与策略全可关

### S2 稳定门（约 200-300 行）
- 内容：settle.ts 模块、抽池/learn/done 退避接入、`meta.policy.settle`
- 验收：Maps 弹层回归探针（r7 场景）菜单项点击从「必败」变为可判定；静态页 settleMs≈0 无感；A/B 记录 waitedMs 分布后定参
- 风险：中（重 SPA 每步最多 +timeout）；回滚：policy 一键 off

### S3 语言补齐（约 300-400 行）
- 内容：`css_exists_text` 算子 + kit.existsText、judge visible 选项、`ctx.collect` 原语、check 校验留痕 + 静态调用点对账
- 验收：Traffic 按钮（r8 innerText-only）用 existsText 可断言；collect 在 feed 上取行数 ≈ r3/r4 手拼结果且步骤 ≤5/城；**r7 式吞错脚本（try/catch 包坏 expand）apps check FAIL 并指出调用点**
- 风险：中（新原语需 dry 桩同构）；回滚：新原语独立，可移除

### S4 执行韧性（约 300 行）
- 内容：stale 重解析重试、force/坐标 opt-in、hover 原语、learn 修复（settle/导航等待/hint 池投影/WITNESS_SEL）
- 验收：r7 弹层点击在 settle+重试下通过（否则记录 actionability 细节）；hover 打开图层面板（r1 悬案）；learn 录制九宫格链路不再 3 连败
- 风险：中（行为面变化，全部 opt-in）；回滚：op/policy 开关

### S5 决策接入（实验驱动，约 200 行）
- **S5a 状态进闸门**：ask 前检查 cursor（未 settle / 池指纹未变 & 规则仍歧义 → 不重复 ask，走 reobserve/规则）；A/B 指标：ask 数、拒绝率、成功率
- **S5b 状态进模型上文**：DecisionRequest 增 `state_digest`（结构化 ≤200B：navEpoch delta、last effect、settle 状态、flags）；协议加版本字段；laya-onnx feature flag 降级跳过；A/B 指标：conf 分布 / 通过率 / 步骤成功
- 顺序：S5a 先（不改协议），S5b 后（协议演进 + A/B 验证）
- 回滚：`meta.policy.decision_state` 一键 off

---

## 5. 兼容性策略

1. **全附加**：新字段只增不改；`step_traces` 追加 `state`；result 追加 `warnings`；桥摘要容忍新字段。
2. **默认保守**：`done_preheld=warn`（不拦）、`settle` 仅脏时等待、`effect_readback` 不可读自动降级、`decision_state=off`。
3. **dry 同构**：每期必须同步 ctx-dry 桩（否则 check 盲区扩大——这是 r5/r6/r7 的教训）。
4. **schema 快照**：任何 schema-gen 改动后 `schema ctx --out dist/schema/ctx.json` + `schema:check`。
5. **配置文档**：新 policy 键同步 `src/support/config-schema.ts` 与配置示例（`npm run check` 会校验一致性）。

---

## 6. 验证与回归计划

| 层 | 内容 |
|---|---|
| PR 门禁 | `npm run check`（typecheck + schema 快照 + 配置示例一致性 + online case 校验） |
| 真实站点套件 | `npm run test -- --tier smoke/core/deep`；Maps 相关用 probe tier（非门禁） |
| 回归探针（5 个，复刻 8 轮证据） | ① r7 排序弹层点击 ② r8 跨城串扰 ③ r6 滑杆精度 ④ r1 learn 录制 ⑤ r5 expand 吞错 |
| 复验轮协议 | 每期落地后 1-2 轮：同 8 轮协议派 fresh 子代理（prompt 不变），对照基线指标 |

### 验收指标（对照 8 轮基线）

| 指标 | 基线（8 轮） | S1 目标 | S2/S3 目标 |
|---|---|---|---|
| 弹层菜单项点击 | 0/3 轮通过（r2/r5/r7） | 可判定（细节字段） | 通过（settle+重试） |
| preheld/串扰事故 | r4 盲踩 2 失败 + r8 脏数据 PASSED | 标记 100% | policy=fail 可拦 |
| fill/setRange 假成功 | 2 类（r6） | 返回 effect | — |
| 决策 ask 拒绝率 | 37/44（r7） | — | 显著下降（S5a） |
| 列表穷举步数 | 10-24/城 | — | collect ≤5/城 |
| 每轮固定摩擦（文档类） | S0 项已列 | 清零 | — |

---

## 7. 开放问题与风险

1. **settle 参数**：重 SPA 的 quietMs/timeout 需 A/B 定参；持续动画页面靠 timeout 兜底，可能拖慢极端页面。
2. **指纹噪声**：content 指纹受时间戳类文本影响；前进性默认只用 struct（结构），content 仅诊断——需在复验轮验证 struct 判据的误报率。
3. **laya-onnx**：本地模型输入 schema 可能固定，state_digest 只能进 decision-service 协议；需 feature flag。
4. **policy 膨胀**：新增键要克制（本期 5 个），后续合并/简化。
5. **learn 修复优先级**：r2-r8 无人使用 learn，投入产出比低——S4 中最后做，或按需砍掉。
6. **switchTab**（r6 新标签页）：架构级改动，不列入本期；单列为后续议题。
7. **回归探针位置**：8 轮证据应用不进仓库（AGENTS 约束），探针应用放 `~/.amberflow/reports/gmap-hotels-8cities/regression/`；仓库只加 online probe cases 最小集。

---

## 8. 证据与代码锚点索引

**实验证据**：`~/.amberflow/reports/gmap-hotels-8cities/`（round1-8 报告、FINAL-8rounds、A 批决策文件、DECISION-20261104-B-lite-declined.md）

**关键代码锚点（本会话已核）**：
- `src/engine/executor.ts`：op→可兼容集 856-861；池盖章 `[data-af-probe]` 2155；frame 门 2585-2596；actionability 文案 ~3280-3300；唯一执行循环入口
- `src/flow/signal-induction.ts`：WITNESS_SEL 308-309；captureStateView 340-358；induceSignals 209
- `src/app/ctx.ts`：validateExpandRequest 435-455（978 调用）；ctx.slots 231/850
- `src/app/ctx-dry.ts`：expand/setRange 桩 218-235；extract 桩 316-335
- `src/app/kit.ts`：judge 接口 86-141；all/any 变参 99-101；构造器 159-166
- `src/engine/signals.ts`：checkSignal 34-80；matchSelector 153-181
- `src/engine/rules.ts`：aria-label→label 别名 180-188
- `tools/learn.ts`：hint 原样 click 191；固定 300ms 196-197
- `src/support/schema-gen.ts`：F01-F16 29-44；HINT_GRAMMAR 60-67；renderSchemaCtx 208
- `integrations/dsh-bridge/src/index.ts`：first failure 摘要 582；bridge.ts 953/962
- A 批已改：`src/cli/commands/apps.ts`（骨架）、`src/support/schema-gen.ts`（F05/F15/F16）、`src/engine/executor.ts`（frame 提示）、`docs/SITE_FACTS.md`
