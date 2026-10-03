#!/usr/bin/env node
/**
 * 确定性的**桩工具**：CLI 传输与工具步（动作腿）的夹具。
 *
 * 它的地位与测试里的 `scriptedRuntime` 等价 —— 让"命令行工具当数据源/动作腿"这条链路
 * 在 CI 里可复现，不依赖任何真实外部工具、也不依赖时间。真实工具（git / jq）另有
 * `apps/git-log`、`apps/bench-cases` 两个 source 做对照。
 *
 * 约定（被 tests/cli-transport.test.ts、tests/tool-signals.test.ts 与 apps/<id>/pack.json 依赖）：
 *   --version                 -> 打印 `stub-tool 1.4.2`（版本 pin 用）
 *   --query=<x>               -> 原样回显到 JSON 的 query/rows.label
 *   --write=<path>            -> 写一个确定性产物文件；带 --dry-run 时只打印"会写什么"，不落盘
 *   --fail-times=<N> --counter=<file>
 *                             -> 前 N 次调用退出 1（计数写在 counter 文件里），之后退出 0：
 *                                "重试/幂等"的靶子，且状态存在于进程之外（跨调用可复现）
 *   --auth-required           -> stderr 一行 + 退出码 2（block_markers / stderr_contains 的靶子）
 *   --fail                    -> stderr 一行 + 退出码 3（exit_code_equals 的靶子）
 *   --slow=<ms>               -> 等 ms 毫秒再输出（超时的靶子）
 *   默认                       -> 一行 JSON：{tool, query, cwd, env 标记, argv, rows}
 *
 * 它把收到的 argv 原样回显，这正是"永不过 shell"的验收点：参数里的 `;`、`$(...)`、`|`
 * 必须原封不动地出现在 argv 里。
 */
import fs from "node:fs";
import path from "node:path";

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

// 跨调用的失败计数：前 N 次退出 1（状态放文件里，所以重试语义可测）
const failTimes = Number(flag("--fail-times", "0"));
const counter = flag("--counter");
if (failTimes > 0 && counter) {
  let seen = 0;
  try { seen = Number(fs.readFileSync(counter, "utf-8")) || 0; } catch { seen = 0; }
  seen += 1;
  fs.writeFileSync(counter, String(seen));
  if (seen <= failTimes) {
    process.stderr.write(`stub-tool: transient failure ${seen}/${failTimes}\n`);
    process.exit(1);
  }
}

// 产物写入：--dry-run 时只报告不落盘（"不可逆动作先干跑"的靶子）
const writePath = flag("--write");
if (writePath) {
  const content = `stub-tool artifact\nversion=${VERSION}\nquery=${flag("--query")}\n`;
  if (args.includes("--dry-run")) {
    process.stdout.write(`would write ${writePath} (${content.length} bytes)\n`);
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(writePath), { recursive: true });
  fs.writeFileSync(writePath, content);
  process.stdout.write(`wrote ${writePath}\n`);
  process.exit(0);
}

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
