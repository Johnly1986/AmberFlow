# 梯队 A（v2）落地实施文档（可执行版）

- 版本：v1.0（2026-11-03）· 依据已采纳的推荐方案（D1–D6；设计过程文档已归档，实施所需细节均在本文件内）
- 位置：本文档位于仓库 `docs/`（随仓库版本化）；**实施证据与审查记录按仓库纪律写仓库外** `$AMBERFLOW_HOME/goal-runs/impl2/`（不提交）。
- 决策状态：**按推荐方案执行**（D1=分桶配额默认 + policy 回退；D2=forceAct opt-in；D3=新增三个 ctx 原语；D4=通用范围控件实现；D5=默认窗口不变 + MAX_CHOICES=200 安全帽；D6=只提示不自动回退）
- 基线：HEAD `c47fc37`（工作区干净）；`npm run check` 全绿（typecheck/config/schema/prompt-hit/secret-scan/examples-check/test:validate 均过，实测 2026-11-03 08:41）
- 执行模式：**每项一个独立实施子代理 → Lead 审查（diff + check + 针对性/真站验证）→ commit**；本文件是逐项可照做的实施清单与验收标准。
- 不做：站点专有选择器进引擎、反爬绕过、新应用格式、模型提示词业务知识、URL filter hack。

---

## 0. 提交序列总览

| # | commit 信息 | 依赖 | 预估 | 主要文件 |
|---|---|---|---|---|
| 1 | `A4: 引用盖章唯一化（nonce + 唯一性校验 + 清理）` | 无 | 0.5d | extraction.ts、executor.ts、app-runner.ts、scripts/ |
| 2 | `A1: 动作执行证据与 done 诚实性（executed/skipped/forceAct/inert）` | A4 建议先行 | 1–1.5d | executor.ts、ctx.ts、ctx-dry/replay、app-runner.ts、playbook、schema |
| 3 | `A2: 候选分桶配额、命令可行动优先、hint 可寻址与窗口透明化` | A1（证据字段）+ A4 | 1.5–2d | extraction.ts、rules.ts、executor.ts、inspect.ts、grammar/prompt、playbook |
| 4 | `A3: 列表展开与范围控件原语（expand/scrollList/setRange）` | A1+A2 | 2–3d | ctx.ts、ctx-dry.ts、ctx-replay.ts、executor.ts、engine/range.ts、schema、docs |
| 5 | `A5: 决策面通道引导（doctor 缺省探针 + 403 恢复指引）` | 无 | 0.5d | doctor.ts、run.ts、decision-provider.ts、bridge 描述、docs |
| 6 | `收尾: 文档/CHANGELOG/schema/示例与验收报告` | 1–5 | 0.5d | docs、CHANGELOG、examples、impl2/review-log |

**落地门禁**：每个 commit 前必须 `npm run check` 绿；涉及 schema 的改动须重生成快照（`src/support/schema-gen.ts` / `npm run schema:check`）；涉及示例的跑 `npm run examples-check`；行为变更（A2）跑 `npm run test -- --tier smoke`（可选 core）。

**约定**：
- commit 格式 `A<n>: <一句话>`（沿用上一批）。
- 每项证据落 `~/.amberflow/goal-runs/impl2/evidence/<item>/`（命令输出、真站 run result/report、截图可选），review 记录写 `impl2/review-log.md`。
- 默认行为保持（除 A2 排序，CHANGELOG 标「行为变更」并提供 `meta.policy.candidate_priority:"main-first"` 回退）。
- 新增公开面（ctx 方法/选项/字段）必须同步：类型、ctx-dry、ctx-replay、schema、docs、playbook。

---

## 1. A4 引用盖章唯一化 —— 实施清单

### 1.1 改动
**`src/engine/extraction.ts`**
1. `EXTRACT_JS`（PASS_EXTRACT 内，盖章段，约 :525–533）：
   - 提取开始处（扫描后、盖章前）清旧章：`try { document.querySelectorAll('[data-dshref]').forEach(e => e.removeAttribute('data-dshref')); } catch {}`；
   - 生成 nonce：`const nonce = 'af' + ((globalThis.__afStamp = (globalThis.__afStamp | 0) + 1));`
   - 盖章值 `const stamp = nonce + '-' + ref;`；`setAttribute('data-dshref', stamp)`；返回行里 `dsh_ref: stamp`（`ref` 字段保持 `eN` 不变，内部 forbidden/日志语义不变）。
