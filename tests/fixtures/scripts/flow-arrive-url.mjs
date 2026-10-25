/**
 * 验收回归夹具（子代理发现的三实现漂移）：
 *   - `ctx.arrive` 必须只是"导航 + 等信号"，不能记录成 step、更不能做元素选择；
 *   - `ctx.url()` 在 open 后必须已解析（file://），dry/真实/replay 三处一致。
 */
export const meta = (kit) => ({
  id: "flow-arrive-url",
  label: "arrive/url 一致性",
  goal: "验证 arrive 是纯导航且 url 在三实现中一致",
  hosts: [],
  slots: {},
  invariants: [{ id: "on-portal", desc: "结束时在门户页", signal: kit.judge.url("portal.html") }],
});

export async function flow(ctx) {
  await ctx.open("testpages/portal.html");
  if (!ctx.url().startsWith("file://")) throw new Error(`ctx.url() 未解析：${ctx.url()}`);
  const r = await ctx.arrive("testpages/portal.html", {
    desc: "到达门户",
    done: ctx.judge.url("portal.html"),
  });
  if (!r.ok) throw new Error(`arrive 失败：${r.stopCode} ${r.reason ?? ""}`);
  await ctx.done();
}
