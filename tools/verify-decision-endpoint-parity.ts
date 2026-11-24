/**
 * 决策端点两面归一化 parity lane（非门禁：零网络 / 零浏览器 / 零模型 / 零文件写）。
 *
 * 同一个配置值有两个注入面：
 *   - **桥面**：DSH 插件配置页的模型 URL 经 `decisionEndpointFromPage` 处理（只 trim，其余原值
 *     透传），作为 `AMBERFLOW_DECISION_BASE_URL` 注入引擎子进程
 *     （`integrations/dsh-bridge/src/bridge.ts`）；
 *   - **引擎面**：`AMBERFLOW_DECISION_BASE_URL` + `AMBERFLOW_DECISION_PROTOCOL` 决定协议与
 *     最终端点（`src/model/decision-service.ts` / `decision-openai.ts`），是**唯一协议决策点**。
 * 桥面不决定协议、也不补后缀，只把页面值送进引擎面；真正决定 POST 到哪的是引擎在**子进程环境**
 * 上重算的结果。因此本 lane 比较的不是两个字符串，而是同一输入经两面注入后引擎算出的**有效结果**：
 *   - `direct`  = 引擎读「配置原值」；
 *   - `bridged` = 引擎读「桥注入值」。
 * 两者一致 = 该值在两条注入面上行为相同；不一致 = 差异，必须在 `DIFF_WHITELIST` 逐条登记
 * （精确期望值 + 语义 + 影响面）。未登记差异 exit 1；白名单条目不再成立（差异消失或值漂移）
 * 也 exit 1——本 lane 是 tripwire，不改两面的行为。
 *
 * 桥原值透传后两面收敛到同一份引擎归一化器，差异集**应为空**（`DIFF_WHITELIST` 保留为机制：
 * 任一面再长出第二个决策点，新增差异会立刻出现并要求登记）。注意本 lane 的对照臂是「两条注入面
 * 注入同一个值后是否算出同一个有效结果」——两面共用引擎时改引擎不造成分歧，所以负向自测用
 * **只改一面**的突变器来钉灵敏度。
 *
 * 覆盖样本：裸 host / 尾斜杠（含多重）/ 无 scheme / 大写 host / `/v1` / `/v1/systemone` /
 * `/systemone` / compatible-mode 家族 / 端口 / 自定义反代前缀 / query / fragment / 空值 /
 * `/v1/decisions` / 非 http(s) scheme，以及 `AMBERFLOW_DECISION_PROTOCOL` 开关组合
 * （缺省推断 / `systemone` / `openai-decisions` / 非法值）。桥配置页没有协议字段；部署进程的
 * `AMBERFLOW_*` 在 `allowlist` 环境模式按前缀转发进子进程，所以协议开关只可能从部署环境进入
 * 引擎面——本 lane 按「同一开关值两面一致」建模（两面共用该值）。
 *
 * 用法：node --experimental-strip-types tools/verify-decision-endpoint-parity.ts
 *        [--json] [--verbose] [--explain] [--self-test]
 * 退出码：0 = 有效结果差异集合与白名单逐条一致；1 = 新差异 / 白名单漂移；2 = 用法错误。
 */
import {
  DECISION_ENV,
  decisionEndpointFromPage,
  decisionEnv,
} from "../integrations/dsh-bridge/src/bridge.ts";
import { normalizeOpenAIDecisionsEndpoint } from "../src/model/decision-openai.ts";
import {
  DECISION_SERVICE_KEYS,
  normalizeSystemOneEndpoint,
  serviceProtocol,
} from "../src/model/decision-service.ts";

const USAGE = [
  "usage: node --experimental-strip-types tools/verify-decision-endpoint-parity.ts",
  "       [--json] [--verbose] [--explain] [--self-test]",
].join("\n");

/**
 * 引擎协议开关。桥没有对应字段（配置页只有地址/密钥/模型三件套），只从部署进程环境按
 * `AMBERFLOW_*` 前缀转发；名字单源见 `DECISION_SERVICE_KEYS`（下方预检断言它仍在该组里）。
 */
