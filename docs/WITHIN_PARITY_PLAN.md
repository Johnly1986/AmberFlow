# E 批方案：within 权威对等 + 读侧帧限定（v1.1 · 已评审：CONDITIONAL APPROVE，M1–M6 已吸收）

> 状态：**待架构师评审**。来源：`frame:<origin>` 落地后 `docs/BACKLOG.md`「frame:<origin> 后续立项」#1/#2/#3/#4/#5 + §13.4 延后项 + 小项 #12/#13/#14。
> 姊妹篇：`docs/FRAME_SCOPE_HINT_PLAN.md`（frame:<origin>，已实施，§13 为实施记录）。本文只写**增量**，不重复其语义。

## 1. 目标与非目标

**目标**（补齐能力缺口）：
1. 回捞/合成面 within 权威对等——`#x within:#p` 在 FW8/F64/DRF-text/四处合成池上与主匹配面同语义（BACKLOG #1）；
2. `within:` 语义链——`within:#a>#b` 链式锚定（E 批本体的语法增量，BACKLOG #2）；
3. `findByHint` 支持 within（含与 `frame:` 组合的全语义，BACKLOG #3）；
4. 读侧帧限定对称化——`read/extract/collect/judge/done/when` 的 CSS 选择器接受 ` frame:<origin链>` 尾缀（BACKLOG #4）；
5. `induceHint` 帧限定（记忆产物带 `frame:`，BACKLOG #5）；
6. 小项：`matchedChains` 截断标记、整串 `frame:` 诊断、文档大写示例（BACKLOG #12/#13/#9）。

**非目标（维持 §13.4 口径）**：跨帧 within（锚与目标分属两份文档——`anchor_ids` 是帧内文档祖先链，文档边界不跨）；跨帧同签名不合并（独立立项+开关）；`about:blank`/srcdoc 帧寻址；帧下标/nth-child/XPath。

## 2. 现状事实（侦察结论，全部 file:line 可查）

| 事实 | 出处 |
|---|---|
| `anchor_ids` = 祖先 id 链：`parentElement` 上溯、**内→外**序、≤8、小写、元素自身不入 | `pool-js.ts:500-506`（`anchorIdsOf`），消费 `pool-js.ts:514/530/600/618` |
| 主匹配面 within = 单层 membership：`anchor_ids.includes(parsed.within)` | `rules.ts:337-343`（`inAnchor`，E3） |
| `within:` 语法**单层不链式**（charset `#[a-z0-9_\-.:]+`，无 `>`） | `hint.ts:43/98/108` |
| 四合成池无 `anchor_ids`：hintLookup（`extraction.ts:1384-1393` 只带帧链两字段）、A3（`executor.ts:2373-2391` 主帧）、FW8（`identity.ts:141-142/225-226/255+`）、DRF `rowToElem`（`declared.ts:202-224`） | 各处 |
| FW8/F64/DRF-text 不看 within：FW8/DRF 合成行无 anchors 可言；F64 `_liveDomIdFallback`（`executor.ts:2222-2245`）只做帧链+hosts 过滤，命中后不验锚 | 各处 |
| `locatorAnyFrame` 逐帧 OR，无帧限定；cssCount 同底座 | `extraction.ts:569-592` |
| `induceHint` 只产 `[attr=v]` / `tag[near~token]`，无 `frame:` | `hint-memory.ts:36-52` |
| `esig`=[tag,label,data_test]、`firstIfSame` 同签名——均不含 `anchor_ids` | `extraction.ts:382-401` |
| 真池行的 `anchor_ids` **已进模型面**（`modelProjectionOf` 剥离清单无此字段，既有口径） | `executor-pure.ts:131-152` |
| `splitTailSuffixes` 已把 within 剥出（`{base, within, frameChain}`） | `hint.ts:107-144` |

## 3. E1：within 权威对等（不可拆核心）

**原则**：合成/回捞行与真池同构——真池有 `anchor_ids`，合成行也该有；消费面（FW8/F64/DRF-text）按 `inAnchor` 同语义过滤。

