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
