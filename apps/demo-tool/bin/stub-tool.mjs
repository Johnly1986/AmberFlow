#!/usr/bin/env node
/**
 * 确定性的**桩工具**：CLI 传输的夹具。
 *
 * 它的地位与测试里的 `scriptedRuntime` 等价 —— 让"命令行工具当数据源/动作腿"这条链路
 * 在 CI 里可复现，不依赖任何真实外部工具、也不依赖时间。真实工具（git / jq）另有
 * `apps/git-log`、`apps/bench-cases` 两个 source 做对照。
 *
 * 约定（被 tests/cli-transport.test.ts 与 apps/demo-tool/sources/*.json 依赖）：
 *   --version                 -> 打印 `stub-tool 1.4.2`（版本 pin 用）
 *   --query=<x>               -> 原样回显到 JSON 的 query/rows.label
 *   --auth-required           -> stderr 一行 + 退出码 2（block_markers 的靶子）
 *   --fail                    -> stderr 一行 + 退出码 3
 *   --slow=<ms>               -> 等 ms 毫秒再输出（超时的靶子）
 *   默认                       -> 一行 JSON：{tool, query, cwd, env 标记, argv, rows}
 *
 * 它把收到的 argv 原样回显，这正是"永不过 shell"的验收点：参数里的 `;`、`$(...)`、`|`
 * 必须原封不动地出现在 argv 里。
 */
const args = process.argv.slice(2);
const VERSION = "stub-tool 1.4.2";

if (args.includes("--version")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}
if (args.includes("--auth-required")) {
  process.stderr.write("stub-tool: authentication required (missing token)\n");
  process.exit(2);
}
if (args.includes("--fail")) {
  process.stderr.write("stub-tool: boom\n");
  process.exit(3);
}

const flag = (name, dflt = "") => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 1);
};

const query = flag("--query");
const rows = [
  { id: "w-1", label: `widget ${query}`, price: 12.5 },
  { id: "w-2", label: `widget ${query}`, price: 9.99 },
  { id: "w-3", label: `widget ${query}`, price: 31 },
];

const emit = () => {
  process.stdout.write(JSON.stringify({
    tool: VERSION,
    query,
    cwd: process.cwd(),
    env: {
      PATH: Boolean(process.env.PATH),
      STUB_TOKEN: process.env.STUB_TOKEN === undefined ? null : process.env.STUB_TOKEN,
      HOME: process.env.HOME === undefined ? null : "present",
    },
    argv: args,
    rows,
  }, null, 1) + "\n");
  process.exit(0);
};

const slow = args.find((a) => a.startsWith("--slow="));
if (slow) setTimeout(emit, Number(slow.slice("--slow=".length)));
else emit();
