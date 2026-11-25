/**
 * `frame:<origin>` 帧限定尾缀的**唯一**帧链 helper（提交 A，spec docs/FRAME_SCOPE_HINT_PLAN.md
 * §12.3 R2-1/R2-3/R2-5）。
 *
 * 唯一公式：`fullChain(frame) = [rootOrigin, …, ownOrigin]`（恒含自身帧，外→内）；
 * 声明链是 fullChain 的**后缀**且末段 = 自身帧 origin（尾部对齐比较）。
 * 未知 origin（`about:blank`/srcdoc 的 `"null"`、空串、非 http(s)）⇒ 该帧内元素
 * **不可被任何 `frame:` 命中**（视为 undefined，不是"少一段"，防 srcdoc 子帧被父 origin 误命中）。
 *
 * 为什么独立成模块：池侧（rules/extraction 打点）与回捞/门禁面（identity/declared/executor F64）
 * 共用同一条链判定——两处各判一次就会漂移（本仓 hint 语法漂移过两次，同一条教训）。
 * `frameOriginOf` 从 extraction.ts 移入这里（extraction re-export 保持既有导出面不变），
 * 让本模块对 extraction 只有**类型**依赖、不引入运行期环。
 */
import type { Elem } from "./extraction.ts";
import type { FrameLike, LocLike, PageLike } from "../support/page-like.ts";
import { framesOf, urlOf } from "./page-shapes.ts";
import { frameChainValueProblem } from "./hint.ts";
import { urlInHostsEnvelope, hostMatchesEnv } from "./host-envelope.ts";

/** 一个 frame 的 origin（http/https 规范形）；不可解析/非 http(s)/空 = undefined。 */
function httpOriginOf(frame: FrameLike): string | undefined {
  const origin = frameOriginOf(frame);
  if (!origin || origin === "null") return undefined;
  if (!origin.startsWith("http://") && !origin.startsWith("https://")) return undefined;
  return origin;
}

/** detached（isDetached 有即问；缺省按未 detach 处理）⇒ 帧已死 = 未知 origin。 */
function frameAlive(frame: FrameLike): boolean {
  if (typeof frame.isDetached !== "function") return true;
  try { return frame.isDetached() !== true; } catch { return false; }
}

/**
 * frame 的完整 origin 链（外→内，恒含自身帧）：`[rootOrigin, …, ownOrigin]`。
 * 根判定用 `parentFrame()===null`（**不**假设 `frames()[0]` 是主帧）；无 `parentFrame`
 * 成员（`framesOf` 的 `[page as FrameLike]` 兜底）= 主帧，链 = `[ownOrigin]`。
 * 任一环（含祖先）detached 或 origin 未知 ⇒ undefined。深度帽 8 只防病态循环；
 * 正常页面 `framesOf ≤6`，截断只丢链头、尾部对齐匹配仍正确。
 */
export function frameChainOf(frame: FrameLike): string[] | undefined {
  if (!frameAlive(frame)) return undefined;
  const chain: string[] = [];
  let cur: FrameLike | null = frame;
  for (let depth = 0; cur !== null && depth < 8; depth++) {
    const origin = httpOriginOf(cur);
    if (origin === undefined) return undefined;
    chain.unshift(origin);
    let parent: FrameLike | null = null;
    if (typeof cur.parentFrame === "function") {
      try { parent = cur.parentFrame(); } catch { parent = null; }
    }
    if (parent === null || parent === cur) break;
    if (!frameAlive(parent)) return undefined;
    cur = parent;
  }
  return chain;
}

/**
 * 尾部对齐的核心：声明链是 full 链的**后缀**（外→内；大小写不敏感；声明链更长 = 不命中）。
 * 末段=自身帧 origin 由"full 恒以自身 origin 结尾"保证，不需要单独判。
 */
function chainSuffixMatch(declared: readonly string[], full: readonly string[]): boolean {
  if (declared.length === 0) return true;
  if (declared.length > full.length) return false;
  const off = full.length - declared.length;
  for (let i = 0; i < declared.length; i++) {
    if (full[off + i] !== declared[i]!.toLowerCase()) return false;
  }
  return true;
}

/**
 * 声明链 × **元素**：元素侧完整链 = `[...(frame_path ?? []), frame_origin]`。
 * 两字段都缺（未知 origin 帧，如 about:blank/srcdoc）⇒ 恒 false（不可寻址）。
 * 消费点：rules.hintMatchImpl 入口 entries 过滤（B1；档位因此**在帧内计算**）。
 */
