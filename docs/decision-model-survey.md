# 决策模型应用调研与设计改进（2026-10）

目标：参考现有决策模型应用的设计，**只采纳对本项目有实测优势的部分**。每条给出对方做法、
本项目现状、决定与证据；未被采纳的同样记录原因（避免下次重复调研）。

## 调研对象

| 参照 | 是什么 | 关键设计点 |
|---|---|---|
| [C3-R / Decision-Laya-421M](https://huggingface.co/ColomboAI/C3R-Decision-Laya-421M-v0.1) | **与本项目同基座**的决策模型应用（`convaiinnovations/laya` + `laya==0.3.5`） | System-One 快路径（laya）＋ 独立的深思路径（LLM）；**弃权是一等结果**（校准缺失 / 置信度低 / **top-two 间隔小**）；要求切片级校准后才做决策 |
| [browser-use: The Bitter Lesson of Browser Agents](https://browser-use.com/posts/bitter-lesson-browser-agents) | 浏览器 agent 框架 | **观测瓶颈**："按钮就在那儿，是我们没让模型看见"；随模型变强改为让模型自选观测（raw CDP / 截图 / 写代码） |
| [muscle-mem](https://github.com/pig-dot-dev/muscle-mem)、Stateless Decision Memory | agent 记忆/缓存 | 把已决策的行为缓存并在下次重放 |
| [Playwright 自愈（self-healing）落地](https://cloud.tencent.com.cn/developer/article/2733791) | 浏览器自动化工程实践 | 多策略定位回退（主选择器失败就换备选） |
| `laya/presets.py`（随包附带） | 模型作者自带的提问集 | `guard_questions()` / `moderation_questions()` / `router_questions()` / `triage_questions()` |

## 逐条判断

| 参照的做法 | 本项目现状 | 决定 | 证据 |
|---|---|---|---|
| **观测瓶颈**：模型只能从被展示的元素里选 | 元素池上限 40；只有"计划点名了 hint"才会 JS 回捞（`hintLookup`） | **采纳**——低置信时加一次"加宽观察"（40 → 120 元素）再决策 | 机制 A/B：70 个诱饵按钮把真目标挤出预算 → 关掉重观察**阻塞**（`low confidence 0.0x < floor 0.25`）、打开则**恢复**且轨迹记录 `laya:reobserve`（`tests/reobserve.test.ts`） |
| **决策缓存**：重放已决策行为 | laya 是确定性的，但每次 pick 都真实前向；重试/重规划/续跑/消融会重复问同一问题 | **采纳**——`withDecisionCache`（精确键 = 状态指纹 + 问题指纹，可整体关闭）＋ JSONL 决策日志 | 真模型、同一份计划跑两遍：无缓存 **12 次前向**（每遍 6 次），有缓存**共 6 次**——**第二遍 0 次前向、9.2s → 1.3s**（`tools/cache_measure.ts`）。键包含完整状态与问题，页面一变即 miss，不存在"陈旧命中" |
| **弃权信号之一：top-two 间隔** | 只有置信度地板（0.25） | **先采纳为诊断**（轨迹里记录 `margin`），门限待实测后再决定 | 已入库；见下"下一轮" |
| **快路径 + 深思路径分层** | 规则 → laya →（本轮新增）重观察 → 停止 / 人工确认 | **部分采纳**：补上"重观察"这一级；pick 级 LLM 升级见"下一轮" | 同上；现有 LLM 只用于 replan 与审计 |
| **让模型自选观测 / 写代码（raw CDP）** | 冻结计划 + 规则优先 + 完成只认 DOM 信号 | **不采纳** | 与本项目的三条硬约束冲突（不重规划、不发明取值、完成只认 DOM 信号）。对方的前提是"模型足够强到可以自由行动"，本项目的目标是"模型不可信时流程仍然可控"；观测瓶颈这一**问题**被采纳，其**解法**（放弃受控观测）不被采纳 |
| **多策略定位回退（自愈）** | hint 已分级（精确属性 → 末段路径 → 全子串）、计划点名优先、元素签名禁选、重观察 | **已有**，无需改动 | 线上包 8/8、11/11 子目标全部 `rule:match`（零模型选择） |
| **模型作者自带的注入问句**（`guard_questions().prompt_injection`） | 手写的攻击问句，阈值 0.95（`path-a.ts`） | **不采纳** | 三页实测（真模型，`src/tune-guard.ts`）：preset 措辞在正常页给 **0.969 / 0.930**，**超过 0.95 阈值** → 会把正常页误判为注入；我们的 A 措辞是 **0.907 / 0.940**，恰在阈值下，攻击页三者都是 1.000。preset 是为"用户提示词"调的，不是为"页面文本" |

## 本轮落地（都有测试与数字）

1. **低置信重观察** `src/executor.ts`（`RunOptions.reobserve`，默认开）
   - 只在"即将停止"的失败路径付费：一次加宽抽取（`WIDER_ELEMENTS=120`）+ 重新决策；命中则轨迹记 `laya:reobserve`，审计可见。
   - 抽取层的预算变成参数（`extractElements(page, jsProbe, maxElements)`），默认不变。
2. **决策缓存 + 决策日志** `src/decision-cache.ts`
   - 精确键（状态 + 问题指纹，`sha1`）、插入序淘汰、`decisionStats()`、`resetDecisionCache()`；日志每行一条决策（含 `cached` 标记），是"可重放轨迹"的一半。
   - 实测：无缓存 12 次前向 / 第二遍 9.2s；有缓存共 6 次前向 / 第二遍 **0 次前向、1.3s**；缓存外侧/内侧计数差异也暴露过一个测量陷阱（命中不能算前向），已修。
3. **top-two 间隔诊断**：轨迹的每一步在 `method` 为 `laya*` 时附带 `margin`（数值），为下一轮的弃权门提供数据。
4. **顺手修掉一个引擎边界缺陷**：决策分布为空时 `Math.max()` 返回 `-Infinity`，停止原因会打印 `low confidence -Infinity`；现在回落到答案自带的置信度。

## 下一轮（明确待办）

1. **测 margin 是否值得当门**：用已入库的 `margin` 跑夹具矩阵与线上包，看"好 pick"与"坏 pick（惰性/后续失败）"的 margin 分布是否分离；分离则加 `marginFloor`（C3-R 式弃权），不分离就只保留诊断。
2. **pick 级 LLM 升级（C3-R 的深思路径）**：在"重观察之后、停止之前"加 `escalateFn(instruction, criteria)`；离线用假函数测机制，线上需要 `OPENAI_*`。
3. **切片级校准门**：C3-R 要求"校准不足则不决策"。项目已有 `eceScore`，可记录每语种/每问题类型的 ECE，并在校准不足时弃权而不是硬猜（英文 checkpoint 在 CJK 上的 ECE 0.855 是现成例子）。

## 未能核实的部分（诚实说明）

C3-R 的两篇论文是 PDF，本轮只读了它的模型卡摘要（上表"关键设计点"来自模型卡文字）；
"切片级校准"的具体算法与门限未读原文，因此本轮只做了与已读部分对应的两处改动，未按其完整协议实现。