2. `hintLookup` 的 JS（约 :640）：同法清 `[data-hintref]` + nonce（`hn<nonce>-h<n>`），返回 `hint_ref: hstamp`。
3. 常量注释更新：解释 nonce/清理的目的与开销（一次全页 querySelectorAll）。

**`src/engine/executor.ts`**
1. `_locatorFor`（约 :1491）：
   - 对 `dsh_ref`/`hint_ref` 选择器：`const n = await loc.count(); if (n === 1) return loc; if (n > 1) { record ref_collision diagnostic; /* fall through to scan */ }`
   - `>1` 时不得返回该 locator；继续走 id/name/type/scan 回退；最终 `null`（动作层按 stale_ref）。
   - 诊断：在 trace/stop reason 增 `ref_collision: [data-dshref="af3-e12"] matched 2 elements; fell back to scan`（含匹配计数与 fallback 结果）。
2. 动作层 `_locatorFor` 返回 null 时现有 stale_ref/forbid 逻辑不变。

**`src/app/app-runner.ts`**
- run 收尾（browser close 之前）best-effort 清理两类属性：`page.evaluate(() => { document.querySelectorAll('[data-dshref],[data-hintref]').forEach(e => { e.removeAttribute('data-dshref'); e.removeAttribute('data-hintref'); }); })`，失败吞掉（不影响结果）。

**新增开发脚本 `scripts/ref-stamp-collision.mjs`（或 `tools/` 同名）**
- `chromium.launch → page.setContent()` 构造两阶段 DOM（阶段 A 元素 X 在位置 2；阶段 B 插队元素使 X 换位），调用 `extractElements(page)` 两次，断言：
  - 每次盖章后 `querySelectorAll('[data-dshref]').length === 池大小`；
  - 旧 nonce 章不命中（`[data-dshref^="af1-"]` 的 count 与预期一致）；
  - 用 `[data-dshref="<stamp>"]` 定位唯一（count===1）。
- 输出 PASS/FAIL 与计数；不联网、不开真站。

### 1.2 验证
```
node scripts/ref-stamp-collision.mjs
npm run check
```
真站复核（可选，记录证据）：Maps 酒店列表 `lead-scrollloop` 型临时应用，修复后同一锚点滚动 ≥50 卡（对照 R14 副本 22→50）；trace 无多命中。

### 1.3 回滚
- 单 commit revert；nonce 属性无外部契约。若性能异常，保留「提取前清章」即可（nonce 可退化为 `eN`）。

### 1.4 审查清单
- [ ] 多命中不再返回 locator（有单测脚本证据）；[ ] forbidden/ref 语义未被 nonce 改变；
- [ ] 清理发生在每次提取前与 run 收尾；[ ] 默认产物字段不新增/不变形；[ ] `npm run check` 绿。

---

## 2. A1 动作执行证据与 done 诚实性 —— 实施清单

### 2.1 数据结构（先改类型，逐层透传）
`src/engine/executor.ts`：
```ts
interface TraceStep {
  // 既有 …
  after?: { url: string; pool_size: number; first_text: string | null }; // 单动作步用已有 post 快照补
  changed?: boolean;                       // pre/post 快照是否变化
  skipped?: boolean; skip_reason?: string; // 解析到但未执行
}
```
`src/app/ctx.ts` `StepResult` 增（全部可选）：
```ts
executed?: boolean;
executed_actions?: Array<{ op: string; target: string | null; ref: string; how: "clicked"|"filled"|"scrolled"|"dragged"; desc: string; changed: boolean }>;
skipped_actions?: Array<{ command_id?: string; target: string | null; ref?: string; reason: string; detail?: string }>;
done_preheld?: boolean;
warnings?: string[];
```
`src/app/app-runner.ts`：`step_traces` 投影同步（补字段，缺省省略）；`result`/report.md 增小节「动作执行证据」（executed / executed_actions 表 / skipped 表 / done_preheld 警告）。

