/**
 * 夹具：危险步被拒绝时，脚本能读到**人话原因**（`StepResult.reason`），
 * 而不是只有 `stopCode` 让作者去猜。
 */
export const meta = () => ({
  id: "flow-tool-refused",
  label: "L2 flow：危险步拒绝的人话原因",
  goal: "验证危险工具步在未放行时返回结构化拒绝 + 人话原因",
  model: "english",
  hosts: [],
  slots: {},
});

export async function flow(ctx) {
  const d = await ctx.dangerous({
    desc: "不可逆写入（本次不放行）",
    source: "demo-tool",
    args: ["--write={out_dir}/never.txt"],
    dryRunArgs: ["--write={out_dir}/never.txt", "--dry-run"],
    done: ctx.tool.exitOk(0),
  });
  if (d.ok) throw new Error("危险步不应该在未放行时通过");
  if (d.stopCode !== "dangerous") throw new Error(`期望 dangerous，拿到 ${d.stopCode}`);
  if (!d.reason || !d.reason.includes("危险")) throw new Error(`缺少人话原因：${JSON.stringify(d.reason)}`);
  ctx.log("危险步按设计被拒绝，原因可读");
  await ctx.done();
}
