# Changelog

AmberFlow（冻结计划的浏览器自动化中间件）的显著变更。本文件格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] — frame:<origin> 帧限定 hint（解析/匹配/数据面/候选/诊断/契约）

### A 批（解析 / 匹配 / 数据面 / 回捞 / 契约）

- **【背景】** 多 iframe 页面里同名元素跨帧无法用现有 hint 表达：`within:#id` 只能同帧内
  锚定（iframe 内容的祖先链不含宿主页 iframe 元素）、池 ref `f<fi>:eN` 不是动作地址。
  `frame:` 与 E3 的 `within:` 同构（后缀限定是已验证可行且低风险的模式），本批落地
  解析/匹配核心 + 帧链数据面 + 回捞/门禁适配（A 批不可拆：单独落地任一半会让 frame: 在
  合成池/回捞面静默失效）。规格与评审记录：`docs/FRAME_SCOPE_HINT_PLAN.md`（§11/§12）。
- **【新语法】** 任意 hint 形状可后缀 ` frame:<origin链>`，命中集限定在 origin 链声明的
  frame 内：`>` 分隔外→内、≤4 段、每段 `v === new URL(v).origin` 的 http/https 规范形
  （带 path/query/显式默认端口拒绝，`https://a:443` 要写成 `https://a`）；唯一公式
  （R2-1）= 声明链是帧完整链 `[rootOrigin..ownOrigin]` 的**后缀**且末段 = 元素所在帧自身
  origin——同源父子靠链长区分（`frame:o` 命中父、`frame:o>o` 仅命中子）；与 `within:#id`
  可组合（两种顺序，取交集）。`about:blank`/srcdoc 等未知 origin 帧不可被任何 `frame:` 命中。
  无后缀 hint 走原路径逐字节不变。规格：`docs/FRAME_SCOPE_HINT_PLAN.md`（F70）。
- **【解析】** `parseHint` 改为**串尾词法预扫 + 循环剥离**：两类后缀（within/frame）各至多
  一次、只认「前置空白 + 串尾」，任一类超限 / 值非法 / 空段 ⇒ **整组后缀都不应用**
  （按原始串回退，绝不半剥）。修复旧实现全局子串计数（`h.match(/within:/g)`）对值内伪后缀
  的误伤——`host within:8080 within:#panel` 此前被整串拒绝，现在正确剥离真后缀。
- **【匹配】** `hintMatchImpl` 改为**入口过滤 entries**（B1 修订）：六形状 / 档位 /
  tag-submit / sink / 歧义诊断自动一致，**档位在帧内计算**（帧限定后本档清空 = 落空，
  不让帧外更弱档越级顶上）；tag 形状的 submit 偏好分支在偏好前先 `inAnchor`（修复 tag
  绕过 within 的旧缺陷；within/frame 未声明时恒等）；`hintCandidates`/`suggestHints`/
  歧义谓词经同一实现自动继承。
- **【数据面】** `Elem` 新增 `frame_origin` / `frame_path`（祖先 origin 链，外→内；主帧
  path 省略），帧链判定唯一出处新模块 `src/engine/frame-scope.ts`（`frameChainOf` 沿
  `parentFrame()` 上溯、`parentFrame()===null` 判根、`isDetached()` 判活——detach 后
  `parentFrame()` 返回陈旧父帧不能靠它）。打点全链覆盖：`extractElements` 帧合并、
  heuristic 宽扫（显式 `frame=0` + 主帧 origin）、`observeElements`/`ObserveRawRow`/
  `syntheticElem`（observe 自证池同构）、四处合成池（hintLookup / DRF `rowToElem` /
  A3 `_domFallbackResolve` / FW8 `identityLookup` 合成 Elem）。模型面：`pickInner` 剥离
  两字段（guard+解构收口在 `executor-pure.modelProjectionOf`，模型请求体字节不变）；
  **`esig`/`firstIfSame` 签名不含新字段**。
- **【回捞/门禁】** `hintLookup` / FW8 `identityLookup` / DRF `declaredLookup` /
  F64 `_liveDomIdFallback` 按 `parsed.frameChain` 过滤帧循环（声明链之外绝不动作）；
  `probeExcludedHint` 只对链匹配的排除帧探测/报证据；DRF text 模式改用 `parsed.token`
  （R2-7：尾缀不再被塞进文本匹配）。
- **【行为变更（有意修正）】** ① F64 `#id` live-DOM 直查此前**不查 hosts 信封**——排除帧里的
  `#id` 会被跨帧直查动作；现在与池/hintLookup/FW8 同口径（主帧恒允许、子帧不在信封内跳过），
  声明目标确需该 frame 时走既有 `frame_not_allowed` 路径。② poolView 元素行 `frame_origin`
  改用 `Elem.frame_origin` 单一出处——旧实现 `[pageUrl, ...frames()].map(origin).sort()` 的
  下标映射会重复/排序打乱 fi↔origin，跨源页 inspect 行的 frame_origin 值**会变对**；
  行上没有 frame_origin（未知 origin 帧）如实报 `"opaque"`，顶层 `frame_origins` 仍按帧枚举。
  ③ **会话面 frame 门禁补漏**：`_frameHosts` 此前只在 run 面方法里赋值，session 面从未设置——
  声明 `hosts` 的会话仍会对信封外 iframe 的池/FW8/DRF/F64 不设防（专项测试实测：
  `hosts=[127.0.0.1]` 时 `localhost` 子帧仍可被 `frame:`/`#id` 命中）。现在构造时以 middleware
  默认 hosts 兜底（run 面仍按 run 覆盖），与工具合同"same semantics as meta.hosts"一致。
- **【契约】** `HINT_GRAMMAR.frame_suffix` + F70 条目（schema-gen.ts）；grammar-prompt 新增
  `HINT_FRAME_SUFFIX`（与 HINT_WITHIN_SUFFIX 同构）+ import 时自证（单段/2 段链剥离、
  双 frame/非法 origin 整组拒绝、within+frame 两种顺序）；prompt-hit grammar 组新增两条断言。
- **【验证】** 离线断言全绿（parse 全矩阵 34 条 / 匹配层 18 条 / 数据面+回捞 14 条，
  含 fake parentFrame 帧链）；`npm run typecheck`、`npm run prompt-hit` 通过。浏览器级：
  双端口跨源 fixture（跨源单段/2 段链命中、srcdoc 未知 origin 不可寻址、无后缀跨帧唯一透明、
  跨帧同名同签名会话 act 停机、hosts 信封外子帧不动作）。

### B 批（候选生成 / 观察面 / 结构证据 / bridge 透传 / 契约文字）

- **【候选生成】** `suggestHints` 在唯一文本候选没自证成功、且元素有 `frame_origin` 时补帧限定
  候选：先 `<label> frame:<自身 origin>`；单段仍不唯一且 `frame_path` 非空时再给完整链
  `<label> frame:<祖先…>自身>`（含自身 ≤4 段，>4 段不生成）。仍在 label 之后、`within:` 之前，
  仍走同一个 `push`（`hintMatch`+`hintCandidates` 自证），总数仍 `slice(0,4)`；无 frame 字段/
  无可用 label 时输出逐字节不变。
- **【观察面字段】** `ObserveElement` 增加 `frame_origin` / `frame_path`（来自 A 批已打点的
  `ObserveRawRow`；非空才出现，与既有可选字段同口径），`ctx.observe` 的结果与 `ctx-types`
  文档同步——observe 自证池因此能给出/验证 `frame:` 候选。
- **【结构证据（仅诊断）】** `structure_path`：`extractElements({structurePath:true})`（inspect 面）
  与 `ctx.observe({includeStructure:true})` / 桥 `include_structure` opt-in 时，元素行带
  `structure_path`（祖先 tag/`#id` + 同 tag 兄弟序号 + 帧下标前缀，如 `f2>div#panel>button[2]`，
  ≤160 字符、超长从外侧截断）与 `structure_unstable:true`。**不是 hint**：动态页面可能失效、
  不可照抄；不进 hint 自证、`describeAmbiguity`（零页面 I/O 纯函数）或 `ChoiceRequest.elems`
  （`modelProjectionOf` 同步剥离 `structure_path`/`structure_unstable` 兜底）。
- **【证据上限（R2-6）】** `AMBIGUITY_HINT_MAX` 80 → **200**（`suggested_hint` 可容 4 段
  `frame:` 链）；桥 `suggested_hint` clip 80 → 200；`element-view.HINT_MAX_CHARS` 160 → 200；
  新增 `FRAME_PATH_MAX_ITEMS=4` / `FRAME_PATH_SEGMENT_MAX_CHARS=64` / `STRUCTURE_PATH_MAX_CHARS=160`
  独立上限。**合同变更记账**：歧义候选 additive `frame_origin`（引擎 `candidateView` 来自
  `Elem.frame_origin`，undefined 不出现；桥白名单与 render 摘要同步——跨帧同名时先看 origin）。
- **【bridge】** ElementView 透传 `frame_path`（≤4×64）、`structure_path`（≤160）/
  `structure_unstable`；`amberflow_session` 新增 `include_structure`（缺省 false，只透传）；
  `inspect` 元素行补 `frame_path`/`structure_path`（inspect 始终 opt-in，模型面不经过）。
  契约文字 F41（observe 字段 + `includeStructure`）、F54（ElementView 字段/上限）、F55
  （候选 `frame_origin`、`suggested_hint≤200`）、F70 truth 同步；`docs/APP_SCRIPT_AUTHORING.md`
  多 frame 速查与 `docs/AGENT_INTERFACE.md` 同步。
- **【验证】** 离线断言 98 条（候选自证/链升级/无 iframe 逐字节/证据上限 round-trip/
  `structure_path` 截断/模型面剥离/bridge 常量）；`npm run typecheck`、`npm run prompt-hit`、
  `npm run schema:check`、`npm run check` 全绿。浏览器级：inspect/observe 给出单段与 3 段链候选、
  链候选照抄 session act 命中孙帧（`f3:e0`）、srcdoc 未知 origin 报 opaque 且不给 frame 候选、
  无 iframe 页面对照无 frame 候选。

### C 批（findByHint / `amber start --target` / 链证据 / 拒绝诊断 / apps check lint）

- **【回捞/CLI 适配（R2-4/B9）】** `findByHint`（`plan check --probe` 与 `amber start --target`
  共用的旧匹配器）改为**先 `parseHint` 再按声明链过滤池**：`#id` / `[attr=v]` / `induceHint`
  既有匹配路径不变，只是池先按 `frameScopeMatches` 过滤；**身份形状（`#id` / `[data-test=|id=|name=]`）
  与 `induceHint` 产物**的帧内目标不再被 `plan check --probe` 误报未命中（该 CLI 的匹配器不是
  `hintMatch` 六形状分档语义，裸词/`attrSubstr`/`nearToken` 仍是既有边界——本次未换匹配器）。
  **无后缀路径逐字节不变**（`frameChain` 未定义时池就是原池、base 就是原串；
  与 git HEAD 旧实现 85 例差分一致）。
- **【`amber start --target` 帧限定结构化拒绝】** 该 CLI 的演示点击是**主帧** `page.click(...)`
  （`selectorForHint` 也只产出主帧 CSS），带 `frame:` 的目标会点错/超时。纯函数
  `frameTargetRejection(hint)` 在**开浏览器之前**拒绝：文案点名"不支持帧限定目标 + 主帧
  page.click + 改用 app/run 或 plan 面（`plan check --probe` 支持身份形状 + `frame:` 链核对）"；exit 沿用该 CLI
  既有失败口径（2），**不新增 exit code**。非法/多尾缀仍走旧路径（parseHint 不接受 ⇒ 显式落空）。
- **【被排除帧链证据（F45 C 批）】** `probeExcludedHint` 的 `ExcludedHintProbe` 增
  `declaredChain?`（hint 的 `frame:` 尾缀）与 `matchedChains`（命中帧完整链 `frameChainOf`，
  按链去重、≤4 条、含 origin/帧下标）；`frame_not_allowed` reason 改由纯函数
  `executor-pure.frameTargetStopReason` 拼装——声明链与命中链并排 + 只读命中证据（≤5 行）+
  两条修法（把命中 origin 加进 `meta.hosts` / 改目标或声明链到允许帧）。只探测**链匹配**的
  排除帧（A 批过滤保留），不匹配帧零 evaluate。
- **【拒绝/错链诊断（B8）】** `hint.ts` 新增纯函数 `describeFrameSuffixRejection(hint)`（零页面
  I/O、不改 `parseHint` 返回值语义）：串尾 ` frame:` 尝试未被接受时返回一行可行动原因并区分
  类别——多尾缀 / 非法 origin（缺 `://`、非 http(s)、about:blank）/ 空段 / >4 段 / 非规范 origin
  （path·query·fragment·显式默认端口）/ 空值 / 无 hint 主体 / frame 合法但同串 within 问题导致
  整组回退；合法尾缀、值内伪 `frame:`、中段 `frame:`、纯 within 问题 = null（不误报）。解析面与
  诊断面共用同一份值判定（`frameChainValueProblem`），parseHint 与 HEAD 46 例差分一致。
  接入点集中在 `extraction.frameHintFailureEvidence`（命令步 target_not_found / act_hint:"strict"
  两条 reason / 会话 act 落空 reason / `plan check --probe` 未命中行统一追加）：原因 +
  **页面实际可用 origin**（允许帧去重 ≤6、主帧也列）；无 frame: 参与时返回空串（旧 reason 逐字节
  不变）。`target_not_found` / `frame_not_allowed` 均**无新增 stopCode**。
- **【apps check 静态 lint（N10）】** `hint-lint.ts` 新增独立 stderr 提醒通道（不改三类形状判定与
  计数口径、不进 problems、不改 VALID/exit）：① `frame:` 值不是合法 origin（缺 `://`、带 path、
  多尾缀…）→ "必被解析拒绝"；② 值合法但 origin 的 hostname 不在 `meta.hosts` 信封内 →
  "若该 origin 是被排除的子 frame，运行期会 frame_not_allowed（主帧恒允许）"。`apps check`
  透传 `meta.hosts`；拿不到 hosts 时只做值形状检查（`hosts=[]` 同）。
- **【契约/文档】** F45 statement/truth 补"reason 带声明链 + 命中帧完整链"；F70 statement/truth
  补 C 批（findByHint/start 拒绝/诊断/链证据/lint，明确**无新增 stopCode**）；
  `docs/APP_SCRIPT_AUTHORING.md` 多 frame 速查补 `plan check --probe` 对 `frame:` 的身份形状
  支持边界与 `amber start --target` 结构化拒绝，stopCode 表 `frame_not_allowed` 行补链证据。
