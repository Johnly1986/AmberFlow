/**
 * split-check —— 纯搬移的**等价门禁**：把「声明要搬迁的符号」的源码文本 sha256 钉进
 * `tools/golden/splits/<id>.json`。拆分 PR 只允许改 manifest 里的**文件路径**，hash 不动：
 * 搬过去的源码必须逐字节一致；改一个字符就红。
 *
 * 为什么需要：仓库无单测、CI 离线（`npm run check` 只验声明面），而大文件机械拆分
 * 的唯一可门禁证据是「搬的是同一段代码」——运行语义由 dry / trace / verify-offline 承担，
 * 本工具只把「纯搬移」这一半变成可重复断言。纯 Node + TypeScript 编译器 API：
 * 零网络、零浏览器、零模型，可进 `npm run check`。
 *
 * 工作流（每个拆分 PR）：
 *   1) 搬移前：`--record <id> --file <旧路径> [--file …]`，manifest 落在 `tools/golden/splits/<id>.json`；
 *   2) 搬移后：只把 manifest 的 `files` 键改成新路径（hash 一个都不许动），`--check` 必须绿；
 *   3) hash 不一致 = 搬移顺带改了实现 → 要么回退该改动，要么把该符号从 manifest 里删掉并在 PR 说明
 *      （明确「不是纯搬移」）。
 *
 * 用法：
 *   node --experimental-strip-types tools/split-check.ts                     # 检查全部 manifest
 *   node --experimental-strip-types tools/split-check.ts --check             # 同上，显式
 *   node --experimental-strip-types tools/split-check.ts --record <id> --file src/app/app-pack.ts [--file …] [--note "…"]
 *   node --experimental-strip-types tools/split-check.ts --list              # 列出 manifest 与符号数
 *   node --experimental-strip-types tools/split-check.ts --self-test        # 合成负向自测（改一字符必须红）
 * 退出码：0 绿 / 1 红 / 2 用法错误。manifest 目录为空 = 通过（先能进 CI，再按拆分逐个加）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const REPO = path.resolve(import.meta.dirname, "..");
const GOLDEN_DIR = path.join(REPO, "tools", "golden", "splits");
const USAGE = [
  "usage: node --experimental-strip-types tools/split-check.ts [--check | --list | --self-test",
  "         | --record <id> --file <repo-relative.ts> [--file …] [--note <text>]]",
].join("\n");
const MANIFEST_DOC =
  "纯搬移等价 manifest（tools/split-check.ts）：files→symbols→源码文本 sha256。"
  + "拆分 PR 只许改 files 路径，hash 必须不变。文件名以 _ 开头的被 --check 跳过。";
const HASH_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface SplitManifest {
  _doc?: string;
  id: string;
  note?: string;
  /** 仓库相对路径（正斜杠）→ 该文件内声明的符号 → 源码文本 sha256。 */
  files: Record<string, { symbols: Record<string, string> }>;
}

export interface Problem {
  manifest: string;
  message: string;
}

/** sha256 小写十六进制。 */
function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** 顶层声明名（function/class/interface/type/const/enum/namespace；同名重载按源码序收集）。 */
function declaredNamesOf(stmt: ts.Statement): string[] {
  if (ts.isFunctionDeclaration(stmt)) return stmt.name === undefined ? [] : [stmt.name.text];
  if (ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
    return stmt.name === undefined ? [] : [stmt.name.text];
  }
  if (ts.isModuleDeclaration(stmt)) return [stmt.name.getText()];
  if (ts.isVariableStatement(stmt)) {
    const names: string[] = [];
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
    }
    return names;
  }
  return [];
}

/**
 * 收集一个 TS 文件里可被 manifest 声明的顶层符号：符号名 → 源码文本（同名声明按源码序拼接）。
 * 只取**顶层声明**——机械拆分搬的就是这些边界；类体内方法随类整体哈希，不单独声明。
 */
