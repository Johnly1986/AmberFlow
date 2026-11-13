/**
 * **配置面的唯一声明**：哪些键可以被 `amber config` 读写、属于哪一组、内建默认值是什么。
 *
 * 以前同一件事散在 `rcfile.ts`（白名单）、`config-store.ts`（秘密正则）、
 * `run-defaults.ts`（运行默认值键）、`decision-service.ts`（服务键）和示例 JSON 五处；
 * 改一个键要在五个地方同步，示例还长期只写 25/47 个键。现在只有这一份：
 *   - `RC_GROUPS` / `CONFIG_KEYS` 由这里派生；
 *   - 示例 `configs/amberflowrc.example.json` 由 `tools/config-example.ts` 生成；
 *   - 秘密掩码、默认值查询也在这里。
 *
 * 三条口径：
 *   1. **一个概念一个键**。旧别名（`LAYAA_*`、`LAYAWEBUSE_REPO`、`HUGGINGFACE_HUB_CACHE`、
 *      provider 专属变量）仍由各消费点按环境变量兼容，但**不再进配置面**——配置里写旧名会
 *      在加载期报未知键，而不是悄悄生效。
 *   2. **默认值只写一次**。这里写的是“没有配置时引擎实际使用的值”；空串表示“自动/不覆盖”
 *      （例如服务地址、本地模型路径、闸门刻度），不是“关闭”。
 *   3. **凭据永远留空**。示例里 `*_API_KEY` 一律空串，只提示填法。
 */

export interface ConfigKeySpec {
  key: string;
  /** 没有配置时引擎实际使用的静态默认值；undefined = 动态/自动（示例写空串）。 */
  default?: string;
  /** 值是否属于凭据（doctor/config 掩码）。 */
  secret?: boolean;
  /** 旧环境变量名：消费点仍兼容，但不属于配置面。 */
  legacy?: readonly string[];
  /** 给示例与帮助用的一句话。 */
  description: string;
}

export interface ConfigGroupSpec {
  group: string;
  keys: readonly ConfigKeySpec[];
}

