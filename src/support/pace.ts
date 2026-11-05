/**
 * pace —— 运行节奏（步/动作间间距）的**唯一来源模块**（B1 节奏统一）。
 *
 * 为什么在 support/：engine（planner）、app（app-runner/ctx）、online（runner）三脸都要
 * 用同一份语义与同一个 env 口径，而 support 是三层都能 import 的中性层（engine → support、
 * app → support、online → support，无环；本模块不 import 任何上层）。
 *
 * 语义（2026-11-05 拍板）：**最小步间距（start-to-start ≥ gap）**——相邻两次引擎单元
 * **开始时刻**至少隔 gap 毫秒；上一步耗时长则本步**不补等**（不再是「无条件 sleep」）。
 * 等待量 = `paceRemainder(gap, 上一次单元开始时刻, now)`。三脸共用这份计算与 env 口径，
 * 各自持有自己的时钟：
 *   - flow：单元 = ctx 引擎调用（step/arrive/manual/run/scrollList/expand/setRange/collect）；
 *   - 声明式：单元 = journey 步（runApp 循环）；
 *   - 规划/online：单元 = 子目标的每次 attempt（重试之间同值等待，见 PaceClock）。
 * 共同纪律：**首个单元之前不等**（时钟未启动 = remainder 0）。
 * 边界：正确性等待（settle/轮询/退避）不在这里——见 docs/PACE_UNIFICATION_PLAN.md §1.2；
 * dry 面不模拟等待（pace 是节奏不是断言）。
 */

/** env 层的两个旋钮（坏值响亮报错；0..60000 整数，口径与 resolvePace 一致）。 */
export const STEP_DELAY_ENV = "AMBERFLOW_STEP_DELAY_MS";
export const ACTION_DELAY_ENV = "AMBERFLOW_ACTION_DELAY_MS";

/** env 坏值 = 配置类错误：响亮报错而不是静默当 0。 */
export class PaceConfigError extends Error {}

/** 单字段的生效来源（与 `effective_policy` / resolvePace 同一标源纪律）。 */
export type PaceSource = "explicit" | "meta" | "env" | "default";

export interface PaceValues {
  between_steps_ms: number;
  between_actions_ms: number;
}

type PaceKey = keyof PaceValues;

/**
 * env 层节奏（规划脸/online 的唯一可用来源）：只返回 env 提供的键；
 * 规划脸无 pack/meta，`meta.pace` 仍是应用脸专属（文档口径：规划脸节奏 = env-only）。
 */
export function envPace(env: NodeJS.ProcessEnv): Partial<PaceValues> {
  const out: Partial<PaceValues> = {};
  const read = (key: PaceKey, envKey: string): void => {
    const raw = env[envKey];
    if (raw === undefined || raw === "") return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 60_000) {
      throw new PaceConfigError(`${envKey}=${JSON.stringify(raw)} 不合法：需要 0..60000 的整数毫秒`);
    }
    out[key] = n;
  };
  read("between_steps_ms", STEP_DELAY_ENV);
  read("between_actions_ms", ACTION_DELAY_ENV);
  return out;
}

/** 一次运行的节奏生效值（结果只写非默认值；缺省字段不出现 = 默认档逐字节一致）。 */
export interface ResolvedPace extends PaceValues {
  /**
   * 每个字段的生效来源（与 `effective_policy` 同一标源纪律；01 轮 B5：作者看到 1000ms
   * 却不知从哪来）。`env` 含入口引导时从 `configs/amberflowrc.json` / amber config 吸收进
   * 环境变量的值——想区分到具体文件，用 `amber doctor` / `amber config show` 对照。
   */
  sources: { between_steps_ms: PaceSource; between_actions_ms: PaceSource };
}

/** 声明面的最小结构（pack.pace / 本次显式 opts.pace）——不 import app 层类型，保持中性。 */
export type PaceDecl = { between_steps_ms?: number; between_actions_ms?: number } | undefined;

/** 完整解析：explicit > meta > env > 0 + sources 标注（实现自 app-runner 迁入，B1）。 */
export function resolvePace(
  packPace: PaceDecl,
  explicitPace: PaceDecl,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPace {
  const fromEnv = envPace(env);
  const pick = (key: PaceKey): { value: number; source: PaceSource } => {
    const explicit = explicitPace?.[key];
    if (explicit !== undefined) return { value: explicit, source: "explicit" };
    const declared = packPace?.[key];
    if (declared !== undefined) return { value: declared, source: "meta" };
    const fromE = fromEnv[key];
    return fromE !== undefined ? { value: fromE, source: "env" } : { value: 0, source: "default" };
  };
  const steps = pick("between_steps_ms");
  const actions = pick("between_actions_ms");
  return {
    between_steps_ms: steps.value,
    between_actions_ms: actions.value,
    sources: { between_steps_ms: steps.source, between_actions_ms: actions.source },
  };
}

/** 结果可见性（与 `effective_policy` 同口径）：任一键非 0 或来源非 default 才出现 pace 字段。 */
export function paceNonDefault(p: ResolvedPace): boolean {
  return p.between_steps_ms > 0 || p.between_actions_ms > 0
    || p.sources.between_steps_ms !== "default" || p.sources.between_actions_ms !== "default";
}

/**
 * 最小间距语义的核心计算（三脸共用）：上一个引擎单元开始于 `lastUnitStartTs`
 * （undefined = 本次运行还没有单元 → 首个不等），现在时刻 `now`，下一单元还要等多少毫秒
 * 才能保证 start-to-start ≥ gapMs。gapMs ≤ 0 恒 0。
 */
export function paceRemainder(gapMs: number, lastUnitStartTs: number | undefined, now: number): number {
  if (gapMs <= 0) return 0;
  if (lastUnitStartTs === undefined) return 0;
  return Math.max(0, gapMs - (now - lastUnitStartTs));
}

/**
 * 规划脸/online 共用的节奏时钟：调用方创建并持有，跨子目标/重试/用例共享同一份
 * `lastStart`（单元 = attempt）。这样「上一 attempt → 下一子目标首 attempt」之间也满足
 * 同一个最小间距，而不是按子目标各自重算。
 */
export interface PaceClock {
  /** 生效的子目标/重试间距（毫秒；0 = 不等待）。 */
  gapMs: number;
  /** 上一个引擎单元（attempt）的开始时刻；undefined = 本次运行还没有单元。 */
  lastStart?: number;
  /** 本次累计实际等待（online 套件的 `total_waited_ms` 标注）。 */
  waitedMs: number;
}

export function newPaceClock(gapMs: number): PaceClock {
  return { gapMs, waitedMs: 0 };
}

/**
 * 引擎单元（attempt/用例）开始前的最小间距等待 + 时钟推进：等 `paceRemainder` 毫秒
 * （>0 时可经 `log` 打一行节奏），然后把 `lastStart` 推进到本单元的开始时刻。
 * `gapMs = 0` 的时钟是全 no-op（默认档与旧调用零感知）。
 */
export async function paceBeforeUnit(clock: PaceClock, log?: (waitMs: number) => void): Promise<void> {
  if (clock.gapMs <= 0) return;
  const now = Date.now();
  const wait = paceRemainder(clock.gapMs, clock.lastStart, now);
  if (wait > 0) {
    clock.waitedMs += wait;
    log?.(wait);
    await new Promise((r) => setTimeout(r, wait));
  }
  clock.lastStart = now + wait;
}
