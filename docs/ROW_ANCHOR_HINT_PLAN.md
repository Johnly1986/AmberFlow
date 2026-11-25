# 行锚 hint：`in-row:<token>` 落地方案（v1.0 · 已实施）

> **字段定义见 `docs/AGENT_INTERFACE.md` §3.2（元素字段唯一权威表）**；本文是历史方案文档，
> 保留方案、实施记录与验收证据，不重复字段清单（`row_texts` / `row_index` 的引擎↔桥键名、
> cap 与「哪一面有」以 §3.2 为准）。

> 状态：**已实施**（2026-11-16；批 1 `c3d38f7`、姊妹方案批 2 首项 `a38e674`、批 2 遗留收编
> `13cd7ca`/`a1dd95f`、批 3 首项 `3fcb098` + **F85（2026-11-16 评审收口）**；实施记录、验收
> 证据与未落地项见 §10）
> 规格版本：v1.0（基于 lead 走查实测 + 架构裁决 b13f715f + 产品裁决 db7ab9a2 的合成）
> 关联：F69（within:#id 链）、F70（frame:<origin>）、F63（歧义命中顺序）、F14/T9（模型面剥离纪律）、
>       F-1（回捞行补 anchor_ids 先例）、B5（guard+解构双写教训）、BACKLOG #2（候选列表契约，实施前对齐）、
>       RUN_TAKEOVER_AND_DOM_CONTEXT_PLAN.md §2.2（D2 关系注记）、FRAME_SCOPE_HINT_PLAN.md（尾缀族先例与发布口径）
> 本文件只定方案，不改任何代码；实施以本文件为契约载体（对齐 F69/F70 的 schema-gen 声明模式）。

## 1. 背景与问题

### 1.1 契约级定性（所有者）

> "目标必须能通过稳定句柄（id / data-test / 唯一 class / role / aria-label）从元素池唯一解析出来，
> 这本身就是错误的契约——**子元素一定不可能仅凭借自身信息定位**。"

即：hint 契约必须允许**关系型定位**。列表/表格场景里，行的唯一可靠身份是**内容**（航班号、订单号、
商品名），不是结构（id）——现有两类关系锚全部押在结构身份上（within=祖先 id、frame=帧 origin），
内容身份没有通路。

### 1.2 实测证据（2026-11-16 携程机票列表走查，全部有池内数据）

列表 15 个航班卡片各有"订票"按钮：class=`btn btn-book`、无 id/data-test/aria-label、label 全同。

| # | 通路 | 结果 | 证据 |
|---|---|---|---|
| 1 | 六形状 | 无法唯一解析 → 准入拒绝 | observe.ts:212 "in the admission surface but no uniquely-resolvable hint shape" |
| 2 | `within:#id` | 空转 | 按钮 anchor_ids 仅 `hp_container`（应用根），祖先链无行级 id |
| 3 | `near` + `nearToken` | 采集错行 | near 实采 `¥450起`/`¥570起`（价格行）；身份行 `SC7960 波音737(中)` 在同一爬升路径上被 3 行窗口与"跨池唯一"挑选丢弃（pool-js.ts NEAR_JS） |
| 4 | suggestHints within 闭环（rules.ts:575-652） | 不产出 | 无 id 祖先 |
| 5 | 筛选收敛 | 死路 | 筛选面板 18 个 li 全 class-only 无 id（同类问题自指） |
| 6 | 裸词 + on_ambiguous:"act" | 走通但不可复现 | DOM 先序恰好首位是目标（F63）+ 展开卡片后文案恰好分化为唯一"预订" |

**结论**：缺一块"内容身份行锚"语法。`within:`/`frame:` 已证明"后缀限定"是可行且低风险的模式，
`in-row:` 与它们同构。

### 1.3 现有 near 机制的三个失效叠加（本方案顺带修复信息丢失）

1. 爬升窗口 ≤3 行、从直接父容器起——价格/舱位行先挤满窗口；
2. 挑选规则"跨池唯一者优先"——价格每行必唯一，永远赢过身份行；
3. 行过滤剔除纯数字行（`/^[£€$\d.,x%*\s]+$/`）与无字母行——**纯数字订单号被剔，电商/订单场景致命**。

## 2. 目标 / 非目标

**目标**
1. 任意 hint 形状可后缀 `in-row:<token>`，命中集限定到"行上下文文本包含 token"的元素；
2. `in-row:` 与 `within:`/`frame:` 可组合（三个独立 AND 过滤，集合可交换故书写次序无关）；
3. 观察/建议/歧义证据全链闭环（frame: 立项纪律，FRAME_SCOPE_HINT_PLAN.md §1 目标 3）：
   `observe`/`inspect` 的 hint_candidates 直接产出可照抄的 `in-row:` 候选；
