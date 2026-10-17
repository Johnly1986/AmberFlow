/**
 * plan 端到端（SemanticFlow M3）—— 一句话 + 一个种子页面 → v2 语义模板 + 首站档案。
 * 方案：docs/SEMANTIC_FLOW_TRANSFER_PLAN.md §4 剧本 ①。
 *
 *   ① 从 goal 提取参数（日期/城市/最低价/购买意图）→ 计划槽位（值只来自数据袋）
 *   ② 逐步"看页面"：规划器（离线配方或 LLM 适配器）对当前 criteria view 提议下一步
 *      —— 语义目标由 **goal 词汇 + 页面上看见的标签** 共同决定（"LLM 当老师"的现场职责）
 *   ③ 真执行这一步（唯一的生产执行器 + 三级解析面），捕获 before/after 页面状态
 *   ④ 信号**从真转换归纳**（induceSignals：判别 + 稳定句柄），并要求**两次独立演示可复现**
 *      （reproducible 三关）；选不出来 = manual → 如实停，绝不放宽成"看着像"
 *   ⑤ 站点知识全部观察进档案：pages 角色文件名、page_query 参数名、fill_keys 值绑定、
 *      list_extract 行抽取、比 URL 契约更强的 frozen_signals
 *   ⑥ 人 y/n 确认（或 --yes），然后**重放门控**：编译 + runFlow 从暂存目录整跑一遍，
 *      全绿才落盘到 apps/<id>/（learn 的纪律：不可复现即不存，失败不留半个文件）
 *
 * 与执行期的分工：`plan` 只写**站点档案**（authored 半边）；**hint 仍然由运行期学习**
 * （红线 2——计划阶段没有"重放"可言，模板第一次跑就是首迁，回填环自己收第一站）。
 *
 *   node --experimental-strip-types src/plan-flow.ts \
 *     --goal "在携程订5月18日昆明到北京价格最低的机票" --seed semantic/site-a/index.html \
 *     --app flight-cheapest-planned --site site-a --yes
 *   迁移模式（模板已存在 = 只为本站产档案、必要时放宽语义目标的同义词）：
 *   node --experimental-strip-types src/plan-flow.ts --goal "同上" --seed .../site-b/home.html \
 *     --app flight-cheapest-planned --site site-b --yes
 */
import fs from "node:fs";
import { isParseUsageError, usageErrorLine } from "./cli-args.ts";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { MockAuditor } from "./audit.ts";
import { APPS_DIR } from "./app-pack.ts";
import { ensureDir, userAppsDir } from "./amberflow-home.ts";
import {
  BrowserMiddleware, browserSession, type BrowserSession, type EscalatorLike,
} from "./executor.ts";
import { resolveBinding } from "./bindings.ts";
import { criteriaView, extractElements, urlOf, type ElemPool } from "./extraction.ts";
import { installLayaRuntime, scriptedRuntime } from "./model.ts";
import { llmEscalator } from "./planner.ts";
import { captureStateView, induceSignals, signalReproducible, type StateView } from "./signal-induction.ts";
import { matchSemanticTarget, observeLocale, type CheckpointId, type SemanticTarget } from "./semantic.ts";
import {
  scriptedSemanticAgent, scriptedTeacher,
  type FlowTemplate, type ListExtract, type SiteProfile,
} from "./semantic-flow.ts";
import { startUrl } from "./app-runner.ts";

/* ------------------------------------------------------------------ goal 参数提取 */

const MONTHS_EN = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

export interface ExtractedParams {
  from?: string;
  to?: string;
  date_label?: string;
  date_label_en?: string;
  date_code?: string;
  cheapest: boolean;
  buy: boolean;
}

/** 从一句话 goal 里提参数（"提取参数"那一步的离线正则版；LLM 版由外层 Agent 完成）。 */
export function extractParams(goal: string): ExtractedParams {
  const out: ExtractedParams = { cheapest: false, buy: false };
  const m = goal.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (m) {
    const mm = m[1]!.padStart(2, "0"), dd = m[2]!.padStart(2, "0");
    out.date_label = `${m[1]}月${m[2]}日`;
    out.date_code = `${mm}-${dd}`;
    const month = MONTHS_EN[Number(mm) - 1];
    if (month) out.date_label_en = `${month} ${Number(dd)}`;
  }
  const goalClean = m ? goal.replace(m[0], "") : goal;
  // 三段式（中文没有词边界，纯正则不可能知道 "订一张" 不是城市名的一部分）：
  //   ① `从X到Y` 显式句式最可靠；
  //   ② 有日期时，日期文本就是出发城市的**左边界**——`5月18日昆明到北京` 去掉日期后串首即城市；
  //   ③ 都没有则城市限 2-3 字（多数中国城市名），宁缺勿滥地兜底。
  let c = goalClean.match(/从([\u4e00-\u9fff]{1,8}?)到([\u4e00-\u9fff]{1,8}?)[的，,。]/);
  if (!c && m) {
    const afterDate = goal.slice(goal.indexOf(m[0]) + m[0].length);
    c = afterDate.match(/^([\u4e00-\u9fff]{2,6}?)到([\u4e00-\u9fff]{2,6}?)(?:的|价格|机票|城市)?/);
  }
  if (!c) c = goalClean.match(/([\u4e00-\u9fff]{2,3}?)到([\u4e00-\u9fff]{2,3}?)(?:的|价格|机票)/);
  if (c) { out.from = c[1]; out.to = c[2]; }
  if (/最低|最便宜|cheapest/i.test(goal)) out.cheapest = true;
  // "订一张…机票" 本身就是下单意图——只认 "购买/下单" 会漏掉诉求原文的句式（实测踩过）。
  if (/订|购买|下单|支付|付款|place order|purchase|pay|checkout/i.test(goal)) out.buy = true;
  return out;
}

/**
 * 意图词表——离线规划器对"LLM 天然会做的中英词汇桥"的替身。
 * 真 LLM 规划器看页面自己会认（"Flights" 就是机票频道入口）；这里给配方规划器一张对照表，
 * 键既含中文意图词也含槽位名（迁移模式下模板 fills 用的是槽位名）。
 */