- **【验证】** 离线断言 184 条全绿（findByHint 链过滤 18 / start-target 拒绝 12 / describe 全矩阵
  + parseHint 差分 102 / probe 链证据 + reason 文案 31 / hint-lint 21），
  `npm run typecheck`、`npm run prompt-hit` 通过。浏览器级：`plan check --probe` 正确链命中 +
  错链诊断、`amber start` 拒绝、被排除帧的 `frame_not_allowed` 链证据与零动作、会话 act 错 origin
  reason 带可用 origin。

### D 批（文档与契约收尾）

- **【规格】** `docs/FRAME_SCOPE_HINT_PLAN.md` 标题/状态改为「v1.2 · 已实施」，新增 **§13 实施记录**：
  A=`bc400ca` / B=`3ce26fa` / C=`5c25ef5` / D=本批；每批实际改动面、实施中额外修复的缺陷
  （会话 `_frameHosts` 门禁补漏、F64 hosts 补漏、poolView 映射修复、`findByHint` 旧匹配器边界）、
  「未做/延后」清单与验证证据；§3.2/§4/§5/§7/§8/§9 的 v1 旧口径按 D2 与已实施状态回写。
- **【作者文档】** `docs/APP_SCRIPT_AUTHORING.md`：hint 语法主段补 `within:#id` / `frame:<origin链>`
  两种尾缀（≤4 段、每段规范 origin、未知 origin 不可寻址、串尾预扫+整组回退）；learn/inspect 候选
  口径补尾缀；多 frame 速查明确 `plan check --probe` 只覆盖 `findByHint` 旧形状集（身份形状 +
  `induceHint` 产物，非 `hintMatch` 全语义）；stopCode 表 `target_not_found` 补 frame 拒绝证据、
  `frame_not_allowed` 核对；§11 增加 `frame:` 已知边界。
- **【Agent 接口】** `docs/AGENT_INTERFACE.md` 新增 **§3.2 观察面元素投影合同**（ElementView 字段/
  上限：`hint_candidates` ≤6×≤200、`frame_origin`/`frame_path`、`structure_path` ≤160 仅诊断、
  `includeStructure`、行数 cap 60/200、`ambiguity` 候选字段与 `suggested_hint` ≤200/`frame_origin`
  ≤120（桥 ≤60））；inspect/observe 的元素行字段与差异同处对齐。
- **【会话文档】** `docs/INTERACTIVE_SESSION.md` 核对无 ≤80 旧口径；ambiguity 候选行补
  `frame_origin` 引擎 ≤120 / 桥 clip ≤60 的上限口径。
- **【CLI 帮助】** `src/cli/registry.ts` 的 `inspect`/`session` flow 与 `plan --probe` 旗标补
  `frame:<origin>` 提示（只改帮助字符串，无行为变更）。
- **【契约文字】** `schema-gen.ts` 的 `HINT_GRAMMAR.within_suffix` 补「可与 `frame:` 组合（两种顺序、
  取交集）」；F70 的 `findByHint` 表述改为如实的身份形状/`induceHint` 边界；骨架 cheat sheet 的
  hint 行补尾缀。`dist/schema/ctx.json` 重生成（gitignored），`npm run schema:check` 绿。
- **【验证】** `npm run typecheck` / `npm run prompt-hit` / `npm run schema:check`；D 批只改文档与
  契约文本，**无运行时代码行为改动**。

### 实施复审修复（2026-11-15，架构复审 CONDITIONAL APPROVE 的条件项 B-1）

- **【修复·findByHint 组合后缀假阴性】** `splitFrameSuffix` 只认**字面串尾**的 `frame:`——
  `#id frame:o within:#p` / `#id within:#p frame:o`（两种顺序的合法组合）会把尾缀留在 base
  里而假阴性，`plan check --probe` 错报"机制性必挡项 ✗"。修法：串尾剥离收口为 `hint.ts`
  导出的 **`splitTailSuffixes` 唯一出处**（parseHint 与 findByHint 共用，复审 N6 同步解决），
  两种顺序的身份形状 / induceHint 产物均正确命中；无后缀路径逐字节不变。
- **【记账】** 复审 N1（HINT_HEAD nearToken 维持整串——防无上下文误命中的既定纪律，规格
  该句过承诺已回收）、N7（`matchedChains` 截断无标记）、hintMemory/induceHint 不带 `frame:`
  等边界，已入规格 §13.3/§13.4 与 `docs/BACKLOG.md`「frame:<origin> 后续立项」。

### E1 批（within 权威对等）

- **【背景·F-1 因果链】** hintLookup 的 DOM pass **已执行 within**（HINT_HEAD
  `getElementById + contains`），回捞行 within 洁净；但回捞行并入主池后 executor 重新
  `hintMatch`，池侧 `inAnchor`（rules.ts）按**缺失的 anchor_ids** 把回捞行**二次清零** →
  落到 FW8 `identityLookup`（彼时无视 within）在任意帧动作锚外 `#x`。本批给回捞/合成行补
  anchors 并让消费面遵守 within，闭合此链。规格：`docs/WITHIN_PARITY_PLAN.md` §3 + §12
  （M1–M6 已吸收；本批只做**单层** within 语义，链化留给 E2）。
- **【单一出处】** 新增 `pool-js.ANCHOR_JS`——`anchorIdsOf`（parentElement 上溯、内→外、
  ≤8、小写、自身不入）的唯一 JS 实现，先例 LABEL_HELPERS_JS 的 `${}` 内插。收敛五处：
  EXTRACT_JS / OBSERVE_JS 两份本地副本（EXTRACT pass 串**字节不变**；OBSERVE 本地副本原用词
  `ids` 统一为 `out`——纯变量名差异，行为不变）、HINT_HEAD（回捞行补 anchor_ids）、
  heuristic 宽扫（M3 第五池）、A3 `_domFallbackResolve` / F64 `_liveDomIdFallback` 的
  inline TS arrow evaluate **转 `compile()` PASS 常量再内插**（闭包不跨——Playwright 序列化
  函数源码；identity PASS_IDENTITY 先例）。PASS_HINT_PROBE 的 `data-hintref` 字面耦合保活
  （replace 前后断言）。
- **【五池 anchors】** hintLookup 回捞行 / A3 合成主帧行 / FW8 IDENTITY_PROBE 行 /
  DRF ATTR+TEXT 收集行（`RawRow.anchors` → `rowToElem` 透传）/ heuristic 伪按钮行全部补
  `anchor_ids`（与真池行同构；无 id 祖先 = 字段省略的既有口径）。
- **【消费面遵守 within（单层）】** ① **FW8**：`identityHintInfo` 暴露 `within`；
  `identityLookup` 在候选收集处（"恰好一个可见匹配"判定之前，M5）按 `anchors.includes(within)`
  过滤——两调用点（命令步/act hint）零额外判定自动继承；② **DRF-text**：收集后按
  `row.anchors` 显式过滤；**DRF-attr 零额外代码**（F-2：rowToElem 透传后经
  `hintCandidates→hintMatch.inAnchor` 自动获得语义）；③ **F64**：一次 evaluate 返回
  anchors + TS 判定，`within` 存在时命中后校验 `anchors.includes(within)`，不在锚内 =
  该帧不命中（「找到但在锚外」vs「找不到」在 evaluate 结果里可区分），清探针章后尝试下一帧；
  ④ **A3**：合成行带 anchors 后 `resolveCommandRef → hintMatch.inAnchor` 同语义。
- **【行为变更（有意修正）】** ① 含 within 的回捞命中行为变更 = 本批本意：hintLookup 回捞行
  不再被池侧 `inAnchor` 二次清零（F-1 闭合）；FW8/DRF-text/F64/A3 不再动作（或落空于）
  within 锚外元素——`#x within:#p` 在五个回捞/合成面与主匹配面同语义。② FW8/DRF 歧义证据
  口径变化（M2）：过滤后 `total_matches` / `hidden_matches` / `candidates` 变**锚内**口径
  （此前锚外候选也计入）。
- **【模型面（M2 记账）】** 回捞/合成行 additive 增 `anchor_ids`（与真池行同构——真池行的
  `anchor_ids` 本就在模型投影面）；在线 provider 的 ChoiceRequest 请求体在**回捞行出现时**
  随之多该字段。`esig` / `firstIfSame` / `askSig` / `structDigest` / laya 缓存键（= state
  {goal,url,title,main_text}+criteria 文本指纹）**均不读 anchor_ids**——离线断言钉死。
  无 within 路径：FW8/DRF/F64 输出与改前一致（回捞行多 anchors 字段 = additive，trace/池
  快照允许清单内）；EXTRACT_JS pass 串字节不变。
- **【证据文案（N-R2a 更新）】** `frameHintFailureEvidence` 的 within 注记改为如实状态：
  同帧 within 已在回捞面生效（E1）；**跨帧 within（锚在另一文档）不受支持**——anchor_ids
  是帧内文档祖先链（§13.4 文档边界维持）；heuristic 伪按钮行现已带 anchors。declared 分支
  触发条件与结构不变。
- **【验证】** 离线断言全绿（/tmp/af-e1）：ANCHOR_JS 收敛（EXTRACT 字节不变 + OBSERVE 仅
  ids→out + PASS_HINT_PROBE 字面保活）、五池 anchors 与手算 anchorIdsOf 一致（含无 id 祖先
  字段省略）、within 回捞矩阵（FW8 锚内命中/锚外拒绝/锚内口径歧义、DRF attr 自动/text 显式、
  F64 锚内命中/锚外拒绝、hintLookup 回捞行并入主池后 hintMatch 不再清零 = F-1 闭合断言）、
  无 within 逐字节（FW8/DRF 与 56456fa 旧实现对照）、esig/firstIfSame/structDigest 不含
  anchor_ids 断言；`npm run typecheck` / `npm run prompt-hit` 通过。浏览器级（同帧 within
  回捞真页动作落点）留待专项。

### E2 批（within 语义链）

- **【语法（§4.1 + M1④）】** `within:` 尾缀值从单层 `#id` 升级为 **#id 链**：`>` 分隔、
  **外→内**、≤4 段、每段 `#id` 形态（**首段必须 `#`、后续段可选 `#`**——方案 §4.3/M6⑤ 的链写法
  `within:#a2>#a1` 每段带 `#`，词法 charset 同批加 `#`；段校验保证旧单层/值内伪尾缀行为
  不变）。**单层 `within:#p` = 长度 1 链（逐字节兼容）**；多 within / 空段（`within:#a>`）/
  超 4 段 / 非法段 ⇒ 解析期**整组回退**（绝不半剥，沿用 R2-5 循环语义）。
  `ParsedHint.within` 归一 **string[]（外→内）**，消费面全部同批迁移：splitTailSuffixes /
  parseHint / identityHintInfo / frameHintFailureEvidence / F64 / DRF-text。
- **【语义（§4.2 + M6①②③，唯一出处）】** 新增 `rules.anchorChainMatch(anchorIds, chain)`——
  **嵌套序包含**：每段都在 `anchor_ids`（presence 前置显式化：任一段 indexOf === -1 即不匹配）
  且嵌套序正确（anchor_ids 内→外存储 ⇒ `indexOf(aₙ) < … < indexOf(a₁)`）；**n=1 = membership
  逐字节不变**。写文档边界（M6）：重复 id `within:#x>#x` 池侧不匹配（id 投影无实例身份，序关系
  不成立）；DOM 侧 getElementById 文档序首个且同元素退化（a === b）不命中（N2 起链校验要求两段锚为不同元素且严格包含）；`anchor_ids` ≤8 截断下长链
  落空（显式失败）；间隙容忍（中间有无 id 祖先不影响）。两套对齐规则的文档义务（M6④）：
  `frame:` = 后缀对齐（frame_path 稠密可分同源父子）；`within:` = 嵌套序包含（anchor_ids
  稀疏 ≤8、仅带 id 祖先——后缀对齐会毁单层兼容）。
- **【消费面（M1①②③）】** ① 池侧 `inAnchor` 链化——emit 三档/attrSubstr 三档/tag-submit/
  bare 梯级全部消费点经同一个入口自动继承；② DOM 侧 HINT_HEAD 链化——逐段 `getElementById`
  + 嵌套 contains 校验（声明链 a₁ contains a₂ contains … 元素；任一段 null/不含 = 该帧 0 行，
  下一帧继续找），PASS_HINT_PROBE 的 `data-hintref` 字面耦合保活（replace 前后断言）；
  ③ FW8 `identityLookup` / F64 `_liveDomIdFallback` / DRF-text 收集后过滤改
  `anchorChainMatch`；**DRF-attr 经 hintCandidates→inAnchor 自动继承（F-2 零额外代码保持）**。
- **【候选生成（M6⑤）】** `suggestHints` within 候选链形：先单层 `label within:#a1`
  （最近祖先 = anchor_ids[0]，首候选与 E3 逐字节一致）；push 失败（不自证唯一）且
  anchor_ids ≥2 时**从最近祖先向外生长** `within:#a2>#a1` → `within:#a3>#a2>#a1`…（≤4 段、
  每步走同一 push→hintMatch 自证）；顺序仍 身份→label→frame→within、上限 4 不变
  （R-10：链候选不挤掉 frame 候选——顺序不变 + 离线断言钉死）。
- **【诊断（§4.4）】** `describeFrameSuffixRejection` 的 within 侧值校验同步链形
  （空段/超限/非法段点名——`withinChainValueProblem` 与解析共用同一判定，只在 frame 参与
  时报告的既有口径不变）；`frameHintFailureEvidence` 的 within 注记按链形渲染
  （单层 `join(">")` = 单 id，旧文案逐字节不变）。
- **【契约（M1⑤）】** `grammar-prompt.HINT_WITHIN_SUFFIX` 链形文案 + 自证改写：多 within 拒、
  单串链受（`#a>#b` 与 `#a>b` 同归一）、空段/超 4 段拒；`schema-gen` 的
  `HINT_GRAMMAR.within_suffix` / F69 如实更新（F70 truth 补 E2 文件）；
  gitignored `dist/schema/ctx.json` 重生成；`npm run prompt-hit` 八组全绿。
- **【验证】** 离线断言全绿（/tmp/af-e2）：parse 矩阵（单层等价、链两序、`within:#a>` /
  超 4 段 / 双 within / 值内伪尾缀整组回退、大写 WITHIN）、链语义矩阵（全序命中、缺段/序错/
  重复 id 不匹配、间隙容忍、>8 截断长链落空）、五消费面 fake-DOM 真跑矩阵（池/DOM 回捞/FW8/
  F64/DRF attr+text）、候选单层→链生长序列 + R-10、诊断链形矩阵、契约自证；E1 回归复跑
  （within 形状同步后）全绿；`npm run typecheck` / `npm run prompt-hit` 通过。
  浏览器级（真页链锚命中/落点、frame+within 链组合、observe 链候选照抄）留待专项。

### E3 批（findByHint within）

