# SemanticFlow M1 实测报告 —— 三级解析 + 站点档案回填环

**日期**：2026-10-10（2026-10-11 补回填门/干跑/drift 与相应测试） ｜ **状态**：已实现并验证（M1 + M2 的 list_step + 双站迁移演示）
**方案**：[SEMANTIC_FLOW_TRANSFER_PLAN.md](SEMANTIC_FLOW_TRANSFER_PLAN.md) ｜ **测试**：`tests/semantic.test.ts`（42 条，全绿）
**一句话**：模板只携带语义（页面角色 + 语义目标 + 页面角色契约信号），运行时每步
①查站点档案的已学 hint → ②Laya 现场选 → ③不过闸由"老师"点名；提名让 **DOM/URL 信号**成立才回填，
回填条目 `replays_ok: 0` 起步、**重放命中才 +1**。执行循环零改动——三级解析全部接在既有缝上
（`RunOptions.hintMemory` + `escalateFn`）。

## 0. 诉求 → 交付

| 诉求原文（§0） | 交付 |
|---|---|
| ① 用户输入"在携程上订5月18日昆明到北京价格最低的机票" | 模板 `apps/flight-cheapest/flow.json`：goal + slots（`from/to/date_label/date_code`），值只来自数据袋 |
| ② LLM/Agent 查看页面、提取参数、规划操作顺序 | M1 用手写模板承载同样的 8 节点流（见下表）；"看页面规划"= M3 的 `plan` 工具（未做，见 §5） |
| ③ 流程固化后，Laya 在每个节点做出选择和操作 | ②级路径：desc 进元素池，Laya 现场选（conf/风险/actionability 闸照旧） |
| ④ 下次调用时模板可以迁移（到别的站） | 同一模板在两个 DOM 完全不同的复刻站上迁移并各自收敛（§2 实测） |

8 节点 → 模板步骤的映射（"访问"是每步的 start_url 导航，不是第 9 个点击步）：

| 诉求节点 | 模板步骤 | 说明 |
|---|---|---|
| 访问 www.xc.com | （每步导航） | 执行器每个子目标重新 `goto` |
| 点击机票页面 | `open-flights` | 语义目标 `{role: link, text: ["机票","Flights"]}` |
| 输入出发地 / 输入到达地 / 搜索 | `submit-search`（一步） | 分步填值会在下一次导航时丢失——有序语义目标 + 站点档案 `fill_keys` 绑值；二跑时已学 hint 点中搜索按钮，执行器 pre-fill 守卫先按 fill_keys 填好字段 |
| 选择出发日期 | `pick-date` | 语义目标里的日期文案是**槽位**（`{date_label}`），编译期替换 |
| 判断最低价机票 | `pick-cheapest`（list_step） | **数据规则**：对抽取的价格列求 `min`，模型不产出"选哪行"的判断 |
| 点击购买 | `purchase` | `dangerous: true`——默认拒绝，`--allow-dangerous` 或注入 `confirmDangerous` 才执行 |

## 1. 机制与接缝（共享层零分叉）

```
resolve(step, site):
  ① sites/<site>.profile.json 有已学 hint ──→ 执行器 currentHint() 回退路径取回，
     与 authored hint 同权威，hint 语法不变（落空/歧义仍回落模型）   （稳态，零模型）
  ② 没有 → desc 进元素池，Laya 现场选                              （首访）
  ③ 不过闸 → escalateFn 老师看同一份 criteria view 点名 ref
        提名让 DOM/URL 信号成立 → 执行器调 hintMemory.record() 回填 （门 = 完成真值）
        失败 → blocked，如实报告
```

- **①/③ 不需要改执行器**：`HintMemoryLike`（key/lookup/record）就是缝。`src/semantic.ts` 的
  `SiteProfileMemory` 按（站点, 语义步 id）键控——执行器只知道 (url, instruction)，运行器把
  （desc → stepId）预先注册进记忆，档案因此人可读、按语义步累计。
