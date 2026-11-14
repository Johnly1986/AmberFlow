# 帧限定 hint：`frame:<origin>` 落地方案（v1.2 · 已实施）

> 状态：**已实施**（A/B/C/D 四批，2026-11-15；提交号与每批范围见 §13）
> 规格版本：v1.2（2026-11-14 两轮架构评审；§11/§12 为修订记录，§13 为实施记录）
> 关联：F45（frame 门禁）、F41（observe 合同）、F54/F55（桥/歧义证据）、F64（#id 直查）、F69（within:#id）、F70（帧限定尾缀）、E3 同构
> 前置已落地：inspect `--probe` 跨 frame 探测（e2071bc）、suggestHints within 候选（3636cb1）

## 1. 背景与问题

多 iframe 页面里，**同名元素跨帧无法用现有 hint 语法表达**：

- 两个 iframe 各有一个「Close」按钮：hint `Close` → `target_ambiguous`（正确但不可解）；
- `within:#id` 只能在**同一帧内**用祖先 id 限定（iframe 内容里的祖先链不含宿主页 iframe 元素）；
- 池 ref `f<fi>:eN` 带帧下标，但**ref 不是动作地址**（帧动态增删下标会漂移，且引擎纪律明确"动作地址只用 hint"）；
- 2026-11-14 实测：Google 应用菜单面板在跨源 iframe（`ogs.google.com`，池内 `f1:e3`），探测面无跨帧能力时会误判"不可自动化"（已修探测面）；但**动作寻址**仍缺帧级语法。

**结论**：缺一块"帧作用域限定"的 hint 语法。`within:#id`（E3）已证明"后缀限定"是可行且低风险的模式，`frame:` 与它同构。

## 2. 目标 / 非目标

**目标**
1. 任意 hint 形状可后缀 `frame:<origin>`，命中集限定在该 origin 的 frame 内；
2. `frame:` 与 `within:` 可组合（都限定时取交集）；
3. 观察/建议/歧义证据全链闭环：`ctx.observe`、`inspect` 的 hint_candidates 能直接给出可照抄的 `frame:` 候选；
4. 默认行为**逐字节不变**（无后缀 hint 走原路径）。

**非目标（本期不做，明确 out of scope）**
- 多个 `frame:` 尾缀 / 帧下标链（`frame:0>2`）——链式后缀需要帧链设计，单独立项；**单段与 origin 链 `frame:o1>o2` 已由 §12.3 纳入本期实施**（v1.2 修订）；
- 帧下标形式（`frame:1`）——下标会漂移，不做；
- iframe 元素 CSS selector 形式（`frame:iframe#x`）——违反 hint 封闭集（任意 CSS 锚拒绝，与 within 同纪律）；
- per-frame 池窗口配额、帧数上限提升（`framesOf` ≤6）——独立测量后另议；
- Playwright 升级（1.58→1.65）——不属本方案；
- done/judge 信号的帧限定（judge 走任意 CSS 面，天然可写 iframe 选择器；本方案只服务 act hint/命令 target）。

## 3. 设计

### 3.1 语法（与 E3 `within:#id` 同构，单层后缀）

```
<hint 六形状之一>[ within:#id][ frame:<origin链>]
```

- 后缀可**同时出现**，顺序无关；每个后缀**至多一次**；出现多次/链式 = 解析期拒绝
  （整串按旧形状解析 → 大概率裸词落空 = 显式失败，绝不静默取第一个——沿用 E3 纪律）。
- `frame:` 值必须是合法 **origin 链**（v1.2 §12.3）：`>` 分隔外→内、≤4 段，每段
  `scheme://host[:port]`、scheme ∈ {http, https}、`v === new URL(v).origin` 的规范形；
  大小写不敏感（origin 规范化小写），不接受通配符/正则/相对值/`about:blank`/带 path·query。
- 解析口径（v1.2 R2-5）：**串尾词法预扫 + 循环剥离**；任一后缀超限/值非法/空段 ⇒
  **整组后缀都不应用**（按原始串回退，绝不半剥）。
- 示例：
  ```
  Close frame:https://ogs.google.com
  保存 within:#dialog frame:https://checkout.example.com
  a[href=https://maps.google.com/] frame:https://www.google.com
  button frame:https://a.example>https://b.example     # 嵌套帧：外→内
  ```

### 3.2 语义

> ✅ v1.2 修订已实施（§11.1 B1 / §11.2 D2）：档位语义为**帧内计算**；同签名跨帧终裁由
> `firstIfSame` 合并（run 命令步 / act hint 直接执行一个；会话 act 因 `hintCandidates.decided`
> 不暴露该裁决而停），**不是** `target_ambiguous`——唯一性承诺按该边界读。

- `frame:<origin链>` = 命中集 ⊆ 声明链匹配的帧；与 `within` 同时出现 = 两个过滤**交集**；
- 过滤发生在**各形状的命中集上**（v1.2 B1：`hintMatchImpl` 入口过滤 entries），不改变档位语义
  （bare ladder / attrSubstr 分档仍按原形状计算，且**档位在帧内计算**）；
- 过滤后本档清空 = 落空（不让更弱档越级顶上）——与 E3 现有行为一致；
- 唯一性/歧义判定在**过滤后的集合**上计算（跨帧同名 + frame 限定后唯一 = 正常命中；
  同 origin 序列的兄弟/不同分支链逐段相同 = 不可分，同签名按 `firstIfSame` 边界处理——§11.2 D2）。

### 3.3 数据面：`Elem.frame_origin`（v1 初版；v1.2 扩为两字段）

> ⚠️ §3.3–§3.6 保留 v1 初版设计，**已被 §11.1（B1–B9）与 §12.3（origin 链 / 两字段数据面 /
> 四合成池）修订**：实际字段是 `frame_origin` + `frame_path` 两字段；过滤在 `hintMatchImpl`
> 入口（不是 `inFrame(refs)` emit 级）；解析结果是 `ParsedHint.frameChain`（不是 `frame`）；
> heuristic 宽扫是**主帧常量**（`frame=0` + 主帧 origin，不是"同一 JS 产物"）；`pickInner`
> 收口到 `executor-pure.modelProjectionOf`。代码现状以 §13 与 `src/engine/frame-scope.ts` /
> `hint.ts` / `rules.ts` 为准。

| 位置 | 改动 |
|---|---|
| `src/engine/extraction.ts:44` `Elem` | 新增可选 `frame_origin?: string`（帧 URL 的 origin，小写；空/不可解析 = 字段省略） |
| `extractElements` 帧合并段（`:748-753`） | `row.frame = fi` 同处补 `row.frame_origin = frameOriginOf(frames[fi])`（空串不写） |
| heuristic 宽扫行（`:1074` 附近同一 JS 产物） | 同上（宿主侧补字段，不改 JS pass） |
| `src/engine/executor.ts:1128-1140` `pickInner` | 模型投影剥离列表补 `frame_origin`（与 surface/href_full/identity/declared 同处；**模型面字节不变**） |
| `src/engine/observe.ts:141-156` `syntheticElem` | 透传 `frame_origin`（非空才加） |
| `src/engine/extraction.ts:765` `ObserveRawRow` | 加可选 `frame_origin`；`observeElements` 帧循环（`:838-840`）补字段 |
| inspect 池 | 无需改（`ElementView.frame_origin` 已存在，由 pool view 提供） |

### 3.4 解析层：`src/engine/hint.ts`

