/**
 * SemanticFlow 运行器 —— 一份语义模板（`apps/<id>/flow.json`，spec_version 2）
 * 跑通"三级解析 + 回填环"，并在站点之间迁移。方案：docs/SEMANTIC_FLOW_TRANSFER_PLAN.md。
 *
 *   数据面   模板的 slots（值只来自计划；--slot 覆盖）
 *        ↓
 *   编译     步骤的页面角色（`page: "search"`）+ 查询模板 → 各站的绝对 URL；
 *            信号建在**页面角色契约**上（`{"page":"search"}` → `url_contains 该站文件名`），
 *            站点档案可用 `frozen_signals` 整体覆盖某步的信号（DOM 级先验）
 *        ↓
 *   旅程     浏览器步 → `runSubgoalWithRetries`（唯一的生产执行器，执行循环零改动）：
 *              ① 站点档案有已学 hint → 规则命中（零模型）
 *              ② 没有 → desc 进元素池，Laya 现场选
 *              ③ 不过闸 → escalateFn（LLM 老师）点名；提名让 DOM 信号成立 → 回填档案
 *            list_step → 运行器的数据腿（extract → select: min/max → act_on）：
 *              "判断最低价"是**数据规则**，模型不产出"选哪行"的判断
 *        ↓
 *   验收     模板不变量在旅程结束状态上断言（同会话、同一 cookie/页面）
 *
 * 红线（继承不谈判，docs/SEMANTIC_FLOW_TRANSFER_PLAN.md §7）：
 *   1. DOM/URL 信号唯一完成真值——Laya/老师谁提名都不算数；
 *   2. 学习产物必须经"可复现重放"才可信：回填条目 `replays_ok: 0` 起步，
 *      后续运行真的靠它以规则命中并完成才 +1；
 *   3. `dangerous: true` 的步（购买）默认**拒绝**，只有 `--allow-dangerous` 或注入的
 *      `confirmDangerous` 点头才执行——拒绝是显式结果，不是静默跳过；
 *   4. 值只来自数据袋——desc/URL/信号里的 `{slot}` 只替换已声明的槽位。
 *
 *   node --experimental-strip-types src/semantic-flow.ts --list
 *   node --experimental-strip-types src/semantic-flow.ts --app flight-cheapest --site site-a \
 *        --laya scripted --allow-dangerous
 *   node --experimental-strip-types src/semantic-flow.ts --app flight-cheapest --site site-b --dry
 */
import fs from "node:fs";
import { isParseUsageError, usageErrorLine } from "./cli-args.ts";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { MockAuditor } from "./audit.ts";
import { APPS_DIR } from "./app-pack.ts";
import { userAppsDir } from "./amberflow-home.ts";
import {
  BrowserMiddleware, browserSession, type BrowserSession, type EscalatorLike,
} from "./executor.ts";
import { REPO } from "./flow.ts";
import { checkArtifacts } from "./model-artifacts.ts";
import { extractSlots, urlOf, type ElemFamily } from "./extraction.ts";
import { captureStepStateView, type StepStateView } from "./page-context.ts";
import { contextualProviderNominationAsk } from "./nominate.ts";
import type { DecisionProvider } from "./decision-provider.ts";
import { resolveProviderSpec } from "./decision-provider.ts";
import { resolveBinding, validateBinding } from "./bindings.ts";
import {
  installLayaRuntime, scriptedAgent, scriptedRuntime,
  type DecisionAgent, type Question,
} from "./model.ts";
import { llmEscalator, runSubgoalWithRetries } from "./planner.ts";
import { PlanningRules, TaskPlan, createPathWalk, DEFAULT_MAX_STEP_VISITS, type Subgoal } from "./plan.ts";
import {
  LearnedStore, SiteProfileMemory, matchSemanticTarget,
  CHECKPOINTS, type CheckpointId,
  type LearnedStepEntry, type SemanticTarget,
} from "./semantic.ts";
import { checkSignal, type SignalSpec } from "./signals.ts";
import { startUrl, REFUSAL_LABELS, type AppInvariantResult } from "./app-runner.ts";
import { DEFAULT_ENUM_ORDER, INSTRUCTION_NAMES, getInstruction } from "./instructions.ts";
import { createInstructionMemory } from "./semantic-instructions.ts";
import { nominateInstruction, type NominationAsk } from "./nominate.ts";
import { createDataset, type DatasetEntry } from "./dataset.ts";

/* ------------------------------------------------------------------ 模板形状 */

/** 最低接受的模板版本；`next` 走向边需要 3（v2 模板写了 next ⇒ 红 + 指路）。 */
export const FLOW_SPEC_VERSION = 2;
export const FLOW_SPEC_VERSION_CURRENT = 3;

/** 页面角色信号：完成 = 到达该站此页角色的 URL（可选再要求查询串含某子串）。 */
export interface PageSignal {
  page: string;
  query?: string;
}

export interface ListStepSpec {
  op: "min" | "max";
  by: string;
  act?: "row";
}

export interface FlowStep {
  id: string;
  desc: string;
  /** 页面角色（模板 `pages` 的键；站点档案 `pages` 可覆盖该角色的文件名）。 */
  page: string;
  /** 本页查询串模板（`from={from}&to={to}`；值自动百分号编码）。 */
  page_query?: string;
  semantic_target?: SemanticTarget;
  /** 有序语义目标（多动作步：先填出发、再填到达、再搜索）——"老师"替身按序点名。 */
  semantic_targets?: SemanticTarget[];
  /** 本步供给的槽位名；站点字段键在档案 `fill_keys`（值绑定是站点知识）。 */
  fills?: string[];
  signal: PageSignal;
  when?: SignalSpec;
  retries?: number;
  dangerous?: boolean;
  list_step?: ListStepSpec;
  /**
   * NL Flow S3：本步承诺写进数据集的名字（当前闭集唯一产出指令 = list_pick 的 `chosen`，
   * 所以只允许一个名字）。步没有产出却声明 gives = 加载期红——静默的"永远不写入"比报错更糟。
   */
  gives?: string[];
  /**
   * NL Flow S3：声明式后继（有序候选；适用性 = 候选步自己的 `when`，与 app-runner 的
   * P4 同一语义）。需要 spec_version 3；指向空气 = 加载期红。
   */
  next?: string[];
  /**
   * NL Flow S2（docs/NL_FLOW_DESIGN.md §4/§10-S2）：步级提名开关。声明后本步的
   * `list_step` **降格为 list_pick 候选参数**（op/by/act 仍是声明的数据规则——红线②
   * 不动），运行期由提名梯级裁决"这次用不用它"；不声明 = 现状行为逐字节不变。
   */
  nominate?: boolean;
  /**
   * NL Flow S2：指令锁——跳过提名梯级，恒用该指令（候选集坍缩为它）。
   * 必须在闭集内（`instructions.INSTRUCTION_NAMES`），且要求本步声明 `nominate: true`。
   */
  instr?: string;
}

export interface FlowSite {
  label: string;
  start_url: string;
}

export interface FlowTemplate {
  spec_version: number;
  id: string;
  label: string;
  goal: string;
  model?: string;
  slots?: Record<string, unknown>;
  sites: Record<string, FlowSite>;
  /** 页面角色 → 默认文件名（站点档案可按角色覆盖）。 */
  pages: Record<string, string>;
  steps: FlowStep[];
  invariants?: PageSignal[];
  notes?: string[];
  /**
   * NL Flow S3：每步的进入次数上界（声明 `next` 回边时的环上界；缺省 3，与 app-runner 同源）。
   * 到顶 = 结构化 `next_cycle` 停因，不挂死。
   */
  max_step_visits?: number;
  /** 加载器写入：模板文件路径（报告用）。 */
  _path?: string;
}

/** 站点档案（authored 的那半：随模板包走，`apps/<id>/sites/<site>.profile.json`）。 */
export interface ListExtract {
  row_sel: string;
  fields: Record<string, { sel: string; op: "int" | "str" | "strip" }>;
  act_sel?: string | null;
}

export interface SiteProfile {
  spec_version?: number;
  site: string;
  label?: string;
  locale?: string;
  checkpoint?: string;
  pages?: Record<string, string>;
  /** 站点观察到的查询参数名（模板里 {slot} 占位的猜测被本站观测覆盖时用）。 */
  page_query?: Record<string, string>;
  /** stepId → (站点字段键 → 槽位名)：_slotValue 靠它把"出发城市"绑到槽 from。 */
  fill_keys?: Record<string, Record<string, string>>;
  list_extract?: Record<string, ListExtract>;
  /** DOM 级信号先验（整体覆盖该步的页面角色契约信号）。 */
  frozen_signals?: Record<string, SignalSpec>;
  /** authored 的步级 hint 先验（learned 覆盖 authored）。 */
  steps?: Record<string, LearnedStepEntry>;
  notes?: string[];
  /** 加载器写入：档案文件路径（报告用）。 */
  _path?: string;
}

const TEMPLATE_KEYS = [
  "spec_version", "id", "label", "goal", "model", "slots", "sites", "pages", "steps", "invariants", "notes",
  "max_step_visits",
] as const;
const STEP_KEYS = [
  "id", "desc", "page", "page_query", "semantic_target", "semantic_targets",
  "fills", "signal", "when", "retries", "dangerous", "list_step",
  "nominate", "instr", "next", "gives",
] as const;
const PROFILE_KEYS = [
  "spec_version", "site", "label", "locale", "checkpoint", "pages", "page_query",
  "fill_keys", "list_extract", "frozen_signals", "steps", "notes",
] as const;
const ROLES = new Set(["button", "link", "input", "textarea", "select"]);
// min/max 的合法面在数据槽层一处（`bindings.LIST_ORDERS`）——这里不再复制一份词表。
const FIELD_OPS = new Set(["int", "str", "strip"]);

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/* ------------------------------------------------------------------ 加载与校验 */

/**
 * v2 模板的发现根，**与 app-pack 同一纪律**（P0 前提 A：新产物落 `$AMBERFLOW_HOME/apps`，
 * 不写 checkout；发现制扫 [用户目录, 仓库夹具]，同 id 用户赢）。plan-flow / learn 写的正是
 * 用户目录——发现只看仓库的话，规划出来的模板会"落得下、跑不起"（2026-10-14 开箱测试轮实测：
 * plan:flow 成功落 ~/.amberflow/apps，`npm run semantic -- --app <它>` 报 not found）。
 * 显式传目录 = 只扫那里（测试/工具的单根语义不变）。
 */
export function flowAppsRoots(appsDir?: string | null): string[] {
  return appsDir ? [appsDir] : [userAppsDir(), APPS_DIR];
}

function templatePath(appId: string, appsDir?: string | null): string {
  for (const r of flowAppsRoots(appsDir)) {
    const p = path.join(r, appId, "flow.json");
    if (fs.existsSync(p)) return p;
  }
  return path.join(flowAppsRoots(appsDir)[0]!, appId, "flow.json");   // 报错用：首个候选
}

/** 发现有语义模板的应用（<root>/<id>/flow.json，多根、同 id 用户赢）。 */
export function listFlowApps(appsDir?: string | null): Array<[string, string, string[]]> {
  const out: Array<[string, string, string[]]> = [];
  const seen = new Set<string>();
  for (const root of flowAppsRoots(appsDir)) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      if (seen.has(n)) continue;                       // 前面的根（用户目录）赢
      const p = path.join(root, n, "flow.json");
      if (!fs.existsSync(p)) continue;
      seen.add(n);
      try {
        const t = JSON.parse(fs.readFileSync(p, "utf-8")) as FlowTemplate;
        out.push([String(t.id ?? n), String(t.label ?? ""), Object.keys(t.sites ?? {})]);
      } catch (e) {
        out.push([n, `<invalid: ${e instanceof Error ? e.message : String(e)}>`, []]);
      }
    }
  }
  return out;
}

export function loadTemplate(appId: string, appsDir?: string | null): FlowTemplate {
  const p = templatePath(appId, appsDir);
  if (!fs.existsSync(p)) {
    throw new Error(`semantic template ${JSON.stringify(appId)} not found `
      + `(searched: ${flowAppsRoots(appsDir).map((r) => path.join(r, appId, "flow.json")).join(", ")})`);
  }
  const t = JSON.parse(fs.readFileSync(p, "utf-8")) as FlowTemplate;
  t._path = p;
  return t;
}

/** 模板自带的 authored 站点档案：`<root>/<id>/sites/<site>.profile.json`（多根、用户赢）。 */
export function loadSiteProfile(appId: string, siteKey: string, appsDir?: string | null): SiteProfile {
  for (const r of flowAppsRoots(appsDir)) {
    const p = path.join(r, appId, "sites", `${siteKey}.profile.json`);
    if (fs.existsSync(p)) {
      const prof = JSON.parse(fs.readFileSync(p, "utf-8")) as SiteProfile;
      prof._path = p;
      return prof;
    }
  }
  return { site: siteKey };
}

