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
 * **canonical golden（默认比对，`--record-golden` 显式更新）**：每条命令的输出先经
 * `normalize*` 归一（临时 HOME/仓库绝对路径、时间戳、随机 canary、槽位文件路径），
 * 再与 `tools/golden/examples/<app>.json` 逐字节比对。目的：给「机械拆分 / 运行期重构」
 * 一条**可重复**的离线等价证据——命令的退出码、JSON 结构、字段与文案任何漂移都会红，
 * 不再依赖"本地手工跑一遍看着一样"。
 *
 * 确定性环境（否则 golden 只是把本机状态钉死）：
 *   - 子进程 cwd = 临时 home：不吸收仓库 `.amberflow/config.json` 与旧 `configs/amberflowrc.json`；
 *   - 清空继承的 `AMBERFLOW_*` / `LAYA*` 环境变量，再显式设 HOME/APPS_OUT；
 *   - `VITEST=1` 走仓库既有的「测试进程不吸收本机配置」约定；
 *   - 决策/模型相关键显式置空、模型路径指向临时 home 内不存在的位置 ⇒ 本机是否下载过模型
 *     都不影响 dry 产物（model_status 恒 `off(missing)`，CI 与本机同口径）。
 *
 * 用法：
 *   node --experimental-strip-types tools/examples-check.ts                  # 校验 + golden 比对
 *   node --experimental-strip-types tools/examples-check.ts --record-golden  # 重写 golden
 * 退出码：0 = 全过；1 = 有失败（打印规范化后的命令与输出差异；临时 home 保留以便排查）。
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
const GOLDEN_DIR = path.join(REPO, "tools", "golden", "examples");
const NODE_FLAGS = ["--experimental-strip-types"];
const RECORD_GOLDEN = process.argv.slice(2).includes("--record-golden");
const USAGE = "usage: node --experimental-strip-types tools/examples-check.ts [--record-golden]";

/** 示例下限：task 要求 ≥3 个，少一个就是交付不完整。 */
const MIN_EXAMPLES = 3;
const SECRET_APP = "03-secret-slots";
const MASKED_SLOT = "***";
/** 失败输出截断：完整日志没必要全刷，但要够定位。 */
const OUTPUT_TAIL_LINES = 30;
const OUTPUT_TAIL_CHARS = 4000;
/** golden 里可替换的「每次必变」字段（归一为固定 token；不得靠删字段掩盖）。 */
const DYNAMIC_KEYS = new Set([
  "run_id", "started_at", "finished_at", "started", "saved_at", "at", "epoch",
  "elapsed_ms", "elapsed", "duration_ms", "secs",
  // plan_sha256 = lowest IR 的 canonical JSON hash，而 IR 里带应用脚本的**绝对路径**
  // （app-script.ts: pack._path = scriptPath）；换一次临时 home 就换一次值。脚本内容
  // 由 script_sha256 钉住，这里只把与机器路径耦合的那一维归一，不为它放宽其他字段。
  "plan_sha256",
]);
const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const GOLDEN_DOC =
  "examples-check canonical golden（tools/examples-check.ts）：命令输出经归一（临时 HOME/仓库路径/时间戳/canary/slot-file 路径）后的基线。"
  + "只在预期行为变更时用 --record-golden 更新，不得手改。";

/* ------------------------------------------------------------------ 类型 */

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

/** 一条命令的归一化产物：文本命令存 stdout/stderr；JSON 命令存解析后的结构。 */
interface CanonicalCheck {
  argv: string[];
  exit_code: number | null;
  stdout?: string;
  stderr?: string;
  json?: unknown;
}

interface AppGolden {
  _doc?: string;
  schema_version: 1;
  app: string;
  checks: Record<string, CanonicalCheck>;
}

/** 归一化上下文：这些值在产物里出现即替换为固定 token。 */
interface NormalizeContext {
  tmpHome: string;
  canary: string;
}

/* ------------------------------------------------------------------ 子进程 */

