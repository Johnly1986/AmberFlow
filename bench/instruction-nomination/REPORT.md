# S0 指令提名实验（NL Flow）

- 生成：2026-10-17T05:01:27.896Z ｜ 语料：14 包 / 165 步（跳过 5）
- 真值：已验收语料的**实际执行**（生产循环 trace 的 how/desc），不是声明猜的
- model 臂：**on**（convaiinnovations/laya (+multilingual)）——SKIP 不是通过

| 臂 | 正确率 | 弃权 | 备注 |
|---|---|---|---|
| rules（①关键词梯级） | 36/165 (21.8%) | 45 | 数据规则优先；未命中弃权 |
| first-candidate（基线） | 85/165 (51.5%) | 0 | 永远答 click——新问法要先赢的线 |
| model（③窄问） | 8/165 (4.8%) | 0 | on |
| enumeration（⑤裁决序） | 首位命中 85/165 (51.5%)；序内命中 165/165 (100.0%) | 0 | 真值平均位置 0.88（0 起算） |

## 按真值拆分（rules 臂 / model 臂）

| 真值 | 条数 | rules 命中 | model 命中 |
|---|---|---|---|
| click | 85 | 34 | 2 |
| fill | 14 | 1 | 1 |
| select | 66 | 1 | 5 |

## 对设计文档停止条件的读数（只报告，不裁定）

- ③ vs 基线：model 8 / first-candidate 85（总 165） ⇒ model 臂**不高于**基线
- ⑤ 兜底：枚举序首位命中 85/165，序内命中 165/165 ⇒ 裁决兜回来的代价 = 平均再试 0.88 条指令

## 口径边界（诚实清单）

- **本数是"NL desc 单独够不够"的下界**：问句 state 只装 `{goal: desc}`（无页面）。S2 运行期提名器**可以**看当次页面（执行器实测问法含 `main_text`）——本工具刻意不装，量的是"不依赖页面的提名"这一档的真实水位。
- **model 臂塌缩现象**：多数行答 `list_pick`（desc 里的"最低价/排序"字样关键词捕获，与 ① 规则臂同因）。逐行预测在 `nomination.json` 的 `predictions`，可复核。换问法（短标签 / 带页面 state）是合法的下一步（ask-shapes 先例），换一次重跑一次、各记各数。
- **⑤ 的 100% 覆盖是真值分布的性质**：本语料真值 ∈ {click, fill, select}，声明序恰好覆盖；新指令进闭集时要同步看这一列。

复算：`node --experimental-strip-types tools/instruction_nomination.ts --out /root/coding/AmberFlow/bench/instruction-nomination`