4. near 取值**逐字节不变**（结构性证明，不靠对拍撞运气，见 §3.4）；
5. 默认行为逐字节不变（无尾缀 hint 走原路径）。

**非目标（明确 out of scope）**
- 词边界档位匹配（bare 五档式）——row_texts 是已切分原子行，碰撞面小一个量级；有实测碰撞证据后再议（Phase 3）；
- 严格几何"行"判定（嵌套表/卡片套卡片的容器启发式）——in-row 语义如实定义为"目标所在容器路径可见文本"的关系锚（§4）；有误锚案例再议；
- stability 元数据/unstable 标记系统——结构性安全（歧义缺省拒绝）优于警告标记，警告没人读；
- `near~` 形状复用 row_texts 作匹配底座——那会改既有形状语义，无字节纪律保护（风险表 R8）；
- done/when 信号面（天然 CSS，不需要行锚）。

## 3. 设计

### 3.1 语法（第三类尾缀）

```
<hint 六形状之一>[ within:#id链][ frame:<origin链>][ in-row:<token>]
```

- 三类尾缀**各至多一次**、任意书写次序；任一类超限/值非法 ⇒ **整组后缀都不应用**
  （按原始串回退，绝不半剥——R2-5 三类版，唯一剥离出处仍为 `splitTailSuffixes`，hint.ts:142）；
- token 闭集：非空、无空白（`\S+` 词法天然）、禁 `>`（为未来链语法留词法余量）、≤40 字符；
  解析期小写折叠（parseHint 整串小写既有路径，within/frame 值同口径）；
- 解析只管形状："解析只管形状，匹配是各观察面自己的事"（hint.ts:9-10 纪律）——NFKC 折叠在
  **匹配面**做（§3.3），不进 parseHint；
- 示例：
  ```
  订票 in-row:sc7960
  button[near~add] in-row:order-1042 within:#modal
  删除 in-row:1042 frame:https://shop.example.com
  ```

### 3.2 解析面（hint.ts）

- `ParsedHint` 六形状各加可选 `inRow?: string`（与 `within`/`frameChain` 字段同构）；
- `INROW_TAIL_RE = /(?:\s+in-row:)(\S+)\s*$/i`（splitTailSuffixes 内）；诊断面空值版
  `/(?:\s+in-row:)(\S*)\s*$/`（同 FRAME_TAIL_VALUE_RE 模式，供 describe 点名"缺值"）；
- `inRowValueProblem`（empty / too-long / has-gt），与 `frameChainValueProblem` 同位：
  解析面判合法、诊断面要原因类别；
- `describeRowSuffixRejection(hint)` 与 `describeFrameSuffixRejection`（hint.ts:241）同构，
  接 executor target_not_found reason 与会话 act reason（消费点与 frame 版一致）。

### 3.3 池侧匹配（rules.ts hintMatchImpl）

- `const inRow = (refs) => parsed.inRow === undefined ? refs
  : refs.filter((r) => rowMatch(elems[r], parsed.inRow));`
- **覆盖 inAnchor 的全部 5 处调用点**：emit（:376）、attrSubstr exact/slug/base 三分档（:416-419）、
  tag-submit 偏好（:451，R2-10 修过的绕过点）、bare 五档（:495；限定后空 = 跳到全落空不跨档降级，
  :500 语义照抄）。漏任何一处 = 复刻"tag 绕过 within"类 bug；
- 三尾缀组合 = 三个独立 AND 过滤：frame 是入口 entries 过滤（:360-362），within/inRow 是后置过滤，
  实现为 `limit = (refs) => inRow(inAnchor(refs))`——集合过滤可交换，次序无关；
- **匹配口径：单档 `row_texts 任一行 includes(token)`，逐行匹配不做跨行拼接**。归一口径为
  **仅小写折叠**（与 nearToken 池侧语义 parity，rules.ts:426 同为 includes；within/frame 值同样
  入口小写——hint.ts:110/171 先例），存储面存 innerText 原始行（采集侧统一小写，anchor_ids
  小写先例 extraction.ts:1317-1318）；
  > **NFKC 仲裁（两轮架构评审唯一实质冲突）**：第一轮主张匹配面 NFKC+lowercase+trim（全角
  > `ＳＣ７９６０` 用例），第二轮否决——两面新增归一层 = 纯漂移面，且作者从 hint_candidates
  > 照抄真实行词元**构造上必中**（词元本身来自 row_texts）。**裁决采纳第二轮：仅小写折叠，
  > 全角场景 fail-closed 显式落空**，等实站案例再议（遗留 §8.2）。
