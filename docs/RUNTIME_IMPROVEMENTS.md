# 运行时改进计划（SPA / 真实站点）

状态：改进方向，不是现行接口契约。作者接口仍见 [AGENT_INTERFACE.md](AGENT_INTERFACE.md)。
实施进度：P0（PageState / pool ready gate / done polling / `ctx.waitFor`）、P1（失败语义分层 / recovered / logs[] / `inspect --pool` / frame + popup host gate）、P2 的 `ActionAdapter` 能力面、inline 结构化抽取、scroll / drag 命令与 online 契约用例已落地，并分别由独立子代理验证。
触发案例：Google Maps 上的昆明酒店查询（应用启动器 → Maps → 搜索昆明 → Hotels 视图 → 价格筛选 → 取评分最高的 3 家）。
本篇只记录架构层面的改进方向；不把 Google Maps 专属逻辑写进共享层。

---

## 1. 结论

真实 SPA 暴露的不是“某个 selector 不稳”，而是引擎缺少一组一等运行时语义：

- 页面状态（`PageState`）没有被统一建模；
- action 后的等待 / 稳定化依赖 app 自己写 `waitFor`；
- `ctx.step` 的导航语义和 SPA 预期冲突；
- 元素池为空、目标不存在、动作不支持、页面未稳定被压进粗粒度失败码；
- Agent 只能靠 Playwright probe、trace、源码反推引擎实际看到的页面。

目标不是把流程改回 JSON，也不是让模型生成动作；而是让引擎继续承担“一步之内”的职责，同时把等待、URL、重试、诊断能力吸收成运行时正式语义。

---

## 2. 观察到的问题

### 2.1 页面状态不是一等对象

`ctx.step` 当前同时承担语义声明、可能导航、元素抽取、目标解析、动作执行、短窗口 done 判断和证据记录。
在静态站点上可行；在 SPA 上会出现：

- 上一步动作改变了路由，但下一步的 `currentUrl` 仍是旧值；
- 引擎可能再次 `goto(startUrl)`，导致 SPA 状态丢失；
- app 只能显式传稳定 URL、剥查询串、手写导航兜底。

### 2.2 action 后的 done 窗口太短

Google Maps 的渲染经常需要 1–3 秒，而引擎当前的动作后完成窗口很短。
结果是：

- 元素池短暂为 0；
- command space 立刻 `space_empty`；
- 页面其实会到达目标，但 step 已被判失败；
- app 需要 `waitFor(signal)`、`navStep()`、transient retry 等样板逻辑。

### 2.3 元素池和 label 缺少规范化契约

真实 UI 会出现：

- icon-only button 的 label 是私有区图标字形，例如 `\ue8baHotels`；
- 可见文本、aria-label、图标 glyph 的优先级不一致；
- pool 里的候选信息不足以解释“为什么没解析到目标”。

这会让 `ctx.hints("Hotels")` 这类自然目标在页面上明明存在却匹配不到。

### 2.4 失败码太粗

`space_empty` / `action_space_exhausted` 不能区分：

- 页面还没 ready，元素池为 0；
- pool 有元素，但目标不存在；
- 目标存在但歧义；
- 动作类型不支持；
- action 已执行但 done 一直不成立。

Agent 因此要做额外实验才能定位。

### 2.5 证据面不够自助

报告里可能出现某 step `failed action_space_exhausted` 但整体 `passed`。
这通常是瞬态失败被后续 settle / retry 救回，但当前报告没有“recovered”状态。
Agent 需要读 trace、result、report，甚至源码，才能判断结果是否可信。

### 2.6 动作能力面不足

价格筛选等控件是 slider / drag-only，而当前动作集基本是 click / fill / select。
引擎无法在早期表达“控件存在但当前动作集无法操作”，只能在流程后段失败。

### 2.7 数据抽取太依赖 app 手写解析

复杂列表卡片文本形状不稳定：sponsored 广告、同名重复项、图标行、无价格项都会出现。
app 手写 parser 可以工作，但结构化抽取、去重、字段证据应该是引擎观察层的能力，而不是每个 app 重写。

### 2.8 host / frame 边界需要复核

Google apps 面板实际渲染在 `ogs.google.com` iframe 里。若 app 只声明了 `google.com` 相关 host，
而引擎能操作该 iframe 中的元素，说明 host gate 可能只覆盖顶层页面。
安全边界应覆盖顶层页面、frame、popup 和 new tab。

---

## 3. 目标架构

```text
app flow(ctx)
   ↓ 语义意图 / 完成信号
ctx facade
   ↓
FlowRuntime
   ↓
PageStateStore
   ↓
TransitionEngine
   ↓
Probe / PoolView
   ↓
ActionAdapter
   ↓
SignalEvaluator
   ↓
EvidenceRecorder
```