const LEXICON: Record<string, string[]> = {
  "机票": ["Flight", "Flights", "flight"],
  "出发": ["Departure", "departure", "From", "depart"],
  "到达": ["Arrival", "arrival", "To", "arrive"],
  "搜索": ["Search", "search", "查询"],
  "购买": ["Purchase", "Buy", "Book", "purchase", "buy"],
  "from": ["出发", "Departure", "departure", "From"],
  "to": ["到达", "Arrival", "arrival", "To"],
};
const intentTexts = (word: string): string[] => {
  const seen = new Set([word, ...(LEXICON[word] ?? [])]);
  return [...seen];
};

/* ------------------------------------------------------------------ 规划器协议 */

export interface PlanStepRequest {
  goal: string;
  slots: Record<string, unknown>;
  completed: Array<{ id: string; desc: string }>;
  url: string;
  title: string;
  criteria: Record<string, string>;
}

export interface PlanProposal {
  id: string;
  desc: string;                       // 含 {slot} 占位的模板文案
  page: string;                       // 本步出发的页面角色
  lands: string;                      // 完成时应到达的页面角色
  targets: SemanticTarget[];          // 语义目标（有序列表 = 多动作步）
  fills?: Array<{ slot: string; word: string }>;   // 值绑定意图（word = 字段语义词）
  list?: { op: "min" | "max"; by: string };
  dangerous?: boolean;
}

export type FlowPlanner = (req: PlanStepRequest) => PlanProposal | null | Promise<PlanProposal | null>;

/** 离线配方规划器：意图顺序 = 频道入口 → 填值并搜索 → 日期 → 最低价 → 购买。 */
export function goalRecipePlanner(goal: string, params: ExtractedParams): FlowPlanner {
  const steps: PlanProposal[] = [];
  steps.push({
    id: "open-flights", desc: "进入机票预订频道", page: "home", lands: "search",
    targets: [{ role: "link", text: intentTexts("机票") }],
  });
  if (params.from !== undefined && params.to !== undefined) {
    steps.push({
      id: "submit-search",
      desc: "在出发地填入{from}、到达地填入{to}，然后点击搜索",
      page: "search", lands: "results",
      targets: [
        { role: "input", text: intentTexts("出发") },
        { role: "input", text: intentTexts("到达") },
        { role: "button", text: intentTexts("搜索") },
      ],
      fills: [{ slot: "from", word: "出发" }, { slot: "to", word: "到达" }],
    });
  }
  if (params.date_code !== undefined) {
    steps.push({
      id: "pick-date", desc: "选择出发日期{date_label}",
      page: "results", lands: "results",
      targets: [{ role: "button", text: ["{date_label}", "{date_label_en}"] }],
    });
  }
  if (params.cheapest) {
    steps.push({
      id: "pick-cheapest", desc: "判断最低价机票并选中最低价的航班",
      page: "results", lands: "purchase",
      targets: [], list: { op: "min", by: "price" },
    });
  }
  if (params.buy) {
    steps.push({
      id: "purchase", desc: "点击购买提交订单",
      page: "purchase", lands: "done",
      targets: [{ role: "button", text: intentTexts("购买") }],
      dangerous: true,
    });
  }
  let i = 0;
  return () => (i < steps.length ? steps[i++]! : null);
}

/** 迁移模式规划器：已有模板就是步骤配方（desc/targets 从模板取，槽位名当意图词查词表）。 */
export function templatePlanner(template: FlowTemplate): FlowPlanner {
  let i = 0;
  return () => {
    const s = template.steps[i++];
    if (!s) return null;
    const targets = s.semantic_targets ?? (s.semantic_target ? [s.semantic_target] : []);
    return {
      id: s.id, desc: s.desc, page: s.page, lands: s.signal.page,
      targets: targets.map((t) => ({
        ...(t.role !== undefined ? { role: t.role } : {}),
        // 模板已写的 text 原样保留（站点标签是"看见的"，不是在这里编的）
        ...(t.text !== undefined ? { text: t.text } : {}),
        ...(t.near !== undefined ? { near: t.near } : {}),
        ...(t.data_test !== undefined ? { data_test: t.data_test } : {}),
      })),
      ...(s.fills ? { fills: s.fills.map((slot) => ({ slot, word: slot })) } : {}),
      ...(s.list_step ? { list: { op: s.list_step.op, by: s.list_step.by } } : {}),
      ...(s.dangerous ? { dangerous: true } : {}),
    };
  };
}

/**
 * LLM 规划器适配器（与 llmEscalator 同一 fail-closed 纪律）：看同一份 criteria view，
 * 每轮只提议一步，输出严格 JSON；解析失败 = 停止规划（绝不猜）。
 * 需要 OPENAI_BASE_URL + OPENAI_API_KEY（或注入 chatFn 测试缝）。
 */
