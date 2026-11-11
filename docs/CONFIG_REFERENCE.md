# 配置字段表（CONFIG_REFERENCE）

> 单一事实来源：`src/support/config-schema.ts`（键集、分组、内建默认值）。
> 本表是**人读视图**，与 `configs/amberflowrc.example.json` / `.env.example` 同步维护；
> 键集漂移由 `npm run config:example:check` 拦截（示例 JSON 与 schema 一致性）。
> 优先级：CLI 旗标 > 环境变量 > 项目配置 > 用户配置 > 旧 rc > 内建缺省。
> 未知键在加载期 fail-fast（结构化报错，点名键与已知键集）。

## 决策服务（decision）

| 键 | 类型 | 默认 | 作用点 |
| --- | --- | --- | --- |
| `AMBERFLOW_DECISION_BASE_URL` | string (URL) | `""`（本地） | `model/decision-provider.ts`：在线决策服务地址；空 = 本地 checkpoint |
| `AMBERFLOW_DECISION_MODEL` | string | `""`（= english） | provider 选型；无 BASE_URL 时选本地 checkpoint |
| `AMBERFLOW_DECISION_API_KEY` | string (secret) | `""` | 在线服务鉴权；掩码进一切产物 |
| `AMBERFLOW_DECISION_PROTOCOL` | enum | `""`（自报） | 协议适配（openai 兼容 / 自定义） |
| `AMBERFLOW_DECISION_FLOOR` | number (0..1] | `""`（自报） | provider 自报置信度闸门 |
| `AMBERFLOW_DECISION_SCORE_KIND` | enum | `calibrated_prob` | 分数语义；换 provider 时必须配套 `--conf-floor` |
| `AMBERFLOW_DECISION_TIMEOUT_MS` | int (ms) | `30000` | 在线决策超时 |
| `AMBERFLOW_DECISION_STATE_CONTEXT` | int | `1` | 决策上下文的近期步数 |
| `AMBERFLOW_DECISION_MIN_OPTIONS` | int | `1` | 低于该候选数不问模型 |

## 本地模型工件（artifacts）

| 键 | 类型 | 默认 | 作用点 |
| --- | --- | --- | --- |
| `LAYA_ONNX_MODEL` | path | `""`（默认工件） | 本地 ONNX 模型路径 |
| `LAYA_TOKENIZER_DIR` | path | `""`（默认工件） | 分词器目录 |
| `HF_HOME` / `HF_HUB_CACHE` | path | `""` | HuggingFace 缓存重定向（离线部署） |

## provider 专属（兼容层，不属于核心配置面）

| 键 | 类型 | 默认 | 作用点 |
| --- | --- | --- | --- |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | string | `""` | OpenAI 兼容协议适配 |
| `AUDIT_MODEL` | string | `gpt-4o-mini` | 审计腿模型名 |
| `PLAYWRIGHT_BROWSERS_PATH` | path | `""` | Playwright 浏览器安装位置 |

## 目录布局（paths）

| 键 | 类型 | 默认 | 作用点 |
| --- | --- | --- | --- |
| `AMBERFLOW_HOME` | path | 平台约定（`support/amberflow-home.ts`） | 用户级根（hint-memory、产物） |
| `AMBERFLOW_APPS_OUT` | path | `$HOME/apps-out` | 应用运行产物目录 |
| `AMBERFLOW_REPO` | path | 自动探测 | 仓库根（示例与在线站点解析） |

## 运行节奏（pace）

| 键 | 类型 | 默认 | 作用点 |
| --- | --- | --- | --- |
| `AMBERFLOW_STEP_DELAY_MS` | int (ms) | `0`（关） | 步间最小间距（start-to-start），`support/pace.ts` |
| `AMBERFLOW_ACTION_DELAY_MS` | int (ms) | `0`（关） | 动作前延时（拟人节奏） |

## 行为开关（flags）

| 键 | 类型 | 默认 | 作用点 |
| --- | --- | --- | --- |
| `AMBERFLOW_HEADFUL` | `0/1` | `0` | 有头浏览器（CLI `--headful` 旗标层更优先） |
| `AMBERFLOW_TIERED_HINT` | `0/1` | `0` | P1 实验：hint 档内歧义向模型问更小的问题 |
| `AMBERFLOW_CONFIRM_SAFE` | `0/1` | `1` | 安全动作免确认 |
| `AMBERFLOW_NO_SOURCES` | `0/1` | `0` | 跳过数据腿（不跑网络/进程） |
| `AMBERFLOW_QUIET` | `0/1` | `0` | 静默模式 |
| `AMBERFLOW_SITE_FACTS_INTO_MODEL` | `0/1` | `0` | 站点事实注入模型面 |
| `AMBERFLOW_CONF_FLOOR` | number (0..1] | `""`（provider 自报 / 全局 `0.25`） | 置信度闸门刻度 |

## 不属于配置面的旧变量

`LAYAA_*`、`HUGGINGFACE_HUB_CACHE`、`LAYAWEBUSE_REPO`、provider 专属变量仍由各消费点
兼容读取，但**不收进本表**（写进 rc 以未知键拒绝）。`AMBERFLOW_BROWSER_CHANNEL` 是
浏览器通道的内部读取点（`browser/browser-env.ts`），走 rc 的 `browser_channel` 键。
