/**
 * 应用层度量（Phase 0）——把"定义膨胀"变成一个数字。
 *
 *   npm run apps:matrix  [-- --json]
 *
 * 三件事：
 *   1. 每个应用包/数据源应用声明了多少（角色、步骤、不变量、声明行数）；
 *   2. 应用目录里有多少**代码**行（期望是 0——应用 = 数据，代码在共享层）；
 *   3. **防泄漏**：应用声明出来的站点/工具标识（`hosts`、CLI `bin`、url_template 的主机名）
 *      绝不允许出现在共享层 `src/*.ts` 的代码里（块注释剥掉——注释里的实测引用是文档，
 *      不是依赖）。任何一处命中就退出码 1，所以它可以直接当 CI 门禁。
 */
import fs from "node:fs";
import { isParseUsageError, usageErrorLine } from "../src/cli-args.ts";
import path from "node:path";
import { parseArgs } from "node:util";
import { appDirs, loadPack, listPacks, packHintCoverage, type AppPack } from "../src/app-pack.ts";
import { appsOutDir } from "../src/app-runner.ts";
import { listSources, loadSource } from "../src/datasource.ts";
import { REPO } from "../src/flow.ts";
// 运行时两列的出处：**上一次 `apps:suite` 真跑**落下的 `<app>-result.json`（`decisions` 字段）。
// 矩阵本体仍是静态声明检查；这两列只是把"跑过的证据"拼上表——没跑过显示"未跑"，绝不编数。
import { suiteOutDir } from "./apps_suite.ts";

const SHARED = fs.readdirSync(path.join(REPO, "src"))
  .filter((f) => f.endsWith(".ts")).map((f) => path.join(REPO, "src", f));

/**
 * **核心**共享层：应用/站点知识绝不允许出现的地方（引擎 + 执行器 + 计划 + 应用包本身）。
 * 其他 `src/*.ts` 是每个站点一个的**专用驱动**（探针 / 任务）——它们是这条纪律的**债**，
 * 不是豁免：矩阵把它们单独列出来计数，迁移到应用包时这个数字应该下降。
 */
const CORE = new Set([
  "actions.ts", "amberflow-home.ts", "app-pack.ts", "app-runner.ts", "audit.ts", "bench.ts",
  "bindings.ts", "browser-env.ts", "datasource.ts", "decision-cache.ts", "executor.ts", "extraction.ts",
  "flow.ts", "hint-memory.ts", "index.ts", "model.ts", "model-artifacts.ts", "outcome-memory.ts",
  "picker.ts", "plan.ts", "planner.ts", "probe-set.ts", "rules.ts", "signal-induction.ts",
  "signals.ts", "start.ts", "tool-signals.ts",
  // 探测/任务驱动：站点知识已全部搬进 apps/<id>/pack.json（见 probe-set.ts 的说明），
  // 所以它们也进核心层——再往这里写死一个主机名，门禁就会红。
  "live-capture.ts", "live-probe.ts", "ota-probe.ts", "qunar-probe.ts", "qunar-task.ts",
]);

/** 不是站点知识的"主机"：本地地址与文档示例。 */
const GENERIC_HOSTS = new Set(["localhost", "127.0.0.1", "example.com", "www.example.com",
  "shop.example.com", "0.0.0.0"]);

/** 语言/工具链级名字不算"应用知识"：任何应用都可以用它们。 */
const GENERIC = new Set(["node", "npm", "npx", "curl", "httpx", "cli", "bash", "sh", "ts", "js"]);

/** 块注释 = 文档（承载"为什么是 curl"这类实测引用），代码与字符串照查。 */
function codeOnly(file: string): string {
  return fs.readFileSync(file, "utf-8").replace(/\/\*[\s\S]*?\*\//g, " ");
}

const host = (url: string): string | null => {
  const m = /^https?:\/\/([^/]+)/.exec(url);
  return m ? m[1]!.toLowerCase() : null;
};

/** 一个应用声明出来的、共享层不许知道的标识。 */
function declaredTokens(appDir: string): string[] {
  const out = new Set<string>();
  const push = (t: string | null | undefined): void => {
    const s = String(t ?? "").trim().toLowerCase();
    if (s && !GENERIC.has(s)) out.add(s);
  };
  const packFile = path.join(appDir, "pack.json");
  if (fs.existsSync(packFile)) {
    const pack = loadPack(packFile);
    for (const h of pack.hosts ?? []) push(h);
  }
  const srcDir = path.join(appDir, "sources");
  if (fs.existsSync(srcDir)) {
    for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith(".json"))) {
      const src = JSON.parse(fs.readFileSync(path.join(srcDir, f), "utf-8")) as Record<string, any>;
      const tr = (src["transport"] ?? {}) as Record<string, any>;
      push(host(String(tr["url_template"] ?? "")));
      if (tr["cli"]) push(String(tr["cli"]["bin"] ?? ""));
    }
  }
  return [...out].sort();
}