export function llmFlowPlanner(opts: {
  baseUrl?: string; apiKey?: string; model?: string; timeout?: number;
  chatFn?: (user: string, system: string) => Promise<string>;
  /**
   * 停止原因的回调：`api-error`（网络/HTTP，**会再抛**——静默停下会让网络故障伪装成
   * "模型判完成"，产物写出一个 1 步的假绿模板）、`empty-reply` / `no-json` / `bad-json` /
   * `invalid-schema`（fail-closed，停但不猜）、`done`（模型说目标已达成）。
   */
  onStop?: (reason: "api-error" | "empty-reply" | "no-json" | "bad-json" | "invalid-schema" | "done", detail?: unknown) => void;
} = {}): FlowPlanner {
  const base = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
  const key = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  const model = opts.model ?? process.env.PLANNER_MODEL ?? "gpt-4o-mini";
  // 30s 对"整页元素快照 + 推理型模型"太紧（2026-10-15 实测：第二次规划调用超时被旧代码静默吞掉，
  // 产出一份 1 步的"成功"模板）。默认 120s，可用 PLANNER_TIMEOUT（秒）覆盖。
  const timeout = (opts.timeout ?? (Number(process.env.PLANNER_TIMEOUT ?? "") || 120)) * 1000;
  const system = "You plan a SEMANTIC browser flow, one step per page view. The template must stay "
    + "site-agnostic: never emit CSS selectors, ids or data-test values — name targets by role plus "
    + "the visible wording you can SEE on the page. Never invent values; typed values are referenced "
    + "as {slot}. "
    + "`fills`: [{slot, word}] — `word` is the VISIBLE LABEL or PLACEHOLDER of the input field you "
    + "want to fill (e.g. 出发城市 / Departure city), NEVER the value to type (values come from slots). "
    + "`list`: {op:'min'|'max', by:'price'} ONLY when this page visibly shows a repeating row group "
    + "with a numeric price column (a results/list page); never propose list on a search/form page. "
    + "Reply ONLY JSON: {\"id\",\"desc\",\"page\",\"lands\",\"targets\":[{\"role\",\"text\"}],"
    + "\"fills\":[{\"slot\",\"word\"}],\"list\":{\"op\":\"min|max\",\"by\":\"price\"},\"dangerous\":bool} "
    + "or {\"done\":true} when the goal is achieved.";
  const chat = opts.chatFn ?? (async (user: string, sys: string): Promise<string> => {
    if (!base) throw new Error("llmFlowPlanner needs OPENAI_BASE_URL");
    if (!key) throw new Error("llmFlowPlanner needs OPENAI_API_KEY");
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, temperature: 0,
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) throw new Error(`llmFlowPlanner HTTP ${r.status}`);
    const body = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? "";
  });
  return async (req) => {
    const lines = Object.entries(req.criteria).map(([ref, line]) => `${ref}: ${line}`).join("\n");
    const user = `Goal: ${req.goal}\nSlots: ${JSON.stringify(req.slots)}\nCompleted: `
      + `${JSON.stringify(req.completed.map((c) => c.id))}\nPage: ${req.url} — ${req.title}\n\n`
      + `Visible elements:\n${lines}\n\nPropose the NEXT single step (or {"done":true}).`;
    // 网络/HTTP 错**不是**"模型判完成"：调用错误原样抛给调用方（不进入下面那个 fail-closed 的
    // 解析 try）——静默停下会让网络故障伪装成"规划结束"，写出短模板假绿。
    let reply: string;
    try {
      reply = await chat(user, system);
    } catch (e) {
      opts.onStop?.("api-error", e instanceof Error ? e.message : String(e));
      throw e;
    }
    try {
      if (!String(reply ?? "").trim()) { opts.onStop?.("empty-reply"); return null; }
      // 贪心到最后一个 `}`：惰性匹配会在**嵌套对象**处截断（targets:[{...}] 实测踩过）。
      const m = /\{[\s\S]*\}/.exec(reply ?? "");
      if (m === null) { opts.onStop?.("no-json", String(reply).slice(0, 300)); return null; }
      let p: Record<string, unknown>;
      try { p = JSON.parse(m[0]) as Record<string, unknown>; } catch {
        opts.onStop?.("bad-json", m[0].slice(0, 300));
        return null;
      }
      if (p["done"] === true) { opts.onStop?.("done"); return null; }
      // 契约容错（实测常见形状，不是猜）：id 常给数字（`"id": 1`）→ 归一成字符串；
      // 其余字段仍严格（`desc`/`page` 必须是非空字符串，`targets` 必须是数组）。
      const idRaw = p["id"];
      const stepId = typeof idRaw === "string" ? idRaw.trim()
        : typeof idRaw === "number" ? String(idRaw) : "";
      if (!stepId || typeof p["desc"] !== "string" || !p["desc"].trim()
        || typeof p["page"] !== "string" || !p["page"].trim()
        || !Array.isArray(p["targets"])) {
        opts.onStop?.("invalid-schema", p);                  // fail closed：不像话 = 停
        return null;
      }
      // `lands` **可省略**：落点页名在演示前不可能知道（实测 deepseek-v4-pro 给 null 就此停摆）——
      // 空串 = 让演示观察到的落点文件名当角色名。给了就归一成文件名（模型常给整条 URL）。
      const landsRaw = p["lands"] === undefined || p["lands"] === null ? "" : String(p["lands"]);
      return {
        id: stepId, desc: p["desc"],
        page: fileOf(String(p["page"])),
        lands: landsRaw ? fileOf(landsRaw) : "", 
        targets: p["targets"] as SemanticTarget[],
        ...(Array.isArray(p["fills"]) ? { fills: p["fills"] as Array<{ slot: string; word: string }> } : {}),
        ...(p["list"] && typeof p["list"] === "object"
          ? { list: p["list"] as { op: "min" | "max"; by: string } } : {}),
        ...(p["dangerous"] === true ? { dangerous: true } : {}),
      };
    } catch {
      return null;
    }
  };
}

/* ------------------------------------------------------------------ 观察助手 */

const sub = (text: string, slots: Record<string, unknown>): string =>
  text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k: string) => (k in slots ? String(slots[k]) : m));

/** 语义目标里的 {slot} 替换（执行面用替换版；模板里保留占位版——值只来自数据袋）。 */
function subTarget(target: SemanticTarget, slots: Record<string, unknown>): SemanticTarget {
  const conv = (v: string | string[] | undefined): string | string[] | undefined =>
    v === undefined ? undefined : Array.isArray(v) ? v.map((x) => sub(x, slots)) : sub(v, slots);
  return {
    ...(target.role !== undefined ? { role: target.role } : {}),
    ...(target.text !== undefined ? { text: conv(target.text) } : {}),
    ...(target.near !== undefined ? { near: conv(target.near) } : {}),
    ...(target.data_test !== undefined ? { data_test: conv(target.data_test) } : {}),
  };
}

const fileOf = (u: string): string => {
  try { return new URL(u).pathname.split("/").pop() ?? u; } catch { return u; }
};

/** 把观察到的 URL 查询参数值对回槽位：参数名=站点知识，值=槽位 → 泛化成占位串。 */
export function generalizeQuery(url: string, slots: Record<string, unknown>): string {
  try {
    const u = new URL(url);
    const parts: string[] = [];
    for (const [k, v] of u.searchParams.entries()) {
      const slot = Object.entries(slots).find(([, sv]) => String(sv) === v)?.[0];
      if (slot !== undefined) parts.push(`${k}={${slot}}`);
      // 对不上槽位的参数（订单号、一次性 token）不进模板——它们不是计划数据。
    }
    return parts.join("&");
  } catch {
    return "";
  }
}