const PROTOCOL_KEY = "AMBERFLOW_DECISION_PROTOCOL";

/* ------------------------------------------------------------ 两面归一化的引擎侧投影 */

/** 引擎面最终会 POST 的端点（或解析期失败/未配置）；协议单独列出，因为它决定请求形状。 */
type Resolution =
  | { kind: "endpoint"; protocol: string; url: string }
  | { kind: "error"; protocol: string; reason: string }
  | { kind: "unset"; protocol: string };

/** 把错误消息里的具体地址抹掉，只留可比较的失败类别（两面注入值不同，回显地址必然不同）。 */
function endpointErrorReason(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/（收到 [\s\S]*）$/u, "（收到 <地址>）");
}

/**
 * 复刻引擎解析期对配置的端点决策：协议由 `serviceProtocol` 选（显式键 > 按 URL 推断，
 * 缺省 systemone）；非法协议在归一化之前就报错（与 `serviceConfigError` 同口径）；
 * 地址归一化按协议分派（System One / OpenAI Decisions 各自补后缀）。
 */
function engineResolution(env: NodeJS.ProcessEnv): Resolution {
  const protocol = serviceProtocol(env);
  const base = env[DECISION_ENV.endpoint];
  const raw = typeof base === "string" ? base.trim() : "";
  if (raw === "") return { kind: "unset", protocol };
  if (protocol !== "systemone" && protocol !== "openai-decisions") {
    return {
      kind: "error",
      protocol,
      reason: `${PROTOCOL_KEY}=${JSON.stringify(protocol)} 不支持（当前支持 systemone / openai-decisions）`,
    };
  }
  try {
    const url = protocol === "openai-decisions"
      ? normalizeOpenAIDecisionsEndpoint(raw)
      : normalizeSystemOneEndpoint(raw);
    return { kind: "endpoint", protocol, url };
  } catch (e) {
    return { kind: "error", protocol, reason: endpointErrorReason(e) };
  }
}

/** 可比投影：端点带 URL、错误只带失败类别、未配置单列；协议始终参与比较。 */
function project(res: Resolution): string {
  switch (res.kind) {
    case "endpoint":
      return `endpoint[${res.protocol}] ${res.url}`;
    case "error":
      return `error[${res.protocol}] ${res.reason}`;
    case "unset":
      return `unset[${res.protocol}]`;
  }
}

/* ------------------------------------------------------------ 样本 / 上下文 */

/** 样本：配置页与 CLI 里可能是同一个值。 */
interface Sample {
  id: string;
  input: string;
  /** 额外开关组合（缺省总会跑 `default`）。 */
  extraContexts?: readonly ContextId[];
}

type ContextId = "default" | "systemone" | "openai" | "unsupported";

interface Context {
  id: string;
  /** 部署环境里显式设置的 `AMBERFLOW_DECISION_PROTOCOL`；缺省 = 不设置（引擎按 URL 推断）。 */
  protocol?: string;
}

const CONTEXTS: Readonly<Record<ContextId, Context>> = {
  default: { id: "default" },
  systemone: { id: "protocol=systemone", protocol: "systemone" },
  openai: { id: "protocol=openai-decisions", protocol: "openai-decisions" },
  unsupported: { id: "protocol=unsupported", protocol: "bogus" },
};

