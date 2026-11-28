# 顺序行锚 hint：`row-index:N` 落地方案（v1.0 · 已实施）

> **字段定义见 `docs/AGENT_INTERFACE.md` §3.2（元素字段唯一权威表）**；本文是历史方案文档，
> 保留方案、实施记录与验收证据，不重复字段清单（`row_texts` / `row_index` 的引擎↔桥键名、
> cap 与「哪一面有」以 §3.2 为准）。

> 状态：**已实施**（2026-11-16；批 2 首项 `a38e674` + 批 2 遗留收编 `13cd7ca`/`a1dd95f` +
> 批 3 首项 `3fcb098` + **F85（2026-11-16 评审收口）**；姊妹方案 `ROW_ANCHOR_HINT_PLAN.md` §10
> 有共用实施记录与验收证据）
> 规格版本：v1.0（v0.9 评审稿 → v1.0 定稿；结构范本 ROW_ANCHOR_HINT_PLAN.md，机制先例 F82 批 1 `c3d38f7`）
> 关联：F82（`in-row:<token>` 行锚，批 1 已实施 `c3d38f7`——本方案与之同构的姊妹方案，大量机制直接复用）、
>       F69（within:#id 链）、F70（frame:<origin>）、F63（歧义命中顺序 dom-preorder）、
>       F14/T9/B5（模型面剥离纪律，guard+解构双写教训）、F-1（回捞行补字段先例）、
>       ROW_ANCHOR_HINT_PLAN.md（批 1 方案与实施记录——结构范本、机制先例、遗留问题来源）、
>       RUN_TAKEOVER_AND_DOM_CONTEXT_PLAN.md §2.2（F82 注记后 D2 限缩为容器结构消歧——本方案与 D2 正交）、
>       BACKLOG.md「in-row:<token> 行锚后续立项」（#5 词边界/多 token、#2 hint-lint、#3 歧义反向提示）
> 用户裁决（本方案的立项依据）：**顺序行锚必须有**——排序榜、低价列表、"排序命令后点第 N 行"场景里，
> 序号可以是语义本身，不只是身份代理。

## 1. 背景与问题

### 1.1 契约级定性（用户裁决）

`in-row:<token>`（F82）解决的是"**行内容可分**"的同名网格：行的唯一可靠身份是内容
（航班号/订单号/商品名）。但存在一类真实场景，**序号本身就是语义**：

- 排序榜（销量榜、涨幅榜）："点第 3 名"——行的内容会整体随排序翻动，任何内容词元锚
  都会在下一次刷新漂移，**"第 3 名"才是用户心里的目标**；
- 低价列表："订最便宜的那一档"——排序完成后第 1 行即语义；
- 排序命令后的第 N 行："先按价格排序，然后点第 2 行"——前一步动作（排序）产出的顺序
  就是这一步的目标定义，内容是易变的、顺序才是稳定的。

这三类场景的共同点：作者**显式选择**以序号为语义，并承担"页面顺序变化 ⇒ 目标变化"的
责任（这正是"排序"类流程的本意）。契约里缺一块"顺序行锚"语法：现有三类尾缀
（within / frame / in-row）全部押在**内容或结构身份**上，序号身份没有通路。

### 1.2 实测证据（2026-11-16 books.toscrape 走查延伸 + F82 批 1 实证）

批 1 已实证 books.toscrape Travel 分类页是标准同名网格：11 个同名 `Add to basket`
（`form button[type=submit]` probe 11 hit、无 id/data-test/aria-label、池内零唯一 hint
形状），`in-row:<token>` 已全链闭环（`c3d38f7`，core 用例 `books-inrow-dup-grid` 真站
PASS）。在同一页面上：

| # | 通路 | 结果 | 说明 |
|---|---|---|---|
| 1 | `in-row:<token>` | ✅ 内容可分网格的主形态 | token 取行内容词元（书名）——已上线 |
| 2 | `row-index:N`（本方案） | ❌ 不存在 | "点第 3 个订票按钮"无语法可表达；序号即语义的场景（排序后的顺序）连底座都没有 |
| 3 | 内容词元护栏 | ❌ 硬案例 | **内容不可分网格**（行内容全同或全被生成期护栏拒绝：纯价格榜、纯序号榜、同名卡片无差异列）里，in-row 第 5 档候选全不自证 → suggestHints 交回人，Agent 无可照抄候选 |
| 4 | 池序 ref `eN` | ❌ 不可写进声明 | ref 是位置性的（每轮抽池重排/重编号，A4 章注释），写进冻结计划 = 下一次运行指到别的元素 |

**结论**：缺一块"顺序行锚"语法——`row-index:N`。它与 `in-row:` 同构（同一 dup 组底座、
同一 fail-closed 对称、同一 R2-5 整组回退纪律），并与 `in-row:` 组合成 fail-safe 主推形态。

### 1.3 序漂移的双重失败形态（本方案要区分的核心风险）

顺序行锚引入了一个 in-row 没有的风险维度：**序漂移**（页面顺序变化、窗口截断改变成员
集合）。同一语法下有两种失败形态，方案用"语义两类"把它显式化：

- **静默错点**（最恶性）：单用 `row-index:N`，页面顺序变了 → 第 N 个成员已是另一行 →
  动作"成功"地做在错的对象上；
- **显式落空**（可接受）：组合 `row-index:N in-row:<token>`，页面顺序变了 → 序号指向的
  行内容与声明 token 不符 → **显式落空而非错点**（fail-safe）。

方案不禁止单用（序号即语义的合法场景存在），但把组合守卫立为**主推形态**，并用生成纪律
（内容可分时不产 row-index 候选）与 done 断言纪律（作者指南）把单用的静默错点面压到最小。

## 2. 目标 / 非目标

**目标**

1. 任意 hint 形状可后缀 ` row-index:N`，命中集限定到"**同 dup 组内 DOM 先序第 N 个成员**"；
2. `row-index:N` 与 `in-row:<token>` 可组合：**双条件 AND**（序号与行内容同时满足）——
   内容不符 = 显式落空（fail-safe 主推形态）；
3. 与 `within:`/`frame:`/`in-row:` 组合：四类尾缀各至多一次、任意书写次序（集合过滤可交换）；
4. near / 无声明路径**逐字节不变**（结构性证明沿批 1 方法：编号是 additive 字段与独立过滤，
   不触碰 out 累加器；固定 DOM 语料双实现对拍断言）；