/** 值绑定观察：页面输入框里哪个字段承载哪个槽位的值（字段键 = 标签/句柄，_slotValue 靠它匹配）。 */
export function observeFillKeys(
  elems: ElemPool, fills: Array<{ slot: string; word: string }>, slots: Record<string, unknown>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { slot, word } of fills) {
    const texts = intentTexts(word);
    const hit = Object.values(elems).filter((e) => {
      if (e.tag !== "input" && e.tag !== "textarea") return false;
      const hay = `${e.label ?? ""} ${e.name ?? ""} ${e.id ?? ""} ${e.data_test ?? ""}`.toLowerCase();
      return texts.some((t) => hay.includes(t.toLowerCase()));
    });
    if (hit.length !== 1) {
      throw new Error(`fill slot ${JSON.stringify(slot)} (word ${JSON.stringify(word)}) matched `
        + `${hit.length} fields on this page — the binding is ambiguous, plan stops here（不猜）`);
    }
    const el = hit[0]!;
    const fieldKey = (typeof el.label === "string" && el.label.trim()) ? el.label.trim()
      : (typeof el.data_test === "string" && el.data_test) ? el.data_test
        : (typeof el.id === "string" && el.id) ? el.id
          : (typeof el.name === "string" ? el.name : "");
    if (!fieldKey) throw new Error(`fill slot ${JSON.stringify(slot)}: the matched field has no stable key`);
    if (!(slot in slots)) throw new Error(`fill slot ${JSON.stringify(slot)} has no value in the data bag`);
    map[fieldKey] = slot;
  }
  return map;
}

/** 行抽取发现：重复的同族兄弟节点、每行含数字价格列与可点句柄 → list_extract 配置。
 *  浏览器端的发现器是一段**字符串 JS**（与 extraction 的 _COLLECT_JS 同一惯例：DOM 类型不进 TS 编译面）。 */
const ROW_PROBE = `(() => {
  const clsOf = (el) => { const c = el.className;
    return typeof c === "string" && c.trim() ? c.trim().split(/\\s+/).sort().join(".") : ""; };
  const isPrice = (t) => /\\d[\\d,.]{1,6}/.test(t) && /[¥￥]|CNY|USD|元/i.test(t);
  const groups = new Map();
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const c = clsOf(el); if (!c) continue;
    const kids = Array.from(el.children);
    const priceCell = kids.find((k) => isPrice((k.textContent || "").trim()));
    if (!priceCell || !el.querySelector("button")) continue;
    const p = el.parentElement;
    const sel = el.tagName.toLowerCase() + "." + c;
    const key = (p ? p.tagName.toLowerCase() : "") + ">" + sel;
    let g = groups.get(key);
    if (!g) {
      const pc = clsOf(priceCell).split(".")[0] || "";
      const idCell = kids.find((k) => /^[A-Za-z]{1,3}\\d{1,4}$/.test((k.textContent || "").trim()));
      const btn = el.querySelector("button");
      const bc = clsOf(btn);
      g = { sel, count: 0, priceSel: pc ? "." + pc : "",
        idSel: idCell ? "." + (clsOf(idCell).split(".")[0] || "") : "",
        actSel: bc ? "button." + bc.split(".").join(".") : "button" };
      groups.set(key, g);
    }
    g.count += 1;
  }
  const best = Array.from(groups.values()).sort((a, b) => b.count - a.count)[0];
  return best && best.count >= 3 && best.priceSel ? best : null;
})()`;

export async function discoverListConfig(
  page: unknown, by: string,
): Promise<{ cfg: ListExtract; values: number[]; rows: Array<Record<string, string>> }> {
  const info = await (page as {
    evaluate: (fn: string) => Promise<unknown>;
  }).evaluate(ROW_PROBE);
  if (info === null) throw new Error(`no repeating row group with a ${JSON.stringify(by)} column was found on this page`);
  const g = info as { sel: string; count: number; priceSel: string; idSel: string; actSel: string };
  const fields: Record<string, { sel: string; op: "int" | "str" }> = { [by]: { sel: g.priceSel, op: "int" } };
  if (g.idSel !== "" && g.idSel !== g.priceSel) fields["flight"] = { sel: g.idSel, op: "str" };
  const cfg: ListExtract = { row_sel: g.sel, fields, act_sel: g.actSel };
  const rows = await (page as {
    $$eval: (sel: string, fn: (rs: unknown[], f: unknown) => unknown, arg: unknown) => Promise<unknown>;
  }).$$eval(cfg.row_sel, (rs, f) => rs.map((r) => {
    const el = r as { textContent?: string; querySelector: (sel: string) => { textContent?: string } | null };
    const out: Record<string, string> = {};
    for (const [name, spec] of Object.entries(f as Record<string, { sel: string }>)) {
      const node = spec.sel ? el.querySelector(spec.sel) : el;
      out[name] = node ? String(node.textContent ?? "").trim() : "";
    }
    return out;
  }), cfg.fields) as Array<Record<string, string>>;
  const values = rows.map((r) => Number(String(r[by] ?? "").replace(/[^\d.-]/g, "")));
  if (values.length !== g.count || values.some((x) => !Number.isFinite(x))) {
    throw new Error(`row extraction is inconsistent (${values.length}/${g.count} rows parsed) — refusing to guess`);
  }
  return { cfg, values, rows };
}

/**
 * 归纳回来的信号里，**等于某个槽位值的字面量**（原样或 URL 编码形态）换成 `{slot}` 占位：
 * `--slot to=上海` 换值后信号仍然判得对——值只来自数据袋（红线 4），判据不许钉死观测时的值。
 */
export function generalizeSignalValues(
  spec: Record<string, unknown>, slots: Record<string, unknown>,
): Record<string, unknown> {
  const pairs = Object.entries(slots)
    .map(([k, v]) => [k, String(v)] as const)
    .filter(([, v]) => v !== "")
    .sort((a, b) => b[1].length - a[1].length);
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const [k, v] of pairs) out = out.split(encodeURIComponent(v)).join(`{${k}}`)
        .split(v).join(`{${k}}`);
      return out;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) o[k] = walk(v);
      return o;
    }
    return value;
  };
  return walk(spec) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ 信号归纳（含重放） */

export interface InducedSignal {
  signal: Record<string, unknown>;
  kind: "induced" | "contract" | "manual";
  why: string;
}

/** 查询参数差分候选：after 新增/变化的 `k=v` 是"到达"类步骤最自然的判别式。 */
function queryDiffSignals(runs: Array<[StateView, StateView]>): Array<{ signal: Record<string, unknown>; why: string }> {
  const pairs = new Map<string, string>();
  for (const [b, a] of runs) {
    try {
      const before = new URL(b.url).searchParams;
      const after = new URL(a.url).searchParams;
      for (const [k, v] of after.entries()) {
        if (before.get(k) === v) continue;
        const enc = `${k}=${encodeURIComponent(v)}`;
        if (b.url.includes(enc)) continue;              // before 已含 = 不判别
        pairs.set(enc, v);
      }
      for (const [k, v] of before.entries()) {
        if (!after.has(k) || after.get(k) === v) continue;
        const enc = `${k}=${encodeURIComponent(v)}`;
        if (a.url.includes(enc)) continue;              // gone-param：after 不含才算判别
        if (pairs.has(enc)) pairs.delete(enc);
      }
    } catch {
      return [];
    }
  }
  return [...pairs.keys()].map((enc) => ({
    signal: { url_contains: enc }, why: `query ${enc} appeared`,
  }));
}

