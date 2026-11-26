/**
 * `observe` 的就绪事实（**只增**诊断键）：elements 为空时回答「页面确实是空的」还是「页面还没加载完」。
 *
 * 为什么需要它：`{ok:true, elements:[]}` 在两种页面状态下形状完全相同——真空白页，与启动态
 * （文档仍在解析、候选尚未进 DOM）。自动化流程拿到后者会直接判定「没有可用元素」并停手，这是
 * `wait_for` 假就绪在 observe 面的同一类问题。本模块只**补一条事实**，不参与任何判定、不改任何
 * 既有键：有元素时一次页面探测都不付；无元素时读一次主 frame 的 `document.readyState`，给出
 * `loading` / `empty` 两档判决与一句有界的下一步建议。
 *
 * 纪律（与 title 读取同口径）：
 *   - **只读**：一次 `evaluate`，不发动作、不改页面；
 *   - **绝不抛**：读不到/超时/页面已关闭一律降级为 `unknown`，诊断失败 = 缺键，不影响 observe 本身；
 *   - **有界**：整块序列化 ≤ 300 字符、hint ≤ 120 字符（超限先丢 hint，再只留两档事实）。
 */
import type { PageLike } from "../support/page-like.ts";

/** 主 frame `document.readyState` 的读取窗口（毫秒）：卡死页面不能拖住一行响应。 */
const READINESS_PROBE_TIMEOUT_MS = 1_500;
/** `hint` 的字符上限。 */
const READINESS_HINT_MAX_CHARS = 120;
/** 整个 readiness 块的序列化字符上限（有界优先于信息量）。 */
const READINESS_BLOCK_MAX_CHARS = 300;

/** 观察时刻的文档就绪态；`unknown` = 读不到（页面已关闭 / 正在导航 / 替身没有 evaluate）。 */
export type ObserveDocumentState = "loading" | "interactive" | "complete" | "unknown";

/** 两档判决：`loading` = 页面还在加载（**不是**「没有元素」）；`empty` = 已就绪但确实没有候选。 */
export type ObserveReadinessVerdict = "loading" | "empty";

/**
 * `observe` 结果的**只读子集**：本模块只看这三项。
 * 故意不引用 `ObserveResult`，避免把本模块绑到引擎响应形状上（缺键/换形状都只是不触发）。
 */
export interface ObserveReadinessInput {
  ok?: unknown;
  elements?: unknown;
  counts?: unknown;
}

/** 读主 frame 的 `document.readyState`；任何失败/超时 → `unknown`（**不抛**）。 */
async function readDocumentState(page: PageLike): Promise<ObserveDocumentState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // `Promise.resolve().then` 把「没有 evaluate 的替身」的同步 TypeError 也变成一次拒绝。
    const probe = Promise.resolve().then(() => page.evaluate!(
      () => (globalThis as unknown as { document?: { readyState?: unknown } }).document?.readyState,
    ));
    const raw = await Promise.race([
      probe,
      new Promise<unknown>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, READINESS_PROBE_TIMEOUT_MS); }),
    ]);
    return raw === "loading" || raw === "interactive" || raw === "complete" ? raw : "unknown";
  } catch {
    return "unknown";
  } finally {
    // 清掉输给 race 的定时器：一次空 observe 不留悬挂句柄。
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 固定文案（不含页面内容，逐档可读）：只解释状态与下一步，不猜原因。 */
function hintFor(state: ObserveDocumentState): string {
  switch (state) {
    case "complete":
      return "页面已就绪（document.readyState=complete）但没有候选元素：换 selector、放宽 includeHidden，或确认页面确实为空";
    case "loading":
      return "页面仍在加载（document.readyState=loading）：重试 observe，或用 waitFor 等到目标出现";
    case "interactive":
      return "页面可交互但未加载完（document.readyState=interactive）：重试 observe，或用 waitFor 等到目标出现";
    default:
      return "读不到 document.readyState（页面可能在导航或已关闭）：重试 observe 确认页面事实";
  }
}

/** `hint` 截到 ≤ 120 字符（固定文案本就够短；兜底防后续改文案时越界）。 */
function boundHint(hint: string): string {
  return hint.length <= READINESS_HINT_MAX_CHARS ? hint : `${hint.slice(0, READINESS_HINT_MAX_CHARS - 1)}…`;
}

/** 整块 ≤ 300 字符：超限先丢 hint，仍超限只留两档事实。 */
function boundBlock(block: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(block).length <= READINESS_BLOCK_MAX_CHARS) return block;
  const lean: Record<string, unknown> = {
    document_state: block["document_state"], elements: block["elements"], verdict: block["verdict"],
  };
  if (JSON.stringify(lean).length <= READINESS_BLOCK_MAX_CHARS) return lean;
  return { document_state: block["document_state"], verdict: block["verdict"] };
}

/**
 * observe 的就绪事实：**只在可疑时**返回非空对象，其余一律 `{}`（缺省响应逐字节不变）。
 *
 * 触发条件：`ok === true` 且本次没有元素（`elements` 为空数组 / `counts.elements === 0`）。
 * 元素非空时提前返回，连一次 `evaluate` 都不付。
 *
 * 产出：`{ readiness: { document_state, elements, verdict, hint } }`（**包一层**，调用方直接
 * `Object.assign` 合并；扁平返回会与 observe 既有键撞名）；`verdict` 的判据只有一条——
 * `document_state === "complete"` ⇒ `empty`，否则 `loading`（读不到也按 loading：无法确认就不能说空）。
 */
export async function observeReadiness(
  page: PageLike,
  result: ObserveReadinessInput,
): Promise<Record<string, unknown>> {
  try {
    if (result.ok !== true) return {};
    const elements = Array.isArray(result.elements) ? result.elements : [];
    if (elements.length > 0) return {};
    const counts = typeof result.counts === "object" && result.counts !== null && !Array.isArray(result.counts)
      ? result.counts as Record<string, unknown>
      : {};
    const counted = typeof counts["elements"] === "number" ? counts["elements"] : undefined;
    if (counted !== undefined && counted > 0) return {};
    const documentState = await readDocumentState(page);
    // 包在 `readiness` 下返回：调用方 `Object.assign(extra, ...)` 直接合并，块内键不与 observe
    // 既有键（尤其 `elements`）撞名——扁平返回会把 `elements: []` 覆盖成计数。
    return {
      readiness: boundBlock({
        document_state: documentState,
        elements: counted ?? elements.length,
        verdict: documentState === "complete" ? "empty" : "loading",
        hint: boundHint(hintFor(documentState)),
      }),
    };
  } catch {
    return {};
  }
}