function checkTarget(t: unknown, where: string, problems: string[]): void {
  if (!isDict(t)) {
    problems.push(`${where}: semantic target must be an object`);
    return;
  }
  for (const k of Object.keys(t)) {
    if (!["role", "text", "near", "data_test"].includes(k)) {
      problems.push(`${where}.${k}: unknown semantic-target key (known: role, text, near, data_test)`);
    }
  }
  if (t["role"] !== undefined && !(typeof t["role"] === "string" && ROLES.has(t["role"]))) {
    problems.push(`${where}.role must be one of ${[...ROLES].join(", ")}`);
  }
  for (const k of ["text", "near", "data_test"] as const) {
    const v = t[k];
    if (v !== undefined && !(typeof v === "string" || isStrList(v))) {
      problems.push(`${where}.${k} must be a string or a list of strings`);
    }
  }
}

/** 校验模板：未知键/坏步骤/未声明的页面角色都在加载期炸（配置写错要响亮）。 */
export function validateTemplate(t: FlowTemplate): string[] {
  const p: string[] = [];
  if (!isDict(t)) return ["template must be a JSON object"];
  for (const k of Object.keys(t)) {
    if (!(TEMPLATE_KEYS as readonly string[]).includes(k) && !k.startsWith("_")) {
      p.push(`${k}: unknown template key (known: ${TEMPLATE_KEYS.join(", ")})`);
    }
  }
  if (t.spec_version !== FLOW_SPEC_VERSION && t.spec_version !== FLOW_SPEC_VERSION_CURRENT) {
    p.push(`spec_version must be ${FLOW_SPEC_VERSION} or ${FLOW_SPEC_VERSION_CURRENT}`
      + ` (got ${JSON.stringify(t.spec_version)})`);
  }
  if (t.max_step_visits !== undefined
    && (!Number.isInteger(t.max_step_visits) || Number(t.max_step_visits) < 1)) {
    p.push("max_step_visits must be a positive integer");
  }
  // NL Flow S3：`next` 是 v3 的声明面——v2 模板写了就指路升版（不认识就响亮拒绝的纪律）。
  if (t.spec_version === FLOW_SPEC_VERSION
    && Array.isArray(t.steps) && t.steps.some((s) => isDict(s) && s["next"] !== undefined)) {
    p.push(`step.next requires spec_version ${FLOW_SPEC_VERSION_CURRENT}`
      + `（走向边是 v3 声明面；升版后 v2 模板一字不改照常加载）`);
  }
  for (const k of ["id", "label", "goal"] as const) {
    if (typeof t[k] !== "string" || !t[k]) p.push(`${k} is required`);
  }
  if (t.model !== undefined && typeof t.model !== "string") p.push("model must be a string");
  if (t.slots !== undefined && !isDict(t.slots)) p.push("slots must be an object of slot -> value");
  if (!isDict(t.sites) || Object.keys(t.sites).length === 0) {
    p.push("sites must be a non-empty object of site -> {label, start_url}");
  } else {
    for (const [key, s] of Object.entries(t.sites)) {
      if (!isDict(s) || typeof s["label"] !== "string" || !s["label"]
        || typeof s["start_url"] !== "string" || !s["start_url"]) {
        p.push(`sites.${key} needs {label, start_url}`);
      }
    }
  }
  if (!isDict(t.pages) || Object.keys(t.pages).length === 0) {
    p.push("pages must be a non-empty object of role -> filename");
  } else {
    for (const [role, file] of Object.entries(t.pages)) {
      if (typeof file !== "string" || !file) p.push(`pages.${role} must be a non-empty filename`);
    }
  }
  if (!Array.isArray(t.steps) || t.steps.length === 0) {
    p.push("steps must be a non-empty list");
    return p;
  }
  const ids = new Set<string>();
  t.steps.forEach((s, i) => {
    const where = `steps[${i}]`;
    if (!isDict(s)) { p.push(`${where} must be an object`); return; }
    for (const k of Object.keys(s)) {
      if (!(STEP_KEYS as readonly string[]).includes(k)) {
        p.push(`${where}.${k}: unknown step key (known: ${STEP_KEYS.join(", ")})`);
      }
    }
    if (typeof s["id"] !== "string" || !s["id"]) p.push(`${where}.id is required`);
    else if (ids.has(s["id"])) p.push(`${where}.id ${JSON.stringify(s["id"])} is duplicated`);
    else ids.add(s["id"]);
    if (typeof s["desc"] !== "string" || !s["desc"]) p.push(`${where}.desc is required`);
    const page = s["page"];
    if (typeof page !== "string" || !page) p.push(`${where}.page (a page role) is required`);
    else if (!t.pages || !(page in t.pages)) p.push(`${where}.page ${JSON.stringify(page)} is not a declared page role`);
    if (s["page_query"] !== undefined && (typeof s["page_query"] !== "string" || !s["page_query"])) {
      p.push(`${where}.page_query must be a non-empty string (or omit it)`);
    }
    if (s["semantic_target"] !== undefined) checkTarget(s["semantic_target"], `${where}.semantic_target`, p);
    if (s["semantic_targets"] !== undefined) {
      if (!Array.isArray(s["semantic_targets"])) p.push(`${where}.semantic_targets must be a list`);
      else s["semantic_targets"].forEach((x, j) => checkTarget(x, `${where}.semantic_targets[${j}]`, p));
    }
    if (s["fills"] !== undefined && !isStrList(s["fills"])) {
      p.push(`${where}.fills must be a list of slot names`);
    }
    const sig = s["signal"];
    if (!isDict(sig)) p.push(`${where}.signal must be {"page": role, "query"?: "..."} `);
    else {
      if (typeof sig["page"] !== "string" || (t.pages && !(sig["page"] in t.pages))) {
        p.push(`${where}.signal.page must be a declared page role`);
      }
      if (sig["query"] !== undefined && (typeof sig["query"] !== "string" || !sig["query"])) {
        p.push(`${where}.signal.query must be a non-empty string (or omit it)`);
      }
      for (const k of Object.keys(sig)) {
        if (!["page", "query"].includes(k)) p.push(`${where}.signal.${k}: unknown key (known: page, query)`);
      }
    }
    if (s["when"] !== undefined && (!isDict(s["when"]) || Object.keys(s["when"]).length === 0)) {
      p.push(`${where}.when must be a non-empty signal`);
    }
    if (s["retries"] !== undefined
      && (!Number.isInteger(s["retries"]) || Number(s["retries"]) < 0)) {
      p.push(`${where}.retries must be a non-negative integer`);
    }
    if (s["dangerous"] !== undefined && typeof s["dangerous"] !== "boolean") {
      p.push(`${where}.dangerous must be a boolean`);
    }
    if (s["dangerous"] === true && s["list_step"] !== undefined) {
      p.push(`${where}: a list step cannot be dangerous (it never acts on the model's word)`);
    }
    // NL Flow S3：gives 的产出契约（见 FlowStep.gives 注释）。
    if (s["gives"] !== undefined) {
      if (!isStrList(s["gives"]) || (s["gives"] as string[]).length !== 1 || !(s["gives"] as string[])[0].trim()) {
        p.push(`${where}.gives must be a one-name list (唯一产出指令 list_pick 输出 chosen——给它一个数据集名)`);
      } else if (s["list_step"] === undefined) {
        p.push(`${where}: gives on a step with no producing instruction（当前闭集只有 list_pick 产出，需声明 list_step 候选或本体）`);
      }
    }
    // NL Flow S2：提名步与指令锁（校验紧跟声明面；读取方在 compile/runFlow——不挂空 schema）。
    if (s["nominate"] !== undefined && typeof s["nominate"] !== "boolean") {
      p.push(`${where}.nominate must be a boolean`);
    }
    if (s["nominate"] === true && s["dangerous"] === true) {
      p.push(`${where}: a nominating step cannot be dangerous（不可逆步不参与提名——`
        + `它永远是显式声明的 dangerous 步：dry-run + 人确认，提名闭集里没有它）`);
    }
    if (s["instr"] !== undefined) {
      if (typeof s["instr"] !== "string" || !(INSTRUCTION_NAMES as readonly string[]).includes(s["instr"])) {
        p.push(`${where}.instr must be one of ${INSTRUCTION_NAMES.join("|")} (got ${JSON.stringify(s["instr"])})`);
      } else if (s["nominate"] !== true) {
        p.push(`${where}.instr locks the nomination ladder — declare nominate: true on this step`);
      } else if (s["instr"] === "list_pick" && s["list_step"] === undefined) {
        // 锁到一条**不可执行**的指令 = 运行期静默降级成元素动作 + 谎报提名（复核实测：
        // 校验曾经放行，候选序坍缩成 ["list_pick"]，runner 掉进浏览器支线仍报 via=locked）。
        // 参数是声明的：锁 list_pick 就必须有 list_step 候选参数（行选择器仍在档案里）。
        p.push(`${where}.instr "list_pick" needs a list_step candidate`
          + `（候选参数是声明的；锁到不可执行的指令 = 静默降级 + 谎报提名）`);
      }
    }
    if (s["list_step"] !== undefined) {
      const ls = s["list_step"];
      if (!isDict(ls)) {
        p.push(`${where}.list_step must be {"op": "min"|"max", "by": field${", \"act\": \"row"}}`);
      } else {
        // P3：flow 的 `{op, by}` 形状是**既有**声明面（不动它，§8.4 缺省等价），
        // 但它映射到数据槽层同一条 `{from:"list", order, by}` 上校验——
        // min/max 的合法面只在 `bindings.LIST_ORDERS` 一处，不再各写一份词表（§8.3）。
        validateBinding(
          { from: "list", by: ls["by"], order: ls["op"] },
          `${where}.list_step`, p, { allowList: true },
        );
        if (ls["act"] !== undefined && ls["act"] !== "row") {
          p.push(`${where}.list_step.act must be "row"`);
        }
      }
    }
  });
  // NL Flow S3：`next` 的目标必须是**声明过的步 id**——指向空气的边 = 一步都不走的静默
  // 分支，加载期红（与 app-pack 的 P4 同一条纪律）。
  for (const [i, s] of (t.steps as unknown[]).entries()) {
    if (!isDict(s) || s["next"] === undefined) continue;
    const where = `steps[${i}].next`;
    const nx = s["next"];
    if (!Array.isArray(nx) || nx.length === 0 || !nx.every((x) => typeof x === "string" && x)) {
      p.push(`${where} must be a non-empty list of step ids`);
      continue;
    }
    const seenNext = new Set<string>();
    for (const target of nx) {
      if (!ids.has(target as string)) p.push(`${where}: target ${JSON.stringify(target)} is not a declared step id`);
      if (seenNext.has(target as string)) p.push(`${where}: duplicate target ${JSON.stringify(target)}`);
      seenNext.add(target as string);
    }
  }
  if (t.invariants !== undefined) {
    if (!Array.isArray(t.invariants)) p.push("invariants must be a list of page signals");
    else {
      t.invariants.forEach((inv, i) => {
        if (!isDict(inv) || typeof inv["page"] !== "string" || (t.pages && !(inv["page"] in t.pages))) {
          p.push(`invariants[${i}] must be {"page": role, "query"?: "..."}`);
        }
      });
    }
  }
  if (t.notes !== undefined && !isStrList(t.notes)) p.push("notes must be a list of strings");
  return p;
}

