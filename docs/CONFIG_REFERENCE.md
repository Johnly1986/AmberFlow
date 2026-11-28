# 配置字段表（CONFIG_REFERENCE）

> **生成物，勿手改**：本文件由 `tools/config-example.ts` 从 `src/support/config-schema.ts` 派生。
> 重新生成 `npm run config:example`；一致性校验 `npm run config:example:check`（`npm run check` 的一环）。

**单一事实来源**：`src/support/config-schema.ts`（键集、分组、内建默认值）。本表只是人读视图，不接受手改。

- **优先级**：CLI 旗标 > 环境变量 > 项目配置 > 用户配置 > 旧 rc > 内建缺省。
- **未知键 fail-fast**：不在 schema 的键写进配置文件会在加载期以结构化错误拒绝（点名未知键与已知键集），不会静默生效。
- **凭据纪律**：凭据只留在本机配置文件/环境变量（配置文件已被 `.gitignore` 排除），绝不进计划/包/报告等被审计产物；内建默认值与示例一律空串，展示时只留长度。
- **空串语义**：`""` = 自动/不覆盖（不是「关闭」）。
- **作用点**是人工维护的导航提示（解析结果以代码为准）；它不属于 schema 字段。

本表覆盖 **34 个配置键 / 8 组**；另有 11 个 provider-only 键见文末例外段（**不属于配置面**）。

## 决策模型产物（4 键）

| 键 | 内建默认 | 说明 | 作用点 |
| --- | --- | --- | --- |
| `LAYA_ONNX_MODEL` | `""`（自动/不覆盖） | 本地 ONNX 图路径；空 = <repo>/models/laya_dec.onnx | `src/model/laya-onnx.ts`（模型装载） |
| `LAYA_TOKENIZER_DIR` | `""`（自动/不覆盖） | tokenizer 目录；空 = 自动发现 HF 缓存/项目目录 | `src/model/laya-onnx.ts`（tokenizer 发现） |
| `HF_HOME` | `""`（自动/不覆盖） | HuggingFace 根目录；空 = 默认缓存位置 | `src/model/laya-onnx.ts`（HF 缓存根） |
| `HF_HUB_CACHE` | `""`（自动/不覆盖） | HuggingFace hub 缓存；空 = 默认位置 | `src/model/laya-onnx.ts`（HF hub 缓存） |

## 决策服务（统一配置）（10 键）

| 键 | 内建默认 | 说明 | 作用点 |
| --- | --- | --- | --- |
| `AMBERFLOW_DECISION_BASE_URL` | `""`（自动/不覆盖） | 线上决策服务地址；空 = 使用本地模型 | `src/model/decision-service.ts`（有地址即线上） |
| `AMBERFLOW_DECISION_MODEL` | `""`（自动/不覆盖） | 线上模型名；无服务地址时是本地 checkpoint（空 = english；可填 multilingual） | `src/model/decision-service.ts` / `src/model/checkpoint.ts`（无地址时选本地 checkpoint） |
| `AMBERFLOW_DECISION_API_KEY` | `""`（自动/不覆盖） | 线上服务密钥；本地自托管可空 | `src/model/decision-service.ts`（鉴权；掩码展示） |
| `AMBERFLOW_DECISION_PROTOCOL` | `""`（自动/不覆盖） | systemone 或 openai-decisions；空 = 按 URL 自动推断 | `src/model/decision-service.ts`（协议推断覆盖） |
| `AMBERFLOW_DECISION_FLOOR` | `""`（自动/不覆盖） | 闸门刻度；空 = 不覆盖 provider 自报/全局缺省（0.5）；会被 --conf-floor（或 AMBERFLOW_CONF_FLOOR）覆盖 | `src/model/decision-service.ts`（闸门刻度） |
| `AMBERFLOW_DECISION_SCORE_KIND` | `calibrated_prob` | score 语义：calibrated_prob/entropy_conf/rank_only | `src/model/decision-service.ts`（score 语义） |
| `AMBERFLOW_DECISION_TIMEOUT_MS` | `30000` | 单次请求超时（毫秒） | `src/model/decision-service.ts`（单请求超时） |
| `AMBERFLOW_DECISION_STATE_CONTEXT` | `1` | 1 = choice 题带 url/title/正文；0 = 只带 goal | `src/model/decision-service.ts`（choice 题上下文） |
| `AMBERFLOW_DECISION_MIN_OPTIONS` | `1` | choice 选项下限；自托管 JevK5 用 2 | `src/model/decision-service.ts`（choice 选项下限） |
| `AMBERFLOW_DECISION_HEADERS` | `""`（自动/不覆盖） | 额外请求头（JSON 对象，如 {"x-opencode-session":"…"}）；空/坏 JSON = 不带头。路由头与 Authorization 分开：前者路由，后者身份 | `src/model/decision-service.ts`（额外请求头） |

