# 统一决策服务配置：服务地址 + 模型名 + 密钥

> 决策模型接入面的**唯一推荐形式**：**地址/密钥/模型三件套就是完整的选择依据**，不再有 provider
> 配置键（也不再要求用户记每家 provider 各一套变量名）。有 `AMBERFLOW_DECISION_BASE_URL` 就走
> 线上服务；没有地址就用本地模型。

## 1. 三个主键 + 可选键

| 键 | 必填 | 含义 |
|---|---|---|
| `AMBERFLOW_DECISION_BASE_URL` | ✅ | 服务地址。`https://api.typesafe.ai`、`http://localhost:8008`、`https://host/compatible-mode/v1` 或完整 `…/v1/systemone` 都行；System One 会自动补 `/v1/systemone`（详见 §2） |
| `AMBERFLOW_DECISION_MODEL` | 否 | 请求体里的 `model`（TypeSafe `jev-latest`、百炼 `decision-model-preview`、Kev `kev-onnx`…；服务不要求可留空） |
| `AMBERFLOW_DECISION_API_KEY` | 否 | 以 `Authorization: Bearer <key>` 发送；**本地自托管无认证可留空**（远程缺 key 会在解析期报错指路） |

可选（一般不用填）：

| 键 | 默认 | 含义 |
|---|---|---|
| `AMBERFLOW_DECISION_PROTOCOL` | 按 URL 推断 | `systemone`（TypeSafe/Jev/Kev/百炼/自托管）或 `openai-decisions`（OpenAI `POST /v1/decisions` 及兼容网关） |
| `AMBERFLOW_DECISION_FLOOR` | 全局面板 0.25 | 该服务的置信闸门刻度（0–1）；跨服务刻度不可比，见 `score_kind` |
| `AMBERFLOW_DECISION_SCORE_KIND` | `calibrated_prob` | `calibrated_prob` / `entropy_conf` / `rank_only`（服务自报语义） |
| `AMBERFLOW_DECISION_TIMEOUT_MS` | `30000` | 单次请求超时 |
| `AMBERFLOW_DECISION_STATE_CONTEXT` | 开 | `0` = choice 题不再带 url/title/main_text 上下文（消融口径） |
| `AMBERFLOW_DECISION_MIN_OPTIONS` | `1` | choice 选项下限；自托管 JevK5 需要 `2`（不足时结构上没得选，不发请求） |

配置优先级与原有层叠一致：**CLI 旗标 > 环境变量 > 项目配置 > 用户配置 > 旧 rc > 内建缺省**
（`amber config set` / `--project` / 环境变量三种渠道都行）。`amber config show` 对 API key 做掩码。
闸门刻度的生效顺序是：**`--conf-floor`（或配置 `AMBERFLOW_CONF_FLOOR`）> `AMBERFLOW_DECISION_FLOOR` > 全局面板 0.25**——
前者是"本次/本项目的运行参数覆盖"，后者是"这个决策服务自报的刻度"，报告里 `conf_floor.source`（cli/config/provider）会写明本次用了哪一层。
配置键与默认值的唯一出处是 [src/support/config-schema.ts](../src/support/config-schema.ts)；
示例由 `npm run config:example` 生成，`npm run check` 会校验示例没有漂移。

## 2. 地址归一化

| 你填的 | 实际请求 |
|---|---|
| `https://api.typesafe.ai` | `https://api.typesafe.ai/v1/systemone` |
| `http://localhost:8008` | `http://localhost:8008/v1/systemone` |
| `https://host/compatible-mode/v1` | `https://host/compatible-mode/v1/systemone` |
| `https://host/compatible-mode/v1/systemone` | 原样 |
| `https://api.openai.com` / `…/v1/decisions` | 推断协议为 `openai-decisions`，补成 `…/v1/decisions` |

协议默认按 URL 推断（含 `/decisions` 才是 OpenAI Decisions，否则 System One）。

## 3. 常用服务怎么填

