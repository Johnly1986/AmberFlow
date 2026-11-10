/**
 * Application layer executor 的**纯函数区**（从 executor.ts 拆出，F2）——不依赖执行器类闭包。
 *
 * 拆出的理由：executor.ts 里 helpers/池判定/风险刻画/缺省确认等纯函数约 480 行，这些函数
 * 不碰 `BrowserMiddleware` 实例状态（纯输入→输出），拆出去让类体聚焦真正的循环逻辑，
 * 也让任何面（dry/replay/词面）能直接复用同一份实现（行为逐字节不变）。
 */
import os from "node:os";
import path from "node:path";
import * as browserEnv from "../browser/browser-env.ts";
import { lastBrowserLaunchFacts } from "../browser/browser-env.ts";
import {
  type BindingDiagnostics,
  type OptionCandidate,
} from "./bindings.ts";
import { actionCapabilities, elemFamily, urlOf, type ActionCapability, type Elem, type ElemFamily, type ElemPool, type FrameGate, type PageLike } from "./extraction.ts";
import type { CommandDecl } from "./actions.ts";
import { parseHint } from "./hint.ts";
import { hintMatch, type HintMatchCandidate, type HintMatchOthersDiag } from "./rules.ts";
import { checkSignal, isWeakNegativeSignal, LOGIN_WALL_TEXTS, LOGIN_WALL_URL_RE, type SignalSpec } from "./signals.ts";
import { FILLER_TOKENS, ROLE_TOKENS, STOP_TOKENS } from "./rules.ts";
import type { DecisionProvider } from "../model/decision-provider.ts";
import type { RangeOptions, RangeOutcome, RangeValue } from "./range.ts";
import type { AuditVerdictLike, Readiness, ReadinessVerdict, AnyLoc, PickProposal, PageSnapshot, HintMemoryLike, BrowserSession, PwLike, BrowserHandle, AnyPage } from "./executor-types.ts";
/** Frame URL 的 host gate：host 边界覆盖 frame，而不是只覆盖顶层导航。 */
/**
 * Popup / new tab 的 host gate：只看当前 page.url 会漏掉 `window.open()` 开出的新页。
 * 这里扫描同一 browser context 的所有 page；`pages` 在 Playwright 里是数组属性，替身可能给函数。
 */
export function deniedContextUrl(page: PageLike, hosts: string[] | null | undefined): string | null {  if (!hosts || hosts.length === 0) return null;
  // Playwright 的 page.context 是方法；替身可能直接给对象。
  const contextValue = (page as unknown as { context?: unknown }).context;
  const context = (typeof contextValue === "function" ? contextValue.call(page) : contextValue) as
    | { pages?: ArrayLike<PageLike> | (() => ArrayLike<PageLike>) }
    | undefined;
  const rawPages = typeof context?.pages === "function" ? context.pages() : context?.pages;
  const pages = Array.from(rawPages ?? []);
  for (const p of pages) {
    const u = typeof p.url === "function" ? p.url() : p.url;
    if (typeof u !== "string" || !u.trim()) continue;
    if (disallowedHost(u, hosts) !== null) return u;
  }
  return null;
}

/**
 * eval3 曝光面：context 页数（含当前页）。与 deniedContextUrl 同一套替身兼容读法；
 * 拿不到（替身/异常）返回 -1——调用方据此放弃"标签数增加"的提示判据，绝不误报。
 */
export function contextPageCount(page: PageLike): number {
  try {
    const contextValue = (page as unknown as { context?: unknown }).context;
    const context = (typeof contextValue === "function" ? contextValue.call(page) : contextValue) as
      | { pages?: ArrayLike<PageLike> | (() => ArrayLike<PageLike>) }
      | undefined;
    const rawPages = typeof context?.pages === "function" ? context.pages() : context?.pages;
    return Array.from(rawPages ?? []).length;
  } catch {
    return -1;
  }
}

import { disallowedHost } from "./host-envelope.ts";
export { disallowedHost } from "./host-envelope.ts";

/** Element types whose current value is a SECRET: never written into a trace or report (P0-3, D5①). */
export const SECRET_INPUT_TYPES = new Set(["password", "file", "hidden"]);

