# 决策层收敛：本项目只做 SystemOne 适配（模型加载隔离到服务侧）

> 准绳（项目方设想，2026-10-14）：**当前项目把注意力聚焦到决策模型的使用上；决策模型的加载/启动
> 隔离到服务侧；本项目只关心 SystemOne 适配问题。**
> 本文是这条设想的落地设计：目标架构、删什么/留什么/引入什么、分阶段路径、每阶段的门禁。
> 上游：[MODEL_PURPOSE_ARCH_REVIEW_2.md](MODEL_PURPOSE_ARCH_REVIEW_2.md)（模型边际实测）、
> [DECISION_PROVIDER_BAILIAN.md](DECISION_PROVIDER_BAILIAN.md) / [DECISION_PROVIDER_JEVK5.md](DECISION_PROVIDER_JEVK5.md)（两个在线 provider）。

> 统一接入面（2026-10-25）：服务地址 + 模型名 + 密钥三键（`AMBERFLOW_DECISION_*`）已落地，
> 见 [DECISION_SERVICE_CONFIG.md](DECISION_SERVICE_CONFIG.md)。本文的"一份 systemOneClient + profile 表"
> 仍是协议层设计；统一配置层就是给新服务填 profile 的用户面。

## 0. 一句话

laya、JevK5、百炼 decision-model-preview **说的是同一种协议**（System One：`{state, questions:{qid:{type:choice|noul|score,…}}} → {answers:{qid:{choice|noul|score, confidence, probabilities}}}`，一次前向、不生成文本）。
所以本项目不该为每个服务写一套适配器、更不该在决策层里养本地模型的推理机器——它该拥有的是
**一个 `systemOneClient` + 一份 profile 表**：加一个决策服务 = 加一条配置（端点/认证/model 名/选项下限/score 语义），不是新代码。
模型加载、checkpoint 路由、shortlist 重问、温度标定、多语言权重——**全是服务侧的事**。

## 1. 现状：两条缝并存 + 本地模型机器横切在执行器里

- **旧缝** `installLayaRuntime`/`getLayaRuntime`（LayaRuntime，57 处引用，多为测试注入）；**新缝** `installDecisionProvider`（DecisionProvider）。执行器 `ready()` 两缝都够：有 provider 用 provider，否则 `getLayaRuntime()` → 建常驻 checkpoint + `embedFnFromAgent` + `createRouter` + `agentFor` 换入换出/gc → 再包成 `layaProvider`。
- **问题**：`routeModels / router / agentFor / embedFn / getLayaRuntime / decision-cache / model-artifacts / model:fetch` 这些**只为本地 ONNX 存在**的机器住在决策层/执行器里，而在线 provider 一行都不需要。这就是"模型层复杂"的根源。

## 2. 目标架构

```
执行器 ──只依赖──> DecisionProvider（一条缝）
                        ├── systemOneClient(profile)   ← 本项目的核心资产
                        │      ├── profile: bailian（在线服务）
                        │      ├── profile: jevk5 （在线服务）
                        │      ├── profile: laya  （服务侧跑 laya，暴露 /systemone）
                        │      └── profile: <新服务>（加配置，零代码）
                        ├── rulesOnly（无 provider：声明消化全部——开箱默认）
                        └── scripted-stub（确定性测试桩：CI / 回放门用）
```

**删（隔离到服务侧后本项目不再需要）**：`laya-onnx.ts`（725 行：onnxruntime/HF 缓存/tokenizer 适配/buildSequence/温度标定/shortlist k=8/Router）、`model-artifacts.ts`、`model-fetch.ts`、`decision-cache.ts`（laya 形状专属）、执行器里的 `routeModels/router/agentFor/embedFn/getLayaRuntime` 分支。约 1000+ 行 + 1.7GB 产物依赖。

**留（它们不是"模型"，删不得）**：
- **rules-only**：开箱即用的地基（`npm ci && npm start` 无网络无 key，靠声明跑）。
- **scripted-stub**：CI 与**回放门**（learn/plan:flow 零模型重放）必须离线、确定、可复现——在线模型 conf 会漂（实测 0.78↔0.86），不能进确定性门禁。
- **DecisionProvider 抽象**（capabilities / score_kind / ChoiceOutcome）：已是收敛点，保留并补全。

