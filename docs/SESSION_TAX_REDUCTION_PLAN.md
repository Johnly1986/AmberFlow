# 会话操作税削减方案（盲测复盘：135 → ~70 次操作）

> 来源：一次 fresh-context 盲测（DSH 子代理经 `amberflow_session` 完成航班列表侦察任务，
> 135 次操作、64 次 observe、25 次 extract、17 分钟自收敛）。本文对该复盘的 10 条接口
> 局限逐条做代码级核实，给出改进方案与划界。既有 A1–A5/B 组清单沿用其编号，
> 本文新增 S 组条目与之对接。
>
> 一页结论：引擎会话面 5 条属实（S1–S5），其中 #6 并入 S2（缺的是空值判别不是能力）；
> 编排面 4 条（#7–#10）划界到 DSH 调度器，本仓库仅确认既有对接口（O1）。
> 三项主改（S1+S2+S3）预计把重复轮询税砍半，估算以实测为准。
>
> 编号纪律：S 组是本方案新设条目号；"对接 A1–A5/B 组"指的是**复盘侧改进清单**的
> 编号（同会话产出，不在仓库），与本仓库 task-34 的批次号（A2=歧义停、A4=落空判别、
> B2=滚动语义）**不是同一套**——引用仓库既有批次时本文一律写全称（如"与 E5 同纪律"）。

## 0. 逐条核实（判断 × 代码证据）

| # | 复盘判断 | 核实 | 关键证据（符号锚点） |
|---|---|---|---|
| 1 | 滚动容器无 CSS 寻址（中） | **属实** | 合成目标闭集 `SCROLL_SYNTHETIC_TARGETS` 仅 `document/body/html/window`（`src/app/ctx-validate.ts`）；scroll 的池外回退面是**角色闭集**（`executor-resolve-b.ts` `_domFallbackResolve`：`[role='feed']/[role='list']/main…`），无 role 无 id 的类名容器（`div.flight-list`）零寻址途径；`ctx-runtime.ts` `scrollRowsContainer` 已有"行选择器 → 最近可滚动祖先"完整实现（含逐 frame 探测、` frame:` 尾缀信封），**未暴露成原语**——只在 `ctx.collect` 循环内部消费 |
| 2 | 懒渲染无稳定读（高） | **属实** | `ctx-read.ts` `readRows` 是 extract/collect 唯一实现：字段读失败一律 `catch → value=""`，无行级 rendered 面；`session-runtime.ts` `rowsSettled`（E5）只判**行数**两次连读相等，骨架节点匹配即计为稳定行。空行（`{"row":""}`）与未渲染不可区分 |
| 3 | act 无导航事实（中） | **属实** | `doAct` 成功响应的 `url` 是动作后**即时**快照；`probe_navigated:true` 只在非 timeout 异常且 URL 已变的路径出现（B1），与 SPA 异步导航竞速无覆盖。代理被迫 `waitFor` url 轮询（两次超时）+ `tab list` 兜底 |
| 4 | 行锚漂移无引导（低） | **属实** | A4 `diagnostics`（candidates/near/rejected）是**当次**池事实；无"本会话内该 target 最近命中过"的历史提示 |
| 5 | 侦察面被 snapshot 架空（形态） | **属实** | 桥 `element-view.ts` 按池序投影截断；`observe` 无 offset 是既有刻意决策（元素序随水合漂移，无稳定锚）。设计的"observe → 抄 hint_candidates"主路径在列表页被 `pool-N.json` 文件侧渠道替代 |
| 6 | read nth-child 钻取脆弱（小） | **并入 #2** | `fields` 的 cellSel 本就是任意 CSS 直接喂 locator——`div:nth-child(4) span` 形态**已支持**；缺的是空值与未渲染的判别面，与 #2 同根 |
| 7–10 | 编排面（单轮异步/自由文本报告/无预算/无提问通道） | **划界成立，仓库边界修正** | 桥只做"拼 CLI、解析 envelope、投影有界摘要"（AGENT_INTERFACE §3）；预算已有（`timeout_sec`/`max_steps`/`idle_timeout_ms`）、结构化结果已有（run 的 JSON envelope `schema_version`）、过程可见已有（session 逐行 JSONL + `--record` 轨迹 + snapshot 落盘）。缺口在 **DSH 调度器的 dispatch API 形态**，不在引擎/桥 |

**不是缺陷的边界（复盘已划对，维持）**：hint 六形状闭集 + `ref` 非 act 地址（可验证性取舍）；
`waitFor`/`extract` 的诚实空与诚实超时；fresh-context 重踩已知坑正是税率测量的价值。

## 1. 方案

### S1 滚动原语的行容器寻址（对接复盘①，并入 A1 组）

**形态**：会话 `act scroll` 新增显式 `rows` 字段——`{"op":"scroll","rows":"<css>","to":"bottom"}`
（`to`/`by` 语义不变，`rows` 与 `target` 互斥，同时给 = `config_error`）。