核心思想：app 继续只写流程意图和完成信号；引擎内部把页面状态、等待、重试、观察和证据做成一致语义。

---

## 4. P0：修正 SPA 基础语义

### 4.1 PageState 一等化

引擎应显式维护类似：

```ts
interface PageState {
  pageId: string;
  url: string;
  frameOrigins: string[];
  readiness: "navigating" | "loading" | "interactive" | "settled";
  poolVersion: number;
  observedAt: number;
}
```

规则：

- `ctx.openPage()` / `ctx.arrive()` 是显式导航入口；
- `ctx.step()` 默认在当前 PageState 上执行，不再隐式整页重载；
- `ctx.step({ url })` 表示“确保到达该 URL”，不是无条件 `goto`；
- action 后必须统一更新 PageState；
- trace / report 使用 landed URL，而不是只记 start URL。

### 4.2 action → transition → settle → done 管线

不要用固定短窗口判断 done。每个 action 后应走统一管线：

```text
action
  → transition detected?
  → page settling
  → element pool refresh
  → done signal polling
  → final evidence snapshot
```

`done` 信号应轮询到 timeout，而不是短窗口一次判断。
可以考虑：

```ts
interface TransitionPolicy {
  minSettleMs: number;
  maxSettleMs: number;
  poolNotEmpty: boolean;
  urlStableMs?: number;
  domQuietMs?: number;
  donePollMs: number;
  doneTimeoutMs: number;
}
```

### 4.3 元素池 ready gate

导航后、command 解析前，先等元素池非空或稳定：

- pool 为 0 时不要立刻报 `space_empty`；
- 先报 `page_not_ready`，并带 `pool_size` / `waited_ms`；
- 超时后才失败。

### 4.4 `ctx.waitFor` 成为一等能力

```ts
await ctx.waitFor(signal, { timeoutMs: 20000, pollMs: 400 });
```

这样 app 不需要自写：

```ts
while (Date.now() < deadline) {
  if (await ctx.holds(sig)) return true;
  await sleep(400);
}
```

---

## 5. P1：失败语义与恢复

### 5.1 拆分失败码

| 现在的问题 | 应表达为 |
|---|---|
| 页面刚加载，元素池为 0 | `page_not_ready` |
| pool 有元素，但目标不存在 | `target_not_found` |
| 多个候选无法唯一 | `target_ambiguous` |
| 控件存在但动作不支持 | `action_unsupported` |
| action 已执行但 done 不成立 | `done_not_held` |
| frame origin 不允许 | `frame_not_allowed` |

失败结果应带上下文：

```json
{
  "code": "target_not_found",
  "pool_size": 12,
  "waited_ms": 700,
  "url": "https://...",
  "target": "Hotels",
  "candidates": []
}
```

### 5.2 分离瞬态重试和语义重试

引擎默认处理运行时瞬态：

- SPA 元素池从 0 变非 0；
- stale ref；
- URL 正在变化；
- done 信号未稳定；
- overlay 正在消失。

app 决定业务语义重试：

- 搜索失败后换关键词；
- 页面没有目标项后换路径；
- 数据不足时滚动或改条件。

关键原则：**引擎可以自动恢复“页面没 ready”，但不能自动伪造业务完成。**

---

## 6. P1：可观察性和证据面

### 6.1 canonical evidence

canonical run evidence 应包含：

- 每个 step 的 before / after PageState；
- pool size；
- command 解析结果；
- decision method / confidence；
- action attempts；
- transient failures；
- recovery；
- `ctx.log()`；
- final invariants；
- screenshots / DOM excerpt。

### 6.2 recovered 状态

如果某个 step 先 transient failed，后续信号成立，整体 passed，报告应表达：

```text
step 3 transient_failed -> recovered_by_settle
整体 passed
```

不要只显示：

```text
step 3 failed action_space_exhausted
整体 passed
```

### 6.3 bridge / CLI 摘要直接带诊断

`amberflow_run` / `amber run --json` 摘要应包含：

- 关键 `ctx.log`；
- 每步 final URL；
- 每步 pool size；
- command 解析结果；
- 失败候选；
- recovered 状态。

目标是让 Agent 不需要读 trace 文件和源码也能回答“为什么失败”。

---

## 7. P1：元素池和 hint 视图

### 7.1 PoolView 契约

元素池应输出可解释视图：

```ts
interface PoolElemView {
  ref: string;
  tag: string;
  role?: string;
  ariaLabel?: string;
  visibleText: string;
  normalizedLabel: string;
  hintCandidates: string[];
  actionCapabilities: ("click" | "fill" | "select" | "slider" | ...)[];
  frameOrigin: string;
  bounds: { x: number; y: number; w: number; h: number };
  blockedBy?: string[];
}
```