## 外层 LLM（事后审计）（3 键）

| 键 | 内建默认 | 说明 | 作用点 |
| --- | --- | --- | --- |
| `OPENAI_BASE_URL` | `""`（自动/不覆盖） | OpenAI 兼容服务地址（仅供事后审计 LLMAuditor）；空 = 用内置替身。规划归 Agent：引擎内没有 LLM 规划面 | `src/engine/audit.ts`（事后审计 LLMAuditor） |
| `OPENAI_API_KEY` | `""`（自动/不覆盖） | 外层 LLM 密钥（事后审计用） | `src/engine/audit.ts`（事后审计；掩码展示） |
| `AUDIT_MODEL` | `gpt-4o-mini` | 审计模型名 | `src/engine/audit.ts`（审计模型名） |

## 浏览器与落盘（4 键）

| 键 | 内建默认 | 说明 | 作用点 |
| --- | --- | --- | --- |
| `PLAYWRIGHT_BROWSERS_PATH` | `""`（自动/不覆盖） | Playwright 浏览器目录；空 = 自动发现 | `src/browser/browser-env.ts`（浏览器发现） |
| `AMBERFLOW_HOME` | `""`（自动/不覆盖） | 用户作用域目录；空 = ~/.amberflow | `src/support/amberflow-home.ts`（用户作用域目录） |
| `AMBERFLOW_APPS_OUT` | `""`（自动/不覆盖） | 应用运行产物目录；空 = 系统临时目录/amberflow-apps | `src/support/amberflow-home.ts`（应用运行产物目录） |
| `AMBERFLOW_REPO` | `""`（自动/不覆盖） | DSH 桥指向的 checkout；空 = 自动发现 | `integrations/dsh-bridge/src/index.ts`（桥指向的 checkout） |

## 人工步骤与操作节奏（2 键）

| 键 | 内建默认 | 说明 | 作用点 |
| --- | --- | --- | --- |
| `AMBERFLOW_STEP_DELAY_MS` | `0` | 步骤间最小延迟（毫秒） | `src/support/pace.ts`（步间节奏） |
| `AMBERFLOW_ACTION_DELAY_MS` | `0` | 动作间最小延迟（毫秒） | `src/support/pace.ts`（动作前节奏） |

## 运行参数（CLI 旗标的配置默认值）（6 键）

| 键 | 内建默认 | 说明 | 作用点 |
| --- | --- | --- | --- |
| `AMBERFLOW_HEADFUL` | `0` | 1 = 显示浏览器窗口 | `src/cli/start.ts` / `src/cli/test.ts`（CLI 旗标默认值） |
| `AMBERFLOW_CONF_FLOOR` | `""`（自动/不覆盖） | 闸门刻度覆盖；空 = 不覆盖。优先级：--conf-floor / 此键 > AMBERFLOW_DECISION_FLOOR > 全局缺省（0.5） | `src/support/run-defaults.ts` → `src/app/app-runner.ts`（闸门刻度覆盖） |
| `AMBERFLOW_TIERED_HINT` | `0` | 1 = 打开 tiered hint 实验 | `src/support/run-defaults.ts` → `src/app/app-runner.ts`（P1 实验） |
| `AMBERFLOW_CONFIRM_SAFE` | `1` | 1 = 危险动作仍逐次确认（默认，安全）；0 = 放行（旧行为，需显式） | `src/support/run-defaults.ts` → `src/app/app-runner.ts`（干跑证据确认） |
| `AMBERFLOW_NO_SOURCES` | `0` | 1 = 跳过应用数据腿 | `src/support/run-defaults.ts` → `src/app/app-runner-cli.ts`（跳过数据腿） |
| `AMBERFLOW_QUIET` | `0` | 1 = 只输出结论 | `src/support/run-defaults.ts` → `src/app/app-runner-cli.ts`（只输出结论） |

## 决策开关（decision.*，行为变更面）（4 键）

