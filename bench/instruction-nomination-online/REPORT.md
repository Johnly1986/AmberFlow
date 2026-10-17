# S0 线上决策模型审查（③ 提名窄问换 provider）

- 生成：2026-10-17T17:37:37.760Z ｜ provider：**token-plan decision-model-preview**
- 语料：14 包 / 165 步（跳过 5）——与 S0 冻结产物同一份收集器
- 问法：同一份 `nominationInstructions`（S0 与本审查共用单一出处）；选项 = 指令闭集
- 代价：165 次咨询，总 90.8 s（均值 550.5 ms / p50 454 ms）

| 臂 | 正确率 | 弃权 | 说明 |
|---|---|---|---|
| rules（①关键词梯级） | 36/165 (21.8%) | 45 | 确定性；未命中弃权 |
| first-candidate（基线） | 85/165 (51.5%) | 0 | 永远答 click |
| 本地 laya（S0 冻结账） | 8/165 (4.8%) | — | 2026-10-15 冻结产物（on） |
| **线上 token-plan（③）** | **41/165 (24.8%)** | 0 | score_kind=calibrated_prob |

## 按真值拆分

| 真值 | 条数 | rules 命中 | 线上 ③ 命中 |
|---|---|---|---|
| click | 85 | 34 | 41 |
| fill | 14 | 1 | 0 |
| select | 66 | 1 | 0 |

## 错成什么（线上 ③ 的混淆，只列错行）

- 真值 select → click×30、list_pick×36
- 真值 fill → click×14
- 真值 click → list_pick×41、check×3

## 对设计文档停止条件的读数（只报告，不裁定）

- ③ vs 基线：线上 41 / first-candidate 85（总 165） ⇒ **不高于**基线
- ③ vs ①规则：41 vs 36 ⇒ 高于确定性梯级
- 与本地 laya 的差：41 vs 8（同一份考卷、不同模型——不是"同模型换问法"）

## 口径边界（诚实清单）

- **desc-only 问法**（state 只有 `{goal: desc}`，无页面）：这是"不依赖页面的提名"的下界；运行期提名器可以带页面状态，那一档没测。
- **一份权重/一个服务**：换 provider 的权重或服务版本 = 另一场考试，数字不迁移（同 S0 model 臂的 graph_sha256 纪律）。
- **单次运行**，不是统计重采样；线上服务有网络抖动（延迟列在产物里）。
- 本产物**不替代** S0 冻结产物（`bench/instruction-nomination/`）：那份仍是本地 laya 的账。

复算：`TOKEN_PLAN_ENDPOINT=… TOKEN_PLAN_API_KEY=… node --experimental-strip-types tools/instruction_nomination.ts --provider token-plan`