| 服务 | BASE_URL | MODEL | KEY |
|---|---|---|---|
| TypeSafe Jev（托管） | `https://api.typesafe.ai` | `jev-latest`（或 `jev-1.14.0` / `jev-1.13.0`） | TypeSafe key |
| 阿里云百炼 `decision-model-preview` | `https://<WorkspaceId>.<region>.maas.aliyuncs.com/compatible-mode/v1` | `decision-model-preview` | `DASHSCOPE_API_KEY` 的值 |
| token-plan MaaS 网关 | 你的 `…/compatible-mode/v1` | `decision-model-preview` | token-plan key |
| OpenRouter System One | `https://openrouter.ai/api/v1` | `typesafe/jev-1.13` 等 | OpenRouter key |
| VLM Run Gateway | 其文档给出的网关地址 | 其目录中的模型名 | VLM Run key |
| 自托管 Kev（kev-onnx） | `http://localhost:8008` | `kev-onnx`（可空） | 空 |
| 自托管 Laya（`laya-serve`） | `http://localhost:8000` | 空（服务只有 Router） | 设了 `LAYA_API_KEY` 才填 |
| 自托管 JevK5（`jevk5-serve`） | `http://localhost:8090` | 空 | 空（另设 `AMBERFLOW_DECISION_MIN_OPTIONS=2`） |

```bash
# 一次性写入用户配置（密钥写本机，不进仓库；仓库的 .amberflow/ 与 configs/amberflowrc.json 都已 gitignore）
amber config set AMBERFLOW_DECISION_BASE_URL https://api.typesafe.ai
amber config set AMBERFLOW_DECISION_MODEL jev-latest
amber config set AMBERFLOW_DECISION_API_KEY sk-…
# 本地自托管：
amber config set AMBERFLOW_DECISION_BASE_URL http://localhost:8008
amber config set AMBERFLOW_DECISION_MIN_OPTIONS 2   # JevK5 才需要
```

只要地址在，就会走统一服务，**不需要** provider 键；没有地址才使用本地模型。
地址在但远程缺 key、或协议写错 ⇒ 解析期 exit 2，不静默降级；本地自托管（localhost）允许无 key。

## 4. 与实验/兼容 provider 的关系（仅 `--provider`）

- 旧的 `--provider token-plan|bailian|jevk5` 与它们各自的**环境变量**仍然有效（各自有实测过的提示词/选项下限/
  池外校验/闸门刻度），适合做 A/B 对照；它们不属于配置面（`amber config set` 不认），也不再从配置里选择，
  只能命令行显式点名 + 环境变量。
- 迁移对照：

| 旧 | 统一 |
|---|---|
| `TOKEN_PLAN_ENDPOINT` | `AMBERFLOW_DECISION_BASE_URL`（token-plan 的 `…/compatible-mode/v1`） |
| `TOKEN_PLAN_MODEL` / `BAILIAN_MODEL` | `AMBERFLOW_DECISION_MODEL`（服务模型名；本地 checkpoint 也用同一个键） |
| `TOKEN_PLAN_API_KEY`（回退 `DASHSCOPE_API_KEY`） | `AMBERFLOW_DECISION_API_KEY` |
| `BAILIAN_ENDPOINT` / `BAILIAN_MODEL` / `BAILIAN_API_KEY` | 同上三键 |
| `JEVK5_ENDPOINT` | `AMBERFLOW_DECISION_BASE_URL=http://…:8090` + `AMBERFLOW_DECISION_MIN_OPTIONS=2` |
| `AMBERFLOW_DECISION_PROVIDER` / `AMBERFLOW_DEFAULT_DECISION_PROVIDER` | **已移除**：不再需要；有地址即线上，`--provider` 仅本次实验 |
| token-plan 的 `floor=0.2` | `AMBERFLOW_DECISION_FLOOR=0.2`（统一层不猜刻度） |

- **本地 ONNX（laya）不走这层**：它不是服务地址型配置；没有服务地址时，本地 checkpoint 名由
  `AMBERFLOW_DECISION_MODEL` 选择（`english` / `multilingual`，未设置时用应用包声明或 `english`），
  权重位置仍用 `LAYA_ONNX_MODEL` / `LAYA_TOKENIZER_DIR`。
