/**
 * examples-check —— `examples/apps/**` 的**离线**校验入口（纯 Node；不开浏览器、不调模型、不联网）。
 *
 * 为什么是"复制到临时 AMBERFLOW_HOME 再校验"：examples 只是源材料，用户真正运行的形态是
 * `$AMBERFLOW_HOME/apps/<id>/app.mjs`。这里先在临时目录里复制成用户作用域的样子，再走与用户
 * 完全相同的发现路径——证明"复制过去就能用"，而不是靠仓库里的路径碰巧能跑。临时 home 同时
 * 保证不污染真实的 `~/.amberflow`。
 *
 * 逐示例检查（全部是 dry 路径，不启浏览器、不调模型）：
 *   1. `apps check <id>`              → exit 0（加载 + dry 调用序列）
 *   2. `apps explain <id> --json`     → exit 0，problems 为空
 *   3. `app-runner --app <id> --dry`  → exit 0，dry_run=true 且 problems 为空
 * 另外对 `03-secret-slots`：把一次性 canary 写进 `--slot-file`（JSON，chmod 600）再 dry，
 * 断言 stdout 含掩码 `***`、且 canary 在 stdout+stderr 零命中。
 *
 * 用法：node --experimental-strip-types tools/examples-check.ts
 * 退出码：0 = 全过；1 = 有失败（打印命令与输出；临时 home 保留以便排查）。
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const EXAMPLES_APPS = path.join(REPO, "examples", "apps");
const CLI_ENTRY = path.join(REPO, "src", "cli", "main.ts");
const APP_RUNNER_ENTRY = path.join(REPO, "src", "app", "app-runner.ts");
const NODE_FLAGS = ["--experimental-strip-types"];

/** 示例下限：task 要求 ≥3 个，少一个就是交付不完整。 */
const MIN_EXAMPLES = 3;
const SECRET_APP = "03-secret-slots";
const MASKED_SLOT = "***";
/** 失败输出截断：完整日志没必要全刷，但要够定位。 */
const OUTPUT_TAIL_LINES = 30;
const OUTPUT_TAIL_CHARS = 4000;

interface CommandRun {
  argv: string[];
  /** null = 子进程没正常退出（启动失败 / 超时）。 */
  status: number | null;
  error: string | null;
  stdout: string;
  stderr: string;
}

interface Failure {
  label: string;
  argv: string[];
  problem: string;
  stdout: string;
  stderr: string;
}

type RunCmd = (argv: string[]) => CommandRun;
type Validate = (r: CommandRun) => string | null;

/* ------------------------------------------------------------------ 子进程 */

function spawnRun(argv: string[], env: NodeJS.ProcessEnv): CommandRun {
  const exe = argv[0];
  if (exe === undefined) throw new Error("spawnRun: argv 不能为空");
  const res = spawnSync(exe, argv.slice(1), {
    cwd: REPO,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    argv,
    status: res.status,
    error: res.error === undefined ? null : res.error.message,
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    stderr: typeof res.stderr === "string" ? res.stderr : "",
  };
}

/** 子进程环境：临时 AMBERFLOW_HOME；并清掉决策服务/模型旋钮，保证 dry 不因本机配置漂移。 */
function buildChildEnv(tmpHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AMBERFLOW_HOME: tmpHome,
    AMBERFLOW_APPS_OUT: path.join(tmpHome, "apps-out"),
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AMBERFLOW_DECISION_")) delete env[key];
  }
  return env;
}

function nodeCli(args: string[]): string[] {
  return [process.execPath, ...NODE_FLAGS, CLI_ENTRY, ...args];
}

function nodeAppRunner(args: string[]): string[] {
  return [process.execPath, ...NODE_FLAGS, APP_RUNNER_ENTRY, ...args];
}

