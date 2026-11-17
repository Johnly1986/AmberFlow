/**
 * 从 `src/support/config-schema.ts` 生成三份配置派生文档（唯一事实来源 = schema）：
 *
 *   1. `configs/amberflowrc.example.json` —— rc 模板（键 → 默认值，含 `_doc` 前言）；
 *   2. `.env.example`                     —— 环境变量示例（按 CONFIG_GROUPS 分组 + 每键说明）；
 *   3. `docs/CONFIG_REFERENCE.md`         —— 人读配置字段表（键 / 内建默认 / schema 说明 / 作用点）。
 *
 * 用法：
 *   `npm run config:example`         重新生成三份；
 *   `npm run config:example:check`   逐字节校验三份与 schema 一致（漂移即 exit 1）。
 *
 * 生成器**不伪造 schema 字段**：表格里的键/默认/说明全部来自 `CONFIG_GROUPS`；
 * 生成不了的人工信息（优先级、凭据纪律、legacy 别名、env-only 例外、provider-only 11 键）
 * 放在固定段落里由本脚本维护；**每个键的作用点**是 schema 的 `ConfigKeySpec.usedAt` 字段
 * （唯一出处）：schema 新增键忘写 `usedAt` → 生成/校验 exit 2（文档不会缺作用点）。
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DOC, CONFIG_GROUPS, PROVIDER_ONLY_KEYS } from "../src/support/config-schema.ts";
import { REPO } from "../src/support/paths.ts";

const KEY_COUNT = CONFIG_GROUPS.reduce((n, g) => n + g.keys.length, 0);
const PROVIDER_KEY_COUNT = PROVIDER_ONLY_KEYS.reduce((n, g) => n + g.keys.length, 0);
const GROUP_COUNT = CONFIG_GROUPS.length;

/** 只在环境变量层读取、不在配置面的开关（人工例外段；写进 rc/配置会被未知键拒绝）。 */
const ENV_ONLY_READS: ReadonlyArray<{ key: string; reader: string; meaning: string }> = [
  {
    key: "AMBERFLOW_BROWSER_CHANNEL",
    reader: "`src/browser/browser-env.ts`",
    meaning: "`chrome` 或 `headless-shell`；部署/CI 的机器级覆盖，优先于 `meta.policy.browser`（缺省 headless-shell）",
  },
  {
    key: "AMBERFLOW_RESCUE_SHADOW",
    reader: "`src/app/intervention-shadow.ts`",
    meaning: "`1` = 介入/救援影子模式（只记录不阻断）；其余值一律视为关",
  },
];

function defaultLabel(spec: { default?: string }): string {
  return spec.default === undefined ? '`""`（自动/不覆盖）' : `\`${spec.default}\``;
}

/** Markdown 表格单元格转义：schema description 里可能有字面 `|`（如枚举说明 "a | b"）。 */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function assertHandwrittenCoverage(): string[] {
  const problems: string[] = [];
  for (const group of CONFIG_GROUPS) {
    for (const spec of group.keys) {
      if (typeof spec.usedAt !== "string" || spec.usedAt.trim() === "") {
        problems.push(`schema 键 ${spec.key} 缺少 usedAt 作用点（src/support/config-schema.ts）`);
      }
    }
  }
  return problems;
}

