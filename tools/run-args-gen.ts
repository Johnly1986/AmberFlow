/**
 * `run-args-gen` —— 把共享契约 `src/support/run-args-contract.ts` 的桥侧子集生成为
 * `integrations/dsh-bridge/src/run-contract.generated.ts`（check in）。
 *
 * 为什么要有生成物：桥包自带 tsconfig（`rootDir=src`），不能 import 仓库 `src`；而字段契约
 * 必须单源，所以桥只收一份**确定性**投影。生成物的任何手改都会在 `--check` 下判红。
 *
 * 用法：
 *   node --experimental-strip-types tools/run-args-gen.ts --write   # 重新生成（改契约后）
 *   node --experimental-strip-types tools/run-args-gen.ts --check   # 校验生成物是否过期
 *
 * 生成物是唯一写点；`--check` 顺带做契约自检（key/flag/argv 序唯一、engine 选项名在引擎
 * 类型面真实存在、validation 与 tool 类型自洽）。退出码：0 = 一致；1 = 过期/契约自检失败；2 = 用法。
 */
import fs from "node:fs";
import path from "node:path";
import {
  RUN_ARG_FIELDS,
  RUN_BRIDGE_MESSAGES,
  RUN_TIMEOUT_MAX_SEC,
  type RunArgField,
  type RunEngineMap,
} from "../src/support/run-args-contract.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const GENERATED_PATH = path.join(REPO, "integrations", "dsh-bridge", "src", "run-contract.generated.ts");

/** 引擎侧可能出现的选项声明来源（`ScriptRunOptions` 在 app-runner.ts，其余在 types）。 */
const ENGINE_OPTION_SOURCES = ["src/app/app-runner.ts", "src/app/app-runner-types.ts"];

/** `*_pilot` 段的选项声明来源（`PilotOptions` 在 pilot-contract.ts）。 */

const MAP_KINDS: ReadonlySet<RunEngineMap> = new Set<RunEngineMap>([
  "flag", "flag-true", "string", "context", "sources", "headful", "confirm-safe", "tiered-hint", "rescue", "none",
]);

/** 契约自检：任何一条都能让"新增字段只改契约"失效，所以生成前先判红。 */
function checkContract(fields: readonly RunArgField[], optionNames: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  const params = new Set<string>();
  const cliFlags = new Set<string>();
  const argvOrders = new Set<number>();
  for (const field of fields) {
    if (keys.has(field.key)) problems.push(`字段 key 重复：${field.key}`);
    keys.add(field.key);
    if (field.param !== undefined) {
      if (params.has(field.param)) problems.push(`tool 参数名重复：${field.param}`);
      params.add(field.param);
    }
    if ((field.param === undefined) !== (field.tool === undefined)) {
      problems.push(`${field.key}: param 与 tool 必须同时出现或同时缺省`);
    }
    if (field.cli !== undefined) {
      if (cliFlags.has(field.cli.flag)) problems.push(`CLI 旗标重复：--${field.cli.flag}`);
      cliFlags.add(field.cli.flag);
    }
    if (field.argv !== undefined) {
      if (argvOrders.has(field.argv.order)) problems.push(`argv.order 重复：${String(field.argv.order)}`);
      argvOrders.add(field.argv.order);
      if (field.cli === undefined) problems.push(`${field.key}: 有 argv 却没有 cli（引擎收不到这个旗标）`);
    }
    if (field.argv?.kind === "provider" && field.argv.order === undefined) {
      problems.push(`${field.key}: provider 类 argv 需要显式 order`);
    }
    if (field.argv?.fallback === true) {
      if (field.argv.kind !== "flag") problems.push(`${field.key}: fallback 只对 boolean flag 有意义`);
      if (typeText(field) !== "boolean") problems.push(`${field.key}: fallback 字段必须是 boolean`);
    }
    problems.push(...checkEngineField(field, optionNames));
  }
  return problems;
}

/** engine 映射自检：选项名真实存在、映射种类与字段形态自洽。 */
function checkEngineField(field: RunArgField, optionNames: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const engine = field.engine;
  if (engine === undefined) return problems;
  if (!MAP_KINDS.has(engine.map)) problems.push(`${field.key}: 未知 engine.map ${String(engine.map)}`);
  if (engine.map === "none") {
    if (engine.option !== undefined) problems.push(`${field.key}: map:none 不带 option`);
  } else if (engine.option === undefined || !optionNames.has(engine.option)) {
    problems.push(`${field.key}: engine.option ${String(engine.option)} 不在引擎选项面（${ENGINE_OPTION_SOURCES.join(" / ")}）`);
  }
  const validate = field.validate;
  if (validate !== undefined) {
    if (validate.kind === "enum" && (field.tool?.enum ?? []).length === 0) {
      problems.push(`${field.key}: enum 校验需要 tool.enum 作为取值闭集`);
    }
    if (validate.kind !== "enum" && field.cli?.type !== "string") {
      problems.push(`${field.key}: ${validate.kind} 校验需要字符串 CLI 旗标`);
    }
  }
  return problems;
}