5. 观察/建议/歧义/诊断全链闭环（F70/F82 的全链一次到位纪律）：
   `observe`/`inspect` 的 hint_candidates 可产出 `row-index` 候选（仅内容不可分网格），
   越界 reason 报组大小 K 与真实行词元；
6. 证据可审计：动作 trace 带所选行的 `row_index` + `row_texts`（事后可回答"点的是哪一行"）。

**非目标（明确 out of scope）**

- **页面级行号语义**：`row-index:N` 是"同名 dup 网格内第 N 个成员"，不是"页面第 N 行"
  （跨网格、跨 tag 的页面级序号没有稳定底座，也无 fail-closed 对称可守）——语义边界 §4；
- 词边界档位 / 多 token 组合行锚（`in-row:a>b`）——沿用批 1 §2 非目标与 §8.11 遗留，有实测碰撞证据再议；
- `near~` 形状复用 row_texts/row_index 作匹配底座——沿用批 1 R8 否决（改既有形状语义无字节纪律保护）；
- done/when 信号面（天然 CSS；"第 N 个元素存在"用 `css_count_equals`/`css_count_min` 已可表达）；
- stability 元数据 / unstable 标记机制——沿用批 1 §2 否决（结构性安全优于警告标记，警告没人读）；
- FW8 / DRF / F64 / A3 声明目标恢复路径白名单扩展——**不做且已 fail-closed**：声明行锚时
  恢复面不参与（落空 = `target_not_found` + 行锚证据，绝不按 base 绕过行约束）；池外行锚恢复
  仍属 Phase 2。

## 3. 设计

### 3.1 语法（第四尾缀）

```
<hint 六形状之一>[ within:#id链][ frame:<origin链>][ in-row:<token>][ row-index:N]
```

- 四类尾缀**各至多一次**、任意书写次序；任一类超限/值非法 ⇒ **整组后缀都不应用**
  （按原始串回退，绝不半剥——R2-5 **四类版**；唯一剥离出处仍为 `splitTailSuffixes`）；
- 值闭集：**1-based 正整数**，词法 `\S+` 天然禁空白，解析面校验 `^[1-9]\d{0,8}$`
  （无前导零；≤9 位为词法卫生——10 亿上界远超任何真实网格，语义上界由越界面兜底，见 §3.9）；
  `0` / 负数（`-` 被 not-positive-integer 拒，文案点名"row-index 从 1 开始"）/ 非数字 / 带空白（词法天然拒）= 整组回退；
- 解析只管形状："解析只管形状，匹配是各观察面自己的事"（hint.ts:9-10 纪律）——
  数值转换（`Number`）在解析面完成（≤9 位内 Number 精确），匹配面只做整数相等比较；
- 示例：
  ```
  订票 row-index:3                          ← 单用：第 3 个订票按钮（序号即语义）
  订票 row-index:3 in-row:sc7960            ← 组合守卫：第 3 行且行内容含 sc7960（fail-safe 主推）
  订票 row-index:3 in-row:sc7960 within:#modal frame:https://shop.example.com   ← 四尾缀全组合
  ```

### 3.2 解析面（hint.ts）

- `ParsedHint` 六形状各加可选 `rowIndex?: number`（与 `within`/`frameChain`/`inRow` 字段同构）；
- `ROW_INDEX_TAIL_RE = /(?:\s+row-index:)(\S+)\s*$/i`（splitTailSuffixes 内）；诊断面空值版
  `/(?:\s+row-index:)(\S*)\s*$/`（同 `FRAME_TAIL_VALUE_RE`/`INROW_TAIL_VALUE_RE` 模式）；
- `rowIndexValueProblem`（empty / not-positive-integer / too-many-digits），与 `inRowValueProblem`
  同位：解析面判合法、诊断面要原因类别。**类别口径（v1.0 仲裁定稿，B 项修正）**：
  `empty`（无值）/ `not-positive-integer`（0、负数、非数字、带字母——**文案必须点名
  "row-index 从 1 开始"**：0 与负数是作者常见笔误，拒因要点名而非笼统"非数字"）/
  `too-many-digits`（>9 位）。`>` 与带空白由词法天然拒绝（`\S+` 不收空白；纯数字值不含
  `>`），不单设类别；
- `describeRowIndexSuffixRejection(hint)` 与 `describeRowSuffixRejection` 同构，接 executor
  target_not_found reason 与会话 act reason（消费点与 frame/in-row 版一致——
  extraction.ts `frameHintFailureEvidence` 单点接线）；
- 循环剥离扩展为四类：三类既有分支不动（`within`/`frame`/`in-row` 的值校验、seen 计数、
  hasUnclosedBracket 伪尾缀守卫逐字节保留），追加 `row-index` 分支（同结构：base 空/重复/
  值非法/伪尾缀 ⇒ 整组 rejected）。**解析只管形状**：数值合法性在解析面判完，匹配面不再解释。

### 3.3 池侧匹配（rules.ts hintMatchImpl）

- 批 1 现状：`const limit = (refs) => inRow(inAnchor(refs))`（组合过滤，集合可交换）；
- 本方案扩展为 `limit = rowIdx(inRow(inAnchor(refs)))`：
  ```ts
  const rowIdx = (refs: string[]): string[] =>
    parsed.rowIndex === undefined ? refs
      : refs.filter((r) => elems[r]!.row_index === parsed.rowIndex);
  ```
  **整数全等比较**（不是 includes——序号是离散身份，无"子串序号"语义）；
- 覆盖面自动一致：`limit` 是批 1 已收口的唯一组合过滤出口（emit / attrSubstr 三分档 /
  tag-submit 偏好 / bare 五档全部经它），**无须再逐点接线**——这是批 1 把 5 处调用点收口成
  单一 `limit` 的直接红利；
- **限定后本档清空 = 落空，不跨档降级**（跨档混选防线不变，照抄批 1 语义）；
- **fail-closed 对称**：元素无 `row_index`（非重复组）⇔ row-index 恒不命中 ≙ in-row 无
  row_texts 恒不命中 ≙ frame 对未知 origin 帧不可命中——行锚族（in-row/row-index）只服务
  "同文案网格"这一它们要解决的问题，不制造新歧义；