- **【必修点（base 口径）】** `findByHint`（`src/cli/start.ts`）旧实现
  `const base = frameChain === undefined ? hint : s.base` 在「**无 frame 后缀但有 within**」时
  base 保留整串（含 within 尾缀）→ attr 正则与 `induceHint` 精确串匹配全落空。改为
  **任一后缀存在即用 `s.base`**；无后缀（within/frameChain 都 undefined）= base 就是
  **原串 hint 逐字节**——`s.base` 是 trim 后形状，`induceHint` 精确串比较依赖原样大小写/空白
  （离线断言钉死：原样大小写 near 产物命中、带空白原串不命中）。
- **【within 作用域过滤（§5）】** 帧链过滤后（无帧链时直接）按真池行 `anchor_ids` 过滤——
  `rules.anchorChainMatch(el.anchor_ids ?? [], s.within)`（单层 membership/链嵌套序包含同一
  语义，与 E1 权威面唯一出处共用）；帧链过滤与锚过滤合并为一次 `Object.entries` 过滤
  （正确性优先）；全滤掉/空池 = 显式 null。无锚行（`anchor_ids` 缺省/空）对任何 within
  fail-closed。`frame:`+`within:` 组合成为**全语义**（两面同时生效，此前 probe 面只做帧过滤）；
  `plan check --probe` 因此可校验 within 作用域。
- **【回退口径】** 非法 within 值 = `splitTailSuffixes` 整组回退（无 within/frameChain 字段）
  ⇒ 走原串 = 尾缀留在 base 里 = 既有旧形状集显式落空（与 frame 批 C 同口径）；
  值内伪后缀仍按 R2-5（真尾缀剥离、伪尾缀留 base → 落空）。
- **【消费面不变】** `frameTargetRejection` 不变（`parseHint` 的 frameChain 判定——within 不触发
  帧限定拒绝）；`plan-cli.ts` probePlan 的未命中证据 helper 不变（within 归因文案已在 E1 更新）；
  `selectorForHint` 不变。
- **【文档/记账】** BACKLOG「后续立项」#2 收口（E2 标注的"剩余=待 E3"闭合）；
  WITHIN_PARITY_PLAN §5 标注已实施；APP_SCRIPT_AUTHORING 多 frame 速查/已知边界两处更新
  （within 作用域已校验 单层+链）；schema-gen F70 statement findByHint 表述同步全语义 +
  truth 补 start.ts（E3 项）。
- **【验证】** 离线断言全绿（/tmp/af-e3，97 断言）：必修点旧新对照（`git show ca74fc0` 旧实现
  机械转换对照——9 条 within 修复行旧=显式 null/新=命中）、无后缀逐字节回归（19 行 old==new，
  含原样大小写/空白/attr 折叠边界）、单层/链矩阵（错序/缺段/词法边界/锚自身/无锚行）、
  组合矩阵（frame+within 两序严格等价、帧决定双胞胎、未知 origin）、整组回退、E1 权威面
  parity（hintMatch 与 findByHint 同 ref）、anchorChainMatch 直证、frameTargetRejection 不变；
  E1（33）/E2（34）套件回归复跑全绿；`npm run typecheck` / `npm run prompt-hit` 通过。
  浏览器级（真页 `plan check --probe` 的 within/链 within/组合命中与未命中+诊断）留待专项。

### E4 批（读侧帧限定）

- **【新语法（读/判面）】** 读/判面的 CSS 选择器可尾缀 ` frame:<origin链>`：`ctx.read.{text,value,count,attr}`、
  `ctx.extract`/`ctx.collect` 的 **rows 行选择器**、done/when/judge 的 css_* 算子（css_exists /
  css_exists_text / css_visible_exists / css_text_contains / css_text_equals / css_value_equals /
  css_count_equals / css_count_min）。校验与 hint 尾缀同一 `frameChainValueProblem`（`>` 分隔外→内、
  ≤4 段、http(s) 规范 origin）。**为什么对 CSS 零风险**：选择器尾的 `frame:<origin>` 对纯 CSS 在 E4 前必然是非法
  （伪类语法永不成立）——尾缀**只能激活原本就保证失败的纯 CSS 串**，既有选择器零影响；无尾缀路径逐字节不变。
  **非 CSS 引擎（Playwright `text=` 等）不保证**：裸 `text=hello frame:o` 仍会被当尾缀剥离（文档注明），
  作者需把文本显式引用；E7/N4 的引号/括号平衡守卫会拒绝引号内的尾缀（`div:has-text("x frame:o")` 整串原样）。
- **【值不合法 = 原样 CSS（显式落空）】** 值非法/缺主体/双尾缀 ⇒ 整串按原 CSS 处理，绝不半剥——
  防选择器属性值以 ` frame:` 结尾的伪尾缀误伤（属性值捕获必带 CSS 收尾字符、过不了 origin 校验）。
  与 hint 的 splitTailSuffixes 同一整组回退口径；`within:` 不是读侧语法（带它按原 CSS 显式落空）。
- **【底座单一收口（M4④）】** `extraction.ts` 新增 `splitFrameSuffixFromSelector`（唯一剥离出处，
  尾预扫、值合法才剥）+ `locatorAnyFrame`/`countAnyFrame` 帧循环按 `frameScopeMatchesFrame` 过滤
  （信封同口径：主帧恒允许、子帧按 hosts；声明帧一个都没扫到 = 结构化 miss，不回捞替身）；
  **test-double fallback 在 split 之后**（替身拿到剥离后 base，无尾缀 = 原串逐字节）。
  `frameScopeEvidenceOf` 导出帧级扫描证据（与帧循环同一谓词/帧序）。
- **【signals 覆盖】** live css_* 全部经 locatorAnyFrame/countAnyFrame **自动继承**（signals.ts 零改动；
  核对无直用 page.locator 的信号路径）。out of scope：离线池近似 `evalSignalOnState`/`matchSelector`
  （StateView 无帧字段；带尾缀选择器对池 PART 正则不可表达 → 返回 null = 待 live 验证，诱导面不猜）。
- **【逐面失败语义钉死（M4②）】** `ctx.read`/`ctx.extract` **不抛** frame_not_allowed（保 op 面）：
  声明帧不在信封/不存在 → 返回 null/0/[] + trace 事件 additive 证据
  `frame_evidence`={declared,excluded,scanned}（excluded 非空=声明帧被信封排除；scanned 空=帧不存在/
  链写错；scanned 非空=帧已扫、选择器本身零命中）。done/when 走既有 F45② 升级；会话面经同一 ctx
  实现（零合同变化，只回 null/miss）。
- **【F45② done/when 探针 suffix-aware（M4③）】** done/when 的 css_* 带合法 ` frame:` 尾缀时，
  allowed 视图上声明帧（指向被排除帧的链）恒零命中 → excluded 视图只读探测（帧循环链匹配被排除帧、
  该面无 hosts 无信封跳过）→ 命中即 doneInExcluded → 收尾升级 `frame_not_allowed`——此前该写法是
  非法 CSS、双面都 false，升级永不触发、退化为纯 done_not_held。声明链指向允许帧 = 正常完成面；
  非法尾缀 = 整串原 CSS（双面 false → 普通 done_not_held，不升级）。
- **【arrive/manual 的 done 求值对齐（新发现缺口的封口）】** `ctx.arrive` / `ctx.manual` 的 done
  求值此前不传 hosts（既有无尾缀口径=信封不设防，逐字节保留）——仅当 done 信号树带**合法**帧尾缀
  时按信封求值（`signals.signalHasFrameSuffix`；声明帧不在信封 = miss）。不加这个条件，尾缀会让一个
  E4 前必然失败的串在这两个无信封面上命中被排除帧（读面越权）。`plan check --probe` 的信号探测
  （plan-cli，无 hosts 的既有探测面）维持原样——探测非完成真值，既有口径不变。
- **【尾缀被拒诊断（M4①）】** 选择器串含 ` frame:` 形状但值非法、且原样 CSS 解析失败时点名
  「尾缀被拒+原因」（B8 同款，只在失败路径附注）：读面 trace 附 `frame_suffix_rejected`；
  抽取预检（checkExtractSelectors）的 config_error reason 附注拒因（预检本体先剥合法尾缀再验
  base 形状）。成功路径/无尾缀零改动。
- **【抽取面口径】** 行选择器带合法尾缀时与 ctx.read 同信封口径（hosts 传入，被排除帧不读）；
  **无尾缀抽取维持既有信封不设防口径**（对称化只经尾缀激活，既有 op 面零行为变更——
  无尾缀 locatorAnyFrame 调用的 opts/帧序/回捞全部原样）。字段选择器是行内相对寻址、不支持尾缀
  （带 ` frame:` 形状的字段选择器按原 CSS 预检 → 非法即 config_error）；collect 的内部滚动
  （scrollRowsContainer）只滚声明帧——**E7/B1 修复**：滚动 evaluate 实参此前误传原串（带尾缀 =
  非法 CSS），每帧 catch continue ⇒ 恒 `not_scrollable` 且 scrollTop 不动；现在传剥离后 base。`checkExtractSelectors` 对合法尾缀行选择器先剥后验。
- **【契约】** schema-gen F71 条目 + css_exists/css_count_* 语义注记与 HINT_GRAMMAR note 补尾缀；
  dist/schema/ctx.json 快照已重生成（schema:check 绿）；APP_SCRIPT_AUTHORING §5「读侧帧限定」+
  多 frame 速查 + §10 stopCode 表 + §11 已知边界更新；AGENT_INTERFACE 会话读侧帧限定节新增；
  BACKLOG「后续立项」#4 收口；WITHIN_PARITY_PLAN §6 实施注记。
- **【验证】** 离线断言全绿（/tmp/af-e4，54 组）：split 矩阵（合法单段/链/大写、非法 path/默认端口/
  伪尾缀属性值/双尾缀/缺主体、无尾缀逐字节恒等）、locatorAnyFrame/countAnyFrame 帧过滤矩阵
  （声明帧命中且只扫声明帧、信封外跳过、帧不存在 miss、无尾缀跨帧 OR 原样）、signals css_*
  经底座等价性（无尾缀全帧口径不变；带尾缀新语义）、F45② suffix-aware（frameGateOf 双视图 +
  runReportTail 升级触发断言）、ctx.read 不抛口径（null/0 + trace 证据）、尾缀被拒诊断、
  test-double fallback 排序、signalHasFrameSuffix + arrive 尾缀条件信封（含无尾缀逐字节对照）；
  E1（33）/E2（34）/E3（97）套件回归复跑全绿；
  `npm run typecheck` / `npm run prompt-hit` 通过。浏览器级留待 lead 专项
  （真页 read/extract 带 ` frame:` 取子帧文本、信封外 null、done 信号 frame 尾缀升级）。

### E5 批（induceHint 帧限定）

- **【背景/规格】** `docs/WITHIN_PARITY_PLAN.md` §7（+ §12.4「E5 不依赖 E2」）。旧 `induceHint`
  只产 `[attr=v]` / `tag[near~token]`——记忆 hint 只在同一 `(url, subgoal)` 生效，但同 url 下
  同签名父子/兄弟帧回放会歧义 → 回退模型（无误动作，记忆价值打折）。
- **【产物】`src/model/hint-memory.ts`**：`induceHint` 在稳定句柄后追加帧限定尾缀——
  `frame_path` 非空（= 非主帧）且 `frame_origin` 非空时产 `<hint> frame:<own origin>`（单段；
  与 `frame:` 语法同形）；主帧（`frame_path` 省略/空数组）**逐字节不变**；未知 origin 帧
  （`frame_origin`/`frame_path` 两字段皆缺，如 about:blank/srcdoc）**不追加**——任何 `frame:`
  都命中不了那种帧，加了只会得到一条死 hint，保持既有"歧义/未命中→回模型"行为。
- **【回放链路（零新增代码，核对项）】** `currentHint`（`executor.ts`）→ `hintMatch` →
  `parseHint`：尾缀在解析层被 `splitTailSuffixes` 剥离、`frameChain` 进 `hintMatchImpl` 入口
  entries 过滤——子帧记忆精确落帧，同签名跨帧不再歧义（D2：**同 origin 父子帧仍可能歧义**，
  own origin 单段区分不了同源父子；跨帧同签名不合并仍是独立立项）。`hintMemory.record/
  lookup`、落盘 sidecar 重载同链路可用；`hint-lint` 的三类形状判定只读 `parseHint` 的 base，
  合法尾缀不产生 `rejected`/`host` 提醒（三类 finding 种类/条数与无尾缀一致）。
- **【amber start 护栏（E5 产物进入主帧点击面的必要适配）】** 该 CLI 的演示点击是主帧
  `page.click(...)`：`extractElements` 会扫子帧，`induceHint` 产出的帧限定串此前会以非法 CSS
  点击失败。现在对**生成后的 hint** 复用 `frameTargetRejection`（与 `--target` 同一条结构化拒绝，
  exit 沿用 2，指路 app/run 或 plan 面）；主帧产物 rejection = null，行为逐字节不变。
- **【文档/契约】** `docs/APP_SCRIPT_AUTHORING.md` 学习环补「记忆产物的帧限定（E5）」段
  （子帧带尾缀、主帧不变、未知 origin 不加、D2 边界）；BACKLOG「后续立项」#5 收口；
  `schema-gen` F70 statement 末尾补 E5 批（induceHint 子帧尾缀）+ truth 补
  `src/model/hint-memory.ts` / `src/cli/start.ts`；`HINT_GRAMMAR.frame_suffix` 注记同步；
  schema 快照重生成。
- **【验证】** 离线断言全绿（/tmp/af-e56，E5 组 89 条）：主帧元素新旧实现逐字节矩阵
  （旧实现 = `git show fb86b7c` 提取的 `HANDLE_ATTRS+induceHint`，data-test/id/name/near/
  无句柄/长 label/volatile/主帧两字段形状/null/undefined）；子帧产物 = 旧产物 + ` frame:<origin>`
  且 `splitTailSuffixes`/`parseHint` 自证 base/kind/frameChain；未知 origin/部分缺失/主帧空 path
  不追加；池内 `hintMatch` 自证（同签名三帧中精确命中 f1/f2/n2、候选集 1 vs 未限定 3）；
  `record→lookup→currentHint→hintMatch→parseHint` 回放与 sidecar 落盘重载；hint-lint
  三类 finding 不误报 + 合法 origin 零 frame 提醒 + 大写 origin 合法；`amber start` 子帧产物
  结构化拒绝 / 主帧放行。

### E6 批（小项收尾）

- **【matchedChains 截断标记（BACKLOG #7 / 方案编号 #12）】** `extraction.probeExcludedHint`
  此前"去重"与"截断到 ≤4"共用一个条件（`!seen && length<4`）——>4 条时证据里连总数都看不到。
  改为**全量 distinct 链计数**（`seenChains` 恒累加）+ 列表仍列前 4 条；`ExcludedHintProbe`
  additive 增 `matched_chains_total`（恒有，去重口径）与 `matched_chains_truncated?: true`
  （仅 `total > listed` 时出现，≤4 条时字段省略）。`executor-pure.frameTargetStopReason`
  仅在截断时于 `hit chain(s):` 段末补 ` (共 N 条 distinct 链，还有 M 条未列出)`；**≤4 条 /
  空链证据时 reason 逐字节不变**（离线用 `git show fb86b7c` 的旧函数对照）。