const SAMPLES: readonly Sample[] = [
  { id: "host-bare", input: "https://api.typesafe.ai", extraContexts: ["systemone", "openai", "unsupported"] },
  { id: "host-trailing-slash", input: "https://api.typesafe.ai/" },
  { id: "host-multi-slash", input: "https://api.typesafe.ai////" },
  { id: "host-no-scheme", input: "api.typesafe.ai" },
  { id: "host-uppercase", input: "HTTPS://Host.Example.COM/" },
  { id: "v1", input: "https://api.typesafe.ai/v1" },
  { id: "v1-trailing-slash", input: "https://api.typesafe.ai/v1/" },
  { id: "v1-systemone", input: "https://api.typesafe.ai/v1/systemone", extraContexts: ["openai"] },
  { id: "v1-systemone-trailing-slash", input: "https://api.typesafe.ai/v1/systemone/" },
  { id: "systemone", input: "https://api.typesafe.ai/systemone" },
  { id: "systemone-trailing-slash", input: "https://api.typesafe.ai/systemone/" },
  { id: "systemone-uppercase", input: "https://api.typesafe.ai/v1/SYSTEMONE" },
  { id: "compatible-mode", input: "https://host/compatible-mode" },
  { id: "compatible-mode-trailing-slash", input: "https://host/compatible-mode/" },
  { id: "compatible-v1", input: "https://host/compatible-mode/v1", extraContexts: ["openai"] },
  { id: "compatible-v1-trailing-slash", input: "https://host/compatible-mode/v1/" },
  { id: "compatible-v1-systemone", input: "https://host/compatible-mode/v1/systemone" },
  { id: "port", input: "http://localhost:8008" },
  { id: "port-trailing-slash", input: "http://localhost:8008/" },
  { id: "port-v1", input: "http://localhost:8008/v1" },
  { id: "port-compatible-v1", input: "https://host:8443/compatible-mode/v1" },
  { id: "reverse-proxy-prefix", input: "https://host/prefix" },
  { id: "reverse-proxy-prefix-trailing-slash", input: "https://host/prefix/" },
  { id: "query", input: "https://host/v1?foo=bar" },
  { id: "query-bare", input: "https://host?foo=bar" },
  { id: "query-after-systemone", input: "https://host/v1/systemone?x=1" },
  { id: "fragment", input: "https://host/v1#frag" },
  { id: "path-after-systemone", input: "https://host/v1/systemone/extra" },
  { id: "whitespace-padded", input: "  https://host/v1  " },
  { id: "empty", input: "" },
  { id: "blank", input: "   " },
  { id: "decisions-path", input: "https://host/v1/decisions", extraContexts: ["systemone", "openai"] },
  { id: "non-http-scheme", input: "ftp://host" },
];

/* ------------------------------------------------------------ 差异族（白名单语义） */

type FamilyId = "missing-v1" | "bridge-forces-systemone";

/**
 * 差异族：同族的条目共享语义与影响面判断。族文本是给 review 的结论，不是运行期逻辑；
 * 出现新族 = 需要人判断影响面后登记。
 *
 * 桥改原值透传后，这两个族**只在回归时才会重新出现**：它们的语义描述"如果桥侧又长出第二份
 * 归一化，两面会从哪里分开"，供白名单条目（若将来确实需要登记）与 `--explain` 使用。
 */
const DIFF_FAMILIES: Readonly<Record<FamilyId, { summary: string; semantics: string; impact: string }>> = {
  "missing-v1": {
    summary: "桥侧若再次补齐端点，注入值会缺引擎会补的 `/v1` 段（默认 SystemOne 面）",
    semantics:
      "桥把页面值当基址直接追加 `/systemone`；引擎对同一个值按基址补 `/v1/systemone`"
      + "（`…/compatible-mode` 先补 `/v1`）。桥注入值已经以 `/systemone` 结尾，引擎按"
      + "「已是完整端点」原样保留，于是有效端点少了 `/v1` 段。",
    impact:
      "只影响桥注入面（DSH 插件部署、配置页填裸 host / 端口 / 自定义反代前缀 / 不带 `/v1` 的"
      + "compatible-mode 基址）；CLI 直跑与其它配置层叠面不受影响，引擎仍是唯一协议决策点。"
      + "出现该族 = 桥又引入了一份归一化：修正口径是桥原值透传，而不是让引擎去认桥的产物。",
  },
  "bridge-forces-systemone": {
    summary: "桥侧若再次无条件补 `/systemone`，OpenAI Decisions 端点会被二次加后缀",
    semantics:
      "桥无条件追加 `/systemone` 且不识别协议；当引擎按 `/decisions` 推断为 OpenAI Decisions"
      + "（或部署进程显式设 `AMBERFLOW_DECISION_PROTOCOL=openai-decisions`）时，引擎拿到的是"
      + "已被加上 `/systemone` 的基址，OpenAI 归一化器再补 `/v1/decisions`，请求路径出现双后缀。",
    impact:
      "该形态会让 DSH 部署面无法使用 OpenAI Decisions 端点（配置页没有协议字段，任何页面值都被"
      + "SystemOne 化）；CLI 直跑不受影响。修正口径同上：桥原值透传，协议与后缀只由引擎这一处决定。",
  },
};