- `parseHint` 在剥离 `within:#id` 之后、一切形状判定之前，再剥离 `frame:<origin>`：
  - 正则：`/\s+frame:([a-z][a-z0-9+.-]*:\/\/[^\s]+)\s*$/i`（只认带 scheme 的 origin 串）；
  - 出现多次 `frame:` = 不剥离（原串按旧形状解析 → 落空），与 within 同纪律；
  - 校验：`new URL(value)` 成功且 scheme ∈ {http,https} 才落 `ParsedHint.frame`（小写 origin），
    否则不剥离（显式失败，不抛异常）。
- `ParsedHint` 加 `frame?: string`；`within` 与 `frame` 可同时存在。
- 边界：形状值里含 `frame:` 字样的（如裸词包含该子串）——后缀剥离要求**前置空格 + 结尾**，
  且先于形状判定，按与 within 相同的既有测试口径覆盖。

### 3.5 匹配层：`src/engine/rules.ts`

- `hintMatchImpl`：在 `inAnchor()` 旁增加 `inFrame(refs)`：
  ```ts
  const inFrame = (refs: string[]): string[] =>
    parsed.frame === undefined ? refs
      : refs.filter((r) => String(elems[r]!.frame_origin ?? "").toLowerCase() === parsed.frame);
  ```
  ⚠️ v1.2 修订（§11.1 B1 / R2-10）：过滤改为 **`hintMatchImpl` 入口过滤 `entries`**（链匹配 helper），不是 emit 级；档位在帧内计算；`tag` 形状的 submit 偏好分支先 `inAnchor` 再偏好（否则 within 被绕过）。
- `hintCandidates` 自动继承（内部同一 `hintMatchImpl`）；
- `suggestHints`（`:514-561`）：文本候选不唯一时追加帧候选——顺序：身份形状 → label →
  **`${label} frame:${elem.frame_origin}`**（elem.frame_origin 非空且 label 2..80）→ within 候选；
  仍经同一 `push`（hintMatch+hintCandidates 自证唯一），上限 4 条不变；身份形状优先不变。
- `ambiguity.ts` `candidateView`：additive 加 `frame_origin`（`AmbiguityCandidate` 可选字段），
  便于 Agent 从歧义证据直接构造 `frame:` 候选。

### 3.6 回捞/门禁适配

| 面 | 改动 |
|---|---|
| **FW8 身份回捞**（`identity.ts:187`） | 解析 hint 后若 `parsed.frame` 存在：只在该 origin 的帧上回捞（帧循环过滤）；无匹配帧 = 保持失败路径 |
| **DRF**（`declared.ts:234`） | 同上（跨帧统计前按 origin 过滤 frames） |
| **F45 排除帧探测**（`probeExcludedHint`，`extraction.ts:1343`） | 已有 `parsed`（`hintLookupArgs` 传 ParsedHint）：循环 excluded frames 时若 `parsed.frame` 存在且该帧 origin ≠ parsed.frame → 跳过；若等于 → 视为"声明目标在该被排除帧"，按既有 `frame_not_allowed` 路径报（reason 已含 origin） |
| **F42 strict / F44 DRF** | 消费同一 hintMatch 结果，语义不变 |
| **#id live-DOM 直查**（F64） | 同样按 `parsed.frame` 过滤帧（E1-c 直查是跨帧的，必须遵守限定） |

### 3.7 契约与文档面

| 面 | 改动 |
|---|---|
| `src/engine/grammar-prompt.ts` | 新增 `HINT_FRAME_SUFFIX`（token/example/anchor/note）+ import 时自证（示例被解析为 `frame:'<origin>'`；链式/非法 origin 被拒绝），与 `HINT_WITHIN_SUFFIX` 同构 |
| `docs/APP_SCRIPT_AUTHORING.md` | §hint 语法补后缀说明与示例；「多 frame 定位速查」补 `frame:` 用法与边界（同签名跨帧由 `firstIfSame` 合并、origin 链单层 ≤4 段、未知 origin 不可寻址；`plan check --probe` 的旧匹配器边界） |
| `src/cli/registry.ts` | 若有 hint 语法帮助行，同步后缀说明 |
| `src/cli/schema-gen.ts` | 新增 **F70**（编号接 F69）：`frame:<origin>` 帧限定尾缀——语法/解析/池侧过滤/建议候选/回捞适配/契约纪律 |
| `CHANGELOG.md` | 新增 `## [Unreleased] — frame:<origin> 帧限定 hint` 条目（含背景、兼容性、验证） |
| `hint-lint.ts` | 不新增类别；确认 `frame:` 后缀不改变三类 lint 判定（parseHint 只读复用）；C 批实现为独立 stderr 通道：非法值 + origin 不在 `meta.hosts` 两条静态提醒（不进 problems/exit） |

## 4. 关键决策点（v1 评审建议；D2/D3 已按 §11.2 修订）

> 下表保留 v1 拍板时的建议；**D2/D3 的实际口径以 §11.2 修订行为准**（D1/D4 维持原决定）。
> §4 原草案的“同 origin 多帧仍报 target_ambiguous”与“嵌套帧独立立项”均已被 §12.3 取代。

| # | 决策 | 建议 | 备选 |
|---|---|---|---|
| D1 | 限定值形态 | **完整 origin**（`scheme://host[:port]`；每段 `v === new URL(v).origin`） | hostname 简写（需补默认端口/协议推断，语义模糊，不推荐） |
| D2 | 同来源多帧同名 | 同签名跨帧由 `firstIfSame` 合并（run/act hint 直接执行一个，会话 act 停）；同 origin 兄弟不可分；**不承诺** `target_ambiguous` | 加帧下标（漂移风险，拒绝） |
| D3 | 嵌套帧 | origin 链 `frame:o1>o2`（≤4 段、外→内、末段=自身）；同源父子靠链长区分 | 帧下标链（漂移，拒绝）；within 语义链（§12.4 延后） |
| D4 | 与 within 组合 | 允许，顺序无关，交集 | 禁止组合（能力损失） |
| D5 | about:blank 帧 | 本期不支持 | 后续按需 |
| D6 | 非法 origin 处理 | 解析期不剥离（显式失败） | 抛 config_error（破坏旧串兼容） |
| D7 | 池窗口共享 | 不在本期解决，文档提示 `ctx.observe()` | per-frame 配额（独立测量） |

## 5. 实施拆解（v1 四提交 → 实际 A–D 四批，全部完成）

> v1 的 C1–C4 在 §11.3 重排为 A–D 四批（A=C1+C3a+契约、B=C2、C=C3b、D=C4）。
> 实际字段/过滤位置以 §12.3 与 §13 为准（`frameChain` 两字段、`hintMatchImpl` 入口过滤）。

**A 批（原 C1 + C3a + 契约）**
- [x] `hint.ts`：`ParsedHint.frameChain` + 串尾预扫/循环剥离（合法/非法/链式/多后缀/与 within 组合）
- [x] `rules.ts`：`hintMatchImpl` 入口 entries 过滤 + tag-submit 先 `inAnchor`
- [x] `extraction.ts`：`Elem.frame_origin` + `frame_path` 全链打点（extract/heuristic 主帧/observe/四合成池）
- [x] `executor.ts`：pickInner 两字段剥离（收口 `executor-pure.modelProjectionOf`）
- [x] FW8 / F64 / DRF / hintLookup 帧链 + hosts 过滤
- 验收：无后缀 hint 行为逐字节；`frame:` 唯一命中/落空语义正确；typecheck 绿

