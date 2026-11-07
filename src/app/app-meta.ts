/**
 * 应用元数据（`app.mjs` 的 `meta`）——脚本化应用**唯一**的声明面。
 *
 * 以前应用有两条作者路径：`pack.json` / 固定形状的 `@amberflow:declarative-data` 数据脚本，
 * 以及 `flow(ctx)` 脚本。现在只保留后者：流程本身在脚本里，`meta` 只描述应用级事实
 * （主机、槽位、数据源、站点角色、策略、节奏、结束态不变量、血统）。
 *
 * 本模块做两件事，互不依赖：
 *   1. `lowerMeta(meta)`：把脚本的 `meta` 投影成运行器内部的 `AppPack` IR（不落盘）；
 *   2. `packToFlowSource(pack)`：把一份内部 IR 生成回 flow 脚本（只给录制/生成器用，
 *      生成物必须过 `apps check` 与回放门）。
 */
import type { AppPack, AppInvariant, PackPace, PackPolicy, PackSite } from "./app-pack.ts";

/** `meta` 的字段表：`meta` 面（camelCase）→ 内部 IR 面（snake_case）。 */
export interface MetaField {
  readonly meta: string;
  readonly pack: string;
}

export const META_FIELD_MAP: readonly MetaField[] = [
  { meta: "id", pack: "id" },
  { meta: "label", pack: "label" },
  { meta: "goal", pack: "goal" },
  { meta: "model", pack: "model" },
  { meta: "maxSubgoals", pack: "max_subgoals" },
  { meta: "hosts", pack: "hosts" },
  { meta: "slots", pack: "slots" },
  { meta: "requiredSlots", pack: "required_slots" },
  { meta: "secretSlots", pack: "secret_slots" },
  { meta: "sources", pack: "sources" },
  { meta: "device", pack: "device" },
  { meta: "site", pack: "site" },
  { meta: "notes", pack: "notes" },
  { meta: "policy", pack: "policy" },
  { meta: "pace", pack: "pace" },
  { meta: "invariants", pack: "invariants" },
  { meta: "recordedFrom", pack: "recorded_from" },
  { meta: "generatedFrom", pack: "generated_from" },
] as const;

const META_NAMES = new Set(META_FIELD_MAP.map((f) => f.meta));
const FIELD = Object.fromEntries(META_FIELD_MAP.map((f) => [f.pack, f])) as Record<string, MetaField>;

/** 脚本面的 `meta` 形状。 */
export interface ScriptMeta {
  id: string;
  label?: string;
  goal: string;
  model?: string;
  maxSubgoals?: number;
  hosts?: string[];
  slots?: Record<string, unknown>;
  requiredSlots?: string[];
  /** 敏感槽位（如 password/token）：产物自动掩码；值仍来自声明/观察。 */
  secretSlots?: string[];
  sources?: string[];
  device?: Record<string, unknown>;
  /** 站点面声明：页面角色（openPage）/ 命名行抽取（extract）。 */
  site?: PackSite;
  notes?: string[];
  /**
   * 运行策略（键的唯一出处 `app-pack.ts` 的 `POLICY_KEYS`；未知键在 `validateApp` 加载期拒绝）。
   * S1 状态层新增：`done_preheld: "warn"|"fail"|"allow"`（缺省 warn）与
   * `effect_readback: {fill?, set_range?}`（缺省都开）。
   */
  policy?: PackPolicy;
  pace?: PackPace;
  invariants?: AppInvariant[];
  recordedFrom?: Record<string, unknown>;
  generatedFrom?: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asList = (v: unknown, field: string): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`app script: meta.${field} must be a list`);
  return [...v];
};

/** 小编辑距离（近邻拼写建议用；meta 字段面很小，O(n·m) 足够）。 */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const upLeft = diag;
      diag = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        upLeft + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return prev[b.length];
}