- **回填有门（红线 2）**：回填先只进内存（`SiteProfileMemory` 的 staged 模式），**同一次运行内**
  再整跑一遍**零模型重放**（`laya none`、无老师），只有真的以规则命中并完成的条目才 `commitVerified`
  落盘、`replays_ok` 从 1 起算；没过门的按原值撤回、一个字节都不写（`backfill_gate: unverified`）。
  `--no-verify-backfill` 是显式消融口：按现状落盘、`replays_ok` 停在 0、报告记 `skipped`。写盘原子
  （tmp+rename），坏档案响亮报错（证据面不许静默损坏）。
- **已学 hint 连续失败到阈值 → drift（§5）**：条目用上了但信号没成立就记一次失败（重放成功即清零），
  达到阈值（默认 2）报 `drift` 并撤下该条目——下次运行重新学，而不是拿着烂句柄硬跑。
- **危险步先干跑（红线 3）**：`dangerous` 步执行前先走执行器 `dryRun`——三级解析 + 只读
  actionability 探针（`isVisible`/`isEnabled`/中心 hit-test），**不点不填不滚动**；拿到"会点到什么"
  的证据后才问 `--allow-dangerous` / `confirmDangerous(step, evidence)`；干跑本身不成立 = 直接拒绝。
- **信号建在页面角色契约上**：模板写 `{"page": "results", "query": "date={date_code}"}`，编译器按
  **该站**的 pages 表解析成 `url_contains fare-list.html`（site-b 用档案覆盖页名）。站点档案可用
  `frozen_signals` 整体覆盖某步信号（DOM 级先验，M3 plan 工具的产物位）。
- **值绑定是站点知识**：`fill_keys` 把站点字段键（site-a 的 `出发城市`、site-b 的 `dep-city`）绑到
  模板槽位（`from/to`）——`_slotValue` 靠键匹配，键必须来自档案而不是模板。
- **新增文件**：`src/semantic.ts`（匹配器 + 档案存储）、`src/semantic-flow.ts`（模板编译 + 运行器 +
  list_step + 报告 + CLI）、`apps/flight-cheapest/`（模板 + 两站档案）、`semantic/site-{a,b}/`（复刻站）、
  `sites/`（运行时学习档案）。执行器唯一改动是一处硬化：**不回答 `act` 的运行时如实阻塞而不是崩**
  （与 `isRisky`/`isDone` 的既有守卫同一口径，`tests/semantic.test.ts` 钉住）。

## 2. 实测（离线 scripted 决策面；命令 → 原始观测）

复刻站刻意做成**零共享选择器**：site-a 用 `id` + 中文标签 + `tr` 行；site-b 用 `data-test` +
英文标签 + `div` 行，连页名都不同（`search.html` vs `fare-query.html`）。
决策面：`--laya scripted`（语义替身，conf 0.71，扮演 Laya 现场选）/ `--laya unsure`（0.05，
永远不过闸，逼出 ③通道）；老师：`--escalate scripted`（同一匹配核，扮演 LLM 点名）。

```bash
npm run semantic -- --app flight-cheapest --site site-a --laya scripted --allow-dangerous --out bench/semantic-flow
npm run semantic -- --app flight-cheapest --site site-a --laya scripted --allow-dangerous --out bench/semantic-flow   # 二跑
npm run semantic -- --app flight-cheapest --site site-b --laya scripted --allow-dangerous --out bench/semantic-flow
npm run semantic -- --app flight-cheapest --site site-b --laya scripted --allow-dangerous --out bench/semantic-flow   # 二跑
npm run semantic -- --app flight-cheapest --site site-a --laya unsure --escalate scripted --allow-dangerous \
  --profile-dir sites/escalate --out bench/semantic-flow                                                              # ③通道
```

原始观测（解析级行，报告全文在 `bench/semantic-flow/*.md`）：