1. **四合成池补 anchors**（JS 侧内联同一 `anchorIdsOf` 实现——与 `pool-js.ts:500` 逐字符同构，防漂移）：
   - `hintLookup` 的 PASS_HINT 回捞行（`extraction.ts:~1370` 前的 JS）；
   - A3 `_domFallbackResolve` 主帧合成行（`executor.ts:~2373`）；
   - FW8 `identityLookup` 合成 Elem（`identity.ts:~141/225`）；
   - DRF `declaredLookup` 的 `RawRow` 增 `anchors` 字段 → `rowToElem` 透传（`declared.ts:202-224`）。
2. **消费面遵守 within**（单层语义，先对齐再谈链）：
   - FW8：`identityLookup` 候选行过滤 `anchors.includes(within)`（`identity.ts:~225` 处）；FW8 的 `identityRecovery` 主路径同样过滤；
   - DRF-text：`declaredLookup` 行过滤同语义（`declared.ts:~277` 帧循环内）；
   - F64 `_liveDomIdFallback`：帧循环内命中 `#id` 后，同一 `evaluate` 里校验 `anchorIdsOf(el).includes(within)`（`executor.ts:~2237` 的 evaluate 返回结构加 anchors 或二次求值）。
3. **跨帧 within 边界（文档化）**：锚在另一份文档（如宿主页 iframe 元素）时 anchor_ids 天然不含它——N-R2a 证据文案更新为"跨帧 within（锚在另一文档）不受支持；同帧 within 已在回捞面生效（E1）"。
4. **不变量**：无 within 的合成行多带 `anchor_ids` 字段（additive；与真池行同构，模型面/esig/firstIfSame 不变）；**含 within 的回捞行为变更 = 权威对等的本意**（CHANGELOG 记账）。

## 4. E2：within 语义链

> **状态：已实施（E2 批，提交号由 lead 落定）**。实施记录见 CHANGELOG「E2 批（within 语义链）」；
> 与本节 + §12.2 M1/M6 的对齐情况：①语法（含 M6④ 两套对齐规则文档义务、M6② 重复 id、M6③ ≤8 截断）
> ②语义（`rules.anchorChainMatch` 唯一出处，presence 前置显式化）③候选（M6⑤ 从最近祖先向外生长）
> ④诊断（`withinChainValueProblem` 与解析共用判定）。**实施偏差一处**：词法 charset 除 `>` 外
> 同批加 `#`（段首标记）——§4.3/M6⑤ 链候选写法 `within:#a1>#a2` 每段带 `#`，词法必须收下才能
> 解析；段校验（`withinChainValueProblem`）保证旧单层值/值内伪尾缀的解析结果逐字节不变
> （伪 `#`/空段/超限都在段校验整组回退，回退 base 与旧"不剥"路径相同）。

1. **语法**：`within:#a>#b`——`>` 分隔、**≤4 段**、每段 id charset、空段/超限/非法 ⇒ 整组回退（复用 `splitTailSuffixes` 循环：`WITHIN_TAIL_RE` 值 charset 加 `>`，段校验新增）。单层 `within:#p` 行为逐字节不变。
2. **语义（向后兼容的超集）**：声明链 [a₁…aₙ]（外→内）匹配 ⇔ 每段都在 `anchor_ids` 且**嵌套序正确**（anchor_ids 是内→外存储 ⇒ `indexOf(aₙ) < … < indexOf(a₁)`）；单层 = membership（不变）。
3. **候选生成**：`suggestHints` 的 within 候选升级——label 歧义且锚信息可用时：单层 `label within:#a` → 仍歧义且 `anchor_ids` ≥2 时链候选 `label within:#a>#b`（取该元素 anchor_ids 的外→内重组、≤4 段）；顺序仍 身份→label→frame→within、上限 4。
4. **诊断**：`describeFrameSuffixRejection` 的 within 侧值校验同步链形（空段/超限）；`frameHintFailureEvidence` 的 N-R2a 文案按 E1 更新。

## 5. E3：findByHint within（含 frame+within 组合）

> **状态：已实施（E3 批，提交号由 lead 落定）**。实施记录见 CHANGELOG「E3 批（findByHint within）」；
> 离线套件 `/tmp/af-e3/`（findByHint 矩阵 97 断言：必修点旧新对照 / 无后缀逐字节 / 单层·链 / 组合两序 /
> 整组回退 / E1 权威面 parity / frameTargetRejection 不变）。浏览器级 `plan check --probe` 实测留专项。

