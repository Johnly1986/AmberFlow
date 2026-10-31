# 统一提示词系统（三层级）

状态：现行设计。目标：让任意 Harness（Claude Code、Codex、WorkBuddy、DSH 桥调用方）的
Agent 在三个时机拿到同一出处的提示词——**索引命中时知道这是什么（层 1）、help 时知道
怎么干（层 2）、失败时知道怎么回去（层 3）**——且每一句话只有一个可修改的出处。

范围：Agent 可见的提示词面。不在范围：执行器内部算法、决策模型协议。

---

## 0. 现状调研（2026-10-30）

### 已有的"单一出处"资产

| 出处 | 内容 | 已投放面 |
|---|---|---|
| `src/cli/registry.ts` | 命令表（name/summary/usage/flags） | `amber --help` / `amber help <cmd>` |
| `src/engine/grammar-prompt.ts` | hint 六形状、信号算子、属性匹配模型 | executor 停因、plan promptText、桥生成物、文档 |
| `src/engine/planning-playbook.ts` | 五步法、失败特征速查、STOP_NEXT 停因→下一步 | apps new 骨架、inspect next、run 失败 next、桥、文档 |
| `src/support/schema-gen.ts` | 引擎语义契约（facts/signals/…/stopcodes 九节） | `amber schema ctx`（快照 + `--check` 防漂移） |
| `tools/prompt-hit.ts` | 六层离线闸门 | `npm run check` |
| `AGENTS.md` | 跨 harness 的 Agent 指令枢纽 | Claude Code（经 CLAUDE.md 薄壳）等 |

### 与目标的差距

1. **层 1 缺位**：AGENTS.md 是"仓库工程指南"，不是"引擎概述"。插件/skill 索引工具
   （如 DSH 的插件列表、skill 索引）命中的是一段安装说明，Agent 无法在 10 秒内知道
   "这是什么、什么时候用我、从哪个命令开始"。桥工具描述各写各的，没有统一的概述段。
2. **层 2 半成品**：registry 只有 usage/flags，缺"实践流程"（先 inspect 再写、
   探针先行等五步法只在文档与骨架注释里，help 面看不到）；命令之间的流程关系
   （check → explain → run 的调试回路）没有结构化表达；`amber help` 与
   `amber schema ctx` 两套自描述面互不知晓。
3. **层 3 覆盖不全**：`STOP_NEXT` 只收了 6 个实测停因，schema 的 stopcodes 节有
   20 个键，多数 `next: null`（宁可不建议也不泛泛而谈的纪律是对的，但其中
   `config_error`/`host_not_allowed`/`invariant_failed` 等高频停因显然有明确回
   流路径，只是没收录）；CLI 用法错误（`CliError` 的 hint/next）各自手写，没有
   与 playbook 同源。
4. **维护性**：文档与代码之间的"逐字嵌入"靠 prompt-hit 逐条钉，新增投放面时
   要人工记得加校验层；没有一张"哪句话从哪来、投放到哪"的总账。

### 设计原则（沿用仓库既有纪律）

- **单一出处**：每句话只有一个可修改的模块；其他面全部由它渲染或逐字嵌入。
- **数据优先于文案**：表从真源 import（`SIGNAL_OPS` / `COMMAND_OPS` / `STOP_NEXT`），
  文案只写在叶子模块里。
- **防漂移**：所有投放面进 `npm run check`（prompt-hit / schema `--check`），
  漂移即红。
- **桥纪律 "called, not embedded"**：桥不 import 引擎代码，跨边界走生成物。

---

## 1. 三层定义

| 层 | 命中时机 | 回答的问题 | 载体 |
|---|---|---|---|
| **层 1 概述层** | 索引工具命中插件/skill、Agent 首次接触、`amber` 无参首页 | 这是什么？什么时候用？从哪开始？ | `OVERVIEW_TEXT` + 各命令一行"何时用" |
| **层 2 工具层** | `amber help` / `amber <cmd> --help` / `amber schema ctx` | 能干什么？怎么干？按什么流程干？参数怎么填？ | registry 的 flow 字段 + help-map + schema 契约 |
| **层 3 提示层** | 命令失败、运行停因、流程受阻 | 我卡在哪？怎么回到正确流程？ | `STOP_NEXT` 全量收录 + `CliError` hint/next 同源 + 停因 reason 自带修正指引 |

