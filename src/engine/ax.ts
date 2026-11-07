/**
 * AX 证据源 —— **浏览器自己算的可访问性语义**（只读观察面，不进任何行为路径）。
 *
 * 为什么需要它：引擎的元素池是一个**选择器闭集**（POOL_SEL + 投影 + 窗口），它回答
 * “我们能指向什么”；浏览器算出的 accessibility tree 回答的是另一件事——
 * “页面在语义上可交互/有名字的节点有哪些”。两者不是同一个口径，把后者当参照面，
 * 才能在 inspect 里说清“浏览器认为可交互、而池没指向的”这类信息差（例如只有
 * `aria-label` 的 `div[role=button]`、`tabindex=0` 的自绘面板）。
 *
 * 纪律（本波只做只读证据）：
 *   1. **不改行为**：本模块不参与抽池、hint 匹配、模型视图、动作或判定；只有
 *      `inspect` 调它，每页一次。池仍是选择器闭集。
 *   2. **不猜**：可交互判定只有两条确定性依据——原生可聚焦/可激活的 AX role，
 *      或浏览器给的 `focusable=true`；原始 role 原样输出供人判读。`disabled` 同理。
 *   3. **失败即 null，绝不抛裸栈**：优先 Playwright `page.accessibility.snapshot`
 *      （若该版本仍有），没有就降级 CDP `Accessibility.getFullAXTree`；两者都不可用、
 *      抛错或超过 3s → null，调用方照常输出其余观察面。
 *
 * 可交互口径（写死在此，报告与文档同口径）：
 *   - role ∈ INTERACTIVE_AX_ROLES（button/link/textbox/... 见下表）→ 可交互；
 *   - 或浏览器报告 `focusable=true`（如 `div[tabindex=0]` 的 generic）→ 可交互；
 *   - 文档根（RootWebArea/WebArea/document）即使 focusable 也不算（它不是可动作元素，
 *     否则每个页面都会凭空多一个“可交互”）；
 *   - generic/none/group 等**只有** focusable=true 才算（不靠名字/角色猜）。
 *
 * 有界输出：语义节点按「可交互 → 有名 → 其余」三段 + 文档树序截断到 200；静态文本
 * 叶子（StaticText/InlineTextBox/LineBreak）不进证据（它们不是可动作语义，且会把
 * 有界清单压满；可读文本走 `inspect --text` / `ctx.read.text`）。
 */

/** 一次 AX 观察的归一节点（形状固定；role 保留浏览器原值）。 */
export interface AxNode {
  role: string;
  name: string;
  focusable: boolean;
  disabled: boolean;
}

export interface AxSnapshot {
  available: true;
  /** 树从哪个 API 取到：playwright（若该版本还有该 API）或 cdp。 */
  source: "playwright" | "cdp";
  /** 有界节点（≤ AX_MAX_NODES；交互/有名优先 + 文档树序）。 */
  nodes: AxNode[];
  /** 全树（非 ignored、非文本叶子）按 role 计数；空名节点同样计入 role。 */
  counts_by_role: Record<string, number>;
  /** 只统计可交互节点的 role 计数（人读摘要用；口径同 axNodeInteractive）。 */
  interactive_counts_by_role: Record<string, number>;
  /** 全树可交互节点数（不受 nodes 有界截断影响）。 */
  interactive_count: number;
  /** 全树参与统计的节点数（不受 nodes 有界截断影响）。 */
  total_nodes: number;
  /** nodes 是否被 AX_MAX_NODES 截断。 */
  truncated: boolean;
}

/** 取树总超时：超过就当作不可用（inspect 不该被 AX 拖住）。 */
export const AX_TIMEOUT_MS = 3000;
/** nodes 有界上限（inspect 展示再取前 50）。 */
export const AX_MAX_NODES = 200;

/**
 * 原生可聚焦/可激活的 AX role（小写比较；role 原值照常输出）。
 * 清单只收确定可动作的角色：原生控件 + ARIA widget/菜单/页签/树项 + 摘要三角。
 * `DisclosureTriangle` 是 Chromium 对 `<summary>` 的 AX role 名（不是 "summary"）。
 */
const INTERACTIVE_AX_ROLES: ReadonlySet<string> = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "listbox", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "slider", "switch", "spinbutton", "summary", "disclosuretriangle",
  "treeitem", "scrollbar",
  // 注意：`option` **有意不计入**——select 内部的 option 由引擎的 `select` 动作承载
  //（不是池里的独立动作目标），计入会让每个 select 都往 not_in_pool 里灌 N 条噪声。
  // 原始 role 仍原样出现在 nodes/counts_by_role，浏览器语义证据不丢。
]);

