# 接入阿里百炼决策模型 `decision-model-preview`

> 代码：[src/decision-bailian.ts](../src/decision-bailian.ts) ｜ 测试：[tests/decision-bailian.test.ts](../tests/decision-bailian.test.ts)（假服务，CI 不碰网络、不碰真 key）
> ｜ 选择入口：实验/对照用 `--provider bailian`；正常接入用地址/密钥/模型三件套（`AMBERFLOW_DECISION_*`，见 [DECISION_SERVICE_CONFIG.md](DECISION_SERVICE_CONFIG.md)）
> ｜ API 契约：<https://help.aliyun.com/zh/model-studio/decision-model-api>

## 为什么它接得上

百炼的决策模型走 **TypeSafe System One** 协议（`POST /compatible-mode/v1/systemone`）：
一次请求带业务 `state` 与若干类型化问题（`choice` / `noul` / `score`），模型**一次前向**返回每个问题的
判定、概率分布与置信度，**不生成文本**——延迟与成本和输出长度无关。这与 JevK5 的 `/v1/systemone`、
与我们 `LayaRuntime.predictShortlist` 是同一类形状，所以落在 provider 层，**执行循环零改动**。

```jsonc
// 请求
{ "model": "decision-model-preview",
  "state": { "goal": "..." },
  "questions": { "act": { "type": "choice", "instructions": "...",
                          "criteria": { "e1": "Add to cart", "e2": "Cart" } } } }
// 响应
{ "answers": { "act": { "type": "choice", "choice": "e1", "confidence": 0.88,
                        "probabilities": { "e1": 0.94, "e2": 0.06 } } },
  "usage": { "input_tokens": 125 }, "latency_ms": 52.9 }
```

criteria 的 key 就是元素 ref，`ChoiceOutcome.ref` 直接对上；`noul` 头同时供风险与完成投票用。

## 它与 laya / JevK5 的三个不同（差异必须声明，不能抹平）

| | laya | JevK5 | 百炼 decision-model-preview |
|---|---|---|---|
| `confidence` 的含义 | `1 − H(p)/log k`（归一化熵） | **`max(p)`** | **独立标定的把握数**——官方示例里 choice `confidence=0.88` 而 `max(prob)=0.94`，两者**不相等** |
| 因此 provider 怎么映射 | `score=conf`，无分布外信号 | `score=confidence=max(p)` | `score=confidence`，而 `pTop1/pTop2/margin` 从 `probabilities` 单独取——**两组数分开，不混** |
| `choice` 选项数 | 短名单 k=8 重问 | 要 ≥2（否则服务端 400）⇒ 单候选不发请求 | **1–255 项** ⇒ 单候选照样问；只有 0 候选才"结构上没得选" |
| 认证 | 无（本地权重） | 无（本地服务） | **`Authorization: Bearer $DASHSCOPE_API_KEY`** |
| 端点 | 本地 ONNX | 本地 `:8090` | **workspace 作用域**：`https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1/systemone` |

`score_kind` 声明成 `calibrated_prob`（与 JevK5 同类，与 laya 的 `entropy_conf` 不同）。
**跨 provider 比这些数没有意义**——同名不同义，这正是本仓库当年把两支 AUC 平均成一个 0.325 而得出
错误结论的教训。

## 凭据：token 只从环境变量按名读，绝不进代码/产物/提交

这是仓库既有的硬规矩（CLI 传输里"凭据按名从环境引用，绝不写进被审计的计划"）在 provider 层的延伸。
百炼 provider 读：

- `DASHSCOPE_API_KEY`（官方推荐名；也接受别名 `BAILIAN_API_KEY`）——**API token**；
- `BAILIAN_ENDPOINT`（完整 URL）**或** `BAILIAN_WORKSPACE_ID`（+ 可选 `BAILIAN_REGION`，默认 `cn-beijing`）——端点是 workspace 作用域的，二者必须给一个；
- 可选 `AMBERFLOW_DECISION_MODEL`（默认 `decision-model-preview`；`BAILIAN_MODEL` 仍兼容）。

缺 key / 缺端点时 provider 在**真调用**时报错指路（不静默退回 laya、不瞎选），而**注册不需要**它们——
所以 `npm run doctor` 能列出 `bailian`，没配好时错误信息告诉你缺哪一件。

> ⚠️ **不要把 token 写进 `pack.json`、`.env` 提交、命令行明文、或本仓库任何被 git 跟踪的文件。**
> 用 `export DASHSCOPE_API_KEY=...`（或从密钥管理器注入进程环境）。若 token 曾出现在明文里，去百炼控制台**吊销重发**。

## 怎么跑

```bash
export DASHSCOPE_API_KEY=<你的 API Key>          # 只进环境，不进任何文件
export BAILIAN_WORKSPACE_ID=<业务空间 ID>          # 或 export BAILIAN_ENDPOINT=https://<ws>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone
export BAILIAN_REGION=cn-beijing                 # 可选，默认 cn-beijing；新加坡用 ap-southeast-1

# 单应用换 provider 跑（真网络 + 真服务）
npm run apps -- --app demo-app --provider bailian --out /tmp/bailian
# 整批语料对照（看它 vs laya 的出场/边际）
npm run apps:suite -- --provider bailian
```

## 与 JevK5 一样：本机不依赖它跑测试

契约测试用一个假的 `/compatible-mode/v1/systemone` 把线协议钉住（认证头、`model` 字段、
`confidence≠max(prob)` 的映射、单候选可问、池外答案归 null、缺 key/端点报错、
**非 2xx 错误体是嵌套对象时抽出可读原因**），**CI 不需要网络、不需要真 key**。真服务在场时同一份 provider 代码直接可用。

## 在线实测（2026-10-14，decision-model-preview @ token-plan.cn-beijing）

- **契约确认**：choice 返回 `{choice, confidence, probabilities}`，且 `confidence` 与 `max(prob)` **不相等**
  （实测 0.78 vs 0.85）——独立标定的把握数，映射按此分开。
- **风险头比 laya 更锐利**：`risk("Place order")=0.95` vs `risk("Cart")=0.08`（laya 在 ~40% 良性点击上误报）。
- **slowjet（冷启动，声明失效的那一类）**：bailian 咨询 25 次、**全部过闸门**、决定 25 步、19/19 通过；
  对照 laya 在同一应用 5 次咨询 0 次过闸门、只靠 retries 走完。**这是模型兜底档第一次真出场**（模型边际 0 → 25）。
  诚实边界：证据集中在**一个**冷启动夹具应用，其余 16 个应用 bailian 咨询 0 次（规则消化全部，model not needed）。
- **限流（preview 档）**：整批 `apps:suite`（~170 次突发调用）会触发 **HTTP 429**，风险头如实降级到关键词规则
  （`risk_degraded` 进产物，不静默）。单应用跑不触发。批量对照要么**放慢/分批**，要么把它当已知的 preview 档配额约束。

