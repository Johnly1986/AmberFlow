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
import type { Elem, FrameLike } from "./extraction.ts";

/** 一个 frame 的 origin（http/https 规范形）；不可解析/非 http(s)/空 = undefined。 */
function httpOriginOf(frame: FrameLike): string | undefined {
  const origin = frameOriginOf(frame);
  if (!origin || origin === "null") return undefined;
  if (!origin.startsWith("http://") && !origin.startsWith("https://")) return undefined;
  return origin;
}

/** detached（isDetached 有即问；测试替身可缺省）⇒ 帧已死 = 未知 origin。 */
function frameAlive(frame: FrameLike): boolean {
  if (typeof frame.isDetached !== "function") return true;
  try { return frame.isDetached() !== true; } catch { return false; }
}

/**
 * frame 的完整 origin 链（外→内，恒含自身帧）：`[rootOrigin, …, ownOrigin]`。
 * 根判定用 `parentFrame()===null`（**不**假设 `frames()[0]` 是主帧）；无 `parentFrame`
 * 成员（`framesOf` 的 `[page as FrameLike]` 兜底 / 测试替身）= 主帧，链 = `[ownOrigin]`。
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