/* ------------------------------------------------------------ 差异白名单 */

interface WhitelistEntry {
  /** `样本 id@上下文 id`。 */
  key: string;
  family: FamilyId;
  /** 桥注入的 `AMBERFLOW_DECISION_BASE_URL`（空串 = 未注入）。 */
  bridgeEnv: string;
  /** 引擎读配置原值的有效结果投影。 */
  direct: string;
  /** 引擎读桥注入值的有效结果投影。 */
  bridged: string;
}

/**
 * 有意差异白名单：**当前为空**——桥只 trim、原值透传，两面都交给引擎同一个归一化器，所以同一
 * 输入在两条注入面上必然算出同一个有效端点（含协议）。
 *
 * 保留这张表而不是删掉机制：它是 tripwire 的登记位。桥或引擎任一侧再长出第二个决策点时，
 * 未登记差异立刻 exit 1；确认影响面后在这里逐条登记（精确期望值 + 族），并注明为什么"有意"。
 */
const DIFF_WHITELIST: readonly WhitelistEntry[] = [];

/* ------------------------------------------------------------ 比较 / 评估 */

const BRIDGE_KEY = DECISION_ENV.endpoint;

interface ParityRow {
  key: string;
  sample: Sample;
  context: Context;
  bridgeEnv: string;
  direct: string;
  bridged: string;
  /** 两面有效结果是否不同（错误只比失败类别，不比回显地址）。 */
  diff: boolean;
}

function buildRows(
  bridge: (raw: string) => string,
  engine: (env: NodeJS.ProcessEnv) => Resolution,
  samples: readonly Sample[] = SAMPLES,
  /** 只对「桥注入面」生效的引擎解析器（负向自测模拟一面改道；缺省两面同一解析器）。 */
  bridgedEngine: (env: NodeJS.ProcessEnv) => Resolution = engine,
): ParityRow[] {
  const rows: ParityRow[] = [];
  for (const sample of samples) {
    const bridgeEnv = bridge(sample.input);
    for (const contextId of ["default" as const, ...(sample.extraContexts ?? [])]) {
      const context = CONTEXTS[contextId];
      const directEnv: NodeJS.ProcessEnv = {};
      const bridgedEnv: NodeJS.ProcessEnv = {};
      if (context.protocol !== undefined) {
        directEnv[PROTOCOL_KEY] = context.protocol;
        bridgedEnv[PROTOCOL_KEY] = context.protocol;
      }
      directEnv[BRIDGE_KEY] = sample.input;
      // 桥只注入非空三件套（空串 = 不注入，子进程保留部署环境里的值/不配置）。
      Object.assign(bridgedEnv, decisionEnv({ endpoint: bridgeEnv, apiKey: "", model: "" }));
      const direct = project(engine(directEnv));
      const bridged = project(bridgedEngine(bridgedEnv));
      rows.push({ key: `${sample.id}@${context.id}`, sample, context, bridgeEnv, direct, bridged, diff: direct !== bridged });
    }
  }
  return rows;
}

type ProblemKind = "new-difference" | "drift" | "stale-whitelist" | "unknown-whitelist-case";

interface ParityProblem {
  kind: ProblemKind;
  key: string;
  message: string;
}