### 2.2 执行器改动
1. **命令解析记录**：命令空间 walk（~:2196–2245）中，凡是 `resolved but forbidden` / 动作阶段 `not-actionable-or-covered|stale_ref|action_unsupported|needs_value` 的候选 → 记入 `skipped[]`（command_id、ref、reason、detail）。
2. **零执行步骤**：命令空间耗尽且 `executedCount===0` 时：
   - 若 done 成立 → stop 文案保持，追加 `— executed 0 action(s); skipped: <ids/reasons>; see skipped_actions`；
   - 若 done 不成立 → `done_not_held` reason 追加同一 skipped 摘要；
   - `StepResult`：`executed=false`、`skipped_actions`、`warnings`。
3. **done_preheld**：命令解析前对含命令声明的步评估一次 done（仅命令步；决策步不付）；记录 `done_preheld`；**默认不改变执行**（仍按既有流程动作）。
4. **`forceAct` opt-in**：`ctx.step(desc, { forceAct: true, … })`（类型/透传/文档）：
   - 在命令步中，即使 done 已成立，也先执行命令闭集（每条一次，最多命令数），执行后再评估 done；
   - dry：不改变 dry 模拟（dry step 仍 ok:true；仅记录声明）；replay：按录制动作序列，不重新决策；
   - 与命令解析（A2 可行动优先）协同；零执行仍按 2 记录证据。
5. **inert 与异步**：click 动作且 `changed===false` 且 done 已成立 → 记 `suspected_async` warning，**不 forbid、不写 outcome memory inert**；仅 done 不成立且同元素重复 > `max_effective_repeats` 时走既有 anti-repeat/no_progress。`scrolled/dragged` 保持不判 inert。
6. **after 补全**：动作执行后若 done 已成立（无下一次观察），用已有 `pre/post` 快照写 `after/changed`（不新增页面往返）。

### 2.3 测试（开发脚本 + 示例 dry）
- `examples/apps/05-done-evidence/app.mjs`（dry 可过）：command 步 + `forceAct:true` 声明，examples-check 覆盖加载/校验；
- 开发脚本 `scripts/done-evidence-check.mjs`（`page.setContent`，本地、无网络）：
  1. done 已成立 + 声明 click → 断言 `executed=true, done_preheld=true`；
  2. 同 label div+button（配合 A2 或单独构造）→ 断言 skipped_actions 有 div 原因、无静默 done；
  3. 点击后延迟 1s 增长的行 → 断言 `changed=false` 不 forbid、warning=suspected_async；
  4. `forceAct:true` 下 done 已成立仍执行（hows 有动作）。
- 真站记录（证据）：Maps See more 连续 3 步 → executed=true 3/3（配合 A2 修复目标解析），无「无证据的 done」。

### 2.4 验证 / 回滚
```
node scripts/done-evidence-check.mjs
npm run check
```
回滚：字段增量可保留；forceAct/行为调整单 commit revert 即恢复。

### 2.5 审查清单
- [ ] 默认行为等价（无 forceAct 的既有脚本结果逐字节不变；report 仅增行）；[ ] 零执行步骤有显式证据；
- [ ] inert 调整不导致死循环终止变慢（no_progress/max_steps 仍拦截）；[ ] dry/replay 一致；[ ] 性能：命令步 done 预评估 <5% 步耗时（实测记录）。

---

## 3. A2 候选分桶配额 + 命令可行动优先 + hint 可寻址 —— 实施清单

### 3.1 提取层（extraction.ts）
1. `EXTRACT_JS` 每候选新增（只读字段，排序用）：
   `rect{top,left,width,height}`、`inViewport`（viewport ±15%）、`nearViewport`（±150%）、`scrollDepth`、`inScrollContainer`、`bucket`、`prio`、`full_label`（≤200，内部匹配用；模型视图仍 40 字）。
2. 「最近可滚动祖先」：JS 内向上遍历 `parentElement`（缓存 parent→ancestor），`scrollHeight > clientHeight + 4` 且 overflow 可滚动 → 标记；单元素 O(depth)。
3. **分桶与配额常量**（extraction.ts 顶部）：
   ```ts
   export const POOL_QUOTAS = { chrome: 8, viewport: 16, contentNear: 8, mainOffscreen: 6, other: 2 };
   export const WIDE_QUOTAS = { chrome: 16, viewport: 48, contentNear: 32, mainOffscreen: 16, other: 8 };
   export const MAX_CHOICES = 200;    // < 决策服务 255
   ```