- **【整串 `frame:` 诊断（BACKLOG #8 / 方案编号 #13）】** `hint.describeFrameSuffixRejection`
  对**首词即 `frame:`、无 hint 主体**的形状（`frame:https://a.com`、前导空白后同形、大写
  `FRAME:...`、带 within 的同类串）补「尾缀前没有 hint 主体（必须写成 `<hint> frame:<origin>`）」
  诊断（复用同一条失败修饰文案，只走失败路径附注）；带**未闭合 `[` 守卫**——`[data-x=frame:o]`
  一类值内伪后缀不误报（与循环内同一条 `hasUnclosedBracket`）。`parseHint` 的解析结果不变
  （整串仍按旧形状=裸词落空）；**带主体时新旧逐字节相同**（22 条矩阵）。
- **【文档（BACKLOG #9）】** `docs/APP_SCRIPT_AUTHORING.md` 尾缀段补「大小写与整串形状」：
  hint 先整串 lowercase（`i` 语义）——`FRAME:HTTPS://A.COM` 与 `frame:https://a.com` 等价、
  被识别为合法尾缀；`findByHint`（`plan check --probe`）的属性词正则大小写敏感——
  `[DATA-TEST=x]` 不命中、`[data-test=x]` 才命中（新旧一致、既有边界；act hint 侧先折叠不受影响）；
  整串无主体的显式失败与修法。BACKLOG #5/#7/#8/#9 状态更新（#7/#8 标注方案编号 #12/#13）。
- **【契约】** `schema-gen` F70 statement 补 E6（整串 `frame:` 缺主体诊断 + `[data-x=frame:o]`
  不误报）+ truth 补 E6 文件；F45 statement/truth 补 `matched_chains_total/truncated`（列表仍
  ≤4、reason 截断带总数）；`HINT_GRAMMAR.frame_suffix` 同批注记；schema 快照重生成
  （`npm run schema:check` 绿）。
- **【验证】** 离线断言全绿（/tmp/af-e56，E6 组 61 条）：6 条 distinct 链 → total=6、列表 4、
  truncated=true、reason 除截断附注外与旧文案逐字节相同；1/3/4 链 → total 真实、无 truncated、
  reason 逐字节旧；同链两帧 distinct 去重 total=1；未知 origin（detached）opaque 键去重；
  声明链只评估匹配帧；无被排除帧 → null；空 matchedChains 的 reason 逐字节旧；整串
  `frame:` 诊断矩阵（`frame:o` / 前导空白 / 大写 / 链形 / 带 within）+ 属性值伪后缀/未闭合 `[`
  不误报；带主体 22 条新旧逐字节；`parseHint` 解析不变、大写 origin 合法、`[DATA-TEST=x]`
  既有边界、子帧 induceHint 身份产物 findByHint 命中。

### E7 批（E 批实现复审修复：2 Blocking + 非阻断项）

- **【B1（中）ctx.collect 声明帧滚动失效】** `scrollRowsContainer` 已算 `scrollSplit`，但 evaluate
  实参仍是**原始 rowSelector**——带 ` frame:` 尾缀时每帧 `querySelectorAll` 非法 CSS → catch continue
  → 恒 `not_scrollable`、scrollTop 不动。改为传 `scrollSplit.selector`（无尾缀/被拒尾缀时与原串逐字节
  相同）。浏览器复跑：`li.row frame:<主帧 origin>` 前后从 `not_scrollable/scrollTop=0/rounds=1` 变为
  `stable/scrollTop=640/rounds=6/rows=20`，无尾缀对照不变。
- **【B2（中低）findByHint 无法解析子帧 nearToken 记忆产物】** E5 起 `induceHint` 子帧产物尾带
  ` frame:<own origin>`；`findByHint` 的 `induceHint(el) === base` 精确串比较在「有尾缀产物 vs 剥离后
  base」时恒不等 → null（E5 前可用 = 行为回归）。改为比较 `splitTailSuffixes(induceHint(el) ?? "").base`
  ——无尾缀产物 split 后 base 逐字节原串。浏览器复跑：子帧 near 产物 `button[near~…] frame:o` 从
  `null` 变为命中 `f1:e0`；无 frame 字段元素命中不变。
- **【N1（中）HINT_HEAD within 锚查找大小写】** DOM 侧 `getElementById(id)` 用 parseHint 归一后的
  小写值，`<div id="Wrap">` 查 `wrap` 恒 null（池侧 anchor_ids 已小写）→ 池/DOM 判定分裂。改为
  pass 内**懒建一次**小写 id → 文档序首元素映射（memoized；口径与 `getElementById` 一致：重复 id 取
  文档序首个），每行复用。离线 fake DOM + 真页（`browser-case.mjs`：#Wrap/#Inner 大小写混写）复跑：
  DOM 回捞与池侧同时命中，`#Inner>#Wrap` 错序仍 fail-closed。
- **【N2（低）`within:#x>#x` DOM 侧非 fail-closed】** `contains(self) === true` 使同元素退化命中。
  DOM 侧链校验改为**两段锚必须是不同元素且严格包含**（`a !== b && a.contains(b)`）；契约同步
  （F69 / `HINT_GRAMMAR.within_suffix` / 文档 / E2 断言）：**池侧不匹配、DOM 侧同元素退化也不命中**。
  复跑 `within-parity-edges` / `probe-dup3`：`#target within:#a0>#a0` 与 `#bx within:#x>#x` 的 DOM/PROBE
  行从 1 → 0（`#x>#y` 这类真实嵌套仍命中）。
- **【N4（低）读侧尾缀对非 CSS 选择器误剥】** `new URL()` 接受 `)`/`'`/`"` 作为 host 字符，
  `div:has-text("x frame:https://a.com")` 的尾缀落在引号内仍被剥（base 变成 `div:has-text("x`）。
  `splitFrameSuffixFromSelector` 剥离后加**引号/括号平衡守卫**（`"`/`'`/`(`/`)`/`[`/`]` 不配对 ⇒
  整串原样 + rejected「选择器含未闭合引号/括号，尾缀未应用」；字符串内对比字符不参与、反斜杠转义
  跳过）。F71/CHANGELOG 的「E4 前必然非法 CSS」措辞改为「纯 CSS 必失败；非 CSS 引擎（text= 等）作者需
  显式引用 / 本守卫拒绝」。复跑 `browser-pseudotail`：`div:has-text("x frame:o")` 从误剥 → 整串原样 + 拒因；
  `[title="x frame:o"]` 等值内伪尾缀仍原样拒绝；纯 CSS 合法尾缀不受影响。
- **【N5（低）读侧 `frame:` 空值不诊断】** `SELECTOR_FRAME_TAIL_RE` 值部 `(\S+)` → `(\S*)`，空值
  走 rejected（selector 原样）——`selectorFrameChainProblemText` 的 `case "empty"` 变可达。复跑
  `browser-read-invalid`：`#bg4 frame:` 的读面事件从无 `frame_suffix_rejected` → 带拒因（null 不变）。
- **【N6（低）suggestHints 非法段 break 丢失外层合法祖先单层候选】** E2 生长链在首个非法段停下
  （正确：更深链必含它），但非法段**之后**的外层合法祖先单层候选被一并吞掉（E3 旧行为会跳过非法段
  继续逐个试）。补回「链候选未命中时，对其后每个合法祖先 id 单独试单层 `within:#id`」——push 仍
  自证唯一、顺序（身份→label→frame→within）与上限 4 不变，首次成功即停。复跑 `suggest-invalid`：
  `["Close within:#good"]` 与旧实现逐字节一致，正常生长序 `#a3>#a2>#a1` 不变。
- **【N7（低）E4 尾缀激活的信封面两条未封口】** `ctx.step newTab` 的采用标签 done（ctx.ts:311）与
  新开标签 done（:421）、`ctx.done` 的 invariants 求值（:1759）此前不传 hosts。现在与 arrive 同口径：
  **仅 `signalHasFrameSuffix(...)` 时传 `{hosts}`**；无尾缀逐字节不变（新 helper `signalHosts`）。
- **【N8（低）契约/文档漂移】** ① F64 statement 补 E1/E2 的 F64 within 消费（`anchorChainMatch`；
  truth 补 `executor.ts:2316-2322`）；② 本文件旧「read/extract/collect/judge 帧限定未做」边界改为已收口；
  ③ E4 的 collect 滚动描述与 B1 修复一致；④ F69 `#x>#x` 文案按 N2；⑤ F69「段首 # 可选」改
  「首段必须 #、后续段可选 #」；⑥ 会话 `rowsSettled` 的 `countAnyFrame` 不传 hosts 在 F71/文档注明为
  证据面边界（只影响 `scroll_settled` 提示，不影响抽取行）。
- **【验证】** `browser-collect`（B1）、`browser-findby-near`（B2）、`within-parity-edges`+`probe-dup3`
  （N1/N2）、`browser-pseudotail`（N4/N5）、`browser-read-invalid`（N5）、`suggest-invalid`（N6）复跑
  关键行见上；`browser-case` 真页大写 id（N1）。离线：E1 33 / E2 34（N2/N6 断言按新契约更新）/
  E3 97 / E4 54→56 组（补 2 组：collect 滚动 maxRounds≥2 含尾缀 + N4/N5 split 守卫）/ E5+E6 150→153
  （补 3 条：near 产物带尾缀 + 子帧 near 产物命中 + 无 frame 字段命中不变）全绿；`npm run typecheck` / `npm run prompt-hit` / `npm run schema:check`（快照重生成）通过。

### 已知边界 / 未做（A–D 批后的诚实清单）

- **`within` 语义链（E 批 E2）**：已收口（E2——链语法/嵌套序包含语义/池+DOM+FW8+F64+DRF
  消费面/候选生长/诊断/契约同批，见上方 E2 小节）。**单层** within 的回捞面权威对等已由
  E1 收口；**跨帧** within（锚在另一文档）维持文档边界。
- **跨帧同签名不合并**：未做（需独立立项 + 开关）。`esig`/`firstIfSame` 的签名不含 frame 字段，
  同 tag/label/href/data-test 的跨帧元素仍可能被 `firstIfSame` 合并；run 命令步 / act hint 直接
  执行一个，会话 act 因 `hintCandidates.decided` 不暴露该裁决而停。
- **同 origin 父子帧的记忆产物（E5/D2 边界）**：`induceHint` 只追加自身 origin 单段（记忆侧
  没有帧完整链）——同源父/子同签名元素的记忆回放仍可能歧义 → 回退模型（无误动作）；
  需要精确区分时用 authored `frame:<parent>><child>` 链或 `inspect`/`ctx.observe` 的候选。
- **`read`/`extract`/`collect`/`judge` 帧限定对称化**：**已收口（E4；E7 修复 B1 滚动与 N4/N5 拒因）**——
  读/判面 CSS 选择器支持 ` frame:<origin链>` 尾缀；ctx.read/extract/collect 按信封过滤（不抛，
  miss + `frame_evidence`），done/when 走 F45② 升级，collect 内部滚动只滚声明帧（evaluate 用剥离后
  base）。**证据面边界**：会话 `extract` 的 `rowsSettled` 滚动稳定计数走 `countAnyFrame` 未传 hosts
  ——带尾缀 rows 的 `scroll_settled` 可能含信封外帧（只影响该提示，抽取本体按信封过滤）。
- **>6 帧 / 每帧池配额**：未做。`framesOf ≤6`；池窗口 40/120 跨帧共享、主 frame 优先；
  `frame:` 落空时 reason 列允许帧 origin（去重 ≤6）。
- **`about:blank`/srcdoc**：本期不可寻址（未知 origin → 不可被任何 `frame:` 命中）；`frame:` 只做
  匹配，不是安全判定（门禁是 hosts）。
- **帧下标链 / nth-child / XPath / iframe 选择器锚**：不做（漂移 + 破坏 hint 封闭集）。
- **`plan check --probe` 的匹配边界**：`findByHint` 只支持 `#id` / `[data-test=|id=|name=]` /
  `induceHint` 产物；C 批只补 parseHint + 帧链过滤、E3 同面补 within 作用域（单层+链），
  **不是** `hintMatch` 六形状分档。`amber start
  --target` 对帧限定目标结构化拒绝（主帧 `page.click`）。
- **证据上限合同变更（已记账）**：`AMBIGUITY_HINT_MAX` 80→200、桥 `suggested_hint` 80→200、
  `HINT_MAX_CHARS` 160→200；新增 `FRAME_PATH_MAX_ITEMS=4` / `FRAME_PATH_SEGMENT_MAX_CHARS=64` /
  `STRUCTURE_PATH_MAX_CHARS=160`。引擎歧义 `frame_origin` ≤120，桥 clip ≤60。
- **`structure_path`**：仅诊断（inspect 恒开 / observe `includeStructure` opt-in），不进模型面、
  歧义证据或 hint 自证。
- **`within` 在回捞面**：E1 已收口**同帧** within（五池 anchors + 消费面遵守，E2 起链形
  同语义）；**跨帧** within（锚在另一文档，如宿主页的 iframe 元素）维持文档边界——anchor_ids
  是帧内文档祖先链。

## [Unreleased] — inspect --probe 跨 frame 探测（iframe 元素不再静默漏检）

- **【修复·inspect 探测面】** `inspect --probe` 此前只在**主 frame** `page.evaluate`，
  跨 iframe 元素恒 0 命中，被误读为"页面没有/不可自动化"（2026-11-14 实测：Google 应用菜单
  面板在跨源 iframe 里，探针 `a[aria-label="Maps"]` 报 0，但池内 `f1:e3` 可点）。现探测
  覆盖主 frame + 可达子 frame（`framesOf` ≤6）：主 frame 命中仍落 `count/texts`（**旧 JSON
  形状逐字节不变**），子 frame 命中落 `probes[].frames[]`（`frame` 下标 + `origin` + 命中数/文本，
  additive；仅在有子 frame 命中时出现）。
- **【advisory 增强】** `not_in_pool` / `pool_inexpressible` 的 `dom_hits` 改为全帧总命中并带
  `frame_hits` 证据；命中仅在子 frame 时明确提示「动作目标需该 frame origin 在 hosts 信封
  （app `meta.hosts` / 会话 hosts），否则解析面排除该帧（frames_excluded），池内以 `fN:`
  前缀 ref 出现」；`pool_only` 文案与全帧探测口径对齐。`frame_host` advisory 保留。