**B 批（原 C2）**
- [x] `observe.ts`：`ObserveElement.frame_origin` / `frame_path` + `includeStructure`
- [x] `rules.ts`：`suggestHints` 追加 frame 单段/链候选（自证唯一）
- [x] `ambiguity.ts`：`AmbiguityCandidate.frame_origin` + `AMBIGUITY_HINT_MAX=200`
- [x] bridge：ElementView 字段/上限（`HINT_MAX_CHARS=200`、`frame_path`、`structure_path`）
- 验收：双端口跨源 fixture——同名跨帧 → observe 给出 `Close frame:<origin>` 候选；歧义证据带 frame_origin

**C 批（原 C3b）**
- [x] `findByHint` parseHint + 链过滤；`amber start --target` 结构化拒绝
- [x] `probeExcludedHint` 链证据（声明链 + 命中帧完整链）
- [x] `describeFrameSuffixRejection` / `frameTargetStopReason` / apps check 静态 lint
- 验收：`frame:` 指向被排除帧 → `frame_not_allowed`（reason 含声明链与命中链）；FW8/DRF/F64 不越帧

**D 批（原 C4）**
- [x] `grammar-prompt.ts`：`HINT_FRAME_SUFFIX` + 自证（随 A 批落地）
- [x] `schema-gen.ts`：F70（A/B/C 文字已随批同步，D 批核对并重生成快照）
- [x] 文档 / `registry.ts` / `CHANGELOG.md` / schema 快照
- 验收：`npm run check` 全绿（含 prompt-hit / schema / secret-scan / examples / test:validate）

## 6. 测试计划

**离线（node --experimental-strip-types，脚本放 /tmp，不入库）**
1. `parseHint`：合法后缀（六形状各一）、origin 大小写、带端口、非法 scheme/相对值、
   多 frame:/链式、与 within 同现、`frame:` 出现在中段（非结尾）→ 不剥离；
2. `hintMatch`：跨帧同名池上 `frame:` 唯一命中；错 origin → 落空；无后缀 → 歧义不变；
   within+frame 交集；主帧元素 `frame:<主 origin>` 命中；
3. `suggestHints`：跨帧同名给出 frame 候选；唯一 label 不追加；无 frame_origin 不追加；
4. 模型投影：`pickInner` 后 `ChoiceRequest.elems` 无 `frame_origin`（字节对照）。

**浏览器级（本地双端口跨源 fixture）**
| # | 场景 | 期望 |
|---|---|---|
| 1 | 两个 iframe 各一个同名按钮 | `Close` 歧义；`Close frame:<origin1>` / `<origin2>` 分别命中正确元素（点击落点断言） |
| 2 | 同一 iframe 内同名按钮 + 祖先 #id | `Close within:#panel` 仍可用；`Close within:#panel frame:<origin>` 组合可用 |
| 3 | 错 origin | `target_not_found`（不误点） |
| 4 | hosts 未声明该 frame origin + `frame:` 目标 | `frame_not_allowed`，reason 含 origin |
| 5 | 无 iframe 普通页 + `frame:<主 origin>` | 命中（主帧 origin 可限定） |
| 6 | inspect `--probe` / observe 候选 | 输出 `frame:` 形状可照抄，照抄后命中 |
| 7 | 回归：既有无后缀 hint 的应用 | 行为/产物逐字节不变（对照 dry 面） |

**门禁**：`npm run check`；如有 schema 快照变化则重生成 `dist/schema/ctx.json`（gitignored）。

## 7. 风险与回退

| 风险 | 等级 | 缓解 |
|---|---|---|
| 后缀解析误伤旧 hint（值里含 `frame:` 文本） | 低 | 仅结尾 + 前置空格 + 合法 origin 才剥离；与 within 同款测试面；不剥离时按旧串落空（显式失败） |
| 池行新增字段泄漏到模型面 | 中 | `pickInner` 剥离 + 离线断言模型投影字节不变 |
| 同签名跨帧被 `firstIfSame` 合并 / 同 origin 兄弟不可分被误认为 bug | 低 | 文档明示（§11.2 D2）；「跨帧同签名不合并」独立立项（行为变更需开关） |
| F45/FW8/DRF 忽略 frame 限定导致越帧动作 | **中高** | C3 显式适配 + 浏览器级断言（错误 origin 不动作） |
| `frame:` 与 `within:` 剥离顺序冲突 | 低 | 固定顺序（within 先、frame 后）+ 单测覆盖两种顺序 |
| 动态帧 origin 变化（导航） | 低 | origin 稳定；导航后帧 URL 变 → 按新 origin 匹配，文档提示用 observe 复核 |
| hint-lint/grammar 断言漏改 | 低 | C4 自证 + prompt-hit 门禁 |

**回退**：新语法纯 additive。回退以 **A 批为最小单位**（A 批单独 revert 会破坏 frame 语义一致性，见 §11.5）；只删 `parseHint` 的 frame 剥离分支仅恢复语法层，不能单独上线。

## 8. 备选方案对比（为何选 origin）

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 帧下标 `frame:1` | 实现最简单 | 下标随动态 iframe 漂移；跨会话不稳定 | ❌ |
| iframe 元素 selector `frame:iframe#x` | 直观、可定位嵌套链 | 引入任意 CSS（违反封闭集）；iframe 元素本身可能不可寻址 | ❌ |
| policy 级帧白名单 `meta.policy.frames` | 集中控制 | 粒度太粗（不能区分同帧元素）；与 hosts 重复 | ❌ |
| **origin 尾缀 `frame:<origin链>`** | 稳定、跨源一致、与 within 同构、可自证唯一、origin 链可区分同源父子 | 同签名跨帧仍由 `firstIfSame` 合并；同 origin 兄弟不可分；链长 ≤4 段 | ✅ 本期 |
| 池外 DOM 回捞（FW8 式） | 无语法改动 | 只能回捞身份形状；无法表达"哪个帧" | ❌ |

## 9. 验收标准（DoD）

1. 功能：六形状 × `frame:<origin链>`（含 ≤4 段）均可唯一命中；与 within 交集；错 origin 不动作；
2. 兼容：无后缀 hint 的 run/trace/result/dry 产物逐字节不变（对照运行）；
3. 观察面：`ctx.observe` / `inspect` 的 hint_candidates 给出可照抄 `frame:` 候选；
4. 门禁：`npm run check` 全绿；grammar-prompt 自证不抛；F70/文档/CHANGELOG 同步；
5. 证据：错误 origin / 被排除帧 / 同签名跨帧（firstIfSame 边界）三类失败都有可行动 reason；
6. 范围纪律：不引入任意 CSS、不扩 hint 六形状、不动 done/judge 语义。

## 10. 工作量预估

| 批次 | 内容 | 规模 |
|---|---|---|
| C1 | 解析 + 匹配 + 数据面 | ~4 文件、~150 行、离线断言 ~80 行 |
| C2 | 观察/建议/歧义证据 | ~4 文件、~60 行 |
| C3 | 回捞/门禁适配 | ~3 文件、~40 行 |
| C4 | 契约/文档/门禁 | ~5 文件、~80 行 |
| 测试 | 离线 + 双端口 fixture + 回归 | 1 轮专项测试 + `npm run check` |

**建议节奏**：C1 → 专项测试（离线+fixture）→ C2 → C3 → C4 → 全量门禁 → 推送。每个批次独立可回退。

> 实际执行按 §11.3 的 A–D 执行（A 不可拆，B/C 依赖 A，D 收尾）；实际规模大于上表预估
> （A 批 16 文件 +963/−73 行，B 批 18 文件 +330/−36，C 批 11 文件 +466/−52）。

---

## 11. 架构评审记录与修订（v1.1，2026-11-14）