export const CONFIG_GROUPS: readonly ConfigGroupSpec[] = [
  {
    group: "决策模型产物",
    keys: [
      { key: "LAYA_ONNX_MODEL", legacy: ["LAYAA_ONNX_MODEL"], description: "本地 ONNX 图路径；空 = <repo>/models/laya_dec.onnx" },
      { key: "LAYA_TOKENIZER_DIR", legacy: ["LAYAA_TOKENIZER_DIR"], description: "tokenizer 目录；空 = 自动发现 HF 缓存/项目目录" },
      { key: "HF_HOME", description: "HuggingFace 根目录；空 = 默认缓存位置" },
      { key: "HF_HUB_CACHE", legacy: ["HUGGINGFACE_HUB_CACHE"], description: "HuggingFace hub 缓存；空 = 默认位置" },
    ],
  },
  {
    group: "决策服务（统一配置）",
    keys: [
      { key: "AMBERFLOW_DECISION_BASE_URL", description: "线上决策服务地址；空 = 使用本地模型" },
      { key: "AMBERFLOW_DECISION_MODEL", description: "线上模型名；无服务地址时是本地 checkpoint（空 = english；可填 multilingual）" },
      { key: "AMBERFLOW_DECISION_API_KEY", secret: true, description: "线上服务密钥；本地自托管可空" },
      { key: "AMBERFLOW_DECISION_PROTOCOL", description: "systemone 或 openai-decisions；空 = 按 URL 自动推断" },
      { key: "AMBERFLOW_DECISION_FLOOR", description: "闸门刻度；空 = 不覆盖 provider 自报/全局 0.25；会被 --conf-floor（或 AMBERFLOW_CONF_FLOOR）覆盖" },
      { key: "AMBERFLOW_DECISION_SCORE_KIND", default: "calibrated_prob", description: "score 语义：calibrated_prob/entropy_conf/rank_only" },
      { key: "AMBERFLOW_DECISION_TIMEOUT_MS", default: "30000", description: "单次请求超时（毫秒）" },
      { key: "AMBERFLOW_DECISION_STATE_CONTEXT", default: "1", description: "1 = choice 题带 url/title/正文；0 = 只带 goal" },
      { key: "AMBERFLOW_DECISION_MIN_OPTIONS", default: "1", description: "choice 选项下限；自托管 JevK5 用 2" },
    ],
  },
  {
    group: "外层 LLM（事后审计）",
    keys: [
      { key: "OPENAI_BASE_URL", description: "OpenAI 兼容服务地址（仅供事后审计 LLMAuditor）；空 = 用内置替身。规划归 Agent：引擎内没有 LLM 规划面" },
      { key: "OPENAI_API_KEY", secret: true, description: "外层 LLM 密钥（事后审计用）" },
      { key: "AUDIT_MODEL", default: "gpt-4o-mini", description: "审计模型名" },
    ],
  },
  {
    group: "浏览器与落盘",
    keys: [
      { key: "PLAYWRIGHT_BROWSERS_PATH", description: "Playwright 浏览器目录；空 = 自动发现" },
      { key: "AMBERFLOW_HOME", description: "用户作用域目录；空 = ~/.amberflow" },
      { key: "AMBERFLOW_APPS_OUT", description: "应用运行产物目录；空 = 系统临时目录/amberflow-apps" },
      { key: "AMBERFLOW_REPO", legacy: ["LAYAWEBUSE_REPO"], description: "DSH 桥指向的 checkout；空 = 自动发现" },
    ],
  },
  {
    group: "人工步骤与操作节奏",
    keys: [
      { key: "AMBERFLOW_STEP_DELAY_MS", default: "0", description: "步骤间最小延迟（毫秒）" },
      { key: "AMBERFLOW_ACTION_DELAY_MS", default: "0", description: "动作间最小延迟（毫秒）" },
    ],
  },
  {
    group: "运行参数（CLI 旗标的配置默认值）",
    keys: [
      { key: "AMBERFLOW_HEADFUL", default: "0", description: "1 = 显示浏览器窗口" },
      { key: "AMBERFLOW_CONF_FLOOR", description: "闸门刻度覆盖；空 = 不覆盖。优先级：--conf-floor / 此键 > AMBERFLOW_DECISION_FLOOR > 全局 0.25" },
      { key: "AMBERFLOW_TIERED_HINT", default: "0", description: "1 = 打开 tiered hint 实验" },
      { key: "AMBERFLOW_CONFIRM_SAFE", default: "1", description: "1 = 危险动作仍逐次确认（默认，安全）；0 = 放行（旧行为，需显式）" },
      { key: "AMBERFLOW_NO_SOURCES", default: "0", description: "1 = 跳过应用数据腿" },
      { key: "AMBERFLOW_QUIET", default: "0", description: "1 = 只输出结论" },
    ],
  },
  {
    group: "决策开关（decision.*，行为变更面）",
    keys: [
      {
        key: "AMBERFLOW_AMBIGUOUS_ORDERING", default: "dom-preorder",
        description: "on_ambiguous:act 的歧义命中顺序：dom-preorder（缺省，命中 act 时刻 DOM 序首个 actionable 候选）| pool-order（旧池序，回退开关）",
      },
      {
        key: "AMBERFLOW_ID_FALLBACK", default: "1",
        description: "act 的 #id hint 池内未命中时是否做 live-DOM getElementById 单点直查兜底：1（缺省）= 兜底；0 = 维持旧 target_not_found（回退开关）",
      },
      {
        key: "AMBERFLOW_ACT_POOL_CAP",
        description: "act 池上限（decision.act_pool_cap；空 = 引擎默认 40）。仅观测面可配；默认值调整需另行变更",
      },
      {
        key: "AMBERFLOW_POOL_QUOTA_MODE", default: "legacy",
        description: "池构建配额模型：legacy（缺省，优先级逐出）| quota（双配额：viewport 保底 + id-backed 保留 + 壳元素限额；灰度站点显式开启）",
      },
    ],
  },
  {
    group: "实验开关（opt-in）",
    keys: [
      { key: "AMBERFLOW_SITE_FACTS_INTO_MODEL", default: "0", description: "1 = 站点事实注入模型请求面（fenced 块；缺省 OFF = notes 原样）" },
    ],
  },
];

export const RC_GROUPS: Array<{ group: string; keys: string[] }> = CONFIG_GROUPS.map((g) => ({
  group: g.group,
  keys: g.keys.map((k) => k.key),
}));

export const CONFIG_KEYS: readonly string[] = CONFIG_GROUPS.flatMap((g) => g.keys.map((k) => k.key));

function keysOfGroup(group: string): readonly string[] {
  const found = CONFIG_GROUPS.find((g) => g.group === group);
  return found ? found.keys.map((k) => k.key) : [];
}

/** 服务配置键：从唯一 schema 派生，避免 `decision-service.ts` 再手写一遍。 */
export const DECISION_SERVICE_KEYS: readonly string[] = keysOfGroup("决策服务（统一配置）");