export function frameScopeMatches(
  declaredChain: readonly string[],
  elem: Pick<Elem, "frame_origin" | "frame_path">,
): boolean {
  const origin = typeof elem.frame_origin === "string" ? elem.frame_origin.toLowerCase() : "";
  if (!origin || origin === "null"
    || !(origin.startsWith("http://") || origin.startsWith("https://"))) return false;
  const path = Array.isArray(elem.frame_path)
    ? elem.frame_path.map((x) => String(x ?? "").toLowerCase())
    : [];
  return chainSuffixMatch(declaredChain, [...path, origin]);
}

/**
 * 声明链 × **frame**（回捞/门禁的帧循环过滤：hintLookup / FW8 / DRF / F64 / probeExcludedHint）。
 * 帧 origin 未知（about:blank/srcdoc/detached）⇒ 不命中。
 */
export function frameScopeMatchesFrame(declaredChain: readonly string[], frame: FrameLike): boolean {
  const chain = frameChainOf(frame);
  if (chain === undefined) return false;
  return chainSuffixMatch(declaredChain, chain);
}

/**
 * 帧打点（数据面唯一出处）：`{ frame_origin, frame_path? }`——主帧 path 省略（链=[origin]）；
 * 未知 origin 帧 = 空对象（两字段都不写，"字段省略"口径见 Elem 注释）。
 * 消费点：extractElements 帧合并 / observeElements 帧循环 / heuristic 宽扫 / hintLookup /
 * FW8 合成 Elem / DRF rowToElem / A3 主帧合成行。
 */
export function elemFrameStamp(frame: FrameLike): { frame_origin?: string; frame_path?: string[] } {
  const chain = frameChainOf(frame);
  if (chain === undefined || chain.length === 0) return {};
  return {
    frame_origin: chain[chain.length - 1]!,
    ...(chain.length > 1 ? { frame_path: chain.slice(0, -1) } : {}),
  };
}

/**
 * P0-D：frame 的 origin 证据（解析失败/空 URL 退化为空串）。
 * 自 extraction.ts 移入（本模块是帧链判定的唯一出处；extraction re-export 保持导出面）。
 */
export function frameOriginOf(frame: FrameLike): string {
  let url = "";
  try { url = typeof frame.url === "function" ? frame.url() : (frame.url ?? ""); } catch { url = ""; }
  if (!url) return "";
  try { return new URL(url).origin; } catch { return ""; }
}

/**
 * P0-D：一个 frame 的 URL 是否在**声明的 hosts 信封**内（空 URL / about:blank = 允许；
 * 口径与 `host-envelope.urlInHostsEnvelope` 同一实现）。extraction re-export 保持导出面。
 */
export function frameInHostsEnvelope(frame: FrameLike, hosts: readonly string[] | null | undefined): boolean {
  let url = "";
  try { url = typeof frame.url === "function" ? frame.url() : (frame.url ?? ""); } catch { url = ""; }
  return urlInHostsEnvelope(String(url), hosts as string[] | null | undefined);
}

/** 帧门禁用的 URL 文本（FrameLike.url 双形状；取不到 = 空串）。 */
function frameUrlText(frame: FrameLike): string {
  try { return typeof frame.url === "function" ? frame.url() : (frame.url ?? ""); } catch { return ""; }
}

/** IPv4 形状（4 段全数字）。IPv4 的「最后两段」可以碰巧相等（172.16.1.1 vs 10.16.1.1 的 16.1），两段近似对它不安全 ⇒ 只认精确相等。 */
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * 「同注册域」免检近似：两边的**最后两段**相等即视为同一注册域。本仓不引入 PSL——
 * 多段后缀域（co.uk 这类共用后缀的不同站）是**已知近似误放**（见 `frameGateExcludes`
 * 的边界说明）。单标签（无 `.`，如 localhost）没有「两段」，返回原样（调用方退化为精确相等）。
 */
function lastTwoLabels(host: string): string {
  const parts = host.split(".");
  return parts.length < 2 ? host : parts.slice(-2).join(".");
}

