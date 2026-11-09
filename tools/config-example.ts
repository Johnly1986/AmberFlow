/**
 * 从 `src/support/config-schema.ts` 生成 `configs/amberflowrc.example.json`。
 *
 * 示例里的键与默认值不再手抄：schema 是唯一出处。新增配置键时改 schema，再跑
 * `npm run config:example`；`--check` 用于门禁（示例与 schema 漂移就红）。
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DOC, CONFIG_GROUPS } from "../src/support/config-schema.ts";
import { REPO } from "../src/support/paths.ts";

const out: Record<string, string> = { _doc: CONFIG_DOC };
for (const group of CONFIG_GROUPS) {
  for (const spec of group.keys) out[spec.key] = spec.default ?? "";
}
const file = path.join(REPO, "configs", "amberflowrc.example.json");
const expected = `${JSON.stringify(out, null, 2)}\n`;
const check = process.argv.includes("--check");

if (check) {
  const actual = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  if (actual !== expected) {
    // task-7：错误面给绝对路径 + 首个差异行号 + 建议动作（只改文案，门禁语义不变）。
    const expLines = expected.split("\n");
    const actLines = actual.split("\n");
    let diffLine: number | null = null;
    for (let i = 0; i < Math.max(expLines.length, actLines.length); i++) {
      if (expLines[i] !== actLines[i]) { diffLine = i + 1; break; }
    }
    console.error(`${file}${diffLine === null ? "" : `（首个差异在第 ${diffLine} 行）`}`
      + " 与 src/support/config-schema.ts 不一致——"
      + "建议：该文件是生成物，不要手改；运行 npm run config:example 重新生成。");
    process.exit(1);
  }
  console.log(`configs/amberflowrc.example.json 与 schema 一致（${Object.keys(out).length - 1} keys）`);
} else {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, expected, "utf-8");
  console.log(`wrote ${file} (${Object.keys(out).length - 1} keys)`);
}