- 组合守卫的双条件 AND：`row_index === N && rowMatch(token)`——两个独立过滤的合取，
  内容不符 ⇒ 过滤后空 ⇒ 显式落空（**不是**"放宽到任一条件满足"）。

### 3.4 数据面：`Elem.row_index`（dup 组 DOM 先序编号）

- 字段：`row_index?: number`（1-based）。**仅同文案重复组元素携带**（与 near/row_texts 同触发）；
  注释注明：只服务匹配/回捞/建议/证据，不进模型面（§3.7）；
- **编号口径（本方案的核心裁决点，实现必须四面一致）**：`row_index` = 该元素在
  **本帧内、同 dup 组（同 tag+同 label）成员中按 DOM 先序（scan 升序）的位次**（1-based）；
  - 为什么是**帧内**：dup 判定与编号的全部 JS 采集面（OBSERVE_JS/HINT_HEAD/A3）天然按帧
    运行（一帧一次 evaluate，只见本帧文档）；池侧 `addNearContext` 的 dup 计数（`cnt`）虽是
    跨帧的（触发面：跨帧同名互为 dup、near/row_texts 同触发不变），但**编号**按
    `(frame, tag+label)` 子组内 scan 升序做——单帧场景 = 纯 DOM 先序，跨帧同名网格各自编号；
  - **四采集面同口径（F85 评审收口）**：池 `addNearContext` / `OBSERVE_JS` / `HINT_HEAD` / A3
    四 pass 的 dup 键统一为共享 `__rowLabelOf`（与池 label 同口径：aria-label→title→**首子节点
    文本**→innerText→placeholder→value；input/select 追加 label 包裹文本；PUA 剥除 + 空白
    折叠 + 40 字符）；`HINT_HEAD`/A3 的编号只计**可见**成员（与池/observe 对齐——隐藏成员不
    占序号）；
  - 为什么不是页面级行号：跨网格、跨 tag 的页面级序号没有稳定底座（§4 语义边界）；
  - **跨帧同名组**：两个帧里各有一个"订票"网格时，各自 1..K；`row-index:2` 会同时命中两帧
    的第 2 个成员 → **跨帧歧义**由既有口径兜住（`frame:` 尾缀收窄 / `firstIfSame` 同签名
    合并 / `target_ambiguous` 歧义谓词）——不新增跨帧处理（D2 边界沿 frame: 批条款）；
- **编号底座的截断边界（如实声明）**：编号是**页面前缀**（1..K 按扫描到的 DOM 先序），
  池帽只会**截尾**（窗口截断丢掉尾部成员，不重新编号、不压缩前缀）。编号基于**本面收集到的
  dup 成员**——池面 = 池内可见成员（`POOL_SEL`+heuristic 候选集，64/128 窗口截断同界），
  回捞面 = `ADMIT_SEL` 收集面全组，observe 面 = 观察集合内可见成员（max 截断同界）。同面内
  编号自洽；**跨面 K 可能不同**（池面被截断时 K 小于页面真实组大小）——序漂移的一种来源，
  组合守卫缓解 + 诊断面报本面 K（§3.9 案①），批 1 遗留 #5（虚拟列表同界）同源；
  **跨面可移植的前提 = 同名组成员在两个收集面都在场**：两个收集面的元素宇宙不同
  （池面 `POOL_SEL`+heuristic 候选集 vs 回捞/observe 面 `ADMIT_SEL` 集合），对同组成员不一致
  时 N 仍可能不可移植——**照抄 inspect 候选前用 `ctx.observe`/run 复核**；编号基统一到页级
  全量收集列为 BACKLOG 后续项；
- **采集接线（实现锚点，全部在 c3d38f7 已就位的结构上做 additive 扩展）**：
  - 池面：`addNearContext` 已有全组 dup 清单（`dups: [ref, scan, frame]` + `cnt`）——宿主侧
    按 `(frame, tag+label)` 子组 scan 升序编号写入 `elems[r].row_index`（纯宿主计算，零新增
    页面往返；与 row_texts 的宿主写入同点）；
  - OBSERVE_JS：dup 门控循环（`dupCnt`/`dupLabels`）内给 dup 组成员按 rows 数组序（= DOM
    先序）编号，additive 字段 `row_index`（无 dup 页不出键 ⇒ 观察 JSON 逐字节不变）；
  - `ROW_CLIMB_JS` 不动：编号不是爬升产物（是 dup 组序），扩组序号在 dup 门控/宿主分组处做，
    `__dupKeyOf`/`__dupLabelsOf`（dup 键单一出处）直接复用——不新增第二套键函数；
  - 模型面/签名：`row_index` 不进 `ChoiceRequest.elems`（`modelProjectionOf` **guard 与解构
    两处同步**加 row_index，B5 教训）；**不进 esig/firstIfSame 签名**（新字段天然不在，
    实施时只核验不修改）。

### 3.5 回捞/回退对等（pool-js.ts HINT_HEAD / executor.ts DOM_FALLBACK，F-1 同构）

- 回捞是"计划点名但被预算逐出"的最后通道，必须同口径：**回捞行缺 row_index + 声明
  row-index ⇒ 二次 hintMatch 的 rowIdx 过滤清零 ⇒ 回捞路径整体死路**（F-1 同构问题，
  批 1 已用同一结构闭合 in-row 侧）；
- **HINT_HEAD in-row 门扩展为 in-row/row-index 门**（结构照抄批 1：惰性 + memoized +
  凑满 5 早退 + 总计算封顶 120 超标 fail-closed）：
  - 门触发条件：`p.inRow !== undefined || p.rowIndex !== undefined`（声明任一即启用；
    未声明 ⇒ 门整块不进 ⇒ 回捞行形状与今天逐字节一致）；
  - 编号计算（v1.0 措辞收紧，C 项修正）：**一次 O(n) 全组序映射**，不是逐候选计算——pass
    内对 `all`（ADMIT 收集面）按 `__dupLabelsOf`（dup 键单一出处，已算 dupLabels）分出的
    同组成员做 **scan 升序位次表**（组内第 k 个成员 → row_index = k，一次遍历完成）；memo
    **只适用于组合守卫的 row_texts 爬升**（批 1 门结构原样）；**单用 row-index 声明 = 零爬升
    成本**（位次表查表比较，无 innerText 读取）——这是 R3 的强化论据（编号比爬升便宜一个
    量级，门封顶语义对编号路径实际不可达）；
  - 收集谓词：单用 = `row_index === N`；组合 = `row_index === N && 行词面含 inRow`
    （双条件 AND 与池侧同口径）；
  - 回捞行补 `row_index`（additive，与 row_texts/anchor_ids 同形）；