4. 排序：按桶配额取候选（桶内 DOM 序，不足顺延 viewport→contentNear→mainOffscreen→other）→ 拼接 → 截断 40/120；`prio` 仅诊断/展示；`main` 字段保留兼容。
5. `hintLookup` 返回行补 `full_label`；`hintMatch/hintCandidates`（rules.ts）优先用 `full_label`，attr 模型新增 `aria-label` 别名（映射 label），裸词改为「大小写不敏感、词边界/前缀匹配」（`label === token || startsWith(token+" ") || includes(" "+token+" ") || includes(" "+token+",")` 等）。

### 3.2 执行器（executor.ts）
1. **命令解析可行动优先**：新增 `resolveCommandRef(target, elems, op, forbidden)`：
   - `hintCandidates` 全部命中 → 排序：原生可行动 tag/role（a/button/input/label/role button|link|menuitem|tab/option）优先 → 非点击族对 click 剔除 → DOM 序；
   - 依次尝试前 4 个候选；动作阶段 actionability 失败 → 记 `skipped_actions` 并尝试下一个；全败 → 命令未解决（A1 记录，不静默 done）。
2. **MAX_CHOICES 预检**：所有 provider `pick/askChoice` 调用前，若候选数 > `MAX_CHOICES`：stop `decision_service_choice_limit`，reason 提示「用分桶优先级/收窄 hint，不要放大窗口；服务上限 255」。
3. 宽扫路径（WIDER）配额改用 `WIDE_QUOTAS`；行为保持「miss 才宽扫」。

### 3.3 inspect（src/cli/commands/inspect.ts）
- `--json` 增 `window: {visible_interactive, shown, out_of_window: [{tag,label,prio}] ≤10}`；`--wide` 展示至 120（保留 200 上限）；文本模式一行提示「N 个可见交互在默认窗口外，例如 Sort by (button)」。
- `--pool` 视图展示 `bucket/prio/full_label`（调试字段）。

### 3.4 文档/生成物
- `src/engine/grammar-prompt.ts`（唯一语法出处）与 `integrations/dsh-bridge/src/grammar.generated.ts`（生成器产出）、`src/engine/planning-playbook.ts`、`docs/APP_SCRIPT_AUTHORING.md`：写 aria-label 别名、完整 label 匹配、分桶窗口、`candidate_priority` 回退。
- `meta` 允许 `policy.candidate_priority: "bucketed" | "main-first"`（`src/app/app-meta.ts` 字段校验 + 执行器读取）；默认 `bucketed`；CHANGELOG 标注行为变更。

### 3.5 测试
- 开发脚本 `scripts/candidate-buckets-check.mjs`（`page.setContent`）：
  1. 页头 Sort by + 无限滚动 feed 10 行：默认 40 同时含页头按钮与视口行；`scrollList` 后新行进入窗口；
  2. 长正文页（main 内容在视口外）：mainOffscreen 桶可被 hint 命中；
  3. 虚拟列表只渲染 10 行：对第 50 行 hint → `target_not_found + viewport_underloaded` advisory（A3 依赖）；
  4. hint：`Sort by` 裸词命中 `aria-label="Sort by, Not selected"`；`button[aria-label~sort]` 命中。
- 真站 A/B（证据）：Google Hotels 决策「打开排序菜单 → 选择最低价」修复前 low_confidence/max_steps、修复后 PASS（O8 矩阵）；Maps See more 目标为 button 而非 div。
- 回归：`npm run check`、`npm run test -- --tier smoke`（core 可选）、`npm run examples-check`。

### 3.6 回滚
- `meta.policy.candidate_priority:"main-first"` 逐应用回退；引擎级常量/开关可加 `AMBERFLOW_CANDIDATE_PRIORITY=main-first`（仅调试）。MAX_CHOICES 为安全帽，无需回退。

### 3.7 审查清单
- [ ] Sort by 在默认池（脚本证据）；[ ] 命令目标选 button 不选 div；[ ] aria-label 三形状命中行为有测试；
- [ ] smoke/core 无回归（或 policy 回退用例说明）；[ ] 服务 255 上限结构化报错；[ ] prompt-hit 校验通过。

