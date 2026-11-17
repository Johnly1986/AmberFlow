/**
 * verify-run-execution lane · flow 源夹具。
 *
 * 只服务 `tools/verify-run-execution.ts`（非门禁等价 lane）：在本地静态夹具页
 * `fixtures/engine/filter-bar.html` 上走一条**规则面可判定**的路径——
 * `arrive` 先把页面等稳（元素存在），随后一条决策语句：目标由 authored hint 点名、
 * 完成由 DOM 信号裁决，不需要任何模型调用。
 *
 * 入口 URL 由运行器以槽位 `entry` 注入（lane 的静态服务端口在运行时才分配）。
 */
export const meta = (kit) => ({
  id: "run-execution-flow",
  label: "runExecution lane · flow",
  goal: "到达筛选页，点击航空公司筛选并验收 active 状态",
  hosts: ["127.0.0.1"],
  slots: { entry: "" },
  invariants: [
    { id: "filter-active", desc: "筛选已选中", signal: kit.judge.exists("#filter_item_airline.active") },
  ],
});

export async function flow(ctx) {
  const arrived = await ctx.arrive(ctx.slots.entry, {
    id: "arrive-entry",
    desc: "到达夹具筛选页",
    done: ctx.judge.exists("#filter_item_airline"),
  });
  if (!arrived.ok) ctx.fail(arrived.stopCode ?? "arrive_failed", arrived.reason);
  const stepped = await ctx.step("点击航空公司筛选", {
    id: "filter-airline",
    act: ctx.hint("#filter_item_airline"),
    done: ctx.judge.exists("#filter_item_airline.active"),
  });
  if (!stepped.ok) ctx.fail(stepped.stopCode ?? "step_failed", stepped.reason);
  await ctx.done();
}