/** 按「有效端点」形状给新差异提一个族建议（供人确认后填入白名单，不自动登记）。 */
function suggestFamily(row: ParityRow): FamilyId | "unclassified" {
  const direct = /^endpoint\[[^\]]+\] (.*)$/u.exec(row.direct);
  const bridged = /^endpoint\[[^\]]+\] (.*)$/u.exec(row.bridged);
  if (direct !== null && bridged !== null) {
    // missing-v1 的精确形状：bridged 端点 = direct 端点把末尾 `/v1/systemone` 换成 `/systemone`。
    if (direct[1]!.replace(/\/v1\/systemone$/u, "/systemone") === bridged[1]) return "missing-v1";
  }
  if (row.direct.includes("/decisions") || row.bridged.includes("/decisions")
    || row.context.protocol === "openai-decisions") {
    return "bridge-forces-systemone";
  }
  return "unclassified";
}

function whitelistLiteral(row: ParityRow): string {
  const family = suggestFamily(row);
  return `  { key: ${JSON.stringify(row.key)}, family: ${JSON.stringify(family)},`
    + ` bridgeEnv: ${JSON.stringify(row.bridgeEnv)}, direct: ${JSON.stringify(row.direct)},`
    + ` bridged: ${JSON.stringify(row.bridged)} },`;
}

function evaluateParity(rows: readonly ParityRow[], whitelist: readonly WhitelistEntry[]): ParityProblem[] {
  const problems: ParityProblem[] = [];
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.diff) continue;
    const entry = whitelist.find((candidate) => candidate.key === row.key);
    if (entry === undefined) {
      problems.push({
        kind: "new-difference",
        key: row.key,
        message: "出现未登记的差异（确认语义后加白名单，或修正行为后删除对应条目）",
      });
      continue;
    }
    seen.add(row.key);
    if (entry.bridgeEnv !== row.bridgeEnv) {
      problems.push({ kind: "drift", key: row.key, message: `白名单 bridgeEnv 漂移：期望 ${JSON.stringify(entry.bridgeEnv)}，实际 ${JSON.stringify(row.bridgeEnv)}` });
    }
    if (entry.direct !== row.direct) {
      problems.push({ kind: "drift", key: row.key, message: `白名单 direct 漂移：期望 ${entry.direct}，实际 ${row.direct}` });
    }
    if (entry.bridged !== row.bridged) {
      problems.push({ kind: "drift", key: row.key, message: `白名单 bridged 漂移：期望 ${entry.bridged}，实际 ${row.bridged}` });
    }
    if (!(entry.family in DIFF_FAMILIES)) {
      problems.push({ kind: "drift", key: row.key, message: `白名单 family 未登记：${entry.family}` });
    }
  }
  for (const entry of whitelist) {
    const row = rowByKey.get(entry.key);
    if (row === undefined) {
      problems.push({ kind: "unknown-whitelist-case", key: entry.key, message: "白名单指向不存在的样本/上下文" });
      continue;
    }
    if (!seen.has(entry.key)) {
      problems.push({ kind: "stale-whitelist", key: entry.key, message: "白名单条目已不再产生差异（两面已一致或差异被修正），请重新评估" });
    }
  }
  const keys = whitelist.map((entry) => entry.key);
  for (const key of new Set(keys)) {
    if (keys.filter((candidate) => candidate === key).length > 1) {
      problems.push({ kind: "drift", key, message: "白名单存在重复条目" });
    }
  }
  return problems;
}

/* ------------------------------------------------------------ 输出 */

function printFamilies(explain: boolean): void {
  for (const [id, family] of Object.entries(DIFF_FAMILIES)) {
    console.log(`  族 ${id} — ${family.summary}`);
    if (explain) {
      console.log(`    语义：${family.semantics}`);
      console.log(`    影响面：${family.impact}`);
    }
  }
}

function printRows(rows: readonly ParityRow[], verbose: boolean): void {
  for (const row of rows) {
    if (!row.diff && !verbose) continue;
    const mark = row.diff ? "[差异]" : "[一致]";
    const entry = row.diff ? DIFF_WHITELIST.find((candidate) => candidate.key === row.key) : undefined;
    const tag = entry === undefined ? "" : ` (${entry.family})`;
    console.log(`  ${mark} ${row.key}${tag}`);
    console.log(`    输入=${JSON.stringify(row.sample.input)} 桥注入=${JSON.stringify(row.bridgeEnv)}`);
    console.log(`    direct=${row.direct}`);
    console.log(`    bridged=${row.bridged}`);
  }
}

