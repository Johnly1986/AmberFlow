# 审查意见 B — Agent 调用者视角

角色设定：你是一个真实接入 AmberFlow 的调用方 Agent（运行在 Claude Code / Codex /
WorkBuddy 之一的 harness 里，通过 CLI 与 DSH 桥工具调引擎，读不到引擎源码，
只能看到提示词面）。审查对象是 docs/PROMPT_SYSTEM.md 的三层设计，以及它声称
要改造的现有提示词面（registry.ts 的 help、planning-playbook 的 STOP_NEXT、
schema-gen 的契约、AGENTS.md）。

审查维度（逐项给出 通过 / 有保留 / 不通过 + 理由 + 修改建议）：

1. **首用体验**：假设你只有插件索引里的一段概述（层 1）。这段概述是否足以让你
   纠正"直接写 Playwright 脚本"的错误心智？你是否能判断"这个任务该不该用
   AmberFlow"？"从哪开始"给的命令你是否能直接执行（考虑 npx 挂住、PATH 不在
   等已知坑）？
2. **规划效率**：拿到一个"在 X 网站上自动做 Y"的任务，层 2 的 help 面（usage/
   flow/flags）是否能让你不经试错就排出正确命令序列（inspect → 探针 → 参数化
   → check → run）？flow 字段的粒度是否合适？
3. **失败自愈**：模拟你遇到了 `low_confidence` / `needs_value` /
   `arrive_signal_not_held` / `host_not_allowed` / `budget_exceeded` 停因。
   层 3 的 next 建议是否足以让你不重试、不放弃、直接修正？有没有你实际会踩
   但方案没覆盖的失败（例如：next 建议让你跑 `apps check`，但 check 通过后
   重跑还是同一个停因——建议里有没有"何时该停手上报人类"的出口）？
4. **信息可达性**：你在 harness 里能看到的面与人类用户不同（JSON envelope、
   工具描述、错误块）。三层的投放面矩阵是否覆盖了你真实的信息入口？
   `--json` 模式下层 2 的 flow 字段是否可靠可达？
5. **一致性风险**：如果层 1 的 AGENTS.md 嵌入、层 2 的 help、层 3 的停因
   三处对同一事实表述不一致（比如 max-steps 的语义），你更信谁？设计里的
   单一出处纪律是否真的消解了这个风险？
6. **升级兼容**：桥工具描述、schema 契约、help 文案随版本变化时，你缓存的
   旧知识会不会与新版本冲突？设计是否有版本锚点（schema_version 之类）的
   考虑？

输出格式：每维度一段，最后给出【必须修改项】清单（按优先级排序）与
【可选优化项】清单。审查必须基于文档原文与既有代码事实，不得虚构。
