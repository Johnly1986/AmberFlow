# 语义模板与站点迁移方案（SemanticFlow）

**日期**：2026-10-10（2026-10-11 补齐红线机制与验收测试） ｜ **状态**：M1/M2/M3/M4 均已实现并实测（[M1 报告](SEMANTIC_FLOW_M1_REPORT.md)、[M3 报告](SEMANTIC_FLOW_M3_REPORT.md)）；验收对照见 §8
**一句话**：流程模板只携带**语义**，不携带站点选择器；运行时每步由 Laya 现场决策，首次访问的站点由 LLM 当"老师"点名、验证通过后**回填为 hint 缓存**——下次再跑，同一步就是零成本的规则命中。**模板迁移一次，站点收敛一次；越跑越便宜，越跑越确定。**

## 0. 需求原文

> 1. 用户输入"在携程上订一张5月18日昆明到北京价格最低的机票"
> 2. LLM/Agent 查看页面、提取参数、规划操作顺序（访问 → 点机票 → 输入出发地 → 输入到达地 → 搜索 → 选日期 → **判断最低价** → 购买）
> 3. 流程固化后，Laya 在每个节点做出选择和操作；下次调用时**模板可以迁移**（到别的站）。

## 1. 需求 → 能力三层

| 层 | 要什么 | 现状 |
|---|---|---|
| **L1 规划** | NL + 种子 URL → 逐步看页面生成计划 | ✅ 已有：`LLMPlanner`（snapshot 进 prompt、强制产 `target_hint`）+ `plan-cli new --llm --url` + replan |
| **L2 执行** | 每节点"选择和操作"由 Laya 决策 | ⚠️ 半个：executor 无 hint 时走 laya + reobserve + 置信/风险闸（已有）；但**好计划都带 hint，laya 出场被压制**——需要反转角色 |
| **L3 迁移** | 模板脱站点、跨站可用 | ⚠️ 半个：`transfer/specs` 已证明"同一 flow 数据在 7 个站点全绿"——但每个站点的 hint 是**人预先写进 spec 的**；不是运行时学出来的 |

**真正要造的只有一件事**：把 hint 从"人写的答案"变成"运行时学到的缓存"。其余全是既有机制的重新接线。

## 2. 核心机制：每步的三级解析 + 回填环

```
resolve(step, site):
  ① SiteProfile[site][step] 有已学 hint ──→ 规则解析，零模型零 token        （稳态）
  ② 没有 → 语义目标进元素池，Laya 现场选（conf 闸/风险闸/actionability 照旧） （拉丁页/data-test 页够用）
  ③ Laya 不过闸 → escalateFn：LLM 看同一份 criteria view，点名 ref
        成功且该步信号成立 → 候选 hint 写入 SiteProfile（下次起走 ①）
        失败 → blocked，如实报告（现行语义，不加戏）
```

- **完成判据不变**：每步仍以 DOM/URL 信号为唯一真值——LLM 只提名，不验收。
- **回填有门**：写回 SiteProfile 的 hint 必须**重放通过**（沿用 learn 的纪律：不可复现即不存）。
- **LLM 只在"第一次"出现**：迁移到新站的每个节点首次走 ②/③，二次起全站规则化。用户"下次调用模板可迁移"的体感 = 新站第一次稍慢且可能花钱，之后与固化脚本无异。

## 3. 数据结构（新增标 ●，复用标 ✓）

```jsonc
// pack spec_version: 2 —— 步骤模板（站点无关，进 apps/<id>/）
{
  "desc": "提交出发地+到达地搜索",                    // ✓ 语义步
  "semantic_target": {                                // ● 语义目标（代替硬 hint 成为模板默认）
    "role": "button", "near": "到达城市", "text": "搜索"
  },
  "signals_hint": ["[data-test=search-submit]"],      // ● 可选：已知站的先验，仅当 SiteProfile 命中时启用
  "slots": ["dcity","acity"],                          // ✓ 步级数据袋（值仍只来自计划）
  "signal": { "url_contains": "list" },               // ✓ 完成判据
  "when": {...}, "retries": 2                          // ✓ 原样
}
```

```jsonc
// sites/<host>.profile.json —— 运行时学到的站点档案（● 新文件族，人机两可读）
{
  "www.xc.com": {
    "steps": { "search-submit": { "hint": "button \"搜索\"", "replays_ok": 3, "conf_last": 0.71 } },
    "locale": "zh", "checkpoint": "multilingual",     // ✓ 复用 Router 的文字系统路由结论
    "tested": "2026-10-10", "frozen_signals": {...}   // 该站实测的信号形状
  }
}
```