/* ------------------------------------------------------------------ 断言 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJsonObject(text: string): { value: Record<string, unknown> | null; problem: string | null } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null, problem: "stdout 为空（期望 JSON）" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { value: null, problem: `stdout 不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRecord(parsed)) return { value: null, problem: "stdout 的 JSON 不是对象" };
  return { value: parsed, problem: null };
}

function exitProblem(r: CommandRun): string | null {
  if (r.status === 0) return null;
  if (r.status === null) return `子进程没有正常退出${r.error === null ? "" : `：${r.error}`}`;
  const hint = r.status === 2 ? "（exit 2 = 加载/校验/用法错误）" : "";
  return `退出码 ${r.status}${hint}（期望 0）`;
}

function validateExplain(r: CommandRun): string | null {
  const exit = exitProblem(r);
  if (exit !== null) return exit;
  const parsed = parseJsonObject(r.stdout);
  if (parsed.value === null) return parsed.problem ?? "stdout 不是 JSON 对象";
  const data = parsed.value["data"];
  if (!isRecord(data)) return "explain JSON 缺少 data 对象";
  const problems = data["problems"];
  if (!Array.isArray(problems) || problems.length > 0) {
    return `explain 报出 problems：${JSON.stringify(problems)}`;
  }
  return null;
}

function validateDry(r: CommandRun): string | null {
  const exit = exitProblem(r);
  if (exit !== null) return exit;
  const parsed = parseJsonObject(r.stdout);
  if (parsed.value === null) return parsed.problem ?? "stdout 不是 JSON 对象";
  if (parsed.value["dry_run"] !== true) return "dry JSON 的 dry_run 不是 true";
  const problems = parsed.value["problems"];
  if (!Array.isArray(problems) || problems.length !== 0) {
    return `dry JSON 的 problems 非空：${JSON.stringify(problems)}`;
  }
  return null;
}

/** 03 的 canary 断言：掩码在、canary 零命中、slot-file 权限生效。 */
function validateCanary(r: CommandRun, canary: string): string | null {
  const combined = `${r.stdout}\n${r.stderr}`;
  const exit = exitProblem(r);
  if (exit !== null) {
    return combined.includes(canary) ? `${exit}；且输出里出现 canary 明文` : exit;
  }
  if (combined.includes(canary)) return "输出里出现 canary 明文：敏感槽位未被掩码";
  if (!r.stdout.includes(MASKED_SLOT)) return `stdout 未包含掩码 ${JSON.stringify(MASKED_SLOT)}`;
  const parsed = parseJsonObject(r.stdout);
  if (parsed.value === null) return parsed.problem ?? "stdout 不是 JSON 对象";
  const slots = parsed.value["slots"];
  if (!isRecord(slots)) return "dry JSON 缺少 slots 对象";
  if (slots["password"] !== MASKED_SLOT) {
    return `dry JSON 的 slots.password 不是 ${JSON.stringify(MASKED_SLOT)}（实际 ${JSON.stringify(slots["password"])}）`;
  }
  // 我们刚 chmod 600 写过它；出现告警说明权限没生效（Windows 不做该断言）。
  if (process.platform !== "win32" && r.stderr.includes("chmod 600")) {
    return "slot-file 权限告警：文件应已是 600";
  }
  return null;
}

function expectOk(label: string, argv: string[], run: RunCmd, validate: Validate, failures: Failure[]): void {
  const r = run(argv);
  const problem = r.error !== null ? `子进程启动失败：${r.error}` : validate(r);
  if (problem !== null) {
    failures.push({ label, argv, problem, stdout: r.stdout, stderr: r.stderr });
    console.log(`  ✗ ${label}`);
    return;
  }
  console.log(`  ✓ ${label}`);
}

/* ------------------------------------------------------------------ 示例发现 / 复制 */

function discoverExampleApps(): string[] {
  if (!fs.existsSync(EXAMPLES_APPS)) return [];
  return fs.readdirSync(EXAMPLES_APPS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => fs.existsSync(path.join(EXAMPLES_APPS, id, "app.mjs")))
    .sort();
}

function copyExamplesToHome(apps: string[], tmpHome: string): void {
  const destRoot = path.join(tmpHome, "apps");
  fs.mkdirSync(destRoot, { recursive: true });
  for (const app of apps) {
    fs.cpSync(path.join(EXAMPLES_APPS, app), path.join(destRoot, app), { recursive: true });
  }
}

/* ------------------------------------------------------------------ 输出格式 */

