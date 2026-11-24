/**
 * 环境变量 typed getter —— **配置面读取的唯一入口**（L0）。
 *
 * 键集与内建默认值从 `src/support/config-schema.ts` 的 `CONFIG_GROUPS` 派生；另有若干
 * **只在环境变量层读取、不在配置面**的开关（见 `ENV_ONLY_KEYS`：浏览器通道、救援影子模式、
 * 两个实验/lane 开关）在本模块显式登记（写进 rc/用户配置仍会被未知键拒绝）。
 *
 * 消费点不再裸读 `process.env.<配置键>`：门禁 `tools/maintain/constants.ts` 把白名单外的
 * 裸读判 fail。允许的例外（平台变量 PATH/NO_COLOR/LOCALAPPDATA/VITEST/GITHUB_SHA、
 * `{{env:}}` 占位符的动态下标读取、bridge 跨进程注入）在门禁里显式登记。
 *
 * 语义与既有裸读**逐字节一致**：`readString` 不 trim（空串原样返回，等于「已设但为空」）；
 * 只有变量**未设**时才回落 schema 默认值。需要「非空白才算配置」的判空口径继续用
 * `support/decision-env.ts` 的 `envText`（它是 trim 语义的唯一出处）。
 */

import { CONFIG_GROUPS, type ConfigKeySpec } from "./config-schema.ts";

/** 结构化配置读取错误（未知键 / 非法值）；调用方据此给出可行动文案，不抛裸栈。 */
export class EnvConfigError extends Error {
  readonly code: "unknown_key" | "invalid_value";
  readonly key: string;
  readonly raw: string;
  readonly expected: string;

  constructor(code: "unknown_key" | "invalid_value", key: string, raw: string, expected: string) {
    super(code === "unknown_key"
      ? `${key} 不是配置面键：${expected}`
      : `${key}=${JSON.stringify(raw)} 不合法：需要 ${expected}`);
    this.name = "EnvConfigError";
    this.code = code;
    this.key = key;
    this.raw = raw;
    this.expected = expected;
  }
}

interface EnvEntry {
  key: string;
  default?: string;
  secret?: boolean;
  legacy?: readonly string[];
  description: string;
}

const ENTRIES = new Map<string, EnvEntry>();
for (const group of CONFIG_GROUPS) {
  for (const spec of group.keys as readonly ConfigKeySpec[]) {
    ENTRIES.set(spec.key, {
      key: spec.key,
      ...(spec.default === undefined ? {} : { default: spec.default }),
      ...(spec.secret === undefined ? {} : { secret: spec.secret }),
      ...(spec.legacy === undefined ? {} : { legacy: spec.legacy }),
      description: spec.description,
    });
  }
}

/**
 * 只在环境变量层读取、不在配置面的开关（显式登记；写进 rc/配置会被未知键拒绝）。
 * 消费点一律经本模块的 typed getter 读取，因此 src 内不再出现裸 `process.env.X`。
 */
export const ENV_ONLY_KEYS = [
  {
    key: "AMBERFLOW_BROWSER_CHANNEL",
    description: "浏览器通道（chrome | headless-shell）；部署/CI 的机器级覆盖，不在配置面",
  },
  {
    key: "AMBERFLOW_RESCUE_SHADOW",
    description: "介入/救援影子模式（仅 1 = 开）；实验开关，不在配置面",
  },
  {
    key: "AMBERFLOW_STATE_TEXT_SCOPE",
    description: "决策上下文取文范围（仅 wide = 主文档外追加子帧正文）；实验/lane 开关，不在配置面",
  },
  {
    key: "AMBERFLOW_DECISION_LADDER",
    description: "选择段执行臂 A/B 对照（仅 phase = 对照臂）；实验/lane 开关，不在配置面",
  },
] as const;

for (const spec of ENV_ONLY_KEYS) {
  ENTRIES.set(spec.key, { key: spec.key, default: "", description: spec.description });
}

