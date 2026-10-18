# 用线上模型审查测试（2026-10-17）

> 审查对象：**S0 提名考卷**（决策模型）与 **SystemTwo 真链路**（LLM 规划器/老师）。
> 线上服务：token-plan MaaS 网关（见 [DECISION_PROVIDER_TOKENPLAN.md](DECISION_PROVIDER_TOKENPLAN.md)）——
> 决策模型 `decision-model-preview`（SystemOne 协议）· LLM `qwen3.8-flash`（OpenAI 兼容通道）。
> 纪律：凭据只从环境读；网络臂不进 CI（CI 只跑假服务契约测试）；**跳过 ≠ 通过**，失败如实记。

## 0. 这轮为什么做

上一轮把线上决策模型接进了 provider 缝，但只验证了"接得上"（线协议 + 应用套件）。
"S0 提名实验台"是仓库里**唯一在考'模型判断力'的考卷**（指令提名，NL Flow S2 ③ 档的可行性依据），
而它当时的 model 臂只有**本地 laya** 的账（4.8%，远低于零智能基线）。本轮用它来问三件事：

1. 把 ③ 档换成一个**更强的线上决策模型**，S0 的结论会变吗？（③ 能不能进关键路径）
2. 线上 **LLM 真链路**（qwen3.8-flash）在"规划器"和"老师"两条通道上到底能不能用？
3. 这两次真跑暴露的系统缺陷，修掉。

## 1. S0 考卷复测：线上决策模型参加"指令提名"

**考卷**：与 S0 冻结产物**同一份收集器**——14 个离线旅程包 / 165 条有真值的浏览器步
（真值 = 这步在生产循环里**实际执行了什么**，来自 trace，不是声明猜的）。
**问法**：与 S0 同一份 `nominationInstructions`（本轮把它抽成单一出处，S0 与运行期共用），
选项 = 指令闭集，答案必须落在闭集内。

| 臂 | 正确率 | 弃权 | 说明 |
|---|---|---|---|
| rules（① 关键词梯级） | 36/165 = **21.8%** | 45 | 确定性；没命中 = 弃权 |
| first-candidate（基线） | 85/165 = **51.5%** | 0 | 永远答 click |
| 本地 laya（S0 冻结账 2026-10-15） | 8/165 = **4.8%** | — | 本地模型，模型臂的唯一既有读数 |
| **线上 decision-model-preview（③）** | **41/165 = 24.8%** | **0** | 165 次咨询，总 90.8 s（均 550 ms / p50 454 ms） |

**按真值拆分**（线上臂：click 41/85、fill **0/14**、select **0/66**）。**错成什么**（混淆）：
select 真值 → list_pick×36、click×30；fill 真值 → click×14；click 真值 → list_pick×41、check×3。

### 读数与裁定

- **③ 仍然不高于零智能基线**：41 < 85。这**不是"模型不够强"**——线上模型把本地 laya 的 8 提到 41（5×），
  但题形状（desc-only：state 只有 `{goal: desc}`，无页面）的天花板比模型强度更决定结果。
- **它从不弃权**（0 弃权），且大量塌缩到 `list_pick`（"最低价"类措辞的引力）；
  fill/select 两类真值全错——决策模型对"这是哪种操作"没有可用的先验。
- **裁定（按设计文档 §10-S0 的停止条件执行）**：③ 维持**可选、不接线**；运行期承重仍是
  ①②⑤（规则 + 已学映射 + 枚举裁决）。这条判断在"换更强的线上模型"后**依然成立**——
  这正是本轮审查要证伪而没能证伪的东西。
- 与本地 laya 的差别要按"另一场考试"读：换权重/服务 = 换考卷，数字不迁移（同 graph_sha256 纪律）。

产物：`bench/instruction-nomination-online/nomination-online.json` + `REPORT.md`。
**重要读法（修正在此之后）**：这组 41/165 的读数**不能当能力证据**——逐行复核发现考卷有三层偏倚
（题面无状态 83/165 行同一句话跨应用真值不同、标签取 trace 首动作仅 44.8% 的题面读得出、语料排除
list/check 导致闭集 2/5 结构性不可对、97.6% 的错误是"按文字作答 vs 按实现判分"的错位），见
[NOMINATION_QUESTION_SET_ANALYSIS.md](NOMINATION_QUESTION_SET_ANALYSIS.md)。③ 不接线的依据因此改为
**边际读数**（rules 弃权 45 行上模型只对 3 行），而不是 24.8% < 51.5% 这个被标签污染的对比。

**后续（2026-10-18，S0-v2）**：把页面上下文补进题面后，同一考卷 **24.8% → 63.6%**；候选按页面条件化后
**88.5%**（歧义组 **92.8%**）——见 NOMINATION_QUESTION_SET_ANALYSIS.md §6。**③ 的可行性取决于问法构造**，
运行期接线仍是未做项。
（逐行预测与混淆矩阵在内；离线部分可用 `npm run nominate:online -- --check` 复算）。
**不替代** S0 冻结产物（`bench/instruction-nomination/` 仍是本地 laya 的账）。

## 2. SystemTwo 真链路：qwen3.8-flash

同一网关的 OpenAI 兼容通道（`OPENAI_BASE_URL` + `OPENAI_API_KEY` + `PLANNER_MODEL=qwen3.8-flash`），
两条通道分别是 `plan:flow --planner llm`（规划器）与 `npm run semantic -- --laya unsure --escalate llm`（老师）。

### 2.1 老师（④ 档）通道：**可用，且真的产出了被重放门验证的学习**