/** 生成物里的 TS 类型文本（契约逐字给出，或由 tool/cli 类型推导）。 */
function typeText(field: RunArgField): string {
  if (field.tsType !== undefined) return field.tsType;
  const tool = field.tool;
  if (tool !== undefined) {
    if (tool.type === "boolean") return "boolean";
    if (tool.type === "integer") return "number";
    if (tool.type === "number") return "number";
    if (tool.type === "array") return "string[]";
    const values = tool.enum;
    if (values !== undefined && values.length > 0) return values.map((v) => JSON.stringify(v)).join(" | ");
    return "string";
  }
  if (field.cli?.type === "boolean") return "boolean";
  return "string";
}

/** JSDoc 块；契约里的 `doc` 用换行分段，这里按行还原，不改文字。 */
function docLines(field: RunArgField, indent: string): string[] {
  if (field.doc === undefined) return [];
  const lines = field.doc.split("\n");
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`), `${indent} */`];
}

function interfaceProperty(field: RunArgField, optional: boolean): string[] {
  const optionalMark = optional ? "?" : "";
  return [...docLines(field, "  "), `  ${field.key}${optionalMark}: ${typeText(field)};`];
}

/** 桥 tool 参数对象（`as const` 后投影给 `defineTool`，required 仍是本项目 tool 框架的注解位）。 */
function toolParametersSource(fields: readonly RunArgField[], constName: string): string {
  const toolFields = fields.filter((field) => field.tool !== undefined);
  const lines: string[] = [`export const ${constName} = {`];
  for (const field of toolFields) {
    const tool = field.tool;
    if (tool === undefined || field.param === undefined) continue;
    lines.push(`  ${field.param}: {`);
    lines.push(`    type: ${JSON.stringify(tool.type)},`);
    if (tool.required === true) lines.push("    required: true,");
    lines.push(`    description: ${JSON.stringify(tool.description)},`);
    if (tool.enum !== undefined) lines.push(`    enum: [${tool.enum.map((v) => JSON.stringify(v)).join(", ")}],`);
    if (tool.items !== undefined) lines.push(`    items: { type: ${JSON.stringify(tool.items)} },`);
    lines.push("  },");
  }
  lines.push("} as const;");
  return lines.join("\n");
}

/** 全部生成片段；`writeGenerated` 只负责比对/落盘，便于 `--check` 与 `--write` 共用同一份文本。 */
function renderGenerated(fields: readonly RunArgField[]): string {
  const argvFields = fields
    .filter((field) => field.argv !== undefined)
    .sort((a, b) => (a.argv?.order ?? 0) - (b.argv?.order ?? 0));
  const toolFields = fields.filter((field) => field.tool !== undefined);
  const parts: string[] = [];
  parts.push(
    "/**\n"
    + " * 由 tools/run-args-gen.ts 从 src/support/run-args-contract.ts 生成——不要手改。\n"
    + " * 重新生成：npm run run-args:gen；校验：npm run run-args:check。\n"
    + " */\n",
  );
  parts.push(
    "/** 桥进程 argv 的一个发射项（顺序由契约的 argv.order 决定）。 */\n"
    + "export interface BridgeRunArgvField {\n"
    + "  readonly key: keyof BridgeRunArgs;\n"
    + "  readonly flag: string;\n"
    + "  readonly kind: 'flag' | 'value' | 'repeated' | 'provider';\n"
    + "  readonly when?: 'truthy' | 'defined';\n"
    + "}\n",
  );
  parts.push("/** 一个 tool 参数到 `runArgs` camelCase 名的绑定。 */\nexport interface BridgeToolFieldBinding {\n  readonly key: string;\n  readonly param: string;\n  readonly collect?: 'slots';\n}\n");
  parts.push("/** 一个 tool 参数到桥 argv 参数名的绑定（argvKey 缺省 = 不往引擎进程传）。 */\nexport interface BridgeServiceFieldBinding {\n  readonly key: string;\n  readonly argvKey?: string;\n}\n");
  // runArgs 的入参面：app/outDir 由桥本体的调用点提供，其余字段来自契约的 argv 块。
  const bridgeLines = ["export interface BridgeRunArgs {", "  app: string;", "  outDir: string;"];
  for (const field of argvFields) bridgeLines.push(...interfaceProperty({ ...field, key: field.argv?.key ?? field.key }, true));
  bridgeLines.push("}");
  parts.push(bridgeLines.join("\n"));
  // AmberFlowRunArgs 的入参面：tool 字段的 camelCase 形状（app 必填，其余可选）。
  const serviceLines = ["export interface BridgeServiceRunArgs {"];
  for (const field of toolFields) serviceLines.push(...interfaceProperty(field, field.tool?.required !== true));
  serviceLines.push("}");
  parts.push(serviceLines.join("\n"));
  parts.push(toolParametersSource(fields, "RUN_TOOL_PARAMETERS"));
  parts.push(
    "export const RUN_TOOL_FIELDS: readonly BridgeToolFieldBinding[] = [\n"
    + toolFields.map((field) => `  { key: ${JSON.stringify(field.key)}, param: ${JSON.stringify(field.param)}, `
      + `${field.tool?.collect === undefined ? "" : `collect: ${JSON.stringify(field.tool.collect)}, `}},\n`).join("")
    + "];\n",
  );
  parts.push(
    "export const RUN_SERVICE_FIELDS: readonly BridgeServiceFieldBinding[] = [\n"
    + toolFields.map((field) => `  { key: ${JSON.stringify(field.key)}`
      + `${field.argv === undefined ? "" : `, argvKey: ${JSON.stringify(field.argv.key ?? field.key)}`} },\n`).join("")
    + "];\n",
  );
  parts.push(
    "export const RUN_ARGV_FIELDS: readonly BridgeRunArgvField[] = [\n"
    + argvFields.map((field) => {
      const argv = field.argv;
      if (argv === undefined) return "";
      const when = argv.when === undefined ? "" : `, when: ${JSON.stringify(argv.when)}`;
      return `  { key: ${JSON.stringify(argv.key ?? field.key)}, flag: ${JSON.stringify(argv.flag)}, `
        + `kind: ${JSON.stringify(argv.kind)}${when} },\n`;
    }).join("")
    + "];\n",
  );
  parts.push(
    "/** 调用方没给时由 `runApp` 补齐的固定转发（模型不可见）。 */\n"
    + "export const RUN_BRIDGE_DEFAULTS: readonly { readonly key: string; readonly value: boolean }[] = [\n"
    + argvFields.filter((field) => field.argv?.fallback === true)
      .map((field) => `  { key: ${JSON.stringify(field.argv?.key ?? field.key)}, value: true },\n`).join("")
    + "];\n",
  );
  parts.push(`/** 桥侧校验文案；\`{tool}\` = \`\${toolPrefix}_run\`。 */\nexport const RUN_BRIDGE_MESSAGES = ${JSON.stringify(RUN_BRIDGE_MESSAGES, null, 2)} as const;\n`);
  parts.push(`/** \`timeout_sec\` 的防呆上限（秒）。 */\nexport const RUN_TIMEOUT_MAX_SEC = ${String(RUN_TIMEOUT_MAX_SEC)};\n`);
  return `${parts.join("\n")}`;
}

/** 引擎类型面里的属性名闭集（用于 engine.option 存在性自检；来源按段给定）。 */
function engineOptionNames(sources: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const rel of sources) {
    const text = fs.readFileSync(path.join(REPO, rel), "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
      if (m?.[1] !== undefined) names.add(m[1]);
    }
  }
  return names;
}

function main(argv: readonly string[]): number {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write === check) {
    console.error("usage: run-args-gen (--write | --check)");
    return 2;
  }
  const problems = [
    ...checkContract(RUN_ARG_FIELDS, engineOptionNames(ENGINE_OPTION_SOURCES)),
  ];
  if (problems.length > 0) {
    for (const problem of problems) console.error(`run-args: ${problem}`);
    console.error("run-args: 契约自检失败——先修 src/support/run-args-contract.ts");
    return 1;
  }
  const source = `${renderGenerated(RUN_ARG_FIELDS)}`;
  const current = fs.existsSync(GENERATED_PATH) ? fs.readFileSync(GENERATED_PATH, "utf8") : "";
  if (write) {
    fs.writeFileSync(GENERATED_PATH, source);
    console.log(`run-args-gen: 已写入 ${path.relative(REPO, GENERATED_PATH)}`);
    return 0;
  }
  if (current !== source) {
    console.error(`run-args: ${path.relative(REPO, GENERATED_PATH)} 与契约不一致——运行 npm run run-args:gen`);
    return 1;
  }
  console.log(`run-args: 生成物与契约一致（${path.relative(REPO, GENERATED_PATH)}）`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(main(process.argv.slice(2)));
}