/** schema 声明的 legacy 环境变量名（消费点兼容读取，不属于配置面）。 */
const LEGACY_NAMES: ReadonlySet<string> = new Set(
  CONFIG_GROUPS.flatMap((g) => g.keys.flatMap((k) => k.legacy ?? [])),
);

function entryOf(key: string): EnvEntry {
  const entry = ENTRIES.get(key);
  if (entry === undefined) {
    throw new EnvConfigError(
      "unknown_key",
      key,
      "",
      "只能用 config-schema 声明的配置键或本模块登记的 env-only 开关（见 amber config show / docs/CONFIG_REFERENCE.md）",
    );
  }
  return entry;
}

/** 变量原始值（未设 = undefined；空串 = ""，与 `process.env.X` 同语义）。 */
function rawOf(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

/** 读取字符串：未设 → schema 内建默认值（无默认 = ""）；已设（含空串）→ 原值，不 trim。 */
export function readString(key: string, env: NodeJS.ProcessEnv = process.env): string {
  const entry = entryOf(key);
  const raw = rawOf(env, key);
  return raw === undefined ? (entry.default ?? "") : raw;
}

/** 读取字符串但**保留未设 = undefined**（供 `x ?? fallback` 的既有判空写法零行为替换）。 */
export function readOptionalString(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  entryOf(key);
  return rawOf(env, key);
}

/** 读取 legacy 别名（白名单来自 schema 的 `legacy` 字段；不在配置面）。 */
export function readLegacyString(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!LEGACY_NAMES.has(name)) {
    throw new EnvConfigError(
      "unknown_key",
      name,
      "",
      "不是 schema 登记的 legacy 别名（见 docs/CONFIG_REFERENCE.md 的 legacy 段）",
    );
  }
  return rawOf(env, name);
}

function defaultValueOf(entry: EnvEntry): string | undefined {
  return entry.default;
}

/** 读取整数：未设 → schema 数字默认值（非数字默认 = undefined）；空串视为未设；非法值抛错。 */
export function readInt(key: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const entry = entryOf(key);
  const raw = rawOf(env, key);
  if (raw === undefined) {
    const fallback = defaultValueOf(entry);
    return fallback !== undefined && /^-?\d+$/.test(fallback) ? Number(fallback) : undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (!/^-?\d+$/.test(trimmed)) {
    throw new EnvConfigError("invalid_value", key, raw, "整数");
  }
  return Number(trimmed);
}

const TRUE_TOKENS: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);
const FALSE_TOKENS: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

/** 读取布尔：未设 → schema 默认值（"0"/"1" 可解析；否则 undefined）；空串视为未设；非法值抛错。 */
export function readBool(key: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const entry = entryOf(key);
  const raw = rawOf(env, key);
  if (raw === undefined) {
    const fallback = defaultValueOf(entry);
    if (fallback === "1") return true;
    if (fallback === "0") return false;
    return undefined;
  }
  const token = raw.trim().toLowerCase();
  if (token === "") return undefined;
  if (TRUE_TOKENS.has(token)) return true;
  if (FALSE_TOKENS.has(token)) return false;
  throw new EnvConfigError("invalid_value", key, raw, "布尔值（1/0/true/false/yes/no/on/off）");
}

/** 读取枚举：未设 → schema 默认值（在 allowed 内才返回）；空串视为未设；非法值抛错。 */
export function readEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
): T | undefined {
  const entry = entryOf(key);
  const raw = rawOf(env, key);
  if (raw === undefined) {
    const fallback = defaultValueOf(entry);
    return fallback !== undefined && allowed.includes(fallback as T) ? (fallback as T) : undefined;
  }
  const value = raw.trim();
  if (value === "") return undefined;
  if (allowed.includes(value as T)) return value as T;
  throw new EnvConfigError("invalid_value", key, raw, `枚举（${allowed.join(" | ")}）`);
}