三层的递进关系：层 1 让 Agent **上手**（一次索引命中即知全貌）；层 2 让 Agent
**规划**（拿到的是流程而非命令清单）；层 3 让 Agent **自愈**（每次失败都指向
回流的下一跳，而不是重试或放弃）。

## 2. 层 1：概述层

### 2.1 出处与结构

新增 `src/support/help-map.ts`（叶子模块，零引擎依赖），内容：

```ts
export const OVERVIEW_TEXT = `AmberFlow 是冻结计划的浏览器自动化引擎：
计划由人给出（app.mjs 的 flow(ctx) 脚本），引擎逐步选元素、执行动作、
验证完成信号；模型只做选择票，不生成动作，完成只认 DOM/工具信号。
什么时候用：要在真实网站上自动化一条可验证的流程（采集、下单、巡检、回归），
且希望每一步有结构化证据与完成裁决时。
从哪开始：已安装 → amber doctor 体检；checkout 内 → node --experimental-strip-types
src/cli/main.ts doctor（裸 amber 不在 PATH，npx amber 会挂住）。`;

export interface WhenToUse { readonly cmd: string; readonly when: string; }
export const WHEN_TO_USE: readonly WhenToUse[] = [ /* 每命令一行 */ ];
```

**长度预算（进校验，超限即红）**：概述全文 ≤ 400 字符；每命令 `when` ≤ 40 字符。
概述必须含三件事：① 一句话本质（含"模型只做选择票、完成只认信号"两条差异
声明，纠正"直接写 Playwright"的错误心智）；② 何时用；③ 按调用环境分叉的
"从哪开始"（已安装走 `amber doctor`，checkout 内走 `node --experimental-strip-types
src/cli/main.ts doctor`——与首页 `INVOKE_FALLBACKS` 同一口径）。"从哪开始"
必须是可执行命令，不是文档链接——索引命中时 Agent 手里只有命令行。

### 2.2 投放面（全部从 help-map 渲染，不许手抄）

| 投放面 | 方式 | 校验组 |
|---|---|---|
| `amber` 无参首页 | 开头插 `OVERVIEW_TEXT`，"下一步"改为从 `WHEN_TO_USE` 生成 | overview |
| `amber --help` | GLOBAL_USAGE 头部加一段概述（由 registry 引 help-map 渲染） | overview |
| AGENTS.md「引擎概述」节 | 最小逐字块嵌入 `OVERVIEW_TEXT`（带"勿手抄"标注，不重写既有内容） | overview |
| DSH 桥插件描述 | `integrations/dsh-bridge/src/grammar.generated.ts` 增加 `OVERVIEW_TEXT` 生成物——桥侧无 AGENTS.md 可读，插件描述承载**完整概述**，不改写 | overview |
| `amber schema ctx` 新增 `overview` 节 | schema-gen 从 help-map 取 | schema `--check` |

### 2.3 设计要点

- **索引命中即全貌**：概述必须一句话说清"引擎替你决策、完成只认信号"这两条
  与通用浏览器自动化工具的本质差异，否则 Agent 会带着 Playwright 直写的错误
  心智模型进入层 2。
- 每个 CLI 命令配一行 `when`（何时用）：层 1 与层 2 的桥梁，让"看了一眼命令表"
  与"知道何时用哪个"合并成一次阅读。

## 3. 层 2：工具层

### 3.1 registry 增加流程字段

`CommandSpec` 新增可选 `flow?: string[]`（实践流程，按序）与 `when?: string`
（何时用，与 help-map 同源互证）：

```ts
{
  name: "run",
  summary: "运行应用、计划或一次性目标",
  when: "应用已通过 check/explain，要真跑或按预算试跑时",   // ← 新
  flow: [                                                  // ← 新（只写正向流程，≤4 行）
    "--dry-run 先验调用序列（不启浏览器）",
    "--max-steps 3 --trace 预算试跑，拿结构化反馈",
    "完整运行；失败回流见层 3（停因 next）",
  ],
  usage: ..., flags: ..., related: ...,
}
```

**职责边界**：`flow` 只写正向流程；失败排查统一由层 3 承载，`flow` 里最多一句
"失败看停因 next"指回层 3，不展开排查内容。