/** 文档根：即使 focusable 也不是可动作元素（否则每页都多 1 个可交互）。 */
const DOCUMENT_AX_ROLES: ReadonlySet<string> = new Set(["rootwebarea", "webarea", "document"]);

/** 静态文本叶子：不是可动作语义，不进证据（role 计数也不计）。 */
const TEXT_LEAF_AX_ROLES: ReadonlySet<string> = new Set(["statictext", "inlinetextbox", "linebreak"]);

/** 节点名上界（与池 label 的 ≤200 同一口径）。 */
const NAME_MAX = 200;

/** 可交互判定（唯一口径；见文件头）。导出让文档/测试共用，不要另写一份。 */
export function axNodeInteractive(role: string, focusable: boolean): boolean {
  const r = role.trim().toLowerCase();
  if (!r) return false;
  if (INTERACTIVE_AX_ROLES.has(r)) return true;
  if (DOCUMENT_AX_ROLES.has(r)) return false;
  // select 内部的 `option` 即使浏览器报 focusable=true 也不算可交互证据：它由引擎的
  // `select` 动作承载（不是池里的独立动作目标）；计入会让 not_in_pool 被每个 select 灌噪声。
  if (r === "option") return false;
  return focusable === true;
}

/** 归一 name：折叠空白、去首尾、截断 ≤200；空名保留空串（不编造）。 */
function normalizeName(raw: unknown): string {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  return s.length > NAME_MAX ? `${s.slice(0, NAME_MAX)}…` : s;
}

/** 页面需要的一小块面（Playwright page / frame；不用 import 避免循环）。 */
export interface AxPageLike {
  accessibility?: { snapshot?(opts?: unknown): Promise<unknown> } | null;
  context?: () => { newCDPSession?(page: unknown): Promise<CdpSessionLike> };
}

interface CdpSessionLike {
  send(method: string, params?: unknown): Promise<unknown>;
  detach?(): Promise<void>;
}

interface RawAxNode {
  role: string;
  name: string;
  focusable: boolean;
  disabled: boolean;
}

/**
 * 取一次 AX 树。`null` = 不可用（没有 accessibility API / CDP 会话 / 3s 超时 / 取树抛错），
 * 调用方把它当“没有这个证据源”，不要当异常。
 */
export async function snapshotAx(page: AxPageLike | null | undefined): Promise<AxSnapshot | null> {
  if (!page || typeof page !== "object") return null;
  try {
    return await withTimeout(captureAx(page), AX_TIMEOUT_MS);
  } catch {
    return null;
  }
}

async function captureAx(page: AxPageLike): Promise<AxSnapshot | null> {
  const viaPw = await captureViaPlaywright(page);
  if (viaPw) return viaPw;
  return captureViaCdp(page);
}

/**
 * Playwright 的 accessibility API（1.58 已移除；保留此路是因为旧运行时仍可能有）。
 * 该 API 的节点不保证带 focusable，只认它真给了 true 的；role 命中照样可交互。
 */
async function captureViaPlaywright(page: AxPageLike): Promise<AxSnapshot | null> {
  const a11y = page.accessibility;
  if (!a11y || typeof a11y.snapshot !== "function") return null;
  let raw: unknown;
  try {
    raw = await a11y.snapshot({ interestingOnly: false });
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const nodes: RawAxNode[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 200) return;
    const n = node as Record<string, unknown>;
    const role = typeof n.role === "string" ? n.role.trim() : "";
    if (role && !TEXT_LEAF_AX_ROLES.has(role.toLowerCase())) nodes.push({
      role,
      name: normalizeName(n.name),
      focusable: n.focusable === true,
      disabled: n.disabled === true,
    });
    const children = n.children;
    if (Array.isArray(children)) for (const c of children) walk(c, depth + 1);
  };
  walk(raw, 0);
  return buildSnapshot("playwright", nodes);
}

/** CDP 降级：Accessibility.enable + Accessibility.getFullAXTree（只读；会话 best-effort detach）。 */
async function captureViaCdp(page: AxPageLike): Promise<AxSnapshot | null> {
  const context = typeof page.context === "function" ? page.context() : null;
  if (!context || typeof context.newCDPSession !== "function") return null;
  let session: CdpSessionLike;
  try {
    session = await context.newCDPSession(page);
  } catch {
    return null;
  }
  if (!session || typeof session.send !== "function") return null;
  try {
    await session.send("Accessibility.enable");
    const tree = await session.send("Accessibility.getFullAXTree");
    const nodes = parseCdpTree(tree);
    return nodes === null ? null : buildSnapshot("cdp", nodes);
  } catch {
    return null;
  } finally {
    try { await session.detach?.(); } catch { /* 页面已关/已 detach：不影响结论 */ }
  }
}

