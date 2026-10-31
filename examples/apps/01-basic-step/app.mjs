/**
 * 01-basic-step —— 最小 flow：到达（arrive）→ 一条决策语句（step）→ 验收（done）。
 *
 * 离线可验：`apps check` / `run --dry-run` 只把调用序列 dry 一遍——不开浏览器、不调模型、
 * 不联网。真跑需要本机装好 chromium；本示例的入口是公开的 https://example.com/。
 *
 * 抄这个示例时通常只改三处：入口 URL、完成信号（done）、结束态不变量（invariants）。
 */
export const meta = (kit) => ({
  id: "01-basic-step",
  label: "01 · 最小步（arrive + step）",
  goal: "打开示例页，用 DOM 信号确认页面已到达，并在结束态验收",
  hosts: ["example.com"],              // 导航信封：越界 URL 在 dry 与真实运行都会被拒
  slots: {},                           // 这个示例没有参数：值只能来自声明/观察，不写进 flow
  invariants: [
    // 结束态断言：ctx.done() 时在同一页面上验收；失败会抛 invariant_failed。
    { id: "on-example-page", desc: "结束时停在 example.com", signal: kit.judge.url("example.com") },
  ],
});

export async function flow(ctx) {
  // ① 纯导航 + 到达信号：arrive 不做元素选择、不花模型；真跑时只 goto + 轮询 done。
  const arrived = await ctx.arrive("https://example.com/", {
    id: "arrive-home",
    desc: "到达 example.com",
    done: ctx.judge.all(ctx.judge.url("example.com"), ctx.judge.exists("h1")),
  });
  if (!arrived.ok) ctx.fail(arrived.stopCode ?? "arrive_failed", arrived.reason);

  // ② 决策语句：完成只认 done 信号，不认“看起来完成了”。
  //    这一步没有要动的元素，用零动作命令 skip 收窄动作面：引擎在动作后评估一次 done，
  //    不选元素、不花模型。（act 省略 = 把“点哪里”完全交给引擎的规则/决策层，
  //    是默认决策语句写法；纯验证步用 skip 更精确——这一步本来就不该动作。）
  const verified = await ctx.step("确认示例页标题", {
    id: "verify-heading",
    act: [ctx.command("skip")],
    done: ctx.judge.text("h1", "Example Domain"),
  });
  if (!verified.ok) ctx.fail(verified.stopCode ?? "step_failed", verified.reason);

  // ③ 结束态不变量在这里验收；ctx.done() 之后不允许再有动作。
  await ctx.done();
}