/** “你是不是想写 X”：离已知字段足够近才建议，宁缺毋滥。 */
function didYouMean(key: string, known: string[]): string {
  let best = "";
  let bestD = Infinity;
  for (const k of known) {
    const d = editDistance(key.toLowerCase(), k.toLowerCase());
    if (d < bestD) { bestD = d; best = k; }
  }
  const limit = Math.max(2, Math.round(key.length / 3));
  return best !== "" && bestD <= limit ? ` (did you mean "${best}"?)` : "";
}

/**
 * `meta` → 内部 IR。**未知 meta 字段响亮拒绝**（`_` 开头视为注释）：
 * 拼错 `invaraints` 如果静默忽略，表现会是“不变量没生效”而不是“你拼错了”。
 * 一次报**全部**未知项并给近邻建议（01 轮 B9：只报首个、无建议，多拼错要修一轮才见一个）。
 */
export function lowerMeta(meta: ScriptMeta): AppPack {
  if (!isObj(meta)) throw new Error("app script: meta must be an object");
  const m = meta as unknown as Record<string, unknown>;
  const known = META_FIELD_MAP.map((f) => f.meta);
  const unknown = Object.keys(m).filter((k) => !META_NAMES.has(k) && !k.startsWith("_"));
  if (unknown.length) {
    const detail = unknown.map((k) => `meta.${k}${didYouMean(k, known)}`).join(", ");
    throw new Error(`app script: unknown field(s) ${detail} (known: `
      + `${known.join(", ")}; keys starting with "_" are ignored)`);
  }
  const id = m["id"];
  const goal = m["goal"];
  if (typeof id !== "string" || !id.trim()) throw new Error("app script: meta.id must be a non-empty string");
  if (typeof goal !== "string" || !goal.trim()) throw new Error("app script: meta.goal must be a non-empty string");

  if (m["slots"] !== undefined && !isObj(m["slots"])) {
    throw new Error("app script: meta.slots must be an object of slot -> value");
  }
  const pack: Record<string, unknown> = {
    spec_version: 1,
    id,
    goal,
    hosts: asList(m["hosts"], "hosts"),
    slots: isObj(m["slots"]) ? { ...m["slots"] } : {},
    required_slots: asList(m["requiredSlots"], "requiredSlots"),
    sources: asList(m["sources"], "sources"),
    // 流程在 flow(ctx) 里，IR 的 journey 只用于共用校验/报告，永远为空。
    journey: [],
    invariants: asList(m["invariants"], "invariants"),
  };
  const secretSlotsRaw = asList(m["secretSlots"], "secretSlots");
  if (!secretSlotsRaw.every((x): x is string => typeof x === "string" && x.trim() !== "")) {
    throw new Error("app script: meta.secretSlots must be a list of non-empty strings");
  }
  const secretSlots = secretSlotsRaw as string[];
  const declaredSlots = new Set<string>([
    ...Object.keys(isObj(m["slots"]) ? m["slots"] : {}),
    ...asList(m["requiredSlots"], "requiredSlots").map(String),
  ]);
  for (const k of secretSlots) {
    if (!declaredSlots.has(k)) {
      throw new Error(`app script: meta.secretSlots 含未声明槽位 ${JSON.stringify(k)}`
        + `（已声明：${[...declaredSlots].sort().join(", ") || "无"}）`);
    }
  }
  if (secretSlots.length > 0) pack["secret_slots"] = secretSlots;
  for (const f of META_FIELD_MAP) {
    if (["id", "goal", "hosts", "slots", "required_slots", "secret_slots", "sources", "invariants"].includes(f.pack)) continue;
    const v = m[f.meta];
    if (v === undefined) continue;
    pack[f.pack] = Array.isArray(v) ? [...v] : v;
  }
  if (typeof pack["label"] !== "string" || !String(pack["label"]).trim()) pack["label"] = String(id);
  return pack as unknown as AppPack;
}