| 运行 | 解析级 |
|---|---|
| site-a 首跑 | `rule 1 · laya 3 · escalate 0 (written back 3) · list 1 · blocked 0` |
| **site-a 二跑** | **`rule 4 · laya 0 · escalate 0 (written back 0) · list 1 · blocked 0`** |
| site-b 首跑 | `rule 1 · laya 5 · escalate 0 (written back 3) · list 1 · blocked 0` |
| **site-b 二跑** | **`rule 4 · laya 0 · escalate 0 (written back 0) · list 1 · blocked 0`** |
| site-a 首跑（unsure+老师） | `rule 1 · laya 0 · escalate 3 (written back 3) · list 1 · blocked 0` |
| site-a 二跑（同配置） | `rule 4 · laya 0 · escalate 0 (written back 0) · list 1 · blocked 0` |

结论（逐条对着 M1/M2 验收指标）：

1. **同一模板同站二跑：escalate/laya 次数 → 0，成本 → 0 forwards** —— 两站都成立（表内加粗行）。
2. **回填的 hint 按站点隔离且互不相同**：site-a 学到 `[id=nav-flight]` / `[data-test=chip-may18]` /
   `[id=buy-btn]`；site-b 学到 `[data-test=tab-flights]` / `[data-test=do-search]` /
   `[data-test=purchase-submit]`——同一语义步、两个完全不同的 DOM，各学各的、互不泄漏。
   提交的证据：`sites/site-{a,b}.profile.json`。
   （2026-10-11 起落盘门槛更严：条目要先在**同一次运行的零模型整跑重放**里被验证过才写，
   所以首跑落盘的条目 `replays_ok` 从 1 起算，二跑累到 2；不可复现的条目当场撤回。）
3. **"判断最低价"与手算一致**：05-18 的价格列 `[1280,1150,980,1330,1060]`，两站 list_step 都选中
   F3 ¥980（site-b 抽取格式还是 `980 CNY`——`int` op 剥非数字）。site-b 首跑曾选中 F5 ¥1090，
   根因是 pick-date 一步失败导致页面停在 05-17 默认列表——**list_step 忠实于当时的页面状态**，
   修好日期步后即与手算一致；这反而验证了"选择是数据规则、不是模型判断"。
4. **③老师通道**：unsure + 老师 → 3 次升级、3 次回填、二跑零升级；档案条目 `method: "escalate"`
   如实标注来源。
5. **危险步红线**：不带 `--allow-dangerous` 时 purchase 步先干跑取证（"会点到 `button "购买"`"、
   停在 `purchase.html`），再显式 `refused`（`REFUSAL_LABELS.dangerous`），旅程不算通过（exit 1），
   未执行未落盘；`confirmDangerous(step, evidence)` 看过证据点头后才真执行。
6. **不变量**：结束状态 `done.html?order=` / `fare-done.html?order=` 成立（页面角色契约编译）。

## 3. 测试钉住的不变量（`tests/semantic.test.ts`，42 条）

- 匹配器：等值档先于包含档；role 严格过滤；歧义如实返回 null；`data_test` 是最强档；未知 role 宁可空手。
- 档案：record 落盘/重读；`replays_ok` 只增、覆写同值不重置、改 hint 才从 0 计数（改版自愈）；
  learned 覆盖 authored；坏档案响亮报错。
- 回填门：staged 只进内存、`commitVerified` 只放行验证过的、撤回时把原条目**还原**、
  readOnly（`writeProfile:false`）一个字节都不写；端到端 `once-app`（现场成功、重放不可复现 →
  撤回且档案 `steps: {}`）+ 消融对照（`skipped`，`replays_ok` 停在 0）。
- drift：连续失败计数、达阈值撤下、重放成功清零。
- 编译：两站信号各自解析到自己的落点页（"信号页 ≠ 出发页"回归钉）；fill_keys 展开；槽位覆盖
  打错名字 = 用法错误；缺 `fill_keys`/`list_extract` 编译期响亮报错；页面角色档案覆盖生效。
- 文字系统路由：`observeLocale`（`<html lang>` 优先、否则 CJK 占比）；档案 `checkpoint` 真的决定
  模型面；坏值加载期报错。