- **【文档】** `docs/APP_SCRIPT_AUTHORING.md` 增「多 frame 定位速查」：枚举帧（`frame_origins` /
  `probes[].frames` / observe `frames[]`+`frame` 下标）→ 定位元素（`f<fi>:eN`、跨帧 hint 唯一性、
  ambiguity frame 证据、F64 #id 直查）→ 跨源帧须进 hosts → 已知边界（≤6 帧、池窗口跨帧共享、
  下标漂移用 hint 不用 ref）；inspect 帮助文本同步。
- **【验证】** 双端口跨源 fixture：`a[aria-label="Maps"]` 主 frame 0 / 子 frame 1
  （http://127.0.0.1:8932）1 命中；`div[aria-label="Maps"]` 触发带 frame_hits 的 not_in_pool
  advisory；主 frame 命中与无命中路径形状不变；`npm run check` 全绿。

## [Unreleased] — not_scrollable 停因诊断增强（祖先 overflow 证据）

- **【优化·滚动停因】** `_scrollWithLoc`（run scroll 命令 / `ctx.scrollList` / 会话 act 容器滚动
  的同一条实现）在找不到标准滚动容器时，`reason` 不再只有一句泛化文案，而是带上祖先诊断：
  最近 ≤3 个非 `overflow:visible` 祖先的 `tag.class`/overflow 值/`scrollHeight/clientHeight`；
  若存在「内容溢出但 `overflow:hidden`」的程序化滚动候选，明确标注
  `(programmatically scrollable, not a standard scroller)` 并提示引擎只滚标准
  `overflow:auto/scroll/overlay` 容器（可改滚其内部目标或 `ctx.scrollList("document")`）。
  判据与 stopCode 语义**不变**（仍 `not_scrollable`、零行为变更），仅提升 Agent 自解释能力。
- **【背景】** 2026-11-14 实测：Google Maps「All filters」面板用 `overflow:hidden` +
  程序化 `scrollTop` 自定义滚动（面板内 `overflow:auto` 祖先 638/638 不溢出、全页标准
  滚动器 0 个）→ 旧文案无法区分三种成因，本条补足证据。
- **【文档/契约】** `docs/APP_SCRIPT_AUTHORING.md` 的 scrollList 注释与 schema-gen F56 同步补记。

## [Unreleased] — schema 契约文字同步：观察面 within 闭环（F41/F55/F69）

- **【schema·F41】** `ctx.observe` 的 `hint_candidates` 候选形状补记「同名组 within 候选」：
  文本候选不唯一但祖先链有 #id 时给 `<label> within:#<ancestor-id>`（同一 hintMatch 自证），
  同名元素组从「无候选 → admitted:false」变为「带 within 候选的 admitted:true」；truth 补
  `OBSERVE_JS anchorIdsOf` 采集 / `syntheticElem` 透传 / `why_not_admitted` within 指引。
- **【schema·F55】** 歧义证据的 `suggested_hint` 补记可为 `<label> within:#<ancestor-id>` 形态
  （同名组且元素有 anchor_ids 时由 suggestHints 生成，仍经同一 hintMatch 自证，可直接照抄）。
- **【schema·F69】** within 条目补记观察面闭环：OBSERVE_JS 同口径采集祖先 id 并经
  syntheticElem 透传；suggestHints 对同名组按最近祖先优先建议 within；inspect/observe 的
  hint_candidates 与歧义 evidence 的 suggested_hint 直接给出可照抄形态。
- **【验证】** `npm run check` 全绿（`dist/schema/ctx.json` 按提示重生成，gitignored）。

## [Unreleased] — 引擎观察面修复：aria-label 探测假阴性 + 同名组 within hint 候选

- **【修复·inspect 探测面】** `matchSelector` 的 `aria-label` 别名键映射到 `aria_label`
  （signals witness 池字段），而引擎元素池行（`Elem`）只有 `label`/`full_label` →
  字段恒空 → `not_in_pool` advisory 把可被 act 命中的元素误报“池内 0 命中”。
  改为别名键按池行底座回退 `aria_label ?? full_label ?? label`（显式空串不回退，
  带 `aria_label` 的 StateView 匹配逐字节不变）；其它属性键与
  class/组合器“不可表达”语义不变。
- **【修复·advisory 文案】** `inspect` 的 `not_in_pool` 文案改为准确表述（元素可能不在
  准入面或无交互角色/不可见；aria-label 是 label 别名、交互标签可命中），删除
  “aria-label/class 永不入池、act hint 永不命中”的误导；其它 advisory 分支不动。
- **【新增·同名组 within 候选闭环】** `suggestHints` 在文本候选不唯一且有 `anchor_ids`
  时按最近祖先优先追加 `<label> within:#<id>`（锚字符集与 `parseHint` 一致、仍走同一
  `hintMatch` 自证、4 条上限与身份形状顺序不变）；`why_not_admitted` 补 within 指引；
  `OBSERVE_JS` 采集祖先 id（≤8、小写、最近祖先在前；无 id 祖先时字段不出现，旧观察
  JSON 形状不变），`ObserveRawRow.anchor_ids` + `syntheticElem` 透传 →
  `ctx.observe` 的自证池可生成/验证 within 候选：同名元素组从 `admitted:false` 变为
  带 `Close within:#panel` 等可照抄候选。
- **【文档】** `docs/APP_SCRIPT_AUTHORING.md` 停因表 `host_not_allowed` 行补：页面驱动
  导航若 301/302 落到信封外 host 同样报此停因——重定向落地 host 也要声明在 `meta.hosts`。
- **【验证】** Lead 离线断言 11/11（别名回退 / StateView 不变 / within 自证 / 唯一 label
  顺序不变 / 无锚与非法锚不变）；本地 fixture 浏览器级：inspect 探测不再误报、
  `ctx.observe` 同名组 admitted 且带 within 候选、`close within:#panel` 与
  `#searchbox` 分别命中正确元素、裸词歧义仍零动作；`npm run check` 全绿。

## [Unreleased] — 介入/救援中断模块 texts 生成接线（设计 §8 步 4）

- **【新增·intervention 断言组】** `tools/prompt-hit.ts` 新增第八个断言组
  `intervention`：对 `src/support/intervention-texts.ts` 的
  `RESCUE_TEXTS`（action/value/authorization 三 kind）+ `SIGNAL_NOT_HELD_TEXT` +
  `OUTCOME_TEXTS` + `FULFILLED_NOT_HELD_TEXT` 全量执行六条清单——① 每条 zh 非空；
  ② agent_hint 为 en 面（混入中文即红，渲染器不得拼 zh）；③ summary ≤400 字；
  ④ human_question ≤120 字；⑤ 人话层禁 stopCode 键名/JSON 形状/英文栈帧；
  ⑥ agent_hint 不含面向人的祈使句。总输出行同步更新为「八组全绿」并列出
  intervention（组名引用制，插组不失准）。
- **【桥接·RESCUE_AGENT_HINTS】** `bridgeGenerated()` 把三 kind 的 agent_hint
  （`{fact, recommended_action, stop_condition}`）以 `RESCUE_AGENT_HINTS` 导出进
  `integrations/dsh-bridge/src/grammar.generated.ts`（生成物，经
  `npm run prompt-hit -- --fix` 刷新，不手编辑）；zh 人话层不进桥——渲染留在引擎侧，
  called, not embedded 纪律不变。
- **【schema·intervention 节 + F62】** `src/cli/schema-gen.ts` 的 `SCHEMA_TOPICS`
  追加 `intervention`；新节从真源 import（`RESCUE_KINDS` / `RESCUE_TEXTS`）渲染
  kind 三条（who_can_fix / stop_code / zh summary 摘要）、`result.rescue` 形状、
  agent_hint 三键形状、五态结局与影子开关说明；F 条目续编 F62（既有编号零重排）。
  `dist/schema/ctx.json` 同提交重生成；`amber schema ctx --topic intervention` 可查。
- **【文档】** `docs/MANUAL_STEPS_AND_PACE.md` 增第 6 节、`docs/AGENT_INTERFACE.md`
  增 §4.1：v1 语义、`result.rescue` 只在真实求援出现、影子开关
  `AMBERFLOW_RESCUE_SHADOW=1`（其余值视为关）。
- **【不改运行时】** `intervention-texts.ts` / `intervention-contract.ts` /
  `src/intervention/` 模块本体冻结；除 `schema-gen.ts` 外 `src` 运行时文件零改动。

## [Unreleased] — amber session 有头窗口尺寸（--window maximized|fullscreen）

- **【新增·session 窗口尺寸】** `amber session --window maximized|fullscreen`：
  `maximized` = 最大化（保留浏览器 chrome，注入 `--start-maximized`）、`fullscreen` = 全屏
  （F11 语义，注入 `--start-fullscreen`）。仅 headful 生效（`--headful` 或配置层
  `AMBERFLOW_HEADFUL=1`）；无头会话下给 `--window` = 用法错误（exit 2，**不静默忽略**）；
  闭集外的值同样 exit 2。实现 = 启动旗标 + 上下文 `viewport:null`（页面铺满真实窗口；
  否则 Playwright 缺省 1280×720 视口会把窗口约束回默认尺寸）。缺省不传 = 现状逐字节不变
  （`launchKwargs` 的窗口旗标只在显式 windowMode 且非 headless 时追加）。
- **【桥接·需重载】** `amberflow_session` open 增 `window` 参数（枚举 `maximized|fullscreen`）：
  需有头（`headful:true` 或部署 `Config.headful`），无头组合由桥先拒为结构化
  `config_error`（不靠子进程报错）；argv 透传 `--window`。桥模块重载/重启后工具参数才可见。
- **【范围】** 只接 session 面（authoring 试错最需要看真实窗口）；`run` / `inspect` 的同类
  窗口尺寸可作为后续扩展——`browserSession(headless, device, metaChannel, windowMode)` 与
  `launchKwargs` 已是单点实现，接入只需把参数从各自 CLI 透传下去。

## [Unreleased] — AMBERFLOW_HEADFUL env 层接线到 inspect/session/test（插件 HEADFUL 全链路生效）

- **【缺陷修复·env 层只覆盖 run 一条腿】** 桥配置页勾选 HEADFUL 后子进程注入
  `AMBERFLOW_HEADFUL=1`，但引擎只有 app-runner（`amber run/apps`）读 runDefaults——
  `amber inspect`（只读观察）与 `amber session`（authoring 会话）的 CLI 从不消费该 env，
  Agent 最常走的两条"打开浏览器"路径依旧无头（配置页勾选形同虚设）。修复：inspect 的
  `--headed` 与 session 的 `--headful` 都接入「CLI 旗标 > env（AMBERFLOW_HEADFUL）> 缺省
  headless」同一层叠；test 的 `--headful/--headless` 也接 env 层（配置默认值语义，旗标仍赢）。
  runDefaults 解析错误响亮报错（exit 2，与 app-runner-cli 同纪律）。plan-cli 旧面维持文档化
  的"缺省 headless"（`a.headful` 只来自新 CLI 透传）。
- **【缺陷修复·test --headless 起有头】** `amber test --headless` 此前被解析但接线算错：
  `runSuite` 的 headless 写成 `!(--headful || --headless)`，给 `--headless` 也算出 `false`
  → 套件起了**有头**浏览器，与 USAGE "--headless 显式无窗口（缺省 headless）"直接矛盾。
  修复后：`--headful` 或配置层 headful=true 才有头；`--headless` 显式无窗口；两者同给仍
  exit 2。`--headless` 从"不生效"变"生效"（有意变更面）。
- **【引擎侧同义参数排查结论】** 配置面（`config-schema.ts`）已是「一个概念一个键」纪律：
  旧别名（`LAYAA_*`、`HUGGINGFACE_HUB_CACHE`、`LAYAWEBUSE_REPO`、`TOKEN_PLAN_STATE_CONTEXT`）
  只作兼容回退留在消费点（canonical 优先读），不进配置面——写进 rc 加载期按未知键拒绝。
  疑似同义对均为**作用域分层**而非同层重复：`--conf-floor`/`AMBERFLOW_CONF_FLOOR`（run 层）
  > `meta.policy.conf_floor`（应用层）> provider 自报 floor（`AMBERFLOW_DECISION_FLOOR`，
  随 provider 走——score_kind 跨 provider 不可比，这是 provider floor 存在的理由）> 全局
  0.25；`AMBERFLOW_STEP_DELAY_MS`（步间）/`AMBERFLOW_ACTION_DELAY_MS`（动作间）粒度不同，
  共用 `src/support/pace.ts` 同一语义。CLI 的 `--headful`/`--headless` 是一维两向旗标
  （同给 exit 2；配置面只有 `AMBERFLOW_HEADFUL` 一键），与插件配置页只留 HEADFUL 同构。

## [Unreleased] — 插件配置页 HEADFUL 开关（单一有头选项）

- **【新增·桥接配置页 HEADFUL 布尔项】** `amberflow-bridge` 的 Config 新增 `headful`（volatile
  boolean，默认 false）：勾选后桥拉起的每个引擎子进程注入 `AMBERFLOW_HEADFUL=1`（显示浏览器
  窗口），压过引擎配置文件的 `runDefaults.headful=false`（env 层 > 配置文件层）；不勾选 = 不注入
  （引擎配置层叠决定，逐字节现状）。工具调用显式给的 `headful` 参数是 CLI 旗标层，仍最优先。
- **【形态说明·一个开关维度一个选项】** 浏览器窗口只有"要不要显示"一个维度，配置面只保留
  HEADFUL 一个布尔：headful 与 headless 是同一事实的两面，同置两个反义布尔 = 同一配置写两处
  （会互相覆盖、还得引入互斥校验），故不设 headless 反义项——想常驻无窗口在引擎 rc 配
  `AMBERFLOW_HEADFUL=0`（页面不勾选时不注入任何 env，rc 照常生效）。本版本线里此前实验性的
  `headless` 布尔项（未发布，本 profile 也未写入过）随之移除，无迁移面。配置页勾选时行摘要
  显示 `· HEADFUL`；`client-root.js` 由生成器重新生成，README/README.zh/DEVELOPING 同步。
- **【同义配置排查】** 桥 Config 面逐项核对后无其余同层同义项：`timeoutMs`↔工具参 `timeout_sec`、
  页面三项决策模型/步间距/HEADFUL↔引擎 rc 同名键（`AMBERFLOW_DECISION_*`/`AMBERFLOW_STEP_DELAY_MS`/
  `AMBERFLOW_HEADFUL`）均为「部署默认 ↔ 逐次覆盖」「页面 env 层 ↔ 引擎配置文件层」的分层关系
  （CLI 旗标 > env > 项目配置 > 全局配置，且"未设置 = 不注入"不遮蔽 rc），与引擎配置面
  「一个概念一个键」纪律同构；`sessionIdleMs`（桥会话 TTL）与引擎子进程 `--idle-timeout-ms`
  孤儿兜底是刻意的双层空闲（桥层权威，子进程层只是保险），非用户可见同义配置。

## [Unreleased] — C2 抽取选择器预检（非法选择器 → 结构化 config_error）