function spawnRun(argv: string[], env: NodeJS.ProcessEnv, cwd: string): CommandRun {
  const exe = argv[0];
  if (exe === undefined) throw new Error("spawnRun: argv 不能为空");
  const res = spawnSync(exe, argv.slice(1), {
    cwd,
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

/**
 * 子进程环境：临时 AMBERFLOW_HOME + 配置/模型面隔离。
 * 清掉继承的机器级开关，保证「本机有没有配置/模型」不改变 dry 产物；模型路径显式指向
 * 临时 home 内不存在的位置 ⇒ model_status 恒 off(missing)，CI 与本机同口径。
 */
function buildChildEnv(tmpHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("AMBERFLOW_") || /^LAYAA?_/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    AMBERFLOW_HOME: tmpHome,
    AMBERFLOW_APPS_OUT: path.join(tmpHome, "apps-out"),
    // 仓库既有约定：测试进程不吸收本机用户/项目配置（apply-config-env.ts 的 includeFiles）。
    VITEST: "1",
    NO_COLOR: "1",
    // 决策面显式置空（空串 = 未配置）：本机 rc/环境不会把 dry 变成"有决策源"。
    AMBERFLOW_DECISION_BASE_URL: "",
    AMBERFLOW_DECISION_MODEL: "",
    AMBERFLOW_DECISION_API_KEY: "",
    AMBERFLOW_DECISION_PROTOCOL: "",
    // 模型工件缺失是确定性的（不是"本机刚好下过"）。
    LAYA_ONNX_MODEL: path.join(tmpHome, "no-model.onnx"),
    LAYAA_ONNX_MODEL: path.join(tmpHome, "no-model.onnx"),
    LAYA_TOKENIZER_DIR: path.join(tmpHome, "no-tokenizer"),
    LAYAA_TOKENIZER_DIR: path.join(tmpHome, "no-tokenizer"),
  });
  return env;
}

function nodeCli(args: string[]): string[] {
  return [process.execPath, ...NODE_FLAGS, CLI_ENTRY, ...args];
}

function nodeAppRunner(args: string[]): string[] {
  return [process.execPath, ...NODE_FLAGS, APP_RUNNER_ENTRY, ...args];
}

/* ------------------------------------------------------------------ 归一化 */

/** 文本归一：临时 home / 仓库绝对路径 / ISO 时间戳 / canary → 固定 token。 */
function normalizeText(raw: string, ctx: NormalizeContext): string {
  let text = raw;
  // 长的先替换（realpath 可能让临时 home 多一层前缀）。
  const homeVariants = new Set([ctx.tmpHome, safeRealpath(ctx.tmpHome)]);
  for (const home of [...homeVariants].filter((h): h is string => h !== null).sort((a, b) => b.length - a.length)) {
    text = text.split(home).join("<TMP_HOME>");
  }
  text = text.split(REPO).join("<REPO>");
  if (ctx.canary !== "") text = text.split(ctx.canary).join("<CANARY>");
  text = text.replace(ISO_RE, "<TIMESTAMP>");
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/g, "");
}

function safeRealpath(target: string): string | null {
  try { return fs.realpathSync(target); } catch { return null; }
}

/** JSON 归一：键递归排序（同内容 = 同字节）；已知每次必变键 → `<DYNAMIC>`。 */
function normalizeValue(value: unknown, ctx: NormalizeContext): unknown {
  if (typeof value === "string") return normalizeText(value, ctx);
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry, ctx));
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = DYNAMIC_KEYS.has(key) ? "<DYNAMIC>" : normalizeValue(source[key], ctx);
    }
    return out;
  }
  return value;
}

/** 文本命令的归一化产物（argv 用语义形态，便于 golden 直接读懂）。 */
function canonicalText(argv: string[], r: CommandRun, ctx: NormalizeContext): CanonicalCheck {
  return {
    argv,
    exit_code: r.status,
    stdout: normalizeText(r.stdout, ctx),
    stderr: normalizeText(r.stderr, ctx),
  };
}

/** JSON 命令的归一化产物；解析失败时保留 null（校验器已先报错，golden 不掩盖失败）。 */
function canonicalJson(argv: string[], r: CommandRun, ctx: NormalizeContext): CanonicalCheck {
  let json: unknown = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { argv, exit_code: r.status, json: normalizeValue(json, ctx) };
}

/** 稳定序列化（键已排序；用于 golden 写入与比对）。 */
function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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