```jsonc
// “判断最低价” = ● list_step（浏览器步内的数据腿，复用 datasource 的路径语言与 selects）
{
  "desc": "选最低价航班",
  "extract": { "row_path": "…flight-item", "fields": { "price": { "path": "…price", "op": "int" } } },
  "select":  { "op": "min", "by": "price" },           // ✓ 取数引擎的选择规则语义，搬进浏览器侧
  "act_on":  "row",                                     // 点击选中行（行句柄由抽取步盖戳）
  "signal":  { "css_text_contains": ["[data-test=selected-flight]", "…"] }
}
```

> **落地时的字段名对照（实现即准，2026-10-11 对齐）**：模板步骤用
> `semantic_target` / `semantic_targets`（有序多动作）/ `fills`（步级槽位名）/ `page` + `page_query`
> （页面角色 + 查询模板）/ `signal`（**页面角色契约** `{"page": …, "query": …}`）/ `when` / `retries` /
> `dangerous` / `list_step`；`signals_hint` 这一"已知站先验"由站点档案的 `steps`（authored hint，learned
> 覆盖 authored）与 `frozen_signals`（DOM 级信号先验）承担——**hint 绝不写进模板**（红线：plan/模板不种
> hint，hint 归运行期回填环）。`list_step` 的写法是
> `{ "op": "min"|"max", "by": "<字段>", "act": "row" }` + 档案 `list_extract`（`row_sel`/`fields[].sel|op`/`act_sel`），
> 选择走 `datasource.selectIndex`（与 `selects` 同一实现），**不是**独立的一套路径语言。

## 4. 端到端走一遍（用户剧本）

```bash
# ① 一句话 → 模板 + 首站档案
amberflow plan --goal "在携程订 5-18 昆明到北京最低价机票" --seed https://www.ctrip.com
#    LLM 逐步看页面出 plan（每步 semantic_target+signal 归纳）→ 人 y/n 确认 →
#    产出 apps/flight-cheapest/（模板）+ sites/www.ctrip.com.profile.json（学习成果，重放门控后）
#    —— 购买步自动标 dangerous，执行时 dry-run+确认，永远不在无人值守里下单

# ② 执行（可复现，零 token）
amberflow run --app flight-cheapest --site www.ctrip.com --slot date=2027-05-18

# ③ 迁移（这就是新能力）
amberflow run --app flight-cheapest --site flight.qunar.com
#    SiteProfile 空 → ②laya/③escalate 现场干活 → 成功步回填 →
#    终端如实报告：rule 6 · laya 1 · escalate 1 (written back 1) · blocked 0
#    第二次跑 qunar：rule 8 · 成本 0
```

## 5. 现实约束与对策（全部基于本仓实测，不粉饰）

| 约束 | 实测事实 | 对策 |
|---|---|---|
| laya 对 CJK 列表页零样本不可靠 | 0.03–0.15，hint 全删后 0/7（CLAUDE.md 钉住） | 中文站首次迁移**默认走 escalate 通道**（LLM 点名、laya 复核），不把担子压在 laya 上；站的文字系统结论落进档案 `locale`/`checkpoint`（`observeLocale`：`<html lang>` 优先，否则 CJK 占比），运行期据此选 checkpoint——同一判据落成数据，不靠置信度 |
| 真站改版 | wikipedia/python.org 实测多坑（假可见 rect、17 路 href 歧义） | hint 分级匹配已治（精确→末段→子串）；**已学 hint 连续 N 次（默认 2）没让信号成立 → 报 `drift` 并撤下该条目**（下次运行重新学），而不是硬跑 |
| "最低价"不能交给模型拍脑袋 | —— | 选择是**数据规则**，且与数据引擎是**同一个实现**：`list_step` 的 min/max 与 `datasource` 的 `selects` 都走 `selectIndex`（`order: min|max`），模型不产出"选哪行"的判断，只按句柄点行 |
| 自动化订票的合规/安全 | 真实站点 | 购买步 dangerous 硬闸：**先 dry-run 取证**（三级解析 + 只读 actionability 探针，页面一动不动）→ 人/`--allow-dangerous` 点头才真执行；部署级 allowlist；对外站点尊重站点条款与频控（探针家族的既有纪律） |

## 6. 里程碑与验收