/* ------------------------------------------- 值管道 codegen（U2b）

   一条纪律：**没有槽位占位符的流程，生成物与 U2b 之前逐字节一致**。所以下面的渲染器只在
   信号里真的出现已声明的 `{slot}` 时才启用；否则原样走 `JSON.stringify(..., null, 2)`。
   占位符换成运行期表达式 `ctx.slots["k"]`——flow 应用没有声明式展开，`meta.invariants`
   也不会做槽位替换，所以参数化只能落在生成的 JS 里（这是「动态 done」的唯一实现面）。 */

const SLOT_PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 信号/不变量里是否引用了**已声明**的槽位占位符（未声明的花括号是普通文本）。 */
function hasSlotPlaceholder(value: unknown, keys: ReadonlySet<string>): boolean {
  if (typeof value === "string") {
    for (const m of value.matchAll(SLOT_PLACEHOLDER)) if (keys.has(m[1]!)) return true;
    return false;
  }
  if (Array.isArray(value)) return value.some((v) => hasSlotPlaceholder(v, keys));
  if (isObj(value)) return Object.values(value).some((v) => hasSlotPlaceholder(v, keys));
  return false;
}

/** 一个字符串 → JS 表达式：已声明占位符变 `ctx.slots["k"]`，其余部分是 JSON 字符串字面量。 */
function renderStringExpr(text: string, keys: ReadonlySet<string>): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(SLOT_PLACEHOLDER)) {
    if (!keys.has(m[1]!)) continue;
    const at = m.index ?? 0;
    if (at > last) parts.push(JSON.stringify(text.slice(last, at)));
    parts.push(`ctx.slots[${JSON.stringify(m[1]!)}]`);
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(JSON.stringify(text.slice(last)));
  if (parts.length === 0) return JSON.stringify(text);
  return parts.length === 1 ? parts[0]! : parts.join(" + ");
}

function renderSignalJs(value: unknown, keys: ReadonlySet<string>, indent: string): string {
  if (typeof value === "string") return renderStringExpr(value, keys);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = indent + "  ";
    return "[\n" + value.map((v) => inner + renderSignalJs(v, keys, inner)).join(",\n") + "\n" + indent + "]";
  }
  if (isObj(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const inner = indent + "  ";
    return "{\n" + entries
      .map(([k, v]) => inner + JSON.stringify(k) + ": " + renderSignalJs(v, keys, inner))
      .join(",\n") + "\n" + indent + "}";
  }
  return JSON.stringify(value);
}

/** 信号 → flow 源码。无占位符时与旧 codegen 逐字节相同（回归锚点）。 */
function signalSource(signal: unknown, keys: ReadonlySet<string>): string {
  if (!hasSlotPlaceholder(signal, keys)) return JSON.stringify(signal, null, 2);
  return renderSignalJs(signal, keys, "");
}