- **A3 DOM fallback**：`arg` 增 `rowIndex`（宿主 `parseHint(target).rowIndex` 随 inRow 同点
  下发）；声明时每行补 `row_index`（dup 编号按收集面 DOM 先序）；未声明时零计算、行形状
  逐字节不变（批 1 的 2b 形状基线字段集断言扩一档）；
- PASS_HINT_PROBE 经 `HINT_HEAD.replace(...)` 派生自动继承——验证只读路径不受盖章改动影响
  （批 1 1f 断言同款）；
- 性能：编号是 O(组内排序) 的纯内存计算，爬升仍是唯一昂贵路径且仅声明时启用（批 1 R2 缓解
  原样适用）；封顶 120 语义不变（超标 fail-closed）。

### 3.6 建议闭环（rules.ts suggestHints 第 6 档，生成纪律）

- 批 1 现状：第 5 档 = within 全落空后从 row_texts 生成 `<label> in-row:<token>`（within
  产出即跳过——`withinPushed` 门）。追加**第 6 档**：
  - **触发门槛（生成纪律，本方案的核心裁决点）**：仅当 **within 全落空 且 第 5 档（in-row
    词元候选）全落空** ——即行内容词元全被生成期护栏拒绝或全不自证（**内容不可分网格 = 硬
    案例本体**）——才从 `row_index` 生成 `<label> row-index:N`（N = 该元素组内序号），走
    同一个 push → hintMatch 自证（恰好唯一命中才保留），命中即停；
  - **内容可分时内容候选优先**：第 5 档先行且命中即停 ⇒ 内容可分网格的候选清单里不出现
    row-index（序号是身份代理，能不用就不用——与用户裁决"序号可以是语义本身"不冲突：
    生成纪律只管"引擎建议什么"，不管"作者可以声明什么"）；
  - **单用 only**：生成器不产 `row-index:N in-row:<token>` 组合候选（Q3 仲裁定稿：不产）——
    内容可分时第 5 档已给 token 单用候选，同 token 组合是冗余候选挤 cap 4 槽位（R-10 顺序
    纪律：身份→label→frame→within→in-row→row-index，`out.slice(0,4)` cap 不动）；作者需要
    双保险时**手写**组合——"内容可分时优先手写 `row-index:N in-row:<token>`"立为**推荐纪律
    （非强制）**（Q2 仲裁定稿：序号即语义是用户裁决的合法部分，强制守卫会把排序榜类合法
    用例逼出语法；分层缓解——生成纪律 + done 纪律 + trace row_evidence——已足够），
    §4.13 批 2 文档项；
  - **不产 unstable 标记**（沿用批 1 裁决理由：带 unstable 警告的候选是半成品承诺，作者会
    照抄且警告没人读——宁可不产出交回人；row-index 候选只在内容完全不可分时才产，此时它是
    唯一可行动出口而非半成品）；
- 收益链：observe/inspect 的 hint_candidates、歧义证据 `suggested_hint`
  （`suggestHints(e, elems)[0]`）自动产出可照抄候选；observe 准入 = suggestHints 非空自动
  受益（**内容不可分网格从此在 observe 面可准入**——批 1 遗留的硬案例闭环）。

### 3.7 模型面剥离与证据面（executor-pure.ts / trace）

- `row_index` **不进** `ChoiceRequest.elems`（F14/T9/F82 同一纪律）：序号是引擎内部定位
  底座，灌进模型视图 = 改变模型世界（对拍语料碎）且诱导模型按序号提名（位置性 ref 的
  老坑，A4 章注释）；`modelProjectionOf` **guard 与解构两处同步**加 row_index（B5 教训：
  只改解构会泄漏）；
- **不进 esig/firstIfSame 签名**（新字段天然不在；实施时只做核验断言，同批 1 免改核验项）；
- **证据面（目标⑤）**：声明 row-index / in-row 的目标解析成功后，动作 trace 行 additive
  `row_evidence: {row_index?: number, row_texts?: string[]}`（取所选 Elem 的实值，仅字段
  存在时出现；缺省路径零新字段）。事后可审计"点的是哪一行"：row_index 回答第几个成员、
  row_texts 回答那一行长什么样——序漂移事故的归因证据（done 断言纪律的配套，§4.13）。
  trace 字段面属批 2 实现细节（镜像 `resolved_by`/`declared_resolve` 的 additive 先例）。

### 3.8 observe/inspect 面闭环（F70/F82 全链一次到位纪律）

- OBSERVE_JS dup 门控采集 row_index（additive；无 dup 页观察 JSON 逐字节不变——批 1 golden
  方法直接复用）；`syntheticElem` 透传 → observe 自证池与池行同构，suggestHints 第 6 档在
  observe 面自动闭环（**内容不可分网格从此可在 inspect/observe 拿到可照抄候选**——批 1
  遗留的硬案例出口）；
- `whyNotAdmitted`（observe.ts）**同批追加** row-index 可行动指引：在批 1 的 in-row 指引
  之后补一句"行内容全同时（无差异词元），用 `<label> row-index:N` 按网格内顺序定位"；
  observe 面边界声明不变（自证范围 = 本次观察集合）；
- `ObserveElement` 输出面加可选 `row_index`（批 1 先例：row_texts 输出面字段 + 桥白名单
  边界如实标注——桥 `element-view.ts` 未列入前桥面不出现，BACKLOG 立项 #4 同款跟进项）。

### 3.9 失败诊断口径（stopCode 保持 target_not_found/target_ambiguous，不加新码；镜像批 1 §3.9 三案）