| 键 | 内建默认 | 说明 | 作用点 |
| --- | --- | --- | --- |
| `AMBERFLOW_AMBIGUOUS_ORDERING` | `dom-preorder` | on_ambiguous:act 的歧义命中顺序：dom-preorder（缺省，命中 act 时刻 DOM 序首个 actionable 候选）\| pool-order（旧池序，回退开关） | `src/engine/executor.ts`（act 歧义命中顺序） |
| `AMBERFLOW_ID_FALLBACK` | `1` | act 的 #id hint 池内未命中时是否做 live-DOM getElementById 单点直查兜底：1（缺省）= 兜底；0 = 维持旧 target_not_found（回退开关） | `src/engine/executor.ts`（#id 直查兜底） |
| `AMBERFLOW_ACT_POOL_CAP` | `""`（自动/不覆盖） | act 池上限（decision.act_pool_cap；空 = 引擎默认 64）。仅观测面可配；默认值调整需另行变更 | `src/engine/executor.ts`（act 落空归因的池帽回显） |
| `AMBERFLOW_POOL_QUOTA_MODE` | `legacy` | 池构建配额模型：legacy（缺省，优先级逐出）\| quota（双配额：viewport 保底 + id-backed 保留 + 壳元素限额；灰度站点显式开启） | `src/engine/extraction.ts`（池配额模型） |

## 实验开关（opt-in）（1 键）

| 键 | 内建默认 | 说明 | 作用点 |
| --- | --- | --- | --- |
| `AMBERFLOW_SITE_FACTS_INTO_MODEL` | `0` | 1 = 站点事实注入模型请求面（fenced 块；缺省 OFF = notes 原样） | `src/app/app-runner.ts`（站点事实注入模型请求面） |

## 旧环境变量别名（legacy，兼容读取但不属于配置面）

以下旧名仍由各消费点兼容读取，但**不属于配置面**：写进 rc / 用户/项目配置会以未知键拒绝。新代码与新文档一律使用左列配置键。

| 配置键 | 兼容的旧环境变量 |
| --- | --- |
| `LAYA_ONNX_MODEL` | `LAYAA_ONNX_MODEL` |
| `LAYA_TOKENIZER_DIR` | `LAYAA_TOKENIZER_DIR` |
| `HF_HUB_CACHE` | `HUGGINGFACE_HUB_CACHE` |
| `AMBERFLOW_REPO` | `LAYAWEBUSE_REPO` |

## 只在环境变量层读取、不在配置面的开关（人工例外段）

下面这些变量**没有** schema 条目：写进 rc / 用户/项目配置会被未知键拒绝，只能在环境变量层设置。

| 环境变量 | 读取点 | 语义 |
| --- | --- | --- |
| `AMBERFLOW_BROWSER_CHANNEL` | `src/browser/browser-env.ts` | `chrome` 或 `headless-shell`；部署/CI 的机器级覆盖，优先于 `meta.policy.browser`（缺省 headless-shell） |
| `AMBERFLOW_RESCUE_SHADOW` | `src/app/intervention-shadow.ts` | `1` = 介入/救援影子模式（只记录不阻断）；其余值一律视为关 |

## Provider 专属键（仅文档性，不进配置面）

这些键**不是配置键**：它们只由各家 provider 的消费点按环境变量直接读取，`amber config set` 会按未知键拒绝，写进 rc 也会在加载期拒绝。列在这里只为说明兼容面；provider 是引擎的插件面，引擎不内置其语义。

| 键 | 凭据 | 说明 |
| --- | --- | --- |
| `BAILIAN_API_KEY` | 是（掩码） | 百炼 API key（回退 DASHSCOPE_API_KEY）；只按名读，绝不内联 |
| `BAILIAN_MODEL` | 否 | 百炼模型名（空 = 默认） |
| `BAILIAN_ENDPOINT` | 否 | 百炼端点全 URL |
| `BAILIAN_WORKSPACE_ID` | 否 | 百炼 workspace 作用域 ID |
| `BAILIAN_REGION` | 否 | 百炼区域（有默认值） |
| `TOKEN_PLAN_ENDPOINT` | 否 | Token Plan 端点（完整 URL，含 /…/v1/systemone） |
| `TOKEN_PLAN_API_KEY` | 是（掩码） | Token Plan API key（回退 DASHSCOPE_API_KEY） |
| `TOKEN_PLAN_MODEL` | 否 | Token Plan 模型名（空 = 默认） |
| `TOKEN_PLAN_STATE_CONTEXT` | 否 | 旧名兼容；0 = 不带 state 上下文（等价 AMBERFLOW_DECISION_STATE_CONTEXT） |
| `DASHSCOPE_API_KEY` | 是（掩码） | DashScope API key（多家 provider 共用回退） |
| `JEVK5_ENDPOINT` | 否 | JevK5 端点（指向 /v1/systemone） |