/**
 * 帧免检判定（只认 hostname；协议/端口不参与，与 `hostMatchesEnv` 同口径）：帧与任一
 * 声明条目「同注册域」即免检。域名走**双向**两段近似——只复用 `hostMatchesEnv` 不够：
 * 它是单向子域包含（host 端 endsWith("." + 条目)），声明 `www.google.com`、帧
 * `ogs.google.com` 时两侧谁也不是谁的子域，但注册域都是 `google.com`，语义上同属声明站。
 * IP（IPv4 形状 / 含冒号的 IPv6）精确相等——两段近似对 IP 是误放源。
 */
function frameHostnameExempt(frameHost: string, hosts: readonly string[]): boolean {
  const h = frameHost.toLowerCase();
  const frameIsIp = h.includes(":") || IPV4_RE.test(h);
  return hosts.some((raw) => {
    const entry = String(raw).toLowerCase().replace(/^\.+/, "");
    if (!entry) return false;
    if (frameIsIp || entry.includes(":") || IPV4_RE.test(entry)) return h === entry;
    const frameRd = lastTwoLabels(h);
    const entryRd = lastTwoLabels(entry);
    return frameRd === entryRd || hostMatchesEnv(h, [entry]);
  });
}

/**
 * P0-D **帧门禁谓词**（唯一出处）：主 frame 恒允许（导航信封已经强制过它）；只有子 frame
 * （`fi > 0`）才查 hosts 信封。短路顺序与旧手写一致——`fi === 0` 不解析 URL，不付信封开销。
 *
 * 解析面口径：子帧与**任一声明条目同注册域**即免检（不要求逐条声明子帧 origin；
 * 导航信封本身只认子域包含，声明条目的注册域就是作者声明的站）。仍排除的只有
 * 跨注册域子帧。免检只对子帧的**解析面**生效——导航信封（goto/落地/popup）不受影响，
 * `frameGateExcludes` 是唯一出口，消费点（池/hint/回捞/done/when）自动同口径。
 *
 * 判定边界（`lastTwoLabels` 不引入 PSL 的已知近似）：
 *   - IP 只认精确相等（127.0.0.1 声明 + 127.0.0.2 帧仍排除；两段近似会把
 *     172.16.1.1 / 10.16.1.1 误判同注册域）；
 *   - **宽域声明 = 信任其全部子域**：声明 `evil.io` + 帧 `google.com.evil.io` 免检
 *     （该帧确是声明注册域的下挂，两段近似自洽；不想放它就别声明宽域）；
 *   - 反向必须拦住：声明 `google.com` + 帧 `google.com.evil.io` 排除
 *     （帧的注册域是 evil.io ≠ google.com；`hostMatchesEnv` 对它是 false，靠 rd 不等拦）；
 *   - 同用域组合是**双向近似误放**：`blog.co.uk` 声明 + `news.co.uk` 帧，两侧最后两段
 *     都是 co.uk 又互不为子域 → 误免检（PSL 缺失的已知代价，换回声明面零维护：
 *     ogs.google.com 这类同站子帧天然进池）。声明 `google.com` + 帧 `google.co.uk`
 *     不误放（两段 google.com vs co.uk 不等）。
 *
 * 消费点：extraction 池抽取/信号求值/回捞/probe、declared DRF、identity FW8、
 * executor 的 id 直查回退、ctx scrollList。改门禁口径只改这一个函数。
 */
export function frameGateExcludes(
  fi: number,
  frame: FrameLike,
  hosts: readonly string[] | null | undefined,
): boolean {
  if (fi <= 0) return false;
  if (!hosts || hosts.length === 0) return false;
  if (frameInHostsEnvelope(frame, hosts)) return false;
  // 信封已先行放行不可解析 URL 与 about/data/file 协议，所以这里的解析失败只可能来自
  // 未来信封白名单收缩——按 fail-closed 处理（判不清是否同注册域就不放行进解析面）。
  let host = "";
  try { host = new URL(frameUrlText(frame)).hostname; } catch { return true; }
  return !frameHostnameExempt(host, hosts);
}

/** P0-D：frame 的 origin 证据文案已移入 frame-scope.ts（唯一出处；文件头 re-export 保持导出面）。 */

/**
 * P0-D：**帧门禁**。主 frame 恒允许（导航信封已经强制过它）；子帧按 `frameGateExcludes`
 * 判——跨注册域的 origin 进 `excluded`（不参与池/hint/identity/DRF/done/when 的解析面），
 * 与声明条目同注册域的免检进池。无 hosts 声明或没有任何被排除帧时 `null`
 * （缺省路径零新行为）。
 *
 * 索引纪律：`frames` / `allowedIndexes` 保留**真实**下标，池行的 `frame`/`f<fi>:` ref
 * 因此逐字节不变——被排除的只是解析面，不是编号。
 */