| 场景 | reason 口径 |
|---|---|
| ① N > K（越界）或组不存在 | `row-index:N 超出网格组大小 K`——报本面真实组大小 K（按 tag+label 分组）+ 真实行词元 ≤8（镜像 in-row 案①"池面真实行词元"先例与 frame: "页面实际可用 origin" 先例）。窗口截断导致的 K 偏小在此可见（K 与页面不符是诊断素材） |
| ② N ≤ K 但组合守卫内容不符 | `序号已定位（第 N 个成员）+ 行内词面不符`——作者改 token 或核对顺序（in-row 案②"改 base 不改 token"的行镜像） |
| ③ 组合后仍多候选（跨帧同名网格 / 多网格同页各含同序成员） | `target_ambiguous` 按现场列出、零动作（永不选第一行）——收窄 `frame:`/`within:` 或 token |
| ④ 尾缀形状非法 | 整组回退显式落空 + `describeRowIndexSuffixRejection` 点名（0/负数/非数字/带空白/重复尾缀/缺主体） |

三案 reason 必须可区分；接线深度镜像批 1（extraction.ts 证据面单点扩展，`elems` 可选参
既有结构上加 row-index 分支——`frameHintFailureEvidence` 不新增第二个证据函数）。

**诊断可达面矩阵（v1.0 必改 A 项；批 1 真站实测暴露 → 批 2 遗留收编 `a1dd95f` 后已覆盖）**
三案证据的接线点（executor 命令空间停因 / `act_hint:"strict"` / 会话 act，全部经
`frameHintFailureEvidence` 单点）批 1 时只在 app flow / 会话面可达；**规划面（plan/probe
子目标，`runSubgoalWithRetries` 链）已在批 2 遗留收编 `a1dd95f` 接线**——规划链停因点复用
同一 `frameHintFailureEvidence` 单点追加行锚证据（stopCode 不变、无行锚声明 reason 逐字节
不变）。批 1 probe 真站实测的 `low_confidence`（0.13 < floor）停因是**收口前的历史观察**，
现状见下表：

| 停因路径 | 三案证据可达性 | 依据 |
|---|---|---|
| app flow 命令空间停因（pending unresolved → `target_not_found`） | ✅ 保证 | executor 命令空间停因处的证据接线点（批 1 已接 elems 参；`a1dd95f` 覆盖命令步） |
| `act_hint:"strict"` 停因 | ✅ 保证 | strict 分支证据接线点（批 1 已接） |
| 会话 act 落空诊断（`diagnostics:true`） | ✅ 保证 | 会话 act 证据接线点（批 1 已接） |
| act hint widen（缺省）落空 → 回退模型 | ⚠️ 不保证 | widen 路径不产 `target_not_found`（回退 `low_confidence`，词面诊断）——**这是 widen 路径本身的设计**，不是行锚缺口 |
| 规划面（plan/probe 子目标） | ✅ **已覆盖**（`a1dd95f`） | 规划链停因点复用 `frameHintFailureEvidence` 单点；证据单点 = `frameHintFailureEvidence`（本方案 §8 遗留 #8 已收口） |

**probe 用例期望口径（相应调整）**：`books-rowindex-out-of-range` 的 fail-closed 正向证明 =
**零动作 + 诚实落空**；规划面停因现为 `target_not_found` + 案①证据（`a1dd95f` 起）。批 1 probe
观察同时留档了一条正向结论：**序号缺失 ⇒ 零动作零错点成立**（规划面也没有静默取第一行）。
probe 现在还可断言**零动作/零错点**（在线声明面的零动作断言字段，见 CHANGELOG review 收口条）。

## 4. 语义边界（写进文档，不当 bug 修）

- **"row-index:N ≠ 页面第 N 行"**：它是"同名 dup 网格内第 N 个成员"（帧内、同 tag+label、
  DOM 先序）。页面里有两个不同网格时，`row-index:2` 命中两个网格各自的第 2 个成员 →
  歧义谓词兜住（案③）；作者写页面级序号诉求 = 语义误用，文档点名修正法
  （收窄 within/frame/in-row 或换内容锚）；
- **序漂移的两种失败形态**（§1.3）：单用 = 可能静默错点（作者显式承担——序号即语义的
  代价，文档写明）；组合 = 显式落空（fail-safe）。**引擎不新增"静默取第一个"**；
- **编号底座是"本面收集到的成员"**：编号本身是**页面前缀**（1..K 按扫描到的 DOM 先序），
  池帽只会截尾（丢尾部成员，不重新编号/不压缩）——池窗口截断 / 观察集合 max / 虚拟列表都会
  让 K 小于页面真实组大小（批 1 遗留 #5 同源）——单用形态在此场景的错点面由组合守卫与
  done 断言纪律缓解；有实测误锚案例再议"全组编号"（需池外计数，成本另评）。**跨面可移植的
  前提 = 同名组成员在两个收集面都在场**（池面 `POOL_SEL`+heuristic / 回捞·observe 面
  `ADMIT_SEL` 两个元素宇宙不同；照抄 inspect 候选前用 `ctx.observe`/run 复核）；
- **DOM 插入/重排**（列表插入广告、懒加载补行）：编号随 DOM 先序变化——这是序号语义的
  固有属性，不是缺陷；fail-safe 形态把它转成显式落空；
- **重复组按池内可见计数**、`anchor_ids` ≤8 截断、重复 id（M6②）等既有 fail-closed 条款
  原样适用（row-index 继承 dup 组底座的全部边界）；
- row-index 服务重复网格；非重复组元素写 row-index = 恒落空（fail-closed 对称，作者指南
  写明，风险 R6 同款）；
- **near vs row_texts vs row_index 一句话分工（作者指引，写进文档）**：near = 模型视图
  单行（宿主挑选后的展示装饰）；row_texts = in-row 匹配底座（内容词元来源）；
  row_index = row-index 匹配底座（dup 组内 DOM 先序位次）。作者只照抄 hint_candidates，
  混淆面在文档层消解（批 1 §4 裁决的延伸）。

## 5. 分批实施清单

**批 2 首项（已实施，一次 PR；结构镜像批 1，全部为 c3d38f7 已就位结构上的 additive 扩展）**
代次口径：`row-index` 声明编号 **F83**（批 2 = F83；批 3 = F84，见 CHANGELOG 映射）。

