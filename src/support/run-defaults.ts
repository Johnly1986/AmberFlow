/**
 * **运行参数配置默认值**：`--headful` / `--conf-floor` / `--tiered-hint` /
 * `--confirm-safe` / `--no-sources` / `--quiet` 这些旗标可以写进配置文件，CLI 显式旗标仍然赢。
 *
 * 层叠（由 `resolveConfig` 保证）：命令行旗标 > 环境变量 > 项目配置 > 全局配置 > 旧 rc > 缺省。
 * 这里只做"env → 强类型默认值"的解析；配置文件本身由 `config-store` 读进 env。
 *
 * 为什么 `--allow-dangerous` 不在这里：危险动作的默认放行不能是"某台机器上悄悄配过"，
 * 必须每次在命令里显式出现。`AMBERFLOW_CONFIRM_SAFE` 的缺省是 `1`（安全）；只有显式配 `0`
 * 或命令行 `--confirm-unsafe` 才恢复旧的放行行为。
 */

export { RUN_DEFAULT_KEYS } from "./config-schema.ts";

export interface RunDefaults {
  headful?: boolean;
  confFloor?: number;
  tieredHint?: boolean;
  confirmSafe?: boolean;
  noSources?: boolean;
  quiet?: boolean;
  /** E2：歧义命中顺序（decision.ambiguous_ordering；缺省 dom-preorder）。 */
  ambiguousOrdering?: "dom-preorder" | "pool-order";
  /** E1-c：act #id 直查兜底（decision.id_fallback；缺省 true）。 */
  idFallback?: boolean;
  /** E1-a：act 池上限（decision.act_pool_cap；空 = 引擎默认 40，仅观测面可配）。 */
  actPoolCap?: number;
  /** E1-b：池配额模型（decision.pool_quota_mode；缺省 legacy）。 */
  poolQuotaMode?: "legacy" | "quota";
}

export interface ParsedRunDefaults {
  defaults: RunDefaults;
  errors: string[];
}

/** 空串 = 没设（与 rc/配置层"留空占位"同一口径）。非法值 = 配置错误，不静默当 false。 */
export function parseRunDefaults(env: NodeJS.ProcessEnv = process.env): ParsedRunDefaults {
  const errors: string[] = [];
  const defaults: RunDefaults = {};
  const raw = (key: string): string | undefined => {
    const v = env[key];
    if (v === undefined || v.trim() === "") return undefined;
    return v.trim();
  };
  const bool = (key: string, set: (v: boolean) => void): void => {
    const v = raw(key);
    if (v === undefined) return;
    const lower = v.toLowerCase();
    if (["1", "true", "yes", "on"].includes(lower)) { set(true); return; }
    if (["0", "false", "no", "off"].includes(lower)) { set(false); return; }
    errors.push(`${key}=${JSON.stringify(v)} 不合法：布尔值用 true/false（或 1/0、on/off）`);
  };

  bool("AMBERFLOW_HEADFUL", (v) => { defaults.headful = v; });
  bool("AMBERFLOW_TIERED_HINT", (v) => { defaults.tieredHint = v; });
  bool("AMBERFLOW_CONFIRM_SAFE", (v) => { defaults.confirmSafe = v; });
  bool("AMBERFLOW_NO_SOURCES", (v) => { defaults.noSources = v; });
  bool("AMBERFLOW_QUIET", (v) => { defaults.quiet = v; });

  const floorRaw = raw("AMBERFLOW_CONF_FLOOR");
  if (floorRaw !== undefined) {
    const n = Number(floorRaw);
    if (!Number.isFinite(n) || n <= 0 || n > 1) {
      errors.push(`AMBERFLOW_CONF_FLOOR=${JSON.stringify(floorRaw)} 不合法：需要 (0, 1] 之间的数`);
    } else {
      defaults.confFloor = n;
    }
  }

  // ---- 决策开关（decision.*，行为变更面；非法值 = 配置错误，绝不静默取缺省）----

  const orderingRaw = raw("AMBERFLOW_AMBIGUOUS_ORDERING");
  if (orderingRaw !== undefined) {
    if (orderingRaw === "dom-preorder" || orderingRaw === "pool-order") {
      defaults.ambiguousOrdering = orderingRaw;
    } else {
      errors.push(`AMBERFLOW_AMBIGUOUS_ORDERING=${JSON.stringify(orderingRaw)} 不合法：只接受 dom-preorder | pool-order`);
    }
  }

  bool("AMBERFLOW_ID_FALLBACK", (v) => { defaults.idFallback = v; });

  const capRaw = raw("AMBERFLOW_ACT_POOL_CAP");
  if (capRaw !== undefined) {
    const n = Number(capRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 500) {
      errors.push(`AMBERFLOW_ACT_POOL_CAP=${JSON.stringify(capRaw)} 不合法：需要 1..500 的整数`);
    } else {
      defaults.actPoolCap = n;
    }
  }

  const quotaRaw = raw("AMBERFLOW_POOL_QUOTA_MODE");
  if (quotaRaw !== undefined) {
    if (quotaRaw === "legacy" || quotaRaw === "quota") {
      defaults.poolQuotaMode = quotaRaw;
    } else {
      errors.push(`AMBERFLOW_POOL_QUOTA_MODE=${JSON.stringify(quotaRaw)} 不合法：只接受 legacy | quota`);
    }
  }
  return { defaults, errors };
}
