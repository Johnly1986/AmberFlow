/**
 * **声明式脚本**（`@amberflow:declarative-data`）的读写——L3 的桥。
 *
 * 迁移生成的 `app.mjs` 长这样（固定形状，由 `packToScriptSource` 产出）：
 *
 * ```js
 * // @amberflow:declarative-data ...
 * const META = { ... };
 * const DATA = { ... };
 * const JOURNEY = [ ... ];
 * export const meta = () => META;
 * export const app = () => ({ data: DATA, exec: JOURNEY });
 * ```
 *
 * 为什么要有**同步解析**：`loadPack` 是同步 API，被 39 个文件当"读一个应用"用。
 * 删掉 `pack.json` 后如果只能 `import()`（异步），这 39 处全要改签名。这里的取舍是：
 * 声明式脚本是**数据**（带标记、固定形状、不含逻辑），所以可以像 JSON 一样同步读；
 * 带控制流的 `flow` 脚本仍走异步 `import()`（`loadScriptApp`）。
 */
import fs from "node:fs";
import path from "node:path";
import type { AppPack, PackSite } from "./app-pack.ts";

/** 标记：只有带它的 `.mjs` 才算"数据脚本"（别的代码文件仍然算逻辑，见 apps:matrix）。 */
export const DECLARATIVE_MARKER = "@amberflow:declarative-data";

/**
 * meta 的字段表（**唯一清单**）：序列化（IR→脚本）与降级（脚本→IR）都读它。
 *
 * 为什么要有这张表：字段原来在**三处**各写一遍（类型 / lower 的逐字段搬运 / 序列化的
 * `MIGRATE_FIELDS`），加一个字段漏一处就是"静默丢字段"。现在加字段只改这张表。
 *
 * `meta` = 脚本面的 canonical 名字（camelCase）；`pack` = IR/pack.json 面（snake_case）；
 * `aliases` = 旧脚本里的写法（只读兼容，序列化只写 canonical）。
 */
export interface MetaField {
  readonly meta: string;
  readonly pack: string;
  readonly aliases?: readonly string[];
}

export const META_FIELD_MAP: readonly MetaField[] = [
  { meta: "id", pack: "id" },
  { meta: "label", pack: "label" },
  { meta: "goal", pack: "goal" },
  { meta: "model", pack: "model" },
  { meta: "maxSubgoals", pack: "max_subgoals", aliases: ["max_subgoals"] },
  { meta: "hosts", pack: "hosts" },
  { meta: "slots", pack: "slots" },
  { meta: "requiredSlots", pack: "required_slots", aliases: ["required_slots"] },
  { meta: "sources", pack: "sources" },
  { meta: "device", pack: "device" },
  { meta: "site", pack: "site" },
  { meta: "notes", pack: "notes" },
  { meta: "policy", pack: "policy" },
  // 迁移/高级用法：步骤模板与探针声明原样搬运（L3 迁移需要；不是常用作者面）。
  { meta: "roles", pack: "roles" },
  { meta: "probe", pack: "probe" },
  { meta: "invariants", pack: "invariants" },
  { meta: "recordedFrom", pack: "recorded_from", aliases: ["recorded_from"] },
  // 生成器血统（`--check`/`--write` 靠它发现"这个应用由 spec 管"）。
  { meta: "generatedFrom", pack: "generated_from", aliases: ["generated_from"] },
] as const;

const META_NAMES = new Set(META_FIELD_MAP.flatMap((f) => [f.meta, ...(f.aliases ?? [])]));

/** 从一个脚本 meta 对象里取某字段（canonical 优先，旧别名兜底）。 */
function metaValue(meta: Record<string, unknown>, field: MetaField): unknown {
  if (meta[field.meta] !== undefined) return meta[field.meta];
  for (const a of field.aliases ?? []) if (meta[a] !== undefined) return meta[a];
  return undefined;
}

const FIELD = Object.fromEntries(META_FIELD_MAP.map((f) => [f.pack, f])) as Record<string, MetaField>;

/** 脚本面对外的 meta 形状（canonical；旧 snake 名字在类型里保留为 deprecated 可选）。 */
export interface ScriptMeta {
  id: string;
  label?: string;
  goal: string;
  model?: string;
  maxSubgoals?: number;
  hosts?: string[];
  slots?: Record<string, string>;
  requiredSlots?: string[];
  sources?: string[];
  device?: Record<string, unknown>;
  /** 站点面声明：页面角色（openPage）/ 命名行抽取（extract）。 */
  site?: PackSite;
  notes?: string[];
  policy?: Record<string, unknown>;
  roles?: Record<string, unknown>;
  probe?: Record<string, unknown>;
  invariants?: Array<Record<string, unknown>>;
  recordedFrom?: Record<string, unknown>;
  generatedFrom?: Record<string, unknown>;
  /** 旧写法（仍可读）：`max_subgoals` 等；新脚本请用 canonical 名字。 */
  max_subgoals?: number;
  required_slots?: string[];
  recorded_from?: Record<string, unknown>;
  generated_from?: Record<string, unknown>;
}