- M2 对拍：测试侧独立读复刻站票价表 → `datasource.selectBest` 选出的行 == 浏览器 `list_step`
  选中的行；`selectIndex` 的 min/max/缺值/并列由 `tests/datasource.test.ts` 钉住。
- 回填环（真 chromium）：首跑回填过门落盘（`replays_ok=1`）；二跑零模型且重放步 `hint_used`；
  跨站隔离；③通道回填 `method: escalate`；危险步拒绝 + 干跑证据；list_step 选中行与引擎一致。
- 危险步：执行器 `dry-run` 不改页面（信号仍 false）；拒绝里带干跑证据；`confirmDangerous` 拿到
  证据才放行；放行后购买步真执行、不变量成立；二跑干跑走已学 hint（`rule:match`）。
- 出厂产物：遍历 `apps/*/flow.json`，逐站校验模板/档案/编译（产物不许静默漂移）。
- 执行器硬化：不答 `act` 的运行时 → blocked（不是 TypeError）；提名不存在 ref → fail closed。

## 4. 与方案文档的对照

- **§2 三级解析 + 回填环**：✅ 完整实现（M1）。
- **§3 数据结构**：✅ v2 模板（`semantic_target(s)`/`list_step`/`fills`）与 `sites/<site>.profile.json`
  落地；`signals_hint` 由"authored 档案的 steps 先验"承担（learned 覆盖 authored）；
  `locale`/`checkpoint` 不再只是数据——运行期据此选 checkpoint（`runFlow` 的 `modelId`），
  plan 首访用 `observeLocale` 观察 `<html lang>`/CJK 占比写进档案。
- **§4 端到端剧本**：`amberflow plan`（一句话 → 模板 + 首站档案）已做 → M3；`amberflow run --app --site`
  已可用（`npm run semantic`）。
- **§5 现实约束**：CJK 站的 checkpoint 由档案数据决定（策略在，运行期选面已成）；"最低价不能交给模型"
  ——list_step 的选择与 datasource 的 `selects` 是**同一个实现**（`selectIndex`），对拍有测试。
- **§7 红线**：①信号唯一真值（老师/Laya 只提名）✅；②学习产物过**同运行的零模型整跑重放**才落盘 ✅
  （`backfill_gate` + 撤回路径有端到端测试）；③不可逆动作**先 dry-run 取证**、再人确认 ✅；
  ④值只来自数据袋（{slot} 只替换已声明槽位）✅。

## 5. 已知边界（如实，不粉饰）

1. **真站迁移仍属外推**：离线复刻站的 URL 契约与页面角色是模板前置声明的；`plan` 已能把 LLMPlanner
   的产物写成 v2 模板 + 站点档案（M3），但 `--seed https://www.ctrip.com` 这类真站首访没有在
   本环境跑过（需要生产环境人工在场）。
2. **frozen_signals 目前是 authored**：DOM 级信号先验写在站点档案里（fixture 里为空——两站全部
   走 URL 契约）；运行时**学习 DOM 信号**（signal induction 接进档案）是下一轮。
3. **决策面在 CI 里是替身**：本报告的 laya/老师是语义替身（离线、CI 可复现）。真模型路径同一接口
   （`--laya onnx` + `--escalate llm`），但没有进 CI；CJK 站上 Laya 零样本不可靠是既有实测
   （0.03–0.15），所以中文站首迁的预期路径就是 ③——这正是 escalate 通道存在的原因。
4. **回填门要多跑一遍**：首次迁移的回填会追加一次**零模型整跑重放**（成本是"再走一遍旅程"，
   没有 forward pass）。`--no-verify-backfill` 关掉它，代价是档案里会有没验过的条目
   （`replays_ok: 0`，报告记 `skipped`）。
5. **list_step 的 retries 未实现**：list 步失败即 blocked（一次导航一次机会）；浏览器步的
   retries 语义不受影响。