- **【缺陷修复·静默空数据】** `ctx.extract` 的行/字段选择器非法（如 `rows:"div["`、`fields:{x:"div["}`）
  此前被 `locatorAnyFrame`/字段循环的 `try/catch` 吞成 `[]`/`""`——假数据与"合法但零命中"
  无法区分（最危险的静默形态）。现在 `readRows`（extract 与 collect 的唯一实现）在**入口**做一次
  选择器解析预检：行选择器 + 每个字段选择器（除 `"."`/`":scope"`/`"@attr"` 形态）各一次
  Playwright `locator(sel).count()`（每次抽取 ≤ 1+字段数 次往返；collect 只在入口一次、循环内不重复）。
  `locator(sel)` 本身不解析选择器（解析在 driver 侧），所以必须真付一次 `count()`。
- **【结构化错误·不新增 stopCode】** 仅当异常文本是**解析错误**（Unexpected token / parsing css
  selector / Unknown engine / invalid selector）才抛 `config_error`：reason
  `ctx.extract: field "x" selector "…" is not valid: …`，`diagnostics.bad_selector={selector, field?}`。
  掉帧/超时/页面已关闭仍按旧行为（不误报成选择器错）。**合法但零命中仍是 `[]`/`""`**。
  会话 `extract` 复用 observe 口径：引擎 `amber session` 响应带 `error:"bad_selector"`
  （`code` 仍 `config_error`）；桥的失败投影在引擎给该标记时原样透出 `error`（不补键）。
- **【有意行为变更】** ①非法选择器从"静默空"变"响亮配置错"；②`ctx.collect` 旧的 DOM
  `querySelectorAll` 预检已删除、改走同一入口——Playwright 伪类（`:has-text(...)` 等）不再被误拒。
  **dry/replay 不访问浏览器、不做预检**（`apps check` 不因此红，只有真跑/会话才红）——文档写明。
  合法选择器下 extract/collect 的返回值与产物逐字节不变（夹具按"改前 readRows 复刻"对照全字段全等）。

## [Unreleased] — C3 信号报错形态统一（合法写法单点给出）

- **【缺陷修复·报错不可行动】** 对象形信号 `{css_text_contains:{selector:"div",text:"x"}}` 被
  `signalArgs` 折成长度 1 的参数列表 → 只报 `needs 2 argument(s)`，不说合法形态；会话/加载期
  各自拼提示。现在 `signals.ts` 新增 `SIGNAL_SHAPE_HINT`（叶 `{op:[arg…]}` 按位置放数组；组合
  `all_of`/`any_of` 非空数组、`not` 单个对象；对象形 `{selector,text}` 非法）+ `signalProblemText(problems,
  "json"|"cli")`，是合法形态提示的**唯一出处**。
- **【problems 自带提示】** `validateSignalSpec` 的 arity 分支在 `signalArgs(args).length !== arity` 时
  把合法形态与"收到什么形状"写进 problem（`all_of`/`any_of`/`not` 的形状错同样指路）——因此
  `apps check`/`plan check`/`test --validate` 的加载期校验自动继承。`plan-cli` 走 cli 版（`--signal`
  示例串与改动前**逐字一致**）；会话 `signal`/`waitFor` 失败 reason 走 json 版（`problems` 数组原样）。
- **【不变】** 合法信号的校验结果、`checkSignal` 运行时语义与产物逐字节不变；未新增 stopCode。

## [Unreleased] — B3 快照 changed 签名含可勾选控件状态（checks）

- **【缺陷修复·changed/inert】** `changed = pre/post 快照 JSON diff` 原有签名只有
  `{url,title,text,vals}`，而 `vals` 只序列化 input/textarea/select 的 `.value`——原生
  checkbox/radio 的 `checked`、`aria-checked`、`aria-selected`、`select[multiple]` 的选中
  index 都不在里面。于是 `check` 一个单选/复选控件可能拿到 `changed=false`，进而被记为
  inert（并写入 outcome memory 误伤该元素）、吞掉 `suspected_async` 的诚实提示。
- **【独立 `checks` 字段】** `PageSnapshot`（主 frame 与子 frame 项）新增可选
  `checks?: string`：只读 `CHECKS_JS` 记录上述确定性状态（`0/1` / 属性值 / 只记 true 的
  `aria-selected` / 多选 select 的选中 index 列表），空串则不出现该字段。**不改 `VALS_JS`**
  （P0-3 的 password/file/hidden 掩码零改动），也不把状态拼进 `vals` 串（避免分隔符碰撞）。
- **【一次 evaluate】** `vals` 与 `checks` 合并为组合脚本 `FN_STATE` 一次取回（主/子 frame
  各一次），页面往返不增加；`changed` 仍是同一份 pre/post JSON diff 机制（inert /
  anti-repeat / `suspected_async` 随之如实修正），`executed_actions.changed` 口径不变。
- **【落盘与默认产物】** session `snapshot-<n>.json` 一并写 `checks`（主 4000 / 帧 1200 字符
  有界）；无 checkbox/radio/aria 选中/多选 select 的页面**产物逐字节不变**。不新增
  stopCode / effect kind；dry 与 replay 不访问浏览器。schema 快照在 F17 truth 末尾补注
  （不新增 F id），`docs/APP_SCRIPT_AUTHORING.md` 判读规则补一句口径。

## [Unreleased] — A4 会话 act 落空判别（池内同档候选 / 词面近似 / 池外不可见行）

- **【缺陷修复·session act】** `target_not_found` 此前只有一句 `target "…" matched nothing in a
  pool of N element(s)`，分不清「目标不在页面」与「用词/形状不对，或元素不可见」。现在会话 `act`
  的落空响应多带 `diagnostics:{target, pool_size, hint_shape, hint_len, candidates[≤5],
  near[≤5], rejected[≤3]}`，`reason` 末尾追加一行 `判别: …`（仿 run 命令步的
  `cmdDiscrimination`：纯内存判别，主 reason 前缀与停因码不变）。
- **【同档候选不污染回显】** `HintMatchOptions.diag`（缺省 `true`）新增 quiet 读法：`false` 时
  `hintMatchImpl` **不写** B1 弱档旁路模块态；`candidates` 用它取候选，task-34 的
  `ambiguous`/`matched_others` 回显仍是本条 target 真实解析的结果（A2 行为不变）。
- **【词面近似】** 新纯函数 `nearCandidates(target, pool, cap=5)`（`executor-pure.ts`）：token 仍由
  唯一解析器 `parseHint` 给出，对 `label`/`full_label`/`data_test`/`id`/`name`/`href` 做**前缀/
  包含**比较，返回 ≤5 条 `{ref,tag,label≤40,why?}`——纯内存、零页面往返，**不扩 hint 语法**。
- **【池外不可见行】** `_domFallbackResolve` 把扫描行一并回传（既有解析行为不变）：只对词面近似
  的 ≤5 行做**一次**可见性判定 → `rejected`（≤3，`why:"not visible"`，措辞与 `observe` 的
  `why_not_admitted` 同源）；不扫面外元素、不新造 `why` 分支。
- **【透传】** 会话 `act` 失败分支带出 `diagnostics`（引擎已按上限构造）；桥 `engineFailure`
  有界透传（candidates ≤3 / near ≤3 / rejected ≤2 / label ≤40，不重算、不补键），`index.ts`
  失败 render 在 `diagnostics` 存在时追加一行 `no match: hint <shape>/<len> pool <n> — near: …`；
  桥参数/结果 schema 不动。
- **【不变】** 成功路径与非落空失败**键集逐字节不变**（新字段只在 `target_not_found` 时出现）；
  `ctx.expand`/`ctx.scrollList`/命令步（run 面）不传该开关，返回值与 `reason` 逐字节不变；
  不新增 stopCode、不新增 schema F 语句（会话契约不进 `CTX_FACTS`）；A1/A2/A3/B1/B2/C1 不受影响。

## [Unreleased] — B1 会话 act 的被遮挡证据（探针即点击 / 结构化失败 / opt-in 失败截图）

- **【缺陷修复·session act】** 会话 `act` 的 `click`/`check` 此前走 `_clickOnly` 的 5s 超时，被覆盖时
  只回 Playwright 首行（≤160 字），没有 bbox/覆盖者证据。现在这两类动作复用 run 的
  `occludedReason`——**探针本身就是那次点击**（返回 `__clicked__` 即已点，不再调 `_clickOnly`，
  无双点），预算 `(800, 5000)`：被遮挡约 0.8s 报，未遮挡的慢元素仍留 5s 重试。
- **【结构化失败】** 失败串 `not-actionable-or-covered:<blocker>` / `action-timeout` → `code` 取冒号前
  token、`reason` 保留原文，**不新增 stopCode**（既有 skip_reason 词面，F50 同例）；失败响应带
  `actionability:{reason,bbox,blocker,requery}`（`action-timeout` 也走同一现场读取：证明无覆盖者、
  节点仍在）。非 timeout 异常不补点：URL 已变记 `probe_navigated:true` 按已点击返回，否则
  `action_failed` + Playwright 首行。
- **【新增·失败截图 opt-in】** 会话 `act` 请求 `screenshot`（缺省 `false`）：失败时写
  `<evidence_dir>/act-<n>-failure.png`，响应只回 `screenshot_file` 路径（不内联图片）。桥透传
  `actionability`（reason≤200、blocker/requery≤60、bbox 数值）与 `screenshot_file`，`act` 参数
  `screenshot` 同义；模型可见的失败行在 `actionability` 存在时追加
  `blocked by <blocker> (requery=…)`。
- **【不变】** run 面/命令步/`ctx.expand`/`ctx.scrollList` 内部点击不传探针参数，行为与产物逐字节
  不变；session 的 A2 歧义两档、B2 滚动、A1/A3/C1 均不受影响。

## [Unreleased] — A3 弱档命中门槛（`meta.policy.act_hint_tier:"strong"`）

- **【新增 policy】** `meta.policy.act_hint_tier: "any"（缺省）| "strong"`，与 `act_hint` **正交**：
  `strong` = 裸词/属性子串的**弱档**胜出（词前缀/词包含、loose 子串）判为**未命中**，不再以
  conf=1.0 直接执行——弱档命中最容易点到容器/同缀元素。
- **【判据复用】** 门槛不另造档位表，直接用 `rules.takeHintMatchOthers()` 的既有 `suspicious`
  （bare t≥3、attrSubstr t=3）；step warning 从 `matched_others` 换成 `weak_hint_rejected`
  （含档位/候选≤3/开关）。池解析与 rules-only 宽扫重解析共用同一判定（`declaredAllow`）。
- **【后续语义】** 拒后按 `act_hint` 既有语义继续：`widen` 交模型（rules-only 落既有
  `no_model_runtime`）；`strict` 结构化 `target_not_found`（reason 写明弱档被拒 + 候选 + 两条改法：
  收窄成强形状 / 回 `act_hint_tier:"any"`）。
- **【不变】** 缺省 `any` 下行为与产物**逐字节不变**；命令 target、learned hint、决策步（无 act）
  不受影响；**不新增 stopCode**（strict 复用 target_not_found）；hint 六形状闭集不变；
  显式声明才进 `effective_policy.act_hint_tier`（声明 `"any"` 也进账）。契约注记见
  `amber schema ctx` 的 F59。

## [Unreleased] — A1 属性值匹配按完整值（aria-label：full_label + label 双底座）

- **【缺陷修复·hint 属性匹配】>40 字的 aria-label 值此前永远等不上**：`tag[aria-label=…]` /
  `tag[aria-label~…]` 的匹配底座只取池字段 `label`，而 `label` 是**模型视图的前 40 字**
  （`full_label` 才是 ≤200 的匹配口径）。现在与 T9 的 href `[href_full, href]` 同形状：
  aria-label 别名（`poolFieldFor` → `label`）的底座改为 `[full_label, label]`（非空、同值去重、
  大小写折叠），**attrEq 与 attrSubstr 共用同一函数**——`[aria-label~长值尾串]` 同修，不只修等值。
- **【行为变更·严格只增】** ≤40 的值**等值**命中集合逐字节不变（`full_label` 全等 ⇒ `label` 全等）；
  >40 的值从"必落空"变为按 `full_label` 等值/子串命中；子串面在超长 label 上可能新增命中（同一
  "按完整值匹配"语义的直接结果）。同值重复仍取 DOM 首个，不新增"假唯一"；hint 六形状闭集、
  敏感值纪律不变。
- **【新增·`meta.policy.attr_value_match`】** `"full_label"`（缺省，= 修复后）| `"display"`
  （= A1 之前只看前 40 字 label；逃生口/对照臂）。接线：`app-pack` 的
  `POLICY_KEYS`/`ATTR_VALUE_MATCH_MODES`/`PackPolicy`/`validateApp`（未知值加载期 `config_error`，
  `apps check` 即红）→ `app-runner` `resolveRunPolicy`（`effective_policy.attr_value_match`
  仅声明时出现）→ `MiddlewareOptions.attrValueMatch` → `rules` 的 `HintMatchOptions`
  （`hintMatch`/`hintCandidates`/`affordanceRule`/`hintMatchImpl`；DRF 的 `declaredLookup` 与
  `ctx.waitForTarget` 同口径）。run 面按 policy 传；**inspect/observe/session 无 policy，恒
  `full_label`**。默认产物不变（policy 缺省时只有 >40 命中这一处新行为，生效于 run 面）。
- **【不变量注释】** `label === full_label 前 40 字` 已在 extraction/declared/observe/executor 的
  各构造点用注释固化。契约注记见 `amber schema ctx` 的 F58。

## [Unreleased] — C1 行抽取分页（ctx.extract offset / 会话 offset·total·has_more / 桥 save 落盘）

- **【新增·`ctx.extract` 第二参】** `ctx.extract(nameOrSpec, { offset? })`：`offset` 只做分页起点
  （0-based 整数 0..10000，非法/写进 inline spec = 结构化 `config_error` 并指路第二参），
  `maxItems` 仍是每页上限。`readRows` 唯一实现改为 `all.slice(offset, offset+cap)`，
  `total = all.length`、`truncated = offset+rows.length < total`——**offset=0 与之前逐字节一致**。
  返回类型不变（仍是行数组，`count` 语义不变）；`total` 只经 `CtxDeps.extractStats` 观测口回写，
  **只有 session 面注入**，run/dry/replay 不注入、行为与产物不变（dry 恒 `[]`、replay 按 desc 回放）。
- **【新增·会话协议分页】** `amber session` 的 `extract` 请求新增 `offset?`（非整数/越界 = `config_error`）；
  响应在 **capped 或 offset>0** 时追加 `offset`/`total`/`has_more`（`has_more = offset+count < total`），
  `count` 恒为本页返回行数、`capped` 语义不变；无 cap 且 offset=0 时键集与之前逐字节一致。
  `observe` **不提供 offset**（元素序随水合/动画变化，无稳定锚）：收窄用 `selector`/`max`，全量用
  `snapshot`（`pool-<n>.json`）。
