/**
 * 动作可及性（actionability）：遮挡探针、中心命中关系、可动作祖先重定向。
 *
 * 从执行器类拆出的叶子实现（存量文件只减不增的尺寸纪律）：执行器类只保留薄委托。
 * 中心命中判据单源 = eval-snippets 的 `FN_HIT_RELATION`（self / descendant / ancestor /
 * covered / zero-size / offscreen）。**祖先命中 = 元素本身不可命中**（pointer-events:none
 * 或布局画在祖先上）：Playwright 的动作性检查会拒绝点击，而冒泡语义下真人点击由祖先
 * handler 处理——所以动作面必须重定向到最近的可动作祖先（见 `clickActionableAncestor`）。
 */
import { FN_HIT_RELATION } from "./eval-snippets.ts";
import { hintCandidates } from "./rules.ts";
import { firstLoc } from "./executor-pure.ts";
import { actionCapabilities, type Elem, type ElemPool, type PageLike, frameAt, urlOf } from "./extraction.ts";
import type { AnyLoc, AnyPage } from "./executor-types.ts";
import type { BrowserMiddleware } from "./executor.ts";

/**
 * 超时对账（**派发可能已发生**的唯一定性办法）：动作超时后，URL 与动作前不同即
 * "点击已派发并生效"——Playwright 的动作性检查可能因页面在点击中途换页/换节点而超时，
 * 而副作用已经发生。判据只用 URL（无额外页面往返、不猜页面状态）；URL 未变 = **未知**
 * （派发与未派发都可能），由调用方如实报 `execution_state:"unknown"`，不得报 `executed:false`。
 *
 * 为什么这条必须是引擎事实而不是调用方推断：对破坏性动作，把"未知"说成"没执行"会诱发
 * 重复执行；说成"执行了"会掩盖真失败。两者都错，所以只有 `navigated` 是布尔事实，
 * 其余留给调用方按停因码分支。
 */
export function timeoutDispatchNavigated(urlBefore: string, urlAfter: string): boolean {
  return urlBefore !== urlAfter;
}

/** 中心点命中关系（`hitRelation` 返回形状；读不到 = unknown，不造假）。 */
export interface HitRelation { relation: string; blocker: string | null }

/** Playwright 失败 → 一行证据：拦截者（"… intercepts pointer events"）比只看首行可诊断。 */
export function describeActionFailure(e: unknown): string {
  const lines = (e instanceof Error ? e.message : String(e)).split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => l.includes("intercepts pointer events"));
  const text = hit === undefined ? (lines[0] ?? "") : `${lines[0] ?? ""} — ${hit}`;
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}

/** 中心点命中关系（单源 = FN_HIT_RELATION；evaluate 失败 = unknown）。 */
export async function hitRelation(mw: BrowserMiddleware, loc: AnyLoc): Promise<HitRelation> {
  try {
    const raw = await firstLoc(loc).evaluate(FN_HIT_RELATION);
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>;
      return {
        relation: typeof r["relation"] === "string" ? r["relation"] : "unknown",
        blocker: typeof r["blocker"] === "string" ? r["blocker"] : null,
      };
    }
  } catch (e) {
    mw._lastProbeError = describeActionFailure(e);
  }
  return { relation: "unknown", blocker: null };
}

/**
 * 把点击重定向到**最近的可动作祖先**（元素本身不可命中、点击由祖先前台接住时）。
 *
 * 判据：祖先中心点的 elementFromPoint 命中祖先自身或其后代（祖先真的接住点击），且祖先是
 * 可动作形状（role 为 menuitem / menuitemradio / menuitemcheckbox / button / option / tab /
 * link / checkbox / radio / switch；或 tag 为 a / button / label；或 jsaction 含 click /
 * onclick；或 cursor:pointer）。临时盖 `data-af-ancestor` 章定位（帧内作用域，与 A3 探针章
 * 同一纪律），点击后无论成败都清章。成功返回祖先摘要并落 `mw._lastAncestorRetarget`。
 */