export interface FrameGate {
  hosts: string[];
  frames: FrameLike[];
  allowed: FrameLike[];
  allowedIndexes: number[];
  excluded: Array<{ index: number; frame: FrameLike; origin: string }>;
  origins: string[];
}

export function frameGateOf(page: PageLike, hosts: string[] | null | undefined): FrameGate | null {
  if (!hosts || hosts.length === 0) return null;
  const frames = framesOf(page, 64);
  if (frames.length <= 1) return null;
  const allowed: FrameLike[] = [frames[0]!];
  const allowedIndexes: number[] = [0];
  const excluded: Array<{ index: number; frame: FrameLike; origin: string }> = [];
  for (let i = 1; i < frames.length; i++) {
    const fr = frames[i]!;
    if (frameGateExcludes(i, fr, hosts)) excluded.push({ index: i, frame: fr, origin: frameOriginOf(fr) });
    else { allowed.push(fr); allowedIndexes.push(i); }
  }
  if (excluded.length === 0) return null;
  const origins = [...new Set(excluded.map((e) => e.origin || "about:blank"))];
  return { hosts, frames, allowed, allowedIndexes, excluded, origins };
}

/**
 * P0-D：一个只暴露指定 frame 的**页面视图**（读面用）。只转发信号/池解析真正用到的
 * 成员（url / frames / locator / evaluate）；动作路径永远拿真实 page。
 */
export function framesScopedPage(page: PageLike, frames: FrameLike[]): PageLike {
  const view: PageLike = {
    url: () => urlOf(page),
    frames: () => frames,
    ...(page.locator === undefined ? {} : { locator: (sel, opts) => page.locator!(sel, opts) }),
    ...(page.evaluate === undefined ? {} : { evaluate: (fn, arg) => page.evaluate!(fn, arg) }),
  };
  return view;
}

