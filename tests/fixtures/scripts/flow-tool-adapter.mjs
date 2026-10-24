/**
 * L2/L3 夹具：`ctx.run` 的**声明形式**——用应用支持器（`stdio`）跑进程族工具步。
 *
 * 为什么这条能力重要：声明式应用里的进程类型（cli/ssh/stdio）是**支持器**（适配器）提供的；
 * 如果 `ctx.run` 只会 cli，那么"换成 flow 脚本"就等于丢掉一半声明面。这里验证的是：
 * flow 脚本与声明式 journey **共用同一份** validate/expand/run 实现。
 */
export const meta = () => ({
  id: "flow-tool-adapter",
  label: "L2 flow：声明形式的工具步（stdio 适配器）",
  goal: "用 stdio 适配器跑一个真实子进程，并以退出码 + stdout 作为完成证据",
  model: "english",
  hosts: [],
  slots: {},
});

export async function flow(ctx) {
  const r = await ctx.run({
    desc: "用 stdio 适配器跑一个子进程：退出码 0 且 stdout 含 adapter-ok",
    adapter: "stdio",
    // stdio 是"交互进程"适配器：script = 等 stdout 匹配 when 后发送 send（^ = 立刻发一行空输入）。
    stdio: {
      argv: [process.execPath, "-e", "console.log('adapter-ok')"],
      script: [{ when: "^", send: "" }],
      env_allow: [],
    },
    done: ctx.tool.all(ctx.tool.exitOk(0), ctx.tool.stdoutContains("adapter-ok")),
  });
  if (!r.ok) throw new Error(`stdio adapter failed: ${r.stopCode ?? "blocked"}${r.reason ? `（${r.reason}）` : ""}`);
  ctx.log("stdio 适配器 ok");
  await ctx.done();
}