/** 校验站点档案（authored 半边）：未知键/坏提取配置加载期炸。 */
export function validateProfile(prof: SiteProfile, template: FlowTemplate): string[] {
  const p: string[] = [];
  if (!isDict(prof)) return ["site profile must be a JSON object"];
  for (const k of Object.keys(prof)) {
    if (!(PROFILE_KEYS as readonly string[]).includes(k) && !k.startsWith("_")) {
      p.push(`${k}: unknown profile key (known: ${PROFILE_KEYS.join(", ")})`);
    }
  }
  if (prof.site !== undefined && !template.sites[prof.site]) {
    p.push(`site ${JSON.stringify(prof.site)} is not declared by template ${template.id}`);
  }
  // §3 文字系统路由：这两个字段是**数据**（Router 的脚本结论落成档案），错值当场炸。
  if (prof.locale !== undefined && (typeof prof.locale !== "string" || !prof.locale.trim())) {
    p.push("locale must be a non-empty string (e.g. \"zh-cn\")");
  }
  if (prof.checkpoint !== undefined && !(CHECKPOINTS as readonly string[]).includes(String(prof.checkpoint))) {
    p.push(`checkpoint must be one of ${CHECKPOINTS.join(", ")} (got ${JSON.stringify(prof.checkpoint)})`);
  }
  if (prof.pages !== undefined) {
    if (!isDict(prof.pages)) p.push("pages must be an object of role -> filename");
    else {
      for (const [role, file] of Object.entries(prof.pages)) {
        if (!(role in template.pages)) p.push(`pages.${role}: unknown page role (declared by template: ${Object.keys(template.pages).join(", ")})`);
        if (typeof file !== "string" || !file) p.push(`pages.${role} must be a non-empty filename`);
      }
    }
  }
  if (prof.page_query !== undefined) {
    if (!isDict(prof.page_query)) p.push("page_query must be an object of stepId -> query template");
    else {
      for (const [stepId, qt] of Object.entries(prof.page_query)) {
        if (!template.steps.some((s) => s.id === stepId)) {
          p.push(`page_query.${stepId}: unknown step id`);
          continue;
        }
        if (typeof qt !== "string" || !qt) p.push(`page_query.${stepId} must be a non-empty query template`);
      }
    }
  }
  if (prof.fill_keys !== undefined) {
    if (!isDict(prof.fill_keys)) p.push("fill_keys must be an object of stepId -> (fieldKey -> slotName)");
    else {
      for (const [stepId, m] of Object.entries(prof.fill_keys)) {
        const step = template.steps.find((s) => s.id === stepId);
        if (!step) {
          p.push(`fill_keys.${stepId}: unknown step id (declared: ${template.steps.map((s) => s.id).join(", ")})`);
          continue;
        }
        if (!isDict(m)) { p.push(`fill_keys.${stepId} must be an object`); continue; }
        const fills = step.fills ?? [];
        for (const [fieldKey, slotName] of Object.entries(m)) {
          if (typeof fieldKey !== "string" || !fieldKey || typeof slotName !== "string" || !slotName) {
            p.push(`fill_keys.${stepId}.${fieldKey}: must map a non-empty field key to a slot name`);
          } else if (!fills.includes(slotName)) {
            p.push(`fill_keys.${stepId}.${fieldKey}: slot ${JSON.stringify(slotName)} is not in steps[${stepId}].fills (${fills.join(", ") || "none"})`);
          }
        }
        for (const slotName of fills) {
          if (!Object.values(m).includes(slotName)) {
            p.push(`fill_keys.${stepId}: slot ${JSON.stringify(slotName)} (declared in fills) has no field key`);
          }
        }
      }
    }
  }
  if (prof.list_extract !== undefined) {
    if (!isDict(prof.list_extract)) p.push("list_extract must be an object of stepId -> config");
    else {
      for (const [stepId, cfg] of Object.entries(prof.list_extract)) {
        const step = template.steps.find((s) => s.id === stepId);
        if (!step) {
          p.push(`list_extract.${stepId}: unknown step id`);
          continue;
        }
        if (!isDict(cfg) || typeof cfg["row_sel"] !== "string" || !cfg["row_sel"]) {
          p.push(`list_extract.${stepId}.row_sel must be a non-empty css selector`);
          continue;
        }
        const fields = cfg["fields"];
        if (!isDict(fields) || Object.keys(fields).length === 0) {
          p.push(`list_extract.${stepId}.fields must be a non-empty object`);
          continue;
        }
        for (const [name, f] of Object.entries(fields)) {
          if (!isDict(f) || typeof f["sel"] !== "string" || !FIELD_OPS.has(String(f["op"]))) {
            p.push(`list_extract.${stepId}.fields.${name} must be {sel, op: int|str|strip}`);
          }
        }
        const by = (step.list_step as ListStepSpec | undefined)?.by;
        if (by !== undefined && !(by in fields)) {
          p.push(`list_extract.${stepId}.fields: step selects by ${JSON.stringify(by)} — that field must be declared`);
        }
        if (cfg["act_sel"] !== undefined && cfg["act_sel"] !== null && typeof cfg["act_sel"] !== "string") {
          p.push(`list_extract.${stepId}.act_sel must be a css selector or null (click the row itself)`);
        }
      }
    }
  }
  if (prof.frozen_signals !== undefined) {
    if (!isDict(prof.frozen_signals)) p.push("frozen_signals must be an object of stepId -> signal");
    else {
      for (const [stepId, sig] of Object.entries(prof.frozen_signals)) {
        if (!template.steps.some((s) => s.id === stepId)) {
          p.push(`frozen_signals.${stepId}: unknown step id`);
          continue;
        }
        // 同一套信号语法（一个口径）：借 PlanningRules 的 walker 校验。
        const plan = new TaskPlan("x", [{ desc: "x", signal: sig }], ":memory:");
        for (const issue of new PlanningRules(8, true, false).problems(plan)) {
          p.push(`frozen_signals.${stepId}: ${issue.replace("subgoal[0]", "signal")}`);
        }
      }
    }
  }
  if (prof.steps !== undefined) {
    for (const [stepId, e] of Object.entries(prof.steps)) {
      if (!template.steps.some((s) => s.id === stepId)) {
        p.push(`steps.${stepId}: unknown step id`);
        continue;
      }
      if (!isDict(e) || typeof e["hint"] !== "string" || !e["hint"]) {
        p.push(`steps.${stepId}.hint must be a non-empty string`);
      }
    }
  }
  return p;
}

/* ------------------------------------------------------------------ 编译 */

export interface CompiledStep {
  id: string;
  desc: string;
  kind: "browser" | "list";
  /** 本步的绝对起始 URL（页面角色 + 查询模板 + 槽位 → 各站的真 URL）。 */
  url: string;
  sg: Subgoal | null;
  list?: { cfg: ListExtract; op: "min" | "max"; by: string };
  dangerous: boolean;
  /** 有序语义目标（老师替身 / 未来 LLM 老师的语义锚点）。 */
  targets: SemanticTarget[];
  /** 该站此页角色的文件名（信号编译的 url_contains 依据）。 */
  pageFile: string;
  signal: SignalSpec;
  signal_source: "contract" | "authored";
  /** NL Flow S2：本步参与提名梯级（`nominate: true`；list_step 降格为 list_pick 候选参数）。 */
  nominate?: boolean;
  /** NL Flow S2：指令锁（非 null = 候选集坍缩为它，跳过梯级）。 */
  instr?: string | null;
  /** NL Flow S2：list_pick 候选的声明参数（来自模板 list_step × 档案 list_extract）。 */
  list_candidate?: { cfg: ListExtract; op: "min" | "max"; by: string };
  /** NL Flow S3：声明式后继（有序候选；适用性 = 候选步自己的 `when`）。 */
  next?: string[];
  /** NL Flow S3：本步承诺写进数据集的名字（唯一产出 = list_pick 的 chosen）。 */
  gives?: string[];
}

function substituteSlots(text: string, slots: Record<string, unknown>, problems: string[]): string {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k: string) => {
    if (!(k in slots)) {
      problems.push(`unknown slot placeholder {${k}} (declared: ${Object.keys(slots).join(", ")})`);
      return m;
    }
    return String(slots[k]);
  });
}

/**
 * NL Flow S2：一个提名步的**可执行候选序**（⑤枚举的输入；runFlow 的裁决按它走）。
 *   - `instr` 锁 = 候选集坍缩为该指令（跳过梯级——锁是作者的最终说法）；
 *   - `list_pick` 只有在候选参数齐备（模板 `list_step` × 档案 `list_extract`）时才在序内——
 *     它的参数永远是声明的，模型/学习环只裁"用不用"（红线②）；
 *   - 其余按缺省序（S0 实测那张：click 在首位，⑤的兜底头）。
 */
export function executableInstructionOrder(step: CompiledStep): readonly string[] {
  if (!step.nominate) return [];
  if (step.instr) return [step.instr];
  return DEFAULT_ENUM_ORDER.filter((n) => n !== "list_pick" || step.list_candidate !== undefined);
}

/**
 * 信号里的 {slot} 用 **URL 编码后的值** 替换：`url_contains` 面对的是页面真实 URL，
 * 中文槽位值在那里是 %E6%98%86%E6%98%8E——裸替换永远对不上。ASCII 值编码后不变。
 */
function substituteSlotsEncoded(text: string, slots: Record<string, unknown>, problems: string[]): string {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k: string) => {
    if (!(k in slots)) {
      problems.push(`unknown slot placeholder {${k}} (declared: ${Object.keys(slots).join(", ")})`);
      return m;
    }
    return encodeURIComponent(String(slots[k]));
  });
}

/**
 * 对整棵信号树做槽位替换（frozen_signals 是观察回来的，可能含 {slot} 占位）。
 * **只有 `url_contains` 的字符串用 URL 编码值**——它面对的是页面真实 URL（%E6%98%86…）；
 * `css_text_*` / `css_value_*` 面对的是 DOM 原文（昆明），编码替换永远对不上（site-b 实测踩过）。
 */
function substituteSignalSpec(value: unknown, slots: Record<string, unknown>, problems: string[]): unknown {
  const raw = (v: unknown): unknown => {
    if (typeof v === "string") return substituteSlots(v, slots, problems);
    if (Array.isArray(v)) return v.map(raw);
    if (isDict(v)) {
      const o: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v)) o[k] = raw(vv);
      return o;
    }
    return v;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return substituteSlotsEncoded(v, slots, problems);
    if (Array.isArray(v)) return v.map(walk);
    if (isDict(v)) {
      const o: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v)) {
        if (k === "all_of" || k === "any_of") o[k] = (vv as unknown[]).map(walk);
        else if (k === "not") o[k] = walk(vv);
        else o[k] = k === "url_contains" ? walk(vv) : raw(vv);
      }
      return o;
    }
    return v;
  };
  return walk(value);
}

export interface CompiledFlow {
  siteKey: string;
  site: FlowSite;
  slots: Record<string, unknown>;
  steps: CompiledStep[];
  invariants: SignalSpec[];
}

/**
 * 模板 + 站点档案 + 槽位 → 可执行步骤表。同一份模板 + 同一组槽位 + 同一份档案
 * 必须展开出逐字段相同的步骤（可复现性由测试钉住）。
 */