function buildJson(): string {
  const out: Record<string, string> = { _doc: CONFIG_DOC };
  for (const group of CONFIG_GROUPS) {
    for (const spec of group.keys) out[spec.key] = spec.default ?? "";
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

function buildEnvExample(): string {
  const lines: string[] = [
    "# AmberFlow 环境变量示例（.env.example）",
    "#",
    `# 生成物，勿手改：由 tools/config-example.ts 从 src/support/config-schema.ts 生成（${KEY_COUNT} 键 / ${GROUP_COUNT} 组）。`,
    "# 重新生成：npm run config:example；漂移校验：npm run config:example:check（npm run check 的一环）。",
    "#",
    "# 语义：空值 = 自动/不覆盖（不是「关闭」）；每行的值就是引擎的内建默认值。",
    "# 优先级：CLI 旗标 > 环境变量 > 项目配置 > 用户配置 > 旧 rc > 内建缺省。",
    "# 凭据：只留本机（配置文件已被 .gitignore 排除），绝不进被审计产物；本示例一律空串。",
    "# 未知键：写进 rc / 用户/项目配置会在加载期以未知键拒绝，不会静默生效。",
  ];
  for (const group of CONFIG_GROUPS) {
    lines.push("", `# --- ${group.group} ---`);
    for (const spec of group.keys) {
      lines.push(`# ${spec.description}`);
      lines.push(`${spec.key}=${spec.default ?? ""}`);
    }
  }
  lines.push(
    "",
    "# --- 不在配置面的环境变量（消费点直接读取 env，写进 rc/配置会被未知键拒绝）---",
  );
  for (const item of ENV_ONLY_READS) {
    lines.push(`# ${item.key}：${item.meaning}（${item.reader}）`);
  }
  return `${lines.join("\n")}\n`;
}

function buildConfigReference(): string {
  const lines: string[] = [
    "# 配置字段表（CONFIG_REFERENCE）",
    "",
    "> **生成物，勿手改**：本文件由 `tools/config-example.ts` 从 `src/support/config-schema.ts` 派生。",
    "> 重新生成 `npm run config:example`；一致性校验 `npm run config:example:check`（`npm run check` 的一环）。",
    "",
    "**单一事实来源**：`src/support/config-schema.ts`（键集、分组、内建默认值）。本表只是人读视图，不接受手改。",
    "",
    "- **优先级**：CLI 旗标 > 环境变量 > 项目配置 > 用户配置 > 旧 rc > 内建缺省。",
    "- **未知键 fail-fast**：不在 schema 的键写进配置文件会在加载期以结构化错误拒绝（点名未知键与已知键集），不会静默生效。",
    "- **凭据纪律**：凭据只留在本机配置文件/环境变量（配置文件已被 `.gitignore` 排除），绝不进计划/包/报告等被审计产物；内建默认值与示例一律空串，展示时只留长度。",
    '- **空串语义**：`""` = 自动/不覆盖（不是「关闭」）。',
    "- **作用点**是人工维护的导航提示（解析结果以代码为准）；它不属于 schema 字段。",
    "",
    `本表覆盖 **${KEY_COUNT} 个配置键 / ${GROUP_COUNT} 组**；另有 ${PROVIDER_KEY_COUNT} 个 provider-only 键见文末例外段（**不属于配置面**）。`,
  ];
  for (const group of CONFIG_GROUPS) {
    lines.push("", `## ${group.group}（${group.keys.length} 键）`, "");
    lines.push("| 键 | 内建默认 | 说明 | 作用点 |", "| --- | --- | --- | --- |");
    for (const spec of group.keys) {
      lines.push(`| \`${spec.key}\` | ${defaultLabel(spec)} | ${cell(spec.description)} | ${cell(spec.usedAt ?? "")} |`);
    }
  }

  const legacy = CONFIG_GROUPS.flatMap((g) =>
    g.keys.filter((k) => k.legacy !== undefined && k.legacy.length > 0)
      .flatMap((k) => (k.legacy ?? []).map((old) => ({ key: k.key, old }))));
  lines.push(
    "",
    "## 旧环境变量别名（legacy，兼容读取但不属于配置面）",
    "",
    "以下旧名仍由各消费点兼容读取，但**不属于配置面**：写进 rc / 用户/项目配置会以未知键拒绝。新代码与新文档一律使用左列配置键。",
    "",
    "| 配置键 | 兼容的旧环境变量 |",
    "| --- | --- |",
  );
  for (const item of legacy) lines.push(`| \`${item.key}\` | \`${item.old}\` |`);

  lines.push(
    "",
    "## 只在环境变量层读取、不在配置面的开关（人工例外段）",
    "",
    "下面这些变量**没有** schema 条目：写进 rc / 用户/项目配置会被未知键拒绝，只能在环境变量层设置。",
    "",
    "| 环境变量 | 读取点 | 语义 |",
    "| --- | --- | --- |",
  );
  for (const item of ENV_ONLY_READS) lines.push(`| \`${item.key}\` | ${cell(item.reader)} | ${cell(item.meaning)} |`);

  lines.push(
    "",
    "## Provider 专属键（仅文档性，不进配置面）",
    "",
    "这些键**不是配置键**：它们只由各家 provider 的消费点按环境变量直接读取，`amber config set` 会按未知键拒绝，写进 rc 也会在加载期拒绝。列在这里只为说明兼容面；provider 是引擎的插件面，引擎不内置其语义。",
    "",
    "| 键 | 凭据 | 说明 |",
    "| --- | --- | --- |",
  );
  for (const group of PROVIDER_ONLY_KEYS) {
    for (const spec of group.keys) {
      lines.push(`| \`${spec.key}\` | ${spec.secret === true ? "是（掩码）" : "否"} | ${cell(spec.description)} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const problems = assertHandwrittenCoverage();
if (problems.length > 0) {
  console.error("配置派生文档生成器与 schema 不一致（修 src/support/config-schema.ts 的 usedAt/手写段）：");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(2);
}

const OUTPUTS = [
  { file: path.join(REPO, "configs", "amberflowrc.example.json"), content: buildJson() },
  { file: path.join(REPO, ".env.example"), content: buildEnvExample() },
  { file: path.join(REPO, "docs", "CONFIG_REFERENCE.md"), content: buildConfigReference() },
];

const check = process.argv.includes("--check");
if (check) {
  let failed = 0;
  for (const out of OUTPUTS) {
    const actual = fs.existsSync(out.file) ? fs.readFileSync(out.file, "utf-8") : "";
    if (actual === out.content) continue;
    failed += 1;
    // task-7：错误面给绝对路径 + 首个差异行号 + 建议动作（只改文案，门禁语义不变）。
    const expLines = out.content.split("\n");
    const actLines = actual.split("\n");
    let diffLine: number | null = null;
    for (let i = 0; i < Math.max(expLines.length, actLines.length); i++) {
      if (expLines[i] !== actLines[i]) { diffLine = i + 1; break; }
    }
    console.error(`${out.file}${diffLine === null ? "" : `（首个差异在第 ${diffLine} 行）`}`
      + " 与 src/support/config-schema.ts 不一致——"
      + "建议：该文件是生成物，不要手改；运行 npm run config:example 重新生成。");
  }
  if (failed > 0) {
    console.error(`配置派生文档漂移：${failed}/${OUTPUTS.length} 份与 schema 不一致`);
    process.exit(1);
  }
  console.log(`configs/amberflowrc.example.json / .env.example / docs/CONFIG_REFERENCE.md 与 schema 一致（${KEY_COUNT} keys）`);
} else {
  for (const out of OUTPUTS) {
    fs.mkdirSync(path.dirname(out.file), { recursive: true });
    fs.writeFileSync(out.file, out.content, "utf-8");
    console.log(`wrote ${out.file} (${KEY_COUNT} keys)`);
  }
}
