/**
 * S1 执行内核 —— `runExecution(source, deps)` 组合根。
 *
 * 四套编排（flow 脚本面 `runScriptApp`、声明式 `runApp`、计划面 `runPlan`、套件面
 * `runOneCase`）共享同一条运行骨架；本模块是这组共享职责的**唯一出处**：
 *
 *   - **SessionLease**：惰性创建、`finally` 关闭一次（租约实现见 `session-lease.ts`）；
 *   - **RunScope**：`plan_path` / `outDir` / `runId` / `today` 的唯一解析点（`run-scope.ts`），
 *     并把产物目录交给适配器（`artifacts`，只交接、不建目录——谁写谁建）；
 *   - **执行器装配入口**：一个 run 最多一个执行器；首次 `middleware()` 才装配，
 *     显式实例（调用方已装配的 plan 面）与工厂（app/suite 面）都经这一个入口；
 *     收尾事实（降级/指标）也从这里读一次（`middlewareFacts`）；
 *   - **节奏时钟**：env-only 脸（plan/suite）共享同一份 `envPace` 解析与 `PaceClock`；
 *     单元边界与等待点仍归源适配器（内核不内嵌 sleep，见 `docs/MAINLINE.md` §4.1）；
 *   - **attempt 记账**：执行单元尝试次数的单点账本（重入覆盖为最新一次）；
 *   - **停因分类**：`stop_code` → 闭集类别（`budget` / `config` / `terminal`）的单点，
 *     配置类停因同时是 plan 重试的 NEVER_RETRY 名单（`CONFIG_CLASS_STOPS`）。
 *
 * **不共享**（刻意留在源适配器）：flow 的脚本控制流与结束态不变量、plan 的子目标循环/
 * retries/replan、suite 的用例 preflight/oracle/证据；以及一切业务判定（`checkSignal` /
 * `ctx.done`）。本模块不读页面、不写盘、不调模型。
 */
import { createSessionLease, type SessionLease } from "./session-lease.ts";
import { createRunScope, type RunScope } from "./run-scope.ts";
import { envPace, newPaceClock, type PaceClock } from "../support/pace.ts";
import type { BrowserMiddleware } from "./executor.ts";
import type { BrowserSession, DecisionStateMetrics } from "./executor-types.ts";

/** 源适配器标识（只用于账/错误文案；不改变行为）。 */
export type RunSourceKind = "flow" | "declared-flow" | "plan" | "suite";

/* ------------------------------------------------------------------ 停因分类 */

/** 预算用满的停因（执行事实：已执行的步是真的，不是配置错误）。 */
export const BUDGET_STOP_CODE = "budget_exceeded";

/**
 * 配置类停因：重试只会重复同一句拒绝与同一批副作用（见 `planner.runSubgoalWithRetries`
 * 的重试纪律）。plan 面的 NEVER_RETRY 名单直接引用本集合，不另抄一份。
 */
export const CONFIG_CLASS_STOPS: ReadonlySet<string> = new Set([
  "config_error", "host_not_allowed", "needs_value",
  "nominated_family_empty",
]);

export type StopClass = "none" | "budget" | "config" | "terminal";

/**
 * 停因分类单点：`none`（没有停因）/ `budget`（预算用满）/ `config`（配置类，重试无效）/
 * `terminal`（其余执行期停因——是否可重试由源适配器按业务语义决定）。
 */
export function classifyStop(stopCode: string | undefined): StopClass {
  if (stopCode === undefined || stopCode === "") return "none";
  if (stopCode === BUDGET_STOP_CODE) return "budget";
  return CONFIG_CLASS_STOPS.has(stopCode) ? "config" : "terminal";
}

/* ------------------------------------------------------------------ attempt 记账 */

/**
 * 执行单元的尝试账本：源适配器在每次执行单元结束后记录该单元的尝试次数
 * （单元键由源给：`plan:<desc>` / `case:<id>:<i>` / `step:<id>`），产物里的
 * `attempts` 从账本读回。重入覆盖为最新一次——与各源既有的 `sg.attempts = attempt`
 * 语义一致（续跑/回边重访时看的是最近一次）。
 */
export interface AttemptLedger {
  /** 记录并返回该单元的尝试次数。 */
  record(unit: string, attempts: number): number;
  /** 某单元最近一次记录的尝试次数（未记录 = 0）。 */
  count(unit: string): number;
}