| 文件 | 改动 | 字节/纪律约束 |
|---|---|---|
| `src/engine/hint.ts` | 六形状加 `rowIndex?: number`；`ROW_INDEX_TAIL_RE`（含诊断空值版）；四类循环剥离；`rowIndexValueProblem`（empty / **not-positive-integer**〔文案点名"row-index 从 1 开始"〕 / too-many-digits，B 项修正）；`describeRowIndexSuffixRejection` | R2-5 四类版整组回退；三类既有分支逐字节不动；解析只管形状 |
| `src/engine/rules.ts` | `rowIdx` 过滤并入 `limit`；suggestHints 第 6 档（`withinPushed` + 第 5 档全落空才触发） | 限定后空=落空不跨档；cap 4 与 R-10 顺序不变；整数全等比较 |
| `src/engine/extraction.ts` | `Elem.row_index` 字段（注释注明不进模型面）+ addNearContext 编号接线 + 证据面 row-index 分支 | 编号口径 = 帧内 dup 组 DOM 先序（(frame, tag+label) 子组 scan 升序）；near pick 消费面不动 |
| `src/engine/pool-js.ts` | OBSERVE_JS dup 门控编号（additive）；HINT_HEAD in-row/row-index 门扩展 + 回捞行补 row_index | **String.raw 模板首行直接跟内容、模板内不加注释行**（ROW_CLIMB_JS 本身不动）；无声明逐字节不变；无 dup 页观察 JSON 逐字节不变 |
| `src/engine/executor.ts` | DOM_FALLBACK arg.rowIndex + fallback 行补 row_index | 缺字段=重演 F-1 半链缺口；未声明形状基线字段集断言扩一档 |
| `src/engine/executor-pure.ts` | modelProjectionOf 剥离 row_index | **guard 与解构两处同步**（B5） |
| `src/engine/observe.ts` | syntheticElem 透传；ObserveElement.row_index；whyNotAdmitted 追加 row-index 指引 | 边界声明随文案（桥白名单边界如实标注） |
| `src/engine/executor.ts`（trace） | 动作 trace 行 additive `row_evidence: {row_index, row_texts?}` | 仅声明 row-index/in-row 且解析成功时出现；缺省路径零新字段 |
| `src/cli/schema-gen.ts` | 新 F83 声明（statement/truth 对齐 F69/F70/F82 写法） | schema 快照为 gitignored 构建产物；`check:ci` 负责漂移门 |
| `src/engine/grammar-prompt.ts` | `HINT_ROW_INDEX_SUFFIX` 示例 + import 时 parseHint 自证断言（四尾缀全组合排列、整组回退、单用形状） | 语法对齐既有自证机制（prompt-hit 组保持绿） |
| docs | APP_SCRIPT_AUTHORING §4 尾缀四并列 + 新 §4.13「顺序行锚：序号即语义与内容守卫」（两类语义/组合守卫/done 断言纪律/越界）+ §10 停因表四案口径 + §11 已知边界；AGENT_INTERFACE ElementView 表加 row_index 行 + trace 证据说明；README 能力 bullet 增序数场景；RUN_TAKEOVER §2.2 注记补序数类；BACKLOG 立项条目更新（本条收编）；CHANGELOG 批 2 单条 Unreleased | — |
| online | core/books-row-index.json（序数场景：单用 `row-index:5`（Q5 仲裁定稿：进 core，N 取中段）+ 组合守卫 `row-index:3 in-row:<token>` 双子目标 + 结束态不变量）；probe/books-rowindex-out-of-range.json（`row-index:99` ⇒ 零动作 + 诚实落空；规划面停因已由 `a1dd95f` 接成 `target_not_found` + 案①证据，probe 可断言零动作/零错点——§8 遗留 #8 已收口） | URL 真实 http(s)；凭据只允许 {{env:NAME|default}}；test:validate 过即入批，真站执行批后验证；批 1 既有 `books-inrow-token-missing` 的 goal 文案（"期望 target_not_found"）随批 2 docs 项顺带按实测口径修正 |

**免改核验项（实施时只做断言核验，不修改）**：`hintLookupArgs`（parsed 自动携带
rowIndex）；esig/firstIfSame（天然不含 row_index）；`ROW_CLIMB_JS` 三 helper 与 out/rows
累加器（编号不进爬升）；PASS_NEAR 唯一消费点；hint-lint（parseHint 自动继承）；nearToken
池侧语义；`near~` 形状；批 1 的 near/observe golden 面（无声明路径逐字节不变的正向证明）。

**恢复面行锚语义（F85 评审收口，原"显式缺口"已关闭）**：identity.ts/declared.ts 的 FW8
声明目标恢复路径、DRF、F64 `#id` 直查与 A3 DOM 回退在声明行锚时**统一 fail-closed、不参与
恢复**——落空 = `target_not_found` + 行锚证据，不按 base 身份/文本绕过行约束；A3/HINT_HEAD
已支持 `row_index` 底座（§3.5）。批 2 后续项已收编：findByHint / plan check --probe /
apps check hint-lint 行锚适配（`13cd7ca`）；桥 ElementView 透传 row_index/row_texts 属合同
变更（`3fcb098` 已收编）。池外行锚恢复仍属 Phase 2。