- **fail-closed 对称**：元素无 row_texts（非重复组）⇔ in-row 恒不命中 ≙ frame 对未知 origin 帧
  不可命中（F70 语义）。行锚只服务"同文案网格"这一它要解决的问题，不制造新歧义；
- 限定后本档清空 = 落空，不让行锚内更弱档越级顶上（跨档混选防线不变）。

### 3.4 数据面：`Elem.row_texts`（双累加器 + 行过滤放宽）

- 字段：`row_texts?: string[]`（≤6 行，每行 ≤40 字符）。**仅同文案重复组元素携带**（与 near 同触发）；
  注释注明：只服务匹配/回捞/建议，不进模型面（§3.7）；
- **双累加器改造（addNearContext + NEAR_JS）**：与 near 共享同一次爬升（≤8 层祖先、
  容器持有 >1 个同文案交互控件即停 = 行边界），但两个累加器独立：
  - `out`（near）：累加序、行过滤（纯数字/无字母剔除）、3 行窗口**逐字符不动**；
  - `rows`（row_texts）：**独立行过滤（row 视图）**——现行过滤 **OR 连续数字 ≥5 位**（救援纯数字
    订单号 20240101；时刻 "20:20"、短价格段维持剔除）；泄漏的长数字/价格行无害——价格词元由
    生成期硬拒兜底（§3.6），匹配面不挑词；窗口 6 行；
  - NEAR_JS break 条件取**并集** `(out.length>=3 && rows.length>=6)`——新循环永不早于旧条件退出、
    out 累加序前缀稳定 ⇒ `near = out.slice(0,3)` **逐字节相等可证**（结构性证明；near pick 消费面
    extraction.ts:1518-1522 不动，宿主侧 pick 仍只在"前 3 行切片"上做唯一性挑选）；
- NEAR_JS 返回 `{near, rows}` 形态（或双数组，实施时定，以 pass 串字节纪律优先）；
  宿主按前 3 行做 near pick、全量做 row_texts。

### 3.5 DOM 回捞对等（pool-js.ts HINT_HEAD / extraction.ts hintLookup）

- 回捞是"计划点名但被预算逐出"的最后通道，必须同口径；**回捞行缺 row_texts + 声明 in-row ⇒
  二次 hintMatch 的 inRow 过滤清零 ⇒ 回捞路径整体死路**（F-1 同构问题，pool-js.ts:764-767 注释即先例）；
- ROW_CLIMB_JS 共享片段（仿 `${ANCHOR_JS}` 插值模式，唯一 JS 实现防两面漂移——hint.ts:1-11 教训），
  EXTRACT/OBSERVE/HINT_HEAD 三 pass 经 `${}` 内插同一份；
- HINT_HEAD 的 in-row 门要求**惰性 + memoized + 上限 + 早退**：先收集形状命中（不含 in-row 过滤），
  按 DOM 序逐候选算 row_texts（memo 每候选一次），命中即收集、凑满 5 个早退；总计算次数封顶
  （120，超出 fail-closed 并文档化）——只补字段不进门的话 `slice(0,5)` 可能全被非命中占满；
- 回捞行补 `row_texts`（additive 字段模式 `...(rows.length ? {row_texts} : {})`，与 anchor_ids 同形）；
- **A3 DOM fallback 池行同样补 row_texts**（批 1 必改项，第二评审补漏）：`DOM_FALLBACK_COLLECT_JS`
  内插同一 ROW_CONTEXT_JS（executor.ts:358-360）——fallback 行并入主池后同样走二次 hintMatch，
  缺字段=重演 F-1 半链缺口；
- PASS_HINT_PROBE 经 `HINT_HEAD.replace(...)` 派生（pool-js.ts:828-829）自动继承——验证只读路径不受盖章改动影响；
- 性能：爬升只发生在 `parsed.inRow !== undefined` 的回捞（罕见路径）；回捞上限本就 5 行；超标则
  候选帽降 3（第二评审备选）。

### 3.6 建议闭环（rules.ts suggestHints 第 5 档）

- 现有顺序：身份（data-test/id/name/href）→ 唯一 label → frame → within 链生长。追加**第 5 档**：
  within 全部落空后，从 `row_texts` 逐行取词元生成 `<label> in-row:<token>`，逐个走同一个
  push → hintMatch 自证（恰好唯一命中才保留），命中即停；`out.slice(0,4)` cap 不动
  （R-10：链候选与 frame 候选互不挤占的顺序纪律不变；携程场景 within 恒空故 in-row 拿得到槽位）；