---

## 4. A3 列表展开与范围控件原语 —— 实施清单

### 4.1 新增 ctx 面（真实/dry/replay 三实现）
`src/app/ctx.ts`（接口 + 真实实现）：
```ts
scrollList(target: string, opts?: { to?: "bottom"|"top"|"page"; by?: number; settleMs?: number }):
  Promise<{ ok: boolean; scrollTop?: number; scrollHeight?: number; clientHeight?: number; moved?: boolean; stopCode?: string; reason?: string }>;

expand(target: string, opts: {
  count: { rows: string; fields?: Record<string,string> } | { selector: string };
  maxClicks?: number;            // 默认 20
  stableRounds?: number;         // 默认 2
  settleMs?: number;             // 默认 800
  timeoutMs?: number;            // 默认 60000
}): Promise<{ ok: boolean; clicks: number; before: number; after: number; grew: boolean; stable: boolean; coverage: {rows: number}; stopCode?: string; reason?: string }>;

setRange(target: string, value: { value: number } | { percent: number }, opts?: { tolerance?: number; timeoutMs?: number }):
  Promise<{ ok: boolean; achieved?: number; strategy?: "fill"|"keyboard"|"pointer"; stopCode?: string; reason?: string }>;
```
- `ctx-dry.ts`：确定性桩（expand `{ok:true, clicks:0, before:0, after:0, grew:false, stable:true, coverage:{rows:0}}`；scrollList `{ok:true}`；setRange `{ok:true}`），保持「dry 只验调用序列」；
- `ctx-replay.ts`：记录三方法参数，回放一致校验；
- budget：每个方法计 1 个 flow step；内部 click 不占 flow budget，由 `maxClicks`/`timeoutMs` 兜底；文档写清。
- 新增 `mw`（BrowserMiddleware）方法：`actOnce(decl)`（单动作解析+执行，复用 A1/A2 解析与证据）、`scrollContainer(page, sel, to)`、`setRange(page, sel, value)`。

### 4.2 引擎实现
- `scrollList`：解析元素（A2 解析器）→ `page.evaluate` 找最近可滚动祖先（或 `[role=feed]` 等目标自身）→ 写 `scrollTop`；返回 scroll 指标。纯 DOM 属性，不做鼠标/滚轮模拟。
- `expand`：ctx 内循环：读 count（`ctx.extract` 行数或 `read.count`）→ `mw.actOnce({hint:target, op:"click"})`（按 A2 解析、A1 记录）→ settle → 重读；连续 stableRounds 无增长/超 maxClicks/timeout 停止；返回 coverage。
- `setRange`：新文件 `src/engine/range.ts`：
  1. `input[type=range]` → fill；
  2. `role=slider` → 读 aria-valuemin/max/step/now，focus + Home + ArrowRight×n；校验 `aria-valuenow`；
  3. 指针拖拽兜底：bbox 为 0×0 时取最近有尺寸祖先的 bbox；`fraction=(value-min)/(max-min)`；mouse.move/down/move/up；校验 aria-valuenow，重试 ≤3；
  4. 失败 → `slider_not_settable`（reason 附策略/bbox/当前值）；成功返回 `{achieved, strategy}`。
- 命令面：`ctx.command("scroll", sel, {to:"bottom"})` 扩展（可选 `to` 字段，value 语义；保持旧 scroll 行为）；`setRange` 不新增 command op（保持命令闭集最小），由 ctx 方法提供。

### 4.3 测试
- 开发脚本 `scripts/expand-range-check.mjs`（`page.setContent`）：
  1. load-more 列表（点击追加 10 行×10 批）：`expand` → rows 100、clicks 合理、stable=true、coverage=100；
  2. 无限滚动容器：`scrollList({to:"bottom"})` → scrollTop 到达 scrollHeight-clientHeight；
  3. `input[type=range]`、`div[role=slider]` 正常与 0×0 手柄（最近祖先有尺寸）→ achieved 正确；
  4. dry 三方法桩行为（`--dry` 输出结构）。
