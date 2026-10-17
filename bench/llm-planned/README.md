# 首个真 LLM 规划闭环的产物（证据归档）

> 生成时间：2026-10-15 ｜ 模型：`deepseek-v4-pro`（token-plan MaaS 网关，OpenAI 兼容通道）
> 命令与前置条件见 [docs/DECISION_PROVIDER_TOKENPLAN.md §5](../../docs/DECISION_PROVIDER_TOKENPLAN.md)
> ｜ 归档原因：真实 LLM 端点跑一遍才能暴露"已就位但从未真跑"的适配缺陷（本次抓到 6 处，
> 全部已修，回归见 `tests/plan-flow.test.ts`）——这份模板是"修完之后真的能规划出来"的证据。

## 它是什么

`plan:flow --planner llm`（一句话 + 种子页 → 逐步看页面 → 两次独立演示归纳完成信号 →
模板 + 站点档案 → 重放门控整跑）在**真模型**下的产物：

```bash
export OPENAI_BASE_URL='https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
export OPENAI_API_KEY='<token-plan 的 token>'
export PLANNER_MODEL='deepseek-v4-pro'
npm run plan:flow -- --goal "在云程旅行订5月18日昆明到北京价格最低的机票" \
  --seed semantic/site-a/index.html --app llm-probe-e --site site-a \
  --planner llm --yes --allow-dangerous-demo
# 门控：rule 0 · laya 4 · escalate 0 (written back 4) · list 1 · blocked 0  ✓ 落盘
```

产出的 `flow.json`（本目录同名文件，逐字节复制自落盘物）：

- 5 步：进入机票搜索页 → 填两城+搜索 → 选日期 → **list 步骤选最低价** → 购买（自动标 `dangerous`）；
- 槽位从目标文本提取（`date_label` / `date_code` / `from` / `to` 等）；
- 完成判据全部是**观察到的页面角色**，模板里零站点选择器；
- 站点档案 `site-a.profile.json`（本目录）记录页面角色/查询参数/值绑定/行抽取。

## 回放证据（同一份模板 + 档案）

```bash
# 首跑：laya 现场解析 4 步 + 回填 4 条 hint（重放门内验证）
npm run semantic -- --app llm-probe-e --site site-a --laya scripted --allow-dangerous \
  --profile-dir /tmp/llm-replay-prof --out /tmp/llm-replay-out1
# → 解析级：rule 0 · laya 4 · escalate 0 (written back 4) · list 1 · blocked 0

# 二跑：同一份档案（零模型）
npm run semantic -- --app llm-probe-e --site site-a --laya scripted --allow-dangerous \
  --profile-dir /tmp/llm-replay-prof --out /tmp/llm-replay-out2
# → 解析级：rule 4 · laya 0 · escalate 0 (written back 0) · list 1 · blocked 0
```

**边界（不吹过头）**：这是**一个**目标在一个复刻站上的一次真跑，不是统计结论；换个模型/站点要重测。
模板里的中文页面角色名（如「航班预订页面」）来自模型，能跑但不是有意设计；产物不经审计，
只作证据归档——真正进 `apps/` 的模板仍须过 `plan:flow` 的重放门与仓库的审计纪律。