/* ------------------------------------------------------------ 负向自测 */

/**
 * 一个"又长出第二份归一化"的桥突变器：把页面值当基址补 `/systemone`（正是被修掉的那份）。
 * 负向自测靠它证明 tripwire 仍然灵敏——桥侧一旦回退成两处决策点，差异就会出现在有效结果上。
 */
function mutantBridgeForcesSystemone(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/u, "");
  if (trimmed === "") return "";
  return /\/systemone$/i.test(trimmed) ? trimmed : `${trimmed}/systemone`;
}

function selfTest(): number {
  const failures: string[] = [];
  const run = (name: string, body: () => void): void => {
    try {
      body();
      console.log(`verify-decision-endpoint-parity self-test PASS ${name}`);
    } catch (e) {
      failures.push(name);
      console.error(`verify-decision-endpoint-parity self-test FAIL ${name}: ${(e as Error).message}`);
    }
  };
  const hasKind = (problems: readonly ParityProblem[], kind: ProblemKind): boolean =>
    problems.some((problem) => problem.kind === kind);

  run("基线（真实两面 + 空白名单）= 0 问题且无差异", () => {
    const rows = buildRows(decisionEndpointFromPage, engineResolution);
    const problems = evaluateParity(rows, DIFF_WHITELIST);
    if (problems.length !== 0) {
      throw new Error(`基线应无问题，实际 ${problems.length}：${problems.slice(0, 3).map((p) => `${p.kind} ${p.key}`).join("；")}`);
    }
    // 桥原值透传后两面共用同一个引擎归一化器：任何差异都意味着又出现了第二个决策点。
    const diffs = rows.filter((row) => row.diff);
    if (diffs.length !== 0) {
      throw new Error(`基线应无差异，实际 ${diffs.length} 条（首条 ${diffs[0]!.key}）：桥侧又引入了第二份归一化`);
    }
  });

  run("桥注入值被污染（非 trim 改动）→ new-difference", () => {
    // 只在"页面值走到桥"这一环注入噪声：模拟桥侧再长出一次改写（补后缀、改大小写都算）。
    const noisyBridge = (raw: string): string => {
      const passthrough = decisionEndpointFromPage(raw);
      return passthrough === "" ? "" : `${passthrough}/systemone`;
    };
    const problems = evaluateParity(buildRows(noisyBridge, engineResolution), DIFF_WHITELIST);
    if (!hasKind(problems, "new-difference")) throw new Error("桥注入值被改写后没有被抓到");
    if (DIFF_WHITELIST.length !== 0) throw new Error("本组断言假设白名单为空——先重新评估负向自测口径");
  });

  run("桥回退成「补 /systemone」→ new-difference（含 OpenAI 双后缀面）", () => {
    const problems = evaluateParity(buildRows(mutantBridgeForcesSystemone, engineResolution), DIFF_WHITELIST);
    if (!hasKind(problems, "new-difference")) throw new Error("桥侧第二份归一化没有被抓到");
    const keys = problems.filter((problem) => problem.kind === "new-difference").map((problem) => problem.key);
    if (!keys.includes("host-bare@default")) throw new Error("缺少 missing-v1 形状的差异（host-bare@default）");
    if (!keys.includes("decisions-path@protocol=openai-decisions")) {
      throw new Error("缺少 bridge-forces-systemone 形状的双后缀差异（decisions-path@protocol=openai-decisions）");
    }
  });

  run("建议族：missing-v1 与 bridge-forces-systemone 仍按形状归族", () => {
    const rows = buildRows(mutantBridgeForcesSystemone, engineResolution);
    const bare = rows.find((row) => row.key === "host-bare@default");
    if (bare === undefined) throw new Error("样本 host-bare@default 不存在");
    if (suggestFamily(bare) !== "missing-v1") throw new Error(`host-bare@default 归族应为 missing-v1，实际 ${suggestFamily(bare)}`);
    const openai = rows.find((row) => row.key === "host-bare@protocol=openai-decisions");
    if (openai === undefined) throw new Error("样本 host-bare@protocol=openai-decisions 不存在");
    if (suggestFamily(openai) !== "bridge-forces-systemone") {
      throw new Error(`host-bare@protocol=openai-decisions 归族应为 bridge-forces-systemone，实际 ${suggestFamily(openai)}`);
    }
  });

  run("白名单条目不再产生差异 → stale-whitelist", () => {
    const rows = buildRows(decisionEndpointFromPage, engineResolution);
    const problems = evaluateParity(rows, [
      ...DIFF_WHITELIST,
      { key: "v1@default", family: "missing-v1", bridgeEnv: "https://api.typesafe.ai/v1", direct: "endpoint[systemone] https://api.typesafe.ai/v1/systemone", bridged: "endpoint[systemone] https://api.typesafe.ai/v1/systemone" },
    ]);
    if (!hasKind(problems, "stale-whitelist")) throw new Error("不再产生差异的白名单条目没有被抓到");
  });

  run("白名单期望值漂移 → drift", () => {
    const rows = buildRows(mutantBridgeForcesSystemone, engineResolution);
    // 拿一条真实存在的差异做底座，再把期望值改错：drift 必须被点名。
    const actual = rows.find((row) => row.diff && row.key === "host-bare@default");
    if (actual === undefined) throw new Error("突变器下应有 host-bare@default 差异");
    const entry: WhitelistEntry = {
      key: actual.key, family: "missing-v1", bridgeEnv: actual.bridgeEnv,
      direct: actual.direct, bridged: `${actual.bridged}（漂移）`,
    };
    const problems = evaluateParity(rows, [entry]);
    if (!hasKind(problems, "drift")) throw new Error("白名单期望值漂移没有被抓到");
  });

  run("白名单指向不存在的样本 → unknown-whitelist-case", () => {
    const rows = buildRows(decisionEndpointFromPage, engineResolution);
    const problems = evaluateParity(rows, [
      { key: "no-such-sample@default", family: "missing-v1", bridgeEnv: "", direct: "unset[systemone]", bridged: "unset[systemone]" },
    ]);
    if (!hasKind(problems, "unknown-whitelist-case")) throw new Error("悬空白名单条目没有被抓到");
  });

  run("白名单重复条目 → drift", () => {
    const rows = buildRows(mutantBridgeForcesSystemone, engineResolution);
    const actual = rows.find((row) => row.diff && row.key === "host-bare@default");
    if (actual === undefined) throw new Error("突变器下应有 host-bare@default 差异");
    const entry: WhitelistEntry = {
      key: actual.key, family: "missing-v1", bridgeEnv: actual.bridgeEnv,
      direct: actual.direct, bridged: actual.bridged,
    };
    const problems = evaluateParity(rows, [entry, entry]);
    if (!hasKind(problems, "drift")) throw new Error("重复白名单条目没有被抓到");
  });

  run("桥注入面的引擎解析改道（协议/后缀面）→ new-difference", () => {
    const mutantEngine = (env: NodeJS.ProcessEnv): Resolution => {
      const resolved = engineResolution(env);
      return resolved.kind === "endpoint"
        ? { kind: "endpoint", protocol: "openai-decisions", url: normalizeOpenAIDecisionsEndpoint(resolved.url) }
        : resolved;
    };
    // 两面共用同一个引擎归一化器时，改引擎不会造成「两面分歧」——真正的回归形状是一面改道：
    // 只把桥注入面喂给突变引擎，差异就必须出现（tripwire 对引擎侧同样灵敏）。
    const problems = evaluateParity(
      buildRows(decisionEndpointFromPage, engineResolution, SAMPLES, mutantEngine), DIFF_WHITELIST);
    if (!hasKind(problems, "new-difference")) throw new Error("桥注入面被改道后没有被抓到");
  });

  if (failures.length > 0) {
    console.error(`verify-decision-endpoint-parity self-test: ${failures.length} 项未过（${failures.join("、")}）`);
    return 1;
  }
  console.log(`verify-decision-endpoint-parity self-test: 9/9 通过（负向构造均被抓到；基线差异=0）`);
  return 0;
}