## 6. 风险表

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **序漂移静默错点**（单用形态：DOM 插入/重排/窗口截断改变成员集合 ⇒ 第 N 个成员已是另一行） | 语义两类显式化（§1.3）：单用=作者显式承担（序号即语义的合法场景）；组合守卫=fail-safe 主推（内容不符=显式落空）；生成纪律（内容可分不产 row-index 候选）；done 断言纪律（§4.13 把静默错点降级为 done 失败）；trace row_evidence 事后归因 |
| R2 | **四面编号口径漂移**（池/回捞/回退/observe 各自编号，键函数/排序序不一致） | dup 键单一出处已就位（`__dupKeyOf`/`__dupLabelsOf`）；编号口径单点定义（§3.4：帧内 dup 组 DOM 先序）；固定 DOM 语料四面编号一致性断言（验收 §7.2）；golden 对拍方法沿批 1（oldtree 双实现） |
| R3 | HINT_HEAD 性能（编号 + 爬升在回捞面） | 仅 parsed.inRow/rowIndex 声明时启用（门触发条件扩一档）；**编号 = 一次 O(n) 全组位次表**（C 项修正：非逐候选计算——单用 row-index 声明**零爬升成本**，封顶语义对编号路径实际不可达）；memo 只适用组合守卫的 row_texts 爬升（每候选一次）；凑满 5 早退；总计算封顶 120 超标 fail-closed（批 1 R2 缓解原样适用） |
| R4 | 模型面泄漏（row_index 进 ChoiceRequest 改变模型世界） | modelProjectionOf guard+解构两处同步（B5 教训）；esig/firstIfSame 核验断言；池行体积零增量（number 字段仅重复组携带） |
| R5 | observe 时延 | 编号是 dup 门控循环内的 O(K) 排序，无新增爬升；dup 门控本身是批 1 已实测面；降级预案沿批 1（1a/1b 同条目两步、不可跨迭代）备而不用 |
| R6 | 非重复组写 row-index 恒落空且诊断不提底座 | fail-closed 可接受（与 in-row 同款）；诊断案①报"网格组不存在"指引 row-index 语义；指南写明 |
| R7 | 跨帧同名网格歧义（两个网格各含同序成员） | 歧义谓词兜住（案③零动作）；`frame:` 尾缀收窄；firstIfSame 同签名合并 = 既有 D2 边界不新增处理；语义边界写明 |
| R8 | 编号底座跨面 K 不一致（池面截断 K < 回捞/收集面 K） | 如实文档化（§3.4 截断边界）；案①报本面 K（差异即诊断素材）；组合守卫 fail-safe；有实测误锚案例再议全组编号（遗留 §8） |
| R9 | 与 F63 dom-preorder 的交互（on_ambiguous:"act" 的执行序 vs row_index 编号序） | 同源：编号 = 组内 scan 升序 = DOM 先序 = F63 排序键（同 scan 按 ref）——组合守卫命中集内 F63 重排不改变"第 N 个成员"的身份；验收加一条交互断言 |

## 7. 验收标准（正式版——批 2 实施门禁）

1. `npm.cmd run check` 全绿——本仓无 *.test.ts，唯一 PR 门禁（`npm.cmd`，Windows 执行策略）；
2. **离线纯函数断言**（一次性证据脚本出仓库，沿批 1 证据目录方法）：row-index × 六形状 ×
   组合守卫（序对内容不符=落空、序对内容符=命中）× 越界（N>K=落空+案①证据报 K）×
   四尾缀组合与次序无关（24 排列全采样）× 整组回退（双 row-index / `0` / 负数 / 非数字 /
   带空白（词法）/ 属性值内伪尾缀 / 跨类连坐）× 全角落空（非重复组恒落空 fail-closed 正向）×
   bare 限定后空不跨档 × 单用命中（dup 组 DOM 先序第 N 个）× 编号四面一致性（固定语料）×
   生成纪律（内容可分不产 row-index / 内容不可分产）× R9 交互断言；
3. **near/observe 逐字节 golden**（沿批 1 oldtree 双实现方法）：无声明路径 near/observe
   JSON 逐字节不变 + golden Elem.near 全量 + hintMatch/hintCandidates/suggestHints 旧输出
   全等（含第 5 档既有行为）+ 无 dup 页观察 JSON 逐字节不变；smoke/core 真站前后跑批后执行
   （lead 评审后另跑），traces near/observe diff = 空；
4. **online 用例**（test:validate 过即入批；真站执行批后验证）：
   - core `books-row-index`：单用 `row-index:5`（Q5 仲裁定稿：进 core，N 取中段——序号即
     语义形态）+ 组合守卫 `row-index:3 in-row:<第 3 本书名 token>`（fail-safe 形态）
     双子目标 + 结束态不变量；
   - probe `books-rowindex-out-of-range`：`row-index:99` ⇒ **零动作 + 诚实落空**（fail-closed
     正向证明）——规划面停因已由 `a1dd95f` 接成 `target_not_found` + 案①证据；probe 还可
     断言零动作/零错点（在线声明面零动作断言字段）。**ctrip 的"命中卡断言航班号 / 撞多行
     按行分组证据"未落地**（随 ROW_ANCHOR_HINT_PLAN §10 降级为观察项，不作本批验收）。
5. **用户故事级验收（产品）**：
   - US1 排序榜：排序命令后 `row-index:1` 命中榜首行（序号即语义）；
   - US2 fail-safe：同一声明在行序被广告插入打乱后重跑 = 显式落空（reason 报序号已定位 +
     行内词面不符），**零错点**；
   - US3 硬案例闭环：内容不可分网格（行内容全同）在 inspect/observe 拿到唯一 `row-index:N`
     候选且 admitted=true，run 3/3 命中对应序成员。

## 8. 遗留问题

1. 编号底座的"全组 vs 本面收集面"分歧（R8）——池面截断时 K 偏小；有实测误锚案例再议
   池外全组计数（成本另评，倾向维持本面就地编号 + 文档声明）；
2. 虚拟列表 row_index 与池窗口同界——文档接 ctx.scrollList/collect 分块指引（批 1 遗留
   #5 同源，两者合并处理）；
3. row_index 与 row_texts 的字段形状与 BACKLOG #2（候选列表上移应用层）契约对齐——批 1
   遗留 #1 的延续，两次改池问题同样适用本字段；
4. 跨帧同名组的 firstIfSame 同签名合并（同 tag+label 同 row_index 跨帧）——D2 边界沿
   frame: 批既有条款，批 2 实现时加验证断言（不新增处理）；
5. FW8 / findByHint / hint-lint / 桥 ElementView 透传——**已收口**（F85：四面恢复
   fail-closed；`13cd7ca` findByHint/hint-lint；`3fcb098` 桥透传）；池外行锚恢复仍属 Phase 2；
6. 生成纪律的"部分可分"网格（部分行有标识词元、部分没有）：第 5 档对有词元的行成功、
   没词元的行走第 6 档——逐元素独立触发，天然支持；无额外工作，实施时加一条断言钉死；
7. `row-index` 与 `in-row` 的诊断证据函数合并度（同一证据面内两个分支 vs 各自函数）——
   批 1 证据面已单点接线（`frameHintFailureEvidence` 可选 elems 参），批 2 在其上加分支，
   不另立函数；实现时定文案合并形态；
8. **规划面三案接线——已收口（`a1dd95f`）**：诊断三案证据的保证面原为 app flow 命令空间 /
   strict / 会话 act（§3.9 矩阵）；批 1 probe 实测的 `low_confidence` 停因已由批 2 遗留收编
   在规划链四个停因点 additive 接线（同一 `frameHintFailureEvidence` 单点，stopCode 不变），
   probe 用例按 `target_not_found` + 案①证据观测。批 1 既有 `books-inrow-token-missing` 的
   goal 文案已随批 2 docs 项按实测口径修正。

