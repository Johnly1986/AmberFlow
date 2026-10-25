# 统一决策服务配置：服务地址 + 模型名 + 密钥

> 2026-10-25。目的：决策模型接入面的**唯一推荐形式**，不再要求用户记每家 provider 各一套变量名
> （`TOKEN_PLAN_*` / `BAILIAN_*` / `JEVK5_*` / `DASHSCOPE_API_KEY` …）再额外指定 provider 名。

## 1. 三个主键 + 可选键

| 键 | 必填 | 含义 |
|---|---|---|
| `AMBERFLOW_DECISION_BASE_URL` | ✅ | 服务地址。`https://api.typesafe.ai`、`http://localhost:8008`、`https://host/compatible-mode/v1` 或完整 `…/v1/systemone` 都行；System One 会自动补 `/v1/systemone`（详见 §2） |
| `AMBERFLOW_DECISION_MODEL` | 否 | 请求体里的 `model`（TypeSafe `jev-latest`、百炼 `decision-model-preview`、Kev `kev-onnx`…；服务不要求可留空） |
| `AMBERFLOW_DECISION_API_KEY` | 否 | 以 `Authorization: Bearer <key>` 发送；**本地自托管无认证可留空**（远程缺 key 会在解析期报错指路） |

可选（一般不用填）：

| 键 | 默认 | 含义 |
|---|---|---|
| `AMBERFLOW_DECISION_PROTOCOL` | 按 URL 推断 | `systemone`（当前唯一支持）；`openai-decisions` 预留给下一步 |
| `AMBERFLOW_DECISION_FLOOR` | 全局面板 0.25 | 该服务的置信闸门刻度（0–1）；跨服务刻度不可比，见 `score_kind` |
| `AMBERFLOW_DECISION_SCORE_KIND` | `calibrated_prob` | `calibrated_prob` / `entropy_conf` / `rank_only`（服务自报语义） |
| `AMBERFLOW_DECISION_TIMEOUT_MS` | `30000` | 单次请求超时 |
| `AMBERFLOW_DECISION_STATE_CONTEXT` | 开 | `0` = choice 题不再带 url/title/main_text 上下文（消融口径） |
| `AMBERFLOW_DECISION_MIN_OPTIONS` | `1` | choice 选项下限；自托管 JevK5 需要 `2`（不足时结构上没得选，不发请求） |

配置优先级与原有层叠一致：**CLI 旗标 > 环境变量 > 项目配置 > 用户配置 > 旧 rc > 内建缺省**
（`amber config set` / `--project` / 环境变量三种渠道都行）。`amber config show` 对 API key 做掩码。

## 2. 地址归一化

| 你填的 | 实际请求 |
|---|---|
| `https://api.typesafe.ai` | `https://api.typesafe.ai/v1/systemone` |
| `http://localhost:8008` | `http://localhost:8008/v1/systemone` |
| `https://host/compatible-mode/v1` | `https://host/compatible-mode/v1/systemone` |
| `https://host/compatible-mode/v1/systemone` | 原样 |
| `https://api.openai.com/v1/decisions` | 推断协议为 `openai-decisions`（当前会报"还没实现"） |

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

配置好地址后：**不设 `AMBERFLOW_DEFAULT_DECISION_PROVIDER` 也会默认用 `decision-service`**；
显式 `--provider decision-service` 可强制点名（显式点名但缺地址/远程缺 key ⇒ 解析期 exit 2，不静默降级）。
未配置统一服务时仍旧默认 `laya-onnx`（本地 ONNX，行为不变）。

## 4. 与旧 provider 的关系（兼容，不是替代）

- 旧的 `--provider token-plan|bailian|jevk5` 与它们各自的变量仍然有效（各自有实测过的提示词/选项下限/
  池外校验/闸门刻度），适合做 A/B 对照；统一层是**接入新服务的推荐面**。
- 迁移对照：

| 旧 | 统一 |
|---|---|
| `TOKEN_PLAN_ENDPOINT` | `AMBERFLOW_DECISION_BASE_URL`（token-plan 的 `…/compatible-mode/v1`） |
| `TOKEN_PLAN_MODEL` | `AMBERFLOW_DECISION_MODEL` |
| `TOKEN_PLAN_API_KEY`（回退 `DASHSCOPE_API_KEY`） | `AMBERFLOW_DECISION_API_KEY` |
| `BAILIAN_ENDPOINT` / `BAILIAN_MODEL` / `BAILIAN_API_KEY` | 同上三键 |
| `JEVK5_ENDPOINT` | `AMBERFLOW_DECISION_BASE_URL=http://…:8090` + `AMBERFLOW_DECISION_MIN_OPTIONS=2` |
| `AMBERFLOW_DEFAULT_DECISION_PROVIDER` | 不用设（配了地址即默认）；要显式就 `AMBERFLOW_DECISION_PROVIDER=decision-service` |
| token-plan 的 `floor=0.2` | `AMBERFLOW_DECISION_FLOOR=0.2`（统一层不猜刻度） |

- **本地 ONNX（laya）不走这层**：它不是服务地址型配置，仍用 `LAYA_ONNX_MODEL` / `LAYA_TOKENIZER_DIR`。
- **DSH 插件配置页**已经是同样的三元组（URL / Token Key / ModelName），但桥当前仍映射到
  `token-plan` profile；等桥切换到 `decision-service` 后可完全共用一张配置。

## 5. OpenAI Decisions API（下一步）

调研结论：OpenAI 的 `POST /v1/decisions` 已是 GA 的决策协议（`gpt-6-luna`），但形状与 System One
不同（`predicate` vs `noul`、数组 vs map、`probabilities[]` vs map、`refusal` 答案）。统一配置层
已经预留 `AMBERFLOW_DECISION_PROTOCOL=openai-decisions` 和地址归一化；适配器尚未实现——显式选它会
在解析期给出明确错误，而不是悄悄走错协议。