/** CDP 扁平树 → 归一节点。ignored / 空 role / 静态文本叶子剔除；坏形状返回 null。 */
function parseCdpTree(tree: unknown): RawAxNode[] | null {
  const nodes = (tree as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return null;
  const out: RawAxNode[] = [];
  for (const item of nodes) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    if (n.ignored === true) continue;
    const roleVal = (n.role as { value?: unknown } | undefined)?.value;
    const role = typeof roleVal === "string" ? roleVal.trim() : "";
    if (!role || TEXT_LEAF_AX_ROLES.has(role.toLowerCase())) continue;
    const props = new Map<string, unknown>();
    if (Array.isArray(n.properties)) {
      for (const p of n.properties) {
        if (!p || typeof p !== "object") continue;
        const pr = p as Record<string, unknown>;
        const name = typeof pr.name === "string" ? pr.name : "";
        if (name) props.set(name, (pr.value as { value?: unknown } | undefined)?.value);
      }
    }
    const nameVal = (n.name as { value?: unknown } | undefined)?.value;
    out.push({
      role,
      name: normalizeName(nameVal),
      focusable: props.get("focusable") === true || props.get("focusable") === "true",
      disabled: props.get("disabled") === true || props.get("disabled") === "true",
    });
  }
  return out;
}

/** 归一 + 有界排序 + 计数（唯一形状构造点）。 */
function buildSnapshot(source: AxSnapshot["source"], raw: RawAxNode[]): AxSnapshot {
  const counts = new Map<string, number>();
  const interactiveCounts = new Map<string, number>();
  let interactiveCount = 0;
  for (const n of raw) {
    counts.set(n.role, (counts.get(n.role) ?? 0) + 1);
    if (axNodeInteractive(n.role, n.focusable)) {
      interactiveCount++;
      interactiveCounts.set(n.role, (interactiveCounts.get(n.role) ?? 0) + 1);
    }
  }
  // 可交互（0）→ 有名（1）→ 其余（2）；同段保持文档树序（稳定 sort）。
  const priority = (n: RawAxNode): number =>
    axNodeInteractive(n.role, n.focusable) ? 0 : n.name ? 1 : 2;
  const ordered = raw
    .map((n, i) => ({ n, i, p: priority(n) }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.n);
  return {
    available: true,
    source,
    nodes: ordered.slice(0, AX_MAX_NODES),
    counts_by_role: sortCounts(counts),
    interactive_counts_by_role: sortCounts(interactiveCounts),
    interactive_count: interactiveCount,
    total_nodes: raw.length,
    truncated: raw.length > AX_MAX_NODES,
  };
}

/** Map → Record，按次数降序 + role 字典序（输出确定；人读摘要直接取前几条）。 */
function sortCounts(counts: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [role, n] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    out[role] = n;
  }
  return out;
}

/**
 * `not_in_pool` 的**近似**口径（inspect 专用）：在 AX 可交互且有名字的节点里，
 * 名字与任一池元素 label 归一化后**全等**、或（双方长度 ≥4 时）互相包含，算“池指向了”；
 * 否则算“未进池”。空名可交互节点不参与（无从对照，单独由 interactive_count 体现）。
 *
 * 为什么是近似：池 label 是引擎的合成文本（≤200，可能含 near/aria 拼接），AX name 是
 * 浏览器的 computed name；两者同义不同字时只能判“不确定”。所以这个数只用于指出
 * 信息差，不作断言——措辞红线：说“池未指向/未进池”，不说“不可点击/不存在”。
 */
export function countAxNotInPool(
  snapshot: Pick<AxSnapshot, "nodes">,
  poolLabels: readonly string[],
): number {
  const labels = poolLabels
    .map((l) => String(l ?? "").replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
  let missing = 0;
  for (const node of snapshot.nodes) {
    if (!axNodeInteractive(node.role, node.focusable)) continue;
    const name = node.name.replace(/\s+/g, " ").trim().toLowerCase();
    if (!name) continue;
    const hit = labels.some((label) =>
      label === name
      || (label.length >= 4 && name.length >= 4 && (label.includes(name) || name.includes(label))));
    if (!hit) missing++;
  }
  return missing;
}

/** 与 inspect 输出一起给 Agent 看的口径说明（避免把近似数当断言）。 */
export const AX_NOT_IN_POOL_BASIS =
  "近似口径：AX 可交互且有名字的节点中，name 与池元素 label 归一化后全等/互相包含算“已进池”，否则计未进池；空名节点不参与（看 interactive_count），有界节点内计算";

/** 超时即 null；输掉的 promise 也挂 catch，晚到失败不会变成 unhandled rejection。 */
function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(1, ms));
  });
  return Promise.race([p.catch(() => null), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