**语义**：匹配 `rows` 的元素 → 最近可滚动祖先 → 滚动。执行面**复用**
`ctx-runtime.ts` `scrollRowsContainer`（既有唯一实现，含 frame 探测与信封口径），
不改它的返回契约；`to:"bottom"` 时有界循环（≤50 轮）滚到 `atBottom`，
`by`/`to:"page"` 单步，`to:"top"` 置 0。

**边界纪律**：
- **不扩 hint 六形状闭集**——`rows` 是滚动语义的显式第二参数（与合成四名并列的
  第三种 target 形态），不进 `parseHint`，不给它出 `hint_candidates`；
- 失败沿用既有闭集：找不到行 = `target_not_found`（reason 点名 rows 选择器）、
  行在但无可滚容器 = `not_scrollable`——**不新增 stopCode**；
- `moved`/`delta`/`scroll` 证据与 B2 同口径（实测）；
- `--record` 记 `scroll_mode:"rows_container"` + `rows`；`session export` 还原为
  注释块 + `ctx.scrollList` 骨架提示（新原语面在 export 生成物可用前不发明动作）；
- **run 面零改动**：`ctx.scrollList`/命令步 `scroll`/`scrollDocument` 产物逐字节不变。
  （后续可选：`ctx.scrollList(target, { rows })` 应用面投影，另行立项。）

**验收**：缺省（不带 `rows`）响应键集与既有逐字节一致；fixtures 静态页 +
真实站点 core tier 各一条容器滚动用例；`npm run check`。

### S2 extract 的稳定读与空行事实（对接 A3，本轮最高税）

**形态**：extract 请求可选 `waitSettled:true`（缺省不出现 = 行为不变）；响应
additive 两键。

**语义**：
- `waitSettled:true` 时走 `rowsSettled` 的**双指标增强版**：行数 **与** 空行数
  （单次 evaluate 内联统计"匹配行中 innerText 为空的行数"，一次往返）连续
  2 轮相等才抽；有界窗口（600ms × 5 轮）超窗**如实回** `settled:false`，
  不静默放行也不无界等（与 E5 同纪律）；
- 响应恒带事实字段 `blank_rows`（本页所有字段为空串的行数）——**不猜骨架**：
  只报"有几行是空的"，是否未渲染由代理结合 `settled`/`scroll_settled` 判读；
- 行内容仍原样返回（空行返回空行的语义不变），变的是判别面。

**边界纪律**：`readRows` 不动（dry/replay/collect 零影响）；`settled:false`
不是失败，抽取照常发生（读到的就是此刻事实）。

**验收**：缺省键集不变；懒加载列表页实测 blank_rows 随滚动收敛为 0；
`npm run check`。

### S3 act 的同标签页导航事实（对接 A5）

**形态**：act 请求可选 `navProbeMs`（整数 100..3000，缺省不出现 = 行为不变）。

**语义**：动作**成功**后在窗口内以 100ms 间隔轮询 `urlOf(page)`，与动作后
即时值不同 → 响应 additive 三键 `same_tab_navigation:true, nav_from, nav_to`
（`nav_to` 以最后观测值为准，附 `probe_ms` 实测）；窗口内未变 →
`same_tab_navigation:false`。失败路径不探测（失败现场证据已有）。

**边界纪律**：只报事实不判完成——`same_tab_navigation` 不是 done 信号，
与 `waitFor`/`signal` 不冒充；成本 opt-in（缺省零额外等待）；`probe_navigated`
（异常路径）语义不变，两键互斥出现；桥透传三键；record 记导航事实一行。

**验收**：缺省逐字节不变；预订点击场景 `changed:false` 但 `nav_to` 落新 URL；
`npm run check`。

### S4 行锚漂移的最近命中提示（对接 A4 增量）

**形态**：SessionRuntime 内存 `recentResolutions`（LRU ≤20：`target → {actionSeq, op, how}`）。

**语义**：`target_not_found` 时若同 target 在 ≤10 个动作内命中过 →
`diagnostics.recently_resolved:{steps_ago, last_op, last_how}`，`reason` 尾行
追加"该 hint 曾在 N 步前命中（op=…, how=…）；行内容可能已变，建议重新 observe"。

**边界纪律**：纯内存零页面往返；只陈述事实不自动重试；run 面/命令步不接该
提示（会话 authoring 面专属）；键集 additive。

**验收**：展开后 in-row 失配场景多一行提示；无历史时不出现该键。

### S5 观察面截断的内容密度优先（对接 A2，P2 观察项）

**形态**：桥 `element-view.ts` 投影在**截断发生时**优先保留"带唯一
`hint_candidates` 的行"，池序本身仍是事实（只影响显示截断的选择，不影响
引擎 observe 的返回与键集）。

