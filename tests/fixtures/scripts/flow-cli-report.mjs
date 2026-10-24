/**
 * L2 夹具：工具步当动作腿（`ctx.run` / `ctx.dangerous`）。
 *
 * 三条纪律仍由引擎执行，脚本只是声明：
 *   ① `retries` 需要 `idempotent`；② 危险步需要 `dryRunArgs`；③ 危险步默认**拒绝**。
 * 脚本能看到的是 `{ok, stopCode}`（完成真值 = 进程观察面），拿不到模型/命令行内部状态。
 */
export const meta = () => ({
  id: "flow-cli-report",
  label: "L2 flow：工具步链路（读 JSON / 认失败 / 幂等重试 / 危险步干跑）",
  goal: "用命令行工具跑一条链路：读一次 JSON、认两次失败、重试一次瞬时错误、最后经干跑与确认落盘一个产物",
  model: "english",
  hosts: [],
  slots: {},
});

function mustOk(r, what) {
  if (!r.ok) throw new Error(`${what} failed: ${r.stopCode}`);
}

export async function flow(ctx) {
  const q = await ctx.run("demo-tool", [], {
    desc: "跑一次桩工具：退出码为 0，且 JSON 里的第三行是 w-3",
    done: ctx.tool.all(
      ctx.tool.exitOk(0),
      ctx.tool.stdoutContains("stub-tool"),
      ctx.tool.jsonPath("rows[2].id", "w-3"),
    ),
  });
  mustOk(q, "query-json");

  const f = await ctx.run("demo-tool", ["--fail"], {
    desc: "退出码 3 + stderr 事实 = 一个被验证过的失败",
    done: ctx.tool.all(
      ctx.tool.exitCode(3),
      ctx.tool.stderrContains("boom"),
      ctx.tool.not(ctx.tool.exitOk(0)),
    ),
  });
  // `ok` 的含义是"声明的进程观察成立"，不是"命令成功"：失败被如实验证也算成立。
  if (!f.ok) throw new Error(`fail-path: the verified failure did not satisfy its signal: ${f.stopCode}`);

  const a = await ctx.run("demo-tool", ["--auth-required"], {
    desc: "要登录也是一种可验证事实",
    done: ctx.tool.all(ctx.tool.exitCode(2), ctx.tool.stderrContains("authentication required")),
  });
  if (!a.ok) throw new Error(`auth-path: the verified failure did not satisfy its signal: ${a.stopCode}`);

  const flaky = await ctx.run("demo-tool", ["--fail-times=2", "--counter={out_dir}/retry-counter-{run_id}"], {
    desc: "前两次失败、第三次成功：读操作声明幂等，才允许重试",
    idempotent: true,
    retries: 3,
    done: ctx.tool.all(ctx.tool.exitOk(0), ctx.tool.stdoutContains("rows")),
  });
  mustOk(flaky, "flaky-read");

  const d = await ctx.dangerous({
    desc: "不可逆写入：先干跑，经确认后落盘一个产物文件",
    source: "demo-tool",
    args: ["--write={out_dir}/flow-artifact.txt", "--query=report"],
    dryRunArgs: ["--write={out_dir}/flow-artifact.txt", "--query=report", "--dry-run"],
    done: ctx.tool.all(
      ctx.tool.exitOk(0),
      ctx.tool.stdoutContains("wrote"),
      ctx.tool.fileExists("{out_dir}/flow-artifact.txt"),
    ),
  });
  if (!d.ok && d.stopCode === "dangerous") {
    // 默认拒绝是**设计行为**：脚本把这当作一次"没有放行"的显式结果，而不是失败。
    ctx.log("危险步未放行（预期；--allow-dangerous 才执行）");
    await ctx.done();
    return;
  }
  mustOk(d, "write-artifact");
  await ctx.done();
}