- `splitTailSuffixes` 已返回 `within`——`findByHint` 在帧链过滤后按 `anchor_ids` 过滤（单层/链同 §4.2 语义；真池行天然带 anchors）；`frame:`+`within:` 组合成为**全语义**（此前 probe 面只做帧过滤）。
- `plan check --probe` 因此可校验 within 作用域；N-R2a 证据保留（跨帧 within 仍 fail-closed 且文案准确）。

## 6. E4：读侧帧限定对称化

1. **语法**：`read/extract/collect/judge` 与 done/when 的 CSS 选择器可尾缀 ` frame:<origin链>`（与 hint 同一 `parseFrameChainValue` 校验；**值不合法 ⇒ 整串按原 CSS 处理**（显式落空），绝不半剥——防选择器属性值以 ` frame:` 结尾的伪尾缀误伤）。
2. **底座**：`extraction.ts` 新增 `splitFrameSuffixFromSelector(sel)` + `locatorAnyFrame`/`cssCount` 帧循环按 `frameScopeMatchesFrame` 过滤（hosts 信封同口径：主帧恒允许、子帧按信封）；`signals.ts` 的 css_* 求值走同一 helper。
3. **结构化失败**：声明帧不在信封 → `frame_not_allowed` 同证据面（复用 probeExcludedHint 思路，只读探测）；帧不存在 → 结构化 miss。
4. **不变量**：无尾缀选择器逐字节不变；`frame:` 尾缀只加不改既有 op 面。

## 7. E5：induceHint 帧限定（记忆产物）

- `induceHint(elem)`：`elem.frame_path` 非空（**非主帧**）时在产物尾追加 ` frame:<own origin>`——主帧元素逐字节不变（绝大多数记忆不受影响）；子帧元素记忆回放可精确落帧。
- 兼容核对：`hint-lint` 对带尾缀记忆 hint 的三类 finding 不误报；`learn` 录制→回放链路实测。

## 8. E6：小项收尾

- `probeExcludedHint.matchedChains` 增 `truncated` 标记 + reason 带总数；
- `describeFrameSuffixRejection` 对整串 `frame:<origin>`（首词即 frame:、无前导空白主体）补"缺少 hint 主体"诊断；
- 文档：大写 origin / 大写属性词示例（BACKLOG #9 收口）。

## 9. 批次与验收

| 批 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **E1** | §3 within 权威对等（四池 anchors + FW8/F64/DRF 遵守 + N-R2a 文案） | — | 离线：四池 anchors 断言 + within 回捞命中/落空矩阵；无 within 逐字节；`npm run check` |
| **E2** | §4 链语法 + 语义 + 候选 + 诊断 | E1 | parse 矩阵（链/单层/伪尾缀/整组回退）+ 候选自证 + 诊断；浏览器级：链锚命中 |
| **E3** | §5 findByHint within | E1（链：E2） | findByHint 矩阵（frame/within/组合）+ plan probe 实测 |
| **E4** | §6 读侧帧限定 | — | 选择器尾缀矩阵 + 帧过滤/信封拒绝实测 + signals css_* 同底座 |
| **E5+E6** | §7+§8 | E2（诊断链形） | induceHint 矩阵 + learn 回放 + truncated/诊断断言 |

每批：子代理实施 → lead 复核 + 离线套件 + `npm run check` → 浏览器级专项 → commit+push。**纪律沿用 frame 批**：无后缀/无 within 路径逐字节不变；行为变更逐条 CHANGELOG；离线脚本放 `/tmp/af-e*/`。

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 合成池补 anchors 改变含 within 回捞行为 | 这是对等本意（CHANGELOG 行为变更）；无 within 逐字节不变 |
| within 链语义与单层 membership 的兼容 | 链 = 超集语义（单层不变）；parse 整组回退沿用 |
| 读侧尾缀伪命中（CSS 属性值含 ` frame:`） | 仅当值通过 origin 校验才剥，否则原样 CSS（显式失败） |
| induceHint 形状变化影响既有记忆 | 主帧逐字节不变；子帧记忆是新增精确性；hint-lint 三类 finding 核对 |
| 跨帧 within 仍不支持（文档边界） | N-R2a 文案如实点名；不静默 |