/** Mask a filled value when the target field is secret-typed; same length, no content. */
export function redactValue(el: Elem, val: unknown): unknown {
  if (val === null || val === undefined) return val;
  const t = String(el["input_type"] ?? "").toLowerCase();
  if (!SECRET_INPUT_TYPES.has(t)) return val;
  const s = String(val);
  return `***(${s.length})`;
}

/**
 * W8：敏感槽位 fill 的 effect 掩码值。与 `app/redaction.ts` 的 `MASKED_SLOT` 同值
 * （顶层 slots 掩码、收尾 scrubSecrets 的替换值都用它）；engine 不反向依赖 app 层，
 * 字面量就地同值——改掩码形状时两处同步。
 */
export const EFFECT_MASK = "***";

/**
 * W8：s 是否携带敏感值——精确全等不限长度；子串沿用收尾 `scrubSecrets` 的 ≥4 纪律
 * （`app/redaction.ts` 同口径，避免短串误伤普通内容）。这是**内容**判定：掩码只看
 * 读回/写入内容里是否真的出现敏感值，不看绑定的声明形态。
 */
export function carriesSecret(s: string, secrets: Iterable<string>): boolean {
  if (s.length === 0) return false;
  for (const x of secrets) {
    if (s === x || (x.length >= 4 && s.includes(x))) return true;
  }
  return false;
}

export function safeUrl(obj: unknown): string {
  try {
    return urlOf(obj as PageLike);
  } catch {
    return "";
  }
}

/**
 * A1 子改动③（逐步动作后内容签名，DOM diff 的最小形态）：池首候选文本。
 * 按提取写入序（= 观察序）取第一个带非空 label 的元素，截 ~60 字符；空池返回 null。
 * 只读内存里已有的池，不新增页面往返。
 */
export function firstPoolText(pool: ElemPool): string | null {
  for (const e of Object.values(pool)) {
    const t = String(e.label ?? "").trim();
    if (t) return t.slice(0, 60);
  }
  return null;
}

/* ------------------------------------------------------------------ A2 判别（解析失败附池快照答案） */

/**
 * A2（12 轮真站实测的停因判别）：命令闭集解析失败（`target_not_found`）与决策层弃权
 * （`low_confidence`）这两类停因，报错区分不了「候选在池外（引擎/闭集问题）」和
 * 「目标在页面上根本不存在（产品事实）」——真站实验里产品 UI 本来就没有的排序项被
 * 9/11 轮误读成引擎池缺陷，直到专门写 DOM 探针取证才发现排序菜单只有
 * ["Relevance","Rating"]。下面判别全部是**纯内存计算**（池已在手），不新增页面往返；
 * 只往既有 reason 末尾追加一段短文本（一两句 + 最多 5 个候选名），停因码与前置文本不变。
 */