投放：`commandHelp()` 在"示例"与"常用选项"之间渲染「何时用」「实践流程」两段；
`--json` 输出同步带上（桥与 Agent 直接读结构化 help）。

### 3.2 `amber help --json`：层 2 对 Agent 的正规通道

现状：`amber help <cmd>` 只走 `say()`（人类文本），`--json` 模式下 Agent 没有
结构化 help 可读。新增：`amber help <cmd> --json` 输出 success envelope，
`data` 为完整 `CommandSpec`（含 when/flow/flags/related）。这是审查确认的
P0 项——缺失则整套设计对 harness Agent 打折。

### 3.3 help 与 schema 互认（两套自描述面归一）

- `amber --help` 尾部加一行：`引擎语义契约（facts/signals/hints/commands/…）：amber schema ctx --json`。
- `amber schema ctx` 的 `overview` 节带一行：`命令与实践流程：amber help <命令>`。
- 两处文案都由 help-map / schema-gen 生成，prompt-hit 校验互引存在。

### 3.4 参数填写规范

已有纪律保持：flags 表从 registry 渲染、配置键从 `config-schema.ts` 渲染、
meta 字段从 `META_FIELD_MAP` 渲染。层 2 不新增手抄表，只把既有单源面
**串成流程**（help 里按使用顺序排列，而非字母序堆放）。

## 4. 层 3：提示层

### 4.1 STOP_NEXT 全量收录（保持"只收验证过的"纪律，但补齐回流路径明确的）

`planning-playbook.ts` 的 `STOP_NEXT` 补齐 schema stopcodes 节里已有明确
语义的停因（每个都有"回到正确流程"的下一跳）：

| 新增停因 | next（回流路径） |
|---|---|
| `config_error` | 停因 reason 自带具体声明错误；改 meta/声明后先 `apps check`（离线）再重跑 |
| `host_not_allowed` | 目标主机加进 `meta.hosts`，或改用 `meta.site.pages` + `openPage`；`apps check` 离线可验 |
| `invariant_failed` | 看 steps[] 最后一步是否真的到达结束页；`inspect --probe` 实证不变量选择器 |
| `missing_done` | flow 末尾补 `ctx.done()`；声明了不变量就必须验收 |
| `needs_value` | slot 缺值：值必须来自任务输入或数据源（`--slot k=v` 传入）；**没有真实值就如实返回 needs_value 给上游，不要造默认值** |
| `trace_mismatch` | 重放条件不符：重新完整运行，不要重放 |
| `precondition_skipped` | 不是失败：按 stopCode 分支继续；误跳则修 when 条件（先 inspect 实证） |

措辞纪律：`needs_value` 的 next 不允许出现"声明默认值"的诱导表述——引擎红线
是"值绝不来自猜测"，提示词不能教 Agent 绕过它。

### 4.2 停手出口（兜底规则，新增 `STOP_ESCALATION_TEXT`）

提示层不只是"回流"，还要给出**何时停止自愈**：

> 同一停因按 next 修正后重跑仍出现 ≥ 2 次 → 停手：如实上报 stopCode / reason /
> 已试过的修正，等待人或上游决策；不要再自行迭代脚本或重试。

实测依据：调用方 Agent 最危险的行为是反复改脚本重跑真实站点——回流建议必须
带终止条件，否则层 3 反而放大无效重试。该文本进 run 失败输出（`runNextHint`
附在 next 之后）、文档逐字块、桥生成物。

### 4.3 键集校验闭环（防"收录不全"悄悄回潮）

prompt-hit 新增 coverage 组断言：

```
schema STOPCODE_MEANING 键集 ⊆ STOP_NEXT 键集 ∪ 显式豁免清单（EXEMPT_NEXT）
```

- 豁免清单收"确实没有可建议下一跳"的停因（如 `manual_declined`——人放弃，
  没有工程动作可建议），豁免要写一行理由注释。
- 这样新增 stopcode 时：要么给 next，要么显式豁免，二选一，不会静默漏。
- 注意：`STOPCODE_MEANING`（schema-gen）与 `STOP_NEXT`（planning-playbook）
  分属两个模块，校验时从两边 import 键集比对，不改任何一边的真源地位。

### 4.4 CliError 与 playbook 同源