/** 从两次独立演示的 before/after 对上选信号：判别 + 复现；选不出来 = manual（如实，不放宽）。 */
export function pickInducedSignal(
  runs: Array<[StateView, StateView]>, landingRole: string, landingFile: string,
): InducedSignal {
  const first = induceSignals(runs[0]![0], runs[0]![1]);
  const reproducible = first.candidates.filter((c) => signalReproducible(c.signal, runs));
  const top = reproducible[0];
  if (top !== undefined) return { signal: top.signal, kind: "induced", why: top.why };
  // 查询差分：DOM 候选不判别时，"到达页 + 新查询参数"仍是观察到的 DOM/URL 事实。
  for (const cand of queryDiffSignals(runs)) {
    const b = runs[0]![0].url.includes(String(cand.signal.url_contains));
    const a = runs[0]![1].url.includes(String(cand.signal.url_contains));
    if (b === false && a === true && signalReproducible(cand.signal, runs)) {
      return { signal: cand.signal, kind: "induced", why: cand.why };
    }
  }
  // URL 契约兜底：落点页文件名对"到达"这一步永远可判（before 在出发页，after 在落点页）。
  if (runs.every(([b, a]) => !b.url.includes(landingFile) && a.url.includes(landingFile))) {
    return { signal: { page: landingRole }, kind: "contract", why: `url contains ${landingFile} (by role contract)` };
  }
  return { signal: { manual: true }, kind: "manual", why: "nothing discriminating AND reproducible" };
}

/* ------------------------------------------------------------------ plan 引擎 */

export interface PlanFlowOptions {
  goal: string;
  seedUrl: string;               // 相对仓库根的页面路径或 URL
  app: string;
  site: string;
  planner?: FlowPlanner;
  laya?: "scripted" | "unsure";
  escalate?: "scripted" | "llm" | "none";
  yes?: boolean;                  // 跳过逐步 y/n（外层 Agent 的一次调用）
  /**
   * 允许规划期**真点一下** dangerous 步（购买/支付）来观察它的转换。默认关：
   * 在真站上"演示一次购买"就是下单。复刻站/沙箱页才开它（红线 3 的 plan 期形态）——
   * 关着时规划如实停在危险步，什么文件都不写。
   */
  allowDangerousDemo?: boolean;
  force?: boolean;                // 新建模式下覆盖已有 apps/<id>
  appsDir?: string;               // 落盘根（测试可注入）
  confirmStep?: (p: PlanProposal, sig: InducedSignal) => boolean | Promise<boolean>;
  sessionFactory?: () => Promise<BrowserSession>;
  verbose?: boolean;
  maxSteps?: number;
}

export interface PlannedStep {
  id: string; desc: string; page: string; lands: string;
  signal: { page: string };
  signal_source: "induced" | "contract";
  targets: SemanticTarget[];
  page_query?: string;
  fills?: string[];
  list_step?: { op: "min" | "max"; by: string };
  dangerous?: boolean;
  evidence: Record<string, unknown> | null;
}

export interface PlanFlowResult {
  app: string;
  site: string;
  goal: string;
  slots: Record<string, unknown>;
  steps: PlannedStep[];
  profile: SiteProfile;
  gate: { ok: boolean; line: string; blocked: string[] };
  written: { flow: string; profile: string } | null;
  ok: boolean;
}

/**
 * 首访观察文字系统：`<html lang>` 声明 + 正文片段。函数的构造方式与 `WITNESS_FN` 同款
 * （源码字符串 → 真函数 → 交给 Playwright 序列化），任何失败都退化成"没有声明 → 按空文本判"，
 * 绝不因为一次 evaluate 失败而停。
 */
const LOCALE_JS = `() => ({
  lang: (document.documentElement && document.documentElement.getAttribute('lang')) || null,
  text: ((document.body && document.body.innerText) || '').slice(0, 4000),
})`;
const LOCALE_FN = new Function(`return (${LOCALE_JS});`)() as () => { lang: string | null; text: string };

async function observePageLocale(
  session: BrowserSession,
): Promise<{ locale: string; checkpoint: CheckpointId }> {
  try {
    const seen = await (session.page as unknown as {
      evaluate: (fn: unknown) => Promise<{ lang: string | null; text: string }>;
    }).evaluate(LOCALE_FN);
    return observeLocale(seen?.lang ?? null, seen?.text ?? "");
  } catch {
    return observeLocale(null, "");
  }
}

