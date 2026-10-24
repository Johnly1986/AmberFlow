/**
 * L1 夹具：cli-report 的**脚本版**（与 apps/cli-report/pack.json 逐字段等价）。
 *
 * 这条应用证明 L1 覆盖**工具步**：完成真值长在进程观察面上（退出码/stdout/stderr/产物文件），
 * 三条纪律（retries 需 idempotent、dangerous 需 dry_run_args、危险步默认拒绝）仍然由引擎执行，
 * 脚本只是**声明**它们——这正是"脚本作者面 + 引擎独占执行"的分工。
 */
export const meta = () => ({
  id: "cli-report",
  label: "工具步示范：命令行当动作腿（退出码 / JSON / 干跑 / 确认 / 幂等重试 / 产物）",
  goal: "用命令行工具跑一条链路：读一次 JSON、认一次失败、重试一次瞬时错误、最后经干跑与确认落盘一个产物",
  model: "english",
  hosts: [],
  slots: {},
  // 注意：这里不声明 `sources`——它指的是**数据腿**（应用启动前取数）；本应用没有数据腿，
  // 工具步在步内用 `source` 自己声明用哪个工具（既有 pack.json 也是这么写的）。
});

export const app = (kit) => ({
  data: {},
  exec: [
    kit.run("demo-tool", {
      id: "query-json",
      desc: "跑一次桩工具：退出码为 0，且 JSON 里的第三行是 w-3",
      done: kit.tool.all(
        kit.tool.exitOk(0),
        kit.tool.stdoutContains("stub-tool"),
        kit.tool.jsonPath("rows[2].id", "w-3"),
      ),
    }),
    kit.run("demo-tool", {
      id: "fail-path",
      desc: "工具以退出码 3 失败时，用精确退出码加 stderr 事实认出来（失败也是一种可验证事实）",
      args: ["--fail"],
      done: kit.tool.all(
        kit.tool.exitCode(3),
        kit.tool.stderrContains("boom"),
        kit.tool.not(kit.tool.exitOk(0)),
      ),
    }),
    kit.run("demo-tool", {
      id: "auth-path",
      desc: "工具提示要登录时，stderr 信号能认出这类失败（对应浏览器面的 block_markers）",
      args: ["--auth-required"],
      done: kit.tool.all(
        kit.tool.exitCode(2),
        kit.tool.stderrContains("authentication required"),
      ),
    }),
    kit.run("demo-tool", {
      id: "flaky-read",
      desc: "前两次调用失败、第三次成功：读操作声明幂等，才允许重试",
      args: ["--fail-times=2", "--counter={out_dir}/retry-counter-{run_id}"],
      idempotent: true,
      retries: 3,
      done: kit.tool.all(kit.tool.exitOk(0), kit.tool.stdoutContains("rows")),
    }),
    kit.run("demo-tool", {
      id: "write-artifact",
      desc: "不可逆写入：先干跑，经确认后落盘一个产物文件",
      args: ["--write={out_dir}/cli-report-artifact.txt", "--query=report"],
      dryRunArgs: ["--write={out_dir}/cli-report-artifact.txt", "--query=report", "--dry-run"],
      dangerous: true,
      done: kit.tool.all(
        kit.tool.exitOk(0),
        kit.tool.stdoutContains("wrote"),
        kit.tool.fileExists("{out_dir}/cli-report-artifact.txt"),
      ),
    }),
  ],
});