## 11. 与架构师前两轮结论的承接

- R2-8（within 权威不对等）→ 本文 E1/E2 全量解决；
- N-R2a → E1 文案更新（跨帧 within 仍是文档边界）；
- BACKLOG #1/#2/#3/#4/#5/#9/#12/#13 → 本文 E1–E6 对应收口。

---

## 12. 架构师评审（v1.0 → v1.1 修订记录，2026-11-15）

裁决：**CONDITIONAL APPROVE**——方向与批次分层正确；§2 十条事实全部核实（修正一处笔误：induceHint 在 `src/model/hint-memory.ts:36-51`）。必改项 M1–M6 全部吸收如下（本节为**规范增量**，覆盖正文对应条款）：

### 12.1 方案外源码发现（已并入设计）

- **F-1 危险因果链（写全）**：hintLookup 的 DOM pass **已执行 within**（HINT_HEAD `getElementById+contains`），回捞行 within 洁净；但并入主池后 executor 重新 `hintMatch`，池侧 `inAnchor` 按缺失的 anchor_ids 把回捞行**二次清零** → 落到 FW8（无视 within）在任意帧动作锚外 `#x`。E1 给回捞行补 anchors 正是闭合此链的关键一环（不只是同构美观）。
- **F-2 DRF 不对称**：DRF-attr 经 `hintCandidates→inAnchor` **已消费 within**（合成行无 anchors ⇒ 恒 fail-closed）；E1 补 anchors 后 attr 模式**零额外代码**自动获得语义；只有 text 模式需显式过滤。
- **F-3 第五个合成池**：heuristic 宽扫行（`extraction.ts:1124-1160` + `pool-js.ts:812-860`）也无 anchors → 纳入 E1（M3）。
- **F-5 字面耦合**：`PASS_HINT_PROBE = HINT_HEAD.replace("e.setAttribute('data-hintref', stamp);","")`（`pool-js.ts:788-789`）——E1 改 HINT_HEAD **必须保住该行字面**。
- **decision-cache 无影响**：缓存只装本地 laya、键=`{goal,url,title,main_text}+criteria 文本`，池字段不在键/criteriaView/askSig/structDigest 里——合成行新增 anchors 只影响 ChoiceRequest 请求体（M2 记账），无缓存 miss 波及。

### 12.2 必改项吸收