export async function planFlow(opts: PlanFlowOptions): Promise<PlanFlowResult> {
  const {
    goal, seedUrl, app, site,
    laya = "scripted", escalate = "scripted",
    yes = false, verbose = true, maxSteps = 12,
  } = opts;
  // 落点默认移出 checkout（P0-⑥ / 前提 A）：规划出来的应用是**用户本地产物**，写
  // `$AMBERFLOW_HOME/apps`；显式传 appsDir 时听调用方的（测试/工具都传）。
  const appsRoot = opts.appsDir ?? userAppsDir();
  // 迁移模式的配方可能在仓库夹具里（`apps/<id>/flow.json` 是 authored 模板，跟代码版本走）。
  // 用户目录还没有它 → 先把**仓库里的整个应用目录**拷到用户作用域再走既有流程：
  // 读得到、门控用得着、其它站点的档案不丢，而且**checkout 一个字节都不写**。
  if (appsRoot !== APPS_DIR && !fs.existsSync(path.join(appsRoot, app))) {
    const repoApp = path.join(APPS_DIR, app);
    if (fs.existsSync(path.join(repoApp, "flow.json"))) {
      ensureDir(appsRoot);
      fs.cpSync(repoApp, path.join(appsRoot, app), { recursive: true });
    }
  }
  const params = extractParams(goal);
  const slots: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && v) slots[k] = v;
  }

  // 迁移模式：已有模板就是配方。写暂存副本，门控过了才换回正式文件。
  const existingFlowPath = path.join(appsRoot, app, "flow.json");
  const existing = fs.existsSync(existingFlowPath)
    ? JSON.parse(fs.readFileSync(existingFlowPath, "utf-8")) as FlowTemplate
    : undefined;
  const planner = opts.planner ?? (existing ? templatePlanner(existing) : goalRecipePlanner(goal, params));

  const staging = path.join(appsRoot, `.plan-staging-${app}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, "sites"), { recursive: true });
  if (existing) {
    // 暂存 = 正式目录的拷贝：门控用的 runFlow 从 appsRoot/<app>/flow.json 读模板与**其它站**的档案。
    fs.cpSync(path.join(appsRoot, app), staging, { recursive: true });
  }

  const ownSession = opts.sessionFactory === undefined;
  const session = ownSession ? await browserSession(true) : await opts.sessionFactory!();
  // §3 文字系统路由：首访就把这一页的脚本结论观察进档案（<html lang> 声明优先，
  // 否则按 CJK 占比）——运行期据此选 checkpoint，是 Router 的同一判据落成数据。
  // 观察放在第一轮 goto 之后：会话刚起来时页面还是 about:blank。
  let observedLocale = observeLocale(null, "");
  const steps: PlannedStep[] = [];
  const pages: Record<string, string> = {};
  const fillKeys: Record<string, Record<string, string>> = {};
  const pageQuery: Record<string, string> = {};
  const listExtract: Record<string, ListExtract> = {};
  const frozenSignals: Record<string, Record<string, unknown>> = {};
  let currentUrl = startUrl(seedUrl);
  const ask = opts.confirmStep ?? (async (p: PlanProposal, sig: InducedSignal): Promise<boolean> => {
    if (yes) return true;
    const rl = await import("node:readline/promises");
    const r = rl.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await r.question(
        `下一步：${p.desc}（完成判据：${sig.kind} ${JSON.stringify(sig.signal)}）确认？ [y/n] `,
      )).trim().toLowerCase();
      return a === "" || a === "y" || a === "yes";
    } finally { r.close(); }
  });

  // 规划期的决策面与运行期同款：scripted 替身（或 unsure 逼出老师）。数组随演示增长，工厂惰性查它。
  const planePairs: Array<{ desc: string; targets: SemanticTarget[] }> = [];
  installLayaRuntime(scriptedRuntime(scriptedSemanticAgent(planePairs, laya === "unsure")));
  const teacher: EscalatorLike | null = escalate === "scripted" ? scriptedTeacher(planePairs)
    : escalate === "llm" ? llmEscalator() : null;
  const mw = new BrowserMiddleware({
    modelId: "english", auditor: new MockAuditor(), maxSteps: 6,
    confFloor: 0.25, riskyThreshold: 0.6, doneThreshold: 0.5,
    // 规划期只点演示过的步；风险照旧记录，购买这类不可逆动作的闸在运行期（dangerous + 确认）。
    confirmFn: () => true,
    ...(teacher !== null ? { escalateFn: teacher } : {}),
  });

  try {
    for (let guard = 0; guard < maxSteps; guard++) {
      const pg = session.page as { goto: (u: string, o?: unknown) => Promise<void> };
      await pg.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (guard === 0) observedLocale = await observePageLocale(session);
      const elems = await extractElements(session.page as never);
      const crit = criteriaView(elems, new Set(), null);
      const proposal = await planner({
        goal, slots,
        completed: steps.map((s) => ({ id: s.id, desc: s.desc })),
        url: currentUrl, title: await (session.page as { title: () => Promise<string> }).title(),
        criteria: crit,
      });
      if (proposal === null) break;

      // 危险步在规划期也要点头才演示——"看页面规划"不能以真下单一副代价换一条判据。
      if (proposal.dangerous === true && opts.allowDangerousDemo !== true) {
        throw new Error(`planning reached the dangerous step ${JSON.stringify(proposal.id)} `
          + "— the plan phase will not demonstrate an irreversible action without "
          + "allowDangerousDemo (fixtures/sandboxes only). Nothing was written.");
      }

      const startFile = fileOf(currentUrl);
      const execDesc = sub(proposal.desc, slots);
      const execTargets = proposal.targets.map((t) => subTarget(t, slots));
      const pairsEntry = planePairs.find((p) => p.desc === execDesc);
      if (pairsEntry === undefined) planePairs.push({ desc: execDesc, targets: execTargets });
      else pairsEntry.targets = execTargets;

      // 两次独立演示：每次都从**本步的起始 URL** 重新导航（执行器的重导航语义就是回放语义），
      // before/after 各采一对——重放可复现三关的现场版。
      const baseStart = currentUrl;
      const runs: Array<[StateView, StateView]> = [];
      let landedUrl = "";
      let evidence: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        await pg.goto(baseStart, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const before = await captureStateView(session.page as never);
        const stepStart = baseStart;
        if (proposal.list) {
          const disc = await discoverListConfig(session.page, proposal.list.by);
          // "选哪一行"只有一份实现（P3 数据槽层 → datasource.selectIndex）：规划期演示选中的那一行
          // 与运行期 `list_step` 选的那一行必须是同一条规则，否则写进档案的 chosen_row 会骗人。
          const picked = resolveBinding(
            { from: "list", by: "v", order: proposal.list.op },
            { rows: disc.values.map((v) => ({ v })) },
          );
          if (!picked.ok) throw new Error(`list step ${proposal.id}: ${picked.reason}`);
          const idx = picked.index ?? -1;
          const loc = (session.page as {
            locator: (s: string) => {
              nth: (i: number) => { locator: (s: string) => { first: () => { click: (o: unknown) => Promise<void> } } };
            };
          }).locator(disc.cfg.row_sel).nth(idx).locator(String(disc.cfg.act_sel ?? "button")).first();
          await loc.click({ timeout: 5_000 });
          await (session.page as { waitForLoadState: (s: string, o?: unknown) => Promise<void> })
            .waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
          landedUrl = urlOf(session.page as never);
          if (attempt === 0) {
            listExtract[proposal.id] = disc.cfg;
            evidence = {
              rows: disc.rows.length, values: disc.values,
              chosen_row: disc.rows[idx], chosen_value: disc.values[idx],
            };
          }
        } else {
          const stepSlots: Record<string, unknown> = { ...slots };
          if (proposal.fills?.length) {
            const fmap = observeFillKeys(elems, proposal.fills, slots);
            for (const [fieldKey, slotName] of Object.entries(fmap)) stepSlots[fieldKey] = slots[slotName];
            if (attempt === 0) fillKeys[proposal.id] = fmap;
          }
          const rep = await mw.run(execDesc, stepStart, {
            page: session.page as never, pw: session.pw as never,
            slots: stepSlots,
            // 规划期的完成验收 = "页面确实动了"；真判据由 ④ 的归纳给出（信号才是落盘的东西）。
            goalSignalFn: async (p: unknown) => urlOf(p as never) !== stepStart,
            verbose: false,
          });
          landedUrl = urlOf(session.page as never);
          if (landedUrl === stepStart) {
            throw new Error(`step ${JSON.stringify(proposal.id)} did not advance the page: ${rep.stop_reason}`);
          }
        }
        const after = await captureStateView(session.page as never);
        runs.push([before, after]);
      }
      currentUrl = landedUrl;

      const landingFile = fileOf(landedUrl);
      // 落点角色名：模型给了就用；没给（演示前不可能知道）就用观察到的文件名——
      // 模板里的 signal/invariant 引用的是**这个名字**，映射表 pages 里再落真文件。
      const landsRole = proposal.lands !== "" ? proposal.lands : landingFile;
      pages[proposal.page] = startFile;
      pages[landsRole] = landingFile;
      const qt = generalizeQuery(runs[0]![0]!.url, slots);
      if (qt !== "") pageQuery[proposal.id] = qt;
      const sig = pickInducedSignal(runs, landsRole, landingFile);
      if (sig.kind === "manual") {
        throw new Error(`step ${JSON.stringify(proposal.id)}: no discriminating reproducible signal — `
          + "plan stops instead of guessing（learn 的纪律）");
      }
      if (sig.kind === "induced") frozenSignals[proposal.id] = generalizeSignalValues(sig.signal, slots);

      steps.push({
        id: proposal.id, desc: proposal.desc, page: proposal.page, lands: landsRole,
        signal: { page: landsRole },
        signal_source: sig.kind,
        targets: proposal.targets,
        ...(qt !== "" ? { page_query: qt } : {}),
        ...(proposal.fills?.length ? { fills: proposal.fills.map((f) => f.slot) } : {}),
        ...(proposal.list ? { list_step: proposal.list } : {}),
        ...(proposal.dangerous ? { dangerous: true } : {}),
        evidence,
      });
      const ok = await ask(proposal, sig);
      if (!ok) throw new Error(`human declined step ${JSON.stringify(proposal.id)} — plan aborted`);
      if (verbose) {
        console.log(`  [${proposal.id}] ${execDesc}  ->  ${landingFile}`
          + `  判据: ${sig.kind} ${JSON.stringify(sig.signal)}`
          + (evidence !== null ? `  证据: ${JSON.stringify(evidence)}` : ""));
      }
    }

    if (!steps.length) throw new Error("the planner produced no steps for this goal");

    /* ---- 组装模板 + 档案（写进 staging），重放门控整跑一遍才算数 ---- */
    const template: FlowTemplate = existing
      ? {
        ...existing,
        // 迁移不改模板的页面角色默认值与已有站点；只补本站的 sites 条目（若缺）。
        sites: { ...existing.sites, [site]: existing.sites[site] ?? { label: site, start_url: seedUrl } },
      }
      : {
        spec_version: 2, id: app, label: goal, goal,
        model: "english",
        slots,
        sites: { [site]: { label: site, start_url: seedUrl } },
        pages,
        steps: steps.map((s) => ({
          id: s.id, desc: s.desc, page: s.page,
          ...(s.page_query !== undefined ? { page_query: s.page_query } : {}),
          ...(s.targets.length === 1 ? { semantic_target: s.targets[0]! }
            : s.targets.length > 1 ? { semantic_targets: s.targets } : {}),
          ...(s.fills !== undefined ? { fills: s.fills } : {}),
          ...(s.list_step !== undefined ? { list_step: s.list_step } : {}),
          signal: s.signal,
          ...(s.dangerous === true ? { dangerous: true } : {}),
        })) as FlowTemplate["steps"],
        invariants: [{ page: steps[steps.length - 1]!.lands }],
        notes: [
          `planned: goal=${JSON.stringify(goal)} seed=${JSON.stringify(seedUrl)} site=${site}`,
          "signals/queries/fill bindings/row extraction are OBSERVED on the first walk;",
          "completion truth stays DOM/URL (induced, discriminating, reproducible across 2 demos).",
          "hints are NOT written here — the runtime backfill ring earns them on the first real runs.",
        ],
      };

    const profile: SiteProfile = {
      spec_version: 2, site,
      label: `planned profile for ${site}`,
      // 文字系统路由结论（§3）：运行期据此选 checkpoint。
      locale: observedLocale.locale,
      checkpoint: observedLocale.checkpoint,
      ...(Object.keys(pageQuery).length ? { page_query: pageQuery } : {}),
      ...(Object.keys(fillKeys).length ? { fill_keys: fillKeys } : {}),
      ...(Object.keys(listExtract).length ? { list_extract: listExtract } : {}),
      ...(Object.keys(frozenSignals).length ? { frozen_signals: frozenSignals } : {}),
      steps: {},
    };
    // 迁移到页面文件名不同的站点：profile.pages 必须带上本站观察（模板默认值不动别的站点）。
    if (existing) profile.pages = pages;

    fs.writeFileSync(path.join(staging, "flow.json"), JSON.stringify(template, null, 2) + "\n", "utf-8");
    fs.writeFileSync(path.join(staging, "sites", `${site}.profile.json`),
      mergeInto(path.join(staging, "sites", `${site}.profile.json`), profile), "utf-8");

    const { runFlow } = await import("./semantic-flow.ts");
    const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-gate-"));
    let gateOk = false; let line = ""; const blocked: string[] = [];
    try {
      // 门控从 **staging** 读模板与档案（runFlow 按 appsRoot/.plan-staging-<app>/ 发现）；
      // 学习面隔离在临时目录——plan 不种 hint，hint 属于运行期回填环。
      const gate = await runFlow(path.basename(staging), site, {
        profileDir: gateDir, fresh: true, laya, writeProfile: false,
        escalate: escalate === "llm" ? "llm" : escalate === "none" ? "none" : "scripted",
        confirmDangerous: () => true, verbose: false, appsDir: appsRoot,
      });
      gateOk = gate.ok; line = gate.line;
      blocked.push(...gate.steps.filter((s) => s.status === "blocked" || s.status === "refused")
        .map((s) => `${s.id}: ${s.obstacle ?? s.status}`));
    } catch (e) {
      blocked.push(String(e instanceof Error ? e.message : e));
    }

    if (!gateOk) {
      throw new Error(`replay gate FAILED — nothing was written: ${line}`
        + (blocked.length ? `\n  - ${blocked.join("\n  - ")}` : ""));
    }

    const target = path.join(appsRoot, app);
    let written: { flow: string; profile: string };
    if (existing) {
      // 迁移：只换本站档案 + 模板（若模板没改动过内容，写回也无害）；其它站点文件不动。
      fs.writeFileSync(existingFlowPath, JSON.stringify(template, null, 2) + "\n", "utf-8");
      const profPath = path.join(appsRoot, app, "sites", `${site}.profile.json`);
      fs.writeFileSync(profPath, mergeInto(profPath, profile), "utf-8");
      written = { flow: existingFlowPath, profile: profPath };
    } else {
      if (fs.existsSync(target) && !opts.force) {
        throw new Error(`apps/${app} already exists — pass --force to overwrite`);
      }
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
      written = { flow: path.join(target, "flow.json"), profile: path.join(target, "sites", `${site}.profile.json`) };
    }
    if (verbose) console.log(`  gate: ${line}  ✓ 落盘 ${written.flow}`);
    return {
      app, site, goal, slots, steps, profile,
      gate: { ok: gateOk, line, blocked },
      written, ok: true,
    };
  } finally {
    if (ownSession) await session.close();
    installLayaRuntime(null);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** 把 fresh 档案并入既有档案（staging 可能是正式目录的拷贝；learned steps 与其它先验都不丢）。 */

function mergeInto(existingPath: string, fresh: SiteProfile): string {
  let base: Partial<SiteProfile> = {};
  try { base = JSON.parse(fs.readFileSync(existingPath, "utf-8")) as Partial<SiteProfile>; } catch { /* new file */ }
  const merged: SiteProfile = {
    ...base, ...fresh,
    pages: fresh.pages !== undefined || base.pages !== undefined ? { ...base.pages, ...fresh.pages } : undefined,
    fill_keys: { ...base.fill_keys, ...fresh.fill_keys },
    list_extract: { ...base.list_extract, ...fresh.list_extract },
    frozen_signals: { ...base.frozen_signals, ...fresh.frozen_signals },
    page_query: { ...base.page_query, ...fresh.page_query },
    steps: { ...base.steps, ...fresh.steps },
  };
  for (const k of Object.keys(merged) as Array<keyof SiteProfile>) {
    if (merged[k] === undefined) delete merged[k];
  }
  return JSON.stringify(merged, null, 2) + "\n";
}

/* ------------------------------------------------------------------ CLI */

const USAGE = `usage: plan-flow --goal "..." --seed <page|url> --app ID [--site KEY]
                   [--planner scripted|llm] [--laya scripted|unsure] [--escalate scripted|llm|none]
                   [--yes] [--force] [--allow-dangerous-demo] [--json] [--quiet] [--list]

一句话 + 种子页 → 看页面逐步规划 → 信号归纳 → v2 模板 + 站点档案（重放门控后落盘）。
危险步（购买）默认不演示——加 --allow-dangerous-demo 只在复刻站/沙箱页开。`;

/** 站点键：--site 优先；否则用 seed 路径的目录名（file://）或主机名（http）。 */
export function siteKeyFor(seed: string): string {
  if (seed.includes("://")) {
    try {
      const u = new URL(seed);
      return u.protocol === "file:" ? path.basename(u.pathname.replace(/\/[^/]*$/, "")) || "site" : u.host;
    } catch {
      return "site";
    }
  }
  return path.basename(path.dirname(seed.replace(/[/\\][^/\\]*$/, ""))) || path.basename(path.dirname(seed)) || "site";
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  // 打错的参数 → 一行点名 + usage，绝不甩 parseArgs 的堆栈（src/cli-args.ts 的体例）。
  try {
    parsed = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      goal: { type: "string" }, seed: { type: "string" }, app: { type: "string" },
      site: { type: "string" }, planner: { type: "string" }, laya: { type: "string" },
      escalate: { type: "string" }, yes: { type: "boolean" }, force: { type: "boolean" },
      "allow-dangerous-demo": { type: "boolean" },
      json: { type: "boolean" }, quiet: { type: "boolean" }, help: { type: "boolean" },
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
  if (!v.goal || !v.seed || !v.app) { console.error(USAGE); return 2; }
  const plannerKind = String(v.planner ?? "scripted");
  try {
    const result = await planFlow({
      goal: String(v.goal), seedUrl: String(v.seed), app: String(v.app),
      site: v.site !== undefined ? String(v.site) : siteKeyFor(String(v.seed)),
      ...(plannerKind === "llm"
        ? { planner: llmFlowPlanner({ onStop: (reason, detail) => {
          const why: Record<string, string> = {
            "api-error": "调用失败（网络/HTTP）——已抛出，本次未落盘",
            "empty-reply": "模型回了空内容（fail-closed 停止）",
            "no-json": "模型回答里没有 JSON（fail-closed 停止）",
            "bad-json": "模型回答的 JSON 解析失败（fail-closed 停止）",
            "invalid-schema": "模型回答不符合步骤契约（fail-closed 停止）",
            "done": "模型判定目标已达到（{done:true}）——规划结束",
          };
          console.error(`规划停止：${why[reason] ?? reason}`
            + (detail !== undefined ? ` ｜ ${JSON.stringify(detail).slice(0, 300)}` : ""));
        } }) } : {}),
      laya: v.laya === "unsure" ? "unsure" : "scripted",
      escalate: v.escalate === "llm" ? "llm" : v.escalate === "none" ? "none" : "scripted",
      yes: v.yes === true, force: v.force === true, verbose: !v.quiet,
      allowDangerousDemo: v["allow-dangerous-demo"] === true,
    });
    if (v.json) {
      console.log(JSON.stringify({
        status: "planned", app: result.app, site: result.site, ok: true,
        slots: result.slots,
        steps: result.steps.map((s) => ({ id: s.id, desc: s.desc, signal_source: s.signal_source })),
        gate: result.gate.line, written: result.written,
      }, null, 2));
    } else if (!v.quiet) {
      console.log(`\n模板：${result.written?.flow}\n档案：${result.written?.profile}\n门控：${result.gate.line}`);
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    if (v.json) console.log(JSON.stringify({ status: "failed", error: msg }, null, 2));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