/** 候选的可检索文本：label + data_test + id + name + near——与 hintMatch 的匹配字段同族。 */
export function candidateText(e: Elem): string {
  return [e.label, e["data_test"], e.id, e.name, e.near]
    .map((v) => String(v ?? "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

/** 词面里的"词"：按空白切、去标点（保留字母/数字/CJK）。 */
export function lexWords(lexeme: string): string[] {
  return lexeme.toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((w) => w.length > 0);
}

/**
 * 词面匹配（不区分大小写的包含匹配）：完整词面被候选文本包含，**或**（多词目标）清洗后
 * 的全部词同时被包含。全词 AND 是刻意的：目标 "Price (lowest first)" 不能被一个恰好叫
 * "Price" 的筛选 chip 顶成"存在匹配"——那会把「目标不存在」误报成「闭集约束」，正好
 * 复刻本判别要消灭的误读方向。
 */
export function lexMatchOne(lexeme: string, text: string): boolean {
  if (!text) return false;
  const lx = lexeme.toLowerCase().trim();
  if (lx && text.includes(lx)) return true;
  const ws = lexWords(lx);
  return ws.length > 1 && ws.every((w) => text.includes(w));
}

/** 一个候选在判别里的显示名：label 优先，退回 data_test/id，最后是 tag。 */
export function candidateName(e: Elem, cap = 30): string {
  const label = String(e.label ?? "").trim().slice(0, cap);
  if (label) return label;
  const alt = String(e["data_test"] ?? e.id ?? "").trim().slice(0, cap);
  return alt || e.tag;
}

/**
 * T3：绑定失败时"该步可行动候选"的摘要（目标元素优先，其余按 op 能力面收，最多 3 条）。
 * 只拼诊断文本；不参与选择、不改变任何动作。
 */
export function bindingCandidateSummaries(elems: ElemPool, targetRef: string, op: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (e: Elem | undefined): void => {
    if (e === undefined || out.length >= 3) return;
    const bits = [`${e.tag}${e.id ? `#${e.id}` : ""}`];
    if (e.name) bits.push(`name=${JSON.stringify(String(e.name).slice(0, 40))}`);
    if (e["data_test"]) bits.push(`data-test=${JSON.stringify(String(e["data_test"]).slice(0, 40))}`);
    if (e.label) bits.push(`label=${JSON.stringify(String(e.label).slice(0, 60))}`);
    const line = bits.join(" ");
    if (seen.has(line)) return;
    seen.add(line);
    out.push(line);
  };
  add(elems[targetRef]);
  const cap = op as ActionCapability;
  for (const [r, e] of Object.entries(elems)) {
    if (out.length >= 3) break;
    if (r === targetRef) continue;
    if (!actionCapabilities(e).includes(cap)) continue;
    add(e);
  }
  return out;
}

/**
 * 命令目标（hint 语法字符串）→ 词面判定器。`parseHint` 的六种形状各取其"名字"：
 * id/attr 值、near token、裸 token；tag 形状（button/link/…）没有专属词面，退化为对
 * 候选 tag 的相等匹配。返回 null = 拿不到稳健词面（空值/单字符）——调用方不编判别。
 */
export function targetMatcher(target: string): ((e: Elem) => boolean) | null {
  const p = parseHint(target);
  const raw = (p.kind === "id" || p.kind === "attrSubstr" || p.kind === "attrEq"
    ? p.value
    : p.kind === "tag" ? p.tag : p.token).trim();
  if (lexWords(raw).join("").length < 2) return null;
  if (p.kind === "tag") return (e) => e.tag === p.tag;
  return (e) => lexMatchOne(raw, candidateText(e));
}

/** 全部动作族：判别拿不到目标族（决策步没有声明 op）时池摘要的兜底范围。 */
export const ALL_FAMILIES: ReadonlySet<string> = new Set(["click", "fill", "select", "check", "upload"]);

/** 命令 op 的"同族 + 相邻族"动作面（相邻：click↔check 按压语义、fill↔select 选值语义）。 */
export function cmdFamilies(op: string): ReadonlySet<string> {
  switch (String(op)) {
    case "click": return new Set(["click", "check"]);
    case "check": return new Set(["check", "click"]);
    case "fill": return new Set(["fill", "select"]);
    case "select": return new Set(["select", "fill"]);
    case "upload": return new Set(["upload"]);
    case "scroll":
    case "drag": return new Set(["click"]);
    default: return ALL_FAMILIES;
  }
}

/**
 * task-9（评审 #2）：弱档命中诊断的 step warning 文案（`matched_others`）。
 * 现场语义：裸词"价格"前缀命中整块结果容器（label="价格评分时间所有过滤条件…"）——
 * 动作"成功"点了个容器，done 永不成立只剩 step_timeout。这里点名选中者与其余撞词候选
 * （≤3 条，每条 tag + class 首段（池带 class_names 时）+ label ≤40 字符，总长有界），
 * 并给收窄建议。措辞与 B2 的 check 静态 hint 提示分层：这里是运行期**当场事实**，
 * 那边是声明形状的静态提醒——不复制同一段话。
 */
export function matchedOthersWarning(d: HintMatchOthersDiag, hint: string, stepNo: number): string {
  const shape = d.kind === "bare" ? "裸词的词前缀/词包含档" : "属性子串的 loose 档";
  const fmt = (c: HintMatchCandidate): string =>
    `${c.tag}${c.class ? `.${c.class}` : ""} "${c.label.slice(0, 40)}"${c.ref === d.decided ? "（选中）" : ""}`;
  const shown = d.candidates.slice(0, 3).map(fmt).join(" | ");
  const more = d.candidates.length > 3 ? `（共 ${d.candidates.length} 个撞词候选，只列前 3）` : "";
  return `matched_others: step ${stepNo} target_hint ${JSON.stringify(hint)} 经${shape}命中，`
    + `命中对象可能是容器/同缀元素而非预期目标 — ${shown}${more}；`
    + `建议收窄：tag[attr=…] 精确值、更长独词或 #id（对照 inspect --json 的 hint_candidates）`;
}

/**
 * 池摘要（判别附言的 role 汇总）：只列与目标同/相邻动作族的候选——多成员组（menu/tab/
 * option 这类重复控件区，排障最想先看到的行）按组内数量升序排前，×1 孤儿角色垫底；
 * 泛化大组（button×31）由 5 个名字的预算自然截掉。名字截断到 5 个，超出以「其余略」收尾。
 */
export function poolRoleSummary(pool: ElemPool, families: ReadonlySet<string>): string {
  const groups = new Map<string, string[]>();
  for (const e of Object.values(pool)) {
    if (!families.has(elemFamily(e))) continue;
    const name = String(e.label ?? "").trim().slice(0, 24);
    if (!name) continue;                       // 列不出名字的候选只进组计数，不占名名额
    const key = String(e.role ?? "").trim().toLowerCase() || e.tag;
    const arr = groups.get(key) ?? [];
    arr.push(name);
    groups.set(key, arr);
  }
  const rank = (n: number): number => (n === 1 ? Number.MAX_SAFE_INTEGER : n);
  const ordered = [...groups.entries()]
    .sort((a, b) => rank(a[1].length) - rank(b[1].length) || (a[0] < b[0] ? -1 : 1));
  if (!ordered.length) return "";
  const parts: string[] = [];
  let shown = 0;
  let cut = false;
  for (const [key, names] of ordered) {
    if (shown >= 5) { cut = true; break; }
    const take = names.slice(0, 5 - shown);
    parts.push(`${key}×${names.length}: ${take.join(", ")}`);
    shown += take.length;
    if (take.length < names.length) cut = true;
  }
  if (parts.length < ordered.length) cut = true;
  return parts.join("；") + (cut ? "；其余略" : "");
}

/**
 * A2 判别①（命令闭集解析失败，`target_not_found` 停因）：对每个未解析命令，用当时内存里
 * 已有的池回答「是目标不在页面上，还是闭集解析没把它放进命令空间」——
 *   无词面匹配 ⇒ `页面上不存在词面匹配「<目标>」的候选（池 N 项：<role 汇总>）——目标很可能不在本页面存在`
 *   有匹配未入空间 ⇒ `池中存在词面匹配「<目标>」的候选（如 "…"）但未入本次命令空间——属闭集解析约束，非目标缺失`
 * 纯内存、零页面往返；没有未解析命令、池为空、或都拿不到稳健词面时返回空串（reason 保持今天的文本）。
 */
export function cmdDiscrimination(
  cmdSpace: readonly CommandDecl[], unresolved: readonly string[], pool: ElemPool,
): string {
  if (Object.keys(pool).length === 0) return "";
  const cmds = cmdSpace.filter((c) => unresolved.includes(c.id))
    .map((c) => ({ id: c.id, op: String(c.op), target: String(c.target ?? "").trim() }))
    .filter((c) => c.target !== "");
  if (!cmds.length) return "";
  const segs: Array<{ id: string; text: string }> = [];
  let poolShown = false;                     // 多命令时池摘要只随第一个无匹配判别出现一次
  for (const c of cmds) {
    const match = targetMatcher(c.target);
    if (match === null) continue;            // 拿不到稳健词面：不编判别，只靠其他命令的段落
    const hits: string[] = [];
    for (const e of Object.values(pool)) {
      if (!match(e)) continue;
      hits.push(candidateName(e));
      if (hits.length >= 3) break;
    }
    if (hits.length) {
      segs.push({ id: c.id, text:
        `池中存在词面匹配「${c.target}」的候选（如 ${hits.map((h) => `"${h}"`).join("、")}）`
        + `但未入本次命令空间——属闭集解析约束，非目标缺失` });
    } else {
      const summary = poolShown ? "" : poolRoleSummary(pool, cmdFamilies(c.op));
      poolShown = true;
      segs.push({ id: c.id, text:
        `页面上不存在词面匹配「${c.target}」的候选（池 ${Object.keys(pool).length} 项`
        + `${summary ? `：${summary}` : ""}）——目标很可能不在本页面存在` });
    }
  }
  if (!segs.length) return "";
  return "。判别: "
    + segs.map((s) => (segs.length > 1 ? `命令 ${s.id}：${s.text}` : s.text)).join("；");
}

/**
 * 决策步 goal 里的**判别词面**：引号词（"…"、「…」等成对引号）优先——那是作者点名的
 * 目标词；没有引号就退回 goal 全文里的显著词（ASCII ≥3 且非停用/填充/角色词，CJK ≥2 字
 * 连续段，与规则层同一份词表纪律）。找不到稳健词面返回空表 ⇒ 判别降级为只报池摘要。
 */
export function goalLexemes(instruction: string): string[] {
  const out: string[] = [];
  for (const m of String(instruction ?? "").matchAll(/["“”「」『』]([^"“”「」『』]{2,})["“”「」『』]/g)) {
    const t = m[1]!.trim();
    if (t && lexWords(t).join("").length >= 2 && !out.includes(t)) out.push(t);
  }
  if (out.length) return out.slice(0, 3);
  const ins = String(instruction ?? "").toLowerCase();
  for (const w of ins.match(/[a-z0-9]{3,}/g) ?? []) {
    if (!STOP_TOKENS.has(w) && !FILLER_TOKENS.has(w) && !ROLE_TOKENS.has(w) && !out.includes(w)) out.push(w);
  }
  for (const seq of ins.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (!out.includes(seq)) out.push(seq);
  }
  return out.slice(0, 6);
}

/**
 * A2 判别②（决策层弃权，`low_confidence` 停因）：模型被咨询但分数不过闸门时，同样用池
 * 回答「是目标不在，还是候选在而模型没把握」。池中存在词面相关候选 ⇒ 明确说
 * 「候选存在但置信度低于闸门（闸门问题）」——这与「目标不存在」是不同问题；
 * 无词面 ⇒ 只报池摘要。纯内存、零页面往返。
 */
export function lowConfDiscrimination(instruction: string, pool: ElemPool, pickRef: string | null): string {
  const n = Object.keys(pool).length;
  if (n === 0) return "";
  const lexemes = goalLexemes(instruction);
  const pick = pickRef !== null ? pool[pickRef] : undefined;
  const families = pick !== undefined ? new Set([elemFamily(pick)]) : ALL_FAMILIES;
  const summary = poolRoleSummary(pool, families);
  if (!lexemes.length) return summary ? `。判别: 池 ${n} 项：${summary}` : "";
  const shown = lexemes.slice(0, 3).join("、");
  const hits: string[] = [];
  for (const e of Object.values(pool)) {
    const text = candidateText(e);
    if (lexemes.some((lx) => lexMatchOne(lx, text))) {
      hits.push(candidateName(e));
      if (hits.length >= 3) break;
    }
  }
  if (hits.length) {
    return `。判别: 池中存在与词面「${shown}」相关的候选（如 ${hits.map((h) => `"${h}"`).join("、")}）`
      + `但置信度低于闸门——候选存在但置信度低于闸门（闸门问题），非目标缺失`;
  }
  return `。判别: 池中不存在与词面「${shown}」相关的候选（池 ${n} 项`
    + `${summary ? `：${summary}` : ""}）——目标可能不在本页面（或未进元素池）`;
}

/**
 * Python's `input("CONFIRM ...")` default. There is no synchronous stdin prompt
 * in Node, and a risky action must never be silently approved — so the port
 * refuses unless the caller supplies `confirmFn`.
 */
export const DEFAULT_CONFIRM = (desc: string): boolean => {
  console.warn(`  CONFIRM '${desc}'? [y/N] no confirmFn configured -> refusing`);
  return false;
};

/* ------------------------------------------------------------------ browser lifecycle */

/**
 * One playwright + one page for a whole plan (Python: `browser_session()`).
 *
 * The subgoals of a plan are ONE session, not N: reusing the page keeps cookies
 * and JS state alive across subgoals, avoids paying a cold browser launch per
 * subgoal, and lets a logged-in session survive into the next subgoal. `run()`
 * still navigates to each subgoal's own start_url, so isolation is unchanged.
 *
 * Python is a context manager yielding `(pw, page)`; Node returns a handle with
 * an explicit async `close()` (there is no `with` in TS). `run()` will not own
 * the browser when this page/pw pair is injected.
 */
/**
 * 可声明的**设备面**（应用包里的 `device` 块用它）。
 *
 * 为什么它必须能声明：有些站点是**只有手机版才存在**的——`touch.qunar.com` 的 H5 页在桌面 UA/视口下
 * DOM 都不一样，于是计划点名的城市 chip 在元素池里根本不存在，hint 落空、laya 也选不出来（实测：
 * 桌面上下文下第一个子目标三次尝试都 `low confidence 0.15`；同一份计划在 iPhone UA + 390×844 下
 * 一次命中）。把它写死在驱动里就等于把站点知识藏回代码，所以设备是**声明**。
 */
export interface DeviceSpec {
  user_agent?: string;
  viewport?: { width: number; height: number };
  is_mobile?: boolean;
  has_touch?: boolean;
  locale?: string;
  timezone?: string;
  device_scale_factor?: number;
}

export async function browserSession(
  headless = true,
  device?: DeviceSpec | null,
  // task-43：meta.policy.browser 的通道（run 面解析后传入；session/辅助路径不传 = env>default）。
  // env(AMBERFLOW_BROWSER_CHANNEL) > 此参数 > 缺省解析，优先级在 browser-env.launchKwargs 单源实现。
  metaChannel: import("../browser/browser-env.ts").BrowserChannel | null = null,
): Promise<BrowserSession> {
  const mod = await import("playwright");
  const pw: PwLike = { chromium: mod.chromium as unknown as PwLike["chromium"] };
  const browser = (await browserEnv.launch(pw, headless, null, metaChannel)) as unknown as BrowserHandle;
  // task-21/D-1：启动事实挂到会话上（env.browser 一等证据；app-runner 收尾读进 result.env）。
  const envBrowser = lastBrowserLaunchFacts() ?? undefined;
  let page: AnyPage;
  let context: AnyPage | null = null;
  try {
    if (device && Object.keys(device).length) {
      // 有设备声明就开一个带 UA/视口/触摸的上下文；没有就保持老的 `browser.newPage()` 路径，
      // 免得给所有既有应用引入一层新对象（它们的验收输出不该因为这次改动而变化）。
      const ctx = await (browser as unknown as {
        newContext(o?: Record<string, unknown>): Promise<{
          newPage(): Promise<AnyPage>; close(): Promise<void>;
        }>;
      }).newContext({
        ...(device.user_agent === undefined ? {} : { userAgent: device.user_agent }),
        ...(device.viewport === undefined ? {} : { viewport: device.viewport }),
        ...(device.is_mobile === undefined ? {} : { isMobile: device.is_mobile }),
        ...(device.has_touch === undefined ? {} : { hasTouch: device.has_touch }),
        ...(device.locale === undefined ? {} : { locale: device.locale }),
        ...(device.timezone === undefined ? {} : { timezoneId: device.timezone }),
        ...(device.device_scale_factor === undefined ? {} : { deviceScaleFactor: device.device_scale_factor }),
      });
      context = ctx as unknown as AnyPage;
      page = await ctx.newPage();
    } else {
      page = (await browser.newPage()) as AnyPage;
    }
  } catch (err) {
    await browser.close();
    throw err;
  }
  let closed = false;
  return {
    pw,
    browser,
    page,
    ...(envBrowser !== undefined ? { envBrowser } : {}),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (context) { try { await (context as unknown as { close(): Promise<void> }).close(); } catch { /* browser.close()下面兜底 */ } }
      await browser.close();
    },
  };
}

/**
 * How many laya checkpoints may stay resident.
 *
 * Two is laya's own recommendation (with one, a plan that alternates languages
 * re-loads the checkpoint on every switch), but an Agent is ~0.7-1.7 GB of
 * weights. Python probes `os.sysconf("SC_AVPHYS_PAGES")` (available physical
 * pages); the port uses `os.totalmem()`, which is the closest stable cross-
 * platform probe Node ships (there is no sysconf). Any failure falls back to the
 * safe 1.
 */
export function routerMaxLoaded(): number {
  try {
    const totalGb = os.totalmem() / 1e9;
    return totalGb >= 4.0 ? 2 : 1;
  } catch {
    return 1;
  }
}

/* ------------------------------------------------------------------ middleware */

