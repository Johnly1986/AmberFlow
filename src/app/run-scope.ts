/**
 * S1 执行内核 · RunScope（一次 run 的标识、落点与运行期投影）。
 *
 * `run_id` / `outDir` / `planPath` / `today` 的**唯一解析点**：两个 app 适配器面
 * （声明式 `runApp`、flow `runScriptApp`）不再各写一份默认值链，`ctx.runtime` 投影
 * 也由这里产出（`ctx` 自己只补 `epoch`/`dry` 等运行期字段）。
 *
 * 所有权（行为冻结）：
 *   - 默认值只**解析**、不建目录、不写盘；`planPath` 缺省 = `$AMBERFLOW_HOME/apps/<id>-plan.json`，
 *     `outDir` 缺省 = `path.dirname(planPath)`，`runId` 缺省 = `<毫秒时间戳 base36>-<pid>`。
 *   - 面与面之间的语义差异留在适配器调用点，不塞进本工厂：声明式面当前以 `planPath`
 *     派生产物目录、不看 `AppRunOptions.outDir`（那个字段只服务工具步 `{out_dir}` 占位符）；
 *     flow 面接受 `outDir`/`runId` 显式注入（CLI 与测试缝）。
 */
import path from "node:path";
import { appsOutDir } from "../support/amberflow-home.ts";

export interface RunScopeOptions {
  appId: string;
  /** 计划 checkpoint 落点。 */
  planPath?: string;
  /** 产物目录；缺省 `path.dirname(planPath)`。 */
  outDir?: string;
  /** 本次运行唯一标识（`{run_id}` / rescue 幂等键）；缺省时间戳 + pid。 */
  runId?: string;
  /** 运行日期（`ctx.runtime.today`）；缺省空串 = 数据腿按系统日期。 */
  today?: string;
}

export interface RunScope {
  planPath: string;
  outDir: string;
  runId: string;
  today: string;
  /** `ctx.runtime` 的投影（唯一出处）。 */
  runtime: { outDir: string; runId: string; today: string };
}

export function createRunScope(opts: RunScopeOptions): RunScope {
  const planPath = opts.planPath ?? path.join(appsOutDir(), `${opts.appId}-plan.json`);
  const outDir = opts.outDir ?? path.dirname(planPath);
  const runId = opts.runId ?? `${Date.now().toString(36)}-${process.pid}`;
  const today = opts.today ?? "";
  return { planPath, outDir, runId, today, runtime: { outDir, runId, today } };
}