export async function clickActionableAncestor(mw: BrowserMiddleware, page: AnyPage,
    el: Elem | null, loc: AnyLoc, timeoutMs: number): Promise<string | null> {
  const token = `anc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const frame = el === null ? undefined : el["frame"];
  const scope: any = frame ? (frameAt(page, frame as number) ?? page) : page;
  try {
    const raw = await firstLoc(loc).evaluate((node: any, tok: string) => {
      const d = globalThis as unknown as {
        document: any;
        innerWidth: number;
        innerHeight: number;
        getComputedStyle: (x: any) => { cursor: string };
      };
      const doc = d.document;
      const actionable = (n: any): boolean => {
        const role = String(n.getAttribute?.("role") ?? "").toLowerCase();
        const tag = String(n.tagName || "").toLowerCase();
        const js = String(n.getAttribute?.("jsaction") ?? "");
        if (["menuitem", "menuitemradio", "menuitemcheckbox", "button", "option", "tab",
          "link", "checkbox", "radio", "switch"].includes(role)) return true;
        if (tag === "a" || tag === "button" || tag === "label") return true;
        if (js.includes("click") || n.hasAttribute?.("onclick")) return true;
        try { return d.getComputedStyle(n).cursor === "pointer" } catch { return false }
      };
      let n = node.parentElement;
      for (let i = 0; i < 8 && n && n !== doc.body && n !== doc.documentElement; i++, n = n.parentElement) {
        const rr = n.getBoundingClientRect();
        if (!rr.width || !rr.height) continue;
        if (!actionable(n)) continue;
        const x = rr.x + rr.width / 2, y = rr.y + rr.height / 2;
        if (x < 0 || y < 0 || x > d.innerWidth || y > d.innerHeight) continue;
        const top = doc.elementFromPoint(x, y);
        if (!top || !(top === n || n.contains(top))) continue;   // 祖先自身必须接住点击
        n.setAttribute("data-af-ancestor", tok);
        return { desc: `${String(n.tagName || "").toLowerCase()}${n.id ? "#" + n.id : ""}` };
      }
      return null;
    }, token);
    if (raw === null || typeof raw !== "object") return null;
    const ancLoc = scope.locator(`[data-af-ancestor='${token}']`);
    if (Number(await ancLoc.count()) !== 1) return null;
    await ancLoc.click({ timeout: timeoutMs });
    mw._lastAncestorRetarget = String((raw as Record<string, unknown>)["desc"] ?? "ancestor");
    return mw._lastAncestorRetarget;
  } catch (e) {
    mw._lastProbeError = describeActionFailure(e);
    return null;
  } finally {
    try {
      await firstLoc(loc).evaluate((node: any, tok: string) => {
        const a = node.ownerDocument.querySelector(`[data-af-ancestor='${tok}']`);
        if (a) a.removeAttribute("data-af-ancestor");
      }, token);
    } catch {
      /* the node may be detached after the click */
    }
  }
}

/**
 * 遮挡/可动作性预检（单动作面）：先打一次短探针真点击；超时后按中心命中关系分流——
 * 祖先命中 → 重定向到可动作祖先；第三方覆盖/零尺寸/离屏 → `not-actionable-or-covered:<blocker>`
 * + 结构化现场；自身命中 → 慢元素一次长重试，仍失败才 `action-timeout`。
 * 返回 `"__clicked__"` = 探针已经完成真点击（调用方按已动作处理）。
 */
export async function occlusionProbe(mw: BrowserMiddleware, page: AnyPage, el: Elem,
    probeMs = 800, slowMs = 2500): Promise<string | null> {
  mw._lastActionabilityDetail = null;
  mw._lastProbeError = null;
  mw._lastAncestorRetarget = null;
  mw._lastTimeoutNavigated = false;
  const loc = await mw._locatorFor(page, el);
  if (loc === null) return "stale_ref";
  // 超时对账基线：动作前的 URL（零额外往返）。点击派发可能在超时前生效——URL 变了就是
  // 已动作的硬证据，不能把"慢"说成"没执行"（破坏性动作会因此被重复执行）。
  const urlBefore = urlOf(page as unknown as PageLike);
  try {
    await firstLoc(loc).click({ timeout: probeMs });   // real click; usually succeeds
    return "__clicked__";                              // caller treats as done action
  } catch (ex) {
    const msg = String((ex as Error)?.message ?? ex);
    if (!msg.toLowerCase().includes("timeout")) {
      // B1：click 可能已派发（非 timeout 异常）——记下首行供单动作面 action_failed 使用。
      mw._lastProbeError = describeActionFailure(ex);
      return null;
    }
    const rel = await hitRelation(mw, loc);
    if (rel.relation === "ancestor") {
      // 元素本身不可命中、点击由祖先 handler 承接 → 重定向；不重定向只能白等慢重试后
      // 报无信息量的 action-timeout，且 ref 会被拉黑（实测：Google Maps 评分筛选行）。
      if (await clickActionableAncestor(mw, page, el, loc, slowMs) !== null) return "__clicked__";
      const reason = "not-actionable-or-covered:ancestor";
      mw._lastActionabilityDetail = await mw._readActionabilityDetail(loc, reason);
      return reason;
    }
    if (rel.relation === "covered" || rel.relation === "zero-size" || rel.relation === "offscreen") {
      const reason = `not-actionable-or-covered:${rel.blocker ?? rel.relation}`;
      mw._lastActionabilityDetail = await mw._readActionabilityDetail(loc, reason);
      return reason;
    }
    // self/descendant/none/unknown：中心点没有第三方覆盖，短预算只是不够——慢元素一次长重试。
    // Measured on the live saucedemo logout: the sidebar slides in over 0.5 s and Playwright
    // would not commit the click inside the 0.8 s probe, so the ordered `target_hints`
    // sequence lost its last target and the long flow blocked on a link that works ~1 s later.
    try {
      await firstLoc(loc).click({ timeout: slowMs });
      return "__clicked__";
    } catch {
      // 长重试也超时：URL 与探针前不同 = 点击已在途中生效（含被探针那次派发推进的异步导航）。
      // 记成事实供调用方按已动作处理；URL 未变 = 未知（不冒充 either way）。
      mw._lastTimeoutNavigated = timeoutDispatchNavigated(urlBefore, urlOf(page as unknown as PageLike));
      return "action-timeout";   // still not actionable: it is not just slow
    }
  }
}

/** DRF 目标的动作前 hit-test（P0-C）：self/descendant = ok；ancestor/covered = 拒绝并带 blocker。 */
export async function declaredHitTest(mw: BrowserMiddleware, page: AnyPage, el: Elem):
  Promise<{ ok: true } | { ok: false; kind: "covered" | "ancestor"; blocker: string }> {
  const loc = await mw._locatorFor(page, el);
  if (loc === null) return { ok: false, kind: "covered", blocker: "stale_ref" };
  try {
    // 先滚入视口（原判据的前置动作）；中心命中判据单源 = FN_HIT_RELATION。
    await firstLoc(loc).evaluate((node: any) => {
      try { node.scrollIntoView({ block: "center", inline: "center" }); } catch { /* ignore */ }
    });
    const rel = await hitRelation(mw, loc);
    if (rel.relation === "self" || rel.relation === "descendant") return { ok: true };
    if (rel.relation === "ancestor") return { ok: false, kind: "ancestor", blocker: rel.blocker ?? "ancestor" };
    return { ok: false, kind: "covered", blocker: rel.blocker ?? rel.relation };
  } catch {
    return { ok: false, kind: "covered", blocker: "probe-failed" };
  }
}

/** 池外回退（`el === null`，如 0×0 手柄 / 未进池但 DOM 可直查的 #id）：直查 locator 点一次；
 *  祖先接住点击时与池内元素同一处置（重定向），否则如实抛出给调用方报 action_failed。 */
export async function clickPoollessTarget(mw: BrowserMiddleware, page: AnyPage, loc: AnyLoc): Promise<void> {
  try {
    await firstLoc(loc).click({ timeout: 5000 });
  } catch (e) {
    if (!String((e as Error)?.message ?? e).toLowerCase().includes("timeout")) throw e;
    if ((await hitRelation(mw, loc)).relation !== "ancestor") throw e;
    if (await clickActionableAncestor(mw, page, null, loc, 5000) === null) throw e;
  }
}

/**
 * 同单元折叠（歧义判定的父节点综合判断）：同 label 命中档里的候选若属于**同一个可动作
 * 单元**，取组内执行者直接执行，不判 `target_ambiguous`。两级判据，互不包含的同 label
 * 候选（两行同名 "Add to basket" 那种跨行兄弟组）仍由既有谓词零动作真歧义：
 *   ① DOM 包含——容器 vs 它自己的链接/控件（容器文案继承自子节点），保留可动作后代；
 *   ② 共同交互祖先——互不包含但同属一张卡片/一行（典型：覆盖链接按 aria-label 与
 *      可见标题 div 同 label，如 Maps 结果卡），组内**唯一 native 控件**即执行者。
 * 探测即清章（每对 ≤4 次页面往返；同祖先判定 n+2 次）；任何探测失败 = fail-open
 * 回既有歧义谓词，绝不猜。
 */
export async function foldNestedDuplicates(mw: BrowserMiddleware, page: AnyPage,
    elems: ElemPool, target: string, op: string): Promise<string[] | null> {
  const cand = hintCandidates(target, elems, {});
  if (cand === null || cand.decided !== null || cand.refs.length < 2 || cand.refs.length > 6) return null;
  const refs = cand.refs;
  const token = `fold-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  /** 探测一对候选的 DOM 包含方向：`"a>b"` = A 含 B；`"b>a"` = B 含 A；null = 互不包含/读不到。 */
  const relation = async (ra: string, rb: string): Promise<"a>b" | "b>a" | null> => {
    const la = await mw._locatorFor(page, elems[ra]!); const lb = await mw._locatorFor(page, elems[rb]!);
    if (la === null || lb === null) return null;
    const tok = { a: `a${token}`, b: `b${token}` };
    try {
      await firstLoc(la).evaluate((n: any, t: string) => n.setAttribute("data-af-fold", t), tok.a);
      await firstLoc(lb).evaluate((n: any, t: string) => n.setAttribute("data-af-fold", t), tok.b);
      const rel = await firstLoc(la).evaluate((n: any, t: { a: string; b: string }) => {
        const other = n.ownerDocument.querySelector(`[data-af-fold='${t.b}']`);
        if (other === null) return null;
        if (n.contains(other)) return "a>b";
        if (other.contains(n)) return "b>a";
        return null;
      }, tok);
      return rel === "a>b" || rel === "b>a" ? rel : null;
    } catch {
      return null;
    } finally {
      await firstLoc(la).evaluate((n: any) => n.removeAttribute("data-af-fold"), tok.a).catch(() => {});
      await firstLoc(lb).evaluate((n: any) => n.removeAttribute("data-af-fold"), tok.b).catch(() => {});
    }
  };
  // ① 包含折叠：祖先出列，保留后代。部分包含但剩 >1 = 链不完整，按真歧义处理。
  const survivors = new Set(refs);
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      const rel = await relation(refs[i]!, refs[j]!);
      if (rel === "a>b") survivors.delete(refs[i]!);
      else if (rel === "b>a") survivors.delete(refs[j]!);
    }
  }
  const pick = (ref: string): string[] | null =>
    elems[ref] !== undefined && actionCapabilities(elems[ref]!).includes(op as never) ? [ref] : null;
  if (survivors.size === 1) return pick([...survivors][0]!);
  if (survivors.size !== refs.length) return null;
  // ② 共同交互祖先折叠：全部候选同属一个交互单元（卡片/行）且组内恰一个 native 控件。
  const unitExecutor = await commonUnitExecutor(mw, page, elems, refs, token);
  return unitExecutor === null ? null : pick(unitExecutor);
}