- **【新增·桥 `amberflow_session`】** extract 参数补 `offset`（透传）与 `save`：`save:true` 时桥内
  翻页取全（每页 ≤500，硬顶 **2000 行 / 4MB**）写 `<evidence_dir>/extract-<n>.json`，返回
  `file`/`saved`/`bytes`（被硬顶截断如实标 `truncated`+`save_limit`），`rows` 仍给首页 ≤20。
  模型可见 render 的 observe/extract 显示行数 12→20 / 5→20，且**只有溢出时**追加两行
  （observe：`… +N more (M total, K omitted)` + 收窄/max/snapshot 指引；extract：`… +N more` +
  `total=T · offset=… 续页 · save:true → extract-<n>.json`）——无溢出/无 offset/无 save 时输出不变。
- **不变量**：run 的 result/report 不变（extractStats 仅会话注入；trace 的 `offset` 仅 offset>0 出现）；
  A2/B2 的会话行为不破；桥不新增引擎语义；`element-view.ts` 合同不动。契约注记见 `amber schema ctx` 的 F57。

## [Unreleased] — B2 会话 act 滚动语义诚实化

- **【缺陷修复·会话 act scroll】元素目标的 `to`/`by` 此前被静默丢弃**：`act scroll "列表" {to:"bottom"}`
  只做 `scrollIntoViewIfNeeded`（滚入视口），`changed` 还硬编码 `true`——请求的方向没生效，响应却说
  "页面变了"。现在：**带 `to`/`by` = 容器滚动**（目标元素自身或最近可滚动祖先，走
  `_scrollContainerForElement`→`_scrollWithLoc`，与 `ctx.scrollList`、run 的 `scroll` 命令同一条实现；
  `by` 优先；找不到可滚动容器 = 结构化 `not_scrollable`，不再是静默无操作）；**不带 `to`/`by` = 滚入
  视口**（旧语义不变），但 `changed` 改为**实测** `moved`（滚动容器 `scrollTop` 前后差）。
- **【新增·滚动证据】`act scroll` 响应带 `moved`/`delta`/`scroll:{scrollTop,scrollHeight,clientHeight}`
  （有则附，没有就不附）**，`_scrollWithLoc`/`scrollDocument` 成功时也新增 `delta`（after-before）。
  桥（`amberflow_session` 的 `act_op:"scroll"`）只透传这三个键（有界、不重算），act 渲染行显示
  `moved/delta`；工具参数说明改写为"to/by = 容器滚动，无 = 滚入视口"。
- **【缺陷修复·`--record` 记录诚实性】只记实际发生的事实**：滚动没走通不再记 `to`/`by`；没请求方向
  的元素滚动不再伪记 `to:"bottom"`；另记 `scroll_mode`(`container`|`into_view`)/`moved`/`delta`/
  `scrollTop`。`session export` 按 `scroll_mode` 还原：container → `ctx.scrollList(target,{to|by})`，
  into_view → `ctx.command("scroll", target)`（无 to）；旧轨迹（无 `scroll_mode`）导出与之前逐字节一致。
- **不变量**：run 面/命令步/`ctx.scrollList`/`scrollDocument` 的既有语义与产物**逐字节不变**
  （`_executeElement` 的 scroll 分支原样保留）；dry/replay 不受影响；A2 歧义透传不破（`actOnce`
  第 5 参 `onAmbiguous` 语义不变，歧义失败面仍 `target_ambiguous`+`ambiguity`）；不新增 stopCode、
  不扩 hint 六形状闭集。契约注记见 `amber schema ctx` 的 F56。

## [Unreleased] — A2 会话 act 歧义缺省不执行

- **【行为变更·会话 act 歧义】`amber session` 的 `act` 目标命中多个**不同**候选时，缺省不再执行**：
  返回结构化 `{ok:false, code:"target_ambiguous", executed:false, ambiguity}`（与 `amber run` 命令步
  `target_ambiguous` **同一个谓词**：`hintCandidates` 非空 && `decided === null` && `refs.length > 1`）。
  `ambiguity` 有界：候选 ≤5（`candidates_total`/`truncated`）、label/class/near ≤40、ref/tag ≤16、
  `suggested_hint` ≤80、`would_act_ref`；`source:"dom_fallback"`（A3 池外回退）不给 near/suggested_hint。
  事故形状：`div "搜索关闭"` | `button "关闭"` 上点 "关闭" 会命中搜索框清除按钮，整条搜索链路退出。
  恢复旧行为：会话级 `--on-ambiguous act`，或单行请求 `onAmbiguous:"act"`（桥参数 `on_ambiguous`）；
  该失败进 `--record` 轨迹的 `code` + `candidate_refs`（≤5）+ `candidates_total`。
  **不变量**：run 面/命令步/决策步行为与产物逐字节不变（dry/replay 不调 `actOnce`）；
  `ctx.scrollList` 内部点击与 run 原语不传该策略，行为不变；不新增 stopCode、不扩 hint 六形状闭集。

## [Unreleased] — run --headless 透传修复 + 插件 headless 配置

- **【缺陷修复·run --headless 透传】`amber run --headless` 此前被解析但从不转发给
  app-runner 子进程**（spawn args 只 push `--headful`）：机器配置层配了
  `runDefaults.headful=true` 时，用户给 `--headless` 也退不出有头（浏览器窗口照样弹）。
  修复：run.ts 的 app/goal 两模式透传 `--headless`；app-runner 与 start.ts 解析该旗标并按
  「CLI 旗标 > env > 配置文件」层叠压过 runDefaults.headful；`--headful` 与 `--headless`
  同给 = 互斥用法错误（exit 2）。**行为变更面**：此前 `--headless` 静默无效 → 现在生效
  （不传任何旗标的默认路径不变）。
- **【新增·桥接配置页 headless 开关】`amberflow-bridge` 插件配置页新增 headless 布尔项
  （volatile）：勾选后桥拉起的每个引擎子进程注入 `AMBERFLOW_HEADFUL=0`（无窗口），压过
  机器 rc 的 `runDefaults.headful=true`；不勾选 = 不注入（引擎配置层叠决定，逐字节现状）。
  工具调用显式给的 `--headful` 是 CLI 旗标层，仍最优先。需要插件重载后生效。
  （该布尔项在本版本线内随后由单一的 `headful` 开关取代——headless 是同一维度的反义面，
  不再单设，见下方「插件配置页 HEADFUL 开关」。）

## [Unreleased] — feat/opt-scale（task-21/1a 行为变更）

- **【行为变更·1a 滑杆假成功修复】`ctx.setRange` 越界请求不再静默钳制后报成功**：
  `{value}` 超出滑杆 [min,max] 时返回结构化失败 `value_out_of_range`（stopCode），零动作
  （不走任何交互策略），结果带 `requested`（请求原话）/`clamped_from`（被拒的钳制值）。
  旧行为：越界目标被钳进值域后按钳制值报 `ok:true + accurate:true`（违反「完成只认证据/
  不假装成功」红线——实测：请求 200、滑杆 [1,11]、返回 achieved 11 且 accurate:true）。
- **【行为变更·1a accurate 语义收紧】`accurate` 改为精确语义（achieved === requested）**：
  容差（缺省 max(0.5, step/2)，步长感知）只用于交互过程的收敛判定，不再用于 accurate 判定；
  「容差内但非请求值」如实报 `accurate:false` 并把 achieved 带出。keyboard 策略格点感知
  （从 Home 归位值 + k*step 格点起算、最近格点 Math.round、|gap|<step 不做 ±3 微调），
  收敛失败带 `probe`（value_unreadable | home_ignored | lattice_unreachable）。
  依赖容差语义的旧脚本请改按 `achieved`/`requested` 自行判定。
- **【新增·D-1 观测面】`result.env.browser`（binary_basename/headless/persistent_profile）、
  `result.observations[]`（read/extract/observe 的行样例+计数+hint 投影，只增）、observe
  trace 事件增 `elements_sample`（前 5 元素有界样例）、run warnings 注入 `[step N:id]` 前缀
  （flow 面执行器 stepNo 恒 1 的步号修正）。
- **【新增·D-2 产出守卫】`amber apps new` 骨架内置「产出行数 ≥N 否则 ctx.fail(output_underflow)」
  模板；docs 把数据类任务的产出下限写成硬要求。

## [2.0.0] - 未发布

2.0.0 是一次结构性重构：仓库从「决策任务流引擎 + 声明式应用 + 离线夹具/复刻站」收敛为
**冻结计划的浏览器自动化中间件**——单一执行循环、单一应用作者模型（`meta` + `flow(ctx)` 脚本）、
真实站点线上套件与可验证的执行证据。本版本尚未 npm 发布、未打 git tag；下列内容即当前工作树的
未发布摘要，发布形态见文末「发布形态（待定）」。

### 新增

- **A1 动作执行证据与 done 诚实性**：命令步在动作前对 done 做一次预评估（`done_preheld`，只记录、
  不改变执行顺序）；`StepResult` / trace / `RunReport` / report.md 新增「动作执行证据」——
  `executed`、`executed_actions`（op/ref/how/changed）、`skipped_actions`（每条"为什么没动作"的
  结构化原因）、`warnings`（如 `suspected_async`）；零执行步骤以 `executed=false` + 跳过证据 + 停因
  摘要 `executed 0 action(s)` 诚实呈现（不静默 done）；click 快照未变但 done 成立 = `suspected_async`
  （async 效果，不 forbid、不写 inert 记忆）；`ctx.step` 新增 `forceAct` 声明（done 预成立也先执行
  命令闭集）；新增示例 `examples/apps/05-done-evidence` 与开发脚本 `scripts/done-evidence-check.mjs`。
- **A5 决策面通道引导**：`amber doctor` 缺省发一次最小 ask 探针（`ask_probe` 进 JSON，旧字段不变、
  失败不改退出码，可 `--no-ask-probe` 关闭）；`decision-provider` 的 ask 失败/`no_model_runtime`
  统一附恢复指引（桥 `amberflow_run` 用部署配置 vs CLI `AMBERFLOW_DECISION_*` 用户配置，403 处理
  见 `docs/DECISION_SERVICE_CONFIG.md` 两条通道矩阵）；`run` 的 stderr 与 next[] 同步；不打印密钥、
  不自动切换。
- **A3 列表展开与范围控件三原语**：`ctx.scrollList(target, {to|by})`（滚目标/最近可滚动祖先，纯 DOM
  scrollTop）、`ctx.expand(target, {count, maxClicks, stableRounds, settleMs, timeoutMs})`（点"加载更多"
  到行数稳定，内部点击不占 flow 预算）、`ctx.setRange(target, {value|percent})`（fill→keyboard→pointer
  三策略，0×0 手柄用最近有尺寸祖先 bbox）。三者各计 1 flow step，失败是结构化结果
  （`not_scrollable` / `expand_not_stable` / `slider_not_settable`），dry 有确定性桩且参数校验真做，
  trace 记 `args` 供重放逐字比对；`ctx.command("scroll", sel, {to})` 扩展为滚容器到方向（旧调用不变）。
- 应用唯一格式：`$AMBERFLOW_HOME/apps/<id>/app.mjs` 的 `meta` + `flow(ctx)` 脚本；配套
  `amber apps new/list/show/check/explain/path/remove` 命令面，`apps check` / `apps explain`
  只做加载与 dry 调用序列校验（不开浏览器、不调模型）。
- `amber inspect`：只读观察真实页面元素与候选 hint；`amber record`：演示一次并归纳完成信号，
  零模型调用回放不通过就不落盘。
- 真实站点测试声明层 `online/`（`sites/*.json` 与 `cases/{smoke,core,deep,probe}/*.json`）：
  退出码 0/1/2/3 语义、`--require-all`、证据写 `$AMBERFLOW_HOME/online-runs/` 且不入库。
- `amber schema ctx` 自描述语义契约与 `dist/schema/ctx.json` 快照（`--check` 做漂移门）。
- 统一执行循环 `BrowserMiddleware.run`：完成信号语言（9 算子 + 组合器 + `manual`）、
  元素池以 AX 可访问性树为主源、结构化停因与 trace / replay（`script_sha256`）锚点。
- 人工步（`ctx.manual`）与可配置运行节奏（`meta.pace`）；非 TTY 不假装有人。
- 决策源统一：线上三件套 `AMBERFLOW_DECISION_BASE_URL` / `_MODEL` / `_API_KEY`；无地址用本地
  `laya-onnx`（`AMBERFLOW_DECISION_MODEL=english|multilingual` 选 checkpoint）。
- DSH 桥（`integrations/dsh-bridge/`，9 个 model-facing 工具）与仓库根 bundle 安装门
  （`dsh-bundle.yml`）：`dsh plugin add github:Johnly1986/AmberFlow` 即可接入。
- `npm run check` PR 门禁：`typecheck` + 配置示例一致性 + schema 快照漂移 + 提示词/信号一致性 +
  线上用例声明校验。

### 变更

- **行为变更（A2）**：元素池缺省排序从「main 内容优先 + DOM 序截断」改为**分桶配额 + 当前视口感知**
  （chrome/viewport/contentNear/mainOffscreen/other；默认 40 / 宽扫 120，配额常量单一出处
  `extraction.ts`）；`hint` 匹配改用完整 label（`full_label` ≤200）并支持 `aria-label` 别名与裸词
  词边界/前缀；命令目标按可行动优先尝试前 4 个候选（失败记 `skipped_actions` 并换下一个，全败不静默 done）。
  逐应用回退：`meta.policy.candidate_priority: "main-first"`（缺省 `bucketed`）；窗口外元素可用
  `amber inspect --json` 的 `window` 事实查看，引擎不自动滚动。
- 线上套件 npm 入口由 `online` 更名为 `test`（`npm run test -- --tier smoke|core|deep|probe`）。
- 配置收敛为单一 schema 声明（`configs/amberflowrc.example.json` 由 schema 生成并做一致性检查）；
  移除 provider 配置键与命令行模型旗标，`--provider` 只用于本次实验/消融。
- 应用作者模型收敛为 flow 脚本：仓库不再是「决策任务流引擎」，`flow.json` / `pack.json`
  声明式应用与语义模板被 `app.mjs` 取代。
- **统一决策函数入口**（BACKLOG #1；前提：规划归 Agent）：执行侧 provider 缝成为引擎唯一
  决策入口。`plan-cli run` 接入与 start/apps/online 相同的决策源解析（三件套 / 本地 laya /
  `--provider` 本次覆盖）；低置信 escalation 梯级改走 `DecisionProvider.askChoice` 闭集窄问
  （`plan-cli run --escalate` / `amber run --plan --escalate` / `amber plan run --escalate`，
  opt-in 缺省关），provider 不支持 `askChoice` 时梯级缺席并如实打印；`askChoice` 计入
  咨询计数（`countedProvider`）。