高频用法错误的 hint/next 保持现状（已有 `usageFromParseError` 的翻译层），
但 `usageError` 的 `next` 数组里出现的命令必须存在于 registry——prompt-hit
顺手断言（扫 `src/cli/**` 的 `next: [...]` 字面量，提取 `amber <cmd>` 前缀，
与 COMMANDS 键集比对）。防止"next 指向已删除命令"这类死链。

## 5. 防漂移总账（prompt-hit 校验组）

校验输出从计数式（"OK（6 层）"）改为**分组清单式**——文档与本方案只引用组名，
不引用编号（避免后续插组导致全部编号失准）：

| 组 | 校验内容 | 现状 |
|---|---|---|
| grammar | hint 示例可解析、算子描述双向一致 | 已有 |
| pool | 示例 hint 在合成池恰好命中 | 已有 |
| plan | 信号样本判定 ↔ 声明 | 已有 |
| bridge | 桥生成物同步（grammar + playbook + **overview**） | 扩展 |
| doc | 文档逐字含 ATTR_MATCH_MODEL_TEXT / PLAN_PLAYBOOK_TEXT / FAILURE_SIGNS_TEXT | 已有 |
| overview（新） | AGENTS.md 逐字含 OVERVIEW_TEXT；长度预算（概述 ≤400 字符、when ≤40、flow ≤4 行）；WHEN_TO_USE 与 registry when 双向一致；overview 进桥生成物 | 新增 |
| coverage（新） | STOPCODE_MEANING 键集 ⊆ STOP_NEXT ∪ EXEMPT_NEXT；CLI next 无死链；三处（首页/help/桥）同一事实抽查一致 | 新增 |

## 6. 可验收判据

1. **维护性**：新增一个投放面（如又一种 harness 入口）时，零文案改动——只加
   一处渲染接线 + 一条 coverage 断言；文案本体不改。
2. **覆盖完整性**：STOP_NEXT 覆盖率 = (STOPCODE_MEANING 键集 − EXEMPT_NEXT)
   / STOPCODE_MEANING 键集 = 100%，由 coverage 组持续断言。
3. **一致可查**：同一事实（抽查项：`--max-steps` 是执行预算的表述）在首页、
   `amber help run`、桥 `amberflow_run` 工具描述三处文本一致（逐字或语义等价
   由断言钉住）。

## 7. 实施顺序

1. `src/support/help-map.ts`（层 1 出处）→ registry `when`/`flow` 字段 +
   `help --json`（层 2）→ `STOP_NEXT` 补全 + `EXEMPT_NEXT` +
   `STOP_ESCALATION_TEXT`（层 3）。
2. 投放面接线：首页 / `--help` / `help --json` / AGENTS.md / schema overview
   节 / 桥生成物。
3. **重建快照基线**：overview 节会让旧快照全量漂移（预期行为）——
   `amber schema ctx --out dist/schema/ctx.json` 后再接 CI `--check`。
4. prompt-hit 改分组输出 + overview / coverage 两组；`npm run check` 全绿。
5. 文档：本文档即设计出处；AGENTS.md「文档」节追加本文档。

## 8. 各 Harness 的入口矩阵

| Harness | 层 1 入口 | 层 2 入口 | 层 3 入口 |
|---|---|---|---|
| Claude Code | CLAUDE.md → AGENTS.md 概述节 | `amber help` / `amber help <cmd> --json` / `amber schema ctx` | 停因 reason + `next` 字段 |
| Codex / Cursor 等 | AGENTS.md（同一份） | 同上 | 同上 |
| DSH / WorkBuddy 桥 | 插件描述（OVERVIEW_TEXT 生成物，完整概述——桥侧无 AGENTS.md） | 工具描述 + 参数描述 | 工具结果的 `next`/停因映射（桥透传） |
| 纯 CLI 用户 | `amber` 首页 | `amber --help` | 错误块「提示 / 下一步」 |

关键约束：同一层在不同 harness 上**逐字相同**（生成物或逐字嵌入），差异只允许
出现在"入口怎么找到它"（薄壳指针、插件注册、skill 索引），不允许出现在内容里。

## 9. 审查记录

本方案经双视角审查迭代（产品视角 + Agent 调用者视角，2026-10-30）：审查结论
与修改项全文见 `docs/PROMPT_SYSTEM_REVIEW.md`（含未采纳的保留意见）。