function displayCommand(argv: string[]): string {
  return argv.map((arg, i) => {
    if (i === 0 && arg === process.execPath) return "node";
    const shown = arg.startsWith(`${REPO}${path.sep}`) ? path.relative(REPO, arg) : arg;
    return /[\s"'$]/.test(shown) ? JSON.stringify(shown) : shown;
  }).join(" ");
}

function boundedOutput(text: string): string {
  const trimmed = text.trimEnd();
  const lines = trimmed.split("\n");
  const kept = lines.length > OUTPUT_TAIL_LINES ? lines.slice(-OUTPUT_TAIL_LINES) : lines;
  const joined = kept.join("\n");
  return joined.length > OUTPUT_TAIL_CHARS ? joined.slice(-OUTPUT_TAIL_CHARS) : joined;
}

function indent(text: string): string {
  return text.split("\n").map((line) => `    ${line}`).join("\n");
}

function printFailures(failures: Failure[], scrub: (text: string) => string): void {
  console.error(`\nFAIL：${failures.length} 项未通过`);
  for (const f of failures) {
    console.error(`\n✗ ${f.label}`);
    console.error(`  问题：${scrub(f.problem)}`);
    if (f.argv.length > 0) console.error(`  命令：${displayCommand(f.argv)}`);
    const stdout = boundedOutput(scrub(f.stdout));
    const stderr = boundedOutput(scrub(f.stderr));
    if (stdout !== "") console.error(`  --- stdout（尾部）---\n${indent(stdout)}`);
    if (stderr !== "") console.error(`  --- stderr（尾部）---\n${indent(stderr)}`);
  }
}

/* ------------------------------------------------------------------ 主流程 */

function main(): number {
  const apps = discoverExampleApps();
  if (apps.length < MIN_EXAMPLES) {
    console.error(`✗ examples/apps 下只发现 ${apps.length} 个示例（至少需要 ${MIN_EXAMPLES} 个）`
      + `：${apps.length > 0 ? apps.join(", ") : "无"}`);
    return 1;
  }

  console.log(`examples-check：离线校验 examples/apps/（${apps.length} 个示例；不启浏览器、不调模型、不联网）`);
  console.log(`  示例：${apps.join(" · ")}`);

  const failures: Failure[] = [];
  // 一次性 canary：每次运行随机生成，只活在本进程 + 临时 slot-file 里。
  const canary = `CANARY-${crypto.randomBytes(12).toString("hex")}`;
  const scrub = (text: string): string => (text === "" ? text : text.split(canary).join(MASKED_SLOT));

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-examples-"));
  let thrown: string | null = null;
  try {
    copyExamplesToHome(apps, tmpHome);
    console.log(`  临时 AMBERFLOW_HOME：${tmpHome}\n`);

    const childEnv = buildChildEnv(tmpHome);
    const run: RunCmd = (argv) => spawnRun(argv, childEnv);

    for (const app of apps) {
      expectOk(`${app} · apps check`, nodeCli(["apps", "check", app]), run, exitProblem, failures);
      expectOk(`${app} · apps explain --json`, nodeCli(["apps", "explain", app, "--json"]), run, validateExplain, failures);
      expectOk(`${app} · app-runner --dry`, nodeAppRunner(["--app", app, "--dry"]), run, validateDry, failures);
    }

    // 敏感槽位：canary 走 --slot-file（不写进 argv），dry 输出必须是 ***。
    if (!apps.includes(SECRET_APP)) {
      failures.push({
        label: `${SECRET_APP} · canary 掩码`,
        argv: [],
        problem: `examples/apps 缺少 ${SECRET_APP}`,
        stdout: "",
        stderr: "",
      });
      console.log(`  ✗ ${SECRET_APP} · canary 掩码`);
    } else {
      const slotFile = path.join(tmpHome, "canary-slots.json");
      fs.writeFileSync(slotFile, `${JSON.stringify({ password: canary })}\n`, { encoding: "utf-8", mode: 0o600 });
      fs.chmodSync(slotFile, 0o600);            // writeFileSync 的 mode 会被 umask 削，chmod 兜底
      expectOk(
        `${SECRET_APP} · canary 掩码（--slot-file）`,
        nodeAppRunner(["--app", SECRET_APP, "--dry", "--slot-file", slotFile]),
        run,
        (r) => validateCanary(r, canary),
        failures,
      );
    }
  } catch (e) {
    thrown = e instanceof Error ? (e.stack ?? e.message) : String(e);
  }

  const ok = failures.length === 0 && thrown === null;
  if (thrown !== null) console.error(`\n✗ examples-check 自身异常：\n${thrown}`);
  if (failures.length > 0) printFailures(failures, scrub);

  if (ok) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    console.log(`\nPASS：${apps.length} 个示例全绿`
      + `（每个 3 项：apps check + explain --json + app-runner --dry；${SECRET_APP} 含 canary 掩码断言）`);
    return 0;
  }
  console.error(`\n临时 AMBERFLOW_HOME 保留以便排查：${tmpHome}`);
  return 1;
}

process.exitCode = main();