| M | 修订 |
|---|---|
| **M1（E2 范围）** | E2 补列：①池侧 `inAnchor` 链化；②DOM 侧 HINT_HEAD 链化（`getElementById` 逐段 + contains 嵌套）；③FW8/F64/DRF-text 链消费（E1 只做单层）；④`ParsedHint.within` 归一 `string[]`（**外→内**，单层=长度 1）+ 消费面迁移清单（splitTailSuffixes/parseHint/identityHintInfo/frameHintFailureEvidence/findByHint）；⑤契约文本同批：HINT_WITHIN_SUFFIX 文案+自证改写（grammar-prompt.ts:100-113「链式拒绝」断言改「多 within 拒、单串链受」）、`HINT_GRAMMAR.within_suffix`、F69/F70、schema 快照重生成、prompt-hit。缺此批 E2 =「只在主池生效、回捞面全瞎」的半吊子链语法。 |
| **M2（E1 不变量口径）** | §3.4 改写：esig/firstIfSame/askSig/structDigest/**laya 缓存键**不变；模型面 = 回捞行 **additive 增 `anchor_ids`**（与真池同构、在线请求体变化）→ CHANGELOG 记账；FW8 歧义证据口径变化（过滤后 total/hidden/candidates 变锚内口径）记账。 |
| **M3（第五池）** | heuristic 宽扫行补 anchors，纳入 E1。 |
| **M4（E4 收口）** | ①尾缀被拒诊断（原样 CSS 全帧解析失败且串含 ` frame:` 尾缀 → B8 同款「尾缀被拒+原因」）；②逐面结构化失败钉死：`ctx.read/extract` **不抛** frame_not_allowed（null/空 + trace evidence additive）、done/when 走既有 **F45②** 升级、会话面只回 null（零合同变化）；③**F45② done 探针 suffix-aware** 进 E4 文件清单（否则声明帧 done 永远零命中→frame_not_allowed 永不升级）；④test-double fallback（extraction.ts:587）在 split **之后**。 |
| **M5（E1 术语接线）** | 不存在 identityRecovery 函数——过滤器落 `identityLookup` 内部（"恰好一个可见匹配"判定之前，identity.ts:221-229）；`identityHintInfo` **暴露 within**（现在只带 frameChain）；两调用点（executor.ts:3777/3997）断言继承。 |
| **M6（E2 语义钉板）** | ①presence 前置显式化（indexOf=-1 不满足序关系）；②重复 id 规则写文档（池=最近实例 / DOM=getElementById 文档序首个）；③anchor_ids ≤8 截断边界写文档（长链可能落空）；④两套对齐规则的文档义务（frame=后缀对齐——frame_path 稠密可分同源父子；within=嵌套序包含——anchor_ids 稀疏仅带 id 祖先，后缀对齐会毁单层兼容）；⑤链候选**从最近祖先向外生长**（`within:#a1` 不唯一 → `within:#a2>#a1`…，与单层"最近祖先优先"一致，不从最外层起）。 |

### 12.3 工程口径（E1）

- **抽共享 JS 常量**（先例 LABEL_HELPERS_JS 等 `${}` 内插）：`ANCHOR_JS` 单一出处；EXTRACT_JS/OBSERVE_JS 两份 `anchorIdsOf`（pool-js.ts:500/:564）收敛为同一常量（文本逐字符一致 ⇒ pass JS 串字节不变）；A3/F64 的 inline TS arrow evaluate 闭包不跨（Playwright 序列化函数源码）→ 转 `compile()` PASS 常量再内插（identity PASS_IDENTITY 先例）；若个别处保持复制，加 `fn.toString().includes(ANCHOR_JS)` 漂移断言。
- **F64**：一次 `evaluate` 返回 anchors + TS 判定（二次求值多一次跨源往返且原子性差；anchors 还能区分"找到但在锚外"）。
- **DRF**：text 模式收集后按 row.anchors 过滤；attr 模式零额外代码（F-2）。
- **FW8**：过滤器在 identityLookup 候选收集处；`identityHintInfo` 暴露 within。

### 12.4 批次修正

- E1→E2→E3 主线成立；**E5 不依赖 E2**（只产 `frame:` 尾缀）可并行；E6 两小项亦不依赖 E2。
- 逐字节允许清单补：trace/池快照回捞触发时的 additive 字段（frame 批 §12.8-10 同款）、FW8 证据文案、PASS_HINT_PROBE replace 字面、E3 无后缀 base 逐字节。
- 测试矩阵补 11 类（评审 §六）：>8 id 截断一致性、重复 id `within:#x>#x`、`within:#a>`/超 4 段/双 within 仍拒、frame+within 链两序、FW8 锚内歧义证据口径、F64 hosts×within+锚外区分、DRF attr/text 矩阵、E4 信封外 done 升级+非法尾缀回退、E5 主帧记忆逐字节+srcdoc 无尾缀+跨帧同名消歧、E6 truncated+total、契约自证（grammar-prompt/prompt-hit/schema 快照）。

### 12.5 风险表增补

R-1 模型面口径错写（M2）｜R-2 heuristic 池遗漏（M3）｜R-3 重复 id 两面判定分歧（M6②）｜R-4 E4 invalid-selector 静默 miss（M4①）｜R-5 F45② 探针不剥尾缀（M4③）｜R-6 契约文本漂移（B7 同款，M1⑤）｜R-7 PASS_HINT_PROBE 字面耦合（F-5）｜R-8 anchor_ids≤8 截断长链落空（文档义务）｜R-9 E5 同 origin 父子帧记忆仍歧义（D2 边界）｜R-10 suggestHints 链候选挤掉 frame 候选（顺序 身份→label→frame→within 不变）。
