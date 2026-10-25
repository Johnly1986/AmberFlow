/** 验收回归夹具：声明了结束态不变量却**从不调用** ctx.done() —— 验收没发生，不能报绿。 */
export const meta = (kit) => ({
  id: "flow-missing-done",
  label: "missing done",
  goal: "声明不变量但不验收",
  hosts: [],
  slots: {},
  invariants: [{ id: "never", desc: "永远不会被验证的断言", signal: kit.judge.url("portal.html") }],
});

export async function flow(ctx) {
  ctx.log("故意不调用 ctx.done()");
}