> 评审裁决：**CONDITIONAL APPROVE**（方向正确；9 处代码假设需修正，其中 3 处会导致**错帧动作/静默失效**）。
> 评审证据已由 Lead 抽检复核（inAnchor 使用点 / poolView 映射 / findByHint / F64 hosts / HINT_GRAMMAR / hintLookup 合成池），属实。

### 11.1 必须修订（Blocker → 处理决定）

| # | 问题（评审证据） | 处理决定 |
|---|---|---|
| B1 | `inAnchor` 只在 `emit()`（rules.ts:328-336），attrSubstr 三档（:373/375/376）、bare（:449）、tag-submit 偏好（:404-411）绕过 → emit 级 frame 过滤会漏 | **改为 `hintMatchImpl` 入口过滤 `entries`**（:320）：`parsed.frame===undefined ? entries : entries.filter(e => String(e.frame_origin??"")===parsed.frame)`；六形状/档位/tag-submit/sink/diag 自动一致；**档位在帧内计算**（纠正 §3.2 表述），补充与 F59 弱档门（suspicious）交互说明 |
| B2 | within 正则带 `$` 锚（hint.ts:51-63），只支持串尾；与 §3.1「顺序无关」矛盾 | **循环剥离两种后缀**（各计数 ≤1）；grammar-prompt 自证固定两种顺序各一条 |
| B3 | **四处**合成池缺帧字段：hintLookup（extraction.ts:1318）、DRF `rowToElem`（declared.ts:198-224）、A3 `_domFallbackResolve`（executor.ts:2357-2366）、**FW8 `identityLookup` 合成 Elem**（identity.ts:239-259；executor.ts:3998-4000 注入后 4040/4073/4240/4296 再 hintMatch，entries 级过滤会整行滤掉）→ frame: 在回捞面静默失效；且链需 `frame_origin`+`frame_path` 两字段（只补 origin 时 ≥2 段链永不命中） | **四池同批补两字段**；A3/FW8 主帧常量或按 `fi` 走同一 helper；C3a 验收覆盖"只 origin/两字段"两态 |
| B4 | C1 单独落地时 FW8/F64 仍跨帧回捞（identity.ts:202-210 只按 hosts；F64 `_liveDomIdFallback` 连 hosts 都不查）→ 声明 A 帧点到 B 帧 | **C1 与 C3a（FW8/F64/DRF 帧+hosts 过滤）同一提交发布**；F64 顺手补 `frameInHostsEnvelope` 检查 |
| B5 | `pickInner` 快路径 guard（executor.ts:1134-1136）只判 surface/href_full/identity/declared；只改解构会把「只带 frame_origin」行泄漏进模型面 | **guard + 解构两处都加**；离线断言必须含「只带 frame_origin 的行」；**不把 frame_origin 塞进 `esig`/`firstIfSame` 签名** |
| B6 | `poolView` 的 `frame_origin` 本身错（pool-view.ts:47-71：`[pageUrl, ...frames()]` 重复+Set+sort 破坏 fi↔origin；跨源页会全反） | 元素行改用 `e.frame_origin`（单一出处）；顶层 `frame_origins` 仅作枚举；**这是有意的 bug fix，CHANGELOG 记录**（会改变 cross-origin 页 inspect 行的 frame_origin 值） |
| B7 | `HINT_GRAMMAR`（schema-gen.ts:118-127）只有 `within_suffix`，无 frame 键；F 条目联动缺 | **`HINT_GRAMMAR` 增 `frame_suffix`；F70 与代码同批**（不留到 C4）；视改动面同步 F41/F44/F45/F54/F55/F64 文字 |
| B8 | 非法 origin/多后缀 = 永不命中的裸词，target_not_found 不点名后缀；合法但写错 origin 不列页面实际 origin | hint.ts 增**只读「后缀被拒绝」判定**；`target_not_found` / act_hint strict / 会话 diagnostics 追加「frame: 尾缀被拒绝（原因）；页面可用 origin: [...]」 |
| B9 | `findByHint`（start.ts:178）是独立旧匹配器（start.ts:260 / plan-cli.ts:222 消费）→ `plan check --probe` / `amber start --target` 对 frame: 误报未命中；且 `amber start` 演示点击是主帧 `page.click(sel)`（start.ts:290），带帧限定目标会点错/超时 | findByHint 先 `parseHint`+链过滤；`amber start --target` 二选一：结构化拒绝带帧限定 target，或改用解析帧 locator 点击（C 批，R2-4） |

### 11.2 决策点修订

| 点 | 修订 |
|---|---|
| D1 | 同意完整 origin；**收紧值语法**：`v === new URL(v).origin` 才剥离（带 path/query 拒绝）；文档写明"同站不同路径的 iframe 不可分"边界 |
| **D2** | **改为**：同签名跨帧终裁会被 `firstIfSame`（extraction.ts:369-381，签名仅 tag/label/href/data_test）合并——**不是 `target_ambiguous`**；本期不承诺"同 origin 多帧歧义"，另立项「跨帧同签名不合并」（行为变更需开关）；三种消费面（run 命令步 / act hint / 会话 act）分别断言 |
| D3 | 改为：嵌套帧在 `framesOf ≤6` 且 origin 唯一时可命中；真正边界 = 父子同 origin、第 7 帧后、下标漂移；**帧链独立立项**，不把已能用的场景写成 out of scope |
| D4 | 同意可组合；先按 B1/B2 实现；语义 = "帧内 universe + 锚内过滤"；补两种顺序/双后缀拒绝测试 |
| D5 | 同意不支持 about:blank；补 N4（`frameOriginOf` 对 about:blank 返回 `"null"` 字符串，只对 http/https 落字段）+ 可读诊断 |
| D6 | 同意不抛 config_error；但"显式失败"必须显式（B8 诊断）；带 path 的 URL 处理写清（拒绝） |
| D7 | 同意不动配额；补充 `framesOf ≤6` 与 `frameGateOf` 用 64 的口径不一致问题；frame: 落空时 reason 列页面实际帧 origin |

### 11.3 批次修订（实施顺序）

