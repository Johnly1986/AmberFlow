/**
 * 应用包的**单一校验入口**（P0-C）。
 *
 * 为什么需要它：`validatePack` 管包内契约（键、槽位、信号、命令、跨引用对账），
 * 但它对**数据源配置**只做"存在性"检查（`loadSource`），不跑 `validateSource` 的 schema 校验——
 * 于是 `sources/*.json` 写错（未知 extractor / 未知算子 / 坏日期表达式）在应用路径上**静默放行**，
 * 直到运行时才以空数据或奇怪报错出现。另一个官方入口（datasource 自身 CLI）却是校验的：
 * 同一个配置文件，两条入口两种严格度，就是"配了却像没配"。
 *
 * 本模块把它们收成一个入口：`validateApp = validatePack + 数据源 schema 校验`。
 * **不新增规则**：每一项都来自既有实现（`validatePack` / `validateSource`）。
 * 调用方只需记住一个名字，不再需要知道"应用路径少校验了哪一半"。
 */
import { validatePack, type AppPack } from "./app-pack.ts";
import { loadSource, validateSource } from "../data/datasource.ts";

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 包会加载的全部数据源名：`sources` 声明 + 旅程里工具步引用的 `source`
 * （角色模板与内联步按既有规则合并，内联优先）。
 */
export function appSourceNames(pack: AppPack): string[] {
  const names = new Set<string>();
  for (const s of Array.isArray(pack.sources) ? pack.sources : []) names.add(String(s));
  const roles = isDict(pack.roles) ? pack.roles : {};
  for (const e of Array.isArray(pack.journey) ? pack.journey : []) {
    if (!isDict(e)) continue;
    const role = typeof e["role"] === "string" ? roles[e["role"] as string] : undefined;
    const merged = { ...(isDict(role) ? role : {}), ...e };
    if (merged["source"] !== undefined && merged["source"] !== null) names.add(String(merged["source"]));
  }
  return [...names].sort();
}

export interface ValidateAppOptions {
  slots?: Record<string, unknown>;
  /** L2 flow 脚本没有静态旅程（见 `validatePack` 的 allowEmptyJourney）。 */
  allowEmptyJourney?: boolean;
  /** 测试/工具可指定数据源目录（与 `loadSource(name, dirs)` 同口径；缺省 = 发现制默认根）。 */
  sourceDirs?: string[] | null;
}

/**
 * 应用包的单一校验入口。返回 problem 字符串（与 `validatePack` 同款口径，由调用方汇总/抛）。
 *
 * 数据源分两步：**缺失**由 `validatePack` 报（保持原文案，不重复）；**存在但 schema 坏**由
 * `validateSource` 报，统一加 `source "<name>":` 前缀，让作者一眼知道是哪个文件。
 */
export function validateApp(pack: AppPack, opts: ValidateAppOptions = {}): string[] {
  const problems = validatePack(pack, {
    ...(opts.slots === undefined ? {} : { slots: opts.slots }),
    ...(opts.allowEmptyJourney === true ? { allowEmptyJourney: true } : {}),
  });
  for (const name of appSourceNames(pack)) {
    let src: ReturnType<typeof loadSource>;
    try {
      src = loadSource(name, opts.sourceDirs ?? null);
    } catch {
      continue;                                   // 缺失：validatePack 已用既有文案报过
    }
    for (const p of validateSource(src)) problems.push(`source ${JSON.stringify(name)}: ${p}`);
  }
  return problems;
}