- 词元启发式（**生成期护栏**）：优先"类标识符"词元（字母+数字混合，如 `sc7960`、`order-1042`）；
  跳过纯价格/货币/百分比词元（`^[¥$€£\d.,%*\s]+$`）与时段词元（`^\d{1,2}:\d{2}$`）。
  **理由（产品裁决）**：带 unstable 警告的候选是半成品承诺，作者会照抄且警告没人读——宁可不产出交回人。
  不做 unstable 标记机制（hint_candidates 本来只承诺当页自证唯一，APP_SCRIPT_AUTHORING.md:270）；
- 收益链：observe/inspect 的 hint_candidates、run 面歧义证据 `suggested_hint`
  （ambiguity.ts:181 `suggestHints(e, elems)[0]`）自动产出可照抄候选；准入 = suggestHints 非空
  （observe.ts:283-291）自动受益。

### 3.7 模型面剥离（executor-pure.ts modelProjectionOf）

- row_texts **不进** ChoiceRequest.elems（F14/T9/surface/frame_origin 同一纪律）：
  near 已以"每重复元素一行"进 criteriaView（extraction.ts:1476-1479 `[near=...]`）是模型视图装饰；
  再灌 6 行 × 15 卡是请求体爆炸且改变模型世界（对拍语料碎）；
- `modelProjectionOf` 快路径 **guard（:134）与解构（:139）两处同步**加 row_texts（B5 教训：只改解构会泄漏）；
- esig（extraction.ts:388-390）与 firstIfSame 签名（:402-404）天然不含 row_texts，已核验免改；
- 池行体积上界：15 卡 × 6 行 × 40 字 ≈ 3.6KB，仅重复组携带，模型请求体零增量。

### 3.8 observe/inspect 面闭环（产品裁决：必须同批）

- `OBSERVE_JS` 经共享 ROW_CLIMB_JS 采集 row_texts（dup 门控、additive 字段、与 near 同触发条件）；
  **无重复组页面的观察 JSON 逐字节不变**（仅 dup 组且非空出键，anchor_ids 长度门控 pool-js.ts:624 同型）；
  dup 键函数（tag+label，与宿主 addNearContext 同口径）收进共享 helper 单一出处，防页内计数与
  宿主 map 漂移；
- `observe.ts` `syntheticElem` 透传 row_texts（observe.ts:183 anchor_ids 先例）→ suggestHints 在
  observe 自证池自动闭环；observe 准入=suggestHints 非空（observe.ts:283-292），不采集则 ctrip 类
  页面按钮在 inspect 仍不可准入——半链上线会重演 frame: 教训（F70 数据面全链一次到位）；
- `whyNotAdmitted`（observe.ts:212-215）**同批改写**：追加指向 in-row 的可行动指引 + observe 面边界
  声明——旧文案"add id/name/data-test"在无 id 页面是主动误导（架构硬条件）；
- **降级预案**（对架构"变更风险"异议的显式折中）：若实测 observe 时延劣化超阈值，允许把 OBSERVE_JS
  采集拆出为批 1b（同一 CHANGELOG 条目内两步合入），**不可跨迭代搁置**——对产品"不可拆"裁决与
  架构"风险"异议的折中，须在实施记录里写明；
- Phase 2 才答的设计题提前到批 1 处理：max 截断 → dup 判定只对"观察集合内可见同文案计数"执行并
  文档声明边界；成本 → 爬升仅对已判定重复组的元素执行（与 near 同触发），observe 面已有 max≤200 硬上限。

### 3.9 失败诊断三案口径（stopCode 保持 target_not_found，不加新码）

| 场景 | reason 口径 |
|---|---|
| token 在任何行词元中无匹配 | 列出该池面真实行词元 ≤8（镜像 frame: "页面实际可用 origin" 先例，APP_SCRIPT_AUTHORING.md:1085） |
| 行已定位但行内无 `<hint>` 命中 | 报"行已定位 + 行内词面"——作者改 base 不改 token |
| token 撞多行 | `target_ambiguous` 按现场列出、零动作（永不选第一行——结构性安全承诺）。**已由解析面 fail-closed 兑现（F85 评审收口）**：`rules.hintMatchImpl` 在声明行锚且限定后候选 >1 时返回 null（不再用 `firstIfSame` 合并同签名候选）；命令步/决策步 act hint 在取首候选与 widen/strict 之前结构性 `target_ambiguous`，候选进 `skipped_actions`——不依赖 `on_ambiguous` 偶然性，也不交模型挑一行 |
| 尾缀形状非法 | 整组回退显式落空 + 缺主体诊断（BACKLOG #8/E2 先例） |

三案 reason 必须可区分。

## 4. 语义边界（写进文档，不当 bug 修）