function jsonLines(p: string): number {
  try {
    return fs.readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function appCodeLines(appDir: string, into: { bin: number } = { bin: 0 }): number {
  let n = 0;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) {
        if (/[/\\]bin[/\\]/.test(p)) into.bin += jsonLines(p);
        else n += jsonLines(p);
      }
    }
  };
  walk(appDir);
  return n;
}

/** 上一次套件真跑留下的运行时数（没有产物 = 未跑过，显示"未跑"而不是 0）。 */
interface SuiteStats {
  /** 模型被咨询的决策数（含未过闸门的）——"保险碰没碰过"。 */
  modelAsks: number;
  confMax: number | null;
  reobserve: number;
}

function suiteStats(app: string): SuiteStats | null {
  const file = path.join(suiteOutDir(), app, `${app}-result.json`);
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, any>;
    const d = doc["decisions"] as Record<string, any> | undefined;
    if (!d) return null;
    const conf = d["conf"] as Record<string, any> | undefined;
    return {
      modelAsks: Number(d["model_asks"] ?? 0),
      confMax: typeof conf?.["max"] === "number" ? conf["max"] : null,
      reobserve: Number(d["reobserve"] ?? 0),
    };
  } catch {
    return null;                      // 没跑过/读不到：如实缺席
  }
}

/** 包声明的策略（原样回显，不补默认值——"没声明"和"声明成缺省值"是两件事）。 */
function declaredPolicy(pack: AppPack): string {
  const q = (pack as unknown as Record<string, unknown>)["policy"] as Record<string, unknown> | undefined;
  if (!q) return "";
  return Object.entries(q).map(([k, v]) => `${k}=${String(v)}`).join(" ");
}

/**
 * R2 学习环的账：读**上一次 app-runner 独立运行**产物里的 `hint_memory`
 * （`AMBERFLOW_APPS_OUT`，缺省 tmpdir/amberflow-apps——suite 的桩臂不学习，所以出处不是套件目录）。
 * 三种缺席要分开说：没有产物 = "未跑"；有产物但没开 --learn-hints = "未接"；
 * 开了 = `已知/复用`。绝不把"没证据"印成 0。
 */
function learnColumn(app: string): string {
  const file = path.join(appsOutDir(), `${app}-result.json`);
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return "未跑";
  }
  const h = doc["hint_memory"] as Record<string, unknown> | undefined;
  if (!h) return "未接";
  return `${Number(h.entries ?? 0)}/${Number(h.used ?? 0)}`;
}

function hintCoverageOf(pack: AppPack): string {
  const c = packHintCoverage(pack);
  if (!c.browser) return "-";
  // 两个数并排：hint 点名 / 由声明解决（含 commands）。相等时只打一个，免得读的人以为有差。
  return c.named === c.hinted ? `${c.hinted}/${c.browser}` : `${c.hinted}(+${c.named - c.hinted} commands)/${c.browser}`;
}

interface Row {
  app: string;
  kind: string;
  sources: number;
  roles: number;
  steps: number;
  /** 旅程里的工具步（命令行动作腿）数量 */
  toolSteps: number;
  invariants: number;
  declared: number;
  code: number;
  tokens: string[];
  /** 这个包是**生成的**吗？`spec` 就是它的上游（`generated_from`）；手写的是 `null`。 */
  generated: string | null;
  /** 上一次套件真跑的模型咨询数（`null` = 未跑；0 = 真跑过且零咨询——那是卖点，不是缺数）。 */
  modelAsks: number | null;
  confMax: number | null;
  reobserve: number | null;
  /** 包声明的运行策略（§3）：`k=v` 列表；没声明为空串（缺省 = 今天的行为）。 */
  policy: string;
  /** 浏览器步里点名了目标的比例（§W2：承重墙要每天看得见）。 */
  hintCoverage: string;
  /** R2 学习环：`已知/复用`（读上次 app-runner 独立跑产物）；"未跑"/"未接" 是缺席，不是 0。 */
  learn: string;
}