**纪律**：引擎 observe 不动（无 offset 决策维持）；先经 `prompt-hit`
bridge_desc 组观测现状占比，再定排序键；投影多一行 `order_note` 说明
"截断按可抄抄性优先"。**列为 P2**：snapshot 兜底已可用，属形态问题非功能缺口。

### O1 编排面划界（对接复盘②）

#7–#10 的实施面在 **DSH 调度器**，本仓库不改动。既有对接口确认：

| 复盘缺口 | AmberFlow 已提供 | DSH 侧待决 |
|---|---|---|
| 过程不可见 | session 逐行 JSONL（每请求一响应）、`--record` 轨迹、snapshot/pool 落盘 | dispatch 是否改为长任务走 session 面或 attach 只读投影 |
| 自由文本报告 | run 的 JSON envelope（`schema_version`）、result/report 工件 | 结果 schema 校验回执（可选 JSON Schema 参数） |
| 无预算 | `timeout_sec`（1..7200）/ `max_steps` / `idle_timeout_ms` | dispatch 入参是否透传预算 |
| 无提问通道 | `needs_human`/`needs_value` 结构化停因、会话可中途 `close` | 中途提问的产品形态 |

唯一可选的本仓库贡献：桥工具描述里显式指引"长任务用 session 面替代单轮
dispatch"（描述面已有该能力表述，属提示词调优，随 S 组实施一并观测）。

## 2. 实施顺序与操作税预估

```
S2（最高税：25 次 extract 重试的主因） → S1（64 次 observe/滚动绕行的主因）
→ S3（waitFor 轮询 + tab 兜底） → S4（一次试错） → S5（P2 观察项）
```

- S1/S2/S3 全在会话面（`session-runtime.ts` / `ctx-runtime.ts` / `ctx-read.ts`），
  同一批提交可共用 fixtures 静态页验证回路；
- 每条独立成提交，缺省路径逐字节不变是硬门；
- 操作税：135 → ~70 为**估算**（observe 轮询 −60%、extract 重试 −50% 来自复盘
  自报），以下次同型任务实测复核——把"税率下降"写成验收观测项而不是承诺。

## 3. 非目标（红线）

- 不扩 hint 六形状闭集（`parseHint` 唯一解析器不动；S1 的 `rows` 是滚动专属
  第二参数，不是 hint 形态）；
- 不改 run 面任何产物（`ctx.scrollList`/命令步/`scrollDocument` 逐字节不变）；
- 不新增 stopCode（S1 复用 `target_not_found`/`not_scrollable`，S2/S3 是事实字段）；
- 不猜"骨架/未渲染"——只报 `blank_rows`/`settled` 事实，判读权在调用方；
- `observe` 不加 offset（元素序无稳定锚的既有决策维持）；
- DSH 编排面（#7–#10）不在本仓库实施；
- 不新增运行时依赖。

## 4. 实施状态（2026-11-18）

S 组四条已全部落地（每条独立提交，缺省路径逐字节不变均以 `npm run check` 全绿验证）：

| 条 | 提交 | 实施要点 |
|---|---|---|
| S2 | `39bb2fb` | `rowStatsAnyFrame`（frame-scope）单次 evaluate 拿行数+空行数；`extract` `waitSettled:true` 双指标稳定门（行数与空行数连续 2 轮相等）；响应恒带 `blank_rows` |
| S1 | `7d8d388` | `scrollRowsBase` 模块级统一实现（步进/绝对两模式）；`act scroll` `rows` 参数（与 `target` 互斥）；`to:"bottom"` 有界循环 ≤50 轮到 `atBottom`；`scroll_mode:"rows_container"` 进轨迹 |
| S3 | `23f06ef` | `act` 成功路径 `navProbeMs`（100..3000ms）轮询同标签页 URL；`same_tab_navigation` + `nav_from`/`nav_to`；record 留 `nav_probe` 事件行 |
| S4 | `ccd99d3` | 会话内 LRU（≤20）；`target_not_found` 且同 hint ≤10 动作内命中过 → 独立键 `recently_resolved` + reason 尾行（不覆盖引擎 A4 `diagnostics`） |
| 门禁合规 | `730777f` | scroll 执行体拆 `session-act-scroll.ts`、稳定判定/S3 探测/S4 LRU 移 evidence 模块（主文件与 doAct 回到存量基线内）；split manifest 移除非纯搬移符号 |

- 手册同步：`docs/INTERACTIVE_SESSION.md` 新增四节 + 分页节交叉引用。
- S5（桥投影截断 `order_note`）维持 **P2 观察项**：snapshot 兜底已可用，待下次编排面
  对接实测再决定是否实施。
- O1 维持划界不变；"长任务用 session 面"的桥描述提示词调优随 S 组实施一并观测。
- 操作税验收：以下次同型任务实测复核（observe 轮询与 extract 重试的下降是
  **观测项**，不是承诺）。