/**
 * 同单元判定（最低公共祖先版）+ 组内执行者选择。native 序纯内存可算
 * （a/button/input/label/select/textarea = 0，其余 = 1）：恰一个 native 才折叠——
 * 一卡双同名 native 控件语义不可分，仍真歧义。LCA 判据不被中间样式层（如标题容器的
 * cursor:pointer）欺骗：先给首个候选的祖先链盖章，其余候选向上找**第一个带章节点**
 * = 与首候选链的 LCA；LCA 是交互单元且非 body/html/main 泛容器（跨单元 = 真歧义）。
 */
async function commonUnitExecutor(mw: BrowserMiddleware, page: AnyPage,
    elems: ElemPool, refs: string[], token: string): Promise<string | null> {
  const native = (ref: string): boolean =>
    ["a", "button", "input", "label", "select", "textarea"].includes(String(elems[ref]?.tag ?? ""));
  const natives = refs.filter(native);
  if (natives.length !== 1) return null;
  const winner = natives[0]!;
  const locs: Array<{ ref: string; loc: AnyLoc | null }> = [];
  for (const r of refs) locs.push({ ref: r, loc: await mw._locatorFor(page, elems[r]!) });
  if (locs.some((x) => x.loc === null)) return null;
  const ancMark = `anc${token}`;
  const walk = (fn: unknown, arg: unknown, loc: AnyLoc) => firstLoc(loc).evaluate(fn, arg);
  try {
    // ① 首候选祖先链盖章（≤12 层）：其余候选的第一个带章祖先即与首链的 LCA。
    await walk((n: any, m: string) => {
      let p = n.parentElement, i = 0;
      while (p && i < 12) { p.setAttribute("data-af-anc", m); p = p.parentElement; i += 1 }
    }, ancMark, locs[0]!.loc as AnyLoc);
    /** 从候选向上找带章祖先：泛容器（body/html/main）= 跨单元真歧义；签名 = tag#class。 */
    const lcaOf = (loc: AnyLoc) => walk((n: any) => {
      for (let p = n.parentElement, i = 0; p && i < 12; i++, p = p.parentElement) {
        if (p.getAttribute("data-af-anc") !== null) {
          if (/^(?:BODY|HTML|MAIN)$/i.test(p.tagName)) return null;
          return `${p.tagName}#${String(p.className).slice(0, 40)}`;
        }
      }
      return null;
    }, undefined, loc).catch(() => null) as Promise<string | null>;
    let lcaSig: string | null = null;
    for (const { loc } of locs.slice(1)) {
      const sig = await lcaOf(loc as AnyLoc);
      if (typeof sig !== "string") return null;
      if (lcaSig === null) lcaSig = sig;
      else if (lcaSig !== sig) return null;
    }
    if (lcaSig === null) return null;
    // ② LCA 本身必须是交互单元（role / jsaction click / onclick / cursor:pointer）。
    const interactiveOk = await walk((n: any) => {
      for (let p = n.parentElement, i = 0; p && i < 12; i++, p = p.parentElement) {
        if (p.getAttribute("data-af-anc") === null) continue;
        const role = String(p.getAttribute("role") ?? "").toLowerCase();
        const js = String(p.getAttribute("jsaction") ?? "");
        if (["article", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "button", "link", "tab"].includes(role)) return true;
        if (js.includes("click") || js.includes("auxclick") || p.hasAttribute("onclick")) return true;
        try { return (globalThis as unknown as { getComputedStyle: (x: any) => { cursor: string } }).getComputedStyle(p).cursor === "pointer" } catch { return false }
      }
      return false;
    }, undefined, locs[1]!.loc as AnyLoc).catch(() => false);
    return interactiveOk === true ? winner : null;
  } finally {
    await walk((n: any) => {
      let p = n.parentElement, i = 0;
      while (p && i < 13) { p.removeAttribute("data-af-anc"); p = p.parentElement; i += 1 }
    }, undefined, locs[0]!.loc as AnyLoc).catch(() => {});
  }
}