/** 跑一条命令并校验；返回原始 CommandRun 供 golden 使用。 */
function expectOk(label: string, argv: string[], run: RunCmd, validate: Validate, failures: Failure[]): CommandRun {
  const r = run(argv);
  const problem = r.error !== null ? `子进程启动失败：${r.error}` : validate(r);
  if (problem !== null) {
    failures.push({ label, argv, problem, stdout: r.stdout, stderr: r.stderr });
    console.log(`  ✗ ${label}`);
    return r;
  }
  console.log(`  ✓ ${label}`);
  return r;
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

/* ------------------------------------------------------------------ golden I/O */

function goldenFileOf(app: string): string {
  return path.join(GOLDEN_DIR, `${app}.json`);
}

function goldenPayload(app: string, checks: Record<string, CanonicalCheck>): AppGolden {
  return { schema_version: 1, app, checks };
}

/** 比对一份产出与 golden；返回问题（空 = 一致）。 */
function compareGolden(app: string, actual: AppGolden): string[] {
  const file = goldenFileOf(app);
  const rel = path.relative(REPO, file);
  if (!fs.existsSync(file)) return [`缺少 golden：${rel}（运行 --record-golden 生成）`];
  let goldenRaw: unknown;
  try {
    goldenRaw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return [`${rel} 解析失败：${err instanceof Error ? err.message : String(err)}`];
  }
  if (!isRecord(goldenRaw)) return [`${rel} 不是 JSON 对象`];
  const expected = stableStringify(goldenPayload(
    typeof goldenRaw["app"] === "string" ? goldenRaw["app"] : app,
    isRecord(goldenRaw["checks"]) ? goldenRaw["checks"] as Record<string, CanonicalCheck> : {},
  ));
  const got = stableStringify(actual);
  if (got === expected) return [];
  const expLines = expected.split("\n");
  const actLines = got.split("\n");
  for (let i = 0; i < Math.max(expLines.length, actLines.length); i++) {
    if (expLines[i] === actLines[i]) continue;
    return [`${rel} 与本次产出不一致（首个差异第 ${i + 1} 行）\n    golden: ${expLines[i] ?? "<无>"}\n    实际:   ${actLines[i] ?? "<无>"}`];
  }
  return [`${rel} 与本次产出不一致`];
}

/** 写入 golden（`--record-golden`）。 */
function writeGolden(app: string, actual: AppGolden): void {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  fs.writeFileSync(goldenFileOf(app), stableStringify({ _doc: GOLDEN_DOC, ...actual }), "utf8");
}

function staleGoldenFiles(apps: string[]): string[] {
  if (!fs.existsSync(GOLDEN_DIR)) return [];
  const keep = new Set(apps.map((app) => `${app}.json`));
  return fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json") && !keep.has(f)).sort();
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
  for (const arg of process.argv.slice(2)) {
    if (arg !== "--record-golden") {
      console.error(`examples-check: 未知参数 ${JSON.stringify(arg)}\n${USAGE}`);
      return 2;
    }
  }
  const apps = discoverExampleApps();
  if (apps.length < MIN_EXAMPLES) {
    console.error(`✗ examples/apps 下只发现 ${apps.length} 个示例（至少需要 ${MIN_EXAMPLES} 个）`
      + `：${apps.length > 0 ? apps.join(", ") : "无"}`);
    return 1;
  }

  console.log(`examples-check：离线校验 examples/apps/（${apps.length} 个示例；不启浏览器、不调模型、不联网）`);
  console.log(`  示例：${apps.join(" · ")}`);
  if (RECORD_GOLDEN) console.log("  模式：--record-golden（写入 tools/golden/examples/，不比对）");

  const failures: Failure[] = [];
  // 一次性 canary：每次运行随机生成，只活在本进程 + 临时 slot-file 里。
  const canary = `CANARY-${crypto.randomBytes(12).toString("hex")}`;
  const scrub = (text: string): string => (text === "" ? text : text.split(canary).join(MASKED_SLOT));

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-examples-"));
  const goldens = new Map<string, AppGolden>();
  let thrown: string | null = null;
  try {
    copyExamplesToHome(apps, tmpHome);
    console.log(`  临时 AMBERFLOW_HOME：${tmpHome}\n`);

    const childEnv = buildChildEnv(tmpHome);
    const run: RunCmd = (argv) => spawnRun(argv, childEnv, tmpHome);
    const normCtx: NormalizeContext = { tmpHome, canary };

    for (const app of apps) {
      const checks: Record<string, CanonicalCheck> = {};

      const checkArgv = ["apps", "check", app];
      const checkRun = expectOk(`${app} · apps check`, nodeCli(checkArgv), run, exitProblem, failures);
      checks["apps-check"] = canonicalText(checkArgv, checkRun, normCtx);

      const explainArgv = ["apps", "explain", app, "--json"];
      const explainRun = expectOk(`${app} · apps explain --json`, nodeCli(explainArgv), run, validateExplain, failures);
      checks["apps-explain"] = canonicalJson(explainArgv, explainRun, normCtx);

      const dryArgv = ["app-runner", "--app", app, "--dry"];
      const dryRun = expectOk(`${app} · app-runner --dry`, nodeAppRunner(dryArgv), run, validateDry, failures);
      checks["app-runner-dry"] = canonicalJson(dryArgv, dryRun, normCtx);

      // 敏感槽位：canary 走 --slot-file（不写进 argv），dry 输出必须是 ***。
      if (app === SECRET_APP) {
        const slotFile = path.join(tmpHome, `${SECRET_APP}-canary-slots.json`);
        fs.writeFileSync(slotFile, `${JSON.stringify({ password: canary })}\n`, { encoding: "utf-8", mode: 0o600 });
        fs.chmodSync(slotFile, 0o600);            // writeFileSync 的 mode 会被 umask 削，chmod 兜底
        const canaryArgv = ["app-runner", "--app", SECRET_APP, "--dry", "--slot-file", "<SLOT_FILE>"];
        const canaryRun = expectOk(
          `${SECRET_APP} · canary 掩码（--slot-file）`,
          nodeAppRunner(["app-runner", "--app", SECRET_APP, "--dry", "--slot-file", slotFile]),
          run,
          (r) => validateCanary(r, canary),
          failures,
        );
        checks["app-runner-dry-slot-file"] = canonicalJson(canaryArgv, canaryRun, normCtx);
      }
      goldens.set(app, goldenPayload(app, checks));
    }
  } catch (e) {
    thrown = e instanceof Error ? (e.stack ?? e.message) : String(e);
  }

  // golden：只在全部语义校验通过后写/比（失败时不制造"看似有效"的基线）。
  const goldenProblems: string[] = [];
  if (thrown === null && failures.length === 0) {
    if (RECORD_GOLDEN) {
      for (const app of apps) writeGolden(app, goldens.get(app)!);
      for (const stale of staleGoldenFiles(apps)) {
        fs.rmSync(path.join(GOLDEN_DIR, stale));
        console.log(`  删除过期 golden：${stale}`);
      }
      console.log(`  已记录 ${apps.length} 份 golden → tools/golden/examples/`);
    } else {
      for (const app of apps) goldenProblems.push(...compareGolden(app, goldens.get(app)!));
      for (const stale of staleGoldenFiles(apps)) goldenProblems.push(`过期 golden：tools/golden/examples/${stale}（示例已不存在；--record-golden 会清理）`);
    }
  }

  const ok = failures.length === 0 && thrown === null && goldenProblems.length === 0;
  if (thrown !== null) console.error(`\n✗ examples-check 自身异常：\n${thrown}`);
  if (failures.length > 0) printFailures(failures, scrub);
  if (goldenProblems.length > 0) {
    console.error("\ngolden 不一致（canonical golden）：");
    for (const problem of goldenProblems.map((p) => scrub(p))) console.error(`  - ${problem}`);
    console.error("  确认是预期行为变更后，运行 `node --experimental-strip-types tools/examples-check.ts --record-golden` 更新基线，并随 PR 说明改动。");
  }

  if (ok) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    console.log(`\nPASS：${apps.length} 个示例全绿`
      + `（每个 3 项：apps check + explain --json + app-runner --dry；${SECRET_APP} 含 canary 掩码断言；golden ${RECORD_GOLDEN ? "已记录" : "一致"}）`);
    return 0;
  }
  console.error(`\n临时 AMBERFLOW_HOME 保留以便排查：${tmpHome}`);
  return 1;
}

process.exitCode = main();