/** 内部 IR → flow 脚本源码（只给录制/生成器用；生成后必须过 check + 回放门）。 */
export function packToFlowSource(pack: AppPack): string {
  const raw = pack as unknown as Record<string, unknown>;
  const meta: Record<string, unknown> = {};
  for (const f of META_FIELD_MAP) {
    const v = raw[f.pack];
    if (v !== undefined) meta[f.meta] = v;
  }
  if (meta["label"] === undefined) meta["label"] = raw["id"];
  const steps = Array.isArray(pack.journey) ? pack.journey : [];
  const rawSlots = isObj(raw["slots"]) ? raw["slots"] : {};
  const slotKeys = new Set<string>(Object.keys(rawSlots));
  for (const k of Array.isArray(raw["required_slots"]) ? (raw["required_slots"] as unknown[]).map(String) : []) slotKeys.add(k);
  const secretKeys = new Set<string>(
    Array.isArray(raw["secret_slots"]) ? (raw["secret_slots"] as unknown[]).map(String) : [],
  );
  for (const k of secretKeys) slotKeys.add(k);
  // 敏感槽位纪律（U2b）：值绝不落盘——不管上游 pack 带了什么，生成物里敏感槽位一律空串占位。
  if (secretKeys.size > 0) {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawSlots)) cleaned[k] = secretKeys.has(k) ? "" : v;
    for (const k of secretKeys) if (!(k in cleaned)) cleaned[k] = "";
    meta["slots"] = cleaned;
  }
  // notes 用副本：生成器可能追加"依赖演示值的不变量已省略"这类事实，不能改到 pack 本身。
  const rawNotes = Array.isArray(raw["notes"]) ? [...(raw["notes"] as unknown[])] : [];
  const notes = [...rawNotes];
  // flow 面的 `meta.invariants` **不做槽位替换**（ctx.done 直接拿声明值判定），所以依赖
  // 演示值的断言只能省略——留着就是一条永远不成立的假红；每步的 done 已按槽位值动态生成。
  const rawInvariants = Array.isArray(raw["invariants"]) ? raw["invariants"] : [];
  const dependsOnSlot = (inv: unknown): boolean => isObj(inv) && hasSlotPlaceholder(inv["signal"], slotKeys);
  const omittedInvariants = rawInvariants.filter(dependsOnSlot);
  if (omittedInvariants.length) {
    meta["invariants"] = rawInvariants.filter((inv) => !dependsOnSlot(inv));
    const ids = omittedInvariants.map((inv) => (isObj(inv) ? String(inv["id"] ?? "?") : "?")).join(", ");
    notes.push(`以下结束态不变量依赖演示值（槽位占位符）：flow 面的 meta.invariants 不做槽位替换，`
      + `**故意省略**，参数化判据由每步的动态 done 承担：${ids}`);
  }
  // 敏感槽位的运行期守卫：空串占位不是值。不给 --slot-file 时必须结构化 needs_value，
  // 而不是拿空串填进去（空串对 fill 合法，会静默做成一次"填了空"）。
  const boundSlotKeys = new Set<string>();
  for (const step of steps) {
    if (!isObj(step)) continue;
    const binding = step["value_binding"];
    if (isObj(binding) && binding["from"] === "slot" && typeof binding["key"] === "string") {
      boundSlotKeys.add(binding["key"]);
    }
  }
  const guardedSecrets = [...secretKeys].filter((k) => boundSlotKeys.has(k));
  if (notes.length !== rawNotes.length) meta["notes"] = notes;

  const lines: string[] = [];
  lines.push("/**");
  lines.push(` * ${String(pack.id)} — flow 应用（由录制/生成器产出）。`);
  lines.push(" *");
  lines.push(" * 流程在 flow(ctx) 里；引擎负责一步之内的元素选择、闸门、动作与完成信号。");
  lines.push(" * 回放门通过后才会写盘：改这里等于改流程版本，重新跑一次 check/run。");
  lines.push(" */");
  lines.push(`export const meta = () => (${JSON.stringify(meta, null, 2)});`);
  lines.push("");
  lines.push("export async function flow(ctx) {");
  for (const key of guardedSecrets) {
    lines.push(`  if (!ctx.slots[${JSON.stringify(key)}]) {`);
    lines.push(`    ctx.fail("needs_value", ${JSON.stringify(
      `secret slot "${key}" has no value — pass --slot-file <json> (or --slot ${key}=…)`,
    )});`);
    lines.push("  }");
  }
  if (steps.length === 0) {
    lines.push("  await ctx.done();");
    lines.push("}");
    lines.push("");
    return lines.join("\n");
  }
  steps.forEach((rawStep, i) => {
    if (!isObj(rawStep)) throw new Error(`flow codegen: journey[${i}] must be an object`);
    if (rawStep["source"] !== undefined || rawStep["adapter"] !== undefined) {
      throw new Error(`flow codegen: journey[${i}] is a tool/manual step; only browser steps can be generated`);
    }
    if (rawStep["commands"] !== undefined) {
      throw new Error(`flow codegen: journey[${i}] uses a command set; write that step by hand`);
    }
    const signal = rawStep["signal"];
    if (signal === undefined || signal === null || typeof signal !== "object") {
      throw new Error(`flow codegen: journey[${i}] needs a done signal`);
    }
    const desc = typeof rawStep["desc"] === "string" && rawStep["desc"]
      ? rawStep["desc"] : `第 ${i + 1} 步`;
    const opts: string[] = [];
    if (typeof rawStep["start_url"] === "string" && rawStep["start_url"]) {
      opts.push(`url: ${JSON.stringify(rawStep["start_url"])}`);
    }
    const hint = typeof rawStep["target_hint"] === "string" ? rawStep["target_hint"] : null;
    const hints = Array.isArray(rawStep["target_hints"])
      ? (rawStep["target_hints"] as unknown[]).filter((h): h is string => typeof h === "string" && h.length > 0)
      : [];
    // U2b 值绑定：fill 的简写 → 命令闭集的一项；值来自 `ctx.value.slot/literal`（绝不硬编码
    // 演示字面值——`--slot` 覆盖后 done 与动作必须一起走槽位值）。
    const binding = rawStep["value_binding"];
    if (binding !== undefined) {
      if (!isObj(binding)) throw new Error(`flow codegen: journey[${i}].value_binding must be an object`);
      if (hint === null || hint.length === 0) {
        throw new Error(`flow codegen: journey[${i}].value_binding needs target_hint (one control to fill)`);
      }
      if (!(binding["from"] === "slot" && typeof binding["key"] === "string" && binding["key"].trim() !== "")) {
        throw new Error(`flow codegen: journey[${i}].value_binding must be {from:"slot",key} `
          + `(literal 不是命令/计划面的值来源，见 F33；option/list/dataset 请手写 commands)`);
      }
      const valueExpr = `ctx.value.slot(${JSON.stringify(binding["key"])})`;
      opts.push(`act: [ctx.command("fill", ${JSON.stringify(hint)}, ${valueExpr})]`);
    } else if (hint !== null && hint.length > 0) {
      opts.push(`act: ctx.hint(${JSON.stringify(hint)})`);
    } else if (hints.length > 0) {
      opts.push(`act: ctx.hints(${hints.map((h) => JSON.stringify(h)).join(", ")})`);
    } else if (typeof rawStep["start_url"] === "string" && rawStep["start_url"]) {
      // 纯导航步：与声明式 journey 的“到达即完成”语义一致。
      lines.push(`  const r${i + 1} = await ctx.arrive(${JSON.stringify(rawStep["start_url"])}, { done: ${signalSource(signal, slotKeys)}, desc: ${JSON.stringify(desc)} });`);
      lines.push(`  if (!r${i + 1}.ok) ctx.fail(r${i + 1}.stopCode ?? "arrive_signal_not_held", r${i + 1}.reason);`);
      return;
    } else {
      throw new Error(`flow codegen: journey[${i}] needs target_hint/target_hints (or a start_url for a pure navigation step)`);
    }
    if (rawStep["when"] !== undefined) opts.push(`when: ${JSON.stringify(rawStep["when"], null, 2)}`);
    if (rawStep["slots"] !== undefined) opts.push(`slots: ${JSON.stringify(rawStep["slots"], null, 2)}`);
    opts.push(`done: ${signalSource(signal, slotKeys)}`);
    opts.push(`id: ${JSON.stringify(typeof rawStep["id"] === "string" && rawStep["id"] ? rawStep["id"] : `step-${i + 1}`)}`);
    if (typeof rawStep["timeoutMs"] === "number") opts.push(`timeoutMs: ${rawStep["timeoutMs"]}`);
    lines.push(`  const r${i + 1} = await ctx.step(${JSON.stringify(desc)}, {`);
    for (const opt of opts) lines.push(`    ${opt},`);
    lines.push("  });");
    lines.push(`  if (!r${i + 1}.ok) ctx.fail(r${i + 1}.stopCode ?? "step_failed", r${i + 1}.reason);`);
  });
  lines.push("  await ctx.done();");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}