- **"爬升路径文本 ≠ 严格几何行"**：目标容器路径跨 2 行且只含 1 个重复按钮时继续爬，邻居行文本可能入集
  （风险 R3）——in-row 是"目标所在容器路径可见文本"的关系锚；grid-break 只挡整网格级；错误命中面被
  歧义门与自证兜住；
- **token 命中多行** → 限定后仍多候选 → **解析面 fail-closed（F85 评审收口）**：`rules.hintMatchImpl`
  声明行锚时多候选直接返回 null，命令步/决策步 act hint 在 widen 之前结构化 `target_ambiguous`
  零动作、候选进 `skipped_actions`；in-row 不新增"静默取第一个"，也不再有"on_ambiguous 碰运气"面；
- **行文本漂移**（价格改版、文案 A/B）：推荐身份文本做锚；suggest 启发式已剔除价格类，但不禁止
  作者手写价格锚——与 near 同一信任模型；假唯一失败形态 = 显式落空或歧义拒绝，**永不错点**；
- **重复 id（M6②）、anchor_ids ≤8 截断、重复组按池内可见计数**等既有 fail-closed 条款原样适用；
- in-row 服务重复网格；非重复组元素写 in-row = 恒落空（作者指南写明，风险 R6）；
- **near vs row_texts 一句话裁决（作者指引，写进文档）**：near = 模型视图单行（宿主挑选后的展示
  装饰），row_texts = in-row 匹配底座（自证候选的词元来源）；作者只照抄 hint_candidates，
  混淆面在文档层消解（第二评审 R 表）。

## 5. 分批实施清单

**批 1（不可拆，一次 PR；observe 采集如触发降级预案则拆 1a/1b 同条目两步）**

| 文件 | 改动 | 字节/纪律约束 |
|---|---|---|
| `src/engine/hint.ts` | 六形状加 `inRow?`；`INROW_TAIL_RE`（含诊断空值版）；三类循环剥离；`inRowValueProblem`；`describeRowSuffixRejection` | R2-5 整组回退；解析只管形状；NFKC 不进 parseHint |
| `src/engine/rules.ts` | `limit=inRow(inAnchor())` 组合函数覆盖 5 处；`rowMatch` 折叠 helper；suggestHints 第 5 档 | 限定后空=落空不跨档；cap 4 与 R-10 顺序不变 |
| `src/engine/extraction.ts` | `Elem.row_texts` 字段 + addNearContext 双累加器接线 | near pick 消费面 :1518-1522 不动；字段注释注明不进模型面 |
| `src/engine/pool-js.ts` | NEAR_JS 双累加器（break 并集）；ROW_CLIMB_JS 共享片段；HINT_HEAD 惰性门 + 回捞行补字段 | **String.raw 模板首行直接跟内容、模板内不加注释行**；out 累加器逐字符不动；PASS_HINT_PROBE 只读验证 |
| `src/engine/pool-js.ts`（OBSERVE_JS） | 共享 ROW_CLIMB_JS 内插 + dup 门控采集 | additive；max 截断边界文档化；无 dup 页观察 JSON 逐字节不变 |
| `src/engine/executor.ts`（A3 DOM fallback） | `DOM_FALLBACK_COLLECT_JS` 内插 ROW_CLIMB_JS + fallback 行补 row_texts | 缺字段=重演 F-1 半链缺口（executor.ts:358-360） |
| `src/engine/executor-pure.ts` | modelProjectionOf 剥离 row_texts | **guard 与解构两处同步**（B5） |
| `src/engine/observe.ts` | syntheticElem 透传；whyNotAdmitted 文案改写 | 缺口/边界声明随文案 |
| `src/cli/schema-gen.ts` | 新 F82 声明（statement/truth 对齐 F69/F70 写法） | schema 快照为 gitignored 构建产物，`check:ci` 负责漂移门 |
| `src/engine/grammar-prompt.ts` | `HINT_ROW_SUFFIX` 示例 + import 时 parseHint 自证断言 | 语法对齐既有自证机制 |
| docs | APP_SCRIPT_AUTHORING §4 尾缀三并列 + 新 §4.x「列表/表格行：内容身份定位」（工作示例/词元启发式/边界）+ §10 停因表三案口径 + §11 已知边界；AGENT_INTERFACE ElementView 表加 row_texts 行 + hint_candidates 形态说明；README 能力 bullet；RUN_TAKEOVER §2.2 注记（行身份类由 in-row 收口、D2 限缩为容器结构消歧）；BACKLOG 立项条目；CHANGELOG 单条 Unreleased 仿 frame 批结构 | — |

