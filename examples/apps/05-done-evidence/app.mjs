/**
 * 05-done-evidence —— A1「动作执行证据与 done 诚实性」的声明面示例。
 *
 * 演示三件事（全部可在离线 dry 路径验证；真跑需要 chromium 与公开的 example.com）：
 *   1. `ctx.step(..., { forceAct: true })`：**声明**"即使 done 在动作前已成立，也先把命令闭集
 *      执行完再评估"——A1 的 opt-in 声明面（引擎当前没有 done 预判短路，缺省本来就先动作；
 *      这个字段是给未来短路的出口，同时让作者明确表达"这一步必须真的动一下"）；
 *   2. 零动作命令 `skip`：只有"验证完成"、不该点任何东西的步用它把动作面收窄到空——完成仍只由
 *      done 信号裁决，零执行不是静默 done（result/trace 会带 executed/skipped_actions 证据）；
 *   3. `StepResult` 的 A1 字段：`executed / executed_actions / skipped_actions / done_preheld /
 *      warnings`。dry 期这些字段不出现（dry 只验调用序列）；真跑时零动作步应看到
 *      `executed=false`，命令步可能在动作前就 `done_preheld=true`（信号本来就成立）。
 *
 * 抄这个示例时通常只改三处：入口 URL、done 信号、结束态不变量。
 * ⚠ 锚点纪律：done 锚在 `<title>` 文本（与 01-basic-step 同源）；换站点前先
 *   `amber inspect --url <页> --json` 核对锚点在实况页上成立。
 */
export const meta = (kit) => ({
  id: "05-done-evidence",
  label: "05 · 动作执行证据（forceAct + done_preheld 判读）",
  goal: "到达示例页，用零动作验证步确认标题，并判读 StepResult 的动作执行证据",
  hosts: ["example.com"],
  slots: {},
  invariants: [
    { id: "on-example-page", desc: "结束时停在 example.com", signal: kit.judge.url("example.com") },
  ],
});

export async function flow(ctx) {
  // ① 导航 + 到达信号（与 01 相同；真实页面状态在真跑时才有意义）。
  const arrived = await ctx.arrive("https://example.com/", {
    id: "arrive-home",
    desc: "到达 example.com",
    done: ctx.judge.all(ctx.judge.url("example.com"), ctx.judge.text("title", "Example Domain")),
  });
  if (!arrived.ok) ctx.fail(arrived.stopCode ?? "arrive_failed", arrived.reason);

  // ② 零动作验证步 + forceAct 声明：不选元素、不点任何东西，done 由标题信号裁决。
  //    `forceAct: true` 在这里是**声明**（命令步即使 done 预成立也先走完命令闭集）——skip
  //    本身就是"按定义解决"的零动作命令，声明它让"动作面为空"这件事显式可见。
  const verified = await ctx.step("确认示例页标题（零动作命令 + forceAct 声明）", {
    id: "verify-heading",
    act: [ctx.command("skip")],
    forceAct: true,
    done: ctx.judge.text("title", "Example Domain"),
  });
  if (!verified.ok) ctx.fail(verified.stopCode ?? "step_failed", verified.reason);

  // ③ A1 证据判读：真跑时零动作步应 executed=false；done 预成立时 done_preheld=true；
  //    skipped_actions 记录"为什么没有动作"（这里是 skip 命令，按定义解决、不记跳过原因）。
  ctx.log("动作执行证据", {
    executed: verified.executed ?? null,
    executed_actions: verified.executed_actions ?? [],
    skipped_actions: verified.skipped_actions ?? [],
    done_preheld: verified.done_preheld ?? null,
    warnings: verified.warnings ?? [],
  });
  // 防呆断言：零动作步不得声称执行过动作（否则"完成"就是假的）。
  if (verified.executed === true) {
    ctx.fail("evidence_mismatch", "zero-action verification step must not report executed actions");
  }

  // ④ 结束态验收（之后不允许再有动作）。
  await ctx.done();
}