label normalization 应集中处理：

- aria-label 优先；
- 可见文本 fallback；
- 私有区图标字形剥离；
- Unicode normalization；
- icon-only button 语义；
- hidden / disabled / overlay blocked 状态。

### 7.2 `inspect --pool`

建议提供引擎视角的只读观察：

```bash
amber inspect --url ... --pool
```

输出：

- engine 实际看到的元素；
- label / hint candidates；
- command target 是否可解析；
- pool 数量；
- frame origin；
- 不支持动作的控件。

这可以替代 Agent 自建 Playwright probe。

---

## 8. P1：host / frame 安全边界

host allowlist 必须覆盖：

- 顶层页面；
- 所有 frame；
- popup；
- new tab；
- action 所在元素的 frame origin。

不满足时应返回 `frame_not_allowed` 或 `host_not_allowed`，并在 trace 中记录 `frameOrigin`。
不能只检查顶层 URL。

---

## 9. P2：动作适配器与结构化抽取

### 9.1 ActionAdapter

当前实现位于 `src/engine/extraction.ts`：`ActionAdapter` 是能力面，
`ACTION_ADAPTERS` 是 click/fill/select/check/slider 的注册表；
`PoolView` 与 `inspect --pool` 通过 `actionCapabilities(e)` 投影同一个能力面。

动作不应继续内联扩散，而应显式声明能力：

```ts
interface ActionAdapter {
  kind: "click" | "fill" | "select" | "check" | "slider" | "scroll" | "drag";
  canApply(elem: Elem): boolean;
  apply(loc: ActionLocatorLike, opts?: { value?: string; timeoutMs?: number }): Promise<[string, unknown]>;
}
```

这仍然不让模型自由生成动作；只是让动作空间可声明、可检查、可解释。
slider / drag-only 控件应在 inspect 阶段表达 `action_unsupported`，而不是流程后段才失败。

### 9.2 结构化抽取

复杂列表应支持 app 声明结构化抽取，而不是手写整段 parser：

```ts
const hotels = await ctx.extract({
  scope: 'div[role="feed"] a[href*="/maps/place/"]',
  fields: {
    name: "heading",
    rating: "rating",
    price: "price"
  },
  maxItems: 50
});
```

引擎负责观察与字段证据；app 负责业务解释，例如去重、排序、过滤 sponsored。
这样仍保持“脚本管业务，引擎管观察”。

---

## 10. 回归测试架构

不新增单元测试层；继续用 `online/` 真实站点套件验证架构契约：

- SPA 元素池延迟渲染；
- action 后 URL 变化；
- action 后 DOM overlay；
- icon-only label；
- frame origin host gate；
- transient failure recovery；
- 结构化列表抽取。

这些应从“偶然发现”变成 `online/` 中的显式契约用例。

---

## 11. 不做的事

- 不恢复 JSON 步骤文件 / 静态步骤表；
- 不让模型生成动作或完成结论；
- 不把 Google Maps 专属逻辑写进共享引擎；
- 不用固定 sleep 伪装 ready；
- 不通过 app-side retry 掩盖引擎语义缺口；
- 不伪造价格筛选、排序结果或页面状态；
- 不放松危险动作和 host/frame 安全边界。

---

## 12. 落地顺序

1. **P0：SPA 基础语义** —— 已落地，独立子代理验证通过
   - PageState；
   - `ctx.step` 导航语义；
   - pool ready gate；
   - done 轮询；
   - `ctx.waitFor`。

2. **P1：诊断闭环** —— 已落地，独立子代理验证通过
   - 失败码分层（`page_not_ready` / `target_not_found` / `target_ambiguous` / `action_unsupported` / `done_not_held`）；
   - recovered 状态；
   - evidence / trace / bridge summary；
   - `inspect --pool`。

3. **P1：安全边界** —— frame gate 与 popup/new-tab gate 已落地，独立子代理验证通过
   - frame origin 的 host gate；
   - popup / new-tab 的 host gate；
   - PageState 记录 frameOrigins（含 popup）。

4. **P2：表达力** —— ActionAdapter 能力面、inline 结构化抽取、scroll / drag 命令已落地，独立子代理验证通过
   - ActionAdapter 能力面；
   - native `input[type=range]` 可由引擎 `fill` 驱动；
   - `ctx.extract({ rows, fields, maxItems })`；
   - `ctx.command("scroll", target)`；
   - `ctx.command("drag", source, { from:"slot", key:"destSelector" })`。

5. **持续：在线回归** —— 已开始，独立子代理验证通过
   - `online/sites/the-internet.json`；
   - `online/cases/core/the-internet-nested-frames.json` 验证跨 frame 信号；
   - 后续可继续补 popup / scroll / drag 的真实站点用例。