**免改核验项**：hintLookupArgs（parsed 自动携带 inRow）；esig/firstIfSame；PASS_NEAR 唯一消费点
（extraction.ts:1509）；hint-lint（parseHint 自动继承）。

**恢复面行锚语义（F85 评审收口后的现状，原"显式缺口"已关闭）**：四面（FW8 `identityHintInfo` /
DRF `declaredLookup` / F64 `#id` live-DOM 直查 / A3 DOM 回退）在目标声明了 `in-row:`/`row-index:`
行锚时**统一 fail-closed、不参与恢复**——声明行锚落空 = `target_not_found` + 行锚证据，
绝不会按 base 身份/文本绕过行约束动作；A3 与回捞行（HINT_HEAD）已支持 `row_texts` 底座
（批 1 同批补字段）。池外行锚恢复（Phase 2）仍不做。

**批 2（已实施，`13cd7ca` + `a1dd95f`）**：findByHint / plan check --probe 行锚适配；apps check
hint-lint 行锚提醒（合法声明聚合为一行汇总，不再逐条刷 stderr）；歧义证据反向提示"改用行锚"
（`AmbiguityCandidate.row_index`）；规划面诊断三案 additive 接线（`frameHintFailureEvidence`
单点，stopCode 不变）。

**批 3（首项已实施 `3fcb098`，其余择期）**：induceHint 记忆产物带 `in-row:`（内容候选；
**记忆面禁产单用 `row-index`**——位置性 hint 的序漂移责任只属于作者显式声明，不固化进 learned
hint）、`hint_token_allow` 下传到记忆生成面、桥 ElementView 透传 row_texts/row_index；
词边界档、deny-list 可配化（已随批 3 首项落地为放行表）、criteriaView [near] 演进仍择期。

## 6. 风险表

| # | 风险 | 缓解 |
|---|---|---|
| R1 | near 值漂移（改 NEAR_JS 动了 out） | 结构性证明：break 并集 ⇒ 新爬升 ⊇ 旧爬升、out 前缀稳定 ⇒ slice(0,3) 逐字节相等；验收加固定 DOM 语料双实现断言 + smoke/core 前后 traces near 值 diff=空 |
| R2 | HINT_HEAD 性能（候选×8 层×querySelectorAll） | 仅 parsed.inRow 声明时启用；每候选 memo 一次；凑满 5 早退；总计算封顶 120 |
| R3 | 爬升路径文本混入邻居行 | 语义如实文档化（§4）；grid-break 只挡网格级；错误命中被歧义门与自证兜住；有案例再议行容器启发式 |
| R4 | 价格锚漂移假唯一 | 失败形态=显式落空/歧义拒绝，永不错点；suggest 启发式跳价格/时段；作者指南引导身份文本 |
| R5 | 全半角/Unicode | **仅小写折叠，不做 NFKC**（§3.3 仲裁）：全角 fail-closed 显式落空；作者从 hint_candidates 照抄真实行词元构造上必中；离线断言含全角用例（断言其落空而非命中） |
| R6 | 非重复组写 in-row 恒落空且诊断不提 row_texts | fail-closed 可接受；candidateText（executor-pure.ts:159）批 1 不加（判别文案变更面控制）；指南写明 |
| R7 | 池行体积 | 仅重复组携带；≤6 行；modelProjectionOf 剥离后模型请求体零增量 |
| R8 | PASS_HINT_PROBE / nearToken 旧路径波及 | probe 自动继承需只读验证；**否决** near~ 复用 row_texts 匹配（改既有形状语义无纪律保护） |
| R9 | observe 时延（OBSERVE_JS 采集） | dup 门控 + 共享片段；降级预案 1a/1b（§3.8）；超阈值即拆，不可跨迭代 |

## 7. 验收标准

1. `npm run check` 全绿（typecheck + prompt-hit + config/schema + secret-scan + examples-check +
   test:validate）——本仓无 *.test.ts，此为唯一 PR 门禁；
2. 离线纯函数断言（一次性证据脚本/工具语料）：in-row × 六形状 × fail-closed（无 row_texts 恒不命中）
   × 三尾缀组合与次序无关 × 整组回退（双 in-row / 含 ">" / 空 / >40 / 属性值内伪尾缀）×
   全角落空断言（fail-closed 正向证明）× bare 限定后空不跨档 × 纯数字订单号行可命中；
3. near 对拍：固定 DOM 语料双累加器断言 + smoke/core 真站前后跑，traces 中 near 值 diff = 空；
   golden 三件全等：hintMatch/hintCandidates/suggestHints 旧四档输出、Elem.near 全量、
   无 dup 页 observe JSON；
