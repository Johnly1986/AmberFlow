/**
 * **`spec → pack` 生成器**：把"人抄一遍"换成"展开一次"。
 *
 * 背景（见 [bench/AUTHORING_ASSESSMENT.md](../bench/AUTHORING_ASSESSMENT.md)）：15 个有旅程的应用里
 * 61% 的声明行（1797 行）是"某个已存在数据展开一下就能得到"的机械内容；其中 7 个应用（6 个 transfer
 * 复刻站 + `ctrip-case`）的展开结果与 `transfer/specs/*.json` 经 `emitPlan()` 展开的计划**逐字段 0 diff**
 * ——也就是说，那 1197 行是由人逐字段抄写的，而抄写正确与否只能靠另一轮逐字段复核来确认。
 *
 * 这个工具把那段流程换成一个**构造性质**：包里的旅程 = spec 的展开结果，且包里记着展开内容的
 * `plan_sha256`。任何一侧漂移（改了包、改了 spec）都会被 `--check` 抓住。
 *
 *   一条命令生成/刷新：      npm run apps:gen -- --write --id transfer-trekly --spec trekly
 *   全部已挂上的应用刷新：    npm run apps:gen -- --write
 *   检查（CI/门禁口径）：     npm run apps:gen -- --check
 *   有哪些可生成的 spec：     npm run apps:gen -- --list
 *
 * **人写的部分被显式保留**（生成器不发明判断）：
 *   `invariants`（什么必须成立）、`notes`（说明）、`label`、`model`、`hosts`、`sources`、
 *   `required_slots`、`device`、`probe`、`max_subgoals`。
 * 这些是"不可约残差"——生成器只搬运，不生成；缺 `invariants` 时会**明着提示**（而不是悄悄给一个空壳）。
 */
import crypto from "node:crypto";
import { isParseUsageError, usageErrorLine } from "../src/support/cli-args.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { appDirs, expandPack, loadPack, validatePack, type AppPack } from "../src/app/app-pack.ts";
import { FROZEN_TODAY } from "./frozen-today.ts";
import { pathToFileURL } from "node:url";
import { discoverSpecs, emitPlan } from "../src/sites/transfer-task.ts";

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const REPO = path.resolve(import.meta.dirname, "..");

/**
 * **冻结展开日期**。spec 的 `per_date` 阶段是按"下周"展开的，所以 `emitPlan` 的结果**依赖当天日期**：
 * 2026-10-04 生成的一周是 10-05..09，跨到 10-05 再 `--check` 就会算出 10-12..16 —— 门禁每个周一自己变红。
 * 包是冻结语料，所以展开必须钉在同一天（与 `tests/app-packs-authored.test.ts` 的 `emitted()` 同一口径；
 * ctrip 对拍也是这么钉的：语料哪天生成的就用哪天）。要故意换一周就 `--today 2026-10-02`。
 */
export { FROZEN_TODAY } from "./frozen-today.ts";

/** 只有显式的 `--today` 能移动那一周；环境里的 `LAYA_TODAY` 一律不算（否则别的测试设一下就能改变门禁结论）。 */
let EXPANSION_TODAY: string | null = null;
export function setExpansionToday(today: string | null): void { EXPANSION_TODAY = today; }

/** 在**钉住的**日期下跑展开：环境变量被忽略，恢复到调用前的值。 */
export function withFrozenToday<T>(fn: () => T): T {
  const prev = process.env.LAYA_TODAY;
  process.env.LAYA_TODAY = EXPANSION_TODAY ?? FROZEN_TODAY;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.LAYA_TODAY; else process.env.LAYA_TODAY = prev;
  }
}

/** 计划的最小形状（`TaskPlan` 实例与 `emitPlan` 写出的 JSON 都满足它）。 */
export interface PlanLike {
  goal?: string;
  slots?: Record<string, unknown>;
  subgoals: Array<Record<string, unknown>>;
}

/** 流程的来源：一个 spec 文件，或一个导出"应用级计划"的模块函数。 */
export type FlowRef = { spec: string } | { source: string };