- **DSH 插件配置页**转发同一组三元组（URL / Token Key / ModelName）；有地址即选
  `decision-service`，没有地址回本地，不再需要 provider 字段。

## 5. OpenAI Decisions API（已实现）

调研结论：OpenAI 的 `POST /v1/decisions` 已是 GA 的决策协议（当前原生只支持 `gpt-6-luna`）。
统一配置层已把它接成同一个 `decision-service` provider（`AMBERFLOW_DECISION_PROTOCOL=openai-decisions`）：

```bash
amber config set AMBERFLOW_DECISION_BASE_URL https://api.openai.com
amber config set AMBERFLOW_DECISION_PROTOCOL openai-decisions
amber config set AMBERFLOW_DECISION_MODEL gpt-6-luna
amber config set AMBERFLOW_DECISION_API_KEY sk-...
```

协议映射（与 System One 的差异都收在 `src/model/decision-openai.ts`）：

| 我们的概念 | System One | OpenAI Decisions |
|---|---|---|
| 风险/完成票 | `noul` | `predicate`（返回 `probability`） |
| 选元素/闭集选择 | `choice`（criteria map） | `choice`（`choices[]` 数组，value/description） |
| 题目容器 | `questions` map | `questions[]`（`name` 标识） |
| 概率 | `probabilities` map | `probabilities[]`（value→probability） |
| 拒答 | 无显式字段 | `refusal` 答案 → 映射成"没答"（pick 返回 null；风险题拒绝会抛错，不伪装成低风险） |

边界：
- 原生 OpenAI 端点只接受 `gpt-6-luna`；网关（如 GoModel 这类 `/v1/decisions` 转 System One 的实现）
  可以填别的决策模型名——按网关文档为准。
- 本仓未用真实 key 跑过 OpenAI 官方端点（本机没有凭据）；适配器用假服务钉住线协议，
  要接真服务时把 URL/KEY/MODEL 换掉即可。
- `predicate` 概率的刻度与 `confidence` 同属标定概率（`score_kind=calibrated_prob`），
  但**不要**和 laya 的归一化熵跨源比较。

## 6. 决策入口唯一：escalation 与审计的边界（2026-11）

- **步级决策只有这一个入口**：执行（apps / online / start / plan run）统一按三件套或本地
  laya 解析（`resolveProviderSpec` → `applySpecToRuntime`）；`--provider` 仅本次实验/消融。
  低置信恢复的 escalation 梯级（`--escalate`，opt-in 缺省关）也走同一个 provider 缝——经
  `DecisionProvider.askChoice` 闭集窄问点名，只许选已展示的候选、池外答案一律弃权
  （fail closed，双层校验）；provider 不支持 `askChoice` 时梯级缺席并如实打印，
  绝不悄悄降级成一个每步都抛错的梯级，也绝不猜。
- **规划归 Agent**：引擎内没有 LLM 规划/重规划面（原 `plan-cli new --llm` 与
  `plan-cli run --replan` 已移除）。计划由人/Agent 给出（`TaskPlan` JSON 或 `app.mjs` 都是
  冻结计划的载体），被挡的子目标以 `blocked + obstacle` 结构化结果返回，由 Agent 决定下一步。
- **`OPENAI_BASE_URL` / `OPENAI_API_KEY` 只剩一个消费者**：事后审计（`LLMAuditor`，评估
  性质——不在环、不规划）。`PLANNER_MODEL` 配置键已移除；旧 rc 里残留会在加载期以
  未知键拒绝，删掉该键即可。

## 7. 桥与 CLI：两条决策配置面（A3，2026-11-02）

同一份三件套有两个**注入面**，排查凭据问题前先分清这次运行走的是哪一条：

| | 桥通道（DSH 插件） | CLI 直跑（`amber run` / `npm run apps` / `npm start`） |
|---|---|---|
| 凭据从哪来 | DSH 插件配置页 → 桥以 **decisionEnv 注入子进程环境变量** | 配置层叠读进 `process.env`（`src/support/apply-config-env.ts`） |
| 生效顺序 | **注入的环境变量最高**——真环境变量已设置的键，配置文件盖不住它 | 旧 rc < 用户配置（`~/.amberflow/config.json`）< 项目配置（`<repo>/.amberflow/config.json`）< 环境变量 |
| 典型错位 | 桥侧没配 → 子进程落到本机配置层的凭据 | 本机配置层里躺着一套**过期的/未购买的**凭据，CLI 拿它去敲门 |