export interface ScriptDraft {
  /** ① 数据槽：常量写进 `slots`；`{kind:"source", source, ...}` 写进 `source_slots`。 */
  data?: Record<string, unknown>;
  /** ② 决策判断（应用级）：只有 `invariants` 在这一层。 */
  judge?: { invariants?: Array<Record<string, unknown>> };
  /** ③ 决策执行：步骤列表。 */
  exec: Array<Record<string, unknown>>;
}

export interface DeclarativeParts {
  meta: ScriptMeta;
  data: Record<string, unknown>;
  journey: Array<Record<string, unknown>>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 一个应用目录里的**应用文件**：`pack.json`（旧格式）或 `app.mjs`（L3 主格式）。
 *
 * 注意两个概念要分开：
 *   - **发现**（这个函数）：任何 `app.mjs` 都算一个应用——包括手写的（没有标记）；
 *   - **同步读取**（`loadPack`）：只有带 `@amberflow:declarative-data` 标记、固定
 *     `META/DATA/JOURNEY` 形状的数据脚本能同步解析；手写脚本走异步的 `loadScriptApp`/CLI。
 * 以前发现也要求标记，导致用户手写的 `app.mjs` 在 `apps list`/按 id 的命令里**不存在**——
 * 那是把"同步读不了"错当成了"不算应用"。
 */
export function appDataFileInDir(dir: string): string | null {
  const json = path.join(dir, "pack.json");
  try {
    if (fs.statSync(json).isFile()) return json;
  } catch { /* 没有旧文件：正常（L3 之后） */ }
  for (const name of ["app.mjs", "app.js", "app.ts"]) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* 读不了就当没有 */ }
  }
  return null;
}

/** 读数据文件 → 声明面字段（JSON 与声明式脚本共用；不校验）。 */
export function readDataFile(file: string): Record<string, unknown> {
  if (file.endsWith(".json")) return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  const parts = parseDeclarativeScript(fs.readFileSync(file, "utf-8"));
  return { ...(parts.meta as unknown as Record<string, unknown>), journey: parts.journey, source_slots: parts.data };
}

export function isDeclarativeScriptSource(src: string): boolean {
  return src.includes(DECLARATIVE_MARKER);
}