- **规划归 Agent**：移除引擎内 LLM 规划/重规划面——`plan-cli new --llm` 与
  `plan-cli run --replan`（及 `amber plan new --llm`、`--replan` 转发）不再存在，被挡子目标
  照旧以 `blocked + obstacle` 结构化结果返回，由 Agent 决定下一步。
- `PLANNER_MODEL` 配置键移除（旧 rc 残留会在加载期以未知键拒绝，删掉该键即可）；
  `OPENAI_BASE_URL` / `OPENAI_API_KEY` 只剩事后审计（`LLMAuditor`）一个消费者，
  配置组更名为「外层 LLM（事后审计）」。

### 移除

- `pack.json`、声明式数据脚本、语义模板等旧应用格式。
- 离线夹具、复刻测试页、内置应用与真实站点冻结证据；`vitest` 单测与 parity 工具链。
- 历史报告 / 基准 / 应用清单等过时文档（当前事实以 `AGENTS.md`、`ARCHITECTURE.md`、`docs/` 为准）。
- `LLMPlanner`（System-2 计划起草）与裸读 `OPENAI_*` 的 `llmEscalator`（含 `snapshotText`）：
  规划归 Agent，escalation 由 `src/model/provider-escalator.ts` 经 provider 缝承接。

### 修复

- **A4 引用盖章唯一化**：提取前清旧章 + 批次 nonce（`data-dshref` 章值 `af<批>-e<位>`，
  `data-hintref` 用 `af<批>-h<n>`），消除"元素换位后旧 ref 章残留 → 同一选择器命中多个节点"的
  点错隐患；`_locatorFor` 对引用章加唯一性闸门（恰好 1 个才用；>1 记 `ref_collision` 诊断并回退
  id/name/scan，最终 null 交动作层 `stale_ref`）；run 收尾 best-effort 清理两类章属性；
  开发脚本 `scripts/ref-stamp-collision.mjs`。
- **纯验证步停因如实化**（2026-11-01 产品评审 P1）：无 target_hint、无命令空间的子目标在
  规则档被挡时，不再误报「no model runtime: needs a model pick」——当场评估 done 信号并
  区分两种实况：「信号已成立但本步未声明动作 → 声明 `commands:[{"op":"skip"}]` 或点名
  target_hint」/「信号不成立 → 点名、声明命令或提供决策模型」。
- **trace 方法标签跟决策源走**（2026-11-01 二轮评审④）：`method` 不再硬编码 `laya`——
  provider 自报真名（线上档 `decision-service`、消融基线真名；本地 laya 档归一化仍为
  `laya`，逐字节不变），后缀 `<name>:reobserve` / `<name>:adjudicated` 动态拼接；
  trace step 增 `decision_kind`（rule/model/escalate）粗分类字段。`decisions.line` 汇总
  `laya 1` → `model 1 (decision-service, conf …)`；ladder JSON 键 `laya` → `model`
  （2.0.0 未发布窗口一次改净；旧 trace 回退按旧串聚合，重放不受影响）。
- `plan check --probe`（P1b，opt-in 在线探针）：离线规则通过后，把每个 start_url 真实到达
  一遍（只读、不动作）——点名步核对 target_hint 能否在实况元素池解析，零动作验证步核对
  done 信号此刻是否成立；发现机制性必挡项 exit 1（`amber plan check --probe` 同语义）。
- inspect 输出随附说明（P3）：hint_candidates 可直接用作 hint（**非 CSS** 语法），href 等
  字段是元素池投影——文本输出加一行标注，`--json` 增 `hint_syntax` 字段。
- 示例 01-basic-step 信号锚点更新（P4）：h1 锚点在 example.com 实况漂移中已消失，
  改锚 `<title>` 文本并加「锚点纪律」注释（抄示例前先 inspect 核对实况）。
- 双载体定位（P2）：文档与 `plan-cli` USAGE 明确——**应用唯一编写格式是 app.mjs**（不接受
  JSON 应用描述），plan JSON 是逐步调试/续跑的轻载体；`plan new` 输出附定位提示。

### 安全

- 完成只认信号，模型 done 票仅 advisory；值只来自计划/观察，缺值返回 `needs_value`。
- 凭据只允许 `{{env:NAME|default}}` 占位符；明文凭据不得进入用例/计划/产物/仓库，本机配置
  `configs/amberflowrc.json` 已被 gitignore。
- 不绕过反爬（不伪造指纹、不轮换代理、不规避风控/速率限制，风控拦截按 `blocked` 停止）；
  验证环节（登录/2FA/验证码等）可在用户授权下代过。

### M0 基础设施（2026-10-31，未发布）

- CI `checks.yml`：check job 在 `npm run check` 之前生成 `dist/schema/ctx.json` 快照（该文件是
  构建产物、已被 gitignore 排除），干净 checkout 不再因 `SCHEMA_SNAPSHOT_MISSING` 变红。
- CI `checks.yml`：online job 改用真实入口 `npm run test -- --tier smoke --require-all`
  （原 `npm run online` 在 v2 更名后已不存在）；保留定时/手动触发与证据上传语义。
- CI `bridge.yml`：删除调用已不存在的 `tests/*.spec.ts` + `vitest` 的 job，改为干净 checkout 可
  离线复现的校验——桥 TypeScript 源解析（`node --experimental-strip-types --check`）+ 生成的仓库根
  client bundle 与 `client.js` 同步、根 `exports` 导出门禁。
- npm 可发布元数据：移除 `private:true`；补 `license: Apache-2.0`、`repository` / `homepage` /
  `bugs`、`files` 白名单（含 `bin/`、`src/`、`tools/`、`configs/`、`scripts/`、`docs/`、`online/`
  与 DSH 桥运行必需文件；排除 `models/`、构建产物与 `node_modules`）；修复 `description` 乱码为
  正确 UTF-8；保留 `engines`（Node ≥ 22.6）。未改动 `exports` 结构。
- README 定位统一为「冻结计划的浏览器自动化中间件 / 可验证的浏览器执行内核」，并补充
  `npx amber` 在 checkout 内会挂住、就地改用 `node --experimental-strip-types src/cli/main.ts` 的说明。
- 新增本 CHANGELOG；不创建 git tag（发布形态与 tag 由后续决定）。

### M0 凭据/产物安全（2026-10-31，未发布）

- `meta.secretSlots`：显式声明敏感槽位（加载期校验必须是已声明槽位）；`result`/`report`/`stdout`/dry JSON 中
  敏感槽位一律掩码为 `***`。名称启发（password/token/api_key/...）作为兜底，只对已声明槽位生效。
- 深扫兜底 `scrubSecrets`：敏感值被流程写进 `logs`/`step_traces`/trace 等其它字段时也会被抹掉；
  `--emit-trace` 写盘前同样脱敏。
- `--slot-file FILE`：从 JSON 对象读槽位，避免敏感值进 argv/进程列表；与 `--slot` 同名时 `--slot` 优先；
  文件对 group/other 可读会告警，建议 `chmod 600`。`--slot` 敏感键会告警。
- `tools/secret-scan.ts`：一次性 canary 扫 `result.json`/`report.md`/dry JSON/scrub 后的 result/trace，
  断言零命中；接入 `npm run check`（`npm run secret-scan`）。
- 本机配置写入后 chmod `0600`（Windows 无 POSIX 模式时忽略失败）；新增 `SECURITY.md` 写凭据模型、
  证据脱敏、信任边界、反爬/验证边界与已知缺口。

### 安全修复（2026-10-31，未发布）

- **修复 flow 应用浏览器腿的 confirmFn 分支反接**：M0 翻转默认时把安全分支写进了
  `runScriptApp` 的错误侧——flow 应用此前默认**放行**破坏性动作，`--confirm-unsafe`
  反而拒绝。现已与 `runApp`/文档语义一致（默认按干跑证据拒绝破坏性动作）。
  e2e 实测（受控本地页面 + `effect: { irreversible: true }` 声明）：默认
  `RISKY → risk-declined` 拒绝（exit 1）；`--confirm-unsafe` 放行且 done 成立（exit 0）。
- `amber run` 补转发 `--slot-file` / `--confirm-unsafe`（此前 help 列出但 CLI 层静默忽略）；
  `amber run --dry-run --json` 的 envelope 掩码敏感槽位（第三个明文出口封堵）。

### 提示词系统补全（2026-10-31，未发布）

- 层 3 覆盖闭环：`STOPCODE_MEANING` 补 `max_steps` / `noul_unverified` / `no_progress` /
  `space_empty` / `nominated_family_empty|mismatch`；prompt-hit 改**双向**断言
  （STOP_NEXT ⊆ schema 且 schema ⊆ STOP_NEXT ∪ EXEMPT），并新增 executor `StopCode`
  union ↔ 契约/内部码边界（`EXECUTOR_ONLY_STOPCODES`，逐条理由）闭环——覆盖率不再只是
  对手写表的自我证明。
- 豁免收紧：`needs_human`、`frame_not_allowed`、`popup_not_allowed`、`manual_signal_not_held`、
  `action_unsupported`、`target_not_found`、`target_ambiguous`、`hint_matched_no_target`、
  `step_names_no_target` 晋升为可执行 next（STOP_NEXT 28 条 / EXEMPT 3 条）；
  **停手规则改为失败即输出**（stdout/report.md/report.html），不再依赖 next 是否存在。
- 层 1 真正进桥：`OVERVIEW_TEXT` 接进 `amberflow_status` 工具描述头部（prompt-hit 断言接线）；
  概述措辞修正为「模型只做选择/风险/完成票（完成票仅 advisory）」。
- 层 2 补全：`amber help --json`（无命令名）输出结构化命令清单；registry `when` 改由
  help-map 单源投影；`run` 帮助补 `--slot-file` / `--confirm-unsafe` 并修正 `--confirm-safe`
  语义描述；首页「下一步」改由 help-map `HOME_NEXT` 单源渲染。
- `amber schema ctx --check --topic <节>` 修复：快照按同 topic 切片比较（此前切片 vs
  全量必然 drift，为既有缺陷，本版修复）。
- 停手规则进 `docs/APP_SCRIPT_AUTHORING.md` 逐字块（prompt-hit doc 组断言）。

### M0 可用性（2026-10-31，未发布）

- **默认安全**：应用批量运行的 `confirmFn` 缺省从「一律放行」翻转为按干跑证据拒绝破坏性浏览器动作；
  `--confirm-unsafe` 或 `AMBERFLOW_CONFIRM_SAFE=0` 显式恢复旧行为。配置 schema 的默认值同步改为 `1`，
  示例配置重新生成。
- **HTML 证据报告 v0**：`amber run` 在 `-result.json` / `-report.md` 之外写 `-report.html`（结论、脱敏槽位、
  步骤/不变量/证据锚点；全部值经 HTML 转义），并打印落盘路径。
- `npm run check` 增加 `secret-scan`（凭据/敏感槽位产物零命中门）。
- 离线示例：`examples/apps/` 4 个零网络/零模型样板 + `tools/examples-check.ts`；`npm run examples-check`
  接入 `npm run check`，`examples/` 随 npm 包分发。

### 执行取证与走查批次（2026-11-02，未发布）

- **done 信号多动作闭集**（A1）：一步内多命令闭集全部执行完才判 done——不在中间态误判完成；
  dry-run 增两条信号 lint（裸 `not` / `any` 含 `not(exists)`，stderr 非致命、不改退出码）；
  `step_traces.afters` 逐步记录动作后的内容签名，事后可核对每步实动了什么。
- **解析失败判别**（A2）：`target_not_found` / `low_confidence` 的 reason 附池快照答案——
  区分「目标不在页面」与「候选在而闸门拒/闭集约束」，失败看 reason 即可判别，不必再开浏览器取证。
- **决策源对齐**（A3）：ask 失败透传 HTTP 事实（machine code / cause 链 / 2xx 非 JSON 响亮
  报错）；`failed_asks` 独立计数；`no_model_runtime` 附降级原因；flow 路径 `provider_degraded`
  管道修复；`amber doctor --ask-probe` 用当前三件套真实发一次最小 ask（探针只诊断，不改退出码）。
- **DSH 桥超时**（A4）：`amberflow_run` 增 `timeout_sec`（1..7200 秒）硬墙钟上限——长流程
  调大预算而不是被默认上限杀掉；被杀落盘 `run-killed.json`，部分证据不再丢失。
- **高效规划六步法 v2.1**（A5）：五步法 → 六步法，走查先行——先用引擎把流程按真实步序走通，
  再写正式应用；planning-playbook 真源同步骨架注释、inspect next、run 失败 next 与文档逐字块。
- **`amber run --walk` 单会话走查模式**（A6，调试旗标，默认关）：`ctx.step` 同页重锚
  （origin+path 同）不重导航、保留 SPA 状态，跨页显式 url 照常导航；与 `--dry-run` 互斥；
  结果自报 `walk:true`——适合复现「只在演进状态出现」的问题；正式跑不用 walk，每步重导航
  （起点 URL 确定性）才是 done 判定确定性来源。
- **B 组修正**（B1/B3/B2/B5/B6）：`action_unsupported(fill)` 附修正指引；PARTIAL 报告的
  不变量措辞「不成立」→「未验收」（验收未发生态）；`--slot k=v` 逗号拆分行为说明；结果 JSON /
  report 增 env 环境与会话字段（run_id / 时间戳 / final_url / viewport / UA，缺省等价）；
  extract 字段投影与池文本分歧文档化（设计如此非 bug，附行号证据）。

### 发布形态（M0 决定）

- **M0 决定：首次 npm 发布采用单包 `amberflow`**——`bin/` + 引擎 `src/`；DSH 集成继续走
  git-install（`dsh plugin add github:Johnly1986/AmberFlow`），不单独发 npm 包。
- 根 `exports` 暂保持指向 DSH 桥（兼容 git-install）；**首次发布不承诺** `import 'amberflow'`
  的引擎 API（消费面以 CLI 为准）。
- 拆分（`amberflow` 引擎包 + `@deepseek-ai/dsh-amberflow-bridge` 集成包）列为 v3 M1+ 工作项；
  拆分前需解决「bin 依赖 `--experimental-strip-types` 运行 `.ts`」与「`exports` 指向 `.ts`」两处
  对普通消费者不友好的形态。
- `npm run check` 在干净 checkout 上会先由 `precheck` 生成缺失的 `dist/schema/ctx.json`（构建产物）；
  快照已存在时 `schema:check` 仍做严格漂移比较。

## [1.0.0] - 2026-10-03

首个 TypeScript 单一技术栈可用版本（当时名 LayaWebUse）：冻结计划 + 本地决策模型执行，
验证依赖离线夹具 / 复刻测试页（`testpages/`、`tests/`、`bench/`）。已被 2.0.0 取代。

[2.0.0]: https://github.com/Johnly1986/AmberFlow/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Johnly1986/AmberFlow/releases/tag/v1.0.0