export function compileFlow(
  template: FlowTemplate,
  siteKey: string,
  profile: SiteProfile,
  slotOverrides: Record<string, unknown> = {},
): CompiledFlow {
  const site = template.sites[siteKey];
  if (!site) {
    throw new Error(`site ${JSON.stringify(siteKey)} is not declared by template ${template.id}`
      + `（declared: ${Object.keys(template.sites).join(", ")}）`);
  }
  const slots: Record<string, unknown> = { ...(template.slots ?? {}), ...slotOverrides };
  const problems: string[] = [];
  for (const k of Object.keys(slotOverrides)) {
    if (!(k in (template.slots ?? {}))) {
      // 覆盖未声明的槽位 = 值永远没人用（与 app-runner 的 --slot 同一口径：用法错误）。
      problems.push(`slot ${JSON.stringify(k)} is not declared by template ${template.id}`
        + `（declared: ${Object.keys(template.slots ?? {}).join(", ")}）`);
    }
  }
  const pages = { ...template.pages, ...(profile.pages ?? {}) };
  const steps: CompiledStep[] = [];

  template.steps.forEach((step, index) => {
    const where = `steps[${index}](${step.id})`;
    const pageFile = pages[step.page];
    if (!pageFile) {
      problems.push(`${where}: page role ${JSON.stringify(step.page)} has no filename on this site`);
      return;
    }
    // 页面 URL：文件名相对站点根；查询串里的值经 searchParams 百分号编码。
    // 查询串的**参数名是站点知识**（真站各写各的）：档案 `page_query` 覆盖模板的猜测。
    let url = "";
    try {
      const u = new URL(pageFile, new URL(startUrl(site.start_url)));
      const qt = profile.page_query?.[step.id] ?? step.page_query;
      if (qt) {
        const qs = substituteSlots(qt, slots, problems);
        for (const pair of qs.split("&").filter(Boolean)) {
          const i = pair.indexOf("=");
          if (i <= 0) {
            problems.push(`${where}: bad page_query pair ${JSON.stringify(pair)}`);
            continue;
          }
          u.searchParams.set(pair.slice(0, i), pair.slice(i + 1));
        }
      }
      url = u.href;
    } catch (e) {
      problems.push(`${where}: cannot build step url (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    // desc 里的 {slot}：值只来自数据袋（红线 4）。
    const desc = substituteSlots(step.desc, slots, problems);
    // 语义目标里的 {slot} 同理（日期文案是槽位，不是写死的模板知识）。
    const subAll = (v: string | string[]): string | string[] =>
      Array.isArray(v) ? v.map((x) => substituteSlots(x, slots, problems)) : substituteSlots(v, slots, problems);
    const subTarget = (t: SemanticTarget): SemanticTarget => ({
      ...(t.role !== undefined ? { role: t.role } : {}),
      ...(t.text !== undefined ? { text: subAll(t.text) } : {}),
      ...(t.near !== undefined ? { near: subAll(t.near) } : {}),
      ...(t.data_test !== undefined ? { data_test: subAll(t.data_test) } : {}),
    });
    // 信号：页面角色契约（默认）或档案的 DOM 级先验（覆盖，{slot} 按 URL 编码替换）。
    const frozenRaw = profile.frozen_signals?.[step.id];
    const frozen = frozenRaw === undefined ? undefined
      : substituteSignalSpec(frozenRaw, slots, problems) as SignalSpec;
    const signal: SignalSpec = frozen ?? compilePageSignal(step.signal, pages, slots, problems);
    const targets: SemanticTarget[] = step.semantic_targets
      ? step.semantic_targets.map(subTarget)
      : (step.semantic_target ? [subTarget(step.semantic_target)] : []);

    const listSpec = step.list_step;
    const nominating = step.nominate === true;
    if (listSpec && !nominating) {
      const cfg = profile.list_extract?.[step.id];
      if (!cfg) {
        problems.push(`${where}: a list step needs list_extract.${step.id} in the site profile`
          + `（行选择器/字段是站点知识，进档案）`);
        return;
      }
      steps.push({
        id: step.id, desc, kind: "list", url, sg: null,
        list: { cfg, op: listSpec.op, by: listSpec.by },
        dangerous: false, targets, pageFile, signal,
        signal_source: frozen ? "authored" : "contract",
        ...(step.next ? { next: [...step.next] } : {}),
        ...(step.gives ? { gives: [...step.gives] } : {}),
      });
      return;
    }
    // NL Flow S2：nominate 步——`list_step` 是 list_pick **候选参数**（不是决定）。
    // 行选择器/字段仍是站点知识（缺档案 = 编译期红，与 list 步同一纪律）；
    // 用不用这个候选由运行期提名梯级裁决（值与选择规则永远是声明的——红线②）。
    let listCandidate: CompiledStep["list_candidate"] = undefined;
    if (listSpec && nominating) {
      const cfg = profile.list_extract?.[step.id];
      if (!cfg) {
        problems.push(`${where}: a nominating step with a list_pick candidate needs `
          + `list_extract.${step.id} in the site profile（缺了 = 该候选不可执行，编译期说清楚）`);
        return;
      }
      listCandidate = { cfg, op: listSpec.op, by: listSpec.by };
    }

    // 值绑定：fill 声明的槽位 ← 档案的字段键（_slotValue 靠键匹配站点字段）。
    let stepSlots: Record<string, unknown> | undefined;
    if (step.fills?.length) {
      const map = profile.fill_keys?.[step.id];
      if (!map) {
        problems.push(`${where}: fills [${step.fills.join(", ")}] need fill_keys.${step.id}`
          + ` in the site profile（字段键 ↔ 槽位的绑定是站点知识）`);
      } else {
        const expanded: Record<string, unknown> = {};
        for (const [fieldKey, slotName] of Object.entries(map)) {
          if (step.fills.includes(slotName)) {
            if (!(slotName in slots)) {
              problems.push(`${where}: slot ${JSON.stringify(slotName)} has no value`);
              continue;
            }
            expanded[fieldKey] = slots[slotName];
          }
        }
        if (Object.keys(expanded).length) stepSlots = expanded;
      }
    }

    steps.push({
      id: step.id, desc, kind: "browser", url,
      sg: {
        desc, signal, start_url: url,
        ...(stepSlots ? { slots: stepSlots } : {}),
        ...(step.when ? { when: step.when } : {}),
        ...(step.retries ? { retries: Math.trunc(Number(step.retries)) } : {}),
      },
      dangerous: step.dangerous === true, targets, pageFile, signal,
      signal_source: frozen ? "authored" : "contract",
      ...(nominating
        ? { nominate: true, instr: step.instr ?? null, ...(listCandidate ? { list_candidate: listCandidate } : {}) }
        : {}),
      ...(step.next ? { next: [...step.next] } : {}),
      ...(step.gives ? { gives: [...step.gives] } : {}),
    });
  });

  const invariants: SignalSpec[] = (template.invariants ?? []).map((inv) => {
    if (!pages[inv.page]) {
      problems.push(`invariants: page role ${JSON.stringify(inv.page)} has no filename on this site`);
    }
    return compilePageSignal(inv, pages, slots, problems);
  });

  if (problems.length) {
    throw new Error(`semantic flow ${template.id} on ${siteKey} is invalid:\n  - ${[...new Set(problems)].join("\n  - ")}`);
  }
  return { siteKey, site, slots, steps, invariants };
}

function compilePageSignal(
  sig: PageSignal, pages: Record<string, string>, slots: Record<string, unknown>, problems: string[],
): SignalSpec {
  // 信号的 page 角色是"落点页"（完成时应到达的页面），不是本步出发的页面——
  // 所以按角色从该站的 pages 表解析文件名，而不是用本步自己的 pageFile。
  const file = pages[sig.page];
  if (!file) {
    problems.push(`signal.page ${JSON.stringify(sig.page)} has no filename on this site`);
    return {};
  }
  const filePart: SignalSpec = { url_contains: file };
  if (!sig.query) return filePart;
  const q = substituteSlots(sig.query, slots, problems);
  return { all_of: [filePart, { url_contains: q }] };
}

/* ------------------------------------------------------------------ list_step */

export interface ListStepOutcome {
  done: boolean;
  detail: Record<string, unknown>;
  error?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 首个**执行过的**动作的族（trace 证据面）：`type text into select` → select、
 * `type text into input/textarea` → fill、其余 → click。强制点用它核对提名。
 */
function firstExecFamily(
  steps: ReadonlyArray<Record<string, unknown>>,
): "click" | "fill" | "select" | null {
  const t = steps.find((x) => x["executed"] === true);
  if (!t) return null;
  const d = String(t["desc"] ?? "").toLowerCase();
  if (d.startsWith("type text into select")) return "select";
  if (d.startsWith("type text into input") || d.startsWith("type text into textarea")) return "fill";
  return "click";
}

/* ------------------------------------------------------------------ 组合指令解释器（S3） */

/** 解释器的逐步状态：观察到的行集 → 数值列 → 选中下标（管线各原语读写它）。 */
interface ComposeCtx {
  rows: Array<Record<string, string>>;
  values: number[];
  index: number;
  detail: Record<string, unknown>;
}

/** `extract_rows`：一次 $$eval 读行 × 声明的字段选择器（观察，不是猜测）。 */
async function composeExtractRows(
  page: unknown, cfg: ListExtract, ctx: ComposeCtx,
): Promise<string | null> {
  const rows = await (page as {
    $$eval: (sel: string, fn: (rs: unknown[], f: unknown) => unknown, arg: unknown) => Promise<unknown>;
  }).$$eval(cfg.row_sel, (rs, f) => rs.map((r) => {
    const el = r as {
      textContent?: string | null;
      querySelector: (sel: string) => { textContent?: string | null } | null;
    };
    const out: Record<string, string> = {};
    for (const [name, spec] of Object.entries(f as Record<string, { sel: string } >)) {
      const node: { textContent?: string | null } | null = spec.sel ? el.querySelector(spec.sel) : el;
      out[name] = node ? String(node.textContent ?? "").trim() : "";
    }
    return out;
  }), cfg.fields) as Array<Record<string, string>>;
  ctx.rows = rows;
  ctx.detail.rows = rows.length;
  if (!rows.length) return "no rows matched row_sel";
  return null;
}

/** `select`：数值列解析 + 声明规则的 `min|max`（走 bindings/datasource 那一份实现）。 */
function composeSelect(op: "min" | "max", by: string, cfg: ListExtract, ctx: ComposeCtx): string | null {
  ctx.values = ctx.rows.map((r) => {
    const raw = String(r[by] ?? "");
    if (cfg.fields[by]?.op === "int") {
      const n = Number(raw.replace(/[^\d-]/g, ""));
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  });
  if (ctx.values.some((v) => Number.isNaN(v))) {
    return `field ${JSON.stringify(by)} did not parse as a number on every row`;
  }
  // "选哪一行"不是模型判断，也不在这里另写一套：这条声明（`{from:"list", by, order}`）
  // 由数据槽层 `bindings.resolveBinding` 解析，它内部调的仍是 datasource 引擎的同一个
  // `selectIndex`（`selects` / `list_step` / 命令绑定共用一份实现），min/max 只是 order 的值。
  const numeric: Array<Record<string, unknown>> = ctx.rows.map((r, i) => ({ ...r, [by]: ctx.values[i] }));
  const bound = resolveBinding({ from: "list", by, order: op }, { rows: numeric });
  if (!bound.ok) return bound.reason;
  ctx.index = bound.index ?? -1;
  // detail 的键与顺序照旧（报告与 pilot 测试钉着 chosen/chosen_index/values）。
  ctx.detail.op = op; ctx.detail.by = by;
  ctx.detail.chosen = ctx.rows[ctx.index]; ctx.detail.chosen_index = ctx.index;
  ctx.detail.values = ctx.values;
  return null;
}

/** `act_on_row`：点选中行的动作句柄（行选择器来自档案声明，不是模型发明）。 */
async function composeActOnRow(page: unknown, cfg: ListExtract, ctx: ComposeCtx): Promise<string | null> {
  const rowLoc = (page as {
    locator: (sel: string) => {
      nth: (i: number) => {
        click: (o: unknown) => Promise<void>;
        locator: (sel: string) => { first: () => { click: (o: unknown) => Promise<void> } };
      };
    };
  }).locator(cfg.row_sel).nth(ctx.index);
  const target = cfg.act_sel ? rowLoc.locator(cfg.act_sel).first() : rowLoc;
  await target.click({ timeout: 5000 });
  try {
    await (page as { waitForLoadState: (s: string, o?: unknown) => Promise<void> })
      .waitForLoadState("domcontentloaded", { timeout: 3000 });
  } catch {
    /* the click may not navigate; the signal decides */
  }
  return null;
}

/**
 * list_step：浏览器步内的数据腿——S3 起**按注册表声明的管线执行**：`list_pick.compose`
 * 的原语序决定解释顺序（extract_rows → select → act_on_row），参数永远来自声明
 * （模板 list_step 的 op/by × 档案 list_extract），解释器不发明任何东西（红线②）。
 * "判断最低价"是数据规则（min/max 走 bindings/datasource 那一份 `selectIndex`），
 * 点击之后照旧由 DOM/URL 信号验收（红线③）。
 */
export async function runListStep(
  page: unknown, step: CompiledStep, _verbose = true,
): Promise<ListStepOutcome> {
  const { cfg, op, by } = step.list!;
  const pipeline = getInstruction("list_pick")?.compose ?? [];
  if (pipeline.length === 0) {
    return { done: false, detail: {}, error: "list_pick compose declaration missing (engine invariant broken)" };
  }
  const ctx: ComposeCtx = { rows: [], values: [], index: -1, detail: {} };
  try {
    for (const primitive of pipeline) {
      const err = primitive === "extract_rows" ? await composeExtractRows(page, cfg, ctx)
        : primitive === "select" ? composeSelect(op, by, cfg, ctx)
        : await composeActOnRow(page, cfg, ctx);
      if (err !== null) return { done: false, detail: ctx.detail, error: err };
    }
    for (let k = 0; k < 5; k++) {
      if (await checkSignal(page as never, step.signal)) {
        ctx.detail.settled_after = `${(k + 1) * 120}ms`;
        return { done: true, detail: ctx.detail };
      }
      await sleep(120);
    }
    return { done: false, detail: ctx.detail, error: "completion signal never held after the click" };
  } catch (e) {
    return { done: false, detail: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------------------------------------------ 运行 */

export interface FlowStepResult {
  id: string;
  desc: string;
  kind: "browser" | "list";
  status: "done" | "blocked" | "skipped" | "refused";
  attempts: number;
  /** 本步 trace 里出现过的决策方法（按序）。 */
  methods: string[];
  /** 本步以"已学 hint 规则命中"完成（重放证据）。 */
  hint_used: boolean;
  /** 本步回填了新 hint（③→档案）。 */
  backfilled: boolean;
  obstacle: string | null;
  detail: Record<string, unknown> | null;
  /**
   * NL Flow S2：本步的提名（仅 `nominate: true` 的步有）——梯级选出的指令与命中档
   * （`locked` = 模板的 `instr` 锁）。元素动作的提名**不落盘**：可复现重放的证据是
   * hint 环的，不是指令环的——报告如实显示，绝不假装它被持久化了。
   */
  nominated?: { instruction: string | null; via: string };
}

/** 一个被报为 drift 的已学 hint（连续 N 次没让信号成立 → 撤下、下次重新学）。 */
export interface DriftNote {
  step: string;
  hint: string;
  failures: number;
}

export interface FlowRunResult {
  app: string;
  site: string;
  site_label: string;
  goal: string;
  laya: string;
  escalate: string;
  /**
   * P0 层级行——**真**跑在哪一层：`on`（ONNX 面且三件齐）/ `off(missing)`（请求了 onnx 但产物不齐）/
   * `off(scripted)`（离线替身）/ `off(rules-only)`（`--laya none` 纯规则面）。
   * 与 pack 的 `model_status` 同一词汇、同一出处（`src/model-artifacts.ts`）。
   */
  model_status: string;
  /** 本站档案决定的 checkpoint（§3：复用 Router 的文字系统路由结论）。 */
  checkpoint: string;
  locale: string | null;
  steps: FlowStepResult[];
  invariants: AppInvariantResult[];
  counts: { rule: number; laya: number; escalate: number; list: number; refused: number; blocked: number; backfilled: number };
  /** 回填门：none（没有新回填）/ verified（整跑重放全部通过）/ unverified（有条目没通过、未落盘）/ skipped（显式关门，按现状落盘未验证）。 */
  backfill_gate: "none" | "verified" | "unverified" | "skipped";
  /** 过了重放门、真的落盘的语义步（= 报告里的 written back）。 */
  verified_backfill: string[];
  /** 回填了但重放门没过 → 撤回、未落盘（红线 2："不可复现即不存"）。 */
  unverified_backfill: string[];
  /** 连续失败达到阈值、已撤下的已学 hint（§5 的 drift 语义）。 */
  drift: DriftNote[];
  /**
   * NL Flow S3：声明 `next` 的模板才带这三样（缺省等价——无边模板的结果 JSON 一字不加）：
   * 环上界的结构化停因、每步进入次数、被边跨过的步（记 skipped 的那一半事实）。
   */
  path_stop?: { code: "next_cycle"; step_id: string; visits: number; detail: string };
  path_visits?: Record<string, number>;
  path_crossed?: string[];
  /**
   * NL Flow S4：提名账单（仅 `nominate` 步在场时）——各档出场数 + 指令回填门的
   * 落盘/撤回 + drift 数。dead rung 自报：哪档从没出场一眼可见。
   */
  nominate_bill?: {
    via: Record<string, number>; committed: number; dropped: number; drift: number;
    /** ③ 运行期接线的模型账（缺字段 = 没接 provider）。 */
    model?: { asks: number; abstains: number; errors: number };
  };
  /** S2 ③ 运行期接线：本次用的决策 provider 身份（缺字段 = 没接）。 */
  nominate_provider?: { name: string; version: string };
  /**
   * NL Flow S3：模板声明了 `gives` 时的运行级数据集**审计视图**（全部条目，含被重跑
   * 失效的陈旧世代——审计面看得见历史，`read` 面只认最新）。缺字段 = 没有 gives。
   */
  dataset_view?: DatasetEntry[];
  line: string;
  profile_path: string;
  ok: boolean;
  secs: number;
}

export interface FlowRunOptions {
  slots?: Record<string, unknown>;
  /** 学习档案目录（默认 REPO/sites；测试指向临时目录）。 */
  profileDir?: string;
  /** 模板根目录（默认 REPO/apps）；plan 的重放门控从 staging 目录读。 */
  appsDir?: string;
  /** 忽略已学档案（重演"第一次迁移"）。 */
  fresh?: boolean;
  /** ②级决策者：scripted=语义替身(0.71)；unsure=语义替身但永远不过闸(0.05)；onnx=真模型；none=纯规则（同 app-runner 的 `--ablate rules-only`）。 */
  laya?: "scripted" | "unsure" | "onnx" | "none";
  /** ③级老师：scripted=语义替身；llm=llmEscalator(OPENAI_*）；none=无。 */
  escalate?: "scripted" | "llm" | "none";
  allowDangerous?: boolean;
  /**
   * 危险步的确认门：收到**干跑证据**（这一步会点到什么、可否点）后决定放不放行。
   * 红线 3：不可逆动作先 dry-run 再看证据，永远不在无人值守里下单。
   */
  confirmDangerous?: (step: CompiledStep, evidence: DryRunEvidence) => boolean | Promise<boolean>;
  /** 回填门（红线 2）：新回填的 hint 必须过"整跑零模型重放"才落盘。默认 ON。 */
  verifyBackfill?: boolean;
  /** 已学 hint 连续失败多少次算 drift（默认 2）。 */
  driftLimit?: number;
  sessionFactory?: () => Promise<BrowserSession>;
  /**
   * **有头运行**（CLI `--headful`）：浏览器窗口可见。默认关 = 与今天逐字节等价（headless）。
   * 窗口出现在跑引擎的那台机器上（服务器需真实显示器或 Xvfb + VNC/noVNC）。
   */
  headful?: boolean;
  verbose?: boolean;
  outDir?: string;
  /**
   * S2 ③ **运行期接线**（用户裁定：允许收窄元素池 / 纯运行期不回填 / 仅 nominate 步）。
   * 传入一个决策 provider（如 `--nominate-provider token-plan`）后：仅对 `nominate: true` 且没有
   * `instr` 锁的步，在 ②学习映射、①规则都弃权时，用**页面状态 + 页面条件化候选**问它一次；
   * 提名来自模型（`via=model`）且是元素动作族时，把它作为**软先验**交给执行器：候选池按该族
   * 排序（其他族元素仍在候选与上下文里），只有解析出的动作族与提名不符时才做**一次有界修复**
   * （窄池重解析）；修复仍不成立 ⇒ 结构化停因（绝不执行与提名矛盾的动作）。
   * 缺省 null = 不接线，行为逐字节不变。
   */
  nominateProvider?: DecisionProvider | null;
  /**
   * 是否把学习档案写到 `profileDir`。`false`（plan 的重放门控用）= 一个字都不写：
   * 回填门照跑、报告照报"哪几条过了门"，但磁盘不动、`profile_path` 为空。
   */
  writeProfile?: boolean;
}

/** ②级替身：对每步的语义目标在 criteria view 里做分层匹配（离线扮演 laya 的角色）。
 *  形状无关——编译后的步骤与规划期的提议都喂得进（只要带 desc + targets）。 */
export function scriptedSemanticAgent(
  steps: Array<{ desc: string; targets: SemanticTarget[] }>, unsure: boolean,
): DecisionAgent {
  const cursor = new Map<string, number>();
  const conf = unsure ? 0.05 : 0.71;
  return scriptedAgent((key, state, questions) => {
    if (key === "r") return { noul: 0.05 };                       // 风险：无
    if (key === "d") return { noul: 0.0 };                        // noul 判断：永不宣称完成
    if (key !== "act") return undefined;
    const goal = String((state as Record<string, unknown>)["goal"] ?? "");
    // 惰性查表：plan 阶段这个数组是随演示增长的，快照式 Map 会永远看不见后来的步。
    const targets = steps.find((s) => s.desc === goal)?.targets;
    if (!targets || !targets.length) return undefined;
    const crit = ((questions["act"] as Question | undefined)?.criteria ?? {}) as Record<string, string>;
    const i = cursor.get(goal) ?? 0;
    for (let k = 0; k < targets.length; k++) {
      const t = targets[(i + k) % targets.length]!;
      const ref = matchSemanticTarget(t, crit);
      if (ref !== null) {
        cursor.set(goal, (i + k + 1) % targets.length);
        return { choice: ref, probabilities: { [ref]: 1 }, confidence: conf };
      }
    }
    return undefined;   // 老师替身也没认出来 → 执行器按"没有可用元素"如实阻塞
  });
}

/** ③级老师替身：与执行器同一个 criteria view 上做语义匹配（LLM 老师的离线替身）。 */
export function scriptedTeacher(
  steps: Array<{ desc: string; targets: SemanticTarget[] }>,
): EscalatorLike {
  return (req: { instruction: string; criteria: Record<string, string> }) => {
    const targets = steps.find((s) => s.desc === req.instruction)?.targets;   // 惰性，同 agent
    if (!targets) return null;
    for (const t of targets) {
      const ref = matchSemanticTarget(t, req.criteria);
      if (ref !== null) return ref;
    }
    return null;
  };
}

/* ------------------------------------------------------------------ 危险步干跑 */

/** 一次危险步干跑的证据：解析到哪个元素、能不能点、页面停在哪。 */
export interface DryRunEvidence {
  step: string;
  desc: string;
  /** 干跑真的解析出目标且可点（false 时 `stop_reason` 说明为什么）。 */
  actionable: boolean;
  /** 解析级（rule:match / laya / escalate）——重放门也看它。 */
  method: string | null;
  /** 会点到什么（`<tag> "<label>"`）。 */
  would: string | null;
  url: string | null;
  stop_reason: string;
  /** 报告面把它当普通 detail 用（`Record<string, unknown>` 的形状）。 */
  [k: string]: unknown;
}

/**
 * 危险步的干跑：走**完整**的三级解析（已学 hint → laya → escalate）+ 只读
 * actionability 探针，但绝不做动作（执行器的 `dryRun` 在 pre-fill/occlusion 之前就停）。
 * 红线 3：给"人确认"的是这份证据，而不是一句"要点了"。
 */
async function dryRunStep(
  mw: BrowserMiddleware, step: CompiledStep, plan: TaskPlan,
  session: BrowserSession, verbose: boolean,
): Promise<DryRunEvidence> {
  const bsg = step.sg!;
  const rep = await mw.run(bsg.desc, bsg.start_url ?? "", {
    goalSignalFn: (p) => checkSignal(p as never, bsg.signal),
    slots: { ...extractSlots(plan.goal), ...plan.slots, ...(bsg.slots ?? {}) },
    page: session.page as never, pw: session.pw as never,
    precondition: bsg.when ?? null,
    dryRun: true, verbose,
  });
  const t = ((rep.steps ?? []) as Array<Record<string, unknown>>)
    .find((s) => s["dry_run"] === true);
  return {
    step: step.id, desc: bsg.desc,
    actionable: rep.dry_run === true && t?.["actionable"] === true,
    method: (t?.["method"] as string | undefined) ?? null,
    would: (t?.["would"] as string | undefined) ?? null,
    url: (t?.["url"] as string | undefined) ?? null,
    stop_reason: rep.stop_reason,
  };
}

/** 跑一条语义模板在某个站点上的完整旅程。返回结构化结果（报告由调用方决定）。 */
export async function runFlow(
  appId: string, siteKey: string, opts: FlowRunOptions = {},
): Promise<FlowRunResult> {
  const {
    slots = {}, fresh = false, laya = "scripted", escalate = "scripted",
    allowDangerous = false, verbose = true, writeProfile = true,
  } = opts;
  const t0 = Date.now();
  const template = loadTemplate(appId, opts.appsDir);
  const tProblems = validateTemplate(template);
  if (tProblems.length) throw new Error(`semantic template ${appId} is invalid:\n  - ${tProblems.join("\n  - ")}`);
  const profile = loadSiteProfile(appId, siteKey, opts.appsDir);
  const pProblems = validateProfile(profile, template);
  if (pProblems.length) throw new Error(`site profile ${appId}/${siteKey} is invalid:\n  - ${pProblems.join("\n  - ")}`);

  const store = new LearnedStore(opts.profileDir ?? path.join(REPO, "sites"));
  const learnedOnDisk = fresh ? {} as Record<string, LearnedStepEntry> : store.load(siteKey).steps;
  const compiled = compileFlow(template, siteKey, profile, slots);
  // 回填门（红线 2）：新 hint 先进内存，整跑重放通过才落盘（writeProfile=false 时
  // 连落盘都不发生——plan 的门控跑真实回填环，但不碰正式档案）。
  const memory = new SiteProfileMemory(store, siteKey, profile.steps ?? {}, {
    staged: true, readOnly: writeProfile === false,
  });
  memory.registerSteps(compiled.steps.map((s) => [s.desc, s.id] as [string, string]));
  const knownBefore = new Set(Object.keys(memory.getSteps()));
  // NL Flow S2：指令记忆（有 nominate 步才建；与 hint 记忆同库同段、staged 回填门照旧）。
  const hasNominate = compiled.steps.some((s) => s.nominate);
  const instrMemory = hasNominate
    ? createInstructionMemory(store, siteKey, { staged: true, readOnly: writeProfile === false })
    : null;
  const learnedOnDiskInstr = fresh
    ? {} as Record<string, string>
    : Object.fromEntries(Object.entries(store.load(siteKey).instructions ?? {})
      .map(([k, v]) => [k, v.instruction]));
  // NL Flow S3 数据集生产面：有步声明 `gives` 才建生产者（缺省零开销、结果也不带
  // dataset_view——缺字段等价纪律）。写入发生在**信号成立之后**；重跑（指令重放门）
  // 先失效旧写入再重写（§2.3 规则 3：陈旧世代不可读）。
  const dataset = compiled.steps.some((s) => s.gives?.length) ? createDataset() : null;
  // §3 文字系统路由：站点档案的 checkpoint 优先（plan 观察来的，或人手写的），
  // 否则模板的 model，最后 english——"中文站用多语 checkpoint"因此是数据不是代码。
  const checkpoint = profile.checkpoint ?? template.model ?? "english";

  // ②级与③级的决策者装好（离线替身、真模型/LLM，或 none=纯规则面）。
  const noneRuntime = (): ReturnType<typeof scriptedRuntime> =>
    // 与 app-runner 的 `--ablate rules-only` 同口径：不装 runtime，规则消化一切——
    // 规则没命中的步如实 blocked，而不是崩溃。
    scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 })));
  if (laya === "onnx") {
    const { createLayaOnnxRuntime } = await import("./laya-onnx.ts");
    installLayaRuntime(createLayaOnnxRuntime());
  } else if (laya === "none") {
    installLayaRuntime(noneRuntime());
  } else {
    installLayaRuntime(scriptedRuntime(scriptedSemanticAgent(compiled.steps, laya === "unsure")));
  }
  let escalateFn: EscalatorLike | null = null;
  if (laya !== "none" && escalate === "scripted") escalateFn = scriptedTeacher(compiled.steps);
  else if (laya !== "none" && escalate === "llm") escalateFn = llmEscalator();

  const browserSteps = compiled.steps.filter((s) => s.sg !== null).map((s) => s.sg!);
  const plan = new TaskPlan(template.goal, browserSteps, ":memory:", compiled.slots);
  const rules = new PlanningRules(Math.max(8, template.steps.length), true, false);
  const planProblems = rules.problems(plan);
  if (planProblems.length) {
    installLayaRuntime(null);
    throw new Error(`compiled plan is invalid:\n  - ${planProblems.join("\n  - ")}`);
  }

  const mwOpts = {
    modelId: checkpoint,
    auditor: new MockAuditor(),
    maxSteps: 8,
    confFloor: 0.25,
    riskyThreshold: 0.6,
    doneThreshold: 0.5,
    // 语义层的危险闸在这里（模板 `dangerous`）；执行器自己的风险闸照旧记录不阻断。
    confirmFn: () => true,
  };
  const mw = new BrowserMiddleware({ ...mwOpts, escalateFn, hintMemory: memory, dataset });

  const own = opts.sessionFactory === undefined;
  const session = own ? await browserSession(opts.headful !== true) : await opts.sessionFactory!();
  const results: FlowStepResult[] = [];
  const drift: DriftNote[] = [];
  // NL Flow S2：元素动作提名的记录面（step id → {instruction, via}；不落盘，见 FlowStepResult.nominated）。
  const nominatedOf = new Map<string, { instruction: string | null; via: string }>();
  // S2 ③ 运行期接线：仅 nominate 步、仅 ②①弃权时问；这里记模型账（咨询/弃权/降级）。
  const nominateProvider = opts.nominateProvider ?? null;
  let modelAsks = 0;
  let modelAbstains = 0;
  let modelErrors = 0;
  const driftLimit = opts.driftLimit ?? 2;
  let backfillGate: FlowRunResult["backfill_gate"] = "none";
  let committed: string[] = [];
  let dropped: string[] = [];
  // NL Flow S4：指令回填门的账（提名账单用）。
  let instrCommitted = 0;
  let instrDropped = 0;
  try {
    // NL Flow S3：走向 = 声明边（`next`）+ 候选步自己的 `when`；无边的模板 = 顺序遍历，
    // 行为与今天逐字节相同（walk.after 无边时就是 i+1）。
    const walk = createPathWalk(compiled.steps, template.max_step_visits ?? DEFAULT_MAX_STEP_VISITS);
    const ranIdx = new Set<number>();
    const pathCrossed: string[] = [];
    let pathStop: FlowRunResult["path_stop"];
    const hasEdges = compiled.steps.some((s) => s.next !== undefined);
    let i = 0;
    const runOne = async (step: CompiledStep): Promise<void> => {
      // ---- 红线 3：不可逆动作先 DRY-RUN，再要人确认；默认拒绝 --------------
      let dryEvidence: DryRunEvidence | null = null;
      if (step.dangerous) {
        dryEvidence = await dryRunStep(mw, step, plan, session, verbose);
        if (!dryEvidence.actionable) {
          // 干跑本身不成立（目标解析不出来/被覆盖/禁用）→ 绝不执行。
          results.push({
            id: step.id, desc: step.desc, kind: step.kind, status: "refused", attempts: 0,
            methods: [], hint_used: false, backfilled: false,
            obstacle: `dry-run 未通过：${dryEvidence.stop_reason}`, detail: { dry_run: dryEvidence },
          });
          if (verbose) console.log(`  [${step.id}] 危险步干跑未通过 —— ${dryEvidence.stop_reason}`);
          return;
        }
        let allowed = allowDangerous === true;
        if (!allowed && opts.confirmDangerous) allowed = await opts.confirmDangerous(step, dryEvidence);
        if (!allowed) {
          results.push({
            id: step.id, desc: step.desc, kind: step.kind, status: "refused", attempts: 0,
            methods: [], hint_used: false, backfilled: false,
            obstacle: REFUSAL_LABELS.dangerous, detail: { dry_run: dryEvidence, approved: false },
          });
          if (verbose) console.log(`  [${step.id}] ${REFUSAL_LABELS.dangerous} —— ${step.desc}`);
          return;
        }
        if (verbose) {
          console.log(`  [${step.id}] 危险步放行（干跑证据：${dryEvidence.method} ${dryEvidence.would}）`);
        }
      }
      if (step.kind === "list") {
        if (verbose) console.log(`  [${step.id}] ${step.desc} (list: ${step.list!.op} by ${step.list!.by})`);
        const out = await runListStep(session.page, step, verbose);
        results.push({
          id: step.id, desc: step.desc, kind: "list",
          status: out.done ? "done" : "blocked", attempts: 1,
          methods: out.done ? ["list"] : [], hint_used: false, backfilled: false,
          obstacle: out.done ? null : (out.error ?? "list step failed"), detail: out.detail,
        });
        if (verbose) {
          console.log(`  [${step.id}] -> ${out.done ? "done" : `BLOCKED (${out.error})`}`
            + (out.done ? ` ${JSON.stringify(out.detail.chosen)}` : ""));
        }
        if (out.done && dataset && step.gives?.length) {
          dataset.write(step.gives[0], out.detail["chosen"], step.id);   // 信号成立之后才写
        }
        return;
      }
      const bsg = step.sg!;
      // ---- NL Flow S2：提名步——梯级裁"这次用哪个指令" -------------------------
      // list_pick 候选走数据腿（op/by/act 是声明的数据规则，梯级只裁用不用——红线②）；
      // 元素动作走既有浏览器支线（元素解析是执行器自己的梯级）。`instr` 锁 = 候选集坍缩。
      if (step.nominate) {
        // 键 = 语义步 id（学习档案按站点一份，与 hint 记忆同一键法；应用归属由档案路径承载）
        const instrKey = step.id;
        let ask: NominationAsk | null = null;
        if (!step.instr && nominateProvider !== null) {
          // ③ 运行期接线（用户裁定：仅 nominate 步 / 纯运行期不回填 / 提名族作软先验+有界修复）：
          // 提问前把页面**按本步 URL 守卫导航**到 start 页并抓只读上下文——提名发生在
          // 执行器导航之前，不补这一步拿到的就是上一步的落点（S0 的教训：没有上下文别问）。
          // 抓不到上下文 ⇒ 不提问（ask=null），梯级按 ②①⑤ 继续，行为与没接线一致。
          try {
            if (urlOf(session.page as never) !== step.url) {
              await (session.page as unknown as { goto(u: string, o?: unknown): Promise<unknown> }).goto(
                step.url, { waitUntil: "domcontentloaded", timeout: 30_000 },
              );
            }
            const pageState: StepStateView | null = await captureStepStateView(session.page as never);
            const baseAsk = contextualProviderNominationAsk(nominateProvider, pageState);
            if (baseAsk !== null) {
              ask = async (desc, options) => {
                modelAsks += 1;
                try {
                  const r = await baseAsk(desc, options);
                  if (r === null) modelAbstains += 1;
                  return r;
                } catch (e) {
                  modelErrors += 1;      // 降级到 ⑤：错误由梯级兜成该档弃权，不打死旅程
                  throw e;
                }
              };
            }
          } catch { ask = null; }
        }
        const nom: { instruction: string | null; via: "rule" | "learned" | "model" | "teacher" | "enumerate" | "locked" } = step.instr
          ? { instruction: step.instr, via: "locked" }
          : await nominateInstruction({ desc: step.desc, stepKey: instrKey, memory: instrMemory, ask });
        if (verbose) console.log(`  [${step.id}] 提名：${nom.instruction} (${nom.via})`);
        if (nom.instruction === "list_pick" && step.list_candidate) {
          const listExec: CompiledStep = { ...step, kind: "list", list: step.list_candidate };
          // 既有模板的 list 步靠前一步落到列表页；提名步可能就是旅程第一步——
          // 按本步 URL 守卫导航（domcontentloaded 纪律），不把"页面不在"误报成"没有行"。
          if (urlOf(session.page) !== listExec.url) {
            await session.page.goto(listExec.url, { waitUntil: "domcontentloaded" });
          }
          if (verbose) console.log(`  [${step.id}] ${step.desc} (list: ${listExec.list!.op} by ${listExec.list!.by})`);
          const out = await runListStep(session.page, listExec, verbose);
          results.push({
            id: step.id, desc: step.desc, kind: "list",
            status: out.done ? "done" : "blocked", attempts: 1,
            methods: out.done ? ["list"] : [], hint_used: false, backfilled: false,
            obstacle: out.done ? null : (out.error ?? "list step failed"), detail: out.detail,
            nominated: { instruction: nom.instruction, via: nom.via },
          });
          if (out.done) {
            // 提名让信号成立 → 候选映射进指令记忆（staged；重放门在旅程末尾统一裁决）。
            // **③ 运行期接线是纯运行期**（用户裁定）：模型提名不写学习记忆——否则下一跑就会
            // 以 ② 命中（"学到的"），把一次在线咨询悄悄变成持久配置。规则/档案档照旧。
            if (nom.via !== "model") instrMemory?.recordInstruction(instrKey, "list_pick", nom.via);
            if (dataset && step.gives?.length) dataset.write(step.gives[0], out.detail["chosen"], step.id);
          }
          // blocked 的失败计数**只在旅程末尾的 drift 块记一次**（与 hint 块同一模式——
          // 这里再记就是双计，阈值会被一次运行打穿）。
          return;
        }
        // 元素动作提名：via 记进结果。**不落盘**——可复现重放的证据是 hint 环的，
        // 元素动作的提名没有等价证据（绝不假装它被持久化了）。
        nominatedOf.set(step.id, { instruction: nom.instruction, via: nom.via });
      }
      if (verbose) console.log(`  [${step.id}] ${bsg.desc}`);
      // S2 ③ 收窄：只有**模型提名**的元素动作族才窄（用户裁定"允许 ③ 真正收窄元素池"）。
      // 规则/档案/枚举档保持既有行为（缺省等价：没接 provider 时这条永远为空）。
      const modelNom = nominatedOf.get(step.id);
      const elemFamily = modelNom?.via === "model" && (modelNom.instruction === "click" || modelNom.instruction === "fill"
        || modelNom.instruction === "select" || modelNom.instruction === "check")
        ? (modelNom.instruction as ElemFamily) : null;
      const { rep, attempt } = await runSubgoalWithRetries(
        mw as never, bsg, plan, bsg.start_url ?? "", session.page, session.pw, verbose,
        elemFamily !== null ? { expectedFamily: elemFamily } : {});
      const methods = ((rep.steps ?? []) as Array<{ method?: string }>)
        .map((t) => t.method ?? "").filter(Boolean);
      // ---- S3 元素动作强制（复核发现 8）：提名/锁定说出的指令，必须由页面**真实执行的动作
      // 族**背书——check ≡ click（执行器同一点击路径，trace 分不开它们；声明等价而非假装能分）。
      // 不一致 = 结构化 blocked（绝不绿着把"没照做"记成"做完了"）。
      let forceViolation: string | null = null;
      const nomRec = nominatedOf.get(step.id);
      if (step.nominate && nomRec?.instruction && !rep.skipped) {
        const fam = firstExecFamily(((rep.steps ?? []) as Array<Record<string, unknown>>));
        const want = nomRec.instruction === "check" ? "click" : nomRec.instruction;
        if (fam !== null && fam !== want) {
          forceViolation = `instruction_not_honored: nominated ${JSON.stringify(nomRec.instruction)}, page action was ${fam}`;
          if (verbose) console.log(`  [${step.id}] ${forceViolation}`);
        }
      }
      const hintUsed = knownBefore.has(step.id) && rep.done && forceViolation === null
        && !rep.skipped && methods.includes("rule:match");
      if (hintUsed) memory.countReplay(step.id);
      results.push({
        id: step.id, desc: bsg.desc, kind: "browser",
        status: rep.done && forceViolation === null ? (rep.skipped ? "skipped" : "done") : "blocked",
        attempts: attempt, methods,
        hint_used: hintUsed, backfilled: memory.recordedThisRun.has(step.id),
        obstacle: forceViolation ?? (rep.done ? null : rep.stop_reason), detail: dryEvidence,
        ...(nominatedOf.has(step.id) ? { nominated: nominatedOf.get(step.id) } : {}),
      });
      // 回填来源标注（报告面）：本步走过 escalate 就是老师点名，否则是 laya 现场。
      if (memory.recordedThisRun.has(step.id)) {
        memory.labelMethod(step.id, methods.includes("escalate") ? "escalate" : "laya");
      }
    };
    // ---- 走向驱动：声明边（next）+ 候选步自己的 when；环上界 = next_cycle 结构化停因
    while (i < compiled.steps.length) {
      const over = walk.enter(i);
      if (over !== null) {
        pathStop = {
          code: "next_cycle", step_id: over.id, visits: over.visits,
          detail: `step ${JSON.stringify(over.id)} was entered ${over.visits} time(s) in one run`
            + ` (per-path bound max_step_visits=${template.max_step_visits ?? DEFAULT_MAX_STEP_VISITS})`
            + " — a declared next edge forms a cycle; stopping instead of looping forever",
        };
        if (verbose) console.log(`  [journey] ${pathStop.detail}`);
        break;
      }
      ranIdx.add(i);
      await runOne(compiled.steps[i]!);
      const from = i;
      i = await walk.after(i, async (j) => {
        const cand = compiled.steps[j]!;
        const when = cand.sg?.when ?? null;
        if (!when) return true;                      // 没声明 when 的候选：声明即适用
        return await checkSignal(session.page as never, when);
      });
      if (i > from + 1) {
        for (let k = from + 1; k < i; k++) {
          const crossed = compiled.steps[k]!;
          pathCrossed.push(`${crossed.id ?? `#${k}`} (crossed by \`next\` from ${compiled.steps[from]!.id ?? `#${from}`})`);
          if (verbose) console.log(`  [journey] step ${crossed.id ?? `#${k}`} crossed by a declared next edge -> skipped`);
        }
      }
    }
    // 被边跨过且从未进入的步：没有结果 = 没执行 → 记 skipped（边就是作者对
    // "这条路径上它不适用"的声明；P4 的同一条语义）。后来经回边进入的步有真实结果。
    compiled.steps.forEach((s, k) => {
      if (ranIdx.has(k)) return;
      results.push({
        id: s.id, desc: s.desc, kind: s.kind, status: "skipped", attempts: 0,
        methods: [], hint_used: false, backfilled: false,
        obstacle: "crossed by a declared next edge", detail: null,
      });
    });

    // ---- §5 drift：本次运行前已在盘上的 hint，这一步却没让信号成立 -----------------
    for (const r of results) {
      if (!(r.id in learnedOnDisk)) continue;         // 只对"被信任过的"条目判 drift
      if (r.status !== "blocked") continue;
      const failures = memory.countFailure(r.id);
      if (failures >= driftLimit) {
        const hint = memory.dropHint(r.id);
        if (hint) {
          drift.push({ step: r.id, hint, failures });
          if (verbose) {
            console.log(`  [${r.id}] drift：已学 hint ${hint} 连续 ${failures} 次没让信号成立 → 撤下`);
          }
        }
      }
    }

    // ---- NL Flow S2 drift：同一套纪律用在已学指令上（list_pick 是唯一可执行判定的轴）--
    for (const r of results) {
      if (!(r.id in learnedOnDiskInstr)) continue;
      if (r.status !== "blocked") { instrMemory?.resetFailures(r.id); continue; }
      const failures = instrMemory?.countFailure(r.id) ?? 0;
      if (failures >= driftLimit) {
        const gone = instrMemory?.dropInstruction(r.id);
        if (gone) {
          drift.push({ step: r.id, hint: gone, failures });
          if (verbose) {
            console.log(`  [${r.id}] drift：已学指令 ${gone} 连续 ${failures} 次没让信号成立 → 撤下`);
          }
        }
      }
    }

    // 不变量断言在**本次真实旅程**的结束状态上（不是重放之后的状态）。
    const invariants: AppInvariantResult[] = [];
    for (const [i, inv] of compiled.invariants.entries()) {
      const held = await checkSignal(session.page as never, inv);
      invariants.push({ id: `inv${i}`, desc: JSON.stringify(inv), held });
      if (verbose) console.log(`  invariant inv${i}: ${held ? "held" : "VIOLATED"}`);
    }

    // ---- 回填门（红线 2）：整跑零模型重放一次，只有真的靠新 hint 完成的条目才落盘 -----
    const stagedIds = memory.stagedSteps();
    if (stagedIds.length && opts.verifyBackfill !== false) {
      installLayaRuntime(noneRuntime());               // 重放必须零模型：裁决的是 hint，不是模型
      const mwReplay = new BrowserMiddleware({ ...mwOpts, escalateFn: null, hintMemory: memory });
      const verified = new Set<string>();
      for (const step of compiled.steps) {
        if (!stagedIds.includes(step.id) || step.sg === null) continue;
        const bsg = step.sg;
        if (step.dangerous) {
          // 危险步的重放只到"干跑解析"为止——证明 hint 可复现，且绝不真点。
          const ev = await dryRunStep(mwReplay, step, plan, session, false);
          if (ev.actionable && ev.method === "rule:match") verified.add(step.id);
          continue;
        }
        const { rep } = await runSubgoalWithRetries(
          mwReplay as never, bsg, plan, bsg.start_url ?? "", session.page, session.pw, false);
        const methods = ((rep.steps ?? []) as Array<{ method?: string }>).map((t) => t.method ?? "");
        if (rep.done && !rep.skipped && methods.includes("rule:match")) verified.add(step.id);
      }
      ({ committed, dropped } = memory.commitVerified(verified));
      backfillGate = dropped.length ? "unverified" : "verified";
      if (verbose) {
        console.log(`  回填门：${committed.length} 条重放通过落盘`
          + (dropped.length ? `，${dropped.length} 条不可复现已撤回（${dropped.join(", ")}）` : ""));
      }
    } else if (stagedIds.length) {
      // 显式关掉门（测试/消融）：按现状落盘，replays_ok 不动——档案里如实可见"没验过"。
      committed = memory.commitAll();
      backfillGate = "skipped";
    }
    // 重放计数与 drift 计数落盘（没有新条目时也要写）。
    memory.flush();
    for (const r of results) r.backfilled = committed.includes(r.id);

    // ---- NL Flow S2 指令回填门：list_pick 是确定性数据规则——同运行重放一次，过了才落盘。
    // （元素动作的提名不进记忆：没有可复现重放证据的产物不落盘——红线 2 的同一条纪律。）
    const stagedInstr = instrMemory?.stagedSteps() ?? [];
    if (stagedInstr.length && opts.verifyBackfill !== false) {
      const verifiedInstr = new Set<string>();
      for (const step of compiled.steps) {
        if (!stagedInstr.includes(step.id) || step.list_candidate === undefined) continue;
        const listExec: CompiledStep = { ...step, kind: "list", list: step.list_candidate };
        // 重放在**当前会话的真实状态**上进行——先把页面带回本步的 URL（首次执行可能已离开）
        if (urlOf(session.page) !== listExec.url) {
          await session.page.goto(listExec.url, { waitUntil: "domcontentloaded" });
        }
        // §2.3 规则 3 的生产触发者：重跑前失效旧写入（陈旧不可读），重放的写入是新事件。
        dataset?.invalidateStep(step.id);
        const out = await runListStep(session.page, listExec, false);
        if (out.done) {
          verifiedInstr.add(step.id);
          if (dataset && step.gives?.length) dataset.write(step.gives[0], out.detail["chosen"], step.id);
        } else if (verbose) console.log(`  指令回填门：${step.id} 重放未通过（${out.error}）`);
      }
      const res = instrMemory?.commitVerified(verifiedInstr);
      instrCommitted = res?.committed.length ?? 0;
      instrDropped = res?.dropped.length ?? 0;
      if (verbose) {
        console.log(`  指令回填门：${verifiedInstr.size}/${stagedInstr.length} 条重放通过落盘`
          + `${verifiedInstr.size < stagedInstr.length ? "（未过的按原值撤回）" : ""}`);
      }
    } else if (stagedInstr.length) {
      instrCommitted = instrMemory?.commitAll().length ?? 0;
    }
    instrMemory?.flush();

    return finalize(template, siteKey, compiled, results, invariants, {
      laya, escalate, store, t0,
      profileWritten: writeProfile,
      checkpoint,
      locale: profile.locale ?? null,
      backfillGate, committed, dropped, drift,
      pathStop, pathCrossed, hasEdges, pathVisits: walk.visits(), instrCommitted, instrDropped,
      datasetView: dataset ? dataset.entriesView() : null,
      nominateProvider, modelAsks, modelAbstains, modelErrors,
    });
  } finally {
    if (own) await session.close();
    installLayaRuntime(null);
  }
}

function finalize(
  template: FlowTemplate, siteKey: string, compiled: CompiledFlow,
  results: FlowStepResult[], invariants: AppInvariantResult[],
  ctx: {
    laya: string; escalate: string; store: LearnedStore; t0: number; profileWritten: boolean;
    checkpoint: string; locale: string | null;
    backfillGate: FlowRunResult["backfill_gate"]; committed: string[]; dropped: string[];
    drift: DriftNote[];
    pathStop?: FlowRunResult["path_stop"]; pathCrossed: string[]; hasEdges: boolean;
    pathVisits: Record<string, number>;
    instrCommitted: number; instrDropped: number;
    datasetView: readonly DatasetEntry[] | null;
    /** S2 ③ 运行期接线的模型账（缺省 null = 没接 provider）。 */
    nominateProvider: DecisionProvider | null;
    modelAsks: number; modelAbstains: number; modelErrors: number;
  },
): FlowRunResult {
  let rule = 0, layaN = 0, escN = 0, listN = 0, refusedN = 0;
  for (const r of results) {
    if (r.status === "refused") refusedN += 1;
    if (r.status === "blocked") continue;
    for (const m of r.methods) {
      if (m === "rule:match") rule += 1;
      else if (m.startsWith("laya")) layaN += 1;
      else if (m === "escalate") escN += 1;
      else if (m === "list") listN += 1;
    }
  }
  const blocked = results.filter((r) => r.status === "blocked").length;
  const backfilled = ctx.committed.length;
  const counts = { rule, laya: layaN, escalate: escN, list: listN, refused: refusedN, blocked, backfilled };
  const line = `rule ${rule} · laya ${layaN} · escalate ${escN} (written back ${backfilled})`
    + ` · list ${listN} · blocked ${blocked}${refusedN ? ` · refused ${refusedN}` : ""}`
    + (ctx.drift.length ? ` · drift ${ctx.drift.length}` : "");
  // NL Flow S4：提名账单（dead-rung 自报——哪档从没出场一眼可见；仅 nominate 步在场时有）。
  const viaCounts: Record<string, number> = {};
  for (const r of results) {
    if (!r.nominated) continue;
    const v = r.nominated.via;
    viaCounts[v] = (viaCounts[v] ?? 0) + 1;
  }
  const hasNominate = Object.keys(viaCounts).length > 0;
  // ③ 的模型账：只有在接了 provider 的 run 里出现（缺字段 = 没接线，缺省等价纪律）。
  const modelSection = ctx.nominateProvider !== null
    ? { asks: ctx.modelAsks, abstains: ctx.modelAbstains, errors: ctx.modelErrors }
    : undefined;
  const nominate_bill = hasNominate
    ? {
      via: viaCounts, committed: ctx.instrCommitted, dropped: ctx.instrDropped, drift: ctx.drift.length,
      ...(modelSection ? { model: modelSection } : {}),
    }
    : undefined;
  const billLine = hasNominate
    ? ` · 提名 ${Object.entries(viaCounts).map(([k, v]) => `${k} ${v}`).join(" · ")}`
      + (modelSection && modelSection.asks > 0
        ? ` · model ${modelSection.asks}${modelSection.abstains ? `(弃权 ${modelSection.abstains})` : ""}`
          + `${modelSection.errors ? `(降级 ${modelSection.errors})` : ""}`
        : "")
      + `（指令落盘 ${ctx.instrCommitted}/撤回 ${ctx.instrDropped}）`
    : "";
  const ok = results.every((r) => r.status === "done" || r.status === "skipped")
    && invariants.every((i) => i.held)
    && ctx.pathStop === undefined;
  // P0 层级行：`laya` 是**请求的面**，`model_status` 是**真跑在哪一层**——请求 onnx 面但三件不齐
  // 就是 off(missing)（真上场时会在装载处响亮失败），离线替身面是 off(scripted)/off(rules-only)。
  // 与 pack 同一个词汇、同一个出处（`src/model-artifacts.ts`），桥与报告念同一行。
  const tier = ctx.laya === "onnx"
    ? (checkArtifacts().ready ? "on" : "off(missing)")
    : ctx.laya === "none" ? "off(rules-only)" : "off(scripted)";
  return {
    app: template.id, site: siteKey, site_label: compiled.site.label, goal: template.goal,
    laya: ctx.laya, escalate: ctx.escalate, model_status: tier,
    checkpoint: ctx.checkpoint, locale: ctx.locale,
    steps: results, invariants, counts, line: line + billLine,
    backfill_gate: ctx.backfillGate,
    verified_backfill: ctx.committed,
    unverified_backfill: ctx.dropped,
    drift: ctx.drift,
    ...(ctx.hasEdges ? {
      path_stop: ctx.pathStop,
      path_visits: ctx.pathVisits,
      path_crossed: ctx.pathCrossed,
    } : {}),
    ...(nominate_bill ? { nominate_bill } : {}),
    ...(ctx.nominateProvider !== null
      ? { nominate_provider: { name: ctx.nominateProvider.name, version: ctx.nominateProvider.version } }
      : {}),
    ...(ctx.datasetView ? { dataset_view: [...ctx.datasetView] } : {}),
    profile_path: ctx.profileWritten ? ctx.store.pathFor(siteKey) : "",
    ok, secs: Math.round((Date.now() - ctx.t0) / 100) / 10,
  };
}

/* ------------------------------------------------------------------ 报告 */

/** 结构化结果 → 人读的 Markdown（语义迁移证据：每步的解析级 + 回填 + 重放计数）。 */
export function flowReportMarkdown(r: FlowRunResult): string {
  const gate = r.backfill_gate === "none"
    ? "无新回填"
    : r.backfill_gate === "skipped"
      ? `skipped（--no-verify-backfill：${r.verified_backfill.length} 条按现状落盘、**未验证**）`
      : r.backfill_gate === "verified"
        ? `verified（${r.verified_backfill.length} 条整跑零模型重放通过后落盘）`
        : `unverified（${r.unverified_backfill.join(", ")} 重放不过 → **已撤回、未落盘**）`;
  const L: string[] = [
    `# 语义流运行报告：${r.app} @ ${r.site}（${r.site_label}）`,
    "",
    `- 目标：${r.goal}`,
    `- 决策面：laya=${r.laya} ｜ escalate=${r.escalate} ｜ checkpoint=${r.checkpoint}`
      + (r.locale ? `（locale=${r.locale}）` : ""),
    `- 模型层级：\`${r.model_status}\`（请求的面 laya=${r.laya}；on 才意味着真模型在决策）`,
    `- 结果：**${r.ok ? "通过" : "未通过"}** ｜ 步骤 ${r.steps.filter((s) => s.status === "done" || s.status === "skipped").length}/${r.steps.length} ｜ 用时 ${r.secs}s`,
    `- 解析级：${r.line}`,
    `- 回填门（红线 2）：${gate}`,
    ...(r.drift.length
      ? [`- drift（§5）：${r.drift.map((d) => `${d.step}（${d.hint}，连续 ${d.failures} 次失败）`).join("、")}`]
      : []),
    `- 站点档案：\`${r.profile_path || "(未写)"}\``,
    "",
    "| # | 语义步 | 级 | 状态 | 解析方法 | 尝试 | 已学hint | 回填 | 障碍 |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  r.steps.forEach((s, i) => {
    L.push(`| ${i} | ${s.desc.slice(0, 46)} | ${s.kind} | ${s.status} | ${s.methods.join(",") || "-"}`
      + ` | ${s.attempts} | ${s.hint_used ? "✓" : "-"} | ${s.backfilled ? "✓" : "-"} | ${s.obstacle ?? "-"} |`);
  });
  if (r.steps.some((s) => s.detail)) {
    L.push("", "<details><summary>list_step 细节（抽取列与选中行）与危险步干跑证据</summary>", "");
    for (const s of r.steps) {
      if (s.detail) L.push(`- ${s.id}: ${JSON.stringify(s.detail)}`);
    }
    L.push("", "</details>");
  }
  if (r.invariants.length) {
    L.push("", "## 验收（结束状态不变量）", "", "| 不变量 | 结论 |", "|---|---|");
    for (const i of r.invariants) L.push(`| ${i.desc} | ${i.held ? "成立" : "**不成立**"} |`);
  }
  return L.join("\n") + "\n";
}

/* ------------------------------------------------------------------ CLI */

const USAGE = `usage: semantic-flow --app ID --site KEY [--laya scripted|unsure|onnx|none]
                   [--escalate scripted|llm|none] [--slot k=v ...] [--profile-dir DIR]
                   [--fresh] [--allow-dangerous] [--no-verify-backfill] [--drift-limit N]
                   [--nominate-provider NAME] [--out DIR] [--dry] [--quiet] [--headful] [--list]

S2 ③ 运行期接线（--nominate-provider）：仅对声明 nominate: true 且无 instr 锁的步，在 ②学习映射、
①规则都弃权时，用**页面状态 + 页面条件化候选**问一次决策 provider（如 token-plan）；模型提名若是
元素动作族，则作为**软先验**（族内优先排序，不丢其他族元素/上下文）+ 解析族不符时**一次有界修复**
交给执行器（hint 仍是权威；同页无该族候选/修复不过闸 = 结构化停因）。
纯运行期、不回填指令记忆；不接 = 行为逐字节不变。provider 需显式配置（如 TOKEN_PLAN_ENDPOINT/
TOKEN_PLAN_API_KEY），缺配置响亮报错。

一份语义模板（apps/<id>/flow.json）+ 站点档案，跑通三级解析与回填环，
并在站点之间迁移。--dry 只编译不执行；--laya none 是纯规则面（同 app-runner 的 --ablate rules-only）。
危险步（购买）先干跑取证、再要 --allow-dangerous/人确认；新回填的 hint 必须过
"整跑零模型重放"才落盘（--no-verify-backfill 关掉这道门，只用于消融）。`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  // 打错的参数 → 一行点名 + usage，绝不甩 parseArgs 的堆栈（src/cli-args.ts 的体例）。
  try {
    parsed = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      list: { type: "boolean" }, app: { type: "string" }, site: { type: "string" },
      laya: { type: "string" }, escalate: { type: "string" },
      slot: { type: "string", multiple: true }, "profile-dir": { type: "string" },
      fresh: { type: "boolean" }, "allow-dangerous": { type: "boolean" },
      "no-verify-backfill": { type: "boolean" }, "drift-limit": { type: "string" },
      "nominate-provider": { type: "string" },
      out: { type: "string" }, dry: { type: "boolean" }, quiet: { type: "boolean" },
      headful: { type: "boolean" }, help: { type: "boolean" },
    },
  });
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    console.error(usageErrorLine(err));
    console.error();
    console.error(USAGE);
    return 2;
  }
  const v = parsed.values;
  if (v.help) { console.log(USAGE); return 0; }
  if (v.list || !v.app || !v.site) {
    for (const [id, label, sites] of listFlowApps()) {
      console.log(`${id.padEnd(20)} ${label}  sites: ${sites.join(", ") || "-"}`);
    }
    if (!v.app || !v.site) { console.log(); console.log(USAGE); return v.list ? 0 : 2; }
  }
  const laya = String(v.laya ?? "scripted");
  // S2 ③ 运行期接线：解析决策 provider（显式点名却没配 ⇒ 报错退出，绝不静默降级成"没接线"）。
  let nominateProvider: DecisionProvider | null = null;
  const nominateProviderName = v["nominate-provider"] !== undefined ? String(v["nominate-provider"]) : "";
  if (nominateProviderName !== "") {
    try {
      const spec = await resolveProviderSpec(nominateProviderName);
      if (spec.kind !== "provider") {
        console.error(`--nominate-provider ${JSON.stringify(nominateProviderName)} 未配置到可用（tier=${spec.tier}）：`
          + "决策 provider 需要显式配置（例如 TOKEN_PLAN_ENDPOINT / TOKEN_PLAN_API_KEY）。");
        return 2;
      }
      nominateProvider = spec.provider;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
  }
  const escalate = String(v.escalate ?? "scripted");
  if (!["scripted", "unsure", "onnx", "none"].includes(laya)
    || !["scripted", "llm", "none"].includes(escalate)) {
    console.error("--laya must be scripted|unsure|onnx|none; --escalate must be scripted|llm|none");
    return 2;
  }
  const slotOverrides: Record<string, unknown> = {};
  for (const s of v.slot ?? []) {
    const i = s.indexOf("=");
    if (i <= 0) { console.error(`--slot needs k=v, got ${JSON.stringify(s)}`); return 2; }
    const key = s.slice(0, i);
    if (Object.prototype.hasOwnProperty.call(slotOverrides, key)) {
      console.error(`--slot ${JSON.stringify(key)} 给了两次：一个槽位只能有一个值`);
      return 2;
    }
    slotOverrides[key] = s.slice(i + 1);
  }
  const appId = String(v.app), siteKey = String(v.site);
  const verbose = !v.quiet;
  let driftLimit = 2;
  if (v["drift-limit"] !== undefined) {
    driftLimit = Number(v["drift-limit"]);
    if (!Number.isInteger(driftLimit) || driftLimit < 1) {
      console.error(`--drift-limit needs a positive integer, got ${JSON.stringify(v["drift-limit"])}`);
      return 2;
    }
  }

  try {
    if (v.dry) {
      const template = loadTemplate(appId);
      const tProblems = validateTemplate(template);
      if (tProblems.length) throw new Error(`semantic template ${appId} is invalid:\n  - ${tProblems.join("\n  - ")}`);
      const profile = loadSiteProfile(appId, siteKey);
      const pProblems = validateProfile(profile, template);
      if (pProblems.length) throw new Error(`site profile ${appId}/${siteKey} is invalid:\n  - ${pProblems.join("\n  - ")}`);
      // dry 也带层级行：调用者在"会不会真用模型"上问的正是这一次展开会跑在哪一层。
      const dryTier = laya === "onnx"
        ? (checkArtifacts().ready ? "on" : "off(missing)")
        : laya === "none" ? "off(rules-only)" : "off(scripted)";
      const compiled = compileFlow(template, siteKey, profile, slotOverrides);
      console.log(JSON.stringify({
        app: appId, site: siteKey, site_label: compiled.site.label, goal: template.goal,
        slots: compiled.slots, profile_path: loadSiteProfile(appId, siteKey)._path ?? "",
        checkpoint: profile.checkpoint ?? template.model ?? "english",
        locale: profile.locale ?? null, model_status: dryTier,
        steps: compiled.steps.map((s) => ({
          id: s.id, desc: s.desc, kind: s.kind, url: s.url, signal: s.signal,
          signal_source: s.signal_source, dangerous: s.dangerous, targets: s.targets,
          ...(s.sg?.slots ? { step_slots: s.sg.slots } : {}),
        })),
        invariants: compiled.invariants,
      }, null, 2));
      return 0;
    }

    const result = await runFlow(appId, siteKey, {
      slots: slotOverrides, fresh: v.fresh === true,
      laya: laya as "scripted" | "unsure" | "onnx" | "none",
      escalate: escalate as "scripted" | "llm" | "none",
      allowDangerous: v["allow-dangerous"] === true,
      verifyBackfill: v["no-verify-backfill"] !== true,
      driftLimit,
      profileDir: v["profile-dir"] ?? undefined,
      headful: v.headful === true,
      verbose,
      ...(nominateProvider !== null ? { nominateProvider } : {}),
    });
    if (!v.quiet) {
      console.log();
      console.log(flowReportMarkdown(result));
    }
    if (v.out) {
      const outDir = path.resolve(v.out);
      fs.mkdirSync(outDir, { recursive: true });
      const jsonPath = path.join(outDir, `${appId}-${siteKey}-flow-result.json`);
      const mdPath = path.join(outDir, `${appId}-${siteKey}-flow-report.md`);
      fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf-8");
      fs.writeFileSync(mdPath, flowReportMarkdown(result), "utf-8");
      if (!v.quiet) console.log(`写入 ${jsonPath} 与 ${mdPath}`);
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    // 坏模板/坏档案/坏槽位在加载期就抛：CLI 的契约是"报清楚 + 退出码 2"，不是甩栈。
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    return /is invalid|not found|not declared|not a declared/.test(msg) ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