/** The frame an element came from (0 = main); undefined once it has detached. */
export function frameAt(page: PageLike, index: number): FrameLike | undefined {
  try {
    const f = typeof page.frames === "function" ? page.frames() : page.frames;
    const list = (f ?? []) as FrameLike[];
    return index >= 0 && index < list.length ? list[index] : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------ 读侧帧限定（E4，M4 收口） */

/**
 * E4（读侧帧限定对称化）：CSS 选择器串尾 ` frame:<origin链>` 尾缀的**唯一**剥离出处
 * （消费面：`locatorAnyFrame`/`countAnyFrame` 的帧循环过滤 + ctx 读/抽取面的证据与诊断）。
 *
 * 语义（架构师裁决）：
 *   - **值不合法 ⇒ 整串按原 CSS 处理**（显式落空），绝不半剥——防选择器属性值以
 *     ` frame:` 结尾的伪尾缀误伤。`rejected` 带 B8 同款拒因，调用方只在原样 CSS
 *     解析失败时附注（M4①），成功路径零影响。
 *   - **值合法 ⇒ 帧限定查询**。纯 CSS 形态在 E4 前必然是非法 CSS（`frame:<origin>` 落在
 *     选择器尾只能是伪类语法、永不成立），故尾缀**只能激活原本就保证失败的纯 CSS 串**——
 *     既有 CSS 选择器零影响（无尾缀 = `selector` 逐字节原样返回）。**非 CSS 引擎不保证**
 *     （Playwright `text=` 等把整串当文本）：作者需把文本显式引用（或依赖下列守卫拒绝），
 *     详见 N4 守卫与文档。
 *   - **N4 守卫**：剥离后的 base 必须引号/括号配对（`"`/`'`/`(`/`)`/`[`/`]`；CSS 字符串内
 *     的对比字符不算、反斜杠转义跳过）——`new URL()` 会接受 `)`/`'`/`"` 作为 host 字符，
 *     让 `div:has-text("x frame:https://a.com")` 这类**引号内**的尾缀被误剥；不配对 ⇒
 *     整串原样 + rejected（"选择器含未闭合引号/括号，尾缀未应用"）。
 *   - **N5 空值**：词法收 ` frame:` 后无值（`(\S*)`）——整串原样 + rejected（"frame: 后没有值"）。
 *   - 校验与 hint 的 `frame:` 尾缀同一份 `frameChainValueProblem`（`>` 分隔外→内、
 *     ≤4 段、每段 `v === new URL(v).origin` 的 http(s) 规范形）；同一串至多一个尾缀——
 *     剥离后 base 仍以「规范 origin 值的 frame: 尾缀」结尾 = 第二个真尾缀 ⇒ 整组拒绝
 *     （值内伪尾缀的捕获必然带着 CSS 收尾字符、过不了 origin 校验，不会误伤）。
 *   - `within:` 不在剥面（读侧 CSS 无锚定语义；带 within 的串按原 CSS 显式落空）。
 */
export interface SplitSelectorFrameSuffix {
  /** 剥离后的 CSS（无尾缀/被拒 = **原串逐字节**，含原大小写与空白）。 */
  selector: string;
  /** 合法声明链（小写规范 origin，外→内）；无合法尾缀时省略。 */
  frameChain?: string[];
  /** M4①：串含 ` frame:` 尾缀形状但未生效（值非法/缺主体/空值/双尾缀/引号括号不配对）时的拒因；其余省略。 */
  rejected?: string;
}

const SELECTOR_FRAME_TAIL_RE = /(?:\s+frame:)(\S*)\s*$/i;

/**
 * E7（N4）：剥离后 base 的引号/括号配对守卫。只做词法配对（不认识 CSS 语义）：
 * 反斜杠转义跳过、字符串内的 `(`/`[` 等不参与配对；出现**先闭后开**或收尾未闭合即视为
 * 不配对。用于拦截"尾缀原本落在引号/括号内部"的误剥（`new URL()` 会把 `)`/`'`/`"` 当
 * host 字符收下，单看值校验发现不了）。
 */
function selectorDelimiterProblem(base: string): string | null {
  let quote: '"' | "'" | null = null;
  let round = 0;
  let square = 0;
  for (let i = 0; i < base.length; i++) {
    const ch = base[i]!;
    if (ch === "\\") { i += 1; continue; }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") round += 1;
    else if (ch === ")") round -= 1;
    else if (ch === "[") square += 1;
    else if (ch === "]") square -= 1;
    if (round < 0 || square < 0) return "选择器含未闭合引号/括号，尾缀未应用";
  }
  if (quote !== null || round !== 0 || square !== 0) return "选择器含未闭合引号/括号，尾缀未应用";
  return null;
}

export function splitFrameSuffixFromSelector(sel: string): SplitSelectorFrameSuffix {
  const m = SELECTOR_FRAME_TAIL_RE.exec(sel);
  if (m === null) return { selector: sel };
  const base = sel.slice(0, m.index).trim();
  const value = m[1]!.toLowerCase();
  if (base === "" || value === "" || frameChainValueProblem(value) !== null) {
    return {
      selector: sel,
      rejected: base === ""
        ? "frame: 尾缀前没有选择器主体（必须写成 `<css> frame:<origin>`）——整串按原 CSS 处理"
        : `frame: 尾缀未被应用（${selectorFrameChainProblemText(value)}）——整串按原 CSS 处理`
          + "（显式落空，绝不半剥）",
    };
  }
  // N4：尾缀可能落在引号/括号内部（值侧 `new URL()` 收得下 `)`/`'`/`"`）——base 不配对 =
  // 这不是一个真正的串尾语法后缀，整串原样（诊断照旧只在失败路径附注）。
  const delimiter = selectorDelimiterProblem(base);
  if (delimiter !== null) {
    return {
      selector: sel,
      rejected: `${delimiter}（尾缀前的主体引号/括号不配对）——整串按原 CSS 处理（显式落空，绝不半剥）`,
    };
  }
  const residual = SELECTOR_FRAME_TAIL_RE.exec(base);
  if (residual !== null && frameChainValueProblem(residual[1]!.toLowerCase()) === null) {
    return {
      selector: sel,
      rejected: "同一串出现多个 frame: 尾缀（至多一次）——整串按原 CSS 处理（显式落空，绝不半剥）",
    };
  }
  return { selector: base, frameChain: value.split(">") };
}

/** `frame:` 尾缀值问题的人话（与 hint.ts 的 frameChainProblemText 同一判定类别）。 */
function selectorFrameChainProblemText(value: string): string {
  const p = frameChainValueProblem(value);
  switch (p?.kind) {
    case "empty": return "frame: 后没有值";
    case "too-long": return `声明 ${p.segments} 段超过上限 4 段`;
    case "empty-segment": return "链里有空段（\">\" 两侧都必须有 origin）";
    case "not-http-origin": return `值 ${JSON.stringify(p.segment)} 不是 http(s) origin（需要 scheme://host[:port] 规范形）`;
    case "not-canonical": return `值 ${JSON.stringify(p.segment)} 不是规范 origin（带 path/query/显式默认端口；如 https://a:443 要写 https://a）`;
    default: return "值非法";
  }
}

/**
 * E4（M4②）：读侧声明帧的**帧级扫描证据**（ctx.read/ctx.extract 的 miss trace 用，
 * additive；与 `locatorAnyFrame`/`countAnyFrame` 的帧循环同一谓词、同一帧序——
 * 链匹配 ∧ 信封规则（主帧恒允许、子帧按 hosts））。
 * `excluded` 非空 = 声明帧存在但被 hosts 信封排除（未扫描）；两者皆空 = 声明帧不存在/链写错。
 */
export interface FrameScopeEvidence {
  declared: string[];
  excluded: string[];
  scanned: string[];
}

export function frameScopeEvidenceOf(
  page: PageLike, hosts: string[] | null | undefined, declared: readonly string[],
): FrameScopeEvidence {
  const excluded: string[] = [];
  const scanned: string[] = [];
  const frames = framesOf(page);
  for (let fi = 0; fi < frames.length; fi++) {
    const fr = frames[fi]!;
    if (!frameScopeMatchesFrame(declared, fr)) continue;
    const origin = frameOriginOf(fr).toLowerCase();
    if (frameGateExcludes(fi, fr, hosts)) {
      if (!excluded.includes(origin) && excluded.length < 6) excluded.push(origin);
    } else if (!scanned.includes(origin) && scanned.length < 6) {
      scanned.push(origin);
    }
  }
  return { declared: [...declared], excluded, scanned };
}

/**
 * First matching locator across the main frame and reachable child frames
 * (same-origin and cross-origin both resolve through Playwright locators;
 * cross-origin stability is measured, R11 B5). Signals are frequently rendered
 * inside an iframe (a success banner, an embedded form's own field), where
 * `page.locator` never looks.
 *
 * `opts.hasText` 透传给每一帧的 `locator(selector, { hasText })`（`css_exists_text`
 * 用它跨 frame 找"文本含 text"的元素；Playwright 的 hasText 是大小写不敏感的子串匹配）。
 *
 * E4：选择器可尾缀 ` frame:<origin链>`（`splitFrameSuffixFromSelector` 唯一剥离出处）——
 * 声明了合法尾缀时帧循环按 `frameScopeMatchesFrame` 过滤（与 hint 同一尾部对齐判定），
 * 信封规则不变（主帧恒允许、子帧按 hosts；被信封排除且链匹配的帧不扫描）；声明帧一个都
 * 没扫到（不存在/链写错/全在信封外）= 结构化 miss（null），绝不落到 test-double 回捞——
 * 那会拿另一份 DOM 冒充声明帧的答案。无尾缀路径逐字节不变。
 */
export async function locatorAnyFrame(
  page: PageLike, selector: string, opts?: { hasText?: string; hosts?: string[] | null },
): Promise<LocLike | null> {
  // E4（M4④）：split 在一切帧遍历与 test-double fallback 之前。
  const split = splitFrameSuffixFromSelector(selector);
  const declared = split.frameChain;
  if (page.frames !== undefined || page.locator !== undefined) {
    const frames = framesOf(page);
    let chainScanned = 0;   // E4：链匹配且被实际扫描的帧数（声明帧全缺席时的短路依据）
    for (let fi = 0; fi < frames.length; fi++) {
      const fr = frames[fi]!;
      // E4：声明了合法尾缀 = 只查链匹配的帧（frameScopeMatchesFrame 尾部对齐，与 hint 同一口径）。
      if (declared !== undefined && !frameScopeMatchesFrame(declared, fr)) continue;
      // P0-D：被排除的 frame 不参与信号求值（主 frame 恒在面内；无 hosts = 旧行为）。
      if (frameGateExcludes(fi, fr, opts?.hosts)) continue;
      chainScanned += 1;
      try {
        const loc = opts === undefined ? fr.locator(split.selector) : fr.locator(split.selector, opts);
        if (await loc.count()) return loc;
      } catch {
        continue;   // frame detached mid-scan / no execution context: skip（跨源 frame 不在此抛——R11 B5 实测可跨源 locator 定位）
      }
    }
    // E4：声明帧在本页一个都没扫到 ⇒ 结构化 miss（不回捞替身 DOM）。
    if (declared !== undefined && chainScanned === 0) return null;
  }
  // Test doubles / non-Playwright pages may provide their own resolver.
  // E4（M4④）：fallback 在 split 之后——替身拿到剥离后的 base（无尾缀 = 原串逐字节）。
  return (await page.locatorAnyFrame?.(split.selector)) ?? null;
}

/**
 * E5：selector 在主 frame + 可达子 frame 的**命中总数**（`css_count_equals` /
 * `css_count_min` 的求值底座）。帧序与 `locatorAnyFrame` 相同（framesOf；被排除
 * frame 不计数，P0-D 信封同口径）；单帧抛错（中途分离等）跳过该帧继续数——
 * 计数是观察面，不因一帧失联把整个信号打成 false。空 selector 返回 null
 * （语法错不猜：调用方按"不成立"处理，与 css_exists 空串的抛错-捕获路径同向）。
 *
 * E4：选择器可尾缀 ` frame:<origin链>`（与 `locatorAnyFrame` 同一剥离出处与同一
 * 帧过滤口径：链匹配 ∧ 信封规则；值非法 = 整串按原 CSS 处理——原串对 locator 是
 * 非法 CSS → 各帧抛错跳过 → 计 0，显式落空）。无尾缀路径逐字节不变。
 */
export async function countAnyFrame(
  page: PageLike, selector: string, opts?: { hosts?: string[] | null },
): Promise<number | null> {
  if (selector.trim() === "") return null;
  const split = splitFrameSuffixFromSelector(selector);
  const declared = split.frameChain;
  if (page.frames !== undefined || page.locator !== undefined) {
    const frames = framesOf(page);
    let total = 0;
    for (let fi = 0; fi < frames.length; fi++) {
      const fr = frames[fi]!;
      if (declared !== undefined && !frameScopeMatchesFrame(declared, fr)) continue;
      if (frameGateExcludes(fi, fr, opts?.hosts)) continue;
      try {
        total += await fr.locator(split.selector).count();
      } catch {
        continue;   // frame detached mid-scan / invalid selector piece in this frame
      }
    }
    return total;
  }
  return null;
}

/**
 * S2（盲测复盘）：selector 的**行数 + 空行数**双指标（主 frame + 可达子 frame，
 * 帧序/信封口径与 `countAnyFrame` 同一份循环）。空行 = `innerText.trim() === ""`
 * 的匹配元素——懒渲染骨架节点的典型形态。单次 evaluate 一次往返拿两个数，
 * 供 extract 的稳定判定（行数与空行数连续两轮相等才算稳定）与 `blank_rows`
 * 事实回显。读不到（替身页/帧全失联）= null（调用方按"判不了"处理，不猜）。
 */
export async function rowStatsAnyFrame(
  page: PageLike, selector: string, opts?: { hosts?: string[] | null },
): Promise<{ rows: number; blank: number } | null> {
  if (selector.trim() === "") return null;
  const split = splitFrameSuffixFromSelector(selector);
  const declared = split.frameChain;
  if (page.frames !== undefined || page.locator !== undefined) {
    const frames = framesOf(page);
    let rows = 0;
    let blank = 0;
    for (let fi = 0; fi < frames.length; fi++) {
      const fr = frames[fi]!;
      if (declared !== undefined && !frameScopeMatchesFrame(declared, fr)) continue;
      if (frameGateExcludes(fi, fr, opts?.hosts)) continue;
      try {
        const per = await fr.evaluate((sel: string) => {
          const g = globalThis as unknown as {
            document?: { querySelectorAll(s: string): ArrayLike<{ innerText?: string }> },
          };
          const doc = g.document;
          if (!doc) return { rows: 0, blank: 0 };
          const all = doc.querySelectorAll(sel);
          let b = 0;
          for (let i = 0; i < all.length; i++) {
            if (String(all[i]!.innerText ?? "").trim() === "") b += 1;
          }
          return { rows: all.length, blank: b };
        }, split.selector) as { rows: number; blank: number } | null;
        if (per !== null && typeof per === "object") {
          rows += Number(per.rows) || 0;
          blank += Number(per.blank) || 0;
        }
      } catch {
        continue;   // frame detached mid-scan：观察面不因一帧失联整体失败
      }
    }
    return { rows, blank };
  }
  return null;
}