/** 运行参数默认值键：从唯一 schema 派生，`run-defaults.ts` 只负责类型解析。 */
export const RUN_DEFAULT_KEYS: readonly string[] = keysOfGroup("运行参数（CLI 旗标的配置默认值）");

/** 决策闸门刻度的全局兜底（provider 自报 / 包策略 / CLI 覆盖都没有时的缺省值）。单源。 */
export const DEFAULT_CONF_FLOOR = 0.25;

/** 统一决策服务的缺省单请求超时（毫秒）。`AMBERFLOW_DECISION_TIMEOUT_MS` 未设时生效。单源。 */
export const DEFAULT_DECISION_TIMEOUT_MS = 30_000;

/**
 * Provider 专属实验键（**仅文档性分组，不进配置面**）：
 * `amber config set` 对它们会按未知键拒绝，写进 amberflowrc.json 也会在加载期拒绝。
 * 它们只由各家 provider 消费点按环境变量直接读（决策模型 provider 的 `--provider` 消融实验面）。
 * 这些键是"引擎不认识站点/具体提供商"纪律的例外：provider 是引擎的插件面，各带自己的配置词汇。
 */
export const PROVIDER_ONLY_KEYS: readonly ConfigGroupSpec[] = [
  {
    group: "Provider 专属（仅文档性，不进配置面）",
    keys: [
      { key: "BAILIAN_API_KEY", secret: true, description: "百炼 API key（回退 DASHSCOPE_API_KEY）；只按名读，绝不内联" },
      { key: "BAILIAN_MODEL", description: "百炼模型名（空 = 默认）" },
      { key: "BAILIAN_ENDPOINT", description: "百炼端点全 URL" },
      { key: "BAILIAN_WORKSPACE_ID", description: "百炼 workspace 作用域 ID" },
      { key: "BAILIAN_REGION", description: "百炼区域（有默认值）" },
      { key: "TOKEN_PLAN_ENDPOINT", description: "Token Plan 端点（完整 URL，含 /…/v1/systemone）" },
      { key: "TOKEN_PLAN_API_KEY", secret: true, description: "Token Plan API key（回退 DASHSCOPE_API_KEY）" },
      { key: "TOKEN_PLAN_MODEL", description: "Token Plan 模型名（空 = 默认）" },
      { key: "TOKEN_PLAN_STATE_CONTEXT", description: "旧名兼容；0 = 不带 state 上下文（等价 AMBERFLOW_DECISION_STATE_CONTEXT）" },
      { key: "DASHSCOPE_API_KEY", secret: true, description: "DashScope API key（多家 provider 共用回退）" },
      { key: "JEVK5_ENDPOINT", description: "JevK5 端点（指向 /v1/systemone）" },
    ],
  },
];

const SECRETISH = /API_KEY|SECRET|PASSWORD|ACCESS_TOKEN/;

export function isSecretKey(key: string): boolean {
  return SECRETISH.test(key);
}

/** doctor/config 的唯一掩码入口：秘密只留长度。 */
export function maskValue(key: string, value: string): string {
  return isSecretKey(key) ? `${"*".repeat(Math.min(value.length, 12))}（长度 ${value.length}，已掩码）` : value;
}

export const CONFIG_DOC = [
  "把它复制成同目录的 amberflowrc.json 就是无害的：本模板的值就是引擎的内建默认值。",
  "空串 = 自动/不覆盖（例如服务地址为空表示用本地模型，闸门刻度为空表示让 provider 自报或全局 0.25），不是“关闭”。",
  "线上决策服务只填三件套：AMBERFLOW_DECISION_BASE_URL + AMBERFLOW_DECISION_MODEL + AMBERFLOW_DECISION_API_KEY；",
  "没有 BASE_URL 时 AMBERFLOW_DECISION_MODEL 选本地 checkpoint：空 = english，multilingual 需显式填写。",
  "凭据只留在本机这个文件里（已被 .gitignore 排除），绝不进计划/包/报告等被审计的产物。",
  "旧环境变量（LAYAA_*、HUGGINGFACE_HUB_CACHE、LAYAWEBUSE_REPO、provider 专属变量）仍由各消费点兼容，但不属于配置面；写进这里会以未知键拒绝。",
  "优先级：CLI 旗标 > 环境变量 > 项目配置 > 用户配置 > 旧 rc > 内建缺省；本文件的键若已在环境里设过，以环境为准。",
].join("");