export function matrix(): {
  rows: Row[];
  leaks: Array<{ token: string; file: string }>;
  debt: Array<{ token: string; file: string }>;
  /** `bin/` 桩夹具的行数（不计入"应用逻辑代码行"，但头条数字要说明它） */
  binLines: number;
} {
  const rows: Row[] = [];
  const binAcc = { bin: 0 };            // bin/ 桩夹具的行数（不计入"应用逻辑"，但要在头条里说明）
  for (const dir of appDirs()) {
    const pack = loadPack(path.join(dir, "pack.json"));
    const srcDir = path.join(dir, "sources");
    const sources = fs.existsSync(srcDir)
      ? fs.readdirSync(srcDir).filter((f) => f.endsWith(".json")).length : 0;
    const stats = suiteStats(pack.id);
    rows.push({
      app: pack.id, kind: "pack",
      modelAsks: stats?.modelAsks ?? null, confMax: stats?.confMax ?? null,
      reobserve: stats?.reobserve ?? null,
      // 数据腿可以是本目录的 source，也可以是引用别的应用的 source（`sources` 字段）
      sources: Math.max(sources, (pack.sources ?? []).length),
      roles: Object.keys(pack.roles ?? {}).length,
      steps: pack.journey.length,
      toolSteps: pack.journey.filter((e) => (e as Record<string, unknown>)["source"] !== undefined).length,
      invariants: (pack.invariants ?? []).length,
      declared: jsonLines(path.join(dir, "pack.json")),
      code: appCodeLines(dir, binAcc),
      tokens: declaredTokens(dir),
      policy: declaredPolicy(pack), hintCoverage: hintCoverageOf(pack),
      learn: learnColumn(pack.id),
      generated: (() => {
        const p2 = pack as {
          generated_from?: { spec?: string; source?: string };
          recorded_from?: { url?: string };
        };
        const g = p2.generated_from;
        if (g?.spec || g?.source) return g.spec ?? g.source ?? null;
        if (p2.recorded_from?.url) return `recorded:${p2.recorded_from.url}`;   // 演示录下来的
        return null;
      })(),
    });
  }
  // 只用 sources 的应用（数据腿应用）也算应用——它们没有包
  for (const d of new Set(listSources().map(([, , p]) => path.dirname(p)))) {
    if (path.dirname(d) === path.join(REPO, "apps") || !d.startsWith(path.join(REPO, "apps"))) continue;
    const app = path.basename(path.dirname(d));
    if (rows.some((r) => r.app === app)) continue;
    rows.push({
      app, kind: "sources-only", sources: fs.readdirSync(d).filter((f) => f.endsWith(".json")).length,
      roles: 0, steps: 0, toolSteps: 0, invariants: 0, generated: null,
      modelAsks: null, confMax: null, reobserve: null,
      policy: "", hintCoverage: "-", learn: "-",          // 只有数据腿的目录：没有旅程，也就没有点名与策略
      declared: fs.readdirSync(d).filter((f) => f.endsWith(".json"))
        .reduce((n, f) => n + jsonLines(path.join(d, f)), 0),
      code: appCodeLines(path.dirname(d), binAcc), tokens: declaredTokens(path.dirname(d)),
    });
  }
  rows.sort((a, b) => (a.app < b.app ? -1 : a.app > b.app ? 1 : 0));

  // ---- 防泄漏：应用声明的标识不许出现在共享层代码里 ------------------------
  const shared = SHARED.map((f) => [f, codeOnly(f)] as const);
  const leaks: Array<{ token: string; file: string }> = [];
  const allTokens = new Set(rows.flatMap((r) => r.tokens));
  // 根目录下的站点配置（`<site>/sources`）同样受这条纪律约束：站点名是配置，不是引擎知识
  for (const [, , file] of listSources()) {
    const dir = path.dirname(file);
    if (!dir.startsWith(path.join(REPO, "apps"))) {
      for (const t of declaredTokens(path.dirname(dir))) allTokens.add(t);
    }
  }
  const debt: Array<{ token: string; file: string }> = [];
  // 声明无关的那一半：非核心共享层文件里**写死的 http(s) 主机**。声明过的 token 已经
  // 由下面的循环覆盖；这里抓的是"藏在驱动里、应用还没声明"的站点知识——否则债计数
  // 就只能看见自己已经承认的那些。
  const declaredSet = new Set(allTokens);
  for (const [file, code] of shared) {
    if (CORE.has(path.basename(file))) continue;
    for (const m of code.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) {
      const h = m[1]!.toLowerCase();
      if (GENERIC_HOSTS.has(h) || declaredSet.has(h)) continue;
      const entry = { token: h, file: path.relative(REPO, file) };
      if (!debt.some((d) => d.token === entry.token && d.file === entry.file)) debt.push(entry);
    }
  }
  for (const token of allTokens) {
    // 词边界匹配：短标识（git / jq）用子串会误伤 digit / legitimate 这类普通单词
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    for (const [file, code] of shared) {
      if (!re.test(code)) continue;
      const entry = { token, file: path.relative(REPO, file) };
      if (CORE.has(path.basename(file))) leaks.push(entry); else debt.push(entry);
    }
  }
  return { rows, leaks, debt, binLines: binAcc.bin };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  let values;
  // 打错的参数 → 一行点名，绝不甩 parseArgs 的堆栈（src/cli-args.ts 的体例）。
  try {
    ({ values } = parseArgs({ args: argv, options: { json: { type: "boolean" } } }));
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    console.error(usageErrorLine(err));
    return 2;
  }
  const { rows, leaks, debt, binLines } = matrix();
  if (values.json) {
    console.log(JSON.stringify({ rows, leaks, debt }, null, 2));
    return leaks.length ? 1 : 0;
  }
  const head = ["应用", "类型", "数据源", "角色", "步骤", "工具步", "不变量", "声明行", "代码行", "模型咨询", "reobserve", "来源", "声明的标识", "hint覆盖", "学到/复用", "policy"];
  // 运行时两列的口径（LAYA_VALUE_PLAN P1）：读上一次 `apps:suite` 的 result.json；
  // "未跑" ≠ 0——前者是没证据，后者是真跑过且规则消化了全部（这是卖点）。
  const fmtModel = (r: Row): string => r.modelAsks === null ? "未跑"
    : `${r.modelAsks}${r.confMax !== null ? `(conf ${r.confMax.toFixed(2)})` : ""}`;
  const fmtReobs = (r: Row): string => r.reobserve === null ? "未跑" : String(r.reobserve);
  const table = rows.map((r) => [r.app, r.kind, String(r.sources), String(r.roles), String(r.steps),
    String(r.toolSteps), String(r.invariants), String(r.declared), String(r.code),
    fmtModel(r), fmtReobs(r),
    r.generated
      ? (r.generated.startsWith("recorded:")
        ? `录制:${r.generated.slice("recorded:".length)}`
        : `生成:${r.generated.replace(/^transfer\/specs\//, "").replace(/\.json$/, "").replace(/^src\//, "")}`)
      : "手写",
    r.tokens.join(",") || "-", r.hintCoverage, r.learn || "-", r.policy || "-"]);
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((r) => r[i]!.length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of table) console.log(line(r));
  const totDeclared = rows.reduce((n, r) => n + r.declared, 0);
  const totCode = rows.reduce((n, r) => n + r.code, 0);
  const allTokenCount = new Set([...rows.flatMap((r) => r.tokens),
    ...leaks.map((l) => l.token), ...debt.map((d) => d.token)]).size;
  console.log();
  // `bin/` 里的桩夹具不计入"应用逻辑代码行"（它是工具步要调的命令，跟配置一样是夹具）——
  // 但头条数字必须写明这一点：独立复核量过 apps/demo-tool/bin/stub-tool.mjs 共 102 行（非空 93），
  // 只写"0 行"字面不真。
  console.log(`应用 ${rows.length} 个 ｜ 声明 ${totDeclared} 行 ｜ 应用目录里的代码 ${totCode} 行`
    + `（期望 0：应用是数据，代码在共享层；另有 bin/ 桩夹具 ${binLines} 行不计入）`);
  const gen = rows.filter((r) => r.generated && !r.generated.startsWith("recorded:")).length;
  const rec = rows.filter((r) => r.generated?.startsWith("recorded:")).length;
  const hand = rows.length - gen - rec;
  const genDeclared = rows.filter((r) => r.generated).reduce((n, r) => n + r.declared, 0);
  console.log(`共享层文件 ${SHARED.length} 个（核心 ${CORE.size} 个）｜ 应用声明的标识 ${allTokenCount} 个`);
  console.log(`其中**由 spec/代码生成**的 ${gen} 个、**演示录制的** ${rec} 个（合计声明 ${genDeclared} 行不再由人抄写）；`
    + `手写 ${hand} 个 —— 剩给"人"的只有 invariants / notes / 探针这些判断与测量`);
  if (debt.length) {
    console.log();
    console.log(`每站点专用驱动里的站点知识（债，不是豁免）：${debt.length} 处`);
    for (const d of debt) console.log(`  - ${d.file} 提到 ${JSON.stringify(d.token)}`);
  }
  if (leaks.length) {
    console.log();
    console.log("泄漏检查：FAIL");
    for (const l of leaks) console.log(`  - 核心层 ${l.file} 出现了应用标识 ${JSON.stringify(l.token)}`);
    return 1;
  }
  console.log("泄漏检查：OK（核心层代码里没有任何应用声明的站点/工具标识）");
  console.log(`模型步/reobserve 两列读的是上一次 \`apps:suite\` 的产物（${suiteOutDir()}）；`
    + `"未跑"=没有证据，0=真跑过且规则消化了全部（model not needed，正是产品主张）`);
  console.log(`学到/复用 列读的是上一次 **app-runner 独立跑**（带 --learn-hints）的产物（${appsOutDir()}）；`
    + `"未接"=那次没开学习环——学习环的账不替没发生的事编数（R2）`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(main());
}
