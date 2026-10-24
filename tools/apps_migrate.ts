/**
 * `apps/<id>/pack.json` → `apps/<id>/app.mjs`（L3.1 迁移工具）。
 *
 * 目的：把"今天的数据格式"**无损**搬进脚本作者面，作为删掉 JSON 加载路径的过渡证据。
 * 生成的脚本是**声明式**（`meta()` + `app()`），数据内联；它不发明判断，也不改一个字段——
 * 验收口径是"生成的脚本 `loadApp` 后 `expandPack` 与来源包逐字段 0 diff"。
 *
 * 用法：
 *   npm run apps:migrate -- --app ip-config            # 打印生成的脚本（不落盘）
 *   npm run apps:migrate -- --app ip-config --write    # 写 apps/ip-config/app.mjs
 *   npm run apps:migrate -- --all --check              # 全部生成到临时目录并对照（CI 口径）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { listPacks, loadPack, expandPack, type AppPack } from "../src/app/app-pack.ts";
import { packToScriptSource } from "../src/app/declarative.ts";
import { isParseUsageError, stripArgSeparators } from "../src/support/cli-args.ts";
import { REPO } from "../src/flow/flow.ts";

// 生成器本体在 `src/app/declarative.ts`（与 `apps:gen` 共用同一份；这里只做 CLI/校验）。
export { DECLARATIVE_MARKER, packToScriptSource } from "../src/app/declarative.ts";

/** 生成到临时文件并用**真实加载器**读回来对照（与 `apps:migrate --check` 同一实现）。 */
export async function verifyMigration(pack: AppPack): Promise<{ problems: string[]; source: string }> {
  const source = packToScriptSource(pack);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `amberflow-migrate-${pack.id}-`));
  const file = path.join(dir, "app.mjs");
  fs.writeFileSync(file, source, "utf-8");
  const problems: string[] = [];
  try {
    const { loadScriptApp } = await import("../src/app/app-script.ts");
    const loaded = await loadScriptApp(file);
    const a = expandPack(loaded.pack);
    const b = expandPack(pack);
    const cmp = (label: string, x: unknown, y: unknown): void => {
      if (JSON.stringify(x) !== JSON.stringify(y)) problems.push(`${label}: migrated ≠ source`);
    };
    cmp("steps", a.steps, b.steps);
    cmp("invariants", a.invariants, b.invariants);
    cmp("slots", a.slots, b.slots);
    cmp("rolesUsed", a.rolesUsed, b.rolesUsed);
    cmp("hosts", loaded.pack.hosts ?? [], pack.hosts ?? []);
    cmp("sources", loaded.pack.sources ?? [], pack.sources ?? []);
    // 源码也要逐字节一致：否则"手改了 app.mjs 却仍能展开成自己"会静默通过（生成物必须可重放）。
    const regenerated = packToScriptSource(loaded.pack);
    if (fs.readFileSync(file, "utf-8") !== regenerated) problems.push("source bytes: app.mjs ≠ 由它自己重新生成的结果");
  } catch (e) {
    problems.push(`load/validate failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { problems, source };
}

async function main(argv: string[]): Promise<number> {
  const args = stripArgSeparators(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args, allowPositionals: false,
      options: {
        app: { type: "string" }, all: { type: "boolean" },
        write: { type: "boolean" }, check: { type: "boolean" }, quiet: { type: "boolean" },
      },
    });
  } catch (e) {
    console.error(isParseUsageError(e) ? (e as Error).message : String(e));
    return 2;
  }
  const v = parsed.values;
  const quiet = v.quiet === true;
  const targets: Array<{ id: string; packPath: string }> = v.all === true
    ? listPacks().map(([id, , p]) => ({ id, packPath: p }))
    : (() => {
        const id = typeof v.app === "string" ? v.app : "";
        if (!id) return [];
        const hit = listPacks().find(([x]) => x === id);
        return hit ? [{ id, packPath: hit[2] }] : [{ id, packPath: path.join(REPO, "apps", id, "pack.json") }];
      })();
  if (!targets.length) {
    console.error("usage: apps:migrate --app <id> [--write] [--check] | --all [--check]");
    return 2;
  }
  let bad = 0;
  for (const t of targets) {
    const pack = loadPack(t.packPath);
    const { problems, source } = await verifyMigration(pack);
    if (problems.length) { bad += 1; console.error(`✗ ${t.id}: ${problems.join(" | ")}`); continue; }
    if (v.write === true) {
      const out = path.join(path.dirname(t.packPath), "app.mjs");
      fs.writeFileSync(out, source, "utf-8");
      if (!quiet) console.log(`✓ ${t.id}  ${path.relative(REPO, out)}  (0 diff)`);
    } else if (!quiet) {
      console.log(`✓ ${t.id}  (0 diff)`);
      if (v.all !== true) console.log(source);
    }
  }
  if (!quiet && targets.length > 1) console.log(`\n${targets.length - bad}/${targets.length} 个应用迁移后与来源包逐字段一致`);
  return bad ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
