import { usageFromParseError, type CliError } from "./errors.ts";

/**
 * 旧旗标 → 新旗标。归一化只做**无歧义**的替换：`--plan` 的旧含义依赖命令
 * （`start --plan` 是保存位置，`plan-cli --file` 是输入），由命令/兼容层处理，
 * 不放进这张全局表。
 */
const ALIASES: Record<string, string> = {
  "--dry": "--dry-run",
  "--no-sources": "--skip-data",
  "--learn-hints": "--remember",
  "--hint-memory": "--memory",
  "--conf-floor": "--min-confidence",
  "--model": "--checkpoint",
  "--hint": "--target",
};

export function normalizeAliases(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // 旧 `--force-hints off` 是双 token 的布尔别名，不能靠单词映射。
    if (a === "--force-hints" && args[i + 1] === "off") {
      out.push("--without-hints");
      i++;
      continue;
    }
    if (a === "--force-hints=off") {
      out.push("--without-hints");
      continue;
    }
    out.push(ALIASES[a] ?? a);
  }
  return out;
}

/**
 * `--plan [文件]` 是可选值。Node parseArgs 的 string 选项缺值会直接报错，
 * 所以在解析前把裸 `--plan` 补成默认路径。
 */
export function injectOptionalValue(args: readonly string[], flag: string, value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        out.push(a, value);
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/** `--json` 在参数里的任意位置出现（用于错误输出选择；正式解析仍由命令决定）。 */
export function hasFlag(args: readonly string[], ...names: string[]): boolean {
  return args.some((a) => names.includes(a) || names.some((n) => a.startsWith(`${n}=`)));
}

export function parseOrThrow(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (err) {
    throw usageFromParseError(err) as CliError;
  }
}

/** 列表参数：可重复 + 逗号分隔（旧脚本常见的混合写法）。 */
export function stringValue(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function boolValue(v: unknown): boolean {
  return v === true;
}

export function flatList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return values.flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean));
}

export function parseSlots(values: readonly string[] | undefined): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const item of flatList(values)) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new Error(`--slot 要写成 k=v（收到 ${JSON.stringify(item)}）`);
    slots[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return slots;
}