## 9. 评审记录（2026-11-16，v0.9 → v1.0）

lead 评审结论：**方案骨架合格**；开放问题 Q1-Q6 全部裁决（本稿"倾向"全部采纳）+ 四项必改
（A-D）收编为 v1.0 定稿：

| # | 裁决 | 定稿口径 |
|---|---|---|
| Q1 | **保留 `row-index`** | 与 in-row 词族对称、作者心智连续（同一 dup 组底座、同一 fail-closed 对称）；`nth` 会引入 CSS :nth-child 心智模型、恰好诱导 §4 要挡的"页面第 N 个元素"误读；grid-index 更精确但破坏词族且别扭——误读风险由 §4 语义边界 + 案①诊断文案兜住 |
| Q2 | **混合形态不强制内容守卫** | 序号即语义是用户裁决的合法部分（排序榜 US1 场景里内容按定义易变，强制守卫会把合法用例逼出语法）；分层缓解（生成纪律 + done 纪律 + trace row_evidence）已足够；v1.0 把"内容可分时优先手写组合"立为**推荐纪律（非强制）**（§3.6/§4.13） |
| Q3 | **生成器不产组合候选** | 第 5 档已给 token 单用候选，组合冗余挤 cap 4；作者手写组合走 §4.13 文档引导 |
| Q4 | **采纳 `^[1-9]\d{0,8}$`** | 词法卫生 + Number 精确 + 早失败早诊断 |
| Q5 | **单用序数进 core** | 单用形态需要至少一条真站正向证明；N 取中段 5；不变量断言最终页面状态兜底 |
| Q6 | **trace 独立键 `row_evidence: {row_index?, row_texts?}`** | 对齐 `declared_resolve` 先例，查询面清晰，不与 `resolved_by` 混装 |

**四项必改（已全部收编进本 v1.0）**：

- **A. §3.9 增"诊断可达面矩阵"**（最重要——批 1 probe `books-inrow-token-missing` 真站实测
  暴露：规划面停因是 `low_confidence`（0.13 < floor，`method=decision-service:reobserve`，
  词面扫描诊断），不是三案 reason）：三案证据**保证面** = app flow 命令空间 / strict / 会话
  act；**规划面不保证**（**历史口径——已于 `a1dd95f` 收口，现状见 §3.9 矩阵与 §8 #8**）；
  probe 用例期望口径相应调整（fail-closed 正向证明 = 零动作 + 诚实
  落空）；"target_not_found + 案①报 K"可达性列为 §8 遗留 #8（**已收口**：规划面三案接线
  已在 `a1dd95f` 落地）。
  该项同时留档批 1 的正向观察：序号缺失 ⇒ 零错点成立。
- **B. rowIndexValueProblem 类别修正**：`0` 是数字但非法（1-based）——归 not-numeric 语义
  不准；定稿为 empty / **not-positive-integer**（0/负/非数字/带字母归此，文案必须点名
  "row-index 从 1 开始"）/ too-many-digits 三类（§3.2/§5）。
- **C. §3.5 编号实现措辞收紧**：编号是**一次 O(n) 全组序映射**（`__dupLabelsOf` → 组内
  scan 升序位次表），不是逐候选计算；memo 只适用于组合守卫的 row_texts 爬升；**单用
  row-index 零爬升成本**（§3.5 改写 + R3 同步强化）。
- **D. §10 核对单补第 9 条**：诊断可达面矩阵确认（保证面/不保证面划分与 probe 期望口径
  一致性）。

## 10. 评审要点（给评审者的核对单）

> v1.0 状态：Q1-Q6 已仲裁（§9）；方案已实施（`a38e674` 等）——本核对单保留为**实施复核
> 记录**：实施 PR 与评审者按此逐条核对实现与定稿口径（含 `a1dd95f` 规划面接线收口）。

1. **语义两类裁决**（§1.3/§3.1）：单用合法 + 组合 fail-safe 主推（Q2 已裁决：不强制内容
   守卫；"内容可分时优先手写组合" = 推荐纪律）——实现不得把组合守卫做成强制；
2. **编号口径**（§3.4）：帧内 dup 组 DOM 先序 1..K（跨帧组各自编号）——与四面 JS pass 的
   天然 per-frame 结构对齐；跨帧歧义沿用既有口径（R7）——实现按 (frame, tag+label) 子组
   scan 升序，池面跨帧 dup 计数（触发面）不变；
3. **命名**（Q1 已裁决：保留 `row-index`）——文档/诊断文案须把"≠ 页面第 N 行"写进语义
   边界与案①文案；
4. **生成纪律**（§3.6，Q3 已裁决：不产组合候选）：第 6 档仅在 within 全落空 + 第 5 档全
   落空时产 row-index 单用候选；"部分可分"逐元素触发（遗留 #6）加断言钉死；
5. **截断边界**（R8）：编号基于本面收集到的成员、跨面 K 可不同——文档如实声明，案①报
   本面 K；
6. **诊断四案 + 可达面矩阵**（§3.9）：案①报 K + 行词元、案②序号已定位改 token、案③歧义
   谓词、案④整组回退；**保证面 = 命令空间 / strict / 会话 act / 规划面（`a1dd95f` 收口，
   证据单点 `frameHintFailureEvidence`）**——遗留 #8 已关闭；
7. **模型面与证据面**（§3.7，Q6 已裁决：独立键 `row_evidence`）：row_index 剥离
   （guard+解构双写）+ trace additive（仅声明且解析成功时出现）；
8. **批 2 清单与验收**（§5/§7 正式版）：文件面/免改核验/显式缺口/online 用例形态
   （core 单用 `row-index:5` + 组合守卫；probe 期望口径按可达面矩阵）——核对无遗漏面；
9. **诊断可达面矩阵确认**（A 项必改，**已收口**）：三案证据的保证面 = 命令空间 / strict /
   会话 act / 规划面（`a1dd95f`）；probe 可声明 `target_not_found` + 案①报 K 与零动作/零错点
   断言（遗留 #8 已关闭）；批 1 probe 实测（`low_confidence`）作为收口前历史观察留档 §3.9。