export function createAttemptLedger(): AttemptLedger {
  const units = new Map<string, number>();
  return {
    record(unit: string, attempts: number): number {
      units.set(unit, attempts);
      return attempts;
    },
    count(unit: string): number {
      return units.get(unit) ?? 0;
    },
  };
}

/* ------------------------------------------------------------------ 收尾事实 */

/** 决策面兼容降级的留痕（与执行器 `decisionDegraded` 同形；进 result.decision）。 */
export interface DecisionDegradedFact {
  reason_class: "unreachable" | "auth" | "protocol" | "midrun_death" | "unknown";
  message: string;
  config_source: string;
}

/**
 * 执行器收尾事实（「收尾读一次」的单一入口）：降级原因与决策指标都只在执行器实例上，
 * 两个 app 面各自 `?? null` 抄一遍容易漏字段——这里一次取齐。
 * 执行器从未装配（例如 replay 面/零浏览器步）时全部为 null。
 */
export interface MiddlewareFacts {
  providerDegraded: string | null;
  riskDegraded: string | null;
  decisionDegraded: DecisionDegradedFact | null;
  decisionStateMetrics: DecisionStateMetrics | null;
  rejectedAskConf: { n: number; min: number | null; max: number | null } | null;
}

/* ------------------------------------------------------------------ 组合根 */

/** 一次 run 的产物落点（RunScope 的投影；只交接、不创建）。 */
export interface RunArtifactDirs {
  outDir: string;
  planPath: string;
  runId: string;
}

/** env 层节奏生效值（0 = 未设；坏值在首次读取时响亮报错）与各字段来源。 */
export interface EnvPaceFacts {
  betweenStepsMs: number;
  betweenActionsMs: number;
  sources: { betweenStepsMs: "env" | "default"; betweenActionsMs: "env" | "default" };
}

export interface RunExecutionDeps {
  source: RunSourceKind;
  /** app 面：应用包 id（RunScope 的默认值链需要）；plan/suite 缺省 = 源标识。 */
  appId?: string;
  planPath?: string;
  outDir?: string;
  runId?: string;
  today?: string;
  /** 惰性会话创建；缺省 = 本 run 不使用浏览器（replay/dry 面不会调用 `session()`）。 */
  createSession?: () => Promise<BrowserSession>;
  /** 已装配的执行器（plan 面由调用方装配）或工厂（app/suite 面首个 `middleware()` 调用时装配）。 */
  middleware?: BrowserMiddleware | (() => BrowserMiddleware);
  /** 运行预算（`--max-steps`）：用满 = `partial` 执行事实（见 `budgetExhausted`）。 */
  maxSteps?: number;
  /**
   * 已解析的 env 节奏 + 跨单元共享时钟（suite 在套件层解析一次、按 case 传下来）；
   * 缺省 = 内核在该源首次读取时懒解析 `process.env`。
   */
  pace?: {
    clock: PaceClock;
    betweenActionsMs: number;
    /** 各字段来源（plan 面的节奏日志用；suite 不打印，缺省按 default 记）。 */
    sources?: { betweenStepsMs: "env" | "default"; betweenActionsMs: "env" | "default" };
  };
}

export interface RunExecution {
  readonly source: RunSourceKind;
  /** RunScope：一次 run 的标识、落点与 `ctx.runtime` 投影（唯一解析点）。 */
  readonly scope: RunScope;
  /** 产物目录交接（= RunScope 的投影）。 */
  readonly artifacts: RunArtifactDirs;
  /** attempt 记账单点。 */
  readonly attempts: AttemptLedger;
  /** 会话：首次调用才创建；失败可重试（租约语义）。 */
  session(): Promise<BrowserSession>;
  /** 同步读已创建会话（不触发创建）；未创建/已关闭 = null。 */
  peekSession(): BrowserSession | null;
  /** 本 run 唯一的执行器：已有实例/已装配则原样返回；否则用显式 factory 或 deps 工厂装配一次。 */
  middleware(factory?: () => BrowserMiddleware): BrowserMiddleware;
  middlewareOrNull(): BrowserMiddleware | null;
  /** 收尾事实（执行器未装配 = 全 null）。 */
  middlewareFacts(): MiddlewareFacts;
  /** env 层节奏（懒解析一次；坏值在此响亮报错）。 */
  envPace(): EnvPaceFacts;
  /** 跨单元共享的节奏时钟（按 env 间距；单元边界仍归源适配器）。 */
  paceClock(): PaceClock;
  /** 停因分类单点（见 `classifyStop`）。 */
  classifyStop(stopCode: string | undefined): StopClass;
  /** 预算用满的 partial 判定（本次显式声明了预算才算 partial）。 */
  budgetExhausted(stopCode: string | undefined): boolean;
  /** 关闭会话（幂等；内核 `finally` 也会关一次）。 */
  close(): Promise<void>;
}