4. 实站回归（`npm run test`）：core 增一条"重复按钮网格 + `<label> in-row:<token>` 声明 hint +
   结束态不变量"；probe 增一条"token 页面缺失 ⇒ target_not_found"（fail-closed 正向证明）；
   `probe/ctrip-flights` 扩 in-row 用例（命中正确卡的 DOM 证据断言航班号；撞多行 target_ambiguous
   按行分组证据；inspect/observe 产出 in-row 候选且 admitted=true）；均不绕风控、证据出仓库；
5. 用户故事级验收（产品）：
   - **US1 携程**：inspect 候选含自证唯一的 `订票 in-row:sc7960`；run 3/3 命中对应行 +
     rules-only 消融通过 + 零 on_ambiguous/ambiguity 停；
   - **US2 购物车**：多行同名"删除"，指定行删除、其余行 done 负向断言原样、token 撞两行时
     零动作否定用例通过；
   - **US3 落空一次改对**：漂移 token 失败 reason 列真实行词元、无模型回退、单点改后重跑
     verified=true。

## 8. 遗留问题

1. row_texts 字段形状实施前与 BACKLOG #2（候选列表上移应用层）契约对一次，避免两次改池
   （RUN_TAKEOVER_AND_DOM_CONTEXT_PLAN.md:164-165 教训）；
2. in-row 诊断函数与 target_not_found reason 的接线深度——**已定并实施**：`extraction.frameHintFailureEvidence`
   单点接线（命令步 / strict / 会话 act / 规划面停因），reason 带修法文案与真实行词元（见 §10）；
3. 嵌套表/卡片套卡片下的行边界（R3）——有误锚案例再议行容器启发式；
4. OBSERVE_JS 若触发降级预案，批 1b 不可跨迭代（§3.8）；
5. 虚拟列表 row_texts 与池窗口同界——文档接 ctx.scrollList/collect 分块指引；
6. BACKLOG #2 落地后重估 D2 去留（D2 管"容器结构可分"，与 in-row 互补不互代）；
7. 批 2 歧义证据反向提示"改用 in-row"——**已实施**（`AmbiguityCandidate.row_index` additive +
   `suggested_hint` 复用 suggestHints 行锚档；见 CHANGELOG 批 2 遗留收编）；
8. 全角/NFKC 归一：fail-closed 放行（§3.3 仲裁），等实站案例再议；
9. FW8/DRF/F64/A3 声明行锚的恢复路径——**已收口**（本次 review：四面统一 fail-closed、不参与
   恢复，落空 = `target_not_found` + 行锚证据）；池外行锚恢复（Phase 2）仍不做；
10. OBSERVE_JS 大重复网格（100+ 同文按钮）时延需 ctrip 实测一次；超标则 observe 侧爬升帽降 4 层
    （与 run 面 8 层不同帽需写入契约）；
11. 多 token 组合行锚（`in-row:a>b`）：单尾缀已覆盖实测案例（`>` 已在词法保留），等真实案例再议。

## 9. 评审记录（2026-11-16）

- **产品裁决（db7ab9a2）**：P1 优先级（10 站点 ≥7 列表驱动；RUN_TAKEOVER:123-124 承认闭集缺口；
  不升 P0——有迂回）；语法单一正典无别名；observe/inspect 必须同批（frame: 全链闭环先例）；一级能力
  叙事「行上下文定位」；价格词元生成期硬拒绝；无配置开关（F69/F70 先例）；批 1 不可拆；三案诊断口径；
  文档结构清单；US1-3。
- **架构裁决一（b13f715f）**：批准 R 方案为第三尾缀（三角补全定位契约）；双累加器 + break 并集的
  near 逐字节结构性证明；回捞行补 row_texts 必须同批且命中收集期设门（封顶 120）；row_texts 独立
  宽松行过滤（纯数字订单号必须可锚）；不进模型面（guard+解构双写）；建议 2d observe Phase 2 附
  whyNotAdmitted 硬条件；风险表 R1-R8。
- **架构裁决二（e42c3e1d，独立重派复核）**：确认 R 方案与三正交维度定位（含 pool-view.ts:31 extras
  白名单佐证 near 是唯一进模型面的行文本）；observe 同批**论证 Phase 2 不成立**（半链重演 frame: 教训、
  observe 准入断链）；nearToken parity 论证 includes 单档；**行过滤精化为"现行过滤 OR 连续数字≥5 位"**；
  **补漏两项批 1 必改**：A3 DOM fallback 行补 row_texts（executor.ts:358-360）、FW8 白名单缺口显式
  声明；否决 NFKC（两面归一层=纯漂移面，照抄词元构造上必中）；risk R9 备选（候选帽降 3）。