| 期 | 交付 | 验收指标 |
|---|---|---|
| M1 | 三级解析 + SiteProfile 回填环（resolve 链进 executor，plan 产出 v2 模板） | 同一模板同站二跑：escalate 次数 → 0，成本 → 0 forwards（`tests/semantic.test.ts`） |
| M2 | list_step（extract/select/act_on） | 复刻站"最低价"步与 datasource 计算结果一致，且**共用同一实现**（`selectIndex`；`tests/semantic.test.ts` 的 M2 对拍 + `tests/datasource.test.ts` 的 min/max 边界） |
| M3 | `plan` 端到端 + 双站迁移演示（ctrip 模板 → qunar，含真站） | 迁移报告表：rule/laya/escalate/backfill 四列计数；第二站第二次全绿零模型（`tests/plan-flow.test.ts` 的双站 E2E） |
| M4 | DSH 面：`amberflow_plan` 工具 + `amberflow_run` 加 `site` 参 | 新会话一句话完成 §4 全剧本（`integrations/dsh-bridge/tests/bridge.spec.ts` 的 SemanticFlow door；真站部分仍需人工在生产环境确认） |

## 7. 红线（继承不谈判）

1. **DOM 信号唯一完成真值**——LLM/Laya 谁提名都不算数。落点：执行器只在"提名让信号成立"后
   `record`（`src/executor.ts` 的 goal-signal 分支）；③通道的提名同样要信号成立才回填。
2. **学习产物（hint/信号）必须过可复现重放才落盘**。落点：回填先进内存（`SiteProfileMemory`
   的 staged 模式），同一命令内的**整跑零模型重放**逐条验证，通过的才 `commitVerified` 落盘并
   `replays_ok+1`，其余按原值撤回（`backfill_gate: verified|unverified`）。`--no-verify-backfill`
   是显式消融口：按现状落盘、`replays_ok` 停在 0，报告面记 `skipped`——"没验过"永远看得见。
3. **不可逆动作永远 dry-run + 人确认**。落点：`dangerous` 步先走执行器 `dryRun`（三级解析 +
   只读 actionability 探针 `isVisible/isEnabled/中心 hit-test`，不点不填不滚动），拿到"会点到什么"
   的证据后才问 `--allow-dangerous` / `confirmDangerous(step, evidence)`；干跑不成立 = 直接拒绝。
4. **值只来自数据袋**——NL 输入解析出的"5月18日/昆明/北京"进 slots，模型执行期不得改值；
   `{slot}` 只替换已声明的槽位，未声明即编译期报错。

## 8. 验收对照（每条指标钉在哪个测试）

| 文档预期 | 测试（当前全绿） |
|---|---|
| M1 二跑 escalate/laya → 0 | `tests/semantic.test.ts` 首跑/二跑/跨站/③通道 4 条 |
| 回填有门（红线 2） | `tests/semantic.test.ts`：staged/撤回/还原/readOnly 单测 + `once-app` 端到端（重放不可复现 → 撤回、档案 `steps: {}`）+ 消融对照 |
| M2 与数据引擎同一口径 | `tests/semantic.test.ts` M2 对拍（独立读复刻站票价表 → `selectBest` vs 浏览器步选中行）+ `tests/datasource.test.ts` 的 `selectIndex` min/max/缺值/并列 |
| M3 报告四列 + 双站二跑零模型 | `tests/semantic.test.ts` 报告面一条 + `tests/plan-flow.test.ts` 双站迁移 E2E |
| 重放门（走 walk 全绿也要拦） | `tests/plan-flow.test.ts`：`replay gate FAILED`（方案重复步 id）+ 信号不可复现两条，均断言磁盘无半成品 |
| §5 drift | `tests/semantic.test.ts`：已学 hint 连续失败到阈值 → `drift` 上报 + 条目撤下 |
| §3 locale/checkpoint | `observeLocale` 单测 + 档案 checkpoint 决定模型面 + plan 首访观察进档案 + 坏值加载期报错 |
| ⑦ 红线 3 dry-run | `tests/semantic.test.ts`：执行器 dry-run 不改页面、拒绝带证据、确认后真执行、二跑走已学 hint |
| 出厂产物不漂移 | `tests/semantic.test.ts`：遍历 `apps/*/flow.json`，逐站校验模板/档案/编译 |
| M4 DSH 面 | `integrations/dsh-bridge/tests/bridge.spec.ts`（SemanticFlow door：清单/argv/摘要/注册表/plan 门）+ `npm run test:bridge:offline` |

> 真站（`--seed https://www.ctrip.com`）仍是**未验证的外推**：规划循环、归纳三关、门控在复刻站
> 全绿；真站需生产环境人工确认（LLM planner 接真 endpoint + 真站页面角色适配）。
