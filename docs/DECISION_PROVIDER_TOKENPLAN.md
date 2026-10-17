# 接入 token-plan MaaS 决策模型（SystemOne 协议）

> 代码：[src/decision-tokenplan.ts](../src/decision-tokenplan.ts) ｜ 测试：[tests/decision-tokenplan.test.ts](../tests/decision-tokenplan.test.ts)（假服务，CI 不需要网络/凭据）
> ｜ 选择入口：`--provider token-plan` / `AMBERFLOW_DECISION_PROVIDER=token-plan` / 套件 `--provider token-plan`
> ｜ 本次实测日期：2026-10-15（凭据只从环境读，绝不进代码/产物/提交）

## 为什么它接得上

阿里云 MaaS 的**共享网关**上跑着 `decision-model-preview`，`<base>/systemone` 与百炼 workspace 端点
**同一种线协议**（SystemOne：一次前向返回 choice/noul/score，不生成 token）：

```jsonc
// 请求（systemOneClient 组装）
{ "model": "decision-model-preview",
  "state": { "goal": "把无线鼠标加入购物车" },
  "questions": { "act": { "type": "choice", "instructions": "...", "criteria": { "e1": "Add to cart", "e2": "Cart" } } } }
// 响应（实测）
{ "model": "decision-model-preview", "request_id": "…",
  "answers": { "act": { "type": "choice", "choice": "e1", "confidence": 0.97,
                        "probabilities": { "e1": 0.98, "e2": 0.02, "e3": 0 } } },
  "usage": { "input_tokens": 58 }, "latency_ms": 39.6 }
```

同一个 base 上还挂着 OpenAI 兼容的 chat 模型（`/chat/completions`：qwen3.x / glm-5.x /
deepseek-v4.x）——那是 **SystemTwo（规划/审计/老师）** 的通道，不归本 provider 管（见 §5）。

## 1. 协议实测矩阵（2026-10-15，逐条命令见 §6）

| 探针 | 结果 |
|---|---|
| choice 3 选项 | 200；`confidence=0.97` 而 `max(prob)=0.98` —— **两者不同刻度**（与百炼同族标定语义） |
| choice 1 项 | 200（**minOptions=1**）；0 项才 400 `criteria` 非空 |
| noul 风险问句 | 200 `{type:"noul",noul:0.07}`（供风险闸门与完成投票） |
| score 问句 | 400（要求 criteria；本仓不使用 score，无影响） |
| 中文 criteria（CJK 标签） | 200（conf 0.65） |
| 未知 model | 404 `model_not_found` |
| 坏 token | 401 `invalid_api_key`（带官方错误码链接） |
| 坏 body | 400 `InvalidParameter`（说明哪一层校验失败） |

profile 吸收的差异：`score_kind=calibrated_prob`（score=confidence、pTop1/pTop2/margin 从分布取，
**跨 provider 比 score 无意义**）；`minOptions=1`；`validateChoiceInPool=true`（池外答案当没答）；
`shortlist=false`（不做 k=8 重问，收窄由执行器传子集）。

## 2. 怎么接（端点仍是配置，不是代码）

**共享层不许写死外部主机**（`apps:matrix` 的泄漏门禁实测抓到过这个字面量，当作债计）；与 LLM 的
`OPENAI_BASE_URL` 同一条纪律。所以端点、token、model 都从环境按名读：

```bash
export TOKEN_PLAN_ENDPOINT='https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone'
export TOKEN_PLAN_API_KEY='<token-plan 的 token>'      # 回退 DASHSCOPE_API_KEY；绝不内联进命令/代码/产物
# 可选：TOKEN_PLAN_MODEL=decision-model-preview（默认就是它）

npm run apps -- --app demo-app --provider token-plan            # 单应用
npm run apps:suite -- --provider token-plan                     # 整批语料换模型
npm run providers:baseline -- --providers first-candidate,token-plan   # 对照台（删光 hint 的四条旅程）
npm run doctor                                                  # 体检会列出 token-plan（未配置会点名缺什么）
```

解析规则（与 bailian 同一套，`resolveProviderSpec`）：
**显式点名却没配 ⇒ 响亮报错指路**（`--provider token-plan` 缺 key/端点）；
**环境默认档没配 ⇒ 干净落 rules-only**（没人要求在线模型，声明照样能跑）。

## 3. 功能审查：真服务实测结果

### 3.1 对照台（同一批**删掉全部 hint** 的旅程；判据 = 新模型必须赢 first-candidate 这条零智能线）

