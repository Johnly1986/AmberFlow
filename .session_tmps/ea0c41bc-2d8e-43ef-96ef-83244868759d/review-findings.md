# 双视角审查记录与迭代结论（2026-10-30）

审查对象：`docs/PROMPT_SYSTEM.md` 初稿。
审查方式：两个独立视角（产品负责人 / 真实接入的调用方 Agent）对照文档原文与
仓库代码事实逐维度审查；本文件是合并后的结论与方案迭代记录。

---

## A. 产品视角审查

### A1. 上手路径完整性 — 有保留
概述"从哪开始"给的是 `amber doctor → amber help`，但事实核查：裸 `amber` 在
checkout 里默认不在 PATH（`INVOKE_FALLBACKS` 专门为此存在；首页有专门提示），
且 `npx amber` 会挂住（AGENTS.md 明确警告）。**层 1 给的"第一条命令"必须按
调用环境分叉**，否则首用第一条命令就是坑。修改：概述的"从哪开始"区分两种
形态（checkout 内 / 已安装），并保持首页 fallback 文案与之一致。

### A2. 三层职责边界 — 有保留
初稿层 2 的 `flow` 字段示例里写了"失败先看 steps[] 第一一条失败与 trace 的
stopCode/reason"——这是层 3 的内容泄漏进层 2。修改：`flow` 字段只写正向流程；
失败回流统一由层 3 的 STOP_NEXT 承载，flow 里最多以"失败时看停因 next"一句
指回层 3，不展开。

### A3. 维护成本与单一出处 — 有保留
每层一个"出处模块 + 若干投放面 + 一条 prompt-hit 校验"是清晰，但校验层编号
已经在膨胀（6 → 8）。风险不在数量而在**编号耦合**：给校验层编号后，任何文档
说"第 7 层"都会在后续插入新层时失准。修改：prompt-hit 的输出从"6 层"计数式
改为**分组清单式**（grammar / pool / plan / bridge / doc / overview / coverage），
文档不再引用编号，引用组名。

### A4. 信息密度 — 不通过（必须修）
初稿完全没有长度预算。索引命中的概述若超过 ~500 字符会被截断；`amber --help`
塞入概述后总长接近一屏上限。修改：层 1 概述全文 ≤ 400 字符（中文），命令
`when` 每行 ≤ 40 字符；层 2 `flow` 每命令 ≤ 4 行；超限时校验层直接红
（长度也是契约）。

### A5. 与既有文档关系 — 通过（含保留）
PROMPT_SYSTEM.md 自我定位为"设计出处"清晰，与 AGENTS.md（指令枢纽）、
ARCHITECTURE.md（结构）不重叠。保留意见：AGENTS.md 嵌入 OVERVIEW_TEXT 后，
「仓库是什么」一节与概述有内容重叠风险——修改：AGENTS.md 的嵌入采用
"引用 + 逐字块"最小化，不重写原文。

### A6. 可验收性 — 不通过（必须修）
"提高上手/规划效率"没有判据。修改：补三条可验收判据：
① 新投放面零文案改动（只加渲染 + 一条校验）；② STOP_NEXT 覆盖率 =
(schema stopcodes 键集 − 豁免) / 键集 = 100%，由 prompt-hit 断言；
③ 首页/help/桥描述同一事实（max-steps 语义）三处文本逐字一致，抽查断言。

## B. Agent 调用者视角审查

### B1. 首用体验 — 有保留
概述里"模型只做选择票，不生成动作"足够纠正心智。但"从哪开始"同样踩 A1 的
PATH 坑。另：桥场景下 Agent **看不到 AGENTS.md**，插件描述是唯一层 1 入口，
初稿把桥描述放在"投放面"里但没说清它承载概述全文还是简版——修改：桥的
`OVERVIEW_TEXT` 生成物必须是**完整概述**（桥侧无其他来源），长度预算内不改写。

### B2. 规划效率 — 通过
`when` + `flow` 的组合能把"命令清单"变成"决策树"，粒度合适。建议：`apps`
命令的 flow 里显式写出五步法的 ④（--slot 逐分支离线校验），因为这是实测里
最常被漏的一步。