export function collectSymbols(fileAbs: string): Map<string, string> {
  const source = fs.readFileSync(fileAbs, "utf8");
  const sf = ts.createSourceFile(fileAbs, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const buckets = new Map<string, string[]>();
  for (const stmt of sf.statements) {
    const text = stmt.getText(sf);
    for (const name of declaredNamesOf(stmt)) {
      const arr = buckets.get(name) ?? [];
      arr.push(text);
      buckets.set(name, arr);
    }
  }
  const out = new Map<string, string>();
  for (const [name, texts] of buckets) out.set(name, texts.join("\n"));
  return out;
}

/** 规范化 manifest 里的仓库相对路径：拒绝绝对路径、`..` 与 Windows 反斜杠。 */
function normalizeRelPath(raw: string): string | null {
  const rel = raw.trim().replace(/\\/g, "/");
  if (rel === "" || path.isAbsolute(rel) || rel.split("/").includes("..")) return null;
  return rel;
}

/** 校验一个 manifest（纯函数，`repo`/`symbolsOf` 可注入便于自测）。 */
export function checkManifest(
  manifest: SplitManifest,
  opts: { repo?: string; symbolsOf?: (fileAbs: string) => Map<string, string> } = {},
): Problem[] {
  const repo = opts.repo ?? REPO;
  const symbolsOf = opts.symbolsOf ?? collectSymbols;
  const problems: Problem[] = [];
  const push = (message: string): void => { problems.push({ manifest: manifest.id, message }); };
  if (typeof manifest.id !== "string" || !ID_RE.test(manifest.id)) {
    push(`manifest id 非法（要求 ^[a-z0-9][a-z0-9-]*$）：${JSON.stringify(manifest.id)}`);
  }
  if (manifest.files === null || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    push("manifest.files 必须是对象：{ \"repo/relative.ts\": { symbols: { name: sha256 } } }");
    return problems;
  }
  const files = Object.entries(manifest.files);
  if (files.length === 0) {
    push("manifest.files 为空——空 manifest 没有断言力；先 --record 或在 PR 里声明要钉的符号");
  }
  for (const [rawFile, entry] of files) {
    const rel = normalizeRelPath(rawFile);
    if (rel === null) { push(`files 键不是合法的仓库相对路径：${JSON.stringify(rawFile)}`); continue; }
    if (rel !== rawFile) { push(`files 键应使用正斜杠相对路径：${JSON.stringify(rawFile)} → ${JSON.stringify(rel)}`); continue; }
    if (entry === null || typeof entry !== "object" || entry.symbols === null || typeof entry.symbols !== "object" || Array.isArray(entry.symbols)) {
      push(`${rel}: 缺少 symbols 对象`);
      continue;
    }
    const symbols = Object.entries(entry.symbols);
    if (symbols.length === 0) push(`${rel}: symbols 为空（声明文件却没声明符号）`);
    const abs = path.join(repo, rel);
    if (!fs.existsSync(abs)) {
      push(`${rel}: 文件不存在——搬移后请把 manifest 的 files 键改成新路径（hash 不动）`);
      continue;
    }
    const current = symbolsOf(abs);
    for (const [symbol, want] of symbols) {
      if (typeof want !== "string" || !HASH_RE.test(want)) {
        push(`${rel}#${symbol}: 期望值是 64 位小写 sha256，实际 ${JSON.stringify(want)}`);
        continue;
      }
      const got = current.get(symbol);
      if (got === undefined) {
        push(`${rel}#${symbol}: 符号不存在（被改名/搬走但 manifest 没更新？）`);
        continue;
      }
      const gotHash = sha256(got);
      if (gotHash !== want) {
        push(`${rel}#${symbol}: 源码文本 hash 不一致（期望 ${want.slice(0, 12)}…，实际 ${gotHash.slice(0, 12)}…）——不是纯搬移或搬移改动了实现`);
      }
    }
  }
  return problems;
}

/** 读取 manifest 文件（JSON 语法错误也算 problem）。 */
function readManifest(fileAbs: string): { manifest: SplitManifest | null; problem: string | null } {
  let raw: string;
  try {
    raw = fs.readFileSync(fileAbs, "utf8");
  } catch (err) {
    return { manifest: null, problem: `读取失败：${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return { manifest: JSON.parse(raw) as SplitManifest, problem: null };
  } catch (err) {
    return { manifest: null, problem: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 检查目录下全部 manifest（`_` 前缀与 .json 之外跳过；目录不存在 = 通过）。 */
export function checkAll(goldenDir = GOLDEN_DIR, repo = REPO): { problems: Problem[]; checked: string[] } {
  const problems: Problem[] = [];
  const checked: string[] = [];
  if (!fs.existsSync(goldenDir)) return { problems, checked };
  const files = fs.readdirSync(goldenDir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
  for (const file of files) {
    const { manifest, problem } = readManifest(path.join(goldenDir, file));
    if (problem !== null || manifest === null) {
      problems.push({ manifest: file, message: problem ?? "manifest 为空" });
      continue;
    }
    checked.push(manifest.id);
    problems.push(...checkManifest(manifest, { repo }));
  }
  return { problems, checked };
}

/** 写一个 manifest（目录不存在则创建；键排序保证 diff 稳定）。 */
export function recordManifest(
  goldenDir: string, repo: string, id: string, relFiles: string[], note?: string,
  symbolsOf: (fileAbs: string) => Map<string, string> = collectSymbols,
): void {
  const files: SplitManifest["files"] = {};
  for (const raw of relFiles) {
    const rel = normalizeRelPath(raw);
    if (rel === null) throw new Error(`--file 需要仓库相对路径（正斜杠、不允许 .. 与绝对路径）：${JSON.stringify(raw)}`);
    const abs = path.join(repo, rel);
    if (!fs.existsSync(abs)) throw new Error(`--file 指向的文件不存在：${rel}`);
    const symbols: Record<string, string> = {};
    for (const [name, text] of [...symbolsOf(abs).entries()].sort(([a], [b]) => a.localeCompare(b))) {
      symbols[name] = sha256(text);
    }
    files[rel] = { symbols };
  }
  const sortedFiles: SplitManifest["files"] = {};
  for (const rel of Object.keys(files).sort()) sortedFiles[rel] = files[rel]!;
  const manifest: SplitManifest = { _doc: MANIFEST_DOC, id, ...(note === undefined ? {} : { note }), files: sortedFiles };
  fs.mkdirSync(goldenDir, { recursive: true });
  fs.writeFileSync(path.join(goldenDir, `${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** 列出全部 manifest 的 id / 文件数 / 符号数（人读）。 */
function list(goldenDir = GOLDEN_DIR): number {
  if (!fs.existsSync(goldenDir)) {
    console.log("split: 没有 manifest 目录（空 = 通过）");
    return 0;
  }
  const files = fs.readdirSync(goldenDir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
  if (files.length === 0) {
    console.log("split: 没有 manifest（空 = 通过）");
    return 0;
  }
  for (const file of files) {
    const { manifest, problem } = readManifest(path.join(goldenDir, file));
    if (problem !== null || manifest === null) {
      console.error(`split: ${file} —— ${problem ?? "空 manifest"}`);
      continue;
    }
    const fileCount = Object.keys(manifest.files ?? {}).length;
    const symbolCount = Object.values(manifest.files ?? {}).reduce((n, e) => n + Object.keys(e.symbols ?? {}).length, 0);
    console.log(`split: ${manifest.id} · ${fileCount} 文件 / ${symbolCount} 符号 · ${file}`);
  }
  return 0;
}

/* ------------------------------------------------------------------ 自测 */

/** 合成负向自测：临时目录里跑「记录→改为一字符→必须红」「纯搬移→绿」「空目录→绿」。 */
function selfTest(): number {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-split-selftest-"));
  const goldenDir = path.join(root, "golden");
  let failures = 0;
  let checks = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    checks += 1;
    if (ok) { console.log(`  ✓ ${name}`); return; }
    failures += 1;
    console.error(`  ✗ ${name}${detail === "" ? "" : ` —— ${detail}`}`);
  };
  try {
    // 1) 空 manifest 目录 → 通过。
    check("空目录通过", checkAll(goldenDir, root).problems.length === 0);

    // 2) 记录后原样搬运前 → 绿。
    const aFile = path.join(root, "a.ts");
    const fnText = "export function moved(a: number): number {\n  return a + 1;\n}\n";
    fs.writeFileSync(aFile, `${fnText}export const STABLE = \"x\";\n`, "utf8");
    recordManifest(goldenDir, root, "selftest", ["a.ts"]);
    const recorded = JSON.parse(fs.readFileSync(path.join(goldenDir, "selftest.json"), "utf8")) as SplitManifest;
    check("记录后原样通过", checkAll(goldenDir, root).problems.length === 0,
      JSON.stringify(checkAll(goldenDir, root).problems));

    // 3) 纯搬移：函数文本逐字节搬到 b.ts、从 a.ts 删除 → 只改 manifest 路径，必须绿。
    const bFile = path.join(root, "b.ts");
    fs.writeFileSync(bFile, fnText, "utf8");
    fs.writeFileSync(aFile, "export const STABLE = \"x\";\n", "utf8");
    const movedHash = recorded.files["a.ts"]!.symbols["moved"]!;
    const movedManifest: SplitManifest = {
      _doc: MANIFEST_DOC, id: "selftest", files: { "b.ts": { symbols: { moved: movedHash } } },
    };
    fs.writeFileSync(path.join(goldenDir, "selftest.json"), `${JSON.stringify(movedManifest, null, 2)}\n`, "utf8");
    check("纯搬移（只改文件路径、hash 不动）通过", checkAll(goldenDir, root).problems.length === 0,
      JSON.stringify(checkAll(goldenDir, root).problems));

    // 4) 改一字符 → 必须红，且 reason 点名 hash 不一致。
    fs.writeFileSync(bFile, fnText.replace("a + 1", "a + 2"), "utf8");
    const mutated = checkAll(goldenDir, root).problems;
    check("改一字符必须红", mutated.length === 1 && mutated[0]!.message.includes("hash 不一致"),
      JSON.stringify(mutated));
    fs.writeFileSync(bFile, fnText, "utf8");

    // 5) 符号被改名 → 必须红（防止「搬丢了」被当成通过）。
    fs.writeFileSync(bFile, fnText.replace("function moved", "function renamed"), "utf8");
    const renamed = checkAll(goldenDir, root).problems;
    check("符号改名必须红", renamed.length === 1 && renamed[0]!.message.includes("符号不存在"), JSON.stringify(renamed));
    fs.writeFileSync(bFile, fnText, "utf8");

    // 6) manifest 指向不存在文件 → 必须红。
    fs.writeFileSync(path.join(goldenDir, "missing.json"), `${JSON.stringify({
      id: "missing", files: { "nope.ts": { symbols: { x: movedHash } } },
    }, null, 2)}\n`, "utf8");
    const missing = checkAll(goldenDir, root).problems;
    check("缺文件必须红", missing.length === 1 && missing[0]!.message.includes("文件不存在"), JSON.stringify(missing));
  } catch (err) {
    failures += 1;
    console.error(`  ✗ 自测异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const ok = failures === 0;
  console.log(ok
    ? `split-check --self-test: OK（${checks} 条断言：空目录/原样/纯搬移/改一字符/改名/缺文件）`
    : `split-check --self-test: FAIL（${failures}/${checks} 条未过）`);
  return ok ? 0 : 1;
}

/* ------------------------------------------------------------------ CLI */

function main(argv: string[]): number {
  const argumentError = (message: string): number => {
    console.error(`split-check: ${message}`);
    console.error(USAGE);
    return 2;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  const valueOf = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };
  // 未知旗标 = 用法错误（打错不会静默变成 --check）。
  const known = new Set(["--check", "--list", "--self-test", "--record", "--file", "--note"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--record" || a === "--file" || a === "--note") { i += 1; continue; }
    if (!known.has(a)) return argumentError(`未知参数 ${JSON.stringify(a)}`);
  }

  if (has("--self-test")) return selfTest();
  if (has("--list")) return list();
  const record = valueOf("--record");
  if (record !== null) {
    const id = record;
    if (!ID_RE.test(id)) return argumentError(`--record 的 id 非法（要求 ^[a-z0-9][a-z0-9-]*$）：${JSON.stringify(id)}`);
    const files: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--file") {
        const v = argv[i + 1];
        if (v === undefined) return argumentError("--file 缺少值");
        files.push(v);
        i += 1;
      }
    }
    if (files.length === 0) return argumentError("--record 至少需要一个 --file <旧路径>");
    const note = valueOf("--note") ?? undefined;
    try {
      recordManifest(GOLDEN_DIR, REPO, id, files, note);
    } catch (err) {
      return argumentError(err instanceof Error ? err.message : String(err));
    }
    console.log(`split-check: 已记录 tools/golden/splits/${id}.json（${files.length} 文件）`);
    return 0;
  }

  const { problems, checked } = checkAll();
  for (const p of problems) console.error(`split-check: ${p.manifest}: ${p.message}`);
  if (problems.length > 0) {
    console.error(`split-check: FAIL — ${problems.length} 个问题（检查了 ${checked.length} 个 manifest）`);
    return 1;
  }
  console.log(`split-check: OK — ${checked.length} 个 manifest / 纯搬移 hash 全部一致（空目录也算通过）`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