/** 从 `start` 处切出一个完整的 JSON 字面量（尊重字符串与转义），失败返回 null。 */
export function sliceJsonLiteral(src: string, start: number): { text: string; end: number } | null {
  let i = start;
  while (i < src.length && /\s/.test(src[i]!)) i += 1;
  const open = src[i];
  if (open !== "{" && open !== "[") return null;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (; i < src.length; i += 1) {
    const c = src[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === "\"") inStr = false;
      continue;
    }
    if (c === "\"") { inStr = true; continue; }
    if (c === "{" || c === "[") { stack.push(c); continue; }
    if (c === "}" || c === "]") {
      const want = c === "}" ? "{" : "[";
      if (stack.pop() !== want) return null;
      if (stack.length === 0) return { text: src.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

/** 解析声明式脚本源码（同步、无执行）。形状不对 → 抛（坏产物必须响亮）。 */
export function parseDeclarativeScript(src: string): DeclarativeParts {
  if (!isDeclarativeScriptSource(src)) {
    throw new Error(`not a declarative app script (missing ${DECLARATIVE_MARKER})`);
  }
  const grab = (name: string): unknown => {
    const at = src.indexOf(`const ${name} = `);
    if (at < 0) throw new Error(`declarative script: missing "const ${name} = ..."`);
    const lit = sliceJsonLiteral(src, at + `const ${name} = `.length);
    if (lit === null) throw new Error(`declarative script: ${name} is not a JSON literal`);
    try {
      return JSON.parse(lit.text);
    } catch (e) {
      throw new Error(`declarative script: ${name} is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  const meta = grab("META");
  const data = grab("DATA");
  const journey = grab("JOURNEY");
  if (!isObj(meta)) throw new Error("declarative script: META must be an object");
  if (!isObj(data)) throw new Error("declarative script: DATA must be an object");
  if (!Array.isArray(journey)) throw new Error("declarative script: JOURNEY must be a list");
  return { meta: meta as unknown as ScriptMeta, data, journey: journey as Array<Record<string, unknown>> };
}

/**
 * 把声明面/动作面**降级**成今天的 IR（`AppPack`）。唯一翻译点（L1 加载器与同步读取共用）。
 *
 * 未知 meta 字段**响亮拒绝**（`_` 开头视为注释）：拼错 `invaraints` 之类如果静默忽略，
 * 表现会是"不变量没生效"而不是"你拼错了"——那是本仓库最反对的一类假绿。
 */
export function lowerDeclarative(meta: ScriptMeta, draft: ScriptDraft): AppPack {
  if (!isObj(meta)) throw new Error("app script: meta must be an object");
  if (!isObj(draft)) throw new Error("app script: app must be an object");

  const m = meta as unknown as Record<string, unknown>;
  const unknown = Object.keys(m).filter((k) => !META_NAMES.has(k) && !k.startsWith("_"));
  if (unknown.length) {
    throw new Error(`app script: meta.${unknown[0]}: unknown field (known: `
      + `${META_FIELD_MAP.map((f) => f.meta).join(", ")}; keys starting with "_" are ignored)`);
  }
  const draftUnknown = Object.keys(draft as unknown as Record<string, unknown>)
    .filter((k) => !["data", "judge", "exec"].includes(k));
  if (draftUnknown.length) {
    throw new Error(`app script: app.${draftUnknown[0]}: unknown field (known: data, judge, exec)`);
  }

  const str = (f: MetaField): string | undefined => {
    const v = metaValue(m, f);
    return v === undefined ? undefined : String(v);
  };
  const id = metaValue(m, FIELD["id"]!);
  const goal = metaValue(m, FIELD["goal"]!);
  if (typeof id !== "string" || !id.trim()) throw new Error("app script: meta.id must be a non-empty string");
  if (typeof goal !== "string" || !goal.trim()) throw new Error("app script: meta.goal must be a non-empty string");
  if (!Array.isArray(draft.exec)) throw new Error("app script: app.exec must be a list of steps");

  const asList = (f: MetaField, label: string): unknown[] => {
    const v = metaValue(m, f);
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`app script: meta.${f.meta} must be a list`);
    void label;
    return [...v];
  };

  // 槽位：meta.slots + app.data（字符串进 slots，`{kind:"source"}` 进 source_slots）。
  const slots: Record<string, unknown> = isObj(metaValue(m, FIELD["slots"]!))
    ? { ...(metaValue(m, FIELD["slots"]!) as Record<string, unknown>) }
    : {};
  const sourceSlots: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(isObj(draft.data) ? draft.data : {})) {
    if (typeof v === "string") { slots[key] = v; continue; }
    if (isObj(v) && v["kind"] === "source") {
      if (typeof v["source"] !== "string" || !v["source"]) {
        throw new Error(`app script: data.${key}: source binding needs a non-empty "source"`);
      }
      const binding: Record<string, unknown> = { source: v["source"] };
      for (const k of ["select", "count", "field"] as const) if (v[k] !== undefined) binding[k] = v[k];
      sourceSlots[key] = binding;
      continue;
    }
    throw new Error(`app script: data.${key}: value must be a string literal or a source binding`);
  }

  const declaredInvariants = metaValue(m, FIELD["invariants"]!);
  const pack: Record<string, unknown> = {
    spec_version: 1,
    id,
    goal,
    hosts: asList(FIELD["hosts"]!, "hosts"),
    slots,
    required_slots: asList(FIELD["required_slots"]!, "requiredSlots"),
    sources: asList(FIELD["sources"]!, "sources"),
    journey: [...draft.exec],
    invariants: [
      ...(Array.isArray(declaredInvariants)
        ? declaredInvariants
        : (draft.judge?.invariants ?? [])),
    ],
  };
  // 其余字段按表直搬（undefined = 缺席；与"缺省等价"纪律一致）。
  for (const f of META_FIELD_MAP) {
    if (["id", "goal", "hosts", "slots", "required_slots", "sources", "invariants"].includes(f.pack)) continue;
    const v = metaValue(m, f);
    if (v === undefined) continue;
    pack[f.pack] = Array.isArray(v) ? [...v] : v;
  }
  if (Object.keys(sourceSlots).length) pack["source_slots"] = sourceSlots;
  // label 是给人看的；没写就用 id（validatePack 要求 label，但最小脚本不该被"标签"挡住）。
  if (typeof pack["label"] !== "string" || !String(pack["label"]).trim()) pack["label"] = String(id);
  void str;
  return pack as unknown as AppPack;
}

/** IR → 声明式脚本源码。**只搬运，不发明**（迁移与 `apps:gen` 共用；打标记 = 数据）。 */
export function packToScriptSource(pack: AppPack): string {
  const raw = pack as unknown as Record<string, unknown>;
  const meta: Record<string, unknown> = {};
  // 顺序由表决定（canonical 名字）：表是唯一清单，加字段只改 `META_FIELD_MAP`。
  for (const f of META_FIELD_MAP) {
    const v = raw[f.pack];
    if (v === undefined) continue;
    meta[f.meta] = v;
  }
  const sourceSlots = (raw["source_slots"] ?? {}) as Record<string, Record<string, unknown>>;
  const data: Record<string, unknown> = {};
  for (const [k, b] of Object.entries(sourceSlots)) data[k] = { kind: "source", ...b };
  const journey = (raw["journey"] ?? []) as unknown[];
  return `// ${DECLARATIVE_MARKER} —— 本文件是**数据**（迁移/生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 \`npm run apps:migrate -- --app ${String(raw["id"] ?? "?")} --write\` 或 apps:gen 生成；改来源再重新生成，不要手改。
const META = ${JSON.stringify(meta, null, 2)};
const DATA = ${JSON.stringify(data, null, 2)};
const JOURNEY = ${JSON.stringify(journey, null, 2)};

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });
`;
}