两条面共享同一个装配路径（`resolveProviderSpec` → `applySpecToRuntime` → `provider.pick`），
也共享同一份 HTTP 帮手（`src/model/system-one-client.ts`）——所以"桥能用、CLI 直跑 403"
不是引擎分叉，而是**两条面喂进去的凭据不同**。

### 7.1 真实案例：403 AccessDenied.Unpurchased 被吞成「未过闸门」（2026-11-02 实证）

症状（修复前的行为，排查时按这个形状认）：

- `amber doctor` 全绿——它只查配置项**在不在**，不真发请求；
- 应用运行里决策步被报成 `no_model_runtime: … rules-only has no model to pick one`，
  decisions 行写「**模型被咨询 1 次（1 次未过闸门）**」——把一次基础设施失败说成"模型很没把握"；
- 旧版 result JSON 的 `provider_degraded` 为空（flow 路径的管道断点，已修）。

根因：CLI 直跑读了本机用户配置里的一套 token-plan 凭据，网关对它回
`HTTP 403 {"error":{"code":"AccessDenied.Unpurchased",…}}`（workspace 未购买该模型）；
而引擎当时把非 2xx 的真实原因吞掉、静默降级 rules-only。

A3 修复后的透传链（每一环都带 HTTP 事实）：

1. HTTP 帮手把非 2xx 变成 `HTTP <status>` + 响应体关键句（含 machine code）：
   `统一决策服务 返回 403：AccessDenied.Unpurchased：Access to model denied. …`
   （2xx 但响应体不是 JSON 也响亮报错，不再伪装成"没答"；网络层失败透出 `cause` 链里的
   DNS/拒连/超时原因；密钥永不进错误文本。）
2. 执行器把降级原因编进停因：`no_model_runtime: …（决策源不可用：统一决策服务 返回 403：AccessDenied.Unpurchased…）`。
3. result JSON：`provider_degraded` 非空（声明式与 flow 两条路径同账）；
   `decisions.failed_asks` 单独记账，line 写成「模型被咨询 N 次（M 次未过闸门，K 次失败）」——
   闸门是对模型意见打分，抛错没拿到意见，不算"未过闸门"。

### 7.2 排查路径（按序）

```bash
# ① 医生探针（只诊断，不改退出码）：走与运行时同一装配路径真发一次最小 ask
amber doctor --ask-probe
#    ✓ → ref/conf 正常返回；✗ → 一行内给 HTTP 状态码 + 错误关键句（如 AccessDenied.Unpurchased）

# ② 原始对照（密钥不落命令行/终端回显；二选一）：
curl -sS -X POST "<BASE_URL>/chat/completions" \
  -H "Authorization: Bearer $AMBERFLOW_DECISION_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"<模型名>","messages":[{"role":"user","content":"ping"}]}'   # 共享网关的 chat 面，与 systemone 同一套凭据
# 或对 systemone 面：POST <BASE_URL>/systemone，body 形状见 src/model/system-one-client.ts 头注释

# ③ 分清配置面：同一台机器上桥能跑、CLI 报 403 ⇒ 先对比两侧实际生效的三件套
amber config show        # CLI 侧：层叠与来源（key 掩码）
# 桥侧：DSH 插件配置页的 URL/Token/Model 三项
```

判读：`401 invalid_api_key` = key 错/失效；`403 AccessDenied.Unpurchased` = 凭据有效但该
workspace 未购买此模型（换可用的凭据面，或在服务侧开通）；`404 model_not_found` = 模型名错；
429 = 限流；超时/DNS 见错误文本里的 cause 关键句。修复后用 `amber doctor --ask-probe` 复验，
再跑一次真实应用确认 `decisions.failed_asks=0`。