- 真站验证（证据落盘）：
  - Maps 8 城单应用：`expand("See more",{count:{rows:'div[role="feed"] > div'}})` + `scrollList` → 单城 ≥100 行，coverage 落盘；
  - Google Maps Price per night：`All filters → setRange("Maximum price",{value:30}) → Done` → 北京档内 min $18 可复现（与 R17 外部浏览器结果一致）；
  - 反例：URL filter hack 不实现。
- 回归：`npm run check`、smoke/（core 视时间）、examples-check；schema 快照重生成。

### 4.4 回滚
- 新 API 单 commit revert；dry/replay 桩同步删除；文档回滚；示例移除。

### 4.5 审查清单
- [ ] 三方法在 dry/replay 行为符合「dry 只验序列」；[ ] expand 计费语义（1 步）文档与实测一致；[ ] setRange 失败结构化不假装成功；
- [ ] 真站 Maps 覆盖 ≥100 行、价格档 $18 复现（证据）；[ ] 无站点专有代码进引擎；[ ] `npm run check` 绿。

---

## 5. A5 决策面通道引导 —— 实施清单

### 5.1 实现
1. `src/cli/commands/doctor.ts`：默认执行 ask 探针（配置存在时）；输出 JSON 增 `ask_probe {ok, provider, ref?, conf?, error?}`（旧字段不变，探针失败不改退出码）；文本打印失败与通道提示。
2. `src/model/decision-provider.ts`：`no_model_runtime` / ask 失败 reason 统一附 remediation 片段：
   `本机若通过 DSH 桥运行：改用桥工具 amberflow_run（桥使用部署配置）；或 amber config set AMBERFLOW_DECISION_* 更新用户配置（见 docs/DECISION_SERVICE_CONFIG.md）`
   （不打印密钥；不自动切换）。
3. `src/cli/commands/run.ts` / start：当结果 `provider_degraded` 或 `no_model_runtime` 因配置失败时，stderr 与 envelope `next[]` 追加同一指引。
4. 文档/工具面：
   - `docs/DECISION_SERVICE_CONFIG.md` 增「两条通道」矩阵（桥部署配置 vs CLI 用户配置；如何验证；403 处理）；
   - `AGENTS.md` 命令节加一行「应用运行优先走桥工具；CLI 用户配置可能与部署面不同」；
   - `integrations/dsh-bridge/src/index.ts` 的 `amberflow_run`/`amberflow_status` 描述补一句（桥使用部署配置；status 含 ask 探针）；
   - `docs/AGENT_INTERFACE.md` 同步。
5. 测试：`scripts/decision-channel-check.mjs`（或手工命令）：
   - 把 CLI 用户配置指向不可用端点（临时 `AMBERFLOW_HOME`）→ `amber run` 输出含恢复指引、退出码分类不变；
   - `amber doctor` 默认显示 ask 失败；桥正常（部署环境）不受影响。
6. 验收：403 场景指引可见；doctor JSON 兼容；secret-scan 通过；文档更新。

### 5.2 回滚
- 独立 commit；doctor 探针可加开关 `--no-ask-probe`（可选）以防部署侧不希望默认请求；默认建议开启（一次最小请求）。

### 5.3 审查清单
- [ ] 不读取 DSH 配置/密钥（只提示）；[ ] 旧 doctor JSON 字段不变；[ ] 文案准确（不承诺自动修复）；[ ] 文档一致。

---

## 6. 验收矩阵（每项 + 总体）

| 项 | 离线脚本 | 示例/回归 | 真站最小验证 | 门槛 |
|---|---|---|---|---|
| A4 | `scripts/ref-stamp-collision.mjs` | `npm run check` | Maps 同锚点滚动 ≥50 卡 | 多命中=0 |
| A1 | `scripts/done-evidence-check.mjs` | examples 05 + check | Maps See more 3 连 executed=true | 无静默零执行 done |
| A2 | `scripts/candidate-buckets-check.mjs` | smoke/core | Hotels Sort by→Lowest price PASS；Maps See more 目标=button | Sort by 默认池可达 |
| A3 | `scripts/expand-range-check.mjs` | smoke | Maps 单城 ≥100 行；price filter max30→$18 | 引擎内完成展开/过滤 |
| A5 | 403 模拟命令 | check | doctor/run 指引 | 指引可见且无密钥泄漏 |