### B3. 失败自愈 — 有保留（两点必须修）
① 初稿 4.1 表里 `precondition_skipped` 的建议"误跳则修 when 条件"正确，但
缺"何时该停手上报"的出口。实测里 Agent 最危险的行为是**反复改脚本重跑真实
站点**。修改：STOP_NEXT 新增通用兜底规则（放 4.4）：同一停因修正后重跑仍出现
≥ 2 次 → 停手，如实上报 stopCode/reason 与已试过的修正，不再自行迭代。
② `needs_value` 的建议里"在 meta.slots 声明默认值"可能诱导 Agent 写入编造
默认值——修改措辞："值必须来自任务输入或数据源；没有真实值就如实返回
needs_value 给上游，不要造默认值"。

### B4. 信息可达性 — 有保留
`--json` 下层 2 可达性初稿只说了"同步带上"。事实核查：`amber help` 不走
envelope（`say(ctx, commandHelp(...))`，人类文本）；Agent 在 `--json` 模式
下拿 help 的正规通道不存在。修改：`amber help <cmd> --json` 输出结构化
CommandSpec（含 when/flow），与 GLOBAL_USAGE 的人类文本并存——这是层 2 的
关键投放面，必须显式实现。

### B5. 一致性风险 — 通过
单一出处 + 生成物纪律已消解；补强：A6-③ 的三处抽查断言写进 prompt-hit。

### B6. 升级兼容 — 有保留
schema 契约有 `schema: "amberflow.ctx-contract"` 但无版本字段；overview 节
加入会让旧快照全量漂移（这是预期）。修改：overview 节进入快照前先重建基线
（`amber schema ctx --out dist/schema/ctx.json`），并在 PROMPT_SYSTEM.md
标注"改 overview 必须重建快照"为流程的一部分。

## 必须修改项（合并，按优先级）

1. **P0**：`amber help <cmd> --json` 结构化输出（B4）——层 2 对 Agent 的
   正规通道，缺失则整套设计对 harness Agent 打折。
2. **P0**：概述"从哪开始"按调用环境分叉 + 桥侧承载完整概述（A1/B1）。
3. **P1**：长度预算进校验（A4）：概述 ≤400 字符、when ≤40、flow ≤4 行。
4. **P1**：STOP_NEXT 措辞修正（needs_value 不诱导造默认值）+ 停手出口
   规则（B3）。
5. **P1**：prompt-hit 校验改分组清单式，文档不引用层编号（A3）。
6. **P2**：可验收判据三条写入方案（A6）；快照重建纳入流程（B6）。

## 可选优化项

- `apps` flow 显式写 --slot 逐分支校验（B2 建议，顺手采纳）。
- AGENTS.md 嵌入采用最小逐字块（A5 保留意见，采纳）。
- overview 节带 `amber help` 互引（初稿已有，保留）。

## 迭代后的实施顺序（替代初稿 §6）

1. `src/support/help-map.ts`：OVERVIEW_TEXT（≤400 字符，含环境分叉的
   "从哪开始"）+ WHEN_TO_USE（每命令 when ≤40 字符）。
2. `registry.ts`：CommandSpec 增 `when?`/`flow?`；`commandHelp` 渲染；
   `help <cmd> --json` 结构化输出；GLOBAL_USAGE 头部概述、尾部 schema 互引。
3. `planning-playbook.ts`：STOP_NEXT 补全（修正措辞）+ EXEMPT_NEXT（带理由）
   + 停手兜底规则文本。
4. `schema-gen.ts`：overview 节（从 help-map 取）；`amber schema ctx --out`
   重建快照基线。
5. 桥生成物：grammar.generated.ts 增 OVERVIEW_TEXT；index.ts 插件描述接线。
6. prompt-hit：改分组清单式输出；新增 overview 组（AGENTS.md 逐字、长度预算、
   when 双向一致、桥同步）与 coverage 组（STOPCODE 键集 ⊆ NEXT ∪ EXEMPT、
   CLI next 无死链、三处 max-steps 文本一致抽查）。
7. 文档：AGENTS.md 嵌概述最小块 + 文档清单加 PROMPT_SYSTEM.md；
   `npm run check` 全绿。