| 应用（无 hint） | first-candidate | laya 真 ONNX（历史账） | **token-plan** |
|---|---|---|---|
| demo-app | ✓ 5/5 问12/过12 | ✗ 3/5 | **✓ 5/5** 问5/过5 |
| camera-entry | ✓ 4/4 问28/过28 | ✗ 0/4 | **✓ 4/4** 问7/过7 ⬅ 修闸门刻度后（见 §4） |
| transfer-trekly | ✓ 19/19 问37/过37 | ✗ 0/19 | **✓ 19/19** 问26/过26 |
| ctrip-case | ✗ 7/19 问137/过137 | ✗ 10/19 | **✗ 19/19** 问23/过23（旅程全过、**结束态不变量红**） |
| **通过数** | **3/4** | 0/4 | **3/4** |

读法（三条边界都写死在这里，免得事后各说各话）：

1. **平手不吹赢**：通过数 3/4 = first-candidate 的 3/4。它的价值在**问的次数**（12→5、28→7、37→26、
   137→23）与 **ctrip 旅程完成度 7/19→19/19**——同样没有 hint，它更少失手。
2. **ctrip 那格不是"通过"**：19/19 子目标全部达成，但 `end-on-recorded-capped-hotel-list` 这条
   **结束态不变量红**——中间信号可以成立而终态不对，报告如实记 `ok=false`。这是「完成信号 ≠ 结束态
   不变量」的既有设计边界，在线模型把它暴露得更明显；修它属于信号/不变量设计，不是接线问题。
3. **中文包单独记账**（第 1 轮审查的判据）：camera-entry / ctrip-case 是中文页；拉丁页两格全过。

### 3.2 延迟与咨询（这批数据的代价，一并摊开）

- 服务端 `latency_ms` 实测 38–49 ms；**端到端每次调用 0.4–1.5 s**（网络往返占比大，同城网关）。
- 四条旅程合计咨询 61 次（5+7+26+23），对照 first-candidate 的 214 次——低咨询量靠的是"一次选对"，
  不是"少问"。
- 决策模型是**确定性温度**（服务端一次前向），同一问题结果稳定；本 provider 未进 CI（网络/凭据）。

### 3.3 全量套件（`npm run apps:suite -- --provider token-plan`，另一条独立证据）

- **16/17 应用真执行且通过**（与 laya 真模型臂同形；`cli-report` 危险步未放行 = 未执行，非失败；3 个线上应用
  如实跳过），退出码 `3`（有未执行——套件的正常口径）。
- **承重线不随 provider 变**：hint 覆盖 **168/170 = 98.8%**、声明解决 **170/170 = 100%**、
  `model not needed` 的应用 **16 个**、模型边际 25 步（全部在 transfer-slowjet，conf 0.99 过关）。
  换模型换的是**兜底层**，不是"谁在承重"——与 JevK5 接入时的判据一致（见 docs/DECISION_PROVIDER_JEVK5.md）。
- 梯级账单：规则/hint 201 ｜ token-plan 25 ｜ reobserve 0 ｜ escalate 0（后两级本轮语料上仍是 dead rung，
  如实记账，不当"保险"）。

### 3.4 复算命令

```bash
export TOKEN_PLAN_ENDPOINT='https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone'
export TOKEN_PLAN_API_KEY='…'
# 完整四 provider 对照（冻结产物 bench/provider-baselines.json 由它写出）
npm run providers:baseline -- --providers always-abstain,first-candidate,coin-flip,token-plan
# 单点：闸门刻度测量（camera-entry，hintless 包，floor 四档：0.25 / 0.20 / 0.15 / 0.10）
node --experimental-strip-types src/app-runner.ts --app /tmp/<hintless>/camera-entry.json \
  --no-sources --provider token-plan --conf-floor 0.2 --out /tmp/floor-0.2
```

## 4. 审查抓到并修掉的真缺陷：闸门刻度没有随 provider 校准

**现象**：第一次实测时 camera-entry 红（`3/4`，阻塞原因 `low confidence 0.20 < floor 0.25 on step 2`）。
**根因**：执行器闸门比的是 provider 的 `score`，而 `score_kind` 两支不可比（laya 是归一化熵、
token-plan 是标定概率）；**0.25 是 laya 的刻度**，换 provider 后没人重新校准，一个"模型其实选对了"
的 0.20 被硬阻塞。这正是仓库自己写在 `score_kind` 注释里的纪律（"跨 provider 比 score 无意义"）
在闸门上的遗漏。

**修法（三层声明面 + 一条优先级）**：

- `ProviderInfo.floor`（provider 自报闸门刻度）——token-plan 自报 **0.20**（实测边界，见下）；
- `pack.policy.conf_floor`（包作者可声明，加载期校验 `(0,1]`）；
- CLI `--conf-floor N`（本次覆盖；非法值是用法错误、退出码 2）；
- 优先级 **CLI > pack.policy > provider 自报 > 全局缺省 0.25**，生效值与来源进
  `<app>-result.json.effective_policy.conf_floor` 与报告"生效策略"行。

**实测边界**（camera-entry hintless，四档 floor）：

