import fs from "node:fs";
import path from "node:path";
import { REPO } from "../support/paths.ts";
import { amberflowHome } from "../app/amberflow-home.ts";
import { loadRc, maskValue, RC_GROUPS } from "../support/rcfile.ts";

/** 新配置层沿用旧 rc 的白名单：只有同一个键集合，迁移才不是“再发明一套”。 */
export const CONFIG_KEYS: readonly string[] = [...new Set(RC_GROUPS.flatMap((g) => g.keys))];
const KNOWN = new Set(CONFIG_KEYS);

export function isKnownConfigKey(key: string): boolean {
  return KNOWN.has(key);
}

export function isSecretKey(key: string): boolean {
  return /API_KEY|SECRET|PASSWORD|ACCESS_TOKEN/.test(key);
}

export interface ConfigLayer {
  name: string;
  path: string | null;
  exists: boolean;
  values: Record<string, string>;
  errors: string[];
}

export interface ResolvedConfig {
  layers: ConfigLayer[];
  /** 有效值 + 来源层；只含白名单键。 */
  values: Record<string, { value: string; source: string; secret: boolean }>;
  /** 已把文件层的值补进 baseEnv 的环境（环境变量本身仍然赢）。 */
  env: NodeJS.ProcessEnv;
  errors: string[];
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(amberflowHome(env), "config.json");
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".amberflow", "config.json");
}

export function legacyConfigPath(): string {
  return path.join(REPO, "configs", "amberflowrc.json");
}

export function readConfigFile(file: string, name: string): ConfigLayer {
  if (!fs.existsSync(file)) return { name, path: file, exists: false, values: {}, errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    return {
      name, path: file, exists: true, values: {},
      errors: [`${file} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`],
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { name, path: file, exists: true, values: {}, errors: [`${file} 顶层必须是对象（键 → 字符串值）`] };
  }
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "_doc") continue;
    if (!KNOWN.has(key)) {
      errors.push(`${file} 有未知键 ${JSON.stringify(key)}——可用键见 amber config show / configs/amberflowrc.example.json`);
      continue;
    }
    if (typeof value !== "string") {
      errors.push(`${file} 的 ${key} 必须是字符串（收到 ${JSON.stringify(value)}）`);
      continue;
    }
    values[key] = value;
  }
  return { name, path: file, exists: true, values, errors };
}

/**
 * 层叠：旧 rc < 用户配置 < 项目配置（或显式 --config）< 环境变量。
 * 旧 rc 继续只读；新命令不写它。
 */
export function resolveConfig(
  baseEnv: NodeJS.ProcessEnv,
  cwd: string,
  explicitConfig: string | null = null,
): ResolvedConfig {
  const legacyLoad = baseEnv.VITEST !== undefined
    ? { path: null, values: {}, errors: [] as string[] }
    : loadRc(REPO);
  const legacy: ConfigLayer = {
    name: "旧 rc", path: legacyLoad.path ?? legacyConfigPath(), exists: legacyLoad.path !== null,
    values: legacyLoad.values, errors: legacyLoad.errors,
  };

  const layers: ConfigLayer[] = [legacy];
  if (explicitConfig) {
    layers.push(readConfigFile(path.resolve(cwd, explicitConfig), "显式配置"));
  } else {
    layers.push(readConfigFile(userConfigPath(baseEnv), "用户配置"));
    layers.push(readConfigFile(projectConfigPath(cwd), "项目配置"));
  }

  const env = { ...baseEnv };
  const values: ResolvedConfig["values"] = {};
  for (const key of CONFIG_KEYS) {
    const envValue = baseEnv[key];
    if (envValue !== undefined && envValue !== "") {
      values[key] = { value: envValue, source: "环境变量", secret: isSecretKey(key) };
      continue;
    }
    for (const layer of layers) {
      const v = layer.values[key];
      if (v === undefined || v === "") continue;
      env[key] = v;
      values[key] = { value: v, source: layer.name, secret: isSecretKey(key) };
    }
  }

  return {
    layers,
    values,
    env,
    errors: layers.flatMap((l) => l.errors.map((e) => `${l.name}：${e}`)),
  };
}

/** `config show` 的唯一掩码入口，避免命令和存储层各写一套。 */
export function displayValue(key: string, value: string): string {
  return maskValue(key, value);
}

export function selectedConfigPath(
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
  explicitConfig: string | null,
  project: boolean,
): string {
  if (explicitConfig) return path.resolve(cwd, explicitConfig);
  return project ? projectConfigPath(cwd) : userConfigPath(baseEnv);
}

function readRawObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`${file} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} 顶层必须是对象（键 → 字符串值）`);
  }
  return { ...(raw as Record<string, unknown>) };
}

export function writeConfigValue(file: string, key: string, value: string): void {
  const raw = readRawObject(file);
  raw[key] = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
}

export function removeConfigValue(file: string, key: string): boolean {
  if (!fs.existsSync(file)) return false;
  const raw = readRawObject(file);
  if (!(key in raw)) return false;
  delete raw[key];
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
  return true;
}

export function initConfigFile(file: string): boolean {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n", "utf-8");
  return true;
}