/* ------------------------------------------------------------ main */

function main(argv: readonly string[]): number {
  const flags = new Set(argv);
  const known = new Set(["--json", "--verbose", "--explain", "--self-test"]);
  for (const flag of flags) {
    if (!known.has(flag)) {
      console.error(`未知参数：${flag}\n${USAGE}`);
      return 2;
    }
  }

  // 配置键单源预检：桥的三件套键与引擎协议开关必须仍在配置 schema 的决策服务组里。
  const contractProblems: string[] = [];
  if (!DECISION_SERVICE_KEYS.includes(BRIDGE_KEY)) contractProblems.push(`${BRIDGE_KEY} 不在 DECISION_SERVICE_KEYS`);
  if (!DECISION_SERVICE_KEYS.includes(PROTOCOL_KEY)) contractProblems.push(`${PROTOCOL_KEY} 不在 DECISION_SERVICE_KEYS`);
  if (DIFF_WHITELIST.some((entry) => !(entry.family in DIFF_FAMILIES))) {
    contractProblems.push("DIFF_WHITELIST 含未登记差异族");
  }

  if (flags.has("--self-test")) {
    const status = selfTest();
    if (contractProblems.length > 0) {
      for (const message of contractProblems) console.error(`verify-decision-endpoint-parity 契约预检 FAIL ${message}`);
      return 1;
    }
    return status;
  }

  const rows = buildRows(decisionEndpointFromPage, engineResolution);
  const problems = evaluateParity(rows, DIFF_WHITELIST);

  if (flags.has("--json")) {
    console.log(JSON.stringify({
      ok: problems.length === 0 && contractProblems.length === 0,
      samples: SAMPLES.length,
      cases: rows.length,
      differences: rows.filter((row) => row.diff).length,
      whitelist: DIFF_WHITELIST.length,
      families: Object.keys(DIFF_FAMILIES),
      contractProblems,
      problems,
      rows,
    }, null, 2));
    return problems.length === 0 && contractProblems.length === 0 ? 0 : 1;
  }

  console.log(`verify-decision-endpoint-parity: ${SAMPLES.length} 个样本 / ${rows.length} 个 case / `
    + `${rows.filter((row) => row.diff).length} 个有效结果差异 / ${DIFF_WHITELIST.length} 条白名单`);
  printFamilies(flags.has("--explain"));
  printRows(rows, flags.has("--verbose"));

  for (const message of contractProblems) console.error(`[contract] FAIL ${message}`);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`[${problem.kind}] ${problem.key}: ${problem.message}`);
    }
    for (const problem of problems) {
      if (problem.kind !== "new-difference") continue;
      const row = rows.find((candidate) => candidate.key === problem.key);
      if (row === undefined) continue;
      console.error("  可用白名单条目（确认语义后填入 DIFF_WHITELIST）：");
      console.error(whitelistLiteral(row));
    }
  }
  if (problems.length > 0 || contractProblems.length > 0) {
    console.error(`verify-decision-endpoint-parity: FAIL — ${problems.length + contractProblems.length} 个问题`
      + `（新差异 ${problems.filter((problem) => problem.kind === "new-difference").length} / `
      + `漂移 ${problems.filter((problem) => problem.kind === "drift").length} / `
      + `失效白名单 ${problems.filter((problem) => problem.kind === "stale-whitelist").length} / `
      + `悬空 ${problems.filter((problem) => problem.kind === "unknown-whitelist-case").length}）`);
    return 1;
  }
  console.log("verify-decision-endpoint-parity: OK — 有效端点差异集合与白名单逐条一致（纯字符串，零网络/零浏览器/零模型）");
  return 0;
}

process.exit(main(process.argv.slice(2)));