```
解析级：rule 1 · laya 0 · escalate 3 (written back 3) · list 1 · blocked 0
不变量：{"all_of":[{"url_contains":"done.html"},{"url_contains":"order="}]} 成立
```

5 步旅程里 3 步由 qwen3.8-flash 老师点名目标（进入机票频道 / 选日期 / 购买），
**3 条都被回填环重放验证后落盘**；list 步骤选中 ¥980（最低价）；危险步干跑证据指名
`button "购买"`。**结论：④ 档在真 LLM 上成立**（与"可换 provider"的抽象一致——
老师只是又一个 `EscalatorLike`，不碰执行器）。

### 2.2 规划器通道：**能规划，但不稳定；失败全部被门拦下（无假绿）**

| 轮次 | 超时 | 结果 |
|---|---|---|
| 1 | 120 s | 规划 4 步（含 list 选最低价），**重放门 FAILED**：`fill_and_search_flight: action space exhausted on step 1`——未落盘 |
| 2 | 120 s | 规划 2 步后**第 3 次规划调用超时**（120 s）→ 响亮报错、未落盘 |
| 3 | 300 s | 规划 4 步成功演示，但**目标达成后仍提议 step-5**（页面不再推进 → `did not advance the page`）→ 未落盘 |
| 4 | 300 s | **规划出 12 步的循环**（重复 id、把 list 步标 dangerous）→ 重放门 FAILED：`duplicated` / `a list step cannot be dangerous`，未落盘 |

对照：同一提示词下 `deepseek-v4-pro` 一轮跑通 5 步（重放门通过、落盘、回放二跑零模型），
证据在 [bench/llm-planned/](../bench/llm-planned/README.md)。**模型适配性是真实变量**：
qwen3.8-flash 在"老师"上稳，在"规划器"上会（a）声明不足以重放、（b）大页面上下文超时、
（c）目标达成后不停手、（d）**一步循环成 12 步**（重复 id / list 步误标 dangerous）。
四条都是**模型行为问题**，被系统的门如实拦下（规划期两次演示 + 重放门的**加载期校验** ⊂ 红线④），
不是"接错了线"——**门的价值就在这：四轮里没有一轮写出坏模板**。

### 2.3 本轮因此修掉的系统缺陷

1. **重放门失败诊断不定位**：真 LLM 规划时只报 `action space exhausted on step 1`，看不出是哪条**声明**
   解不出来。现在被拦步会带上模板声明形状：`targets=[…] ｜ fills=[…] ｜ list_step={…}`（见 §2.2 轮次 1）。
2. **规划调用超时/网络错不能吞**（上一轮已修，本轮在 flash 上再次验证生效）：轮次 2 直接印出
   `规划停止：调用失败（网络/HTTP）——已抛出，本次未落盘`，没有写出 1 步假绿模板。
3. **超时口径可配**：`PLANNER_TIMEOUT` 在 flash 的大页面上确实需要（120 s → 300 s 才能跑完第 3、4 步）。

## 3. 系统迭代：这轮加/改了什么

1. **provider 缝新增闭集选择能力**（`DecisionProvider.askChoice`，`src/decision-provider.ts` +
   `src/system-one-client.ts` + `layaProvider`）：S2 ③ 提名的题形状——**不依赖页面元素池**，
   选项由调用方给。SystemOne 家族（百炼 / token-plan）自动获得；没实现的 provider = 没有这个能力，
   梯级按"③ 弃权"往下走（fail closed）。**S0 与运行期因此共用一条接线**。
2. **单一出处的提名问法**（`src/nominate.ts` 的 `nominationInstructions` / `providerNominationAsk`）：
   措辞影响行为，改 = 换考卷，S0 与本工具都读这一份。
3. **S0 实验台新增线上审查模式**：`npm run nominate:online`（`--provider <name>`）——
   写**独立产物**（默认 `bench/instruction-nomination-online/`），不碰冻结的 S0 产物；
   `--check` 复算离线部分（语料/闭集/三臂），线上臂标注"网络臂，未比（跳过 ≠ 通过）"。
4. **规划重放门诊断**（§2.3-1）；**非推进步的报错**点名"目标达成后不肯停手"这一真实形态
   （qwen3.8-flash 实测），并在 `plan:flow` 的 USAGE 里点名 `PLANNER_MODEL` / `PLANNER_TIMEOUT`
   （真跑要用、且推理模型建议 ≥300 s）。
5. **不接线决定**：线上 ③ 仍低于基线 ⇒ 运行期不接 ③（`src/nominate.ts` 头注释与本文记录裁定）。
6. 测试：`askChoice` 契约（laya 适配器 + token-plan 假服务）、`providerNominationAsk` 接线
   （题面/闭集/池外弃权/梯级集成）、S0 计分重构成共用 `scoreArm`。

## 4. 边界（诚实清单）

- **单次运行、单服务版本**：线上服务的权重/版本漂移会让数字变化；不是统计重采样。
- **desc-only 问法**：③ 在**带页面状态**的条件下没测；本仓的运行期提名器本来也不该在无页面时问模型。
- **模型矩阵只有一个样本**：deepseek-v4-pro 1 轮通过、qwen3.8-flash 4 轮（见 §2.2）——结论是
  "该任务上 flash 的规划器不可靠"，不是"flash 不行"；老师通道上 flash 表现稳定。
- **不进 CI**：两条线上通道都是网络臂；CI 只跑假服务契约与离线门禁（`npm run verify` /
  `bench/smoke.sh`）。重跑本审查需要环境变量（见各命令）。