**总体验收（fresh-agent 回归台，R18+）**：
- 「零执行动作但步骤 done」事件：**0 静默**（有 executed/skipped 证据）；
- 「关键控制在窗口外」事件：0（inspect 可解释）；
- 数据任务：Maps 单 run 单城覆盖 ≥100 行、coverage 落盘；价格过滤口径 8 城可在引擎内复现；
- 外部 Playwright 作为**决定性数据腿**比例：目标 0；
- `npm run check` 全绿 + smoke 绿 + 文档/CHANGELOG/schema 同步。

## 7. 风险与回滚总表
| 项 | 主要风险 | 缓解 |
|---|---|---|
| A4 | 清章/唯一化引入额外属性开销 | 实测单次开销；可退化为「提取前清章」 |
| A1 | inert 语义变化影响死按钮终止 | 保留 anti-repeat/no_progress；回归用例 |
| A2 | 排序行为变更影响既有应用 | 分桶常量起步 + `candidate_priority:"main-first"` 回退 + smoke/core |
| A3 | 真站滑块/滚动脆弱 | 键盘优先+校验+结构化失败；setRange 失败不假装成功 |
| A5 | 默认 ask 探针增加一次请求 | 可 `--no-ask-probe` 关闭；不更改退出码 |

## 8. 交付物与执行记录
- 每个 commit 附：改动说明、验证命令输出摘要、真站证据路径、审查记录（`impl2/review-log.md`）。
- 最终更新：`docs/APP_SCRIPT_AUTHORING.md`、`planning-playbook.ts`、`CHANGELOG.md`、`docs/DECISION_SERVICE_CONFIG.md`、`AGENTS.md`（仅必要命令/通道说明）。
- 完成后汇总报告：`impl2/IMPLEMENTATION-SUMMARY-v2.md`（逐项 commit/验证/遗留）。

## 附录 A · 文件触点速查
| 文件 | 涉及项 |
|---|---|
| `src/engine/extraction.ts` | A4（nonce/清理）、A2（rect/bucket/prio/full_label/配额）、A3（可滚动祖先辅助，如需） |
| `src/engine/executor.ts` | A4（_locatorFor）、A1（证据/forceAct/inert/after）、A2（命令解析/MAX_CHOICES/宽扫配额）、A3（actOnce/scroll/setRange 接线） |
| `src/engine/rules.ts` | A2（hintMatch/hintCandidates：full_label、aria-label、词边界） |
| `src/engine/range.ts`（新） | A3（setRange 策略） |
| `src/app/ctx.ts` / `ctx-dry.ts` / `ctx-replay.ts` | A1（forceAct/字段）、A3（三方法三实现） |
| `src/app/app-runner.ts` | A4（收尾清理）、A1（trace/report/字段投影） |
| `src/app/app-meta.ts` | A2（`policy.candidate_priority`） |
| `src/cli/commands/inspect.ts` | A2（窗口摘要/out_of_window/池视图字段） |
| `src/cli/commands/doctor.ts` / `run.ts` | A5（探针/指引） |
| `src/model/decision-provider.ts` | A5（remediation） |
| `src/engine/grammar-prompt.ts` / bridge `grammar.generated.ts` | A2（语法文案；生成器更新） |
| `src/engine/planning-playbook.ts` | A1/A2/A3（六步法：动作证据/窗口/展开与口径） |
| `docs/APP_SCRIPT_AUTHORING.md` / `DECISION_SERVICE_CONFIG.md` / `AGENT_INTERFACE.md` / `AGENTS.md` | 全部 |
| `CHANGELOG.md` / `dist/schema/*` | 全部（行为变更/schema 快照） |

## 附录 B · 验证命令速查
```bash
# 每项门禁
npm run check
npm run examples-check
npm run test -- --tier smoke          # A2 必跑；A1/A3 建议
# 开发脚本
node scripts/ref-stamp-collision.mjs
node scripts/done-evidence-check.mjs
node scripts/candidate-buckets-check.mjs
node scripts/expand-range-check.mjs
# 真站证据（把 --out 指向 impl2/evidence/<item>/）
node --experimental-strip-types src/cli/main.ts run <app> --trace --out ~/.amberflow/goal-runs/impl2/evidence/<item>/<run>
```