| 提交 | 内容 | 备注 |
|---|---|---|
| **A** | C1 + C3a + 契约：parse（两种后缀循环剥离 + 串尾预扫/整组回退）、entries 级过滤（档位在帧内）、`Elem.frame_origin`+`Elem.frame_path`、extractElements/heuristic 主帧常量/observeElements、**poolView 单一出处修复**、pickInner guard+strip（两字段）、hintLookup/DRF/A3/**FW8** 四合成池打点、FW8/F64 帧+hosts 过滤、`HINT_GRAMMAR`+F70、grammar-prompt 自证 + prompt-hit 断言 | **不可拆**（B4） |
| B | C2：suggestHints frame 候选、ambiguity `frame_origin`、`ObserveElement.frame_origin`、bridge 透传（白名单/长度上限）、F41/F54 文字 | 依赖 A |
| C | C3b：`probeExcludedHint` 按 frame 过滤、`findByHint`、拒绝/错 origin 诊断、apps check 静态 lint | 依赖 A |
| D | C4：docs / CHANGELOG / schema 快照重生成 | 最后 |

### 11.4 测试补充（采纳评审 T1–T9）

1. 无后缀逐字节对照补 inspect --json / observe / pool-N.json（**声明** poolView 修复会改变 cross-origin 页 frame_origin 值）；2. parse 两种顺序/值内含 `frame:`/带 path/about:blank/多后缀/中段；3. match 档位×frame、attrSubstr 三档、tag-submit、**同签名跨帧三消费面分别断言**；4. 回捞面全覆盖（hintLookup 窗口挤出、DRF attr/text、A3 0×0、F64 正确/错/排除帧、scrollList/expand、plan check、apps check）；5. hosts 两态（排除 origin → `frame_not_allowed`；仅存在排除帧 → `target_not_found`）；6. fixture 让 main/child 端口**反序**逼出 poolView 排序错误；7. 模型投影含"只带 frame_origin 行"+"esig/firstIfSame 不受影响"；8. prompt-hit grammar 组显式后缀断言 + schema 快照重生成；9. 浏览器 fixture 不入库 → 关键离线部分挂 grammar-prompt/prompt-hit（进 `npm run check`），fixture 仅作一次性证据。

### 11.5 规模与前置条件

- C3 拆为 C3a（合成池打点 + FW8/F64 帧与 hosts，随提交 A）与 C3b（probe/findByHint/诊断，提交 C）；总量上修。
- **实施前置条件（全部满足才开工）**：B1 入口过滤+档位语义、B2 循环剥离、B3 三处合成池、B4 合并提交、B5 guard+strip、B6 poolView 单一出处、B7 HINT_GRAMMAR+F 同批、B8 拒绝诊断、B9 findByHint。
- 回退：提交 A 不可单独回退（会破坏 frame 语义一致性），回退以 A 为最小单位。

---

## 12. 层级编码适用性评估与增量设计（frame origin 链 / within 语义链 / 结构证据）（v1.2，已并入第二轮复审修订）

### 12.1 三类"层级编码"与结论

| 类型 | 形式 | 稳定性 | 结论 |
|---|---|---|---|
| A. 帧层级编码（下标链） | `frame:0>2` | ❌ 动态 iframe 增删即漂移（评审 B4/B6 已实证） | **不做**（只保留 `f<fi>:` ref 作展示锚） |
| A'. 帧层级编码（origin 链） | `frame:o1>o2` | ✅ origin 稳定、跨源一致 | **做（增量）**，见 §12.3 |
| B. DOM 层级编码（nth-child/XPath） | `div#panel>button:nth-child(2)` | ❌ 重排/虚拟列表/广告插入/A-B 即漂移 | **不进动作语法**；只进诊断证据（§12.5） |
| C. 混合层级编码 | `frameLocator('#a').frameLocator('#b')...` / `f1:e3` | 依赖 iframe 选择器可寻址 + 任意 CSS | 不做全量；`f1:e3` 仅展示锚 |

**总原则**：语义身份（id/data-test/name/href/唯一文本）→ 语义作用域（`within:#id` / `frame:<origin-chain>`）→ 结构证据（仅诊断）。**层级编码"能表达"一切同名元素，但"稳定表达"才是引擎需要的**。

### 12.2 场景 × 适用性

| 场景 | 推荐编码 | 层级编码适用性 |
|---|---|---|
| 不同 document（跨 iframe） | `frame:<origin>` | 下标链 ❌；**origin 链 ✅** |
| 嵌套 iframe | `frame:o_parent>o_child` | ✅ 父/子可区分（**同 origin 父子靠链长区分**：`frame:o` 命中父、`frame:o>o` 仅命中子）；真正不可分 = 同 origin 序列的**兄弟/不同分支** |
| 同 document、不同子树（modal vs 页面） | `within:#id` 祖先身份 | 祖先 id 链**本期不做**（§12.4 deferred）；单段 `within:#id` 已覆盖常见场景；nth-child ❌ |
| 同 document、无任何语义属性 | 结构路径（兜底） | ✅ 唯一选择但脆弱——只作最后手段，且需唯一性校验 + 稳定性警告 |
| 列表重复项 | 业务键/行内容 | 位置 ❌（排序/过滤会变） |
| 虚拟列表 | 行内容 | 位置 ❌（节点复用） |
| 动态插入广告/懒加载 | 语义身份 | 结构位置 ❌ |

### 12.3 增量设计 A：`frame:<origin>` 支持 **origin 链**（v1.2 修订）

**语法**（同一尾缀扩展）：
```
frame:<origin>          # 单段：元素所在帧自身 origin
frame:<o1>><o2>         # 链：外→内；末段 = 元素所在帧自身 origin
```

**唯一公式（R2-1）**：`fullChain(frame) = [rootOrigin, …, parentOrigin, ownOrigin]`（**恒含自身帧**）；声明链 = fullChain 的**后缀**且**末段 = 自身帧 origin**；深度只由链长隐含（链长 = 帧深度 + 1）。
- 每段 `v === new URL(v).origin`（http/https；默认端口归一后比较——`https://a:443` 要写成 `https://a`）；
- **未知 origin 不可寻址**：`frame_origin` 缺失/非 http(s)（`about:blank`/`srcdoc` 的 `"null"`、空串）⇒ 该帧内元素**不可被任何 `frame:` 命中**（视为 undefined，不是"少一段"），防 srcdoc 子帧被父 origin 误命中；
- 声明段数 ≤4（**声明上限**，>4 = 解析期整组拒绝；`framesOf ≤6` 时更深元素只能用后缀命中、不能被全链唯一表达）；
- 解析口径（R2-5）：**串尾词法预扫**（只匹配串尾后缀）→ within/frame 各 ≤1 次 → 任一类超限或值非法 ⇒ **整组后缀都不应用**（按原始串回退，禁止半剥/全局子串计数；防 `host within:8080` 误伤）；
- 与 `within` 可组合（两种顺序都支持）；**锚与元素必须同文档**（`anchor_ids`/`contains` 都是同帧判定；`within:#dialog frame:checkout` 只在 #dialog 也在该帧内时成立）。

**语义**：声明链匹配 `fullChain` 的后缀；单段退化为自身 origin 相等（与 §3 逐字节兼容）；档位在帧内计算（§11.1 B1）。
- **同源父子可区分（R2-2）**：父 `[o]`、子 `[o,o]` → `frame:o` 命中两者、`frame:o>o` 仅子；**真正不可分 = 同 origin 序列的兄弟/不同分支**（链逐段相同）→ 过滤后唯一性判定，同签名仍由 `firstIfSame` 合并（D2 边界），文档提示用帧内 `within:`/唯一文本。

**数据面（同批全链打点；B3 扩四池 + R2-3/R2-9）**：
- `Elem.frame_origin` + `Elem.frame_path?: string[]`（祖先 origin 链，外→内；主帧 path 省略）；
- 打点五处：`extractElements` 帧合并、**`hintLookup` 合成池、DRF `rowToElem`、A3 `_domFallbackResolve`、FW8 `identityLookup` 合成 Elem**——两字段都要（只写 origin 时 ≥2 段链永不命中）；A3/FW8 主帧常量或按 `fi` 走同一 helper（R2-3）；
- observe：`ObserveRawRow`/`observeElements`/`syntheticElem` 同链字段（observe 自证池无链 = 永远给不出链候选）（R2-9）；
- heuristic 宽扫是 `page.evaluate`（**仅主帧**，连 frame 都不设）→ 显式 `frame=0`、`frame_origin=主帧 origin`、`frame_path` 省略；§3.3"同一 JS 产物"不成立，需改；
- `pickInner` guard+解构同时剥离 `frame_origin` **与** `frame_path`（B5）；不进 `esig`/`firstIfSame` 签名（副作用进风险表：firstIfSame 仍跨帧合并、esig 连坐）；
- `pool-view` 元素行用 `e.frame_origin`（B6）+ 可选 `frame_path`；bridge ElementView 补 `frame_path` 与长度上限（现有 `frame_origin` 60 字截断）。

**回捞/门禁适配（链同批）**：统一 helper `frameChainOf(frame)` + `frameScopeMatches(declared, chain)`（放 `extraction.ts` 或新 `frame-scope.ts`），调用点：extractElements / observeElements / hintLookup / FW8 / DRF / F64 / probeExcludedHint / A3 / heuristic / **findByHint**。
- `findByHint`（start.ts:178）必须 parseHint+链过滤，否则 `plan check --probe` 与 `amber start --target` 对 frame: 误报（R2-4）；
- `amber start --target` 的演示点击是主帧 `page.click(sel)`（start.ts:290）：**结构化拒绝**带帧限定的 target，或改用解析帧的 `frame.locator(sel).click()`（二选一写死）；
- DRF text 用 `parsed.token`（不能 `hint.trim()`）；HINT_HEAD 的 nearToken 用 `parsed.token`（R2-7）；
- 链匹配的排除帧 `frame_not_allowed` 报**命中的那条链**并与声明链并排；probe 只对"链匹配"的排除帧报（不把无关 origin 当证据）。

**唯一性/歧义补充（R2-10）**：`tag` 形状的 submit 偏好分支（rules.ts:404-412 `return submits[0]`）绕过 `inAnchor` → 先 `inAnchor([...hits])` 再偏好（within 未声明时恒等，旧行为逐字节不变）；补 `button/input × within × frame` 测试。

**边界（诚实失败）**：同 origin 序列兄弟不可分（D2）；`framesOf ≤6`；iframe 导航后 origin 变；证据长度上限（R2-6：2 段≈60–80、3 段 >80、4 段逼 160 → 提高 `AMBIGUITY_HINT_MAX`/桥 `suggested_hint`/ElementView `HINT_MAX_CHARS` 并记账，或加长度门+advisory）。

### 12.4 增量设计 B：`within` 语义链 —— **本期不做（deferred，E 批，不占 A–D 回退单元）**

原因：`anchor_ids` 只有 ≤8 个**同文档**祖先 id，缺 id 才是主因，链不创造 id；合成/回捞池（hintLookup/A3/DRF/FW8）**没有 anchor_ids** ⇒ 链在回捞面不可验证；FW8/F64 根本不看 within、DRF text 完全忽略 within（R2-8：`#x within:#panel` 今天就可能操作锚外 #x）；单段 `within:#最近唯一祖先` 已覆盖"模态 vs 页面"；再加一套 `>` 迷你语言与 frame 链在文档/Agent 侧易混。

若未来要做，前置条件：①四处合成池补 `anchor_ids`；②FW8/F64/DRF-text 遵守 within；③再定义段语法（每段 `#id`）、索引严格递增、同 id 重复取首/末、>8/缺锚 = miss、段数上限与独立测试面。

### 12.5 增量设计 C（仅诊断，不进语法）：结构证据 `structure_path`

- **范围**：只进 `inspect`（opt-in，沿用 classNames/fullLabel 先例）+（可选）`ctx.observe({includeStructure:true})`；**不进 ambiguity**——`describeAmbiguity` 是零页面 I/O 纯函数，要带结构路径就得写进 `Elem`，需改 EXTRACT_JS/PASS_OBSERVE 两个 JS pass + pickInner 剥离，成本另算；
- **来源**：`parentFrame().childFrames().indexOf(fr)`（零页面往返）或直接用 `f<fi>:` 下标；不用"父文档第几个 iframe"的视觉描述（跨源子帧拿不到）；
- **字段**：`structure_path`（祖先 tag/id + 兄弟序号 + 帧下标、≤160 独立上限），配 `unstable:true` 或命名 `unstable_structure_path`，让"不是 hint"一眼可见；bridge 加独立上限常量与白名单；
- 不进模型请求面；文档红字"仅诊断，不可照抄"。

### 12.6 明确不做

- nth-child/XPath 全量语法（破坏 hint 封闭集与单一解析器纪律）；
- 帧下标链 `frame:0>2`（漂移）；
- 跨帧同签名静默合并（D2 边界，需独立立项 + 开关）；
- `read/extract/collect/judge` 的帧限定——当前 `locatorAnyFrame` 逐帧 OR，**无法指定帧**；对称化独立立项（不与本方案混）；
- `within` 语义链（§12.4 deferred）。

### 12.7 批次影响

| 批次 | 增加内容 |
|---|---|
| **A（同批）** | origin 链解析（≤4 段、预扫/整组回退）、`Elem.frame_origin`+`frame_path` 全链数据面（extract/observe raw/heuristic 主帧/四条合成池/pickInner 两字段/pool-view）、entries 级链过滤、统一 helper、回捞/门禁链过滤、grammar/F70 链规则 |
| B | `suggestHints` 链候选、`ObserveElement.frame_path`、`structure_path`（inspect opt-in + 可选 observe）、F41/F54/F55 文字、bridge `frame_path`/上限/ambiguity 白名单 |
| C | `findByHint` 链过滤 + `amber start --target` 处理、`probeExcludedHint` 链证据、拒绝/错链诊断、apps check lint |
| D | 文档/CHANGELOG/schema 快照 |
| E（独立，可延后） | `within` 语义链（§12.4 deferred；不占 A–D 回退单元） |

### 12.8 新增测试（并入 §11.4）

1. **解析**：双 frame / 双 within / 真后缀+值内伪后缀 / 两种顺序（within 在前、frame 在前，均带链）/ 空段 / >4 段 / 带 path / 带 query / 默认端口 / IPv6 origin / 中段 `frame:` → 全部"显式失败 = 原串整体不剥（含回滚）"；
2. **链语义**：同源父子（2 段只中子、1 段中两者）、同源兄弟（不可区分 → firstIfSame 合并）、三层链、错序、srcdoc/about:blank 子帧不可寻址、主帧、帧导航后 origin 变；
3. **四条合成池**（FW8/DRF/A3/hintLookup）各一条 `frame:`（含 2 段）+ "只 origin / origin+path"两态对照；
4. **模型面**：pickInner 后"只带 frame_path 行""只带 frame_origin 行""两者都有行"字节对照；
5. **`button/input × within × frame`**：tag-submit 分支不得选锚外元素；
6. **回捞形状**：bare+frame 走 DRF text、nearToken+frame 走 hintLookup、`#id within:#panel` 在 FW8/F64 上不得越锚；
7. **证据**：每条 hint_candidate 长度 ≤ 消费面上限且 parse+自证可命中（round-trip）；ambiguity `suggested_hint` 200 / `target` 120 的 clip 行为（B 批已把 `AMBIGUITY_HINT_MAX` 80→200、桥 `suggested_hint`→200、`HINT_MAX_CHARS` 160→200）；bridge ElementView/ambiguity 投影白名单与截断；`structure_path` 有界/unstable/不进模型面；
8. **门禁**：被排除帧的 reason 带链；仅"存在排除帧"时 `target_not_found`；F64 的 hosts × 链双错；
9. **CLI**：`plan check --probe` 与 `amber start --target` 的 frame: 行为（正确点帧内或明确拒绝）；
10. **逐字节**：无后缀场景 run/trace/result/dry 逐字节 + inspect/observe 的"允许 additive 清单"核对。

### 12.9 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 扁平帧树实现链匹配错误（parentFrame 上溯；帧对象恒等） | 中 | 单一 helper + 离线断言（构造祖先链）；用 `parentFrame()===null` 判根、`isDetached()` 判活 |
| 同 origin 序列兄弟不可分 | 中 | 文档边界（D2 firstIfSame 合并）；帧元素锚独立立项 |
| 语法膨胀/段数无界 | 低 | ≤4 段硬限 + 解析期拒绝 |
| `parentFrame()` 在 detach 时**不抛错也不返回 null**（返回陈旧父帧） | 中 | 用 `isDetached()`（types:7142）或帧 evaluate 失败即整帧丢弃；不能靠 try/catch |
| 结构证据被误当寻址 | 低 | 命名 `unstable_structure_path` + `unstable:true` + 文档红字 + 不进模型面 |
| 证据上限截断链候选（R2-6） | 中 | 提高 `AMBIGUITY_HINT_MAX`/桥 suggested_hint/ElementView HINT_MAX_CHARS（合同记账）或长度门+advisory |
| 回捞 DOM pass 用带后缀原串（R2-7） | 中 | DRF text 用 `parsed.token`；HINT_HEAD nearToken 用 `parsed.token` |
| within 权威不对等（R2-8：回捞面不遵守 within，FW8/F64 完全不看） | 中 | 本期如实写边界 + 测试；E 批前置修复 |
| firstIfSame 跨帧合并 / esig 连坐（N7） | 中 | 风险表记录；帧限定后仍可能静默合并 → 文档提示 + 后续"跨帧同签名不合并"立项 |
| bridge 工具描述无 frame:（可发现性） / ambiguity 白名单缺 frame_origin（N8） | 中 | 契约批同步 bridge 描述、ElementView、ambiguity 投影；`docs/AGENT_INTERFACE.md` 同步 |
| URL origin ≠ document origin（sandboxed iframe、srcdoc）（N17） | 低 | 文档说明：origin 只用于匹配，不是安全判定（门禁是 hosts） |
| A 批体积进一步增大 | 中 | 链逻辑与单 origin 共用一条过滤路径；测试分开；链可作为同一 PR 第二提交（不单独发布），或整体延后到独立批（单段是链的后缀特例） |

### 12.10 与 §11 的继承核对（第二轮复审结论）

| §11 项 | §12 落点 | 核对结果 |
|---|---|---|
| B1 entries 级过滤/档位在帧内 | §12.3 语义 + §3.2 标注 | ✓（证据句修正：inAnchor 在 attrSubstr/bare 有显式调用，真正绕过的是 tag-submit） |
| B2 循环剥离 | §12.3 解析口径（R2-5 预扫/整组回退） | ✓（需 R2-5 口径） |
| B3 合成池打点 | §12.3 数据面（扩为**四池**+两字段） | **原 ✗ → 已补** |
| B4 A 批不可拆 | §12.7 A 同批 | ✓ |
| B5 pickInner guard+strip | §12.3 数据面（两字段） | ✓（需扩 frame_path） |
| B6 pool-view 单一出处 | §12.3 数据面 | ✓（需补链展示） |
| B7 HINT_GRAMMAR+F70 同批 | §12.7 A | ✓ |
| B8 拒绝/错链诊断 | §12.3 数据面/回捞 + §12.9 | ✓（诊断需列链） |
| B9 findByHint | §12.7 C | **原 ✗ → 已补** |

---

## 13. 实施记录（v1.2 落地，2026-11-15）

> 口径：本节记录**实际落地**的范围与偏差；正文与实现不一致处**以代码为准**（偏差见 §13.3）。
> A/B/C 已推送（HEAD=`5c25ef5`），D 为文档/契约收尾批（只改文档与契约文本，不改运行时行为）。

### 13.1 批次与提交

| 批次 | 提交 | 内容 | 实际改动（主要文件） |
|---|---|---|---|
| **A** | `bc400ca` | 解析/匹配/数据面/回捞/契约（C1 + C3a，不可拆） | `hint.ts` 串尾预扫+循环剥离（within/frame 各 ≤1、整组回退、`frameChainValueProblem`）；`frame-scope.ts`（`frameChainOf` / `frameScopeMatches` / `elemFrameStamp` / `frameOriginOf`）；`rules.hintMatchImpl` 入口 entries 过滤 + tag-submit 先 `inAnchor`；`Elem.frame_origin/frame_path` 全链打点（extract / heuristic 主帧 / observe 自证池 / hintLookup / DRF / A3 / FW8 四合成池）；`pickInner`→`modelProjectionOf` 两字段剥离；`hintLookup/FW8/DRF/F64` 链 + hosts 过滤；`poolView` 单一出处修复；`HINT_GRAMMAR.frame_suffix`+F70；`grammar-prompt.HINT_FRAME_SUFFIX`+自证；prompt-hit 断言 |
| **B** | `3ce26fa` | 候选/观察/结构/bridge（C2） | `suggestHints` frame 单段/链候选（自证唯一、4 条上限、顺序=身份→label→frame→within）；`ObserveElement.frame_origin/frame_path`；`structure_path`（inspect / observe `includeStructure` opt-in，≤160 + `structure_unstable`）；`AMBIGUITY_HINT_MAX` 80→200、`AmbiguityCandidate.frame_origin`；bridge ElementView `HINT_MAX_CHARS` 160→200 + `frame_path`(≤4×64)/`structure_path`(≤160) 常量与投影、session `include_structure`、ambiguity `frame_origin`≤60/`suggested_hint`≤200；F41/F54/F55 文字 |
| **C** | `5c25ef5` | 校验面/诊断闭环（C3b） | `findByHint` parseHint+链过滤；`amber start --target` 结构化拒绝（开浏览器前、exit 2）；`probeExcludedHint.declaredChain/matchedChains`（按链去重 ≤4）；`executor-pure.frameTargetStopReason`（声明链 + 命中链 + ≤5 只读命中 + 两条修法）；`describeFrameSuffixRejection` + target_not_found / act_hint strict / 会话 act 落空统一追加「拒绝原因 + 页面可用 origin（≤6）」；`hint-lint.frameFindings` stderr 通道（非法值 / origin 不在 hosts，不进 problems/exit）；F45/F70 文字 |
| **D** | 本批（D 批文档收尾；提交号由 lead 统一落定） | 文档/CHANGELOG/schema 快照收尾（C4） | 本规格标题/状态改「已实施」+ §13 实施记录；`docs/APP_SCRIPT_AUTHORING.md` hint 语法主段补两种尾缀、多 frame 速查补 `findByHint` 能力边界、stopCode `target_not_found` 补 frame 证据；`docs/AGENT_INTERFACE.md` 增 §3.2 ElementView/ambiguity 合同；`docs/INTERACTIVE_SESSION.md` 核对并补上限；`src/cli/registry.ts` 帮助补 `frame:`；`schema-gen.ts` 的 `HINT_GRAMMAR.within_suffix`/F70 边界/cheat sheet 文字一致化并重生成快照；CHANGELOG 全量标题 + D 批 + 已知边界；**无运行时代码行为改动** |

### 13.2 实施中发现并修复的额外缺陷

1. **会话面 `_frame_hosts` 门禁补漏（A，行为变更·修正）**：`_frameHosts` 此前只在 run 面方法里赋值，session 面从未设置——声明 `hosts` 的会话仍会对信封外 iframe 的池 / FW8 / DRF / F64 不设防（专项测试实测：`hosts=[127.0.0.1]` 时 `localhost` 子帧仍可被 `frame:`/`#id` 命中）。现在构造时以 middleware 默认 hosts 兜底（run 面仍按 run 覆盖），与工具合同「same semantics as meta.hosts」一致。
2. **F64 `#id` live-DOM 直查 hosts 补漏（A，行为变更·修正）**：该回捞此前连 hosts 都不查，排除帧里的 `#id` 会被跨帧直查动作；现与池 / hintLookup / FW8 同口径（主帧恒允许、子帧不在信封内跳过）。声明目标确需该帧时仍走既有 `frame_not_allowed`。
3. **poolView 的 `frame_origin` 映射修复（A，行为变更·修正）**：旧实现 `[pageUrl, ...frames()].map(origin).sort()` 的下标映射在跨源页重复/排序打乱 `fi↔origin`，`frame_origin` 值会全反；现元素行用 `Elem.frame_origin` 单一出处，顶层 `frame_origins` 仍按帧枚举。**跨源页 inspect 的 `frame_origin` 值会变对**（有意修复，CHANGELOG 已记账）。
4. **`findByHint` 裸词/旧形状语义边界（C，记录不改）**：`findByHint` 是 `plan check --probe` / `amber start --target` 的旧匹配器，只认 `#id`、`[data-test=|id=|name=]` 与 `induceHint()` 产物（精确串）；C 批只加了 parseHint + 帧链过滤，**没有**把它换成 `hintMatch` 的六形状分档语义。因此 `plan check --probe` 对 `frame:` 的支持边界 = 身份形状与 induceHint 原样串；裸词 / `attrSubstr` / `nearToken` 等仍可能误报未命中（该 CLI 的既有边界，非本方案新增）。`amber start --target` 对帧限定目标在开浏览器前结构化拒绝。
5. **within 权威不对等（R2-8，记录）**：回捞面 DRF text 完全忽略 within、FW8/F64 不看 within（F64 在 A 批只补了 hosts）；本期如实保留，E 批前置修复。

### 13.3 与规格的偏差 / 口径修正

- §3.2 原「同 origin 多帧仍报 `target_ambiguous`」已被 §11.2 D2 取代：同签名跨帧由 `firstIfSame` 合并（run 命令步 / act hint 直接执行一个；会话 act 因 `hintCandidates.decided` 不暴露该裁决而停）。正文已按 D2 回写。
- §12.3 R2-5 预扫口径按 A 批实现：**两类后缀各 ≤1、任一超限/非法 = 整组不应用**（不是只回退超限的那一类）。
- F64 hosts 检查、会话 `_frameHosts` 兜底、poolView 修复是**行为变更**，已在 CHANGELOG 行为变更条记账。
- 引擎歧义证据 `frame_origin` 上限是 `AMBIGUITY_ORIGIN_MAX=120`；桥投影再 clip 到 60（更严，不改变引擎契约）。
- `structure_path` 只进 inspect 恒开面与 `ctx.observe({includeStructure:true})` / 桥 `include_structure` opt-in 面；不进模型面、不进歧义证据。
- `HINT_FRAME_SUFFIX` 的 grammar-prompt 自证随 A 批落地（不是 D 批）；D 批只核对文档/契约文字。
- **实施复审（2026-11-15，CONDITIONAL APPROVE）后续**：① **B-1 已修**——`findByHint` 对 `frame:`+`within:` 组合（两种顺序）此前假阴性（base 只认字面串尾 `frame:`），串尾剥离已收口为 `hint.ts` 导出的 **`splitTailSuffixes` 唯一出处**（parseHint 与 findByHint 共用，复审 N6 同步解决），组合顺序身份/induceHint 形状均正确命中；② R2-7 的 **nearToken 半项未做**（HINT_HEAD 维持整串——DOM 回捞按整串"几乎不命中"是防无上下文误命中的既定纪律），规格该句过承诺已回收；③ N2（整串 `frame:<origin>` 无主体的诊断）未做，显式失败仍在；④ N7（`matchedChains` 截断无标记）未做；⑤ hintMemory/induceHint 不产出 `frame:` 尾缀（跨帧同名记忆回放会歧义→回退模型，无误动作）——均入 §13.4 与 `docs/BACKLOG.md`。

### 13.4 未做 / 延后

| 项 | 状态 | 说明 |
|---|---|---|
| `within` 语义链（E 批） | 延后（独立回退单元） | §12.4 原因：合成池无 `anchor_ids`、FW8/F64/DRF-text 不遵守 within；前置条件见 §12.4 |
| 跨帧同签名不合并 | 未做（独立立项 + 开关） | D2 边界：`esig`/`firstIfSame` 签名不含新字段，同 tag/label/href/data-test 的跨帧元素仍合并 |
| `read/extract/collect/judge` 帧限定对称化 | 未做 | 当前 `locatorAnyFrame` 逐帧 OR，无法指定帧（§12.6）；本方案只服务 act hint / 命令 target |
| >6 帧 / 每帧池配额 | 未做 | `framesOf ≤6`；池窗口 40/120 跨帧共享、主帧优先；`frame:` 落空时 reason 列允许帧 origin（≤6） |
| `about:blank` / srcdoc 帧寻址 | 不做（本期） | 未知 origin 帧不可被任何 `frame:` 命中（D5）；origin 只用于匹配，不是安全判定（门禁是 hosts） |
| 帧下标链 / nth-child / XPath / iframe 选择器锚 | 不做 | 漂移/破坏 hint 封闭集（§12.1/§12.6） |
| `findByHint` 六形状全语义 | 未做（C 批边界） | 见 §13.2-4；`plan check --probe` 仅身份形状 + induceHint 产物 |
| `findByHint` 支持 `within:` | 未做（复审 B-1 附注） | 组合后缀的 **frame 链过滤**已由 B-1 修复；但 within 作用域在该面不生效（与 R2-8 同属回捞面权威不对等，E 批前置） |
| hintMemory / `induceHint` 帧限定 | 未做（复审边界） | `hint-memory.ts` 只产出 `[data-test=x]`/`tag[near~token]` 形状——跨帧同名记忆回放会歧义→回退模型（无误动作，记忆价值打折） |
| `frameChainOf` 深度帽 8 × `framesOf ≤6` 口径差 | 记录 | 帽只防病态环；更深帧本就不可达；病理帧树（环）由 `parent===cur`+帽兜底 |
| 结构证据进 ambiguity / 模型面 | 不做 | `structure_path` 仅诊断，不进 hint/模型/歧义（§12.5） |

### 13.5 验证与证据

- **A/B/C**：离线断言 66 / 98 / 184 条（parse 全矩阵、match 档位×frame、数据面与四合成池、回捞/门禁、findByHint/start 拒绝、诊断全矩阵、hint-lint、bridge 常量）；各批 `npm run typecheck`、`npm run prompt-hit`、`npm run schema:check`、`npm run check` 全绿（详见 CHANGELOG 各批「验证」）。
- **浏览器级（随批）**：A 批——跨源单段/2 段链命中、srcdoc 未知 origin 不可寻址、无后缀跨帧唯一透明、跨帧同名同签名会话 act 停机、hosts 信封外子帧不动作；B 批——inspect/observe 给出单段与 3 段链候选、链候选照抄 session act 命中孙帧（`f3:e0`）、srcdoc 报 opaque 且不给 frame 候选、无 iframe 页面对照无候选；C 批——`plan check --probe` 链命中/错链诊断、`amber start` 拒绝、被排除帧 `frame_not_allowed` 链证据与零动作、会话 act 错 origin reason 带可用 origin。
- **D**：只改文档/契约文本，无运行时行为；`npm run typecheck`、`npm run prompt-hit`（registry/grammar 文本改动后）、`npm run schema:check`（schema-gen 文字改动后重生成 gitignored `dist/schema/ctx.json`）。