**引入**：
- `src/system-one-client.ts`：SystemOne 线协议的**唯一实现**（请求组装、noul 风险/完成、错误抽取、超时/不可达指路）。差异全走 profile。
- `SystemOneProfile`：`{name, version, capabilities, endpoint(), auth?(), extraBody?(), minOptions, validateChoiceInPool, 错误指路串, timeoutMs, fetchImpl}`。
- `providers.json`（可选，Stage 4）：把 profile 变成数据，新服务纯配置。

## 3. 差异如何被 profile 吸收（实测三家的不同点）

| 维度 | laya | JevK5 | 百炼 | profile 字段 |
|---|---|---|---|---|
| 认证 | 无（本地） | 无（本地服务） | `Bearer $DASHSCOPE_API_KEY` | `auth?()` |
| body 里的 `model` | — | 无 | `decision-model-preview` | `extraBody?()` |
| choice 选项下限 | 1 | **2**（否则 400） | 1（1–255） | `minOptions` |
| 池外答案（other） | — | 信任服务端 | **拒绝→null** | `validateChoiceInPool` |
| `confidence` 语义 | 归一化熵 | =max(prob) | 独立标定 | `score_kind`（已有） |
| shortlist k=8 重问 | 客户端做 | 服务端 knockout | 服务端一次读全量 | **收敛到服务侧**（客户端不问子集） |
| 多语言/checkpoint 路由 | 客户端 Router | 英文only | 服务侧 | **全归服务侧** |

关键：`score` 一律读 `confidence`（三家代码路径其实一致），`pTop1/pTop2/margin` 从 `probabilities` 取；
**跨 provider 比 score 无意义**（`score_kind` 声明语义，门禁只读、不跨比——W0 的教训）。

## 4. 分阶段路径（每步可测、冻结语料保持绿）

- **Stage 1（零行为风险，纯重构）**：抽 `systemOneClient`；把 `bailianProvider` / `jevk5Provider` 重写成它的 profile。
  门禁：`tests/decision-bailian.test.ts`、`tests/decision-jevk5.test.ts`、`tests/provider-contract.ts` **一字不改全绿**（契约与错误串保持）。
- **Stage 2**：执行器 `ready()` 塌成"provider 或 rules-only"；把 `router/agentFor/embedFn/routeModels` 从执行器移除。
  laya 若要保留，做成 `systemOneClient` 的一个 profile（服务侧跑 laya）。门禁：`tests/decision-provider.test.ts` 逐字段等价 + `verify` 全绿 + `apps:suite` 缺省不变。
- **Stage 3**：删 `laya-onnx/model-artifacts/model-fetch/decision-cache` + `model:fetch`/`--force-model router`/`LAYA_ONNX_MODEL` 约定；`doctor` 的"决策模型"项改成"决策服务 provider"体检（列 profile、探活、缺 key/端点点名）。
  门禁：`verify`/`smoke`（模型侧分支改成"provider 探活"而非"ONNX 产物在位"）+ 开箱 `npm start`（rules-only 路径）仍绿。
- **Stage 4**：`providers.json` 配置化 + 文档收口（README/ARCHITECTURE 的"为什么本地还养一个模型"章节改写为"决策服务侧加载、本项目只做 SystemOne 适配"）。

## 5. 边界与红线（不动）

- **红线③**（DOM 信号唯一真值）与**回放门**（learn/plan:flow 零模型重放）不依赖任何模型——删本地模型不影响它们（它们本就是 rules-only）。
- 在线 provider 引入**网络/key/配额/延迟/数据出域**依赖：这是"真模型档"的代价，不是 rules-only 的。`risk_degraded`（429 降级到关键词）已有，保留。
- CI **永不依赖在线服务**（确定性 + 无 key）：CI 用 rules-only + scripted-stub。在线 provider 的验证靠契约测试（假服务）。
- 凭据只从环境按名读（`DASHSCOPE_API_KEY` 等），绝不进代码/产物/提交（既有硬规矩）。

## 6. 需要项目方确认

1. Stage 3 是否**彻底删** laya-onnx（本项目不再有任何本地推理），还是保留一个 `laya` profile 指向"服务侧跑的 laya"？（设想倾向前者：加载启动隔离到服务侧。）
2. `providers.json`（Stage 4）要不要做——它把"加决策服务"变成纯配置，但需要定义 profile schema。