- **分歧仲裁（lead 合成）**：
  - observe 闭环：两轮架构意见相左（一: Phase 2 附硬条件；二: 论证 Phase 2 不成立），产品立场坚定
    （frame: 全链闭环先例 + 核心工作流断链）→ **采纳产品 + 架构二：observe 进批 1**，保留架构一的
    降级预案（1a/1b 同条目两步、不可跨迭代）作为时延超阈值时的退出通道；
  - NFKC：两轮架构正面冲突 → **采纳第二轮（仅小写折叠 + 全角 fail-closed）**，理由：两面归一是
    新漂移面，照抄词元消除全角需求，与 within/frame 归一口径一致；
  - 行过滤：采用架构二的"现行过滤 OR 连续数字≥5 位"（最小 delta 救援订单号场景），架构一的
    全宽松版降为备选（若实站出现被剔的有效行再放宽）；
  - 其余全部收敛，无未决分歧。

## 10. 实施记录（2026-11-16）

**状态**：已实施（批 1 一次 PR 不可拆 + 批 2 遗留收编 + 批 3 首项 + F85 评审收口）。

**提交清单**：

| 提交 | 内容 |
|---|---|
| `c3d38f7` | 批 1：解析（`in-row:` 尾缀）/ 匹配（`limit=inRow(inAnchor())`）/ 数据面（`Elem.row_texts` 双累加器）/ 回捞（HINT_HEAD 门）/ A3 回退 / 建议（suggestHints 第 5 档）/ observe 闭环 |
| `13cd7ca` | 批 2 遗留：findByHint 行锚适配 / apps check hint-lint 行锚提醒 / 歧义证据 `row_index` / probe expect 类型收编 / 规划面诊断三案 additive 接线 |
| `a1dd95f` | 规划面命令步证据覆盖 + 命令空间契约违背修复（id-less 命令不再静默丢弃 → `target_not_found` + 行锚证据；停因证据 hint 取该步有效声明目标） |
| `3fcb098` | 批 3 首项：`induceHint` 记忆产物带行锚（禁产单用 row-index）/ `hint_token_allow` 下传记忆面 / 桥 ElementView 透传 `row_texts`/`row_index` |
| **F85（2026-11-16 评审收口）** | 行锚 fail-closed 进解析面（多候选 = null）；恢复面四面（FW8/DRF/F64/A3）不参与；记忆面禁产单用 row-index + tokenAllow 下传 record；四采集面 dup 键（`__rowLabelOf`）/可见成员编号统一；`HINT_GRAMMAR` 补 `row_suffix`/`row_index_suffix`；lint `dupOnly` 聚合；命令自动 id 去重；`npm run check` 接 `precheck` + `row-anchor:check` |

**验收证据**：

- `npm run check` 全绿：`precheck`（无条件重生成快照）+ typecheck + 配置示例一致性 + schema
  渲染一致性 + prompt-hit + secret-scan + examples-check + `row-anchor:check` + test:validate；
- 仓内断言 `tools/row-anchor-check.ts` 经 `npm run row-anchor:check` 纳入 `npm run check`：
  行锚解析/匹配 fail-closed（多候选 = null，绝不取首行）、恢复面四面不参与、记忆面禁单用
  row-index、四采集面编号/dup 键同口径；
- 真站证据（core `books-inrow-dup-grid`、probe `books-inrow-token-missing` 等）在仓库外
  `$AMBERFLOW_HOME/online-runs/`，**不提交**。

**未落地项与降级结论**：

- §7.4 的 ctrip 断言（"命中正确卡时断言航班号 / 撞多行按行分组证据"）**未实现**，只保留
  observe/run 观察；ctrip probe 用例按真实可达面观测，不作本批验收硬门（降级为观察项）。
- 规划面可达面矩阵**已由 `a1dd95f` 接线**（规划链停因点复用 `frameHintFailureEvidence`
  单点证据，stopCode 不变、无行锚声明时 reason 逐字节不变）——本方案与 ROW_INDEX 方案里
  历史"规划面不保证/属后续项"的表述统一为**已收口（a1dd95f）**，证据单点
  `frameHintFailureEvidence`。
- `row-index` 跨面可移植的**残余边界**如实保留：编号基 = 各面收集到的成员（池面 =
  `POOL_SEL`+heuristic 候选集，回捞/observe 面 = `ADMIT_SEL` 集合）；池帽只截尾、编号是
  页面前缀不压缩，但两集合对同组成员不一致时 N 仍可能不可移植。文档口径：**跨面可移植的
  前提 = 同名组成员在两个收集面都在场；照抄 inspect 候选前用 `ctx.observe`/run 复核**。
  后续项见 BACKLOG「编号基统一到页级全量收集」。