export interface Flow {
  plan: PlanLike;
  label: string;
  /** spec 的步骤定义（角色名重建用）；builder 输入没有这个，纯按计划展开。 */
  specSteps?: Array<{ role?: string; desc?: string }>;
}

/**
 * 应用里的每一步都来自**某个上游构件**。两种上游：
 *   - `spec`：`transfer/specs/<key>.json`（经 `emitPlan` 展开）；
 *   - `source`：`<模块>#<导出名>`，导出函数返回一份应用级计划（例如
 *     `src/cli/ip-config.ts#buildAppPlan`：整张 IP 规划表 → 一条旅程，并且把"保存要认回显的值"
 *     "规划表写错的行预期被设备页拒绝"这两条判断写在**代码**里，而不是手抄进 JSON）。
 * 判断写在代码里而不是数据里，是因为它本来就是"这个应用验收什么"的语义；写进代码后
 * 驱动与生成器共用同一份，谁也漂移不了。
 */
export async function flowFor(ref: FlowRef): Promise<Flow> {
  if ("spec" in ref) {
    const key = ref.spec.replace(/^transfer\/specs\//, "").replace(/\.json$/, "");
    const specs = discoverSpecs();
    if (!specs[key]) throw new Error(`spec ${JSON.stringify(ref.spec)} 不存在（可用：${Object.keys(specs).join(", ")}）`);
    return {
      plan: expandSpec(key, specs[key]).plan,
      label: specPathOf(key),
      specSteps: ((specs[key] as { phases?: Array<{ steps?: Array<{ role?: string; desc?: string }> }> }).phases ?? [])
        .flatMap((ph) => ph.steps ?? []),
    };
  }
  const [file, fn] = ref.source.split("#");
  if (!file || !fn) throw new Error(`generated_from.source 形如 "<模块>#<导出名>"，收到 ${JSON.stringify(ref.source)}`);
  // 原生绝对路径直接 import 会被 ESM 当成 URL（Windows 上 "E:\…" ⇒ protocol 'e:'）。
  const mod = (await import(pathToFileURL(path.join(REPO, file)).href)) as Record<string, unknown>;
  const build = mod[fn];
  if (typeof build !== "function") throw new Error(`${file} 没有导出函数 ${fn}`);
  const out = (build as () => unknown)() as PlanLike;
  if (!out || !Array.isArray(out.subgoals)) throw new Error(`${file}#${fn} 必须返回 {goal, slots, subgoals}`);
  return { plan: out, label: ref.source };
}

/** 从 `generated_from` 读出来源（两种写法都支持）。 */
export function refOf(pack: AppPack): FlowRef | null {
  const g = (pack as { generated_from?: { spec?: string; source?: string } }).generated_from;
  if (!g) return null;
  if (typeof g.spec === "string") return { spec: g.spec };
  if (typeof g.source === "string") return { source: g.source };
  return null;
}

export function refLabel(ref: FlowRef): string {
  return "spec" in ref ? ref.spec : ref.source;
}

/** 人写的键：生成器原样保留（缺失时保持缺失）。 */
export const HUMAN_KEYS = [
  "label", "model", "max_subgoals", "hosts", "required_slots", "sources",
  "invariants", "notes", "device", "probe",
] as const;

/** `file:///repo/x` → `x`（包里用仓库相对路径，运行器再解析回 file://）。
 * `fileURLToPath` 是唯一的平台正确换算：Windows 的 file URL 路径是 "/E:/…"，
 * 与 REPO（"E:\…"）直接字符串比较永远不相等——包因此留下机器绝对路径，
 * 别的机器一跑 --check 就是"19 处 start_url 漂移"（Windows 实测）。 */
export function relativize(url: unknown): unknown {
  if (typeof url !== "string") return url;
  const m = /^file:\/\/(.*)$/.exec(url);
  if (!m) return url;
  // 纯字符串口径（不解析、不解码）：冻结包里的 `page.html?from=KMG&…` 与
  // percent-编码的查询值都是**原样**存进包的，任何 URL 往返都可能改写它们。
  // Windows 的唯一差别：URL 路径以 "/E:/…" 出现，先去掉盘符前的那个斜杠。
  const abs = /^\/[A-Za-z]:(\/|\\)/.test(m[1]!) ? m[1]!.slice(1) : m[1]!;
  const repo = REPO.split(path.sep).join("/");
  return abs.startsWith(repo + "/") ? abs.slice(repo.length + 1) : abs;
}

/** 展开内容的稳定指纹：只包含"计划语义"，不含运行期字段（status/obstacle/saved_at）。 */
export function planSha(plan: { goal?: unknown; slots?: unknown; subgoals: Array<Record<string, unknown>> }): string {
  const semantic = {
    goal: plan.goal ?? null,
    slots: plan.slots ?? {},
    subgoals: plan.subgoals.map((s) => ({
      desc: s["desc"] ?? null,
      start_url: relativize(s["start_url"]) ?? null,
      signal: s["signal"] ?? null,
      target_hint: s["target_hint"] ?? null,
      target_hints: s["target_hints"] ?? null,
      when: s["when"] ?? null,
      retries: s["retries"] ?? null,
      slots: s["slots"] ?? null,
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}

/** 展开一个 spec 到内存（写到临时目录，读完即弃）。 */
export function expandSpec(specKey: string, spec: unknown): {
  plan: { goal?: string; slots?: Record<string, unknown>; subgoals: Array<Record<string, unknown>> };
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spec-to-pack-${specKey}-`));
  try {
    // 展开依赖当天日期（见 FROZEN_TODAY）——生成器与 `--check` 都走这里，所以两边永远同一周。
    const planPath = withFrozenToday(() => emitPlan(specKey, spec as never, dir));
    return { plan: JSON.parse(fs.readFileSync(planPath, "utf-8")) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 把 spec 的 desc 模板（`{date}` 之类）变成匹配正则；`{...}` → 任意非空片段。 */
function templateRe(tpl: string): RegExp {
  const parts = tpl.split(/\{[^}]+\}/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("^" + parts.join("(.+?)") + "$");
}

/**
 * 展开后的这一步，对应 spec 里的哪个角色？
 *
 * 展开把模板里的 `{date}` 之类的值填进去了，角色名（spec 的 `step.role`）就丢了。这里用
 * **desc 模板反查**把它找回来：手写包里的角色名正好是 spec 的 role（`filter-window` /
 * `search-form` / `dismiss-promo` …），找回来生成物才和手写物长得一样、也才好读。
 * 匹配不到就返回 null（那一步用内联写法，`--check` 仍然证明展开正确）。
 */
export function roleOf(desc: string, specSteps: Array<{ role?: string; desc?: string }>): string | null {
  const hits = specSteps.filter((s) => typeof s.desc === "string" && typeof s.role === "string"
    && templateRe(s.desc).test(desc));
  if (!hits.length) return null;
  // 多个模板都能匹配时取"最具体"的那个（通配符最少 = 占位符最少），并列取先出现的。
  const wild = (t: string): number => (t.match(/\{[^}]+\}/g) ?? []).length;
  hits.sort((a, b) => wild(a.desc!) - wild(b.desc!));
  return hits[0]!.role!;
}

/** 步的"形状"：不随日期变化的那部分。形状相同且角色相同的连续步 → 一个角色模板 + 差异覆盖。 */
function shapeOf(step: Record<string, unknown>): string {
  const { desc: _d, start_url: _u, ...rest } = step;
  return JSON.stringify(rest);
}

/**
 * 角色化：**角色 = 该形状的第一个实例（完整），后续实例只写差异字段**。
 * 这正是仓库里手写包的约定（`filter-window` 装 10-05 那一步，10-06…10-09 只覆盖 desc/start_url），
 * 现在由这里机械地重建——所以生成物既好读，又让"删掉 retries/when 看它是否变红"这类对抗测试继续有效。
 */
export function rolesAndJourney(
  steps: Array<Record<string, unknown>>, specSteps: Array<{ role?: string; desc?: string }>,
): { roles: Record<string, Record<string, unknown>>; journey: Array<Record<string, unknown>> } {
  const roles: Record<string, Record<string, unknown>> = {};
  const journey: Array<Record<string, unknown>> = [];
  // 按 **(角色名, 形状)** 归并：角色名来自 spec（`filter_window` → `filter-window`），
  // 形状相同才复用模板。这正好是手写包的约定——同一个角色在日期维度上重复出现时，
  // 只保留第一个实例做模板，其余只写差异字段；形状不同的同名步（例如机票排序 vs 酒店排序）
  // 老实内联，不硬塞进同一个模板。
  const template = new Map<string, Record<string, unknown>>();
  for (const step of steps) {
    const raw = roleOf(String(step["desc"] ?? ""), specSteps);
    const name = raw ? raw.replace(/_/g, "-") : null;
    const shape = shapeOf(step);
    if (!name) { journey.push({ ...step }); continue; }
    const key = `${name}|${shape}`;
    const base = template.get(key);
    if (base === undefined) {
      template.set(key, step);
      roles[name] = { ...step };
      journey.push({ role: name });
      continue;
    }
    const override: Record<string, unknown> = { role: name };
    for (const [k, v] of Object.entries(step)) {
      if (JSON.stringify(v) !== JSON.stringify(base[k])) override[k] = v;
    }
    journey.push(override);
  }
  return { roles, journey };
}

/**
 * **沿用已有包的结构**：哪些步用角色、每个实例覆盖哪几个字段。
 *
 * 为什么不让生成器自己发明结构：角色名是人的命名（`sort-fares` vs spec 的 `sort_price`），
 * 而且仓库里的对抗测试正是按着这些名字与"几个角色覆盖多少步"写的。生成器的价值在于
 * **值**由展开结果决定（不再手抄、不再漂移），而不是重新发明结构。所以：
 * 有种子包 → 沿用它的结构（角色名、哪些键是"逐实例覆盖"）；没有 → 退回按 spec 的角色名归并。
 * 结构里出现的**值**一律取自 spec 展开结果 — 这是"对齐由构造保证"。
 */
export interface StepStructure { role?: string; keys?: string[] }

export function structureFromSeed(seed: AppPack | null | undefined, steps: number): StepStructure[] | null {
  const journey = (seed?.journey ?? []) as Array<Record<string, unknown>>;
  if (!seed || journey.length !== steps) return null;
  const roles = (seed.roles ?? {}) as Record<string, unknown>;
  const out: StepStructure[] = [];
  for (const entry of journey) {
    const role = typeof entry["role"] === "string" ? String(entry["role"]) : null;
    if (!role || !(role in roles)) { out.push({}); continue; }
    out.push({ role, keys: Object.keys(entry).filter((k) => k !== "role") });
  }
  return out;
}

/** 每一步的 journey 条目：逐字段来自展开结果（这就是"对齐由构造保证"）。 */
export function journeyFrom(plan: { subgoals: Array<Record<string, unknown>> }): Array<Record<string, unknown>> {
  return plan.subgoals.map((s) => {
    const out: Record<string, unknown> = { desc: s["desc"] };
    if (s["start_url"] !== undefined) out["start_url"] = relativize(s["start_url"]);
    if (s["signal"] !== undefined) out["signal"] = s["signal"];
    for (const k of ["target_hint", "target_hints", "when", "retries", "slots"]) {
      if (s[k] !== undefined && s[k] !== null) out[k] = s[k];
    }
    return out;
  });
}

export interface Generated { pack: AppPack; planSha: string; steps: number; specPath: string }

/**
 * 生成一个应用包。`keep` 是**现有包**（如果有）：人写的键从它继承，其余全部来自 spec 展开。
 */
/** `trekly` / `transfer/specs/trekly.json` 两种写法都接受，统一存成后者（可发现的相对路径）。 */
export function specPathOf(specOrKey: string): string {
  return specOrKey.includes("/") ? specOrKey : `transfer/specs/${specOrKey}.json`;
}

/** 按既有结构组装：角色模板 = 该角色**第一次出现**时展开出来的完整一步；其余实例只写结构声明的覆盖键。 */
export function applyStructure(
  steps: Array<Record<string, unknown>>, structure: StepStructure[],
): { roles: Record<string, Record<string, unknown>>; journey: Array<Record<string, unknown>> } {
  const roles: Record<string, Record<string, unknown>> = {};
  const journey: Array<Record<string, unknown>> = [];
  steps.forEach((step, i) => {
    const st = structure[i]!;
    if (!st.role) { journey.push({ ...step }); return; }
    if (roles[st.role] === undefined) {
      roles[st.role] = { ...step };
      journey.push({ role: st.role });
      return;
    }
    const override: Record<string, unknown> = { role: st.role };
    for (const k of st.keys ?? []) if (step[k] !== undefined) override[k] = step[k];
    journey.push(override);
  });
  return { roles, journey };
}

/** spec 输入的便捷包装（既有调用点与测试都用它）。 */
export function generatePack(
  id: string, specKey: string, spec: unknown, specPath: string, keep?: AppPack | null,
): Generated {
  const { plan } = expandSpec(specKey, spec as never);
  const specSteps = ((spec as { phases?: Array<{ steps?: Array<{ role?: string; desc?: string }> }> }).phases ?? [])
    .flatMap((ph) => ph.steps ?? []);
  return generateFromFlow(id, { plan, label: specPath, specSteps }, keep);
}

export function generateFromFlow(id: string, flow: Flow, keep?: AppPack | null): Generated {
  const plan = flow.plan;
  const specPath = flow.label;
  const steps = plan.subgoals.length;
  const specSteps = flow.specSteps ?? [];
  const full = journeyFrom(plan);
  const seedStructure = structureFromSeed(keep, full.length);
  const { roles, journey } = seedStructure
    ? applyStructure(full, seedStructure)
    : rolesAndJourney(full, specSteps);
  const pack: Record<string, unknown> = {
    spec_version: 1,
    id,
    label: keep?.label ?? `${flow.label} 生成的应用`,
    goal: plan.goal ?? keep?.goal ?? flow.label,
    model: keep?.model ?? "english",
    max_subgoals: keep?.max_subgoals ?? steps,
    hosts: keep?.hosts ?? [],
    slots: plan.slots ?? {},
    required_slots: keep?.required_slots ?? [],
    sources: keep?.sources ?? [],
    ...(Object.keys(roles).length ? { roles } : {}),
    journey,
    invariants: keep?.invariants ?? [],
    notes: [
      `本文件由 \`npm run apps:gen\` 从 \`${flow.label}\` 生成：旅程逐字段等于该来源的展开结果，`,
      "改流程请改 spec 再重新生成，不要手改 journey（手改会被 `npm run apps:gen -- --check` 抓到）。",
      "**人写的只有这里的 invariants 与 notes**（结束状态要成立什么、以及为什么这样定）——生成器不发明判断。",
      ...(keep?.notes ?? []),
    ],
    generated_from: flow.label.includes("#")
      ? { source: flow.label, plan_sha256: planSha(plan) }
      : { spec: flow.label, plan_sha256: planSha(plan) },
  };
  const keepBag = (keep ?? {}) as unknown as Record<string, unknown>;
  for (const k of ["device", "probe"] as const) if (keepBag[k] !== undefined) pack[k] = keepBag[k];
  return { pack: pack as unknown as AppPack, planSha: planSha(plan), steps, specPath: flow.label };
}

/** 稳定序列化：键按 PACK 的书写顺序，2 空格缩进（生成物要可读、可比对、diff 干净）。 */
export function serializePack(pack: AppPack): string {
  const out: Record<string, unknown> = {};
  for (const k of ["spec_version", "id", "label", "goal", "model", "max_subgoals", "hosts", "slots",
    "required_slots", "sources", "device", "roles", "journey", "invariants", "notes",
    "generated_from", "recorded_from", "probe"]) {
    const bag = pack as unknown as Record<string, unknown>;
    if (bag[k] !== undefined) out[k] = bag[k];
  }
  return JSON.stringify(out, null, 2) + "\n";
}

/** 找到所有"已挂上生成器"的应用（发现，而不是维护一张名单）。 */
export function generatedApps(): Array<{ id: string; dir: string; ref: FlowRef; pack: AppPack }> {
  const out: Array<{ id: string; dir: string; ref: FlowRef; pack: AppPack }> = [];
  for (const dir of appDirs()) {
    const pack = loadPack(path.join(dir, "pack.json"));
    const ref = refOf(pack);
    if (ref) out.push({ id: pack.id, dir, ref, pack });
  }
  return out;
}

/**
 * 生成器**表达不了**的键：`--write` 会静默丢掉它们，所以 `--check` 必须点名。
 *
 * 起因（独立复核 D1）：`next` / `id` / `max_step_visits`（P4）、`commands`（P2）、`device`
 * 这些是**应用配置的表达面**，spec 一侧没有对应物；手改一个生成包加了边，`--check` 却照旧
 * 全绿、`--write` 一抹就没了——那正是"静默假绿"。做法是数据驱动的（比较种子包与刚生成的包
 * 的键集合），不维护第二张键清单：清单会漂，比较不会。
 */
export function inexpressibleKeys(seed: AppPack, freshPack: Record<string, unknown>): string[] {
  const out: string[] = [];
  const skipTop = new Set(["generated_from", "_path", "probe"]);
  const freshTop = new Set(Object.keys(freshPack));
  for (const k of Object.keys(seed as unknown as Record<string, unknown>)) {
    if (!freshTop.has(k) && !skipTop.has(k)) out.push(k);
  }
  const freshStepKeys = new Set<string>();
  const collect = (steps: Array<Record<string, unknown>> | undefined): void => {
    for (const s of steps ?? []) for (const k of Object.keys(s)) if (k !== "role") freshStepKeys.add(k);
  };
  collect(freshPack["journey"] as Array<Record<string, unknown>> | undefined);
  const freshRoles = (freshPack["roles"] ?? {}) as Record<string, Record<string, unknown>>;
  for (const r of Object.values(freshRoles)) collect([r]);
  seed.journey.forEach((entry, i) => {
    if (!isDict(entry)) return;
    const rn = entry["role"];
    const tpl = rn !== undefined && isDict(seed.roles?.[String(rn)]) ? seed.roles[String(rn)]! : {};
    for (const k of Object.keys({ ...tpl, ...entry })) {
      if (k === "role" || freshStepKeys.has(k)) continue;
      out.push(`journey[${i}].${k}`);
    }
  });
  return [...new Set(out)];
}

/** `--check`：包与 spec 两侧都不许漂移。返回每条应用的问题清单（空 = 通过）。 */
export function checkAgainstFlow(entry: { id: string; pack: AppPack }, flow: Flow): string[] {
  const problems: string[] = [];
  const fresh = generateFromFlow(entry.id, flow, entry.pack);
  // "比 JSON"是不够的：一个引用了不存在角色的 journey 也可以逐字节等于另一个坏 journey。
  // 所以这里**真加载 + 真展开**，再把展开后的计划逐字段与 emitPlan 的结果比。
  problems.push(...validatePack(entry.pack));
  const dropped = inexpressibleKeys(entry.pack, fresh.pack as unknown as Record<string, unknown>);
  if (dropped.length) {
    problems.push(`这些键生成器表达不了，\`--write\` 会把它们丢掉：${dropped.join(", ")}`
      + "——要么把判断移回 spec，要么不要让这个包由生成器托管");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spec-to-pack-check-${entry.id}-`));
  try {
    const mine = expandPack(entry.pack, {}, path.join(dir, "mine.json")).plan;
    const theirs = expandPack(fresh.pack, {}, path.join(dir, "fresh.json")).plan;
    const fields = ["desc", "start_url", "signal", "when", "retries", "slots", "target_hint", "target_hints"];
    if (mine.subgoals.length !== theirs.subgoals.length) {
      problems.push(`步数不一致：包展开 ${mine.subgoals.length}，spec 展开 ${theirs.subgoals.length}`);
    }
    const n = Math.min(mine.subgoals.length, theirs.subgoals.length);
    const bad: string[] = [];
    for (let i = 0; i < n; i++) {
      for (const f of fields) {
        const a = JSON.stringify((mine.subgoals[i] as Record<string, unknown>)[f] ?? null);
        const b = JSON.stringify((theirs.subgoals[i] as Record<string, unknown>)[f] ?? null);
        if (a !== b) bad.push(`#${i}.${f}`);
      }
    }
    if (bad.length) {
      problems.push(`与 spec 展开不一致（${bad.length} 处：${bad.slice(0, 5).join(", ")}…）`
        + "——改 spec 后请跑 --write；手改 journey 也会在这里被抓到");
    }
    if (JSON.stringify(mine.slots ?? {}) !== JSON.stringify(theirs.slots ?? {})) {
      problems.push("slots 与 spec 展开不一致");
    }
  } catch (e) {
    problems.push(`展开失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const declared = (entry.pack as { generated_from?: { plan_sha256?: string } }).generated_from?.plan_sha256;
  if (declared !== fresh.planSha) {
    problems.push(`plan_sha256 不匹配：包内声明 ${declared ?? "(缺失)"}，按 spec 重算 ${fresh.planSha}`);
  }
  if ((entry.pack.invariants ?? []).length === 0) {
    problems.push("invariants 为空：生成器只搬判断，不发明判断——请补上结束状态要成立什么（或让它空着并接受它不验证任何事）");
  }
  return problems;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let values;
  // 打错的参数 → 一行点名，绝不甩 parseArgs 的堆栈（src/support/cli-args.ts 的体例）。
  try {
    ({ values } = parseArgs({
    args: argv,
    options: {
      write: { type: "boolean" }, check: { type: "boolean" }, list: { type: "boolean" },
      id: { type: "string" }, spec: { type: "string" }, source: { type: "string" },
      today: { type: "string" },
      quiet: { type: "boolean" }, help: { type: "boolean" },
    },
  }));
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    console.error(usageErrorLine(err));
    return 2;
  }
  if (values.help || (!values.write && !values.check && !values.list)) {
    console.log(`usage: apps-gen [--list] [--check] [--write [--id ID --spec KEY]] [--quiet]

  --list            有哪些 spec 可生成、哪些应用已挂上生成器
  --check           检查所有已挂上的应用：旅程 == emitPlan(spec) 的展开，且 plan_sha256 匹配
  --write           重新生成（默认所有已挂上的应用；给 --id/--spec 或 --id/--source 可给新应用挂上）
  --source MOD#FN   流程来自一个导出"应用级计划"的函数（例如 src/cli/ip-config.ts#buildAppPlan）
  --today YYYY-MM-DD 展开用的"今天"（默认钉住 FROZEN_TODAY=${FROZEN_TODAY}，否则包会随星期漂移）
  --quiet           只输出结论行

退出码：0=一致 ｜ 1=有漂移 ｜ 2=用法错误（如 --id 没有对应的 spec）`);
    return values.help ? 0 : 2;
  }
  const specs = discoverSpecs();
  setExpansionToday(values.today ?? null);   // `--today` 是**唯一**能移动冻结那一周的开关

  if (values.list) {
    console.log("可生成的 spec：");
    for (const k of Object.keys(specs).sort()) console.log(`  ${k.padEnd(12)} transfer/specs/${k}.json`);
    const apps = generatedApps();
    console.log("\n已挂上生成器的应用：");
    if (!apps.length) console.log("  （还没有：用 --write --id <app> --spec <key> 或 --source <模块#导出名> 挂上第一个）");
    for (const a of apps.sort((x, y) => x.id.localeCompare(y.id))) {
      console.log(`  ${a.id.padEnd(22)} ${refLabel(a.ref)}`);
    }
    return 0;
  }

  if (values.write) {
    const targets: Array<{ id: string; ref: FlowRef; keep: AppPack | null }> = [];
    if (values.id || values.spec || values.source) {
      if (!values.id || (!values.spec && !values.source)) {
        console.error("--write 给新应用挂上时必须给 --id 且给 --spec 或 --source 之一"); return 2;
      }
      if (values.spec && values.source) { console.error("--spec 与 --source 只能给一个"); return 2; }
      if (values.spec && !specs[values.spec]) {
        console.error(`spec ${JSON.stringify(values.spec)} 不存在（可用：${Object.keys(specs).join(", ")}）`);
        return 2;
      }
      const dir = path.join(REPO, "apps", values.id);
      const existing = fs.existsSync(path.join(dir, "pack.json")) ? loadPack(path.join(dir, "pack.json")) : null;
      targets.push({ id: values.id, ref: values.source ? { source: values.source } : { spec: specPathOf(values.spec!) }, keep: existing });
    } else {
      for (const a of generatedApps()) targets.push({ id: a.id, ref: a.ref, keep: a.pack });
      if (!targets.length) { console.error("没有任何应用声明了 generated_from（用 --id/--spec 挂上第一个）"); return 2; }
    }
    for (const t of targets) {
      const flow = await flowFor(t.ref);
      const gen = generateFromFlow(t.id, flow, t.keep);
      // 响亮拒绝，不静默丢键：一个手改过的生成包如果带了 spec 表达不了的东西（`next` 边、
      // `commands`、`max_step_visits`…），写回就等于把它们删掉而不说一句话。
      if (t.keep) {
        const dropped = inexpressibleKeys(t.keep, gen.pack as unknown as Record<string, unknown>);
        if (dropped.length) {
          console.error(`拒绝写回 apps/${t.id}/pack.json：这些键生成器表达不了，写回等于删掉它们——`
            + `${dropped.join(", ")}。要么把判断移回 ${flow.label}，要么把这个包从生成器里摘出来`
            + `（去掉 generated_from）。什么都没写。`);
          return 1;
        }
      }
      const dir = path.join(REPO, "apps", t.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "pack.json"), serializePack(gen.pack));
      if (!values.quiet) {
        console.log(`已生成 apps/${t.id}/pack.json  ← ${flow.label}（${gen.steps} 步，plan_sha256 ${gen.planSha.slice(0, 12)}…）`);
        if ((gen.pack.invariants ?? []).length === 0) {
          console.log(`  ⚠ ${t.id} 的 invariants 为空：生成器不会替你发明"什么必须成立"——它只验证动作腿跑完。`);
        }
      }
    }
    return 0;
  }

  // --check
  const apps = generatedApps();
  if (!apps.length) { console.error("没有任何应用声明了 generated_from；先跑 --write --id <app> --spec <key>"); return 2; }
  let bad = 0;
  for (const a of apps.sort((x, y) => x.id.localeCompare(y.id))) {
    let problems: string[];
    try {
      problems = checkAgainstFlow(a, await flowFor(a.ref));
    } catch (e) {
      problems = [e instanceof Error ? e.message : String(e)];
    }
    if (problems.length) {
      bad++;
      console.error(`✗ ${a.id}`);
      for (const p of problems) console.error(`    - ${p}`);
    } else if (!values.quiet) {
      const sha = (a.pack as unknown as { generated_from: { plan_sha256: string } }).generated_from.plan_sha256;
      console.log(`✓ ${a.id.padEnd(22)} ${refLabel(a.ref)}  plan_sha256 ${sha.slice(0, 12)}…`);
    }
  }
  console.log(`apps:gen：${apps.length - bad}/${apps.length} 与 spec 展开一致`
    + (bad ? `  ← ${bad} 个漂移了（改 spec 后跑 --write；手改 journey 也会被抓到）` : ""));
  return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(await main());
}