/**
 * 动作前**快速拒绝**（驾驶面准确率闸门）：解析 locator + 一次中心命中关系探测，被第三方
 * 覆盖 / 零尺寸 / 离屏的选中直接判拒绝，返回拒绝码（`unhittable:covered` 等）或 null。
 *
 * 为什么在驾驶面先判：actOnce 的遮挡探针会把「被覆盖」走成 5.8s 慢重试后落
 * `not-actionable-or-covered`，而每一步失败都**计 1 步预算**——实测 Maps 列表里的
 * "Open 24 hours" 文本被卡片覆盖层挡住，连续 3 次选中 = 3 步 + ~17s 全废。此处只付
 * 一次 evaluate（毫秒级）：拒绝 = 不执行、不耗步，账本记 `unhittable:*` 后下一轮换候选。
 * 关系 `self/descendant`（可动作）与 `ancestor`（交由可动作祖先重定向处理）都放行；
 * 探测读不到（unknown）也放行（fail-open，绝不因探针故障卡死）。
 */
export async function pickRejection(mw: BrowserMiddleware, page: AnyPage,
    elems: ElemPool, ref: string, _op: string): Promise<string | null> {
  const el = elems[ref];
  if (el === undefined) return "stale_ref";
  // 能力面**不在此判**（fail-open）：op 由 `elemFamily` 推导、动作可行性交回 actOnce 裁决——
  // 若在这里按 capabilities 拒绝，fill/select/upload 族元素会被判 unsupported 后永久禁选，
  // 比"多花一步拿到 action_unsupported"更糟（能力面与族推导一旦错位就整族不可达）。
  const loc = await mw._locatorFor(page, el);
  if (loc === null) return "stale_ref";
  const rel = await hitRelation(mw, loc);
  if (rel.relation === "covered" || rel.relation === "zero-size" || rel.relation === "offscreen") {
    return `unhittable:${rel.relation}`;
  }
  return null;
}

/** 取走并清空「动作重定向到祖先」事实（一次动作只消费一次）。 */
export function takeAncestorRetarget(mw: BrowserMiddleware): string | null {
  const out = mw._lastAncestorRetarget;
  mw._lastAncestorRetarget = null;
  return out;
}