/**
 * 跑一个源适配器：内核创建 RunScope / 会话租约 / attempt 账本，并在 `finally` 关闭会话一次；
 * 源适配器在回调里只写自己的控制流与业务判定。
 *
 * @throws 源适配器抛出的任何错误（关闭会话后再抛，结果不被 close 覆盖）。
 */
export async function runExecution<T>(
  deps: RunExecutionDeps,
  source: (run: RunExecution) => Promise<T>,
): Promise<T> {
  const scope = createRunScope({
    appId: deps.appId ?? deps.source,
    planPath: deps.planPath,
    outDir: deps.outDir,
    runId: deps.runId,
    today: deps.today,
  });
  const lease: SessionLease | null = deps.createSession === undefined
    ? null
    : createSessionLease(deps.createSession);
  const attempts = createAttemptLedger();

  let middlewareInstance: BrowserMiddleware | null = typeof deps.middleware === "function"
    ? null
    : (deps.middleware ?? null);
  let middlewareFactory: (() => BrowserMiddleware) | null = typeof deps.middleware === "function"
    ? deps.middleware
    : null;
  let paceCache: EnvPaceFacts | null = deps.pace === undefined
    ? null
    : {
      betweenStepsMs: deps.pace.clock.gapMs,
      betweenActionsMs: deps.pace.betweenActionsMs,
      sources: deps.pace.sources ?? { betweenStepsMs: "default", betweenActionsMs: "default" },
    };
  let paceClock: PaceClock | null = deps.pace?.clock ?? null;

  const readEnvPace = (): EnvPaceFacts => {
    if (paceCache === null) {
      const parsed = envPace(process.env);
      paceCache = {
        betweenStepsMs: parsed.between_steps_ms ?? 0,
        betweenActionsMs: parsed.between_actions_ms ?? 0,
        sources: {
          betweenStepsMs: parsed.between_steps_ms === undefined ? "default" : "env",
          betweenActionsMs: parsed.between_actions_ms === undefined ? "default" : "env",
        },
      };
    }
    return paceCache;
  };

  const close = async (): Promise<void> => {
    if (lease !== null) await lease.close();
  };

  const run: RunExecution = {
    source: deps.source,
    scope,
    artifacts: { outDir: scope.outDir, planPath: scope.planPath, runId: scope.runId },
    attempts,
    async session(): Promise<BrowserSession> {
      if (lease === null) {
        throw new Error(`runExecution(${deps.source}): this run declared no session factory (createSession)`);
      }
      return lease.get();
    },
    peekSession(): BrowserSession | null {
      return lease === null ? null : lease.peek();
    },
    middleware(factory?: () => BrowserMiddleware): BrowserMiddleware {
      if (middlewareInstance !== null) return middlewareInstance;
      const build = middlewareFactory ?? factory;
      if (build === undefined || build === null) {
        throw new Error(`runExecution(${deps.source}): this run declared no middleware assembly entry`);
      }
      middlewareInstance = build();
      return middlewareInstance;
    },
    middlewareOrNull(): BrowserMiddleware | null {
      return middlewareInstance;
    },
    middlewareFacts(): MiddlewareFacts {
      const mw = middlewareInstance;
      if (mw === null) {
        return {
          providerDegraded: null, riskDegraded: null, decisionDegraded: null,
          decisionStateMetrics: null, rejectedAskConf: null,
        };
      }
      return {
        providerDegraded: mw.providerDegraded.length > 0 ? mw.providerDegraded : null,
        riskDegraded: mw.riskDegraded,
        decisionDegraded: mw.decisionDegraded,
        decisionStateMetrics: mw.decisionStateMetrics(),
        rejectedAskConf: mw.rejectedAskConfMetrics(),
      };
    },
    envPace: readEnvPace,
    paceClock(): PaceClock {
      if (paceClock === null) paceClock = newPaceClock(readEnvPace().betweenStepsMs);
      return paceClock;
    },
    classifyStop,
    budgetExhausted(stopCode: string | undefined): boolean {
      return deps.maxSteps !== undefined && classifyStop(stopCode) === "budget";
    },
    close,
  };

  try {
    return await source(run);
  } finally {
    await close();
  }
}