| floor | 结果 | 不变量 | 咨询 |
|---|---|---|---|
| 0.25（旧缺省） | ✗ 3/4（阻塞 0.20） | 3/3 held | 7 |
| **0.20**（provider 自报） | ✓ 4/4 | 3/3 held | 7 |
| 0.15 | ✓ 4/4 | 3/3 held | 7 |
| 0.10 | ✓ 4/4 | 3/3 held | 7 |

松闸没有带来错点（每步仍由该步自己的信号裁决——红线③不变）。**边界**：0.20 是单包单点的实测值，
不是普适校准；别的包可用 `policy.conf_floor` 或本次 CLI 覆盖。

## 5. 顺带的第二通道：SystemTwo（chat 模型）

同一网关的 `/chat/completions` 兼容 OpenAI 协议，SystemTwo 三件套（plan:flow 的 LLM 规划器 /
escalate 老师 / 审计）**不用改一行代码**，走既有 `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `PLANNER_MODEL`：

```bash
export OPENAI_BASE_URL='https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
export OPENAI_API_KEY='<同上或另一份 token>'
export PLANNER_MODEL='qwen3.8-max'          # 也可 proxy glm-5.3 / deepseek-v4-pro
npm run plan:flow -- --goal "在云程旅行订5月18日昆明到北京价格最低的机票" \
  --seed semantic/site-a/index.html --app <id> --site site-a --planner llm --yes
```

**本次实测（2026-10-15，`deepseek-v4-pro`）：真跑通了首个真 LLM 闭环**——一句话 + 种子页 → 5 步完整规划
（进机票搜索 → 填两城+搜索 → 选日期 → **list 选最低价** → 购买自动标 `dangerous`）→ 两次独立演示归纳
完成判据（全部 `induced`）→ 重放门控整跑通过 → 落盘 4 条 hint。回放验证：首跑 `rule 0 · laya 4 (written back 4)`，
**二跑同一档案 `rule 4 · laya 0`**（零模型摊销成立）。证据归档：[bench/llm-planned/](../bench/llm-planned/README.md)。

这一步"只是接线"的东西一跑就现原形，**共修掉 6 处从未被真跑覆盖的适配缺陷**（每处都有回归测试）：

| # | 现象（真跑暴露的） | 修法 |
|---|---|---|
| 1 | 第二次规划调用**网络超时**，错误被 `catch { return null }` 当"模型说完成"吞掉 → **写出 1 步的假绿模板、exit 0** | 只有解析/契约错误才 fail-closed；调用错误**抛出**（规划循环打印原因、不落盘）；停止原因可辨（`done` / `no-json` / `bad-json` / `invalid-schema` / `empty-reply` / `api-error`） |
| 2 | 30s 超时对"整页元素快照 + 推理模型"太紧 | 默认 120s，`PLANNER_TIMEOUT`（秒）可配 |
| 3 | `lands`（落点页名）被要求为字符串，但**演示前不可能知道**（deepseek 给 `null` → 停摆） | `lands` 可省略：落点角色名用演示观察到的文件名 |
| 4 | 模型常把 `id` 给成数字（`"id": 1`）→ 被判契约不合 | 数字 id 归一为字符串（其余字段仍严格） |
| 5 | 模型给整条 URL 当页面角色名 → 模板里混入绝对路径 | `page`/`lands` 归一成文件名（`fileOf`） |
| 6 | `fills: [{slot, word}]` 的 `word` 契约不清：模型填了**值**（"昆明"）而不是**字段标签**（"出发城市"）→ 匹配 0 字段 | 系统提示词点名：`word` = 可见标签/占位符，不是要输入的值 |

模型适配性也留下了对比账：同一条流水线，`qwen3.8-max` 能规划第 1 步但**在搜索页误提 list 步骤**
（页面没有价格行，plan-flow 按纪律停、不猜）；`deepseek-v4-pro` 在该任务上全程可用。换模型要重测，
不能拿一次跑通的结论推所有模型。

## 6. 探针复算

```bash
# 协议矩阵（工具在仓库里：tools/probe-tokenplan.mjs；端点经环境变量传入，工具本身不含主机字面量）
export TP_BASE='https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
export TP_KEY='…'
npm run probe:tokenplan            # 逐条打印 HTTP 码 + 原始 JSON（§1 的每一行都可复算）
```

## 7. 边界与反清单

- **不进 CI**：网络与凭据不满足仓库"CI 永不依赖在线服务"的红线；CI 用假服务契约测试（已钉）。
- **token 绝不进代码/产物/提交**；`--provider token-plan` 的报错只指路，不回显 token。
- **不做默认档**：缺省仍是 `laya-onnx`（`AMBERFLOW_DEFAULT_DECISION_PROVIDER` 可改）——在线服务的
  延迟/可用性/成本不该成为开箱默认；换模型的目的仍是**测量**，不是替换承重件。
- **"某模型更好"的结论必须带咨询数与耗时**（本节 §3.2 已摊开）；跨 provider 比 `score` 无意义，
  闸门刻度必须由 provider 自报 + 实测。
