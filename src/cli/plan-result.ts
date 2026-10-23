import type { CliContext } from "./context.ts";
import { emitJson } from "./context.ts";
import { successEnvelope } from "./json.ts";

/**
 * 执行类旧入口（plan-cli / start）不返回结构化结果，但都会把步骤状态写回计划。
 * 统一从计划文件重建 §5.3 的 data，避免每个入口各写一份状态口径。
 */
export async function emitPlanStatus(
  ctx: CliContext,
  opts: {
    file: string;
    pathLabel: string;
    mode: "plan" | "demo" | "goal";
    command?: string;
    code: number;
    dryRun?: boolean;
    fallbackGoal?: string;
    next?: string[];
  },
): Promise<number> {
  const { TaskPlan } = await import("../engine/plan.ts");
  const plan = TaskPlan.load(opts.file);
  const subgoals = plan?.subgoals ?? [];
  const done = subgoals.filter((s) => s.status === "done" || s.status === "skipped").length;
  const steps = subgoals.map((s, i) => ({
    index: i + 1, id: s.id ?? null, desc: s.desc, status: s.status,
    obstacle: s.obstacle ?? null,
  }));
  const next = opts.next ?? (opts.code === 0
    ? ["amber plan show", `amber run --plan ${opts.pathLabel}`]
    : ["amber plan show", "amber plan check"]);
  const envelope = successEnvelope(opts.command ?? "run", {
    mode: opts.mode,
    ...(opts.dryRun ? { dry_run: true } : {}),
    path: opts.pathLabel,
    goal: plan?.goal ?? opts.fallbackGoal ?? "",
    completed: `${done}/${subgoals.length}`,
    skipped: subgoals.filter((s) => s.status === "skipped").length,
    steps,
  }, { exitCode: opts.code, next });
  if (opts.code !== 0) {
    envelope.ok = false;
    envelope.error = {
      code: opts.code === 130 ? "INTERRUPTED" : opts.code === 3 ? "BLOCKED" : opts.code === 2 ? "USAGE" : "INCOMPLETE",
      message: `计划未跑完（退出码 ${opts.code}）`,
      hint: "步骤状态在 data.steps；执行日志在 stderr。",
      next,
    };
  }
  emitJson(ctx, envelope);
  return opts.code;
}
